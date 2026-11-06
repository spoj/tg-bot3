import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agents } from "../src/agents.ts";
import type { Conversation } from "../src/timeline.ts";

const alice = { chat_id: 1 };
const bob = { chat_id: 2, message_thread_id: 7 };

function setup(busyPath = path.join(mkdtempSync(path.join(tmpdir(), "tg-bot3-")), "busy.json")) {
  const sessions: string[] = [];
  const interrupted: Array<[Conversation, string]> = [];
  const errors: string[] = [];
  const agents = new Agents({
    busyPath,
    worker: (_conversation, session) => {
      sessions.push(session);
      return { command: process.execPath, args: [`${import.meta.dirname}/fake-pi.mjs`], cwd: import.meta.dirname, env: process.env };
    },
    onInterrupted: (conversation, session) => interrupted.push([conversation, session]),
    onError: (_conversation, error) => errors.push(error.message),
  });
  return { agents, busyPath, sessions, interrupted, errors, busy: () => JSON.parse(readFileSync(busyPath, "utf8")) };
}

test("busy agents stay recorded until they settle, and a new host wakes their conversations", async () => {
  const { agents, busyPath, sessions, busy } = setup();
  agents.deliver(alice, "long", "steer");
  agents.deliver(bob, "quick", "steer");
  await sleep(100);
  assert.deepEqual(busy(), { [sessions[0]!]: alice });
  await agents.closeAll();
  assert.deepEqual(busy(), { [sessions[0]!]: alice });

  const next = setup(busyPath);
  next.agents.recover();
  assert.deepEqual(next.interrupted, [[alice, sessions[0]]]);
  assert.deepEqual(next.busy(), {});
});

test("restart kills agents still busy after the grace and wakes their conversations fresh", async () => {
  const { agents, sessions, interrupted, busy } = setup();
  agents.deliver(alice, "long", "steer");
  agents.deliver(bob, "quick", "steer");
  await sleep(100);
  agents.restart(50);
  await sleep(300);
  assert.deepEqual(interrupted, [[alice, sessions[0]]]);
  assert.deepEqual(busy(), {});
  agents.deliver(alice, "quick", "steer");
  assert.equal(sessions.length, 3);
  await agents.closeAll();
});

test("a delivery while an idle agent shuts down starts a new agent", async () => {
  const { agents, sessions, errors } = setup();
  agents.deliver(alice, "quick", "steer");
  await sleep(100);
  void (agents as any).agents.get("1:0").worker.close();
  agents.deliver(alice, "quick", "steer");
  await sleep(100);
  assert.equal(sessions.length, 2);
  assert.deepEqual(errors, []);
  await agents.closeAll();
});
