import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Plugin } from "@opencode-ai/plugin";
import {
  context,
  trace,
  ROOT_CONTEXT,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { RandomIdGenerator } from "@opentelemetry/sdk-trace-base";

/**
 * Custom ID generator that reuses a parent trace ID from the environment.
 *
 * When LANGFUSE_TRACE_ID is set, all root spans created by the Vercel AI SDK
 * will share that trace ID — which is the snakur-2 parent trace. This stitches
 * OpenCode's tool/LLM spans under the caller's Langfuse trace instead of
 * creating standalone traces.
 *
 * OTEL trace IDs are 32-char hex strings. Langfuse observation IDs (span IDs)
 * are 16-char hex. The random generator handles span IDs as usual.
 */
class ParentAwareIdGenerator extends RandomIdGenerator {
  constructor() {
    super();
    const raw = process.env.LANGFUSE_TRACE_ID;
    if (raw && /^[0-9a-f]{32}$/i.test(raw)) {
      const parentTraceId = raw.toLowerCase();
      // RandomIdGenerator defines generateTraceId as a class field (arrow fn),
      // so we reassign the field rather than using override.
      const originalGenerate = this.generateTraceId.bind(this);
      this.generateTraceId = () => parentTraceId ?? originalGenerate();
    }
  }
}

/**
 * Context manager that returns a context with our remote parent span as the
 * default when no other context is active.
 *
 * The Vercel AI SDK creates root spans via `tracer.startSpan()` without
 * explicitly passing a parent. OTEL falls back to `context.active()` in that
 * case. By overriding `active()` to return our parent context when the
 * AsyncLocalStorage is empty, every otherwise-root span becomes a child of
 * the snakur-2 parent observation.
 */
class ParentAwareContextManager extends AsyncLocalStorageContextManager {
  private readonly defaultContext: Context;

  constructor(defaultContext: Context) {
    super();
    this.defaultContext = defaultContext;
  }

  active(): Context {
    const current = super.active();
    return current === ROOT_CONTEXT ? this.defaultContext : current;
  }
}

type LogFn = (level: "info" | "warn" | "error", message: string) => void;

/** Minimal shape of the OTEL pieces the shutdown routine drives — kept local so
 * the routine is trivially unit-testable and independent of SDK internals. */
interface FlushTarget {
  forceFlush: () => Promise<unknown>;
}
interface ShutdownTarget {
  shutdown: () => Promise<unknown>;
}

// ENG-3645: the OpenCode readwrite subprocess is torn down by SIGTERM (pod
// soft-timeout) or by client-disconnect cancellation. OpenTelemetry batches
// spans and only exports them on the graceful `session.idle` /
// `server.instance.disposed` lifecycle events — neither of which fires on a
// kill — so every killed run silently loses its child spans. These module-level
// refs plus a single guarded shutdown routine let a process-signal handler
// flush the batch within the OPENCODE_KILL_GRACE_S window the pod already
// reserves after SIGTERM.
let activeProcessor: FlushTarget | undefined;
let activeSdk: ShutdownTarget | undefined;
let activeLog: LogFn | undefined;
let shuttingDown = false;
let signalHandlersInstalled = false;

const SHUTDOWN_SIGNALS = ["SIGTERM", "SIGINT"] as const;
const signalListeners = new Map<
  (typeof SHUTDOWN_SIGNALS)[number],
  () => void
>();

/**
 * Flush any batched spans and shut the exporter down exactly once, whether the
 * trigger was a process signal or the `server.instance.disposed` lifecycle
 * event. Never throws — a failed flush/shutdown must not mask the original
 * teardown. Deliberately does NOT call `process.exit()`: OpenCode owns the
 * process and still needs the same grace window to flush its own stdout NDJSON
 * (the source of the salvaged diff); exiting here would truncate it.
 */
export async function flushAndShutdown(reason: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  const safeLog: LogFn = (level, message) => {
    try {
      activeLog?.(level, message);
    } catch {
      // The log transport may already be closing during teardown; ignore.
    }
  };

  safeLog("info", `Flushing OTEL spans before ${reason} shutdown`);
  try {
    await activeProcessor?.forceFlush();
  } catch (err) {
    safeLog("warn", `forceFlush on ${reason} failed: ${String(err)}`);
  }
  try {
    await activeSdk?.shutdown();
  } catch (err) {
    safeLog("warn", `shutdown on ${reason} failed: ${String(err)}`);
  }
}

/**
 * Register SIGTERM/SIGINT handlers once per process. Guarded so repeated plugin
 * initialisations (or a second plugin instance) cannot stack duplicate
 * listeners or double-flush.
 */
function installSignalHandlers(): void {
  if (signalHandlersInstalled) return;
  signalHandlersInstalled = true;
  for (const signal of SHUTDOWN_SIGNALS) {
    const listener = () => {
      void flushAndShutdown(signal);
    };
    signalListeners.set(signal, listener);
    process.on(signal, listener);
  }
}

/** Test-only: reset the module-level shutdown state between test cases. */
export function __resetSignalFlushForTests(): void {
  for (const [signal, listener] of signalListeners) {
    process.removeListener(signal, listener);
  }
  signalListeners.clear();
  activeProcessor = undefined;
  activeSdk = undefined;
  activeLog = undefined;
  shuttingDown = false;
  signalHandlersInstalled = false;
}

export const LangfusePlugin: Plugin = async ({ client }) => {
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = process.env.LANGFUSE_BASEURL ?? "https://cloud.langfuse.com";
  const environment = process.env.LANGFUSE_ENVIRONMENT ?? "development";

  const log = (level: "info" | "warn" | "error", message: string) => {
    client.app.log({
      body: { service: "langfuse-otel", level, message },
    });
  };

  if (!publicKey || !secretKey) {
    log(
      "warn",
      "Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY - tracing disabled"
    );
    return {};
  }

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment,
  });

  const idGenerator = new ParentAwareIdGenerator();
  const parentTraceId = process.env.LANGFUSE_TRACE_ID;
  const parentSpanId = process.env.LANGFUSE_PARENT_OBSERVATION_ID;

  // Build a remote parent context when both trace and parent span IDs are
  // provided via the environment. Every root span created by the Vercel AI
  // SDK will be parented to this span, nesting the OpenCode subtree under
  // the caller's observation in Langfuse.
  let contextManager: AsyncLocalStorageContextManager | undefined;
  let parentNested = false;
  if (
    parentTraceId &&
    /^[0-9a-f]{32}$/i.test(parentTraceId) &&
    parentSpanId &&
    /^[0-9a-f]{16}$/i.test(parentSpanId)
  ) {
    const remoteParent: SpanContext = {
      traceId: parentTraceId.toLowerCase(),
      spanId: parentSpanId.toLowerCase(),
      traceFlags: 1,
      isRemote: true,
    };
    const parentContext = trace.setSpanContext(ROOT_CONTEXT, remoteParent);
    contextManager = new ParentAwareContextManager(parentContext);
    parentNested = true;
  }

  const sdk = new NodeSDK({
    spanProcessors: [processor],
    idGenerator,
    ...(contextManager ? { contextManager } : {}),
  });

  sdk.start();

  if (parentNested) {
    log(
      "info",
      `OTEL tracing initialized → ${baseUrl} (nested under parent ${parentTraceId!.slice(0, 8)}…/${parentSpanId!.slice(0, 8)}…)`
    );
  } else if (parentTraceId) {
    log(
      "info",
      `OTEL tracing initialized → ${baseUrl} (stitching to parent trace ${parentTraceId.slice(0, 8)}…)`
    );
  } else {
    log("info", `OTEL tracing initialized → ${baseUrl}`);
  }

  // ENG-3645: expose this run's pipeline to the process-signal shutdown path and
  // register the handlers (once) so a killed readwrite still exports its spans.
  activeProcessor = processor;
  activeSdk = sdk;
  activeLog = log;
  installSignalHandlers();

  return {
    config: async (config) => {
      if (!config.experimental?.openTelemetry) {
        log(
          "warn",
          "OpenTelemetry experimental feature is disabled in Opencode config - tracing disabled"
        );
      }
    },
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        log("info", "Flushing OTEL spans before idle");
        await processor.forceFlush();
      }

      if (event.type === "server.instance.disposed") {
        await flushAndShutdown("server.instance.disposed");
      }
    },
  };
};
