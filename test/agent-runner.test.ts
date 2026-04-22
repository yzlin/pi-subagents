import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, settingsManagerCreate, resourceLoaderOptions } =
  vi.hoisted(() => ({
    createAgentSession: vi.fn(),
    settingsManagerCreate: vi.fn(() => ({ kind: "settings-manager" })),
    resourceLoaderOptions: [] as Record<string, unknown>[],
  }));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession,
  DefaultResourceLoader: class {
    constructor(options: Record<string, unknown>) {
      resourceLoaderOptions.push(options);
    }
    async reload() {
      /* noop */
    }
  },
  getAgentDir: vi.fn(() => "/Users/test/.pi/agent"),
  SessionManager: {
    inMemory: vi.fn(() => ({ kind: "memory-session-manager" })),
  },
  SettingsManager: {
    create(cwd: string) {
      return (settingsManagerCreate as (pathValue: string) => { kind: string })(
        cwd
      );
    },
  },
}));

const DEFAULT_CONFIG = {
  displayName: "Explore",
  description: "Explore",
  builtinToolNames: ["read"],
  extensions: false,
  skills: false,
  promptMode: "replace",
};

const DEFAULT_AGENT_CONFIG = {
  name: "Explore",
  description: "Explore",
  builtinToolNames: ["read"],
  extensions: false,
  skills: false,
  systemPrompt: "You are Explore.",
  promptMode: "replace",
  inheritContext: false,
  runInBackground: false,
  isolated: false,
};

vi.mock("../src/agent-types.js", () => ({
  getConfig: vi.fn(() => DEFAULT_CONFIG),
  getAgentConfig: vi.fn(() => DEFAULT_AGENT_CONFIG),
  getMemoryTools: vi.fn(() => []),
  getReadOnlyMemoryTools: vi.fn(() => []),
  getToolsForType: vi.fn(() => [{ name: "read" }]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({
    isGitRepo: false,
    branch: "",
    platform: "linux",
  })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { getAgentConfig, getConfig } from "../src/agent-types.js";
import { parentBridge } from "../src/parent-bridge.js";

function createSession(finalText: string) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {
        /* noop */
      };
    }),
    prompt: vi.fn(() => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {
      /* noop */
    }),
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  settingsManagerCreate.mockClear();
  resourceLoaderOptions.length = 0;
  vi.mocked(getConfig).mockReturnValue(DEFAULT_CONFIG as any);
  vi.mocked(getAgentConfig).mockReturnValue(DEFAULT_AGENT_CONFIG as any);
  parentBridge.disposeAll("test cleanup");
  parentBridge.drainAllMessages();
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("passes the effective cwd into SettingsManager.create", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say LOCKED", {
      pi,
      cwd: "/tmp/worktree",
    });

    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/worktree");
  });

  it("falls back to process.cwd when both options.cwd and ctx.cwd are missing", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/tmp/process-cwd");

    await runAgent({ ...ctx, cwd: undefined }, "Explore", "Say LOCKED", {
      pi,
    });

    expect(settingsManagerCreate).toHaveBeenCalledWith("/tmp/process-cwd");
    cwdSpy.mockRestore();
  });

  it("passes agentDir to DefaultResourceLoader", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(resourceLoaderOptions[0]).toEqual(
      expect.objectContaining({
        cwd: "/tmp",
        agentDir: "/Users/test/.pi/agent",
      })
    );
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) })
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("does not inherit parent-only bridge tools into child sessions", async () => {
    const { session } = createSession("BOUND");
    session.getActiveToolNames.mockReturnValue([
      "read",
      "reply_to_subagent",
      "get_subagent_message",
      "steer_subagent",
    ]);
    createAgentSession.mockResolvedValue({ session });
    vi.mocked(getConfig).mockReturnValue({
      ...DEFAULT_CONFIG,
      extensions: true,
    } as any);
    vi.mocked(getAgentConfig).mockReturnValue({
      ...DEFAULT_AGENT_CONFIG,
      extensions: true,
    } as any);

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
  });

  it("adds parent bridge tools to the allowlist and custom tool registry", async () => {
    const { session } = createSession("BRIDGED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BRIDGED", { pi, agentId: "agent-123" });

    const sessionOptions = createAgentSession.mock.calls[0][0] as {
      tools: string[];
      customTools: Array<{ name: string }>;
    };
    expect(sessionOptions.tools).toEqual(
      expect.arrayContaining(["read", "message_parent", "ask_parent"])
    );
    expect(sessionOptions.customTools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["message_parent", "ask_parent"])
    );
  });

  it("message_parent queues a one-way parent update", async () => {
    const { session } = createSession("BRIDGED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Send update", { pi, agentId: "agent-123" });

    const sessionOptions = createAgentSession.mock.calls[0][0] as {
      customTools: Array<{
        name: string;
        execute: (toolCallId: string, params: unknown) => Promise<any>;
      }>;
    };
    const messageParentTool = sessionOptions.customTools.find(
      (tool) => tool.name === "message_parent"
    );

    expect(messageParentTool).toBeDefined();

    const result = await messageParentTool!.execute("tool-call-1", {
      message: "Heads up",
    });
    const queued = parentBridge.drainMessages("agent-123");

    expect(result.content).toEqual([
      {
        type: "text",
        text: `Queued message for parent (${result.details.requestId}).`,
      },
    ]);
    expect(result.details.requestId).toEqual(expect.any(String));
    expect(queued).toEqual([
      expect.objectContaining({
        agentId: "agent-123",
        requestId: result.details.requestId,
        kind: "message",
        message: "Heads up",
      }),
    ]);
  });

  it("ask_parent queues a request and resolves with the parent reply", async () => {
    const { session } = createSession("BRIDGED");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Need approval", {
      pi,
      agentId: "agent-123",
    });

    const sessionOptions = createAgentSession.mock.calls[0][0] as {
      customTools: Array<{
        name: string;
        execute: (
          toolCallId: string,
          params: unknown,
          signal?: AbortSignal
        ) => Promise<any>;
      }>;
    };
    const askParentTool = sessionOptions.customTools.find(
      (tool) => tool.name === "ask_parent"
    );

    expect(askParentTool).toBeDefined();

    const resultPromise = askParentTool!.execute("tool-call-2", {
      message: "Approve deploy?",
      timeout_ms: 250,
    });
    const [queued] = parentBridge.drainMessages("agent-123");

    expect(queued).toMatchObject({
      agentId: "agent-123",
      kind: "ask",
      message: "Approve deploy?",
    });
    expect(parentBridge.getPendingAskCount("agent-123")).toBe(1);
    expect(parentBridge.replyToAsk(queued.requestId, "Approved")).toBe(true);

    await expect(resultPromise).resolves.toEqual({
      content: [{ type: "text", text: "Approved" }],
      details: { requestId: queued.requestId },
    });
    expect(parentBridge.getPendingAskCount("agent-123")).toBe(0);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });
});
