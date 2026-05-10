const axios = require('axios');
const WebSocket = require('ws');

// Configuration
const TOKEN = process.env.TRADIER_TOKEN
const ACCOUNT_ID = process.env.ACCOUNT_ID;
const BASE_URL = 'https://sandbox.tradier.com/v1';
const ORB_MINUTES = 30; // 30-minute range

// State management for stocks
const watchlist = {}; 

/**
 * Fetch top 20 most active stocks (Simplified for this example)
 * In a production scenario, you would query a scanner or use 
 * Tradier's /markets/quotes with a predefined high-volume list.
 */
async function getActiveTickers() {
    return ['TSLA', 'NVDA', 'AAPL', 'AMD', 'MSFT', 'AMZN', 'META', 'GOOGL', 'NFLX', 'PLTR', 
            'INTC', 'PYPL', 'SQ', 'ROKU', 'BABA', 'NIO', 'COIN', 'MARA', 'HOOD', 'SHOP'];
}

/**
 * Places a Bracket Order (OTOCO)
 * Entry -> (4x Profit Limit AND -2x Stop Loss)
 */
async function placeBracketOrder(symbol, side, price, risk) {
    const quantity = 10;
    const stopPrice = side === 'buy' ? price - (risk * 2) : price + (risk * 2);
    const profitPrice = side === 'buy' ? price + (risk * 4) : price - (risk * 4);

    const data = new URLSearchParams({
        class: 'oto', // One-Triggers-Other
        symbol: symbol,
        duration: 'day',
        // --- Order 1: Market Entry ---
        'side[0]': side,
        'quantity[0]': quantity,
        'type[0]': 'market',
        // --- Order 2: Stop Loss (OCO Part A) ---
        'side[1]': side === 'buy' ? 'sell' : 'buy',
        'quantity[1]': quantity,
        'type[1]': 'stop',
        'stop[1]': stopPrice.toFixed(2),
        // --- Order 3: Take Profit (OCO Part B) ---
        'side[2]': side === 'buy' ? 'sell' : 'buy',
        'quantity[2]': quantity,
        'type[2]': 'limit',
        'price[2]': profitPrice.toFixed(2)
    });

    try {
        const response = await axios.post(`${BASE_URL}/accounts/${ACCOUNT_ID}/orders`, data, {
            headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' }
        });
        console.log(`✅ Order Placed for ${symbol}:`, response.data.order.status);
    } catch (err) {
        console.error(`❌ Trade Failed for ${symbol}:`, err.response?.data || err.message);
    }
}

/**
 * Connects to Tradier WebSocket for real-time price monitoring
 */
async function startStreaming(symbols) {
    // 1. Get a session key for the stream
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
        console.log("🚀 Stream connected for ORB monitoring...");
    });

    ws.on('message', (data) => {
        const quote = JSON.parse(data);
        const symbol = quote.symbol;
        const price = quote.last;
        
        if (!watchlist[symbol]) watchlist[symbol] = { high: 0, low: Infinity, active: true };
        const entry = watchlist[symbol];

        const now = new Date();
        const marketOpen = new Date();
        marketOpen.setHours(9, 30, 0, 0); 
        const rangeEnd = new Date(marketOpen.getTime() + ORB_MINUTES * 60000);

        // Define the High/Low during the first 30 mins
        if (now <= rangeEnd) {
            if (price > entry.high) entry.high = price;
            if (price < entry.low) entry.low = price;
        } 
        // Monitor for Breakout after the range is set
        else if (entry.active && entry.high > 0) {
            const risk = entry.high - entry.low;
            
            if (price > entry.high) {
                console.log(`📈 Long Breakout: ${symbol} at ${price}`);
                placeBracketOrder(symbol, 'buy', price, risk);
                entry.active = false; // Disable to prevent re-entry
            } else if (price < entry.low) {
                console.log(`📉 Short Breakout: ${symbol} at ${price}`);
                placeBracketOrder(symbol, 'sell', price, risk);
                entry.active = false;
            }
        }
    });
}

// Start Program
getActiveTickers().then(startStreaming);