import { expect } from 'chai';
import { describe, it } from 'mocha';
import fs from 'node:fs';
import { AlpacaClient } from '../src/alpaca';
import { runCycle } from '../src/app';
import { env, strategyConfig } from '../src/config';
import { logger } from '../src/logger';
import { sleep, toNyParts } from '../src/time';

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
});
