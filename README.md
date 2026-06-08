# AI Trading Assistant

Nuxt fullstack MVP for a manual AI trading assistant. The system analyzes market/news data, asks an AI model for a JSON recommendation, validates the answer locally, stores history in Supabase, and shows performance stats.

This is not an auto trading bot. It never places orders, never connects to a broker to trade, and never decides Buy/Sell for the user. The user must trade manually outside the system.

## Setup

```bash
npm install
cp .env.example .env
```

Configure `.env`:

```bash
EVOLINK_API_KEY=
EVOLINK_MODEL=claude-opus-4.8
EVOLINK_BASE_URL=https://api.evolink.ai/v1/chat/completions
AI_TIMEOUT_MS=90000
MARKET_DATA_PROVIDER=mock
NEWS_PROVIDER=mock
SUPABASE_URL=
SUPABASE_SERVICE_ROLE_KEY=
```

`SUPABASE_SERVICE_ROLE_KEY` is server-only runtime config. Do not expose it to client code.

## Supabase

1. Create a Supabase project.
2. Open the SQL editor.
3. Run `supabase/migrations/001_analysis_history.sql`.
4. Copy the project URL into `SUPABASE_URL`.
5. Copy the service role key into `SUPABASE_SERVICE_ROLE_KEY`.

To migrate from the old SQLite MVP, export old rows manually and insert them into `analysis_history`. The old `entry` JSON field maps to `entry_from` and `entry_to`; old numeric IDs are replaced by Supabase UUIDs. SQLite files and `DATABASE_PATH` are no longer used.

## Run

```bash
npm run dev
```

Open the local Nuxt URL and click Analyze. If `EVOLINK_API_KEY` is empty, `AiAnalysisService` returns a valid mock `NO_TRADE` response.

## Test Flow

1. Analyze: click Analyze on `/` and confirm a recommendation, symbol scores, and history row appear.
2. History: open `/history`, update actual entry, actual exit, P/L, status, and note.
3. Stats: open `/stats` and confirm totals, win rate, confidence stats, and symbol performance update.
4. Typecheck: run `npm run typecheck`.

## Validation

AI output is parsed as JSON, validated with Zod, then checked by `TradeValidationService`. If any local rule fails, the result is forced to `NO_TRADE` and the reason is added to `invalid_conditions` and `no_trade_reason`.

Rules are defined in `server/config/tradingRules.ts`:

- minimum confidence
- minimum risk reward
- account size
- risk percent
- maximum holding minutes

The validator blocks trades when confidence is too low, risk reward is too low, direction is invalid, entry/SL/TP are zero, or BUY/SELL levels are logically wrong.

## Evolink

The service expects an OpenAI-compatible chat completion response. If Evolink uses a different contract, update `server/services/AiAnalysisService.ts`.

## Replacing Mock Providers

Market data:

1. Create a class in `server/providers/market` that implements `MarketDataProvider`.
2. Return `MarketSnapshot[]` with current price, bid/ask/spread, and candles per timeframe.
3. Register it in `server/services/MarketDataService.ts` based on `MARKET_DATA_PROVIDER`.

News:

1. Create a class in `server/providers/news` that implements `NewsProvider`.
2. Return recent market news and upcoming high-impact events.
3. Register it in `server/services/NewsService.ts` based on `NEWS_PROVIDER`.

Keep API keys in `.env`; do not log secrets.
