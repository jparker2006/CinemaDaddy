-- Adds per-user starring to conversations + reindexes for the new sort.
-- Apply via Supabase Dashboard → SQL Editor → New query → paste → Run.

alter table public.conversations
  add column if not exists starred boolean not null default false;

-- Sidebar lists conversations sorted by (starred desc, updated_at desc) so
-- starred items float to the top. Replace the old single-axis index.
drop index if exists conversations_user_updated_idx;
create index if not exists conversations_user_starred_idx
  on public.conversations (user_id, starred desc, updated_at desc);
