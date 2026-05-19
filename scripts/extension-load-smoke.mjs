import extension from "../dist/index.js";

const calls = {
  commands: [],
  emittedEvents: [],
  eventHandlers: [],
  messageRenderers: [],
  tools: [],
};

const pi = {
  appendEntry() {},
  events: {
    emit(type, payload) {
      calls.emittedEvents.push({ type, payload });
    },
    on(type, handler) {
      calls.eventHandlers.push({ type, handler });
      return () => {};
    },
  },
  on(type, handler) {
    calls.eventHandlers.push({ type, handler });
  },
  registerCommand(name, command) {
    calls.commands.push({ name, command });
  },
  registerMessageRenderer(type, renderer) {
    calls.messageRenderers.push({ type, renderer });
  },
  registerTool(tool) {
    calls.tools.push(tool);
  },
};

extension(pi);

const requiredTools = new Set([
  "Agent",
  "get_subagent_result",
  "get_subagent_message",
  "reply_to_subagent",
  "steer_subagent",
]);
const registeredTools = new Set(calls.tools.map((tool) => tool?.name));
const missingTools = [...requiredTools].filter((name) => !registeredTools.has(name));
const hasAgentsCommand = calls.commands.some(({ name }) => name === "agents");
const hasNotificationRenderer = calls.messageRenderers.some(
  ({ type }) => type === "subagent-notification"
);

if (missingTools.length > 0 || !hasAgentsCommand || !hasNotificationRenderer) {
  throw new Error(
    [
      missingTools.length > 0 ? `Missing tools: ${missingTools.join(", ")}` : undefined,
      !hasAgentsCommand ? "Missing agents command" : undefined,
      !hasNotificationRenderer ? "Missing notification renderer" : undefined,
    ]
      .filter(Boolean)
      .join("; ")
  );
}
