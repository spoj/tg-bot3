import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { conversationKey, type Conversation, type Timeline } from "./timeline.ts";

type Recurrence = "hourly" | "daily" | "weekly" | null;
type ScheduleInput = { prompt: string; start: string; recurrence: Recurrence };
export type Schedule = ScheduleInput & { id: string; owner: Conversation; next_due_at: string | null };

const PERIOD_MS = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };

export function nextDue(dueAt: string, recurrence: Exclude<Recurrence, null>, now: number): string {
  const due = Date.parse(dueAt);
  if (due > now) return dueAt;
  const period = PERIOD_MS[recurrence];
  return new Date(due + (Math.floor((now - due) / period) + 1) * period).toISOString();
}

function input({ prompt, start, recurrence }: ScheduleInput): ScheduleInput {
  if (!start.endsWith("Z") || Number.isNaN(Date.parse(start))) throw new Error("start must be a UTC ISO-8601 timestamp ending in Z");
  return { prompt, start, recurrence };
}

export class Scheduler {
  schedules: Schedule[];
  private timer: NodeJS.Timeout | undefined;
  private readonly path: string;
  private readonly timeline: Timeline;

  constructor(path: string, timeline: Timeline) {
    this.path = path;
    this.timeline = timeline;
    this.schedules = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")).schedules : [];
  }

  add(owner: Conversation, params: ScheduleInput): Schedule {
    const fields = input(params);
    const schedule = { id: randomUUID(), ...fields, owner, next_due_at: fields.start };
    this.schedules.push(schedule);
    this.commit(owner, "schedule_added", schedule.id, null, schedule);
    return schedule;
  }

  replace(actor: Conversation, params: ScheduleInput & { id: string }): Schedule {
    const current = this.get(params.id, actor);
    const fields = input(params);
    const nextDueAt = fields.start !== current.start
      ? fields.start
      : current.next_due_at ?? (fields.recurrence && nextDue(fields.start, fields.recurrence, Date.now()));
    const replacement = { id: current.id, ...fields, owner: current.owner, next_due_at: nextDueAt };
    this.schedules[this.schedules.indexOf(current)] = replacement;
    this.commit(actor, "schedule_replaced", current.id, current, replacement);
    return replacement;
  }

  remove(actor: Conversation, { id }: { id: string }): void {
    const current = this.get(id, actor);
    this.schedules = this.schedules.filter((schedule) => schedule !== current);
    this.commit(actor, "schedule_removed", id, current, null);
  }

  take(actor: Conversation, { id }: { id: string }): Schedule {
    const current = this.get(id);
    const taken = { ...current, owner: actor };
    this.schedules[this.schedules.indexOf(current)] = taken;
    this.commit(actor, "schedule_taken", id, current, taken);
    return taken;
  }

  tick(now = Date.now()): void {
    for (const schedule of this.schedules) {
      if (schedule.next_due_at === null || Date.parse(schedule.next_due_at) > now) continue;
      this.timeline.publish({
        type: "schedule_fired",
        conversation: schedule.owner,
        scheduleId: schedule.id,
        prompt: schedule.prompt,
        dueAt: schedule.next_due_at,
      });
      schedule.next_due_at = schedule.recurrence && nextDue(schedule.next_due_at, schedule.recurrence, now);
      this.save();
    }
  }

  start(): void {
    this.tick();
    this.timer = setInterval(() => this.tick(), 30_000);
  }

  stop(): void {
    clearInterval(this.timer);
  }

  private get(id: string, owner?: Conversation): Schedule {
    const schedule = this.schedules.find((candidate) => candidate.id === id);
    if (!schedule) throw new Error(`Schedule ${id} does not exist`);
    if (owner && conversationKey(schedule.owner) !== conversationKey(owner)) {
      throw new Error(`Schedule ${id} is owned by conversation ${conversationKey(schedule.owner)}; use schedule_take first`);
    }
    return schedule;
  }

  private commit(actor: Conversation, type: string, scheduleId: string, before: Schedule | null, after: Schedule | null): void {
    this.save();
    this.timeline.publish({ type, conversation: actor, scheduleId, before, after });
  }

  private save(): void {
    writeFileSync(`${this.path}.tmp`, `${JSON.stringify({ schedules: this.schedules }, null, 2)}\n`);
    renameSync(`${this.path}.tmp`, this.path);
  }
}
