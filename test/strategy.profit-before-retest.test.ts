import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { env, strategyConfig } from '../src/config';
import { Bar } from '../src/types';
import { findBreakoutCandidates, executeSizedTrades, evaluateSymbol } from '../src/app';
import { buildWeightedRiskTrades } from '../src/basket';

/**
 * Test: can take profit before retest (simplified)
 *
 * This test verifies that if the price hits the profit target before a retest event occurs,
 * the trade is immediately closed and profit is taken. It simulates a scenario where a breakout
 * candidate is created, a position is opened, and the price quickly reaches the take-profit level
 * before any retest confirmation. The test expects the simulated position to be closed and profit taken.
 */
describe('can take profit before retest (simplified)', () => {
    it('closes the position and takes profit if target is hit before retest', async () => {
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
            async getIntradayBarsBatch(symbols: string[]) {
                const map = new Map<string, Bar[]>();
                for (const requestedSymbol of symbols) {
                    map.set(requestedSymbol, requestedSymbol === symbol ? bars : []);
                }
                return map;
            }
        }
        const client = new TestClient();

        // Build a breakout candidate and trade
        const candidates = await findBreakoutCandidates(client, sessionDate);
        const trades = buildWeightedRiskTrades(candidates, 1000, env.takeProfitMultiple);

        // Simulate trade execution (should open simulated position)
        await executeSizedTrades(client, sessionDate, trades);

        // Add a new bar that hits the profit target before retest
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
        await evaluateSymbol(client, symbol, sessionDate);

        // The simulated position should be closed (not present in the map)
        // We access the simulatedPositions map from the app module
        // @ts-ignore
        const { simulatedPositions } = require('../src/app');
        expect(simulatedPositions.has(symbol)).to.be.false;
    });
});
