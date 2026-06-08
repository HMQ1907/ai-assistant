alter table analysis_history
  add column if not exists market_data_provider text,
  add column if not exists news_provider text,
  add column if not exists data_quality text,
  add column if not exists data_warnings jsonb default '[]'::jsonb,
  add column if not exists skipped_symbols jsonb default '[]'::jsonb,
  add column if not exists market_data_timestamp timestamptz,
  add column if not exists news_data_timestamp timestamptz;
