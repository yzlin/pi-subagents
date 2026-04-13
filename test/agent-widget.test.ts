import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { type AgentActivity, AgentWidget, type Theme, type UICtx } from "../src/ui/agent-widget.js";

const theme: Theme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

describe("AgentWidget", () => {
  it("shows running model and thinking level in status text and widget line", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-13T12:00:05Z"));

    const agent: AgentRecord = {
      id: "agent-1",
      type: "general-purpose",
      description: "Investigate bug",
      status: "running",
      modelName: "haiku",
      thinkingLevel: "high",
      toolUses: 1,
      startedAt: Date.parse("2026-04-13T12:00:00Z"),
    };

    const activity = new Map<string, AgentActivity>([
      ["agent-1", {
        activeTools: new Map(),
        toolUses: 1,
        tokens: "",
        responseText: "Tracing the root cause",
        turnCount: 2,
        maxTurns: 10,
      }],
    ]);

    let statusText: string | undefined;
    let widgetFactory: ((tui: any, theme: Theme) => { render(): string[]; invalidate(): void }) | undefined;

    const uiCtx: UICtx = {
      setStatus: (_key, text) => {
        statusText = text;
      },
      setWidget: (_key, content) => {
        widgetFactory = content;
      },
    };

    const manager = {
      listAgents: () => [agent],
    } as any;

    const widget = new AgentWidget(manager, activity);
    widget.setUICtx(uiCtx);
    widget.update();

    expect(statusText).toBe("1 running agent · haiku:high");

    expect(widgetFactory).toBeDefined();
    const rendered = widgetFactory!({ terminal: { columns: 200 } }, theme).render();
    expect(rendered[1]).toContain("haiku:high");

    vi.useRealTimers();
  });
});
