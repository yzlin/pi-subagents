import { describe, expect, it } from "vitest";

import type { AgentRecord } from "../src/types.js";
import {
  createSubagentViewerState,
  getSubagentViewerSnapshot,
  pauseSubagentAutoFollow,
  resumeSubagentAutoFollow,
  selectNextSubagent,
  selectPreviousSubagent,
  selectSubagentByIndex,
} from "../src/ui/subagent-viewer-state.js";

function agent(id: string, startedAt: number): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: id,
    status: "running",
    toolUses: 0,
    startedAt,
  };
}

const agents = [agent("middle", 200), agent("first", 100), agent("last", 300)];

describe("subagent viewer state", () => {
  it("orders current-session agents by creation time and exposes selection metadata", () => {
    const snapshot = getSubagentViewerSnapshot(
      agents,
      createSubagentViewerState()
    );

    expect(snapshot.agents.map((a) => a.id)).toEqual([
      "first",
      "middle",
      "last",
    ]);
    expect(snapshot.selectedAgentId).toBe("last");
    expect(snapshot.selectedIndex).toBe(2);
    expect(snapshot.count).toBe(3);
    expect(snapshot.hasAgents).toBe(true);
    expect(snapshot.hasPrevious).toBe(true);
    expect(snapshot.hasNext).toBe(false);
  });

  it("navigates previous and next in creation order while pausing auto-follow", () => {
    const initial = createSubagentViewerState();
    const previous = selectPreviousSubagent(agents, initial);

    expect(previous.autoFollow).toBe(false);
    expect(getSubagentViewerSnapshot(agents, previous).selectedAgentId).toBe(
      "middle"
    );

    const next = selectNextSubagent(agents, previous);

    expect(next.autoFollow).toBe(false);
    expect(getSubagentViewerSnapshot(agents, next).selectedAgentId).toBe(
      "last"
    );
  });

  it("keeps the selected agent stable when its status changes", () => {
    const selected = selectSubagentByIndex(
      agents,
      createSubagentViewerState(),
      1
    );
    const completedAgents = agents.map((a) =>
      a.id === "middle" ? { ...a, status: "completed" as const } : a
    );

    const snapshot = getSubagentViewerSnapshot(completedAgents, selected);

    expect(snapshot.selectedAgentId).toBe("middle");
    expect(snapshot.selectedIndex).toBe(1);
  });

  it("selects a stable neighbor when the selected agent is removed", () => {
    const selected = selectSubagentByIndex(
      agents,
      createSubagentViewerState(),
      1
    );
    const remainingAgents = agents.filter((a) => a.id !== "middle");

    const snapshot = getSubagentViewerSnapshot(remainingAgents, selected);

    expect(snapshot.agents.map((a) => a.id)).toEqual(["first", "last"]);
    expect(snapshot.selectedAgentId).toBe("last");
    expect(snapshot.selectedIndex).toBe(1);
  });

  it("returns an empty state without selection", () => {
    const snapshot = getSubagentViewerSnapshot([], createSubagentViewerState());

    expect(snapshot.agents).toEqual([]);
    expect(snapshot.selectedAgent).toBeUndefined();
    expect(snapshot.selectedAgentId).toBeUndefined();
    expect(snapshot.selectedIndex).toBe(-1);
    expect(snapshot.count).toBe(0);
    expect(snapshot.hasAgents).toBe(false);
    expect(snapshot.hasPrevious).toBe(false);
    expect(snapshot.hasNext).toBe(false);
  });

  it("pauses auto-follow at the current agent and resumes following the newest agent", () => {
    const paused = pauseSubagentAutoFollow(agents, createSubagentViewerState());

    expect(paused.autoFollow).toBe(false);
    expect(getSubagentViewerSnapshot(agents, paused).selectedAgentId).toBe(
      "last"
    );

    const withNewAgent = [...agents, agent("newest", 400)];
    expect(
      getSubagentViewerSnapshot(withNewAgent, paused).selectedAgentId
    ).toBe("last");

    const resumed = resumeSubagentAutoFollow(withNewAgent, paused);

    expect(resumed.autoFollow).toBe(true);
    expect(
      getSubagentViewerSnapshot(withNewAgent, resumed).selectedAgentId
    ).toBe("newest");
  });
});
