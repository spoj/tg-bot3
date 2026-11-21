import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GrammyError, InputFile } from "grammy";
import { Bridge, splitHtml } from "../src/bridge.ts";
import type { HcClient, HcTerminal, SpawnSpec } from "../src/hc.ts";
import { Telegram } from "../src/telegram.ts";
import { Timeline } from "../src/timeline.ts";

const OWNER_CHAT = 10;
const OWNER_USER = 10;
const DAISY_CHAT = 20;
const GROUP_CHAT = -100;
const REMOTE_FP = "aaaa1";

const user = (id: number) => ({ id, is_bot: false, first_name: "U" });
const chat = (id: number) => id > 0 ? { id, type: "private", first_name: "U" } : { id, type: "supergroup", title: "G", is_forum: true };

class FakeHc implements HcClient {
  spawns: Array<{ addr: string; spec: SpawnSpec; fp: string; conversationId: string; promptContent?: string; promptMode?: number }> = [];
  terminals = new Map<string, HcTerminal>();
  reapable = new Set<string>();
  killed: string[] = [];
  nextFp?: (spec: SpawnSpec, n: number) => string;
  nextConversationId?: (spec: SpawnSpec, n: number) => string;
  nextReceipt?: (spec: SpawnSpec, n: number) => object;

  async spawn(spec: SpawnSpec): Promise<string> {
    const n = this.spawns.length + 1;
    const addr = `t${n}`;
    const fp = this.nextFp ? this.nextFp(spec, n) : `spawn${n}`;
    const convFlag = spec.argv.indexOf("--conversation");
    const resumedId = convFlag >= 0 ? spec.argv[convFlag + 1] : undefined;
    const conversationId = this.nextConversationId ? this.nextConversationId(spec, n) : (resumedId ?? `conv-${n}`);
    const promptFile = spec.env.AGY_LETMEKNOW_PROMPT_FILE;
    const promptContent = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8") : undefined;
    const promptMode = promptFile && existsSync(promptFile) ? statSync(promptFile).mode & 0o777 : undefined;
    this.spawns.push({ addr, spec, fp, conversationId, promptContent, promptMode });
    this.terminals.set(addr, { address: addr, state: "live", status: { state: "idle" }, labels: spec.labels });
    const readyFile = spec.env.AGY_LETMEKNOW_READY_FILE;
    if (readyFile) {
      mkdirSync(path.dirname(readyFile), { recursive: true });
      const groups = (spec.env.AGY_LETMEKNOW_JOIN ?? "").split(",").filter(Boolean);
      const receipt = this.nextReceipt ? this.nextReceipt(spec, n) : { fp, conversationId, groups, warnings: [] };
      writeFileSync(readyFile, JSON.stringify(receipt) + "\n");
    }
    return addr;
  }

  async get(address: string): Promise<HcTerminal | null> {
    return this.terminals.get(address) ?? null;
  }

  async isReapable(address: string): Promise<boolean> {
    return this.reapable.has(address);
  }

  async killAndRemove(address: string): Promise<void> {
    this.killed.push(address);
    this.terminals.delete(address);
    this.reapable.delete(address);
  }
}

function setup(
  t: TestContext,
  {
    entries = [],
    agentsMd,
    apiHook,
    typingDelayMs = 0,
    typingIntervalMs = 0,
  }: { entries?: object[]; agentsMd?: string; apiHook?: (method: string, params: any) => any; typingDelayMs?: number; typingIntervalMs?: number } = {},
) {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-bridge-"));
  const state = (file: string) => path.join(dir, file);
  const read = (file: string): any[] => existsSync(state(file))
    ? readFileSync(state(file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  writeFileSync(state("allowed.json"), JSON.stringify([OWNER_USER, DAISY_CHAT, GROUP_CHAT]));
  writeFileSync(state("owner-events.jsonl"), "");
  writeFileSync(state("local-events.jsonl"), "");
  if (agentsMd !== undefined) writeFileSync(state("AGENTS.md"), agentsMd);
  if (entries.length) writeFileSync(state("lmk-state.jsonl"), entries.map((e) => JSON.stringify(e) + "\n").join(""));

  const timeline = new Timeline(state("timeline.jsonl"));
  const hc = new FakeHc();
  let bridge!: Bridge;
  const telegram = new Telegram({
    token: "1:x",
    timeline,
    allowedPath: state("allowed.json"),
    attachmentsDir: state("attachments"),
    onNew: (target) => bridge.resetConversation(target),
    pollConversation: (id) => bridge.pollConversation(id),
  });
  telegram.bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "the_bot" } as any;

  const requests: Array<[string, any]> = [];
  let messageId = 50;
  telegram.bot.api.config.use(async (_prev, method, params) => {
    if (method === "getChatAdministrators") return { ok: true, result: [{ status: "creator", user: user(OWNER_USER) }] } as any;
    requests.push([method, params]);
    if (apiHook) {
      const hookRes = apiHook(method, params);
      if (hookRes !== undefined) return hookRes;
    }
    const result = method === "createForumTopic" ? { message_thread_id: 9 }
      : method === "getFile" ? { file_path: "docs/bytes.txt" }
      : method === "answerCallbackQuery" ? true
      : { message_id: messageId++ };
    return { ok: true, result } as any;
  });

  bridge = new Bridge(
    {
      letmeknow: `"${path.join(import.meta.dirname, "fake-letmeknow.mjs")}" --home "${dir}"`,
      owner: { session: "owner", group: "G_OWNER", chat: OWNER_CHAT, user: OWNER_USER },
      local: { session: "local", group: "G_LOCAL" },
      cwd: dir,
      agy: "agy",
      botLabel: "test",
      idleMs: 1_000,
      reapIntervalMs: 0,
      readyTimeoutMs: 5_000,
      typingDelayMs,
      typingIntervalMs,
    },
    dir,
    telegram,
    hc,
  );
  timeline.subscribe((record) => bridge.handleRecord(record));
  t.after(async () => {
    await bridge.stop();
    rmSync(dir, { force: true, recursive: true });
  });
  bridge.start();

  const lmkEvent = (scope: "owner" | "local", id: string, from: string, fields: object) =>
    appendFileSync(state(`${scope}-events.jsonl`), JSON.stringify({ type: "message", id, from, ...fields }) + "\n");
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
  const waitReq = async (count: number) => {
    for (let i = 0; i < 250; i++) {
      if (requests.length >= count) return requests;
      await sleep(10);
    }
    assert.fail(`Timed out waiting for ${count} Telegram requests: ${JSON.stringify(requests)}`);
  };

  return { dir, state, read, timeline, telegram, bridge, hc, requests, lmkEvent, attachment, wait, waitReq };
}

test("ordinary text defaults to HTML, falls back to plain text only on entity parse error, and stays silent on success", async (t) => {
  let parseFailOnce = true;
  const { lmkEvent, waitReq, read, requests, state } = setup(t, {
    apiHook: (method, params) => {
      if (method === "sendMessage" && params.parse_mode === "HTML" && params.text === "a < b" && parseFailOnce) {
        parseFailOnce = false;
        throw new GrammyError("parse", { ok: false, error_code: 400, description: "Bad Request: can't parse entities" } as any, method, params);
      }
      return undefined;
    },
  });
  lmkEvent("owner", "m1", REMOTE_FP, { content: "<b>hi</b>" });
  lmkEvent("owner", "m2", REMOTE_FP, { content: "a < b" });
  await waitReq(4);
  assert.deepEqual(requests[0], ["createForumTopic", { chat_id: OWNER_CHAT, name: "aaaa1" }]);
  assert.deepEqual(requests[1], ["sendMessage", { chat_id: OWNER_CHAT, message_thread_id: 9, text: "<b>hi</b>", parse_mode: "HTML" }]);
  assert.deepEqual(requests[2], ["sendMessage", { chat_id: OWNER_CHAT, message_thread_id: 9, text: "a < b", parse_mode: "HTML" }]);
  assert.deepEqual(requests[3], ["sendMessage", { chat_id: OWNER_CHAT, message_thread_id: 9, text: "a < b" }]);
  await sleep(50);
  assert.equal(read("owner-calls.jsonl").length, 0);
  assert.equal(statSync(state("lmk-state.jsonl")).mode & 0o777, 0o600);
});

test("plain --attach selects media method (including .ogg/.oga -> sendVoice, .json -> sendDocument) and uses short text as HTML caption", async (t) => {
  const { lmkEvent, attachment, waitReq, requests } = setup(t, {
    entries: [{ topic: 9, fp: REMOTE_FP }],
  });
  lmkEvent("owner", "a1", REMOTE_FP, { content: "<b>chart</b>", attachment: attachment("chart.png", "PNG") });
  lmkEvent("owner", "a2", REMOTE_FP, { content: "", attachment: attachment("note.ogg", "OGG") });
  lmkEvent("owner", "a3", REMOTE_FP, { content: "", attachment: attachment("voice.oga", "OGA") });
  lmkEvent("owner", "a4", REMOTE_FP, { content: "config", attachment: attachment("data.json", '{"method":"getUpdates"}') });
  await waitReq(4);
  assert.equal(requests[0]![0], "sendPhoto");
  assert.equal(requests[0]![1].caption, "<b>chart</b>");
  assert.equal(requests[0]![1].parse_mode, "HTML");
  assert.ok(requests[0]![1].photo instanceof InputFile);
  assert.equal(requests[1]![0], "sendVoice");
  assert.ok(requests[1]![1].voice instanceof InputFile);
  assert.equal(requests[2]![0], "sendVoice");
  assert.ok(requests[2]![1].voice instanceof InputFile);
  assert.equal(requests[3]![0], "sendDocument");
  assert.equal(requests[3]![1].caption, "config");
  assert.ok(requests[3]![1].document instanceof InputFile);
  assert.equal(requests[3]![1].document.filename, "data.json");
});

test("explicit 'tg: ' Bot API calls support attach://, block cross-chat overrides, protect foreign topic bindings, and return correlated replies", async (t) => {
  const { lmkEvent, attachment, wait, requests } = setup(t, {
    entries: [{ topic: 9, fp: REMOTE_FP }],
  });
  t.mock.method(globalThis, "fetch", async () => new Response("TG bytes"));
  lmkEvent("owner", "c1", REMOTE_FP, {
    content: 'tg: {"method":"sendDocument","document":"attach://file","caption":"quiet","disable_notification":true}',
    attachment: attachment("rep.pdf", "PDF"),
  });
  lmkEvent("owner", "c2", REMOTE_FP, {
    content: `tg: {"method":"sendMessage","chat_id":${DAISY_CHAT},"text":"sneaky"}`,
  });
  lmkEvent("owner", "c3", REMOTE_FP, {
    content: 'tg: {"method":"sendMessage","message_thread_id":31,"text":"other topic"}',
  });
  lmkEvent("owner", "c4", REMOTE_FP, {
    content: 'tg: {"method":"getFile","file_id":"f","message_thread_id":null}',
  });
  const calls = await wait("owner-calls.jsonl", 4);
  assert.equal(requests.length, 3);
  assert.equal(requests[0]![0], "sendDocument");
  assert.equal(requests[0]![1].chat_id, OWNER_CHAT);
  assert.equal(requests[0]![1].message_thread_id, 9);
  assert.ok(requests[0]![1].document instanceof InputFile);
  assert.equal(requests[0]![1].document.filename, "rep.pdf");
  assert.equal(requests[1]![0], "sendMessage");
  assert.equal(requests[1]![1].message_thread_id, 31);
  assert.equal(requests[2]![0], "getFile");
  assert.equal(JSON.parse(calls[0].body).request, "c1");
  assert.match(calls[1].body, /outside bound chat/);
  assert.equal(JSON.parse(calls[2].body).request, "c3");
  assert.equal(calls[3].name, "bytes.txt");
  assert.equal(calls[3].file, "TG bytes");
});

test("multi-chat isolation: owner spawns in G_OWNER, Daisy spawns in G_LOCAL, bursts serialize into one spawn", async (t) => {
  const { telegram, hc, wait, lmkEvent, waitReq, requests } = setup(t, {
    agentsMd: "# Custom Bot Rules\nBe brief.\n",
  });
  await Promise.all([
    telegram.bot.handleUpdate({ update_id: 1, message: { message_id: 101, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 77, text: "first" } } as any),
    telegram.bot.handleUpdate({ update_id: 2, message: { message_id: 102, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 77, text: "second" } } as any),
  ]);
  const ownerCalls = await wait("owner-calls.jsonl", 2);
  assert.equal(hc.spawns.length, 1);
  assert.deepEqual(hc.spawns[0]!.spec.argv, [
    "agy",
    "--dangerously-skip-permissions",
    "-i",
    "Session started for Telegram. Run agy-letmeknow bind now and wait for incoming Telegram messages.",
  ]);
  assert.equal(hc.spawns[0]!.spec.env.AGY_LETMEKNOW_JOIN, "G_OWNER");
  assert.equal(hc.spawns[0]!.spec.env.AGY_LETMEKNOW_ATTACH, "");
  assert.equal(hc.spawns[0]!.spec.env.AGY_CLI_OSC7501, "on");
  assert.equal(hc.spawns[0]!.promptMode, 0o600);
  assert.match(hc.spawns[0]!.promptContent!, /You are the Antigravity \(AGY\) agent/);
  assert.match(hc.spawns[0]!.promptContent!, /agy-letmeknow bind/);
  assert.match(hc.spawns[0]!.promptContent!, /agy-letmeknow send --to owner -/);
  assert.match(hc.spawns[0]!.promptContent!, /agy-letmeknow send --to owner --attach \/abs\/path -/);
  assert.match(hc.spawns[0]!.promptContent!, /# Custom Bot Rules\nBe brief\./);
  assert.equal(existsSync(hc.spawns[0]!.spec.env.AGY_LETMEKNOW_READY_FILE!), false);
  assert.equal(existsSync(hc.spawns[0]!.spec.env.AGY_LETMEKNOW_PROMPT_FILE!), false);
  assert.deepEqual(ownerCalls.map((c) => JSON.parse(c.body).message.text), ["first", "second"]);

  await telegram.bot.handleUpdate({
    update_id: 3,
    message: { message_id: 201, date: 0, chat: chat(DAISY_CHAT), from: user(DAISY_CHAT), is_topic_message: true, message_thread_id: 3836, text: "hi from daisy" },
  } as any);
  const localCalls = await wait("local-calls.jsonl", 1);
  assert.equal(hc.spawns.length, 2);
  assert.equal(hc.spawns[1]!.spec.env.AGY_LETMEKNOW_JOIN, "G_LOCAL");
  assert.equal(hc.spawns[1]!.spec.env.AGY_CLI_OSC7501, "on");
  assert.match(hc.spawns[1]!.promptContent!, /agy-letmeknow send --to local -/);
  assert.equal(JSON.parse(localCalls[0].body).message.text, "hi from daisy");

  // Daisy's agent replies over local endpoint -> routes strictly to Daisy's chat/topic.
  lmkEvent("local", "d1", hc.spawns[1]!.fp, { content: "<b>你好 Daisy</b>" });
  await waitReq(1);
  assert.deepEqual(requests[0], ["sendMessage", { chat_id: DAISY_CHAT, message_thread_id: 3836, text: "<b>你好 Daisy</b>", parse_mode: "HTML" }]);

  // Unbound sender on local endpoint is rejected.
  lmkEvent("local", "rogue", "unknownfp", { content: "hello" });
  const localAfter = await wait("local-calls.jsonl", 2);
  assert.match(localAfter[1].body, /Unbound local sender/);
});

test("sleeping-topic reminder -> reply resumes same conversationId (even with rotated fp), and /new resets to fresh conversationId", async (t) => {
  const { telegram, bridge, hc, wait, read } = setup(t);
  // 1. Initial message spawns fresh AGY conversation C1 without --conversation.
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 301, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 9885, text: "morning" },
  } as any);
  await wait("owner-calls.jsonl", 1);
  assert.equal(hc.spawns[0]!.spec.argv.includes("--conversation"), false);
  const firstConversationId = hc.spawns[0]!.conversationId;
  const bindEntry = read("lmk-state.jsonl").findLast((e) => "bind" in e);
  assert.equal(bindEntry.conversationId, firstConversationId);
  assert.equal("sessionId" in bindEntry, false);

  // 2. Idle reap kills owned terminal t1.
  hc.reapable.add("t1");
  await bridge.reapIdle(Date.now() + 2_000);
  assert.deepEqual(hc.killed, ["t1"]);

  // 3. Scheduled reminder delivered via telegram.send directly (like host.sock send) while topic session is asleep.
  const sent: any = await telegram.send({ chat_id: OWNER_CHAT, message_thread_id: 9885 }, { method: "sendMessage", text: "Reminder: check calendar" });
  assert.equal(hc.spawns.length, 1); // Sending reminder did NOT wake session.

  // 4. Matthew replies to that reminder -> resumes same conversationId C1 even with rotated fp.
  hc.nextFp = () => "rotated_fp";
  await telegram.bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 302,
      date: 0,
      chat: chat(OWNER_CHAT),
      from: user(OWNER_USER),
      is_topic_message: true,
      message_thread_id: 9885,
      reply_to_message: { message_id: sent.message_id, date: 0, chat: chat(OWNER_CHAT) },
      text: "done, thanks",
    },
  } as any);
  const callsAfterResume = await wait("owner-calls.jsonl", 2);
  assert.equal(hc.spawns.length, 2);
  assert.deepEqual(hc.spawns[1]!.spec.argv, [
    "agy",
    "--dangerously-skip-permissions",
    "--conversation",
    firstConversationId,
    "-i",
    "Session resumed for Telegram. Run agy-letmeknow bind now and handle incoming Telegram messages.",
  ]);
  assert.ok(callsAfterResume[1].args.includes("rotated_fp"));

  // 5. /new kills t2 and unbinds; next message starts a fresh conversation without --conversation.
  await telegram.bot.handleUpdate({
    update_id: 3,
    message: { message_id: 303, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 9885, text: "/new", entities: [{ type: "bot_command", offset: 0, length: 4 }] },
  } as any);
  assert.deepEqual(hc.killed, ["t1", "t2"]);

  hc.nextFp = () => "fresh_fp";
  await telegram.bot.handleUpdate({
    update_id: 4,
    message: { message_id: 304, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 9885, text: "fresh start" },
  } as any);
  await wait("owner-calls.jsonl", 3);
  assert.deepEqual(hc.spawns[2]!.spec.argv, [
    "agy",
    "--dangerously-skip-permissions",
    "-i",
    "Session started for Telegram. Run agy-letmeknow bind now and wait for incoming Telegram messages.",
  ]);
  assert.notEqual(hc.spawns[2]!.conversationId, firstConversationId);
});

test("legacy sessionId bindings in lmk-state.jsonl start fresh without --conversation while keeping unowned bindings and poll/reply maps", async (t) => {
  const { telegram, bridge, hc, wait, read } = setup(t, {
    entries: [
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 42 }, fp: "old_fp_42", scope: "owner", owned: true, sessionId: "legacy-uuid-42", hc: "dead-42" },
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 43 }, fp: "old_fp_43", scope: "owner", owned: true, sessionId: "legacy-uuid-43", hc: "dead-43" },
      { chat: OWNER_CHAT, tg: 601, lmk: "old-lmk-601", scope: "owner", fp: "old_fp_43" },
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 9 }, fp: REMOTE_FP, scope: "owner", owned: false },
      { chat: OWNER_CHAT, poll: "poll-1", lmk: "lmk-poll-1", scope: "owner", fp: REMOTE_FP },
    ],
  });

  // Direct message in legacy-bound topic 42 starts fresh without passing --conversation.
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 701, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 42, text: "hello 42" },
  } as any);
  await wait("owner-calls.jsonl", 1);
  assert.equal(hc.spawns.length, 1);
  assert.equal(hc.spawns[0]!.spec.argv.includes("--conversation"), false);

  // Reply to a legacy message in topic 43 (originFp -> owned binding) also starts fresh without --conversation.
  await telegram.bot.handleUpdate({
    update_id: 2,
    message: {
      message_id: 702,
      date: 0,
      chat: chat(OWNER_CHAT),
      from: user(OWNER_USER),
      is_topic_message: true,
      message_thread_id: 43,
      reply_to_message: { message_id: 601, date: 0, chat: chat(OWNER_CHAT) },
      text: "reply 43",
    },
  } as any);
  await wait("owner-calls.jsonl", 2);
  assert.equal(hc.spawns.length, 2);
  assert.equal(hc.spawns[1]!.spec.argv.includes("--conversation"), false);

  // New bindings persist conversationId from the AGY ready receipt.
  const binds = read("lmk-state.jsonl").filter((e) => "bind" in e && e.conversationId);
  assert.deepEqual(binds.map((b) => b.conversationId), ["conv-1", "conv-2"]);

  // Unowned bindings and poll maps remain intact.
  await telegram.bot.handleUpdate({
    update_id: 3,
    message: { message_id: 703, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 9, text: "to remote" },
  } as any);
  const calls = await wait("owner-calls.jsonl", 3);
  assert.equal(hc.spawns.length, 2);
  assert.ok(calls[2].args.includes(REMOTE_FP));
  assert.deepEqual(bridge.pollConversation("poll-1"), { chat_id: OWNER_CHAT, message_thread_id: 9 });
});

test("ready receipt missing conversationId fails startup, kills terminal, and cleans up prompt and ready files", async (t) => {
  const { telegram, hc, waitReq, requests } = setup(t);
  hc.nextReceipt = () => ({ fp: "bad1", groups: ["G_OWNER"] });
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 801, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 66, text: "hi" },
  } as any);
  await waitReq(1);
  assert.equal(requests[0]![0], "sendMessage");
  assert.match(requests[0]![1].text, /missing conversationId/);
  assert.deepEqual(hc.killed, ["t1"]);
  assert.equal(existsSync(hc.spawns[0]!.spec.env.AGY_LETMEKNOW_READY_FILE!), false);
  assert.equal(existsSync(hc.spawns[0]!.spec.env.AGY_LETMEKNOW_PROMPT_FILE!), false);
});

test("pending inbound item persisted in lmk-state.jsonl replays on bridge restart", async (t) => {
  const { wait, hc } = setup(t, {
    entries: [{
      pending: {
        seq: 42,
        conv: { chat_id: OWNER_CHAT, message_thread_id: 55 },
        scope: "owner",
        said: true,
        written: true,
        tgMessageId: 700,
        payload: JSON.stringify({ update_id: 99, message: { message_id: 700, text: "recovered" } }),
      },
    }],
  });
  const calls = await wait("owner-calls.jsonl", 1);
  assert.equal(hc.spawns.length, 1);
  assert.equal(JSON.parse(calls[0].body).message.text, "recovered");
});

test("splitHtml keeps tags, entities, and surrogate pairs intact across chunks", () => {
  assert.deepEqual(splitHtml("<b>short</b>", 4096), ["<b>short</b>"]);

  const code = `<pre><code class="language-ts">${"const x = 1;\n".repeat(10)}</code></pre>`;
  const codeChunks = splitHtml(code, 80);
  assert.ok(codeChunks.length >= 2);
  for (const chunk of codeChunks) {
    assert.ok(chunk.length <= 80, `chunk exceeded limit: ${chunk.length}`);
    assert.ok(chunk.startsWith('<pre><code class="language-ts">'));
    assert.ok(chunk.endsWith("</code></pre>"));
  }
  const joinedCode = codeChunks.map((c) => c.slice('<pre><code class="language-ts">'.length, -"</code></pre>".length)).join("");
  assert.equal(joinedCode, "const x = 1;\n".repeat(10));

  const nested = `<b><i><a href="https://example.com">${"word ".repeat(20)}</a></i></b>`;
  const nestedChunks = splitHtml(nested, 70);
  assert.ok(nestedChunks.length >= 2);
  for (const chunk of nestedChunks) {
    assert.ok(chunk.length <= 70);
    assert.ok(chunk.startsWith('<b><i><a href="https://example.com">'));
    assert.ok(chunk.endsWith("</a></i></b>"));
  }

  const entities = "aaaaaaa&lt;bbbbbbb&gt;ccccccc";
  const entityChunks = splitHtml(entities, 10);
  for (const chunk of entityChunks) {
    assert.ok(chunk.length <= 10);
    assert.doesNotMatch(chunk, /&[a-z]*$/);
  }
  assert.equal(entityChunks.join(""), entities);

  const emoji = "a".repeat(9) + "😀😀😀";
  const emojiChunks = splitHtml(emoji, 10);
  for (const chunk of emojiChunks) assert.ok(chunk.length <= 10);
  assert.equal(emojiChunks.join(""), emoji);
});

test("truthful typing indicator polls owned hc terminal while working, skips timeline, and ignores idle/remote sessions", async (t) => {
  const { telegram, hc, wait, waitReq, requests, read } = setup(t, {
    entries: [{ topic: 9, fp: REMOTE_FP }],
    typingDelayMs: 30,
    typingIntervalMs: 40,
  });

  // 1. Remote/unowned topic emits no typing indicator.
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 401, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 9, text: "remote ping" },
  } as any);
  await wait("owner-calls.jsonl", 1);
  await sleep(90);
  assert.equal(requests.filter(([m]) => m === "sendChatAction").length, 0);

  // 2. Owned topic that stays idle emits no typing indicator.
  await telegram.bot.handleUpdate({
    update_id: 2,
    message: { message_id: 402, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 88, text: "quick" },
  } as any);
  await wait("owner-calls.jsonl", 2);
  await sleep(90);
  assert.equal(requests.filter(([m]) => m === "sendChatAction").length, 0);

  // 3. Owned topic flips to working -> sends typing repeatedly while working, then stops when done.
  const term = hc.terminals.get("t1")!;
  await telegram.bot.handleUpdate({
    update_id: 3,
    message: { message_id: 403, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 88, text: "slow task" },
  } as any);
  await wait("owner-calls.jsonl", 3);
  term.status = { state: "working" };
  await waitReq(2);
  const typingBeforeDone = requests.filter(([m]) => m === "sendChatAction");
  assert.ok(typingBeforeDone.length >= 2);
  assert.deepEqual(typingBeforeDone[0], ["sendChatAction", { chat_id: OWNER_CHAT, message_thread_id: 88, action: "typing" }]);

  term.status = { state: "done" };
  await sleep(100);
  const countAfterStop = requests.filter(([m]) => m === "sendChatAction").length;
  await sleep(100);
  assert.equal(requests.filter(([m]) => m === "sendChatAction").length, countAfterStop);
  // Typing calls must not pollute timeline.jsonl.
  assert.equal(read("timeline.jsonl").filter((r) => r.type === "telegram.sent").length, 0);
});
