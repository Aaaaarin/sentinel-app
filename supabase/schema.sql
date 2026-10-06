-- Sentinel phone app: single-owner backend.
--
-- Nothing here is readable with the public (anon) key directly: every table has
-- row level security on and no policies. The app goes through the functions
-- below, each of which checks a secret the caller must present:
--   sync key      the phone's pairing key (QR code from the laptop)
--   ingest token  the laptop's upload token
-- Only SHA-256 hashes of both are stored.

create extension if not exists pgcrypto with schema extensions;
create extension if not exists pg_net;
create extension if not exists pg_cron;

create table if not exists public.app_secrets (k text primary key, v text not null);
create table if not exists public.payloads (
  id bigserial primary key, created_at timestamptz not null default now(),
  run_date date, asof date, state text, signal_date date, payload jsonb not null);
create table if not exists public.app_state (
  id int primary key default 1 check (id = 1),
  capital numeric, slots int not null default 20, holdings jsonb not null default '[]'::jsonb,
  shot jsonb, orders_done_for date, prefs jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now());
insert into public.app_state (id) values (1) on conflict do nothing;
create table if not exists public.snapshots (id text primary key, ts bigint not null, data jsonb not null);
create table if not exists public.push_subs (
  endpoint text primary key, sub jsonb not null, created_at timestamptz not null default now(), last_ok timestamptz);
create table if not exists public.notif_log (
  id bigserial primary key, sent_at timestamptz not null default now(), kind text, dedupe text unique,
  title text, body text, delivered int);

alter table public.app_secrets enable row level security;
alter table public.payloads enable row level security;
alter table public.app_state enable row level security;
alter table public.snapshots enable row level security;
alter table public.push_subs enable row level security;
alter table public.notif_log enable row level security;

create or replace function public._sha(p text) returns text
language sql immutable set search_path = '' as $$
  select encode(extensions.digest(coalesce(p, ''), 'sha256'), 'hex')
$$;

create or replace function public._check(p_kind text, p_secret text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not exists (select 1 from public.app_secrets where k = p_kind || '_sha256' and v = public._sha(p_secret)) then
    raise exception 'not paired' using errcode = '28000';
  end if;
end $$;

-- one-time setup from the laptop; refuses once secrets exist
create or replace function public.bootstrap_secrets(p jsonb) returns text
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.app_secrets) then raise exception 'already set up'; end if;
  insert into public.app_secrets (k, v) values
    ('sync_sha256', public._sha(p->>'sync_key')),
    ('ingest_sha256', public._sha(p->>'ingest_token')),
    ('vapid_public', p->>'vapid_public'),
    ('vapid_private', p->>'vapid_private'),
    ('vapid_subject', coalesce(p->>'vapid_subject', 'mailto:sentinel@example.invalid')),
    ('notify_url', p->>'notify_url'),
    -- the Monday reminder's own token: generated here, never leaves the database
    ('cron_token', encode(extensions.gen_random_bytes(24), 'hex'));
  return 'ok';
end $$;

-- laptop -> latest market payload
create or replace function public.ingest_payload(p_token text, p_payload jsonb) returns bigint
language plpgsql security definer set search_path = '' as $$
declare new_id bigint;
begin
  perform public._check('ingest', p_token);
  insert into public.payloads (run_date, asof, state, signal_date, payload)
  values ((p_payload->>'run_date')::date, (p_payload->>'asof')::date, p_payload->>'state',
          (p_payload->'last_rebalance'->>'signal_date')::date, p_payload)
  returning id into new_id;
  delete from public.payloads where id < new_id - 30;
  return new_id;
end $$;

-- phone: everything in one call; the 200 KB payload only when it changed
create or replace function public.get_bundle(p_key text, p_have bigint default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare p record; out jsonb;
begin
  perform public._check('sync', p_key);
  select id, created_at, payload into p from public.payloads order by id desc limit 1;
  out := jsonb_build_object(
    'payload_id', p.id, 'payload_at', p.created_at,
    'payload', case when p.id is distinct from p_have then p.payload else null end,
    'state', (select to_jsonb(s) - 'id' from public.app_state s where s.id = 1),
    'snapshots', coalesce((select jsonb_agg(x.data order by x.ts) from (select data, ts from public.snapshots order by ts desc limit 300) x), '[]'::jsonb),
    'notifs', coalesce((select jsonb_agg(to_jsonb(n) - 'dedupe' order by n.id desc) from (select * from public.notif_log order by id desc limit 30) n), '[]'::jsonb),
    'vapid_public', (select v from public.app_secrets where k = 'vapid_public'),
    'subs', (select count(*) from public.push_subs));
  return out;
end $$;

create or replace function public.save_state(p_key text, p_state jsonb) returns timestamptz
language plpgsql security definer set search_path = '' as $$
declare ts timestamptz := now();
begin
  perform public._check('sync', p_key);
  update public.app_state set
    capital = nullif(p_state->>'capital', '')::numeric,
    slots = coalesce((p_state->>'slots')::int, 20),
    holdings = coalesce(p_state->'holdings', '[]'::jsonb),
    shot = p_state->'shot',
    orders_done_for = nullif(p_state->>'orders_done_for', '')::date,
    prefs = coalesce(p_state->'prefs', '{}'::jsonb),
    updated_at = ts
  where id = 1;
  return ts;
end $$;

create or replace function public.add_snapshot(p_key text, p_snap jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._check('sync', p_key);
  insert into public.snapshots (id, ts, data) values (p_snap->>'id', (p_snap->>'ts')::bigint, p_snap)
  on conflict (id) do update set data = excluded.data;
end $$;

create or replace function public.save_push_sub(p_key text, p_sub jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._check('sync', p_key);
  insert into public.push_subs (endpoint, sub) values (p_sub->>'endpoint', p_sub)
  on conflict (endpoint) do update set sub = excluded.sub;
end $$;

create or replace function public.remove_push_sub(p_key text, p_endpoint text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform public._check('sync', p_key);
  delete from public.push_subs where endpoint = p_endpoint;
end $$;

revoke all on function public._check(text, text) from public, anon, authenticated;
revoke all on function public._sha(text) from public, anon, authenticated;
grant execute on function public.bootstrap_secrets(jsonb) to anon;
grant execute on function public.ingest_payload(text, jsonb) to anon;
grant execute on function public.get_bundle(text, bigint) to anon;
grant execute on function public.save_state(text, jsonb) to anon;
grant execute on function public.add_snapshot(text, jsonb) to anon;
grant execute on function public.save_push_sub(text, jsonb) to anon;
grant execute on function public.remove_push_sub(text, text) to anon;

-- pg_cron -> notify edge function, with the server-side cron token
create or replace function public._cron_notify(p_kind text) returns bigint
language sql security definer set search_path = '' as $$
  select net.http_post(
    url := (select v from public.app_secrets where k = 'notify_url'),
    body := jsonb_build_object('kind', p_kind, 'cron', (select v from public.app_secrets where k = 'cron_token')),
    headers := '{"Content-Type": "application/json"}'::jsonb)
$$;
revoke all on function public._cron_notify(text) from public, anon, authenticated;

-- Monday 09:05 IST (03:35 UTC): reminder if the review's orders are not marked placed
select cron.schedule('sentinel-monday-reminder', '35 3 * * 1', $cron$select public._cron_notify('monday')$cron$);

-- after setup has run once: lock the bootstrap, and nothing is callable by signed-in users (there are none)
revoke execute on function public.bootstrap_secrets(jsonb) from anon, authenticated, public;
revoke execute on function public.get_bundle(text, bigint) from authenticated;
revoke execute on function public.ingest_payload(text, jsonb) from authenticated;
revoke execute on function public.save_state(text, jsonb) from authenticated;
revoke execute on function public.add_snapshot(text, jsonb) from authenticated;
revoke execute on function public.save_push_sub(text, jsonb) from authenticated;
revoke execute on function public.remove_push_sub(text, text) from authenticated;
