import { expect } from 'chai';
import { describe, it } from 'mocha';
import { computeOpeningRange, generateOrbSignal } from '../src/strategy';
import { Bar, Position, StrategyConfig } from '../src/types';
import { AlpacaClient } from '../src/alpaca';
import { findBreakoutCandidates, evaluateSymbol } from '../src/app';
import { buildWeightedRiskTrades } from '../src/basket';
import { env, strategyConfig } from '../src/config';
import { logger } from '../src/logger';

function makeBar(minute: number, close: number, high = close + 0.2, low = close - 0.2): Bar {
    const hh = 13;
    const mm = String(minute).padStart(2, '0');
    return {
        symbol: 'SPY',
        timestamp: `2026-05-13T${hh}:${mm}:00Z`,
        open: close,
        high,
        low,
        close,
        volume: 1000,
    };
}

const cfg: StrategyConfig = {
    symbol: 'SPY',
    openingRangeMinutes: 15,
    candleMinutes: 1,
    sessionTimezone: 'America/New_York',
    sessionOpenHour: 9,
    sessionOpenMinute: 30,
    lastEntryTimeHHMM: '15:30',
    forceExitTimeHHMM: '15:55',
    qty: 1,
    allowLong: true,
    allowShort: true,
};

function makeSymbolBreakoutBars(symbol: string, sessionDate: string): Bar[] {
    const bars: Bar[] = [];
    const [year, month, day] = sessionDate.split('-');

    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: `${year}-${month}-${day}T13:${String(minute).padStart(2, '0')}:00Z`,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
        });
    }

    bars.push({
        symbol,
        timestamp: `${year}-${month}-${day}T13:45:00Z`,
        open: 101,
        high: 103,
        low: 100.5,
        close: 102,
        volume: 5000,
    });

    bars.push({
        symbol,
        timestamp: `${year}-${month}-${day}T13:46:00Z`,
        open: 101.2,
        high: 102.2,
        low: 100.9,
        close: 101.5,
        volume: 4500,
    });

    return bars;
}

function makeSymbolBreakdownBars(symbol: string, sessionDate: string): Bar[] {
    const bars: Bar[] = [];
    const [year, month, day] = sessionDate.split('-');

    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: `${year}-${month}-${day}T13:${String(minute).padStart(2, '0')}:00Z`,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
        });
    }

    bars.push({
        symbol,
        timestamp: `${year}-${month}-${day}T13:45:00Z`,
        open: 99,
        high: 99.2,
        low: 97.8,
        close: 98,
        volume: 5000,
    });

    bars.push({
        symbol,
        timestamp: `${year}-${month}-${day}T13:46:00Z`,
        open: 98.8,
        high: 99.2,
        low: 98.2,
        close: 98.5,
        volume: 4500,
    });

    return bars;
}

class DeterministicStrategyClient extends AlpacaClient {
    requestedMostActiveLimit: number | undefined;

    constructor(
        private readonly symbols: string[],
        private readonly sessionDate: string
    ) {
        super();
    }

    async getMostActiveSymbols(limit = 40): Promise<string[]> {
        this.requestedMostActiveLimit = limit;
        return this.symbols;
    }

    async getOpenPosition(_symbol: string): Promise<Position | null> {
        return null;
    }

    async getIntradayBars(symbol: string, _sessionDate: string): Promise<Bar[]> {
        return makeSymbolBreakoutBars(symbol, this.sessionDate);
    }
}

class WickStopDeterministicClient extends AlpacaClient {
    requestedMostActiveLimit: number | undefined;

    constructor(
        private readonly barsBySymbol: Record<string, Bar[]>
    ) {
        super();
    }

    async getMostActiveSymbols(limit = 40): Promise<string[]> {
        this.requestedMostActiveLimit = limit;
        return Object.keys(this.barsBySymbol);
    }

    async getOpenPosition(_symbol: string): Promise<Position | null> {
        return null;
    }

    async getIntradayBars(symbol: string, _sessionDate: string): Promise<Bar[]> {
        return this.barsBySymbol[symbol] ?? [];
    }

    async getIntradayBarsBatch(symbols: string[], _sessionDate: string): Promise<Map<string, Bar[]>> {
        const map = new Map<string, Bar[]>();
        for (const symbol of symbols) {
            map.set(symbol, this.barsBySymbol[symbol] ?? []);
        }
        return map;
    }
}

describe('strategy integration', () => {
    it('computes the 15-minute opening range from 1-minute bars', () => {
        // 15 unique bars for opening range, 1 for breakout/retest
        const bars: Bar[] = [];
        const sessionDate = '2026-05-13';
        // To get high=102.4 at bar 15: 101 + 14*x = 102.4 => x = 0.1
        // To get low=98.3 at bar 15: 99 - 14*y = 98.3 => y = 0.05
        for (let i = 0; i < 15; i++) {
            const minute = 31 + i;
            bars.push({
                symbol: 'SPY',
                timestamp: `${sessionDate}T13:${String(minute).padStart(2, '0')}:00Z`,
                open: 100 + i * 0.1,
                high: 101 + i * 0.1,
                low: 99 - i * 0.05,
                close: 100,
                volume: 1000,
            });
        }
        // Add a bar after opening range to allow computation
        bars.push({
            symbol: 'SPY',
            timestamp: `${sessionDate}T13:45:00Z`,
            open: 102.5,
            high: 103,
            low: 100.5,
            close: 102.5,
            volume: 1000,
        });
        const openingRange = computeOpeningRange(bars.slice(0, 15), sessionDate, cfg);
        expect(openingRange.high).to.equal(102.4);
        expect(openingRange.low).to.equal(98.3);
    });

    it('returns BUY when candle closes above the opening range high', () => {
        const bars: Bar[] = [];
        const sessionDate = '2026-05-13';
        for (let i = 0; i < 15; i++) {
            const minute = 31 + i;
            bars.push({
                symbol: 'SPY',
                timestamp: `${sessionDate}T13:${String(minute).padStart(2, '0')}:00Z`,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            });
        }
        // Add a breakout bar above opening range high
        bars.push({
            symbol: 'SPY',
            timestamp: `${sessionDate}T13:45:00Z`,
            open: 102.5,
            high: 103,
            low: 100.5,
            close: 102.5,
            volume: 1000,
        });
        // Add a retest bar (simulate confirmation logic)
        bars.push({
            symbol: 'SPY',
            timestamp: `${sessionDate}T13:46:00Z`,
            open: 103.1,
            high: 103.2,
            low: 101,
            close: 103.1,
            volume: 1000,
        });
        const openingRange = computeOpeningRange(bars.slice(0, 15), sessionDate, cfg);
        const signal = generateOrbSignal({
            bars,
            openingRange,
            existingPosition: null,
            cfg,
        });
        expect(signal.type).to.equal('BUY');
    });

    it('returns SELL when candle closes below the opening range low', () => {
        const bars: Bar[] = [];
        const sessionDate = '2026-05-13';
        for (let i = 0; i < 15; i++) {
            const minute = 31 + i;
            bars.push({
                symbol: 'SPY',
                timestamp: `${sessionDate}T13:${String(minute).padStart(2, '0')}:00Z`,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            });
        }
        // Add a breakout bar below opening range low
        bars.push({
            symbol: 'SPY',
            timestamp: `${sessionDate}T13:45:00Z`,
            open: 98.0,
            high: 99.2,
            low: 97.8,
            close: 97.8,
            volume: 1000,
        });
        // Add a retest bar (simulate confirmation logic)
        bars.push({
            symbol: 'SPY',
            timestamp: `${sessionDate}T13:46:00Z`,
            open: 97.5,
            high: 98,
            low: 97,
            close: 97.5,
            volume: 1000,
        });
        const openingRange = computeOpeningRange(bars.slice(0, 15), sessionDate, cfg);
        const signal = generateOrbSignal({
            bars,
            openingRange,
            existingPosition: null,
            cfg,
        });
        expect(signal.type).to.equal('SELL');
    });

    it('returns NONE before the opening range completes', () => {
        const bars: Bar[] = [];
        for (let m = 30; m <= 40; m++) {
            bars.push(makeBar(m, 100, 101, 99));
        }
        // Not enough bars for opening range, so signal should be NONE
        const preBreakoutBars = bars.slice(0, 10);
        // Use a dummy opening range for the test (all required fields)
        const openingRange = {
            symbol: 'SPY',
            sessionDate: '2026-05-13',
            startTime: '2026-05-13T13:30:00Z',
            endTime: '2026-05-13T13:45:00Z',
            high: 101,
            low: 99,
        };
        const signal = generateOrbSignal({
            bars: preBreakoutBars,
            openingRange,
            existingPosition: null,
            cfg,
        });
        expect(signal.type).to.equal('NONE');
    });

    it('returns EXIT when an open position exists after force exit time', () => {
        const bars: Bar[] = [];
        const sessionDate = '2026-05-13';
        for (let i = 0; i < 15; i++) {
            const minute = 31 + i;
            bars.push({
                symbol: 'SPY',
                timestamp: `${sessionDate}T13:${String(minute).padStart(2, '0')}:00Z`,
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            });
        }
        // Add a bar at force exit time (15:55 NY, which is 19:55 UTC)
        bars.push({
            symbol: 'SPY',
            timestamp: `${sessionDate}T19:55:00Z`,
            open: 100,
            high: 100.2,
            low: 99.8,
            close: 100,
            volume: 1000,
        });
        const openingRange = computeOpeningRange(bars.slice(0, 15), sessionDate, cfg);
        const signal = generateOrbSignal({
            bars,
            openingRange,
            existingPosition: {
                symbol: 'SPY',
                side: 'long',
                qty: 10,
            },
            cfg,
        });
        expect(signal.type).to.equal('EXIT');
    });

    it('gets most active stocks and determines breakout candidates deterministically', async () => {
        const sessionDate = '2099-05-14';
        const mostActiveSymbols = ['AAPL', 'TSLA', 'NVDA'];
        class TestClient extends AlpacaClient {
            requestedMostActiveLimit: number | undefined;
            constructor(private readonly symbols: string[], private readonly sessionDate: string) {
                super();
            }
            async getMostActiveSymbols(limit = 40): Promise<string[]> {
                this.requestedMostActiveLimit = limit;
                return this.symbols;
            }
            async getOpenPosition(_symbol: string): Promise<Position | null> {
                return null;
            }
            async getIntradayBars(symbol: string, _sessionDate: string): Promise<Bar[]> {
                // 15 bars for opening range, then a breakout bar, then a retest bar
                const bars: Bar[] = [];
                for (let m = 30; m <= 44; m++) {
                    bars.push({
                        symbol,
                        timestamp: `${sessionDate}T13:${String(m).padStart(2, '0')}:00Z`,
                        open: 100,
                        high: 101,
                        low: 99,
                        close: 100,
                        volume: 1000,
                    });
                }
                // Breakout bar (close above opening range high)
                bars.push({
                    symbol,
                    timestamp: `${sessionDate}T13:45:00Z`,
                    open: 101,
                    high: 103,
                    low: 100.5,
                    close: 102.5,
                    volume: 5000,
                });
                // Retest bar: low dips to opening range high (101), closes above it
                bars.push({
                    symbol,
                    timestamp: `${sessionDate}T13:46:00Z`,
                    open: 102.6,
                    high: 103.1,
                    low: 101.0,
                    close: 103.1,
                    volume: 4500,
                });
                return bars;
            }
            async getIntradayBarsBatch(symbols: string[], _sessionDate: string): Promise<Map<string, Bar[]>> {
                const map = new Map<string, Bar[]>();
                for (const symbol of symbols) {
                    map.set(symbol, await this.getIntradayBars(symbol, _sessionDate));
                }
                return map;
            }
        }
        const client = new TestClient(mostActiveSymbols, sessionDate);

        const retrievedSymbols = await client.getMostActiveSymbols(env.quantityToRetrieve);

        logger.info('Got most active stocks', {
            quantityToRetrieve: env.quantityToRetrieve,
            mostActiveCount: retrievedSymbols.length,
            mostActiveSymbols: retrievedSymbols,
        });

        const candidates = await findBreakoutCandidates(client, sessionDate);

        logger.info('Found breakout candidates', {
            mostActiveCount: retrievedSymbols.length,
            breakoutCandidateCount: candidates.length,
            breakoutCandidates: candidates.map((c) => ({ symbol: c.symbol, side: c.side, price: c.price })),
        });

        // getMostActiveSymbolsFiltered internally fetches 4x the desired count, capped at 100
        expect(client.requestedMostActiveLimit).to.equal(Math.min(env.quantityToRetrieve * 4, 100));
        expect(retrievedSymbols).to.deep.equal(mostActiveSymbols);
        expect(candidates).to.be.an('array');
        expect(candidates.map((candidate) => candidate.symbol)).to.deep.equal(mostActiveSymbols);
        expect(candidates.every((candidate) => candidate.side === 'buy')).to.equal(true);
    });

    it('stop loss limit set according to previous to breakout candlestick', async () => {
        const sessionDate = '2099-05-14';
        const longSymbol = 'AAPL';
        const shortSymbol = 'TSLA';

        // Provide bars with a breakout and a retest for both long and short
        function makeLongBreakoutBars(symbol: string, sessionDate: string): Bar[] {
            const bars: Bar[] = [];
            // Opening range bars
            for (let i = 0; i < 15; i++) {
                bars.push({
                    symbol,
                    timestamp: `${sessionDate}T13:${String(31 + i).padStart(2, '0')}:00Z`,
                    open: 100,
                    high: 101,
                    low: 99,
                    close: 100,
                    volume: 1000,
                });
            }
            // Breakout bar: close above OR high
            bars.push({
                symbol,
                timestamp: `${sessionDate}T13:46:00Z`,
                open: 101,
                high: 103,
                low: 100.5,
                close: 103.1, // close > OR high
                volume: 5000,
            });
            // Retest bar: low dips to OR high, closes above it
            bars.push({
                symbol,
                timestamp: `${sessionDate}T13:47:00Z`,
                open: 102.6,
                high: 103.1,
                low: 101.0, // retest to OR high
                close: 103.1,
                volume: 4500,
            });
            return bars;
        }
        function makeShortBreakoutBars(symbol: string, sessionDate: string): Bar[] {
            const bars: Bar[] = [];
            // Opening range bars
            for (let i = 0; i < 15; i++) {
                bars.push({
                    symbol,
                    timestamp: `${sessionDate}T13:${String(31 + i).padStart(2, '0')}:00Z`,
                    open: 100,
                    high: 101,
                    low: 99,
                    close: 100,
                    volume: 1000,
                });
            }
            // Breakout bar: close below OR low
            bars.push({
                symbol,
                timestamp: `${sessionDate}T13:46:00Z`,
                open: 99,
                high: 99.2,
                low: 97.8,
                close: 97.5, // close < OR low
                volume: 5000,
            });
            // Retest bar: high retests OR low, closes below it
            bars.push({
                symbol,
                timestamp: `${sessionDate}T13:47:00Z`,
                open: 98.8,
                high: 99.0, // retest to OR low
                low: 97.8,
                close: 97.8,
                volume: 4500,
            });
            return bars;
        }

        const client = new WickStopDeterministicClient({
            [longSymbol]: makeLongBreakoutBars(longSymbol, sessionDate),
            [shortSymbol]: makeShortBreakoutBars(shortSymbol, sessionDate),
        });

        const candidates = await findBreakoutCandidates(client, sessionDate);
        const trades = buildWeightedRiskTrades(candidates, 1000, env.takeProfitMultiple);

        const longTrade = trades.find((trade) => trade.symbol === longSymbol);
        const shortTrade = trades.find((trade) => trade.symbol === shortSymbol);

        expect(longTrade).to.not.equal(undefined);
        expect(shortTrade).to.not.equal(undefined);

        const resolvedLongTrade = longTrade!;
        const resolvedShortTrade = shortTrade!;

        const expectedLongStop = 101;
        const expectedShortStop = 99;

        expect(resolvedLongTrade.stopPrice).to.equal(expectedLongStop);
        expect(resolvedShortTrade.stopPrice).to.equal(expectedShortStop);

        const expectedLongTakeProfit =
            resolvedLongTrade.price + (resolvedLongTrade.price - expectedLongStop) * env.takeProfitMultiple;
        const expectedShortTakeProfit =
            resolvedShortTrade.price - (expectedShortStop - resolvedShortTrade.price) * env.takeProfitMultiple;

        expect(resolvedLongTrade.takeProfitPrice).to.equal(expectedLongTakeProfit);
        expect(resolvedShortTrade.takeProfitPrice).to.equal(expectedShortTakeProfit);

        logger.info('Verified wick-anchored bracket exits from pre-breakout candle', {
            stopLossProfitRatio: env.stopLossProfitRatio,
            takeProfitMultiple: env.takeProfitMultiple,
            long: {
                symbol: resolvedLongTrade.symbol,
                entry: resolvedLongTrade.price,
                stop: resolvedLongTrade.stopPrice,
                takeProfit: resolvedLongTrade.takeProfitPrice,
                preBreakoutWick: expectedLongStop,
            },
            short: {
                symbol: resolvedShortTrade.symbol,
                entry: resolvedShortTrade.price,
                stop: resolvedShortTrade.stopPrice,
                takeProfit: resolvedShortTrade.takeProfitPrice,
                preBreakoutWick: expectedShortStop,
            },
        });
    });

    it('closes position when target was hit on an earlier bar but latest bar is below target', async () => {
        const symbol = 'TGTEST';
        const sessionDate = '2026-05-21';
        const originalDryRun = env.dryRun;

        env.dryRun = true;

        try {
            // Directly insert a simulated position so we don't need to reproduce
            // the full breakout + retest logic.
            const { simulatedPositions } = require('../src/app');
            const entryPrice = 100;
            const stopPrice = 95;
            const takeProfitPrice = 110;

            simulatedPositions.set(symbol, {
                side: 'long',
                entryPrice,
                stopPrice,
                takeProfitPrice,
                entryTime: '2026-05-21T13:31:30.000Z',
                qty: 10,
            });

            // Bars: an intermediate bar hits the target (high >= 110), then a
            // pullback bar (latest bar) has high < 110.  Without the fix only
            // latestBar is checked and the hit is missed.
            const bars: Bar[] = [
                { symbol, timestamp: '2026-05-21T13:30:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
                { symbol, timestamp: '2026-05-21T13:31:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
                // Target-hit bar (high >= takeProfitPrice)
                { symbol, timestamp: '2026-05-21T13:32:00Z', open: 108, high: 112, low: 107, close: 111, volume: 1000 },
                // Pullback bar — high < takeProfitPrice, becomes latestBar
                { symbol, timestamp: '2026-05-21T13:33:00Z', open: 109, high: 109.5, low: 108, close: 109, volume: 1000 },
            ];

            class TestClient extends AlpacaClient {
                async getMostActiveSymbols() { return [symbol]; }
                async getOpenPosition() { return null; }
                async getIntradayBars() { return bars; }
            }
            const client = new TestClient();

            await evaluateSymbol(client, symbol, sessionDate);

            expect(simulatedPositions.has(symbol)).to.be.false;
        } finally {
            env.dryRun = originalDryRun;
        }
    });

    it('closes position when target is hit on the same-minute bar as entry', async () => {
        const symbol = 'SAMEMIN';
        const sessionDate = '2026-05-21';
        const originalDryRun = env.dryRun;

        env.dryRun = true;

        try {
            const { simulatedPositions } = require('../src/app');
            const entryPrice = 100;
            const stopPrice = 95;
            const takeProfitPrice = 110;

            // Entry time is mid-bar (13:32:15), so the 13:32:00 bar's timestamp
            // is BEFORE entryTime.  The old filter (bar.timestamp >= entryTime)
            // would exclude this bar, missing the target hit.
            simulatedPositions.set(symbol, {
                side: 'long',
                entryPrice,
                stopPrice,
                takeProfitPrice,
                entryTime: '2026-05-21T13:32:15.000Z',
                qty: 10,
            });

            const bars: Bar[] = [
                { symbol, timestamp: '2026-05-21T13:30:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
                { symbol, timestamp: '2026-05-21T13:31:00Z', open: 100, high: 101, low: 99, close: 100, volume: 1000 },
                // Same-minute bar: starts at 13:32:00, entry is at 13:32:15,
                // target hit (high 112) is later in the same minute (13:32:30).
                { symbol, timestamp: '2026-05-21T13:32:00Z', open: 108, high: 112, low: 107, close: 111, volume: 1000 },
            ];

            class TestClient extends AlpacaClient {
                async getMostActiveSymbols() { return [symbol]; }
                async getOpenPosition() { return null; }
                async getIntradayBars() { return bars; }
            }
            const client = new TestClient();

            await evaluateSymbol(client, symbol, sessionDate);

            expect(simulatedPositions.has(symbol)).to.be.false;
        } finally {
            env.dryRun = originalDryRun;
        }
    });
});