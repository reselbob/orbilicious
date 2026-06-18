// Recovery script: reconstructs a daily session JSON from the trade log
// when runtime data was lost due to server crash/restart.
//
// Usage: npx tsx src/recover-daily-session.ts 2026-06-17
//
// Reads logs/trades/trades-YYYY-MM-DD.log, infers trade details from
// breakout ranges, and patches data/daily/YYYY-MM-DD.json with the
// actual trade events so the report shows correct candidate/trade data.

import fs from 'node:fs';
import path from 'node:path';

const sessionDate = process.argv[2];
if (!sessionDate || !/^\d{4}-\d{2}-\d{2}$/.test(sessionDate)) {
    console.error('Usage: npx tsx src/recover-daily-session.ts YYYY-MM-DD');
    process.exit(1);
}

type LogBreakoutHigh = { type: 'BREAKOUT_HIGH'; symbol: string; highPrice: number; timestamp: string };
type LogBreakoutLow = { type: 'BREAKOUT_LOW'; symbol: string; lowPrice: number; timestamp: string };
type LogTradeOpen = { type: 'TRADE_OPEN'; symbol: string; entryPrice: number; entryTime: string };
type LogTradeClose = { type: 'TRADE_CLOSE'; symbol: string; exitPrice: number; exitTime: string };

type LogEntry = LogBreakoutHigh | LogBreakoutLow | LogTradeOpen | LogTradeClose;

type SessionEvent = {
    eventId: string;
    eventType: 'open' | 'close';
    sessionDate: string;
    timestamp: string;
    symbol: string;
    side: 'buy' | 'sell';
    position: 'long' | 'short';
    qty: number;
    entryPrice?: number;
    stopPrice?: number;
    targetPrice?: number;
    closePrice?: number;
    pnl?: number;
    reason?: string;
};

type DailySessionJson = Record<string, unknown> & {
    sessionDate: string;
    breakoutCandidates?: Array<Record<string, unknown>>;
    evaluationRows?: Array<Record<string, unknown>>;
    totals?: Record<string, unknown>;
    candidateTradeActivity?: Record<string, unknown> | Array<Record<string, unknown>>;
    emulatedTrades?: Array<Record<string, unknown>>;
    finalOutcomes?: Array<Record<string, unknown>>;
    sessionEvents?: SessionEvent[];
};

// Read trade log
const logPath = path.resolve(process.cwd(), 'logs', 'trades', `trades-${sessionDate}.log`);
if (!fs.existsSync(logPath)) {
    console.error(`No trade log found at ${logPath}`);
    process.exit(1);
}

const lines = fs.readFileSync(logPath, 'utf8')
    .split(/\r?\n/)
    .map(l => l.trim())
    .filter(l => l.length > 0);

const entries: LogEntry[] = [];
for (const line of lines) {
    try {
        const parsed = JSON.parse(line) as LogEntry;
        if (parsed && typeof parsed.type === 'string') {
            entries.push(parsed);
        }
    } catch {
        // skip malformed lines
    }
}

// Group breakout ranges by symbol
const breakoutHigh = new Map<string, number>();
const breakoutLow = new Map<string, number>();
for (const entry of entries) {
    if (entry.type === 'BREAKOUT_HIGH') breakoutHigh.set(entry.symbol, entry.highPrice);
    if (entry.type === 'BREAKOUT_LOW') breakoutLow.set(entry.symbol, entry.lowPrice);
}

// Parse open/close trades
const opens = entries.filter((e): e is LogTradeOpen => e.type === 'TRADE_OPEN');
const closes = new Map<string, LogTradeClose>();
for (const e of entries) {
    if (e.type === 'TRADE_CLOSE') closes.set(e.symbol, e);
}

// Infer side from entry price vs breakout range
function inferSide(symbol: string, entryPrice: number): { side: 'buy' | 'sell'; position: 'long' | 'short' } {
    const high = breakoutHigh.get(symbol);
    const low = breakoutLow.get(symbol);
    if (high !== undefined && entryPrice >= high) return { side: 'buy', position: 'long' };
    if (low !== undefined && entryPrice <= low) return { side: 'sell', position: 'short' };
    return { side: 'buy', position: 'long' };
}

function calcPnl(position: 'long' | 'short', entryPrice: number, exitPrice: number, qty: number): number {
    if (position === 'long') return (exitPrice - entryPrice) * qty;
    return (entryPrice - exitPrice) * qty;
}

// Build session events
const qty = 1;
const sessionEvents: SessionEvent[] = [];
const tradeBySymbol = new Map<string, { side: 'buy' | 'sell'; position: 'long' | 'short'; entryPrice: number; entryTime: string }>();

for (const open of opens) {
    const { side, position } = inferSide(open.symbol, open.entryPrice);
    const id = `recovered-open-${open.symbol}`;
    sessionEvents.push({
        eventId: id,
        eventType: 'open',
        sessionDate,
        timestamp: open.entryTime,
        symbol: open.symbol,
        side,
        position,
        qty,
        entryPrice: open.entryPrice,
        reason: 'recovered from trade log',
    });
    tradeBySymbol.set(open.symbol, { side, position, entryPrice: open.entryPrice, entryTime: open.entryTime });
}

for (const [symbol, close] of closes) {
    const trade = tradeBySymbol.get(symbol);
    if (!trade) continue;
    const pnl = calcPnl(trade.position, trade.entryPrice, close.exitPrice, qty);
    const closeSide = trade.side === 'buy' ? 'sell' : 'buy';
    sessionEvents.push({
        eventId: `recovered-close-${symbol}`,
        eventType: 'close',
        sessionDate,
        timestamp: close.exitTime,
        symbol,
        side: closeSide,
        position: trade.position,
        qty,
        entryPrice: trade.entryPrice,
        closePrice: close.exitPrice,
        pnl,
        reason: 'recovered from trade log',
    });
}

if (sessionEvents.length === 0) {
    console.error('No trade events found in trade log');
    process.exit(1);
}

// Read the existing daily session JSON
const dailyDir = path.resolve(process.cwd(), 'data', 'daily');
const jsonPath = path.join(dailyDir, `${sessionDate}.json`);
if (!fs.existsSync(jsonPath)) {
    console.error(`No daily session JSON found at ${jsonPath}. Run the backtest first.`);
    process.exit(1);
}

const raw = fs.readFileSync(jsonPath, 'utf8');
const record: DailySessionJson = JSON.parse(raw);

// Build runtimeTradeHistory-style data for totals
const numTrades = tradeBySymbol.size;
const numLong = Array.from(tradeBySymbol.values()).filter(t => t.side === 'buy').length;
const numShort = Array.from(tradeBySymbol.values()).filter(t => t.side === 'sell').length;
const totalPnl = sessionEvents
    .filter(e => e.eventType === 'close' && typeof e.pnl === 'number')
    .reduce((sum, e) => sum + (e.pnl ?? 0), 0);

// Build derived emulatedTrades and finalOutcomes for the report
const emulatedTrades = Array.from(tradeBySymbol.entries()).map(([symbol, trade]) => ({
    symbol,
    side: trade.side,
    price: trade.entryPrice,
    qty,
    reason: 'recovered from trade log',
    score: 0,
    relativeBreakPct: 0,
    totalVolume: 0,
    openingRangeHigh: breakoutHigh.get(symbol) ?? 0,
    openingRangeLow: breakoutLow.get(symbol) ?? 0,
    assignedRiskDollars: 0,
    stopPrice: 0,
    stopDistancePerShare: 0,
    stopLossPct: 0,
    takeProfitPrice: 0,
    plannedRiskDollars: 0,
    estimatedNotional: trade.entryPrice * qty,
}));

const finalOutcomes = Array.from(tradeBySymbol.entries()).map(([symbol, trade]) => {
    const close = closes.get(symbol);
    const pnl = close ? calcPnl(trade.position, trade.entryPrice, close.exitPrice, qty) : 0;
    const status = pnl >= 0 ? 'profit' : 'loss';
    return {
        symbol,
        side: trade.side,
        entryPrice: trade.entryPrice,
        stopPrice: 0,
        takeProfitPrice: 0,
        qty,
        status,
        exitPrice: close?.exitPrice ?? null,
        exitTimestamp: close?.exitTime ?? null,
        pnl,
    };
});

// Patch the record
record.sessionEvents = sessionEvents;
record.emulatedTrades = emulatedTrades;
record.finalOutcomes = finalOutcomes;
record.totals = {
    totalCandidatesBoughtAtStart: numTrades,
    numberOfCandidatesSoldLong: numLong,
    numberOfCandidatesBoughtShort: numShort,
    totalCostOfBreakoutCandidatePurchases: emulatedTrades.reduce((s, t) => s + (t as { estimatedNotional: number }).estimatedNotional, 0),
    totalAmountOfCashAtStopLossRisk: 0,
    totalProfitLossToDate: totalPnl,
};
record.candidateTradeActivity = {
    totalCandidatesBoughtAtStart: numTrades,
    numberOfCandidatesSoldLong: numLong,
    numberOfCandidatesBoughtShort: numShort,
    totalCostOfBreakoutCandidatePurchases: emulatedTrades.reduce((s, t) => s + (t as { estimatedNotional: number }).estimatedNotional, 0),
    totalAmountOfCashAtStopLossRisk: 0,
    totalProfitLossToDate: totalPnl,
};
record.sessionProgress = {
    ...((record.sessionProgress ?? {}) as Record<string, unknown>),
    breakoutCandidates: numTrades,
    emulatedTrades: numTrades,
    finalOutcomes: numTrades,
};

// Write patched JSON
const tmpPath = `${jsonPath}.tmp-${process.pid}-${Date.now()}`;
fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
fs.renameSync(tmpPath, jsonPath);

// Print summary
console.log(`Recovered ${sessionDate}`);
console.log(`  Trade log:      ${logPath}`);
console.log(`  JSON:           ${jsonPath}`);
console.log(`  Trades found:   ${numTrades} (${numLong} long, ${numShort} short)`);
console.log(`  Open events:    ${sessionEvents.filter(e => e.eventType === 'open').length}`);
console.log(`  Close events:   ${sessionEvents.filter(e => e.eventType === 'close').length}`);
console.log(`  Total P/L:      ${totalPnl.toFixed(2)}`);
