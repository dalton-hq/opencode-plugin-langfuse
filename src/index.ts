import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Plugin } from "@opencode-ai/plugin";
import {
  trace,
  ROOT_CONTEXT,
  type Context,
  type SpanContext,
} from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { NodeSDK } from "@opentelemetry/sdk-node";
import {
  RandomIdGenerator,
  type ReadableSpan,
  type Span,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

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

const AI_SDK_PAYLOAD_ATTRIBUTES = [
  "ai.prompt",
  "ai.prompt.messages",
  "ai.prompt.tools",
  "ai.prompt.toolChoice",
  "ai.response.text",
  "ai.response.toolCalls",
  "ai.response.object",
];

class PayloadScrubbingSpanProcessor implements SpanProcessor {
  constructor(private readonly delegate: SpanProcessor) {}

  onStart(span: Span, parentContext: Context): void {
    this.delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    if (span.name.startsWith("ai.")) {
      const attributes = span.attributes as Record<string, unknown>;
      for (const attribute of AI_SDK_PAYLOAD_ATTRIBUTES) {
        delete attributes[attribute];
      }
    }
    this.delegate.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.delegate.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.delegate.shutdown();
  }
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

  const langfuseProcessor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment,
  });
  const processor = new PayloadScrubbingSpanProcessor(langfuseProcessor);

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

      if (event.type === "server.instance.disposed") await sdk.shutdown();
    },
  };
};
