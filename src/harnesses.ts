import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const BUILTIN_HARNESS_NAMES = ["agy", "pi", "codex", "claude"] as const;
export type BuiltinHarnessName = (typeof BUILTIN_HARNESS_NAMES)[number];

export type HarnessOverride = {
  bin?: string;
  args?: string[];
  preset?: string;
};

export type HarnessConfigMap = Record<string, HarnessOverride>;

export type HarnessLaunchContext = {
  convKey: string;
  promptText: string;
  promptFile: string;
  agentsMdPath?: string;
  bridgeSession: string;
  resumeId?: string;
  launchId: string;
  override?: HarnessOverride;
};

export type HarnessLaunchPlan = {
  argv: string[];
  env?: Record<string, string>;
  resumeId?: string;
  discoverResumeId?: boolean;
};

export interface HarnessPreset {
  readonly name: string;
  readonly defaultBin: string;
  buildLaunch(ctx: HarnessLaunchContext): HarnessLaunchPlan;
}

export type DiscoverResumeOptions = {
  preset: string;
  launchId: string;
  launchedAtMs: number;
  agyBrainDir?: string;
  codexSessionsDir?: string;
  nowMs?: number;
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLLOUT_UUID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
const AGY_HEAD_BYTES = 64 * 1024;
const CODEX_HEAD_BYTES = 512 * 1024;
const DISCOVER_CLOCK_SKEW_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function tomlString(value: string): string {
  return JSON.stringify(value).replace(/\u007f/g, "\\u007f");
}

export function formatLaunchMarker(launchId: string): string {
  return `tg-bot3-run:${launchId}`;
}

export function sanitizeConvFilename(convKey: string): string {
  return convKey.replace(/^-/, "g").replace(/[^a-zA-Z0-9_-]+/g, "_");
}

const agyPreset: HarnessPreset = {
  name: "agy",
  defaultBin: "agy",
  buildLaunch(ctx) {
    const bin = ctx.override?.bin ?? this.defaultBin;
    const extraArgs = ctx.override?.args ?? [];
    const promptRef = ctx.agentsMdPath ? `${ctx.promptFile} (includes ${ctx.agentsMdPath})` : ctx.promptFile;
    const initPrompt = ctx.resumeId
      ? `Session resumed for Telegram (${ctx.convKey}). Reply via \`lmk send --to ${ctx.bridgeSession} -\`. If instructions were not injected, read ${promptRef} and handle incoming [letmeknow] messages.`
      : `Session started for Telegram (${ctx.convKey}, ${formatLaunchMarker(ctx.launchId)}). Reply via \`lmk send --to ${ctx.bridgeSession} -\`. If instructions were not injected, read ${promptRef} and wait for incoming [letmeknow] messages.`;
    return {
      argv: [
        bin,
        "--dangerously-skip-permissions",
        ...extraArgs,
        ...(ctx.resumeId ? ["--conversation", ctx.resumeId] : []),
        "-i",
        initPrompt,
      ],
      env: { AGY_PROMPT_FILE: ctx.promptFile },
      resumeId: ctx.resumeId,
      discoverResumeId: !ctx.resumeId,
    };
  },
};

const piPreset: HarnessPreset = {
  name: "pi",
  defaultBin: "pi",
  buildLaunch(ctx) {
    const bin = ctx.override?.bin ?? this.defaultBin;
    const extraArgs = ctx.override?.args ?? [];
    const sessionId = ctx.resumeId ?? randomUUID();
    return {
      argv: [
        bin,
        "--session-id", sessionId,
        "--name", `tg ${ctx.convKey}`,
        "--append-system-prompt", ctx.promptText,
        ...extraArgs,
      ],
      resumeId: sessionId,
      discoverResumeId: false,
    };
  },
};

const claudePreset: HarnessPreset = {
  name: "claude",
  defaultBin: "claude",
  buildLaunch(ctx) {
    const bin = ctx.override?.bin ?? this.defaultBin;
    const extraArgs = ctx.override?.args ?? [];
    const sessionId = ctx.resumeId ?? randomUUID();
    return {
      argv: [
        bin,
        "--dangerously-skip-permissions",
        "--append-system-prompt", ctx.promptText,
        ctx.resumeId ? "--resume" : "--session-id", sessionId,
        ...extraArgs,
      ],
      resumeId: sessionId,
      discoverResumeId: false,
    };
  },
};

const codexPreset: HarnessPreset = {
  name: "codex",
  defaultBin: "codex",
  buildLaunch(ctx) {
    const bin = ctx.override?.bin ?? this.defaultBin;
    const extraArgs = ctx.override?.args ?? [];
    const flags = [
      "--no-daemon",
      "--dangerously-bypass-approvals-and-sandbox",
      "--dangerously-bypass-hook-trust",
      "-c", "check_for_update_on_startup=false",
      "-c", `developer_instructions=${tomlString(ctx.promptText)}`,
      ...extraArgs,
    ];
    return {
      argv: ctx.resumeId ? [bin, "resume", ...flags, ctx.resumeId] : [bin, ...flags],
      resumeId: ctx.resumeId,
      discoverResumeId: !ctx.resumeId,
    };
  },
};

const BUILTIN_PRESETS: Record<BuiltinHarnessName, HarnessPreset> = {
  agy: agyPreset,
  pi: piPreset,
  codex: codexPreset,
  claude: claudePreset,
};

function makeCustomPreset(name: string, defaultBin: string): HarnessPreset {
  return {
    name,
    defaultBin,
    buildLaunch(ctx) {
      const bin = ctx.override?.bin ?? defaultBin;
      const extraArgs = ctx.override?.args ?? [];
      return {
        argv: [bin, ...extraArgs],
        env: { TG_PROMPT_FILE: ctx.promptFile },
        resumeId: ctx.resumeId,
        discoverResumeId: false,
      };
    },
  };
}

type RegisteredHarness = {
  name: string;
  basePreset: string;
  preset: HarnessPreset;
  override?: HarnessOverride;
};

export class HarnessRegistry {
  private readonly entries = new Map<string, RegisteredHarness>();

  constructor(options: { harnesses?: HarnessConfigMap; legacyAgy?: string } = {}) {
    const overrides = options.harnesses ?? {};
    for (const name of BUILTIN_HARNESS_NAMES) {
      const preset = BUILTIN_PRESETS[name];
      const raw = overrides[name];
      const override: HarnessOverride | undefined = name === "agy" && options.legacyAgy && !raw?.bin
        ? { ...raw, bin: options.legacyAgy }
        : raw;
      this.entries.set(name, { name, basePreset: name, preset, override });
    }
    for (const [name, override] of Object.entries(overrides)) {
      if (this.entries.has(name)) continue;
      if (override.preset) {
        const base = BUILTIN_PRESETS[override.preset as BuiltinHarnessName];
        if (!base) {
          throw new Error(`Harness "${name}" references unknown base preset "${override.preset}"`);
        }
        this.entries.set(name, { name, basePreset: base.name, preset: base, override });
      } else if (override.bin) {
        this.entries.set(name, { name, basePreset: "custom", preset: makeCustomPreset(name, override.bin), override });
      } else {
        throw new Error(`Custom harness "${name}" must specify "preset" or "bin"`);
      }
    }
  }

  names(): string[] {
    return [...this.entries.keys()];
  }

  resolveName(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (this.entries.has(trimmed)) return trimmed;
    const lower = trimmed.toLowerCase();
    for (const name of this.entries.keys()) {
      if (name.toLowerCase() === lower) return name;
    }
    return undefined;
  }

  basePreset(name: string): string | undefined {
    const resolved = this.resolveName(name);
    return resolved ? this.entries.get(resolved)?.basePreset : undefined;
  }

  buildLaunch(name: string, ctx: Omit<HarnessLaunchContext, "override">): HarnessLaunchPlan {
    const resolved = this.resolveName(name);
    if (!resolved) {
      throw new Error(`Unknown harness "${name}". Available: ${this.names().join(", ")}`);
    }
    const entry = this.entries.get(resolved)!;
    return entry.preset.buildLaunch({ ...ctx, override: entry.override });
  }
}

function readHead(filePath: string, maxBytes: number): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(filePath, "r");
    const buf = Buffer.allocUnsafe(maxBytes);
    const bytes = readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytes).toString("utf8");
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // ignore close error
      }
    }
  }
}

function discoverAgyResumeId(brainDir: string, marker: string, launchedAtMs: number): string | undefined {
  if (!existsSync(brainDir)) return undefined;
  let dirents;
  try {
    dirents = readdirSync(brainDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const cutoff = launchedAtMs - DISCOVER_CLOCK_SKEW_MS;
  const candidates: Array<{ id: string; transcriptPath: string; mtimeMs: number }> = [];
  for (const d of dirents) {
    if (!d.isDirectory() || !UUID_RE.test(d.name)) continue;
    const transcriptPath = path.join(brainDir, d.name, ".system_generated", "logs", "transcript.jsonl");
    try {
      const st = statSync(transcriptPath);
      if (st.mtimeMs < cutoff) continue;
      candidates.push({ id: d.name, transcriptPath, mtimeMs: st.mtimeMs });
    } catch {
      // Transcript not created yet or unreadable.
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const matches = new Set<string>();
  for (const candidate of candidates.slice(0, 100)) {
    const head = readHead(candidate.transcriptPath, AGY_HEAD_BYTES);
    if (head && head.includes(marker)) {
      matches.add(candidate.id);
      if (matches.size > 1) return undefined;
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

function dateDirParts(tsMs: number): Array<[string, string, string]> {
  const d = new Date(tsMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return [
    [String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())],
    [String(d.getUTCFullYear()), pad(d.getUTCMonth() + 1), pad(d.getUTCDate())],
  ];
}

function discoverCodexResumeId(sessionsDir: string, marker: string, launchedAtMs: number, nowMs: number): string | undefined {
  if (!existsSync(sessionsDir)) return undefined;
  const dirSet = new Set<string>();
  const addWindow = (centerMs: number) => {
    for (const delta of [-DAY_MS, 0, DAY_MS]) {
      for (const [y, m, day] of dateDirParts(centerMs + delta)) {
        dirSet.add(path.join(sessionsDir, y, m, day));
      }
    }
  };
  addWindow(launchedAtMs);
  addWindow(nowMs);

  const cutoff = launchedAtMs - DISCOVER_CLOCK_SKEW_MS;
  const candidates: Array<{ filePath: string; name: string; mtimeMs: number }> = [];
  for (const dir of dirSet) {
    if (!existsSync(dir)) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) continue;
      const filePath = path.join(dir, entry.name);
      try {
        const st = statSync(filePath);
        if (st.mtimeMs < cutoff) continue;
        candidates.push({ filePath, name: entry.name, mtimeMs: st.mtimeMs });
      } catch {
        // ignore vanished file
      }
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const matches = new Set<string>();
  for (const candidate of candidates.slice(0, 100)) {
    const head = readHead(candidate.filePath, CODEX_HEAD_BYTES);
    if (!head || !head.includes(marker)) continue;
    let id: string | undefined;
    const nl = head.indexOf("\n");
    const firstLine = nl >= 0 ? head.slice(0, nl) : head;
    try {
      const parsed = JSON.parse(firstLine) as { type?: string; payload?: { id?: string; session_id?: string } };
      if (parsed.type === "session_meta") {
        const candidateId = parsed.payload?.id ?? parsed.payload?.session_id;
        if (typeof candidateId === "string" && UUID_RE.test(candidateId)) id = candidateId;
      }
    } catch {
      // fall through to filename UUID
    }
    if (!id) {
      const m = candidate.name.match(ROLLOUT_UUID_RE);
      if (m?.[1] && UUID_RE.test(m[1])) id = m[1];
    }
    if (id) {
      matches.add(id);
      if (matches.size > 1) return undefined;
    }
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

export function discoverResumeId(opts: DiscoverResumeOptions): string | undefined {
  const marker = formatLaunchMarker(opts.launchId);
  const nowMs = opts.nowMs ?? Date.now();
  if (opts.preset === "agy") {
    const brainDir = opts.agyBrainDir ?? path.join(homedir(), ".gemini", "antigravity-cli", "brain");
    return discoverAgyResumeId(brainDir, marker, opts.launchedAtMs);
  }
  if (opts.preset === "codex") {
    const sessionsDir = opts.codexSessionsDir ?? path.join(homedir(), ".codex", "sessions");
    return discoverCodexResumeId(sessionsDir, marker, opts.launchedAtMs, nowMs);
  }
  return undefined;
}
