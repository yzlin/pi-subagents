import { randomUUID } from "node:crypto";

const CAVEMAN_RPC_VERSION = 1;
const CAPABILITIES_CHANNEL = "caveman:rpc:capabilities";
const APPLY_CHANNEL = "caveman:rpc:apply";
const DEFAULT_TIMEOUT_MS = 100;
const RPC_UNAVAILABLE_WARNING =
  "Caveman mode requested but caveman RPC is unavailable.";
const RPC_APPLY_FAILED_WARNING =
  "Caveman mode requested but caveman RPC apply failed.";

interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

interface SuccessfulRpcReply<T> {
  success: true;
  data: T;
}

interface CapabilitiesData {
  version: 1;
  supportsApply: true;
}

interface ApplyData {
  version: 1;
  systemPrompt: string;
}

export interface CavemanApplyResult {
  systemPrompt: string;
  tag: "caveman:on" | "caveman:off" | "caveman:unavailable";
  applied: boolean;
  warning?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function isSuccessfulReply<T>(value: unknown): value is SuccessfulRpcReply<T> {
  return isRecord(value) && value.success === true && "data" in value;
}

function createUnavailableResult(
  systemPrompt: string,
  warning = RPC_UNAVAILABLE_WARNING
): CavemanApplyResult {
  return {
    systemPrompt,
    tag: "caveman:unavailable",
    applied: false,
    warning,
  };
}

function isCapabilitiesReply(
  value: unknown
): value is SuccessfulRpcReply<CapabilitiesData> {
  return (
    isSuccessfulReply<CapabilitiesData>(value) &&
    isRecord(value.data) &&
    value.data.version === CAVEMAN_RPC_VERSION &&
    value.data.supportsApply === true
  );
}

function isApplyReply(value: unknown): value is SuccessfulRpcReply<ApplyData> {
  return (
    isSuccessfulReply<ApplyData>(value) &&
    isRecord(value.data) &&
    value.data.version === CAVEMAN_RPC_VERSION &&
    typeof value.data.systemPrompt === "string"
  );
}

async function requestFirstValid<T>(
  events: EventBus,
  channel: string,
  payload: Record<string, unknown>,
  isValid: (value: unknown) => value is SuccessfulRpcReply<T>,
  timeoutMs: number
): Promise<SuccessfulRpcReply<T> | undefined> {
  const requestId = `${channel}:${randomUUID()}`;
  const replyTo = `${channel}:reply:${requestId}`;
  const responseChannel = `${channel}:response:${requestId}`;

  return await new Promise<SuccessfulRpcReply<T> | undefined>((resolve) => {
    let settled = false;
    const finish = (value: SuccessfulRpcReply<T> | undefined) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      unsubReply();
      unsubResponse();
      resolve(value);
    };
    const receive = (value: unknown) => {
      if (isValid(value)) {
        finish(value);
      }
    };

    const unsubReply = events.on(replyTo, receive);
    const unsubResponse = events.on(responseChannel, receive);
    const timer = setTimeout(() => finish(undefined), timeoutMs);

    events.emit(channel, {
      ...payload,
      requestId,
      replyTo,
      respond: receive,
    });
  });
}

export async function applyCavemanRpc(
  events: EventBus | undefined,
  systemPrompt: string,
  enabled: boolean,
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<CavemanApplyResult> {
  if (!events) {
    return createUnavailableResult(systemPrompt);
  }

  const capabilities = await requestFirstValid(
    events,
    CAPABILITIES_CHANNEL,
    {},
    isCapabilitiesReply,
    timeoutMs
  );
  if (!capabilities) {
    return createUnavailableResult(systemPrompt);
  }

  const applyReply = await requestFirstValid(
    events,
    APPLY_CHANNEL,
    { version: CAVEMAN_RPC_VERSION, enabled, systemPrompt },
    isApplyReply,
    timeoutMs
  );
  if (!applyReply) {
    return createUnavailableResult(systemPrompt, RPC_APPLY_FAILED_WARNING);
  }

  return {
    systemPrompt: applyReply.data.systemPrompt,
    tag: enabled ? "caveman:on" : "caveman:off",
    applied: true,
  };
}
