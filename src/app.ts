import { env, strategyConfig } from './config';
import { AlpacaClient } from './alpaca';
import { logger } from './logger';
import { computeOpeningRange } from './strategy';
import { sleep, toNyParts } from './time';
import {
    BreakoutCandidate,
    SizedTrade,
    buildWeightedRiskTrades,
    computeCandidateScore,
    normalizeTradesToConstraints,
    rankAndSelectCandidates,
} from './basket';
import { Bar } from './types';
import type { OrbReportResult } from './reports';

const executedToday = new Set<string>();
const reportedDates = new Set<string>();

interface SimulatedPosition {
    side: 'long' | 'short';
    entryPrice: number;
    stopPrice: number;
    takeProfitPrice: number;
    qty: number;
}
const simulatedPositions = new Map<string, SimulatedPosition>();

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
    targetPrice?: number;
    closePrice?: number;
    pnl?: number;
    reason?: string;
};

type BacktestProgressEvent = {
    startSessionDate: string;
    endSessionDate: string;
    totalWeekdaySessions: number;
    processedDates: number;
    skippedDates: number;
    currentSessionDate: string | null;
    completed: boolean;
};

type UiStatusEvent = {
    message: string;
};

function emitTradeMonitorEvent(event: TradeMonitorEvent) {
    try {
        const payload = JSON.stringify(event);
        process.stdout.write(`__TRADE_MONITOR__${payload}\n`);
    } catch {
        // Keep failures silent so monitoring output never blocks strategy execution.
    }
}

function emitBacktestProgressEvent(event: BacktestProgressEvent) {
    try {
        const payload = JSON.stringify(event);
        process.stdout.write(`__BACKTEST_PROGRESS__${payload}\n`);
    } catch {
        // Keep failures silent so monitoring output never blocks strategy execution.
    }
}

function emitUiStatusEvent(event: UiStatusEvent) {
    try {
        process.stdout.write(`__UI_STATUS__${event.message}\n`);
    } catch {
        // Keep failures silent so monitoring output never blocks strategy execution.
    }
}

function emitTradeCloseUiStatus(symbol: string, pnl: number) {
    const status = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'break even';
    const amount = `$${Math.abs(pnl).toFixed(2)}`;
    emitUiStatusEvent({ message: `Closing ${symbol} for a ${status} of ${amount}.` });
}

async function emitWaitingForBreakoutsUiStatus(client: AlpacaClient) {
    try {
        const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
        if (symbols.length) {
            emitUiStatusEvent({
                message: `Waiting for breakouts. Breakout candidate symbols: ${symbols.join(', ')}`,
            });
            return;
        }
    } catch {
        // Fall through to default message if symbol lookup fails.
    }

    emitUiStatusEvent({ message: 'Waiting for breakouts' });
}

async function emitOpeningRangeUiStatusForSession(client: AlpacaClient, sessionDate: string) {
    emitUiStatusEvent({ message: 'Determing open range.' });

    try {
        const bars = await client.getIntradayBars(strategyConfig.symbol, sessionDate);
        const sessionBars = dedupeAndSortBars(bars).filter(
            (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate
        );
        const openingRange = computeOpeningRange(sessionBars, sessionDate, strategyConfig);
        emitUiStatusEvent({
            message: `High range prices: ${openingRange.high.toFixed(2)}, Low range prices: ${openingRange.low.toFixed(2)}.`,
        });
        await emitWaitingForBreakoutsUiStatus(client);
    } catch {
        // If bars are unavailable, keep at least the initial status visible.
    }
}

function emitHistoricalTradeMonitorEvents(report: OrbReportResult) {
    const rowBySymbol = new Map(report.evaluationRows.map((row) => [row.symbol, row]));
    const outcomeBySymbol = new Map(report.finalOutcomes.map((outcome) => [outcome.symbol, outcome]));

    for (const trade of report.emulatedTrades) {
        const row = rowBySymbol.get(trade.symbol);
        const entryTimestamp = row?.confirmationRetestTimestamp ?? row?.breakoutTimestamp ?? new Date().toISOString();
        const position = trade.side === 'buy' ? 'long' : 'short';

        emitTradeMonitorEvent({
            eventType: 'open',
            sessionDate: report.sessionDate,
            timestamp: entryTimestamp,
            symbol: trade.symbol,
            side: trade.side,
            position,
            qty: trade.qty,
            entryPrice: trade.price,
            stopPrice: trade.stopPrice,
            targetPrice: trade.takeProfitPrice,
            reason: 'historical emulation entry',
        });

        const outcome = outcomeBySymbol.get(trade.symbol);
        if (!outcome || outcome.exitPrice == null) {
            continue;
        }

        emitTradeCloseUiStatus(trade.symbol, outcome.pnl);
        emitTradeMonitorEvent({
            eventType: 'close',
            sessionDate: report.sessionDate,
            timestamp: outcome.exitTimestamp ?? entryTimestamp,
            symbol: trade.symbol,
            side: trade.side === 'buy' ? 'sell' : 'buy',
            position,
            qty: trade.qty,
            entryPrice: trade.price,
            closePrice: outcome.exitPrice,
            pnl: outcome.pnl,
            reason: `historical emulation ${outcome.status} close`,
        });
    }
}

function executionKey(sessionDate: string, symbol: string) {
    return `${sessionDate}:${symbol}`;
}

function candidateAllowedByTradeType(side: 'buy' | 'sell'): boolean {
    if (env.candidateTradeType === 'LONG_AND_SHORT') {
        return true;
    }

    if (env.candidateTradeType === 'LONG') {
        return side === 'buy';
    }

    return side === 'sell';
}

function minutesFromHHMM(hhmm: string): number {
    const [hour, minute] = hhmm.split(':').map(Number);
    return hour * 60 + minute;
}

function isWeekdaySessionDate(sessionDate: string): boolean {
    const [year, month, day] = sessionDate.split('-').map(Number);
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    const dayOfWeek = utcDate.getUTCDay();
    return dayOfWeek !== 0 && dayOfWeek !== 6;
}

function sessionDatesFromAnchorToToday(anchorDate: string): string[] {
    const [startYear, startMonth, startDay] = anchorDate.split('-').map(Number);
    const start = new Date(Date.UTC(startYear, startMonth - 1, startDay));

    const todayNy = toNyParts(new Date(), strategyConfig.sessionTimezone).date;
    const [endYear, endMonth, endDay] = todayNy.split('-').map(Number);
    const end = new Date(Date.UTC(endYear, endMonth - 1, endDay));

    if (start.getTime() > end.getTime()) {
        return [];
    }

    const dates: string[] = [];
    for (const current = new Date(start); current.getTime() <= end.getTime();) {
        const year = String(current.getUTCFullYear()).padStart(4, '0');
        const month = String(current.getUTCMonth() + 1).padStart(2, '0');
        const day = String(current.getUTCDate()).padStart(2, '0');
        dates.push(`${year}-${month}-${day}`);
        current.setUTCDate(current.getUTCDate() + 1);
    }

    return dates;
}

function dedupeAndSortBars(bars: Bar[]): Bar[] {
    const byTimestamp = new Map<string, Bar>();
    for (const bar of bars) {
        byTimestamp.set(bar.timestamp, bar);
    }

    return [...byTimestamp.values()].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
}

function calculateAtr1m(bars: Bar[], period = 14): number | null {
    if (bars.length < 2) {
        return null;
    }

    const sortedBars = [...bars].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    const trueRanges: number[] = [];
    for (let index = 1; index < sortedBars.length; index++) {
        const current = sortedBars[index];
        const previous = sortedBars[index - 1];
        const rangeHighLow = current.high - current.low;
        const rangeHighPrevClose = Math.abs(current.high - previous.close);
        const rangeLowPrevClose = Math.abs(current.low - previous.close);
        trueRanges.push(Math.max(rangeHighLow, rangeHighPrevClose, rangeLowPrevClose));
    }

    const atrWindow = trueRanges.slice(-period);
    if (!atrWindow.length) {
        return null;
    }

    const atr = atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
    return atr > 0 ? atr : null;
}

function aggregateBarsByMinutes(bars: Bar[], sessionDate: string, intervalMinutes: number): Bar[] {
    if (intervalMinutes <= 1) {
        return bars
            .filter((bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate)
            .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    }

    const grouped = new Map<number, Bar>();
    const sessionBars = bars
        .filter((bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    for (const bar of sessionBars) {
        const p = toNyParts(bar.timestamp, strategyConfig.sessionTimezone);
        const totalMinutes = p.hour * 60 + p.minute;
        const bucketStartMinutes = Math.floor(totalMinutes / intervalMinutes) * intervalMinutes;

        const existing = grouped.get(bucketStartMinutes);
        if (!existing) {
            grouped.set(bucketStartMinutes, {
                ...bar,
                volume: bar.volume,
            });
            continue;
        }

        grouped.set(bucketStartMinutes, {
            ...existing,
            high: Math.max(existing.high, bar.high),
            low: Math.min(existing.low, bar.low),
            close: bar.close,
            volume: existing.volume + bar.volume,
        });
    }

    return [...grouped.values()].sort(
        (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );
}

function minutesFromSessionOpen(bar: Bar): number {
    const p = toNyParts(bar.timestamp, strategyConfig.sessionTimezone);
    const sessionOpenMinutes = strategyConfig.sessionOpenHour * 60 + strategyConfig.sessionOpenMinute;
    return p.hour * 60 + p.minute - sessionOpenMinutes;
}

function passesBreakoutQualityFilters(params: {
    sessionBars: Bar[];
    sessionDate: string;
    side: 'buy' | 'sell';
    breakoutBar: Bar;
    openingRangeHigh: number;
    openingRangeLow: number;
    confirmationBars: Bar[];
}): boolean {
    const {
        sessionBars,
        sessionDate,
        side,
        breakoutBar,
        openingRangeHigh,
        openingRangeLow,
        confirmationBars,
    } = params;

    if (!env.breakoutQualityFiltersEnabled) {
        return true;
    }

    const priorConfirmationBars = confirmationBars.filter(
        (bar) => new Date(bar.timestamp).getTime() < new Date(breakoutBar.timestamp).getTime()
    );
    if (!priorConfirmationBars.length) {
        return false;
    }

    const averagePriorVolume =
        priorConfirmationBars.reduce((sum, bar) => sum + bar.volume, 0) / priorConfirmationBars.length;
    const volumeExpansion = averagePriorVolume > 0 ? breakoutBar.volume / averagePriorVolume : 0;

    const relativeStrengthPct =
        side === 'buy'
            ? ((breakoutBar.close - openingRangeHigh) / openingRangeHigh) * 100
            : ((openingRangeLow - breakoutBar.close) / openingRangeLow) * 100;

    const trendBars = aggregateBarsByMinutes(
        sessionBars,
        sessionDate,
        Math.max(1, Math.floor(env.breakoutTrendTimeframeMinutes))
    ).filter((bar) => new Date(bar.timestamp).getTime() <= new Date(breakoutBar.timestamp).getTime());

    const trendWindowSize = Math.max(2, Math.floor(env.breakoutTrendLookbackBars) + 1);
    const trendWindow = trendBars.slice(-trendWindowSize);
    if (trendWindow.length < trendWindowSize) {
        return false;
    }

    const priorTrendBars = trendWindow.slice(0, -1);
    const trendSma = priorTrendBars.reduce((sum, bar) => sum + bar.close, 0) / priorTrendBars.length;
    const trendSlope = trendWindow[trendWindow.length - 1].close - trendWindow[0].close;
    const trendAligned =
        side === 'buy'
            ? breakoutBar.close > trendSma && trendSlope > 0
            : breakoutBar.close < trendSma && trendSlope < 0;

    return (
        volumeExpansion >= env.breakoutMinVolumeExpansion
        && relativeStrengthPct >= env.breakoutMinRelativeStrengthPct
        && trendAligned
    );
}

function shouldClosePositionForProfitCapture(params: {
    side: 'long' | 'short';
    entryPrice: number;
    latestClose: number;
}): boolean {
    const { side, entryPrice, latestClose } = params;
    return side === 'long' ? latestClose >= entryPrice : latestClose <= entryPrice;
}

function isInProfitCaptureWindow(bar: Bar): boolean {
    const p = toNyParts(bar.timestamp, strategyConfig.sessionTimezone);
    const barMinutes = p.hour * 60 + p.minute;
    const startMinutes = minutesFromHHMM(strategyConfig.forceExitTimeHHMM);
    return barMinutes >= startMinutes;
}

function buildConfirmedBreakoutCandidate(
    symbol: string,
    sessionDate: string,
    bars: Bar[]
): BreakoutCandidate | null {
    const sessionBars = dedupeAndSortBars(bars).filter(
        (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate
    );
    if (!sessionBars.length) {
        return null;
    }

    const cfg = { ...strategyConfig, symbol };
    const openingRange = computeOpeningRange(sessionBars, sessionDate, cfg);
    const evaluationWindowMinutes = strategyConfig.openingRangeMinutes;
    const confirmationBars = aggregateBarsByMinutes(
        sessionBars,
        sessionDate,
        Math.max(1, Math.floor(env.breakoutConfirmationCandleMinutes))
    );

    let breakoutBar: Bar | null = null;
    let confirmationRetestBar: Bar | null = null;
    let side: 'buy' | 'sell' | 'none' = 'none';

    for (const confirmationBar of confirmationBars) {
        const minutesSinceOpen = minutesFromSessionOpen(confirmationBar);
        if (
            minutesSinceOpen < strategyConfig.openingRangeMinutes
            || minutesSinceOpen >= strategyConfig.openingRangeMinutes + evaluationWindowMinutes
        ) {
            continue;
        }

        if (confirmationBar.close > openingRange.high) {
            breakoutBar = confirmationBar;
            side = 'buy';
            break;
        }

        if (confirmationBar.close < openingRange.low) {
            breakoutBar = confirmationBar;
            side = 'sell';
            break;
        }
    }

    if (!breakoutBar || side === 'none') {
        return null;
    }

    if (!passesBreakoutQualityFilters({
        sessionBars,
        sessionDate,
        side,
        breakoutBar,
        openingRangeHigh: openingRange.high,
        openingRangeLow: openingRange.low,
        confirmationBars,
    })) {
        return null;
    }

    const breakoutIndex = sessionBars.findIndex((bar) => bar.timestamp === breakoutBar.timestamp);
    if (breakoutIndex <= 0) {
        return null;
    }

    const preBreakoutBar = sessionBars[breakoutIndex - 1];
    const preBreakoutWickPrice = side === 'buy' ? preBreakoutBar.high : preBreakoutBar.low;

    const postBreakoutBars = sessionBars.filter(
        (bar) => new Date(bar.timestamp).getTime() > new Date(breakoutBar.timestamp).getTime()
    );

    for (const retestBar of postBreakoutBars) {
        if (side === 'buy' && retestBar.low <= openingRange.high && retestBar.close > openingRange.high) {
            confirmationRetestBar = retestBar;
            break;
        }

        if (side === 'sell' && retestBar.high >= openingRange.low && retestBar.close < openingRange.low) {
            confirmationRetestBar = retestBar;
            break;
        }
    }

    if (!confirmationRetestBar) {
        return null;
    }

    const atrSourceBars = sessionBars.filter(
        (bar) => new Date(bar.timestamp).getTime() <= new Date(confirmationRetestBar.timestamp).getTime()
    );
    const atr1m = calculateAtr1m(atrSourceBars, 14);
    if (!atr1m) {
        return null;
    }

    const metrics = computeCandidateScore({
        bars: sessionBars,
        breakoutSide: side,
        latestClose: confirmationRetestBar.close,
        openingRangeHigh: openingRange.high,
        openingRangeLow: openingRange.low,
    });

    return {
        symbol,
        side,
        price: confirmationRetestBar.close,
        reason: `confirmed post-opening-range ${side === 'buy' ? 'upside' : 'downside'} breakout retest`,
        score: metrics.score,
        relativeBreakPct: metrics.relativeBreakPct,
        totalVolume: metrics.totalVolume,
        openingRangeHigh: openingRange.high,
        openingRangeLow: openingRange.low,
        atr1m,
        preBreakoutWickPrice,
    };
}

async function evaluateSymbol(
    client: AlpacaClient,
    symbol: string,
    sessionDate: string
): Promise<BreakoutCandidate | null> {
    try {
        // In dryRun mode use the in-memory simulated position table; live modes query Alpaca.
        const rawSim = env.dryRun ? simulatedPositions.get(symbol) : undefined;
        const position = rawSim
            ? { symbol, side: rawSim.side, qty: rawSim.qty, entryPrice: rawSim.entryPrice }
            : (!env.dryRun ? await client.getOpenPosition(symbol) : null);

        if (position) {
            if (position.entryPrice == null) {
                logger.warn('Skipping position management due to missing entry price', {
                    symbol,
                    side: position.side,
                    qty: position.qty,
                });
                return null;
            }

            const bars = await client.getIntradayBars(symbol, sessionDate);
            const sessionBars = dedupeAndSortBars(bars).filter(
                (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate
            );
            const latestBar = sessionBars[sessionBars.length - 1];

            if (!latestBar) {
                logger.debug('Skipping symbol with existing position and no session bars', {
                    symbol,
                    sessionDate,
                    side: position.side,
                    entryPrice: position.entryPrice,
                });
                return null;
            }

            // Dry-run mode: evaluate stop-loss and take-profit on every cycle using bar high/low.
            if (env.dryRun && rawSim) {
                const stopHit = rawSim.side === 'long'
                    ? latestBar.low <= rawSim.stopPrice
                    : latestBar.high >= rawSim.stopPrice;
                const targetHit = rawSim.side === 'long'
                    ? latestBar.high >= rawSim.takeProfitPrice
                    : latestBar.low <= rawSim.takeProfitPrice;

                if (stopHit || targetHit || isInProfitCaptureWindow(latestBar)) {
                    const exitPrice = stopHit
                        ? rawSim.stopPrice
                        : targetHit
                            ? rawSim.takeProfitPrice
                            : latestBar.close;
                    const exitReason = stopHit
                        ? 'stop-loss hit'
                        : targetHit
                            ? 'take-profit hit'
                            : 'profit-capture close';
                    const pnl = rawSim.side === 'long'
                        ? (exitPrice - rawSim.entryPrice) * rawSim.qty
                        : (rawSim.entryPrice - exitPrice) * rawSim.qty;

                    simulatedPositions.delete(symbol);
                    logger.info('Dry-run: simulated position closed', {
                        symbol,
                        side: rawSim.side,
                        exitReason,
                        exitPrice,
                        entryPrice: rawSim.entryPrice,
                        pnl,
                    });
                    emitTradeCloseUiStatus(symbol, pnl);
                    emitTradeMonitorEvent({
                        eventType: 'close',
                        sessionDate,
                        timestamp: latestBar.timestamp,
                        symbol,
                        side: rawSim.side === 'long' ? 'sell' : 'buy',
                        position: rawSim.side,
                        qty: rawSim.qty,
                        entryPrice: rawSim.entryPrice,
                        closePrice: exitPrice,
                        pnl,
                        reason: exitReason,
                    });
                } else {
                    logger.debug('Dry-run: keeping simulated position open', {
                        symbol,
                        side: rawSim.side,
                        entryPrice: rawSim.entryPrice,
                        stopPrice: rawSim.stopPrice,
                        takeProfitPrice: rawSim.takeProfitPrice,
                        latestClose: latestBar.close,
                        latestLow: latestBar.low,
                        latestHigh: latestBar.high,
                    });
                }

                return null;
            }

            if (!isInProfitCaptureWindow(latestBar)) {
                logger.debug('Skipping profit-capture close outside end-of-day window', {
                    symbol,
                    side: position.side,
                    entryPrice: position.entryPrice,
                    latestClose: latestBar.close,
                    latestTimestamp: latestBar.timestamp,
                    forceExitTimeHHMM: strategyConfig.forceExitTimeHHMM,
                });
                return null;
            }

            const shouldClose = shouldClosePositionForProfitCapture({
                side: position.side,
                entryPrice: position.entryPrice,
                latestClose: latestBar.close,
            });

            if (shouldClose) {
                if (env.dryRun) {
                    logger.info('Dry-run: profit-capture rule would close open position', {
                        symbol,
                        side: position.side,
                        entryPrice: position.entryPrice,
                        latestClose: latestBar.close,
                    });
                } else {
                    await client.closePosition(symbol);
                    logger.info('Closed open position for end-of-day profit capture', {
                        symbol,
                        side: position.side,
                        entryPrice: position.entryPrice,
                        latestClose: latestBar.close,
                    });
                }

                const closePnl = position.side === 'long'
                    ? (latestBar.close - position.entryPrice) * position.qty
                    : (position.entryPrice - latestBar.close) * position.qty;
                emitTradeCloseUiStatus(symbol, closePnl);
                emitTradeMonitorEvent({
                    eventType: 'close',
                    sessionDate,
                    timestamp: latestBar.timestamp,
                    symbol,
                    side: position.side === 'long' ? 'sell' : 'buy',
                    position: position.side,
                    qty: position.qty,
                    entryPrice: position.entryPrice,
                    closePrice: latestBar.close,
                    pnl: closePnl,
                    reason: 'profit-capture close',
                });
            } else {
                logger.debug('Keeping open position; close is not yet favorable for profit capture', {
                    symbol,
                    side: position.side,
                    entryPrice: position.entryPrice,
                    latestClose: latestBar.close,
                });
            }

            return null;
        }

        if (executedToday.has(executionKey(sessionDate, symbol))) {
            logger.debug('Skipping symbol already executed today', { symbol, sessionDate });
            return null;
        }

        const bars = await client.getIntradayBars(symbol, sessionDate);
        if (!bars.length) {
            logger.debug('Skipping symbol with no bars', { symbol, sessionDate });
            return null;
        }

        return buildConfirmedBreakoutCandidate(symbol, sessionDate, bars);
    } catch (error) {
        logger.error('Failed evaluating symbol', { symbol, sessionDate, error });
        return null;
    }
}

export async function findBreakoutCandidates(
    client: AlpacaClient,
    sessionDate: string
): Promise<BreakoutCandidate[]> {
    const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
    logger.info('Evaluating most active symbols', {
        sessionDate,
        quantityToRetrieve: env.quantityToRetrieve,
        retrievedCount: symbols.length,
        symbols,
    });

    const results = await Promise.all(
        symbols.map((symbol) => evaluateSymbol(client, symbol, sessionDate))
    );

    const candidates = results.filter((x): x is BreakoutCandidate => x !== null);
    const filteredCandidates = candidates.filter((candidate) => candidateAllowedByTradeType(candidate.side));

    logger.info('Finished candidate scan', {
        sessionDate,
        candidateCount: filteredCandidates.length,
        preFilterCandidateCount: candidates.length,
        candidateTradeType: env.candidateTradeType,
    });

    return filteredCandidates;
}

export async function executeSizedTrades(
    client: AlpacaClient,
    sessionDate: string,
    trades: SizedTrade[]
) {
    const totalPlannedRisk = trades.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
    const totalEstimatedNotional = trades.reduce((sum, t) => sum + t.estimatedNotional, 0);

    logger.info('Processing normalized trade basket', {
        sessionDate,
        tradeCount: trades.length,
        totalPlannedRisk,
        totalEstimatedNotional,
        dryRun: env.dryRun,
    });

    const tradesToExecute: SizedTrade[] = [];

    for (const trade of trades) {
        const key = executionKey(sessionDate, trade.symbol);

        if (executedToday.has(key)) {
            logger.warn('Skipping already executed trade', { symbol: trade.symbol, sessionDate });
            continue;
        }

        executedToday.add(key);
        tradesToExecute.push(trade);
    }

    if (env.dryRun) {
        for (const trade of tradesToExecute) {
            logger.info('Trade executed in dry-run mode; no Alpaca bracket order submitted', {
                symbol: trade.symbol,
                side: trade.side,
                qty: trade.qty,
                entry: trade.price,
                stop: trade.stopPrice,
                target: trade.takeProfitPrice,
                plannedRisk: trade.plannedRiskDollars,
                estimatedNotional: trade.estimatedNotional,
            });

            emitTradeMonitorEvent({
                eventType: 'open',
                sessionDate,
                timestamp: new Date().toISOString(),
                symbol: trade.symbol,
                side: trade.side,
                position: trade.side === 'buy' ? 'long' : 'short',
                qty: trade.qty,
                entryPrice: trade.price,
                stopPrice: trade.stopPrice,
                targetPrice: trade.takeProfitPrice,
                reason: 'dry-run simulated entry',
            });

            simulatedPositions.set(trade.symbol, {
                side: trade.side === 'buy' ? 'long' : 'short',
                entryPrice: trade.price,
                stopPrice: trade.stopPrice,
                takeProfitPrice: trade.takeProfitPrice,
                qty: trade.qty,
            });
        }

        return;
    }

    await Promise.all(
        tradesToExecute.map((trade) =>
            client.submitBracketOrder({
                symbol: trade.symbol,
                side: trade.side,
                qty: trade.qty,
                takeProfitLimitPrice: trade.takeProfitPrice,
                stopLossStopPrice: trade.stopPrice,
            })
        )
    );

    for (const trade of tradesToExecute) {
        emitTradeMonitorEvent({
            eventType: 'open',
            sessionDate,
            timestamp: new Date().toISOString(),
            symbol: trade.symbol,
            side: trade.side,
            position: trade.side === 'buy' ? 'long' : 'short',
            qty: trade.qty,
            entryPrice: trade.price,
            stopPrice: trade.stopPrice,
            targetPrice: trade.takeProfitPrice,
            reason: 'bracket order submitted',
        });
    }

    logger.info('Submitted bracket orders', {
        sessionDate,
        submittedCount: tradesToExecute.length,
        symbols: tradesToExecute.map((trade) => trade.symbol),
    });
}

export async function runCycle(client: AlpacaClient, sessionDate: string) {
    logger.info('Starting run cycle', { sessionDate });

    const account = await client.getAccount();

    if (account.tradingBlocked) {
        logger.warn('Trading is blocked on account', { sessionDate });
        return;
    }

    const candidates = await findBreakoutCandidates(client, sessionDate);
    const { longs, shorts } = rankAndSelectCandidates(candidates, env.maxPositionsPerSide);
    const selected = [...longs, ...shorts];
    const effectiveBuyingPower = Math.min(account.buyingPower, env.hardBasketCap);

    const weightedTrades = buildWeightedRiskTrades(
        selected,
        env.maxTotalRisk,
        env.takeProfitMultiple
    );
    const normalizedTrades = normalizeTradesToConstraints(
        weightedTrades,
        env.maxTotalRisk,
        effectiveBuyingPower,
        env.maxPositionNotional
    );

    logger.info('Cycle summary', {
        sessionDate,
        accountBuyingPower: account.buyingPower,
        effectiveBuyingPower,
        hardBasketCap: env.hardBasketCap,
        candidateCount: candidates.length,
        selectedCount: selected.length,
        weightedTradeCount: weightedTrades.length,
        normalizedTradeCount: normalizedTrades.length,
    });

    await executeSizedTrades(client, sessionDate, normalizedTrades);
    logger.info('Completed run cycle', { sessionDate });
}

export type StartAppOptions = {
    continuous?: boolean;
};

export async function startApp(options?: StartAppOptions) {
    // Reset per-run state so a re-start (e.g. after clearing trades) gets a
    // fresh run rather than being silently skipped by stale Set entries.
    executedToday.clear();
    reportedDates.clear();
    simulatedPositions.clear();

    const client = new AlpacaClient();
    const continuousMode = options?.continuous === true;
    const shouldRunHistorical = env.sessionMode === 'EMULATION' && Boolean(env.sessionDate);

    const nowNy = toNyParts(new Date(), strategyConfig.sessionTimezone);
    const nyToday = nowNy.date;
    const marketCloseMinutes = minutesFromHHMM(strategyConfig.forceExitTimeHHMM);
    const currentMinutes = nowNy.hour * 60 + nowNy.minute;
    const isBeforeMarketClose = currentMinutes < marketCloseMinutes;
    const isLiveEmulation = env.sessionMode === 'EMULATION' && env.sessionDate === nyToday && isBeforeMarketClose;
    const isHistoricalEmulation = shouldRunHistorical && !isLiveEmulation;

    if (continuousMode) {
        logger.info('Program is running in Continuous mode', {
            pollIntervalSeconds: env.pollIntervalSeconds,
        });
    }

    if (env.sessionMode !== 'EMULATION') {
        logger.info('Running in real time', {
            sessionMode: env.sessionMode,
            continuousMode,
        });
    }

    if (isLiveEmulation && !isHistoricalEmulation) {
        logger.info('Running live emulation with continuous mode', {
            sessionDate: env.sessionDate,
            continuousMode,
            liveMarketData: true,
            tradesExecuted: false,
        });
    } else if (isHistoricalEmulation) {
        logger.info('Starting historical ORB report runner', {
            sessionDate: env.sessionDate,
            quantityToRetrieve: env.quantityToRetrieve,
            maxTotalRisk: env.maxTotalRisk,
            continuousMode,
        });

        const allDates = sessionDatesFromAnchorToToday(env.sessionDate);
        const weekdayDates = allDates.filter(isWeekdaySessionDate);
        const endSessionDate = toNyParts(new Date(), strategyConfig.sessionTimezone).date;

        emitBacktestProgressEvent({
            startSessionDate: env.sessionDate,
            endSessionDate,
            totalWeekdaySessions: weekdayDates.length,
            processedDates: 0,
            skippedDates: 0,
            currentSessionDate: null,
            completed: false,
        });

        if (!weekdayDates.length) {
            logger.warn('No weekday sessions found in selected historical window', {
                sessionDate: env.sessionDate,
                nyToday: endSessionDate,
            });

            emitBacktestProgressEvent({
                startSessionDate: env.sessionDate,
                endSessionDate,
                totalWeekdaySessions: 0,
                processedDates: 0,
                skippedDates: 0,
                currentSessionDate: null,
                completed: true,
            });

            return;
        }

        let processedDates = 0;
        let skippedDates = 0;

        for (const sessionDate of weekdayDates) {
            try {
                await emitOpeningRangeUiStatusForSession(client, sessionDate);
                const report = await client.generateOrbReport(sessionDate, { usesHistoricData: true });
                emitHistoricalTradeMonitorEvents(report);
                processedDates += 1;
            } catch (error) {
                skippedDates += 1;
                logger.warn('Skipping historical session due to unavailable data or generation error', {
                    sessionDate,
                    error,
                });
            }

            emitBacktestProgressEvent({
                startSessionDate: env.sessionDate,
                endSessionDate,
                totalWeekdaySessions: weekdayDates.length,
                processedDates,
                skippedDates,
                currentSessionDate: sessionDate,
                completed: false,
            });
        }

        logger.info('Completed historical ORB emulation window', {
            startSessionDate: env.sessionDate,
            endSessionDate,
            totalWeekdaySessions: weekdayDates.length,
            processedDates,
            skippedDates,
        });

        emitBacktestProgressEvent({
            startSessionDate: env.sessionDate,
            endSessionDate,
            totalWeekdaySessions: weekdayDates.length,
            processedDates,
            skippedDates,
            currentSessionDate: null,
            completed: true,
        });

        return;
    }

    const marketOpenMinutes = strategyConfig.sessionOpenHour * 60 + strategyConfig.sessionOpenMinute;
    const openingRangeEndMinutes = marketOpenMinutes + strategyConfig.openingRangeMinutes;
    const isCurrentDayMode = !continuousMode;
    const reportedOpeningRangeByDate = new Set<string>();
    const reportedWaitingBreakoutsByDate = new Set<string>();

    logger.info('Starting ORB normalized weighted-risk runner (daily schedule)', {
        sessionDateMode: 'current-day',
        continuousMode,
        pollIntervalSeconds: env.pollIntervalSeconds,
        maxTotalRisk: env.maxTotalRisk,
        quantityToRetrieve: env.quantityToRetrieve,
        selectionMode: `top ${env.maxPositionsPerSide} longs and top ${env.maxPositionsPerSide} shorts`,
        rewardMode: `${env.stopLossRiskPart}:${env.takeProfitPart}`,
        dryRun: env.dryRun,
        marketOpenMinutes,
        marketCloseMinutes,
    });

    for (; ;) {
        const nyNow = toNyParts(new Date(), strategyConfig.sessionTimezone);
        const sessionDate = nyNow.date;
        const currentMinutes = nyNow.hour * 60 + nyNow.minute;
        const dayOfWeek = new Date().toLocaleString('en-US', {
            timeZone: strategyConfig.sessionTimezone,
            weekday: 'short',
        });
        const isWeekday = !['Sat', 'Sun'].includes(dayOfWeek);

        try {
            if (!isWeekday) {
                logger.info('Market closed (weekend); waiting for next session', {
                    sessionDate,
                    dayOfWeek,
                    currentTime: nyNow.hhmm,
                });
            } else if (currentMinutes < marketOpenMinutes) {
                logger.info('Waiting for market open', { sessionDate, currentTime: nyNow.hhmm });
            } else if (currentMinutes < marketCloseMinutes) {
                if (currentMinutes < openingRangeEndMinutes) {
                    emitUiStatusEvent({ message: 'Determing open range.' });
                } else if (!reportedOpeningRangeByDate.has(sessionDate)) {
                    try {
                        await emitOpeningRangeUiStatusForSession(client, sessionDate);
                        reportedOpeningRangeByDate.add(sessionDate);
                    } catch {
                        // Keep polling; opening-range bars may still be settling in the data source.
                    }
                } else if (!reportedWaitingBreakoutsByDate.has(sessionDate)) {
                    await emitWaitingForBreakoutsUiStatus(client);
                    reportedWaitingBreakoutsByDate.add(sessionDate);
                }

                await runCycle(client, sessionDate);
            } else if (!reportedDates.has(sessionDate)) {
                logger.info('Market closed; generating end-of-day ORB report', {
                    sessionDate,
                    currentTime: nyNow.hhmm,
                    forceExitTime: strategyConfig.forceExitTimeHHMM,
                });

                await client.generateOrbReport(sessionDate);
                reportedDates.add(sessionDate);
                logger.info('Completed live end-of-day ORB report', { sessionDate });

                if (isCurrentDayMode) {
                    logger.info('Current-day mode complete after market close; exiting app', {
                        sessionDate,
                        currentTime: nyNow.hhmm,
                    });
                    return;
                }
            } else {
                logger.info('End-of-day ORB report already generated for session; waiting for next session', {
                    sessionDate,
                    currentTime: nyNow.hhmm,
                });

                if (isCurrentDayMode) {
                    logger.info('Current-day mode already reported after market close; exiting app', {
                        sessionDate,
                        currentTime: nyNow.hhmm,
                    });
                    return;
                }
            }
        } catch (error) {
            logger.error('Unhandled cycle failure', { sessionDate, error });
        }

        await sleep(env.pollIntervalSeconds * 1000);
    }
}