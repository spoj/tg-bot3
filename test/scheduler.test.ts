import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { nextDue, Scheduler } from "../src/scheduler.ts";
import { Timeline } from "../src/timeline.ts";

const alice = { chat_id: 1 };
const bob = { chat_id: 2, message_thread_id: 7 };

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-"));
  const timeline = new Timeline(path.join(dir, "timeline.jsonl"));
  return { dir, timeline, scheduler: new Scheduler(path.join(dir, "schedules.json"), timeline) };
}

test("nextDue skips missed periods", () => {
  const now = Date.parse("2030-01-03T12:00:00Z");
  assert.equal(nextDue("2030-01-01T09:00:00.000Z", "daily", now), "2030-01-04T09:00:00.000Z");
  assert.equal(nextDue("2030-02-01T09:00:00.000Z", "daily", now), "2030-02-01T09:00:00.000Z");
});

test("due schedules fire to their owner and advance", () => {
  const { dir, timeline, scheduler } = setup();
  const daily = scheduler.add(alice, { prompt: "standup", start: "2030-01-01T09:00:00.000Z", recurrence: "daily" });
  const once = scheduler.add(alice, { prompt: "once", start: "2030-01-01T09:00:00.000Z", recurrence: null });
  scheduler.tick(Date.parse("2030-01-01T10:00:00Z"));
  scheduler.tick(Date.parse("2030-01-01T11:00:00Z"));
  const fired = timeline.read().filter((record) => record.type === "schedule_fired");
  assert.deepEqual(fired.map((record) => [record.prompt, record.conversation]), [["standup", alice], ["once", alice]]);
  const reloaded = new Scheduler(path.join(dir, "schedules.json"), timeline).schedules;
  assert.equal(reloaded.find((s) => s.id === daily.id)!.next_due_at, "2030-01-02T09:00:00.000Z");
  assert.equal(reloaded.find((s) => s.id === once.id)!.next_due_at, null);
});

test("only the owner changes a schedule until another conversation takes it", () => {
  const { timeline, scheduler } = setup();
  const { id } = scheduler.add(alice, { prompt: "a", start: "2030-01-01T09:00:00Z", recurrence: "weekly" });
  assert.throws(() => scheduler.remove(bob, { id }), /schedule_take/);
  scheduler.take(bob, { id });
  scheduler.replace(bob, { id, prompt: "b", start: "2030-01-01T09:00:00Z", recurrence: "weekly" });
  assert.deepEqual(scheduler.schedules[0]!.owner, bob);
  assert.deepEqual(timeline.read().map((record) => record.type), ["schedule_added", "schedule_taken", "schedule_replaced"]);
  assert.throws(() => scheduler.add(alice, { prompt: "c", start: "tomorrow", recurrence: null }), /UTC/);
});
