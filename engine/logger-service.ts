import { Context, Effect } from "effect";

export interface AppLogger {
  readonly debug: (msg: string, data?: Record<string, unknown>) => Effect.Effect<void>;
  readonly info: (msg: string, data?: Record<string, unknown>) => Effect.Effect<void>;
  readonly warn: (msg: string, data?: Record<string, unknown>) => Effect.Effect<void>;
  readonly error: (msg: string, data?: Record<string, unknown>) => Effect.Effect<void>;
}

export class LoggerService extends Context.Tag("LoggerService")<
  LoggerService,
  (component: string) => AppLogger
>() {}
