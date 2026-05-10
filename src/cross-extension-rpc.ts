/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, and stop RPCs over the pi.events event bus,
 * using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 */

import { type ModelRegistry, resolveModel } from "./model-resolver.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 2;

type SpawnRpcOptions = Record<string, unknown>;
interface RpcContext {
  modelRegistry?: ModelRegistry;
}

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(
    pi: unknown,
    ctx: unknown,
    type: string,
    prompt: string,
    options: SpawnRpcOptions
  ): string;
  abort(id: string): boolean;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown; // passed through to manager.spawn
  getCtx: () => unknown | undefined; // returns current ExtensionContext
  manager: SpawnCapable;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) {
        reply.data = data;
      }
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function resolveSpawnOptions(
  ctx: unknown,
  options: SpawnRpcOptions | undefined
): SpawnRpcOptions {
  if (typeof options?.model !== "string") {
    return options ?? {};
  }

  const registry = (ctx as RpcContext).modelRegistry;
  if (!registry) {
    throw new Error(
      "Cannot resolve model override: no model registry available"
    );
  }

  const requestedModel = options.model.trim();
  if (!requestedModel) {
    throw new Error("Model override cannot be blank");
  }

  const resolvedModel = resolveModel(requestedModel, registry);
  if (typeof resolvedModel === "string") {
    throw new Error(resolvedModel);
  }

  return { ...options, model: resolvedModel };
}

/**
 * Register ping, spawn, and stop RPC handlers on the event bus.
 * Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION };
  });

  const unsubSpawn = handleRpc<{
    requestId: string;
    type: string;
    prompt: string;
    options?: SpawnRpcOptions;
  }>(events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
    const ctx = getCtx();
    if (!ctx) {
      throw new Error("No active session");
    }
    const spawnOptions = resolveSpawnOptions(ctx, options);
    return { id: manager.spawn(pi, ctx, type, prompt, spawnOptions) };
  });

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events,
    "subagents:rpc:stop",
    ({ agentId }) => {
      if (!manager.abort(agentId)) {
        throw new Error("Agent not found");
      }
    }
  );

  return { unsubPing, unsubSpawn, unsubStop };
}
