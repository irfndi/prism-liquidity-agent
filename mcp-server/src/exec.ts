import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BUFFER = 10 * 1024 * 1024;

function findPrismBinary(): string {
  if (process.env.PRISM_BIN) {
    return process.env.PRISM_BIN;
  }
  const home = homedir();
  const candidates = [
    join(home, ".local", "bin", "prism"),
    join(home, ".bun", "bin", "prism"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "prism";
}

export interface PrismExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export async function runPrism(
  args: ReadonlyArray<string>,
  options: { timeoutMs?: number } = {},
): Promise<PrismExecResult> {
  const bin = findPrismBinary();
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const result = await execFileAsync(bin, [...args], {
      timeout,
      maxBuffer: MAX_BUFFER,
      env: { ...process.env, FORCE_COLOR: "0" },
    });
    return {
      ok: true,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
      timedOut: false,
    };
  } catch (err) {
    const e = err as {
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      code?: number | string;
      message?: string;
      killed?: boolean;
      signal?: string;
    };
    const stdout = e.stdout ? e.stdout.toString() : "";
    const stderr = e.stderr ? e.stderr.toString() : e.message ?? String(err);
    const exitCode = typeof e.code === "number" ? e.code : 1;
    const timedOut = e.killed === true;
    return { ok: false, stdout, stderr, exitCode, timedOut };
  }
}
