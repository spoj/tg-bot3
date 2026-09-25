import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Agents } from "../src/agents.ts";
import { Router, wakes } from "../src/router.ts";
import type { TimelineRecord } from "../src/timeline.ts";

const record = (seq: number, type: string, meta?: object): TimelineRecord => ({ seq, t: "", type, conversation: { chat_id: 5 }, ...(meta && { meta }) });

test("default attention and per-conversation overrides", () => {
  assert.equal(wakes(record(1, "telegram.message", { user_content: true, private: true })), true);
  assert.equal(wakes(record(1, "telegram.message", { user_content: true, private: false, directed: false })), false);
  assert.equal(wakes(record(1, "telegram.message", { user_content: false, private: true })), false);
  assert.equal(wakes(record(1, "telegram.callback_query")), true);
  assert.equal(wakes(record(1, "telegram.message_reaction")), false);
  assert.equal(wakes(record(1, "telegram.message_reaction"), { wake: ["telegram.message_reaction"] }), true);
  assert.equal(wakes(record(1, "telegram.callback_query"), { mute: ["telegram.callback_query"] }), false);
});

test("cursor waits for in-flight deliveries and skips replayed records", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-"));
  const deliveries: Array<{ message: string; behavior: string; release: () => void }> = [];
  const agents = {
    deliver: (_target: unknown, message: string, behavior: string) => new Promise<void>((release) => deliveries.push({ message, behavior, release })),
  } as unknown as Agents;
  writeFileSync(path.join(dir, "notifications.json"), JSON.stringify({ "5:0": { wake: ["telegram.edited_message"] } }));
  const router = new Router({ cursorPath: path.join(dir, "cursor"), notificationsPath: path.join(dir, "notifications.json"), initialCursor: 0, agents, onError: () => {} });
  router.handle(record(1, "schedule_fired"));
  router.handle(record(2, "telegram.edited_message"));
  router.handle(record(3, "telegram.message_reaction"));
  assert.deepEqual(deliveries.map((d) => d.behavior), ["followUp", "steer"]);
  deliveries[1]!.release();
  await sleep(0);
  assert.equal(router.cursor, 0);
  deliveries[0]!.release();
  await sleep(0);
  assert.equal(readFileSync(path.join(dir, "cursor"), "utf8"), "3");
  router.handle(record(2, "telegram.edited_message"));
  assert.equal(deliveries.length, 2);
});
