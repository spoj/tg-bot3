import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { conversationKey, type Conversation } from "./timeline.ts";

export type Behavior = "steer" | "followUp";
export type WorkerOptions = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };

const IDLE_MS = 2 * 60 * 60_000;
const KILL_GRACE_MS = 10_000;
const RESTART_SETTLE_MS = 30_000;

/** One `pi --mode rpc` process. */
export class Worker {
  readonly exited: Promise<void>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  private settledWaiters: Array<() => void> = [];
  private busy = false;
  private dead = false;
  private stderr = "";
  private abortTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(options: WorkerOptions) {
    this.child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, detached: true });
    let buffer = "";
    this.child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        this.onLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    });
    this.child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4_000);
    });
    this.child.stdin.on("error", () => {});
    this.child.on("error", (error) => {
      this.stderr += error.message;
    });
    this.exited = new Promise((resolve) => this.child.on("close", (code, signal) => {
      this.dead = true;
      clearTimeout(this.idleTimer);
      const error = new Error(`pi exited (${code ?? signal}): ${this.stderr.trim()}`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      this.settle();
      resolve();
    }));
    this.armIdle();
  }

  async prompt(message: string, behavior: Behavior, abortAfterMs?: number): Promise<void> {
    const wasBusy = this.busy;
    this.busy = true;
    clearTimeout(this.idleTimer);
    try {
      await this.request({ type: "prompt", message, streamingBehavior: behavior });
    } catch (error) {
      if (!wasBusy) {
        this.settle();
        this.armIdle();
      }
      throw error;
    }
    // A queued user message aborts a long-running turn so the agent picks it up promptly.
    if (wasBusy && abortAfterMs !== undefined) {
      this.abortTimer ??= setTimeout(() => {
        this.abortTimer = undefined;
        this.request({ type: "abort" }).catch(() => {});
      }, abortAfterMs);
    }
  }

  waitSettled(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.settledWaiters.push(resolve)) : Promise.resolve();
  }

  close(): Promise<void> {
    this.child.stdin.end();
    const timer = setTimeout(() => {
      try {
        process.kill(-this.child.pid!, "SIGKILL");
      } catch {}
    }, KILL_GRACE_MS);
    return this.exited.finally(() => clearTimeout(timer));
  }

  private request(command: Record<string, unknown>): Promise<void> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    });
  }

  private onLine(line: string): void {
    let event: Record<string, any>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.type === "response") {
      const pending = this.pending.get(event.id);
      this.pending.delete(event.id);
      if (event.success) pending?.resolve();
      else pending?.reject(new Error(event.error ?? "pi RPC request failed"));
    } else if (event.type === "extension_ui_request") {
      // Nobody can answer dialogs; decline them instead of blocking the agent.
      if (event.method === "confirm") this.write({ type: "extension_ui_response", id: event.id, confirmed: false });
      if (["select", "input", "editor"].includes(event.method)) this.write({ type: "extension_ui_response", id: event.id, cancelled: true });
    } else if (event.type === "queue_update" && event.steering?.length === 0) {
      clearTimeout(this.abortTimer);
      this.abortTimer = undefined;
    } else if (event.type === "agent_settled") {
      this.settle();
      this.armIdle();
    }
  }

  private write(record: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private settle(): void {
    this.busy = false;
    clearTimeout(this.abortTimer);
    this.abortTimer = undefined;
    for (const resolve of this.settledWaiters) resolve();
    this.settledWaiters = [];
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.dead) return;
    this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
  }
}

/** One worker per conversation, started on demand. */
export class Agents {
  private readonly workers = new Map<string, Worker>();
  private readonly options: (conversation: Conversation) => WorkerOptions;

  constructor(options: (conversation: Conversation) => WorkerOptions) {
    this.options = options;
  }

  deliver(conversation: Conversation, message: string, behavior: Behavior, abortAfterMs?: number): Promise<void> {
    const key = conversationKey(conversation);
    let worker = this.workers.get(key);
    if (!worker) {
      const started = new Worker(this.options(conversation));
      void started.exited.then(() => {
        if (this.workers.get(key) === started) this.workers.delete(key);
      });
      this.workers.set(key, started);
      worker = started;
    }
    return worker.prompt(message, behavior, abortAfterMs);
  }

  /** Detaches every worker now and closes each once its current work settles. */
  restart(): void {
    for (const worker of this.workers.values()) {
      void Promise.race([worker.waitSettled(), sleep(RESTART_SETTLE_MS)]).then(() => worker.close());
    }
    this.workers.clear();
  }

  async closeAll(): Promise<void> {
    const workers = [...this.workers.values()];
    this.workers.clear();
    await Promise.all(workers.map((worker) => worker.close()));
  }
}
