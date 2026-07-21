import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  afterAll,
  mock,
} from "bun:test";
import {
  LangfusePlugin,
  flushAndShutdown,
  __resetSignalFlushForTests,
} from "./index";

const mockForceFlush = mock(() => Promise.resolve());
const mockStart = mock(() => {});
const mockShutdown = mock(() => Promise.resolve());

let capturedNodeSDKOptions: Record<string, unknown> = {};

mock.module("@langfuse/otel", () => ({
  LangfuseSpanProcessor: mock(() => ({
    forceFlush: mockForceFlush,
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
    __resetSignalFlushForTests();
    mockForceFlush.mockClear();
    mockStart.mockClear();
    mockShutdown.mockClear();
    mockLog.mockClear();
    capturedNodeSDKOptions = {};
  });

  afterAll(() => {
    __resetSignalFlushForTests();
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

  describe("shutdown flush (ENG-3645)", () => {
    it("registers SIGTERM and SIGINT handlers on init", async () => {
      setupEnv();
      const termBefore = process.listeners("SIGTERM").length;
      const intBefore = process.listeners("SIGINT").length;

      await LangfusePlugin(mockPluginInput());

      expect(process.listeners("SIGTERM").length).toBe(termBefore + 1);
      expect(process.listeners("SIGINT").length).toBe(intBefore + 1);
    });

    it("flushes batched spans, then shuts the exporter down, on shutdown", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      await flushAndShutdown("SIGTERM");

      expect(mockForceFlush).toHaveBeenCalled();
      expect(mockShutdown).toHaveBeenCalled();
    });

    it("flushes and shuts down at most once across repeated triggers", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());

      await flushAndShutdown("SIGTERM");
      await flushAndShutdown("SIGINT");
      await flushAndShutdown("server.instance.disposed");

      expect(mockForceFlush).toHaveBeenCalledTimes(1);
      expect(mockShutdown).toHaveBeenCalledTimes(1);
    });

    it("registers nothing and flushes nothing when credentials are missing", async () => {
      delete process.env.LANGFUSE_PUBLIC_KEY;
      delete process.env.LANGFUSE_SECRET_KEY;
      const termBefore = process.listeners("SIGTERM").length;

      await LangfusePlugin(mockPluginInput());

      expect(process.listeners("SIGTERM").length).toBe(termBefore);
      // Must be safe to call with nothing registered.
      await flushAndShutdown("SIGTERM");
      expect(mockForceFlush).not.toHaveBeenCalled();
    });

    it("does not terminate the process (OpenCode still owns the grace window)", async () => {
      setupEnv();
      await LangfusePlugin(mockPluginInput());
      const exitSpy = mock((() => undefined) as (code?: number) => never);
      const originalExit = process.exit;
      process.exit = exitSpy as unknown as typeof process.exit;
      try {
        await flushAndShutdown("SIGTERM");
      } finally {
        process.exit = originalExit;
      }

      expect(exitSpy).not.toHaveBeenCalled();
    });
  });
});
