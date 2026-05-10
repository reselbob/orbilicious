require('dotenv').config();
const axios = require('axios');
const WebSocket = require('ws');
const logger = require('./logger'); // Import your Winston logger

// Configuration
const TOKEN = process.env.TRADIER_TOKEN;
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const BASE_URL = 'https://sandbox.tradier.com/v1';
const ORB_MINUTES = 30;

// State management for stocks
const watchlist = {};

/**
 * FIXED: Fetches the top 20 most active stocks via Tradier API
 */
async function getActiveTickers() {
    logger.info("Fetching live market activity from Tradier...");

    // Broad list of high-volume symbols to poll
    const benchmarkSymbols = 'AAPL,NVDA,TSLA,AMD,MSFT,AMZN,META,GOOGL,NFLX,PLTR,INTC,PYPL,SQ,ROKU,BABA,NIO,COIN,MARA,HOOD,SHOP,F,BAC,PFE';

    try {
        const response = await axios.get(`${BASE_URL}/markets/quotes`, {
            params: { symbols: benchmarkSymbols },
            headers: {
                'Authorization': `Bearer ${TOKEN}`,
                'Accept': 'application/json'
            }
        });

        let quotes = response.data.quotes.quote;
        if (!Array.isArray(quotes)) quotes = [quotes];

        const top20 = quotes
            .sort((a, b) => b.volume - a.volume)
            .slice(0, 20)
            .map(q => q.symbol);

        logger.info(`Top 20 Active Tickers identified: ${top20.join(', ')}`);
        return top20;

    } catch (error) {
        logger.error(`Error fetching active tickers: ${error.message}`);
        return ['AAPL', 'NVDA', 'TSLA', 'AMD', 'MSFT'];
    };
}

/**
 * Places a Bracket Order (OTOCO)
 */
async function placeBracketOrder(symbol, side, price, risk) {
    const quantity = 10;
    const stopPrice = side === 'buy' ? price - (risk * 2) : price + (risk * 2);
    const profitPrice = side === 'buy' ? price + (risk * 4) : price - (risk * 4);

    const data = new URLSearchParams({
        class: 'oto',
        symbol: symbol,
        duration: 'day',
        'side[0]': side,
        'quantity[0]': quantity,
        'type[0]': 'market',
        'side[1]': side === 'buy' ? 'sell' : 'buy',
        'quantity[1]': quantity,
        'type[1]': 'stop',
        'stop[1]': stopPrice.toFixed(2),
        'side[2]': side === 'buy' ? 'sell' : 'buy',
        'quantity[2]': quantity,
        'type[2]': 'limit',
        'price[2]': profitPrice.toFixed(2)
    });

    try {
        const response = await axios.post(`${BASE_URL}/accounts/${ACCOUNT_ID}/orders`, data, {
            headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
        });
        logger.info(`✅ Order Placed for ${symbol}. Status: ${response.data.order.status}`);
    } catch (err) {
        const errorDetail = err.response?.data ? JSON.stringify(err.response.data) : err.message;
        logger.error(`❌ Trade Failed for ${symbol}: ${errorDetail}`);
    }
}

/**
 * Connects to Tradier WebSocket for real-time price monitoring
 */
async function startStreaming(symbols) {
    try {
        const sessionResponse = await axios.post(`${BASE_URL}/markets/events/session`, {}, {
            headers: { Authorization: `Bearer ${TOKEN}` }
        });

        const ws = new WebSocket('wss://ws.tradier.com/v1/markets/events');

        ws.on('open', () => {
            const payload = JSON.stringify({
                symbols: symbols,
                sessionid: sessionResponse.data.stream.sessionid,
                filter: ['quote']
            });
            ws.send(payload);
            logger.info(`🚀 WebSocket connected for ${symbols.length} tickers.`);
        });

        ws.on('message', (data) => {
            const quote = JSON.parse(data);
            if (quote.type !== 'quote') return;

            const { symbol, last: price } = quote;

            if (!watchlist[symbol]) watchlist[symbol] = { high: 0, low: Infinity, active: true };
            const entry = watchlist[symbol];

            const now = new Date();
            const marketOpen = new Date();
            marketOpen.setHours(9, 30, 0, 0);
            const rangeEnd = new Date(marketOpen.getTime() + ORB_MINUTES * 60000);

            if (now <= rangeEnd) {
                if (price > entry.high) entry.high = price;
                if (price < entry.low) entry.low = price;
            }
            else if (entry.active && entry.high > 0) {
                const risk = entry.high - entry.low;

                if (price > entry.high) {
                    logger.warn(`📈 LONG BREAKOUT DETECTED: ${symbol} at ${price} (Range: ${entry.low}-${entry.high})`);
                    placeBracketOrder(symbol, 'buy', price, risk);
                    entry.active = false;
                } else if (price < entry.low) {
                    logger.warn(`📉 SHORT BREAKOUT DETECTED: ${symbol} at ${price} (Range: ${entry.low}-${entry.high})`);
                    placeBracketOrder(symbol, 'sell', price, risk);
                    entry.active = false;
                }
            }
        });

        ws.on('error', (err) => logger.error(`WebSocket Error: ${err.message}`));
        ws.on('close', () => logger.warn('WebSocket connection closed.'));

    } catch (err) {
        logger.error(`Failed to start stream: ${err.message}`);
    }
}

// Start Program
getActiveTickers()
    .then(tickers => {
        if (tickers && tickers.length > 0) {
            startStreaming(tickers);
        } else {
            logger.error("No tickers available to stream.");
        }
    })
    .catch(err => logger.error(`Initialization error: ${err.message}`));

module.exports = { getActiveTickers };