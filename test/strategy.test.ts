import { expect } from 'chai';
import { describe, it } from 'mocha';
import { computeOpeningRange, generateOrbSignal } from '../src/strategy';
import { Bar, StrategyConfig } from '../src/types';
import { AlpacaClient } from '../src/alpaca';
import { findBreakoutCandidates } from '../src/app';
import { env, strategyConfig } from '../src/config';
import { logger } from '../src/logger';
import { toNyParts } from '../src/time';

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

    it('gets most active stocks and determines breakout candidates when market is open', async () => {
        // Check if market is open: weekday between 9:30 AM and 4:00 PM ET
        const now = new Date();
        const nyTime = toNyParts(now, 'America/New_York');
        const dayOfWeek = now.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
        const [currentHour, currentMinute] = nyTime.hhmm.split(':').map(Number);
        const currentTimeInMinutes = currentHour * 60 + currentMinute;
        const marketOpenMinutes = 9 * 60 + 30; // 9:30 AM
        const marketCloseMinutes = 16 * 60; // 4:00 PM

        const isWeekday = !['Sat', 'Sun'].includes(dayOfWeek);
        const isMarketOpen = isWeekday && currentTimeInMinutes >= marketOpenMinutes && currentTimeInMinutes < marketCloseMinutes;

        if (!isMarketOpen) {
            throw new Error('MARKET NOT OPEN');
        }

        // Get most active stocks
        const client = new AlpacaClient();
        const sessionDate = `${nyTime.year}-${nyTime.month}-${nyTime.day}`;

        // Get the most active symbols using QUANTITY_TO_RETRIEVE
        const mostActiveSymbols = await client.getMostActiveSymbols(env.quantityToRetrieve);

        logger.info('Got most active stocks', {
            quantityToRetrieve: env.quantityToRetrieve,
            mostActiveCount: mostActiveSymbols.length,
            mostActiveSymbols,
        });

        // Find breakout candidates
        const candidates = await findBreakoutCandidates(client, sessionDate);

        logger.info('Found breakout candidates', {
            mostActiveCount: mostActiveSymbols.length,
            breakoutCandidateCount: candidates.length,
            breakoutCandidates: candidates.map((c) => ({ symbol: c.symbol, side: c.side, price: c.price })),
        });

        // Verify we got the data
        expect(mostActiveSymbols).to.be.an('array');
        expect(mostActiveSymbols.length).to.equal(env.quantityToRetrieve);
        expect(candidates).to.be.an('array');
    });
});