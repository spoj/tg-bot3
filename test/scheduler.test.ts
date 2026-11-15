import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync } from "node:fs";
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
  assert.throws(() => scheduler.add(alice, { prompt: "c", start: "tomorrow 1 Z", recurrence: null }), /UTC/);
  assert.throws(() => scheduler.add(alice, { prompt: "c", start: "2030-02-30T09:00:00Z", recurrence: null }), /UTC/);
  assert.throws(() => scheduler.add(alice, { prompt: "c", start: "2030-01-01T09:00:00Z", recurrence: "monthly" as any }), /recurrence/);
});

test("replacing recurrence recomputes due time from start, equivalent Z/.000Z starts do not refire, and torn timeline tails truncate", () => {
  const { dir, timeline, scheduler } = setup();
  const realNow = Date.now;
  Date.now = () => Date.parse("2030-01-01T09:05:00Z");
  try {
    const s = scheduler.add(alice, { prompt: "p", start: "2030-01-01T09:00:00Z", recurrence: "weekly" });
    scheduler.tick(Date.parse("2030-01-01T09:01:00Z"));
    assert.equal(s.next_due_at, "2030-01-08T09:00:00.000Z");
    assert.equal(scheduler.replace(alice, { id: s.id, prompt: "p2", start: "2030-01-01T09:00:00.000Z", recurrence: "weekly" }).next_due_at, "2030-01-08T09:00:00.000Z");
    assert.equal(scheduler.replace(alice, { id: s.id, prompt: "p3", start: "2030-01-01T09:00:00Z", recurrence: "hourly" }).next_due_at, "2030-01-01T10:00:00.000Z");
    assert.equal(scheduler.replace(alice, { id: s.id, prompt: "p4", start: "2030-01-01T09:00:00Z", recurrence: null }).next_due_at, null);
  } finally {
    Date.now = realNow;
  }

  const countBefore = timeline.read().length;
  appendFileSync(path.join(dir, "timeline.jsonl"), '{"seq":999,"type":"torn');
  const reopened = new Timeline(path.join(dir, "timeline.jsonl"));
  assert.equal(reopened.read().length, countBefore);
  assert.equal(reopened.publish({ type: "after_repair" }).seq, countBefore + 1);

  appendFileSync(path.join(dir, "timeline.jsonl"), "{corrupt_complete_line}\n");
  assert.throws(() => new Timeline(path.join(dir, "timeline.jsonl")), SyntaxError);
});
