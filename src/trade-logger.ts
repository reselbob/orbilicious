import fs from 'node:fs';
import path from 'node:path';

const LOG_DIR = path.resolve(process.cwd(), 'logs', 'trades');

function ensureDir(): void {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logFile(): string {
    const yyyymmdd = new Date().toISOString().slice(0, 10);
    return path.join(LOG_DIR, `trades-${yyyymmdd}.log`);
}

function append(entry: object): void {
    ensureDir();
    fs.appendFileSync(logFile(), JSON.stringify(entry) + '\n');
}

export function logBreakoutHigh(symbol: string, highPrice: number, timestamp: string): void {
    append({ type: 'BREAKOUT_HIGH', symbol, highPrice, timestamp });
}

export function logBreakoutLow(symbol: string, lowPrice: number, timestamp: string): void {
    append({ type: 'BREAKOUT_LOW', symbol, lowPrice, timestamp });
}

export function logTradeOpen(symbol: string, entryPrice: number, entryTime: string): void {
    append({ type: 'TRADE_OPEN', symbol, entryPrice, entryTime });
}

export function logTradeClose(symbol: string, exitPrice: number, exitTime: string): void {
    append({ type: 'TRADE_CLOSE', symbol, exitPrice, exitTime });
}
