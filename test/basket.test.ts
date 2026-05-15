import { expect } from 'chai';
import { describe, it } from 'mocha';
import {
    buildWeightedRiskTrades,
    computeCandidateScore,
    normalizeTradesToConstraints,
    rankAndSelectCandidates,
    sumVolume,
} from '../src/basket';
import { Bar } from '../src/types';
import { env } from '../src/config';
import { AlpacaClient } from '../src/alpaca';
import { toNyParts } from '../src/time';
import { logger } from '../src/logger';

type Candidate = {
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    reason: string;
    score: number;
    relativeBreakPct: number;
    totalVolume: number;
    openingRangeHigh: number;
    openingRangeLow: number;
};

describe('basket integration', () => {
    it('sums volume correctly', () => {
        const bars: Bar[] = [
            { symbol: 'AAA', timestamp: '2026-05-13T13:30:00Z', open: 1, high: 1, low: 1, close: 1, volume: 100 },
            { symbol: 'AAA', timestamp: '2026-05-13T13:31:00Z', open: 1, high: 1, low: 1, close: 1, volume: 250 },
        ];

        expect(sumVolume(bars)).to.equal(350);
    });

    it('computes breakout score using relative breakout percent and log-volume', () => {
        const bars: Bar[] = [
            { symbol: 'AAA', timestamp: '2026-05-13T13:30:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { symbol: 'AAA', timestamp: '2026-05-13T13:31:00Z', open: 101, high: 102, low: 100, close: 101, volume: 9000 },
        ];

        const result = computeCandidateScore({
            bars,
            breakoutSide: 'buy',
            latestClose: 105,
            openingRangeHigh: 100,
            openingRangeLow: 95,
        });

        expect(result.totalVolume).to.equal(10000);
        expect(result.relativeBreakPct).to.equal(5);
        expect(result.score).to.be.closeTo(20, 0.0001);
    });

    it('selects and sizes all QUANTITY_TO_RETRIEVE candidate trades with weighted risk so total stop loss never exceeds MAX_TOTAL_RISK', async () => {
        // Fetch the most active symbols from Alpaca using QUANTITY_TO_RETRIEVE
        const client = new AlpacaClient();
        const tickerSymbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
        console.log(`\n=== Fetched ${tickerSymbols.length} most active symbols from Alpaca ===`);
        console.log(tickerSymbols.join(', '));

        // Generate opening range for 15 minutes (9:30 to 9:44)
        const openingRangeHigh = 101;
        const openingRangeLow = 99;
        const candidates: Candidate[] = [];

        console.log(`\n=== Opening Range: H=${openingRangeHigh} L=${openingRangeLow} ===`);
        console.log(`\n=== Generating ${tickerSymbols.length} candidates from 15-minute price action ===`);

        const numSymbols = tickerSymbols.length;

        // Generate opening 15 minutes of data to identify candidates
        interface SymbolData {
            symbol: string;
            trend: 'up' | 'down' | 'sideways';
            bars: Bar[];
        }

        const symbolDataMap = new Map<string, SymbolData>();

        for (let i = 0; i < numSymbols; i++) {
            const symbol = tickerSymbols[i];
            const trend = i % 3 === 0 ? 'up' : i % 3 === 1 ? 'down' : 'sideways';
            const bars: Bar[] = [];
            let currentPrice = 100;

            // Generate bars from 9:30 to 9:44 (15 minutes)
            for (let minute = 30; minute <= 44; minute++) {
                const trendBias = trend === 'up' ? 0.3 : trend === 'down' ? -0.3 : 0;
                const randomMove = (Math.random() - 0.5) * 2 + trendBias;
                const newPrice = currentPrice + randomMove;

                const open = currentPrice;
                const close = newPrice;
                const high = Math.max(open, close) + Math.abs(Math.random() * 0.5);
                const low = Math.min(open, close) - Math.abs(Math.random() * 0.5);
                const volume = Math.floor(Math.random() * 5000 + 2000);

                bars.push({
                    symbol,
                    timestamp: `2026-05-13T09:${String(minute).padStart(2, '0')}:00Z`,
                    open,
                    high,
                    low,
                    close,
                    volume,
                });

                currentPrice = close;
            }

            symbolDataMap.set(symbol, { symbol, trend, bars });

            const latestBar = bars[bars.length - 1];
            const side = latestBar.close > openingRangeHigh ? 'buy' : latestBar.close < openingRangeLow ? 'sell' : null;

            if (side) {
                const metrics = computeCandidateScore({
                    bars,
                    breakoutSide: side,
                    latestClose: latestBar.close,
                    openingRangeHigh,
                    openingRangeLow,
                });

                candidates.push({
                    symbol,
                    side,
                    price: latestBar.close,
                    reason: `${trend} breakout`,
                    score: metrics.score,
                    relativeBreakPct: metrics.relativeBreakPct,
                    totalVolume: metrics.totalVolume,
                    openingRangeHigh,
                    openingRangeLow,
                });
            }
        }

        console.log(`\n=== Candidate Summary ===`);
        console.log(`Total candidates identified: ${candidates.length}`);

        // Build weighted-risk trades using all candidates, constrained by MAX_TOTAL_RISK
        const trades = buildWeightedRiskTrades(candidates, env.maxTotalRisk, env.takeProfitMultiple);

        console.log(`\n=== Trade Sizing (MAX_TOTAL_RISK=${env.maxTotalRisk}, Stop-Loss-Profit Ratio=${env.stopLossProfitRatio}) ===`);
        const tradeMap = new Map<string, typeof trades[0]>();

        trades.forEach((trade) => {
            tradeMap.set(trade.symbol, trade);
            console.log(
                `${trade.symbol} [${trade.side}] | Price: ${trade.price.toFixed(2)} | Stop: ${trade.stopPrice.toFixed(2)} | TP: ${trade.takeProfitPrice.toFixed(2)} | Qty: ${trade.qty.toFixed(4)} | Risk: $${trade.plannedRiskDollars.toFixed(2)}`
            );
        });

        const totalRisk = trades.reduce((sum, trade) => sum + trade.plannedRiskDollars, 0);
        console.log(`\nTotal Planned Risk: $${totalRisk.toFixed(2)} (max: $${env.maxTotalRisk})`);

        // Monitor candlesticks for 15 minutes (9:30 to 9:44), reporting each minute
        console.log(`\n=== Monitoring 15-Minute Candlesticks & Trade Outcomes ===`);

        const tradeOutcomes = new Map<string, 'stopped' | 'taken_profit' | 'pending'>();
        trades.forEach((trade) => {
            tradeOutcomes.set(trade.symbol, 'pending');
        });

        for (let minute = 30; minute <= 44; minute++) {
            console.log(`\n--- Minute ${minute - 30 + 1} (09:${minute}) ---`);

            for (const symbol of symbolDataMap.keys()) {
                const trade = tradeMap.get(symbol);
                if (!trade || tradeOutcomes.get(symbol) !== 'pending') continue;

                const symbolData = symbolDataMap.get(symbol)!;
                const bar = symbolData.bars.find((b) => parseInt(b.timestamp.split(':')[1]) === minute);

                if (bar) {
                    console.log(
                        `${symbol} | O:${bar.open.toFixed(2)} H:${bar.high.toFixed(2)} L:${bar.low.toFixed(2)} C:${bar.close.toFixed(2)} V:${bar.volume}`
                    );

                    // Check for trade outcomes
                    if (trade.side === 'buy') {
                        if (bar.low <= trade.stopPrice) {
                            console.log(`  >>> ${symbol} STOPPED OUT at ${trade.stopPrice.toFixed(2)}`);
                            tradeOutcomes.set(symbol, 'stopped');
                        } else if (bar.high >= trade.takeProfitPrice) {
                            console.log(`  >>> ${symbol} TAKE PROFIT at ${trade.takeProfitPrice.toFixed(2)}`);
                            tradeOutcomes.set(symbol, 'taken_profit');
                        }
                    } else {
                        if (bar.high >= trade.stopPrice) {
                            console.log(`  >>> ${symbol} STOPPED OUT at ${trade.stopPrice.toFixed(2)}`);
                            tradeOutcomes.set(symbol, 'stopped');
                        } else if (bar.low <= trade.takeProfitPrice) {
                            console.log(`  >>> ${symbol} TAKE PROFIT at ${trade.takeProfitPrice.toFixed(2)}`);
                            tradeOutcomes.set(symbol, 'taken_profit');
                        }
                    }
                }
            }
        }

        // Summary of trade outcomes
        console.log(`\n=== Trade Outcomes Summary ===`);
        let stoppedCount = 0;
        let profitCount = 0;
        let pendingCount = 0;

        tradeOutcomes.forEach((outcome, symbol) => {
            const trade = tradeMap.get(symbol)!;
            if (outcome === 'stopped') {
                console.log(`${symbol}: STOPPED OUT (Risk: $${trade.plannedRiskDollars.toFixed(2)})`);
                stoppedCount++;
            } else if (outcome === 'taken_profit') {
                const profit = trade.side === 'buy'
                    ? (trade.takeProfitPrice - trade.price) * trade.qty
                    : (trade.price - trade.takeProfitPrice) * trade.qty;
                console.log(`${symbol}: TAKEN PROFIT (Gain: $${profit.toFixed(2)})`);
                profitCount++;
            } else {
                console.log(`${symbol}: PENDING`);
                pendingCount++;
            }
        });

        console.log(`\nStats: ${profitCount} profit | ${stoppedCount} stopped | ${pendingCount} pending`);

        // Verify all candidates are considered and sized by weighted risk
        expect(trades.length).to.be.greaterThan(0);
        expect(trades.length).to.be.at.most(candidates.length);

        // Verify total risk never exceeds MAX_TOTAL_RISK
        expect(totalRisk).to.be.at.most(env.maxTotalRisk + 0.0001);

        // Verify each trade has valid qty, stop, and TP prices
        trades.forEach((trade) => {
            expect(trade.qty).to.be.greaterThan(0);
            expect(trade.stopPrice).to.exist;
            expect(trade.takeProfitPrice).to.exist;

            if (trade.side === 'buy') {
                expect(trade.stopPrice).to.be.lessThan(trade.price);
                expect(trade.takeProfitPrice).to.be.greaterThan(trade.price);
            } else {
                expect(trade.stopPrice).to.be.greaterThan(trade.price);
                expect(trade.takeProfitPrice).to.be.lessThan(trade.price);
            }
        });
    });

    it('builds weighted-risk trades and sets 4R profit targets', () => {
        const candidates = [
            {
                symbol: 'AAA',
                side: 'buy' as const,
                price: 110,
                reason: 'breakout',
                score: 3,
                relativeBreakPct: 2,
                totalVolume: 100000,
                openingRangeHigh: 108,
                openingRangeLow: 100,
            },
            {
                symbol: 'BBB',
                side: 'sell' as const,
                price: 90,
                reason: 'breakdown',
                score: 1,
                relativeBreakPct: 1,
                totalVolume: 100000,
                openingRangeHigh: 100,
                openingRangeLow: 92,
            },
        ];

        const trades = buildWeightedRiskTrades(candidates, 1000);

        expect(trades).to.have.length(2);

        const aaa = trades.find((t) => t.symbol === 'AAA')!;
        const bbb = trades.find((t) => t.symbol === 'BBB')!;

        expect(aaa.assignedRiskDollars).to.be.closeTo(750, 0.0001);
        expect(bbb.assignedRiskDollars).to.be.closeTo(250, 0.0001);

        expect(aaa.stopPrice).to.equal(100);
        expect(aaa.stopDistancePerShare).to.equal(10);
        expect(aaa.takeProfitPrice).to.equal(150);

        expect(bbb.stopPrice).to.equal(100);
        expect(bbb.stopDistancePerShare).to.equal(10);
        expect(bbb.takeProfitPrice).to.equal(50);
    });

    it('normalizes the basket so risk and notional fit constraints simultaneously', () => {
        const trades = buildWeightedRiskTrades(
            [
                {
                    symbol: 'AAA',
                    side: 'buy' as const,
                    price: 200,
                    reason: 'breakout',
                    score: 1,
                    relativeBreakPct: 2,
                    totalVolume: 100000,
                    openingRangeHigh: 195,
                    openingRangeLow: 190,
                },
                {
                    symbol: 'BBB',
                    side: 'buy' as const,
                    price: 300,
                    reason: 'breakout',
                    score: 1,
                    relativeBreakPct: 2,
                    totalVolume: 100000,
                    openingRangeHigh: 295,
                    openingRangeLow: 290,
                },
            ],
            1000
        );

        const normalized = normalizeTradesToConstraints(trades, 1000, 10000);

        const totalRisk = normalized.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
        const totalNotional = normalized.reduce((sum, t) => sum + t.estimatedNotional, 0);

        expect(totalRisk).to.be.at.most(1000.0001);
        expect(totalNotional).to.be.at.most(10000.0001);
    });

    it('applies configured STOP_LOSS_PROFIT_RATIO (1:2) so take-profit distance equals 2x stop distance', () => {
        const buyCandidate = {
            symbol: 'BUY_TEST',
            side: 'buy' as const,
            price: 100,
            reason: 'breakout',
            score: 1,
            relativeBreakPct: 2,
            totalVolume: 100000,
            openingRangeHigh: 105,
            openingRangeLow: 95,
        };

        const sellCandidate = {
            symbol: 'SELL_TEST',
            side: 'sell' as const,
            price: 100,
            reason: 'breakdown',
            score: 1,
            relativeBreakPct: 2,
            totalVolume: 100000,
            openingRangeHigh: 105,
            openingRangeLow: 95,
        };

        const takeProfitMultiple = 2;
        const trades = buildWeightedRiskTrades([buyCandidate, sellCandidate], 1000, takeProfitMultiple);

        expect(trades).to.have.length(2);

        const buyTrade = trades.find((t) => t.symbol === 'BUY_TEST')!;
        const sellTrade = trades.find((t) => t.symbol === 'SELL_TEST')!;

        const buyStopDistance = buyTrade.price - buyTrade.stopPrice;
        const buyTPDistance = buyTrade.takeProfitPrice - buyTrade.price;
        expect(buyTPDistance).to.equal(buyStopDistance * takeProfitMultiple);

        const sellStopDistance = sellTrade.stopPrice - sellTrade.price;
        const sellTPDistance = sellTrade.price - sellTrade.takeProfitPrice;
        expect(sellTPDistance).to.equal(sellStopDistance * takeProfitMultiple);
    });

    it('can weight all breakout candidates to never lose more than MAX_TOTAL_RISK', async function () {
        this.timeout(120_000); // Allow up to 2 minutes for live polling

        const client = new AlpacaClient();

        // Step 1: Fetch QUANTITY_TO_RETRIEVE most active symbols from the live market
        const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
        const sessionDate = toNyParts(new Date()).date;

        logger.info(`\n=== Live Market Poll ===`);
        logger.info(`Session date: ${sessionDate}`);
        logger.info(`Symbols (${symbols.length}): ${symbols.join(', ')}`);

        // Step 2: Poll every 10 seconds for 1 minute (6 polls) to build bar data
        const POLL_INTERVAL_MS = 10_000;
        const POLL_DURATION_MS = 60_000;
        const polls = POLL_DURATION_MS / POLL_INTERVAL_MS; // 6 polls

        // Accumulate the latest snapshot of bars per symbol across all polls
        const barSnapshots = new Map<string, Bar[]>();
        symbols.forEach((s) => barSnapshots.set(s, []));

        for (let poll = 1; poll <= polls; poll++) {
            const pollTime = new Date().toISOString();
            logger.info(`\n--- Poll ${poll}/${polls} at ${pollTime} ---`);

            const results = await Promise.all(
                symbols.map(async (symbol) => {
                    try {
                        const bars = await client.getIntradayBars(symbol, sessionDate);
                        return { symbol, bars };
                    } catch {
                        return { symbol, bars: [] as Bar[] };
                    }
                })
            );

            for (const { symbol, bars } of results) {
                if (bars.length > 0) {
                    // Keep the freshest full snapshot for this symbol
                    barSnapshots.set(symbol, bars);
                    const latest = [...bars].sort(
                        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
                    )[0];
                    logger.info(
                        `  ${symbol} | latest bar: O:${latest.open.toFixed(2)} H:${latest.high.toFixed(2)} L:${latest.low.toFixed(2)} C:${latest.close.toFixed(2)} V:${latest.volume} @ ${latest.timestamp}`
                    );
                } else {
                    logger.info(`  ${symbol} | no bars returned`);
                }
            }

            if (poll < polls) {
                logger.info(`  Waiting ${POLL_INTERVAL_MS / 1000}s before next poll...`);
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
        }

        // Step 3: Use accumulated bar data to derive opening range and identify breakout candidates
        // Opening range = high/low across the first OPENING_RANGE_MINUTES bars (overridden to 1 min for this test)
        const orWindowBars = 1; // 1-minute opening range window (matches our 1-minute poll duration)
        const candidates: Candidate[] = [];

        logger.info(`\n=== Candlestick Summary (Opening Range Window: ${orWindowBars} min) ===`);

        for (const [symbol, allBars] of barSnapshots) {
            if (allBars.length < 2) {
                logger.info(`${symbol}: insufficient bars (${allBars.length}), skipping`);
                continue;
            }

            const sorted = [...allBars].sort(
                (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
            );

            // Opening range from first orWindowBars bars
            const orBars = sorted.slice(0, orWindowBars);
            const orHigh = Math.max(...orBars.map((b) => b.high));
            const orLow = Math.min(...orBars.map((b) => b.low));

            logger.info(`\n${symbol} | OR High: ${orHigh.toFixed(2)} OR Low: ${orLow.toFixed(2)}`);
            sorted.forEach((bar) => {
                logger.info(
                    `  ${bar.timestamp} | O:${bar.open.toFixed(2)} H:${bar.high.toFixed(2)} L:${bar.low.toFixed(2)} C:${bar.close.toFixed(2)} V:${bar.volume}`
                );
            });

            const latestBar = sorted[sorted.length - 1];
            const side =
                latestBar.close > orHigh ? 'buy' :
                    latestBar.close < orLow ? 'sell' : null;

            if (!side) continue;

            const metrics = computeCandidateScore({
                bars: sorted,
                breakoutSide: side,
                latestClose: latestBar.close,
                openingRangeHigh: orHigh,
                openingRangeLow: orLow,
            });

            candidates.push({
                symbol,
                side,
                price: latestBar.close,
                reason: `${side === 'buy' ? 'bullish' : 'bearish'} breakout`,
                score: metrics.score,
                relativeBreakPct: metrics.relativeBreakPct,
                totalVolume: metrics.totalVolume,
                openingRangeHigh: orHigh,
                openingRangeLow: orLow,
            });
        }

        // Step 4: Size shares so aggregate stop-loss never exceeds MAX_TOTAL_RISK (always print summary)
        const trades = candidates.length > 0
            ? buildWeightedRiskTrades(candidates, env.maxTotalRisk, env.takeProfitMultiple)
            : [];

        const totalRisk = trades.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
        const totalProfit = trades.reduce((sum, t) => {
            const tpDist = Math.abs(t.takeProfitPrice - t.price);
            return sum + tpDist * t.qty;
        }, 0);

        logger.info(`\n=== Breakout Candidates Identified: ${candidates.length} ===`);
        candidates.forEach((c) => {
            logger.info(`  ${c.symbol} [${c.side}] price=${c.price.toFixed(2)} score=${c.score.toFixed(4)}`);
        });

        logger.info(`\n=== Final Trade Summary ===`);
        logger.info(`  ${'Symbol'.padEnd(8)} ${'Side'.padEnd(5)} ${'Price'.padStart(10)} ${'Stop Limit'.padStart(12)} ${'Profit Limit'.padStart(14)} ${'Pot. Loss'.padStart(11)}`);
        logger.info(`  ${'-'.repeat(65)}`);
        trades.forEach((trade) => {
            logger.info(
                `  ${trade.symbol.padEnd(8)} ${trade.side.padEnd(5)} ${('$' + trade.price.toFixed(2)).padStart(10)} ${('$' + trade.stopPrice.toFixed(2)).padStart(12)} ${('$' + trade.takeProfitPrice.toFixed(2)).padStart(14)} ${('$' + trade.plannedRiskDollars.toFixed(2)).padStart(11)}`
            );
        });
        logger.info(`  ${'-'.repeat(65)}`);
        logger.info(`  ${'Total Symbols Polled:'.padEnd(38)} ${String(symbols.length).padStart(6)}`);
        logger.info(`  ${'Breakout Symbols Found:'.padEnd(38)} ${String(candidates.length).padStart(6)}`);
        logger.info(`  ${'Breakout Symbols Traded:'.padEnd(38)} ${String(trades.length).padStart(6)}`);
        logger.info(`  ${'Aggregated Potential Loss:'.padEnd(38)} ${('$' + totalRisk.toFixed(2)).padStart(11)}`);
        logger.info(`  ${'Aggregated Potential Profit:'.padEnd(38)} ${('$' + totalProfit.toFixed(2)).padStart(11)}`);
        logger.info(`  ${'MAX_TOTAL_RISK Limit:'.padEnd(38)} ${('$' + env.maxTotalRisk.toFixed(2)).padStart(11)}`);

        if (candidates.length === 0) {
            logger.warn('No breakout candidates found for this session — test passes vacuously.');
            return;
        }

        // Assertions
        expect(trades.length).to.be.greaterThan(0);
        expect(totalRisk).to.be.at.most(env.maxTotalRisk + 0.0001);

        trades.forEach((trade) => {
            expect(trade.qty).to.be.greaterThan(0);
            expect(trade.plannedRiskDollars).to.be.greaterThan(0);

            if (trade.side === 'buy') {
                expect(trade.stopPrice).to.be.lessThan(trade.price);
                expect(trade.takeProfitPrice).to.be.greaterThan(trade.price);
            } else {
                expect(trade.stopPrice).to.be.greaterThan(trade.price);
                expect(trade.takeProfitPrice).to.be.lessThan(trade.price);
            }
        });

        trades.forEach((trade) => {
            const stopDist = Math.abs(trade.price - trade.stopPrice);
            const tpDist = Math.abs(trade.takeProfitPrice - trade.price);
            expect(tpDist).to.be.closeTo(stopDist * env.takeProfitMultiple, 0.01);
        });
    });
});