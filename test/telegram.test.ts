import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { format } from "node:util";
import { BotError, Context, HttpError, InputFile } from "grammy";
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

test("update failures are logged without the token", async () => {
  const { telegram } = setup();
  const ctx = new Context({ update_id: 1 } as any, telegram.bot.api, telegram.bot.botInfo);
  const cause = new HttpError("Network request for 'getChatAdministrators' failed!", new Error("request to https://api.telegram.org/bot1:x/getChatAdministrators failed"));
  const logged: string[] = [];
  const log = console.error;
  console.error = (...args: unknown[]) => logged.push(format(...args));
  try {
    await telegram.bot.errorHandler(new BotError(cause, ctx));
  } finally {
    console.error = log;
  }
  assert.match(logged.join("\n"), /Network request for 'getChatAdministrators' failed!/);
  assert.doesNotMatch(logged.join("\n"), /1:x/);
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

test("attachments reject dot-traversal names and preserve original bytes across media edits", async () => {
  const { dir, timeline, telegram } = setup();
  telegram.bot.api.config.use(async (_prev, method, payload) => {
    if (method === "getChatAdministrators") return { ok: true, result: [{ status: "creator", user: user(10) }] } as any;
    if (method === "getFile") return { ok: true, result: (payload as any).file_id === "missing" ? {} : { file_path: "documents/fallback.bin" } } as any;
    return { ok: true, result: {} } as any;
  });
  const previousFetch = globalThis.fetch;
  let body = "ORIGINAL";
  globalThis.fetch = (async () => new Response(body)) as any;
  try {
    await telegram.bot.handleUpdate({ update_id: 1, message: message(-20, { from: user(40), message_id: 1, document: { file_id: "d1", file_unique_id: "u1", file_name: ".." } }) } as any);
    await telegram.bot.handleUpdate({ update_id: 2, message: message(10, { message_id: 2, document: { file_id: "d2", file_unique_id: "u2", file_name: "report.txt" } }) } as any);
    body = "REPLACEMENT";
    await telegram.bot.handleUpdate({ update_id: 3, edited_message: message(10, { message_id: 2, document: { file_id: "d3", file_unique_id: "u3", file_name: "report.txt" } }) } as any);
    await telegram.bot.handleUpdate({ update_id: 4, message: message(10, { message_id: 3, document: { file_id: "missing", file_unique_id: "u4", file_name: "x.txt" } }) } as any);
  } finally {
    globalThis.fetch = previousFetch;
  }
  const records = timeline.read();
  assert.equal(statSync(path.join(dir, "-20")).isDirectory(), true);
  assert.match(records[0]!.attachments[0].path, /fallback\.bin$/);
  assert.notEqual(records[1]!.attachments[0].path, records[2]!.attachments[0].path);
  assert.equal(readFileSync(records[1]!.attachments[0].path, "utf8"), "ORIGINAL");
  assert.equal(readFileSync(records[2]!.attachments[0].path, "utf8"), "REPLACEMENT");
  assert.match(records[3]!.attachments[0].failure, /no file_path/);
});

test("inline callbacks, bot-created topic chatter, media thumbnails/edits, album reactions, and explicit thread sends", async () => {
  const { dir, timeline, telegram, calls } = setup();
  const file = path.join(dir, "v.mp4");
  const thumb = path.join(dir, "t.jpg");
  writeFileSync(file, "v");
  writeFileSync(thumb, "t");
  telegram.bot.api.config.use(async (_prev, method, payload) => {
    calls.push([method, payload]);
    if (method === "getChatAdministrators") return { ok: true, result: [{ status: "creator", user: user(10) }] } as any;
    if (method === "sendMediaGroup") return { ok: true, result: [{ message_id: 80 }, { message_id: 81 }] } as any;
    return { ok: true, result: { message_id: 50 } } as any;
  });

  await telegram.bot.handleUpdate({ update_id: 1, callback_query: { id: "cb1", from: user(10), inline_message_id: "im1", chat_instance: "ci", data: "x" } } as any);
  assert.equal(calls.some(([m]) => m === "answerCallbackQuery"), true);

  await telegram.bot.handleUpdate({
    update_id: 2,
    message: message(-20, { text: "plain chatter", is_topic_message: true, message_thread_id: 9, reply_to_message: { message_id: 9, from: { id: 1 }, forum_topic_created: { name: "T", icon_color: 0 } } }),
  } as any);
  assert.equal(timeline.read().at(-1)!.meta.directed, false);

  await telegram.send({ chat_id: -20, message_thread_id: 3 }, { method: "sendMediaGroup", message_thread_id: 9, media: [{ type: "video", media: file, thumbnail: thumb, cover: thumb }] });
  await telegram.send({ chat_id: 10 }, { method: "editMessageMedia", message_id: 50, media: { type: "photo", media: file, thumbnail: thumb } });
  await assert.rejects(telegram.send({ chat_id: 10 }, { method: "toJSON" }), /Unknown Telegram Bot API method/);
  const mediaGroupPayload = calls.find(([m]) => m === "sendMediaGroup")![1];
  assert.ok(mediaGroupPayload.media[0].thumbnail instanceof InputFile);
  assert.ok(mediaGroupPayload.media[0].cover instanceof InputFile);
  const editMediaPayload = calls.find(([m]) => m === "editMessageMedia")![1];
  assert.ok(editMediaPayload.media.media instanceof InputFile);
  assert.ok(editMediaPayload.media.thumbnail instanceof InputFile);

  await telegram.bot.handleUpdate({ update_id: 3, message_reaction: { chat: chat(-20), message_id: 81, user: user(10), date: 0, old_reaction: [], new_reaction: [] } } as any);
  assert.deepEqual(timeline.read().at(-1)!.conversation, { chat_id: -20, message_thread_id: 9 });

  await telegram.bot.handleUpdate({ update_id: 4, poll_answer: { poll_id: "p", voter_chat: chat(-99), option_ids: [0] } } as any);
  assert.deepEqual(timeline.read().at(-1)!.payload, { update_type: "poll_answer", chat: { id: -99, type: "supergroup" } });
});
