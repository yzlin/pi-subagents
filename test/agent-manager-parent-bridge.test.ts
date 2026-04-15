import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/parent-bridge.js", () => ({
  parentBridge: {
    disposeAgent: vi.fn(),
  },
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
}));

import { runAgent } from "../src/agent-runner.js";
import { parentBridge } from "../src/parent-bridge.js";

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;
const mockSession = () => ({ dispose: vi.fn() }) as any;
const resolvedRun = () =>
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
  });

describe("AgentManager parent bridge lifecycle", () => {
  let manager: AgentManager;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(parentBridge.disposeAgent).mockReset();
  });

  afterEach(() => {
    manager?.dispose();
  });

  it("passes the agentId into runAgent and disposes bridge state on completion", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });

    await manager.getRecord(id)!.promise;

    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      mockCtx,
      "general-purpose",
      "test",
      expect.objectContaining({ agentId: id, allowAskParent: true })
    );
    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      id,
      expect.stringContaining("completed")
    );
  });

  it("does not expose ask_parent to foreground agents", async () => {
    manager = new AgentManager();
    resolvedRun();

    await manager.spawnAndWait(mockPi, mockCtx, "general-purpose", "test", {
      description: "foreground",
    });

    expect(vi.mocked(runAgent)).toHaveBeenCalledWith(
      mockCtx,
      "general-purpose",
      "test",
      expect.objectContaining({ allowAskParent: false })
    );
  });

  it("disposes bridge state when a run fails", async () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockRejectedValue(new Error("boom"));

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });

    await manager.getRecord(id)!.promise;

    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      id,
      expect.stringContaining("error")
    );
  });

  it("disposes bridge state when a queued agent is cancelled", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(
      () =>
        new Promise(() => {
          /* intentionally pending */
        }) as Promise<any>
    );

    const runningId = manager.spawn(
      mockPi,
      mockCtx,
      "general-purpose",
      "test-1",
      {
        description: "running",
        isBackground: true,
      }
    );
    const queuedId = manager.spawn(
      mockPi,
      mockCtx,
      "general-purpose",
      "test-2",
      {
        description: "queued",
        isBackground: true,
      }
    );

    expect(manager.getRecord(runningId)!.status).toBe("running");
    expect(manager.getRecord(queuedId)!.status).toBe("queued");
    expect(manager.abort(queuedId)).toBe(true);
    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      queuedId,
      expect.stringContaining("queue")
    );
  });

  it("disposes bridge state for running and queued agents during abortAll", () => {
    manager = new AgentManager(undefined, 1);
    vi.mocked(runAgent).mockImplementation(
      () =>
        new Promise(() => {
          /* intentionally pending */
        }) as Promise<any>
    );

    const runningId = manager.spawn(
      mockPi,
      mockCtx,
      "general-purpose",
      "test-1",
      {
        description: "running",
        isBackground: true,
      }
    );
    const queuedId = manager.spawn(
      mockPi,
      mockCtx,
      "general-purpose",
      "test-2",
      {
        description: "queued",
        isBackground: true,
      }
    );

    expect(manager.abortAll()).toBe(2);
    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      queuedId,
      expect.stringContaining("queue")
    );
    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      runningId,
      expect.stringContaining("stopped")
    );
  });

  it("disposes bridge state again when completed records are removed", async () => {
    manager = new AgentManager();
    resolvedRun();

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });
    await manager.getRecord(id)!.promise;

    vi.mocked(parentBridge.disposeAgent).mockClear();
    manager.clearCompleted();

    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      id,
      expect.stringContaining("record removed")
    );
    expect(manager.getRecord(id)).toBeUndefined();
  });

  it("disposes bridge state when the manager itself is disposed", () => {
    manager = new AgentManager();
    vi.mocked(runAgent).mockImplementation(
      () =>
        new Promise(() => {
          /* intentionally pending */
        }) as Promise<any>
    );

    const id = manager.spawn(mockPi, mockCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });

    vi.mocked(parentBridge.disposeAgent).mockClear();
    manager.dispose();

    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      id,
      expect.stringContaining("stopped")
    );
    expect(parentBridge.disposeAgent).toHaveBeenCalledWith(
      id,
      expect.stringContaining("record removed")
    );
    manager = undefined as unknown as AgentManager;
  });
});
