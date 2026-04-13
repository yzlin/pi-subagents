import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { type Component, matchesKey, SelectList, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";

type Theme = {
  fg(color: string, text: string): string;
};

export type RememberingSelectOption = {
  value: string;
  label: string;
  description?: string;
};

type RememberingSelectConfig = {
  selectedValue?: string;
  infoLines?: string[];
  maxVisible?: number;
};

type SelectionMove = {
  delta: number;
  wrap: boolean;
};

const COMPACT_HINT = "↑↓ navigate · Enter select · Esc cancel";
const FULL_HINT = "↑↓/jk navigate · Ctrl+F/B page · Enter select · Esc cancel";

function getSelectedIndex(options: RememberingSelectOption[], selectedValue?: string): number {
  if (!selectedValue) return 0;

  const selectedIndex = options.findIndex(option => option.value === selectedValue);
  return selectedIndex >= 0 ? selectedIndex : 0;
}

function getVisibleItemCount(optionCount: number, maxVisible = 10): number {
  return Math.max(1, Math.min(maxVisible, optionCount || 1));
}

function padVisibleText(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

function getAliasSelectionMove(data: string, pageSize: number): SelectionMove | undefined {
  switch (data) {
    case "j":
      return { delta: 1, wrap: true };
    case "k":
      return { delta: -1, wrap: true };
    default:
      if (matchesKey(data, "ctrl+f")) {
        return { delta: pageSize, wrap: false };
      }

      if (matchesKey(data, "ctrl+b")) {
        return { delta: -pageSize, wrap: false };
      }

      return undefined;
  }
}

class RememberingSelectComponent implements Component {
  private readonly list: SelectList;
  private readonly pageSize: number;
  private selectedIndex: number;

  constructor(
    private readonly title: string,
    private readonly infoLines: string[],
    private readonly theme: Theme,
    private readonly options: RememberingSelectOption[],
    done: (value: string | undefined) => void,
    config: RememberingSelectConfig,
  ) {
    this.pageSize = getVisibleItemCount(options.length, config.maxVisible);
    this.selectedIndex = getSelectedIndex(options, config.selectedValue);
    this.list = new SelectList(options, this.pageSize, {
      selectedPrefix: (text) => this.theme.fg("accent", text),
      selectedText: (text) => this.theme.fg("accent", text),
      description: (text) => this.theme.fg("dim", text),
      scrollInfo: (text) => this.theme.fg("dim", text),
      noMatch: (text) => this.theme.fg("warning", text),
    });
    this.list.setSelectedIndex(this.selectedIndex);
    this.list.onSelect = item => done(item.value);
    this.list.onCancel = () => done(undefined);
    this.list.onSelectionChange = item => {
      const nextIndex = this.options.findIndex(option => option.value === item.value);
      if (nextIndex >= 0) this.selectedIndex = nextIndex;
    };
  }

  invalidate(): void {
    this.list.invalidate();
  }

  handleInput(data: string): void {
    const selectionMove = getAliasSelectionMove(data, this.pageSize);
    if (selectionMove) {
      this.moveSelection(selectionMove.delta, selectionMove.wrap);
      return;
    }

    this.list.handleInput(data);
  }

  render(width: number): string[] {
    if (width < 4) {
      return [
        this.theme.fg("border", this.title),
        ...this.infoLines.map(line => this.theme.fg("dim", line)),
        ...this.list.render(width),
        this.theme.fg("dim", COMPACT_HINT),
      ];
    }

    const innerWidth = width - 2;
    const border = (text: string) => this.theme.fg("border", text);
    const row = (text = "") => border("│") + truncateToWidth(padVisibleText(text, innerWidth), innerWidth) + border("│");
    const titleText = ` ${this.title} `;
    const borderLen = Math.max(0, innerWidth - visibleWidth(titleText));
    const leftBorder = Math.floor(borderLen / 2);
    const rightBorder = borderLen - leftBorder;

    const headerRows = this.infoLines.map(line => row(this.theme.fg("dim", line)));
    const separator = border(`├${"─".repeat(innerWidth)}┤`);

    return [
      border(`╭${"─".repeat(leftBorder)}`) + border(titleText) + border(`${"─".repeat(rightBorder)}╮`),
      ...headerRows,
      ...(headerRows.length > 0 ? [separator] : []),
      ...this.list.render(innerWidth).map(line => row(line)),
      separator,
      row(this.theme.fg("dim", FULL_HINT)),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
  }

  private moveSelection(delta: number, wrap: boolean): void {
    if (this.options.length === 0) return;

    if (wrap) {
      this.selectedIndex = (this.selectedIndex + delta + this.options.length) % this.options.length;
    } else {
      this.selectedIndex = Math.max(0, Math.min(this.options.length - 1, this.selectedIndex + delta));
    }

    this.list.setSelectedIndex(this.selectedIndex);
  }
}

export async function showRememberingSelect(
  ctx: Pick<ExtensionCommandContext, "ui">,
  title: string,
  options: RememberingSelectOption[],
  config: RememberingSelectConfig = {},
): Promise<string | undefined> {
  return ctx.ui.custom<string | undefined>(
    async (_tui, theme, _keybindings, done) => new RememberingSelectComponent(title, config.infoLines ?? [], theme, options, done, config),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: "90%" },
    },
  );
}
