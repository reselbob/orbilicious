import { expect } from 'chai';
import { describe, it } from 'mocha';
import { computeOpeningRange, generateOrbSignal } from '../src/strategy';
import { Bar, Position, StrategyConfig } from '../src/types';
import { AlpacaClient } from '../src/alpaca';
import { findBreakoutCandidates } from '../src/app';
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
}

describe('strategy integration', () => {
    it('computes the 15-minute opening range from 1-minute bars', () => {
        const bars: Bar[] = [];
        for (let m = 30; m <= 44; m++) {
            bars.push(makeBar(m, 100 + (m - 30) * 0.1, 101 + (m - 30) * 0.1, 99 - (m - 30) * 0.05));
        }

        const openingRange = computeOpeningRange(bars, '2026-05-13', cfg);
        expect(openingRange.high).to.equal(102.4);
        expect(openingRange.low).to.equal(98.3);
    });

    it('returns BUY when candle closes above the opening range high', () => {
        const bars: Bar[] = [];
        for (let m = 30; m <= 44; m++) {
            bars.push(makeBar(m, 100, 101, 99));
        }
        bars.push(makeBar(45, 101.5, 101.7, 100.8));

        const openingRange = computeOpeningRange(bars, '2026-05-13', cfg);
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
        for (let m = 30; m <= 44; m++) {
            bars.push(makeBar(m, 100, 101, 99));
        }
        bars.push(makeBar(45, 98.5, 99.2, 98.1));

        const openingRange = computeOpeningRange(bars, '2026-05-13', cfg);
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

        const partialRangeBars = [
            ...bars,
            makeBar(41, 100.2, 100.5, 99.8),
            makeBar(42, 100.1, 100.4, 99.7),
            makeBar(43, 100.0, 100.3, 99.6),
            makeBar(44, 100.0, 100.2, 99.5),
        ];

        const openingRange = computeOpeningRange(partialRangeBars, '2026-05-13', cfg);

        const preBreakoutBars = partialRangeBars.slice(0, 10);
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
        for (let m = 30; m <= 44; m++) {
            bars.push(makeBar(m, 100, 101, 99));
        }
        bars.push({
            symbol: 'SPY',
            timestamp: '2026-05-13T19:55:00Z',
            open: 100,
            high: 100.2,
            low: 99.8,
            close: 100,
            volume: 1000,
        });

        const openingRange = computeOpeningRange(bars.slice(0, 15), '2026-05-13', cfg);
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
        const client = new DeterministicStrategyClient(mostActiveSymbols, sessionDate);

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

        expect(client.requestedMostActiveLimit).to.equal(env.quantityToRetrieve);
        expect(retrievedSymbols).to.deep.equal(mostActiveSymbols);
        expect(candidates).to.be.an('array');
        expect(candidates.map((candidate) => candidate.symbol)).to.deep.equal(mostActiveSymbols);
        expect(candidates.every((candidate) => candidate.side === 'buy')).to.equal(true);
    });

    it('stop loss limit set according to previous to breakout candlestick', async () => {
        const sessionDate = '2099-05-14';
        const longSymbol = 'AAPL';
        const shortSymbol = 'TSLA';

        const client = new WickStopDeterministicClient({
            [longSymbol]: makeSymbolBreakoutBars(longSymbol, sessionDate),
            [shortSymbol]: makeSymbolBreakdownBars(shortSymbol, sessionDate),
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
});