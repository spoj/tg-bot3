import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const main = path.resolve(import.meta.dirname, "../src/main.ts");

test("agents run in the configured cwd and get the state directory's AGENTS.md when present", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  mkdirSync(stateDir);
  const preload = path.join(dir, "preload.mjs");
  writeFileSync(preload, `
    import { registerHooks } from "node:module";
    registerHooks({
      load(url, context, nextLoad) {
        if (url.endsWith("/src/agents.ts")) return {
          format: "module", shortCircuit: true,
          source: \`export class Agents {
            constructor(options) {
              const { command, args, cwd, env } = options({ chat_id: 1, message_thread_id: 7 });
              console.log(JSON.stringify({ command, args, cwd, socket: env.TG_BOT_SOCKET,
                conversation: env.TG_BOT_CONVERSATION, agentDir: env.PI_CODING_AGENT_DIR }));
            }
          }\`,
        };
        if (url.endsWith("/src/telegram.ts")) return {
          format: "module", shortCircuit: true,
          source: "export class Telegram { run() { process.exit(0); } }",
        };
        return nextLoad(url, context);
      },
    });
  `);
  const start = (config: object) => {
    writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({ token: "unused", ...config }));
    const child = spawnSync(process.execPath, ["--import", preload, main, stateDir], { cwd: dir, encoding: "utf8", timeout: 5_000 });
    assert.equal(child.status, 0, child.stderr);
    const options = JSON.parse(child.stdout);
    const prompts = options.args.flatMap((arg: string, i: number) => arg === "--append-system-prompt" ? [options.args[i + 1]] : []);
    return { ...options, prompts };
  };

  const plain = start({ cwd: "~" });
  assert.equal(plain.cwd, homedir());
  assert.equal(plain.command, "pi");
  assert.equal(plain.agentDir, undefined);
  assert.equal(plain.socket, path.join(stateDir, "host.sock"));
  assert.equal(plain.conversation, JSON.stringify({ chat_id: 1, message_thread_id: 7 }));
  assert.equal(plain.args[plain.args.indexOf("--session-dir") + 1], path.join(stateDir, "sessions"));
  assert.equal(plain.prompts.length, 1);
  assert.match(plain.prompts[0], new RegExp(`Bot state lives in ${stateDir}:`));
  assert.equal(existsSync(path.join(stateDir, "attachments")), true);

  writeFileSync(path.join(stateDir, "AGENTS.md"), "Bot instructions");
  const work = path.join(dir, "work");
  const custom = start({ cwd: work, agentDir: "~/profile", pi: "custom-pi" });
  assert.equal(custom.cwd, work);
  assert.equal(custom.command, "custom-pi");
  assert.equal(custom.agentDir, path.join(homedir(), "profile"));
  assert.deepEqual(custom.prompts.slice(1), [path.join(stateDir, "AGENTS.md")]);
});
