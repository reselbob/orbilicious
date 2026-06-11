// Report generation: computes per-session ORB report data,
// emulates exits, generates HTML/PDF reports, and writes daily
// session JSON records.
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { AlpacaClient, MostActiveSymbolDetail } from "./alpaca";
import {
    BreakoutCandidate,
    SizedTrade,
    buildWeightedRiskTrades,
    computeCandidateScore,
    normalizeTradesToConstraints,
} from "./basket";
import { env, strategyConfig } from "./config";
import { logger } from "./logger";
import { Bar } from "./types";
import { toNyParts } from "./time";

export type ExitStatus = "profit" | "loss" | "pending";

export type TradeOutcome = {
    symbol: string;
    side: "buy" | "sell";
    entryPrice: number;
    stopPrice: number;
    takeProfitPrice: number;
    qty: number;
    status: ExitStatus;
    exitPrice: number | null;
    exitTimestamp: string | null;
    pnl: number;
};

export type AtrBreakoutCandidate = BreakoutCandidate & {
    atr1m: number;
};

export type BreakoutQualityDetail = {
    /** Whether quality filters were globally enabled for this run. */
    filtersEnabled: boolean;
    /** Measured volume expansion ratio on the breakout candle vs prior confirmation candles. */
    volumeExpansion: number | null;
    /** Configured minimum volume expansion threshold. */
    minVolumeExpansion: number;
    /** Whether the volume expansion check passed (or was skipped). */
    volumeExpansionPassed: boolean;
    /** Measured relative-strength % beyond OR high (longs) or below OR low (shorts). */
    relativeStrengthPct: number | null;
    /** Configured minimum relative strength threshold. */
    minRelativeStrengthPct: number;
    /** Whether the relative strength check passed (or was skipped). */
    relativeStrengthPassed: boolean;
    /** Whether the higher-timeframe trend was aligned with the breakout direction. */
    trendAligned: boolean | null;
    /** Configured trend timeframe in minutes. */
    trendTimeframeMinutes: number;
    /** Configured number of lookback bars for trend. */
    trendLookbackBars: number;
    /** Whether the trend alignment check passed (or was skipped). */
    trendAlignmentPassed: boolean;
    /** Top-level result: true if all enabled checks passed. */
    passed: boolean;
    /** Reason the check was skipped or failed, if applicable. */
    failReason: string | null;
};

export type OrbEvaluationRow = {
    symbol: string;
    openingPrice: number;
    openingRangeHigh: number;
    openingRangeLow: number;
    breakoutPrice: number | null;
    breakoutTimestamp: string | null;
    confirmationRetestPrice: number | null;
    confirmationRetestTimestamp: string | null;
    atr1m: number | null;
    side: "buy" | "sell" | "none";
    /** Per-candidate quality-filter attribution detail. Null when no breakout was detected. */
    qualityDetail: BreakoutQualityDetail | null;
};

export type OrbReportResult = {
    sessionDate: string;
    symbols: MostActiveSymbolDetail[];
    evaluationRows: OrbEvaluationRow[];
    breakoutCandidates: AtrBreakoutCandidate[];
    emulatedTrades: SizedTrade[];
    finalOutcomes: TradeOutcome[];
    htmlReportPath: string;
    pdfReportPath: string;
    maxSessionBars: number;
    insufficientSymbols: string[];
    totalCandidatesBoughtAtStart: number;
    numberOfCandidatesSoldLong: number;
    numberOfCandidatesBoughtShort: number;
    totalCostOfBreakoutCandidatePurchases: number;
    totalAmountOfCashAtStopLossRisk: number;
    totalProfitLossToDate: number;
};

type DailySessionRecord = {
    schemaVersion: 1;
    sessionDate: string;
    sessionMode: string;
    continuous: boolean;
    status: 'completed';
    startedAt: string | null;
    completedAt: string | null;
    timezone: string;
    strategy: {
        referenceSymbol: string;
        openingRangeMinutes: number;
        candleMinutes: number;
        allowLong: boolean;
        allowShort: boolean;
        lastEntryTimeHHMM: string;
        forceExitTimeHHMM: string;
    };
    risk: {
        maxTotalRisk: number;
        hardBasketCap: number;
        maxPositionNotional: number;
        atrStopMultiple: number;
        minStopPct: number;
        stopLossProfitRatio: string;
        takeProfitMultiple: number;
    };
    dataSources: {
        quantityToRetrieve: number;
        dataFeed: string;
        usesHistoricData: boolean;
    };
    breakoutFilters: {
        breakoutConfirmationCandleMinutes: number;
        breakoutQualityFiltersEnabled: boolean;
        breakoutMinVolumeExpansion: number;
        breakoutMinRelativeStrengthPct: number;
        breakoutTrendTimeframeMinutes: number;
        breakoutTrendLookbackBars: number;
    };
    sessionProgress: {
        maxSessionBars: number;
        symbolsScanned: number;
        breakoutCandidates: number;
        emulatedTrades: number;
        finalOutcomes: number;
    };
    mostActiveSymbols: MostActiveSymbolDetail[];
    mostActiveSymbolCount: number;
    insufficientSymbols: string[];
    marketScan: {
        maxSessionBars: number;
        candidateTradeType: string;
    };
    evaluationRows: OrbEvaluationRow[];
    breakoutCandidates: AtrBreakoutCandidate[];
    emulatedTrades: SizedTrade[];
    finalOutcomes: TradeOutcome[];
    candidateTradeActivity: {
        totalCandidatesBoughtAtStart: number;
        numberOfCandidatesSoldLong: number;
        numberOfCandidatesBoughtShort: number;
        totalCostOfBreakoutCandidatePurchases: number;
        totalAmountOfCashAtStopLossRisk: number;
        totalProfitLossToDate: number;
    };
    totals: {
        totalCandidatesBoughtAtStart: number;
        numberOfCandidatesSoldLong: number;
        numberOfCandidatesBoughtShort: number;
        totalCostOfBreakoutCandidatePurchases: number;
        totalAmountOfCashAtStopLossRisk: number;
        totalProfitLossToDate: number;
    };
    artifacts: {
        htmlReportPath: string;
        pdfReportPath: string;
        htmlRelativePath: string;
        pdfRelativePath: string;
    };
    notes: string[];
};

export type WeeklySummaryDay = {
    sessionDate: string;
    totalCandidatesBoughtAtStart: number;
    numberOfCandidatesSoldLong: number;
    numberOfCandidatesBoughtShort: number;
    totalCostOfBreakoutCandidatePurchases: number;
    totalAmountOfCashAtStopLossRisk: number;
    totalProfitLossToDate: number;
    htmlReportPath?: string;
    pdfReportPath?: string;
};

export type WeeklySummaryOrbReportResult = {
    weekStartDate: string;
    weekEndDate: string;
    dailySummaries: WeeklySummaryDay[];
    htmlReportPath: string;
    pdfReportPath: string;
    totalCandidatesBoughtAtStart: number;
    numberOfCandidatesSoldLong: number;
    numberOfCandidatesBoughtShort: number;
    totalCostOfBreakoutCandidatePurchases: number;
    totalAmountOfCashAtStopLossRisk: number;
    totalProfitLossToDate: number;
};

export type RunningSummaryOrbReportResult = {
    startDate: string;
    endDate: string;
    dailySummaries: WeeklySummaryDay[];
    skippedDates: string[];
    htmlReportPath: string;
    pdfReportPath: string;
    totalCandidatesBoughtAtStart: number;
    numberOfCandidatesSoldLong: number;
    numberOfCandidatesBoughtShort: number;
    totalCostOfBreakoutCandidatePurchases: number;
    totalAmountOfCashAtStopLossRisk: number;
    totalProfitLossToDate: number;
};

type OrbReportComputation = {
    sessionDate: string;
    symbols: MostActiveSymbolDetail[];
    evaluationRows: OrbEvaluationRow[];
    breakoutCandidates: AtrBreakoutCandidate[];
    emulatedTrades: SizedTrade[];
    maxSessionBars: number;
    insufficientSymbols: string[];
    totalCandidatesBoughtAtStart: number;
    numberOfCandidatesSoldLong: number;
    numberOfCandidatesBoughtShort: number;
    totalCostOfBreakoutCandidatePurchases: number;
    totalAmountOfCashAtStopLossRisk: number;
    totalProfitLossToDate: number;
    closedOutcomeBySymbol: Map<string, TradeOutcome>;
    finalOutcomeBySymbol: Map<string, TradeOutcome>;
    finalOutcomes: TradeOutcome[];
    sessionBarsBySymbol: Map<string, Bar[]>;
};

const dailySessionDir = path.resolve(process.cwd(), "data", "daily");
const universeDir = path.resolve(process.cwd(), "data", "universe");
const universeFilePath = path.join(universeDir, "fixed-universe.json");

function candidateAllowedByTradeType(side: 'buy' | 'sell'): boolean {
    if (env.candidateTradeType === 'LONG_AND_SHORT') {
        return true;
    }

    if (env.candidateTradeType === 'LONG') {
        return side === 'buy';
    }

    return side === 'sell';
}

function candidateTradeTypeLabel(): string {
    if (env.candidateTradeType === 'LONG') {
        return 'Long';
    }

    if (env.candidateTradeType === 'SHORT') {
        return 'Short';
    }

    return 'Long and Short';
}

export class Reports {
    private static fixedUniverseSymbols: string[] | null = null;
    private static readonly BAR_FETCH_CONCURRENCY = 8;
    private static readonly BAR_FETCH_RETRY_COUNT = 2;
    private static readonly BAR_FETCH_RETRY_DELAY_MS = 350;

    private static readPersistedUniverse(): string[] {
        try {
            if (!fs.existsSync(universeFilePath)) {
                return [];
            }

            const raw = fs.readFileSync(universeFilePath, "utf8");
            const parsed = JSON.parse(raw) as { symbols?: unknown };
            if (!Array.isArray(parsed.symbols)) {
                return [];
            }

            return parsed.symbols
                .map((value) => (typeof value === "string" ? value.trim().toUpperCase() : ""))
                .filter((value) => value.length > 0);
        } catch (error) {
            logger.warn("Failed reading persisted fixed universe", {
                universeFilePath,
                error: error instanceof Error ? error.message : String(error),
            });
            return [];
        }
    }

    private static persistUniverse(symbols: string[]) {
        try {
            fs.mkdirSync(universeDir, { recursive: true });
            const payload = {
                schemaVersion: 1,
                generatedAt: new Date().toISOString(),
                symbolCount: symbols.length,
                symbols,
            };
            fs.writeFileSync(universeFilePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
        } catch (error) {
            logger.warn("Failed writing persisted fixed universe", {
                universeFilePath,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private static async getFixedUniverseSymbols(client: AlpacaClient): Promise<string[]> {
        const maxUniverseSize = 120;
        if (Reports.fixedUniverseSymbols && Reports.fixedUniverseSymbols.length) {
            return Reports.fixedUniverseSymbols.slice(0, maxUniverseSize);
        }

        const persistedSymbols = Reports.readPersistedUniverse();
        if (persistedSymbols.length) {
            const trimmedPersistedSymbols = persistedSymbols.slice(0, maxUniverseSize);
            Reports.fixedUniverseSymbols = trimmedPersistedSymbols;
            logger.info('Loaded fixed universe from local persistence', {
                symbolCount: trimmedPersistedSymbols.length,
                universeFilePath,
            });
            return trimmedPersistedSymbols;
        }

        const minimumUniverse = Math.max(env.quantityToRetrieve, 40);
        const desiredUniverse = Math.max(env.quantityToRetrieve * 2, minimumUniverse);
        const cappedUniverse = Math.min(desiredUniverse, maxUniverseSize);
        const symbols = await client.getMostActiveSymbolsFiltered(cappedUniverse);

        if (!symbols.length) {
            throw new Error('Most active universe is empty; unable to build session ranking.');
        }

        Reports.fixedUniverseSymbols = symbols;
        Reports.persistUniverse(symbols);
        logger.info('Initialized fixed universe for historical volume ranking', {
            requestedUniverseSize: cappedUniverse,
            actualUniverseSize: symbols.length,
            universeFilePath,
        });
        return symbols;
    }

    private static async sleepMs(ms: number): Promise<void> {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private static async getIntradayBarsWithRetry(
        client: AlpacaClient,
        symbol: string,
        sessionDate: string,
    ): Promise<Bar[]> {
        let attempt = 0;

        for (; ;) {
            try {
                return await client.getIntradayBars(symbol, sessionDate);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                const isRateLimit = message.includes('429');
                if (!isRateLimit || attempt >= Reports.BAR_FETCH_RETRY_COUNT) {
                    throw error;
                }

                attempt += 1;
                const delay = Reports.BAR_FETCH_RETRY_DELAY_MS * attempt;
                logger.warn('Rate limited while loading bars; retrying', {
                    symbol,
                    sessionDate,
                    attempt,
                    delayMs: delay,
                });
                await Reports.sleepMs(delay);
            }
        }
    }

    private static async loadUniverseBars(
        client: AlpacaClient,
        universeSymbols: string[],
        sessionDate: string,
    ): Promise<Array<{ symbol: string; bars: Bar[] }>> {
        const results: Array<{ symbol: string; bars: Bar[] }> = [];

        for (let index = 0; index < universeSymbols.length; index += Reports.BAR_FETCH_CONCURRENCY) {
            const batch = universeSymbols.slice(index, index + Reports.BAR_FETCH_CONCURRENCY);
            const batchResults = await Promise.all(
                batch.map(async (symbol) => {
                    try {
                        const bars = await Reports.getIntradayBarsWithRetry(client, symbol, sessionDate);
                        return { symbol, bars: Reports.dedupeAndSortBars(bars) };
                    } catch (error) {
                        logger.warn('Failed loading bars for ORB report', {
                            symbol,
                            sessionDate,
                            error: error instanceof Error ? error.message : String(error),
                        });
                        return { symbol, bars: [] as Bar[] };
                    }
                }),
            );

            results.push(...batchResults);
        }

        return results;
    }

    private static weekDatesMondayToFriday(anchorDate: Date): string[] {
        const nyAnchor = toNyParts(anchorDate, strategyConfig.sessionTimezone);
        const utcAnchor = new Date(
            Date.UTC(nyAnchor.year, nyAnchor.month - 1, nyAnchor.day),
        );

        const mondayOffset = (utcAnchor.getUTCDay() + 6) % 7;
        const monday = new Date(utcAnchor);
        monday.setUTCDate(utcAnchor.getUTCDate() - mondayOffset);

        return Array.from({ length: 5 }, (_, index) => {
            const current = new Date(monday);
            current.setUTCDate(monday.getUTCDate() + index);
            const year = String(current.getUTCFullYear()).padStart(4, "0");
            const month = String(current.getUTCMonth() + 1).padStart(2, "0");
            const day = String(current.getUTCDate()).padStart(2, "0");
            return `${year}-${month}-${day}`;
        });
    }

    private static summarizeOrbReport(
        report: Pick<
            OrbReportComputation,
            | "sessionDate"
            | "totalCandidatesBoughtAtStart"
            | "numberOfCandidatesSoldLong"
            | "numberOfCandidatesBoughtShort"
            | "totalCostOfBreakoutCandidatePurchases"
            | "totalAmountOfCashAtStopLossRisk"
            | "totalProfitLossToDate"
        >,
    ): WeeklySummaryDay {
        return {
            sessionDate: report.sessionDate,
            totalCandidatesBoughtAtStart: report.totalCandidatesBoughtAtStart,
            numberOfCandidatesSoldLong: report.numberOfCandidatesSoldLong,
            numberOfCandidatesBoughtShort: report.numberOfCandidatesBoughtShort,
            totalCostOfBreakoutCandidatePurchases:
                report.totalCostOfBreakoutCandidatePurchases,
            totalAmountOfCashAtStopLossRisk:
                report.totalAmountOfCashAtStopLossRisk,
            totalProfitLossToDate: report.totalProfitLossToDate,
        };
    }

    private static accumulateDailySummaries(dailySummaries: WeeklySummaryDay[]) {
        return dailySummaries.reduce(
            (acc, day) => {
                acc.totalCandidatesBoughtAtStart += day.totalCandidatesBoughtAtStart;
                acc.numberOfCandidatesSoldLong += day.numberOfCandidatesSoldLong;
                acc.numberOfCandidatesBoughtShort += day.numberOfCandidatesBoughtShort;
                acc.totalCostOfBreakoutCandidatePurchases +=
                    day.totalCostOfBreakoutCandidatePurchases;
                acc.totalAmountOfCashAtStopLossRisk +=
                    day.totalAmountOfCashAtStopLossRisk;
                acc.totalProfitLossToDate += day.totalProfitLossToDate;
                return acc;
            },
            {
                totalCandidatesBoughtAtStart: 0,
                numberOfCandidatesSoldLong: 0,
                numberOfCandidatesBoughtShort: 0,
                totalCostOfBreakoutCandidatePurchases: 0,
                totalAmountOfCashAtStopLossRisk: 0,
                totalProfitLossToDate: 0,
            },
        );
    }

    private static isWeekdaySessionDate(sessionDate: string): boolean {
        const [year, month, day] = sessionDate.split("-").map(Number);
        const utcDate = new Date(Date.UTC(year, month - 1, day));
        const dayOfWeek = utcDate.getUTCDay();
        return dayOfWeek !== 0 && dayOfWeek !== 6;
    }

    private static dailySessionJsonPath(sessionDate: string): string {
        return path.join(dailySessionDir, `${sessionDate}.json`);
    }

    private static writeDailySessionRecord(
        reportData: OrbReportComputation,
        htmlReportPath: string,
        pdfReportPath: string,
    ) {
        fs.mkdirSync(dailySessionDir, { recursive: true });

        const record: DailySessionRecord = {
            schemaVersion: 1,
            sessionDate: reportData.sessionDate,
            sessionMode: env.sessionMode,
            continuous: false,
            status: 'completed',
            startedAt: null,
            completedAt: new Date().toISOString(),
            timezone: strategyConfig.sessionTimezone,
            strategy: {
                referenceSymbol: strategyConfig.symbol,
                openingRangeMinutes: strategyConfig.openingRangeMinutes,
                candleMinutes: strategyConfig.candleMinutes,
                allowLong: strategyConfig.allowLong,
                allowShort: strategyConfig.allowShort,
                lastEntryTimeHHMM: strategyConfig.lastEntryTimeHHMM,
                forceExitTimeHHMM: strategyConfig.forceExitTimeHHMM,
            },
            risk: {
                maxTotalRisk: env.maxTotalRisk,
                hardBasketCap: env.hardBasketCap,
                maxPositionNotional: env.maxPositionNotional,
                atrStopMultiple: env.atrStopMultiple,
                minStopPct: env.minStopPct,
                stopLossProfitRatio: env.stopLossProfitRatio,
                takeProfitMultiple: env.takeProfitMultiple,
            },
            dataSources: {
                quantityToRetrieve: env.quantityToRetrieve,
                dataFeed: env.dataFeed,
                usesHistoricData: true,
            },
            breakoutFilters: {
                breakoutConfirmationCandleMinutes: env.breakoutConfirmationCandleMinutes,
                breakoutQualityFiltersEnabled: env.breakoutQualityFiltersEnabled,
                breakoutMinVolumeExpansion: env.breakoutMinVolumeExpansion,
                breakoutMinRelativeStrengthPct: env.breakoutMinRelativeStrengthPct,
                breakoutTrendTimeframeMinutes: env.breakoutTrendTimeframeMinutes,
                breakoutTrendLookbackBars: env.breakoutTrendLookbackBars,
            },
            sessionProgress: {
                maxSessionBars: reportData.maxSessionBars,
                symbolsScanned: reportData.symbols.length,
                breakoutCandidates: reportData.breakoutCandidates.length,
                emulatedTrades: reportData.emulatedTrades.length,
                finalOutcomes: reportData.finalOutcomes.length,
            },
            mostActiveSymbols: reportData.symbols,
            mostActiveSymbolCount: reportData.symbols.length,
            insufficientSymbols: reportData.insufficientSymbols,
            marketScan: {
                maxSessionBars: reportData.maxSessionBars,
                candidateTradeType: env.candidateTradeType,
            },
            evaluationRows: reportData.evaluationRows,
            breakoutCandidates: reportData.breakoutCandidates,
            emulatedTrades: reportData.emulatedTrades,
            finalOutcomes: reportData.finalOutcomes,
            candidateTradeActivity: {
                totalCandidatesBoughtAtStart: reportData.totalCandidatesBoughtAtStart,
                numberOfCandidatesSoldLong: reportData.numberOfCandidatesSoldLong,
                numberOfCandidatesBoughtShort: reportData.numberOfCandidatesBoughtShort,
                totalCostOfBreakoutCandidatePurchases: reportData.totalCostOfBreakoutCandidatePurchases,
                totalAmountOfCashAtStopLossRisk: reportData.totalAmountOfCashAtStopLossRisk,
                totalProfitLossToDate: reportData.totalProfitLossToDate,
            },
            totals: {
                totalCandidatesBoughtAtStart: reportData.totalCandidatesBoughtAtStart,
                numberOfCandidatesSoldLong: reportData.numberOfCandidatesSoldLong,
                numberOfCandidatesBoughtShort: reportData.numberOfCandidatesBoughtShort,
                totalCostOfBreakoutCandidatePurchases: reportData.totalCostOfBreakoutCandidatePurchases,
                totalAmountOfCashAtStopLossRisk: reportData.totalAmountOfCashAtStopLossRisk,
                totalProfitLossToDate: reportData.totalProfitLossToDate,
            },
            artifacts: {
                htmlReportPath,
                pdfReportPath,
                htmlRelativePath: path.relative(path.resolve(process.cwd(), 'reports'), htmlReportPath).split(path.sep).join('/'),
                pdfRelativePath: path.relative(path.resolve(process.cwd(), 'reports'), pdfReportPath).split(path.sep).join('/'),
            },
            notes: [
                'HTML and PDF artifacts are derived from this JSON record.',
            ],
        };

        const targetPath = Reports.dailySessionJsonPath(reportData.sessionDate);
        const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
        fs.renameSync(tmpPath, targetPath);
    }

    private static nyDateRangeInclusive(anchorDate: Date, currentDate: Date): string[] {
        const startNy = toNyParts(anchorDate, strategyConfig.sessionTimezone);
        const endNy = toNyParts(currentDate, strategyConfig.sessionTimezone);
        const start = new Date(Date.UTC(startNy.year, startNy.month - 1, startNy.day));
        const end = new Date(Date.UTC(endNy.year, endNy.month - 1, endNy.day));

        if (start.getTime() > end.getTime()) {
            throw new Error(
                `Running summary anchor date ${startNy.date} cannot be after current NY date ${endNy.date}`,
            );
        }

        const dates: string[] = [];
        for (const current = new Date(start); current.getTime() <= end.getTime();) {
            const year = String(current.getUTCFullYear()).padStart(4, "0");
            const month = String(current.getUTCMonth() + 1).padStart(2, "0");
            const day = String(current.getUTCDate()).padStart(2, "0");
            dates.push(`${year}-${month}-${day}`);
            current.setUTCDate(current.getUTCDate() + 1);
        }

        return dates;
    }

    private static async computeOrbReportData(
        client: AlpacaClient,
        sessionDate: string,
    ): Promise<OrbReportComputation> {
        const universeSymbols = await Reports.getFixedUniverseSymbols(client);
        const openingRangeBars = 15;
        const evaluationWindowMinutes = 15;
        const evaluationRows: OrbEvaluationRow[] = [];
        const breakoutCandidates: AtrBreakoutCandidate[] = [];
        const insufficientSymbols: string[] = [];

        const universeBarResults = await Reports.loadUniverseBars(client, universeSymbols, sessionDate);

        const rankedBySessionVolume = universeBarResults
            .map(({ symbol, bars }) => {
                const sessionBars = bars.filter(
                    (bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate,
                );
                const sessionVolume = sessionBars.reduce((sum, bar) => sum + bar.volume, 0);
                return {
                    symbol,
                    bars,
                    sessionVolume,
                };
            })
            .sort((left, right) => {
                if (right.sessionVolume !== left.sessionVolume) {
                    return right.sessionVolume - left.sessionVolume;
                }
                return left.symbol.localeCompare(right.symbol);
            });

        const barResults = rankedBySessionVolume
            .slice(0, env.quantityToRetrieve)
            .map(({ symbol, bars }) => ({ symbol, bars }));

        const selectedSymbols = barResults.map(({ symbol }) => symbol);

        let symbolDetails: MostActiveSymbolDetail[] = [];
        try {
            symbolDetails = await client.getMostActiveSymbolDetails(env.quantityToRetrieve);
        } catch {
            logger.warn('Failed to fetch most-active symbol details for report enrichment', { sessionDate });
        }
        const detailsBySymbol = new Map(symbolDetails.map((d) => [d.symbol, d]));

        const symbols: MostActiveSymbolDetail[] = selectedSymbols.map((symbol) => {
            const detail = detailsBySymbol.get(symbol);
            return {
                symbol,
                volume: detail?.volume ?? 0,
                trade_count: detail?.trade_count ?? 0,
            };
        });

        logger.info('Selected most active symbols by session historical volume', {
            sessionDate,
            universeSize: universeSymbols.length,
            selectedCount: symbols.length,
            symbols: symbols.map((s) => s.symbol),
        });

        const sessionBarCounts = barResults.map(
            ({ bars }) =>
                bars.filter(
                    (bar) =>
                        toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                        sessionDate,
                ).length,
        );
        const maxSessionBars =
            sessionBarCounts.length > 0 ? Math.max(...sessionBarCounts) : 0;

        for (const { symbol, bars } of barResults) {
            const sessionBars = bars.filter(
                (bar) =>
                    toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                    sessionDate,
            );

            if (sessionBars.length < openingRangeBars + evaluationWindowMinutes) {
                insufficientSymbols.push(symbol);
                continue;
            }

            const openingBars = sessionBars.slice(0, openingRangeBars);
            const openingPrice = openingBars[0].open;
            const openingRangeHigh = Math.max(...openingBars.map((bar) => bar.high));
            const openingRangeLow = Math.min(...openingBars.map((bar) => bar.low));
            const confirmationBars = Reports.aggregateBarsByMinutes(
                sessionBars,
                sessionDate,
                Math.max(1, Math.floor(env.breakoutConfirmationCandleMinutes)),
            );

            let breakoutBar: Bar | null = null;
            let confirmationRetestBar: Bar | null = null;
            let side: "buy" | "sell" | "none" = "none";
            let preBreakoutWickPrice: number | null = null;

            for (const confirmationBar of confirmationBars) {
                const minutesSinceOpen = Reports.minutesFromSessionOpen(confirmationBar);
                if (
                    minutesSinceOpen < strategyConfig.openingRangeMinutes
                    || minutesSinceOpen >= strategyConfig.openingRangeMinutes + evaluationWindowMinutes
                ) {
                    continue;
                }

                if (confirmationBar.close > openingRangeHigh) {
                    breakoutBar = confirmationBar;
                    side = "buy";
                    break;
                }

                if (confirmationBar.close < openingRangeLow) {
                    breakoutBar = confirmationBar;
                    side = "sell";
                    break;
                }
            }

            if (breakoutBar && side !== "none") {
                const breakoutIndex = sessionBars.findIndex(
                    (bar) => bar.timestamp === breakoutBar.timestamp,
                );
                const preBreakoutBar = breakoutIndex > 0 ? sessionBars[breakoutIndex - 1] : null;
                preBreakoutWickPrice = preBreakoutBar
                    ? side === "buy"
                        ? preBreakoutBar.high
                        : preBreakoutBar.low
                    : null;

                const postBreakoutBars = sessionBars.filter(
                    (bar) =>
                        new Date(bar.timestamp).getTime() >
                        new Date(breakoutBar.timestamp).getTime(),
                );

                for (const retestBar of postBreakoutBars) {
                    if (
                        side === "buy" &&
                        retestBar.low <= openingRangeHigh &&
                        retestBar.close > openingRangeHigh
                    ) {
                        confirmationRetestBar = retestBar;
                        break;
                    }

                    if (
                        side === "sell" &&
                        retestBar.high >= openingRangeLow &&
                        retestBar.close < openingRangeLow
                    ) {
                        confirmationRetestBar = retestBar;
                        break;
                    }
                }
            }

            const atrSourceBars = confirmationRetestBar
                ? sessionBars.filter(
                    (bar) =>
                        new Date(bar.timestamp).getTime() <=
                        new Date(confirmationRetestBar.timestamp).getTime(),
                )
                : sessionBars;
            const atr1m = Reports.calculateAtr1m(atrSourceBars, 14);

            evaluationRows.push({
                symbol,
                openingPrice: Number(openingPrice.toFixed(2)),
                openingRangeHigh: Number(openingRangeHigh.toFixed(2)),
                openingRangeLow: Number(openingRangeLow.toFixed(2)),
                breakoutPrice: breakoutBar
                    ? Number(breakoutBar.close.toFixed(2))
                    : null,
                breakoutTimestamp: breakoutBar ? breakoutBar.timestamp : null,
                confirmationRetestPrice: confirmationRetestBar
                    ? Number(confirmationRetestBar.close.toFixed(2))
                    : null,
                confirmationRetestTimestamp: confirmationRetestBar
                    ? confirmationRetestBar.timestamp
                    : null,
                atr1m: atr1m ? Number(atr1m.toFixed(4)) : null,
                side,
                qualityDetail: null,
            });

            if (side === "none" || !confirmationRetestBar || !atr1m || !breakoutBar) {
                continue;
            }

            const qualityDetail = Reports.evaluateBreakoutQuality({
                sessionBars,
                sessionDate,
                side,
                breakoutBar,
                openingRangeHigh,
                openingRangeLow,
                confirmationBars,
            });

            // Attach the quality detail to the evaluation row we just pushed.
            evaluationRows[evaluationRows.length - 1].qualityDetail = qualityDetail;

            if (!qualityDetail.passed) {
                continue;
            }

            const scoreMetrics = computeCandidateScore({
                bars: sessionBars,
                breakoutSide: side,
                latestClose: confirmationRetestBar.close,
                openingRangeHigh,
                openingRangeLow,
            });

            breakoutCandidates.push({
                symbol,
                side,
                price: confirmationRetestBar.close,
                reason: `post-opening-range ${side === "buy" ? "upside" : "downside"} breakout`,
                score: scoreMetrics.score,
                relativeBreakPct: scoreMetrics.relativeBreakPct,
                totalVolume: scoreMetrics.totalVolume,
                openingRangeHigh,
                openingRangeLow,
                preBreakoutWickPrice: preBreakoutWickPrice ?? undefined,
                atr1m,
            });
        }

        const filteredBreakoutCandidates = breakoutCandidates.filter((candidate) =>
            candidateAllowedByTradeType(candidate.side),
        );

        const atrSizedTrades = buildWeightedRiskTrades(
            filteredBreakoutCandidates,
            env.maxTotalRisk,
            env.takeProfitMultiple,
        );
        const emulatedTrades = normalizeTradesToConstraints(
            atrSizedTrades,
            env.maxTotalRisk,
            env.hardBasketCap,
            env.maxPositionNotional,
        );
        const tradeBySymbol = new Map(
            emulatedTrades.map((trade) => [trade.symbol, trade]),
        );
        const sessionBarsBySymbol = new Map<string, Bar[]>();

        for (const { symbol, bars } of barResults) {
            const sessionBars = bars.filter(
                (bar) =>
                    toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                    sessionDate,
            );
            if (sessionBars.length === 0) continue;
            sessionBarsBySymbol.set(symbol, sessionBars);
        }

        const totalCandidatesBoughtAtStart = filteredBreakoutCandidates.length;
        const numberOfCandidatesSoldLong = filteredBreakoutCandidates.filter(
            (trade) => trade.side === "buy",
        ).length;
        const numberOfCandidatesBoughtShort = filteredBreakoutCandidates.filter(
            (trade) => trade.side === "sell",
        ).length;
        const totalCostOfBreakoutCandidatePurchases = emulatedTrades.reduce(
            (sum, trade) => sum + trade.estimatedNotional,
            0,
        );
        const totalAmountOfCashAtStopLossRisk = emulatedTrades.reduce(
            (sum, trade) => sum + trade.plannedRiskDollars,
            0,
        );
        const closedOutcomeBySymbol = new Map<string, TradeOutcome>();
        const finalOutcomeBySymbol = new Map<string, TradeOutcome>();

        evaluationRows.forEach((row) => {
            const trade = tradeBySymbol.get(row.symbol);
            if (!trade || !row.confirmationRetestTimestamp) return;

            const sessionBars = sessionBarsBySymbol.get(row.symbol) ?? [];
            const entryTimeMs = new Date(row.confirmationRetestTimestamp!).getTime();
            const barsAfterEntry = sessionBars.filter(
                (bar) =>
                    new Date(bar.timestamp).getTime() > entryTimeMs - 60000,
            );

            const outcome = Reports.emulateExit(trade, barsAfterEntry);
            if (outcome.status !== "pending") {
                closedOutcomeBySymbol.set(row.symbol, outcome);
                finalOutcomeBySymbol.set(row.symbol, outcome);
                return;
            }

            const finalBar = sessionBars[sessionBars.length - 1];
            if (!finalBar) return;

            const pnlAtClose =
                trade.side === "buy"
                    ? (finalBar.close - trade.price) * trade.qty
                    : (trade.price - finalBar.close) * trade.qty;

            finalOutcomeBySymbol.set(row.symbol, {
                symbol: trade.symbol,
                side: trade.side,
                entryPrice: trade.price,
                stopPrice: trade.stopPrice,
                takeProfitPrice: trade.takeProfitPrice,
                qty: trade.qty,
                status: "pending",
                exitPrice: finalBar.close,
                exitTimestamp: finalBar.timestamp,
                pnl: pnlAtClose,
            });
        });

        const totalProfitLossToDate = [...finalOutcomeBySymbol.values()].reduce(
            (sum, outcome) => sum + outcome.pnl,
            0,
        );

        const finalOutcomes = [...finalOutcomeBySymbol.values()];

        return {
            sessionDate,
            symbols,
            evaluationRows,
            breakoutCandidates: filteredBreakoutCandidates,
            emulatedTrades,
            maxSessionBars,
            insufficientSymbols,
            totalCandidatesBoughtAtStart,
            numberOfCandidatesSoldLong,
            numberOfCandidatesBoughtShort,
            totalCostOfBreakoutCandidatePurchases,
            totalAmountOfCashAtStopLossRisk,
            totalProfitLossToDate,
            closedOutcomeBySymbol,
            finalOutcomeBySymbol,
            finalOutcomes,
            sessionBarsBySymbol,
        };
    }

    public static async generateRunningSummaryOrbReports(
        client: AlpacaClient,
        anchorDate: Date,
    ): Promise<RunningSummaryOrbReportResult> {
        const currentDate = new Date();
        const startDate = toNyParts(anchorDate, strategyConfig.sessionTimezone).date;
        const endDate = toNyParts(currentDate, strategyConfig.sessionTimezone).date;
        const sessionDates = Reports.nyDateRangeInclusive(anchorDate, currentDate);
        const dailySummaries: WeeklySummaryDay[] = [];
        const skippedDates: string[] = [];

        logger.info("Generating running ORB summary reports", {
            startDate,
            endDate,
            totalDatesInRange: sessionDates.length,
        });

        for (const sessionDate of sessionDates) {
            if (!Reports.isWeekdaySessionDate(sessionDate)) {
                skippedDates.push(sessionDate);
                continue;
            }

            try {
                const report = await Reports.computeOrbReportData(client, sessionDate);
                dailySummaries.push(Reports.summarizeOrbReport(report));
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes("fewer than 30 session bars")) {
                    skippedDates.push(sessionDate);
                    logger.info("Skipping running summary date because NY market was closed", {
                        sessionDate,
                        message,
                    });
                    continue;
                }

                throw error;
            }
        }

        if (dailySummaries.length === 0) {
            throw new Error(
                `No NY market-open sessions found between ${startDate} and ${endDate}`,
            );
        }

        const totals = Reports.accumulateDailySummaries(dailySummaries);
        const reportDir = path.resolve(process.cwd(), "reports");
        const htmlReportPath = path.join(
            reportDir,
            `running-summary-start-date-${startDate}.html`,
        );
        const pdfSourceHtmlPath = path.join(
            reportDir,
            `running-summary-start-date-${startDate}-pdf-source.html`,
        );
        const pdfReportPath = path.join(
            reportDir,
            `running-summary-start-date-${startDate}.pdf`,
        );

        const dailyRowsHtml = dailySummaries
            .map(
                (day) => `<tr>
                    <td>${Reports.escapeHtml(day.sessionDate)}</td>
                    <td>${day.totalCandidatesBoughtAtStart}</td>
                    <td>${day.numberOfCandidatesSoldLong}</td>
                    <td>${day.numberOfCandidatesBoughtShort}</td>
                    <td>${day.totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td>
                    <td>${day.totalAmountOfCashAtStopLossRisk.toFixed(2)}</td>
                    <td>${day.totalProfitLossToDate.toFixed(2)}</td>
                </tr>`,
            )
            .join("\n");

        const tableSummaryRowHtml = `<tr class="summary-row">
            <th>Totals</th>
            <th>${totals.totalCandidatesBoughtAtStart}</th>
            <th>${totals.numberOfCandidatesSoldLong}</th>
            <th>${totals.numberOfCandidatesBoughtShort}</th>
            <th>${totals.totalCostOfBreakoutCandidatePurchases.toFixed(2)}</th>
            <th>${totals.totalAmountOfCashAtStopLossRisk.toFixed(2)}</th>
            <th>${totals.totalProfitLossToDate.toFixed(2)}</th>
        </tr>`;

        const html = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ORB Running Summary</title>
    <style>
        body {
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #f7f9fc;
            color: #102a43;
            padding: 24px;
        }
        .panel {
            background: white;
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
            margin-bottom: 18px;
        }
        h1, h2 {
            margin: 0 0 10px;
            color: #0b1f3a;
        }
        p {
            margin: 0;
            color: #334e68;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 14px;
            font-size: 13px;
        }
        th, td {
            border-bottom: 1px solid #d9e2ec;
            padding: 8px;
            text-align: left;
        }
        thead th {
            background: #f0f4f8;
        }
        tfoot th {
            background: #d9e2ec;
        }
        .note {
            margin-top: 12px;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <section class="panel">
        <h1>Running ORB Summary</h1>
        <p>Date range: ${Reports.escapeHtml(startDate)} through ${Reports.escapeHtml(endDate)}</p>
        <p>Breakout Candidate Trade Type: ${Reports.escapeHtml(candidateTradeTypeLabel())}</p>
    </section>
    <section class="panel">
        <h2>Daily Summary Metrics</h2>
        <table>
            <thead>
                <tr>
                    <th>Session Date</th>
                    <th>Total Number of Candidates Bought at Start</th>
                    <th>Number of Candidates Sold Long</th>
                    <th>Number of Candidates Bought Short</th>
                    <th>Total cost of Breakout Candidate purchases</th>
                    <th>Total amount of cash at stop loss risk</th>
                    <th>Total Profit (Loss) to Date</th>
                </tr>
            </thead>
            <tbody>
                ${dailyRowsHtml}
            </tbody>
            <tfoot>
                ${tableSummaryRowHtml}
            </tfoot>
        </table>
        <p class="note">Included ${dailySummaries.length} NY market-open sessions. Skipped ${skippedDates.length} dates with closed markets or no session bars.</p>
    </section>
</body>
</html>`;

        Reports.writeHtmlReport(htmlReportPath, html);
        Reports.writeHtmlReport(pdfSourceHtmlPath, html);
        await Reports.renderHtmlToPdf(pdfSourceHtmlPath, pdfReportPath);
        Reports.unlinkIfExists(pdfSourceHtmlPath);

        logger.info("Generated running ORB summary reports", {
            startDate,
            endDate,
            htmlReportPath,
            pdfReportPath,
            includedSessions: dailySummaries.length,
            skippedSessions: skippedDates.length,
        });

        return {
            startDate,
            endDate,
            dailySummaries,
            skippedDates,
            htmlReportPath,
            pdfReportPath,
            totalCandidatesBoughtAtStart: totals.totalCandidatesBoughtAtStart,
            numberOfCandidatesSoldLong: totals.numberOfCandidatesSoldLong,
            numberOfCandidatesBoughtShort: totals.numberOfCandidatesBoughtShort,
            totalCostOfBreakoutCandidatePurchases:
                totals.totalCostOfBreakoutCandidatePurchases,
            totalAmountOfCashAtStopLossRisk: totals.totalAmountOfCashAtStopLossRisk,
            totalProfitLossToDate: totals.totalProfitLossToDate,
        };
    }

    public static async generateWeeklySummaryOrbReports(
        client: AlpacaClient,
        date: Date,
    ): Promise<WeeklySummaryOrbReportResult> {
        const sessionDates = Reports.weekDatesMondayToFriday(date);
        const weekStartDate = sessionDates[0];
        const weekEndDate = sessionDates[sessionDates.length - 1];

        logger.info("Generating weekly ORB summary reports", {
            weekStartDate,
            weekEndDate,
            sessionDates,
        });

        const dailySummaries: WeeklySummaryDay[] = [];
        for (const sessionDate of sessionDates) {
            const report = await Reports.generateOrbReport(client, sessionDate, {
                usesHistoricData: true,
            });
            dailySummaries.push(Reports.summarizeOrbReport(report));
        }

        const totals = Reports.accumulateDailySummaries(dailySummaries);

        const reportDir = path.resolve(process.cwd(), "reports");
        const htmlReportPath = path.join(
            reportDir,
            `summary-for-week-ending-${weekEndDate}.html`,
        );
        const pdfSourceHtmlPath = path.join(
            reportDir,
            `summary-for-week-ending-${weekEndDate}-pdf-source.html`,
        );
        const pdfReportPath = path.join(
            reportDir,
            `summary-for-week-ending-${weekEndDate}.pdf`,
        );

        const dailyRowsHtml = dailySummaries
            .map(
                (day) => `<tr>
                    <td>${Reports.escapeHtml(day.sessionDate)}</td>
                    <td>${day.totalCandidatesBoughtAtStart}</td>
                    <td>${day.numberOfCandidatesSoldLong}</td>
                    <td>${day.numberOfCandidatesBoughtShort}</td>
                    <td>${day.totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td>
                    <td>${day.totalAmountOfCashAtStopLossRisk.toFixed(2)}</td>
                    <td>${day.totalProfitLossToDate.toFixed(2)}</td>
                </tr>`,
            )
            .join("\n");

        const totalsRowsHtml = `<tr><th>Total Number of Candidates Bought at Start</th><td>${totals.totalCandidatesBoughtAtStart}</td></tr>
            <tr><th>Number of Candidates Sold Long</th><td>${totals.numberOfCandidatesSoldLong}</td></tr>
            <tr><th>Number of Candidates Bought Short</th><td>${totals.numberOfCandidatesBoughtShort}</td></tr>
            <tr><th>Total cost of Breakout Candidate purchases</th><td>${totals.totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td></tr>
            <tr><th>Total amount of cash at stop loss risk</th><td>${totals.totalAmountOfCashAtStopLossRisk.toFixed(2)}</td></tr>
            <tr><th>Total Profit (Loss) to Date</th><td>${totals.totalProfitLossToDate.toFixed(2)}</td></tr>`;

        const html = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>ORB Weekly Summary</title>
    <style>
        body {
            margin: 0;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #f7f9fc;
            color: #102a43;
            padding: 24px;
        }
        .panel {
            background: white;
            border-radius: 16px;
            padding: 20px;
            box-shadow: 0 8px 24px rgba(15, 23, 42, 0.08);
            margin-bottom: 18px;
        }
        h1, h2 {
            margin: 0 0 10px;
            color: #0b1f3a;
        }
        p {
            margin: 0;
            color: #334e68;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 14px;
            font-size: 13px;
        }
        th, td {
            border-bottom: 1px solid #d9e2ec;
            padding: 8px;
            text-align: left;
        }
        th {
            background: #f0f4f8;
        }
    </style>
</head>
<body>
    <section class="panel">
        <h1>Weekly ORB Summary</h1>
        <p>Week range: ${Reports.escapeHtml(weekStartDate)} to ${Reports.escapeHtml(weekEndDate)}</p>
        <p>Breakout Candidate Trade Type: ${Reports.escapeHtml(candidateTradeTypeLabel())}</p>
    </section>
    <section class="panel">
        <h2>Daily Summary Metrics</h2>
        <table>
            <thead>
                <tr>
                    <th>Session Date</th>
                    <th>Total Number of Candidates Bought at Start</th>
                    <th>Number of Candidates Sold Long</th>
                    <th>Number of Candidates Bought Short</th>
                    <th>Total cost of Breakout Candidate purchases</th>
                    <th>Total amount of cash at stop loss risk</th>
                    <th>Total Profit (Loss) to Date</th>
                </tr>
            </thead>
            <tbody>
                ${dailyRowsHtml}
            </tbody>
        </table>
    </section>
    <section class="panel">
        <h2>Week Totals</h2>
        <table>
            <tbody>
                ${totalsRowsHtml}
            </tbody>
        </table>
    </section>
</body>
</html>`;

        Reports.writeHtmlReport(htmlReportPath, html);
        Reports.writeHtmlReport(pdfSourceHtmlPath, html);
        await Reports.renderHtmlToPdf(pdfSourceHtmlPath, pdfReportPath);
        Reports.unlinkIfExists(pdfSourceHtmlPath);

        logger.info("Generated weekly ORB summary reports", {
            weekStartDate,
            weekEndDate,
            htmlReportPath,
            pdfReportPath,
        });

        return {
            weekStartDate,
            weekEndDate,
            dailySummaries,
            htmlReportPath,
            pdfReportPath,
            totalCandidatesBoughtAtStart: totals.totalCandidatesBoughtAtStart,
            numberOfCandidatesSoldLong: totals.numberOfCandidatesSoldLong,
            numberOfCandidatesBoughtShort: totals.numberOfCandidatesBoughtShort,
            totalCostOfBreakoutCandidatePurchases:
                totals.totalCostOfBreakoutCandidatePurchases,
            totalAmountOfCashAtStopLossRisk: totals.totalAmountOfCashAtStopLossRisk,
            totalProfitLossToDate: totals.totalProfitLossToDate,
        };
    }

    public static buildReportSubtitle(
        sessionDate: string,
        usesHistoricData = false,
    ): string {
        const dataSourcePhrase = usesHistoricData
            ? "using historic data from"
            : "using";
        return `ORB activity for the New York session on ${Reports.escapeHtml(sessionDate)} ${dataSourcePhrase} the first 15 minutes for the opening range and the following 15 minutes for breakout detection, then managing positions until market close.`;
    }

    private static escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    private static writeHtmlReport(filePath: string, html: string) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, html, "utf8");
    }
    private static unlinkIfExists(filePath: string) {
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }

    private static async renderHtmlToPdf(htmlPath: string, pdfPath: string) {
        const browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });

        try {
            const page = await browser.newPage();
            await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
            await page.pdf({
                path: pdfPath,
                format: "A4",
                landscape: true,
                printBackground: true,
                margin: {
                    top: "0.5in",
                    right: "0.5in",
                    bottom: "0.5in",
                    left: "0.5in",
                },
            });
        } finally {
            await browser.close();
        }
    }

    private static dedupeAndSortBars(bars: Bar[]): Bar[] {
        const byTimestamp = new Map<string, Bar>();
        for (const bar of bars) {
            byTimestamp.set(bar.timestamp, bar);
        }

        return [...byTimestamp.values()].sort(
            (a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
    }

    private static aggregateBarsByMinutes(
        bars: Bar[],
        sessionDate: string,
        intervalMinutes: number,
    ): Bar[] {
        if (intervalMinutes <= 1) {
            return bars
                .filter(
                    (bar) =>
                        toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                        sessionDate,
                )
                .sort(
                    (a, b) =>
                        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
                );
        }

        const grouped = new Map<number, Bar>();
        const sessionBars = bars
            .filter(
                (bar) =>
                    toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                    sessionDate,
            )
            .sort(
                (a, b) =>
                    new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
            );

        for (const bar of sessionBars) {
            const p = toNyParts(bar.timestamp, strategyConfig.sessionTimezone);
            const totalMinutes = p.hour * 60 + p.minute;
            const bucketStartMinutes = Math.floor(totalMinutes / intervalMinutes) * intervalMinutes;

            const existing = grouped.get(bucketStartMinutes);
            if (!existing) {
                grouped.set(bucketStartMinutes, {
                    ...bar,
                    volume: bar.volume,
                });
                continue;
            }

            grouped.set(bucketStartMinutes, {
                ...existing,
                high: Math.max(existing.high, bar.high),
                low: Math.min(existing.low, bar.low),
                close: bar.close,
                volume: existing.volume + bar.volume,
            });
        }

        return [...grouped.values()].sort(
            (a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
    }

    private static minutesFromSessionOpen(bar: Bar): number {
        const p = toNyParts(bar.timestamp, strategyConfig.sessionTimezone);
        const sessionOpenMinutes =
            strategyConfig.sessionOpenHour * 60 + strategyConfig.sessionOpenMinute;
        return p.hour * 60 + p.minute - sessionOpenMinutes;
    }

    private static evaluateBreakoutQuality(params: {
        sessionBars: Bar[];
        sessionDate: string;
        side: "buy" | "sell";
        breakoutBar: Bar;
        openingRangeHigh: number;
        openingRangeLow: number;
        confirmationBars: Bar[];
    }): BreakoutQualityDetail {
        const {
            sessionBars,
            sessionDate,
            side,
            breakoutBar,
            openingRangeHigh,
            openingRangeLow,
            confirmationBars,
        } = params;

        const baseDetail: Omit<BreakoutQualityDetail, "passed" | "failReason"> = {
            filtersEnabled: env.breakoutQualityFiltersEnabled,
            volumeExpansion: null,
            minVolumeExpansion: env.breakoutMinVolumeExpansion,
            volumeExpansionPassed: false,
            relativeStrengthPct: null,
            minRelativeStrengthPct: env.breakoutMinRelativeStrengthPct,
            relativeStrengthPassed: false,
            trendAligned: null,
            trendTimeframeMinutes: env.breakoutTrendTimeframeMinutes,
            trendLookbackBars: env.breakoutTrendLookbackBars,
            trendAlignmentPassed: false,
        };

        if (!env.breakoutQualityFiltersEnabled) {
            return {
                ...baseDetail,
                volumeExpansionPassed: true,
                relativeStrengthPassed: true,
                trendAlignmentPassed: true,
                passed: true,
                failReason: null,
            };
        }

        const priorConfirmationBars = confirmationBars.filter(
            (bar) =>
                new Date(bar.timestamp).getTime() <
                new Date(breakoutBar.timestamp).getTime(),
        );
        if (!priorConfirmationBars.length) {
            return {
                ...baseDetail,
                passed: false,
                failReason: "no prior confirmation bars to measure volume expansion",
            };
        }

        const averagePriorVolume =
            priorConfirmationBars.reduce((sum, bar) => sum + bar.volume, 0) /
            priorConfirmationBars.length;
        const volumeExpansion = averagePriorVolume > 0
            ? breakoutBar.volume / averagePriorVolume
            : 0;
        const volumeExpansionPassed = volumeExpansion >= env.breakoutMinVolumeExpansion;

        const relativeStrengthPct =
            side === "buy"
                ? ((breakoutBar.close - openingRangeHigh) / openingRangeHigh) * 100
                : ((openingRangeLow - breakoutBar.close) / openingRangeLow) * 100;
        const relativeStrengthPassed = relativeStrengthPct >= env.breakoutMinRelativeStrengthPct;

        const trendBars = Reports.aggregateBarsByMinutes(
            sessionBars,
            sessionDate,
            Math.max(1, Math.floor(env.breakoutTrendTimeframeMinutes)),
        ).filter(
            (bar) =>
                new Date(bar.timestamp).getTime() <=
                new Date(breakoutBar.timestamp).getTime(),
        );

        const trendWindowSize = Math.max(2, Math.floor(env.breakoutTrendLookbackBars) + 1);
        const trendWindow = trendBars.slice(-trendWindowSize);
        if (trendWindow.length < trendWindowSize) {
            const failReasons: string[] = [];
            if (!volumeExpansionPassed) failReasons.push(`vol exp ${volumeExpansion.toFixed(2)} < ${env.breakoutMinVolumeExpansion}`);
            if (!relativeStrengthPassed) failReasons.push(`rel str ${relativeStrengthPct.toFixed(2)}% < ${env.breakoutMinRelativeStrengthPct}%`);
            failReasons.push("insufficient trend bars");
            return {
                ...baseDetail,
                volumeExpansion: Number(volumeExpansion.toFixed(4)),
                volumeExpansionPassed,
                relativeStrengthPct: Number(relativeStrengthPct.toFixed(4)),
                relativeStrengthPassed,
                trendAligned: null,
                trendAlignmentPassed: false,
                passed: false,
                failReason: failReasons.join("; "),
            };
        }

        const priorTrendBars = trendWindow.slice(0, -1);
        const trendSma =
            priorTrendBars.reduce((sum, bar) => sum + bar.close, 0) /
            priorTrendBars.length;
        const trendSlope =
            trendWindow[trendWindow.length - 1].close - trendWindow[0].close;
        const trendAligned =
            side === "buy"
                ? breakoutBar.close > trendSma && trendSlope > 0
                : breakoutBar.close < trendSma && trendSlope < 0;
        const trendAlignmentPassed = trendAligned;

        const passed = volumeExpansionPassed && relativeStrengthPassed && trendAlignmentPassed;
        const failReasons: string[] = [];
        if (!volumeExpansionPassed) failReasons.push(`vol exp ${volumeExpansion.toFixed(2)} < ${env.breakoutMinVolumeExpansion}`);
        if (!relativeStrengthPassed) failReasons.push(`rel str ${relativeStrengthPct.toFixed(2)}% < ${env.breakoutMinRelativeStrengthPct}%`);
        if (!trendAlignmentPassed) failReasons.push("trend not aligned");

        return {
            ...baseDetail,
            volumeExpansion: Number(volumeExpansion.toFixed(4)),
            volumeExpansionPassed,
            relativeStrengthPct: Number(relativeStrengthPct.toFixed(4)),
            relativeStrengthPassed,
            trendAligned,
            trendAlignmentPassed,
            passed,
            failReason: failReasons.length > 0 ? failReasons.join("; ") : null,
        };
    }

    private static formatNyTime(timestamp: string | null): string {
        if (!timestamp) {
            return "";
        }

        return toNyParts(timestamp, strategyConfig.sessionTimezone).hhmm;
    }

    private static renderCandidateCandlestickSvg(params: {
        bars: Bar[];
        row: OrbEvaluationRow | undefined;
        trade: SizedTrade | undefined;
        finalOutcome: TradeOutcome | undefined;
        openingRangeMinutes: number;
        maxBarsAfterDetermination: number;
    }): string {
        const { bars, row, trade, finalOutcome, openingRangeMinutes, maxBarsAfterDetermination } = params;
        if (!bars.length || !row?.confirmationRetestTimestamp) {
            return '<div class="candidate-chart-note">No chart data available for this candidate.</div>';
        }

        const determinationEndMs = new Date(row.confirmationRetestTimestamp).getTime();
        const sessionBars = [...bars].sort(
            (a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const determinationEndIndex = sessionBars.findIndex(
            (bar) => new Date(bar.timestamp).getTime() === determinationEndMs,
        );
        const effectiveDeterminationIndex = determinationEndIndex >= 0
            ? determinationEndIndex
            : sessionBars.findIndex((bar) => new Date(bar.timestamp).getTime() > determinationEndMs);
        const postStart = effectiveDeterminationIndex >= 0 ? effectiveDeterminationIndex + 1 : sessionBars.length;
        const chartBars = sessionBars.slice(0, Math.min(sessionBars.length, postStart + maxBarsAfterDetermination));

        if (!chartBars.length) {
            return '<div class="candidate-chart-note">No chart bars found in chart window.</div>';
        }

        const plotWidth = 820;
        const plotHeight = 250;
        const margin = { top: 14, right: 18, bottom: 90, left: 52 };
        const width = plotWidth + margin.left + margin.right;
        const height = plotHeight + margin.top + margin.bottom;

        const highs = chartBars.map((bar) => bar.high);
        const lows = chartBars.map((bar) => bar.low);
        const overlayValues = [
            row.openingRangeHigh,
            row.openingRangeLow,
            trade?.price,
            trade?.stopPrice,
            trade?.takeProfitPrice,
            finalOutcome?.exitPrice ?? undefined,
        ].filter((value): value is number => typeof value === "number" && Number.isFinite(value));

        const maxValue = Math.max(...highs, ...overlayValues);
        const minValue = Math.min(...lows, ...overlayValues);
        const pad = Math.max((maxValue - minValue) * 0.08, 0.25);
        const yMax = maxValue + pad;
        const yMin = Math.max(0, minValue - pad);
        const range = Math.max(yMax - yMin, 0.0001);

        const xForIndex = (index: number) => {
            if (chartBars.length <= 1) {
                return margin.left + plotWidth / 2;
            }
            return margin.left + (index / (chartBars.length - 1)) * plotWidth;
        };

        const yForPrice = (price: number) => margin.top + ((yMax - price) / range) * plotHeight;
        const candleWidth = Math.max(3, Math.min(12, plotWidth / Math.max(chartBars.length * 1.9, 6)));

        const determinationIndexInChart = chartBars.findIndex(
            (bar) => new Date(bar.timestamp).getTime() >= determinationEndMs,
        );
        const determinationCutoffIndex = determinationIndexInChart >= 0 ? determinationIndexInChart : chartBars.length;

        const openRangeStart = 0;
        const openRangeEnd = Math.max(0, openingRangeMinutes - 1);
        const openingRangeShadeWidth = Math.max(
            0,
            xForIndex(Math.min(openRangeEnd, chartBars.length - 1)) - xForIndex(openRangeStart),
        );

        const line = (price: number | undefined, color: string, dash = "none") => {
            if (typeof price !== "number" || !Number.isFinite(price)) {
                return "";
            }
            const y = yForPrice(price);
            const dashAttr = dash === "none" ? "" : ` stroke-dasharray="${dash}"`;
            return `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" stroke="${color}" stroke-width="1.2"${dashAttr} />`;
        };

        const postClosePathPoints = chartBars
            .map((bar, index) => ({
                index,
                close: bar.close,
                time: new Date(bar.timestamp).getTime(),
            }))
            .filter((point) => point.time > determinationEndMs)
            .map((point) => `${xForIndex(point.index)},${yForPrice(point.close)}`)
            .join(" ");

        const yTicks = Array.from({ length: 5 }, (_, i) => {
            const value = yMin + (range * i) / 4;
            const y = yForPrice(value);
            return {
                y,
                label: value.toFixed(2),
            };
        });

        const xTickStride = Math.max(1, Math.floor(chartBars.length / 7));
        const xTicks = chartBars
            .map((bar, index) => ({ bar, index }))
            .filter(({ index }) => index % xTickStride === 0 || index === chartBars.length - 1)
            .map(({ bar, index }) => ({
                x: xForIndex(index),
                label: Reports.escapeHtml(Reports.formatNyTime(bar.timestamp)),
            }));

        const candlesSvg = chartBars
            .map((bar, index) => {
                const x = xForIndex(index);
                const openY = yForPrice(bar.open);
                const closeY = yForPrice(bar.close);
                const highY = yForPrice(bar.high);
                const lowY = yForPrice(bar.low);
                const bodyTop = Math.min(openY, closeY);
                const bodyHeight = Math.max(1, Math.abs(closeY - openY));
                const bullish = bar.close >= bar.open;
                const bodyColor = bullish ? "#22c55e" : "#ef4444";
                return `<g>
                    <line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" stroke="#cbd5e1" stroke-width="1" />
                    <rect x="${x - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${bodyColor}" opacity="0.95" />
                </g>`;
            })
            .join("");

        const xDetermination = determinationCutoffIndex > 0 && determinationCutoffIndex < chartBars.length
            ? xForIndex(determinationCutoffIndex)
            : null;

        const exitTimestampMs = finalOutcome?.exitTimestamp != null
            ? new Date(finalOutcome.exitTimestamp).getTime()
            : Number.NaN;
        const hasExitTimestamp = Number.isFinite(exitTimestampMs);
        const closeIndexInChart = hasExitTimestamp
            ? chartBars.findIndex((bar) => new Date(bar.timestamp).getTime() >= exitTimestampMs)
            : -1;
        const xClose = hasExitTimestamp
            ? xForIndex(Math.min(Math.max(closeIndexInChart >= 0 ? closeIndexInChart : chartBars.length - 1, 0), chartBars.length - 1))
            : null;

        const labelBaseY = margin.top + plotHeight + 8;
        const timeLabelY = margin.top + plotHeight + 20;
        const legendY = margin.top + plotHeight + 34;
        const legendStartX = margin.left + 4;

        const yEntry = trade != null && Number.isFinite(trade.price) ? yForPrice(trade.price) : null;
        const xEntryForMarker = xDetermination ?? (chartBars.length > 0 ? xForIndex(0) : null);
        const entryMarkerSvg = xEntryForMarker == null || yEntry == null
            ? ""
            : `<polygon points="${xEntryForMarker},${yEntry - 8} ${xEntryForMarker - 6},${yEntry + 4} ${xEntryForMarker + 6},${yEntry + 4}" fill="#38bdf8" stroke="#0ea5e9" stroke-width="1" />`;

        const lineLegendItems: ReadonlyArray<{ label: string; color: string; dash: string }> = [
            { label: "OR High/Low", color: "#facc15", dash: "4 4" },
            { label: "Stop", color: "#f97316", dash: "6 3" },
            { label: "Target", color: "#22c55e", dash: "6 3" },
            ...(finalOutcome?.exitPrice != null
                ? [{ label: "Close", color: "#a78bfa", dash: "2 3" }]
                : []),
        ];
        const entryLegendX = legendStartX;
        const lineLegendStartX = legendStartX + 132;
        const legendSvg = [
            `<g>
                <polygon points="${entryLegendX + 10},${legendY - 7} ${entryLegendX + 4},${legendY + 5} ${entryLegendX + 16},${legendY + 5}" fill="#38bdf8" stroke="#0ea5e9" stroke-width="1" />
                <text x="${entryLegendX + 24}" y="${legendY + 4}" fill="#cbd5e1" font-size="11">Entry triangle</text>
            </g>`,
            ...lineLegendItems.map((item, index) => {
                const itemWidth = 126;
                const x = lineLegendStartX + index * itemWidth;
                return `<g>
                <line x1="${x}" y1="${legendY}" x2="${x + 22}" y2="${legendY}" stroke="${item.color}" stroke-width="1.8" stroke-dasharray="${item.dash}" />
                <text x="${x + 28}" y="${legendY + 4}" fill="#cbd5e1" font-size="11">${item.label}</text>
            </g>`;
            }),
        ].join("");

        return `<svg class="candidate-live-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Candlestick chart with breakout candidate levels">
            <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(15,23,42,0.72)" rx="8" />
            <rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="rgba(15,23,42,0.48)" />
            <rect x="${xForIndex(openRangeStart)}" y="${margin.top}" width="${openingRangeShadeWidth}" height="${plotHeight}" fill="rgba(14,165,233,0.09)" />
            <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#475569" stroke-width="1" />
            <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#475569" stroke-width="1" />
            ${yTicks.map((tick) => `<g><line x1="${margin.left}" y1="${tick.y}" x2="${margin.left + plotWidth}" y2="${tick.y}" stroke="rgba(148,163,184,0.18)" /><text x="${margin.left - 8}" y="${tick.y + 4}" fill="#cbd5e1" font-size="11" text-anchor="end">${tick.label}</text></g>`).join("")}
            ${xTicks.map((tick) => `<text x="${tick.x}" y="${timeLabelY}" fill="#cbd5e1" font-size="11" text-anchor="middle">${tick.label}</text>`).join("")}
            ${line(row.openingRangeHigh, "#facc15", "4 4")}
            ${line(row.openingRangeLow, "#facc15", "4 4")}
            ${line(trade?.stopPrice, "#f97316", "6 3")}
            ${line(trade?.takeProfitPrice, "#22c55e", "6 3")}
            ${line(finalOutcome?.exitPrice ?? undefined, "#a78bfa", "2 3")}
            ${candlesSvg}
            ${entryMarkerSvg}
            ${xDetermination != null ? `<line x1="${xDetermination}" y1="${margin.top}" x2="${xDetermination}" y2="${margin.top + plotHeight}" stroke="#60a5fa" stroke-width="1" stroke-dasharray="5 4" />` : ""}
            ${xClose != null ? `<line x1="${xClose}" y1="${margin.top}" x2="${xClose}" y2="${margin.top + plotHeight}" stroke="#a78bfa" stroke-width="1" stroke-dasharray="3 3" />` : ""}
            ${postClosePathPoints ? `<polyline points="${postClosePathPoints}" fill="none" stroke="#60a5fa" stroke-width="1.7" />` : ""}
            <text x="${margin.left + 6}" y="${margin.top + 14}" fill="#94a3b8" font-size="11">OR window</text>
            ${xDetermination != null ? `<text x="${xDetermination}" y="${labelBaseY}" fill="#93c5fd" font-size="11" text-anchor="start" transform="rotate(90 ${xDetermination} ${labelBaseY})">Determination end</text>` : ""}
            ${xClose != null ? `<text x="${xClose}" y="${labelBaseY}" fill="#c4b5fd" font-size="11" text-anchor="start" transform="rotate(90 ${xClose} ${labelBaseY})">Trade close</text>` : ""}
            ${legendSvg}
        </svg>`;
    }

    private static calculateAtr1m(bars: Bar[], period = 14): number | null {
        if (bars.length < 2) {
            return null;
        }

        const sortedBars = [...bars].sort(
            (a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const trueRanges: number[] = [];
        for (let index = 1; index < sortedBars.length; index++) {
            const current = sortedBars[index];
            const previous = sortedBars[index - 1];
            const rangeHighLow = current.high - current.low;
            const rangeHighPrevClose = Math.abs(current.high - previous.close);
            const rangeLowPrevClose = Math.abs(current.low - previous.close);
            trueRanges.push(
                Math.max(rangeHighLow, rangeHighPrevClose, rangeLowPrevClose),
            );
        }

        const atrWindow = trueRanges.slice(-period);
        if (atrWindow.length === 0) {
            return null;
        }

        const atr =
            atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
        return atr > 0 ? atr : null;
    }

    private static emulateExit(
        trade: SizedTrade,
        barsAfterEntry: Bar[],
    ): TradeOutcome {
        for (const bar of barsAfterEntry) {
            if (trade.side === "buy") {
                const stopHit = bar.low <= trade.stopPrice;
                const tpHit = bar.high >= trade.takeProfitPrice;

                if (stopHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "loss",
                        exitPrice: trade.stopPrice,
                        exitTimestamp: bar.timestamp,
                        pnl: (trade.stopPrice - trade.price) * trade.qty,
                    };
                }

                if (tpHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "profit",
                        exitPrice: trade.takeProfitPrice,
                        exitTimestamp: bar.timestamp,
                        pnl: (trade.takeProfitPrice - trade.price) * trade.qty,
                    };
                }
            } else {
                const stopHit = bar.high >= trade.stopPrice;
                const tpHit = bar.low <= trade.takeProfitPrice;

                if (stopHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "loss",
                        exitPrice: trade.stopPrice,
                        exitTimestamp: bar.timestamp,
                        pnl: (trade.price - trade.stopPrice) * trade.qty,
                    };
                }

                if (tpHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "profit",
                        exitPrice: trade.takeProfitPrice,
                        exitTimestamp: bar.timestamp,
                        pnl: (trade.price - trade.takeProfitPrice) * trade.qty,
                    };
                }
            }
        }

        return {
            symbol: trade.symbol,
            side: trade.side,
            entryPrice: trade.price,
            stopPrice: trade.stopPrice,
            takeProfitPrice: trade.takeProfitPrice,
            qty: trade.qty,
            status: "pending",
            exitPrice: null,
            exitTimestamp: null,
            pnl: 0,
        };
    }

    public static async generateOrbReport(
        client: AlpacaClient,
        sessionDate: string,
        options?: { usesHistoricData?: boolean; generateArtifacts?: boolean },
    ): Promise<OrbReportResult> {
        const reportData = await Reports.computeOrbReportData(client, sessionDate);
        const {
            symbols,
            evaluationRows,
            breakoutCandidates,
            emulatedTrades,
            maxSessionBars,
            insufficientSymbols,
            totalCandidatesBoughtAtStart,
            numberOfCandidatesSoldLong,
            numberOfCandidatesBoughtShort,
            totalCostOfBreakoutCandidatePurchases,
            totalAmountOfCashAtStopLossRisk,
            totalProfitLossToDate,
            closedOutcomeBySymbol,
            finalOutcomeBySymbol,
            sessionBarsBySymbol,
        } = reportData;
        const reportDir = path.resolve(process.cwd(), "reports");
        const htmlReportDir = path.resolve(reportDir, "html", sessionDate);
        fs.mkdirSync(reportDir, { recursive: true });
        const htmlReportPath = path.join(htmlReportDir, `orb-report-${sessionDate}.html`);
        const pdfSourceHtmlPath = path.join(reportDir, `orb-report-${sessionDate}.html`);
        const pdfReportPath = path.join(reportDir, `orb-report-${sessionDate}.pdf`);

        logger.info("Generating ORB report", {
            sessionDate,
            symbolCount: symbols.length,
        });

        const openingPriceRowsHtml = evaluationRows
            .map(
                (row) => `
                <tr>
                    <td>${Reports.escapeHtml(row.symbol)}</td>
                    <td>${row.openingPrice.toFixed(2)}</td>
                    <td>${row.openingRangeHigh.toFixed(2)}</td>
                    <td>${row.openingRangeLow.toFixed(2)}</td>
                </tr>`,
            )
            .join("");

        // Rows for every symbol that reached breakout+retest evaluation (side !== "none"
        // and a breakout bar was found), sorted: passed first, then failed/skipped.
        const filterAttributionRows = evaluationRows
            .filter((row) => row.qualityDetail !== null)
            .sort((a, b) => {
                const ap = a.qualityDetail!.passed ? 0 : 1;
                const bp = b.qualityDetail!.passed ? 0 : 1;
                return ap - bp;
            });

        const passIcon = "&#10003;"; // ✓
        const failIcon = "&#10007;"; // ✗
        const naLabel = "n/a";

        const filterAttributionRowsHtml = filterAttributionRows
            .map((row) => {
                const d = row.qualityDetail!;
                const rowClass = d.passed ? "filter-pass" : "filter-fail";
                const filtersNote = !d.filtersEnabled ? "<em>filters off</em>" : (d.failReason ?? "");
                const volCell = d.volumeExpansion !== null
                    ? `${d.volumeExpansion.toFixed(2)} (min ${d.minVolumeExpansion})`
                    : naLabel;
                const volPass = d.filtersEnabled
                    ? (d.volumeExpansionPassed ? passIcon : failIcon)
                    : naLabel;
                const rsCell = d.relativeStrengthPct !== null
                    ? `${d.relativeStrengthPct.toFixed(2)}% (min ${d.minRelativeStrengthPct}%)`
                    : naLabel;
                const rsPass = d.filtersEnabled
                    ? (d.relativeStrengthPassed ? passIcon : failIcon)
                    : naLabel;
                const trendCell = d.trendAligned !== null
                    ? (d.trendAligned ? "aligned" : "diverged")
                    : naLabel;
                const trendPass = d.filtersEnabled
                    ? (d.trendAlignmentPassed ? passIcon : failIcon)
                    : naLabel;
                return `
                <tr class="${rowClass}">
                    <td>${Reports.escapeHtml(row.symbol)}</td>
                    <td>${Reports.escapeHtml(row.side)}</td>
                    <td>${d.passed ? "PASS" : "FAIL"}</td>
                    <td>${volCell}</td>
                    <td>${volPass}</td>
                    <td>${rsCell}</td>
                    <td>${rsPass}</td>
                    <td>${trendCell}</td>
                    <td>${trendPass}</td>
                    <td>${Reports.escapeHtml(filtersNote)}</td>
                </tr>`;
            })
            .join("");

        const emulatedTradeBySymbol = new Map(
            emulatedTrades.map((trade) => [trade.symbol, trade]),
        );
        const evaluationRowBySymbol = new Map(
            evaluationRows.map((row) => [row.symbol, row]),
        );

        const confirmedTradeRowsHtml = breakoutCandidates
            .map((candidate, index) => {
                const trade = emulatedTradeBySymbol.get(candidate.symbol);
                const row = evaluationRowBySymbol.get(candidate.symbol);
                const closedOutcome = closedOutcomeBySymbol.get(candidate.symbol);
                const finalOutcome = finalOutcomeBySymbol.get(candidate.symbol);
                const closedProfitLoss = finalOutcome
                    ? finalOutcome.pnl.toFixed(2)
                    : "Open";
                const exitPrice =
                    finalOutcome?.exitPrice != null
                        ? finalOutcome.exitPrice.toFixed(2)
                        : "n/a";
                const exitType = closedOutcome
                    ? "Stop/Target"
                    : finalOutcome
                        ? "Market Close"
                        : "Open";
                const stopDistance = trade
                    ? (trade.side === "buy"
                        ? trade.price - trade.stopPrice
                        : trade.stopPrice - trade.price)
                    : 0;
                const targetDistance = trade
                    ? (trade.side === "buy"
                        ? trade.takeProfitPrice - trade.price
                        : trade.price - trade.takeProfitPrice)
                    : 0;
                const riskMultiple =
                    stopDistance > 0 ? `${(targetDistance / stopDistance).toFixed(2)}R` : "n/a";

                return `
                <tr>
                    <td>${index + 1}</td>
                    <td>${Reports.escapeHtml(candidate.symbol)}</td>
                    <td>${trade ? trade.qty.toFixed(4) : "n/a"}</td>
                    <td>${Reports.escapeHtml(candidate.side)}</td>
                    <td>${row?.breakoutPrice != null ? row.breakoutPrice.toFixed(2) : "n/a"}</td>
                    <td>${Reports.escapeHtml(Reports.formatNyTime(row?.breakoutTimestamp ?? null) || "n/a")}</td>
                    <td>${row?.confirmationRetestPrice != null ? row.confirmationRetestPrice.toFixed(2) : "n/a"}</td>
                    <td>${Reports.escapeHtml(Reports.formatNyTime(row?.confirmationRetestTimestamp ?? null) || "n/a")}</td>
                    <td>${candidate.preBreakoutWickPrice != null ? candidate.preBreakoutWickPrice.toFixed(2) : "n/a"}</td>
                    <td>${candidate.price.toFixed(2)}</td>
                    <td>${trade ? trade.stopPrice.toFixed(2) : "n/a"}</td>
                    <td>${trade ? trade.takeProfitPrice.toFixed(2) : "n/a"}</td>
                    <td>${riskMultiple}</td>
                    <td>${exitPrice}</td>
                    <td>${closedProfitLoss}</td>
                    <td>${exitType}</td>
                </tr>`;
            })
            .join("");

        const interactiveCandidateCardsHtml = breakoutCandidates
            .map((candidate) => {
                const trade = emulatedTradeBySymbol.get(candidate.symbol);
                const row = evaluationRowBySymbol.get(candidate.symbol);
                const closedOutcome = closedOutcomeBySymbol.get(candidate.symbol);
                const finalOutcome = finalOutcomeBySymbol.get(candidate.symbol);
                const symbolSessionBars = sessionBarsBySymbol.get(candidate.symbol) ?? [];
                const exitPrice =
                    finalOutcome?.exitPrice != null
                        ? finalOutcome.exitPrice.toFixed(2)
                        : "n/a";
                const exitType = closedOutcome
                    ? "Stop/Target"
                    : finalOutcome
                        ? "Market Close"
                        : "Open";
                const chartSvg = Reports.renderCandidateCandlestickSvg({
                    bars: symbolSessionBars,
                    row,
                    trade,
                    finalOutcome,
                    openingRangeMinutes: strategyConfig.openingRangeMinutes,
                    maxBarsAfterDetermination: 30,
                });

                return `
                <details class="candidate-card" id="candidate-${Reports.escapeHtml(candidate.symbol)}">
                    <summary class="candidate-summary">
                        <span class="candidate-symbol">${Reports.escapeHtml(candidate.symbol)}</span>
                        <span>${Reports.escapeHtml(candidate.side)}</span>
                        <span>${trade ? trade.qty.toFixed(4) : "n/a"}</span>
                        <span>${candidate.price.toFixed(2)}</span>
                        <span>${exitPrice}</span>
                        <span>${finalOutcome ? finalOutcome.pnl.toFixed(2) : "Open"}</span>
                    </summary>
                    <div class="candidate-drilldown">
                        <div class="candidate-chart-wrap">
                            ${chartSvg}
                            <p class="candidate-chart-note">Candles show breakout-candidate determination window and follow-through. Blue line plots close prices after determination.</p>
                        </div>
                        <table class="candidate-drilldown-table">
                            <tbody>
                                <tr><th>Breakout Price</th><td>${row?.breakoutPrice != null ? row.breakoutPrice.toFixed(2) : "n/a"}</td></tr>
                                <tr><th>Breakout Time</th><td>${Reports.escapeHtml(Reports.formatNyTime(row?.breakoutTimestamp ?? null) || "n/a")}</td></tr>
                                <tr><th>Retest Time</th><td>${Reports.escapeHtml(Reports.formatNyTime(row?.confirmationRetestTimestamp ?? null) || "n/a")}</td></tr>
                                <tr><th>Previous Candle Hi/Lo</th><td>${candidate.preBreakoutWickPrice != null ? candidate.preBreakoutWickPrice.toFixed(2) : "n/a"}</td></tr>
                                <tr><th>Stop</th><td>${trade ? trade.stopPrice.toFixed(2) : "n/a"}</td></tr>
                                <tr><th>Target</th><td>${trade ? trade.takeProfitPrice.toFixed(2) : "n/a"}</td></tr>
                                <tr><th>Exit Price</th><td>${exitPrice}</td></tr>
                                <tr><th>Exit Type</th><td>${Reports.escapeHtml(exitType)}</td></tr>
                                ${(() => {
                        const d = row?.qualityDetail;
                        if (!d) return "";
                        const p = (v: boolean | null, skip: boolean) =>
                            skip ? "n/a" : (v ? "&#10003;" : "&#10007;");
                        const skipped = !d.filtersEnabled;
                        return `
                                <tr><th colspan="2" style="padding-top:10px;font-size:11px;letter-spacing:.08em;text-transform:uppercase;opacity:.6">Quality Filters</th></tr>
                                <tr><th>Filters Enabled</th><td>${d.filtersEnabled ? "Yes" : "No"}</td></tr>
                                <tr><th>Vol Expansion</th><td>${d.volumeExpansion !== null ? d.volumeExpansion.toFixed(2) : "n/a"} (min ${d.minVolumeExpansion}) ${p(d.volumeExpansionPassed, skipped)}</td></tr>
                                <tr><th>Rel Strength</th><td>${d.relativeStrengthPct !== null ? d.relativeStrengthPct.toFixed(2) + "%" : "n/a"} (min ${d.minRelativeStrengthPct}%) ${p(d.relativeStrengthPassed, skipped)}</td></tr>
                                <tr><th>Trend Alignment</th><td>${d.trendAligned !== null ? (d.trendAligned ? "aligned" : "diverged") : "n/a"} ${p(d.trendAlignmentPassed, skipped)}</td></tr>
                                ${d.failReason ? `<tr><th>Fail Reason</th><td>${Reports.escapeHtml(d.failReason)}</td></tr>` : ""}`;
                    })()}
                            </tbody>
                        </table>
                    </div>
                </details>`;
            })
            .join("");

        const htmlDrilldownReport = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ORB Drilldown Report ${Reports.escapeHtml(sessionDate)}</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #111827;
            --ink: #f9fafb;
            --muted: #cbd5e1;
            --accent: #34d399;
            --border: rgba(255,255,255,0.12);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: radial-gradient(circle at top, #1f2937, var(--bg) 60%);
            color: var(--ink);
        }
        .page { max-width: 1280px; margin: 0 auto; padding: 32px 20px 72px; }
        .hero {
            background: linear-gradient(135deg, rgba(52,211,153,0.15), rgba(96,165,250,0.12));
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 24px 60px rgba(0,0,0,0.28);
        }
        h1 { margin: 0; font-size: 42px; letter-spacing: -0.03em; }
        .subtitle { margin: 10px 0 0; color: var(--muted); font-size: 16px; }
        .section {
            margin-top: 24px;
            background: rgba(31,41,55,0.92);
            border: 1px solid var(--border);
            border-radius: 22px;
            padding: 20px;
        }
        h2 { margin: 0 0 10px; font-size: 22px; }
        .summary-table {
            width: 100%;
            border-collapse: collapse;
        }
        .summary-table th,
        .summary-table td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
            text-align: left;
            vertical-align: top;
            font-size: 13px;
        }
        .summary-table th {
            color: var(--muted);
            font-weight: 600;
            width: 55%;
        }
        .summary-table tr:last-child th,
        .summary-table tr:last-child td { border-bottom: none; }
        .candidate-table-head {
            display: grid;
            grid-template-columns: 1.6fr 0.9fr 1fr 1fr 1fr 1fr;
            gap: 10px;
            padding: 0 12px 12px;
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }
        .candidate-card {
            border: 1px solid var(--border);
            border-radius: 18px;
            background: linear-gradient(180deg, rgba(36,50,68,0.98), rgba(31,41,55,0.98));
            margin-bottom: 12px;
            overflow: hidden;
        }
        .candidate-summary {
            list-style: none;
            display: grid;
            grid-template-columns: 1.6fr 0.9fr 1fr 1fr 1fr 1fr;
            gap: 10px;
            align-items: center;
            padding: 16px 12px;
            cursor: pointer;
            user-select: none;
        }
        .candidate-summary::-webkit-details-marker { display: none; }
        .candidate-symbol { color: var(--accent); font-weight: 700; letter-spacing: 0.02em; }
        .candidate-drilldown { border-top: 1px solid var(--border); padding: 12px; background: rgba(15,23,42,0.35); }
        .candidate-chart-wrap {
            border: 1px solid var(--border);
            border-radius: 12px;
            padding: 8px;
            background: rgba(2, 6, 23, 0.45);
            margin-bottom: 12px;
        }
        .candidate-chart-svg {
            width: 100%;
            height: auto;
            display: block;
        }
        .candidate-chart-note {
            margin: 8px 4px 0;
            color: var(--muted);
            font-size: 12px;
        }
        .candidate-drilldown-table { width: 100%; border-collapse: collapse; }
        .candidate-drilldown-table th,
        .candidate-drilldown-table td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
            text-align: left;
            vertical-align: top;
            font-size: 13px;
        }
        .candidate-drilldown-table th { width: 240px; color: var(--muted); font-weight: 600; }
        .candidate-drilldown-table tr:last-child th,
        .candidate-drilldown-table tr:last-child td { border-bottom: none; }
        .note { margin-top: 14px; color: var(--muted); font-size: 13px; }
    </style>
</head>
<body>
    <main class="page">
        <section class="hero">
            <h1>ORB Drilldown Report</h1>
        </section>

        <section class="section">
            <h2>Summary</h2>
            <table class="summary-table">
                <tbody>
                    <tr><th>Total Breakout Candidates Detected</th><td>${breakoutCandidates.length}</td></tr>
                    <tr><th>Breakout Candidate Trade Type</th><td>${Reports.escapeHtml(candidateTradeTypeLabel())}</td></tr>
                    <tr><th>Total Number of Candidates Bought at Start</th><td>${totalCandidatesBoughtAtStart}</td></tr>
                    <tr><th>Number of Candidates Sold Long</th><td>${numberOfCandidatesSoldLong}</td></tr>
                    <tr><th>Number of Candidates Bought Short</th><td>${numberOfCandidatesBoughtShort}</td></tr>
                    <tr><th>Total cost of Breakout Candidate purchases</th><td>${totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td></tr>
                    <tr><th>Total amount of cash at stop loss risk</th><td>${totalAmountOfCashAtStopLossRisk.toFixed(2)}</td></tr>
                    <tr><th>Stop Loss Profit Ratio</th><td>${Reports.escapeHtml(env.stopLossProfitRatio)}</td></tr>
                    <tr><th>Total Profit (Loss) to Date</th><td>${totalProfitLossToDate.toFixed(2)}</td></tr>
                </tbody>
            </table>
        </section>

        <section class="section">
            <h2>Breakout Candidates</h2>
            <div class="candidate-table-head">
                <div>Symbol</div>
                <div>Side</div>
                <div>Num of Shares Bought</div>
                <div>Entry Price</div>
                <div>Exit Price</div>
                <div>Profit (Loss)</div>
            </div>
            ${interactiveCandidateCardsHtml}
            <div class="note">Click a symbol row to drill into the breakout, retest, stop, target, and exit data for that symbol.</div>
        </section>
    </main>
</body>
</html>`;

        const htmlReport = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ORB Verification Report ${Reports.escapeHtml(sessionDate)}</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #f5efe5;
            --panel: #fffaf2;
            --ink: #1f2937;
            --muted: #6b7280;
            --accent: #0f766e;
            --accent-soft: #d9f3ee;
            --border: #e7dcc8;
            --warn: #9a3412;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Georgia, 'Times New Roman', serif;
            background: linear-gradient(180deg, #efe4d2 0%, var(--bg) 35%, #f9f4ec 100%);
            color: var(--ink);
        }
        .page {
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 24px 64px;
        }
        .hero {
            background: radial-gradient(circle at top left, #fff6e7, var(--panel));
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 18px 60px rgba(31, 41, 55, 0.08);
        }
        .eyebrow {
            margin: 0 0 8px;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--accent);
        }
        h1 {
            margin: 0;
            font-size: 42px;
            line-height: 1.05;
        }
        .subtitle {
            margin: 12px 0 0;
            font-size: 17px;
            color: var(--muted);
        }
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 14px;
            margin-top: 24px;
        }
        .metric {
            background: var(--accent-soft);
            border-radius: 18px;
            padding: 16px 18px;
        }
        .metric-label {
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .metric-value {
            display: block;
            margin-top: 6px;
            font-size: 28px;
            font-weight: 700;
            color: var(--accent);
        }
        .section {
            margin-top: 28px;
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 24px;
            box-shadow: 0 12px 40px rgba(31, 41, 55, 0.05);
        }
        h2 {
            margin: 0 0 6px;
            font-size: 24px;
        }
        .section-copy {
            margin: 0 0 18px;
            color: var(--muted);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            overflow: hidden;
            border-radius: 16px;
            table-layout: fixed;
        }
        thead th {
            background: #f1e6d7;
            color: #3f3f46;
            font-size: 10px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        th, td {
            padding: 8px 8px;
            border-bottom: 1px solid var(--border);
            text-align: left;
            vertical-align: top;
            font-size: 10px;
            line-height: 1.2;
            word-break: break-word;
        }
        tbody tr:nth-child(even) {
            background: #fffcf7;
        }
        .note {
            margin-top: 14px;
            padding: 14px 16px;
            border-radius: 16px;
            background: #fff4ed;
            color: var(--warn);
        }
    </style>
</head>
<body>
    <main class="page">
        <section class="hero">
            <p class=\"eyebrow\">Orbilicious Report for ${Reports.escapeHtml(sessionDate)}</p>
            <h1>Opening Range Breakout</h1>
            <p class=\"subtitle\">${Reports.buildReportSubtitle(sessionDate, options?.usesHistoricData === true)}</p>
            <div class="metrics">
                <div class="metric"><span class="metric-label">Symbols Requested</span><span class="metric-value">${env.quantityToRetrieve}</span></div>
                <div class="metric"><span class="metric-label">Symbols Received</span><span class="metric-value">${symbols.length}</span></div>
                <div class="metric"><span class="metric-label">Max Session Bars</span><span class="metric-value">${maxSessionBars}</span></div>
                <div class="metric"><span class="metric-label">Confirmed Candidates</span><span class="metric-value">${breakoutCandidates.length}</span></div>
                <div class="metric"><span class="metric-label">Emulated Trades</span><span class="metric-value">${emulatedTrades.length}</span></div>
            </div>
        </section>

        <section class="section">
            <h2>Opening Prices</h2>
            <p class="section-copy">Each most-active symbol with its market opening price and the derived opening-range high and low.</p>
            <table>
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Open</th>
                        <th>15 Min High</th>
                        <th>15 Min Low</th>
                    </tr>
                </thead>
                <tbody>${openingPriceRowsHtml}</tbody>
            </table>
        </section>

        <section class="section">
            <h2>Summary</h2>
            <p class="section-copy">Current run summary based on emulated ORB entries and latest available session prices.</p>
            <table>
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Value</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td>Breakout Candidate Trade Type</td><td>${Reports.escapeHtml(candidateTradeTypeLabel())}</td></tr>
                    <tr><td>Total Number of Candidates Bought at Start</td><td>${totalCandidatesBoughtAtStart}</td></tr>
                    <tr><td>Number of Candidates Sold Long</td><td>${numberOfCandidatesSoldLong}</td></tr>
                    <tr><td>Number of Candidates Bought Short</td><td>${numberOfCandidatesBoughtShort}</td></tr>
                    <tr><td>Total cost of Breakout Candidate purchases</td><td>${totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td></tr>
                    <tr><td>Total amount of cash at stop loss risk</td><td>${totalAmountOfCashAtStopLossRisk.toFixed(2)}</td></tr>
                    <tr><td>Stop Loss Profit Ratio</td><td>${Reports.escapeHtml(env.stopLossProfitRatio)}</td></tr>
                    <tr><td>Total Profit (Loss) to Date</td><td>${totalProfitLossToDate.toFixed(2)}</td></tr>
                </tbody>
            </table>
        </section>

        <section class="section">
            <h2>Breakout Candidates</h2>
            <p class="section-copy">Detected breakout symbols, breakout timing, retest confirmation timing, and emulated entry/exit details from the current risk algorithm.</p>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Symbol</th>
                        <th>Number of Shares Bought</th>
                        <th>Side</th>
                        <th>Breakout Price</th>
                        <th>Breakout Time</th>
                        <th>Retest Price</th>
                        <th>Retest Time</th>
                        <th>Previous Candle Hi/Lo</th>
                        <th>Entry</th>
                        <th>Stop</th>
                        <th>Target</th>
                        <th>Risk Multiple</th>
                        <th>Exit Price</th>
                        <th>Profit (Loss)</th>
                        <th>Exit</th>
                    </tr>
                </thead>
                <tbody>${confirmedTradeRowsHtml}</tbody>
            </table>
            <div class="note">
                Symbols with fewer than 30 session bars: <strong>${insufficientSymbols.length}</strong>
                <br />
                ${Reports.escapeHtml(insufficientSymbols.length > 0 ? insufficientSymbols.join(", ") : "None")}
            </div>
        </section>

        <section class="section">
            <h2>Filter Attribution</h2>
            <p class="section-copy">Per-candidate quality-filter pass/fail detail for every symbol that produced a breakout bar and a confirmation retest. Use this table to tune filter thresholds over time.</p>
            <table>
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th>Result</th>
                        <th>Vol Expansion</th>
                        <th>VE &#10003;/&#10007;</th>
                        <th>Rel Strength</th>
                        <th>RS &#10003;/&#10007;</th>
                        <th>Trend</th>
                        <th>TR &#10003;/&#10007;</th>
                        <th>Notes</th>
                    </tr>
                </thead>
                <tbody>${filterAttributionRowsHtml}</tbody>
            </table>
            <style>
                tr.filter-pass td { color: var(--accent); }
                tr.filter-fail td { color: var(--warn); }
            </style>
            <div class="note">
                Only symbols that reached breakout-bar + confirmation-retest evaluation are shown here.
                Symbols that never broke out of the opening range are omitted.
                When quality filters are disabled, all rows show "PASS" and individual checks show "n/a".
            </div>
        </section>
    </main>
</body>
</html>`;

        const generateArtifacts = options?.generateArtifacts !== false;
        if (generateArtifacts) {
            Reports.writeHtmlReport(htmlReportPath, htmlDrilldownReport);
            Reports.writeHtmlReport(pdfSourceHtmlPath, htmlReport);
            await Reports.renderHtmlToPdf(pdfSourceHtmlPath, pdfReportPath);
            Reports.unlinkIfExists(pdfSourceHtmlPath);
            logger.info("PDF report written", { sessionDate, pdfReportPath });
        }

        if (maxSessionBars < 30) {
            throw new Error(
                `Session ${sessionDate} has fewer than 30 session bars. Highest session bar count found: ${maxSessionBars}`,
            );
        }

        Reports.writeDailySessionRecord(reportData, htmlReportPath, pdfReportPath);

        return {
            sessionDate,
            symbols,
            evaluationRows,
            breakoutCandidates,
            emulatedTrades,
            finalOutcomes: [...finalOutcomeBySymbol.values()],
            htmlReportPath,
            pdfReportPath,
            maxSessionBars,
            insufficientSymbols,
            totalCandidatesBoughtAtStart,
            numberOfCandidatesSoldLong,
            numberOfCandidatesBoughtShort,
            totalCostOfBreakoutCandidatePurchases,
            totalAmountOfCashAtStopLossRisk,
            totalProfitLossToDate,
        };
    }
}
