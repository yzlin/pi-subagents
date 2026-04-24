/**
 * agent-types.ts — Unified agent type registry.
 *
 * Tracks user-defined agents from .pi/agents/*.md.
 * Disabled agents are kept but excluded from spawning.
 */

import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
} from "@mariozechner/pi-coding-agent";

import type { AgentConfig } from "./types.js";

const TOOL_FACTORIES = {
  read: (cwd: string) => createReadTool(cwd),
  bash: (cwd: string) => createBashTool(cwd),
  edit: (cwd: string) => createEditTool(cwd),
  write: (cwd: string) => createWriteTool(cwd),
  grep: (cwd: string) => createGrepTool(cwd),
  find: (cwd: string) => createFindTool(cwd),
  ls: (cwd: string) => createLsTool(cwd),
};

type BuiltinToolName = keyof typeof TOOL_FACTORIES;
type BuiltinTool = ReturnType<(typeof TOOL_FACTORIES)[BuiltinToolName]>;

function isBuiltinToolName(name: string): name is BuiltinToolName {
  return name in TOOL_FACTORIES;
}

/** All known built-in tool names, derived from the factory registry. */
export const BUILTIN_TOOL_NAMES = Object.keys(
  TOOL_FACTORIES
) as BuiltinToolName[];

/** Unified runtime registry of user-defined agents. */
const agents = new Map<string, AgentConfig>();

/**
 * Register user-defined agents into the unified registry.
 * Disabled agents (enabled === false) are kept in the registry but excluded from spawning.
 */
export function registerAgents(userAgents: Map<string, AgentConfig>): void {
  agents.clear();

  for (const [name, config] of userAgents) {
    agents.set(name, config);
  }
}

/** Case-insensitive key resolution. */
function resolveKey(name: string): string | undefined {
  if (agents.has(name)) {
    return name;
  }
  const lower = name.toLowerCase();
  for (const key of agents.keys()) {
    if (key.toLowerCase() === lower) {
      return key;
    }
  }
  return undefined;
}

/** Resolve a type name case-insensitively. Returns the canonical key or undefined. */
export function resolveType(name: string): string | undefined {
  return resolveKey(name);
}

/** Get the agent config for a type (case-insensitive). */
export function getAgentConfig(name: string): AgentConfig | undefined {
  const key = resolveKey(name);
  return key ? agents.get(key) : undefined;
}

/** Get all enabled type names (for spawning and tool descriptions). */
export function getAvailableTypes(): string[] {
  return [...agents.entries()]
    .filter(([_, config]) => config.enabled !== false)
    .map(([name]) => name);
}

/** Get all type names including disabled (for UI listing). */
export function getAllTypes(): string[] {
  return [...agents.keys()];
}

/** Get names of user-defined agents currently in the registry. */
export function getUserAgentNames(): string[] {
  return [...agents.keys()];
}

/** Check if a type is valid and enabled (case-insensitive). */
export function isValidType(type: string): boolean {
  const key = resolveKey(type);
  if (!key) {
    return false;
  }
  return agents.get(key)?.enabled !== false;
}

/** Tool names required for memory management. */
const MEMORY_TOOL_NAMES: BuiltinToolName[] = ["read", "write", "edit"];

/**
 * Get the tools needed for memory management (read, write, edit).
 * Only returns tools that are NOT already in the provided set.
 */
export function getMemoryTools(
  cwd: string,
  existingToolNames: Set<string>
): BuiltinTool[] {
  return MEMORY_TOOL_NAMES.filter(
    (name) => !existingToolNames.has(name) && isBuiltinToolName(name)
  ).map((name) => TOOL_FACTORIES[name](cwd));
}

/** Tool names needed for read-only memory access. */
const READONLY_MEMORY_TOOL_NAMES: BuiltinToolName[] = ["read"];

/**
 * Get only the read tool for read-only memory access.
 * Only returns tools that are NOT already in the provided set.
 */
export function getReadOnlyMemoryTools(
  cwd: string,
  existingToolNames: Set<string>
): BuiltinTool[] {
  return READONLY_MEMORY_TOOL_NAMES.filter(
    (name) => !existingToolNames.has(name) && isBuiltinToolName(name)
  ).map((name) => TOOL_FACTORIES[name](cwd));
}

/** Get built-in tools for a type (case-insensitive). */
export function getToolsForType(type: string, cwd: string): BuiltinTool[] {
  const key = resolveKey(type);
  const raw = key ? agents.get(key) : undefined;
  const config = raw?.enabled === false ? undefined : raw;
  if (!config) {
    return [];
  }
  const toolNames = config.builtinToolNames?.length
    ? config.builtinToolNames
    : BUILTIN_TOOL_NAMES;
  return toolNames
    .filter(isBuiltinToolName)
    .map((name) => TOOL_FACTORIES[name](cwd));
}

/** Get config for a type (case-insensitive, returns a SubagentTypeConfig-compatible object). */
export function getConfig(type: string): {
  displayName: string;
  description: string;
  builtinToolNames: string[];
  extensions: true | string[] | false;
  skills: true | string[] | false;
  promptMode: "replace" | "append";
} {
  const key = resolveKey(type);
  const config = key ? agents.get(key) : undefined;
  if (config && config.enabled !== false) {
    return {
      displayName: config.displayName ?? config.name,
      description: config.description,
      builtinToolNames: config.builtinToolNames ?? BUILTIN_TOOL_NAMES,
      extensions: config.extensions,
      skills: config.skills,
      promptMode: config.promptMode,
    };
  }

  return {
    displayName: type,
    description: "User-defined agent type not found",
    builtinToolNames: [],
    extensions: false,
    skills: false,
    promptMode: "replace",
  };
}
