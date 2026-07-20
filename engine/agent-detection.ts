import { Effect } from "effect";
import { spawn, type ChildProcess } from "child_process";
import { createLogger } from "./logger.js";
import type { AgentRuntimeDetection, AgentRuntimeKind } from "./agent-transport.js";

const logger = createLogger("AgentDetection");

function which(binary: string): Effect.Effect<string | null, unknown> {
  return Effect.async((resume) => {
    const isWindows = process.platform === "win32";
    const cmd = isWindows ? "where" : "which";
    let child: ChildProcess | null = null;

    try {
      child = spawn(cmd, [binary], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resume(Effect.succeed(null));
      return;
    }

    let stdout = "";
    child.stdout?.on("data", (data: Buffer) => {
      stdout += data.toString("utf-8");
    });

    const cleanup = () => {
      child?.removeAllListeners();
      child?.stdout?.removeAllListeners();
    };

    child.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        resume(Effect.succeed(null));
        return;
      }
      const first = stdout.split(/\r?\n/)[0]?.trim();
      resume(Effect.succeed(first || null));
    });

    child.on("error", () => {
      cleanup();
      resume(Effect.succeed(null));
    });

    const timer = setTimeout(() => {
      cleanup();
      child?.kill("SIGKILL");
      resume(Effect.succeed(null));
    }, 5_000);

    return Effect.sync(() => {
      clearTimeout(timer);
      cleanup();
      child?.kill("SIGKILL");
    });
  });
}

function isGatewayRunning(url: string, token: string): Effect.Effect<boolean, unknown> {
  return Effect.async((resume) => {
    let ws: WebSocket | null = null;
    let settled = false;

    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resume(Effect.succeed(value));
    };

    const timer = setTimeout(() => {
      try {
        ws?.close();
      } catch {
        // ignore close errors during probe timeout cleanup
      }
      settle(false);
    }, 3_000);

    try {
      // Bun's WebSocket takes an options object as the 2nd arg; pass the token on
      // the upgrade so gateways that reject unauthenticated upgrades still answer.
      ws = token
        ? new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } })
        : new WebSocket(url);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        // Settle BEFORE closing: Bun dispatches the close listener synchronously
        // during ws.close(), so settle(false) from the close handler would win
        // if close() ran first.
        settle(true);
        try {
          ws?.close();
        } catch {
          // ignore close errors during probe success cleanup
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        settle(false);
      });
      ws.addEventListener("close", () => {
        clearTimeout(timer);
        settle(false);
      });
    } catch {
      clearTimeout(timer);
      settle(false);
    }

    return Effect.sync(() => {
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // ignore close errors during Effect cancellation cleanup
      }
    });
  });
}

export function detectAgents(config: {
  readonly agentAcpCommand: string;
  readonly agentGatewayUrl: string;
  readonly agentGatewayToken: string;
}): Effect.Effect<AgentRuntimeDetection, unknown> {
  return Effect.gen(function* () {
    logger.info("Detecting agent runtimes...");

    const [hermesPath, openclawPath, gatewayRunning] = yield* Effect.all(
      [
        which(config.agentAcpCommand).pipe(Effect.catchAll(() => Effect.succeed(null))),
        which("openclaw").pipe(Effect.catchAll(() => Effect.succeed(null))),
        isGatewayRunning(config.agentGatewayUrl, config.agentGatewayToken).pipe(
          Effect.catchAll(() => Effect.succeed(false)),
        ),
      ],
      { concurrency: 3 },
    );

    const hermesAvailable = hermesPath !== null;
    const openclawAvailable = openclawPath !== null;

    let recommended: AgentRuntimeKind = "none";
    if (gatewayRunning) {
      recommended = "openclaw";
    } else if (hermesAvailable) {
      recommended = "hermes";
    }

    logger.info("Agent runtime detection complete", {
      hermes: hermesAvailable,
      openclaw: openclawAvailable,
      gatewayRunning,
      recommended,
    });

    return {
      hermes: { available: hermesAvailable, path: hermesPath },
      openclaw: {
        available: openclawAvailable,
        path: openclawPath,
        gatewayRunning,
      },
      recommended,
    };
  });
}
