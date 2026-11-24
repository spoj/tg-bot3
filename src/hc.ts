import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export type DeliverMode = "always" | "idle";

export type HcTerminal = {
  address: string;
  state: "live" | "finished";
  parent?: string | null;
  status?: { state?: string; msg?: string } | null;
  labels?: Record<string, string>;
  pid?: number;
  created_ms?: number;
};

export type SpawnSpec = {
  name?: string;
  cwd: string;
  labels: Record<string, string>;
  join: string;
  readyFile: string;
  session?: string;
  deliver?: DeliverMode;
  env?: Record<string, string>;
  argv: string[];
};

export interface HcClient {
  spawn(spec: SpawnSpec): Promise<string>;
  get(address: string): Promise<HcTerminal | null>;
  isReapable(address: string): Promise<boolean>;
  killAndRemove(address: string): Promise<void>;
}

export function sanitizeTerminalName(raw: string): string {
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return (cleaned || "tg").slice(0, 32);
}

export class Hc implements HcClient {
  private readonly command: string;
  private readonly hcLmk: string;

  constructor(command = "hc", hcLmk = "hc-lmk") {
    this.command = command;
    this.hcLmk = hcLmk;
  }

  async spawn(spec: SpawnSpec): Promise<string> {
    const base = [
      "--bg",
      "--json",
      "--no-parent",
      "--outlive-parent",
      "--no-notify",
      "--cwd", spec.cwd,
      "--join", spec.join,
      "--attach", "",
      "--ready-file", spec.readyFile,
      "--deliver", spec.deliver ?? "always",
    ];
    if (spec.session) base.push("--session", spec.session);
    if (this.command !== "hc") base.push("--hc", this.command);
    for (const [k, v] of Object.entries(spec.labels)) base.push("--label", `${k}=${v}`);
    const envPairs = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);
    const tail = envPairs.length ? ["--", "env", ...envPairs, ...spec.argv] : ["--", ...spec.argv];
    const runWith = async (name?: string): Promise<string> => {
      const args = [...base, ...(name ? ["--name", sanitizeTerminalName(name)] : []), ...tail];
      const { stdout } = await exec(this.hcLmk, args);
      const parsed = JSON.parse(stdout) as { address?: string };
      if (!parsed.address) throw new Error(`${this.hcLmk} did not return an address: ${stdout.trim()}`);
      return parsed.address;
    };
    try {
      return await runWith(spec.name);
    } catch (error) {
      if (!spec.name) throw error;
      return runWith(undefined);
    }
  }

  async get(address: string): Promise<HcTerminal | null> {
    try {
      const { stdout } = await exec(this.command, ["get", "--json", address]);
      return JSON.parse(stdout) as HcTerminal;
    } catch (error: any) {
      if (error?.code === 3 || /not_found/.test(String(error?.stderr ?? error?.stdout ?? ""))) return null;
      throw error;
    }
  }

  async isReapable(address: string): Promise<boolean> {
    const term = await this.get(address);
    if (!term || term.state !== "live") return false;
    const status = term.status?.state;
    if (status !== "idle" && status !== "done") return false;
    const labels = term.labels ?? {};
    if (labels.hold && labels.hold !== "0" && labels.hold !== "false") return false;
    if (Number(labels.monitors ?? 0) > 0) return false;
    const { stdout } = await exec(this.command, ["ls", "--json"]);
    const data = JSON.parse(stdout || "{}") as { terminals?: HcTerminal[] };
    for (const other of data.terminals ?? []) {
      if (other.address === address || other.state !== "live") continue;
      if (other.parent === address) return false;
    }
    return true;
  }

  async killAndRemove(address: string): Promise<void> {
    try {
      await exec(this.command, ["kill", "--json", address]);
    } catch (error: any) {
      const msg = String(error?.stderr ?? error?.stdout ?? "");
      if (error?.code !== 3 && error?.code !== 11 && !/not_found|finished/.test(msg)) throw error;
    }
    try {
      await exec(this.command, ["rm", "--json", address]);
    } catch (error: any) {
      const msg = String(error?.stderr ?? error?.stdout ?? "");
      if (error?.code !== 3 && !/not_found/.test(msg)) throw error;
    }
  }
}
