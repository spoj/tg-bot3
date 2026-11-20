import type { Agents } from "./agents.ts";
import type { Lmk } from "./lmk.ts";
import type { TimelineRecord } from "./timeline.ts";

const USER_STEER_ABORT_MS = 2 * 60_000;

export function wakes(record: TimelineRecord): boolean {
  const meta = record.meta ?? {};
  if (!meta.allowed_sender) return false;
  switch (record.type) {
    case "telegram.message": return meta.user_content && (meta.private || meta.directed);
    case "telegram.callback_query": return true;
    case "telegram.my_chat_member": return meta.group_add;
    default: return false;
  }
}

export function route(agents: Agents, record: TimelineRecord, lmk?: Lmk): void {
  if (lmk?.claim(record)) return;
  const target = record.conversation;
  if (!target) return;
  const message = JSON.stringify(record);
  if (record.type === "schedule_fired") agents.deliver(target, message, "followUp");
  else if (record.type === "steer" || record.type === "agent_interrupted") agents.deliver(target, message, "steer");
  else if (wakes(record)) agents.deliver(target, message, "steer", USER_STEER_ABORT_MS);
}
