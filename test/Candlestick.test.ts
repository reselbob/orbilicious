import { expect } from 'chai';
import { describe, it } from 'mocha';
import { Candlestick } from '../src/Candlestick';

describe('Candlestick Unit Tests', () => {

    describe('measureWicks()', () => {
        it('should correctly calculate metrics for a Bullish candle', () => {
            // Open: 100, High: 110, Low: 95, Close: 105
            // Body: 100 to 105 (Size: 5)
            // Upper Wick: 110 - 105 = 5
            // Lower Wick: 100 - 95 = 5
            // Total Range: 110 - 95 = 15
            const candle = new Candlestick(100, 110, 95, 105);
            const metrics = candle.measureWicks();

            expect(metrics.upperWick).to.equal(5);
            expect(metrics.lowerWick).to.equal(5);
            expect(metrics.bodySize).to.equal(5);
            expect(metrics.totalRange).to.equal(15);
            expect(metrics.upperWickPercentage).to.equal(33.33); // (5/15) * 100
        });

        it('should correctly calculate metrics for a Bearish candle', () => {
            // Open: 105, High: 110, Low: 90, Close: 100
            // Body: 100 to 105 (Size: 5)
            // Upper Wick: 110 - 105 = 5
            // Lower Wick: 100 - 90 = 10
            const candle = new Candlestick(105, 110, 90, 100);
            const metrics = candle.measureWicks();

            expect(metrics.upperWick).to.equal(5);
            expect(metrics.lowerWick).to.equal(10);
            expect(metrics.bodySize).to.equal(5);
        });

        it('should handle a "Doji" candle (Open equals Close)', () => {
            const candle = new Candlestick(100, 110, 90, 100);
            const metrics = candle.measureWicks();

            expect(metrics.bodySize).to.equal(0);
            expect(metrics.upperWick).to.equal(10);
            expect(metrics.lowerWick).to.equal(10);
        });

        it('should return 0 for percentage if total range is zero', () => {
            const candle = new Candlestick(100, 100, 100, 100);
            const metrics = candle.measureWicks();

            expect(metrics.totalRange).to.equal(0);
            expect(metrics.upperWickPercentage).to.equal(0);
        });
    });

    describe('Sentiment Helpers', () => {
        it('should identify a bullish candle', () => {
            const candle = new Candlestick(100, 110, 90, 105);
            expect(candle.isBullish()).to.be.true;
            expect(candle.isBearish()).to.be.false;
        });

        it('should identify a bearish candle', () => {
            const candle = new Candlestick(105, 110, 90, 100);
            expect(candle.isBearish()).to.be.true;
            expect(candle.isBullish()).to.be.false;
        });

        it('should return false for both if price is flat', () => {
            const candle = new Candlestick(100, 110, 90, 100);
            expect(candle.isBullish()).to.be.false;
            expect(candle.isBearish()).to.be.false;
        });
    });
});