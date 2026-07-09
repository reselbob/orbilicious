// Core TypeScript types shared across the orbilicious codebase:
// signal types, bar data, positions, and configuration shape.
export type Side = 'long' | 'short';
export type SignalType = 'BUY' | 'SELL' | 'EXIT' | 'NONE';

export interface Bar {
    symbol: string;
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface OpeningRange {
    symbol: string;
    sessionDate: string;
    startTime: string;
    endTime: string;
    high: number;
    low: number;
}

export interface Position {
    symbol: string;
    side: Side;
    qty: number;
    entryPrice?: number;
    entryTime?: string;
}

export interface Signal {
    type: SignalType;
    symbol: string;
    timestamp: string;
    price: number;
    reason: string;
}

export interface CalendarEntry {
    date: string;
    open: string;
    close: string;
}

export interface StrategyConfig {
    symbol: string;
    openingRangeMinutes: number;
    candleMinutes: number;
    sessionTimezone: string;
    sessionOpenHour: number;
    sessionOpenMinute: number;
    lastEntryTimeHHMM: string;
    forceExitTimeHHMM: string;
    qty: number;
    allowLong: boolean;
    allowShort: boolean;
}