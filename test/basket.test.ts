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

    it('keeps top 10 longs and top 10 shorts by score', () => {
        const longs: Candidate[] = Array.from({ length: 12 }, (_, i) => ({
            symbol: `L${i}`,
            side: 'buy',
            price: 100,
            reason: 'long',
            score: i + 1,
            relativeBreakPct: 1,
            totalVolume: 1000,
            openingRangeHigh: 99,
            openingRangeLow: 95,
        }));

        const shorts: Candidate[] = Array.from({ length: 12 }, (_, i) => ({
            symbol: `S${i}`,
            side: 'sell',
            price: 100,
            reason: 'short',
            score: i + 1,
            relativeBreakPct: 1,
            totalVolume: 1000,
            openingRangeHigh: 105,
            openingRangeLow: 101,
        }));

        const ranked = rankAndSelectCandidates([...longs, ...shorts]);

        expect(ranked.longs).to.have.length(10);
        expect(ranked.shorts).to.have.length(10);
        expect(ranked.longs[0].score).to.equal(12);
        expect(ranked.shorts[0].score).to.equal(12);
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
});