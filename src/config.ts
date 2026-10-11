/**
 * Environment configuration.
 *
 * Fails fast and loudly on startup if something required is missing — a service
 * that boots with a half-configured database and only fails on first request is
 * much harder to diagnose.
 */

export interface Config {
  port: number;
  supabaseUrl: string;
  supabaseServiceKey: string;
  /** Origins allowed to call the API. `*` is accepted but warned about. */
  allowedOrigins: string[];
  rpcUrls: Record<number, string>;
  /** Reject ingested swaps claiming more than this USD value. */
  maxSwapValueUsd: number;
  /** Ingestion can be disabled to run the API read-only. */
  ingestEnabled: boolean;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export function loadConfig(): Config {
  const supabaseUrl = required("SUPABASE_URL");
  const supabaseServiceKey = required("SUPABASE_SERVICE_ROLE_KEY");

  // The anon key is safe to expose; the service-role key is not. Catching a
  // mix-up here is cheaper than discovering it when writes silently fail.
  if (supabaseServiceKey.length < 40) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY looks too short — is it the anon key by mistake?",
    );
  }

  const origins = (process.env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);

  if (origins.includes("*")) {
    console.warn(
      "[config] ALLOWED_ORIGINS is '*' — fine for local development, but set it to your site's origin in production.",
    );
  }

  return {
    port: Number(process.env.PORT ?? 8787),
    supabaseUrl,
    supabaseServiceKey,
    allowedOrigins: origins,
    rpcUrls: {
      8453: process.env.RPC_URL_8453?.trim() || "https://mainnet.base.org",
      84532: process.env.RPC_URL_84532?.trim() || "https://sepolia.base.org",
    },
    maxSwapValueUsd: Number(process.env.MAX_SWAP_VALUE_USD ?? 10_000_000),
    ingestEnabled: (process.env.INGEST_ENABLED ?? "true") !== "false",
  };
}
