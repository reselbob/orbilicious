import { AlpacaClient } from '../alpaca';
import { runCycle } from '../app';
import type {
    OrbReportResult,
    RunningSummaryOrbReportResult,
    WeeklySummaryOrbReportResult,
} from '../reports';

export type GenerateDailyReportOptions = {
    usesHistoricData?: boolean;
};

export type RunTradingCycleOptions = {
    mostActiveSymbolLimit?: number;
};

export type RunTradingCycleFn = (
    client: AlpacaClient,
    sessionDate: string,
    options?: RunTradingCycleOptions,
) => Promise<void>;

/**
 * Application-level orchestration service for trading and reporting flows.
 *
 * This gives web/API entry points a single surface to invoke without coupling
 * route/controller code directly to low-level client and report classes.
 */
export class OrbService {
    constructor(
        private readonly client: AlpacaClient = new AlpacaClient(),
        private readonly runTradingCycleFn: RunTradingCycleFn = runCycle,
    ) { }

    async runTradingCycle(sessionDate: string, options?: RunTradingCycleOptions): Promise<void> {
        await this.runTradingCycleFn(this.client, sessionDate, options);
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
