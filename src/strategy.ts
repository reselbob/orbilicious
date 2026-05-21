import { Bar, OpeningRange, Position, Signal, StrategyConfig } from './types';
import { toNyParts } from './time';
import { logger } from './logger';

export function isWithinOpeningRange(bar: Bar, sessionDate: string, cfg: StrategyConfig): boolean {
    const p = toNyParts(bar.timestamp, cfg.sessionTimezone);
    if (p.date !== sessionDate) return false;
    // Opening range starts 1 minute after NY open
    const startMinutes = cfg.sessionOpenHour * 60 + cfg.sessionOpenMinute + 1;
    const endMinutes = startMinutes + cfg.openingRangeMinutes - 1;
    const barMinutes = p.hour * 60 + p.minute;
    return barMinutes >= startMinutes && barMinutes <= endMinutes;
}

export function isAfterOpeningRange(bar: Bar, sessionDate: string, cfg: StrategyConfig): boolean {
    const p = toNyParts(bar.timestamp, cfg.sessionTimezone);
    if (p.date !== sessionDate) return false;
    // Opening range ends 15 minutes after it starts (so 16 minutes after NY open)
    const cutoff = cfg.sessionOpenHour * 60 + cfg.sessionOpenMinute + 1 + cfg.openingRangeMinutes;
    const barMinutes = p.hour * 60 + p.minute;
    return barMinutes >= cutoff;
}

// Helper to determine if current time is 30 seconds after NY open
export function isThirtySecondsAfterOpen(bar: Bar, cfg: StrategyConfig): boolean {
    const p = toNyParts(bar.timestamp, cfg.sessionTimezone);
    const openMinutes = cfg.sessionOpenHour * 60 + cfg.sessionOpenMinute;
    const barMinutes = p.hour * 60 + p.minute;
    // This assumes bar timestamp is at least minute-level; for sub-minute, adjust as needed
    return barMinutes === openMinutes && p.second >= 30;
}

export function isAfterTimeHHMM(bar: Bar, hhmm: string, timeZone = 'America/New_York'): boolean {
    const p = toNyParts(bar.timestamp, timeZone);
    const [h, m] = hhmm.split(':').map(Number);
    return p.hour * 60 + p.minute >= h * 60 + m;
}

export function computeOpeningRange(
    bars: Bar[],
    sessionDate: string,
    cfg: StrategyConfig,
): OpeningRange {
    const orBars = bars
        .filter((b) => isWithinOpeningRange(b, sessionDate, cfg))
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    if (orBars.length < cfg.openingRangeMinutes / cfg.candleMinutes) {
        logger.warn('Not enough bars to compute opening range', {
            symbol: cfg.symbol,
            sessionDate,
            have: orBars.length,
            need: cfg.openingRangeMinutes / cfg.candleMinutes,
        });
        throw new Error(`Not enough bars to compute opening range for ${sessionDate}`);
    }

    const openingRange = {
        symbol: cfg.symbol,
        sessionDate,
        startTime: orBars[0].timestamp,
        endTime: orBars[orBars.length - 1].timestamp,
        high: Math.max(...orBars.map((b) => b.high)),
        low: Math.min(...orBars.map((b) => b.low)),
    };

    logger.debug('Computed opening range', openingRange);
    return openingRange;
}

export function generateOrbSignal(params: {
    bars: Bar[];
    openingRange: OpeningRange;
    existingPosition: Position | null;
    cfg: StrategyConfig;
}): Signal {
    const { bars, openingRange, existingPosition, cfg } = params;
    const sessionBars = bars
        .filter((b) => toNyParts(b.timestamp, cfg.sessionTimezone).date === openingRange.sessionDate)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    const latestBar = sessionBars[sessionBars.length - 1];
    if (!latestBar) {
        const signal = {
            type: 'NONE' as const,
            symbol: cfg.symbol,
            timestamp: new Date().toISOString(),
            price: 0,
            reason: 'No bars available',
        };
        logger.debug('Generated ORB signal', signal);
        return signal;
    }

    if (existingPosition && isAfterTimeHHMM(latestBar, cfg.forceExitTimeHHMM, cfg.sessionTimezone)) {
        const signal = {
            type: 'EXIT' as const,
            symbol: cfg.symbol,
            timestamp: latestBar.timestamp,
            price: latestBar.close,
            reason: `Force exit at ${cfg.forceExitTimeHHMM}`,
        };
        logger.info('Generated ORB signal', signal);
        return signal;
    }

    if (!isAfterOpeningRange(latestBar, openingRange.sessionDate, cfg)) {
        const signal = {
            type: 'NONE' as const,
            symbol: cfg.symbol,
            timestamp: latestBar.timestamp,
            price: latestBar.close,
            reason: 'Opening range not complete',
        };
        logger.debug('Generated ORB signal', signal);
        return signal;
    }

    if (isAfterTimeHHMM(latestBar, cfg.lastEntryTimeHHMM, cfg.sessionTimezone) && !existingPosition) {
        const signal = {
            type: 'NONE' as const,
            symbol: cfg.symbol,
            timestamp: latestBar.timestamp,
            price: latestBar.close,
            reason: `Past last entry time ${cfg.lastEntryTimeHHMM}`,
        };
        logger.debug('Generated ORB signal', signal);
        return signal;
    }

    if (existingPosition) {
        const signal = {
            type: 'NONE' as const,
            symbol: cfg.symbol,
            timestamp: latestBar.timestamp,
            price: latestBar.close,
            reason: 'Position already open',
        };
        logger.debug('Generated ORB signal', signal);
        return signal;
    }

    if (cfg.allowLong && latestBar.close > openingRange.high) {
        const signal = {
            type: 'BUY' as const,
            symbol: cfg.symbol,
            timestamp: latestBar.timestamp,
            price: latestBar.close,
            reason: `Close ${latestBar.close} > OR high ${openingRange.high}`,
        };
        logger.info('Generated ORB signal', signal);
        return signal;
    }

    if (cfg.allowShort && latestBar.close < openingRange.low) {
        const signal = {
            type: 'SELL' as const,
            symbol: cfg.symbol,
            timestamp: latestBar.timestamp,
            price: latestBar.close,
            reason: `Close ${latestBar.close} < OR low ${openingRange.low}`,
        };
        logger.info('Generated ORB signal', signal);
        return signal;
    }

    const signal = {
        type: 'NONE' as const,
        symbol: cfg.symbol,
        timestamp: latestBar.timestamp,
        price: latestBar.close,
        reason: 'No confirmed breakout',
    };
    logger.debug('Generated ORB signal', signal);
    return signal;
}