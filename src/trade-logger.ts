import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve(process.cwd(), 'logs', 'trades');

function ensureDir(): void {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logFile(timestamp: string): string {
    const yyyymmdd = timestamp.slice(0, 10);
    return path.join(LOG_DIR, `trades-${yyyymmdd}.log`);
}

function append(entry: object, timestamp: string): void {
    ensureDir();
    fs.appendFileSync(logFile(timestamp), JSON.stringify(entry) + '\n');
}

export function logBreakoutHigh(symbol: string, highPrice: number, timestamp: string): void {
    append({ type: 'BREAKOUT_HIGH', symbol, highPrice, timestamp }, timestamp);
}

export function logBreakoutLow(symbol: string, lowPrice: number, timestamp: string): void {
    append({ type: 'BREAKOUT_LOW', symbol, lowPrice, timestamp }, timestamp);
}

export function logTradeOpen(symbol: string, entryPrice: number, entryTime: string): void {
    append({ type: 'TRADE_OPEN', symbol, entryPrice, entryTime }, entryTime);
}

export function logTradeClose(symbol: string, exitPrice: number, exitTime: string): void {
    append({ type: 'TRADE_CLOSE', symbol, exitPrice, exitTime }, exitTime);
}
