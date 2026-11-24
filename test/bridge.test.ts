import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GrammyError, InputFile } from "grammy";
import { Bridge, splitHtml } from "../src/bridge.ts";
import type { HarnessConfigMap } from "../src/harnesses.ts";
import type { DeliverMode, HcClient, HcTerminal, SpawnSpec } from "../src/hc.ts";
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
  spawns: Array<{ addr: string; spec: SpawnSpec; fp: string; promptContent?: string; promptMode?: number }> = [];
  terminals = new Map<string, HcTerminal>();
  reapable = new Set<string>();
  killed: string[] = [];
  nextFp?: (spec: SpawnSpec, n: number) => string;
  nextReceipt?: (spec: SpawnSpec, n: number) => object;
  onSpawn?: (spec: SpawnSpec, n: number, addr: string) => void;

  async spawn(spec: SpawnSpec): Promise<string> {
    const n = this.spawns.length + 1;
    const addr = `t${n}`;
    const fp = this.nextFp ? this.nextFp(spec, n) : (spec.session ?? `spawn${n}`);
    const promptFile = spec.env?.AGY_PROMPT_FILE;
    const promptContent = promptFile && existsSync(promptFile) ? readFileSync(promptFile, "utf8") : undefined;
    const promptMode = promptFile && existsSync(promptFile) ? statSync(promptFile).mode & 0o777 : undefined;
    this.spawns.push({ addr, spec, fp, promptContent, promptMode });
    this.terminals.set(addr, { address: addr, state: "live", status: { state: "idle" }, labels: spec.labels });
    this.onSpawn?.(spec, n, addr);
    if (spec.readyFile) {
      mkdirSync(path.dirname(spec.readyFile), { recursive: true });
      const groups = spec.join.split(",").filter(Boolean);
      const receipt = this.nextReceipt ? this.nextReceipt(spec, n) : { fp, groups, warnings: [] };
      writeFileSync(spec.readyFile, JSON.stringify(receipt) + "\n");
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

type SetupOptions = {
  dir?: string;
  entries?: object[];
  agentsMd?: string;
  harness?: string;
  harnesses?: HarnessConfigMap;
  agy?: string;
  deliver?: DeliverMode;
  agyBrainDir?: string;
  codexSessionsDir?: string;
  apiHook?: (method: string, params: any) => any;
  typingDelayMs?: number;
  typingIntervalMs?: number;
};

function setup(t: TestContext, opts: SetupOptions = {}) {
  const ownsDir = !opts.dir;
  const dir = opts.dir ?? mkdtempSync(path.join(tmpdir(), "tg-bot3-bridge-"));
  const state = (file: string) => path.join(dir, file);
  const read = (file: string): any[] => existsSync(state(file))
    ? readFileSync(state(file), "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  if (!existsSync(state("allowed.json"))) {
    writeFileSync(state("allowed.json"), JSON.stringify([OWNER_USER, DAISY_CHAT, GROUP_CHAT]));
  }
  if (!existsSync(state("owner-events.jsonl"))) writeFileSync(state("owner-events.jsonl"), "");
  if (!existsSync(state("local-events.jsonl"))) writeFileSync(state("local-events.jsonl"), "");
  if (opts.agentsMd !== undefined) writeFileSync(state("AGENTS.md"), opts.agentsMd);
  if (opts.entries?.length) writeFileSync(state("lmk-state.jsonl"), opts.entries.map((e) => JSON.stringify(e) + "\n").join(""));

  const timeline = new Timeline(state("timeline.jsonl"));
  const hc = new FakeHc();
  let bridge!: Bridge;
  const telegram = new Telegram({
    token: "1:x",
    timeline,
    allowedPath: state("allowed.json"),
    attachmentsDir: state("attachments"),
    onNew: (target, harness) => bridge.resetConversation(target, harness),
    pollConversation: (id) => bridge.pollConversation(id),
  });
  telegram.bot.botInfo = { id: 1, is_bot: true, first_name: "Bot", username: "the_bot" } as any;

  const requests: Array<[string, any]> = [];
  let messageId = 50;
  telegram.bot.api.config.use(async (_prev, method, params) => {
    if (method === "getChatAdministrators") return { ok: true, result: [{ status: "creator", user: user(OWNER_USER) }] } as any;
    requests.push([method, params]);
    if (opts.apiHook) {
      const hookRes = opts.apiHook(method, params);
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
      harness: opts.harness,
      harnesses: opts.harnesses,
      agy: opts.agy,
      deliver: opts.deliver,
      botLabel: "test",
      idleMs: 1_000,
      reapIntervalMs: 0,
      readyTimeoutMs: 5_000,
      typingDelayMs: opts.typingDelayMs ?? 0,
      typingIntervalMs: opts.typingIntervalMs ?? 0,
      agyBrainDir: opts.agyBrainDir ?? path.join(dir, "brain"),
      codexSessionsDir: opts.codexSessionsDir ?? path.join(dir, "codex-sessions"),
    },
    dir,
    telegram,
    hc,
  );
  timeline.subscribe((record) => bridge.handleRecord(record));
  t.after(async () => {
    await bridge.stop();
    if (ownsDir) rmSync(dir, { force: true, recursive: true });
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

test("multi-chat isolation: owner spawns in G_OWNER, Daisy spawns in G_LOCAL, bursts serialize into one spawn, and prompt files persist", async (t) => {
  const { telegram, hc, wait, lmkEvent, waitReq, requests, state } = setup(t, {
    agentsMd: "# Custom Bot Rules\nBe brief.\n",
  });
  await Promise.all([
    telegram.bot.handleUpdate({ update_id: 1, message: { message_id: 101, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 77, text: "first" } } as any),
    telegram.bot.handleUpdate({ update_id: 2, message: { message_id: 102, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 77, text: "second" } } as any),
  ]);
  const ownerCalls = await wait("owner-calls.jsonl", 2);
  assert.equal(hc.spawns.length, 1);
  const s0 = hc.spawns[0]!;
  assert.equal(s0.spec.join, "G_OWNER");
  assert.equal(s0.spec.deliver, "always");
  assert.equal(s0.spec.labels.harness, "agy");
  assert.equal(s0.spec.argv[0], "agy");
  assert.equal(s0.spec.argv[1], "--dangerously-skip-permissions");
  assert.equal(s0.spec.argv[2], "-i");
  assert.doesNotMatch(s0.spec.argv[3]!, /agy-letmeknow/);
  assert.match(s0.spec.argv[3]!, /lmk send --to owner -/);
  const expectedPromptPath = state(path.join("prompts", `${OWNER_CHAT}_77.md`));
  assert.equal(s0.spec.env?.AGY_PROMPT_FILE, expectedPromptPath);
  assert.equal(s0.promptMode, 0o600);
  assert.match(s0.promptContent!, /You are the agent for Telegram chat_id 10, message_thread_id 77/);
  assert.match(s0.promptContent!, /lmk send --to owner -/);
  assert.match(s0.promptContent!, /lmk send --to owner --attach \/abs\/path -/);
  assert.doesNotMatch(s0.promptContent!, /agy-letmeknow/);
  assert.match(s0.promptContent!, /# Custom Bot Rules\nBe brief\./);
  // Ready file is cleaned up, while persistent prompt file stays intact (no race with harness boot).
  assert.equal(existsSync(s0.spec.readyFile), false);
  assert.equal(existsSync(expectedPromptPath), true);
  assert.equal(statSync(expectedPromptPath).mode & 0o777, 0o600);
  assert.deepEqual(ownerCalls.map((c) => JSON.parse(c.body).message.text), ["first", "second"]);

  await telegram.bot.handleUpdate({
    update_id: 3,
    message: { message_id: 201, date: 0, chat: chat(DAISY_CHAT), from: user(DAISY_CHAT), is_topic_message: true, message_thread_id: 3836, text: "hi from daisy" },
  } as any);
  const localCalls = await wait("local-calls.jsonl", 1);
  assert.equal(hc.spawns.length, 2);
  assert.equal(hc.spawns[1]!.spec.join, "G_LOCAL");
  assert.match(hc.spawns[1]!.promptContent!, /lmk send --to local -/);
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

test("all 4 harness presets via /new <harness>, savedFp reuse on resume, discovery for agy/codex, and /new persistence across restart", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-harnesses-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const brainDir = path.join(dir, "brain");
  const codexDir = path.join(dir, "codex-sessions");

  const env1 = setup(t, { dir, agyBrainDir: brainDir, codexSessionsDir: codexDir });

  // 1. Default agy in topic 100 -> simulate AGY creating transcript with marker -> reapIdle discovers resumeId -> resume reuses resumeId AND savedFp.
  const agyUuid = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  env1.hc.onSpawn = (spec) => {
    if (spec.labels.harness === "agy" && !spec.argv.includes("--conversation")) {
      const m = spec.argv[spec.argv.indexOf("-i") + 1]!.match(/tg-bot3-run:[0-9a-f-]+/);
      if (m) {
        const logDir = path.join(brainDir, agyUuid, ".system_generated", "logs");
        mkdirSync(logDir, { recursive: true });
        writeFileSync(path.join(logDir, "transcript.jsonl"), JSON.stringify({ content: m[0] }) + "\n");
      }
    }
  };
  await env1.telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 1001, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "start agy" },
  } as any);
  await env1.wait("owner-calls.jsonl", 1);
  const agyFp = env1.hc.spawns[0]!.fp;
  assert.equal(env1.hc.spawns[0]!.spec.session, undefined);

  env1.hc.reapable.add("t1");
  await env1.bridge.reapIdle(Date.now() + 2_000);
  assert.deepEqual(env1.hc.killed, ["t1"]);

  // Next message resumes agy with discovered --conversation AND --session <agyFp>.
  await env1.telegram.bot.handleUpdate({
    update_id: 2,
    message: { message_id: 1002, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "resume agy" },
  } as any);
  await env1.wait("owner-calls.jsonl", 2);
  assert.equal(env1.hc.spawns[1]!.spec.session, agyFp);
  assert.equal(env1.hc.spawns[1]!.spec.argv[env1.hc.spawns[1]!.spec.argv.indexOf("--conversation") + 1], agyUuid);

  // Unknown /new harness is rejected WITHOUT killing live terminal t2.
  await env1.telegram.bot.handleUpdate({
    update_id: 3,
    message: { message_id: 1003, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "/new unknown", entities: [{ type: "bot_command", offset: 0, length: 4 }] },
  } as any);
  assert.deepEqual(env1.hc.killed, ["t1"]);
  assert.match(env1.requests.at(-1)![1].text, /Unknown harness "unknown"/);
  assert.match(env1.requests.at(-1)![1].text, /agy, pi, codex, claude/);

  // 2. /new pi -> kills t2, pins pi, spawns pi with UUID, reaps, resumes with same UUID AND savedFp.
  await env1.telegram.bot.handleUpdate({
    update_id: 4,
    message: { message_id: 1004, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "/new pi", entities: [{ type: "bot_command", offset: 0, length: 4 }] },
  } as any);
  assert.deepEqual(env1.hc.killed, ["t1", "t2"]);

  await env1.telegram.bot.handleUpdate({
    update_id: 5,
    message: { message_id: 1005, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "hi pi" },
  } as any);
  await env1.wait("owner-calls.jsonl", 3);
  const piSpawn1 = env1.hc.spawns[2]!;
  assert.equal(piSpawn1.spec.argv[0], "pi");
  assert.equal(piSpawn1.spec.session, undefined);
  const piSessionId = piSpawn1.spec.argv[piSpawn1.spec.argv.indexOf("--session-id") + 1]!;
  assert.equal(piSpawn1.spec.argv[piSpawn1.spec.argv.indexOf("--name") + 1], `tg ${OWNER_CHAT}:100`);

  env1.hc.reapable.add(piSpawn1.addr);
  await env1.bridge.reapIdle(Date.now() + 2_000);
  await env1.telegram.bot.handleUpdate({
    update_id: 6,
    message: { message_id: 1006, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "resume pi" },
  } as any);
  await env1.wait("owner-calls.jsonl", 4);
  const piSpawn2 = env1.hc.spawns[3]!;
  assert.equal(piSpawn2.spec.argv[0], "pi");
  assert.equal(piSpawn2.spec.argv[piSpawn2.spec.argv.indexOf("--session-id") + 1], piSessionId);
  assert.equal(piSpawn2.spec.session, piSpawn1.fp);

  // 3. /new claude -> first launch uses --session-id, resume uses --resume with same UUID and savedFp.
  await env1.telegram.bot.handleUpdate({
    update_id: 7,
    message: { message_id: 1007, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "/new claude", entities: [{ type: "bot_command", offset: 0, length: 4 }] },
  } as any);
  await env1.telegram.bot.handleUpdate({
    update_id: 8,
    message: { message_id: 1008, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "hi claude" },
  } as any);
  await env1.wait("owner-calls.jsonl", 5);
  const claudeSpawn1 = env1.hc.spawns[4]!;
  assert.equal(claudeSpawn1.spec.argv[0], "claude");
  assert.ok(claudeSpawn1.spec.argv.includes("--dangerously-skip-permissions"));
  const claudeSessionId = claudeSpawn1.spec.argv[claudeSpawn1.spec.argv.indexOf("--session-id") + 1]!;

  env1.hc.reapable.add(claudeSpawn1.addr);
  await env1.bridge.reapIdle(Date.now() + 2_000);
  await env1.telegram.bot.handleUpdate({
    update_id: 9,
    message: { message_id: 1009, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "resume claude" },
  } as any);
  await env1.wait("owner-calls.jsonl", 6);
  const claudeSpawn2 = env1.hc.spawns[5]!;
  assert.equal(claudeSpawn2.spec.argv[0], "claude");
  assert.equal(claudeSpawn2.spec.argv.includes("--session-id"), false);
  assert.equal(claudeSpawn2.spec.argv[claudeSpawn2.spec.argv.indexOf("--resume") + 1], claudeSessionId);
  assert.equal(claudeSpawn2.spec.session, claudeSpawn1.fp);

  // 4. /new codex persisted across Bridge restart!
  await env1.telegram.bot.handleUpdate({
    update_id: 10,
    message: { message_id: 1010, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "/new codex", entities: [{ type: "bot_command", offset: 0, length: 4 }] },
  } as any);
  await env1.bridge.stop();

  // Restart bridge on the same state directory -> pending codex choice survives!
  const env2 = setup(t, { dir, agyBrainDir: brainDir, codexSessionsDir: codexDir });
  const codexUuid = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  env2.hc.onSpawn = (spec) => {
    if (spec.labels.harness === "codex" && spec.argv[1] !== "resume") {
      const cfg = spec.argv[spec.argv.indexOf("-c") + 1]!;
      const m = cfg.match(/tg-bot3-run:[0-9a-f-]+/);
      if (m) {
        const d = new Date();
        const pad = (n: number) => String(n).padStart(2, "0");
        const dayDir = path.join(codexDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
        mkdirSync(dayDir, { recursive: true });
        writeFileSync(
          path.join(dayDir, `rollout-2026-11-24T16-00-00-${codexUuid}.jsonl`),
          JSON.stringify({ type: "session_meta", payload: { id: codexUuid } }) + "\n"
            + JSON.stringify({ type: "response_item", payload: { role: "developer", content: [{ text: m[0] }] } }) + "\n",
        );
      }
    }
  };
  await env2.telegram.bot.handleUpdate({
    update_id: 11,
    message: { message_id: 1011, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "hi codex" },
  } as any);
  await env2.wait("owner-calls.jsonl", 7);
  const codexSpawn1 = env2.hc.spawns[0]!;
  assert.equal(codexSpawn1.spec.argv[0], "codex");
  assert.equal(codexSpawn1.spec.argv[1], "--no-daemon");

  env2.hc.reapable.add(codexSpawn1.addr);
  await env2.bridge.reapIdle(Date.now() + 2_000);
  await env2.telegram.bot.handleUpdate({
    update_id: 12,
    message: { message_id: 1012, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "resume codex" },
  } as any);
  await env2.wait("owner-calls.jsonl", 8);
  const codexSpawn2 = env2.hc.spawns[1]!;
  assert.equal(codexSpawn2.spec.argv[0], "codex");
  assert.equal(codexSpawn2.spec.argv[1], "resume");
  assert.equal(codexSpawn2.spec.argv.at(-1), codexUuid);
  assert.equal(codexSpawn2.spec.session, codexSpawn1.fp);

  // 5. Plain /new resets back to default harness (agy).
  await env2.telegram.bot.handleUpdate({
    update_id: 13,
    message: { message_id: 1013, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "/new", entities: [{ type: "bot_command", offset: 0, length: 4 }] },
  } as any);
  await env2.telegram.bot.handleUpdate({
    update_id: 14,
    message: { message_id: 1014, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 100, text: "back to agy" },
  } as any);
  await env2.wait("owner-calls.jsonl", 9);
  assert.equal(env2.hc.spawns[2]!.spec.argv[0], "agy");
  assert.equal(env2.hc.spawns[2]!.spec.session, undefined);
});

test("legacy conversationId (agy) and sessionId (pi) bindings replay cleanly and resume with savedFp", async (t) => {
  const { telegram, bridge, hc, wait, read } = setup(t, {
    entries: [
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 42 }, fp: "old_agy_fp", scope: "owner", owned: true, conversationId: "legacy-agy-conv", hc: "dead-42" },
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 43 }, fp: "old_pi_fp", scope: "owner", owned: true, sessionId: "legacy-pi-uuid", hc: "dead-43" },
      { chat: OWNER_CHAT, tg: 601, lmk: "old-lmk-601", scope: "owner", fp: "old_pi_fp" },
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 9 }, fp: REMOTE_FP, scope: "owner", owned: false },
      { chat: OWNER_CHAT, poll: "poll-1", lmk: "lmk-poll-1", scope: "owner", fp: REMOTE_FP },
    ],
  });

  // Legacy conversationId -> resumes as agy with --conversation legacy-agy-conv and --session old_agy_fp.
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 701, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 42, text: "hello 42" },
  } as any);
  await wait("owner-calls.jsonl", 1);
  assert.equal(hc.spawns[0]!.spec.argv[0], "agy");
  assert.equal(hc.spawns[0]!.spec.argv[hc.spawns[0]!.spec.argv.indexOf("--conversation") + 1], "legacy-agy-conv");
  assert.equal(hc.spawns[0]!.spec.session, "old_agy_fp");

  // Legacy sessionId -> resumes as pi with --session-id legacy-pi-uuid and --session old_pi_fp.
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
  assert.equal(hc.spawns[1]!.spec.argv[0], "pi");
  assert.equal(hc.spawns[1]!.spec.argv[hc.spawns[1]!.spec.argv.indexOf("--session-id") + 1], "legacy-pi-uuid");
  assert.equal(hc.spawns[1]!.spec.session, "old_pi_fp");

  const newBinds = read("lmk-state.jsonl").filter((e) => "bind" in e && e.harness);
  assert.deepEqual(
    newBinds.map((b) => ({ harness: b.harness, resumeId: b.resumeId, fp: b.fp })),
    [
      { harness: "agy", resumeId: "legacy-agy-conv", fp: "old_agy_fp" },
      { harness: "pi", resumeId: "legacy-pi-uuid", fp: "old_pi_fp" },
    ],
  );

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

test("originFp rebind edge case: replies to older messages in owned topics route to current/fresh session after fp rotation or /new, while remote originFp stays intact", async (t) => {
  const { telegram, bridge, hc, lmkEvent, wait, waitReq } = setup(t, {
    entries: [
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 9 }, fp: REMOTE_FP, scope: "owner", owned: false },
      { chat: OWNER_CHAT, tg: 900, lmk: "remote-lmk-900", scope: "owner", fp: REMOTE_FP },
    ],
  });

  // 1. Owned topic 50 spawns with fp1 and sends a message (Telegram message_id 50) -> recorded in msgByTg with fp1.
  hc.nextFp = (_spec, n) => `owned_fp_${n}`;
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 501, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 50, text: "init" },
  } as any);
  await wait("owner-calls.jsonl", 1);
  assert.equal(hc.spawns[0]!.fp, "owned_fp_1");

  lmkEvent("owner", "agent-msg-1", "owned_fp_1", { content: "hello from owned_fp_1" });
  await waitReq(1); // receives message_id 50

  // 2. Reap and rotate fp to owned_fp_2 (e.g. after 7-day letmeknow retention expiry).
  hc.reapable.add("t1");
  await bridge.reapIdle(Date.now() + 2_000);
  await telegram.bot.handleUpdate({
    update_id: 2,
    message: { message_id: 502, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 50, text: "wake rotated" },
  } as any);
  const callsAfterRotate = await wait("owner-calls.jsonl", 2);
  assert.equal(hc.spawns[1]!.fp, "owned_fp_2");
  assert.ok(callsAfterRotate[1].args.includes("owned_fp_2"));

  // 3. Reply to the OLD message (message_id 50, whose msgByTg.fp is dead owned_fp_1) -> must route to owned_fp_2, NEVER owned_fp_1!
  await telegram.bot.handleUpdate({
    update_id: 3,
    message: {
      message_id: 503,
      date: 0,
      chat: chat(OWNER_CHAT),
      from: user(OWNER_USER),
      is_topic_message: true,
      message_thread_id: 50,
      reply_to_message: { message_id: 50, date: 0, chat: chat(OWNER_CHAT) },
      text: "replying to old owned msg",
    },
  } as any);
  const callsAfterOldReply = await wait("owner-calls.jsonl", 3);
  assert.ok(callsAfterOldReply[2].args.includes("owned_fp_2"));
  assert.equal(callsAfterOldReply[2].args.includes("owned_fp_1"), false);

  // 4. /new codex unbinds topic 50 -> replying to old message_id 50 (dead owned_fp_1) launches fresh codex (owned_fp_3), NEVER dead owned_fp_1!
  await telegram.bot.handleUpdate({
    update_id: 4,
    message: { message_id: 504, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 50, text: "/new codex", entities: [{ type: "bot_command", offset: 0, length: 4 }] },
  } as any);
  await telegram.bot.handleUpdate({
    update_id: 5,
    message: {
      message_id: 505,
      date: 0,
      chat: chat(OWNER_CHAT),
      from: user(OWNER_USER),
      is_topic_message: true,
      message_thread_id: 50,
      reply_to_message: { message_id: 50, date: 0, chat: chat(OWNER_CHAT) },
      text: "replying after /new",
    },
  } as any);
  const callsAfterNewReply = await wait("owner-calls.jsonl", 4);
  assert.equal(hc.spawns[2]!.spec.argv[0], "codex");
  assert.ok(callsAfterNewReply[3].args.includes("owned_fp_3"));
  assert.equal(callsAfterNewReply[3].args.includes("owned_fp_1"), false);

  // 5. Replying to an unowned remote agent's message (tg 900, fp REMOTE_FP) inside topic 50 STILL routes to REMOTE_FP!
  await telegram.bot.handleUpdate({
    update_id: 6,
    message: {
      message_id: 506,
      date: 0,
      chat: chat(OWNER_CHAT),
      from: user(OWNER_USER),
      is_topic_message: true,
      message_thread_id: 50,
      reply_to_message: { message_id: 900, date: 0, chat: chat(OWNER_CHAT) },
      text: "to remote agent",
    },
  } as any);
  const callsAfterRemoteReply = await wait("owner-calls.jsonl", 5);
  assert.ok(callsAfterRemoteReply[4].args.includes(REMOTE_FP));
});

test("expired savedFp receipt error retries once without --session while keeping harness and resumeId", async (t) => {
  const { telegram, hc, wait } = setup(t, {
    entries: [
      { bind: { chat_id: OWNER_CHAT, message_thread_id: 61 }, fp: "expired_fp", scope: "owner", owned: true, harness: "pi", resumeId: "pi-uuid-61", hc: "dead-61" },
    ],
  });
  hc.nextReceipt = (spec, n) => (n === 1 ? { error: "session expired" } : { fp: "fresh_fp_61", groups: [spec.join], warnings: [] });
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 810, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 61, text: "hello" },
  } as any);
  const calls = await wait("owner-calls.jsonl", 1);
  assert.equal(hc.spawns.length, 2);
  assert.equal(hc.spawns[0]!.spec.session, "expired_fp");
  assert.equal(hc.spawns[1]!.spec.session, undefined);
  assert.equal(hc.spawns[1]!.spec.argv[0], "pi");
  assert.equal(hc.spawns[1]!.spec.argv[hc.spawns[1]!.spec.argv.indexOf("--session-id") + 1], "pi-uuid-61");
  assert.deepEqual(hc.killed, ["t1"]);
  assert.ok(calls[0].args.includes("fresh_fp_61"));
});

test("ready receipt missing fp fails startup, kills terminal, cleans up ready file, and keeps persistent prompt file", async (t) => {
  const { telegram, hc, waitReq, requests } = setup(t);
  hc.nextReceipt = () => ({ groups: ["G_OWNER"] });
  await telegram.bot.handleUpdate({
    update_id: 1,
    message: { message_id: 801, date: 0, chat: chat(OWNER_CHAT), from: user(OWNER_USER), is_topic_message: true, message_thread_id: 66, text: "hi" },
  } as any);
  await waitReq(1);
  assert.equal(requests[0]![0], "sendMessage");
  assert.match(requests[0]![1].text, /missing fp/);
  assert.deepEqual(hc.killed, ["t1"]);
  assert.equal(existsSync(hc.spawns[0]!.spec.readyFile), false);
  assert.equal(existsSync(hc.spawns[0]!.spec.env!.AGY_PROMPT_FILE!), true);
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
