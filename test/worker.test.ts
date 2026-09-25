import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker } from "../src/agents.ts";

function fakeWorker(): { worker: Worker; commands: () => any[] } {
  const worker = new Worker({ command: process.execPath, args: [`${import.meta.dirname}/fake-pi.mjs`], cwd: import.meta.dirname, env: process.env });
  let log = "";
  (worker as any).child.stderr.on("data", (chunk: string) => { log += chunk; });
  return { worker, commands: () => log.split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

test("queued user steer aborts a busy turn after the deadline", async () => {
  const { worker, commands } = fakeWorker();
  await worker.prompt("long", "steer", 50);
  await worker.prompt("next", "steer", 50);
  await worker.waitSettled();
  assert.deepEqual(commands().map((command) => command.type), ["prompt", "prompt", "abort"]);
  await worker.close();
});

test("settled worker does not abort, declines dialogs, and reports rejected prompts", async () => {
  const { worker, commands } = fakeWorker();
  await worker.prompt("quick", "steer", 10);
  await worker.prompt("ask", "steer");
  await assert.rejects(worker.prompt("fail", "steer"), /rejected/);
  await sleep(50);
  assert.deepEqual(commands().map((command) => command.type), ["prompt", "prompt", "extension_ui_response", "prompt"]);
  assert.equal(commands()[2].confirmed, false);
  await worker.close();
});

test("exit rejects pending requests", async () => {
  const worker = new Worker({ command: "false", args: [], cwd: import.meta.dirname, env: process.env });
  await assert.rejects(worker.prompt("hi", "steer"), /pi exited/);
});

test("missing binary rejects instead of crashing", async () => {
  const worker = new Worker({ command: "/nonexistent/pi", args: [], cwd: import.meta.dirname, env: process.env });
  await assert.rejects(worker.prompt("hi", "steer"), /ENOENT/);
});
