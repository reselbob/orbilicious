import { expect } from 'chai';
import { describe, it, beforeEach } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { Emulator } from '../src/trading/emulator';
import { LiveTrader } from '../src/trading/live-trader';
import {
    SizedTrade,
    buildWeightedRiskTrades,
    normalizeTradesToConstraints,
} from '../src/basket';
import { Bar } from '../src/types';

describe('Emulator — resetCumulativeRealizedLoss', () => {
    let client: AlpacaClient;
    let emulator: Emulator;

    beforeEach(() => {
        client = new AlpacaClient();
        emulator = new Emulator(client);
    });

    describe('basic behavior', () => {
        it('starts at zero', () => {
            expect(emulator.getCumulativeRealizedLoss()).to.equal(0);
        });

        it('reset on a fresh emulator remains zero', () => {
            emulator.resetCumulativeRealizedLoss();
            expect(emulator.getCumulativeRealizedLoss()).to.equal(0);
        });

        it('can be called multiple times', () => {
            for (let i = 0; i < 10; i++) {
                emulator.resetCumulativeRealizedLoss();
            }
            expect(emulator.getCumulativeRealizedLoss()).to.equal(0);
        });
    });

    describe('no side effects on other Emulator state', () => {
        const dummyTrade: SizedTrade = {
            symbol: 'TEST',
            side: 'buy',
            price: 100,
            reason: 'test',
            score: 50,
            relativeBreakPct: 2,
            totalVolume: 100000,
            openingRangeHigh: 101,
            openingRangeLow: 99,
            atr1m: 0.5,
            preBreakoutWickPrice: 99.5,
            assignedRiskDollars: 100,
            stopPrice: 99,
            stopDistancePerShare: 1,
            stopLossPct: 0.01,
            takeProfitPrice: 104,
            qty: 100,
            plannedRiskDollars: 100,
            estimatedNotional: 10000,
        };

        beforeEach(async () => {
            await emulator.executeTrades([dummyTrade], '2099-01-01');
        });

        it('does not clear simulatedPositions', () => {
            expect(emulator.simulatedPositions.size).to.equal(1);
            emulator.resetCumulativeRealizedLoss();
            expect(emulator.simulatedPositions.size).to.equal(1);
            expect(emulator.simulatedPositions.has('TEST')).to.be.true;
        });

        it('does not clear tradeHistory', () => {
            expect(emulator.tradeHistory.length).to.equal(1);
            emulator.resetCumulativeRealizedLoss();
            expect(emulator.tradeHistory.length).to.equal(1);
            expect(emulator.tradeHistory[0].symbol).to.equal('TEST');
        });

        it('does not alter trade history entries', () => {
            const before = emulator.tradeHistory[0];
            emulator.resetCumulativeRealizedLoss();
            const after = emulator.tradeHistory[0];
            expect(after.symbol).to.equal(before.symbol);
            expect(after.side).to.equal(before.side);
            expect(after.qty).to.equal(before.qty);
            expect(after.status).to.equal('open');
        });

        it('does not affect computeUsedRisk', () => {
            const riskBefore = emulator.computeUsedRisk();
            emulator.resetCumulativeRealizedLoss();
            expect(emulator.computeUsedRisk()).to.equal(riskBefore);
        });

        it('does not affect dryRun flag', () => {
            expect(emulator.dryRun).to.be.true;
            emulator.resetCumulativeRealizedLoss();
            expect(emulator.dryRun).to.be.true;
        });

        it('does not affect getAllPositions', async () => {
            const positionsBefore = await emulator.getAllPositions();
            emulator.resetCumulativeRealizedLoss();
            const positionsAfter = await emulator.getAllPositions();
            expect(positionsAfter).to.deep.equal(positionsBefore);
        });
    });

    describe('end-to-end loss accumulation and daily reset', () => {
        const entryPrice = 100;
        const stopPrice = 99;
        const qty = 100;
        const lossAmount = (entryPrice - stopPrice) * qty; // $100 loss

        function makeStopBar(symbol: string, sessionDate: string): Bar[] {
            const [year, month, day] = sessionDate.split('-');
            return [
                {
                    symbol,
                    timestamp: `${year}-${month}-${day}T14:00:00Z`,
                    open: entryPrice,
                    high: entryPrice + 1,
                    low: stopPrice - 0.1,
                    close: stopPrice,
                    volume: 5000,
                },
            ];
        }

        function makeBreakoutBars(symbol: string, sessionDate: string): Bar[] {
            const [year, month, day] = sessionDate.split('-');
            const bars: Bar[] = [];

            for (let minute = 30; minute <= 44; minute++) {
                bars.push({
                    symbol,
                    timestamp: `${year}-${month}-${day}T13:${String(minute).padStart(2, '0')}:00Z`,
                    open: entryPrice,
                    high: entryPrice + 1,
                    low: entryPrice - 1,
                    close: entryPrice,
                    volume: 1000,
                });
            }

            bars.push({
                symbol,
                timestamp: `${year}-${month}-${day}T13:45:00Z`,
                open: entryPrice + 0.5,
                high: entryPrice + 2,
                low: entryPrice - 0.5,
                close: entryPrice + 1,
                volume: 5000,
            });

            bars.push({
                symbol,
                timestamp: `${year}-${month}-${day}T13:46:00Z`,
                open: entryPrice + 1,
                high: entryPrice + 1.5,
                low: entryPrice + 0.5,
                close: entryPrice + 0.8,
                volume: 4500,
            });

            return bars;
        }

        it('accumulates losses from stop-loss hits and resets correctly', async () => {
            const sessionDate = '2099-06-01';
            const bars = makeStopBar('TEST', sessionDate);

            const position = await emulator.getPosition('TEST');
            expect(position).to.be.null;

            await emulator.executeTrades([{
                symbol: 'TEST',
                side: 'buy',
                price: entryPrice,
                reason: 'test',
                score: 25,
                relativeBreakPct: 2,
                totalVolume: 50000,
                openingRangeHigh: entryPrice + 1,
                openingRangeLow: entryPrice - 1,
                atr1m: 0.5,
                preBreakoutWickPrice: entryPrice - 0.5,
                assignedRiskDollars: lossAmount,
                stopPrice: stopPrice,
                stopDistancePerShare: entryPrice - stopPrice,
                stopLossPct: (entryPrice - stopPrice) / entryPrice,
                takeProfitPrice: entryPrice + 4 * (entryPrice - stopPrice),
                qty: qty,
                plannedRiskDollars: lossAmount,
                estimatedNotional: entryPrice * qty,
            }], sessionDate);

            const pos = await emulator.getPosition('TEST');
            expect(pos).to.not.be.null;
            expect(pos!.symbol).to.equal('TEST');

            const result = await emulator.managePosition(
                'TEST',
                pos!,
                sessionDate,
                bars,
                bars[bars.length - 1],
            );

            expect(result.action).to.equal('closed');
            expect(result.pnl).to.be.lessThan(0);

            expect(emulator.getCumulativeRealizedLoss()).to.equal(Math.abs(result.pnl!));

            emulator.resetCumulativeRealizedLoss();
            expect(emulator.getCumulativeRealizedLoss()).to.equal(0);
        });

        it('remainingRisk resets each day via the integration path', async () => {
            const env = require('../src/config').env;

            // Simulate Day 1: enter and lose a trade
            const day1 = '2099-06-01';
            const bar1 = makeStopBar('LOSS1', day1);

            await emulator.executeTrades([{
                symbol: 'LOSS1',
                side: 'buy',
                price: entryPrice,
                reason: 'test',
                score: 25,
                relativeBreakPct: 2,
                totalVolume: 50000,
                openingRangeHigh: entryPrice + 1,
                openingRangeLow: entryPrice - 1,
                atr1m: 0.5,
                preBreakoutWickPrice: entryPrice - 0.5,
                assignedRiskDollars: lossAmount,
                stopPrice: stopPrice,
                stopDistancePerShare: entryPrice - stopPrice,
                stopLossPct: (entryPrice - stopPrice) / entryPrice,
                takeProfitPrice: entryPrice + 4 * (entryPrice - stopPrice),
                qty: qty,
                plannedRiskDollars: lossAmount,
                estimatedNotional: entryPrice * qty,
            }], day1);

            const pos1 = await emulator.getPosition('LOSS1');
            await emulator.managePosition('LOSS1', pos1!, day1, bar1, bar1[bar1.length - 1]);

            const usedRiskDay1 = emulator.computeUsedRisk();
            const realizedLossDay1 = emulator.getCumulativeRealizedLoss();
            const remainingDay1 = Math.max(0, env.maxTotalRisk - realizedLossDay1 - usedRiskDay1);
            expect(remainingDay1).to.be.lessThan(env.maxTotalRisk);

            // Simulate Day 2: reset budget, then enter a fresh trade
            emulator.resetCumulativeRealizedLoss();

            const usedRiskDay2 = emulator.computeUsedRisk();
            const realizedLossDay2 = emulator.getCumulativeRealizedLoss();
            const remainingDay2 = Math.max(0, env.maxTotalRisk - realizedLossDay2 - usedRiskDay2);
            expect(realizedLossDay2).to.equal(0);
            expect(remainingDay2).to.equal(env.maxTotalRisk - usedRiskDay2);
            expect(remainingDay2).to.be.greaterThan(remainingDay1);
        });
    });
});

describe('LiveTrader — getCumulativeRealizedLoss', () => {
    it('always returns 0', () => {
        const client = new AlpacaClient();
        const trader = new LiveTrader(client);
        expect(trader.getCumulativeRealizedLoss()).to.equal(0);
        // Should not crash even though it has no resetCumulativeRealizedLoss
        expect((trader as any).resetCumulativeRealizedLoss).to.be.undefined;
    });
});

describe('remainingRisk calculation — no side effects', () => {
    it('risk budget is fully available after reset', () => {
        const client = new AlpacaClient();
        const emu = new Emulator(client);

        // Simulate accumulated losses
        Reflect.set(emu, 'cumulativeRealizedLoss', 800);
        expect(emu.getCumulativeRealizedLoss()).to.equal(800);

        // Reset
        emu.resetCumulativeRealizedLoss();
        expect(emu.getCumulativeRealizedLoss()).to.equal(0);

        // New trades can now use full budget
        const env = require('../src/config').env;
        const remainingRisk = Math.max(0, env.maxTotalRisk - emu.getCumulativeRealizedLoss() - emu.computeUsedRisk());
        expect(remainingRisk).to.equal(env.maxTotalRisk);
    });

    it('does not affect the interface contract for LiveTrader consumers', () => {
        const client = new AlpacaClient();
        const trader: import('../src/trading/trader-interface').ITrader = new LiveTrader(client);

        // LiveTrader doesn't have reset, but optional chaining handles it
        const resetFn = (trader as any).resetCumulativeRealizedLoss;
        expect(resetFn).to.be.undefined;

        // Calling through optional chain should not throw
        expect(() => { (trader as any).resetCumulativeRealizedLoss?.(); }).to.not.throw();
    });
});
