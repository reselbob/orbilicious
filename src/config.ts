import 'dotenv/config';
import { StrategyConfig } from './types';
import { logger } from './logger';

export const APP_VERSION = '0.0.8';

type SessionMode = 'EMULATION' | 'PAPER' | 'LIVE';
export type CandidateTradeType = 'LONG' | 'SHORT' | 'LONG_AND_SHORT';

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

function dateStr(name: string, fallback = ''): string {
    const value = process.env[name];
    if (value == null || value.trim() === '') return fallback;

    const parts = value.trim().split('-').map((part) => Number(part));
    if (parts.length !== 3 || parts.some((part) => Number.isNaN(part) || part <= 0)) {
        logger.error('Invalid date environment variable', { name, value, expected: 'YYYY-M-D or YYYY-MM-DD' });
        throw new Error(`Invalid date for ${name}: ${value}`);
    }

    const [year, month, day] = parts;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function ratio(name: string, fallback: string): { raw: string; risk: number; reward: number; rewardMultiple: number } {
    const value = process.env[name] || fallback;
    const parts = value.split(':').map((part) => Number(part.trim()));

    if (parts.length !== 2 || parts.some((part) => Number.isNaN(part) || part <= 0)) {
        logger.error('Invalid ratio environment variable', { name, value, expected: 'x:y' });
        throw new Error(`Invalid ratio for ${name}: ${value}`);
    }

    const [risk, reward] = parts;
    return {
        raw: value,
        risk,
        reward,
        rewardMultiple: reward / risk,
    };
}

function sessionMode(name: string, fallback: SessionMode): SessionMode {
    const value = process.env[name];
    if (value == null || value.trim() === '') return fallback;

    const normalized = value.trim().toUpperCase();
    if (normalized === 'DEVELOPMENT') return 'EMULATION';

    if (normalized === 'EMULATION' || normalized === 'PAPER' || normalized === 'LIVE') {
        return normalized;
    }

    logger.error('Invalid session mode environment variable', {
        name,
        value,
        expected: 'EMULATION|PAPER|LIVE',
    });
    throw new Error(`Invalid session mode for ${name}: ${value}`);
}

function candidateTradeType(name: string, fallback: CandidateTradeType): CandidateTradeType {
    const value = process.env[name];
    if (value == null || value.trim() === '') return fallback;

    const normalized = value.trim().toUpperCase();
    if (normalized === 'LONG' || normalized === 'SHORT' || normalized === 'LONG_AND_SHORT') {
        return normalized;
    }

    logger.error('Invalid candidate trade type environment variable', {
        name,
        value,
        expected: 'LONG|SHORT|LONG_AND_SHORT',
    });
    throw new Error(`Invalid candidate trade type for ${name}: ${value}`);
}

const stopLossProfitRatio = ratio('STOP_LOSS_PROFIT_RATIO', '1:4');
const configuredSessionMode = sessionMode('SESSION_MODE', 'EMULATION');
const configuredCandidateTradeType = candidateTradeType('CANDIDATE_TRADE_TYPE', 'LONG_AND_SHORT');
const defaultTradingBaseUrlByMode = configuredSessionMode === 'LIVE'
    ? 'https://api.alpaca.markets'
    : 'https://paper-api.alpaca.markets';

export const env = {
    apiKey: required('APCA_API_KEY_ID'),
    apiSecret: required('APCA_API_SECRET_KEY'),
    sessionMode: configuredSessionMode,
    paper: configuredSessionMode !== 'LIVE',
    tradingBaseUrl: process.env.ALPACA_TRADING_BASE_URL || defaultTradingBaseUrlByMode,
    dataBaseUrl: process.env.ALPACA_DATA_BASE_URL || 'https://data.alpaca.markets',
    dataFeed: process.env.ALPACA_DATA_FEED || 'iex',
    sessionDate: dateStr('SESSION_DATE', ''),
    candidateTradeType: configuredCandidateTradeType,
    pollIntervalSeconds: num('POLL_INTERVAL_SECONDS', 20),
    maxTotalRisk: num('MAX_TOTAL_RISK', 1000),
    hardBasketCap: num('HARD_BASKET_CAP', 25000),
    quantityToRetrieve: num('QUANTITY_TO_RETRIEVE', 40),
    breakoutConfirmationCandleMinutes: num('BREAKOUT_CONFIRMATION_CANDLE_MINUTES', 5),
    breakoutQualityFiltersEnabled: bool('BREAKOUT_QUALITY_FILTERS_ENABLED', false),
    breakoutMinVolumeExpansion: num('BREAKOUT_MIN_VOLUME_EXPANSION', 1.2),
    breakoutMinRelativeStrengthPct: num('BREAKOUT_MIN_RELATIVE_STRENGTH_PCT', 0.25),
    breakoutTrendTimeframeMinutes: num('BREAKOUT_TREND_TIMEFRAME_MINUTES', 5),
    breakoutTrendLookbackBars: num('BREAKOUT_TREND_LOOKBACK_BARS', 3),
    maxPositionsPerSide: num('MAX_POSITIONS_PER_SIDE', 3),
    maxPositionNotional: num('MAX_POSITION_NOTIONAL', 5000),
    atrStopMultiple: num('ATR_STOP_MULTIPLE', 1),
    minStopPct: num('MIN_STOP_PCT', 0.0075),
    stopLossProfitRatio: stopLossProfitRatio.raw,
    stopLossRiskPart: stopLossProfitRatio.risk,
    takeProfitPart: stopLossProfitRatio.reward,
    takeProfitMultiple: stopLossProfitRatio.rewardMultiple,
    dryRun: configuredSessionMode === 'EMULATION',
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
    sessionMode: env.sessionMode,
    paper: env.paper,
    tradingBaseUrl: env.tradingBaseUrl,
    dataBaseUrl: env.dataBaseUrl,
    dataFeed: env.dataFeed,
    sessionDate: env.sessionDate,
    candidateTradeType: env.candidateTradeType,
    pollIntervalSeconds: env.pollIntervalSeconds,
    maxTotalRisk: env.maxTotalRisk,
    hardBasketCap: env.hardBasketCap,
    quantityToRetrieve: env.quantityToRetrieve,
    breakoutConfirmationCandleMinutes: env.breakoutConfirmationCandleMinutes,
    breakoutQualityFiltersEnabled: env.breakoutQualityFiltersEnabled,
    breakoutMinVolumeExpansion: env.breakoutMinVolumeExpansion,
    breakoutMinRelativeStrengthPct: env.breakoutMinRelativeStrengthPct,
    breakoutTrendTimeframeMinutes: env.breakoutTrendTimeframeMinutes,
    breakoutTrendLookbackBars: env.breakoutTrendLookbackBars,
    maxPositionsPerSide: env.maxPositionsPerSide,
    maxPositionNotional: env.maxPositionNotional,
    atrStopMultiple: env.atrStopMultiple,
    minStopPct: env.minStopPct,
    stopLossProfitRatio: env.stopLossProfitRatio,
    takeProfitMultiple: env.takeProfitMultiple,
    dryRun: env.dryRun,
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