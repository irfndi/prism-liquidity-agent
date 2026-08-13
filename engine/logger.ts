import fs from "fs";
import path from "path";
import { getPrismLogsPath } from "./paths.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Represents arbitrary runtime state that may be attached to a log line.
 * Logging is display, not a parse boundary: values may be JSON-serializable,
 * an `Error` (the common `logger.error(..., err)` shape), or a record of the
 * same. Bound (recursive) rather than `unknown`/`Record<string, unknown>` so it
 * stays a named, serde-able contract without an unsafe escape hatch.
 */
export type LoggableData =
  | import("./services.js").JsonValue
  | Error
  | readonly LoggableData[]
  | { readonly [key: string]: LoggableData | undefined };

export interface LogEntry {
  ts: string;
  level: LogLevel;
  component: string;
  msg: string;
  data?: LoggableData;
}

const AUDIT_PATH = getPrismLogsPath();
let auditStream: fs.WriteStream | null = null;

function getAuditStream(): fs.WriteStream {
  if (!auditStream) {
    fs.mkdirSync(path.dirname(AUDIT_PATH), { recursive: true, mode: 0o700 });
    auditStream = fs.createWriteStream(AUDIT_PATH, { flags: "a" });
  }
  return auditStream;
}

const LEVEL_COLOR = {
  debug: "\x1b[90m",
  info: "\x1b[36m",
  warn: "\x1b[33m",
  error: "\x1b[31m",
} as const;
const RESET = "\x1b[0m";

function emit(level: LogLevel, component: string, msg: string, data?: LoggableData) {
  const entry: LogEntry = {
    ts: new Date().toISOString(),
    level,
    component,
    msg,
  };
  if (data !== undefined) entry.data = data;

  const color = LEVEL_COLOR[level];
  const tag = `${color}[${level.toUpperCase().padEnd(5)}]${RESET}`;
  const comp = `\x1b[35m[${component}]${RESET}`;
  const line = `${entry.ts} ${tag} ${comp} ${msg}`;
  if (level === "error") {
    console.error(line, data ?? "");
  } else if (level === "warn") {
    console.warn(line, data ?? "");
  } else {
    console.log(line, data ?? "");
  }

  getAuditStream().write(JSON.stringify(entry) + "\n");
}

export function createLogger(component: string) {
  return {
    debug: (msg: string, data?: LoggableData) => emit("debug", component, msg, data),
    info: (msg: string, data?: LoggableData) => emit("info", component, msg, data),
    warn: (msg: string, data?: LoggableData) => emit("warn", component, msg, data),
    error: (msg: string, data?: LoggableData) => emit("error", component, msg, data),
  };
}

export type Logger = ReturnType<typeof createLogger>;
