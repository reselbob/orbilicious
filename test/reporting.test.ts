import { expect } from 'chai';
import { describe, it } from 'mocha';
import fs from 'node:fs';
import { AlpacaClient } from '../src/alpaca';
import { Reports } from '../src/reports';
import { env, strategyConfig } from '../src/config';
import { toNyParts } from '../src/time';
import type { Bar } from '../src/types';

function removeIfExists(filePath: string) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

function makeTimestamp(sessionDate: string, hourEt: number, minuteEt: number) {
    const [year, month, day] = sessionDate.split('-').map(Number);
    const utcHour = hourEt + 4;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(utcHour).padStart(2, '0')}:${String(minuteEt).padStart(2, '0')}:00Z`;
}

function makeDeterministicSessionBars(symbol: string, sessionDate: string): Bar[] {
    const bars: Bar[] = [];

    // Opening-range bars (9:30-9:44 ET): stable range high/low.
    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
        });
    }

    // Evaluation window bars (9:45-9:59 ET): breakout at 9:45 then drift.
    for (let minute = 45; minute <= 59; minute++) {
        if (minute === 45) {
            bars.push({
                symbol,
                timestamp: makeTimestamp(sessionDate, 9, minute),
                open: 100.8,
                high: 103,
                low: 100.4,
                close: 102,
                volume: 5000,
            });
            continue;
        }

        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 101.4,
            high: 102,
            low: 101.1,
            close: 101.6,
            volume: 2400,
        });
    }

    // Confirmation retest bar after breakout.
    bars.push({
        symbol,
        timestamp: makeTimestamp(sessionDate, 10, 0),
        open: 101.7,
        high: 102.2,
        low: 100.9,
        close: 101.5,
        volume: 2600,
    });

    return bars;
}

function makeDeterministicShortSessionBars(symbol: string, sessionDate: string): Bar[] {
    const bars: Bar[] = [];

    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
        });
    }

    for (let minute = 45; minute <= 59; minute++) {
        if (minute === 45) {
            bars.push({
                symbol,
                timestamp: makeTimestamp(sessionDate, 9, minute),
                open: 99.2,
                high: 99.6,
                low: 97.8,
                close: 98.4,
                volume: 5000,
            });
            continue;
        }

        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 98.8,
            high: 99.2,
            low: 98.1,
            close: 98.5,
            volume: 2400,
        });
    }

    bars.push({
        symbol,
        timestamp: makeTimestamp(sessionDate, 10, 0),
        open: 98.7,
        high: 99.1,
        low: 98.2,
        close: 98.4,
        volume: 2600,
    });

    return bars;
}

function makeOneMinuteSpikeOnlyBars(symbol: string, sessionDate: string): Bar[] {
    return [
        ...Array.from({ length: 15 }, (_, index) => {
            const minute = 30 + index;
            return {
                symbol,
                timestamp: makeTimestamp(sessionDate, 9, minute),
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            };
        }),
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 45),
            open: 100.9,
            high: 103,
            low: 100.4,
            close: 102,
            volume: 4500,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 46),
            open: 101.2,
            high: 101.6,
            low: 100.8,
            close: 101.2,
            volume: 3300,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 47),
            open: 101.1,
            high: 101.2,
            low: 100.3,
            close: 100.8,
            volume: 2900,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 48),
            open: 100.9,
            high: 101,
            low: 100.2,
            close: 100.7,
            volume: 2800,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 49),
            open: 100.8,
            high: 100.95,
            low: 100.1,
            close: 100.6,
            volume: 2700,
        },
    ];
}

function makeWeakRelativeStrengthBars(symbol: string, sessionDate: string): Bar[] {
    return [
        ...Array.from({ length: 15 }, (_, index) => {
            const minute = 30 + index;
            return {
                symbol,
                timestamp: makeTimestamp(sessionDate, 9, minute),
                open: 100,
                high: 101,
                low: 99,
                close: 100,
                volume: 1000,
            };
        }),
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 45),
            open: 100.9,
            high: 101.2,
            low: 100.6,
            close: 101.03,
            volume: 4200,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 46),
            open: 101.01,
            high: 101.12,
            low: 100.95,
            close: 101.02,
            volume: 3800,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 47),
            open: 101,
            high: 101.1,
            low: 100.9,
            close: 101.01,
            volume: 3600,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 48),
            open: 101.01,
            high: 101.08,
            low: 100.92,
            close: 101.0,
            volume: 3400,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 49),
            open: 101.0,
            high: 101.07,
            low: 100.9,
            close: 101.01,
            volume: 3300,
        },
    ];
}

function weekDatesMondayToFriday(sessionDate: string): string[] {
    const [year, month, day] = sessionDate.split('-').map((part) => Number(part));
    if (!year || !month || !day) {
        throw new Error(`Invalid sessionDate format: ${sessionDate}. Expected YYYY-MM-DD`);
    }

    const anchor = new Date(Date.UTC(year, month - 1, day));
    const mondayOffset = (anchor.getUTCDay() + 6) % 7;
    const monday = new Date(anchor);
    monday.setUTCDate(anchor.getUTCDate() - mondayOffset);

    return Array.from({ length: 5 }, (_, index) => {
        const current = new Date(monday);
        current.setUTCDate(monday.getUTCDate() + index);
        const currentYear = current.getUTCFullYear();
        const currentMonth = String(current.getUTCMonth() + 1).padStart(2, '0');
        const currentDay = String(current.getUTCDate()).padStart(2, '0');
        return `${currentYear}-${currentMonth}-${currentDay}`;
    });
}

class DeterministicAlpacaClient extends AlpacaClient {
    private readonly deterministicUniverse = ['SPY', 'QQQ'];

    override async getMostActiveSymbols(limit = 40): Promise<string[]> {
        return this.deterministicUniverse.slice(0, Math.max(1, limit));
    }

    override async getIntradayBars(symbol: string, sessionDate: string): Promise<Bar[]> {
        return makeDeterministicSessionBars(symbol, sessionDate);
    }
}

class MixedDirectionDeterministicClient extends AlpacaClient {
    override async getMostActiveSymbols(): Promise<string[]> {
        return ['LONG_A', 'SHORT_A'];
    }

    override async getIntradayBars(symbol: string, sessionDate: string): Promise<Bar[]> {
        if (symbol === 'SHORT_A') {
            return makeDeterministicShortSessionBars(symbol, sessionDate);
        }
        return makeDeterministicSessionBars(symbol, sessionDate);
    }
}

class QualityFilterDeterministicClient extends AlpacaClient {
    override async getMostActiveSymbols(): Promise<string[]> {
        return ['SPIKE_ONLY', 'WEAK_RS', 'CONFIRMED'];
    }

    override async getIntradayBars(symbol: string, sessionDate: string): Promise<Bar[]> {
        if (symbol === 'SPIKE_ONLY') {
            return makeOneMinuteSpikeOnlyBars(symbol, sessionDate);
        }
        if (symbol === 'WEAK_RS') {
            return makeWeakRelativeStrengthBars(symbol, sessionDate);
        }
        return makeDeterministicSessionBars(symbol, sessionDate);
    }
}

describe('reporting tests', () => {
    it('verifying ORB pattern with deterministic fixtures', async function () {
        this.timeout(120_000);
        const client = new DeterministicAlpacaClient();
        const result = await client.generateOrbReport('2026-05-14', { usesHistoricData: true });

        expect(result.sessionDate).to.equal('2026-05-14');
        expect(result.symbols.length).to.be.greaterThan(0);
        expect(result.evaluationRows.length).to.be.greaterThan(0);
        expect(result.totalCandidatesBoughtAtStart).to.equal(result.breakoutCandidates.length);
        expect(result.breakoutCandidates.length).to.be.greaterThan(0);

        result.breakoutCandidates.forEach((candidate) => {
            if (candidate.side === 'buy') {
                expect(candidate.price).to.be.greaterThan(candidate.openingRangeHigh);
            } else {
                expect(candidate.price).to.be.lessThan(candidate.openingRangeLow);
            }
        });

        expect(fs.existsSync(result.pdfReportPath)).to.be.true;
        expect(fs.existsSync(result.htmlReportPath)).to.be.true;

        removeIfExists(result.pdfReportPath);
        removeIfExists(result.htmlReportPath);
    });

    it('respects SESSION_DATE and includes candidate details in generated HTML', async function () {
        this.timeout(120_000);
        const client = new DeterministicAlpacaClient();
        const sessionDate = '2026-05-14';

        const result = await client.generateOrbReport(sessionDate, {
            usesHistoricData: true,
        });

        expect(result.sessionDate).to.equal(sessionDate);
        expect(result.pdfReportPath).to.include(sessionDate);
        expect(result.htmlReportPath).to.include(sessionDate);

        const htmlReport = fs.readFileSync(result.htmlReportPath, 'utf8');
        expect(htmlReport).to.include('<details class="candidate-card"');
        expect(htmlReport).to.include('Num of Shares Bought');
        expect(htmlReport).to.include('Previous Candle Hi/Lo');
        expect(htmlReport).to.include('candidate-chart-svg');
        expect(htmlReport).to.include('Blue line plots close prices after determination.');

        removeIfExists(result.pdfReportPath);
        removeIfExists(result.htmlReportPath);
    });

    it('filters historical report trades by CANDIDATE_TRADE_TYPE', async function () {
        this.timeout(120_000);
        (Reports as unknown as { fixedUniverseSymbols: string[] | null }).fixedUniverseSymbols = ['LONG_A', 'SHORT_A'];
        const client = new MixedDirectionDeterministicClient();
        const previousTradeType = env.candidateTradeType;

        try {
            env.candidateTradeType = 'LONG';
            const longOnly = await client.generateOrbReport('2026-05-14', { usesHistoricData: true });
            expect(longOnly.emulatedTrades.length).to.be.greaterThan(0);
            expect(longOnly.emulatedTrades.every((trade) => trade.side === 'buy')).to.equal(true);
            removeIfExists(longOnly.pdfReportPath);
            removeIfExists(longOnly.htmlReportPath);

            env.candidateTradeType = 'SHORT';
            const shortOnly = await client.generateOrbReport('2026-05-14', { usesHistoricData: true });
            expect(shortOnly.emulatedTrades.length).to.be.greaterThan(0);
            expect(shortOnly.emulatedTrades.every((trade) => trade.side === 'sell')).to.equal(true);
            removeIfExists(shortOnly.pdfReportPath);
            removeIfExists(shortOnly.htmlReportPath);
        } finally {
            env.candidateTradeType = previousTradeType;
        }
    });

    it('applies 5-minute close confirmation and quality filters in historical reports', async function () {
        this.timeout(120_000);
        (Reports as unknown as { fixedUniverseSymbols: string[] | null }).fixedUniverseSymbols = ['SPIKE_ONLY', 'WEAK_RS', 'CONFIRMED'];
        const client = new QualityFilterDeterministicClient();
        const previousSettings = {
            breakoutConfirmationCandleMinutes: env.breakoutConfirmationCandleMinutes,
            breakoutQualityFiltersEnabled: env.breakoutQualityFiltersEnabled,
            breakoutMinVolumeExpansion: env.breakoutMinVolumeExpansion,
            breakoutMinRelativeStrengthPct: env.breakoutMinRelativeStrengthPct,
            breakoutTrendTimeframeMinutes: env.breakoutTrendTimeframeMinutes,
            breakoutTrendLookbackBars: env.breakoutTrendLookbackBars,
        };

        try {
            env.breakoutConfirmationCandleMinutes = 5;
            env.breakoutQualityFiltersEnabled = true;
            env.breakoutMinVolumeExpansion = 1.1;
            env.breakoutMinRelativeStrengthPct = 0.25;
            env.breakoutTrendTimeframeMinutes = 5;
            env.breakoutTrendLookbackBars = 3;

            const report = await client.generateOrbReport('2026-05-14', { usesHistoricData: true });
            expect(report.breakoutCandidates.map((candidate) => candidate.symbol)).to.deep.equal(['CONFIRMED']);
            expect(report.emulatedTrades.map((trade) => trade.symbol)).to.deep.equal(['CONFIRMED']);
            removeIfExists(report.pdfReportPath);
            removeIfExists(report.htmlReportPath);
        } finally {
            env.breakoutConfirmationCandleMinutes = previousSettings.breakoutConfirmationCandleMinutes;
            env.breakoutQualityFiltersEnabled = previousSettings.breakoutQualityFiltersEnabled;
            env.breakoutMinVolumeExpansion = previousSettings.breakoutMinVolumeExpansion;
            env.breakoutMinRelativeStrengthPct = previousSettings.breakoutMinRelativeStrengthPct;
            env.breakoutTrendTimeframeMinutes = previousSettings.breakoutTrendTimeframeMinutes;
            env.breakoutTrendLookbackBars = previousSettings.breakoutTrendLookbackBars;
        }
    });

    it('verify continuous reporting over a deterministic historical week', async function () {
        this.timeout(300_000);

        const weekDates = weekDatesMondayToFriday('2026-05-14');
        const client = new DeterministicAlpacaClient();

        const results = [];
        for (const sessionDate of weekDates) {
            const result = await client.generateOrbReport(sessionDate, {
                usesHistoricData: true,
            });
            results.push(result);
        }

        expect(results.map((result) => result.sessionDate)).to.deep.equal(weekDates);

        results.forEach((result) => {
            expect(fs.existsSync(result.htmlReportPath)).to.be.true;
            expect(fs.existsSync(result.pdfReportPath)).to.be.true;
            removeIfExists(result.htmlReportPath);
            removeIfExists(result.pdfReportPath);
        });
    });

    it('generates weekly summary HTML and PDF reports deterministically', async function () {
        this.timeout(300_000);

        const anchorDate = new Date('2026-05-14T13:30:00Z');
        const expectedWeekEnding = '2026-05-15';
        const client = new DeterministicAlpacaClient();

        const result = await client.generateWeeklySummaryOrbReports(anchorDate);

        expect(result.weekEndDate).to.equal(expectedWeekEnding);
        expect(result.dailySummaries.length).to.equal(5);
        expect(result.htmlReportPath).to.include(`summary-for-week-ending-${expectedWeekEnding}.html`);
        expect(result.pdfReportPath).to.include(`summary-for-week-ending-${expectedWeekEnding}.pdf`);
        expect(fs.existsSync(result.htmlReportPath)).to.be.true;
        expect(fs.existsSync(result.pdfReportPath)).to.be.true;

        const html = fs.readFileSync(result.htmlReportPath, 'utf8');
        expect(html).to.include('Weekly ORB Summary');
        expect(html).to.include('Daily Summary Metrics');
        expect(html).to.include('Week Totals');

        removeIfExists(result.htmlReportPath);
        removeIfExists(result.pdfReportPath);
    });

    it('generates running summary HTML and PDF reports for NY market-open dates only', async function () {
        this.timeout(300_000);

        const anchorDate = new Date('2026-05-12T13:30:00Z');
        const todayNy = toNyParts(new Date(), strategyConfig.sessionTimezone).date;
        const client = new DeterministicAlpacaClient();

        const result = await Reports.generateRunningSummaryOrbReports(client, anchorDate);

        expect(result.startDate).to.equal('2026-05-12');
        expect(result.endDate).to.equal(todayNy);
        expect(result.dailySummaries.map((day) => day.sessionDate)).to.include('2026-05-12');
        expect(result.dailySummaries.map((day) => day.sessionDate)).to.include('2026-05-13');
        expect(result.dailySummaries.map((day) => day.sessionDate)).to.include('2026-05-14');
        expect(result.dailySummaries.map((day) => day.sessionDate)).to.include('2026-05-15');
        expect(result.skippedDates).to.include('2026-05-16');
        expect(result.skippedDates).to.include('2026-05-17');
        expect(result.htmlReportPath).to.include('running-summary-start-date-2026-05-12.html');
        expect(result.pdfReportPath).to.include('running-summary-start-date-2026-05-12.pdf');
        expect(fs.existsSync(result.htmlReportPath)).to.be.true;
        expect(fs.existsSync(result.pdfReportPath)).to.be.true;

        const html = fs.readFileSync(result.htmlReportPath, 'utf8');
        expect(html).to.include('Running ORB Summary');
        expect(html).to.include('Daily Summary Metrics');
        expect(html).to.include('Totals');

        removeIfExists(result.htmlReportPath);
        removeIfExists(result.pdfReportPath);
    });
});
