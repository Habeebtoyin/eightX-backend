/**
 * Supabase access.
 *
 * Uses the service-role key, which bypasses RLS — so this module must only ever
 * run server-side, and the key must never be sent to a browser.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Config } from "./config.js";

export interface SwapRow {
  tx_hash: string;
  chain_id: number;
  account: string;
  token_in_symbol: string;
  token_out_symbol: string;
  token_in_address: string;
  token_out_address: string;
  amount_in: string;
  amount_out: string;
  value_usd: string;
  block_number: number | null;
  occurred_at: string;
}

export function createDb(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export interface PlatformStatsRow {
  total_users: number;
  active_users_24h: number;
  trading_users: number;
  total_swaps: number;
  swaps_24h: number;
  volume_usd_24h: string;
  volume_usd_all_time: string;
}

export async function getPlatformStats(
  db: SupabaseClient,
): Promise<PlatformStatsRow> {
  const { data, error } = await db.rpc("get_platform_stats");
  if (error) throw new Error(`get_platform_stats failed: ${error.message}`);

  // The function returns a single row; Supabase hands it back as an array.
  const row = Array.isArray(data) ? data[0] : data;
  return (
    row ?? {
      total_users: 0,
      active_users_24h: 0,
      trading_users: 0,
      total_swaps: 0,
      swaps_24h: 0,
      volume_usd_24h: "0",
      volume_usd_all_time: "0",
    }
  );
}

/**
 * Records a wallet connection, creating the user if they are new.
 *
 * Idempotent: reconnecting only moves `last_seen`, so a user's `first_seen` and
 * trading history survive.
 */
export async function recordUserConnection(
  db: SupabaseClient,
  account: string,
): Promise<void> {
  const { error } = await db.rpc("record_user_connection", {
    p_account: account,
  });
  if (error) throw new Error(`record_user_connection failed: ${error.message}`);
}

export interface ChainBreakdownRow {
  chain_id: number;
  swaps: number;
  volume_usd: string;
  users: number;
}

export async function getChainBreakdown(
  db: SupabaseClient,
): Promise<ChainBreakdownRow[]> {
  const { data, error } = await db.rpc("get_chain_breakdown");
  if (error) throw new Error(`get_chain_breakdown failed: ${error.message}`);
  return (data ?? []) as ChainBreakdownRow[];
}

export interface DailyVolumeRow {
  day: string;
  volume_usd: string;
  swaps: number;
}

export async function getDailyVolume(
  db: SupabaseClient,
  days: number,
): Promise<DailyVolumeRow[]> {
  const { data, error } = await db.rpc("get_daily_volume", { days });
  if (error) throw new Error(`get_daily_volume failed: ${error.message}`);
  return (data ?? []) as DailyVolumeRow[];
}

export async function getRecentSwaps(
  db: SupabaseClient,
  limit: number,
): Promise<SwapRow[]> {
  const { data, error } = await db
    .from("swaps")
    .select(
      "tx_hash, chain_id, account, token_in_symbol, token_out_symbol, token_in_address, token_out_address, amount_in, amount_out, value_usd, block_number, occurred_at",
    )
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`recent swaps query failed: ${error.message}`);
  return (data ?? []) as SwapRow[];
}

/**
 * Inserts a swap, treating a duplicate tx_hash as success rather than an error —
 * the client may retry, and a swap is naturally idempotent on its hash.
 */
export async function insertSwap(
  db: SupabaseClient,
  row: SwapRow,
): Promise<{ inserted: boolean }> {
  const { error } = await db.from("swaps").insert(row);

  if (!error) return { inserted: true };
  // 23505 = unique_violation
  if (error.code === "23505") return { inserted: false };

  throw new Error(`insert swap failed: ${error.message}`);
}
