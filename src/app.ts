// Core orbilicious session logic: cycle execution, breakout-candidate
// filtering, trade simulation, dry-run position tracking, and exit
// evaluation.
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
import { logBreakoutHigh, logBreakoutLow, logTradeOpen, logTradeClose } from './trade-logger';
import { ITrader } from './trading/trader-interface';
import { Emulator } from './trading/emulator';
import { LiveTrader } from './trading/live-trader';

const executedToday = new Set<string>();
const reportedDates = new Set<string>();


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
        logger.debug('Trade monitor event', { event, eventType: event.eventType, symbol: event.symbol });
        process.stdout.write(`__TRADE_MONITOR__${payload}\n`);
    } catch {
        // Keep failures silent so monitoring output never blocks strategy execution.
    }
}

function emitBacktestProgressEvent(event: BacktestProgressEvent) {
    try {
        const payload = JSON.stringify(event);
        logger.debug('Backtest progress event', { event });
        process.stdout.write(`__BACKTEST_PROGRESS__${payload}\n`);
    } catch {
        // Keep failures silent so monitoring output never blocks strategy execution.
    }
}

function emitUiStatusEvent(event: UiStatusEvent) {
    try {
        logger.debug('UI status event', { message: event.message });
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

function formatSessionDateForUi(sessionDate: string): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
        return sessionDate;
    }

    const [year, month, day] = sessionDate.split('-');
    return `${month}/${day}/${year}`;
}

async function emitWaitingForBreakoutsUiStatus(client: AlpacaClient, sessionDate: string) {
    try {
        const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
        if (symbols.length) {
            emitUiStatusEvent({
                message: `Identified Breakout Candidates, ${symbols.join(', ')}`,
            });
            return;
        }
    } catch {
        // Fall through to default message if symbol lookup fails.
    }

    emitUiStatusEvent({ message: 'No Breakout Candidates Identified Yet' });
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
        await emitWaitingForBreakoutsUiStatus(client, sessionDate);
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
            stopLossPct: trade.stopLossPct,
            targetPrice: trade.takeProfitPrice,
            reason: 'historical emulation entry',
        });

        logTradeOpen(trade.symbol, trade.price, entryTimestamp);

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

        logTradeClose(trade.symbol, outcome.exitPrice, outcome.exitTimestamp ?? entryTimestamp);
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

function nextMarketDayDate(): string {
    const next = new Date();
    next.setDate(next.getDate() + 1);
    let dayOfWeek = next.toLocaleString('en-US', {
        timeZone: strategyConfig.sessionTimezone,
        weekday: 'short',
    });
    while (['Sat', 'Sun'].includes(dayOfWeek)) {
        next.setDate(next.getDate() + 1);
        dayOfWeek = next.toLocaleString('en-US', {
            timeZone: strategyConfig.sessionTimezone,
            weekday: 'short',
        });
    }
    return toNyParts(next, strategyConfig.sessionTimezone).date;
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

    const trueRanges: number[] = [];
    for (let index = 1; index < bars.length; index++) {
        const current = bars[index];
        const previous = bars[index - 1];
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

function isRetestFreshForEntry(params: {
    retestTimestamp: string;
    sessionDate: string;
}): boolean {
    const { retestTimestamp, sessionDate } = params;
    const maxAgeMinutes = Math.max(0, Math.floor(env.breakoutRetestMaxAgeMinutes));
    if (maxAgeMinutes === 0) {
        return true;
    }

    if (env.sessionMode === 'EMULATION') {
        return true;
    }

    // Only apply staleness checks to the active NY session; historical/report paths keep full-session behavior.
    const nyToday = toNyParts(new Date(), strategyConfig.sessionTimezone).date;
    if (sessionDate !== nyToday) {
        return true;
    }

    const retestMs = new Date(retestTimestamp).getTime();
    if (!Number.isFinite(retestMs)) {
        return false;
    }

    const ageMinutes = (Date.now() - retestMs) / 60000;
    if (!Number.isFinite(ageMinutes)) {
        return false;
    }

    if (ageMinutes < 0) {
        return true;
    }

    return ageMinutes <= maxAgeMinutes;
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

    if (!isRetestFreshForEntry({
        retestTimestamp: confirmationRetestBar.timestamp,
        sessionDate,
    })) {
        logger.debug('Skipping stale breakout retest candidate', {
            symbol,
            sessionDate,
            retestTimestamp: confirmationRetestBar.timestamp,
            breakoutRetestMaxAgeMinutes: env.breakoutRetestMaxAgeMinutes,
        });
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

export async function evaluateSymbol(
    client: AlpacaClient,
    trader: ITrader,
    symbol: string,
    sessionDate: string,
    barsMap?: Map<string, Bar[]>
): Promise<BreakoutCandidate | null> {
    try {
        const position = await trader.getPosition(symbol);

        if (position) {
            if (position.entryPrice == null) {
                logger.warn('Skipping position management due to missing entry price', {
                    symbol, side: position.side, qty: position.qty,
                });
                return null;
            }

            const bars = barsMap?.get(symbol) ?? await client.getIntradayBars(symbol, sessionDate);
            const sessionBars = dedupeAndSortBars(bars).filter(
                (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate
            );
            const latestBar = sessionBars[sessionBars.length - 1];

            if (!latestBar) {
                logger.debug('Skipping symbol with existing position and no session bars', {
                    symbol, sessionDate, side: position.side, entryPrice: position.entryPrice,
                });
                return null;
            }

            const result = await trader.managePosition(
                symbol, position, sessionDate, sessionBars, latestBar
            );

            if (result.action === 'closed') {
                executedToday.add(executionKey(sessionDate, symbol));
            }

            return null;
        }

        if (executedToday.has(executionKey(sessionDate, symbol))) {
            logger.debug('Skipping symbol already executed today', { symbol, sessionDate });
            return null;
        }

        const bars = barsMap?.get(symbol) ?? await client.getIntradayBars(symbol, sessionDate);
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
    trader: ITrader,
    sessionDate: string,
    options?: { mostActiveSymbolLimit?: number },
): Promise<BreakoutCandidate[]> {
    const configuredLimit = options?.mostActiveSymbolLimit;
    const quantityToRetrieve = Number.isFinite(configuredLimit)
        ? Math.floor(Math.max(1, configuredLimit as number))
        : env.quantityToRetrieve;
    const symbols = await client.getMostActiveSymbolsFiltered(quantityToRetrieve);
    logger.info('Evaluating most active symbols', {
        sessionDate,
        quantityToRetrieve,
        retrievedCount: symbols.length,
        symbols,
    });

    const barsMap = await client.getIntradayBarsBatch(symbols, sessionDate);

    const results = await Promise.all(
        symbols.map((symbol) => evaluateSymbol(client, trader, symbol, sessionDate, barsMap))
    );

    const candidates = results.filter((x): x is BreakoutCandidate => x !== null);
    const filteredCandidates = candidates.filter((candidate) => candidateAllowedByTradeType(candidate.side));

    const now = new Date().toISOString();
    for (const c of filteredCandidates) {
        logBreakoutHigh(c.symbol, c.openingRangeHigh, now);
        logBreakoutLow(c.symbol, c.openingRangeLow, now);
    }

    logger.info('Finished candidate scan', {
        sessionDate,
        candidateCount: filteredCandidates.length,
        preFilterCandidateCount: candidates.length,
        candidateTradeType: env.candidateTradeType,
    });

    return filteredCandidates;
}

export async function executeSizedTrades(
    trader: ITrader,
    sessionDate: string,
    trades: SizedTrade[]
): Promise<SizedTrade[]> {
    const totalPlannedRisk = trades.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
    const totalEstimatedNotional = trades.reduce((sum, t) => sum + t.estimatedNotional, 0);

    logger.info('Processing normalized trade basket', {
        sessionDate,
        tradeCount: trades.length,
        totalPlannedRisk,
        totalEstimatedNotional,
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

    if (!tradesToExecute.length) {
        return [];
    }

    await trader.executeTrades(tradesToExecute, sessionDate);
    return tradesToExecute;
}

export async function runCycle(
    client: AlpacaClient,
    trader: ITrader,
    sessionDate: string,
    options?: { mostActiveSymbolLimit?: number },
): Promise<SizedTrade[]> {
    logger.info('Starting run cycle', { sessionDate });

    const account = await trader.getAccount();

    if (account.tradingBlocked) {
        logger.warn('Trading is blocked on account', { sessionDate });
        return [];
    }

    const candidates = await findBreakoutCandidates(client, trader, sessionDate, options);
    const { longs, shorts } = rankAndSelectCandidates(candidates, env.maxPositionsPerSide);
    const selected = [...longs, ...shorts];
    const effectiveBuyingPower = Math.min(account.buyingPower, env.hardBasketCap);

    const usedRisk = trader.computeUsedRisk();
    const realizedLoss = trader.getCumulativeRealizedLoss();
    const remainingRisk = Math.max(0, env.maxTotalRisk - realizedLoss - usedRisk);

    if (remainingRisk <= 0) {
        logger.info('Cumulative risk budget exhausted', { usedRisk, realizedLoss, maxTotalRisk: env.maxTotalRisk, selectedCount: selected.length });
        return [];
    }

    const weightedTrades = buildWeightedRiskTrades(
        selected,
        remainingRisk,
        env.takeProfitMultiple,
        env.maxRiskPctPerSymbol
    );

    const normalizedTrades = normalizeTradesToConstraints(
        weightedTrades,
        remainingRisk,
        effectiveBuyingPower,
        env.maxPositionNotional
    );

    logger.info('Cycle summary', {
        sessionDate,
        accountBuyingPower: account.buyingPower,
        effectiveBuyingPower,
        hardBasketCap: env.hardBasketCap,
        maxTotalRisk: env.maxTotalRisk,
        usedRisk,
        realizedLoss,
        remainingRisk,
        candidateCount: candidates.length,
        selectedCount: selected.length,
        weightedTradeCount: weightedTrades.length,
        normalizedTradeCount: normalizedTrades.length,
    });

    const executed = await executeSizedTrades(trader, sessionDate, normalizedTrades);
    logger.info('Completed run cycle', { sessionDate });
    return executed;
}

export async function manageOpenPositions(
    client: AlpacaClient,
    trader: ITrader,
    sessionDate: string,
): Promise<void> {
    const positions = await trader.getAllPositions();
    if (!positions.length) return;

    await Promise.all(positions.map(async (position) => {
        try {
            const bars = await client.getIntradayBars(position.symbol, sessionDate);
            const sessionBars = dedupeAndSortBars(bars).filter(
                (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate,
            );
            const latestBar = sessionBars[sessionBars.length - 1];
            if (!latestBar) return;

            const result = await trader.managePosition(
                position.symbol, position, sessionDate, sessionBars, latestBar,
            );

            if (result.action === 'closed') {
                executedToday.add(executionKey(sessionDate, position.symbol));
            }
        } catch (error) {
            logger.error('Failed managing open position after breakout window', {
                symbol: position.symbol, sessionDate, error,
            });
        }
    }));
}

export type StartAppOptions = {
    continuous?: boolean;
};

export async function startApp(options?: StartAppOptions) {
    executedToday.clear();
    reportedDates.clear();

    const client = new AlpacaClient();
    const trader: ITrader = env.sessionMode === 'EMULATION'
        ? new Emulator(client)
        : new LiveTrader(client);
    const continuousMode = options?.continuous === true;
    const shouldRunHistorical = env.sessionMode === 'EMULATION' && Boolean(env.sessionDate);

    const nowNy = toNyParts(new Date(), strategyConfig.sessionTimezone);
    const nyToday = nowNy.date;
    const marketCloseMinutes = minutesFromHHMM(strategyConfig.forceExitTimeHHMM);
    const currentMinutes = nowNy.hour * 60 + nowNy.minute;
    const isLiveEmulation = env.sessionMode === 'EMULATION' && env.sessionDate === nyToday;
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

        const endSessionDate = continuousMode
            ? toNyParts(new Date(), strategyConfig.sessionTimezone).date
            : env.sessionDate;
        const weekdayDates = continuousMode
            ? sessionDatesFromAnchorToToday(env.sessionDate).filter(isWeekdaySessionDate)
            : (isWeekdaySessionDate(env.sessionDate) ? [env.sessionDate] : []);

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
                const report = await client.generateOrbReport(sessionDate, {
                    usesHistoricData: true,
                    generateArtifacts: false,
                });
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
    const breakoutWindowEndMinutes = openingRangeEndMinutes + strategyConfig.openingRangeMinutes;
    const isCurrentDayMode = !continuousMode;
    const reportedOpeningRangeByDate = new Set<string>();
    const reportedWaitingBreakoutsByDate = new Set<string>();
    const breakoutScanCompleteByDate = new Set<string>();
    const allRuntimeTrades: SizedTrade[] = [];

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
        openingRangeEndMinutes,
        breakoutWindowEndMinutes,
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
                emitUiStatusEvent({ message: 'NY Markets are closed. ORBilicious will get Most Active Stocks and discover Breakout Candidates once the NY Markets open.' });
                logger.info('Market closed (weekend); waiting for next session', {
                    sessionDate,
                    dayOfWeek,
                    currentTime: nyNow.hhmm,
                });
            } else if (currentMinutes < marketOpenMinutes) {
                emitUiStatusEvent({ message: 'NY Markets are closed. ORBilicious will get Most Active Stocks and discover Breakout Candidates once the NY Markets open.' });
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
                    await emitWaitingForBreakoutsUiStatus(client, sessionDate);
                    reportedWaitingBreakoutsByDate.add(sessionDate);
                }

                if (!breakoutScanCompleteByDate.has(sessionDate)) {
                    const trades = await runCycle(client, trader, sessionDate);
                    if (trades.length > 0) allRuntimeTrades.push(...trades);
                    if (currentMinutes >= breakoutWindowEndMinutes) {
                        logger.info('Breakout window closed; initial scan complete', {
                            sessionDate,
                            currentTime: nyNow.hhmm,
                            breakoutWindowEndMinutes,
                        });
                        breakoutScanCompleteByDate.add(sessionDate);
                    }
                } else {
                    await manageOpenPositions(client, trader, sessionDate);
                }
            } else if (!reportedDates.has(sessionDate)) {
                await manageOpenPositions(client, trader, sessionDate);

                logger.info('Market closed; generating end-of-day ORB report', {
                    sessionDate,
                    currentTime: nyNow.hhmm,
                    forceExitTime: strategyConfig.forceExitTimeHHMM,
                });

                const tradeHistory = trader.getTradeHistory();
                await client.generateOrbReport(sessionDate, { generateArtifacts: false, runtimeTrades: allRuntimeTrades, runtimeTradeHistory: tradeHistory });
                reportedDates.add(sessionDate);
                logger.info('Completed live end-of-day ORB report', { sessionDate });

                if (isCurrentDayMode) {
                    if (isLiveEmulation) {
                        emitUiStatusEvent({ message: 'NY Markets are closed. ORBilicious will get Most Active Stocks and discover Breakout Candidates once the NY Markets open.' });
                    }
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
                emitUiStatusEvent({ message: 'NY Markets are closed. ORBilicious will get Most Active Stocks and discover Breakout Candidates once the NY Markets open.' });
            }
        } catch (error) {
            logger.error('Unhandled cycle failure', { sessionDate, error });
        }

        await sleep(env.pollIntervalSeconds * 1000);
    }
}