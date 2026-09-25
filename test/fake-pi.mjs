// Minimal pi RPC stand-in: acknowledges commands, records them on stderr, settles on "quick" prompts and aborts.
let buffer = "";
const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
process.stdin.setEncoding("utf8").on("data", (chunk) => {
  buffer += chunk;
  for (let i = buffer.indexOf("\n"); i !== -1; i = buffer.indexOf("\n")) {
    const command = JSON.parse(buffer.slice(0, i));
    buffer = buffer.slice(i + 1);
    process.stderr.write(`${JSON.stringify(command)}\n`);
    if (command.type === "extension_ui_response") continue;
    emit({ type: "response", id: command.id, command: command.type, success: command.message !== "fail", error: "rejected" });
    if (command.message === "ask") emit({ type: "extension_ui_request", id: "ui1", method: "confirm" });
    if (command.message === "quick" || command.type === "abort") emit({ type: "agent_settled" });
  }
});
