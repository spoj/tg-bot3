import net from "node:net";
import { Type, type TSchema } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

async function callHost(tool: string, params: unknown): Promise<unknown> {
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(process.env.TG_BOT_SOCKET!);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ caller: JSON.parse(process.env.TG_BOT_CONVERSATION!), tool, params })}\n`));
    socket.on("data", (chunk: string) => { buffer += chunk; });
    socket.on("end", () => resolve(buffer));
    socket.on("error", reject);
  });
  const response = JSON.parse(reply);
  if (!response.ok) throw new Error(response.error);
  return response.result;
}

const id = Type.String({ description: "Schedule ID from schedules.json" });
const schedule = {
  prompt: Type.String({ description: "Complete instruction delivered to the owning conversation when due" }),
  start: Type.String({ description: "First run as a UTC ISO-8601 timestamp ending in Z" }),
  recurrence: Type.Union([Type.Literal("hourly"), Type.Literal("daily"), Type.Literal("weekly"), Type.Null()]),
};

const tools: Array<[name: string, description: string, parameters: TSchema]> = [
  [
    "send",
    "Call a Telegram Bot API method in this conversation: {method, ...params}. chat_id and message_thread_id are filled in. Media fields (photo, document, media items, ...) accept absolute local file paths. Returns Telegram's result.",
    Type.Object({ method: Type.String({ description: "Bot API method, e.g. sendMessage" }) }, { additionalProperties: true }),
  ],
  [
    "annotate",
    "Record a short factual description of an attachment in the timeline.",
    Type.Object({ path: Type.String({ description: "Attachment path from the timeline" }), description: Type.String() }),
  ],
  [
    "steer_conversation",
    "Wake another conversation's agent with an instruction. Does not send a Telegram message.",
    Type.Object({
      conversation: Type.Object({ chat_id: Type.Number(), message_thread_id: Type.Optional(Type.Number()) }),
      message: Type.String(),
    }),
  ],
  ["schedule_add", "Create a schedule owned by this conversation.", Type.Object(schedule)],
  ["schedule_replace", "Fully replace a schedule this conversation owns. Changing start resets its next due time.", Type.Object({ id, ...schedule })],
  ["schedule_remove", "Delete a schedule this conversation owns.", Type.Object({ id })],
  ["schedule_take", "Make this conversation the owner of an existing schedule without changing its timing.", Type.Object({ id })],
];

export default function hostTools(pi: ExtensionAPI): void {
  for (const [name, description, parameters] of tools) {
    pi.registerTool({
      name,
      label: name,
      description,
      parameters,
      async execute(_toolCallId, params) {
        const result = await callHost(name, params);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: {} };
      },
    });
  }
}
