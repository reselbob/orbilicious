import fs from 'node:fs';
import path from 'node:path';
import { toNyParts } from '../time';

export type TradeMonitorEvent = {
    eventType: 'open' | 'close';
    sessionDate: string;
    timestamp: string;
    symbol: string;
    side: 'buy' | 'sell';
    position: 'long' | 'short';
    qty: number;
    entryPrice?: number;
    stopPrice?: number;
    stopLossPct?: number;
    targetPrice?: number;
    closePrice?: number;
    pnl?: number;
    reason?: string;
};

export type TradeMonitorEventWithId = TradeMonitorEvent & {
    id: number;
};

type DailySessionRecordForTradeMonitor = {
    sessionDate: string;
    sessionEvents?: Array<{
        eventType: 'open' | 'close';
        sessionDate: string;
        timestamp: string;
        symbol: string;
        side: 'buy' | 'sell';
        position: 'long' | 'short';
        qty: number;
        entryPrice?: number;
        stopPrice?: number;
        stopLossPct?: number;
        targetPrice?: number;
        closePrice?: number;
        pnl?: number;
        reason?: string;
    }>;
    evaluationRows?: Array<{
        symbol: string;
        breakoutTimestamp?: string | null;
        confirmationRetestTimestamp?: string | null;
    }>;
    finalOutcomes?: Array<{
        symbol: string;
        status?: string;
        pnl?: number;
        entryPrice?: number;
        exitPrice?: number | null;
        exitTimestamp?: string | null;
    }>;
    emulatedTrades?: Array<{
        symbol: string;
        side?: 'buy' | 'sell';
        price?: number;
        qty?: number;
        stopPrice?: number;
        stopLossPct?: number;
        takeProfitPrice?: number;
    }>;
    candidateTradeActivity?: Array<{
        symbol: string;
        side?: 'buy' | 'sell';
        position?: 'long' | 'short';
        qty?: number;
        stopPrice?: number;
        targetPrice?: number;
    }> | Record<string, unknown>;
};

export function compareTradeMonitorEvents(left: TradeMonitorEvent, right: TradeMonitorEvent): number {
    const sessionCompare = left.sessionDate.localeCompare(right.sessionDate);
    if (sessionCompare !== 0) {
        return sessionCompare;
    }

    const symbolCompare = left.symbol.localeCompare(right.symbol);
    if (symbolCompare !== 0) {
        return symbolCompare;
    }

    if (left.eventType !== right.eventType) {
        return left.eventType === 'open' ? -1 : 1;
    }

    const timestampCompare = new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime();
    if (timestampCompare !== 0) {
        return timestampCompare;
    }

    return (left.reason ?? '').localeCompare(right.reason ?? '');
}

export function resolveClosedTradePnl(params: {
    position?: 'long' | 'short';
    entryPrice?: number | null;
    closePrice?: number | null;
    qty?: number | null;
    fallbackQty?: number | null;
    existingPnl?: number | null;
}): number | null {
    const {
        position,
        entryPrice,
        closePrice,
        qty,
        fallbackQty,
        existingPnl,
    } = params;

    if (typeof existingPnl === 'number' && Number.isFinite(existingPnl)) {
        return existingPnl;
    }

    if (typeof entryPrice !== 'number' || !Number.isFinite(entryPrice) || typeof closePrice !== 'number' || !Number.isFinite(closePrice)) {
        return null;
    }

    const effectiveQty = typeof qty === 'number' && Number.isFinite(qty) && qty > 0
        ? qty
        : (typeof fallbackQty === 'number' && Number.isFinite(fallbackQty) && fallbackQty > 0 ? fallbackQty : 1);

    if (position === 'short') {
        return (entryPrice - closePrice) * effectiveQty;
    }

    return (closePrice - entryPrice) * effectiveQty;
}

export function loadReplayTradeMonitorEventsFromRecord(
    record: DailySessionRecordForTradeMonitor | null,
    sessionTimezone?: string,
): TradeMonitorEventWithId[] | null {
    if (!record) {
        return null;
    }

    if (Array.isArray(record.sessionEvents) && record.sessionEvents.length > 0) {
        const replayEvents = record.sessionEvents
            .map((event): TradeMonitorEvent => ({
                eventType: event.eventType,
                sessionDate: event.sessionDate,
                timestamp: event.timestamp,
                symbol: event.symbol,
                side: event.side,
                position: event.position,
                qty: event.qty,
                entryPrice: event.entryPrice,
                stopPrice: event.stopPrice,
                stopLossPct: event.stopLossPct,
                targetPrice: event.targetPrice,
                closePrice: event.closePrice,
                pnl: event.pnl,
                reason: event.reason,
            }))
            .sort(compareTradeMonitorEvents);

        return replayEvents.map((event, index) => ({
            ...event,
            id: index + 1,
        }));
    }

    const evaluationRows = Array.isArray(record.evaluationRows) ? record.evaluationRows : [];
    const rowBySymbol = new Map(evaluationRows.map((row) => [row.symbol, row]));
    const outcomeBySymbol = new Map(
        (Array.isArray(record.finalOutcomes) ? record.finalOutcomes : []).map((outcome) => [outcome.symbol, outcome])
    );

    const synthesized: TradeMonitorEvent[] = [];
    for (const trade of Array.isArray(record.emulatedTrades) ? record.emulatedTrades : []) {
        if (!trade || !trade.symbol || typeof trade.price !== 'number' || typeof trade.qty !== 'number') {
            continue;
        }

        const row = rowBySymbol.get(trade.symbol);
        const outcome = outcomeBySymbol.get(trade.symbol);
        const entryTimestamp = row?.confirmationRetestTimestamp
            ?? row?.breakoutTimestamp
            ?? outcome?.exitTimestamp
            ?? `${record.sessionDate}T00:00:00Z`;
        const side = trade.side === 'sell' ? 'sell' : 'buy';
        const position = side === 'buy' ? 'long' : 'short';

        synthesized.push({
            eventType: 'open',
            sessionDate: record.sessionDate,
            timestamp: entryTimestamp,
            symbol: trade.symbol,
            side,
            position,
            qty: trade.qty,
            entryPrice: trade.price,
            stopPrice: typeof trade.stopPrice === 'number' ? trade.stopPrice : undefined,
            stopLossPct: typeof trade.stopLossPct === 'number' ? trade.stopLossPct : undefined,
            targetPrice: typeof trade.takeProfitPrice === 'number' ? trade.takeProfitPrice : undefined,
            reason: 'historical emulation entry',
        });

        if (!outcome || typeof outcome.exitPrice !== 'number') {
            continue;
        }

        synthesized.push({
            eventType: 'close',
            sessionDate: record.sessionDate,
            timestamp: outcome.exitTimestamp ?? entryTimestamp,
            symbol: trade.symbol,
            side: side === 'buy' ? 'sell' : 'buy',
            position,
            qty: trade.qty,
            entryPrice: typeof outcome.entryPrice === 'number' ? outcome.entryPrice : trade.price,
            closePrice: outcome.exitPrice,
            pnl: typeof outcome.pnl === 'number' ? outcome.pnl : undefined,
            reason: `historical emulation ${outcome.status ?? 'close'} close`,
        });
    }

    if (synthesized.length === 0) {
        return null;
    }

    synthesized.sort(compareTradeMonitorEvents);

    return synthesized.map((event, index) => ({
        ...event,
        id: index + 1,
    }));
}

function isMinuteAlignedTimestamp(timestamp: string): boolean {
    const value = new Date(timestamp);
    if (Number.isNaN(value.getTime())) {
        return false;
    }

    return value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
}

function isMarketHoursTimestamp(sessionDate: string, timestamp: string, sessionTimezone: string): boolean {
    const parts = toNyParts(timestamp, sessionTimezone);
    if (parts.date !== sessionDate) {
        return false;
    }

    const minutes = parts.hour * 60 + parts.minute;
    return minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

function synthesizeTradeMonitorEventsFromTradeLog(
    record: DailySessionRecordForTradeMonitor,
    sessionTimezone: string,
): TradeMonitorEvent[] {
    const logPath = path.resolve(process.cwd(), 'logs', 'trades', `trades-${record.sessionDate}.log`);
    if (!fs.existsSync(logPath)) {
        return [];
    }

    const rawLines = fs.readFileSync(logPath, 'utf8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

    const parsed = rawLines
        .map((line) => {
            try {
                return JSON.parse(line) as Record<string, unknown>;
            } catch {
                return null;
            }
        })
        .filter((entry): entry is Record<string, unknown> => entry !== null);

    const actualOpens = parsed.filter((entry) => (
        entry.type === 'TRADE_OPEN'
        && typeof entry.symbol === 'string'
        && typeof entry.entryTime === 'string'
        && isMarketHoursTimestamp(record.sessionDate, entry.entryTime, sessionTimezone)
        && !isMinuteAlignedTimestamp(entry.entryTime)
    ));

    if (!actualOpens.length) {
        return [];
    }

    const closeBySymbol = new Map<string, Record<string, unknown>>();
    for (const entry of parsed) {
        if (
            entry.type === 'TRADE_CLOSE'
            && typeof entry.symbol === 'string'
            && typeof entry.exitTime === 'string'
            && isMarketHoursTimestamp(record.sessionDate, entry.exitTime, sessionTimezone)
        ) {
            closeBySymbol.set(entry.symbol, entry);
        }
    }

    const persistedOpenBySymbol = new Map<string, {
        side?: 'buy' | 'sell';
        position?: 'long' | 'short';
        qty?: number;
        stopPrice?: number;
        stopLossPct?: number;
        targetPrice?: number;
    }>();

    for (const event of Array.isArray(record.sessionEvents) ? record.sessionEvents : []) {
        if (event.eventType !== 'open') {
            continue;
        }

        persistedOpenBySymbol.set(event.symbol, {
            side: event.side,
            position: event.position,
            qty: event.qty,
            stopPrice: event.stopPrice,
            stopLossPct: event.stopLossPct,
            targetPrice: event.targetPrice,
        });
    }

    for (const row of Array.isArray(record.candidateTradeActivity) ? record.candidateTradeActivity : []) {
        persistedOpenBySymbol.set(row.symbol, {
            side: row.side,
            position: row.position,
            qty: row.qty,
            stopPrice: row.stopPrice,
            targetPrice: row.targetPrice,
        });
    }

    const events: TradeMonitorEvent[] = [];
    for (const open of actualOpens) {
        const symbol = open.symbol as string;
        const enrichment = persistedOpenBySymbol.get(symbol);
        const entryPrice = typeof open.entryPrice === 'number' ? open.entryPrice : undefined;
        const close = closeBySymbol.get(symbol);

        events.push({
            eventType: 'open',
            sessionDate: record.sessionDate,
            timestamp: open.entryTime as string,
            symbol,
            side: enrichment?.side ?? 'buy',
            position: enrichment?.position ?? 'long',
            qty: typeof enrichment?.qty === 'number' ? enrichment.qty : 0,
            entryPrice,
            stopPrice: enrichment?.stopPrice,
            stopLossPct: enrichment?.stopLossPct,
            targetPrice: enrichment?.targetPrice,
            reason: 'trade-log replay entry',
        });

        if (!close) {
            continue;
        }

        events.push({
            eventType: 'close',
            sessionDate: record.sessionDate,
            timestamp: close.exitTime as string,
            symbol,
            side: enrichment?.side === 'sell' ? 'buy' : 'sell',
            position: enrichment?.position ?? 'long',
            qty: typeof enrichment?.qty === 'number' ? enrichment.qty : 0,
            entryPrice,
            closePrice: typeof close.exitPrice === 'number' ? close.exitPrice : undefined,
            reason: 'trade-log replay close',
        });
    }

    return events.sort(compareTradeMonitorEvents);
}

export function synthesizeTradeMonitorEventsFromRecord(
    record: DailySessionRecordForTradeMonitor,
    sessionTimezone: string,
): TradeMonitorEvent[] {
    const tradeLogEvents = synthesizeTradeMonitorEventsFromTradeLog(record, sessionTimezone);
    if (tradeLogEvents.length) {
        return tradeLogEvents;
    }

    const persistedEvents = Array.isArray(record.sessionEvents)
        ? record.sessionEvents.map((event): TradeMonitorEvent => ({
            eventType: event.eventType,
            sessionDate: event.sessionDate,
            timestamp: event.timestamp,
            symbol: event.symbol,
            side: event.side,
            position: event.position,
            qty: event.qty,
            entryPrice: event.entryPrice,
            stopPrice: event.stopPrice,
            stopLossPct: event.stopLossPct,
            targetPrice: event.targetPrice,
            closePrice: event.closePrice,
            pnl: event.pnl,
            reason: event.reason,
        }))
        : [];

    if (persistedEvents.length) {
        return persistedEvents.sort(compareTradeMonitorEvents);
    }

    const evaluationRows = Array.isArray(record.evaluationRows) ? record.evaluationRows : [];
    const rowBySymbol = new Map(evaluationRows.map((row) => [row.symbol, row]));
    const outcomeBySymbol = new Map(
        (Array.isArray(record.finalOutcomes) ? record.finalOutcomes : []).map((outcome) => [outcome.symbol, outcome])
    );

    const synthesized: TradeMonitorEvent[] = [];
    for (const trade of Array.isArray(record.emulatedTrades) ? record.emulatedTrades : []) {
        if (!trade || !trade.symbol || typeof trade.price !== 'number' || typeof trade.qty !== 'number') {
            continue;
        }

        const row = rowBySymbol.get(trade.symbol);
        const outcome = outcomeBySymbol.get(trade.symbol);
        const entryTimestamp = row?.confirmationRetestTimestamp
            ?? row?.breakoutTimestamp
            ?? outcome?.exitTimestamp
            ?? `${record.sessionDate}T00:00:00Z`;
        const side = trade.side === 'sell' ? 'sell' : 'buy';
        const position = side === 'buy' ? 'long' : 'short';

        synthesized.push({
            eventType: 'open',
            sessionDate: record.sessionDate,
            timestamp: entryTimestamp,
            symbol: trade.symbol,
            side,
            position,
            qty: trade.qty,
            entryPrice: trade.price,
            stopPrice: typeof trade.stopPrice === 'number' ? trade.stopPrice : undefined,
            stopLossPct: typeof trade.stopLossPct === 'number' ? trade.stopLossPct : undefined,
            targetPrice: typeof trade.takeProfitPrice === 'number' ? trade.takeProfitPrice : undefined,
            reason: 'historical emulation entry',
        });

        if (!outcome || typeof outcome.exitPrice !== 'number') {
            continue;
        }

        synthesized.push({
            eventType: 'close',
            sessionDate: record.sessionDate,
            timestamp: outcome.exitTimestamp ?? entryTimestamp,
            symbol: trade.symbol,
            side: side === 'buy' ? 'sell' : 'buy',
            position,
            qty: trade.qty,
            entryPrice: typeof outcome.entryPrice === 'number' ? outcome.entryPrice : trade.price,
            closePrice: outcome.exitPrice,
            pnl: typeof outcome.pnl === 'number' ? outcome.pnl : undefined,
            reason: `historical emulation ${outcome.status ?? 'close'} close`,
        });
    }

    return synthesized.sort(compareTradeMonitorEvents);
}

export function toCanonicalTradeMonitorEvents(params: {
    records: DailySessionRecordForTradeMonitor[];
    sessionTimezone: string;
}): TradeMonitorEventWithId[] {
    const events = params.records
        .flatMap((record) => synthesizeTradeMonitorEventsFromRecord(record, params.sessionTimezone))
        .sort(compareTradeMonitorEvents);

    let ordinalWithinTimestamp = 0;
    let previousTimestamp = '';

    return events.map((event) => {
        if (event.timestamp !== previousTimestamp) {
            previousTimestamp = event.timestamp;
            ordinalWithinTimestamp = 0;
        } else {
            ordinalWithinTimestamp += 1;
        }

        const timestampMs = new Date(event.timestamp).getTime();
        const numericId = Number.isFinite(timestampMs)
            ? timestampMs * 100 + ordinalWithinTimestamp
            : ordinalWithinTimestamp;

        return {
            id: numericId,
            ...event,
        };
    });
}
