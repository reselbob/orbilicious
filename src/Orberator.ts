import Alpaca from '@alpacahq/alpaca-trade-api';
import logger from './Logger'; // Adjust path as necessary

type TradingState = 'MONITORING' | 'TESTING_HIGH' | 'TESTING_LOW' | 'WATCHING_BREAKOUT' | 'COMPLETED';
type Direction = 'UP' | 'DOWN';

interface OpeningRange {
    highValue: number;
    lowValue: number;
}

interface WatchlistEntry extends OpeningRange {
    state: TradingState;
    retestPrice?: number;
    direction?: Direction;
}

export class Orberator {
    private alpaca: any;
    private socket: any;
    private watchlist: Record<string, WatchlistEntry> = {};

    private constructor() { }

    /**
     * Static factory method to ensure the bot is verified before use.
     */
    public static async create(): Promise<Orberator> {
        const instance = new Orberator();

        instance.alpaca = new Alpaca({
            keyId: process.env.ALPACA_KEY || '',
            secretKey: process.env.ALPACA_SECRET || '',
            paper: true,
        });

        instance.socket = instance.alpaca.data_stream_v2;

        // Perform health check and logging verification
        await instance.pingAlpaca();

        return instance;
    }

    /**
     * Verifies API credentials and connectivity.
     */
    private async pingAlpaca(): Promise<void> {
        const { ALPACA_KEY, ALPACA_SECRET } = process.env;

        if (!ALPACA_KEY || !ALPACA_SECRET) {
            const errorMsg = `Missing environment variables: ${!ALPACA_KEY ? 'ALPACA_KEY' : 'ALPACA_SECRET'}`;
            logger.error(errorMsg);
            throw new Error(errorMsg);
        }

        try {
            logger.info("Connecting to Alpaca API...");
            const account = await this.alpaca.getAccount();
            logger.info(`Successfully authenticated. Account Status: ${account.status} | ID: ${account.id}`);
        } catch (err: any) {
            logger.error(`Alpaca Connection Failed: ${err.message}`);
            throw new Error("Could not connect to Alpaca. Please check your credentials.");
        }
    }

    /**
     * Scans for active stocks and logs the results to Orberator.log
     */
    async getActives(): Promise<string[]> {
        logger.info("Scanning for 40 most active stocks...");
        try {
            const actives = await this.alpaca.getMostActives();
            if (!actives?.most_actives) {
                logger.warn("Alpaca returned no active movers.");
                return [];
            }
            const symbols: string[] = actives.most_actives
                .slice(0, 40)
                .map((item: { symbol: string }) => item.symbol);

            logger.info(`Watchlist identified: ${symbols.join(', ')}`);
            return symbols;
        } catch (err: any) {
            logger.error(`Failed to fetch active stocks: ${err.message}`);
            return [];
        }
    }

    async getOpeningRange(ticker: string): Promise<OpeningRange | null> {
        const today = new Date().toISOString().split('T')[0];
        try {
            // Using 15-minute range (9:30 AM - 9:45 AM EST)
            const bars = await this.alpaca.getBarsV2(ticker, {
                start: `${today}T13:30:00Z`,
                end: `${today}T13:46:00Z`,
                timeframe: this.alpaca.newTimeframe(1, this.alpaca.timeframeUnit.MIN),
            });

            let high = 0;
            let low = Infinity;

            for await (const bar of bars) {
                if (bar.High > high) high = bar.High;
                if (bar.Low < low) low = bar.Low;
            }

            logger.info(`Calculated Range [${ticker}]: High=${high}, Low=${low}`);
            return { highValue: high, lowValue: low };
        } catch (err: any) {
            logger.error(`Error calculating range for ${ticker}: ${err.message}`);
            return null;
        }
    }

    async initMonitoring(tickers: string[]): Promise<void> {
        logger.info(`Initializing monitoring for ${tickers.length} assets...`);

        for (const symbol of tickers) {
            const range = await this.getOpeningRange(symbol);
            if (range && range.highValue > 0) {
                this.watchlist[symbol] = { ...range, state: 'MONITORING' };
            }
        }

        const activeSymbols = Object.keys(this.watchlist);
        if (activeSymbols.length === 0) {
            logger.warn("No valid tickers found to monitor. Aborting socket connection.");
            return;
        }

        this.socket.onConnect(() => {
            logger.info("🚀 WebSocket Stream Connected. Subscribing to trade data...");
            this.socket.subscribeForTrades(activeSymbols);
        });

        this.socket.onStockTrade((trade: { Symbol: string; Price: number }) => {
            this.processTrade(trade.Symbol, trade.Price);
        });

        this.socket.connect();
    }

    private processTrade(ticker: string, price: number): void {
        const stock = this.watchlist[ticker];
        if (!stock || stock.state === 'COMPLETED') return;

        if (stock.state === 'MONITORING') {
            if (price >= stock.highValue) {
                stock.state = 'TESTING_HIGH';
                logger.info(`[${ticker}] Crossed Above High: ${price} (Target: ${stock.highValue})`);
            } else if (price <= stock.lowValue) {
                stock.state = 'TESTING_LOW';
                logger.info(`[${ticker}] Crossed Below Low: ${price} (Target: ${stock.lowValue})`);
            }
        } else if (stock.state === 'TESTING_HIGH' || stock.state === 'TESTING_LOW') {
            this.watchForTest(ticker, price);
        } else if (stock.state === 'WATCHING_BREAKOUT') {
            this.watchForBreakout(ticker, price);
        }
    }

    private watchForTest(ticker: string, price: number): void {
        const stock = this.watchlist[ticker];
        const isHighTest = stock.state === 'TESTING_HIGH' && price <= stock.highValue;
        const isLowTest = stock.state === 'TESTING_LOW' && price >= stock.lowValue;

        if (isHighTest || isLowTest) {
            const testResult = {
                ticker,
                price,
                type: isHighTest ? "Resistance Test" : "Support Test"
            };

            logger.warn(`TEST DETECTED: ${JSON.stringify(testResult)}`);

            stock.state = 'WATCHING_BREAKOUT';
            stock.retestPrice = price;
            stock.direction = isHighTest ? 'UP' : 'DOWN';
        }
    }

    private watchForBreakout(ticker: string, price: number): void {
        const stock = this.watchlist[ticker];
        if (!stock.retestPrice || !stock.direction) return;

        const buffer = 0.05;
        const isBreakingUp = stock.direction === 'UP' && price > stock.retestPrice + buffer;
        const isBreakingDown = stock.direction === 'DOWN' && price < stock.retestPrice - buffer;

        if (isBreakingUp || isBreakingDown) {
            logger.info(`📈 BREAKOUT CONFIRMED: ${ticker} at ${price}. Direction: ${stock.direction}`);
            stock.state = 'COMPLETED';
            // Placeholder for trade execution
            // this.executeOrder(ticker, stock.direction);
        }
    }

    // Helper for testing purposes since alpaca is private
    public getAlpacaInstance() {
        return this.alpaca;
    }
}