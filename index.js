require('dotenv').config();
const Alpaca = require('@alpacahq/alpaca-trade-api');
const logger = require('./logger'); // Import the new logger

class AlpacaOrbBot {
    constructor() {
        this.alpaca = new Alpaca({
            keyId: process.env.ALPACA_KEY,
            secretKey: process.env.ALPACA_SECRET,
            paper: true,
        });

        this.watchlist = {};
        this.socket = this.alpaca.data_stream_v2;
    }

    async getActives() {
        logger.info("Scanning for 40 most active stocks...");
        try {
            const actives = await this.alpaca.getMostActives();
            if (!actives?.most_actives) {
                logger.warn("Alpaca returned no active movers.");
                return [];
            }
            const symbols = actives.most_actives.slice(0, 40).map(item => item.symbol);
            logger.info(`Watchlist set: ${symbols.join(', ')}`);
            return symbols;
        } catch (err) {
            logger.error(`getActives failure: ${err.message}`);
            return [];
        }
    }

    async getOpeningRange(ticker) {
        const today = new Date().toISOString().split('T')[0];
        try {
            const bars = await this.alpaca.getBarsV2(ticker, {
                start: `${today}T13:30:00Z`, 
                end: `${today}T13:46:00Z`,   
                timeframe: this.alpaca.newTimeframe(1, this.alpaca.timeframeUnit.MIN),
            });

            let high = 0, low = Infinity;
            for await (let bar of bars) {
                if (bar.High > high) high = bar.High;
                if (bar.Low < low) low = bar.Low;
            }
            logger.info(`Range for ${ticker}: High ${high}, Low ${low}`);
            return { highValue: high, lowValue: low };
        } catch (err) {
            logger.error(`Range Error [${ticker}]: ${err.message}`);
            return null;
        }
    }

    async initMonitoring(tickers) {
        for (const symbol of tickers) {
            const range = await this.getOpeningRange(symbol);
            if (range && range.highValue > 0) {
                this.watchlist[symbol] = { ...range, state: 'MONITORING' };
            }
        }

        this.socket.onConnect(() => {
            logger.info("🚀 WebSocket Stream Connected via Alpaca");
            this.socket.subscribeForTrades(Object.keys(this.watchlist));
        });

        this.socket.onStockTrade((trade) => {
            this.processTrade(trade.Symbol, trade.Price);
        });

        this.socket.connect();
    }

    processTrade(ticker, price) {
        const stock = this.watchlist[ticker];
        if (!stock || stock.state === 'COMPLETED') return;

        switch (stock.state) {
            case 'MONITORING':
                if (price >= stock.highValue) {
                    stock.state = 'TESTING_HIGH';
                    logger.info(`${ticker} crossed above High Level (${stock.highValue})`);
                } else if (price <= stock.lowValue) {
                    stock.state = 'TESTING_LOW';
                    logger.info(`${ticker} crossed below Low Level (${stock.lowValue})`);
                }
                break;

            case 'TESTING_HIGH':
            case 'TESTING_LOW':
                this.watchForTest(ticker, price);
                break;

            case 'WATCHING_BREAKOUT':
                this.watchForBreakout(ticker, price);
                break;
        }
    }

    watchForTest(ticker, price) {
        const stock = this.watchlist[ticker];
        const isHighTest = stock.state === 'TESTING_HIGH' && price <= stock.highValue;
        const isLowTest = stock.state === 'TESTING_LOW' && price >= stock.lowValue;

        if (isHighTest || isLowTest) {
            const result = { 
                ticker, 
                price: price, 
                state: isHighTest ? "testedHigh" : "testedLow" 
            };
            
            // Log the specific test result as requested
            logger.warn(result);

            stock.state = 'WATCHING_BREAKOUT';
            stock.retestPrice = price;
            stock.direction = isHighTest ? 'UP' : 'DOWN';
        }
    }

    watchForBreakout(ticker, price) {
        const stock = this.watchlist[ticker];
        const buffer = 0.05;

        const isBreakingUp = stock.direction === 'UP' && price > stock.retestPrice + buffer;
        const isBreakingDown = stock.direction === 'DOWN' && price < stock.retestPrice - buffer;

        if (isBreakingUp || isBreakingDown) {
            logger.info(`📈 BREAKOUT: ${ticker} moving away from ${stock.retestPrice} (Current: ${price})`);
            stock.state = 'COMPLETED';
            // executeTrade(ticker, side);
        }
    }
}

const bot = new AlpacaOrbBot();
bot.getActives().then(tickers => bot.initMonitoring(tickers));
