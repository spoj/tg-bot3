import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { conversationKey, type Conversation } from "./timeline.ts";

export type Behavior = "steer" | "followUp";
export type WorkerOptions = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv };
export type WorkerEvents = {
  onBusy: () => void;
  /** The worker went idle; aborted when its work was cut short. */
  onSettled: (aborted: boolean) => void;
  /** A failure the conversation should hear about. */
  onError: (error: Error) => void;
};

const IDLE_MS = 60 * 60_000;
const KILL_GRACE_MS = 10_000;
const RESTART_GRACE_MS = 5_000;

type Pending = { resolve: (data: any) => void; reject: (error: Error) => void; onResponse?: (event: any) => void };

/** One `pi --mode rpc` process. */
export class Worker {
  readonly exited: Promise<void>;
  closing = false;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly events: WorkerEvents;
  private readonly pending = new Map<string, Pending>();
  private settledWaiters: Array<() => void> = [];
  private running = false;
  private prompting = 0;
  private runError: string | undefined;
  private dead = false;
  private stderr = "";
  private abortTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;

  constructor(options: WorkerOptions, events: WorkerEvents) {
    this.events = events;
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
      if (this.busy) {
        if (!this.closing) this.events.onError(error);
        this.running = false;
        this.prompting = 0;
        this.settle(this.closing);
      }
      resolve();
    }));
    this.armIdle();
  }

  get busy(): boolean {
    return this.running || this.prompting > 0;
  }

  /** Resolves once pi has answered the prompt; failures go to onError. */
  async prompt(message: string, behavior: Behavior, abortAfterMs?: number): Promise<void> {
    if (!this.busy) {
      clearTimeout(this.idleTimer);
      this.events.onBusy();
    }
    this.prompting++;
    try {
      // Runs as the response is read, before any later event, such as agent_settled, is handled.
      await this.request({ type: "prompt", message, streamingBehavior: behavior }, ({ data }) => {
        this.prompting--;
        if (data?.disposition === "started") this.running = true;
        // A queued user message interrupts a long-running turn so the agent picks it up promptly.
        if (data?.disposition === "queued" && abortAfterMs !== undefined) {
          this.abortTimer ??= setTimeout(() => {
            this.abortTimer = undefined;
            this.interrupt().catch((error) => console.error("Interrupting pi failed", error));
          }, abortAfterMs);
        }
        if (!this.busy) this.settle(false);
      });
    } catch (error) {
      if (!this.dead) this.events.onError(error as Error);
    }
  }

  /**
   * Aborts the run and prompts with its queued steers. They leave the queue first: an aborted run would take
   * them into the session and end without answering them.
   */
  private async interrupt(): Promise<void> {
    const { steering, followUp } = await this.request({ type: "clear_queue" });
    // Pi may have taken the steers just before the deadline.
    if (steering.length > 0) {
      await this.request({ type: "abort" });
      await this.prompt(steering.join("\n\n"), "steer");
    }
    for (const message of followUp) await this.prompt(message, "followUp");
  }

  waitSettled(): Promise<void> {
    return this.busy ? new Promise((resolve) => this.settledWaiters.push(resolve)) : Promise.resolve();
  }

  close(killAfterMs = KILL_GRACE_MS): Promise<void> {
    this.closing = true;
    this.child.stdin.end();
    const timer = setTimeout(() => {
      try {
        process.kill(-this.child.pid!, "SIGKILL");
      } catch {}
    }, killAfterMs);
    return this.exited.finally(() => clearTimeout(timer));
  }

  private request(command: Record<string, unknown>, onResponse?: (event: any) => void): Promise<any> {
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, onResponse });
      this.write({ ...command, id });
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
      pending?.onResponse?.(event);
      if (event.success) pending?.resolve(event.data);
      else pending?.reject(new Error(event.error ?? "pi RPC request failed"));
    } else if (event.type === "extension_ui_request") {
      // Nobody can answer dialogs; decline them instead of blocking the agent.
      if (event.method === "confirm") this.write({ type: "extension_ui_response", id: event.id, confirmed: false });
      if (["select", "input", "editor"].includes(event.method)) this.write({ type: "extension_ui_response", id: event.id, cancelled: true });
    } else if (event.type === "queue_update" && event.steering?.length === 0) {
      clearTimeout(this.abortTimer);
      this.abortTimer = undefined;
    } else if (event.type === "agent_end" && !event.willRetry && event.messages.at(-1)?.stopReason === "error") {
      this.runError = event.messages.at(-1).errorMessage;
    } else if (event.type === "agent_settled") {
      // An abort can also end a run in an error; only failures nobody asked for are reported.
      if (this.runError !== undefined && !event.aborted) this.events.onError(new Error(this.runError));
      this.runError = undefined;
      this.running = false;
      if (!this.busy) this.settle(event.aborted);
    }
  }

  private write(record: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private settle(aborted: boolean): void {
    clearTimeout(this.abortTimer);
    this.abortTimer = undefined;
    for (const resolve of this.settledWaiters) resolve();
    this.settledWaiters = [];
    this.armIdle();
    this.events.onSettled(aborted);
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.dead) return;
    this.idleTimer = setTimeout(() => void this.close(), IDLE_MS);
  }
}

export type AgentsOptions = {
  /** Sessions of busy agents, kept so a new host can wake their conversations. */
  busyPath: string;
  worker: (conversation: Conversation, session: string) => WorkerOptions;
  /** A conversation's agent stopped mid-run; wake a fresh one. */
  onInterrupted: (conversation: Conversation, session: string) => void;
  onError: (conversation: Conversation, error: Error) => void;
};

type Agent = { worker: Worker; session: string; conversation: Conversation };

/** One worker per conversation, started on demand. */
export class Agents {
  private readonly agents = new Map<string, Agent>();
  private readonly busy: Record<string, Conversation>;
  private readonly options: AgentsOptions;

  constructor(options: AgentsOptions) {
    this.options = options;
    this.busy = existsSync(options.busyPath) ? JSON.parse(readFileSync(options.busyPath, "utf8")) : {};
  }

  /** Wakes the conversations whose agents were busy when the previous host stopped. */
  recover(): void {
    for (const [session, conversation] of Object.entries(this.busy)) this.interrupted(session, conversation);
  }

  deliver(conversation: Conversation, message: string, behavior: Behavior, abortAfterMs?: number): void {
    const key = conversationKey(conversation);
    let agent = this.agents.get(key);
    if (!agent || agent.worker.closing) {
      const session = randomUUID();
      const worker = new Worker(this.options.worker(conversation, session), {
        onBusy: () => {
          this.busy[session] = conversation;
          this.save();
        },
        onSettled: (aborted) => {
          if (aborted) return;
          delete this.busy[session];
          this.save();
        },
        onError: (error) => this.options.onError(conversation, error),
      });
      void worker.exited.then(() => {
        if (this.agents.get(key)?.worker === worker) this.agents.delete(key);
      });
      agent = { worker, session, conversation };
      this.agents.set(key, agent);
    }
    void agent.worker.prompt(message, behavior, abortAfterMs);
  }

  /** Detaches every agent now; one still busy after the grace is killed and its conversation woken fresh. */
  restart(graceMs = RESTART_GRACE_MS): void {
    for (const { worker, session, conversation } of this.agents.values()) {
      void Promise.race([worker.waitSettled(), sleep(graceMs)]).then(async () => {
        const interrupted = worker.busy;
        await worker.close(0);
        if (interrupted) this.interrupted(session, conversation);
      });
    }
    this.agents.clear();
  }

  /** Stops every agent; busy ones stay recorded for the next host. */
  async closeAll(): Promise<void> {
    const agents = [...this.agents.values()];
    this.agents.clear();
    await Promise.all(agents.map(({ worker }) => worker.close()));
  }

  private interrupted(session: string, conversation: Conversation): void {
    delete this.busy[session];
    this.save();
    this.options.onInterrupted(conversation, session);
  }

  private save(): void {
    writeFileSync(`${this.options.busyPath}.tmp`, JSON.stringify(this.busy));
    renameSync(`${this.options.busyPath}.tmp`, this.options.busyPath);
  }
}
