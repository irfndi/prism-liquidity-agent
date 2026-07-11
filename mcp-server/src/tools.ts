import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runPrism } from "./exec.js";

function getPrismDataDir(): string {
  if (process.env.PRISM_DATA_DIR) return process.env.PRISM_DATA_DIR;
  if (existsSync(path.resolve(".env"))) return process.cwd();
  return path.join(os.homedir(), ".local", "share", "prism");
}

function getPrismDbPath(): string {
  // Keep in sync with engine/paths.ts::getPrismDbPath
  if (process.env.SQLITE_DB_PATH) return process.env.SQLITE_DB_PATH;
  return path.join(getPrismDataDir(), "prism.db");
}

function openDb(): InstanceType<typeof Database> | null {
  const dbPath = getPrismDbPath();
  if (!existsSync(dbPath)) {
    return null;
  }
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

function registerPrismStatus(server: McpServer): void {
  server.tool(
    "prism_status",
    "Get the current status of the Prism trading agent. Returns position count, " +
      "total deposited/current value, and the last 3 audit entries. Returns an empty status " +
      "object if the SQLite database does not exist (no agent has run yet).",
    {},
    async () => {
      const db = openDb();
      if (db === null) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { running: false, message: "No SQLite database found. Run `prism dev` at least once to create one." },
                null,
                2,
              ),
            },
          ],
        };
      }
      try {
        const positionCount = (
          db.prepare("SELECT COUNT(*) as n FROM positions WHERE paper_exited_at IS NULL").get() as { n: number }
        ).n;
        const totals = db
          .prepare(
            "SELECT COALESCE(SUM(deposited_usd), 0) as total_deposited, " +
              "COALESCE(SUM(current_value_usd), 0) as total_current " +
              "FROM positions WHERE paper_exited_at IS NULL",
          )
          .get() as { total_deposited: number; total_current: number };
        const lastAudit = db
          .prepare(
            "SELECT timestamp, action, pool_address, reasoning, paper_trading " +
              "FROM audit ORDER BY timestamp DESC LIMIT 3",
          )
          .all() as Array<{
            timestamp: number;
            action: string;
            pool_address: string;
            reasoning: string;
            paper_trading: number;
          }>;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  running: true,
                  dbPath: getPrismDbPath(),
                  positionCount,
                  totalDepositedUsd: totals.total_deposited,
                  totalCurrentValueUsd: totals.total_current,
                  lastAudit: lastAudit.map((a) => ({
                    timestamp: new Date(a.timestamp).toISOString(),
                    action: a.action,
                    pool: a.pool_address,
                    reasoning: a.reasoning,
                    paperTrading: a.paper_trading === 1,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: `Failed to read SQLite database: ${err instanceof Error ? err.message : String(err)}` },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      } finally {
        db.close();
      }
    },
  );
}

function registerPrismPositions(server: McpServer): void {
  server.tool(
    "prism_positions",
    "List all active positions tracked by the Prism agent. Excludes paper-exited positions. " +
      "Returns an empty array if the SQLite database does not exist.",
    {},
    async () => {
      const db = openDb();
      if (!db) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify([], null, 2),
            },
          ],
        };
      }
      try {
        const rows = db
          .prepare(
            "SELECT pool_address, token_x_symbol, token_y_symbol, " +
              "deposited_usd, current_value_usd, lower_bin_id, upper_bin_id, " +
              "active_bin_id, oor_cycle_count, last_rebalance_at " +
              "FROM positions WHERE paper_exited_at IS NULL " +
              "ORDER BY deposited_usd DESC",
          )
          .all() as Array<Record<string, unknown>>;
        const positions = rows.map((r) => ({
          pool: r.pool_address,
          tokens: `${r.token_x_symbol}/${r.token_y_symbol}`,
          depositedUsd: Number(r.deposited_usd),
          currentValueUsd: Number(r.current_value_usd),
          range: { lower: r.lower_bin_id, upper: r.upper_bin_id, active: r.active_bin_id },
          outOfRangeCycleCount: r.oor_cycle_count,
          lastRebalanceAt: r.last_rebalance_at
            ? new Date(Number(r.last_rebalance_at)).toISOString()
            : null,
        }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(positions, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: `Failed to read positions: ${err instanceof Error ? err.message : String(err)}` },
                null,
                2,
              ),
            },
          ],
          isError: true,
        };
      } finally {
        db.close();
      }
    },
  );
}

function registerPrismWhoami(server: McpServer): void {
  server.tool(
    "prism_whoami",
    "Show the current Prism cloud account info. Requires `prism register` to have been run first. " +
      "Returns an error message if not registered.",
    {},
    async () => {
      const result = await runPrism(["whoami"]);
      if (!result.ok) {
        if (result.stderr.includes("Not registered") || result.stderr.includes("Run 'prism register'")) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  { registered: false, message: "Not registered. Run 'prism register' first." },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        const detail = result.timedOut
          ? `Command timed out after 30s:\n${result.stderr}`
          : `Error running \`prism whoami\` (exit ${result.exitCode}):\n${result.stderr}`;
        return {
          content: [
            {
              type: "text",
              text: detail,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.stdout }],
      };
    },
  );
}

function registerPrismBacktest(server: McpServer): void {
  server.tool(
    "prism_backtest",
    "Run a Prism backtest. By default uses synthetic data for 7 days. " +
      "Set `source` to `replay` and provide `days` + optionally `pools` to replay on-chain snapshots. " +
      "Note: the `pools` parameter is only used when `source` is `replay`; it is ignored otherwise.",
    {
      source: z.enum(["synthetic", "replay"]).default("synthetic").describe(
        "Data source: 'synthetic' (default) generates deterministic mock data; 'replay' reads from prism.db snapshots.",
      ),
      days: z.number().int().min(1).max(365).default(7).describe("Number of days to backtest (1-365)."),
      pools: z
        .array(z.string())
        .optional()
        .describe("Pool addresses to backtest (replay mode only — ignored if source is 'synthetic'). If empty, uses all pools with snapshots."),
    },
    async ({ source, days, pools }) => {
      const args = ["backtest", "--source", source, "--days", String(days)];
      if (source === "replay" && pools && pools.length > 0) {
        args.push("--pools", pools.join(","));
      }
      const result = await runPrism(args, { timeoutMs: 120_000 });
      if (!result.ok) {
        const detail = result.timedOut
          ? `Backtest timed out after 120s:\n${result.stderr || result.stdout}`
          : `Error running \`prism backtest\` (exit ${result.exitCode}):\n${result.stderr || result.stdout}`;
        return {
          content: [
            {
              type: "text",
              text: detail,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [{ type: "text", text: result.stdout }],
      };
    },
  );
}

export function registerAllTools(server: McpServer): void {
  registerPrismStatus(server);
  registerPrismPositions(server);
  registerPrismWhoami(server);
  registerPrismBacktest(server);
}
