import { describe, expect, it, vi } from "vitest";
import { ParentBridge } from "../src/parent-bridge.js";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

describe("ParentBridge", () => {
  it("resolves ask_parent requests when the parent replies", async () => {
    const bridge = new ParentBridge();

    const replyPromise = bridge.askParent("agent-1", "Need approval", { sessionId: SESSION_A });
    const queued = bridge.drainMessages("agent-1");

    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      agentId: "agent-1",
      sessionId: SESSION_A,
      kind: "ask",
      message: "Need approval",
    });

    expect(bridge.replyToAsk(queued[0].requestId, "Approved")).toBe(true);
    await expect(replyPromise).resolves.toMatchObject({
      requestId: queued[0].requestId,
      text: "Approved",
    });
    expect(bridge.replyToAsk(queued[0].requestId, "Late reply")).toBe(false);
  });

  it("drains queued bridge traffic by parent session", async () => {
    const bridge = new ParentBridge();
    const onQueue = vi.fn();
    const unsubscribe = bridge.onQueue(onQueue);

    bridge.messageParent("agent-1", "Status update", { sessionId: SESSION_A });
    const replyPromise = bridge.askParent("agent-2", "Need sign-off", { sessionId: SESSION_B });
    const queuedForA = bridge.drainAllMessagesForSession(SESSION_A);
    const queuedForB = bridge.drainAllMessagesForSession(SESSION_B);
    const ask = queuedForB.find((message) => message.kind === "ask");

    expect(onQueue).toHaveBeenCalledTimes(2);
    expect(queuedForA.map(({ agentId, kind, message, sessionId }) => ({ agentId, kind, message, sessionId }))).toEqual([
      { agentId: "agent-1", kind: "message", message: "Status update", sessionId: SESSION_A },
    ]);
    expect(queuedForB.map(({ agentId, kind, message, sessionId }) => ({ agentId, kind, message, sessionId }))).toEqual([
      { agentId: "agent-2", kind: "ask", message: "Need sign-off", sessionId: SESSION_B },
    ]);
    expect(bridge.getPendingAskCountForSession(SESSION_B)).toBe(1);

    unsubscribe();
    bridge.messageParent("agent-3", "No listener", { sessionId: SESSION_A });
    expect(onQueue).toHaveBeenCalledTimes(2);

    expect(bridge.replyToAsk(ask!.requestId, "Ship it")).toBe(true);
    await expect(replyPromise).resolves.toMatchObject({
      requestId: ask!.requestId,
      text: "Ship it",
    });
    expect(bridge.getPendingAskCountForSession(SESSION_B)).toBe(0);
  });

  it("does not enqueue asks for already-aborted signals", async () => {
    const bridge = new ParentBridge();
    const controller = new AbortController();
    controller.abort();

    await expect(bridge.askParent("agent-3", "Still there?", {
      sessionId: SESSION_A,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError", message: `ask_parent aborted for agent agent-3` });
    expect(bridge.drainAllMessagesForSession(SESSION_A)).toEqual([]);
  });

  it("removes stale queued asks when they time out", async () => {
    const bridge = new ParentBridge();

    const replyPromise = bridge.askParent("agent-3", "Still there?", {
      sessionId: SESSION_A,
      timeoutMs: 5,
    });

    await expect(replyPromise).rejects.toThrow(/Timed out waiting for parent reply/);
    expect(bridge.drainAllMessagesForSession(SESSION_A)).toEqual([]);
    expect(bridge.getPendingAskCountForSession(SESSION_A)).toBe(0);
  });

  it("only resolves replies from the matching parent session", async () => {
    const bridge = new ParentBridge();

    const replyPromise = bridge.askParent("agent-4", "Need approval", { sessionId: SESSION_A });
    const [queued] = bridge.drainMessages("agent-4");

    expect(bridge.replyToAsk(queued.requestId, "Wrong session", { sessionId: SESSION_B })).toBe(false);
    expect(bridge.replyToAsk(queued.requestId, "Approved", { sessionId: SESSION_A })).toBe(true);
    await expect(replyPromise).resolves.toMatchObject({ text: "Approved" });
  });

  it("disposes queued state for only the matching parent session", async () => {
    const bridge = new ParentBridge();

    const sessionAReply = bridge.askParent("agent-a", "Need session A", { sessionId: SESSION_A });
    const sessionBReply = bridge.askParent("agent-b", "Need session B", { sessionId: SESSION_B });
    const [queuedA] = bridge.drainMessages("agent-a");

    const deliveredSessionA = bridge.messageParent("agent-a", "Delivered session A update", { sessionId: SESSION_A });
    bridge.drainMessages("agent-a");
    bridge.messageParent("agent-a", "Session A update", { sessionId: SESSION_A });
    bridge.messageParent("agent-b", "Session B update", { sessionId: SESSION_B });
    bridge.disposeSession(SESSION_A, "Session A closed");

    await expect(sessionAReply).rejects.toMatchObject({ name: "AbortError", message: "Session A closed" });
    expect(bridge.getMessage(deliveredSessionA.requestId, { sessionId: SESSION_A })).toBeUndefined();
    expect(bridge.replyToAsk(queuedA.requestId, "Late", { sessionId: SESSION_A })).toBe(false);
    expect(bridge.drainAllMessagesForSession(SESSION_A)).toEqual([]);
    expect(bridge.drainAllMessagesForSession(SESSION_B)).toEqual(expect.arrayContaining([
      expect.objectContaining({ agentId: "agent-b", kind: "ask", message: "Need session B", sessionId: SESSION_B }),
      expect.objectContaining({ agentId: "agent-b", kind: "message", message: "Session B update", sessionId: SESSION_B }),
    ]));
    expect(bridge.getPendingAskCountForSession(SESSION_B)).toBe(1);
    bridge.disposeAll("cleanup");
    await expect(sessionBReply).rejects.toMatchObject({ name: "AbortError", message: "cleanup" });
  });

  it("disposes queued state and rejects pending asks for an agent", async () => {
    const bridge = new ParentBridge();

    bridge.messageParent("agent-2", "FYI", { sessionId: SESSION_A });
    const replyPromise = bridge.askParent("agent-2", "Need input", { sessionId: SESSION_A });
    const queued = bridge.drainMessages("agent-2");
    const ask = queued.find((message) => message.kind === "ask");

    expect(ask).toBeDefined();

    bridge.messageParent("agent-2", "leftover message", { sessionId: SESSION_A });
    bridge.disposeAgent("agent-2", "Agent finished");

    await expect(replyPromise).rejects.toMatchObject({
      name: "AbortError",
      message: "Agent finished",
    });
    expect(bridge.drainMessages("agent-2")).toEqual([
      expect.objectContaining({
        agentId: "agent-2",
        sessionId: SESSION_A,
        kind: "message",
        message: "leftover message",
      }),
    ]);
    expect(bridge.replyToAsk(ask!.requestId, "Late reply")).toBe(false);
  });
});
