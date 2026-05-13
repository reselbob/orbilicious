/**
 * Metrics representing the physical dimensions of a candlestick
 */
export interface WickMetrics {
    upperWick: number;
    lowerWick: number;
    bodySize: number;
    totalRange: number;
    upperWickPercentage: number;
}

export class Candlestick {
    public readonly open: number;
    public readonly high: number;
    public readonly low: number;
    public readonly close: number;
    public readonly volume: number;
    public readonly timestamp?: string;

    constructor(open: number, high: number, low: number, close: number, volume: number = 0, timestamp?: string) {
        this.open = open;
        this.high = high;
        this.low = low;
        this.close = close;
        this.volume = volume; // Volume can be set later if needed
        this.timestamp = timestamp;
    }

    /**
     * Measures the length of the wicks and the body of the candle.
     * 
     * Upper Wick = High - Max(Open, Close)
     * Lower Wick = Min(Open, Close) - Low
     */
    public measureWicks(): WickMetrics {
        const bodyTop = Math.max(this.open, this.close);
        const bodyBottom = Math.min(this.open, this.close);

        const upperWick = Number((this.high - bodyTop).toFixed(2));
        const lowerWick = Number((bodyBottom - this.low).toFixed(2));
        const bodySize = Number((bodyTop - bodyBottom).toFixed(2));
        const totalRange = Number((this.high - this.low).toFixed(2));

        // Avoid division by zero if high === low
        const upperWickPercentage = totalRange > 0
            ? Number(((upperWick / totalRange) * 100).toFixed(2))
            : 0;

        return {
            upperWick,
            lowerWick,
            bodySize,
            totalRange,
            upperWickPercentage
        };
    }

    /**
     * Helper to determine if the candle is bullish (green)
     */
    public isBullish(): boolean {
        return this.close > this.open;
    }

    /**
     * Helper to determine if the candle is bearish (red)
     */
    public isBearish(): boolean {
        return this.close < this.open;
    }


}