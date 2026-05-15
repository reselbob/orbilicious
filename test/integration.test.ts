import { expect } from 'chai';
import { describe, it } from 'mocha';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import {
    buildWeightedRiskTrades,
    computeCandidateScore,
    BreakoutCandidate,
    SizedTrade,
} from '../src/basket';
import { AlpacaClient } from '../src/alpaca';
import { env, strategyConfig } from '../src/config';
import { logger } from '../src/logger';
import { Bar } from '../src/types';
import { sleep, toNyParts } from '../src/time';

type ExitStatus = 'profit' | 'loss' | 'pending';

type TradeOutcome = {
    symbol: string;
    side: 'buy' | 'sell';
    entryPrice: number;
    stopPrice: number;
    takeProfitPrice: number;
    qty: number;
    status: ExitStatus;
    exitPrice: number | null;
    pnl: number;
};

type AtrBreakoutCandidate = BreakoutCandidate & {
    atr1m: number;
};

function toCsv(headers: string[], rows: Array<Record<string, string | number>>) {
    const headerLine = headers.join(',');
    const body = rows.map((row) => headers.map((h) => JSON.stringify(row[h] ?? '')).join(',')).join('\n');
    return `${headerLine}\n${body}`;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function writeHtmlReport(filePath: string, html: string) {
    fs.writeFileSync(filePath, html, 'utf8');
}

async function renderHtmlToPdf(htmlPath: string, pdfPath: string) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            landscape: true,
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });
    } finally {
        await browser.close();
    }
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

function getOpenMarketSessionDate(): string {
    const now = new Date();
    const nyTime = toNyParts(now, strategyConfig.sessionTimezone);
    const dayOfWeek = now.toLocaleString('en-US', {
        timeZone: strategyConfig.sessionTimezone,
        weekday: 'short',
    });
    const currentMinutes = nyTime.hour * 60 + nyTime.minute;
    const marketOpenMinutes = strategyConfig.sessionOpenHour * 60 + strategyConfig.sessionOpenMinute;
    const marketCloseParts = strategyConfig.forceExitTimeHHMM.split(':').map(Number);
    const marketCloseMinutes = marketCloseParts[0] * 60 + marketCloseParts[1];
    const isWeekday = !['Sat', 'Sun'].includes(dayOfWeek);
    const isMarketOpen = isWeekday && currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes;

    if (!isMarketOpen) {
        throw new Error('Market not open');
    }

    return nyTime.date;
}

function getTodayNySessionDate(): string {
    return toNyParts(new Date(), strategyConfig.sessionTimezone).date;
}

function formatNyTime(timestamp: string | null): string {
    if (!timestamp) {
        return '';
    }

    return toNyParts(timestamp, strategyConfig.sessionTimezone).hhmm;
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
    if (atrWindow.length === 0) {
        return null;
    }

    const atr = atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
    return atr > 0 ? atr : null;
}

function buildAtrBasedTrades(candidates: AtrBreakoutCandidate[], maxTotalRisk: number): SizedTrade[] {
    const validCandidates = candidates.filter((candidate) => candidate.score > 0 && candidate.atr1m > 0);
    if (!validCandidates.length) {
        return [];
    }

    const totalScore = validCandidates.reduce((sum, candidate) => sum + candidate.score, 0);
    if (totalScore <= 0) {
        return [];
    }

    return validCandidates.map((candidate) => {
        const assignedRiskDollars = maxTotalRisk * (candidate.score / totalScore);
        const stopDistancePerShare = candidate.atr1m * 1.0;
        const targetDistancePerShare = candidate.atr1m * 1.5;
        const qty = assignedRiskDollars / stopDistancePerShare;

        const stopPrice = candidate.side === 'buy'
            ? candidate.price - stopDistancePerShare
            : candidate.price + stopDistancePerShare;

        const takeProfitPrice = candidate.side === 'buy'
            ? candidate.price + targetDistancePerShare
            : candidate.price - targetDistancePerShare;

        const plannedRiskDollars = qty * stopDistancePerShare;
        const estimatedNotional = qty * candidate.price;

        return {
            ...candidate,
            assignedRiskDollars,
            stopPrice,
            stopDistancePerShare,
            takeProfitPrice,
            qty: Number(qty.toFixed(4)),
            plannedRiskDollars,
            estimatedNotional,
        };
    });
}

// Conservative single-bar fill model:
// if both TP and stop are hit in the same bar, assume stop fills first.
function emulateExit(trade: SizedTrade, barsAfterEntry: Bar[]): TradeOutcome {
    for (const bar of barsAfterEntry) {
        if (trade.side === 'buy') {
            const stopHit = bar.low <= trade.stopPrice;
            const tpHit = bar.high >= trade.takeProfitPrice;

            if (stopHit) {
                return {
                    symbol: trade.symbol,
                    side: trade.side,
                    entryPrice: trade.price,
                    stopPrice: trade.stopPrice,
                    takeProfitPrice: trade.takeProfitPrice,
                    qty: trade.qty,
                    status: 'loss',
                    exitPrice: trade.stopPrice,
                    pnl: (trade.stopPrice - trade.price) * trade.qty,
                };
            }

            if (tpHit) {
                return {
                    symbol: trade.symbol,
                    side: trade.side,
                    entryPrice: trade.price,
                    stopPrice: trade.stopPrice,
                    takeProfitPrice: trade.takeProfitPrice,
                    qty: trade.qty,
                    status: 'profit',
                    exitPrice: trade.takeProfitPrice,
                    pnl: (trade.takeProfitPrice - trade.price) * trade.qty,
                };
            }
        } else {
            const stopHit = bar.high >= trade.stopPrice;
            const tpHit = bar.low <= trade.takeProfitPrice;

            if (stopHit) {
                return {
                    symbol: trade.symbol,
                    side: trade.side,
                    entryPrice: trade.price,
                    stopPrice: trade.stopPrice,
                    takeProfitPrice: trade.takeProfitPrice,
                    qty: trade.qty,
                    status: 'loss',
                    exitPrice: trade.stopPrice,
                    pnl: (trade.price - trade.stopPrice) * trade.qty,
                };
            }

            if (tpHit) {
                return {
                    symbol: trade.symbol,
                    side: trade.side,
                    entryPrice: trade.price,
                    stopPrice: trade.stopPrice,
                    takeProfitPrice: trade.takeProfitPrice,
                    qty: trade.qty,
                    status: 'profit',
                    exitPrice: trade.takeProfitPrice,
                    pnl: (trade.price - trade.takeProfitPrice) * trade.qty,
                };
            }
        }
    }

    return {
        symbol: trade.symbol,
        side: trade.side,
        entryPrice: trade.price,
        stopPrice: trade.stopPrice,
        takeProfitPrice: trade.takeProfitPrice,
        qty: trade.qty,
        status: 'pending',
        exitPrice: null,
        pnl: 0,
    };
}

describe('end-to-end integration', () => {
    it('can execute the entire strategy', async function () {
        this.timeout(190_000);
        const client = new AlpacaClient();
        const sessionDate = getOpenMarketSessionDate();
        const errors: string[] = [];
        let symbols: string[] = [];
        let trades: SizedTrade[] = [];
        let outcomes: TradeOutcome[] = [];

        try {
            symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);

            // (1) Universe retrieval report: human-readable, JSON, CSV.
            logger.info('\n=== Step 1: Most Active Universe ===');
            logger.info(`Session date: ${sessionDate}`);
            logger.info(`Total requested via QUANTITY_TO_RETRIEVE: ${env.quantityToRetrieve}`);
            logger.info(`Total received: ${symbols.length}`);
            logger.info(`Symbols: ${symbols.join(', ')}`);

            const universeRows = symbols.map((symbol, index) => ({ rank: index + 1, symbol }));
            logger.info('Universe JSON:\n' + JSON.stringify(universeRows, null, 2));
            logger.info('Universe CSV:\n' + toCsv(['rank', 'symbol'], universeRows));

            // (2) Poll every 10 seconds for one minute and aggregate bars.
            logger.info('\n=== Step 2: Polling for 1 minute (10-second intervals) ===');
            const pollIntervalMs = 10_000;
            const pollRounds = 6;
            const barsBySymbol = new Map<string, Bar[]>();
            symbols.forEach((symbol) => barsBySymbol.set(symbol, []));

            for (let round = 1; round <= pollRounds; round++) {
                const now = new Date().toISOString();
                logger.info(`Poll ${round}/${pollRounds} at ${now}`);

                const pollResults = await Promise.all(
                    symbols.map(async (symbol) => {
                        try {
                            const bars = await client.getIntradayBars(symbol, sessionDate);
                            const validBars = bars.filter((bar) =>
                                Number.isFinite(bar.open) &&
                                Number.isFinite(bar.high) &&
                                Number.isFinite(bar.low) &&
                                Number.isFinite(bar.close) &&
                                Number.isFinite(bar.volume)
                            );
                            return { symbol, bars: validBars };
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            logger.warn('Bars fetch failed for symbol', { symbol, error: message });
                            errors.push(`bars:${symbol}:${message}`);
                            return { symbol, bars: [] as Bar[] };
                        }
                    })
                );

                for (const { symbol, bars } of pollResults) {
                    const previous = barsBySymbol.get(symbol) ?? [];
                    barsBySymbol.set(symbol, dedupeAndSortBars([...previous, ...bars]));
                    const latest = bars[bars.length - 1];

                    if (latest) {
                        logger.info(
                            `${symbol} latest O:${latest.open.toFixed(2)} H:${latest.high.toFixed(2)} L:${latest.low.toFixed(2)} C:${latest.close.toFixed(2)} V:${latest.volume}`
                        );
                    } else {
                        logger.info(`${symbol} no bars yet`);
                    }
                }

                if (round < pollRounds) {
                    await sleep(pollIntervalMs);
                }
            }

            // (3) Build breakout candidates at one-minute mark and risk-size them using env ratio/risk constraints.
            // We override opening range to one bar (one minute) for this integration run.
            const openingRangeBars = 1;
            const candidates: BreakoutCandidate[] = [];

            for (const symbol of symbols) {
                try {
                    const allBars = barsBySymbol.get(symbol) ?? [];
                    if (allBars.length < 2) continue;

                    const openingBars = allBars.slice(0, openingRangeBars);
                    const openingRangeHigh = Math.max(...openingBars.map((b) => b.high));
                    const openingRangeLow = Math.min(...openingBars.map((b) => b.low));
                    const latest = allBars[allBars.length - 1];

                    const side =
                        latest.close > openingRangeHigh
                            ? 'buy'
                            : latest.close < openingRangeLow
                                ? 'sell'
                                : null;

                    if (!side) continue;

                    const scoreMetrics = computeCandidateScore({
                        bars: allBars,
                        breakoutSide: side,
                        latestClose: latest.close,
                        openingRangeHigh,
                        openingRangeLow,
                    });

                    candidates.push({
                        symbol,
                        side,
                        price: latest.close,
                        reason: `${side === 'buy' ? 'bullish' : 'bearish'} breakout`,
                        score: scoreMetrics.score,
                        relativeBreakPct: scoreMetrics.relativeBreakPct,
                        totalVolume: scoreMetrics.totalVolume,
                        openingRangeHigh,
                        openingRangeLow,
                    });
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.error('Failed evaluating symbol', { symbol, sessionDate, error: message });
                    errors.push(`candidate:${symbol}:${message}`);
                }
            }

            trades = buildWeightedRiskTrades(candidates, env.maxTotalRisk, env.takeProfitMultiple);

            const plannedRows = trades.map((trade) => ({
                symbol: trade.symbol,
                side: trade.side,
                purchasePrice: Number(trade.price.toFixed(2)),
                stopLimitPrice: Number(trade.stopPrice.toFixed(2)),
                profitLimitPrice: Number(trade.takeProfitPrice.toFixed(2)),
                qty: Number(trade.qty.toFixed(4)),
                potentialLoss: Number(trade.plannedRiskDollars.toFixed(2)),
                potentialProfit: Number((Math.abs(trade.takeProfitPrice - trade.price) * trade.qty).toFixed(2)),
            }));

            // (4) Report universe and breakout trade plan in human-readable, JSON, CSV.
            logger.info('\n=== Step 4: Breakout Candidates / Trade Plan ===');
            logger.info(`Breakout candidates found: ${candidates.length}`);
            logger.info(`Trades sized: ${trades.length}`);
            logger.info(`Configured ratio (STOP_LOSS_PROFIT_RATIO): ${env.stopLossProfitRatio}`);
            logger.info(`Configured max risk (MAX_TOTAL_RISK): ${env.maxTotalRisk}`);

            for (const row of plannedRows) {
                logger.info(
                    `${row.symbol} [${row.side}] entry=${row.purchasePrice} stop=${row.stopLimitPrice} tp=${row.profitLimitPrice} qty=${row.qty} maxLoss=${row.potentialLoss}`
                );
            }

            logger.info('Trade Plan JSON:\n' + JSON.stringify(plannedRows, null, 2));
            logger.info(
                'Trade Plan CSV:\n' +
                toCsv(
                    [
                        'symbol',
                        'side',
                        'purchasePrice',
                        'stopLimitPrice',
                        'profitLimitPrice',
                        'qty',
                        'potentialLoss',
                        'potentialProfit',
                    ],
                    plannedRows
                )
            );

            // (5) Emulate exits using subsequent bars relative to the synthetic one-minute entry moment.
            // (6) Report outcome buckets in human-readable, JSON, CSV.
            outcomes = trades.map((trade) => {
                const allBars = barsBySymbol.get(trade.symbol) ?? [];
                const entryTime = allBars.length > 0 ? allBars[allBars.length - 1].timestamp : '';
                const afterEntry = allBars.filter((bar) => new Date(bar.timestamp).getTime() > new Date(entryTime).getTime());
                return emulateExit(trade, afterEntry);
            });

            const soldAtProfit = outcomes.filter((o) => o.status === 'profit');
            const soldAtLoss = outcomes.filter((o) => o.status === 'loss');
            const pendingSale = outcomes.filter((o) => o.status === 'pending');

            logger.info('\n=== Step 6: Simulated Exit Outcomes ===');
            logger.info(`Sold at profit: ${soldAtProfit.length}`);
            soldAtProfit.forEach((o) => {
                logger.info(`${o.symbol} exit=${o.exitPrice} pnl=${o.pnl.toFixed(2)}`);
            });

            logger.info(`Sold at loss: ${soldAtLoss.length}`);
            soldAtLoss.forEach((o) => {
                logger.info(`${o.symbol} exit=${o.exitPrice} pnl=${o.pnl.toFixed(2)}`);
            });

            logger.info(`Pending sale: ${pendingSale.length}`);
            pendingSale.forEach((o) => {
                logger.info(`${o.symbol} entry=${o.entryPrice.toFixed(2)} pnl=${o.pnl.toFixed(2)}`);
            });

            const outcomeRows = outcomes.map((o) => ({
                symbol: o.symbol,
                side: o.side,
                status: o.status,
                entryPrice: Number(o.entryPrice.toFixed(2)),
                exitPrice: o.exitPrice == null ? '' : Number(o.exitPrice.toFixed(2)),
                qty: Number(o.qty.toFixed(4)),
                pnl: Number(o.pnl.toFixed(2)),
            }));

            logger.info(
                'Outcomes JSON:\n' +
                JSON.stringify(
                    {
                        soldAtProfit,
                        soldAtLoss,
                        pendingSale,
                    },
                    null,
                    2
                )
            );
            logger.info(
                'Outcomes CSV:\n' +
                toCsv(['symbol', 'side', 'status', 'entryPrice', 'exitPrice', 'qty', 'pnl'], outcomeRows)
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error('Integration strategy execution failed', { sessionDate, error: message });
            errors.push(`fatal:${message}`);
        } finally {
            // (7) Summary: Total Cash Invested, Maximum Potential Loss, Actual Profit or Loss.
            const totalCashInvested = trades.reduce((sum, t) => sum + t.estimatedNotional, 0);
            const maxPotentialLoss = trades.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
            const actualProfitOrLoss = outcomes.reduce((sum, o) => sum + o.pnl, 0);

            logger.info('\n=== Strategy Summary ===');
            logger.info(`Total symbols requested: ${env.quantityToRetrieve}`);
            logger.info(`Total symbols received: ${symbols.length}`);
            logger.info(`Total trades planned: ${trades.length}`);
            logger.info(`Total Cash Invested: $${totalCashInvested.toFixed(2)}`);
            logger.info(`Maximum Potential Loss: $${maxPotentialLoss.toFixed(2)}`);
            logger.info(`Actual Profit or Loss: $${actualProfitOrLoss.toFixed(2)}`);
            logger.info(`Evaluation errors: ${errors.length}`);
        }

        // Keep integration assertions broad to avoid flaky market-data behavior.
        expect(symbols.length).to.be.greaterThan(0);

        const maxPotentialLoss = trades.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
        expect(maxPotentialLoss).to.be.at.most(env.maxTotalRisk + 0.0001);

        if (trades.length > 0) {
            for (const trade of trades) {
                expect(trade.qty).to.be.greaterThan(0);
                const stopDistance = Math.abs(trade.price - trade.stopPrice);
                const tpDistance = Math.abs(trade.takeProfitPrice - trade.price);
                expect(tpDistance).to.be.closeTo(stopDistance * env.takeProfitMultiple, 0.01);
            }
        }

        if (errors.some((e) => e.startsWith('fatal:'))) {
            expect.fail(`Integration run failed before completion: ${errors.join(' | ')}`);
        }
    });

    it('verifying ORB pattern', async function () {
        this.timeout(150_000);

        const client = new AlpacaClient();
        const sessionDate = '2026-05-14';
        const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
        const reportDir = path.resolve(process.cwd(), 'reports');
        fs.mkdirSync(reportDir, { recursive: true });
        const htmlReportPath = path.join(reportDir, `orb-report-${sessionDate}.html`);
        const pdfReportPath = path.join(reportDir, `orb-report-${sessionDate}.pdf`);

        logger.info('\n=== ORB Verification ===');
        logger.info(`Session date: ${sessionDate}`);
        logger.info(`Symbols received: ${symbols.length}`);

        const openingRangeBars = 15;
        const evaluationWindowBars = 15;
        const evaluationRows: Array<{
            symbol: string;
            openingPrice: number;
            openingRangeHigh: number;
            openingRangeLow: number;
            breakoutPrice: number | null;
            breakoutTimestamp: string | null;
            confirmationRetestPrice: number | null;
            confirmationRetestTimestamp: string | null;
            atr1m: number | null;
            side: 'buy' | 'sell' | 'none';
        }> = [];
        const breakoutCandidates: AtrBreakoutCandidate[] = [];
        const insufficientSymbols: string[] = [];

        const barResults = await Promise.all(
            symbols.map(async (symbol) => {
                try {
                    const bars = await client.getIntradayBars(symbol, sessionDate);
                    return { symbol, bars: dedupeAndSortBars(bars) };
                } catch (error) {
                    logger.warn('Failed loading bars for ORB verification', {
                        symbol,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return { symbol, bars: [] as Bar[] };
                }
            })
        );

        const sessionBarCounts = barResults.map(({ bars }) =>
            bars.filter((bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate).length
        );
        const maxSessionBars = sessionBarCounts.length > 0 ? Math.max(...sessionBarCounts) : 0;

        for (const { symbol, bars } of barResults) {
            // Opening range is the first 15 one-minute bars after the 9:30 open.
            const sessionBars = bars.filter(
                (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate
            );

            if (sessionBars.length < openingRangeBars + evaluationWindowBars) {
                insufficientSymbols.push(symbol);
                continue;
            }

            const openingBars = sessionBars.slice(0, openingRangeBars);
            const openingPrice = openingBars[0].open;
            const openingRangeHigh = Math.max(...openingBars.map((b) => b.high));
            const openingRangeLow = Math.min(...openingBars.map((b) => b.low));

            // Evaluate the following 15 minutes, from 9:45 through 9:59, for the first breakout.
            const evaluationBars = sessionBars.slice(openingRangeBars, openingRangeBars + evaluationWindowBars);
            let breakoutBar: Bar | null = null;
            let confirmationRetestBar: Bar | null = null;
            let side: 'buy' | 'sell' | 'none' = 'none';

            for (const evaluationBar of evaluationBars) {
                if (evaluationBar.close > openingRangeHigh) {
                    breakoutBar = evaluationBar;
                    side = 'buy';
                    break;
                }

                if (evaluationBar.close < openingRangeLow) {
                    breakoutBar = evaluationBar;
                    side = 'sell';
                    break;
                }
            }

            if (breakoutBar && side !== 'none') {
                const postBreakoutBars = sessionBars.filter(
                    (bar) => new Date(bar.timestamp).getTime() > new Date(breakoutBar!.timestamp).getTime()
                );

                for (const retestBar of postBreakoutBars) {
                    if (side === 'buy' && retestBar.low <= openingRangeHigh && retestBar.close > openingRangeHigh) {
                        confirmationRetestBar = retestBar;
                        break;
                    }

                    if (side === 'sell' && retestBar.high >= openingRangeLow && retestBar.close < openingRangeLow) {
                        confirmationRetestBar = retestBar;
                        break;
                    }
                }
            }

            const atrSourceBars = confirmationRetestBar
                ? sessionBars.filter(
                    (bar) => new Date(bar.timestamp).getTime() <= new Date(confirmationRetestBar!.timestamp).getTime()
                )
                : sessionBars;
            const atr1m = calculateAtr1m(atrSourceBars, 14);

            evaluationRows.push({
                symbol,
                openingPrice: Number(openingPrice.toFixed(2)),
                openingRangeHigh: Number(openingRangeHigh.toFixed(2)),
                openingRangeLow: Number(openingRangeLow.toFixed(2)),
                breakoutPrice: breakoutBar ? Number(breakoutBar.close.toFixed(2)) : null,
                breakoutTimestamp: breakoutBar ? breakoutBar.timestamp : null,
                confirmationRetestPrice: confirmationRetestBar ? Number(confirmationRetestBar.close.toFixed(2)) : null,
                confirmationRetestTimestamp: confirmationRetestBar ? confirmationRetestBar.timestamp : null,
                atr1m: atr1m ? Number(atr1m.toFixed(4)) : null,
                side,
            });

            if (side === 'none' || !confirmationRetestBar || !atr1m) {
                continue;
            }

            const scoreMetrics = computeCandidateScore({
                bars: sessionBars,
                breakoutSide: side,
                latestClose: confirmationRetestBar.close,
                openingRangeHigh,
                openingRangeLow,
            });

            breakoutCandidates.push({
                symbol,
                side,
                price: confirmationRetestBar.close,
                reason: `post-opening-range ${side === 'buy' ? 'upside' : 'downside'} breakout`,
                score: scoreMetrics.score,
                relativeBreakPct: scoreMetrics.relativeBreakPct,
                totalVolume: scoreMetrics.totalVolume,
                openingRangeHigh,
                openingRangeLow,
                atr1m,
            });
        }

        const emulatedTrades = buildAtrBasedTrades(
            breakoutCandidates,
            env.maxTotalRisk,
        );
        const tradeBySymbol = new Map(emulatedTrades.map((trade) => [trade.symbol, trade]));
        const sessionBarsBySymbol = new Map<string, Bar[]>();

        for (const { symbol, bars } of barResults) {
            const sessionBars = bars.filter(
                (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate
            );
            if (sessionBars.length === 0) {
                continue;
            }
            sessionBarsBySymbol.set(symbol, sessionBars);
        }

        const totalCandidatesBoughtAtStart = emulatedTrades.length;
        const numberOfCandidatesSoldLong = emulatedTrades.filter((trade) => trade.side === 'buy').length;
        const numberOfCandidatesBoughtShort = emulatedTrades.filter((trade) => trade.side === 'sell').length;
        const totalCostOfBreakoutCandidatePurchases = emulatedTrades.reduce(
            (sum, trade) => sum + trade.estimatedNotional,
            0
        );
        const totalAmountOfCashAtStopLossRisk = emulatedTrades.reduce(
            (sum, trade) => sum + trade.plannedRiskDollars,
            0
        );
        const closedOutcomeBySymbol = new Map<string, TradeOutcome>();
        const finalOutcomeBySymbol = new Map<string, TradeOutcome>();
        evaluationRows.forEach((row) => {
            const trade = tradeBySymbol.get(row.symbol);
            if (!trade || !row.confirmationRetestTimestamp) {
                return;
            }

            const sessionBars = sessionBarsBySymbol.get(row.symbol) ?? [];
            const barsAfterEntry = sessionBars.filter(
                (bar) => new Date(bar.timestamp).getTime() > new Date(row.confirmationRetestTimestamp!).getTime()
            );

            const outcome = emulateExit(trade, barsAfterEntry);
            if (outcome.status !== 'pending') {
                closedOutcomeBySymbol.set(row.symbol, outcome);
                finalOutcomeBySymbol.set(row.symbol, outcome);
                return;
            }

            // If stop/target never triggered, close at end of session (market close proxy: last 1-minute bar).
            const finalBar = sessionBars[sessionBars.length - 1];
            if (!finalBar) {
                return;
            }

            const pnlAtClose = trade.side === 'buy'
                ? (finalBar.close - trade.price) * trade.qty
                : (trade.price - finalBar.close) * trade.qty;

            finalOutcomeBySymbol.set(row.symbol, {
                symbol: trade.symbol,
                side: trade.side,
                entryPrice: trade.price,
                stopPrice: trade.stopPrice,
                takeProfitPrice: trade.takeProfitPrice,
                qty: trade.qty,
                status: 'pending',
                exitPrice: finalBar.close,
                pnl: pnlAtClose,
            });
        });

        const totalProfitLossToDate = [...finalOutcomeBySymbol.values()].reduce((sum, outcome) => sum + outcome.pnl, 0);

        logger.info('ORB Evaluation (human-readable):');
        evaluationRows.forEach((row) => {
            const trade = tradeBySymbol.get(row.symbol);
            logger.info(
                `${row.symbol} open=${row.openingPrice} ORH=${row.openingRangeHigh} ORL=${row.openingRangeLow} breakout=${row.breakoutPrice ?? 'none'} breakoutTime=${formatNyTime(row.breakoutTimestamp) || 'n/a'} retestTime=${formatNyTime(row.confirmationRetestTimestamp) || 'n/a'} stop=${trade ? trade.stopPrice.toFixed(2) : 'n/a'} target=${trade ? trade.takeProfitPrice.toFixed(2) : 'n/a'} side=${row.side}`
            );
        });

        logger.info('ORB Evaluation JSON:\n' + JSON.stringify(evaluationRows, null, 2));
        logger.info(
            'ORB Evaluation CSV:\n' +
            toCsv(
                [
                    'symbol',
                    'openingPrice',
                    'openingRangeHigh',
                    'openingRangeLow',
                    'breakoutPrice',
                    'breakoutTimestamp',
                    'confirmationRetestPrice',
                    'confirmationRetestTimestamp',
                    'side',
                ],
                evaluationRows.map((row) => ({
                    ...row,
                    breakoutPrice: row.breakoutPrice ?? '',
                    breakoutTimestamp: row.breakoutTimestamp ?? '',
                    confirmationRetestPrice: row.confirmationRetestPrice ?? '',
                    confirmationRetestTimestamp: row.confirmationRetestTimestamp ?? '',
                    atr1m: row.atr1m ?? '',
                }))
            )
        );

        logger.info(`Breakout candidates during the second 15-minute window: ${breakoutCandidates.length}`);
        logger.info(`Emulated trades after confirmation retest: ${emulatedTrades.length}`);

        const openingPriceRowsHtml = evaluationRows
            .map(
                (row) => `
                    <tr>
                        <td>${escapeHtml(row.symbol)}</td>
                        <td>${row.openingPrice.toFixed(2)}</td>
                        <td>${row.openingRangeHigh.toFixed(2)}</td>
                        <td>${row.openingRangeLow.toFixed(2)}</td>
                    </tr>`
            )
            .join('');

        const confirmedTradeRowsHtml = emulatedTrades
            .map((trade, index) => {
                const row = evaluationRows.find((evaluationRow) => evaluationRow.symbol === trade.symbol);
                const closedOutcome = closedOutcomeBySymbol.get(trade.symbol);
                const finalOutcome = finalOutcomeBySymbol.get(trade.symbol);
                const closedProfitLoss = finalOutcome ? finalOutcome.pnl.toFixed(2) : 'Open';
                const exitType = closedOutcome ? 'Stop/Target' : finalOutcome ? 'Market Close' : 'Open';

                return `
                    <tr>
                        <td>${index + 1}</td>
                        <td>${escapeHtml(trade.symbol)}</td>
                        <td>${trade.qty.toFixed(4)}</td>
                        <td>${escapeHtml(trade.side)}</td>
                        <td>${row?.breakoutPrice != null ? row.breakoutPrice.toFixed(2) : 'n/a'}</td>
                        <td>${escapeHtml(formatNyTime(row?.breakoutTimestamp ?? null) || 'n/a')}</td>
                        <td>${row?.confirmationRetestPrice != null ? row.confirmationRetestPrice.toFixed(2) : 'n/a'}</td>
                        <td>${escapeHtml(formatNyTime(row?.confirmationRetestTimestamp ?? null) || 'n/a')}</td>
                        <td>${trade.price.toFixed(2)}</td>
                        <td>${trade.stopPrice.toFixed(2)}</td>
                        <td>${trade.takeProfitPrice.toFixed(2)}</td>
                        <td>${closedProfitLoss}</td>
                        <td>${exitType}</td>
                    </tr>`;
            })
            .join('');

        const htmlReport = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ORB Verification Report ${escapeHtml(sessionDate)}</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #f5efe5;
            --panel: #fffaf2;
            --ink: #1f2937;
            --muted: #6b7280;
            --accent: #0f766e;
            --accent-soft: #d9f3ee;
            --border: #e7dcc8;
            --warn: #9a3412;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Georgia, 'Times New Roman', serif;
            background: linear-gradient(180deg, #efe4d2 0%, var(--bg) 35%, #f9f4ec 100%);
            color: var(--ink);
        }
        .page {
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 24px 64px;
        }
        .hero {
            background: radial-gradient(circle at top left, #fff6e7, var(--panel));
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 18px 60px rgba(31, 41, 55, 0.08);
        }
        .eyebrow {
            margin: 0 0 8px;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--accent);
        }
        h1 {
            margin: 0;
            font-size: 42px;
            line-height: 1.05;
        }
        .subtitle {
            margin: 12px 0 0;
            font-size: 17px;
            color: var(--muted);
        }
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 14px;
            margin-top: 24px;
        }
        .metric {
            background: var(--accent-soft);
            border-radius: 18px;
            padding: 16px 18px;
        }
        .metric-label {
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .metric-value {
            display: block;
            margin-top: 6px;
            font-size: 28px;
            font-weight: 700;
            color: var(--accent);
        }
        .section {
            margin-top: 28px;
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 24px;
            box-shadow: 0 12px 40px rgba(31, 41, 55, 0.05);
        }
        h2 {
            margin: 0 0 6px;
            font-size: 24px;
        }
        .section-copy {
            margin: 0 0 18px;
            color: var(--muted);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            overflow: hidden;
            border-radius: 16px;
        }
        thead th {
            background: #f1e6d7;
            color: #3f3f46;
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        th, td {
            padding: 12px 14px;
            border-bottom: 1px solid var(--border);
            text-align: left;
            vertical-align: top;
        }
        tbody tr:nth-child(even) {
            background: #fffcf7;
        }
        .chip {
            display: inline-block;
            padding: 4px 10px;
            border-radius: 999px;
            font-size: 12px;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            background: #efe5d5;
        }
        .note {
            margin-top: 14px;
            padding: 14px 16px;
            border-radius: 16px;
            background: #fff4ed;
            color: var(--warn);
        }
        code {
            font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
            font-size: 13px;
        }
    </style>
</head>
<body>
    <main class="page">
        <section class="hero">
            <p class="eyebrow">Orbilicious Integration Report</p>
            <h1>Opening Range Breakout Verification</h1>
            <p class="subtitle">Historical backtest for the New York session on ${escapeHtml(sessionDate)} using the first 15 minutes for the opening range and the following 15 minutes for breakout detection, then managing positions until market close.</p>
            <div class="metrics">
                <div class="metric"><span class="metric-label">Symbols Requested</span><span class="metric-value">${env.quantityToRetrieve}</span></div>
                <div class="metric"><span class="metric-label">Symbols Received</span><span class="metric-value">${symbols.length}</span></div>
                <div class="metric"><span class="metric-label">Max Session Bars</span><span class="metric-value">${maxSessionBars}</span></div>
                <div class="metric"><span class="metric-label">Confirmed Candidates</span><span class="metric-value">${breakoutCandidates.length}</span></div>
                <div class="metric"><span class="metric-label">Emulated Trades</span><span class="metric-value">${emulatedTrades.length}</span></div>
            </div>
        </section>

        <section class="section">
            <h2>Opening Prices</h2>
            <p class="section-copy">Each most-active symbol with its market opening price and the derived opening-range high and low.</p>
            <table>
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Open</th>
                        <th>15 Min High</th>
                        <th>15 Min Low</th>
                    </tr>
                </thead>
                <tbody>${openingPriceRowsHtml}</tbody>
            </table>
        </section>

        <section class="section">
            <h2>Summary</h2>
            <p class="section-copy">Current run summary based on emulated ORB entries and latest available session prices.</p>
            <table>
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Value</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td>Total Number of Candidates Bought at Start</td><td>${totalCandidatesBoughtAtStart}</td></tr>
                    <tr><td>Number of Candidates Sold Long</td><td>${numberOfCandidatesSoldLong}</td></tr>
                    <tr><td>Number of Candidates Bought Short</td><td>${numberOfCandidatesBoughtShort}</td></tr>
                    <tr><td>Total cost of Breakout Candidate purchases</td><td>${totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td></tr>
                    <tr><td>Total amount of cash at stop loss risk</td><td>${totalAmountOfCashAtStopLossRisk.toFixed(2)}</td></tr>
                    <tr><td>Total Profit (Loss) to Date</td><td>${totalProfitLossToDate.toFixed(2)}</td></tr>
                </tbody>
            </table>
        </section>

        <section class="section">
            <h2>Breakout Candidates</h2>
            <p class="section-copy">Detected breakout symbols, breakout timing, retest confirmation timing, and the emulated stop/target generated by the current risk algorithm.</p>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Symbol</th>
                        <th>Number of Shares Bought</th>
                        <th>Side</th>
                        <th>Breakout Price</th>
                        <th>Breakout Time</th>
                        <th>Retest Price</th>
                        <th>Retest Time</th>
                        <th>Entry</th>
                        <th>Stop</th>
                        <th>Target</th>
                        <th>Profit (Loss)</th>
                        <th>Exit</th>
                    </tr>
                </thead>
                <tbody>${confirmedTradeRowsHtml}</tbody>
            </table>
            <div class="note">
                Symbols with fewer than 30 session bars: <strong>${insufficientSymbols.length}</strong>
                <br />
                ${escapeHtml(insufficientSymbols.length > 0 ? insufficientSymbols.join(', ') : 'None')}
            </div>
        </section>
    </main>
</body>
</html>`;

        writeHtmlReport(htmlReportPath, htmlReport);
        await renderHtmlToPdf(htmlReportPath, pdfReportPath);
        fs.unlinkSync(htmlReportPath);
        logger.info(`PDF report written: ${pdfReportPath}`);

        if (maxSessionBars < openingRangeBars + evaluationWindowBars) {
            expect.fail(`Today has fewer than 30 session bars. Highest session bar count found: ${maxSessionBars}`);
        }

        expect(symbols.length).to.be.greaterThan(0);
        expect(evaluationRows.length).to.be.greaterThan(0);

        breakoutCandidates.forEach((candidate) => {
            if (candidate.side === 'buy') {
                expect(candidate.price).to.be.greaterThan(candidate.openingRangeHigh);
            } else {
                expect(candidate.price).to.be.lessThan(candidate.openingRangeLow);
            }
        });
    });
});
