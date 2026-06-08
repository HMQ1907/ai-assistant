# AI Trading Assistant

Nuxt fullstack MVP for a manual trading assistant. It analyzes mock market/news data, asks an AI model for a JSON recommendation, stores each analysis in SQLite, and shows the result in the UI. It never places trades.

## Run

```bash
npm install
npm run dev
```

Open the local Nuxt URL and click `Hien thi lenh goi y`.

The app runs without an AI key. If `EVOLINK_API_KEY` is empty, `AiAnalysisService` returns a valid mock `NO_TRADE` response.

## Evolink

Create `.env` from `.env.example`:

```bash
EVOLINK_API_KEY=your_key
EVOLINK_MODEL=claude-opus-4.8
EVOLINK_BASE_URL=https://api.evolink.ai/v1/chat/completions
```

The service expects an OpenAI-compatible chat completion response. If Evolink uses a different contract, update `server/services/AiAnalysisService.ts` only.

## Replacing Mock Providers

Market data:

1. Create a class in `server/providers/market` that implements `MarketDataProvider`.
2. Return `MarketSnapshot[]` with current price, bid/ask/spread, and at least 100 candles per timeframe where possible.
3. Register it in `server/services/MarketDataService.ts` based on `MARKET_DATA_PROVIDER`.

News:

1. Create a class in `server/providers/news` that implements `NewsProvider`.
2. Return recent USD, gold, crypto, Fed/CPI/NFP/PPI/PMI/rates/geopolitical items and upcoming high-impact events.
3. Register it in `server/services/NewsService.ts` based on `NEWS_PROVIDER`.

Keep API keys in `.env`; do not log secrets.

## Safety Rules

The prompt and local validation enforce conservative behavior:

- `confidence < 70` becomes `NO_TRADE`.
- risk reward below `1:1.5` becomes `NO_TRADE`.
- high-impact news within 30 minutes, wide spreads, or unclear/sideway markets should prefer `NO_TRADE`.
- no martingale, no loss DCA, no all-in, no increasing lot after losses.
- suggested risk is limited to 1-2% of account size.

This is an AI-generated trading suggestion, not financial advice. The user must make the final decision.
