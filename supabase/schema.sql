create extension if not exists "pgcrypto";

create table if not exists public.users (
  id uuid primary key default gen_random_uuid(),
  google_id text not null unique,
  email text not null unique,
  full_name text,
  avatar_url text,
  phone text,
  timezone text default 'UTC',
  subscription_status text default 'trialing' check (subscription_status in ('trialing', 'active', 'past_due', 'canceled')),
  google_access_token text,
  google_refresh_token text,
  google_token_expiry timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.brief_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  event_id text not null,
  attendee_email text not null,
  dedupe_key text not null unique,
  body text not null,
  created_at timestamptz not null default now()
);

alter table public.users enable row level security;
alter table public.brief_logs enable row level security;
