-- Run once in the Supabase SQL editor. Safe to run again.
create table if not exists public.shop_requests (
  id          uuid primary key,
  business    text not null,
  code        text not null,
  name        text not null,
  phone       text not null,
  address     text not null default '',
  notes       text not null default '',
  items       jsonb not null default '[]'::jsonb,
  status      text not null default 'new' check (status in ('new','seen','confirmed','done','cancelled')),
  created_at  timestamptz not null default now()
);
create index if not exists shop_requests_biz_created on public.shop_requests (business, created_at desc);

create table if not exists public.shop_content (
  business   text primary key,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);

-- Locked down: no policies at all, so the public (anon) key can read or write nothing.
-- Only the proxy, using its server-side service key, can touch these tables.
alter table public.shop_requests enable row level security;
alter table public.shop_content  enable row level security;
revoke all on public.shop_requests from anon, authenticated;
revoke all on public.shop_content  from anon, authenticated;
