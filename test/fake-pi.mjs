// Minimal pi RPC stand-in: acknowledges commands and records them on stderr. A prompt starts a run that settles at once
// for "quick" and "error" (which fails) and otherwise lasts until aborted; prompts during a run are queued.
// "settle-first" arrives just after the current run settled on its own.
let buffer = "";
let running = false;
let queue = { steering: [], followUp: [] };
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
async function handle(command) {
  process.stderr.write(`${JSON.stringify(command)}\n`);
  if (command.type === "extension_ui_response") return;
  if (command.message === "fail") {
    emit({ type: "response", id: command.id, command: command.type, success: false, error: "rejected" });
    return;
  }
  if (command.message === "slow-start") await new Promise((resolve) => setTimeout(resolve, 25));
  if (command.message === "settle-first" && running) {
    running = false;
    emit({ type: "agent_settled", aborted: false });
  }
  const starts = command.type === "prompt" && !running;
  let data;
  if (command.type === "prompt" && running) {
    queue[command.streamingBehavior === "followUp" ? "followUp" : "steering"].push(command.message);
    data = { disposition: "queued" };
  }
  if (starts) {
    running = true;
    data = { disposition: "started" };
  }
  if (command.type === "clear_queue") [data, queue] = [queue, { steering: [], followUp: [] }];
  // Like pi, an abort settles the run before it responds, and may end it in an error.
  if (command.type === "abort" && running) {
    running = false;
    emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "This operation was aborted" }] });
    emit({ type: "agent_settled", aborted: true });
  }
  emit({ type: "response", id: command.id, command: command.type, success: true, data });
  if (command.message === "ask") emit({ type: "extension_ui_request", id: "ui1", method: "confirm" });
  if (starts && command.message === "error") {
    emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "Overloaded" }] });
  }
  if (starts && command.message === "empty-error") {
    emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error" }] });
  }
  if (starts && command.message === "overflow-recover") {
    emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "prompt is too long" }] });
    emit({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] });
  }
  if (starts && ["quick", "error", "empty-error", "overflow-recover"].includes(command.message)) {
    running = false;
    emit({ type: "agent_settled", aborted: false });
  }
}
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
    const command = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    void handle(command);
  }
});
