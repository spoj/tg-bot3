import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { InputFile } from "grammy";
import type { Agents } from "../src/agents.ts";
import { Lmk } from "../src/lmk.ts";
import { route } from "../src/router.ts";
import { Telegram } from "../src/telegram.ts";
import { Timeline } from "../src/timeline.ts";

const CHAT = -100;
const USER = 10;
const FP = "aaaa1";
const user = (id = USER) => ({ id, is_bot: false, first_name: "U" });
const chat = (id = CHAT) => ({ id, type: "supergroup", title: "G", is_forum: true });

function setup(t: TestContext, entries: object[] = []) {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-lmk-"));
  const state = (file: string) => path.join(dir, file);
  const read = (file: string): any[] => existsSync(state(file))
    ? readFileSync(state(file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  writeFileSync(state("allowed.json"), JSON.stringify([USER, 11, CHAT, -200]));
  writeFileSync(state("events.jsonl"), "");
  if (entries.length) writeFileSync(state("lmk-state.jsonl"), entries.map((entry) => JSON.stringify(entry) + "\n").join(""));
  const timeline = new Timeline(state("timeline.jsonl"));
  const telegram = new Telegram({
    token: "1:x", timeline, allowedPath: state("allowed.json"), attachmentsDir: state("attachments"), onRestart: () => {},
    pollConversation: (id) => lmk.pollConversation(id),
  });
  telegram.bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "the_bot" } as any;
  const requests: Array<[string, any]> = [];
  let messageId = 50;
  telegram.bot.api.config.use(async (_prev, method, params) => {
    if (method === "getChatAdministrators") return { ok: true, result: [{ status: "creator", user: user() }] } as any;
    requests.push([method, params]);
    const result = method === "createForumTopic" ? { message_thread_id: 9 }
      : method === "getFile" ? { file_path: "docs/bytes.txt" }
      : method === "answerCallbackQuery" ? true : { message_id: messageId++ };
    return { ok: true, result } as any;
  });

  const session = process.env.LETMEKNOW_SESSION;
  process.env.LETMEKNOW_SESSION = "do-not-inherit";
  const lmk: Lmk = new Lmk({
    chat: CHAT, user: USER, session: "test",
    letmeknow: `"${path.join(import.meta.dirname, "fake-letmeknow.mjs")}" --home "${dir}"`,
  }, dir, telegram);
  if (session === undefined) delete process.env.LETMEKNOW_SESSION;
  else process.env.LETMEKNOW_SESSION = session;
  t.after(async () => {
    await lmk.stop();
    rmSync(dir, { force: true, recursive: true });
  });
  const deliveries: any[] = [];
  const agents = { deliver: (_target: unknown, message: string) => deliveries.push(JSON.parse(message)) } as unknown as Agents;
  timeline.subscribe((record) => route(agents, record, lmk));
  lmk.start();
  const lmkEvent = (id: string, fields: object) => appendFileSync(state("events.jsonl"), JSON.stringify({ type: "message", id, from: FP, ...fields }) + "\n");
  const attachment = (name: string, contents: string) => {
    writeFileSync(state(name), contents);
    return { name, path: state(name) };
  };
  const wait = async (file: string, count: number) => {
    for (let i = 0; i < 250; i++) {
      const rows = read(file);
      if (rows.length >= count) return rows;
      await sleep(10);
    }
    assert.fail(`Timed out waiting for ${count} entries in ${file}: ${JSON.stringify(read(file))}`);
  };
  return { state, telegram, timeline, requests, deliveries, lmkEvent, attachment, wait };
}

test("letmeknow delivers text and files to a fingerprint topic and logs the Bot API calls", async (t) => {
  const { lmkEvent, attachment, wait, requests, timeline, state } = setup(t);
  const text = "x".repeat(4097);
  lmkEvent("one", { content: text, truncated: true, attachment: attachment("notes.txt", "notes") });
  const calls = await wait("calls.jsonl", 3);
  assert.deepEqual(calls.map(({ args, body }) => [args, JSON.parse(body)]), [
    [["-"], { request: "one", result: { message_id: 50 } }],
    [["-"], { request: "one", result: { message_id: 51 } }],
    [["-"], { request: "one", result: { message_id: 52 } }],
  ]);
  assert.deepEqual(requests.slice(0, 3), [
    ["createForumTopic", { chat_id: CHAT, name: "aaaa1" }],
    ["sendMessage", { chat_id: CHAT, message_thread_id: 9, text: text.slice(0, 4096) }],
    ["sendMessage", { chat_id: CHAT, message_thread_id: 9, text: "x" }],
  ]);
  assert.equal(requests[3]![0], "sendDocument");
  assert.equal(requests[3]![1].message_thread_id, 9);
  assert.ok(requests[3]![1].document instanceof InputFile);
  assert.equal(requests[3]![1].document.filename, "notes.txt");
  assert.deepEqual((await wait("lmk-state.jsonl", 4)), [
    { topic: 9, fp: FP }, ...[50, 51, 52].map((tg) => ({ tg, lmk: "one", fp: FP })),
  ]);
  assert.equal(statSync(state("lmk-state.jsonl")).mode & 0o777, 0o600);
  assert.deepEqual(timeline.read().map((r) => r.type), Array(4).fill("telegram.sent"));
});

test("raw Bot API calls honor explicit topics, return getFile bytes, and reply to the sender on error", async (t) => {
  const { lmkEvent, attachment, wait, requests } = setup(t);
  const raw = (id: string, request: object) => lmkEvent(id, { content: "not sent", attachment: attachment(id + ".json", JSON.stringify(request)) });
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.telegram.org/file/bot1:x/docs/bytes.txt");
    return new Response("TG file");
  });
  raw("custom", { method: "sendDocument", document: "/not-a-local-upload", chat_id: 777, message_thread_id: 31 });
  raw("file", { method: "getFile", file_id: "f", message_thread_id: null });
  raw("bad", { method: "getUpdates" });
  const calls = await wait("calls.jsonl", 3);
  assert.deepEqual(requests, [
    ["sendDocument", { document: "/not-a-local-upload", chat_id: CHAT, message_thread_id: 31 }],
    ["getFile", { chat_id: CHAT, file_id: "f" }],
  ]);
  assert.deepEqual(JSON.parse(calls[1].body), { request: "file", result: { file_path: "docs/bytes.txt" } });
  assert.deepEqual([calls[1].args[0], calls[1].name, calls[1].file], ["--attach", "bytes.txt", "TG file"]);
  assert.deepEqual(calls[2].args, ["--reply-to", "bad", "--to", FP, "-"]);
  assert.match(calls[2].body, /invalid Bot API call/);
});

test("only lmk-bound topics and tracked messages or polls claim Telegram updates", async (t) => {
  const { telegram, timeline, deliveries, wait, lmkEvent, requests } = setup(t, [
    { topic: 9, fp: FP }, { tg: 70, lmk: "tracked", fp: FP }, { poll: "p", lmk: "poll", fp: FP },
  ]);
  t.mock.method(globalThis, "fetch", async () => new Response("outbound file"));
  let seq = 0;
  const update = async (kind: string, body: object) => {
    const raw = { update_id: ++seq, [kind]: body };
    await telegram.bot.handleUpdate(raw as any);
    return raw;
  };
  const message = (thread: number | undefined, extra?: object) => ({
    date: 0, message_id: 100 + seq, chat: chat(), from: user(), text: "@the_bot hi",
    entities: [{ type: "mention", offset: 0, length: 8 }],
    ...(thread === undefined ? {} : { message_thread_id: thread, is_topic_message: true }),
    ...extra,
  });
  const bound = await update("message", message(9, { document: { file_id: "f", file_unique_id: "u", file_name: "user.txt" } }));
  await update("message", message(31)); // existing Pi topic
  await update("message", message(32)); // new user topic, no mapping
  await update("message", message(undefined));
  await update("message", message(9, { chat: chat(-200), reply_to_message: { message_id: 70 } }));
  await update("message", message(9, { from: user(11) }));
  const reply = await update("message", message(31, { reply_to_message: { message_id: 70 } }));
  const callback = await update("callback_query", { id: "cb", from: user(), message: message(31, { message_id: 70 }) });
  const reaction = await update("message_reaction", { message_id: 70, chat: chat(), user: user(), old_reaction: [], new_reaction: [], date: 0 });
  const poll = await update("poll_answer", { poll_id: "p", user: user(), option_ids: [0] });
  assert.deepEqual(deliveries.map((r) => r.update_id), [2, 3, 4, 5, 6]);
  assert.equal(timeline.read().at(-1)!.type, "telegram.poll_answer");
  const calls = await wait("calls.jsonl", 5);
  assert.deepEqual(calls.map((call) => JSON.parse(call.body)), [bound, reply, callback, reaction, poll]);
  assert.deepEqual(calls[0].args.slice(0, 3), ["--to", FP, "--attach"]);
  assert.deepEqual([calls[0].name, calls[0].file], ["user.txt", "outbound file"]);
  assert.deepEqual(calls.slice(1).map((call) => call.args), [
    ["--reply-to", "tracked", "--to", FP, "-"],
    ["--reply-to", "tracked", "--to", FP, "-"],
    ["-"],
    ["--reply-to", "poll", "--to", FP, "-"],
  ]);
  const mappings = await wait("lmk-state.jsonl", 5);
  assert.deepEqual(mappings.slice(3), [{ tg: 100, lmk: calls[0].id }, { tg: 106, lmk: calls[1].id }]);
  lmkEvent("threaded", { content: "back to you", reply_to: calls[0].id });
  await wait("calls.jsonl", 6);
  assert.deepEqual(requests.at(-1), ["sendMessage", {
    text: "back to you", chat_id: CHAT, message_thread_id: 9,
    reply_parameters: { message_id: 100, allow_sending_without_reply: true },
  }]);
});
