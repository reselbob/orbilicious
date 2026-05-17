import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { OrbService } from '../src/services/orb-service';
import type {
    OrbReportResult,
    RunningSummaryOrbReportResult,
    WeeklySummaryOrbReportResult,
} from '../src/reports';

class StubAlpacaClient extends AlpacaClient {
    generateOrbReportCalls: Array<{ sessionDate?: string; options?: { usesHistoricData?: boolean } }> = [];
    generateWeeklySummaryCalls: Date[] = [];
    generateRunningSummaryCalls: Date[] = [];

    override async generateOrbReport(
        sessionDate?: Date | string,
        options?: { usesHistoricData?: boolean },
    ): Promise<OrbReportResult> {
        this.generateOrbReportCalls.push({
            sessionDate: typeof sessionDate === 'string' ? sessionDate : undefined,
            options,
        });

        return {
            sessionDate: typeof sessionDate === 'string' ? sessionDate : '2099-01-01',
            symbols: [],
            evaluationRows: [],
            breakoutCandidates: [],
            emulatedTrades: [],
            finalOutcomes: [],
            htmlReportPath: '/tmp/orb-report.html',
            pdfReportPath: '/tmp/orb-report.pdf',
            maxSessionBars: 30,
            insufficientSymbols: [],
            totalCandidatesBoughtAtStart: 0,
            numberOfCandidatesSoldLong: 0,
            numberOfCandidatesBoughtShort: 0,
            totalCostOfBreakoutCandidatePurchases: 0,
            totalAmountOfCashAtStopLossRisk: 0,
            totalProfitLossToDate: 0,
        };
    }

    override async generateWeeklySummaryOrbReports(
        date: Date,
    ): Promise<WeeklySummaryOrbReportResult> {
        this.generateWeeklySummaryCalls.push(date);
        return {
            weekStartDate: '2099-01-05',
            weekEndDate: '2099-01-09',
            dailySummaries: [],
            htmlReportPath: '/tmp/weekly-summary.html',
            pdfReportPath: '/tmp/weekly-summary.pdf',
            totalCandidatesBoughtAtStart: 0,
            numberOfCandidatesSoldLong: 0,
            numberOfCandidatesBoughtShort: 0,
            totalCostOfBreakoutCandidatePurchases: 0,
            totalAmountOfCashAtStopLossRisk: 0,
            totalProfitLossToDate: 0,
        };
    }

    override async generateRunningSummaryOrbReports(
        anchorDate: Date,
    ): Promise<RunningSummaryOrbReportResult> {
        this.generateRunningSummaryCalls.push(anchorDate);
        return {
            startDate: '2099-01-01',
            endDate: '2099-01-10',
            dailySummaries: [],
            skippedDates: [],
            htmlReportPath: '/tmp/running-summary.html',
            pdfReportPath: '/tmp/running-summary.pdf',
            totalCandidatesBoughtAtStart: 0,
            numberOfCandidatesSoldLong: 0,
            numberOfCandidatesBoughtShort: 0,
            totalCostOfBreakoutCandidatePurchases: 0,
            totalAmountOfCashAtStopLossRisk: 0,
            totalProfitLossToDate: 0,
        };
    }
}

describe('service layer', () => {
    it('delegates trading cycle execution to injected runner', async () => {
        const client = new StubAlpacaClient();
        const runnerCalls: Array<{ client: AlpacaClient; sessionDate: string }> = [];
        const runner = async (runnerClient: AlpacaClient, sessionDate: string) => {
            runnerCalls.push({ client: runnerClient, sessionDate });
        };

        const service = new OrbService(client, runner);
        await service.runTradingCycle('2099-01-07');

        expect(runnerCalls).to.have.length(1);
        expect(runnerCalls[0].client).to.equal(client);
        expect(runnerCalls[0].sessionDate).to.equal('2099-01-07');
    });

    it('delegates daily report generation to AlpacaClient', async () => {
        const client = new StubAlpacaClient();
        const service = new OrbService(client, async () => { });

        const result = await service.generateDailyReport('2099-01-08', {
            usesHistoricData: true,
        });

        expect(client.generateOrbReportCalls).to.have.length(1);
        expect(client.generateOrbReportCalls[0]).to.deep.equal({
            sessionDate: '2099-01-08',
            options: { usesHistoricData: true },
        });
        expect(result.sessionDate).to.equal('2099-01-08');
    });

    it('delegates weekly summary generation to AlpacaClient', async () => {
        const client = new StubAlpacaClient();
        const service = new OrbService(client, async () => { });
        const anchorDate = new Date('2099-01-09T14:30:00Z');

        const result = await service.generateWeeklySummaryReport(anchorDate);

        expect(client.generateWeeklySummaryCalls).to.have.length(1);
        expect(client.generateWeeklySummaryCalls[0].toISOString()).to.equal(anchorDate.toISOString());
        expect(result.weekEndDate).to.equal('2099-01-09');
    });

    it('delegates running summary generation to AlpacaClient', async () => {
        const client = new StubAlpacaClient();
        const service = new OrbService(client, async () => { });
        const anchorDate = new Date('2099-01-01T14:30:00Z');

        const result = await service.generateRunningSummaryReport(anchorDate);

        expect(client.generateRunningSummaryCalls).to.have.length(1);
        expect(client.generateRunningSummaryCalls[0].toISOString()).to.equal(anchorDate.toISOString());
        expect(result.startDate).to.equal('2099-01-01');
    });
});
