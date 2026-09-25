import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { Agents } from "./agents.ts";
import { conversationKey, type Conversation, type TimelineRecord } from "./timeline.ts";

const USER_STEER_ABORT_MS = 2 * 60_000;

type Overrides = { wake?: string[]; mute?: string[] };

export function wakes(record: TimelineRecord, overrides: Overrides = {}): boolean {
  if (overrides.mute?.includes(record.type)) return false;
  if (overrides.wake?.includes(record.type)) return true;
  const meta = record.meta ?? {};
  switch (record.type) {
    case "telegram.message": return meta.user_content && (meta.private || meta.directed);
    case "telegram.channel_post": return meta.user_content;
    case "telegram.callback_query": return true;
    case "telegram.my_chat_member": return meta.group_add;
    default: return false;
  }
}

/** Delivers timeline records to conversation agents and persists a replay cursor. */
export class Router {
  cursor: number;
  private seen: number;
  private readonly inflight = new Set<number>();
  private readonly cursorPath: string;
  private readonly notificationsPath: string;
  private readonly agents: Agents;
  private readonly onError: (conversation: Conversation, error: unknown) => void;

  constructor(options: {
    cursorPath: string;
    notificationsPath: string;
    initialCursor: number;
    agents: Agents;
    onError: (conversation: Conversation, error: unknown) => void;
  }) {
    this.cursorPath = options.cursorPath;
    this.notificationsPath = options.notificationsPath;
    this.agents = options.agents;
    this.onError = options.onError;
    this.cursor = existsSync(this.cursorPath) ? Number(readFileSync(this.cursorPath, "utf8")) : options.initialCursor;
    this.seen = this.cursor;
  }

  handle(record: TimelineRecord): void {
    if (record.seq <= this.cursor) return;
    this.seen = Math.max(this.seen, record.seq);
    const delivery = this.deliver(record);
    if (!delivery) return this.advance();
    this.inflight.add(record.seq);
    delivery
      .catch((error) => this.onError(record.conversation!, error))
      .finally(() => {
        this.inflight.delete(record.seq);
        this.advance();
      });
  }

  private deliver(record: TimelineRecord): Promise<void> | undefined {
    const target = record.conversation;
    if (!target) return undefined;
    const message = JSON.stringify(record);
    if (record.type === "schedule_fired") return this.agents.deliver(target, message, "followUp");
    if (record.type === "steer") return this.agents.deliver(target, message, "steer");
    const overrides = existsSync(this.notificationsPath)
      ? JSON.parse(readFileSync(this.notificationsPath, "utf8"))[conversationKey(target)]
      : undefined;
    if (wakes(record, overrides)) return this.agents.deliver(target, message, "steer", USER_STEER_ABORT_MS);
    return undefined;
  }

  private advance(): void {
    const cursor = this.inflight.size > 0 ? Math.min(...this.inflight) - 1 : this.seen;
    if (cursor <= this.cursor) return;
    this.cursor = cursor;
    writeFileSync(this.cursorPath, String(cursor));
  }
}
