-- Supabase setup for AI Trading Assistant.
-- Run this file once in Supabase SQL Editor. It is safe to re-run.

create extension if not exists pgcrypto;

create table if not exists analysis_history (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  request_payload jsonb not null,
  ai_response_raw text not null,
  parsed_result jsonb not null,
  decision text not null,
  symbol text not null,
  direction text not null,
  confidence int not null,
  entry_from numeric not null,
  entry_to numeric not null,
  stop_loss numeric not null,
  take_profit numeric not null,
  result_status text not null default 'PENDING',
  actual_entry numeric,
  actual_exit numeric,
  actual_profit_loss numeric,
  user_note text,
  market_data_provider text,
  news_provider text,
  data_quality text,
  data_warnings jsonb default '[]'::jsonb,
  skipped_symbols jsonb default '[]'::jsonb,
  market_data_timestamp timestamptz,
  news_data_timestamp timestamptz,
  constraint analysis_history_result_status_check
    check (result_status in ('PENDING', 'WIN', 'LOSS', 'BREAKEVEN', 'SKIPPED'))
);

alter table analysis_history
  add column if not exists market_data_provider text,
  add column if not exists news_provider text,
  add column if not exists data_quality text,
  add column if not exists data_warnings jsonb default '[]'::jsonb,
  add column if not exists skipped_symbols jsonb default '[]'::jsonb,
  add column if not exists market_data_timestamp timestamptz,
  add column if not exists news_data_timestamp timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'analysis_history_result_status_check'
      and conrelid = 'analysis_history'::regclass
  ) then
    alter table analysis_history
      add constraint analysis_history_result_status_check
      check (result_status in ('PENDING', 'WIN', 'LOSS', 'BREAKEVEN', 'SKIPPED'));
  end if;
end $$;

create index if not exists analysis_history_created_at_idx
  on analysis_history (created_at desc);

create index if not exists analysis_history_symbol_idx
  on analysis_history (symbol);

create index if not exists analysis_history_result_status_idx
  on analysis_history (result_status);
