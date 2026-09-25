import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { InputFile } from "grammy";
import { Telegram } from "../src/telegram.ts";
import { Timeline } from "../src/timeline.ts";

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-"));
  writeFileSync(path.join(dir, "allowed.json"), "[10, -20]");
  const timeline = new Timeline(path.join(dir, "timeline.jsonl"));
  let restarts = 0;
  const telegram = new Telegram({ token: "1:x", timeline, allowedPath: path.join(dir, "allowed.json"), attachmentsDir: dir, onRestart: () => restarts++ });
  telegram.bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "the_bot" } as any;
  const calls: Array<[string, any]> = [];
  telegram.bot.api.config.use(async (_prev, method, payload) => {
    calls.push([method, payload]);
    return { ok: true, result: method === "sendPoll" ? { message_id: 99, poll: { id: "p1" } } : { message_id: 50 } } as any;
  });
  return { dir, timeline, telegram, calls, restarts: () => restarts };
}

const chat = (id: number) => id > 0 ? { id, type: "private", first_name: "U" } : { id, type: "supergroup", title: "G", is_forum: true };
const message = (chatId: number, extra: object = {}) => ({ message_id: 1, date: 0, chat: chat(chatId), from: { id: 10, is_bot: false, first_name: "U" }, ...extra });

test("records allowed updates with routing metadata and reports others once", async () => {
  const { timeline, telegram } = setup();
  await telegram.bot.handleUpdate({ update_id: 1, message: message(10, { text: "hi" }) } as any);
  await telegram.bot.handleUpdate({ update_id: 2, message: message(-20, { text: "chatter", message_thread_id: 3, is_topic_message: true }) } as any);
  await telegram.bot.handleUpdate({ update_id: 3, message: message(-20, { text: "@The_Bot do it", entities: [{ type: "mention", offset: 0, length: 8 }] }) } as any);
  await telegram.bot.handleUpdate({ update_id: 4, message: message(30, { text: "let me in" }) } as any);
  await telegram.bot.handleUpdate({ update_id: 5, message: message(30, { text: "again" }) } as any);
  const records = timeline.read();
  assert.deepEqual(records.map((r) => [r.type, r.conversation, r.meta?.directed]), [
    ["telegram.message", { chat_id: 10 }, false],
    ["telegram.message", { chat_id: -20, message_thread_id: 3 }, false],
    ["telegram.message", { chat_id: -20 }, true],
    ["telegram.access_request", undefined, undefined],
  ]);
  assert.equal(records[0]!.meta.private, true);
  assert.equal(records[3]!.payload.chat.id, 30);
});

test("send fills in the conversation, uploads local paths, and routes poll answers", async () => {
  const { dir, timeline, telegram, calls } = setup();
  const file = path.join(dir, "a.txt");
  writeFileSync(file, "x");
  const target = { chat_id: -20, message_thread_id: 3 };
  await telegram.send(target, { method: "sendDocument", document: file, caption: "c" });
  await telegram.send(target, { method: "sendPoll", question: "q", options: [{ text: "a" }, { text: "b" }] });
  assert.equal(calls[0]![0], "sendDocument");
  assert.equal(calls[0]![1].chat_id, -20);
  assert.equal(calls[0]![1].message_thread_id, 3);
  assert.ok(calls[0]![1].document instanceof InputFile);
  await telegram.bot.handleUpdate({ update_id: 6, poll_answer: { poll_id: "p1", user: { id: 10, is_bot: false, first_name: "U" }, option_ids: [0] } } as any);
  const answer = timeline.read().at(-1)!;
  assert.equal(answer.type, "telegram.poll_answer");
  assert.deepEqual(answer.conversation, target);
});

test("/restart restarts agents without recording", async () => {
  const { timeline, telegram, calls, restarts } = setup();
  await telegram.bot.handleUpdate({ update_id: 7, message: message(10, { text: "/restart", entities: [{ type: "bot_command", offset: 0, length: 8 }] }) } as any);
  assert.equal(restarts(), 1);
  assert.equal(calls[0]![0], "sendMessage");
  assert.equal(timeline.read().length, 0);
});
