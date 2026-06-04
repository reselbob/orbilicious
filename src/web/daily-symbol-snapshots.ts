import { AlpacaClient } from '../alpaca';
import type { Bar } from '../types';

export type DailySymbolSnapshot = {
    chartSvg?: string;
    openingPrice?: number;
    openingRangeHigh?: number;
    openingRangeLow?: number;
    breakoutPrice?: number;
    breakoutTimestamp?: string;
    confirmationRetestPrice?: number;
    confirmationRetestTimestamp?: string;
    atr1m?: number;
};

type DailySessionRecordForSnapshots = {
    sessionDate: string;
    updatedAt?: string;
    symbolSnapshots?: Record<string, DailySymbolSnapshot>;
    evaluationRows?: Array<{
        symbol: string;
        breakoutTimestamp?: string | null;
        confirmationRetestTimestamp?: string | null;
    }>;
    emulatedTrades?: Array<{
        symbol: string;
        price?: number;
        stopPrice?: number;
        takeProfitPrice?: number;
    }>;
    breakoutCandidates?: Array<{
        symbol: string;
        price?: number;
        stopPrice?: number;
        takeProfitPrice?: number;
    }>;
    candidateTradeActivity?: Array<{
        symbol: string;
        entryTimestamp?: string;
        entryPrice?: number;
        stopPrice?: number;
        targetPrice?: number;
        closePrice?: number | null;
        closeTimestamp?: string | null;
    }> | Record<string, unknown>;
    finalOutcomes?: Array<{
        symbol: string;
        exitPrice?: number | null;
        exitTimestamp?: string | null;
    }>;
};

type CandidateChartSvgRenderer = (params: {
    bars: Bar[];
    sessionDate: string;
    determinationTimestamp: string;
    entryTimestamp?: string;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    closePrice: number | null;
    closeTimestamp?: string | null;
    openingRangeMinutes: number;
    maxBarsAfterDetermination: number;
}) => string;

export async function buildDailySymbolCharts(params: {
    record: DailySessionRecordForSnapshots;
    symbols: string[];
    openingRangeMinutes: number;
    barsForSessionDate: (bars: Bar[], sessionDate: string) => Bar[];
    renderCandidateChartSvg: CandidateChartSvgRenderer;
    readDailySessionRecord: (sessionDate: string) => DailySessionRecordForSnapshots | null;
    writeDailySessionRecordAtomic: (sessionDate: string, record: DailySessionRecordForSnapshots) => void;
    logWarn: (message: string, payload: Record<string, unknown>) => void;
}): Promise<Map<string, DailySymbolSnapshot>> {
    const {
        record,
        symbols,
        openingRangeMinutes,
        barsForSessionDate,
        renderCandidateChartSvg,
        readDailySessionRecord,
        writeDailySessionRecordAtomic,
        logWarn,
    } = params;

    const snapshotsBySymbol = new Map<string, DailySymbolSnapshot>();
    if (!symbols.length) {
        return snapshotsBySymbol;
    }

    const persistedSnapshots = record.symbolSnapshots ?? {};
    const rowBySymbol = new Map((record.evaluationRows ?? []).map((row) => [row.symbol, row]));
    const tradeBySymbol = new Map((record.emulatedTrades ?? []).map((row) => [row.symbol, row]));
    const candidateBySymbol = new Map((record.breakoutCandidates ?? []).map((row) => [row.symbol, row]));
    const activityBySymbol = new Map(
        (Array.isArray(record.candidateTradeActivity) ? record.candidateTradeActivity : [])
            .map((row) => [row.symbol, row]),
    );
    const outcomeBySymbol = new Map((record.finalOutcomes ?? []).map((row) => [row.symbol, row]));
    const client = new AlpacaClient();

    await Promise.all(symbols.map(async (symbol) => {
        const row = rowBySymbol.get(symbol);
        const trade = tradeBySymbol.get(symbol);
        const candidate = candidateBySymbol.get(symbol);
        const activity = activityBySymbol.get(symbol);
        const outcome = outcomeBySymbol.get(symbol);
        const persistedSnapshot = persistedSnapshots[symbol];
        const determinationTimestamp = row?.confirmationRetestTimestamp
            ?? row?.breakoutTimestamp
            ?? activity?.entryTimestamp
            ?? null;
        const entryPrice = activity?.entryPrice ?? trade?.price ?? candidate?.price;
        const stopPrice = activity?.stopPrice ?? trade?.stopPrice ?? candidate?.stopPrice;
        const targetPrice = activity?.targetPrice ?? trade?.takeProfitPrice ?? candidate?.takeProfitPrice;
        const entryTimestamp = activity?.entryTimestamp ?? determinationTimestamp ?? undefined;

        const snapshot: DailySymbolSnapshot = {
            ...cloneDailySymbolSnapshot(persistedSnapshot),
            breakoutPrice: persistedSnapshot?.breakoutPrice ?? entryPrice,
            breakoutTimestamp: persistedSnapshot?.breakoutTimestamp ?? entryTimestamp ?? undefined,
            confirmationRetestPrice: persistedSnapshot?.confirmationRetestPrice ?? entryPrice,
            confirmationRetestTimestamp: persistedSnapshot?.confirmationRetestTimestamp ?? entryTimestamp ?? undefined,
        };

        if (persistedSnapshot?.chartSvg) {
            snapshotsBySymbol.set(symbol, snapshot);
            return;
        }

        if (
            typeof determinationTimestamp !== 'string'
            || !determinationTimestamp
            || typeof entryPrice !== 'number'
            || !Number.isFinite(entryPrice)
            || typeof stopPrice !== 'number'
            || !Number.isFinite(stopPrice)
            || typeof targetPrice !== 'number'
            || !Number.isFinite(targetPrice)
        ) {
            return;
        }

        try {
            const bars = await client.getIntradayBars(symbol, record.sessionDate);
            const sessionBars = barsForSessionDate(bars, record.sessionDate);
            if (!sessionBars.length) {
                snapshotsBySymbol.set(symbol, snapshot);
                return;
            }

            const openingRangeBars = Math.max(1, openingRangeMinutes);
            const openingBars = sessionBars.slice(0, Math.min(openingRangeBars, sessionBars.length));
            if (openingBars.length) {
                snapshot.openingPrice = openingBars[0].open;
                snapshot.openingRangeHigh = Math.max(...openingBars.map((bar) => bar.high));
                snapshot.openingRangeLow = Math.min(...openingBars.map((bar) => bar.low));
            }

            const atr1m = calculateAtr1mFromBars(sessionBars, 14);
            if (atr1m != null) {
                snapshot.atr1m = atr1m;
            }

            const svg = renderCandidateChartSvg({
                bars: sessionBars,
                sessionDate: record.sessionDate,
                determinationTimestamp,
                entryTimestamp,
                entryPrice,
                stopPrice,
                targetPrice,
                closePrice: typeof activity?.closePrice === 'number'
                    ? activity.closePrice
                    : (typeof outcome?.exitPrice === 'number' ? outcome.exitPrice : null),
                closeTimestamp: activity?.closeTimestamp ?? outcome?.exitTimestamp ?? null,
                openingRangeMinutes,
                maxBarsAfterDetermination: 30,
            });
            snapshot.chartSvg = svg;
            snapshotsBySymbol.set(symbol, snapshot);
        } catch (error) {
            logWarn('Failed building daily drilldown chart', {
                symbol,
                sessionDate: record.sessionDate,
                error: error instanceof Error ? error.message : String(error),
            });
            snapshotsBySymbol.set(symbol, snapshot);
        }
    }));

    let snapshotsUpdated = false;
    const mergedSnapshots: Record<string, DailySymbolSnapshot> = { ...persistedSnapshots };
    for (const [symbol, snapshot] of snapshotsBySymbol.entries()) {
        if (!snapshotRecordsEqual(mergedSnapshots[symbol], snapshot)) {
            mergedSnapshots[symbol] = cloneDailySymbolSnapshot(snapshot);
            snapshotsUpdated = true;
        }
    }

    if (snapshotsUpdated) {
        record.symbolSnapshots = mergedSnapshots;
        const existingRecord = readDailySessionRecord(record.sessionDate);
        if (existingRecord) {
            writeDailySessionRecordAtomic(record.sessionDate, {
                ...existingRecord,
                symbolSnapshots: mergedSnapshots,
                updatedAt: new Date().toISOString(),
            });
        }
    }

    return snapshotsBySymbol;
}

function cloneDailySymbolSnapshot(snapshot?: DailySymbolSnapshot): DailySymbolSnapshot {
    if (!snapshot) {
        return {};
    }

    return {
        chartSvg: snapshot.chartSvg,
        openingPrice: snapshot.openingPrice,
        openingRangeHigh: snapshot.openingRangeHigh,
        openingRangeLow: snapshot.openingRangeLow,
        breakoutPrice: snapshot.breakoutPrice,
        breakoutTimestamp: snapshot.breakoutTimestamp,
        confirmationRetestPrice: snapshot.confirmationRetestPrice,
        confirmationRetestTimestamp: snapshot.confirmationRetestTimestamp,
        atr1m: snapshot.atr1m,
    };
}

function snapshotRecordsEqual(left?: DailySymbolSnapshot, right?: DailySymbolSnapshot): boolean {
    return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function calculateAtr1mFromBars(bars: Bar[], period = 14): number | null {
    if (bars.length < 2) {
        return null;
    }

    const trueRanges: number[] = [];
    for (let index = 1; index < bars.length; index += 1) {
        const current = bars[index];
        const previous = bars[index - 1];
        const rangeHighLow = current.high - current.low;
        const rangeHighPrevClose = Math.abs(current.high - previous.close);
        const rangeLowPrevClose = Math.abs(current.low - previous.close);
        trueRanges.push(Math.max(rangeHighLow, rangeHighPrevClose, rangeLowPrevClose));
    }

    const atrWindow = trueRanges.slice(-period);
    if (!atrWindow.length) {
        return null;
    }

    const atr = atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
    return Number.isFinite(atr) && atr > 0 ? atr : null;
}
