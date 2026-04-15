import { randomUUID } from "node:crypto";

export const DEFAULT_ASK_PARENT_TIMEOUT_MS = 60_000;
export const DEFAULT_PARENT_SESSION_ID = "global";

export interface QueuedParentMessage {
  agentId: string;
  sessionId: string;
  requestId: string;
  kind: "message" | "ask";
  message: string;
  createdAt: number;
}

export interface ParentReply {
  requestId: string;
  text: string;
  repliedAt: number;
}

interface PendingAsk {
  agentId: string;
  sessionId: string;
  resolve: (reply: ParentReply) => void;
  reject: (error: Error) => void;
}

interface QueueOptions {
  sessionId?: string;
}

interface AskParentOptions extends QueueOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

interface ReplyOptions extends QueueOptions {}

interface EnqueueOptions extends QueueOptions {
  emit?: boolean;
  requestId?: string;
}

function createAbortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function resolveSessionId(sessionId?: string): string {
  return sessionId || DEFAULT_PARENT_SESSION_ID;
}

export class ParentBridge {
  private queues = new Map<string, QueuedParentMessage[]>();
  private pendingAsks = new Map<string, PendingAsk>();
  private pendingAskIdsByAgent = new Map<string, Set<string>>();
  private messageIndex = new Map<string, QueuedParentMessage>();
  private queueListeners = new Set<() => void>();

  constructor(private readonly defaultAskTimeoutMs = DEFAULT_ASK_PARENT_TIMEOUT_MS) {}

  onQueue(listener: () => void): () => void {
    this.queueListeners.add(listener);
    return () => this.queueListeners.delete(listener);
  }

  messageParent(agentId: string, message: string, options: QueueOptions = {}): QueuedParentMessage {
    return this.enqueue(agentId, "message", message, options);
  }

  askParent(
    agentId: string,
    message: string,
    options: AskParentOptions = {},
  ): Promise<ParentReply> {
    if (options.signal?.aborted) {
      return Promise.reject(createAbortError(`ask_parent aborted for agent ${agentId}`));
    }

    const sessionId = resolveSessionId(options.sessionId);
    const requestId = randomUUID();
    const queued = this.enqueue(agentId, "ask", message, {
      sessionId,
      requestId,
      emit: false,
    });
    const timeoutMs = Math.max(1, options.timeoutMs ?? this.defaultAskTimeoutMs);

    return new Promise<ParentReply>((resolve, reject) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (fn: () => void): boolean => {
        if (settled) return false;
        settled = true;
        if (timeout) clearTimeout(timeout);
        options.signal?.removeEventListener("abort", onAbort);
        this.pendingAsks.delete(queued.requestId);
        this.removeQueuedMessage(queued.requestId);
        this.messageIndex.delete(queued.requestId);
        this.removePendingAskId(agentId, queued.requestId);
        fn();
        return true;
      };

      const onAbort = () => {
        finish(() => reject(createAbortError(`ask_parent aborted for agent ${agentId}`)));
      };

      let askIds = this.pendingAskIdsByAgent.get(agentId);
      if (!askIds) {
        askIds = new Set();
        this.pendingAskIdsByAgent.set(agentId, askIds);
      }
      askIds.add(queued.requestId);

      this.pendingAsks.set(queued.requestId, {
        agentId,
        sessionId,
        resolve: (reply) => {
          finish(() => resolve(reply));
        },
        reject: (error) => {
          finish(() => reject(error));
        },
      });

      options.signal?.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        finish(() => reject(new Error(`Timed out waiting for parent reply (${queued.requestId})`)));
      }, timeoutMs);
      this.emitQueueListeners();
    });
  }

  drainMessages(agentId: string): QueuedParentMessage[] {
    const queued = this.queues.get(agentId) ?? [];
    this.queues.delete(agentId);
    return queued;
  }

  drainAllMessages(): QueuedParentMessage[] {
    const queued = [...this.queues.values()].flat();
    this.queues.clear();
    return queued;
  }

  drainAllMessagesForSession(sessionId: string): QueuedParentMessage[] {
    const resolvedSessionId = resolveSessionId(sessionId);
    const drained: QueuedParentMessage[] = [];

    for (const [agentId, queued] of this.queues) {
      const matches = queued.filter((message) => message.sessionId === resolvedSessionId);
      const remaining = queued.filter((message) => message.sessionId !== resolvedSessionId);
      if (matches.length > 0) drained.push(...matches);
      this.setQueuedMessages(agentId, remaining);
    }

    return drained;
  }

  hasQueuedMessages(sessionId?: string): boolean {
    if (!sessionId) return [...this.queues.values()].some((queued) => queued.length > 0);
    const resolvedSessionId = resolveSessionId(sessionId);
    return [...this.queues.values()].some((queued) => queued.some((message) => message.sessionId === resolvedSessionId));
  }

  getPendingAskCount(agentId?: string): number {
    if (agentId) return this.pendingAskIdsByAgent.get(agentId)?.size ?? 0;
    let count = 0;
    for (const ids of this.pendingAskIdsByAgent.values()) count += ids.size;
    return count;
  }

  getMessage(requestId: string, options: QueueOptions = {}): QueuedParentMessage | undefined {
    const message = this.messageIndex.get(requestId);
    if (!message) return undefined;
    if (options.sessionId && message.sessionId !== resolveSessionId(options.sessionId)) return undefined;
    return message;
  }

  getPendingAskCountForSession(sessionId: string): number {
    const resolvedSessionId = resolveSessionId(sessionId);
    let count = 0;
    for (const pending of this.pendingAsks.values()) {
      if (pending.sessionId === resolvedSessionId) count++;
    }
    return count;
  }

  replyToAsk(requestId: string, text: string, options: ReplyOptions = {}): boolean {
    const pending = this.pendingAsks.get(requestId);
    if (!pending) return false;
    if (options.sessionId && pending.sessionId !== resolveSessionId(options.sessionId)) return false;
    pending.resolve({ requestId, text, repliedAt: Date.now() });
    return true;
  }

  rejectAsk(requestId: string, error: string | Error): boolean {
    const pending = this.pendingAsks.get(requestId);
    if (!pending) return false;
    pending.reject(typeof error === "string" ? new Error(error) : error);
    return true;
  }

  disposeAgent(agentId: string, reason = `Parent bridge disposed for agent ${agentId}`): void {
    const queued = this.queues.get(agentId) ?? [];
    const remainingMessages = queued.filter((message) => message.kind === "message");
    this.setQueuedMessages(agentId, remainingMessages);

    const askIds = this.pendingAskIdsByAgent.get(agentId);
    if (askIds) {
      for (const requestId of [...askIds]) {
        const pending = this.pendingAsks.get(requestId);
        pending?.reject(createAbortError(reason));
      }
    }

    this.pendingAskIdsByAgent.delete(agentId);
  }

  disposeSession(sessionId: string, reason = `Parent bridge disposed for session ${sessionId}`): void {
    const resolvedSessionId = resolveSessionId(sessionId);

    for (const [agentId, queued] of this.queues) {
      const removed = queued.filter((message) => message.sessionId === resolvedSessionId);
      const remaining = queued.filter((message) => message.sessionId !== resolvedSessionId);
      for (const message of removed) {
        this.messageIndex.delete(message.requestId);
      }
      this.setQueuedMessages(agentId, remaining);
    }

    for (const [requestId, pending] of [...this.pendingAsks]) {
      if (pending.sessionId !== resolvedSessionId) continue;
      pending.reject(createAbortError(reason));
      this.removeQueuedMessage(requestId);
    }

    for (const [requestId, message] of [...this.messageIndex]) {
      if (message.sessionId === resolvedSessionId) {
        this.messageIndex.delete(requestId);
      }
    }
  }

  disposeAll(reason = "Parent bridge disposed"): void {
    for (const agentId of new Set([
      ...this.queues.keys(),
      ...this.pendingAskIdsByAgent.keys(),
    ])) {
      this.disposeAgent(agentId, reason);
    }
    this.queues.clear();
    this.messageIndex.clear();
  }

  private enqueue(
    agentId: string,
    kind: QueuedParentMessage["kind"],
    message: string,
    options: EnqueueOptions = {},
  ): QueuedParentMessage {
    const queued: QueuedParentMessage = {
      agentId,
      sessionId: resolveSessionId(options.sessionId),
      requestId: options.requestId ?? randomUUID(),
      kind,
      message,
      createdAt: Date.now(),
    };
    const existing = this.queues.get(agentId) ?? [];
    existing.push(queued);
    this.queues.set(agentId, existing);
    this.messageIndex.set(queued.requestId, queued);
    if (options.emit !== false) this.emitQueueListeners();
    return queued;
  }

  private removeQueuedMessage(requestId: string): void {
    for (const [agentId, queued] of this.queues) {
      const remaining = queued.filter((message) => message.requestId !== requestId);
      if (remaining.length === queued.length) continue;
      this.setQueuedMessages(agentId, remaining);
      return;
    }
  }

  private removePendingAskId(agentId: string, requestId: string): void {
    const askIds = this.pendingAskIdsByAgent.get(agentId);
    if (!askIds) return;
    askIds.delete(requestId);
    if (askIds.size === 0) {
      this.pendingAskIdsByAgent.delete(agentId);
    }
  }

  private setQueuedMessages(agentId: string, queued: QueuedParentMessage[]): void {
    if (queued.length > 0) {
      this.queues.set(agentId, queued);
      return;
    }
    this.queues.delete(agentId);
  }

  private emitQueueListeners(): void {
    for (const listener of this.queueListeners) listener();
  }
}

export const parentBridge = new ParentBridge();
