import { describe, expect, it } from "vitest";

import { buildAgentPrompt } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "darwin",
};

const envNoGit: EnvInfo = {
  isGitRepo: false,
  branch: "",
  platform: "linux",
};

function makeConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: "custom",
    description: "Custom",
    builtinToolNames: [],
    extensions: true,
    skills: true,
    systemPrompt: "You are a custom agent.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
    ...overrides,
  };
}

describe("buildAgentPrompt", () => {
  it("includes cwd and git info", () => {
    const prompt = buildAgentPrompt(makeConfig(), "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles non-git repos", () => {
    const prompt = buildAgentPrompt(makeConfig(), "/workspace", envNoGit);
    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("append mode with parent prompt includes parent + custom instructions", () => {
    const config = makeConfig({
      name: "appender",
      description: "Appender",
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
    });
    const parentPrompt = "You are a parent coding agent with special powers.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("parent coding agent with special powers");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("<inherited_system_prompt>");
    expect(prompt).toContain("<agent_instructions>");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode without parent prompt falls back to generic base", () => {
    const config = makeConfig({
      name: "appender",
      description: "Appender",
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
    });
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra custom instructions here.");
  });

  it("append mode with empty systemPrompt is a pure parent clone", () => {
    const config = makeConfig({
      name: "clone",
      description: "Clone",
      systemPrompt: "",
      promptMode: "append",
    });
    const parentPrompt = "You are a parent coding agent.";
    const prompt = buildAgentPrompt(config, "/workspace", env, parentPrompt);
    expect(prompt).toContain("parent coding agent");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("<inherited_system_prompt>");
    expect(prompt).not.toContain("<agent_instructions>");
  });

  it("replace mode uses config systemPrompt directly", () => {
    const config = makeConfig({ systemPrompt: "You are a specialized agent." });
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("You are a specialized agent.");
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("You are a pi coding agent sub-agent");
  });

  it("replace mode ignores parent prompt", () => {
    const config = makeConfig({
      name: "standalone",
      description: "Standalone",
      systemPrompt: "You are a standalone agent.",
      promptMode: "replace",
    });
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      "SECRET parent prompt content"
    );
    expect(prompt).toContain("You are a standalone agent.");
    expect(prompt).not.toContain("SECRET parent prompt content");
    expect(prompt).not.toContain("<sub_agent_context>");
  });

  it("append mode bridge contains tool reminders", () => {
    const config = makeConfig({
      name: "appender",
      description: "Appender",
      systemPrompt: "",
      promptMode: "append",
    });
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      "Parent prompt."
    );
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("Use the edit tool instead of sed");
    expect(prompt).toContain("Use the grep tool instead of");
  });

  it("append mode without parent prompt still has bridge", () => {
    const config = makeConfig({
      name: "no-parent",
      description: "No parent",
      systemPrompt: "Extra stuff.",
      promptMode: "append",
    });
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("<inherited_system_prompt>");
    expect(prompt).toContain("Use the read tool instead of cat");
    expect(prompt).toContain("general-purpose coding agent");
    expect(prompt).toContain("Extra stuff.");
  });

  it("injects memory block in replace mode", () => {
    const config = makeConfig({
      name: "mem-agent",
      description: "Memory Agent",
      systemPrompt: "You are a memory agent.",
    });
    const extras = {
      memoryBlock: "# Agent Memory\nYou have persistent memory at /tmp/mem/",
    };
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      undefined,
      extras
    );
    expect(prompt).toContain("You are a memory agent.");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("persistent memory");
  });

  it("injects memory block in append mode", () => {
    const config = makeConfig({
      name: "mem-append",
      description: "Memory Append",
      systemPrompt: "Custom instructions.",
      promptMode: "append",
    });
    const extras = { memoryBlock: "# Agent Memory\nPersistent memory here." };
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      "Parent prompt.",
      extras
    );
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("Custom instructions.");
  });

  it("injects preloaded skill blocks", () => {
    const config = makeConfig({
      name: "skill-agent",
      description: "Skill Agent",
      systemPrompt: "You are a skill agent.",
    });
    const extras = {
      skillBlocks: [
        { name: "api-conventions", content: "Use REST endpoints." },
        { name: "error-handling", content: "Handle errors gracefully." },
      ],
    };
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      undefined,
      extras
    );
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("Preloaded Skill: error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });

  it("injects both memory and skills", () => {
    const config = makeConfig({
      name: "full-agent",
      description: "Full Agent",
      systemPrompt: "Full agent.",
    });
    const extras = {
      memoryBlock: "# Memory\nRemember this.",
      skillBlocks: [{ name: "skill1", content: "Skill content." }],
    };
    const prompt = buildAgentPrompt(
      config,
      "/workspace",
      env,
      undefined,
      extras
    );
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("Preloaded Skill: skill1");
  });

  it("no extras means no extra sections", () => {
    const config = makeConfig({
      name: "plain",
      description: "Plain",
      systemPrompt: "Plain agent.",
    });
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });
});
