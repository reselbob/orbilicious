import { env, strategyConfig } from './config';
import { AlpacaClient } from './alpaca';
import { logger } from './logger';
import { computeOpeningRange, generateOrbSignal } from './strategy';
import { sleep, todayNyDate } from './time';
import {
    BreakoutCandidate,
    SizedTrade,
    buildWeightedRiskTrades,
    computeCandidateScore,
    normalizeTradesToConstraints,
    rankAndSelectCandidates,
} from './basket';

const executedToday = new Set<string>();

function executionKey(sessionDate: string, symbol: string) {
    return `${sessionDate}:${symbol}`;
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

        const cfg = { ...strategyConfig, symbol };
        const openingRange = computeOpeningRange(bars, sessionDate, cfg);

        const signal = generateOrbSignal({
            bars,
            openingRange,
            existingPosition: null,
            cfg,
        });

        const latestBar = bars[bars.length - 1];
        if (!latestBar) return null;

        if (signal.type === 'BUY') {
            const metrics = computeCandidateScore({
                bars,
                breakoutSide: 'buy',
                latestClose: latestBar.close,
                openingRangeHigh: openingRange.high,
                openingRangeLow: openingRange.low,
            });

            return {
                symbol,
                side: 'buy',
                price: signal.price,
                reason: signal.reason,
                score: metrics.score,
                relativeBreakPct: metrics.relativeBreakPct,
                totalVolume: metrics.totalVolume,
                openingRangeHigh: openingRange.high,
                openingRangeLow: openingRange.low,
            };
        }

        if (signal.type === 'SELL') {
            const metrics = computeCandidateScore({
                bars,
                breakoutSide: 'sell',
                latestClose: latestBar.close,
                openingRangeHigh: openingRange.high,
                openingRangeLow: openingRange.low,
            });

            return {
                symbol,
                side: 'sell',
                price: signal.price,
                reason: signal.reason,
                score: metrics.score,
                relativeBreakPct: metrics.relativeBreakPct,
                totalVolume: metrics.totalVolume,
                openingRangeHigh: openingRange.high,
                openingRangeLow: openingRange.low,
            };
        }

        return null;
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
    const { longs, shorts } = rankAndSelectCandidates(candidates);
    const selected = [...longs, ...shorts];

    const weightedTrades = buildWeightedRiskTrades(
        selected,
        env.maxTotalRisk,
        env.takeProfitMultiple
    );
    const normalizedTrades = normalizeTradesToConstraints(
        weightedTrades,
        env.maxTotalRisk,
        account.buyingPower
    );

    logger.info('Cycle summary', {
        sessionDate,
        accountBuyingPower: account.buyingPower,
        candidateCount: candidates.length,
        selectedCount: selected.length,
        weightedTradeCount: weightedTrades.length,
        normalizedTradeCount: normalizedTrades.length,
    });

    await executeSizedTrades(client, sessionDate, normalizedTrades);
    logger.info('Completed run cycle', { sessionDate });
}

export async function startApp() {
    const sessionDate = env.sessionDate || todayNyDate();
    const client = new AlpacaClient();

    logger.info('Starting ORB normalized weighted-risk runner', {
        sessionDate,
        pollIntervalSeconds: env.pollIntervalSeconds,
        maxTotalRisk: env.maxTotalRisk,
        quantityToRetrieve: env.quantityToRetrieve,
        selectionMode: 'top 10 longs and top 10 shorts',
        rewardMode: `${env.stopLossRiskPart}:${env.takeProfitPart}`,
        dryRun: env.dryRun,
    });

    for (; ;) {
        try {
            await runCycle(client, sessionDate);
        } catch (error) {
            logger.error('Unhandled cycle failure', { sessionDate, error });
        }

        await sleep(env.pollIntervalSeconds * 1000);
    }
}