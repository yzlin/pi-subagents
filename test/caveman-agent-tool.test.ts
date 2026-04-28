import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, resourceLoaderOptions } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  resourceLoaderOptions: [] as Array<{
    systemPromptOverride?: () => string;
  }>,
}));

vi.mock("@mariozechner/pi-coding-agent", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@mariozechner/pi-coding-agent")>();
  return {
    ...actual,
    createAgentSession,
    DefaultResourceLoader: class {
      constructor(options: { systemPromptOverride?: () => string }) {
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
      create: vi.fn(() => ({ kind: "settings-manager" })),
    },
  };
});

import registerExtension from "../src/index.js";

const AGENT_ID_REGEX = /Agent ID: (\S+)/;

function createSession(finalText: string) {
  const session = {
    messages: [] as any[],
    subscribe: vi.fn(() => () => {
      /* noop */
    }),
    prompt: vi.fn(() => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => []),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {
      /* noop */
    }),
    getSessionStats: vi.fn(() => ({ tokens: { total: 0 } })),
  };
  return session;
}

function createPiWithFakeCavemanHook(options?: {
  apply?: "success" | "failure";
}) {
  const tools = new Map<string, any>();
  const handlers = new Map<string, (event: unknown, ctx?: unknown) => void>();
  const applyRequests: Array<{ enabled: boolean; systemPrompt: string }> = [];
  const pi = {
    registerTool: vi.fn((tool: any) => tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    on: vi.fn(
      (
        event: string,
        handler: (agentEvent: unknown, ctx?: unknown) => void
      ) => {
        handlers.set(event, handler);
        return () => handlers.delete(event);
      }
    ),
    events: {
      on: vi.fn(() => () => {
        /* noop */
      }),
      emit: vi.fn((channel: string, payload: unknown) => {
        if (channel === "caveman:rpc:capabilities") {
          (payload as { respond: (response: unknown) => void }).respond({
            success: true,
            data: { version: 1, supportsApply: true },
          });
          return;
        }
        if (channel === "caveman:rpc:apply") {
          const request = payload as {
            enabled: boolean;
            systemPrompt: string;
            respond: (response: unknown) => void;
          };
          applyRequests.push({
            enabled: request.enabled,
            systemPrompt: request.systemPrompt,
          });
          if (options?.apply === "failure") {
            request.respond({ success: false, error: "nope" });
            return;
          }
          request.respond({
            success: true,
            data: {
              version: 1,
              systemPrompt: `${request.systemPrompt}\n\nFAKE CAVEMAN HOOK`,
            },
          });
        }
      }),
    },
  } as any;
  return { pi, tools, applyRequests, handlers };
}

describe("Agent tool caveman frontmatter integration", () => {
  let tmpDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pi-subagents-caveman-"));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = tmpDir;
    process.chdir(tmpDir);
    mkdirSync(join(tmpDir, ".pi", "agents"), { recursive: true });
    writeFileSync(
      join(tmpDir, ".pi", "agents", "cave.md"),
      `---
description: Cave Agent
tools: none
extensions: false
skills: false
caveman: true
---

You are Cave Agent.`,
      "utf-8"
    );
    resourceLoaderOptions.length = 0;
    createAgentSession.mockReset();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalHome == null) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("applies caveman through the registered Agent tool spawn path", async () => {
    createAgentSession.mockResolvedValue({ session: createSession("DONE") });
    const { pi, tools, applyRequests, handlers } =
      createPiWithFakeCavemanHook();
    registerExtension(pi);

    const result = await tools.get("Agent").execute(
      "tool-call-1",
      {
        subagent_type: "cave",
        prompt: "Do cave task",
        description: "Cave task",
      },
      undefined,
      vi.fn(),
      {
        cwd: tmpDir,
        hasUI: true,
        ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() },
        model: undefined,
        modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
        getSystemPrompt: vi.fn(() => "parent prompt"),
        sessionManager: {
          getBranch: vi.fn(() => []),
          getSessionId: vi.fn(() => "parent-session"),
        },
      }
    );

    expect(applyRequests).toEqual([
      expect.objectContaining({
        enabled: true,
        systemPrompt: expect.stringContaining("You are Cave Agent."),
      }),
    ]);
    expect(resourceLoaderOptions[0].systemPromptOverride?.()).toContain(
      "FAKE CAVEMAN HOOK"
    );
    expect(result.content[0].text).toContain("DONE");
    expect(result.details.tags).toContain("caveman:on");
    handlers.get("session_shutdown")?.({}, undefined);
  });

  it("keeps background caveman RPC warnings out of UI notifications and in result details", async () => {
    createAgentSession.mockResolvedValue({ session: createSession("DONE") });
    const { pi, tools, handlers } = createPiWithFakeCavemanHook({
      apply: "failure",
    });
    registerExtension(pi);
    const notify = vi.fn();
    const ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent prompt"),
      sessionManager: {
        getBranch: vi.fn(() => []),
        getSessionId: vi.fn(() => "parent-session"),
      },
    };

    const started = await tools.get("Agent").execute(
      "tool-call-1",
      {
        subagent_type: "cave",
        prompt: "Do cave task",
        description: "Cave task",
        run_in_background: true,
      },
      undefined,
      vi.fn(),
      ctx
    );
    const id = started.content[0].text.match(AGENT_ID_REGEX)?.[1];
    expect(id).toBeDefined();

    const result = await tools
      .get("get_subagent_result")
      .execute(
        "tool-call-2",
        { agent_id: id, wait: true },
        undefined,
        vi.fn(),
        ctx
      );

    expect(notify).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain(
      "Caveman mode requested but caveman RPC apply failed."
    );
    expect(result.details.warnings).toEqual([
      "Caveman mode requested but caveman RPC apply failed.",
    ]);
    expect(result.details.tags).toContain("caveman:unavailable");
    handlers.get("session_shutdown")?.({}, ctx);
  });

  it("keeps background invalid caveman frontmatter warnings out of UI notifications and in result details", async () => {
    writeFileSync(
      join(tmpDir, ".pi", "agents", "bad-cave.md"),
      `---
description: Bad Cave Agent
tools: none
extensions: false
skills: false
caveman: yes please
---

You are Bad Cave Agent.`,
      "utf-8"
    );
    createAgentSession.mockResolvedValue({ session: createSession("DONE") });
    const { pi, tools, handlers } = createPiWithFakeCavemanHook();
    registerExtension(pi);
    const notify = vi.fn();
    const ctx = {
      cwd: tmpDir,
      hasUI: true,
      ui: { notify, setStatus: vi.fn(), setWidget: vi.fn() },
      model: undefined,
      modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
      getSystemPrompt: vi.fn(() => "parent prompt"),
      sessionManager: {
        getBranch: vi.fn(() => []),
        getSessionId: vi.fn(() => "parent-session"),
      },
    };

    const started = await tools.get("Agent").execute(
      "tool-call-1",
      {
        subagent_type: "bad-cave",
        prompt: "Do cave task",
        description: "Bad cave task",
        run_in_background: true,
      },
      undefined,
      vi.fn(),
      ctx
    );
    const id = started.content[0].text.match(AGENT_ID_REGEX)?.[1];
    expect(id).toBeDefined();

    const result = await tools
      .get("get_subagent_result")
      .execute(
        "tool-call-2",
        { agent_id: id, wait: true },
        undefined,
        vi.fn(),
        ctx
      );

    const warning =
      'Agent "bad-cave" has non-boolean caveman frontmatter; ignoring it.';
    expect(notify).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain(warning);
    expect(result.details.warnings).toEqual([warning]);
    handlers.get("session_shutdown")?.({}, ctx);
  });
});
