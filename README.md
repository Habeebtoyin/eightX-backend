# EightX analytics backend

Supabase-backed API that feeds the `/dashboard` page real numbers instead of
sample data.

It serves exactly the contract the frontend already expects
(`app/analytics/types.ts`), so switching from sample data to live data is a single
config change on the frontend — no frontend code changes.

## Setup

**1. Create the database tables**

In your Supabase project, open the SQL Editor and run
[`supabase/schema.sql`](supabase/schema.sql). It is idempotent, so re-running is
safe. It creates:

- `swaps` — one row per verified swap
- `users` — one row per distinct wallet, kept in sync by a trigger on `swaps`
- `get_platform_stats()` and `get_daily_volume(days)` — the dashboard's two
  aggregate queries, each a single round trip
- RLS enabled on both tables with **no public policies**, so only this service
  (via the service-role key) can read or write

**2. Configure**

```sh
cd backend
cp .env.example .env
```

Fill in `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from
*Project Settings → API*. Use the **service role** key (the newer `sb_secret_…`
format works too), not the anon/publishable key — it bypasses RLS and must never
reach a browser.

`.env` is loaded automatically via `dotenv` (imported first in `src/index.ts`, so
it populates `process.env` before the config is read).

**3. Run**

```sh
npm install
npm run dev     # http://localhost:8787
```

**4. Point the frontend at it**

In `public/config.js`:

```js
"VITE_ANALYTICS_API_URL": "http://localhost:8787"
```

The "Sample data — not real" banner disappears as soon as a real endpoint
responds. No rebuild needed: that file is runtime config.

## Endpoints

| Method | Path                | Purpose |
| ------ | ------------------- | ------- |
| `GET`  | `/health`           | Liveness + database reachability |
| `GET`  | `/stats`            | Headline figures |
| `GET`  | `/volume?days=30`   | Daily volume series (1–365) |
| `GET`  | `/swaps?limit=25`   | Recent swaps (1–100) |
| `POST` | `/swaps`            | Record a swap — verified on-chain first |
| `POST` | `/users`            | Record a wallet connection |

Money and token amounts are serialised as **decimal strings**, not JSON numbers:
a float cannot hold a wei-precision amount without rounding.

## How data gets in

The frontend calls `POST /swaps` after a swap confirms
(`app/analytics/report.ts`), fire-and-forget so analytics can never delay or
break a trade.

It also calls `POST /users` as soon as a wallet connects, so **a user counts from
connection, not from their first trade**. The address is the primary key, so
reconnecting only refreshes `last_seen` and can never inflate the count, and the
client deduplicates per page load as well.

`/stats` therefore reports two different populations, and the dashboard shows
both: `totalUsers` is everyone who connected, `tradingUsers` is the subset who
actually swapped.

### Connections are not provable

A swap can be verified on-chain; a connection cannot — there is no transaction to
check, so `POST /users` has to take the address on trust. The defences are that
duplicates collapse on the primary key and the endpoint is rate limited (20
requests per minute per IP, in-memory). Someone determined could still register
generated addresses and inflate `totalUsers`.

If that figure ever needs to be trustworthy, have the wallet sign a nonce on
connect and verify it server-side with `verifyMessage` — that proves control of
the address, at the cost of a signature prompt on every connect. It was left out
because that prompt is a real UX tax for a metric that is usually directional.
`tradingUsers` is the hard number; prefer it when the distinction matters.

### Trust boundary — please read

A client could POST fabricated swaps, so before writing a row the service
verifies against the chain that:

1. the transaction exists and succeeded
2. it was sent **by** the account being credited
3. it was sent **to** our Universal Router or PositionManager
4. its timestamp comes from the block, never from the request

`tx_hash` is the primary key, so replaying the same swap cannot inflate totals.

**USD value is computed here, not accepted from the client.** Any `valueUsd` in
the request body is ignored outright. `src/pricing.ts` prices each swap from, in
order of preference:

1. **Chainlink feeds** — ETH, BTC, USDC and DAI, all verified live on Base
2. **$1 for known stablecoins** when no feed exists (all of Base Sepolia)
3. **The Uniswap v4 quoter**, pricing the token into USDC — this is what values
   tokens with no feed at all, including ones you deployed yourself

Prices are cached for 60s. Volatile feeds are rejected if older than 6h; stablecoin
feeds are allowed up to 7 days, because they only publish on deviation and sit
~19h stale in normal operation — applying the volatile limit to them would throw
away good prices.

Whichever side of the swap can be priced most confidently wins: a stablecoin leg
is exact, a Chainlink-backed asset next, a quoted token last. Anything unpriceable
is stored as 0 rather than guessed.

**What is still client-supplied:** the token *amounts* and symbols. The
transaction is proven genuine and the price is ours, but a determined actor could
misreport how much moved in a real swap of their own. `MAX_SWAP_VALUE_USD` caps
the damage. Closing this fully means decoding the pool's `Swap` event from the
receipt — the remaining known follow-up. If you need tamper-proof volume today,
set `INGEST_ENABLED=false` and populate `swaps` from an indexer; the read
endpoints do not care where rows came from.

### Chains are aggregated

The headline figures intentionally span **every** chain, so Base mainnet and Base
Sepolia are counted together — none of the stats queries filter by `chain_id`.
`get_chain_breakdown()` returns the split, which `/stats` includes as
`chainBreakdown` and the dashboard renders under "By network".

Testnet tokens have no market value, so a combined total measures *activity*, not
revenue. The dashboard says so when testnet rows are present. To report mainnet
only, add `where chain_id = 8453` to the stats functions in `schema.sql`.

## Deploying

Any Node 20+ host works (Railway, Fly, Render, a container). Set the same
environment variables, and set `ALLOWED_ORIGINS` to your real site origin rather
than `*`.

Supabase Edge Functions are a reasonable alternative if you would rather not run a
process — the SQL and the endpoint contract carry over unchanged; only the HTTP
layer in `src/index.ts` would need porting to Deno.
