import { beforeEach, describe, expect, it } from "vitest";

import {
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getAllTypes,
  getAvailableTypes,
  getConfig,
  getMemoryTools,
  getReadOnlyMemoryTools,
  getToolsForType,
  getUserAgentNames,
  isValidType,
  registerAgents,
  resolveType,
} from "../src/agent-types.js";
import type { AgentConfig } from "../src/types.js";

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "test-agent",
    description: "Test agent",
    builtinToolNames: ["read", "grep"],
    extensions: false,
    skills: false,
    systemPrompt: "You are a test agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("agent type registry", () => {
  beforeEach(() => {
    registerAgents(new Map());
  });

  describe("empty default registry", () => {
    it("ships no embedded default agent types", () => {
      expect(getAvailableTypes()).toEqual([]);
      expect(isValidType("general-purpose")).toBe(false);
      expect(isValidType("Explore")).toBe(false);
      expect(isValidType("Plan")).toBe(false);
    });

    it("rejects unknown types", () => {
      expect(isValidType("nonexistent")).toBe(false);
      expect(isValidType("")).toBe(false);
      expect(resolveType("nonexistent")).toBeUndefined();
    });

    it("getConfig returns a non-spawnable placeholder for missing types", () => {
      const config = getConfig("nonexistent");
      expect(config.displayName).toBe("nonexistent");
      expect(config.description).toBe("User-defined agent type not found");
      expect(config.builtinToolNames).toEqual([]);
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(false);
    });

    it("getToolsForType returns no tools for missing types", () => {
      expect(getToolsForType("nonexistent", "/tmp")).toEqual([]);
    });

    it("BUILTIN_TOOL_NAMES is derived from factory keys", () => {
      expect(BUILTIN_TOOL_NAMES).toContain("read");
      expect(BUILTIN_TOOL_NAMES).toContain("bash");
      expect(BUILTIN_TOOL_NAMES).toContain("edit");
      expect(BUILTIN_TOOL_NAMES).toContain("write");
      expect(BUILTIN_TOOL_NAMES).toContain("grep");
      expect(BUILTIN_TOOL_NAMES).toContain("find");
      expect(BUILTIN_TOOL_NAMES).toContain("ls");
      expect(BUILTIN_TOOL_NAMES.length).toBeGreaterThanOrEqual(7);
    });
  });

  describe("user agents", () => {
    it("registers and retrieves user agents", () => {
      const agents = new Map([
        [
          "auditor",
          makeAgentConfig({ name: "auditor", description: "Auditor" }),
        ],
      ]);
      registerAgents(agents);

      expect(isValidType("auditor")).toBe(true);
      expect(getAgentConfig("auditor")?.description).toBe("Auditor");
    });

    it("case-insensitive lookup works for user agents", () => {
      const agents = new Map([
        [
          "auditor",
          makeAgentConfig({ name: "auditor", description: "Auditor" }),
        ],
      ]);
      registerAgents(agents);

      expect(isValidType("AUDITOR")).toBe(true);
      expect(getAgentConfig("Auditor")?.name).toBe("auditor");
      expect(resolveType("AUDITOR")).toBe("auditor");
    });

    it("includes only user agents in available types", () => {
      const agents = new Map([
        ["auditor", makeAgentConfig({ name: "auditor" })],
      ]);
      registerAgents(agents);

      expect(getAvailableTypes()).toEqual(["auditor"]);
    });

    it("lists user agent names", () => {
      const agents = new Map([
        ["auditor", makeAgentConfig({ name: "auditor" })],
        ["reviewer", makeAgentConfig({ name: "reviewer" })],
      ]);
      registerAgents(agents);

      expect(getUserAgentNames()).toEqual(["auditor", "reviewer"]);
    });

    it("getConfig returns config for user agents", () => {
      const agents = new Map([
        [
          "auditor",
          makeAgentConfig({
            name: "auditor",
            description: "Security auditor",
            builtinToolNames: ["read", "grep"],
            extensions: false,
            skills: true,
          }),
        ],
      ]);
      registerAgents(agents);

      const config = getConfig("auditor");
      expect(config.displayName).toBe("auditor");
      expect(config.description).toBe("Security auditor");
      expect(config.builtinToolNames).toEqual(["read", "grep"]);
      expect(config.extensions).toBe(false);
      expect(config.skills).toBe(true);
    });

    it("getConfig returns extension allowlist for user agents", () => {
      const agents = new Map([
        [
          "partial",
          makeAgentConfig({
            name: "partial",
            extensions: ["web-search"],
            skills: ["planning"],
          }),
        ],
      ]);
      registerAgents(agents);

      const config = getConfig("partial");
      expect(config.extensions).toEqual(["web-search"]);
      expect(config.skills).toEqual(["planning"]);
    });

    it("getToolsForType works for user agents", () => {
      const agents = new Map([
        [
          "auditor",
          makeAgentConfig({
            name: "auditor",
            builtinToolNames: ["read", "grep", "find"],
          }),
        ],
      ]);
      registerAgents(agents);

      const tools = getToolsForType("auditor", "/tmp");
      expect(tools).toHaveLength(3);
    });

    it("clearing user agents removes all available types", () => {
      const agents = new Map([
        ["auditor", makeAgentConfig({ name: "auditor" })],
      ]);
      registerAgents(agents);
      expect(isValidType("auditor")).toBe(true);

      registerAgents(new Map());
      expect(isValidType("auditor")).toBe(false);
      expect(getAvailableTypes()).toEqual([]);
    });

    it("allows user agents with names formerly used by defaults", () => {
      const agents = new Map([
        [
          "Explore",
          makeAgentConfig({
            name: "Explore",
            description: "Custom Explore",
            builtinToolNames: BUILTIN_TOOL_NAMES,
          }),
        ],
      ]);
      registerAgents(agents);

      const config = getConfig("Explore");
      expect(config.description).toBe("Custom Explore");
      expect(config.builtinToolNames).toEqual(BUILTIN_TOOL_NAMES);
    });

    it("disabled agent is excluded from available types", () => {
      const agents = new Map([
        [
          "planner",
          makeAgentConfig({
            name: "planner",
            enabled: false,
          }),
        ],
      ]);
      registerAgents(agents);

      expect(isValidType("planner")).toBe(false);
      expect(getAvailableTypes()).not.toContain("planner");
      expect(getAllTypes()).toContain("planner");
    });
  });

  describe("getMemoryTools", () => {
    it("returns read, write, edit when none exist", () => {
      const tools = getMemoryTools("/tmp", new Set());
      const names = tools.map((t) => t.name);
      expect(names).toContain("read");
      expect(names).toContain("write");
      expect(names).toContain("edit");
      expect(names).toHaveLength(3);
    });

    it("skips tools that already exist", () => {
      const tools = getMemoryTools("/tmp", new Set(["read", "edit"]));
      const names = tools.map((t) => t.name);
      expect(names).toEqual(["write"]);
    });

    it("returns empty when all memory tools already exist", () => {
      const tools = getMemoryTools("/tmp", new Set(["read", "write", "edit"]));
      expect(tools).toHaveLength(0);
    });
  });

  describe("getReadOnlyMemoryTools", () => {
    it("returns only read when missing", () => {
      const tools = getReadOnlyMemoryTools("/tmp", new Set());
      const names = tools.map((t) => t.name);
      expect(names).toEqual(["read"]);
    });

    it("returns empty when read already exists", () => {
      const tools = getReadOnlyMemoryTools("/tmp", new Set(["read"]));
      expect(tools).toHaveLength(0);
    });
  });
});
