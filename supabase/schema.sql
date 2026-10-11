-- Analytics schema for the EightX swap dashboard.
--
-- Run this against your Supabase project (SQL Editor, or `supabase db push`).
-- Re-running is safe: tables use `create table if not exists` so existing data is
-- never touched, and each function is dropped before being recreated. The drops
-- matter — `create or replace` cannot change a function's return type, so without
-- them a re-run fails with 42P13 as soon as a returned column is added.
--
-- Security model: the API talks to Postgres with the service-role key, which
-- bypasses RLS. RLS is enabled on both tables with NO public policies, so the
-- anon/public key can read nothing directly — all access goes through the API,
-- which is where verification and rate limiting live.

-- ---------------------------------------------------------------------------
-- swaps: one row per on-chain-verified swap
-- ---------------------------------------------------------------------------
create table if not exists public.swaps (
  tx_hash            text primary key,
  chain_id           integer     not null,
  account            text        not null,
  token_in_symbol    text        not null,
  token_out_symbol   text        not null,
  token_in_address   text        not null,
  token_out_address  text        not null,
  -- numeric, not float: token amounts need exact decimal arithmetic.
  amount_in          numeric(78, 18) not null default 0,
  amount_out         numeric(78, 18) not null default 0,
  value_usd          numeric(38, 6)  not null default 0,
  block_number       bigint,
  -- Block timestamp taken from chain, never from the client.
  occurred_at        timestamptz not null,
  created_at         timestamptz not null default now(),

  constraint swaps_amounts_non_negative
    check (amount_in >= 0 and amount_out >= 0 and value_usd >= 0)
);

create index if not exists swaps_occurred_at_idx on public.swaps (occurred_at desc);
create index if not exists swaps_account_idx     on public.swaps (account);
create index if not exists swaps_chain_idx       on public.swaps (chain_id);

-- ---------------------------------------------------------------------------
-- users: one row per distinct wallet that has swapped
-- ---------------------------------------------------------------------------
create table if not exists public.users (
  account      text primary key,
  first_seen   timestamptz not null default now(),
  last_seen    timestamptz not null default now(),
  swap_count   integer     not null default 0,
  volume_usd   numeric(38, 6) not null default 0
);

create index if not exists users_last_seen_idx on public.users (last_seen desc);

-- ---------------------------------------------------------------------------
-- Keep `users` in step with `swaps` automatically, so the API only ever has to
-- insert a swap. Doing this in a trigger means the two can never disagree, even
-- if a second writer is added later.
-- ---------------------------------------------------------------------------
create or replace function public.sync_user_from_swap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (account, first_seen, last_seen, swap_count, volume_usd)
  values (new.account, new.occurred_at, new.occurred_at, 1, new.value_usd)
  on conflict (account) do update
    set last_seen  = greatest(public.users.last_seen, excluded.last_seen),
        first_seen = least(public.users.first_seen, excluded.first_seen),
        swap_count = public.users.swap_count + 1,
        volume_usd = public.users.volume_usd + excluded.volume_usd;
  return new;
end;
$$;

drop trigger if exists swaps_sync_user on public.swaps;
create trigger swaps_sync_user
  after insert on public.swaps
  for each row execute function public.sync_user_from_swap();

-- ---------------------------------------------------------------------------
-- Record a wallet connection.
--
-- A user counts from the moment they connect, not from their first trade, so a
-- row is created on connect with zero swaps and zero volume. `swap_count > 0` is
-- what distinguishes someone who actually traded from someone who only looked.
--
-- On conflict only `last_seen` moves: `first_seen`, `swap_count` and `volume_usd`
-- must survive, or reconnecting would wipe a user's trading history.
-- ---------------------------------------------------------------------------
drop function if exists public.record_user_connection(text);
create or replace function public.record_user_connection(p_account text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (account, first_seen, last_seen, swap_count, volume_usd)
  values (p_account, now(), now(), 0, 0)
  on conflict (account) do update
    set last_seen = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Headline stats in a single round trip.
--
-- Dropped before creating: `create or replace` cannot change a function's return
-- type, so adding a column to the returned row fails with 42P13 on an existing
-- deployment. Dropping first is what keeps this file re-runnable as the shape
-- evolves. Safe here because nothing else depends on these functions.
-- ---------------------------------------------------------------------------
drop function if exists public.get_platform_stats();
create or replace function public.get_platform_stats()
returns table (
  total_users          bigint,
  active_users_24h     bigint,
  -- Users who have actually traded. `total_users` counts everyone who connected
  -- a wallet, so this is what separates interest from activity.
  trading_users        bigint,
  total_swaps          bigint,
  swaps_24h            bigint,
  volume_usd_24h       numeric,
  volume_usd_all_time  numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from public.users),
    (select count(*) from public.users where last_seen > now() - interval '24 hours'),
    (select count(*) from public.users where swap_count > 0),
    (select count(*) from public.swaps),
    (select count(*) from public.swaps where occurred_at > now() - interval '24 hours'),
    (select coalesce(sum(value_usd), 0) from public.swaps where occurred_at > now() - interval '24 hours'),
    (select coalesce(sum(value_usd), 0) from public.swaps);
$$;

-- ---------------------------------------------------------------------------
-- Per-chain split.
--
-- The headline figures above intentionally aggregate every supported chain, so
-- mainnet and testnet activity are counted together. That makes the totals a
-- measure of app usage rather than of real economic value — testnet tokens are
-- worthless — so this breakdown exists to keep the aggregate interpretable.
-- ---------------------------------------------------------------------------
drop function if exists public.get_chain_breakdown();
create or replace function public.get_chain_breakdown()
returns table (
  chain_id   integer,
  swaps      bigint,
  volume_usd numeric,
  users      bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    s.chain_id,
    count(*)                        as swaps,
    coalesce(sum(s.value_usd), 0)   as volume_usd,
    count(distinct s.account)       as users
  from public.swaps s
  group by s.chain_id
  order by volume_usd desc;
$$;

-- ---------------------------------------------------------------------------
-- Daily volume series. Uses generate_series so quiet days appear as zero rather
-- than being missing, which would make the chart lie about its own x-axis.
-- ---------------------------------------------------------------------------
drop function if exists public.get_daily_volume(integer);
create or replace function public.get_daily_volume(days integer default 30)
returns table (
  day        date,
  volume_usd numeric,
  swaps      bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with bounds as (
    select greatest(1, least(coalesce(days, 30), 365)) as n
  ),
  calendar as (
    select generate_series(
      (current_date - ((select n from bounds) - 1)),
      current_date,
      interval '1 day'
    )::date as day
  )
  select
    calendar.day,
    coalesce(sum(s.value_usd), 0) as volume_usd,
    count(s.tx_hash)              as swaps
  from calendar
  left join public.swaps s
    on s.occurred_at >= calendar.day
   and s.occurred_at <  calendar.day + interval '1 day'
  group by calendar.day
  order by calendar.day;
$$;

-- ---------------------------------------------------------------------------
-- Lock the tables down. The service-role key bypasses RLS; nothing else gets in.
-- ---------------------------------------------------------------------------
alter table public.swaps enable row level security;
alter table public.users enable row level security;

-- ---------------------------------------------------------------------------
-- Tell PostgREST to reload.
--
-- Supabase serves these functions through PostgREST, which caches the schema.
-- A function added in this script is invisible until that cache refreshes, and
-- the symptom is a confusing "Could not find the function ... in the schema
-- cache" from an API that is otherwise healthy. Supabase normally reloads on its
-- own, but asking costs nothing and removes the race.
-- ---------------------------------------------------------------------------
notify pgrst, 'reload schema';
