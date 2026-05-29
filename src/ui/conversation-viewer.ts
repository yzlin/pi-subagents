/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 */

import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  getMarkdownTheme,
  parseSkillBlock,
  SkillInvocationMessageComponent,
  ToolExecutionComponent,
  type TruncationResult,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
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
  describeActivity,
  formatDuration,
  formatTokens,
  getDisplayName,
  getPromptModeLabel,
} from "./agent-widget.js";
import { getMouseWheelDirection, retainMouseWheelReporting } from "./mouse.js";

/** Lines consumed by chrome: top border + header + header sep + footer sep + footer + bottom border. */
const CHROME_LINES = 6;
const MIN_VIEWPORT = 3;
const TAB_STOP = 8;
const VIEWER_SCROLLBAR_WIDTH = 1;
const VIEWER_SCROLLBAR_GLYPH = "█";
const VIEWER_SCROLLBAR_TRACK = `\x1b[2;90m${VIEWER_SCROLLBAR_GLYPH}\x1b[0m`;
const VIEWER_SCROLLBAR_THUMB = `\x1b[97m${VIEWER_SCROLLBAR_GLYPH}\x1b[0m`;
const ANSI_TERMINATOR_RE = /[A-Za-z]/;
const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function readEscapeSequence(text: string, start: number): string | undefined {
  if (text[start] !== "\x1b") {
    return undefined;
  }

  const next = text[start + 1];
  if (!next) {
    return undefined;
  }

  if (next === "[") {
    let end = start + 2;
    while (end < text.length && !ANSI_TERMINATOR_RE.test(text[end])) {
      end++;
    }
    return end < text.length ? text.slice(start, end + 1) : undefined;
  }

  if (next === "]" || next === "_") {
    let end = start + 2;
    while (end < text.length) {
      if (text[end] === "\x07") {
        return text.slice(start, end + 1);
      }
      if (text[end] === "\x1b" && text[end + 1] === "\\") {
        return text.slice(start, end + 2);
      }
      end++;
    }
    return undefined;
  }

  return undefined;
}

function expandTabsForDisplay(line: string): string {
  if (!line.includes("\t")) {
    return line;
  }

  let result = "";
  let column = 0;

  for (let i = 0; i < line.length; ) {
    const escapeSequence = readEscapeSequence(line, i);
    if (escapeSequence) {
      result += escapeSequence;
      i += escapeSequence.length;
      continue;
    }

    if (line[i] === "\t") {
      const spaces = TAB_STOP - (column % TAB_STOP || 0);
      result += " ".repeat(spaces);
      column += spaces;
      i++;
      continue;
    }

    let end = i;
    while (end < line.length) {
      if (line[end] === "\t") {
        break;
      }
      if (readEscapeSequence(line, end)) {
        break;
      }
      end++;
    }

    const plainText = line.slice(i, end);
    result += plainText;
    for (const { segment } of GRAPHEME_SEGMENTER.segment(plainText)) {
      column += visibleWidth(segment);
    }
    i = end;
  }

  return result;
}

function nonNegativeInteger(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

export interface ViewerScrollbarState {
  totalLines: number;
  viewportRows: number;
  scrollOffset: number;
}

export interface ViewerScrollbarThumb {
  start: number;
  size: number;
}

export function getViewerScrollbarContentWidth(width: number): number {
  return Math.max(1, Math.trunc(width) - VIEWER_SCROLLBAR_WIDTH);
}

export function calculateViewerScrollbarThumb(
  state: ViewerScrollbarState
): ViewerScrollbarThumb | null {
  const totalLines = nonNegativeInteger(state.totalLines);
  const viewportRows = Math.max(1, nonNegativeInteger(state.viewportRows));
  if (totalLines <= viewportRows) {
    return null;
  }

  const maxScrollOffset = totalLines - viewportRows;
  const scrollOffset = Math.max(
    0,
    Math.min(nonNegativeInteger(state.scrollOffset), maxScrollOffset)
  );
  const size = Math.max(
    1,
    Math.min(
      viewportRows,
      Math.floor((viewportRows * viewportRows) / totalLines)
    )
  );
  const travel = viewportRows - size;
  const start = Math.round((scrollOffset / maxScrollOffset) * travel);

  return { start, size };
}

function fitViewerLineToContentWidth(
  line: string,
  contentWidth: number
): string {
  if (contentWidth <= 0) {
    return "";
  }

  const fitted =
    visibleWidth(line) > contentWidth
      ? truncateToWidth(line, contentWidth, "", true)
      : line;
  return `${fitted}${" ".repeat(
    Math.max(0, contentWidth - visibleWidth(fitted))
  )}`;
}

export function decorateViewerScrollbar(
  lines: readonly string[],
  state: ViewerScrollbarState,
  width: number
): string[] {
  const renderWidth = Math.max(1, Math.trunc(width));
  const contentWidth = Math.max(0, renderWidth - VIEWER_SCROLLBAR_WIDTH);
  const thumb = calculateViewerScrollbarThumb(state);

  return lines.map((line, index) => {
    const scrollbar =
      thumb && index >= thumb.start && index < thumb.start + thumb.size
        ? VIEWER_SCROLLBAR_THUMB
        : VIEWER_SCROLLBAR_TRACK;
    return `${fitViewerLineToContentWidth(line, contentWidth)}${scrollbar}`;
  });
}

export function renderViewerViewportLines(
  contentLines: readonly string[],
  visibleStart: number,
  viewportHeight: number,
  width: number
): string[] {
  const viewportLines = Array.from(
    { length: viewportHeight },
    (_unused, index) => contentLines[visibleStart + index] ?? ""
  );

  return decorateViewerScrollbar(
    viewportLines,
    {
      totalLines: contentLines.length,
      viewportRows: viewportHeight,
      scrollOffset: visibleStart,
    },
    width
  );
}

interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output?: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
}

function isBashExecutionMessage(
  message: AgentSession["messages"][number]
): message is AgentSession["messages"][number] & BashExecutionMessage {
  return (
    message.role === "bashExecution" &&
    "command" in message &&
    typeof message.command === "string"
  );
}

function createStoredBashTruncationResult(output: string): TruncationResult {
  const lines = output ? output.split("\n") : [];
  const bytes = Buffer.byteLength(output);

  return {
    content: output,
    truncated: true,
    truncatedBy: "bytes",
    totalLines: lines.length,
    totalBytes: bytes,
    outputLines: lines.length,
    outputBytes: bytes,
    lastLinePartial: false,
    firstLineExceedsLimit: false,
    maxLines: lines.length,
    maxBytes: bytes,
  };
}

export type ScrollInputAction =
  | "lineUp"
  | "lineDown"
  | "pageUp"
  | "pageDown"
  | "home"
  | "end";

export interface ScrollState {
  scrollOffset: number;
  autoScroll: boolean;
}

interface ContentLinesCache {
  width: number;
  key: string;
  lines: string[];
}

export function getConversationContentCacheKey(
  record: AgentRecord,
  activity: AgentActivity | undefined
): string {
  if (record.status !== "running" || !activity) {
    return record.status;
  }

  const activeTools = [...activity.activeTools.entries()]
    .map(([name, value]) => `${name}:${value}`)
    .join("\u001f");
  return [record.status, activeTools, activity.responseText].join("\u001e");
}

export function getScrollInputAction(
  data: string
): ScrollInputAction | undefined {
  const wheelDirection = getMouseWheelDirection(data);

  if (
    wheelDirection === "up" ||
    matchesKey(data, "up") ||
    matchesKey(data, "k")
  ) {
    return "lineUp";
  }

  if (
    wheelDirection === "down" ||
    matchesKey(data, "down") ||
    matchesKey(data, "j")
  ) {
    return "lineDown";
  }

  if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b")) {
    return "pageUp";
  }

  if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+f")) {
    return "pageDown";
  }

  if (matchesKey(data, "home")) {
    return "home";
  }

  if (matchesKey(data, "end")) {
    return "end";
  }

  return undefined;
}

export function updateScrollState(
  scrollOffset: number,
  action: ScrollInputAction,
  viewportHeight: number,
  maxScroll: number
): ScrollState {
  switch (action) {
    case "lineUp": {
      const nextOffset = Math.max(0, scrollOffset - 1);
      return { scrollOffset: nextOffset, autoScroll: nextOffset >= maxScroll };
    }
    case "lineDown": {
      const nextOffset = Math.min(maxScroll, scrollOffset + 1);
      return { scrollOffset: nextOffset, autoScroll: nextOffset >= maxScroll };
    }
    case "pageUp":
      return {
        scrollOffset: Math.max(0, scrollOffset - viewportHeight),
        autoScroll: false,
      };
    case "pageDown": {
      const nextOffset = Math.min(maxScroll, scrollOffset + viewportHeight);
      return { scrollOffset: nextOffset, autoScroll: nextOffset >= maxScroll };
    }
    case "home":
      return { scrollOffset: 0, autoScroll: false };
    case "end":
      return { scrollOffset: maxScroll, autoScroll: true };
  }
}

export function renderConversationContentLines(
  tui: TUI,
  session: AgentSession,
  record: AgentRecord,
  activity: AgentActivity | undefined,
  theme: Theme,
  width: number
): string[] {
  if (width <= 0) {
    return [];
  }

  const messages = session.messages;
  const lines: string[] = [];

  if (messages.length === 0) {
    lines.push(theme.fg("dim", "(waiting for first message...)"));
    return lines;
  }

  const markdownTheme = getMarkdownTheme();
  const components: Component[] = [];
  const pendingTools = new Map<string, ToolExecutionComponent>();

  for (const msg of messages) {
    if (isBashExecutionMessage(msg)) {
      const component = new BashExecutionComponent(
        msg.command,
        tui,
        msg.excludeFromContext
      );
      if (msg.output) {
        component.appendOutput(msg.output);
      }
      component.setComplete(
        msg.exitCode,
        msg.cancelled ?? false,
        msg.truncated
          ? createStoredBashTruncationResult(msg.output ?? "")
          : undefined,
        msg.fullOutputPath
      );
      components.push(component);
      continue;
    }

    if (msg.role === "user") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((content) => content.type === "text")
              .map((content) => content.text)
              .join("\n");
      if (!text.trim()) {
        continue;
      }

      const skillBlock = parseSkillBlock(text);
      if (skillBlock) {
        const skillComponent = new SkillInvocationMessageComponent(
          skillBlock,
          markdownTheme
        );
        skillComponent.setExpanded(false);
        components.push(skillComponent);
        if (skillBlock.userMessage) {
          components.push(
            new UserMessageComponent(skillBlock.userMessage, markdownTheme)
          );
        }
      } else {
        components.push(new UserMessageComponent(text, markdownTheme));
      }
      continue;
    }

    if (msg.role === "assistant") {
      components.push(
        new AssistantMessageComponent(
          msg,
          false,
          markdownTheme,
          "thinking hidden"
        )
      );

      for (const content of msg.content) {
        if (content.type !== "toolCall") {
          continue;
        }

        const component = new ToolExecutionComponent(
          content.name,
          content.id,
          content.arguments,
          { showImages: false },
          undefined,
          tui,
          process.cwd()
        );
        component.setExpanded(false);
        components.push(component);

        if (msg.stopReason === "aborted" || msg.stopReason === "error") {
          component.updateResult({
            content: [
              {
                type: "text",
                text:
                  msg.stopReason === "aborted"
                    ? "Operation aborted"
                    : (msg.errorMessage ?? "Error"),
              },
            ],
            isError: true,
          });
        } else {
          pendingTools.set(content.id, component);
        }
      }
      continue;
    }

    if (msg.role === "toolResult") {
      const component = pendingTools.get(msg.toolCallId);
      if (component) {
        component.updateResult(msg);
        pendingTools.delete(msg.toolCallId);
      }
    }
  }

  for (const component of components) {
    lines.push(...component.render(width));
  }

  if (record.status === "running" && activity) {
    const act = describeActivity(activity.activeTools, activity.responseText);
    lines.push("");
    lines.push(
      truncateToWidth(theme.fg("accent", "▍ ") + theme.fg("dim", act), width)
    );
  }

  return lines.map((line) =>
    truncateToWidth(expandTabsForDisplay(line), width)
  );
}

export class ConversationViewer implements Component {
  private scrollOffset = 0;
  private autoScroll = true;
  private unsubscribe: (() => void) | undefined;
  private contentCache: ContentLinesCache | undefined;
  private lastInnerW = 0;
  private closed = false;
  private readonly releaseMouseWheelReporting = retainMouseWheelReporting();
  private readonly tui: TUI;
  private readonly session: AgentSession;
  private readonly record: AgentRecord;
  private readonly activity: AgentActivity | undefined;
  private readonly theme: Theme;
  private readonly done: (result: undefined) => void;

  constructor(
    tui: TUI,
    session: AgentSession,
    record: AgentRecord,
    activity: AgentActivity | undefined,
    theme: Theme,
    done: (result: undefined) => void
  ) {
    this.tui = tui;
    this.session = session;
    this.record = record;
    this.activity = activity;
    this.theme = theme;
    this.done = done;
    this.unsubscribe = session.subscribe(() => {
      if (this.closed) {
        return;
      }
      this.invalidateContentCache();
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.closed = true;
      this.disposeResources();
      this.done(undefined);
      return;
    }

    const action = getScrollInputAction(data);
    if (!action) {
      return;
    }

    const totalLines = this.getContentLines(
      getViewerScrollbarContentWidth(this.lastInnerW)
    ).length;
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
      return []; // too narrow for any meaningful rendering
    }
    const th = this.theme;
    const innerW = width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string) =>
      th.fg("border", "│") +
      " " +
      truncateToWidth(pad(content, innerW), innerW) +
      " " +
      th.fg("border", "│");
    const hrTop = th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    lines.push(hrTop);
    const name = getDisplayName(this.record.type);
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    let statusIcon = th.fg("dim", "○");
    if (this.record.status === "running") {
      statusIcon = th.fg("accent", "●");
    } else if (this.record.status === "completed") {
      statusIcon = th.fg("success", "✓");
    } else if (this.record.status === "error") {
      statusIcon = th.fg("error", "✗");
    }
    const duration = formatDuration(
      this.record.startedAt,
      this.record.completedAt
    );

    const headerParts: string[] = [duration];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) {
      headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    }
    if (this.activity?.session) {
      try {
        const tokens = this.activity.session.getSessionStats().tokens.total;
        if (tokens > 0) {
          headerParts.push(formatTokens(tokens));
        }
      } catch {
        /* */
      }
    }

    lines.push(
      row(
        `${statusIcon} ${th.bold(name)}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${th.fg("dim", headerParts.join(" · "))}`
      )
    );
    lines.push(hrMid);

    const contentWidth = getViewerScrollbarContentWidth(innerW);
    const contentLines = this.getContentLines(contentWidth);
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
    const scrollPct =
      contentLines.length <= viewportHeight
        ? "100%"
        : `${Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100)}%`;
    const footerLeft = th.fg(
      "dim",
      `${contentLines.length} lines · ${scrollPct}`
    );
    const footerRight = th.fg(
      "dim",
      "↑↓/jk scroll · PgUp/PgDn/Ctrl+F/B · Esc close"
    );
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
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private viewportHeight(): number {
    return Math.max(MIN_VIEWPORT, this.tui.terminal.rows - CHROME_LINES);
  }

  private invalidateContentCache(): void {
    this.contentCache = undefined;
  }

  private getContentLines(width: number): string[] {
    const key = getConversationContentCacheKey(this.record, this.activity);
    if (
      !this.contentCache ||
      this.contentCache.width !== width ||
      this.contentCache.key !== key
    ) {
      this.contentCache = {
        width,
        key,
        lines: this.buildContentLines(width),
      };
    }
    return this.contentCache.lines;
  }

  private buildContentLines(width: number): string[] {
    return renderConversationContentLines(
      this.tui,
      this.session,
      this.record,
      this.activity,
      this.theme,
      width
    );
  }
}
