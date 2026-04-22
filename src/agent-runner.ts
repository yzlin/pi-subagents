/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import {
  getAgentConfig,
  getConfig,
  getMemoryTools,
  getReadOnlyMemoryTools,
  getToolsForType,
} from "./agent-types.js";
import { buildParentContext, extractText } from "./context.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { DEFAULT_PARENT_SESSION_ID, parentBridge } from "./parent-bridge.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { SubagentType, ThinkingLevel } from "./types.js";

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES = [
  "Agent",
  "get_subagent_result",
  "steer_subagent",
  "reply_to_subagent",
  "get_subagent_message",
];

const NOOP = () => {
  /* noop */
};

function sdkExpectsToolAllowlist(): boolean {
  return SettingsManager.create.length >= 1;
}

interface ToolCallContentBlock {
  type: "toolCall";
  name?: string;
  toolName?: string;
}

function getToolCallName(content: ToolCallContentBlock): string {
  return content.name ?? content.toolName ?? "unknown";
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) {
    return undefined;
  }
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined {
  return defaultMaxTurns;
}
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void {
  defaultMaxTurns = normalizeMaxTurns(n);
}

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number {
  return graceTurns;
}
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void {
  graceTurns = Math.max(1, n);
}

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<Api> | undefined,
  registry: {
    find(provider: string, modelId: string): Model<Api> | undefined;
    getAvailable?(): Model<Api>[];
  },
  configModel?: string
): Model<Api> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) {
        return found;
      }
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Stable runtime ID for parent bridge routing. */
  agentId?: string;
  /** Parent session affinity for bridge delivery. */
  parentSessionId?: string;
  /** Whether the subagent may block on ask_parent. */
  allowAskParent?: boolean;
  model?: Model<Api>;
  maxTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start") {
      text = "";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/** Get the last assistant text from the completed session history. */
function getLastAssistantText(session: AgentSession): string {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") {
      continue;
    }
    const text = extractText(msg.content).trim();
    if (text) {
      return text;
    }
  }
  return "";
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(
  session: AgentSession,
  signal?: AbortSignal
): () => void {
  if (!signal) {
    return NOOP;
  }
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function createParentBridgeTools(
  agentId: string,
  parentSessionId = DEFAULT_PARENT_SESSION_ID,
  allowAskParent = true
) {
  const tools = [
    {
      name: "message_parent",
      label: "Message Parent",
      description: "Queue a one-way message for the parent agent.",
      parameters: Type.Object({
        message: Type.String({
          description: "The message to send to the parent agent.",
        }),
      }),
      execute(_toolCallId: string, params: unknown) {
        const { message } = params as { message: string };
        const queued = parentBridge.messageParent(agentId, message, {
          sessionId: parentSessionId,
        });
        return Promise.resolve({
          content: [
            {
              type: "text" as const,
              text: `Queued message for parent (${queued.requestId}).`,
            },
          ],
          details: { requestId: queued.requestId },
        });
      },
    },
  ];

  if (!allowAskParent) {
    return tools;
  }

  tools.push({
    name: "ask_parent",
    label: "Ask Parent",
    description: "Ask the parent agent a question and wait for a reply.",
    parameters: Type.Object({
      message: Type.String({
        description: "The question or request for the parent agent.",
      }),
      timeout_ms: Type.Optional(
        Type.Number({
          description:
            "Optional timeout in milliseconds while waiting for the parent reply.",
          minimum: 1,
        })
      ),
    }),
    async execute(_toolCallId: string, params: unknown, signal?: AbortSignal) {
      const { message, timeout_ms } = params as {
        message: string;
        timeout_ms?: number;
      };
      const reply = await parentBridge.askParent(agentId, message, {
        sessionId: parentSessionId,
        signal,
        timeoutMs: timeout_ms,
      });
      return {
        content: [{ type: "text" as const, text: reply.text }],
        details: { requestId: reply.requestId },
      };
    },
  });

  return tools;
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions
): Promise<RunResult> {
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  // Resolve working directory: worktree override > parent cwd > process cwd
  const effectiveCwd = options.cwd ?? ctx.cwd ?? process.cwd();

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};

  // Resolve extensions/skills: isolated overrides to false
  const extensions = options.isolated ? false : config.extensions;
  const skills = options.isolated ? false : config.skills;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, effectiveCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  type BuiltinSessionTool = ReturnType<typeof getToolsForType>[number];

  let builtinTools: BuiltinSessionTool[] = [
    ...getToolsForType(type, effectiveCwd),
  ];
  const customTools: ToolDefinition[] = options.agentId
    ? createParentBridgeTools(
        options.agentId,
        options.parentSessionId,
        options.allowAskParent
      )
    : [];

  // Persistent memory: detect write capability and branch accordingly.
  // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
  if (agentConfig?.memory) {
    const existingNames = new Set(builtinTools.map((t) => t.name));
    const denied = agentConfig.disallowedTools
      ? new Set(agentConfig.disallowedTools)
      : undefined;
    const effectivelyHas = (name: string) =>
      existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      // Read-write memory: add any missing memory tools (read/write/edit)
      const memTools = getMemoryTools(effectiveCwd, existingNames);
      if (memTools.length > 0) {
        builtinTools = [...builtinTools, ...memTools];
      }
      extras.memoryBlock = buildMemoryBlock(
        agentConfig.name,
        agentConfig.memory,
        effectiveCwd
      );
    } else {
      // Read-only memory: only add read tool, use read-only prompt
      if (!existingNames.has("read")) {
        const readTools = getReadOnlyMemoryTools(effectiveCwd, existingNames);
        if (readTools.length > 0) {
          builtinTools = [...builtinTools, ...readTools];
        }
      }
      extras.memoryBlock = buildReadOnlyMemoryBlock(
        agentConfig.name,
        agentConfig.memory,
        effectiveCwd
      );
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(
      agentConfig,
      effectiveCwd,
      env,
      parentSystemPrompt,
      extras
    );
  } else {
    // Unknown type fallback: general-purpose (defensive — unreachable in practice
    // since index.ts resolves unknown types to "general-purpose" before calling runAgent)
    systemPrompt = buildAgentPrompt(
      {
        name: type,
        description: "General-purpose agent",
        systemPrompt: "",
        promptMode: "append",
        extensions: true,
        skills: true,
        inheritContext: false,
        runInBackground: false,
        isolated: false,
      },
      effectiveCwd,
      env,
      parentSystemPrompt,
      extras
    );
  }

  // When skills is string[], we've already preloaded them into the prompt.
  // Still pass noSkills: true since we don't need the skill loader to load them again.
  const noSkills = skills === false || Array.isArray(skills);

  // Load extensions/skills: true or string[] → load; false → don't
  // Explicit agentDir works around pi 0.68.x DefaultResourceLoader passing an
  // undefined user-scope base dir into DefaultPackageManager for local packages.
  const agentDir = getAgentDir();
  const loader = new DefaultResourceLoader({
    cwd: effectiveCwd,
    agentDir,
    noExtensions: extensions === false,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    systemPromptOverride: () => systemPrompt,
  });
  await loader.reload();

  // Resolve model: explicit option > config.model > parent model
  const model =
    options.model ??
    resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model);

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const localToolNames = [
    ...new Set([...builtinTools, ...customTools].map((tool) => tool.name)),
  ];

  const sessionOpts: Record<string, unknown> = {
    cwd: effectiveCwd,
    sessionManager: SessionManager.inMemory(effectiveCwd),
    settingsManager: SettingsManager.create(effectiveCwd),
    modelRegistry: ctx.modelRegistry,
    model,
    customTools: customTools.length > 0 ? customTools : undefined,
    resourceLoader: loader,
  };
  sessionOpts.tools = sdkExpectsToolAllowlist() ? localToolNames : builtinTools;
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  // createAgentSession's type signature may not include thinkingLevel yet
  const { session } = await createAgentSession(
    sessionOpts as Parameters<typeof createAgentSession>[0]
  );

  // Build disallowed tools set from agent config
  const disallowedSet = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  // Filter active tools: remove our own tools to prevent nesting,
  // apply extension allowlist if specified, and apply disallowedTools denylist
  if (extensions !== false) {
    const localToolNameSet = new Set(localToolNames);
    const activeTools = session.getActiveToolNames().filter((t) => {
      if (EXCLUDED_TOOL_NAMES.includes(t)) {
        return false;
      }
      if (disallowedSet?.has(t)) {
        return false;
      }
      if (localToolNameSet.has(t)) {
        return true;
      }
      if (Array.isArray(extensions)) {
        return extensions.some((ext) => t.startsWith(ext) || t.includes(ext));
      }
      return true;
    });
    session.setActiveToolsByName(activeTools);
  } else if (disallowedSet) {
    // Even with extensions disabled, apply denylist to built-in tools
    const activeTools = session
      .getActiveToolNames()
      .filter((t) => !disallowedSet.has(t));
    session.setActiveToolsByName(activeTools);
  }

  // Bind extensions so that session_start fires and extensions can initialize
  // (e.g. loading credentials, setting up state). Placed after tool filtering
  // so extension-provided skills/prompts from extendResourcesFromExtensions()
  // respect the active tool set. All ExtensionBindings fields are optional.
  await session.bindExtensions({
    onError: (err) => {
      options.onToolActivity?.({
        type: "end",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

  options.onSessionCreated?.(session);

  // Track turns for graceful max_turns enforcement
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(
    options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns
  );
  let softLimitReached = false;
  let aborted = false;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
          session.steer(
            "You have reached your turn limit. Wrap up immediately — provide your final answer now."
          );
        } else if (softLimitReached && turnCount >= maxTurns + graceTurns) {
          aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(
        event.assistantMessageEvent.delta,
        currentMessageText
      );
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Build the effective prompt: optionally prepend parent context
  let effectivePrompt = prompt;
  if (options.inheritContext) {
    const parentContext = buildParentContext(ctx);
    if (parentContext) {
      effectivePrompt = parentContext + prompt;
    }
  }

  try {
    await session.prompt(effectivePrompt);
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText =
    collector.getText().trim() || getLastAssistantText(session);
  return { responseText, session, aborted, steered: softLimitReached };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: {
    onToolActivity?: (activity: ToolActivity) => void;
    signal?: AbortSignal;
  } = {}
): Promise<string> {
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const unsubToolUse = options.onToolActivity
    ? session.subscribe((event: AgentSessionEvent) => {
        if (event.type === "tool_execution_start") {
          options.onToolActivity!({ type: "start", toolName: event.toolName });
        }
        if (event.type === "tool_execution_end") {
          options.onToolActivity!({ type: "end", toolName: event.toolName });
        }
      })
    : NOOP;

  try {
    await session.prompt(prompt);
  } finally {
    collector.unsubscribe();
    unsubToolUse();
    cleanupAbort();
  }

  return collector.getText().trim() || getLastAssistantText(session);
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : extractText(msg.content);
      if (text.trim()) {
        parts.push(`[User]: ${text.trim()}`);
      }
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) {
          textParts.push(c.text);
        } else if (c.type === "toolCall") {
          toolCalls.push(`  Tool: ${getToolCallName(c)}`);
        }
      }
      if (textParts.length > 0) {
        parts.push(`[Assistant]: ${textParts.join("\n")}`);
      }
      if (toolCalls.length > 0) {
        parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
      }
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? `${text.slice(0, 200)}...` : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
