import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { env, strategyConfig } from '../src/config';
import { Bar } from '../src/types';
import { executeSizedTrades } from '../src/app';
import { buildWeightedRiskTrades } from '../src/basket';
import sinon from 'sinon';

/**
 * Test: can take profit before retest
 *
 * This test verifies that if the price hits the profit target before a retest event occurs,
 * the trade is immediately closed and profit is taken. It simulates a scenario where a breakout
 * candidate is created, a position is opened, and the price quickly reaches the take-profit level
 * before any retest confirmation. The test expects the simulated position to be closed and profit taken.
 */
describe('can take profit before retest', () => {
    it('can take profit before retest', async () => {
        // Setup: create a deterministic AlpacaClient and environment
        const symbol = 'TEST';
        const sessionDate = '2026-05-21';
        env.dryRun = true;
        env.takeProfitMultiple = 2; // 2R for easier test math
        strategyConfig.sessionTimezone = 'America/New_York';
        strategyConfig.sessionOpenHour = 9;
        strategyConfig.sessionOpenMinute = 30;
        strategyConfig.openingRangeMinutes = 2;
        strategyConfig.candleMinutes = 1;

        // Create bars: opening range, breakout, and a bar that hits the profit target before retest
        const bars: Bar[] = [
            // Opening range bars
            {
                symbol,
                timestamp: '2026-05-21T13:30:00Z',
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            },
            {
                symbol,
                timestamp: '2026-05-21T13:31:00Z',
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            },
            // Breakout bar
            {
                symbol,
                timestamp: '2026-05-21T13:32:00Z',
                open: 100,
                high: 103,
                low: 100,
                close: 102,
                volume: 2000,
            },
            // Bar that hits the profit target before retest
            {
                symbol,
                timestamp: '2026-05-21T13:33:00Z',
                open: 102,
                high: 106,
                low: 101.5,
                close: 105,
                volume: 2500,
            },
        ];

        // Mock AlpacaClient to return our bars
        class TestClient extends AlpacaClient {
            async getMostActiveSymbols() { return [symbol]; }
            async getOpenPosition() { return null; }
            async getIntradayBars() { return bars; }
        }
        const client = new TestClient();

        // Build a breakout candidate and trade
        const { findBreakoutCandidates } = await import('../src/app');
        const candidates = await findBreakoutCandidates(client, sessionDate);
        const trades = buildWeightedRiskTrades(candidates, 1000, env.takeProfitMultiple);

        // Simulate trade execution (should open simulated position)
        await executeSizedTrades(client, sessionDate, trades);

        // Patch logger and event emitters to capture close events
        const closeEvents: any[] = [];
        const origEmitTradeMonitorEvent = (await import('../src/app')).emitTradeMonitorEvent;
        sinon.replace(await import('../src/app'), 'emitTradeMonitorEvent', (event: any) => {
            if (event.eventType === 'close') closeEvents.push(event);
            origEmitTradeMonitorEvent(event);
        });

        // Simulate a new bar that hits the profit target before retest
        bars.push({
            symbol,
            timestamp: '2026-05-21T13:34:00Z',
            open: 105,
            high: 110,
            low: 104,
            close: 109,
            volume: 3000,
        });

        // Re-evaluate symbol to trigger profit-taking logic
        const { evaluateSymbol } = await import('../src/app');
        await evaluateSymbol(client, symbol, sessionDate);

        // The test expects a close event for profit-taking before retest
        expect(closeEvents.length).to.be.greaterThan(0);
        expect(closeEvents.some(e => e.reason && e.reason.includes('take-profit'))).to.be.true;
        // The simulated position should be closed
        // ...existing code...
    });
});
