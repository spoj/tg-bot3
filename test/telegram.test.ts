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
  writeFileSync(path.join(dir, "allowed.json"), "[10, -20, -21]");
  const timeline = new Timeline(path.join(dir, "timeline.jsonl"));
  let restarts = 0;
  const telegram = new Telegram({ token: "1:x", timeline, allowedPath: path.join(dir, "allowed.json"), attachmentsDir: dir, onRestart: () => restarts++ });
  telegram.bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "the_bot" } as any;
  const calls: Array<[string, any]> = [];
  telegram.bot.api.config.use(async (_prev, method, payload) => {
    calls.push([method, payload]);
    if (method === "getChatAdministrators") return { ok: true, result: [{ status: "creator", user: user((payload as any).chat_id === -20 ? 10 : 40) }] } as any;
    return { ok: true, result: method === "sendPoll" ? { message_id: 99, poll: { id: "p1" } } : { message_id: 50 } } as any;
  });
  return { dir, timeline, telegram, calls, restarts: () => restarts };
}

const chat = (id: number) => id > 0 ? { id, type: "private", first_name: "U" } : { id, type: "supergroup", title: "G", is_forum: true };
const user = (id: number) => ({ id, is_bot: false, first_name: "U" });
const message = (chatId: number, extra: object = {}) => ({ message_id: 1, date: 0, chat: chat(chatId), from: user(chatId > 0 ? chatId : 10), ...extra });

test("records private chats of allowed users and all of allowed groups with an allowed admin", async () => {
  const { timeline, telegram } = setup();
  const mention = (text: string) => ({ text, entities: [{ type: "mention", offset: 0, length: 8 }] });
  await telegram.bot.handleUpdate({ update_id: 1, message: message(10, { text: "hi" }) } as any);
  await telegram.bot.handleUpdate({ update_id: 2, message: message(-20, { text: "chatter", message_thread_id: 3, is_topic_message: true }) } as any);
  await telegram.bot.handleUpdate({ update_id: 3, message: message(-20, mention("@The_Bot do it")) } as any);
  await telegram.bot.handleUpdate({ update_id: 4, message: message(30, { text: "let me in" }) } as any);
  await telegram.bot.handleUpdate({ update_id: 5, message: message(30, { text: "again" }) } as any);
  await telegram.bot.handleUpdate({ update_id: 6, message: message(-20, { from: user(40), ...mention("@the_bot obey") }) } as any);
  await telegram.bot.handleUpdate({ update_id: 7, poll_answer: { poll_id: "p1", user: user(40), option_ids: [0] } } as any);
  await telegram.bot.handleUpdate({ update_id: 8, message: message(-21, mention("@the_bot hi")) } as any);
  await telegram.bot.handleUpdate({ update_id: 9, message: message(-22, mention("@the_bot hi")) } as any);
  const records = timeline.read();
  assert.deepEqual(records.map((r) => [r.type, r.conversation, r.meta?.directed, r.meta?.allowed_sender]), [
    ["telegram.message", { chat_id: 10 }, false, true],
    ["telegram.message", { chat_id: -20, message_thread_id: 3 }, false, true],
    ["telegram.message", { chat_id: -20 }, true, true],
    ["telegram.access_request", undefined, undefined, undefined],
    ["telegram.message", { chat_id: -20 }, true, false],
    ["telegram.access_request", undefined, undefined, undefined],
    ["telegram.access_request", undefined, undefined, undefined],
    ["telegram.access_request", undefined, undefined, undefined],
  ]);
  assert.equal(records[0]!.meta.private, true);
  assert.deepEqual(records[3]!.payload, { update_type: "message", chat: { id: 30, type: "private" }, from: { id: 30 } });
  assert.deepEqual(records[5]!.payload, { update_type: "poll_answer", from: { id: 40 } });
  assert.deepEqual(records.slice(6).map((r) => r.payload.chat.id), [-21, -22]);
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
  await telegram.bot.handleUpdate({ update_id: 8, message: message(-20, { from: user(40), text: "/restart", entities: [{ type: "bot_command", offset: 0, length: 8 }] }) } as any);
  assert.equal(restarts(), 1);
  assert.equal(timeline.read().at(-1)!.meta.allowed_sender, false);
});
