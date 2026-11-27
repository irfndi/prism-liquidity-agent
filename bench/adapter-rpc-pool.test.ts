import { afterEach, describe, expect, it, vi } from "vitest";
import { Connection, Keypair } from "@solana/web3.js";
import { Effect, Layer } from "effect";
import { AdapterService } from "../engine/services.js";
import { AdapterLive } from "../engine/adapter-service.js";
import { ConfigService } from "../engine/config-service.js";
import { AuditLive } from "../engine/audit-service.js";
import { DbLive } from "../engine/db-service.js";
import { defaultAppConfig } from "./helpers.js";

function adapterLayer(): Layer.Layer<AdapterService, never, never> {
  const config = Layer.succeed(
    ConfigService,
    defaultAppConfig({
      solanaRpcUrl: "https://primary.example.com",
      solanaRpcFallbackUrl: "https://fallback.example.com",
      rpcMinIntervalMs: 0,
      sqliteDbPath: ":memory:",
      autoUpdate: false,
    }),
  );
  const audit = Layer.provide(AuditLive, DbLive(":memory:"));
  // SAFETY: All layer dependencies are supplied in the merge below.
  return Layer.provide(
    AdapterLive,
    Layer.merge(config, Layer.merge(audit, DbLive(":memory:"))),
  ) as Layer.Layer<AdapterService, never, never>;
}

function parsedMintResponse(): Awaited<ReturnType<Connection["getParsedAccountInfo"]>> {
  // SAFETY: This fixture matches the parsed-account response consumed by the mint parser.
  return {
    context: { slot: 1 },
    value: {
      data: {
        parsed: {
          info: { decimals: 9, mintAuthority: null, freezeAuthority: null },
        },
      },
    },
  } as Awaited<ReturnType<Connection["getParsedAccountInfo"]>>;
}

describe("adapter RPC provider routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rotates immediately to the fallback on 429 without retrying the primary", async () => {
    const endpoints: string[] = [];
    vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockImplementation(function (
      this: Connection,
    ) {
      endpoints.push(this.rpcEndpoint);
      if (this.rpcEndpoint.includes("primary.example.com")) {
        return Promise.reject(Object.assign(new Error("429 rate limit"), { code: 429 }));
      }
      return Promise.resolve(parsedMintResponse());
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        yield* adapter.getMintAuthorities(Keypair.generate().publicKey.toBase58());
      }).pipe(Effect.provide(adapterLayer())),
    );

    expect(endpoints).toEqual(["https://primary.example.com", "https://fallback.example.com"]);
  });

  it("retries the whole provider pool after an all-endpoint transient failure", async () => {
    const endpoints: string[] = [];
    let attempts = 0;
    vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockImplementation(function (
      this: Connection,
    ) {
      endpoints.push(this.rpcEndpoint);
      attempts += 1;
      if (attempts <= 2) return Promise.reject(new Error("RPC request timeout after 15s"));
      return Promise.resolve(parsedMintResponse());
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        yield* adapter.getMintAuthorities(Keypair.generate().publicKey.toBase58());
      }).pipe(Effect.provide(adapterLayer())),
    );

    expect(endpoints).toEqual([
      "https://primary.example.com",
      "https://fallback.example.com",
      "https://primary.example.com",
    ]);
  }, 5_000);

  it("stops selecting a provider after its circuit opens", async () => {
    const endpoints: string[] = [];
    vi.spyOn(Connection.prototype, "getParsedAccountInfo").mockImplementation(function (
      this: Connection,
    ) {
      endpoints.push(this.rpcEndpoint);
      if (this.rpcEndpoint.includes("primary.example.com")) {
        return Promise.reject(Object.assign(new Error("429 rate limit"), { code: 429 }));
      }
      return Promise.resolve(parsedMintResponse());
    });

    await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* AdapterService;
        for (let index = 0; index < 4; index += 1) {
          yield* adapter.getMintAuthorities(Keypair.generate().publicKey.toBase58());
        }
      }).pipe(Effect.provide(adapterLayer())),
    );

    expect(endpoints.filter((url) => url.includes("primary.example.com"))).toHaveLength(3);
    expect(endpoints.filter((url) => url.includes("fallback.example.com"))).toHaveLength(4);
  });
});
