import { describe, expect, it } from "vitest";

import { getMouseWheelDirection } from "../src/ui/mouse.js";

describe("mouse input", () => {
  it("detects SGR wheel up/down events", () => {
    expect(getMouseWheelDirection("\x1b[<64;10;5M")).toBe("up");
    expect(getMouseWheelDirection("\x1b[<65;10;5M")).toBe("down");
  });

  it("detects SGR wheel events with modifier bits", () => {
    expect(getMouseWheelDirection("\x1b[<76;10;5M")).toBe("up");
    expect(getMouseWheelDirection("\x1b[<77;10;5M")).toBe("down");
  });

  it("detects legacy X10 wheel up/down events", () => {
    expect(getMouseWheelDirection(`\x1b[M${String.fromCharCode(96)}!!`)).toBe(
      "up"
    );
    expect(getMouseWheelDirection(`\x1b[M${String.fromCharCode(97)}!!`)).toBe(
      "down"
    );
  });

  it("ignores non-wheel input", () => {
    expect(getMouseWheelDirection("\x1b[A")).toBeUndefined();
    expect(getMouseWheelDirection("\x1b[<0;10;5M")).toBeUndefined();
  });
});
