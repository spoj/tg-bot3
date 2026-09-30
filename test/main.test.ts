import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

const main = path.resolve(import.meta.dirname, "../src/main.ts");

test("bot state and instruction files are independent of the agent working directory", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-main-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const botHome = path.join(dir, "channel");
  const stateDir = path.join(botHome, "bot");
  mkdirSync(stateDir, { recursive: true });
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
  writeFileSync(path.join(botHome, "AGENTS.md"), "Shared instructions");
  writeFileSync(path.join(stateDir, "AGENTS.md"), "Telegram instructions");
  for (const cwd of ["~", "./work"]) {
    writeFileSync(path.join(stateDir, "config.json"), JSON.stringify({
      token: "unused", cwd, instructions: ["AGENTS.md", "bot/AGENTS.md"], agentDir: "./profile", pi: "custom-pi",
    }));
    const child = spawnSync(process.execPath, ["--import", preload, main, botHome], { cwd: dir, encoding: "utf8", timeout: 5_000 });
    assert.equal(child.status, 0, child.stderr);
    const options = JSON.parse(child.stdout);
    assert.equal(options.cwd, cwd === "~" ? homedir() : path.join(botHome, "work"));
    assert.equal(options.command, "custom-pi");
    assert.equal(options.socket, path.join(stateDir, "host.sock"));
    assert.equal(options.conversation, JSON.stringify({ chat_id: 1, message_thread_id: 7 }));
    assert.equal(options.agentDir, path.join(botHome, "profile"));
    assert.equal(options.args[options.args.indexOf("--session-dir") + 1], path.join(stateDir, "sessions"));
    const prompts = options.args.flatMap((arg: string, i: number) => arg === "--append-system-prompt" ? [options.args[i + 1]] : []);
    assert.match(prompts[0], new RegExp(`Bot state lives in ${stateDir}:`));
    assert.deepEqual(prompts.slice(1), [path.join(botHome, "AGENTS.md"), path.join(stateDir, "AGENTS.md")]);
    assert.equal(existsSync(path.join(stateDir, "attachments")), true);
    assert.equal(existsSync(path.join(dir, "bot")), false);
  }
});
