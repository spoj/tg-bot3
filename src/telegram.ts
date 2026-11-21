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
export const MEDIA_FIELDS = ["photo", "audio", "video", "animation", "voice", "video_note", "document", "sticker", "thumbnail", "cover"];
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
  onNew: (target: Conversation) => Promise<void> | void;
  pollConversation?: (id: string) => Conversation | undefined;
};

function isDirected(message: Message, me: UserFromGetMe): boolean {
  if (message.reply_to_message?.from?.id === me.id && !message.reply_to_message.forum_topic_created) return true;
  const text = message.text ?? message.caption ?? "";
  return (message.entities ?? message.caption_entities ?? []).some((entity) => entity.type === "text_mention"
    ? entity.user.id === me.id
    : (entity.type === "mention" || entity.type === "bot_command")
      && text.slice(entity.offset, entity.offset + entity.length).toLowerCase().endsWith(`@${me.username.toLowerCase()}`));
}

async function download(telegram: Telegram, directory: string, message: Message): Promise<Array<Record<string, string>>> {
  const file = message.document ?? message.photo?.at(-1) ?? message.video ?? message.audio ?? message.voice
    ?? message.animation ?? message.video_note ?? message.sticker;
  if (!file) return [];
  try {
    const info = await telegram.bot.api.getFile(file.file_id);
    if (!info.file_path) throw new Error("Telegram returned no file_path");
    const candidate = "file_name" in file && file.file_name ? path.basename(file.file_name) : "";
    const name = candidate && candidate !== "." && candidate !== ".." ? candidate : path.basename(info.file_path);
    if (!name || name === "." || name === "..") throw new Error("Invalid attachment file name");
    const target = path.join(
      directory,
      String(message.chat.id),
      String(message.message_id),
      ...(file.file_unique_id ? [path.basename(file.file_unique_id)] : []),
      name,
    );
    const bytes = await telegram.downloadFile(info.file_path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
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
  private readonly token: string;

  constructor(options: TelegramOptions) {
    const { token, timeline, allowedPath, attachmentsDir, onNew, pollConversation } = options;
    this.timeline = timeline;
    this.token = token;
    // grammY's default agent bypasses Node's environment proxy support.
    const bot = new Bot(token, { client: { baseFetchConfig: { agent: globalAgent } } });
    this.bot = bot;
    const reported = new Set<number>();
    const allowedIds = (): number[] => existsSync(allowedPath) ? JSON.parse(readFileSync(allowedPath, "utf8")) : [];
    const sender = (ctx: Context) => ctx.from ?? ctx.pollAnswer?.user;
    const allowedSender = (ctx: Context) => allowedIds().some((id) => id === sender(ctx)?.id);

    // A private chat needs an allowed user. A group or channel needs to be allowed and to have an allowed admin;
    // then all of its updates are recorded. Names and titles of others are free text, so access requests omit them.
    bot.use(async (ctx, next) => {
      const ids = allowedIds();
      const chat = ctx.chat;
      const accepted = !chat ? allowedSender(ctx)
        : chat.type === "private" ? ids.includes(chat.id)
        : ids.includes(chat.id) && (await bot.api.getChatAdministrators(chat.id)).some((admin) => ids.includes(admin.user.id));
      if (accepted) return next();
      const user = sender(ctx);
      const requestChat = chat ?? ctx.pollAnswer?.voter_chat;
      const key = requestChat?.id ?? user?.id;
      if (key === undefined || reported.has(key)) return;
      reported.add(key);
      timeline.publish({
        type: "telegram.access_request",
        payload: {
          update_type: updateType(ctx),
          chat: requestChat && { id: requestChat.id, type: requestChat.type },
          from: user && { id: user.id, username: user.username },
        },
      });
    });

    bot.command("new", async (ctx, next) => {
      if (!allowedSender(ctx) || !ctx.chat) return next();
      const target = conversation(ctx.chat.id, ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined);
      await onNew(target);
      await ctx.reply("Session reset for this conversation. The next message will start a fresh Pi session.");
    });

    bot.use(async (ctx) => {
      const type = updateType(ctx);
      const payload = (ctx.update as Record<string, any>)[type];
      if (type === "callback_query") void ctx.answerCallbackQuery().catch(() => {});
      const target = this.conversationOf(ctx, type, payload) ?? (type === "poll_answer" ? pollConversation?.(payload.poll_id) : undefined);
      if (!target) return;
      const meta: Record<string, boolean> = { allowed_sender: allowedSender(ctx) };
      const event: TimelineEvent = { type: `telegram.${type}`, conversation: target, update_id: ctx.update.update_id, payload, meta };
      const message = ctx.msg;
      if (MESSAGE_UPDATES.has(type) && message) {
        event.attachments = await download(this, attachmentsDir, message);
        meta.private = message.chat.type === "private";
        meta.directed = isDirected(message, bot.botInfo);
        meta.user_content = !SERVICE_FIELDS.some((field) => field in message);
      }
      if (type === "my_chat_member") {
        const { old_chat_member: before, new_chat_member: after } = payload;
        meta.group_add = ["member", "administrator"].includes(after.status) && ["left", "kicked"].includes(before.status);
      }
      timeline.publish(event);
    });

    // The BotError holds the context, whose API object prints the token; a network error's cause prints it in the URL.
    bot.catch((error) => console.error("Telegram update failed", (error.error as Error).stack));
  }

  async run(onStart: () => void): Promise<void> {
    await this.bot.api.setMyCommands([{ command: "new", description: "Start a fresh Pi session in this conversation" }]);
    await this.bot.start({
      allowed_updates: UPDATES,
      onStart: (me) => {
        console.log(`@${me.username} started`);
        onStart();
      },
    });
  }

  async downloadFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
    const response = await fetch(`https://api.telegram.org/file/bot${this.token}/${filePath}`, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }

  async send(target: Conversation, request: Record<string, any>, { raw = false }: { raw?: boolean } = {}): Promise<unknown> {
    const { method, ...params } = request;
    params.chat_id = target.chat_id;
    if (target.message_thread_id) params.message_thread_id ??= target.message_thread_id;
    if (!raw) {
      for (const field of MEDIA_FIELDS) if (field in params) params[field] = localFile(params[field]);
      if (params.media && typeof params.media === "object") {
        const convert = (item: Record<string, any>) => {
          const copy: Record<string, any> = { ...item, media: localFile(item.media) };
          for (const field of ["thumbnail", "cover"]) if (field in copy) copy[field] = localFile(copy[field]);
          return copy;
        };
        params.media = Array.isArray(params.media) ? params.media.map(convert) : convert(params.media);
      }
    }
    const call = (this.bot.api.raw as Record<string, any>)[method];
    if (typeof call !== "function") throw new Error(`Unknown Telegram Bot API method ${method}`);
    for (;;) {
      try {
        const response = await call(params);
        this.timeline.publish({
          type: "telegram.sent",
          conversation: conversation(target.chat_id, typeof params.message_thread_id === "number" ? params.message_thread_id : undefined),
          request: sanitizeRequest(request),
          response,
        });
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
    if (!ctx.chat) return undefined;
    const chatId = ctx.chat.id;
    if (type === "message_reaction") {
      return this.timeline.find((record) => record.conversation?.chat_id === chatId
        && (record.payload?.message_id === payload.message_id
          || (Array.isArray(record.response)
            ? record.response.some((item) => item?.message_id === payload.message_id)
            : record.response?.message_id === payload.message_id)))?.conversation
        ?? conversation(chatId);
    }
    return conversation(chatId, ctx.msg?.is_topic_message ? ctx.msg.message_thread_id : undefined);
  }
}

function sanitizeRequest(value: unknown): unknown {
  if (value instanceof InputFile) return { file: value.filename ?? "upload" };
  if (Array.isArray(value)) return value.map(sanitizeRequest);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitizeRequest(v);
    return out;
  }
  return value;
}

function updateType(ctx: Context): string {
  return Object.keys(ctx.update).find((key) => key !== "update_id")!;
}
