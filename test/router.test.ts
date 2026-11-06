import assert from "node:assert/strict";
import test from "node:test";
import type { Agents } from "../src/agents.ts";
import { route, wakes } from "../src/router.ts";
import type { TimelineRecord } from "../src/timeline.ts";

const record = (seq: number, type: string, meta?: object): TimelineRecord => ({ seq, t: "", type, conversation: { chat_id: 5 }, meta: { allowed_sender: true, ...meta } });

test("waking rules", () => {
  assert.equal(wakes(record(1, "telegram.message", { user_content: true, private: true })), true);
  assert.equal(wakes(record(1, "telegram.message", { user_content: true, private: false, directed: false })), false);
  assert.equal(wakes(record(1, "telegram.message", { user_content: false, private: true })), false);
  assert.equal(wakes(record(1, "telegram.callback_query")), true);
  assert.equal(wakes(record(1, "telegram.message_reaction")), false);
  assert.equal(wakes(record(1, "telegram.message", { user_content: true, directed: true, allowed_sender: false })), false);
});

test("records reach their conversation's agent as follow-ups, steers, or user steers with a deadline", () => {
  const deliveries: unknown[][] = [];
  const agents = { deliver: (...args: unknown[]) => deliveries.push(args) } as unknown as Agents;
  route(agents, record(1, "schedule_fired"));
  route(agents, record(2, "steer"));
  route(agents, record(3, "agent_interrupted"));
  route(agents, record(4, "telegram.message", { user_content: true, private: true }));
  route(agents, record(5, "telegram.message_reaction"));
  route(agents, { seq: 6, t: "", type: "telegram.access_request" });
  assert.deepEqual(deliveries.map(([target, message, behavior, abortAfterMs]) => [target, JSON.parse(message as string).seq, behavior, abortAfterMs]), [
    [{ chat_id: 5 }, 1, "followUp", undefined],
    [{ chat_id: 5 }, 2, "steer", undefined],
    [{ chat_id: 5 }, 3, "steer", undefined],
    [{ chat_id: 5 }, 4, "steer", 120_000],
  ]);
});
