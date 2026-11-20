#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { text } from "node:stream/consumers";
import { fileURLToPath } from "node:url";

const [homeOption, home, sessionOption, session, command, ...args] = process.argv.slice(2);
if (homeOption !== "--home" || sessionOption !== "--session" || session !== "test" || "LETMEKNOW_SESSION" in process.env) {
  throw new Error("unexpected bridge configuration");
}
const state = (file) => path.join(home, file);
if (command === "listen") {
  const log = state("log.jsonl");
  console.log(JSON.stringify({ type: "ready", bin: fileURLToPath(import.meta.url), log }));
  let count = 0;
  setInterval(() => {
    const events = readFileSync(state("events.jsonl"), "utf8").split("\n").slice(0, -1);
    for (const line of events.slice(count)) {
      appendFileSync(log, line + "\n");
      const event = JSON.parse(line);
      if (event.truncated) event.content = event.content.slice(0, 10);
      console.log(JSON.stringify(event));
    }
    count = events.length;
  }, 10);
} else if (command === "members") {
  console.log(JSON.stringify({ members: [{ fp: "aaaa1" }, { fp: "aaaa2" }] }));
} else if (command === "send") {
  const attach = args.indexOf("--attach");
  const file = args[attach + 1];
  const body = await text(process.stdin);
  const calls = state("calls.jsonl");
  // The bridge may send commands concurrently; the reply id only has to be unique.
  const id = `test-${process.pid}`;
  appendFileSync(calls, JSON.stringify({
    id, args, body,
    ...(attach < 0 ? {} : { name: path.basename(file), file: readFileSync(file, "utf8") }),
  }) + "\n");
  console.log(JSON.stringify({ id }));
}
