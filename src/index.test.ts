import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { LangfusePlugin } from "./index";

const mockForceFlush = mock(() => Promise.resolve());
const mockProcessorShutdown = mock(() => Promise.resolve());
const mockOnStart = mock(() => {});
const mockOnEnd = mock(() => {});
const mockStart = mock(() => {});
const mockShutdown = mock(() => Promise.resolve());

let capturedNodeSDKOptions: Record<string, unknown> = {};

mock.module("@langfuse/otel", () => ({
  LangfuseSpanProcessor: mock(() => ({
    onStart: mockOnStart,
    onEnd: mockOnEnd,
    forceFlush: mockForceFlush,
    shutdown: mockProcessorShutdown,
  })),
}));

mock.module("@opentelemetry/sdk-node", () => ({
  NodeSDK: mock((options: Record<string, unknown>) => {
    capturedNodeSDKOptions = options;
    return {
      start: mockStart,
      shutdown: mockShutdown,
    };
  }),
}));

const mockLog = mock(() => {});

const createMockClient = () => ({
  app: {
    log: mockLog,
  },
});

const mockPluginInput = (clientOverrides = {}) =>
  ({
    client: { ...createMockClient(), ...clientOverrides },
    project: { id: "proj-123", worktree: "/test" },
    directory: "/test/dir",
    worktree: "/test/worktree",
    serverUrl: new URL("http://localhost:3000"),
    $: {},
  }) as any;

describe("LangfusePlugin", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockForceFlush.mockClear();
    mockProcessorShutdown.mockClear();
    mockOnStart.mockClear();
    mockOnEnd.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    mockLog.mockClear();
    capturedNodeSDKOptions = {};
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const setupEnv = (overrides: Record<string, string> = {}) => {
    process.env.LANGFUSE_PUBLIC_KEY = "pk-test";
    process.env.LANGFUSE_SECRET_KEY = "sk-test";
    Object.assign(process.env, overrides);
  };

  describe("credentials", () => {
    it("returns empty hooks when credentials missing", async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;

      const hooks = await LangfusePlugin(mockPluginInput());

      expect(hooks).toEqual({});
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "warn",
          message:
            "Missing LANGFUSE_PUBLIC_KEY or LANGFUSE_SECRET_KEY - tracing disabled",
        },
      });
    });

    it("returns hooks when credentials provided via env", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      expect(hooks.config).toBeDefined();
      expect(hooks.event).toBeDefined();
      expect(mockStart).toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://cloud.langfuse.com",
        },
      });
    });
  });

  describe("config hook", () => {
    it("warns when openTelemetry is disabled in config", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await hooks.config!({ experimental: { openTelemetry: false } } as any);

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "warn",
          message:
            "OpenTelemetry experimental feature is disabled in Opencode config - tracing disabled",
        },
      });
    });

    it("warns when experimental config is missing", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await hooks.config!({} as any);

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "warn",
          message:
            "OpenTelemetry experimental feature is disabled in Opencode config - tracing disabled",
        },
      });
    });

    it("does not warn when openTelemetry is enabled", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());
      mockLog.mockClear();

      await hooks.config!({ experimental: { openTelemetry: true } } as any);

      expect(mockLog).not.toHaveBeenCalled();
    });
  });

  describe("event hook", () => {
    it("flushes OTEL spans on session.idle", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());

      await hooks.event!({
        event: { type: "session.idle", properties: { sessionID: "sess-1" } },
      } as any);

      expect(mockForceFlush).toHaveBeenCalled();
      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "Flushing OTEL spans before idle",
        },
      });
    });

    it("does not flush on other events", async () => {
      setupEnv();
      const hooks = await LangfusePlugin(mockPluginInput());
      mockForceFlush.mockClear();

      await hooks.event!({
        event: {
          type: "session.created",
          properties: { info: { id: "sess-1" } },
        },
      } as any);

      expect(mockForceFlush).not.toHaveBeenCalled();
    });
  });

  describe("payload scrubbing", () => {
    it("removes AI SDK prompt and response payload attributes before export", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      const [processor] = capturedNodeSDKOptions.spanProcessors as any[];
      const span = {
        name: "ai.streamText.doStream",
        attributes: {
          "ai.prompt": '{"prompt":"large"}',
          "ai.prompt.messages": '[{"role":"user","content":"large"}]',
          "ai.prompt.tools": '[{"name":"bash"}]',
          "ai.prompt.toolChoice": '{"type":"auto"}',
          "ai.response.text": "large response",
          "ai.response.toolCalls": '[{"toolName":"bash"}]',
          "ai.response.object": '{"result":"large"}',
          "ai.usage.totalTokens": 42,
          "gen_ai.usage.input_tokens": 21,
          "gen_ai.response.model": "gemini-3-flash-preview",
        },
      };

      processor.onEnd(span);

      expect(span.attributes["ai.prompt"]).toBeUndefined();
      expect(span.attributes["ai.prompt.messages"]).toBeUndefined();
      expect(span.attributes["ai.prompt.tools"]).toBeUndefined();
      expect(span.attributes["ai.prompt.toolChoice"]).toBeUndefined();
      expect(span.attributes["ai.response.text"]).toBeUndefined();
      expect(span.attributes["ai.response.toolCalls"]).toBeUndefined();
      expect(span.attributes["ai.response.object"]).toBeUndefined();
      expect(span.attributes["ai.usage.totalTokens"]).toBe(42);
      expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(21);
      expect(span.attributes["gen_ai.response.model"]).toBe(
        "gemini-3-flash-preview"
      );
      expect(mockOnEnd).toHaveBeenCalledWith(span);
    });
  });

  describe("environment configuration", () => {
    it("uses default baseUrl when not provided", async () => {
      setupEnv();
      delete process.env.LANGFUSE_BASEURL;

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://cloud.langfuse.com",
        },
      });
    });

    it("uses custom baseUrl when provided", async () => {
      setupEnv({ LANGFUSE_BASEURL: "https://custom.langfuse.com" });

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://custom.langfuse.com",
        },
      });
    });
  });

  describe("trace stitching", () => {
    it("passes idGenerator to NodeSDK", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      expect(capturedNodeSDKOptions.idGenerator).toBeDefined();
    });

    it("logs parent trace ID when LANGFUSE_TRACE_ID is set", async () => {
      setupEnv({
        LANGFUSE_TRACE_ID: "abcdef1234567890abcdef1234567890",
      });

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message:
            "OTEL tracing initialized → https://cloud.langfuse.com (stitching to parent trace abcdef12…)",
        },
      });
    });

    it("does not log parent trace when LANGFUSE_TRACE_ID is not set", async () => {
      setupEnv();
      delete process.env.LANGFUSE_TRACE_ID;

      await LangfusePlugin(mockPluginInput());

      expect(mockLog).toHaveBeenCalledWith({
        body: {
          service: "langfuse-otel",
          level: "info",
          message: "OTEL tracing initialized → https://cloud.langfuse.com",
        },
      });
    });
  });
});
