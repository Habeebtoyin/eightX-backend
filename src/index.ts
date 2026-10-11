/**
 * Analytics API for the EightX dashboard.
 *
 * Serves exactly the contract the frontend expects (app/analytics/types.ts):
 *
 *   GET  /stats            -> PlatformStats
 *   GET  /volume?days=30   -> VolumePoint[]
 *   GET  /swaps?limit=25   -> SwapRecord[]
 *   POST /swaps            -> record a swap (verified on-chain first)
 *   GET  /health           -> liveness + database reachability
 *
 * Amounts are serialised as decimal strings, matching the frontend contract: a
 * JSON number cannot hold a wei-precision value without rounding.
 */

// Loads .env into process.env before anything reads it. This import must stay
// first: `loadConfig()` runs at module scope below, and ESM evaluates imports in
// order, so moving it would leave the config empty.
import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { loadConfig } from "./config.js";
import {
  createDb,
  getChainBreakdown,
  getDailyVolume,
  getPlatformStats,
  getRecentSwaps,
  insertSwap,
  recordUserConnection,
} from "./db.js";
import { valueSwapUsd } from "./pricing.js";
import { isSupportedChain, verifySwapTransaction, VerificationError } from "./verify.js";

const config = loadConfig();
const db = createDb(config);
const app = new Hono();

app.use(
  "*",
  cors({
    origin: config.allowedOrigins.includes("*") ? "*" : config.allowedOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86_400,
  }),
);

/** Clamp a query param into a sane range; never trust the caller's number. */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number) {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

app.get("/health", async (c) => {
  try {
    const { error } = await db.from("swaps").select("tx_hash").limit(1);
    if (error) throw new Error(error.message);
    return c.json({ ok: true, database: "reachable" });
  } catch (error) {
    return c.json(
      { ok: false, database: "unreachable", error: String(error) },
      503,
    );
  }
});

app.get("/stats", async (c) => {
  try {
    // Headline figures deliberately span every chain; the breakdown keeps that
    // aggregate interpretable rather than hiding where the volume came from.
    const [row, breakdown] = await Promise.all([
      getPlatformStats(db),
      getChainBreakdown(db).catch(() => []),
    ]);

    return c.json({
      totalUsers: Number(row.total_users ?? 0),
      activeUsers24h: Number(row.active_users_24h ?? 0),
      tradingUsers: Number(row.trading_users ?? 0),
      totalSwaps: Number(row.total_swaps ?? 0),
      swaps24h: Number(row.swaps_24h ?? 0),
      volumeUsd24h: String(row.volume_usd_24h ?? "0"),
      volumeUsdAllTime: String(row.volume_usd_all_time ?? "0"),
      chainBreakdown: breakdown.map((chain) => ({
        chainId: Number(chain.chain_id),
        swaps: Number(chain.swaps ?? 0),
        volumeUsd: String(chain.volume_usd ?? "0"),
        users: Number(chain.users ?? 0),
      })),
      updatedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[stats]", error);
    return c.json({ error: "Failed to load stats" }, 500);
  }
});

app.get("/volume", async (c) => {
  const days = clampInt(c.req.query("days"), 30, 1, 365);
  try {
    const rows = await getDailyVolume(db, days);
    return c.json(
      rows.map((row) => ({
        date: String(row.day).slice(0, 10),
        volumeUsd: String(row.volume_usd ?? "0"),
        swaps: Number(row.swaps ?? 0),
      })),
    );
  } catch (error) {
    console.error("[volume]", error);
    return c.json({ error: "Failed to load volume" }, 500);
  }
});

app.get("/swaps", async (c) => {
  const limit = clampInt(c.req.query("limit"), 25, 1, 100);
  try {
    const rows = await getRecentSwaps(db, limit);
    return c.json(
      rows.map((row) => ({
        txHash: row.tx_hash,
        chainId: row.chain_id,
        account: row.account,
        tokenInSymbol: row.token_in_symbol,
        tokenOutSymbol: row.token_out_symbol,
        amountIn: String(row.amount_in ?? "0"),
        amountOut: String(row.amount_out ?? "0"),
        valueUsd: String(row.value_usd ?? "0"),
        timestamp: new Date(row.occurred_at).toISOString(),
      })),
    );
  } catch (error) {
    console.error("[swaps]", error);
    return c.json({ error: "Failed to load swaps" }, 500);
  }
});

/** Trim and clamp a client-supplied label before it reaches the database. */
function label(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  let out = "";
  for (const char of value) {
    const cp = char.codePointAt(0);
    if (cp === undefined) continue;
    if (cp <= 0x1f) continue;
    if (cp >= 0x7f && cp <= 0x9f) continue;
    if (cp >= 0x200b && cp <= 0x200f) continue;
    if (cp >= 0x202a && cp <= 0x202e) continue;
    if (cp === 0x2028 || cp === 0x2029 || cp === 0xfeff) continue;
    out += char;
  }
  return out.trim().slice(0, 24) || fallback;
}

/** Decimal string or 0. Rejects scientific notation and anything non-numeric. */
function decimal(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value.toFixed(18).replace(/0+$/, "").replace(/\.$/, "") || "0";
  }
  if (typeof value !== "string") return "0";
  const trimmed = value.trim();
  return /^\d+(\.\d+)?$/.test(trimmed) ? trimmed : "0";
}

app.post("/swaps", async (c) => {
  if (!config.ingestEnabled) {
    return c.json({ error: "Ingestion is disabled" }, 403);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const txHash = String(body.txHash ?? "");
  const chainId = Number(body.chainId);
  const account = String(body.account ?? "");

  try {
    // Everything that matters is confirmed against the chain, not the request.
    const verified = await verifySwapTransaction({
      config,
      chainId,
      txHash,
      account,
    });

    const amountIn = decimal(body.amountIn);
    const amountOut = decimal(body.amountOut);

    // Priced here, from Chainlink feeds and the on-chain quoter. Any `valueUsd`
    // in the request body is ignored outright — a client-supplied dollar figure
    // is trivially inflated, and previously it was never even sent, so every row
    // landed at $0.
    const valuation = isSupportedChain(chainId)
      ? await valueSwapUsd({
          config,
          chainId,
          tokenInSymbol: label(body.tokenInSymbol, "???"),
          tokenOutSymbol: label(body.tokenOutSymbol, "???"),
          tokenInAddress: String(body.tokenInAddress ?? ""),
          tokenOutAddress: String(body.tokenOutAddress ?? ""),
          amountIn,
          amountOut,
          decimalsIn: Number(body.decimalsIn) || undefined,
          decimalsOut: Number(body.decimalsOut) || undefined,
        })
      : { valueUsd: 0, source: "none" as const };

    // A value above the cap means a bad price read, not a real trade of that size.
    const valueUsd = Math.min(valuation.valueUsd, config.maxSwapValueUsd);

    const { inserted } = await insertSwap(db, {
      tx_hash: txHash.toLowerCase(),
      chain_id: chainId,
      account: verified.account.toLowerCase(),
      token_in_symbol: label(body.tokenInSymbol, "???"),
      token_out_symbol: label(body.tokenOutSymbol, "???"),
      token_in_address: label(body.tokenInAddress, ""),
      token_out_address: label(body.tokenOutAddress, ""),
      amount_in: amountIn,
      amount_out: amountOut,
      value_usd: valueUsd.toFixed(6),
      block_number: Number(verified.blockNumber),
      occurred_at: verified.occurredAt.toISOString(),
    });

    return c.json(
      {
        ok: true,
        recorded: inserted,
        valueUsd: valueUsd.toFixed(2),
        pricedFrom: valuation.source,
      },
      inserted ? 201 : 200,
    );
  } catch (error) {
    if (error instanceof VerificationError) {
      return c.json({ error: error.message }, error.status as 400);
    }
    console.error("[ingest]", error);
    return c.json({ error: "Failed to record swap" }, 500);
  }
});

/**
 * Rate limiter for wallet connections.
 *
 * Unlike a swap there is no transaction to verify here, so this is the only
 * thing standing between the user count and someone POSTing generated addresses
 * in a loop. In-memory and per-process — good enough for a single instance; move
 * it to Redis or the edge if this is ever load balanced.
 */
const connectHits = new Map<string, { count: number; resetAt: number }>();
const CONNECT_WINDOW_MS = 60_000;
const CONNECT_MAX_PER_WINDOW = 20;

function rateLimited(key: string): boolean {
  const now = Date.now();
  const entry = connectHits.get(key);

  if (!entry || entry.resetAt < now) {
    connectHits.set(key, { count: 1, resetAt: now + CONNECT_WINDOW_MS });
    // Opportunistic cleanup so the map cannot grow without bound.
    if (connectHits.size > 10_000) {
      for (const [k, v] of connectHits) if (v.resetAt < now) connectHits.delete(k);
    }
    return false;
  }

  entry.count += 1;
  return entry.count > CONNECT_MAX_PER_WINDOW;
}

/**
 * Records a wallet connection.
 *
 * A user counts from the moment they connect, whether or not they ever trade.
 * Repeat connections from the same address only refresh `last_seen` — the
 * address is the primary key, so reconnecting cannot inflate the count.
 *
 * See the trust note in the README: this cannot be proven on-chain the way a
 * swap can, so the connected-user figure is softer than the trading-user figure
 * that sits beside it.
 */
app.post("/users", async (c) => {
  if (!config.ingestEnabled) {
    return c.json({ error: "Ingestion is disabled" }, 403);
  }

  const clientKey =
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("cf-connecting-ip") ||
    "unknown";

  if (rateLimited(clientKey)) {
    return c.json({ error: "Too many requests" }, 429);
  }

  let body: Record<string, unknown>;
  try {
    body = (await c.req.json()) as Record<string, unknown>;
  } catch {
    return c.json({ error: "Body must be JSON" }, 400);
  }

  const account = String(body.account ?? "").trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) {
    return c.json({ error: "Malformed account address" }, 400);
  }

  try {
    await recordUserConnection(db, account.toLowerCase());
    return c.json({ ok: true });
  } catch (error) {
    console.error("[connect]", error);
    return c.json({ error: "Failed to record connection" }, 500);
  }
});

app.notFound((c) => c.json({ error: "Not found" }, 404));

serve({ fetch: app.fetch, port: config.port }, (info) => {
  console.log(`[analytics] listening on http://localhost:${info.port}`);
  console.log(`[analytics] ingestion ${config.ingestEnabled ? "enabled" : "disabled"}`);
});
