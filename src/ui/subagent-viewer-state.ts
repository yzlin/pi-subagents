import type { AgentRecord } from "../types.js";

export type ViewerAgent = Pick<AgentRecord, "id" | "startedAt">;

export interface SubagentViewerState {
  /** Selected agent id while auto-follow is paused. */
  selectedAgentId?: string;
  /** Last selected creation-order index, used to choose a stable neighbor after removal. */
  selectedIndex: number;
  /** When true, the viewer follows the newest current-session agent. */
  autoFollow: boolean;
}

export interface SubagentViewerSnapshot<TAgent extends ViewerAgent> {
  agents: TAgent[];
  selectedAgent?: TAgent;
  selectedAgentId?: string;
  selectedIndex: number;
  count: number;
  hasAgents: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  autoFollow: boolean;
}

function byCreationTime<TAgent extends ViewerAgent>(
  a: TAgent,
  b: TAgent
): number {
  const delta = a.startedAt - b.startedAt;
  return delta === 0 ? a.id.localeCompare(b.id) : delta;
}

function clampIndex(index: number, count: number): number {
  if (count === 0) {
    return -1;
  }
  return Math.min(Math.max(index, 0), count - 1);
}

function createManualSelectionState<TAgent extends ViewerAgent>(
  snapshot: SubagentViewerSnapshot<TAgent>,
  index: number
): SubagentViewerState {
  const selectedIndex = clampIndex(index, snapshot.count);
  return {
    selectedAgentId: snapshot.agents[selectedIndex]?.id,
    selectedIndex: Math.max(selectedIndex, 0),
    autoFollow: false,
  };
}

export function createSubagentViewerState(): SubagentViewerState {
  return {
    selectedIndex: 0,
    autoFollow: true,
  };
}

export function getSubagentViewerSnapshot<TAgent extends ViewerAgent>(
  agents: readonly TAgent[],
  state: SubagentViewerState
): SubagentViewerSnapshot<TAgent> {
  const orderedAgents = [...agents].sort(byCreationTime);
  const count = orderedAgents.length;

  if (count === 0) {
    return {
      agents: orderedAgents,
      selectedIndex: -1,
      count: 0,
      hasAgents: false,
      hasPrevious: false,
      hasNext: false,
      autoFollow: state.autoFollow,
    };
  }

  const selectedAgentIndex = state.selectedAgentId
    ? orderedAgents.findIndex((agent) => agent.id === state.selectedAgentId)
    : -1;
  const targetIndex =
    selectedAgentIndex === -1 ? state.selectedIndex : selectedAgentIndex;
  const selectedIndex = state.autoFollow
    ? count - 1
    : clampIndex(targetIndex, count);
  const selectedAgent = orderedAgents[selectedIndex];

  return {
    agents: orderedAgents,
    selectedAgent,
    selectedAgentId: selectedAgent?.id,
    selectedIndex,
    count,
    hasAgents: true,
    hasPrevious: selectedIndex > 0,
    hasNext: selectedIndex < count - 1,
    autoFollow: state.autoFollow,
  };
}

export function selectSubagentByIndex<TAgent extends ViewerAgent>(
  agents: readonly TAgent[],
  state: SubagentViewerState,
  index: number
): SubagentViewerState {
  return createManualSelectionState(
    getSubagentViewerSnapshot(agents, state),
    index
  );
}

export function selectNextSubagent<TAgent extends ViewerAgent>(
  agents: readonly TAgent[],
  state: SubagentViewerState
): SubagentViewerState {
  const snapshot = getSubagentViewerSnapshot(agents, state);
  return createManualSelectionState(snapshot, snapshot.selectedIndex + 1);
}

export function selectPreviousSubagent<TAgent extends ViewerAgent>(
  agents: readonly TAgent[],
  state: SubagentViewerState
): SubagentViewerState {
  const snapshot = getSubagentViewerSnapshot(agents, state);
  return createManualSelectionState(snapshot, snapshot.selectedIndex - 1);
}

export function pauseSubagentAutoFollow<TAgent extends ViewerAgent>(
  agents: readonly TAgent[],
  state: SubagentViewerState
): SubagentViewerState {
  const snapshot = getSubagentViewerSnapshot(agents, state);
  return {
    selectedAgentId: snapshot.selectedAgentId,
    selectedIndex: Math.max(snapshot.selectedIndex, 0),
    autoFollow: false,
  };
}

export function resumeSubagentAutoFollow<TAgent extends ViewerAgent>(
  agents: readonly TAgent[],
  state: SubagentViewerState
): SubagentViewerState {
  const snapshot = getSubagentViewerSnapshot(agents, {
    ...state,
    autoFollow: true,
  });
  return {
    selectedAgentId: snapshot.selectedAgentId,
    selectedIndex: Math.max(snapshot.selectedIndex, 0),
    autoFollow: true,
  };
}
