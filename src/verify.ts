/**
 * On-chain verification for ingested swaps.
 *
 * TRUST BOUNDARY — read this before changing anything here.
 *
 * The client reports a swap it just made. Without checks, anyone could POST
 * fabricated volume and inflate the dashboard. So before a row is written we
 * confirm, against the chain:
 *
 *   1. the transaction exists and succeeded
 *   2. it was sent BY the account being credited
 *   3. it was sent TO our Universal Router (not some unrelated transfer)
 *   4. its timestamp comes from the block, never from the request
 *
 * What is still client-supplied: token symbols and the USD valuation. Those are
 * display metadata — a determined actor could overstate `value_usd` on a real
 * swap of their own. The honest fix is to decode the pool's Swap event and price
 * it server-side; that is a known follow-up, not something to pretend is done.
 * `MAX_SWAP_VALUE_USD` caps the blast radius in the meantime.
 */

import {
  createPublicClient,
  http,
  isAddress,
  type Address,
  type PublicClient,
} from "viem";
import { base, baseSepolia } from "viem/chains";
import type { Config } from "./config.js";

/** Universal Router 2.1.2 per chain — the only valid `to` for a swap. */
const UNIVERSAL_ROUTER: Record<number, Address> = {
  8453: "0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40",
  84532: "0x8702463e73f74d0b6765aBceb314Ef07aCb92650",
};

/** PositionManager per chain — accepted so liquidity txs can be ingested too. */
const POSITION_MANAGER: Record<number, Address> = {
  8453: "0x7C5f5A4bBd8fD63184577525326123B519429bDc",
  84532: "0x4B2C77d209D3405F41a037Ec6c77F7F5b8e2ca80",
};

const CHAINS = { 8453: base, 84532: baseSepolia } as const;

export type SupportedChainId = keyof typeof CHAINS;

export function isSupportedChain(id: number): id is SupportedChainId {
  return id === 8453 || id === 84532;
}

export class VerificationError extends Error {
  constructor(
    message: string,
    readonly status: number = 400,
  ) {
    super(message);
    this.name = "VerificationError";
  }
}

export interface VerifiedTx {
  account: Address;
  blockNumber: bigint;
  occurredAt: Date;
}

// Typed as the generic `PublicClient` rather than the inferred return type: the
// two chains produce structurally different client types (Base has deposit
// transactions in its block type), so the inferred union is not assignable to
// itself. The cast is safe — only chain-agnostic reads are used below.
const clients = new Map<number, PublicClient>();

function clientFor(chainId: SupportedChainId, config: Config): PublicClient {
  const cached = clients.get(chainId);
  if (cached) return cached;

  const client = createPublicClient({
    chain: CHAINS[chainId],
    transport: http(config.rpcUrls[chainId], { retryCount: 2, timeout: 15_000 }),
  }) as PublicClient;

  clients.set(chainId, client);
  return client;
}

export async function verifySwapTransaction(params: {
  config: Config;
  chainId: number;
  txHash: string;
  account: string;
}): Promise<VerifiedTx> {
  const { config, chainId, txHash, account } = params;

  if (!isSupportedChain(chainId)) {
    throw new VerificationError(`Unsupported chain ${chainId}`);
  }
  if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
    throw new VerificationError("Malformed transaction hash");
  }
  if (!isAddress(account)) {
    throw new VerificationError("Malformed account address");
  }

  const client = clientFor(chainId, config);

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({
      hash: txHash as `0x${string}`,
    });
  } catch {
    // Not yet mined, or not on this chain at all.
    throw new VerificationError(
      "Transaction not found on chain. It may still be pending.",
      404,
    );
  }

  if (receipt.status !== "success") {
    throw new VerificationError("Transaction reverted on chain");
  }

  // (2) credited account must be the sender
  if (receipt.from.toLowerCase() !== account.toLowerCase()) {
    throw new VerificationError(
      "Transaction was not sent by the reported account",
      403,
    );
  }

  // (3) must target one of our contracts
  const target = receipt.to?.toLowerCase();
  const allowed = [
    UNIVERSAL_ROUTER[chainId]?.toLowerCase(),
    POSITION_MANAGER[chainId]?.toLowerCase(),
  ].filter(Boolean);

  if (!target || !allowed.includes(target)) {
    throw new VerificationError(
      "Transaction did not target this application's contracts",
      403,
    );
  }

  // (4) timestamp from the block, not the request
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });

  return {
    account: receipt.from,
    blockNumber: receipt.blockNumber,
    occurredAt: new Date(Number(block.timestamp) * 1000),
  };
}
