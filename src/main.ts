import { chmodSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Bridge, type EndpointConfig, type OwnerConfig } from "./bridge.ts";
import { Hc } from "./hc.ts";
import { Telegram } from "./telegram.ts";
import { Timeline, type Conversation } from "./timeline.ts";

type Config = {
  token: string;
  cwd: string;
  agentDir?: string;
  pi?: string;
  hc?: string;
  idleMs?: number;
  lmk: {
    letmeknow: string;
    owner: OwnerConfig;
    local?: EndpointConfig;
  };
};

const expand = (value: string) => path.resolve(value.replace(/^~(?=\/|$)/, homedir()));
if (!process.argv[2]) throw new Error("usage: node src/main.ts <state directory>");
const stateDir = expand(process.argv[2]);
const state = (name: string) => path.join(stateDir, name);
const rawConfig = readFileSync(state("config.json"), "utf8");
let config: Config;
try {
  config = JSON.parse(rawConfig);
} catch {
  console.error(`Invalid JSON in ${state("config.json")}`);
  process.exit(1);
}
if (!config.lmk?.owner?.session || !config.lmk?.owner?.group) {
  console.error(`config.json must configure lmk.owner.{session, group, chat, user}`);
  process.exit(1);
}
const cwd = expand(config.cwd);
mkdirSync(state("attachments"), { recursive: true });

await new Promise<void>((resolve, reject) => {
  const probe = net.connect(state("host.sock"));
  probe.on("connect", () => {
    probe.destroy();
    reject(new Error(`Another bot is already using ${stateDir}`));
  });
  probe.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ECONNREFUSED") resolve();
    else reject(error);
  });
});

const timeline = new Timeline(state("timeline.jsonl"));
const hc = new Hc(config.hc ?? "hc");
let bridge!: Bridge;
const telegram = new Telegram({
  token: config.token,
  timeline,
  allowedPath: state("allowed.json"),
  attachmentsDir: state("attachments"),
  onNew: (target) => bridge.resetConversation(target),
  pollConversation: (id) => bridge.pollConversation(id),
});
bridge = new Bridge(
  {
    letmeknow: config.lmk.letmeknow,
    owner: config.lmk.owner,
    local: config.lmk.local,
    cwd,
    pi: config.pi ?? "pi",
    agentDir: config.agentDir ? expand(config.agentDir) : undefined,
    botLabel: (path.basename(stateDir) === "bot" ? path.basename(path.dirname(stateDir)) : path.basename(stateDir)) || "default",
    idleMs: config.idleMs,
  },
  stateDir,
  telegram,
  hc,
);

const hostOps: Record<string, (caller: Conversation, params: any) => unknown> = {
  send: (caller, params) => telegram.send(caller, params),
  wake: (caller, { message }) => {
    if (typeof message !== "string" || !message.trim()) throw new Error("wake requires a non-empty message");
    const record = timeline.publish({ type: "wake", conversation: caller, message });
    bridge.wake(record);
    return record;
  },
};

// Minimal private Unix socket for local scheduled jobs (send + wake).
const server = net.createServer((socket) => {
  let buffer = "";
  socket.on("error", (error) => console.error("Host socket connection failed", error));
  socket.setEncoding("utf8").on("data", async (chunk: string) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline === -1) return;
    socket.removeAllListeners("data");
    try {
      const { caller, tool, params } = JSON.parse(buffer.slice(0, newline));
      if (!Object.hasOwn(hostOps, tool)) throw new Error(`Unknown host op ${tool}`);
      socket.end(JSON.stringify({ ok: true, result: (await hostOps[tool]!(caller, params)) ?? null }));
    } catch (error) {
      socket.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    }
  });
});
rmSync(state("host.sock"), { force: true });
server.listen(state("host.sock"), () => chmodSync(state("host.sock"), 0o600));

timeline.subscribe((record) => bridge.handleRecord(record));

// grammY errors print the token in request URLs and API objects, so only their stacks are logged.
let shuttingDown: Promise<void> | undefined;
function shutdown(code = 0): Promise<void> {
  return shuttingDown ??= (async () => {
    await Promise.race([
      Promise.all([
        bridge.stop().catch((error: Error) => console.error("Stopping letmeknow bridge failed", error.stack)),
        telegram.bot.stop().catch((error: Error) => console.error("Stopping Telegram polling failed", error.stack)),
        running.catch(() => {}),
      ]),
      sleep(3_000),
    ]);
    server.close();
    rmSync(state("host.sock"), { force: true });
    process.exit(code);
  })();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

const running = telegram.run(() => {
  if (shuttingDown) return;
  bridge.start();
});
await running.catch((error: Error) => {
  console.error("Telegram polling failed", error.stack);
  return shutdown(1);
});
