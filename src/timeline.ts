import { appendFileSync, existsSync, readFileSync } from "node:fs";

export type Conversation = { chat_id: number; message_thread_id?: number };
export type TimelineEvent = { type: string; conversation?: Conversation } & Record<string, any>;
export type TimelineRecord = TimelineEvent & { seq: number; t: string };

export function conversation(chatId: number, threadId?: number): Conversation {
  return threadId ? { chat_id: chatId, message_thread_id: threadId } : { chat_id: chatId };
}

export function conversationKey(c: Conversation): string {
  return `${c.chat_id}:${c.message_thread_id ?? 0}`;
}

export class Timeline {
  seq: number;
  private listeners: Array<(record: TimelineRecord) => void> = [];
  readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.seq = this.read().at(-1)?.seq ?? 0;
  }

  read(): TimelineRecord[] {
    if (!existsSync(this.path)) return [];
    return readFileSync(this.path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  find(predicate: (record: TimelineRecord) => boolean): TimelineRecord | undefined {
    return this.read().findLast(predicate);
  }

  publish(event: TimelineEvent): TimelineRecord {
    const record = { seq: this.seq + 1, t: new Date().toISOString(), ...event };
    appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    this.seq = record.seq;
    for (const listener of this.listeners) listener(record);
    return record;
  }

  subscribe(listener: (record: TimelineRecord) => void): void {
    this.listeners.push(listener);
  }
}
