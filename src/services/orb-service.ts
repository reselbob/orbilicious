// ORB service layer: manages the continuous cycle loop, session
// lifecycle, realtime-feed coordination, and historical backtest
// dispatch.
import { AlpacaClient } from '../alpaca';
import { runCycle } from '../app';
import { SizedTrade } from '../basket';
import { ITrader } from '../trading/trader-interface';
import { Emulator } from '../trading/emulator';
import { LiveTrader } from '../trading/live-trader';
import { env } from '../config';
import type {
    OrbReportResult,
    RunningSummaryOrbReportResult,
    WeeklySummaryOrbReportResult,
} from '../reports';

export type GenerateDailyReportOptions = {
    usesHistoricData?: boolean;
    generateArtifacts?: boolean;
};

export type RunTradingCycleOptions = {
    mostActiveSymbolLimit?: number;
};

export type RunTradingCycleFn = (
    client: AlpacaClient,
    trader: ITrader,
    sessionDate: string,
    options?: RunTradingCycleOptions,
) => Promise<SizedTrade[]>;

export type OptimalFilters = {
    breakoutConfirmationCandleMinutes: number;
    breakoutQualityFiltersEnabled: boolean;
    breakoutMinVolumeExpansion: number;
    breakoutMinRelativeStrengthPct: number;
    breakoutTrendTimeframeMinutes: number;
    breakoutTrendLookbackBars: number;
    atrStopMultiple: number;
    minStopPct: number;
    maxRiskPctPerSymbol: number;
};

/**
 * Application-level orchestration service for trading and reporting flows.
 *
 * This gives web/API entry points a single surface to invoke without coupling
 * route/controller code directly to low-level client and report classes.
 */
export class OrbService {
    getDefaultOptimalFilters(): OptimalFilters {
        return {
            breakoutConfirmationCandleMinutes: 5,
            breakoutQualityFiltersEnabled: true,
            breakoutMinVolumeExpansion: 1.5,
            breakoutMinRelativeStrengthPct: 0.5,
            breakoutTrendTimeframeMinutes: 5,
            breakoutTrendLookbackBars: 3,
            atrStopMultiple: 1.5,
            minStopPct: 1.25,
            maxRiskPctPerSymbol: 20,
        };
    }

    /**
     * Analyze historical price data and return optimal filter values for a symbol.
     * This implementation uses simple heuristics over the last session's bars.
     */
    async getOptimalFilters(symbol: string, sessionDate?: string): Promise<OptimalFilters> {
        const normalizedSymbol = (symbol || '').trim().toUpperCase();
        if (!/^[A-Z]{1,6}$/.test(normalizedSymbol)) {
            throw new Error('Invalid symbol for optimal filter analysis.');
        }

        // Fetch 1-min bars for the session
        const bars = await this.client.getIntradayBars(normalizedSymbol, sessionDate || this.getDefaultSessionDate());
        if (!bars || bars.length < 20) {
            throw new Error('Not enough historical bars to analyze.');
        }

        // Heuristic: Use 5-min confirmation candle
        const breakoutConfirmationCandleMinutes = 5;

        // Volume expansion: max volume in last 10 bars / avg of previous 10
        const recentBars = bars.slice(-20);
        const vol10 = recentBars.slice(-10).map(b => b.volume);
        const volPrev10 = recentBars.slice(-20, -10).map(b => b.volume);
        const maxVol = Math.max(...vol10);
        const avgPrevVol = volPrev10.length ? volPrev10.reduce((a, b) => a + b, 0) / volPrev10.length : 1;
        const breakoutMinVolumeExpansion = avgPrevVol > 0 ? Math.max(1.05, Math.min(2, maxVol / avgPrevVol)) : 1.1;

        // Relative strength: max close above min open in last 10 bars
        const closes = vol10.map((_, i) => recentBars[recentBars.length - 10 + i].close);
        const opens = vol10.map((_, i) => recentBars[recentBars.length - 10 + i].open);
        const maxClose = Math.max(...closes);
        const minOpen = Math.min(...opens);
        const breakoutMinRelativeStrengthPct = minOpen > 0 ? Math.max(0.05, Math.min(0.5, (maxClose - minOpen) / minOpen)) : 0.15;

        // Trend timeframe: use 5-min bars, look back 3 bars
        const breakoutTrendTimeframeMinutes = 5;
        const breakoutTrendLookbackBars = 3;

        // Enable quality filters if volume and relative strength are above thresholds
        const breakoutQualityFiltersEnabled = breakoutMinVolumeExpansion > 1.1 && breakoutMinRelativeStrengthPct > 0.1;

        return {
            breakoutConfirmationCandleMinutes,
            breakoutQualityFiltersEnabled,
            breakoutMinVolumeExpansion: Number(breakoutMinVolumeExpansion.toFixed(2)),
            breakoutMinRelativeStrengthPct: Number(breakoutMinRelativeStrengthPct.toFixed(2)),
            breakoutTrendTimeframeMinutes,
            breakoutTrendLookbackBars,
            atrStopMultiple: 2,
            minStopPct: 1.5,
            maxRiskPctPerSymbol: 20,
        };
    }

    getDefaultSessionDate(): string {
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');
        const day = String(now.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    constructor(
        private readonly client: AlpacaClient = new AlpacaClient(),
        private readonly runTradingCycleFn: RunTradingCycleFn = runCycle,
        private readonly trader: ITrader = env.sessionMode === 'EMULATION' ? new Emulator(client) : new LiveTrader(client),
    ) { }

    get alpacaClient(): AlpacaClient {
        return this.client;
    }

    async runTradingCycle(sessionDate: string, options?: RunTradingCycleOptions): Promise<void> {
        await this.runTradingCycleFn(this.client, this.trader, sessionDate, options);
    }

    async generateDailyReport(
        sessionDate?: string,
        options?: GenerateDailyReportOptions,
    ): Promise<OrbReportResult> {
        return this.client.generateOrbReport(sessionDate, options);
    }

    async generateWeeklySummaryReport(
        anchorDate: Date,
    ): Promise<WeeklySummaryOrbReportResult> {
        return this.client.generateWeeklySummaryOrbReports(anchorDate);
    }

    async generateRunningSummaryReport(
        anchorDate: Date,
    ): Promise<RunningSummaryOrbReportResult> {
        return this.client.generateRunningSummaryOrbReports(anchorDate);
    }

    async checkRealtimeDataFeedSupported(): Promise<boolean> {
        return this.client.checkSipFeedSupported();
    }
}
