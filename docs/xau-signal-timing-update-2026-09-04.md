# Signal timing update — 2026-09-04

Manual signals only: no MT5 order writes.

- The existing direct Telegram candidate path remains; no second Codex review is required.
- Directional TREND_BULLISH/TREND_BEARISH watch plans default to EARLY_ALLOWED when entryPolicy is omitted. Explicit M5_REQUIRED still overrides this default.
- M1 is only closed-candle timing at a mapped zone, not a replacement for H1 structure. Transition requires explicit opt-in; range and close-through remain M5.
- Breakout retest still requires a prior closed M5 breakout before M1 timing.
- Two-candle trigger sequences now count the previous candle's zone touch in the location quality check, consistently with trigger recognition.
- Existing RR, spread, news, expiry, invalidation and duplicate-message checks are unchanged. No daily signal count is guaranteed.

Deployment observation: at inspection, the saved plan list was empty, the latest packet was dated 08:02 with HTTP 500, bridge health was unreachable, and both scheduled tasks were Ready rather than Running. Code tests do not establish live service or Telegram delivery health.
