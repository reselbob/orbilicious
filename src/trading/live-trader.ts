import { env, strategyConfig } from '../config';
import { logger } from '../logger';
import { logTradeOpen } from '../trade-logger';
import { SizedTrade } from '../basket';
import { Bar } from '../types';
import { AlpacaClient } from '../alpaca';
import { toNyParts } from '../time';
import {
    ITrader,
    PositionInfo,
    AccountInfo,
    PositionActionResult,
} from './trader-interface';

type TradeMonitorEvent = {
    eventType: 'open' | 'close';
    sessionDate: string;
    timestamp: string;
    symbol: string;
    side: 'buy' | 'sell';
    position: 'long' | 'short';
    qty: number;
    entryPrice?: number;
    stopPrice?: number;
    stopLossPct?: number;
    targetPrice?: number;
    closePrice?: number;
    pnl?: number;
    reason?: string;
};

function emitTradeMonitorEvent(event: TradeMonitorEvent) {
    try {
        const payload = JSON.stringify(event);
        logger.debug('Trade monitor event', { event, eventType: event.eventType, symbol: event.symbol });
        process.stdout.write(`__TRADE_MONITOR__${payload}\n`);
    } catch {
        // Keep failures silent
    }
}

function emitTradeCloseUiStatus(symbol: string, pnl: number) {
    const status = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'break even';
    const amount = `$${Math.abs(pnl).toFixed(2)}`;
    try {
        process.stdout.write(`__UI_STATUS__Closing ${symbol} for a ${status} of ${amount}.\n`);
    } catch {
        // Keep failures silent
    }
}

function minutesFromHHMM(hhmm: string): number {
    const [hour, minute] = hhmm.split(':').map(Number);
    return hour * 60 + minute;
}

export class LiveTrader implements ITrader {
    readonly dryRun = false;
    private readonly client: AlpacaClient;

    constructor(client: AlpacaClient) {
        this.client = client;
    }

    async getAccount(): Promise<AccountInfo> {
        return this.client.getAccount();
    }

    async getPosition(symbol: string): Promise<PositionInfo | null> {
        const pos = await this.client.getOpenPosition(symbol);
        if (!pos || pos.entryPrice == null) return null;
        return { symbol: pos.symbol, side: pos.side, qty: pos.qty, entryPrice: pos.entryPrice };
    }

    async getAllPositions(): Promise<PositionInfo[]> {
        return [];
    }

    async closePosition(symbol: string, sessionDate: string, reason?: string): Promise<void> {
        logger.info('Closing open position', { symbol, sessionDate, reason });
        await this.client.closePosition(symbol);
    }

    async executeTrades(trades: SizedTrade[], sessionDate: string): Promise<void> {
        await Promise.all(
            trades.map((trade) =>
                this.client.submitBracketOrder({
                    symbol: trade.symbol,
                    side: trade.side,
                    qty: trade.qty,
                    takeProfitLimitPrice: trade.takeProfitPrice,
                    stopLossStopPrice: trade.stopPrice,
                })
            )
        );

        for (const trade of trades) {
            const openEventTimestamp = new Date().toISOString();
            emitTradeMonitorEvent({
                eventType: 'open', sessionDate, timestamp: openEventTimestamp,
                symbol: trade.symbol, side: trade.side,
                position: trade.side === 'buy' ? 'long' : 'short',
                qty: trade.qty, entryPrice: trade.price, stopPrice: trade.stopPrice,
                stopLossPct: trade.stopLossPct, targetPrice: trade.takeProfitPrice,
                reason: 'bracket order submitted',
            });

            logTradeOpen(trade.symbol, trade.price, openEventTimestamp);
        }

        logger.info('Submitted bracket orders', {
            sessionDate,
            submittedCount: trades.length,
            symbols: trades.map((trade) => trade.symbol),
        });
    }

    computeUsedRisk(): number {
        return 0;
    }

    async managePosition(
        symbol: string,
        position: PositionInfo,
        sessionDate: string,
        sessionBars: Bar[],
        latestBar: Bar
    ): Promise<PositionActionResult> {
        const p = toNyParts(latestBar.timestamp, strategyConfig.sessionTimezone);
        const barMinutes = p.hour * 60 + p.minute;
        const exitStartMinutes = minutesFromHHMM(strategyConfig.forceExitTimeHHMM);

        if (barMinutes < exitStartMinutes) {
            logger.debug('Skipping profit-capture close outside end-of-day window', {
                symbol, side: position.side, entryPrice: position.entryPrice,
                latestClose: latestBar.close, latestTimestamp: latestBar.timestamp,
                forceExitTimeHHMM: strategyConfig.forceExitTimeHHMM,
            });
            return { action: 'holding' };
        }

        const shouldClose = position.side === 'long'
            ? latestBar.close >= position.entryPrice
            : latestBar.close <= position.entryPrice;

        if (!shouldClose) {
            logger.debug('Keeping open position; close is not yet favorable for profit capture', {
                symbol, side: position.side, entryPrice: position.entryPrice,
                latestClose: latestBar.close,
            });
            return { action: 'holding' };
        }

        const closeEventTimestamp = new Date().toISOString();
        await this.client.closePosition(symbol);
        logger.info('Closed open position for end-of-day profit capture', {
            symbol, side: position.side, entryPrice: position.entryPrice,
            latestClose: latestBar.close,
        });

        const closePnl = position.side === 'long'
            ? (latestBar.close - position.entryPrice) * position.qty
            : (position.entryPrice - latestBar.close) * position.qty;

        emitTradeCloseUiStatus(symbol, closePnl);
        emitTradeMonitorEvent({
            eventType: 'close', sessionDate, timestamp: closeEventTimestamp, symbol,
            side: position.side === 'long' ? 'sell' : 'buy',
            position: position.side, qty: position.qty,
            entryPrice: position.entryPrice, closePrice: latestBar.close, pnl: closePnl,
            reason: `profit-capture close (bar ${latestBar.timestamp})`,
        });

        return { action: 'closed', pnl: closePnl, exitPrice: latestBar.close, closeReason: 'profit-capture' };
    }
}
