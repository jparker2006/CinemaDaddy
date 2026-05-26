-- CinemaDaddy — initial schema for Google login + chat persistence.
-- Design rationale: see PLAN-auth.md §3.
--
-- How to apply: Supabase Dashboard → SQL Editor → New query → paste this whole
-- file → Run. Safe to re-run while iterating (idempotent guards on every
-- statement) but in production prefer versioned migrations via the Supabase
-- CLI rather than re-running this one.

-- ------------------------------------------------------------------
-- 1. Tables
-- ------------------------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  avatar_url  text,
  created_at  timestamptz not null default now()
);

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- messages.content holds the canonical Anthropic MessageParam.content:
-- a JSON string for text-only turns, or a ContentBlock[] for turns with
-- tool_use / tool_result blocks. Storing as jsonb round-trips to /api/chat
-- with zero translation logic.
create table if not exists public.messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role            text not null check (role in ('user', 'assistant')),
  content         jsonb not null,
  sequence        integer not null,
  created_at      timestamptz not null default now(),
  unique (conversation_id, sequence)
);

-- ------------------------------------------------------------------
-- 2. Indexes
-- ------------------------------------------------------------------

create index if not exists conversations_user_updated_idx
  on public.conversations (user_id, updated_at desc);

create index if not exists messages_conversation_sequence_idx
  on public.messages (conversation_id, sequence);

-- ------------------------------------------------------------------
-- 3. updated_at trigger on conversations
-- ------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists conversations_set_updated_at on public.conversations;
create trigger conversations_set_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

-- ------------------------------------------------------------------
-- 4. Auto-create a profiles row when a new auth.users row is inserted.
--    SECURITY DEFINER lets the trigger insert into public.profiles even
--    though the user themselves doesn't have a profiles-insert policy.
-- ------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name, avatar_url)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'full_name',
    new.raw_user_meta_data ->> 'avatar_url'
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------------
-- 5. Row Level Security
-- ------------------------------------------------------------------

alter table public.profiles      enable row level security;
alter table public.conversations enable row level security;
alter table public.messages      enable row level security;

-- profiles: read & update your own row only. Insert is handled by the
-- security-definer trigger; no end-user insert policy needed.
drop policy if exists "profiles self read"   on public.profiles;
drop policy if exists "profiles self update" on public.profiles;
create policy "profiles self read"
  on public.profiles for select
  using (auth.uid() = id);
create policy "profiles self update"
  on public.profiles for update
  using (auth.uid() = id);

-- conversations: full CRUD scoped to your own user_id.
drop policy if exists "conversations self read"   on public.conversations;
drop policy if exists "conversations self insert" on public.conversations;
drop policy if exists "conversations self update" on public.conversations;
drop policy if exists "conversations self delete" on public.conversations;
create policy "conversations self read"
  on public.conversations for select
  using (auth.uid() = user_id);
create policy "conversations self insert"
  on public.conversations for insert
  with check (auth.uid() = user_id);
create policy "conversations self update"
  on public.conversations for update
  using (auth.uid() = user_id);
create policy "conversations self delete"
  on public.conversations for delete
  using (auth.uid() = user_id);

-- messages: scoped via the parent conversation's owner. Append-only.
drop policy if exists "messages self read"   on public.messages;
drop policy if exists "messages self insert" on public.messages;
drop policy if exists "messages self delete" on public.messages;
create policy "messages self read"
  on public.messages for select
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
create policy "messages self insert"
  on public.messages for insert
  with check (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
create policy "messages self delete"
  on public.messages for delete
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id and c.user_id = auth.uid()
  ));
