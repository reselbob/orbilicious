import { env, strategyConfig } from '../config';
import { logger } from '../logger';
import { logTradeOpen, logTradeClose } from '../trade-logger';
import { SizedTrade } from '../basket';
import { Bar } from '../types';
import { AlpacaClient } from '../alpaca';
import { toNyParts } from '../time';
import {
    ITrader,
    PositionInfo,
    AccountInfo,
    PositionActionResult,
    TradeRecord,
} from './trader-interface';

export interface SimulatedPosition {
    side: 'long' | 'short';
    entryPrice: number;
    entryTime: string;
    stopPrice: number;
    stopLossPct?: number;
    takeProfitPrice: number;
    qty: number;
}

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

export class Emulator implements ITrader {
    readonly dryRun = true;
    readonly simulatedPositions = new Map<string, SimulatedPosition>();
    readonly tradeHistory: TradeRecord[] = [];
    private cumulativeRealizedLoss = 0;
    private readonly client: AlpacaClient;

    constructor(client: AlpacaClient) {
        this.client = client;
    }

    getCumulativeRealizedLoss(): number {
        return this.cumulativeRealizedLoss;
    }

    resetCumulativeRealizedLoss(): void {
        this.cumulativeRealizedLoss = 0;
    }

    async getAccount(): Promise<AccountInfo> {
        return this.client.getAccount();
    }

    async getPosition(symbol: string): Promise<PositionInfo | null> {
        const sim = this.simulatedPositions.get(symbol);
        if (!sim) return null;
        return { symbol, side: sim.side, qty: sim.qty, entryPrice: sim.entryPrice, entryTime: sim.entryTime };
    }

    async getAllPositions(): Promise<PositionInfo[]> {
        return [...this.simulatedPositions.entries()].map(([symbol, sim]) => ({
            symbol,
            side: sim.side,
            qty: sim.qty,
            entryPrice: sim.entryPrice,
            entryTime: sim.entryTime,
        }));
    }

    getTradeHistory(): TradeRecord[] {
        return this.tradeHistory;
    }

    async closePosition(symbol: string, _sessionDate: string, _reason?: string): Promise<void> {
        this.simulatedPositions.delete(symbol);
    }

    async executeTrades(trades: SizedTrade[], sessionDate: string): Promise<void> {
        for (const trade of trades) {
            const openEventTimestamp = new Date().toISOString();
            logger.info('Trade executed in dry-run mode; no Alpaca bracket order submitted', {
                symbol: trade.symbol, side: trade.side, qty: trade.qty,
                entry: trade.price, stop: trade.stopPrice, target: trade.takeProfitPrice,
                plannedRisk: trade.plannedRiskDollars, estimatedNotional: trade.estimatedNotional,
            });

            emitTradeMonitorEvent({
                eventType: 'open', sessionDate, timestamp: openEventTimestamp,
                symbol: trade.symbol, side: trade.side,
                position: trade.side === 'buy' ? 'long' : 'short',
                qty: trade.qty, entryPrice: trade.price, stopPrice: trade.stopPrice,
                stopLossPct: trade.stopLossPct, targetPrice: trade.takeProfitPrice,
                reason: 'dry-run simulated entry',
            });

            const simSide = trade.side === 'buy' ? 'long' : 'short';
            this.simulatedPositions.set(trade.symbol, {
                side: simSide,
                entryPrice: trade.price,
                entryTime: openEventTimestamp,
                stopPrice: trade.stopPrice,
                stopLossPct: trade.stopLossPct,
                takeProfitPrice: trade.takeProfitPrice,
                qty: trade.qty,
            });

            this.tradeHistory.push({
                symbol: trade.symbol,
                side: simSide,
                qty: trade.qty,
                entryPrice: trade.price,
                entryTime: openEventTimestamp,
                stopPrice: trade.stopPrice,
                takeProfitPrice: trade.takeProfitPrice,
                status: 'open',
            });

            logTradeOpen(trade.symbol, trade.price, openEventTimestamp);
        }
    }

    computeUsedRisk(): number {
        return Array.from(this.simulatedPositions.values()).reduce((sum, pos) => {
            const perShare = pos.side === 'long'
                ? pos.entryPrice - pos.stopPrice
                : pos.stopPrice - pos.entryPrice;
            return sum + Math.max(0, perShare) * pos.qty;
        }, 0);
    }

    async managePosition(
        symbol: string,
        position: PositionInfo,
        sessionDate: string,
        sessionBars: Bar[],
        latestBar: Bar
    ): Promise<PositionActionResult> {
        const rawSim = this.simulatedPositions.get(symbol);
        if (!rawSim) {
            return { action: 'none' };
        }

        const postEntryBars = sessionBars.filter(
            (bar) => new Date(bar.timestamp).getTime() > new Date(rawSim.entryTime).getTime() - 60000
        );

        const hitBar = postEntryBars.find(bar => {
            if (rawSim.side === 'long') {
                return bar.low <= rawSim.stopPrice || bar.high >= rawSim.takeProfitPrice;
            } else {
                return bar.high >= rawSim.stopPrice || bar.low <= rawSim.takeProfitPrice;
            }
        });

        if (hitBar) {
            const closeEventTimestamp = new Date().toISOString();
            const stopHit = rawSim.side === 'long'
                ? hitBar.low <= rawSim.stopPrice
                : hitBar.high >= rawSim.stopPrice;
            const exitPrice = stopHit ? rawSim.stopPrice : rawSim.takeProfitPrice;
            const exitReason = stopHit
                ? `stop-loss hit (bar ${hitBar.timestamp})`
                : `take-profit hit (bar ${hitBar.timestamp})`;
            const pnl = rawSim.side === 'long'
                ? (exitPrice - rawSim.entryPrice) * rawSim.qty
                : (rawSim.entryPrice - exitPrice) * rawSim.qty;

            this.simulatedPositions.delete(symbol);
            if (pnl < 0) this.cumulativeRealizedLoss += Math.abs(pnl);
            this.recordClose(symbol, exitPrice, closeEventTimestamp, pnl);
            logger.info('Dry-run: simulated position closed', {
                symbol, side: rawSim.side, exitReason, exitPrice,
                entryPrice: rawSim.entryPrice, pnl,
            });
            emitTradeCloseUiStatus(symbol, pnl);
            emitTradeMonitorEvent({
                eventType: 'close', sessionDate, timestamp: closeEventTimestamp, symbol,
                side: rawSim.side === 'long' ? 'sell' : 'buy',
                position: rawSim.side, qty: rawSim.qty,
                entryPrice: rawSim.entryPrice, closePrice: exitPrice, pnl, reason: exitReason,
            });
            logTradeClose(symbol, exitPrice, closeEventTimestamp);
            return { action: 'closed', pnl, exitPrice, closeReason: exitReason };
        }

        const p = toNyParts(latestBar.timestamp, strategyConfig.sessionTimezone);
        const barMinutes = p.hour * 60 + p.minute;
        const exitStartMinutes = minutesFromHHMM(strategyConfig.forceExitTimeHHMM);
        const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const currentMinutes = nyNow.getHours() * 60 + nyNow.getMinutes();
        if (barMinutes >= exitStartMinutes || currentMinutes >= exitStartMinutes) {
            const shouldClose = rawSim.side === 'long'
                ? latestBar.close >= rawSim.entryPrice
                : latestBar.close <= rawSim.entryPrice;

            if (!shouldClose) {
                logger.debug('Dry-run: keeping simulated position open; close is not yet favorable for profit capture', {
                    symbol, side: rawSim.side, entryPrice: rawSim.entryPrice, latestClose: latestBar.close,
                });
                return { action: 'holding' };
            }

            const closeEventTimestamp = new Date().toISOString();
            const exitPrice = latestBar.close;
            const pnl = rawSim.side === 'long'
                ? (exitPrice - rawSim.entryPrice) * rawSim.qty
                : (rawSim.entryPrice - exitPrice) * rawSim.qty;
            this.simulatedPositions.delete(symbol);
            if (pnl < 0) this.cumulativeRealizedLoss += Math.abs(pnl);
            this.recordClose(symbol, exitPrice, closeEventTimestamp, pnl);
            logger.info('Dry-run: simulated position closed (profit-capture window)', {
                symbol, side: rawSim.side, exitPrice, entryPrice: rawSim.entryPrice, pnl,
            });
            emitTradeCloseUiStatus(symbol, pnl);
            emitTradeMonitorEvent({
                eventType: 'close', sessionDate, timestamp: closeEventTimestamp, symbol,
                side: rawSim.side === 'long' ? 'sell' : 'buy',
                position: rawSim.side, qty: rawSim.qty,
                entryPrice: rawSim.entryPrice, closePrice: exitPrice, pnl,
                reason: `profit-capture close (bar ${latestBar.timestamp})`,
            });
            logTradeClose(symbol, exitPrice, closeEventTimestamp);
            return { action: 'closed', pnl, exitPrice, closeReason: 'profit-capture' };
        }

        logger.debug('Dry-run: keeping simulated position open', {
            symbol, side: rawSim.side, entryPrice: rawSim.entryPrice,
            stopPrice: rawSim.stopPrice, takeProfitPrice: rawSim.takeProfitPrice,
            latestClose: latestBar.close, latestLow: latestBar.low, latestHigh: latestBar.high,
        });

        return { action: 'holding' };
    }

    private recordClose(symbol: string, exitPrice: number, exitTime: string, pnl: number): void {
        const existing = this.tradeHistory.find(t => t.symbol === symbol && t.status === 'open');
        if (existing) {
            existing.exitPrice = exitPrice;
            existing.exitTime = exitTime;
            existing.pnl = pnl;
            existing.status = 'closed';
        }
    }
}
