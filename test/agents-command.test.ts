import { describe, expect, it, vi } from "vitest";

import registerExtension from "../src/index.js";
import {
  type RememberingSelectOption,
  showRememberingSelect,
} from "../src/ui/remembering-select.js";

interface TestComponent {
  handleInput?(data: string): void;
  render(width: number): string[];
}

const TEST_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

function createTestComponent(
  factory: any,
  done: (value: string | undefined) => void
): Promise<TestComponent> {
  return factory(
    { requestRender: vi.fn(), terminal: { columns: 120 } },
    TEST_THEME,
    {},
    done
  );
}

function getSelectedLine(component: TestComponent): string | undefined {
  return component.render(120).find((line) => line.includes("→ "));
}

function expectSelectedLine(
  component: TestComponent,
  expectedText: string
): void {
  expect(getSelectedLine(component)).toContain(expectedText);
}

function getAgentsHandler(): (args: string[], ctx: any) => Promise<void> {
  let agentsHandler: ((args: string[], ctx: any) => Promise<void>) | undefined;

  registerExtension({
    registerCommand: (
      name: string,
      command: { handler: (args: string[], ctx: any) => Promise<void> }
    ) => {
      if (name === "agents") {
        agentsHandler = command.handler;
      }
    },
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    on: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn(() => () => {
        /* noop */
      }),
    },
  } as any);

  expect(agentsHandler).toBeDefined();
  return agentsHandler!;
}

async function renderRememberingSelect(
  options: RememberingSelectOption[],
  config?: { selectedValue?: string; maxVisible?: number }
): Promise<TestComponent> {
  let component: TestComponent | undefined;

  await showRememberingSelect(
    {
      ui: {
        custom: async (factory: any) => {
          component = await createTestComponent(factory, vi.fn());
          return undefined;
        },
      },
    } as any,
    "Agents",
    options,
    config
  );

  expect(component).toBeDefined();
  return component!;
}

describe("/agents command", () => {
  it("opens the top-level /agents menu in a modal", async () => {
    const agentsHandler = getAgentsHandler();

    const select = vi.fn(async () => undefined);
    const custom = vi.fn(async (factory: any) => {
      let resolved: string | undefined;
      function done(value: string | undefined): void {
        resolved = value;
      }

      const component = await createTestComponent(factory, done);

      const lines = component.render(120);
      expect(lines[0]).toContain("╭");
      // biome-ignore lint/style/useAtIndex: test LSP target does not include Array.at.
      expect(lines[lines.length - 1]).toContain("╰");
      expect(lines.some((line: string) => line.includes("Agents"))).toBe(true);
      done(undefined);
      return resolved;
    });

    await agentsHandler([], {
      ui: {
        select,
        custom,
        notify: vi.fn(),
      },
      modelRegistry: undefined,
    });

    expect(custom).toHaveBeenCalledTimes(1);
    expect(select).not.toHaveBeenCalled();
  });

  it("shows Settings in a modal with the settings entries", async () => {
    const agentsHandler = getAgentsHandler();

    let customCallCount = 0;
    const select = vi.fn(async () => undefined);
    const custom = vi.fn(async (factory: any) => {
      customCallCount++;
      let resolved: string | undefined;
      function done(value: string | undefined): void {
        resolved = value;
      }

      const component = await createTestComponent(factory, done);
      const lines = component.render(120);

      if (customCallCount === 1) {
        done("settings");
      } else if (customCallCount === 2) {
        const rendered = lines.join("\n");
        expect(rendered).toContain("Settings");
        expect(rendered).toContain("Max concurrency (current: 4)");
        expect(rendered).toContain("Default max turns (current: unlimited)");
        expect(rendered).toContain("Grace turns (current: 5)");
        expect(rendered).toContain("Join mode (current: smart)");
        expect(rendered).toContain("Enter select");
        expect(rendered).toContain("Esc cancel");
        done(undefined);
      } else {
        done(undefined);
      }

      return resolved;
    });

    await agentsHandler([], {
      ui: {
        select,
        custom,
        notify: vi.fn(),
      },
      modelRegistry: undefined,
    });

    expect(custom).toHaveBeenCalledTimes(3);
    expect(select).not.toHaveBeenCalled();
  });

  it("returns to Settings after editing a setting", async () => {
    const agentsHandler = getAgentsHandler();

    let customCallCount = 0;
    const select = vi.fn(async () => undefined);
    const input = vi.fn((title: string) => {
      if (title === "Max concurrent background agents") {
        return "6";
      }
      return undefined;
    });
    const custom = vi.fn(async (factory: any) => {
      customCallCount++;
      let resolved: string | undefined;
      function done(value: string | undefined): void {
        resolved = value;
      }

      const component = await createTestComponent(factory, done);
      const lines = component.render(120);
      const rendered = lines.join("\n");

      if (customCallCount === 1) {
        done("settings");
      } else if (customCallCount === 2) {
        expect(rendered).toContain("Max concurrency (current: 4)");
        done("max-concurrency");
      } else if (customCallCount === 3) {
        expect(rendered).toContain("Settings");
        expect(rendered).toContain("Max concurrency (current: 6)");
        expectSelectedLine(component, "Max concurrency (current: 6)");
        done(undefined);
      } else {
        done(undefined);
      }

      return resolved;
    });

    await agentsHandler([], {
      ui: {
        select,
        input,
        custom,
        notify: vi.fn(),
      },
      modelRegistry: undefined,
    });

    expect(input).toHaveBeenCalledTimes(1);
    expect(custom).toHaveBeenCalledTimes(4);
    expect(select).not.toHaveBeenCalled();
  });

  it("supports j/k and ctrl+f/ctrl+b aliases in the modal", async () => {
    const component = await renderRememberingSelect(
      Array.from({ length: 8 }, (_unused, index) => ({
        value: `item-${index + 1}`,
        label: `Item ${index + 1}`,
      })),
      { maxVisible: 3 }
    );

    component.handleInput?.("j");
    expectSelectedLine(component, "Item 2");

    component.handleInput?.("k");
    expectSelectedLine(component, "Item 1");

    component.handleInput?.("\u0006");
    expectSelectedLine(component, "Item 4");

    component.handleInput?.("\u0002");
    expectSelectedLine(component, "Item 1");
  });

  it("restores the last selected agent when backing out of agent detail", async () => {
    const agentsHandler = getAgentsHandler();

    let customCallCount = 0;
    const select = vi.fn((title: string) => {
      if (title === "auditor") {
        return "Back";
      }
      return undefined;
    });

    const custom = vi.fn(async (factory: any) => {
      customCallCount++;
      let resolved: string | undefined;
      function done(value: string | undefined): void {
        resolved = value;
      }

      const component = await createTestComponent(factory, done);

      const lines = component.render(120);

      if (customCallCount === 1) {
        expect(lines[0]).toContain("╭");
        expect(lines.some((line: string) => line.includes("Agents"))).toBe(
          true
        );
        done("agent-types");
      } else if (customCallCount === 2) {
        done("auditor");
      } else if (customCallCount === 3) {
        expect(lines.find((line: string) => line.includes("→ "))).toContain(
          "auditor"
        );
        done(undefined);
      } else if (customCallCount === 4) {
        expect(lines.find((line: string) => line.includes("→ "))).toContain(
          "Agent types"
        );
        done(undefined);
      }

      return resolved;
    });

    await agentsHandler([], {
      ui: {
        select,
        custom,
        notify: vi.fn(),
      },
      modelRegistry: undefined,
    });

    expect(custom).toHaveBeenCalledTimes(4);
  });
});
