import { execFile, spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, readFileSync, truncateSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import type { Telegram } from "./telegram.ts";
import { conversation, type TimelineRecord } from "./timeline.ts";

type Json = Record<string, any>;
export type LmkConfig = { session: string; letmeknow: string; chat: number; user: number };
type MessageEntry = { tg: number; lmk: string; fp?: string };
type PollEntry = { poll: string; lmk: string; fp: string };
type Entry = MessageEntry | PollEntry | { topic: number; fp: string };

const run = promisify(execFile);
const POLLING_METHODS = new Set(["getUpdates", "setWebhook", "deleteWebhook", "logOut", "close"]);

export class Lmk {
  private readonly config: LmkConfig;
  private readonly telegram: Telegram;
  private readonly statePath: string;
  private readonly lmkOf = new Map<number, MessageEntry>();
  private readonly pollOf = new Map<string, PollEntry>();
  private readonly tgOf = new Map<string, number>();
  private readonly topicOf = new Map<string, number>();
  private readonly memberOf = new Map<number, string>();
  private readonly env = { ...process.env, LETMEKNOW_SESSION: undefined };
  private readonly abort = new AbortController();
  private readonly shared: string[] = [];
  private listener?: ReturnType<typeof spawn>;
  private closed?: Promise<void>;
  private ready?: Promise<{ bin: string; log?: string }>;
  private outgoing = Promise.resolve();

  constructor(config: LmkConfig, stateDir: string, telegram: Telegram) {
    this.config = config;
    this.telegram = telegram;
    this.statePath = path.join(stateDir, "lmk-state.jsonl");
    if (existsSync(this.statePath)) {
      chmodSync(this.statePath, 0o600);
      const bytes = readFileSync(this.statePath);
      const end = bytes.lastIndexOf(10) + 1;
      if (end < bytes.length) truncateSync(this.statePath, end);
      for (const line of bytes.subarray(0, end).toString("utf8").split("\n")) if (line) this.apply(JSON.parse(line));
    }
  }

  start(): void {
    const [command, ...args] = (this.config.letmeknow.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [])
      .map((arg) => arg.replace(/"([^"]*)"|'([^']*)'/g, "$1$2"));
    if (!command) throw new Error("lmk.letmeknow must name a command");
    const prefix: string[] = [];
    const membership: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--membership") membership.push(arg, args[++i]!);
      else if (arg.startsWith("--membership=")) membership.push(arg);
      else if (arg === "--home") {
        const home = args[++i]!;
        this.shared.push(arg, home);
        prefix.push(arg, home);
      } else {
        if (arg.startsWith("--home=")) this.shared.push(arg);
        prefix.push(arg);
      }
    }
    const listener = spawn(command, [...prefix, "--session", this.config.session, "listen", ...membership], {
      env: this.env, detached: true, stdio: ["ignore", "pipe", "inherit"],
    });
    this.listener = listener;
    listener.on("error", (error) => this.report(error));
    this.closed = new Promise((resolve) => listener.once("close", (code, signal) => {
      this.listener = undefined;
      this.report(new Error(`listen exited (${code ?? signal})`));
      resolve();
    }));
    const lines = createInterface({ input: listener.stdout })[Symbol.asyncIterator]();
    this.ready = lines.next().then(({ value, done }) => {
      if (done) throw new Error("listen ended before ready");
      const { bin, log } = JSON.parse(value);
      if (typeof bin !== "string" || !bin) throw new Error("listen did not report its binary");
      return { bin, log };
    });
    void this.ready.then(async ({ log }) => {
      for await (const line of lines) {
        if (this.abort.signal.aborted) break;
        try {
          await this.fromLmk(JSON.parse(line), log);
        } catch (error) {
          this.report(error);
        }
      }
    }).catch((error) => this.report(error));
  }

  async stop(): Promise<void> {
    this.abort.abort();
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

  pollConversation(id: string) {
    const entry = this.pollOf.get(id);
    if (entry) return conversation(this.config.chat, this.topicOf.get(entry.fp));
  }

  claim(record: TimelineRecord): boolean {
    if (!record.type.startsWith("telegram.") || record.conversation?.chat_id !== this.config.chat || !record.payload) return false;
    const kind = record.type.slice("telegram.".length);
    const body = record.payload;
    const message = kind === "callback_query" ? body.message : body;
    const written = kind === "message" || kind === "edited_message";
    let origin: MessageEntry | PollEntry | undefined;
    if (written) {
      origin = (body.external_reply?.chat?.id === this.config.chat ? this.lmkOf.get(body.external_reply.message_id) : undefined)
        ?? this.lmkOf.get(body.reply_to_message?.message_id);
    } else if (kind === "message_reaction" || kind === "callback_query") {
      origin = this.lmkOf.get(message?.message_id);
    } else if (kind === "poll_answer") {
      origin = this.pollOf.get(body.poll_id);
      if (!origin) return false;
    } else return false;
    if ((kind === "poll_answer" || kind === "message_reaction" ? body.user : body.from)?.id !== this.config.user) return false;
    if (!message) return false;
    const member = origin?.fp ?? this.memberOf.get(message.message_thread_id ?? record.conversation.message_thread_id!);
    if (!member) return false;

    const update = { update_id: record.update_id, [kind]: body };
    const args = ["send", ...(origin ? ["--reply-to", origin.lmk] : []), "--to", member];
    const file = record.attachments?.find((item: { path?: string }) => item.path)?.path;
    if (file) args.push("--attach", file);
    this.outgoing = this.outgoing.then(async () => {
      const { id } = await this.call(args, JSON.stringify(update));
      if (written) this.record({ tg: message.message_id, lmk: id });
    }).catch((error) => this.report(error));
    return true;
  }

  private report(error: unknown): void {
    if (!this.abort.signal.aborted) console.error("letmeknow bridge failed", (error as Error).message);
  }

  private apply(entry: Entry): void {
    if ("poll" in entry) this.pollOf.set(entry.poll, entry);
    else if ("topic" in entry) {
      this.topicOf.set(entry.fp, entry.topic);
      this.memberOf.set(entry.topic, entry.fp);
    } else {
      this.lmkOf.set(entry.tg, entry);
      if (!entry.fp) this.tgOf.set(entry.lmk, entry.tg);
    }
  }

  private record(entry: Entry): void {
    appendFileSync(this.statePath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.apply(entry);
  }

  private async call(args: string[], text?: string): Promise<Json> {
    const ready = await this.ready;
    if (!ready) throw new Error("letmeknow listener has not started");
    this.abort.signal.throwIfAborted();
    const call = run(ready.bin, [...this.shared, "--session", this.config.session, ...args, ...(text === undefined ? [] : ["-"])], {
      env: this.env, signal: this.abort.signal,
    });
    call.child.stdin!.on("error", () => {});
    call.child.stdin!.end(text);
    return JSON.parse((await call).stdout);
  }

  private async topic(fp: string): Promise<number> {
    if (!this.topicOf.has(fp)) {
      const { members } = await this.call(["members", "--all"]);
      const others = new Set<string>([...members.map((member: Json) => member.fp), ...this.topicOf.keys()]);
      others.delete(fp);
      let name = fp.slice(0, 4);
      while (name.length < fp.length && [...others].some((other) => other.startsWith(name))) name = fp.slice(0, name.length + 1);
      const created = await this.telegram.send(conversation(this.config.chat), { method: "createForumTopic", name }) as Json;
      this.record({ topic: created.message_thread_id, fp });
    }
    return this.topicOf.get(fp)!;
  }

  private async fromLmk(event: Json, log?: string): Promise<void> {
    const chat = conversation(this.config.chat);
    if (event.type !== "message") {
      for (const text of JSON.stringify(event).match(/[^]{1,4096}/gu) ?? []) await this.telegram.send(chat, { method: "sendMessage", text });
      return;
    }
    const { id, from, attachment } = event;
    try {
      // A fast reply can arrive before the send command has returned its message ID.
      if (event.reply_to && !this.tgOf.has(event.reply_to)) await this.outgoing;
      let content: string = event.content ?? "";
      if (event.truncated && log && existsSync(log)) {
        const whole = readFileSync(log, "utf8").split("\n").slice(0, -1).findLast((line) => {
          if (!line.includes(id)) return false;
          const item = JSON.parse(line);
          return item.type === "message" && item.id === id && (!event.group || item.group === event.group);
        });
        if (whole) content = JSON.parse(whole).content;
      }
      const raw = Boolean(attachment?.name.endsWith(".json"));
      let calls: Json[];
      if (raw) {
        const request = JSON.parse(readFileSync(attachment.path, "utf8"));
        if (typeof request?.method !== "string" || !/^[A-Za-z0-9_]+$/.test(request.method) || POLLING_METHODS.has(request.method)) {
          throw new Error("invalid Bot API call");
        }
        calls = [request];
      } else {
        calls = (content.match(/[^]{1,4096}/gu) ?? []).filter((text) => /\S/.test(text)).map((text) => ({ method: "sendMessage", text }));
        if (attachment) calls.push({ method: "sendDocument", document: attachment.path });
        if (!calls.length) calls.push({ method: "sendMessage", text: content });
      }
      for (const request of calls) {
        const own = !("message_thread_id" in request);
        if (request.message_thread_id === null) delete request.message_thread_id;
        const reply = this.tgOf.get(event.reply_to);
        if (reply !== undefined) request.reply_parameters ??= { message_id: reply, allow_sending_without_reply: true };
        const options = { raw, documentName: !raw && request.method === "sendDocument" ? attachment.name : undefined };
        const target = own ? conversation(this.config.chat, await this.topic(from)) : chat;
        const result: any = await this.telegram.send(target, request, options).catch(async (error: Error) => {
          if (!own || !/message thread not found/.test(error.message)) throw error;
          this.topicOf.delete(from);
          return this.telegram.send(conversation(this.config.chat, await this.topic(from)), request, options);
        });
        for (const item of Array.isArray(result) ? result : [result]) {
          if (item?.message_id && (item.chat?.id ?? this.config.chat) === this.config.chat) {
            this.record({ tg: item.message_id, lmk: id, fp: from });
            if (item.poll?.id) this.record({ poll: item.poll.id, lmk: id, fp: from });
          }
        }
        const text = JSON.stringify({ request: id, result });
        if (request.method === "getFile" && result?.file_path) {
          const temp = await mkdtemp(path.join(tmpdir(), "tg-bot3-lmk-"));
          try {
            const name = path.basename(result.file_path);
            const file = path.join(temp, name && name !== "." && name !== ".." ? name : "file");
            await writeFile(file, await this.telegram.downloadFile(result.file_path, this.abort.signal));
            await this.call(["send", "--attach", file], text);
          } finally {
            await rm(temp, { recursive: true });
          }
        } else await this.call(["send"], text);
      }
    } catch (error) {
      await this.call(["send", "--reply-to", id, "--to", from], String(error));
    }
  }
}
