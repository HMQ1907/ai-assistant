from datetime import datetime, timezone
from threading import Lock
from typing import Optional

import MetaTrader5 as mt5
from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel

app = FastAPI()
mt5_lock = Lock()

TIMEFRAMES = {
    "M5": mt5.TIMEFRAME_M5,
    "M15": mt5.TIMEFRAME_M15,
    "H1": mt5.TIMEFRAME_H1,
    "H4": mt5.TIMEFRAME_H4,
}

# Mỗi order_type ánh xạ sang (mt5 order type, có phải lệnh chờ hay không).
ORDER_TYPES = {
    "MARKET_BUY": (mt5.ORDER_TYPE_BUY, False),
    "MARKET_SELL": (mt5.ORDER_TYPE_SELL, False),
    "BUY_LIMIT": (mt5.ORDER_TYPE_BUY_LIMIT, True),
    "SELL_LIMIT": (mt5.ORDER_TYPE_SELL_LIMIT, True),
    "BUY_STOP": (mt5.ORDER_TYPE_BUY_STOP, True),
    "SELL_STOP": (mt5.ORDER_TYPE_SELL_STOP, True),
}

ORDER_TYPE_NAMES = {
    mt5.ORDER_TYPE_BUY: ("MARKET_BUY", "BUY"),
    mt5.ORDER_TYPE_SELL: ("MARKET_SELL", "SELL"),
    mt5.ORDER_TYPE_BUY_LIMIT: ("BUY_LIMIT", "BUY"),
    mt5.ORDER_TYPE_SELL_LIMIT: ("SELL_LIMIT", "SELL"),
    mt5.ORDER_TYPE_BUY_STOP: ("BUY_STOP", "BUY"),
    mt5.ORDER_TYPE_SELL_STOP: ("SELL_STOP", "SELL"),
}


class PlaceOrderRequest(BaseModel):
    symbol: str = "XAUUSDm"
    order_type: str
    volume: float
    price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profit: Optional[float] = None
    deviation: int = 30
    comment: str = "ai-assistant"


class CancelOrderRequest(BaseModel):
    symbol: str = "XAUUSDm"
    ticket: int
    deviation: int = 30
    comment: str = "ai-assistant-cancel"


def ensure_mt5():
    if not mt5.initialize():
        raise HTTPException(
            status_code=500,
            detail=f"MT5 initialize failed: {mt5.last_error()}",
        )


def ensure_trading_enabled():
    terminal = mt5.terminal_info()
    if terminal is None:
        raise HTTPException(
            status_code=500,
            detail=f"MT5 terminal_info failed: {mt5.last_error()}",
        )
    if not terminal.trade_allowed:
        raise HTTPException(
            status_code=400,
            detail=(
                "MT5 dang tat AutoTrading/Algo Trading. "
                "Hay bat nut Algo Trading/AutoTrading trong MT5 roi dat lenh lai."
            ),
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


def timestamp_to_iso(value):
    return datetime.fromtimestamp(int(value), timezone.utc).isoformat()


def serialize_pending_order(order):
    order_type, direction = ORDER_TYPE_NAMES.get(order.type, (str(order.type), "BUY"))
    return {
        "ticket": int(order.ticket),
        "state": "PENDING",
        "symbol": order.symbol,
        "type": order_type,
        "direction": direction,
        "volume": float(getattr(order, "volume_current", order.volume_initial)),
        "price_open": float(order.price_open),
        "stop_loss": float(order.sl) if order.sl else None,
        "take_profit": float(order.tp) if order.tp else None,
        "profit": None,
        "opened_at": timestamp_to_iso(order.time_setup),
        "comment": getattr(order, "comment", "") or "",
    }


def serialize_position(position):
    order_type, direction = ORDER_TYPE_NAMES.get(position.type, (str(position.type), "BUY"))
    return {
        "ticket": int(position.ticket),
        "state": "FILLED",
        "symbol": position.symbol,
        "type": order_type,
        "direction": direction,
        "volume": float(position.volume),
        "price_open": float(position.price_open),
        "stop_loss": float(position.sl) if position.sl else None,
        "take_profit": float(position.tp) if position.tp else None,
        "profit": float(position.profit),
        "opened_at": timestamp_to_iso(position.time),
        "comment": getattr(position, "comment", "") or "",
    }


@app.get("/")
def root():
    return {
        "ok": True,
        "service": "mt5-exness-bridge",
        "endpoints": [
            "/health",
            "/snapshot",
            "/order",
            "/order/cancel",
            "/order/{ticket}",
            "/docs",
        ],
    }


@app.get("/health")
def health():
    with mt5_lock:
        ensure_mt5()
        account = mt5.account_info()
        terminal = mt5.terminal_info()
        if account is None:
            raise HTTPException(
                status_code=500,
                detail=f"MT5 account not connected: {mt5.last_error()}",
            )
        if terminal is None:
            raise HTTPException(
                status_code=500,
                detail=f"MT5 terminal_info failed: {mt5.last_error()}",
            )

        return {
            "ok": True,
            "login": account.login,
            "server": account.server,
            "company": account.company,
            "currency": account.currency,
            "trade_allowed": bool(terminal.trade_allowed),
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


def _prepare_symbol(symbol: str):
    if not mt5.symbol_select(symbol, True):
        raise HTTPException(
            status_code=404,
            detail=f"Cannot select symbol {symbol}: {mt5.last_error()}",
        )
    info = mt5.symbol_info(symbol)
    tick = mt5.symbol_info_tick(symbol)
    if info is None or tick is None:
        raise HTTPException(
            status_code=500,
            detail=f"No info/tick for {symbol}: {mt5.last_error()}",
        )
    return info, tick


@app.post("/order")
def place_order(req: PlaceOrderRequest):
    mapping = ORDER_TYPES.get(req.order_type)
    if mapping is None:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported order_type {req.order_type}.",
        )
    if req.volume <= 0:
        raise HTTPException(status_code=400, detail="volume must be > 0.")

    mt5_order_type, is_pending = mapping

    with mt5_lock:
        ensure_mt5()
        ensure_trading_enabled()
        info, tick = _prepare_symbol(req.symbol)

        if is_pending:
            if req.price is None:
                raise HTTPException(
                    status_code=400,
                    detail="price is required for a pending order.",
                )
            entry_price = float(req.price)
            action = mt5.TRADE_ACTION_PENDING
        else:
            # MARKET: dùng ask cho lệnh mua, bid cho lệnh bán.
            entry_price = float(tick.ask if mt5_order_type == mt5.ORDER_TYPE_BUY else tick.bid)
            action = mt5.TRADE_ACTION_DEAL

        request = {
            "action": action,
            "symbol": req.symbol,
            "volume": float(req.volume),
            "type": mt5_order_type,
            "price": entry_price,
            "deviation": int(req.deviation),
            "magic": 770001,
            "comment": req.comment,
            "type_time": mt5.ORDER_TIME_GTC,
            "type_filling": mt5.ORDER_FILLING_IOC,
        }
        if req.stop_loss is not None:
            request["sl"] = float(req.stop_loss)
        if req.take_profit is not None:
            request["tp"] = float(req.take_profit)

        result = mt5.order_send(request)
        if result is None:
            raise HTTPException(
                status_code=500,
                detail=f"order_send returned None: {mt5.last_error()}",
            )
        success_retcodes = {mt5.TRADE_RETCODE_DONE}
        if is_pending:
            success_retcodes.add(mt5.TRADE_RETCODE_PLACED)
        if result.retcode not in success_retcodes:
            raise HTTPException(
                status_code=400,
                detail=f"order_send failed retcode={result.retcode}: {result.comment}",
            )

        return {
            "ok": True,
            "ticket": int(result.order),
            "order_type": req.order_type,
            "is_pending": is_pending,
            "price": float(result.price) if result.price else entry_price,
            "volume": float(result.volume) if result.volume else float(req.volume),
            "retcode": int(result.retcode),
            "comment": result.comment,
        }


@app.get("/order/{ticket}")
def get_order(ticket: int, symbol: str = "XAUUSDm"):
    with mt5_lock:
        ensure_mt5()
        pending = mt5.orders_get(ticket=ticket)
        if pending:
            return {"ok": True, "ticket": ticket, "state": "PENDING"}
        position = mt5.positions_get(ticket=ticket)
        if position:
            return {"ok": True, "ticket": ticket, "state": "FILLED"}
        return {"ok": True, "ticket": ticket, "state": "CLOSED_OR_UNKNOWN"}


@app.get("/orders")
def orders(symbol: str = "XAUUSDm"):
    with mt5_lock:
        ensure_mt5()
        if not mt5.symbol_select(symbol, True):
            raise HTTPException(
                status_code=404,
                detail=f"Cannot select symbol {symbol}: {mt5.last_error()}",
            )

        pending = mt5.orders_get(symbol=symbol) or ()
        positions = mt5.positions_get(symbol=symbol) or ()

        return {
            "ok": True,
            "symbol": symbol,
            "orders": [
                *[serialize_pending_order(order) for order in pending],
                *[serialize_position(position) for position in positions],
            ],
        }


@app.post("/order/cancel")
def cancel_order(req: CancelOrderRequest):
    with mt5_lock:
        ensure_mt5()
        ensure_trading_enabled()

        # Lệnh chờ chưa khớp -> remove.
        pending = mt5.orders_get(ticket=req.ticket)
        if pending:
            result = mt5.order_send(
                {
                    "action": mt5.TRADE_ACTION_REMOVE,
                    "order": int(req.ticket),
                    "comment": req.comment,
                }
            )
            return _check_close_result(result, req.ticket, "CANCELLED")

        # Vị thế đã khớp đang mở -> đóng bằng deal ngược chiều.
        positions = mt5.positions_get(ticket=req.ticket)
        if not positions:
            raise HTTPException(
                status_code=404,
                detail=f"Ticket {req.ticket} không phải lệnh chờ hay vị thế đang mở.",
            )

        position = positions[0]
        _prepare_symbol(position.symbol)
        tick = mt5.symbol_info_tick(position.symbol)
        if tick is None:
            raise HTTPException(
                status_code=500,
                detail=f"No tick for {position.symbol}: {mt5.last_error()}",
            )

        if position.type == mt5.POSITION_TYPE_BUY:
            close_type = mt5.ORDER_TYPE_SELL
            close_price = float(tick.bid)
        else:
            close_type = mt5.ORDER_TYPE_BUY
            close_price = float(tick.ask)

        result = mt5.order_send(
            {
                "action": mt5.TRADE_ACTION_DEAL,
                "symbol": position.symbol,
                "volume": float(position.volume),
                "type": close_type,
                "position": int(req.ticket),
                "price": close_price,
                "deviation": int(req.deviation),
                "magic": 770001,
                "comment": req.comment,
                "type_time": mt5.ORDER_TIME_GTC,
                "type_filling": mt5.ORDER_FILLING_IOC,
            }
        )
        return _check_close_result(result, req.ticket, "CLOSED")


def _check_close_result(result, ticket: int, new_state: str):
    if result is None:
        raise HTTPException(
            status_code=500,
            detail=f"order_send returned None: {mt5.last_error()}",
        )
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        raise HTTPException(
            status_code=400,
            detail=f"cancel failed retcode={result.retcode}: {result.comment}",
        )
    return {
        "ok": True,
        "ticket": int(ticket),
        "state": new_state,
        "retcode": int(result.retcode),
        "comment": result.comment,
    }
