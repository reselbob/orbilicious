import 'dotenv/config';
import { StrategyConfig } from './types';
import { logger } from './logger';

function required(name: string): string {
    const value = process.env[name];
    if (!value) {
        logger.error('Missing required environment variable', { name });
        throw new Error(`Missing required env var: ${name}`);
    }
    return value;
}

function bool(name: string, fallback: boolean): boolean {
    const value = process.env[name];
    if (value == null || value === '') return fallback;
    return value.toLowerCase() === 'true';
}

function num(name: string, fallback: number): number {
    const value = process.env[name];
    if (value == null || value === '') return fallback;
    const parsed = Number(value);
    if (Number.isNaN(parsed)) {
        logger.error('Invalid numeric environment variable', { name, value });
        throw new Error(`Invalid number for ${name}: ${value}`);
    }
    return parsed;
}

export const env = {
    apiKey: required('APCA_API_KEY_ID'),
    apiSecret: required('APCA_API_SECRET_KEY'),
    paper: bool('APCA_PAPER', true),
    tradingBaseUrl: process.env.ALPACA_TRADING_BASE_URL || 'https://paper-api.alpaca.markets',
    dataBaseUrl: process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets',
    dataFeed: process.env.ALPACA_DATA_FEED || 'iex',
    sessionDate: process.env.SESSION_DATE || '',
    pollIntervalSeconds: num('POLL_INTERVAL_SECONDS', 20),
    maxTotalRisk: num('MAX_TOTAL_RISK', 1000),
};

export const strategyConfig: StrategyConfig = {
    symbol: process.env.SYMBOL || 'SPY',
    openingRangeMinutes: num('OPENING_RANGE_MINUTES', 15),
    candleMinutes: num('CANDLE_MINUTES', 1),
    sessionTimezone: 'America/New_York',
    sessionOpenHour: 9,
    sessionOpenMinute: 30,
    lastEntryTimeHHMM: process.env.LAST_ENTRY_TIME || '15:30',
    forceExitTimeHHMM: process.env.FORCE_EXIT_TIME || '15:55',
    qty: num('QTY', 1),
    allowLong: bool('ALLOW_LONG', true),
    allowShort: bool('ALLOW_SHORT', true),
};

logger.info('Configuration loaded', {
    paper: env.paper,
    tradingBaseUrl: env.tradingBaseUrl,
    dataBaseUrl: env.dataBaseUrl,
    dataFeed: env.dataFeed,
    pollIntervalSeconds: env.pollIntervalSeconds,
    maxTotalRisk: env.maxTotalRisk,
    strategy: {
        symbol: strategyConfig.symbol,
        openingRangeMinutes: strategyConfig.openingRangeMinutes,
        candleMinutes: strategyConfig.candleMinutes,
        sessionTimezone: strategyConfig.sessionTimezone,
        sessionOpenHour: strategyConfig.sessionOpenHour,
        sessionOpenMinute: strategyConfig.sessionOpenMinute,
        lastEntryTimeHHMM: strategyConfig.lastEntryTimeHHMM,
        forceExitTimeHHMM: strategyConfig.forceExitTimeHHMM,
        allowLong: strategyConfig.allowLong,
        allowShort: strategyConfig.allowShort,
    },
});