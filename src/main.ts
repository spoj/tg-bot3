import { mkdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { Agents } from "./agents.ts";
import { Router } from "./router.ts";
import { Scheduler } from "./scheduler.ts";
import { Telegram } from "./telegram.ts";
import { conversationKey, Timeline, type Conversation } from "./timeline.ts";

type Config = { token: string; cwd?: string; agentDir?: string; pi?: string };

const expand = (value: string) => path.resolve(value.replace(/^~(?=\/|$)/, homedir()));
if (!process.argv[2]) throw new Error("usage: node src/main.ts <state dir>");
const stateDir = expand(process.argv[2]);
const config: Config = JSON.parse(readFileSync(path.join(stateDir, "config.json"), "utf8"));
const cwd = expand(config.cwd ?? "~");
const state = (name: string) => path.join(stateDir, name);
const hostTools = path.join(import.meta.dirname, "..", "extensions", "host-tools.ts");
mkdirSync(state("attachments"), { recursive: true });

function runtimePrompt(target: Conversation): string {
  return `## Telegram bot runtime

You are the agent for one Telegram conversation: chat_id ${target.chat_id}${target.message_thread_id ? `, message_thread_id ${target.message_thread_id}` : ""} (key "${conversationKey(target)}"). Other conversations of this bot have their own agents in the same environment.

Your plain assistant text is not shown to anyone. Talk to the chat with the send tool, a raw Telegram Bot API call whose chat_id and message_thread_id are filled in. Format text with parse_mode "HTML" (escape &, <, > in plain text; newlines, not <br>). Media fields accept absolute local file paths.

Bot state lives in ${stateDir}:
- timeline.jsonl: shared history of all conversations, one JSON record per line with a monotonic seq. Records Telegram updates (telegram.<update_type>, with native payloads), your sends (telegram.sent), schedule changes, steering, annotations, and access requests from chats not yet allowed.
- attachments/: downloaded incoming files; timeline records reference them by path. After interpreting one, call annotate so others can find it by description.
- allowed.json: array of chat IDs allowed to use the bot. Edit it when the owner approves an access request.
- notifications.json: optional per-conversation overrides of which record types wake an agent, e.g. {"${conversationKey(target)}": {"wake": ["telegram.message_reaction"], "mute": []}}. By default private messages, group messages that mention or reply to the bot, channel posts, button presses, and group additions wake an agent.
- schedules.json: current schedules. Change them only through the schedule tools.

You are woken with timeline records as JSON. A record you already handled may be redelivered after a host restart. Scheduled prompts arrive as schedule_fired records; work handed over by another conversation arrives as steer records. Use steer_conversation to hand work to another conversation instead of sending into its chat.

Agents stop after two idle hours or when the user sends /restart (needed after changing Pi settings or extensions); the next message starts a fresh session, so keep anything durable in files or rely on the timeline.
`;
}

const timeline = new Timeline(state("timeline.jsonl"));
const scheduler = new Scheduler(state("schedules.json"), timeline);
const agents = new Agents((target) => ({
  command: config.pi ?? "pi",
  args: ["--mode", "rpc", "--name", `telegram ${conversationKey(target)}`, "--append-system-prompt", runtimePrompt(target), "-e", hostTools],
  cwd,
  env: {
    ...process.env,
    ...(config.agentDir && { PI_CODING_AGENT_DIR: expand(config.agentDir) }),
    TG_BOT_SOCKET: state("host.sock"),
    TG_BOT_CONVERSATION: JSON.stringify(target),
  },
}));
const telegram = new Telegram({
  token: config.token,
  timeline,
  allowedPath: state("allowed.json"),
  attachmentsDir: state("attachments"),
  onRestart: () => agents.restart(),
});
const router = new Router({
  cursorPath: state("cursor"),
  notificationsPath: state("notifications.json"),
  initialCursor: timeline.seq,
  agents,
  onError: (target, error) => {
    console.error(`Delivery to ${conversationKey(target)} failed`, error);
    void telegram.bot.api.sendMessage(target.chat_id, `Agent failed: ${String(error).slice(0, 3_000)}`, {
      ...(target.message_thread_id && { message_thread_id: target.message_thread_id }),
    }).catch(() => {});
  },
});

const tools: Record<string, (caller: Conversation, params: any) => unknown> = {
  send: (caller, params) => telegram.send(caller, params),
  annotate: (caller, { path, description }) => timeline.publish({ type: "attachment_annotated", conversation: caller, path, description }),
  steer_conversation: (caller, { conversation, message }) => timeline.publish({ type: "steer", conversation, from: caller, message }),
  schedule_add: (caller, params) => scheduler.add(caller, params),
  schedule_replace: (caller, params) => scheduler.replace(caller, params),
  schedule_remove: (caller, params) => scheduler.remove(caller, params),
  schedule_take: (caller, params) => scheduler.take(caller, params),
};

// Host tools: the extension sends one JSON line {caller, tool, params} and reads one JSON reply.
const server = net.createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8").on("data", async (chunk: string) => {
    buffer += chunk;
    if (!buffer.includes("\n")) return;
    try {
      const { caller, tool, params } = JSON.parse(buffer);
      socket.end(JSON.stringify({ ok: true, result: (await tools[tool]!(caller, params)) ?? null }));
    } catch (error) {
      socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });
});
rmSync(state("host.sock"), { force: true });
server.listen(state("host.sock"));

timeline.subscribe((record) => router.handle(record));
for (const record of timeline.read()) router.handle(record);
scheduler.start();

async function shutdown(): Promise<void> {
  scheduler.stop();
  server.close();
  await telegram.bot.stop();
  await agents.closeAll();
  process.exit(0);
}
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

await telegram.run();
