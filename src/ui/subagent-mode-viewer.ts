import {
  type Component,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

import type { AgentRecord } from "../types.js";
import type { Theme } from "./agent-widget.js";
import {
  type AgentActivity,
  formatDuration,
  getDisplayName,
} from "./agent-widget.js";
import {
  getConversationContentCacheKey,
  getScrollInputAction,
  getViewerScrollbarContentWidth,
  renderConversationContentLines,
  renderViewerViewportLines,
  updateScrollState,
} from "./conversation-viewer.js";
import { retainMouseWheelReporting } from "./mouse.js";
import {
  createSubagentViewerState,
  getSubagentViewerSnapshot,
  type SubagentViewerState,
  selectNextSubagent,
  selectPreviousSubagent,
} from "./subagent-viewer-state.js";

const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;

interface SubagentContentCache {
  agentId: string;
  width: number;
  key: string;
  lines: string[];
}

export class SubagentModeViewer implements Component {
  private state: SubagentViewerState = createSubagentViewerState();
  private scrollOffset = 0;
  private autoScroll = true;
  private contentCache: SubagentContentCache | undefined;
  private lastInnerW = 0;
  private closed = false;
  private readonly releaseMouseWheelReporting = retainMouseWheelReporting();
  private subscriptions: (() => void)[] = [];
  private readonly subscribedSessionIds = new Set<string>();
  private readonly tui: TUI;
  private readonly getAgents: () => AgentRecord[];
  private readonly getActivity: (agentId: string) => AgentActivity | undefined;
  private readonly theme: Theme;
  private readonly done: (result: undefined) => void;

  constructor(
    tui: TUI,
    getAgents: () => AgentRecord[],
    getActivity: (agentId: string) => AgentActivity | undefined,
    theme: Theme,
    done: (result: undefined) => void,
    subscribeToAgentUpdates?: (onUpdate: () => void) => () => void
  ) {
    this.tui = tui;
    this.getAgents = getAgents;
    this.getActivity = getActivity;
    this.theme = theme;
    this.done = done;
    if (subscribeToAgentUpdates) {
      this.subscriptions.push(
        subscribeToAgentUpdates(() => {
          if (!this.closed) {
            this.invalidateContentCache();
            this.refreshSubscriptions();
            this.tui.requestRender();
          }
        })
      );
    }
    this.refreshSubscriptions();
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.disposeResources();
      this.done(undefined);
      return;
    }

    const agents = this.getAgents();

    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.state = selectPreviousSubagent(agents, this.state);
      this.resetScroll();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "right") || matchesKey(data, "l")) {
      this.state = selectNextSubagent(agents, this.state);
      this.resetScroll();
      this.tui.requestRender();
      return;
    }

    const snapshot = getSubagentViewerSnapshot(agents, this.state);
    if (!snapshot.selectedAgent) {
      return;
    }

    const action = getScrollInputAction(data);
    if (!action) {
      return;
    }

    const totalLines = this.getContentLines(snapshot.selectedAgent).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    const nextState = updateScrollState(
      this.scrollOffset,
      action,
      viewportHeight,
      maxScroll
    );
    this.scrollOffset = nextState.scrollOffset;
    this.autoScroll = nextState.autoScroll;
  }

  render(width: number): string[] {
    if (width < 6) {
      return [];
    }

    this.refreshSubscriptions();

    const th = this.theme;
    const innerW = width - 4;
    this.lastInnerW = innerW;
    const agents = this.getAgents();
    const snapshot = getSubagentViewerSnapshot(agents, this.state);
    const selected = snapshot.selectedAgent;

    const pad = (s: string, len: number) =>
      s + " ".repeat(Math.max(0, len - visibleWidth(s)));
    const row = (content: string) =>
      th.fg("border", "│") +
      " " +
      truncateToWidth(pad(content, innerW), innerW) +
      " " +
      th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    const lines = [hrTop];
    if (selected) {
      const index = snapshot.selectedIndex + 1;
      const title = `${th.bold(getDisplayName(selected.type))} ${th.fg("muted", selected.description)}`;
      const meta = th.fg(
        "dim",
        `${selected.status} · ${formatDuration(selected.startedAt, selected.completedAt)} · ${index}/${snapshot.count}`
      );
      const gap = Math.max(
        1,
        innerW - visibleWidth(title) - visibleWidth(meta)
      );
      lines.push(row(title + " ".repeat(gap) + meta));
    } else {
      lines.push(row(th.fg("dim", "No subagents in this session.")));
    }
    lines.push(hrMid);

    const contentLines = selected
      ? this.getContentLines(selected)
      : [th.fg("dim", "Launch an agent, then reopen Subagent Mode.")];
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);

    if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = Math.min(this.scrollOffset, maxScroll);
    const viewportLines = renderViewerViewportLines(
      contentLines,
      visibleStart,
      viewportHeight,
      innerW
    );
    for (const line of viewportLines) {
      lines.push(row(line));
    }

    lines.push(hrMid);
    const footerLeft = th.fg("dim", `${contentLines.length} lines`);
    const footerRight = th.fg("dim", "←/→ switch · ↑↓ scroll · q/esc exit");
    const footerGap = Math.max(
      1,
      innerW - visibleWidth(footerLeft) - visibleWidth(footerRight)
    );
    lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    lines.push(hrBot);
    return lines;
  }

  invalidate(): void {
    /* no cached state to clear */
  }

  dispose(): void {
    this.closed = true;
    this.disposeResources();
  }

  private disposeResources(): void {
    this.releaseMouseWheelReporting();
    for (const unsubscribe of this.subscriptions) {
      unsubscribe();
    }
    this.subscriptions = [];
    this.subscribedSessionIds.clear();
  }

  private viewportHeight(): number {
    return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - CHROME_LINES);
  }

  private invalidateContentCache(): void {
    this.contentCache = undefined;
  }

  private getContentLines(record: AgentRecord): string[] {
    const width = getViewerScrollbarContentWidth(this.lastInnerW);
    const key = getConversationContentCacheKey(
      record,
      this.getActivity(record.id)
    );
    if (
      !this.contentCache ||
      this.contentCache.agentId !== record.id ||
      this.contentCache.width !== width ||
      this.contentCache.key !== key
    ) {
      this.contentCache = {
        agentId: record.id,
        width,
        key,
        lines: this.buildContentLines(record),
      };
    }
    return this.contentCache.lines;
  }

  private buildContentLines(record: AgentRecord): string[] {
    if (!record.session) {
      return [
        this.theme.fg(
          "dim",
          `(agent is ${record.status}; no session available yet)`
        ),
      ];
    }

    return renderConversationContentLines(
      this.tui,
      record.session,
      record,
      this.getActivity(record.id),
      this.theme,
      getViewerScrollbarContentWidth(this.lastInnerW)
    );
  }

  private resetScroll(): void {
    this.scrollOffset = 0;
    this.autoScroll = true;
    this.invalidateContentCache();
  }

  private refreshSubscriptions(): void {
    for (const agent of this.getAgents()) {
      if (!agent.session || this.subscribedSessionIds.has(agent.id)) {
        continue;
      }

      this.subscribedSessionIds.add(agent.id);
      this.subscriptions.push(
        agent.session.subscribe(() => {
          if (!this.closed) {
            this.invalidateContentCache();
            this.tui.requestRender();
          }
        })
      );
    }
  }
}
