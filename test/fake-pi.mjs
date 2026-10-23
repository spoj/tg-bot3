// Minimal pi RPC stand-in: acknowledges commands and records them on stderr. A prompt starts a run that settles at once
// for "quick" and otherwise lasts until aborted; prompts during a run are queued.
let buffer = "";
let running = false;
let queue = { steering: [], followUp: [] };
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
    const command = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    process.stderr.write(`${JSON.stringify(command)}\n`);
    if (command.type === "extension_ui_response") continue;
    if (command.message === "fail") {
      emit({ type: "response", id: command.id, command: command.type, success: false, error: "rejected" });
      continue;
    }
    let data;
    if (command.type === "prompt" && running) queue[command.streamingBehavior === "followUp" ? "followUp" : "steering"].push(command.message);
    else if (command.type === "prompt") running = command.message !== "quick";
    if (command.type === "clear_queue") [data, queue] = [queue, { steering: [], followUp: [] }];
    // Like pi, an abort settles the run before it responds.
    if (command.type === "abort" && running) {
      running = false;
      emit({ type: "agent_settled", aborted: true });
    }
    emit({ type: "response", id: command.id, command: command.type, success: true, data });
    if (command.message === "ask") emit({ type: "extension_ui_request", id: "ui1", method: "confirm" });
    if (command.message === "quick") emit({ type: "agent_settled" });
  }
});
