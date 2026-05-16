import { expect } from 'chai';
import { describe, it } from 'mocha';
import fs from 'node:fs';
import path from 'node:path';
import { AlpacaClient } from '../src/alpaca';
import { runCycle } from '../src/app';
import { env, strategyConfig } from '../src/config';
import { logger } from '../src/logger';
import { Reports } from '../src/reports';
import { sleep, toNyParts } from '../src/time';

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

function removeIfExists(filePath: string) {
    if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
    }
}

describe('reporting tests', () => {
    it('can execute the entire strategy', async function () {
        this.timeout(300_000);
        const client = new AlpacaClient();
        const now = new Date();
        const nyNow = toNyParts(now, strategyConfig.sessionTimezone);
        const sessionDate = nyNow.date;
        const marketOpenMinutes = strategyConfig.sessionOpenHour * 60 + strategyConfig.sessionOpenMinute;
        const [closeHour, closeMinute] = strategyConfig.forceExitTimeHHMM.split(':').map(Number);
        const marketCloseMinutes = closeHour * 60 + closeMinute;
        const currentMinutes = nyNow.hour * 60 + nyNow.minute;
        const dayOfWeek = now.toLocaleString('en-US', {
            timeZone: strategyConfig.sessionTimezone,
            weekday: 'short',
        });
        const isWeekday = !['Sat', 'Sun'].includes(dayOfWeek);

        logger.info('Executing default current-day behavior in integration test', {
            sessionDate,
            currentTime: nyNow.hhmm,
            dayOfWeek,
        });

        if (!isWeekday || currentMinutes >= marketCloseMinutes) {
            // Market closed: generate report from current-day historical bars.
            try {
                const result = await client.generateOrbReport(sessionDate);
                expect(result.sessionDate).to.equal(sessionDate);
                expect(fs.existsSync(result.pdfReportPath)).to.be.true;
                return;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes('fewer than 30 session bars')) {
                    logger.warn('No session bars. Not a trading day.', {
                        sessionDate,
                        error: message,
                    });
                    return;
                }

                throw error;
            }
        }

        if (currentMinutes < marketOpenMinutes) {
            // Before market open: wait until open, then execute strategy logic.
            const waitMs = ((marketOpenMinutes - currentMinutes) * 60 * 1000) + 1_000;
            const maxWaitMs = 2 * 60 * 1000;

            if (waitMs > maxWaitMs) {
                logger.warn('Skipping long wait before market open in integration test', {
                    sessionDate,
                    currentTime: nyNow.hhmm,
                    waitMs,
                    maxWaitMs,
                });
                this.skip();
                return;
            }

            logger.info('Waiting for market open before executing runCycle', {
                sessionDate,
                waitMs,
            });
            await sleep(waitMs);
        }

        // Market open path: execute strategy logic using current-day data.
        await runCycle(client, sessionDate);
        const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
        expect(symbols.length).to.be.greaterThan(0);
    });

    it('verifying ORB pattern', async function () {
        this.timeout(150_000);
        const result = await new AlpacaClient().generateOrbReport('2026-05-14');

        expect(result.symbols.length).to.be.greaterThan(0);
        expect(result.evaluationRows.length).to.be.greaterThan(0);
        expect(result.totalCandidatesBoughtAtStart).to.equal(result.emulatedTrades.length);

        result.breakoutCandidates.forEach((candidate) => {
            if (candidate.side === 'buy') {
                expect(candidate.price).to.be.greaterThan(candidate.openingRangeHigh);
            } else {
                expect(candidate.price).to.be.lessThan(candidate.openingRangeLow);
            }
        });
    });

    it('runs for current day', async function () {
        this.timeout(170_000);

        const previousSessionDate = process.env.SESSION_DATE;
        delete process.env.SESSION_DATE;

        const sessionDate = toNyParts(new Date(), strategyConfig.sessionTimezone).date;
        const client = new AlpacaClient();
        logger.info('Testing current-day ORB run with SESSION_DATE unset', { sessionDate });

        try {
            let result;
            try {
                result = await client.generateOrbReport();
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (message.includes('fewer than 30 session bars')) {
                    logger.warn('Skipping current-day ORB run due to insufficient bars', {
                        sessionDate,
                        error: message,
                    });
                    this.skip();
                    return;
                }
                throw error;
            }

            expect(result.sessionDate).to.equal(sessionDate);
            expect(result.symbols.length).to.be.greaterThan(0);
            expect(result.evaluationRows.length).to.be.greaterThan(0);
            expect(result.pdfReportPath).to.include(sessionDate);
            expect(fs.existsSync(result.pdfReportPath)).to.be.true;

            logger.info('Current-day ORB run test passed', {
                sessionDate,
                pdfReportPath: result.pdfReportPath,
            });
        } finally {
            if (previousSessionDate != null) {
                process.env.SESSION_DATE = previousSessionDate;
            }
        }
    });

    it('respects SESSION_DATE set in environment variable', async function () {
        this.timeout(150_000);

        const existingSessionDate = process.env.SESSION_DATE;
        let injectedSessionDate: string | null = null;

        if (!existingSessionDate || existingSessionDate.trim() === '') {
            // Inject a known-good reporting date only when SESSION_DATE is not already set.
            injectedSessionDate = '2026-05-14';
            process.env.SESSION_DATE = injectedSessionDate;
        }

        const sessionDate = process.env.SESSION_DATE;
        expect(sessionDate).to.be.a('string').and.not.equal('');

        logger.info('Testing SESSION_DATE from process env', {
            sessionDate,
            wasInjected: injectedSessionDate != null,
        });

        try {
            const result = await new AlpacaClient().generateOrbReport(sessionDate!, {
                usesHistoricData: true,
            });

            expect(result.sessionDate).to.equal(sessionDate!);

            result.emulatedTrades.forEach((trade) => {
                if (trade.preBreakoutWickPrice != null) {
                    expect(trade.stopPrice).to.equal(trade.preBreakoutWickPrice);
                }

                const stopDistance =
                    trade.side === 'buy'
                        ? trade.price - trade.stopPrice
                        : trade.stopPrice - trade.price;
                const targetDistance =
                    trade.side === 'buy'
                        ? trade.takeProfitPrice - trade.price
                        : trade.price - trade.takeProfitPrice;

                expect(targetDistance).to.be.closeTo(stopDistance * env.takeProfitMultiple, 0.0001);
            });

            // Verify report path includes the target date.
            expect(result.pdfReportPath).to.include(sessionDate!);
            expect(result.htmlReportPath).to.include(sessionDate!);

            // Verify the PDF file was created.
            expect(fs.existsSync(result.pdfReportPath)).to.be.true;
            expect(fs.existsSync(result.htmlReportPath)).to.be.true;

            const htmlReport = fs.readFileSync(result.htmlReportPath, 'utf8');
            expect(htmlReport).to.include('<details class="candidate-card"');
            expect(htmlReport).to.include('Num of Shares Bought');
            expect(htmlReport).to.include('Previous Candle Hi/Lo');

            logger.info('SESSION_DATE env test passed', { sessionDate, pdfReportPath: result.pdfReportPath });
        } finally {
            if (injectedSessionDate != null) {
                delete process.env.SESSION_DATE;
            }
        }
    });

    it('verify continuous reporting over a week', async function () {
        this.timeout(900_000);

        const sourceSessionDate = process.env.SESSION_DATE?.trim() || env.sessionDate || '2026-05-14';
        const weekDates = weekDatesMondayToFriday(sourceSessionDate);
        const marketOpenTime = `${String(strategyConfig.sessionOpenHour).padStart(2, '0')}:${String(strategyConfig.sessionOpenMinute).padStart(2, '0')}`;
        const marketCloseTime = strategyConfig.forceExitTimeHHMM;
        const weekStart = weekDates[0];
        const weekEnd = weekDates[weekDates.length - 1];
        const client = new AlpacaClient();

        logger.info('Emulating continuous reporting over historical week', {
            sourceSessionDate,
            weekStart,
            weekEnd,
            startBoundary: `${weekStart}T${marketOpenTime}`,
            endBoundary: `${weekEnd}T${marketCloseTime}`,
            usesHistoricData: true,
        });

        const results = [];
        for (const sessionDate of weekDates) {
            const result = await client.generateOrbReport(sessionDate, {
                usesHistoricData: true,
            });
            results.push(result);
        }

        expect(results.map((result) => result.sessionDate)).to.deep.equal(weekDates);

        weekDates.forEach((sessionDate) => {
            const expectedHtmlReportPath = path.resolve(
                process.cwd(),
                'reports',
                'html',
                sessionDate,
                `orb-report-${sessionDate}.html`
            );
            const expectedPdfReportPath = path.resolve(
                process.cwd(),
                'reports',
                `orb-report-${sessionDate}.pdf`
            );

            expect(
                fs.existsSync(expectedHtmlReportPath),
                `Expected HTML report to exist for ${sessionDate}: ${expectedHtmlReportPath}`
            ).to.be.true;
            expect(
                fs.existsSync(expectedPdfReportPath),
                `Expected PDF report to exist for ${sessionDate}: ${expectedPdfReportPath}`
            ).to.be.true;
        });
    });

    it('generates weekly summary HTML and PDF reports', async function () {
        this.timeout(900_000);

        const anchorDate = new Date('2026-05-14T13:30:00Z');
        const expectedWeekEnding = '2026-05-15';
        const client = new AlpacaClient();

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
    });

    it('generates running summary HTML and PDF reports for NY market-open dates only', async function () {
        this.timeout(900_000);

        const anchorDate = new Date('2026-05-12T13:30:00Z');
        const todayNy = toNyParts(new Date(), strategyConfig.sessionTimezone).date;
        const expectedSessionDates = ['2026-05-12', '2026-05-13', '2026-05-14', '2026-05-15'];
        const client = new AlpacaClient();

        const result = await Reports.generateRunningSummaryOrbReports(client, anchorDate);

        expect(result.startDate).to.equal('2026-05-12');
        expect(result.endDate).to.equal(todayNy);
        expect(result.dailySummaries.map((day) => day.sessionDate).slice(0, expectedSessionDates.length))
            .to.deep.equal(expectedSessionDates);
        expect(result.skippedDates).to.include('2026-05-16');
        expect(result.htmlReportPath).to.include('running-summary-start-date-2026-05-12.html');
        expect(result.pdfReportPath).to.include('running-summary-start-date-2026-05-12.pdf');
        expect(fs.existsSync(result.htmlReportPath)).to.be.true;
        expect(fs.existsSync(result.pdfReportPath)).to.be.true;

        const html = fs.readFileSync(result.htmlReportPath, 'utf8');
        expect(html).to.include('Running ORB Summary');
        expect(html).to.include('Daily Summary Metrics');
        expect(html).to.include('Totals');
        expect(html).to.include('Included 4 NY market-open sessions');

        removeIfExists(result.htmlReportPath);
        removeIfExists(result.pdfReportPath);
    });

    it('generates running summary report starting at the beginning of May 2026', async function () {
        this.timeout(900_000);

        const anchorDate = new Date('2026-05-01T13:30:00Z');
        const todayNy = toNyParts(new Date(), strategyConfig.sessionTimezone).date;
        const expectedSessionDates = [
            '2026-05-01',
            '2026-05-04',
            '2026-05-05',
            '2026-05-06',
            '2026-05-07',
            '2026-05-08',
        ];
        const client = new AlpacaClient();

        let result;
        try {
            result = await Reports.generateRunningSummaryOrbReports(client, anchorDate);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes('too many requests')) {
                this.skip();
                return;
            }

            throw error;
        }

        expect(result.startDate).to.equal('2026-05-01');
        expect(result.endDate).to.equal(todayNy);
        expect(result.dailySummaries.map((day) => day.sessionDate).slice(0, expectedSessionDates.length))
            .to.deep.equal(expectedSessionDates);
        expect(result.skippedDates).to.include('2026-05-02');
        expect(result.skippedDates).to.include('2026-05-03');
        expect(result.skippedDates).to.include('2026-05-09');
        expect(result.htmlReportPath).to.include('running-summary-start-date-2026-05-01.html');
        expect(result.pdfReportPath).to.include('running-summary-start-date-2026-05-01.pdf');
        expect(fs.existsSync(result.htmlReportPath)).to.be.true;
        expect(fs.existsSync(result.pdfReportPath)).to.be.true;

        const html = fs.readFileSync(result.htmlReportPath, 'utf8');
        expect(html).to.include('Running ORB Summary');
        expect(html).to.include(`Date range: 2026-05-01 through ${todayNy}`);
    });
});
