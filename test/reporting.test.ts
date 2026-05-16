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

        const previousRunDate = process.env.RUN_DATE;
        delete process.env.RUN_DATE;

        const sessionDate = toNyParts(new Date(), strategyConfig.sessionTimezone).date;
        const client = new AlpacaClient();
        logger.info('Testing current-day ORB run with RUN_DATE unset', { sessionDate });

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
            if (previousRunDate != null) {
                process.env.RUN_DATE = previousRunDate;
            }
        }
    });

    it('respects RUN_DATE set in environment variable', async function () {
        this.timeout(150_000);

        const existingRunDate = process.env.RUN_DATE;
        let injectedRunDate: string | null = null;

        if (!existingRunDate || existingRunDate.trim() === '') {
            // Inject a known-good reporting date only when RUN_DATE is not already set.
            injectedRunDate = '2026-05-14';
            process.env.RUN_DATE = injectedRunDate;
        }

        const runDate = process.env.RUN_DATE;
        expect(runDate).to.be.a('string').and.not.equal('');

        logger.info('Testing RUN_DATE from process env', {
            runDate,
            wasInjected: injectedRunDate != null,
        });

        try {
            const result = await new AlpacaClient().generateOrbReport(runDate!, {
                usesHistoricData: true,
            });

            expect(result.sessionDate).to.equal(runDate!);

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
            expect(result.pdfReportPath).to.include(runDate!);

            // Verify the PDF file was created.
            expect(fs.existsSync(result.pdfReportPath)).to.be.true;

            logger.info('RUN_DATE env test passed', { runDate, pdfReportPath: result.pdfReportPath });
        } finally {
            if (injectedRunDate != null) {
                delete process.env.RUN_DATE;
            }
        }
    });
});
