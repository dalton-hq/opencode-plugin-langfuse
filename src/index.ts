import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { Plugin } from "@opencode-ai/plugin";
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
  private readonly parentTraceId: string | undefined;

  constructor() {
    super();
    const raw = process.env.LANGFUSE_TRACE_ID;
    if (raw && /^[0-9a-f]{32}$/i.test(raw)) {
      this.parentTraceId = raw.toLowerCase();
    }
  }

  override generateTraceId(): string {
    return this.parentTraceId ?? super.generateTraceId();
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

  const processor = new LangfuseSpanProcessor({
    publicKey,
    secretKey,
    baseUrl,
    environment,
  });

  const idGenerator = new ParentAwareIdGenerator();
  const parentTraceId = process.env.LANGFUSE_TRACE_ID;

  const sdk = new NodeSDK({
    spanProcessors: [processor],
    idGenerator,
  });

  sdk.start();

  if (parentTraceId) {
    log("info", `OTEL tracing initialized → ${baseUrl} (stitching to parent trace ${parentTraceId.slice(0, 8)}…)`);
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
