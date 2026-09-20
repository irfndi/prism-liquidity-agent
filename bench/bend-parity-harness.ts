// Bend parity harness: shells `bend <tmpfile>` with a probe importing
// native/bend/kernels.bend. Fixed-point mapping: TS floats x100 via
// Math.round (so 1.2 -> 120n, 13.92 -> 1392n). Rounding note: values that
// are not exact hundredths round to nearest (half up); all vectors here
// are exact hundredths, so no rounding drift. Nat division floors —
// probes only use exact divisions. Skip (don't fail) when `bend` absent.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const KERNELS_SRC = new URL("../native/bend/kernels.bend", import.meta.url);

/** TS float -> hundredths Nat literal, e.g. 1.2 -> "120n". */
export function toNat(v: number): string {
  return `${Math.round(v * 100)}n`;
}

function bendEnv(): NodeJS.ProcessEnv {
  const home = process.env.HOME ?? "";
  return { ...process.env, PATH: `${home}/.bend/bin:${process.env.PATH ?? ""}` };
}

/** False when the `bend` binary is missing — callers must skip, not fail. */
export function isBendAvailable(): boolean {
  try {
    execFileSync("bend", ["--help"], { env: bendEnv(), stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runProbe(expr: string, ret: "Nat" | "Bool"): string {
  const dir = mkdtempSync(join(tmpdir(), "bend-parity-"));
  try {
    cpSync(new URL(KERNELS_SRC), join(dir, "kernels.bend"));
    writeFileSync(
      join(dir, "probe.bend"),
      `import kernels.bend as K\ndef main() -> ${ret}:\n  ${expr}\n`,
    );
    const out = execFileSync("bend", [join(dir, "probe.bend")], {
      env: bendEnv(),
      encoding: "utf8",
      timeout: 60_000,
    });
    return out.trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Run a Nat-valued kernel expression, e.g. `K.clamp_thr(1392n, 30n, 300n)`. */
export function runBendNat(expr: string): bigint {
  const out = runProbe(expr, "Nat");
  const m = /^(\d+)n$/.exec(out);
  const digits = m?.[1];
  if (!digits) throw new Error(`unparseable Bend Nat output: ${JSON.stringify(out)}`);
  return BigInt(digits);
}

/** Run a Bool-valued kernel expression, e.g. `K.enter_blocked(True{}, False{}, 20n, 30n)`. */
export function runBendBool(expr: string): boolean {
  const out = runProbe(expr, "Bool");
  if (out === "True{}") return true;
  if (out === "False{}") return false;
  throw new Error(`unparseable Bend Bool output: ${JSON.stringify(out)}`);
}
