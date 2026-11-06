import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Worker, type WorkerOptions } from "../src/agents.ts";

const fakePi: WorkerOptions = { command: process.execPath, args: [`${import.meta.dirname}/fake-pi.mjs`], cwd: import.meta.dirname, env: process.env };

function fakeWorker(options = fakePi): { worker: Worker; events: unknown[][]; commands: () => any[] } {
  const events: unknown[][] = [];
  const worker = new Worker(options, {
    onBusy: () => events.push(["busy"]),
    onSettled: (aborted) => events.push(["settled", aborted]),
    onError: (error) => events.push(["error", error.message]),
  });
  let log = "";
  (worker as any).child.stderr.on("data", (chunk: string) => { log += chunk; });
  return { worker, events, commands: () => log.split("\n").filter(Boolean).map((line) => JSON.parse(line)) };
}

test("user steer still queued at the deadline aborts the run and is prompted again, keeping follow-ups", async () => {
  const { worker, events, commands } = fakeWorker();
  await worker.prompt("long", "steer", 50);
  await worker.prompt("next", "steer", 50);
  await worker.prompt("later", "followUp");
  await sleep(200);
  assert.deepEqual(commands().map(({ type, message, streamingBehavior }) => [type, message, streamingBehavior]), [
    ["prompt", "long", "steer"],
    ["prompt", "next", "steer"],
    ["prompt", "later", "followUp"],
    ["clear_queue", undefined, undefined],
    ["abort", undefined, undefined],
    ["prompt", "next", "steer"],
    ["prompt", "later", "followUp"],
  ]);
  assert.deepEqual(events, [["busy"], ["settled", true], ["busy"]]);
  await worker.close();
});

test("settled worker does not abort, declines dialogs, and reports rejected prompts", async () => {
  const { worker, events, commands } = fakeWorker();
  await worker.prompt("quick", "steer", 10);
  await worker.waitSettled();
  await worker.prompt("ask", "steer");
  await worker.prompt("fail", "steer");
  await sleep(50);
  assert.deepEqual(commands().map((command) => command.type).sort(), ["extension_ui_response", "prompt", "prompt", "prompt"]);
  assert.equal(commands().find((command) => command.type === "extension_ui_response").confirmed, false);
  assert.deepEqual(events, [["busy"], ["settled", false], ["busy"], ["error", "rejected"]]);
  await worker.close();
});

test("a run that starts just after the previous one settled stays busy and gets no steer deadline", async () => {
  const { worker, events, commands } = fakeWorker();
  await worker.prompt("long", "steer");
  await worker.prompt("settle-first", "steer", 10);
  await sleep(50);
  assert.equal(worker.busy, true);
  assert.deepEqual(events, [["busy"]]);
  assert.deepEqual(commands().map((command) => command.type), ["prompt", "prompt"]);
  await worker.close();
});

test("dying mid-run is reported, being closed mid-run is not", async () => {
  const crashed = fakeWorker({ ...fakePi, command: "false", args: [] });
  await crashed.worker.prompt("hi", "steer");
  assert.deepEqual(crashed.events.map(([type]) => type), ["busy", "error", "settled"]);
  assert.match(String(crashed.events[1]![1]), /pi exited/);
  assert.deepEqual(crashed.events[2], ["settled", false]);

  const closed = fakeWorker();
  await closed.worker.prompt("long", "steer");
  await closed.worker.close();
  assert.deepEqual(closed.events, [["busy"], ["settled", true]]);
});

test("missing binary is reported instead of crashing", async () => {
  const { worker, events } = fakeWorker({ ...fakePi, command: "/nonexistent/pi" });
  await worker.prompt("hi", "steer");
  assert.match(String(events[1]![1]), /ENOENT/);
});
