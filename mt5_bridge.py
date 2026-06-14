from datetime import datetime, timezone
from threading import Lock

import MetaTrader5 as mt5
from fastapi import FastAPI, HTTPException, Query

app = FastAPI()
mt5_lock = Lock()

TIMEFRAMES = {
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
}


def ensure_mt5():
    if not mt5.initialize():
        raise HTTPException(
            status_code=500,
            detail=f"MT5 initialize failed: {mt5.last_error()}",
        )


def rate_to_candle(rate):
    return {
        "time": datetime.fromtimestamp(int(rate["time"]), timezone.utc).isoformat(),
        "open": float(rate["open"]),
        "high": float(rate["high"]),
        "low": float(rate["low"]),
        "close": float(rate["close"]),
        "volume": float(rate["tick_volume"]),
    }


@app.get("/")
def root():
    return {
        "ok": True,
        "service": "mt5-exness-read-only-bridge",
        "endpoints": ["/health", "/snapshot", "/docs"],
    }


@app.get("/health")
def health():
    with mt5_lock:
        ensure_mt5()
        account = mt5.account_info()
        if account is None:
            raise HTTPException(
                status_code=500,
                detail=f"MT5 account not connected: {mt5.last_error()}",
            )

        return {
            "ok": True,
            "login": account.login,
            "server": account.server,
            "company": account.company,
            "currency": account.currency,
        }


@app.get("/snapshot")
def snapshot(
    symbol: str = "XAUUSDm",
    count: int = Query(default=350, ge=200, le=500),
):
    with mt5_lock:
        ensure_mt5()

        if not mt5.symbol_select(symbol, True):
            raise HTTPException(
                status_code=404,
                detail=f"Cannot select symbol {symbol}: {mt5.last_error()}",
            )

        tick = mt5.symbol_info_tick(symbol)
        info = mt5.symbol_info(symbol)
        if tick is None or info is None:
            raise HTTPException(
                status_code=500,
                detail=f"No tick/info for {symbol}: {mt5.last_error()}",
            )

        candles = {}
        for name, timeframe in TIMEFRAMES.items():
            # Position 0 is the current forming bar, so read from position 1.
            rates = mt5.copy_rates_from_pos(symbol, timeframe, 1, count)
            if rates is None or len(rates) == 0:
                raise HTTPException(
                    status_code=500,
                    detail=f"No candles for {symbol} {name}: {mt5.last_error()}",
                )
            candles[name] = [rate_to_candle(rate) for rate in rates]

        return {
            "symbol": symbol,
            "price": float(tick.bid),
            "bid": float(tick.bid),
            "ask": float(tick.ask),
            "spread": float(tick.ask - tick.bid),
            "spread_points": int(info.spread),
            "digits": int(info.digits),
            "time": datetime.fromtimestamp(int(tick.time), timezone.utc).isoformat(),
            "time_msc": int(tick.time_msc),
            "provider": "mt5-exness",
            "candles": candles,
        }
