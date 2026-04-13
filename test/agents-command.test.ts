import { describe, expect, it, vi } from "vitest";
import registerExtension from "../src/index.js";
import { type RememberingSelectOption, showRememberingSelect } from "../src/ui/remembering-select.js";

type TestComponent = {
  handleInput?(data: string): void;
  render(width: number): string[];
};

const TEST_THEME = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

async function createTestComponent(factory: any, done: (value: string | undefined) => void): Promise<TestComponent> {
  return factory(
    { requestRender: vi.fn(), terminal: { columns: 120 } },
    TEST_THEME,
    {},
    done,
  );
}

function getSelectedLine(component: TestComponent): string | undefined {
  return component.render(120).find(line => line.includes("→ "));
}

function expectSelectedLine(component: TestComponent, expectedText: string): void {
  expect(getSelectedLine(component)).toContain(expectedText);
}

function getAgentsHandler(): (args: string[], ctx: any) => Promise<void> {
  let agentsHandler: ((args: string[], ctx: any) => Promise<void>) | undefined;

  registerExtension({
    registerCommand: (name: string, command: { handler: (args: string[], ctx: any) => Promise<void> }) => {
      if (name === "agents") agentsHandler = command.handler;
    },
    registerTool: vi.fn(),
    registerMessageRenderer: vi.fn(),
    sendMessage: vi.fn(),
    appendEntry: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
  } as any);

  expect(agentsHandler).toBeDefined();
  return agentsHandler!;
}

async function renderRememberingSelect(options: RememberingSelectOption[], config?: { selectedValue?: string; maxVisible?: number }): Promise<TestComponent> {
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
    config,
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
      expect(lines.at(-1)).toContain("╰");
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

  it("supports j/k and ctrl+f/ctrl+b aliases in the modal", async () => {
    const component = await renderRememberingSelect(
      Array.from({ length: 8 }, (_unused, index) => ({
        value: `item-${index + 1}`,
        label: `Item ${index + 1}`,
      })),
      { maxVisible: 3 },
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
    const select = vi.fn(async (title: string) => {
      if (title === "Plan") {
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
        expect(lines.some((line: string) => line.includes("Agents"))).toBe(true);
        done("agent-types");
      } else if (customCallCount === 2) {
        done("Plan");
      } else if (customCallCount === 3) {
        expect(lines.find((line: string) => line.includes("→ "))).toContain("Plan");
        done(undefined);
      } else if (customCallCount === 4) {
        expect(lines.find((line: string) => line.includes("→ "))).toContain("Agent types");
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
