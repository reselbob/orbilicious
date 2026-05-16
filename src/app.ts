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

const executedToday = new Set<string>();
const reportedDates = new Set<string>();

function executionKey(sessionDate: string, symbol: string) {
    return `${sessionDate}:${symbol}`;
}

function minutesFromHHMM(hhmm: string): number {
    const [hour, minute] = hhmm.split(':').map(Number);
    return hour * 60 + minute;
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
    const openingRangeBars = strategyConfig.openingRangeMinutes / strategyConfig.candleMinutes;
    const evaluationWindowBars = openingRangeBars;
    const evaluationBars = sessionBars.slice(openingRangeBars, openingRangeBars + evaluationWindowBars);

    let breakoutBar: Bar | null = null;
    let confirmationRetestBar: Bar | null = null;
    let side: 'buy' | 'sell' | 'none' = 'none';

    for (const evaluationBar of evaluationBars) {
        if (evaluationBar.close > openingRange.high) {
            breakoutBar = evaluationBar;
            side = 'buy';
            break;
        }

        if (evaluationBar.close < openingRange.low) {
            breakoutBar = evaluationBar;
            side = 'sell';
            break;
        }
    }

    if (!breakoutBar || side === 'none') {
        return null;
    }

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
    };
}

async function evaluateSymbol(
    client: AlpacaClient,
    symbol: string,
    sessionDate: string
): Promise<BreakoutCandidate | null> {
    try {
        const position = await client.getOpenPosition(symbol);
        if (position) {
            logger.debug('Skipping symbol with existing position', { symbol, position });
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
    logger.info('Finished candidate scan', { sessionDate, candidateCount: candidates.length });

    return candidates;
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

export async function startApp() {
    const client = new AlpacaClient();

    if (env.runDate) {
        logger.info('Starting historical ORB report runner', {
            runDate: env.runDate,
            quantityToRetrieve: env.quantityToRetrieve,
            maxTotalRisk: env.maxTotalRisk,
        });

        await client.generateOrbReport(env.runDate, { usesHistoricData: true });
        logger.info('Completed historical ORB report run', { runDate: env.runDate });
        return;
    }

    const marketOpenMinutes = strategyConfig.sessionOpenHour * 60 + strategyConfig.sessionOpenMinute;
    const marketCloseMinutes = minutesFromHHMM(strategyConfig.forceExitTimeHHMM);
    const isCurrentDayMode = !env.sessionDate;

    logger.info('Starting ORB normalized weighted-risk runner (daily schedule)', {
        sessionDateMode: isCurrentDayMode ? 'current-day' : 'fixed-session-date',
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
        const sessionDate = env.sessionDate || nyNow.date;
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