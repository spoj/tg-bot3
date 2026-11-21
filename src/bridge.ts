import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, truncateSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { GrammyError, InputFile } from "grammy";
import type { HcClient } from "./hc.ts";
import { MEDIA_FIELDS, type Telegram } from "./telegram.ts";
import { conversation, conversationKey, type Conversation, type TimelineRecord } from "./timeline.ts";

type Json = Record<string, any>;
export type Scope = "owner" | "local";
export type EndpointConfig = { session: string; group: string; letmeknow?: string };
export type OwnerConfig = EndpointConfig & { chat: number; user: number };
export type BridgeConfig = {
  letmeknow: string;
  owner: OwnerConfig;
  local?: EndpointConfig;
  cwd: string;
  pi: string;
  agentDir?: string;
  botLabel: string;
  idleMs?: number;
  reapIntervalMs?: number;
  readyTimeoutMs?: number;
};

type Binding = {
  conv: Conversation;
  fp: string;
  scope: Scope;
  owned: boolean;
  sessionId?: string;
  hc?: string;
  lastActiveMs: number;
};
type MsgEntry = { chat: number; tg: number; lmk: string; scope: Scope; fp?: string };
type PollEntry = { chat: number; poll: string; lmk: string; scope: Scope; fp: string };
type PendingItem = {
  seq: number;
  conv: Conversation;
  scope: Scope;
  said: boolean;
  written: boolean;
  tgMessageId?: number;
  originLmk?: string;
  originFp?: string;
  file?: string;
  payload: string;
};

const run = promisify(execFile);
const POLLING_METHODS = new Set(["getUpdates", "setWebhook", "deleteWebhook", "logOut", "close"]);
const DEFAULT_IDLE_MS = 60 * 60_000;
const DEFAULT_REAP_INTERVAL_MS = 5 * 60_000;
const DEFAULT_READY_TIMEOUT_MS = 90_000;

function parseCommand(spec: string): { command: string; prefix: string[]; shared: string[]; membership: string[] } {
  const [command, ...args] = (spec.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
    .map((arg) => arg.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
  if (!command) throw new Error("letmeknow must name a command");
  const prefix: string[] = [];
  const shared: string[] = [];
  const membership: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--membership") membership.push(arg, args[++i]!);
    else if (arg.startsWith("--membership=")) membership.push(arg);
    else if (arg === "--home") {
      const home = args[++i]!;
      shared.push(arg, home);
      prefix.push(arg, home);
    } else {
      if (arg.startsWith("--home=")) shared.push(arg);
      prefix.push(arg);
    }
  }
  return { command, prefix, shared, membership };
}

export function wakes(record: TimelineRecord): boolean {
  const meta = record.meta ?? {};
  if (!meta.allowed_sender) return false;
  switch (record.type) {
    case "telegram.message": return Boolean(meta.user_content && (meta.private || meta.directed));
    case "telegram.callback_query": return true;
    case "telegram.my_chat_member": return Boolean(meta.group_add);
    default: return false;
  }
}

function isEntityParseError(error: unknown): boolean {
  const msg = error instanceof GrammyError ? error.description : error instanceof Error ? error.message : String(error);
  return /can't parse entities/i.test(msg);
}

function mediaSpecFor(filename: string): { method: string; field: string; fallbackDoc: boolean } {
  const ext = path.extname(filename).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".webp"].includes(ext)) return { method: "sendPhoto", field: "photo", fallbackDoc: true };
  if ([".ogg", ".opus"].includes(ext)) return { method: "sendVoice", field: "voice", fallbackDoc: true };
  if ([".mp3", ".m4a", ".flac", ".wav"].includes(ext)) return { method: "sendAudio", field: "audio", fallbackDoc: true };
  if ([".mp4", ".mov"].includes(ext)) return { method: "sendVideo", field: "video", fallbackDoc: true };
  return { method: "sendDocument", field: "document", fallbackDoc: false };
}

function applyAttachRefs(request: Json, attachment?: { name: string; path: string }): Json {
  const replace = (value: unknown): unknown => {
    if (typeof value === "string" && value.startsWith("attach://")) {
      if (!attachment) throw new Error("attach:// reference used without an attachment");
      return new InputFile(attachment.path, attachment.name);
    }
    return value;
  };
  const copy: Json = { ...request };
  for (const field of MEDIA_FIELDS) {
    if (field in copy) copy[field] = replace(copy[field]);
  }
  if (copy.media && typeof copy.media === "object") {
    const mapItem = (item: Json) => {
      const next: Json = { ...item, media: replace(item.media) };
      for (const field of ["thumbnail", "cover"]) if (field in next) next[field] = replace(next[field]);
      return next;
    };
    copy.media = Array.isArray(copy.media) ? copy.media.map(mapItem) : mapItem(copy.media);
  }
  return copy;
}

class LmkEndpoint {
  readonly scope: Scope;
  readonly session: string;
  readonly group: string;
  private readonly spec: string;
  private readonly env = { ...process.env, LETMEKNOW_SESSION: undefined };
  private readonly abort: AbortController;
  private readonly onEvent: (scope: Scope, event: Json, log?: string) => Promise<void>;
  private readonly onError: (error: unknown) => void;
  private shared: string[] = [];
  private listener?: ReturnType<typeof spawn>;
  private closed?: Promise<void>;
  private ready?: Promise<{ bin: string; log?: string }>;

  constructor(
    scope: Scope,
    config: EndpointConfig,
    defaultCmd: string,
    abort: AbortController,
    onEvent: (scope: Scope, event: Json, log?: string) => Promise<void>,
    onError: (error: unknown) => void,
  ) {
    this.scope = scope;
    this.session = config.session;
    this.group = config.group;
    this.spec = config.letmeknow ?? defaultCmd;
    this.abort = abort;
    this.onEvent = onEvent;
    this.onError = onError;
  }

  start(): void {
    const { command, prefix, shared, membership } = parseCommand(this.spec);
    this.shared = shared;
    const spawnListener = () => {
      if (this.abort.signal.aborted) return;
      const listener = spawn(command, [...prefix, "--session", this.session, "listen", ...membership], {
        env: this.env, detached: true, stdio: ["ignore", "pipe", "inherit"],
      });
      this.listener = listener;
      listener.on("error", (error) => this.onError(error));
      this.closed = new Promise((resolve) => listener.once("close", (code, signal) => {
        if (this.listener === listener) this.listener = undefined;
        resolve();
        if (!this.abort.signal.aborted) {
          this.onError(new Error(`listen (${this.scope}) exited (${code ?? signal}); restarting in 5s`));
          void sleep(5_000, undefined, { signal: this.abort.signal }).then(() => spawnListener()).catch(() => {});
        }
      }));
      const lines = createInterface({ input: listener.stdout })[Symbol.asyncIterator]();
      this.ready = lines.next().then(({ value, done }) => {
        if (done) throw new Error(`listen (${this.scope}) ended before ready`);
        const { bin, log } = JSON.parse(value);
        if (typeof bin !== "string" || !bin) throw new Error(`listen (${this.scope}) did not report its binary`);
        return { bin, log };
      });
      void this.ready.then(async ({ log }) => {
        for await (const line of lines) {
          if (this.abort.signal.aborted) break;
          try {
            await this.onEvent(this.scope, JSON.parse(line), log);
          } catch (error) {
            this.onError(error);
          }
        }
      }).catch((error) => this.onError(error));
    };
    spawnListener();
  }

  async stop(): Promise<void> {
    const pid = this.listener?.pid;
    if (!pid) return this.closed;
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    kill("SIGTERM");
    const timer = setTimeout(() => kill("SIGKILL"), 2_000);
    await this.closed;
    clearTimeout(timer);
  }

  async call(args: string[], text?: string): Promise<Json> {
    const ready = await this.ready;
    if (!ready) throw new Error(`letmeknow listener (${this.scope}) has not started`);
    this.abort.signal.throwIfAborted();
    const call = run(ready.bin, [...this.shared, "--session", this.session, ...args, ...(text === undefined ? [] : ["-"])], {
      env: this.env, signal: this.abort.signal,
    });
    call.child.stdin!.on("error", () => {});
    call.child.stdin!.end(text);
    return JSON.parse((await call).stdout);
  }
}

export class Bridge {
  private readonly config: BridgeConfig;
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly readyDir: string;
  private readonly telegram: Telegram;
  private readonly hc: HcClient;
  private readonly abort = new AbortController();
  private readonly endpoints: Record<Scope, LmkEndpoint | undefined>;
  private readonly bindingOfConv = new Map<string, Binding>();
  private readonly bindingOfFp = new Map<string, Binding>();
  private readonly msgByTg = new Map<string, MsgEntry>();
  private readonly tgByLmk = new Map<string, { chat: number; tg: number }>();
  private readonly pollOf = new Map<string, PollEntry>();
  private readonly pending = new Map<number, PendingItem>();
  private readonly queues = new Map<string, Promise<void>>();
  private reapTimer?: NodeJS.Timeout;

  constructor(config: BridgeConfig, stateDir: string, telegram: Telegram, hc: HcClient) {
    this.config = config;
    this.stateDir = stateDir;
    this.statePath = path.join(stateDir, "lmk-state.jsonl");
    this.readyDir = path.join(stateDir, "ready");
    this.telegram = telegram;
    this.hc = hc;
    const onEvent = (scope: Scope, event: Json, log?: string) => this.fromLmk(scope, event, log);
    const onError = (error: unknown) => this.report(error);
    this.endpoints = {
      owner: new LmkEndpoint("owner", config.owner, config.letmeknow, this.abort, onEvent, onError),
      local: config.local ? new LmkEndpoint("local", config.local, config.letmeknow, this.abort, onEvent, onError) : undefined,
    };
    if (existsSync(this.statePath)) {
      chmodSync(this.statePath, 0o600);
      const bytes = readFileSync(this.statePath);
      const end = bytes.lastIndexOf(10) + 1;
      if (end < bytes.length) truncateSync(this.statePath, end);
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) if (line) this.apply(JSON.parse(line));
    }
  }

  start(): void {
    this.endpoints.owner!.start();
    this.endpoints.local?.start();
    const interval = this.config.reapIntervalMs ?? DEFAULT_REAP_INTERVAL_MS;
    if (interval > 0) {
      this.reapTimer = setInterval(() => void this.reapIdle().catch((err) => this.report(err)), interval);
      this.reapTimer.unref();
    }
    for (const item of [...this.pending.values()].sort((a, b) => a.seq - b.seq)) {
      this.enqueue(item.conv, () => this.deliverPending(item));
    }
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.reapTimer) clearInterval(this.reapTimer);
    await Promise.all([
      this.endpoints.owner?.stop(),
      this.endpoints.local?.stop(),
    ]);
  }

  pollConversation(id: string): Conversation | undefined {
    const entry = this.pollOf.get(id);
    if (!entry) return undefined;
    const binding = this.bindingOfFp.get(`${entry.scope}:${entry.fp}`);
    return binding?.conv ?? conversation(entry.chat);
  }

  handleRecord(record: TimelineRecord): void {
    if (!record.type.startsWith("telegram.") || record.type === "telegram.sent" || record.type === "telegram.access_request") return;
    if (!record.conversation || !record.payload) return;
    const conv = record.conversation;
    const scope: Scope = conv.chat_id === this.config.owner.chat ? "owner" : "local";
    if (!this.endpoints[scope]) return;

    const kind = record.type.slice("telegram.".length);
    const body = record.payload;
    const message = kind === "callback_query" ? body.message : body;
    const written = kind === "message" || kind === "edited_message";

    let origin: MsgEntry | PollEntry | undefined;
    if (written) {
      origin = (body.external_reply?.chat?.id === conv.chat_id ? this.msgByTg.get(`${conv.chat_id}:${body.external_reply.message_id}`) : undefined)
        ?? (body.reply_to_message ? this.msgByTg.get(`${conv.chat_id}:${body.reply_to_message.message_id}`) : undefined);
    } else if (kind === "message_reaction" || kind === "callback_query") {
      origin = message ? this.msgByTg.get(`${conv.chat_id}:${message.message_id}`) : undefined;
    } else if (kind === "poll_answer") {
      origin = this.pollOf.get(body.poll_id);
      if (!origin) return;
    } else if (kind !== "my_chat_member") {
      return;
    }

    const senderId = (kind === "poll_answer" || kind === "message_reaction" ? body.user : body.from)?.id;
    if (scope === "owner" && senderId !== this.config.owner.user) return;
    if (scope === "local" && !record.meta?.allowed_sender) return;

    const key = conversationKey(conv);
    const existing = this.bindingOfConv.get(key);
    if (!existing && !origin?.fp && !wakes(record)) return;

    const attachFailure = record.attachments?.find((item: { failure?: string }) => item.failure)?.failure;
    if (attachFailure) {
      this.enqueue(conv, async () => {
        await this.telegram.send(conv, {
          method: "sendMessage",
          text: `letmeknow bridge: failed to download attachment (${attachFailure})`,
          ...(written && message?.message_id ? { reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true } } : {}),
        }).catch((err) => this.report(err));
      });
      return;
    }

    const media = written && Boolean(body.document ?? body.photo?.at(-1) ?? body.video ?? body.audio ?? body.voice
      ?? body.animation ?? body.video_note ?? body.sticker);
    const said = Boolean(
      kind === "poll_answer" || kind === "callback_query" || kind === "my_chat_member"
      || media || (body.text ?? body.caption) !== undefined,
    );
    const file = record.attachments?.find((item: { path?: string }) => item.path)?.path;
    const update = { update_id: record.update_id, [kind]: body };

    const item: PendingItem = {
      seq: record.seq,
      conv,
      scope,
      said,
      written,
      tgMessageId: written ? message?.message_id : undefined,
      originLmk: origin?.lmk,
      originFp: origin?.fp,
      file,
      payload: JSON.stringify(update),
    };
    this.record({ pending: item });
    this.enqueue(conv, () => this.deliverPending(item));
  }

  wake(record: TimelineRecord): void {
    const conv = record.conversation;
    if (!conv) return;
    const scope: Scope = conv.chat_id === this.config.owner.chat ? "owner" : "local";
    if (!this.endpoints[scope]) throw new Error(`No letmeknow endpoint configured for scope ${scope}`);
    const item: PendingItem = {
      seq: record.seq,
      conv,
      scope,
      said: true,
      written: false,
      payload: JSON.stringify(record),
    };
    this.record({ pending: item });
    this.enqueue(conv, () => this.deliverPending(item));
  }

  async resetConversation(conv: Conversation): Promise<void> {
    const key = conversationKey(conv);
    const done = this.enqueue(conv, async () => {
      const binding = this.bindingOfConv.get(key);
      if (binding?.owned && binding.hc) {
        await this.hc.killAndRemove(binding.hc).catch((err) => this.report(err));
      }
      if (binding) this.record({ unbind: conv });
    });
    await done;
  }

  async reapIdle(now = Date.now()): Promise<void> {
    const idleMs = this.config.idleMs ?? DEFAULT_IDLE_MS;
    for (const binding of [...this.bindingOfConv.values()]) {
      if (!binding.owned || !binding.hc) continue;
      if (now - binding.lastActiveMs < idleMs) continue;
      if (!(await this.hc.isReapable(binding.hc))) continue;
      const addr = binding.hc;
      await this.hc.killAndRemove(addr);
      this.record({ reaped: binding.conv, hc: addr });
    }
  }

  private enqueue(conv: Conversation, fn: () => Promise<void>): Promise<void> {
    const key = conversationKey(conv);
    const next = (this.queues.get(key) ?? Promise.resolve()).then(fn, fn);
    const tracked = next.finally(() => {
      if (this.queues.get(key) === tracked) this.queues.delete(key);
    });
    this.queues.set(key, tracked);
    return tracked;
  }

  private async deliverPending(item: PendingItem): Promise<void> {
    if (!this.pending.has(item.seq)) return;
    const endpoint = this.endpoints[item.scope];
    if (!endpoint) return;
    try {
      const fp = await this.resolveRecipient(item.conv, item.scope, item.originFp);
      const attach = item.file ? ["--attach", item.file] : [];
      const addr = item.said ? [...(item.originLmk ? ["--reply-to", item.originLmk] : []), "--to", fp] : [];
      let result: Json;
      try {
        result = await endpoint.call(["send", ...addr, ...attach], item.payload);
      } catch (error) {
        if (!item.said || !item.originLmk) throw error;
        result = await endpoint.call(["send", "--to", fp, ...attach], item.payload);
      }
      const binding = this.bindingOfConv.get(conversationKey(item.conv)) ?? this.bindingOfFp.get(`${item.scope}:${fp}`);
      if (binding) binding.lastActiveMs = Date.now();
      if (item.written && item.tgMessageId && result.id) {
        this.record({ chat: item.conv.chat_id, tg: item.tgMessageId, lmk: result.id, scope: item.scope });
      }
      this.record({ delivered: item.seq });
    } catch (error) {
      this.report(error);
      this.record({ delivered: item.seq, error: (error as Error).message });
      if (!item.said) return;
      await this.telegram.send(item.conv, {
        method: "sendMessage",
        text: `letmeknow bridge failed: ${(error as Error).message.slice(0, 1_000)}`,
        ...(item.written && item.tgMessageId ? { reply_parameters: { message_id: item.tgMessageId, allow_sending_without_reply: true } } : {}),
      }).catch((err) => this.report(err));
    }
  }

  private async resolveRecipient(conv: Conversation, scope: Scope, originFp?: string): Promise<string> {
    if (originFp) {
      const byFp = this.bindingOfFp.get(`${scope}:${originFp}`);
      if (byFp?.owned) {
        const alive = byFp.hc ? await this.hc.get(byFp.hc) : null;
        if (alive?.state === "live") return byFp.fp;
        return this.launchOrResume(byFp.conv, scope, byFp.sessionId ?? randomUUID());
      }
      return originFp;
    }
    const key = conversationKey(conv);
    const existing = this.bindingOfConv.get(key);
    if (existing) {
      if (!existing.owned) return existing.fp;
      const alive = existing.hc ? await this.hc.get(existing.hc) : null;
      if (alive?.state === "live") return existing.fp;
      return this.launchOrResume(conv, scope, existing.sessionId ?? randomUUID());
    }
    return this.launchOrResume(conv, scope, randomUUID());
  }

  private runtimePrompt(conv: Conversation, scope: Scope): string {
    const endpoint = this.endpoints[scope]!;
    const key = conversationKey(conv);
    const threadNote = conv.message_thread_id ? `, message_thread_id ${conv.message_thread_id}` : "";
    return `## Telegram conversation (${key})

You are the Pi agent for Telegram chat_id ${conv.chat_id}${threadNote}.
Your plain assistant text is not shown in Telegram. Talk to Telegram via the letmeknow tool addressed to bridge session ${endpoint.session}:
- Text (HTML by default, plain-text fallback on parse error): letmeknow send --to ${endpoint.session} -
- File/media (photo/voice/audio/video/document auto-selected; text <=1024 chars becomes caption): letmeknow send --to ${endpoint.session} --attach /abs/path -
- Explicit Telegram Bot API call (e.g. editForumTopic, sendPoll, inline keyboards, disable_notification): prefix stdin with "tg: " + JSON, e.g. tg: {"method":"editForumTopic","name":"Topic Name"}. Combine with --attach /abs/path using "attach://file" in the media field.

Bot state lives in ${this.stateDir} (timeline.jsonl, attachments/, allowed.json, AGENTS.md).
Incoming Telegram updates arrive as letmeknow messages from ${endpoint.session}; attachments are already downloaded and attached.
Manage reminders and schedules with: python3 /home/spoj/jobs/remind.py add|list|remove (never edit schedules.json).
`;
  }

  private async launchOrResume(conv: Conversation, scope: Scope, sessionId: string): Promise<string> {
    const endpoint = this.endpoints[scope]!;
    const key = conversationKey(conv);
    mkdirSync(this.readyDir, { recursive: true, mode: 0o700 });
    const readyFile = path.join(this.readyDir, `${randomUUID()}.json`);
    const agentsMd = path.join(this.stateDir, "AGENTS.md");
    const argv = [
      this.config.pi,
      "--session-id", sessionId,
      "--name", `tg ${key}`,
      "--append-system-prompt", this.runtimePrompt(conv, scope),
      ...(existsSync(agentsMd) ? ["--append-system-prompt", agentsMd] : []),
    ];
    const env: Record<string, string> = {
      PI_LETMEKNOW_JOIN: endpoint.group,
      PI_LETMEKNOW_ATTACH: "",
      PI_LETMEKNOW_READY_FILE: readyFile,
      ...(this.config.agentDir ? { PI_CODING_AGENT_DIR: this.config.agentDir } : {}),
    };
    const hcName = `tg-${String(conv.chat_id).replace("-", "g")}-${conv.message_thread_id ?? 0}`;
    const addr = await this.hc.spawn({
      name: hcName,
      cwd: this.config.cwd,
      labels: { owner: "tg-bot3", bot: this.config.botLabel, conv: key, scope },
      env,
      argv,
    });
    const deadline = Date.now() + (this.config.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    try {
      let checks = 0;
      while (Date.now() < deadline) {
        this.abort.signal.throwIfAborted();
        if (existsSync(readyFile)) {
          const receipt = JSON.parse(readFileSync(readyFile, "utf8")) as { fp?: string; groups?: string[]; warnings?: string[]; error?: string };
          if (receipt.error) throw new Error(`Pi letmeknow startup failed: ${receipt.error}`);
          if (!receipt.fp) throw new Error("Pi readiness receipt missing fp");
          if (!receipt.groups?.includes(endpoint.group)) {
            throw new Error(`Pi ${receipt.fp} did not join group ${endpoint.group}: ${(receipt.warnings ?? []).join("; ")}`);
          }
          this.record({ bind: conv, fp: receipt.fp, scope, owned: true, sessionId, hc: addr });
          return receipt.fp;
        }
        if (++checks % 10 === 0) {
          const term = await this.hc.get(addr);
          if (!term || term.state !== "live") throw new Error(`hc terminal ${addr} exited before letmeknow became ready`);
        }
        await sleep(100, undefined, { signal: this.abort.signal });
      }
      throw new Error(`Timed out waiting for Pi ${addr} to join letmeknow group ${endpoint.group}`);
    } catch (error) {
      await this.hc.killAndRemove(addr).catch(() => {});
      throw error;
    } finally {
      rmSync(readyFile, { force: true });
    }
  }

  private async createOwnerTopic(fp: string): Promise<number> {
    const endpoint = this.endpoints.owner!;
    const { members } = await endpoint.call(["members", "--all"]);
    const others = new Set<string>([
      ...members.map((m: Json) => m.fp),
      ...[...this.bindingOfFp.values()].filter((b) => b.scope === "owner").map((b) => b.fp),
    ]);
    others.delete(fp);
    let name = fp.slice(0, 4);
    while (name.length < fp.length && [...others].some((other) => other.startsWith(name))) name = fp.slice(0, name.length + 1);
    const created = await this.telegram.send(conversation(this.config.owner.chat), { method: "createForumTopic", name }) as Json;
    const conv = conversation(this.config.owner.chat, created.message_thread_id);
    this.record({ bind: conv, fp, scope: "owner", owned: false });
    return created.message_thread_id;
  }

  private async sendWithHtmlFallback(target: Conversation, request: Json, raw: boolean): Promise<any> {
    try {
      return await this.telegram.send(target, request, { raw });
    } catch (error) {
      if (request.parse_mode !== "HTML" || !isEntityParseError(error)) throw error;
      const plain = { ...request };
      delete plain.parse_mode;
      return this.telegram.send(target, plain, { raw });
    }
  }

  private async fromLmk(scope: Scope, event: Json, log?: string): Promise<void> {
    const endpoint = this.endpoints[scope]!;
    if (event.type !== "message") {
      if (scope === "owner") {
        const chat = conversation(this.config.owner.chat);
        for (const text of JSON.stringify(event).match(/[^]{1,4096}/gu) ?? []) {
          await this.telegram.send(chat, { method: "sendMessage", text });
        }
      }
      return;
    }
    const { id, from, attachment } = event;
    try {
      let content: string = event.content ?? "";
      if (event.truncated && log && existsSync(log)) {
        const whole = readFileSync(log, "utf8").split("\n").slice(0, -1).findLast((line) => {
          if (!line.includes(id)) return false;
          try {
            const item = JSON.parse(line);
            return item.type === "message" && item.id === id && (!event.group || item.group === event.group);
          } catch {
            return false;
          }
        });
        if (whole) content = JSON.parse(whole).content;
      }

      const binding = this.bindingOfFp.get(`${scope}:${from}`);
      if (binding) {
        binding.lastActiveMs = Date.now();
        if (event.reply_to && !this.tgByLmk.has(`${scope}:${event.reply_to}`)) {
          await this.queues.get(conversationKey(binding.conv));
        }
      }
      if (scope === "local" && !binding) {
        throw new Error(`Unbound local sender ${from} cannot send to Telegram`);
      }
      const allowedChat = binding ? binding.conv.chat_id : this.config.owner.chat;
      const replyEntry = event.reply_to ? this.tgByLmk.get(`${scope}:${event.reply_to}`) : undefined;
      const replyParams = replyEntry && replyEntry.chat === allowedChat
        ? { message_id: replyEntry.tg, allow_sending_without_reply: true }
        : undefined;

      if (content.startsWith("tg: ")) {
        const parsed = JSON.parse(content.slice(4)) as Json;
        if (typeof parsed?.method !== "string" || !/^[A-Za-z0-9_]+$/.test(parsed.method) || POLLING_METHODS.has(parsed.method)) {
          throw new Error("invalid Bot API call");
        }
        if ("chat_id" in parsed && parsed.chat_id !== allowedChat) {
          throw new Error(`chat_id ${parsed.chat_id} is outside bound chat ${allowedChat}`);
        }
        const request = applyAttachRefs(parsed, attachment);
        const explicitThread = "message_thread_id" in request;
        if (request.message_thread_id === null) delete request.message_thread_id;
        if (replyParams) request.reply_parameters ??= replyParams;

        const target = explicitThread
          ? conversation(allowedChat, typeof request.message_thread_id === "number" ? request.message_thread_id : undefined)
          : (binding?.conv ?? conversation(this.config.owner.chat, await this.createOwnerTopic(from)));

        const result: any = await this.telegram.send(target, request, { raw: true }).catch(async (error: Error) => {
          if (explicitThread || scope !== "owner" || binding?.owned || !/message thread not found/.test(error.message)) throw error;
          if (binding) this.record({ unbind: binding.conv });
          return this.telegram.send(conversation(this.config.owner.chat, await this.createOwnerTopic(from)), request, { raw: true });
        });

        const foreignTopic = explicitThread && (!binding || (request.message_thread_id ?? 0) !== (binding.conv.message_thread_id ?? 0));
        if (!foreignTopic) this.recordTelegramResult(allowedChat, scope, id, from, result);

        const replyText = JSON.stringify({ request: id, result });
        if (request.method === "getFile" && result?.file_path) {
          const temp = await mkdtemp(path.join(tmpdir(), "tg-bot3-lmk-"));
          try {
            const name = path.basename(result.file_path);
            const file = path.join(temp, name && name !== "." && name !== ".." ? name : "file");
            await writeFile(file, await this.telegram.downloadFile(result.file_path, this.abort.signal));
            await endpoint.call(["send", "--reply-to", id, "--to", from, "--attach", file], replyText);
          } finally {
            await rm(temp, { recursive: true });
          }
        } else {
          await endpoint.call(["send", "--reply-to", id, "--to", from], replyText);
        }
        return;
      }

      // Ordinary text / media send (HTML default with plain-text entity-parse fallback, silent on success).
      const target = binding?.conv ?? conversation(this.config.owner.chat, await this.createOwnerTopic(from));
      const sendOrdinary = async (req: Json, raw = false) => {
        const withReply = replyParams ? { reply_parameters: replyParams, ...req } : req;
        return this.sendWithHtmlFallback(target, withReply, raw).catch(async (error: Error) => {
          if (scope !== "owner" || binding?.owned || !/message thread not found/.test(error.message)) throw error;
          if (binding) this.record({ unbind: binding.conv });
          const freshTarget = conversation(this.config.owner.chat, await this.createOwnerTopic(from));
          return this.sendWithHtmlFallback(freshTarget, withReply, raw);
        });
      };

      const trimmed = content.trim();
      if (attachment) {
        const useCaption = Boolean(trimmed) && trimmed.length <= 1024;
        if (trimmed && !useCaption) {
          for (const chunk of content.match(/[^]{1,4096}/gu) ?? []) {
            if (!/\S/.test(chunk)) continue;
            const res = await sendOrdinary({ method: "sendMessage", text: chunk, parse_mode: "HTML" });
            this.recordTelegramResult(allowedChat, scope, id, from, res);
          }
        }
        const spec = mediaSpecFor(attachment.name);
        const buildMediaReq = (method: string, field: string): Json => ({
          method,
          [field]: new InputFile(attachment.path, attachment.name),
          ...(useCaption ? { caption: trimmed, parse_mode: "HTML" } : {}),
        });
        let res: any;
        try {
          res = await sendOrdinary(buildMediaReq(spec.method, spec.field), true);
        } catch (error) {
          if (!spec.fallbackDoc) throw error;
          res = await sendOrdinary(buildMediaReq("sendDocument", "document"), true);
        }
        this.recordTelegramResult(allowedChat, scope, id, from, res);
      } else {
        const chunks = (content.match(/[^]{1,4096}/gu) ?? []).filter((text) => /\S/.test(text));
        if (!chunks.length) chunks.push(content);
        for (const text of chunks) {
          const res = await sendOrdinary({ method: "sendMessage", text, parse_mode: "HTML" });
          this.recordTelegramResult(allowedChat, scope, id, from, res);
        }
      }
    } catch (error) {
      await endpoint.call(["send", "--reply-to", id, "--to", from], String(error)).catch((err) => this.report(err));
    }
  }

  private recordTelegramResult(chat: number, scope: Scope, lmkId: string, fp: string, result: any): void {
    for (const item of Array.isArray(result) ? result : [result]) {
      if (item?.message_id && (item.chat?.id ?? chat) === chat) {
        this.record({ chat, tg: item.message_id, lmk: lmkId, scope, fp });
        if (item.poll?.id) this.record({ chat, poll: item.poll.id, lmk: lmkId, scope, fp });
      }
    }
  }

  private report(error: unknown): void {
    if (!this.abort.signal.aborted) console.error("tg-bot3 bridge error:", (error as Error).message ?? error);
  }

  private record(entry: Json): void {
    appendFileSync(this.statePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.apply(entry);
  }

  private apply(entry: Json): void {
    if ("pending" in entry) {
      this.pending.set(entry.pending.seq, entry.pending);
      return;
    }
    if ("delivered" in entry) {
      this.pending.delete(entry.delivered);
      return;
    }
    if ("unbind" in entry) {
      const key = conversationKey(entry.unbind);
      const prev = this.bindingOfConv.get(key);
      if (prev) {
        this.bindingOfConv.delete(key);
        const fpKey = `${prev.scope}:${prev.fp}`;
        if (this.bindingOfFp.get(fpKey) === prev) this.bindingOfFp.delete(fpKey);
      }
      return;
    }
    if ("reaped" in entry) {
      const prev = this.bindingOfConv.get(conversationKey(entry.reaped));
      if (prev && (!entry.hc || prev.hc === entry.hc)) prev.hc = undefined;
      return;
    }
    if ("bind" in entry) {
      const conv: Conversation = entry.bind;
      const scope: Scope = entry.scope ?? "owner";
      const key = conversationKey(conv);
      const prev = this.bindingOfConv.get(key);
      if (prev) {
        const oldFpKey = `${prev.scope}:${prev.fp}`;
        if (this.bindingOfFp.get(oldFpKey) === prev) this.bindingOfFp.delete(oldFpKey);
      }
      const binding: Binding = {
        conv,
        fp: entry.fp,
        scope,
        owned: Boolean(entry.owned),
        sessionId: entry.sessionId,
        hc: entry.hc,
        lastActiveMs: Date.now(),
      };
      this.bindingOfConv.set(key, binding);
      this.bindingOfFp.set(`${scope}:${entry.fp}`, binding);
      return;
    }
    // Legacy entries from pre-unification lmk-state.jsonl:
    if ("poll" in entry) {
      const poll: PollEntry = {
        chat: entry.chat ?? this.config.owner.chat,
        poll: entry.poll,
        lmk: entry.lmk,
        scope: entry.scope ?? "owner",
        fp: entry.fp,
      };
      this.pollOf.set(poll.poll, poll);
      return;
    }
    if ("topic" in entry) {
      const conv = conversation(entry.chat ?? this.config.owner.chat, entry.topic);
      const scope: Scope = entry.scope ?? "owner";
      const binding: Binding = { conv, fp: entry.fp, scope, owned: false, lastActiveMs: Date.now() };
      this.bindingOfConv.set(conversationKey(conv), binding);
      this.bindingOfFp.set(`${scope}:${entry.fp}`, binding);
      return;
    }
    if ("tg" in entry) {
      const msg: MsgEntry = {
        chat: entry.chat ?? this.config.owner.chat,
        tg: entry.tg,
        lmk: entry.lmk,
        scope: entry.scope ?? "owner",
        ...(entry.fp ? { fp: entry.fp } : {}),
      };
      this.msgByTg.set(`${msg.chat}:${msg.tg}`, msg);
      if (!msg.fp) this.tgByLmk.set(`${msg.scope}:${msg.lmk}`, { chat: msg.chat, tg: msg.tg });
    }
  }
}
