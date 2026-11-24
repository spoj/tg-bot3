import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  discoverResumeId,
  formatLaunchMarker,
  HarnessRegistry,
  sanitizeConvFilename,
  tomlString,
} from "../src/harnesses.ts";
import { Hc } from "../src/hc.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test("tomlString escapes quotes, backslashes, newlines, and DEL as a valid TOML basic string", () => {
  assert.equal(tomlString('hello "world"\nline2\\path\t\u007f'), '"hello \\"world\\"\\nline2\\\\path\\t\\u007f"');
});

test("sanitizeConvFilename maps chat:thread keys to collision-free safe filenames", () => {
  assert.equal(sanitizeConvFilename("829096380:15996"), "829096380_15996");
  assert.equal(sanitizeConvFilename("-10012345:0"), "g10012345_0");
});

test("built-in presets build correct fresh and resume launch plans for agy, pi, claude, and codex", () => {
  const registry = new HarnessRegistry();
  assert.deepEqual(registry.names(), ["agy", "pi", "codex", "claude"]);

  const baseCtx = {
    convKey: "10:77",
    promptText: '## Telegram conversation (10:77)\nUse "lmk" carefully.',
    promptFile: "/tmp/state/prompts/10_77.md",
    agentsMdPath: "/tmp/state/AGENTS.md",
    bridgeSession: "owner_fp",
    launchId: "launch-abc",
  };

  // 1. agy fresh & resume
  const agyFresh = registry.buildLaunch("agy", baseCtx);
  assert.equal(agyFresh.env?.AGY_PROMPT_FILE, "/tmp/state/prompts/10_77.md");
  assert.equal(agyFresh.resumeId, undefined);
  assert.equal(agyFresh.discoverResumeId, true);
  assert.equal(agyFresh.argv[0], "agy");
  assert.equal(agyFresh.argv[1], "--dangerously-skip-permissions");
  assert.equal(agyFresh.argv[2], "-i");
  assert.match(agyFresh.argv[3]!, /tg-bot3-run:launch-abc/);
  assert.match(agyFresh.argv[3]!, /lmk send --to owner_fp -/);
  assert.match(agyFresh.argv[3]!, /\/tmp\/state\/prompts\/10_77\.md/);
  assert.match(agyFresh.argv[3]!, /\/tmp\/state\/AGENTS\.md/);
  assert.doesNotMatch(agyFresh.argv[3]!, /agy-letmeknow/);

  const agyResume = registry.buildLaunch("agy", { ...baseCtx, resumeId: "conv-123" });
  assert.equal(agyResume.resumeId, "conv-123");
  assert.equal(agyResume.discoverResumeId, false);
  assert.deepEqual(agyResume.argv.slice(0, 4), ["agy", "--dangerously-skip-permissions", "--conversation", "conv-123"]);
  assert.equal(agyResume.argv[4], "-i");
  assert.equal(agyResume.env?.AGY_PROMPT_FILE, "/tmp/state/prompts/10_77.md");

  // 2. pi fresh & resume
  const piFresh = registry.buildLaunch("pi", baseCtx);
  assert.ok(piFresh.resumeId && UUID_RE.test(piFresh.resumeId));
  assert.equal(piFresh.discoverResumeId, false);
  assert.equal(piFresh.env, undefined);
  assert.deepEqual(piFresh.argv, [
    "pi",
    "--session-id", piFresh.resumeId,
    "--name", "tg 10:77",
    "--append-system-prompt", baseCtx.promptText,
  ]);

  const piResume = registry.buildLaunch("pi", { ...baseCtx, resumeId: piFresh.resumeId });
  assert.equal(piResume.resumeId, piFresh.resumeId);
  assert.deepEqual(piResume.argv, piFresh.argv);

  // 3. claude fresh & resume
  const claudeFresh = registry.buildLaunch("claude", baseCtx);
  assert.ok(claudeFresh.resumeId && UUID_RE.test(claudeFresh.resumeId));
  assert.equal(claudeFresh.discoverResumeId, false);
  assert.deepEqual(claudeFresh.argv, [
    "claude",
    "--dangerously-skip-permissions",
    "--append-system-prompt", baseCtx.promptText,
    "--session-id", claudeFresh.resumeId,
  ]);

  const claudeResume = registry.buildLaunch("claude", { ...baseCtx, resumeId: claudeFresh.resumeId });
  assert.equal(claudeResume.resumeId, claudeFresh.resumeId);
  assert.deepEqual(claudeResume.argv, [
    "claude",
    "--dangerously-skip-permissions",
    "--append-system-prompt", baseCtx.promptText,
    "--resume", claudeFresh.resumeId,
  ]);

  // 4. codex fresh & resume
  const codexFresh = registry.buildLaunch("codex", baseCtx);
  assert.equal(codexFresh.resumeId, undefined);
  assert.equal(codexFresh.discoverResumeId, true);
  assert.deepEqual(codexFresh.argv, [
    "codex",
    "--no-daemon",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "-c", "check_for_update_on_startup=false",
    "-c", `developer_instructions=${tomlString(baseCtx.promptText)}`,
  ]);

  const codexResume = registry.buildLaunch("codex", { ...baseCtx, resumeId: "01a1e824-d3dc-7281-9964-da9d356a08ac" });
  assert.equal(codexResume.resumeId, "01a1e824-d3dc-7281-9964-da9d356a08ac");
  assert.equal(codexResume.discoverResumeId, false);
  assert.deepEqual(codexResume.argv, [
    "codex",
    "resume",
    "--no-daemon",
    "--dangerously-bypass-approvals-and-sandbox",
    "--dangerously-bypass-hook-trust",
    "-c", "check_for_update_on_startup=false",
    "-c", `developer_instructions=${tomlString(baseCtx.promptText)}`,
    "01a1e824-d3dc-7281-9964-da9d356a08ac",
  ]);
});

test("HarnessRegistry supports legacy agy override, per-harness bin/args, custom aliases, and generic custom harnesses", () => {
  const legacy = new HarnessRegistry({ legacyAgy: "/opt/bin/agy-legacy" });
  const planLegacy = legacy.buildLaunch("agy", {
    convKey: "1:0",
    promptText: "hi",
    promptFile: "/tmp/p.md",
    bridgeSession: "s",
    launchId: "l1",
  });
  assert.equal(planLegacy.argv[0], "/opt/bin/agy-legacy");

  const registry = new HarnessRegistry({
    legacyAgy: "/opt/bin/agy-legacy",
    harnesses: {
      agy: { bin: "/custom/agy", args: ["--effort", "high"] },
      "codex-mini": { preset: "codex", args: ["-m", "o3-mini"] },
      custom: { bin: "/usr/local/bin/my-agent", args: ["--mode", "tg"] },
    },
  });
  assert.deepEqual(registry.names(), ["agy", "pi", "codex", "claude", "codex-mini", "custom"]);
  assert.equal(registry.resolveName("CODEX-MINI"), "codex-mini");
  assert.equal(registry.resolveName("nonexistent"), undefined);
  assert.equal(registry.basePreset("codex-mini"), "codex");

  const agyPlan = registry.buildLaunch("agy", {
    convKey: "1:0",
    promptText: "hi",
    promptFile: "/tmp/p.md",
    bridgeSession: "s",
    launchId: "l2",
  });
  assert.deepEqual(agyPlan.argv.slice(0, 4), ["/custom/agy", "--dangerously-skip-permissions", "--effort", "high"]);

  const miniResume = registry.buildLaunch("codex-mini", {
    convKey: "1:0",
    promptText: "hi",
    promptFile: "/tmp/p.md",
    bridgeSession: "s",
    launchId: "l3",
    resumeId: "01a1e824-d3dc-7281-9964-da9d356a08ac",
  });
  assert.deepEqual(miniResume.argv.slice(-3), ["-m", "o3-mini", "01a1e824-d3dc-7281-9964-da9d356a08ac"]);

  const customPlan = registry.buildLaunch("custom", {
    convKey: "1:0",
    promptText: "hi",
    promptFile: "/tmp/p.md",
    bridgeSession: "s",
    launchId: "l4",
  });
  assert.deepEqual(customPlan.argv, ["/usr/local/bin/my-agent", "--mode", "tg"]);
  assert.equal(customPlan.env?.TG_PROMPT_FILE, "/tmp/p.md");
});

test("discoverResumeId uniquely matches agy and codex sessions and refuses ambiguous matches", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-discover-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const now = Date.now();
  const agyDir = path.join(dir, "brain");
  const uuid1 = "11111111-1111-4111-8111-111111111111";
  const uuid2 = "22222222-2222-4222-8222-222222222222";
  mkdirSync(path.join(agyDir, uuid1, ".system_generated", "logs"), { recursive: true });
  mkdirSync(path.join(agyDir, uuid2, ".system_generated", "logs"), { recursive: true });
  writeFileSync(
    path.join(agyDir, uuid1, ".system_generated", "logs", "transcript.jsonl"),
    JSON.stringify({ content: `Session started (${formatLaunchMarker("run-agy-1")})` }) + "\n",
  );
  writeFileSync(
    path.join(agyDir, uuid2, ".system_generated", "logs", "transcript.jsonl"),
    JSON.stringify({ content: "unrelated manual session" }) + "\n",
  );

  assert.equal(
    discoverResumeId({ preset: "agy", launchId: "run-agy-1", launchedAtMs: now, agyBrainDir: agyDir, nowMs: now }),
    uuid1,
  );
  assert.equal(
    discoverResumeId({ preset: "agy", launchId: "run-missing", launchedAtMs: now, agyBrainDir: agyDir, nowMs: now }),
    undefined,
  );

  // Ambiguous match (>1 transcripts containing same marker) -> returns undefined safely.
  writeFileSync(
    path.join(agyDir, uuid2, ".system_generated", "logs", "transcript.jsonl"),
    JSON.stringify({ content: `duplicate (${formatLaunchMarker("run-agy-1")})` }) + "\n",
  );
  assert.equal(
    discoverResumeId({ preset: "agy", launchId: "run-agy-1", launchedAtMs: now, agyBrainDir: agyDir, nowMs: now }),
    undefined,
  );

  // Codex discovery
  const codexDir = path.join(dir, "codex-sessions");
  const d = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  const dayDir = path.join(codexDir, String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate()));
  mkdirSync(dayDir, { recursive: true });
  const codexUuid = "33333333-3333-4333-8333-333333333333";
  const otherUuid = "44444444-4444-4444-8444-444444444444";
  writeFileSync(
    path.join(dayDir, `rollout-2026-11-24T16-00-00-${codexUuid}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: codexUuid, cwd: "/home/spoj" } }) + "\n"
      + JSON.stringify({ type: "response_item", payload: { role: "developer", content: [{ text: `<!-- ${formatLaunchMarker("run-codex-1")} -->` }] } }) + "\n",
  );
  writeFileSync(
    path.join(dayDir, `rollout-2026-11-24T16-00-01-${otherUuid}.jsonl`),
    JSON.stringify({ type: "session_meta", payload: { id: otherUuid, cwd: "/home/spoj" } }) + "\n"
      + JSON.stringify({ type: "response_item", payload: { role: "developer", content: [{ text: "other session" }] } }) + "\n",
  );

  assert.equal(
    discoverResumeId({ preset: "codex", launchId: "run-codex-1", launchedAtMs: now, codexSessionsDir: codexDir, nowMs: now }),
    codexUuid,
  );
  assert.equal(
    discoverResumeId({ preset: "codex", launchId: "run-codex-missing", launchedAtMs: now, codexSessionsDir: codexDir, nowMs: now }),
    undefined,
  );
});

test("Hc.spawn calls hc-lmk with required flags, env wrapper, saved session, and name-collision fallback", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "tg-bot3-hc-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const logPath = path.join(dir, "calls.jsonl");
  const fakeHcLmk = path.join(dir, "fake-hc-lmk");
  writeFileSync(
    fakeHcLmk,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
if (args.includes("--name") && args[args.indexOf("--name") + 1] === "collide-name") {
  process.stderr.write("name already exists\\n");
  process.exit(1);
}
console.log(JSON.stringify({ address: "t99" }));
`,
  );
  chmodSync(fakeHcLmk, 0o755);

  const hc = new Hc("/custom/hc", fakeHcLmk);
  const addr1 = await hc.spawn({
    name: "collide-name",
    cwd: dir,
    labels: { owner: "tg-bot3", harness: "agy" },
    join: "G_OWNER",
    readyFile: path.join(dir, "ready.json"),
    session: "savedfp1",
    deliver: "idle",
    env: { AGY_PROMPT_FILE: "/tmp/p.md" },
    argv: ["agy", "--dangerously-skip-permissions", "-i", "hi"],
  });
  assert.equal(addr1, "t99");

  const addr2 = await hc.spawn({
    name: "tg-10-1",
    cwd: dir,
    labels: { owner: "tg-bot3", harness: "pi" },
    join: "G_OWNER",
    readyFile: path.join(dir, "ready2.json"),
    argv: ["pi", "--session-id", "u1"],
  });
  assert.equal(addr2, "t99");

  const calls = readFileSync(logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
  assert.equal(calls.length, 3);
  // First call included --name collide-name and failed; second call dropped --name and succeeded.
  assert.ok(calls[0]!.includes("--name"));
  assert.equal(calls[1]!.includes("--name"), false);
  assert.deepEqual(calls[1]!.slice(0, 14), [
    "--bg", "--json", "--no-parent", "--outlive-parent", "--no-notify",
    "--cwd", dir, "--join", "G_OWNER", "--attach", "",
    "--ready-file", path.join(dir, "ready.json"), "--deliver",
  ]);
  assert.equal(calls[1]![14], "idle");
  assert.ok(calls[1]!.includes("--session"));
  assert.equal(calls[1]![calls[1]!.indexOf("--session") + 1], "savedfp1");
  assert.ok(calls[1]!.includes("--hc"));
  assert.equal(calls[1]![calls[1]!.indexOf("--hc") + 1], "/custom/hc");
  assert.deepEqual(calls[1]!.slice(calls[1]!.indexOf("--")), [
    "--", "env", "AGY_PROMPT_FILE=/tmp/p.md", "agy", "--dangerously-skip-permissions", "-i", "hi",
  ]);

  // Third call had no env -> no "env" wrapper, default deliver="always", no --session.
  assert.equal(calls[2]![calls[2]!.indexOf("--deliver") + 1], "always");
  assert.equal(calls[2]!.includes("--session"), false);
  assert.deepEqual(calls[2]!.slice(calls[2]!.indexOf("--")), ["--", "pi", "--session-id", "u1"]);
});
