import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { globalAgent } from "node:https";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Bot, GrammyError, InputFile, type Context } from "grammy";
import type { Message, UserFromGetMe } from "grammy/types";
import { conversation, type Conversation, type Timeline, type TimelineEvent } from "./timeline.ts";

const UPDATES = [
  "message", "edited_message", "channel_post", "edited_channel_post", "callback_query",
  "poll_answer", "message_reaction", "my_chat_member", "chat_join_request",
] as const;
const MESSAGE_UPDATES = new Set(["message", "edited_message", "channel_post", "edited_channel_post"]);
const MEDIA_FIELDS = ["photo", "audio", "video", "animation", "voice", "video_note", "document", "sticker"];
const SERVICE_FIELDS = [
  "forum_topic_created", "forum_topic_closed", "forum_topic_reopened", "forum_topic_edited",
  "general_forum_topic_hidden", "general_forum_topic_unhidden", "new_chat_members", "left_chat_member",
  "new_chat_title", "new_chat_photo", "delete_chat_photo", "group_chat_created", "supergroup_chat_created",
  "channel_chat_created", "message_auto_delete_timer_changed", "migrate_to_chat_id", "migrate_from_chat_id",
  "pinned_message", "video_chat_scheduled", "video_chat_started", "video_chat_ended", "video_chat_participants_invited",
];

export type TelegramOptions = {
  token: string;
  timeline: Timeline;
  allowedPath: string;
  attachmentsDir: string;
  onRestart: () => void;
};

function isDirected(message: Message, me: UserFromGetMe): boolean {
  if (message.reply_to_message?.from?.id === me.id) return true;
  const text = message.text ?? message.caption ?? "";
  return (message.entities ?? message.caption_entities ?? []).some((entity) => entity.type === "text_mention"
    ? entity.user.id === me.id
    : (entity.type === "mention" || entity.type === "bot_command")
      && text.slice(entity.offset, entity.offset + entity.length).toLowerCase().endsWith(`@${me.username.toLowerCase()}`));
}

async function download(bot: Bot, token: string, directory: string, message: Message): Promise<Array<Record<string, string>>> {
  const file = message.document ?? message.photo?.at(-1) ?? message.video ?? message.audio ?? message.voice
    ?? message.animation ?? message.video_note ?? message.sticker;
  if (!file) return [];
  try {
    const info = await bot.api.getFile(file.file_id);
    const name = path.basename(("file_name" in file && file.file_name) || info.file_path!);
    const target = path.join(directory, String(message.chat.id), String(message.message_id), name);
    const response = await fetch(`https://api.telegram.org/file/bot${token}/${info.file_path}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
    return [{ path: target }];
  } catch (error) {
    return [{ failure: String(error) }];
  }
}

function localFile(value: unknown): unknown {
  return typeof value === "string" && value.startsWith("/") ? new InputFile(value) : value;
}

export class Telegram {
  readonly bot: Bot;
  private readonly timeline: Timeline;

  constructor(options: TelegramOptions) {
    const { token, timeline, allowedPath, attachmentsDir, onRestart } = options;
    this.timeline = timeline;
    // grammY's default agent bypasses Node's environment proxy support.
    const bot = new Bot(token, { client: { baseFetchConfig: { agent: globalAgent } } });
    this.bot = bot;
    const reported = new Set<number>();

    bot.use(async (ctx, next) => {
      if (!ctx.chat) return next();
      const allowed: number[] = existsSync(allowedPath) ? JSON.parse(readFileSync(allowedPath, "utf8")) : [];
      if (allowed.includes(ctx.chat.id)) return next();
      if (reported.has(ctx.chat.id)) return;
      reported.add(ctx.chat.id);
      timeline.publish({
        type: "telegram.access_request",
        payload: { update_type: updateType(ctx), chat: ctx.chat, from: ctx.from },
      });
    });

    bot.command("restart", async (ctx) => {
      onRestart();
      await ctx.reply("Restarting agents; each starts a fresh session on its next message.");
    });

    bot.use(async (ctx) => {
      const type = updateType(ctx);
      const payload = (ctx.update as Record<string, any>)[type];
      const target = this.conversationOf(ctx, type, payload);
      if (!target) return;
      const event: TimelineEvent = { type: `telegram.${type}`, conversation: target, payload };
      const message = ctx.msg;
      if (MESSAGE_UPDATES.has(type) && message) {
        event.attachments = await download(bot, token, attachmentsDir, message);
        event.meta = {
          private: message.chat.type === "private",
          directed: isDirected(message, bot.botInfo),
          user_content: !SERVICE_FIELDS.some((field) => field in message),
        };
      }
      if (type === "my_chat_member") {
        const { old_chat_member: before, new_chat_member: after } = payload;
        event.meta = { group_add: ["member", "administrator"].includes(after.status) && ["left", "kicked"].includes(before.status) };
      }
      if (type === "callback_query") void ctx.answerCallbackQuery().catch(() => {});
      timeline.publish(event);
    });

    bot.catch((error) => console.error("Telegram update failed", error));
  }

  async run(): Promise<void> {
    await this.bot.api.setMyCommands([{ command: "restart", description: "Restart all agents" }]);
    await this.bot.start({
      allowed_updates: UPDATES,
      onStart: (me) => console.log(`@${me.username} started`),
    });
  }

  async send(target: Conversation, request: Record<string, any>): Promise<unknown> {
    const { method, ...params } = request;
    params.chat_id = target.chat_id;
    if (target.message_thread_id) params.message_thread_id ??= target.message_thread_id;
    for (const field of MEDIA_FIELDS) if (field in params) params[field] = localFile(params[field]);
    if (Array.isArray(params.media)) params.media = params.media.map((item) => ({ ...item, media: localFile(item.media) }));
    const call = (this.bot.api.raw as Record<string, any>)[method];
    if (!call) throw new Error(`Unknown Telegram Bot API method ${method}`);
    for (;;) {
      try {
        const response = await call(params);
        this.timeline.publish({ type: "telegram.sent", conversation: target, request, response });
        return response;
      } catch (error) {
        const retryAfter = error instanceof GrammyError ? error.parameters.retry_after : undefined;
        if (retryAfter === undefined) throw error;
        await sleep(retryAfter * 1_000);
      }
    }
  }

  private conversationOf(ctx: Context, type: string, payload: any): Conversation | undefined {
    if (type === "poll_answer") {
      return this.timeline.find((record) => (record.payload?.poll?.id ?? record.response?.poll?.id) === payload.poll_id)?.conversation;
    }
    const chatId = ctx.chat!.id;
    if (type === "message_reaction") {
      return this.timeline.find((record) => record.conversation?.chat_id === chatId
        && (record.payload?.message_id ?? record.response?.message_id) === payload.message_id)?.conversation
        ?? conversation(chatId);
    }
    return conversation(chatId, ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined);
  }
}

function updateType(ctx: Context): string {
  return Object.keys(ctx.update).find((key) => key !== "update_id")!;
}
