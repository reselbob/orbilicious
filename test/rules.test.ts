import { expect } from 'chai';
import { afterEach, describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import {
    executeSizedTrades,
    findBreakoutCandidates,
    runCycle,
    startApp,
} from '../src/app';
import {
    MIN_SCORE,
    buildWeightedRiskTrades,
    normalizeTradesToConstraints,
    rankAndSelectCandidates,
} from '../src/basket';
import { env, strategyConfig } from '../src/config';
import { logger } from '../src/logger';
import type { OrbReportResult } from '../src/reports';
import type { Bar, Position } from '../src/types';

type RestoreFn = () => void;

const envSnapshot = { ...env };
const strategySnapshot = { ...strategyConfig };
let restores: RestoreFn[] = [];

function registerRestore(fn: RestoreFn) {
    restores.push(fn);
}

function stubProperty<T extends object, K extends keyof T>(target: T, key: K, replacement: T[K]) {
    const original = target[key];
    (target as T)[key] = replacement;
    registerRestore(() => {
        (target as T)[key] = original;
    });
}

function captureStdout() {
    const writes: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    stubProperty(process.stdout as unknown as { write: typeof process.stdout.write }, 'write', ((chunk: unknown, ...args: unknown[]) => {
        writes.push(String(chunk));
        return originalWrite(chunk as never, ...(args as never[]));
    }) as typeof process.stdout.write);
    return writes;
}

function captureLogMessages() {
    const infoMessages: string[] = [];
    const warnMessages: string[] = [];

    stubProperty(logger as unknown as { info: typeof logger.info }, 'info', ((message: unknown) => {
        infoMessages.push(String(message));
        return logger;
    }) as typeof logger.info);

    stubProperty(logger as unknown as { warn: typeof logger.warn }, 'warn', ((message: unknown) => {
        warnMessages.push(String(message));
        return logger;
    }) as typeof logger.warn);

    return { infoMessages, warnMessages };
}

function withMockDateSequence(isoValues: string[]) {
    const RealDate = Date;
    let index = 0;
    const nextIso = () => isoValues[Math.min(index++, isoValues.length - 1)];

    class MockDate extends RealDate {
        constructor(...args: any[]) {
            if (args.length === 0) {
                super(nextIso());
                return;
            }
            if (args.length === 1) {
                super(args[0]);
                return;
            }
            if (args.length === 2) {
                super(args[0], args[1]);
                return;
            }
            if (args.length === 3) {
                super(args[0], args[1], args[2]);
                return;
            }
            if (args.length === 4) {
                super(args[0], args[1], args[2], args[3]);
                return;
            }
            if (args.length === 5) {
                super(args[0], args[1], args[2], args[3], args[4]);
                return;
            }
            if (args.length === 6) {
                super(args[0], args[1], args[2], args[3], args[4], args[5]);
                return;
            }
            super(args[0], args[1], args[2], args[3], args[4], args[5], args[6]);
        }

        static now() {
            return new RealDate(nextIso()).getTime();
        }

        static parse = RealDate.parse;
        static UTC = RealDate.UTC;
    }

    (globalThis as unknown as { Date: DateConstructor }).Date = MockDate as unknown as DateConstructor;
    registerRestore(() => {
        (globalThis as unknown as { Date: DateConstructor }).Date = RealDate;
    });
}

function clearConfigModuleCache() {
    delete require.cache[require.resolve('../src/config')];
}

function withBaseProcessEnv() {
    process.env.APCA_API_KEY_ID = 'key';
    process.env.APCA_API_SECRET_KEY = 'secret';
    process.env.ALLOW_LONG = 'true';
    process.env.ALLOW_SHORT = 'true';
    process.env.ALPACA_DATA_BASE_URL = 'https://data.alpaca.markets';
    process.env.ALPACA_DATA_FEED = 'iex';
    process.env.OPENING_RANGE_MINUTES = '15';
    process.env.CANDLE_MINUTES = '1';
    process.env.FORCE_EXIT_TIME = '15:55';
    process.env.MAX_TOTAL_RISK = '1000';
    process.env.HARD_BASKET_CAP = '25000';
    process.env.MAX_POSITION_NOTIONAL = '5000';
    process.env.MAX_POSITIONS_PER_SIDE = '3';
    process.env.MIN_STOP_PCT = '0.0075';
    process.env.ATR_STOP_MULTIPLE = '1';
    process.env.QUANTITY_TO_RETRIEVE = '40';
    process.env.STOP_LOSS_PROFIT_RATIO = '1:4';
}

function makeTimestamp(sessionDate: string, hourEt: number, minuteEt: number) {
    const [year, month, day] = sessionDate.split('-').map(Number);
    const utcHour = hourEt + 4;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(utcHour).padStart(2, '0')}:${String(minuteEt).padStart(2, '0')}:00Z`;
}

function makeOpeningRangeBars(symbol: string, sessionDate: string, openingHigh = 101, openingLow = 99): Bar[] {
    const bars: Bar[] = [];
    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 100,
            high: openingHigh,
            low: openingLow,
            close: 100,
            volume: 1000,
        });
    }
    return bars;
}

function makeConfirmedLongCandidateBars(symbol: string, sessionDate: string): Bar[] {
    return [
        ...makeOpeningRangeBars(symbol, sessionDate),
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 45),
            open: 101,
            high: 103,
            low: 100.4,
            close: 102,
            volume: 5000,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 46),
            open: 101.4,
            high: 102.1,
            low: 100.8,
            close: 101.5,
            volume: 4500,
        },
    ];
}

function makeConfirmedShortCandidateBars(symbol: string, sessionDate: string): Bar[] {
    return [
        ...makeOpeningRangeBars(symbol, sessionDate),
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 45),
            open: 99,
            high: 99.2,
            low: 97.8,
            close: 98,
            volume: 5000,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 46),
            open: 98.7,
            high: 99.1,
            low: 98.2,
            close: 98.5,
            volume: 4500,
        },
    ];
}

function makeLateBreakoutBars(symbol: string, sessionDate: string): Bar[] {
    const bars = makeOpeningRangeBars(symbol, sessionDate);
    for (let minute = 45; minute <= 59; minute++) {
        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 100,
            high: 100.8,
            low: 99.2,
            close: 100,
            volume: 1100,
        });
    }
    bars.push({
        symbol,
        timestamp: makeTimestamp(sessionDate, 10, 0),
        open: 101,
        high: 103,
        low: 100.5,
        close: 102,
        volume: 5000,
    });
    return bars;
}

function makeNoRetestBars(symbol: string, sessionDate: string): Bar[] {
    return [
        ...makeOpeningRangeBars(symbol, sessionDate),
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 45),
            open: 101,
            high: 103,
            low: 101.1,
            close: 102,
            volume: 5000,
        },
        {
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, 46),
            open: 102,
            high: 103,
            low: 101.2,
            close: 102.5,
            volume: 4000,
        },
    ];
}

function makeHistoricalReport(sessionDate: string): OrbReportResult {
    return {
        sessionDate,
        symbols: ['SPY'],
        evaluationRows: [{
            symbol: 'SPY',
            openingPrice: 100,
            openingRangeHigh: 101,
            openingRangeLow: 99,
            breakoutPrice: 102,
            breakoutTimestamp: makeTimestamp(sessionDate, 9, 45),
            confirmationRetestPrice: 101.5,
            confirmationRetestTimestamp: makeTimestamp(sessionDate, 9, 46),
            atr1m: 1,
            side: 'buy',
        }],
        breakoutCandidates: [],
        emulatedTrades: [{
            symbol: 'SPY',
            side: 'buy',
            price: 101.5,
            reason: 'historical breakout',
            score: 5,
            relativeBreakPct: 1.5,
            totalVolume: 20000,
            openingRangeHigh: 101,
            openingRangeLow: 99,
            assignedRiskDollars: 100,
            stopPrice: 100.5,
            stopDistancePerShare: 1,
            takeProfitPrice: 105.5,
            qty: 2,
            plannedRiskDollars: 2,
            estimatedNotional: 203,
        }],
        finalOutcomes: [{
            symbol: 'SPY',
            side: 'buy',
            entryPrice: 101.5,
            stopPrice: 100.5,
            takeProfitPrice: 105.5,
            qty: 2,
            status: 'profit',
            exitPrice: 105.5,
            exitTimestamp: makeTimestamp(sessionDate, 10, 15),
            pnl: 8,
        }],
        htmlReportPath: `/tmp/${sessionDate}.html`,
        pdfReportPath: `/tmp/${sessionDate}.pdf`,
        maxSessionBars: 30,
        insufficientSymbols: [],
        totalCandidatesBoughtAtStart: 1,
        numberOfCandidatesSoldLong: 1,
        numberOfCandidatesBoughtShort: 0,
        totalCostOfBreakoutCandidatePurchases: 203,
        totalAmountOfCashAtStopLossRisk: 2,
        totalProfitLossToDate: 8,
    };
}

afterEach(() => {
    Object.assign(env, envSnapshot);
    Object.assign(strategyConfig, strategySnapshot);
    restores.reverse().forEach((restore) => restore());
    restores = [];
});

describe('Operational Rules support', () => {
    it('rules 1-2: validates environment configuration and derives execution mode settings', () => {
        const originalProcessEnv = { ...process.env };
        registerRestore(() => {
            process.env = originalProcessEnv;
        });

        withBaseProcessEnv();
        process.env.SESSION_MODE = 'PAPER';
        process.env.SESSION_DATE = '2026-5-4';
        clearConfigModuleCache();
        let mod = require('../src/config');

        expect(mod.env.sessionMode).to.equal('PAPER');
        expect(mod.env.dryRun).to.equal(false);
        expect(mod.env.sessionDate).to.equal('2026-05-04');
        expect(mod.env.tradingBaseUrl).to.equal('https://paper-api.alpaca.markets');

        withBaseProcessEnv();
        process.env.SESSION_MODE = 'LIVE';
        delete process.env.ALPACA_TRADING_BASE_URL;
        clearConfigModuleCache();
        mod = require('../src/config');
        expect(mod.env.dryRun).to.equal(false);
        expect(mod.env.tradingBaseUrl).to.equal('https://api.alpaca.markets');

        withBaseProcessEnv();
        process.env.STOP_LOSS_PROFIT_RATIO = 'bad';
        clearConfigModuleCache();
        expect(() => require('../src/config')).to.throw('Invalid ratio');

        withBaseProcessEnv();
        process.env.SESSION_MODE = 'INVALID';
        clearConfigModuleCache();
        expect(() => require('../src/config')).to.throw('Invalid session mode');
    });

    it('rules 3-6 and 31: historical emulation filters weekdays, emits progress UI messages, skips failures, and reports closes', async () => {
        env.sessionMode = 'EMULATION';
        env.sessionDate = '2026-05-14';
        env.dryRun = true;
        env.quantityToRetrieve = 2;

        withMockDateSequence([
            '2026-05-17T16:00:00Z',
            '2026-05-17T16:00:00Z',
            '2026-05-17T16:00:00Z',
            '2026-05-17T16:00:00Z',
        ]);

        const writes = captureStdout();
        const generatedDates: string[] = [];

        stubProperty(AlpacaClient.prototype, 'getIntradayBars', (async function (_symbol: string, sessionDate: string) {
            return makeConfirmedLongCandidateBars('SPY', sessionDate);
        }) as typeof AlpacaClient.prototype.getIntradayBars);
        stubProperty(AlpacaClient.prototype, 'getMostActiveSymbols', (async function () {
            return ['SPY', 'AAPL'];
        }) as typeof AlpacaClient.prototype.getMostActiveSymbols);
        stubProperty(AlpacaClient.prototype, 'generateOrbReport', (async function (sessionDate?: string | Date) {
            const normalized = typeof sessionDate === 'string' ? sessionDate : 'unknown';
            generatedDates.push(normalized);
            if (normalized === '2026-05-15') {
                throw new Error('missing data');
            }
            return makeHistoricalReport(normalized);
        }) as typeof AlpacaClient.prototype.generateOrbReport);

        await startApp();

        const output = writes.join('');
        expect(generatedDates).to.deep.equal(['2026-05-14', '2026-05-15']);
        expect(output).to.include('__UI_STATUS__Determing open ranage.');
        expect(output).to.include('__UI_STATUS__High range prices: 101.00, Low range prices: 99.00.');
        expect(output).to.include('__UI_STATUS__Waiting for breakouts. Breakout candidate symbols: SPY, AAPL');
        expect(output).to.include('__UI_STATUS__Closing SPY for a profit of $8.00.');
        expect(output.indexOf('__UI_STATUS__Closing SPY for a profit of $8.00.')).to.be.lessThan(output.indexOf('"eventType":"close"'));
    });

    it('rules 7 and 32: current-day scheduling waits before open and exits after generating one end-of-day report', async () => {
        env.sessionMode = 'PAPER';
        env.sessionDate = '';
        env.dryRun = false;
        env.pollIntervalSeconds = 0;

        withMockDateSequence([
            '2026-05-18T12:55:00Z',
            '2026-05-18T12:55:00Z',
            '2026-05-18T12:55:00Z',
            '2026-05-18T20:05:00Z',
            '2026-05-18T20:05:00Z',
            '2026-05-18T20:05:00Z',
        ]);

        const { infoMessages } = captureLogMessages();
        const reportedSessions: string[] = [];

        stubProperty(AlpacaClient.prototype, 'generateOrbReport', (async function (sessionDate?: string | Date) {
            reportedSessions.push(String(sessionDate));
            return makeHistoricalReport(String(sessionDate));
        }) as typeof AlpacaClient.prototype.generateOrbReport);

        await startApp();

        expect(infoMessages).to.include('Waiting for market open');
        expect(infoMessages).to.include('Current-day mode complete after market close; exiting app');
        expect(reportedSessions).to.deep.equal(['2026-05-18']);
    });

    it('rules 8-9: current-day mode emits opening-range and waiting-for-breakouts UI messages after the OR window completes', async () => {
        env.sessionMode = 'PAPER';
        env.sessionDate = '';
        env.dryRun = false;
        env.pollIntervalSeconds = 0;

        withMockDateSequence([
            ...Array.from({ length: 20 }, () => '2026-05-19T13:46:00Z'),
            ...Array.from({ length: 20 }, () => '2026-05-19T20:05:00Z'),
        ]);

        const writes = captureStdout();

        stubProperty(AlpacaClient.prototype, 'getAccount', (async function () {
            return { buyingPower: 25000, tradingBlocked: true };
        }) as typeof AlpacaClient.prototype.getAccount);
        stubProperty(AlpacaClient.prototype, 'getIntradayBars', (async function (_symbol: string, sessionDate: string) {
            return makeConfirmedLongCandidateBars('SPY', sessionDate);
        }) as typeof AlpacaClient.prototype.getIntradayBars);
        stubProperty(AlpacaClient.prototype, 'getMostActiveSymbols', (async function () {
            return ['SPY', 'QQQ'];
        }) as typeof AlpacaClient.prototype.getMostActiveSymbols);
        stubProperty(AlpacaClient.prototype, 'generateOrbReport', (async function (sessionDate?: string | Date) {
            return makeHistoricalReport(String(sessionDate));
        }) as typeof AlpacaClient.prototype.generateOrbReport);

        await startApp();

        const output = writes.join('');
        expect(output).to.include('__UI_STATUS__Determing open ranage.');
        expect(output).to.include('__UI_STATUS__High range prices: 101.00, Low range prices: 99.00.');
        expect(output).to.include('__UI_STATUS__Waiting for breakouts. Breakout candidate symbols: SPY, QQQ');
    });

    it('rules 10-16: runCycle halts on trading block, and candidate evaluation handles positions, duplicates, and missing bars', async () => {
        class TradingBlockedClient extends AlpacaClient {
            mostActiveCalls = 0;

            async getAccount() {
                return { buyingPower: 25000, tradingBlocked: true };
            }

            async getMostActiveSymbols() {
                this.mostActiveCalls += 1;
                return ['BLOCKED'];
            }
        }

        const blockedClient = new TradingBlockedClient();
        await runCycle(blockedClient, '2026-05-18');
        expect(blockedClient.mostActiveCalls).to.equal(0);

        class EvaluationClient extends AlpacaClient {
            closedSymbols: string[] = [];
            requestedLimit: number | undefined;

            async getMostActiveSymbols(limit = 40) {
                this.requestedLimit = limit;
                return ['HAS_POSITION', 'MISSING_BARS', 'READY'];
            }

            async getOpenPosition(symbol: string): Promise<Position | null> {
                if (symbol === 'HAS_POSITION') {
                    return { symbol, side: 'long', qty: 2, entryPrice: 100 };
                }
                return null;
            }

            async getIntradayBars(symbol: string, sessionDate: string) {
                if (symbol === 'HAS_POSITION') {
                    return makeConfirmedLongCandidateBars(symbol, sessionDate).map((bar, index, rows) =>
                        index === rows.length - 1
                            ? { ...bar, timestamp: makeTimestamp(sessionDate, 15, 56), close: 101 }
                            : bar
                    );
                }
                if (symbol === 'MISSING_BARS') {
                    return [];
                }
                return makeConfirmedLongCandidateBars(symbol, sessionDate);
            }

            async closePosition(symbol: string) {
                this.closedSymbols.push(symbol);
                return { symbol, status: 'closed' };
            }
        }

        env.dryRun = true;
        env.quantityToRetrieve = 3;

        const writes = captureStdout();
        const client = new EvaluationClient();
        const firstPass = await findBreakoutCandidates(client, '2026-05-18');

        expect(client.requestedLimit).to.equal(env.quantityToRetrieve);
        expect(firstPass.map((candidate) => candidate.symbol)).to.deep.equal(['READY']);
        expect(client.closedSymbols).to.deep.equal([]);
        expect(writes.join('')).to.include('__UI_STATUS__Closing HAS_POSITION for a profit of $2.00.');

        const seededTrades = normalizeTradesToConstraints(buildWeightedRiskTrades(firstPass, 1000), 1000, 25000, 5000);
        await executeSizedTrades(client, '2026-05-18', seededTrades);
        const secondPass = await findBreakoutCandidates(client, '2026-05-18');
        expect(secondPass).to.have.length(0);
    });

    it('rules 17-22: builds only confirmed breakout candidates with wick anchors, ATR, and positive scores', async () => {
        class CandidateClient extends AlpacaClient {
            async getMostActiveSymbols(limit = 40) {
                expect(limit).to.equal(env.quantityToRetrieve);
                return ['LONG_OK', 'SHORT_OK', 'NO_RETEST', 'LATE_BREAKOUT'];
            }

            async getOpenPosition() {
                return null;
            }

            async getIntradayBars(symbol: string, sessionDate: string) {
                if (symbol === 'LONG_OK') return makeConfirmedLongCandidateBars(symbol, sessionDate);
                if (symbol === 'SHORT_OK') return makeConfirmedShortCandidateBars(symbol, sessionDate);
                if (symbol === 'NO_RETEST') return makeNoRetestBars(symbol, sessionDate);
                return makeLateBreakoutBars(symbol, sessionDate);
            }
        }

        env.quantityToRetrieve = 4;
        const candidates = await findBreakoutCandidates(new CandidateClient(), '2026-05-19');
        const bySymbol = new Map(candidates.map((candidate) => [candidate.symbol, candidate]));

        expect(candidates.map((candidate) => candidate.symbol).sort()).to.deep.equal(['LONG_OK', 'SHORT_OK']);
        expect(bySymbol.get('LONG_OK')?.side).to.equal('buy');
        expect(bySymbol.get('SHORT_OK')?.side).to.equal('sell');
        expect(bySymbol.get('LONG_OK')?.openingRangeHigh).to.equal(101);
        expect(bySymbol.get('LONG_OK')?.openingRangeLow).to.equal(99);
        expect(bySymbol.get('LONG_OK')?.preBreakoutWickPrice).to.equal(101);
        expect(bySymbol.get('SHORT_OK')?.preBreakoutWickPrice).to.equal(99);
        expect((bySymbol.get('LONG_OK')?.atr1m ?? 0)).to.be.greaterThan(0);
        expect((bySymbol.get('SHORT_OK')?.atr1m ?? 0)).to.be.greaterThan(0);
        expect((bySymbol.get('LONG_OK')?.score ?? 0)).to.be.greaterThan(MIN_SCORE);
    });

    it('rules 23-28: ranks candidates, assigns weighted risk, derives stops and 4R targets, and normalizes to constraints', () => {
        const candidates = [
            {
                symbol: 'LONG_TOP',
                side: 'buy' as const,
                price: 110,
                reason: 'top long',
                score: 12,
                relativeBreakPct: 2,
                totalVolume: 10000,
                openingRangeHigh: 105,
                openingRangeLow: 100,
                preBreakoutWickPrice: 104,
                atr1m: 1,
            },
            {
                symbol: 'LONG_NEXT',
                side: 'buy' as const,
                price: 108,
                reason: 'next long',
                score: 8,
                relativeBreakPct: 1.5,
                totalVolume: 9000,
                openingRangeHigh: 104,
                openingRangeLow: 99,
                atr1m: 2,
            },
            {
                symbol: 'LONG_WEAK',
                side: 'buy' as const,
                price: 107,
                reason: 'weak long',
                score: 1,
                relativeBreakPct: 0.5,
                totalVolume: 2000,
                openingRangeHigh: 104,
                openingRangeLow: 103,
                atr1m: 0,
            },
            {
                symbol: 'SHORT_TOP',
                side: 'sell' as const,
                price: 90,
                reason: 'top short',
                score: 11,
                relativeBreakPct: 2,
                totalVolume: 10000,
                openingRangeHigh: 95,
                openingRangeLow: 92,
                preBreakoutWickPrice: 93,
                atr1m: 1,
            },
            {
                symbol: 'SHORT_NEXT',
                side: 'sell' as const,
                price: 91,
                reason: 'next short',
                score: 7,
                relativeBreakPct: 1.2,
                totalVolume: 8000,
                openingRangeHigh: 96,
                openingRangeLow: 93,
                atr1m: 1.5,
            },
        ];

        const { longs, shorts } = rankAndSelectCandidates(candidates, 2);
        expect(longs.map((candidate) => candidate.symbol)).to.deep.equal(['LONG_TOP', 'LONG_NEXT']);
        expect(shorts.map((candidate) => candidate.symbol)).to.deep.equal(['SHORT_TOP', 'SHORT_NEXT']);

        const weighted = buildWeightedRiskTrades([...longs, ...shorts], 1000, 4);
        const bySymbol = new Map(weighted.map((trade) => [trade.symbol, trade]));

        expect(bySymbol.get('LONG_TOP')?.stopPrice).to.equal(104);
        expect(bySymbol.get('SHORT_TOP')?.stopPrice).to.equal(93);
        expect(bySymbol.get('LONG_NEXT')?.stopPrice).to.equal(99);
        expect(bySymbol.get('LONG_NEXT')?.takeProfitPrice).to.equal(144);
        expect(bySymbol.has('LONG_WEAK')).to.equal(false);

        const normalized = normalizeTradesToConstraints(weighted, 500, 2000, 600);
        const totalRisk = normalized.reduce((sum, trade) => sum + trade.plannedRiskDollars, 0);
        const totalNotional = normalized.reduce((sum, trade) => sum + trade.estimatedNotional, 0);

        expect(totalRisk).to.be.at.most(500.0001);
        expect(totalNotional).to.be.at.most(2000.0001);
        expect(normalized.every((trade) => trade.estimatedNotional <= 600.0001)).to.equal(true);
        expect(normalized.every((trade) => Number(trade.qty.toFixed(4)) === trade.qty)).to.equal(true);
    });

    it('rules 29-30: execution prevents duplicates, uses dry-run monitor events in EMULATION, and submits bracket orders outside dry-run', async () => {
        class ExecutionClient extends AlpacaClient {
            submitted: Array<{ symbol: string; side: 'buy' | 'sell'; qty: number }> = [];

            async submitBracketOrder(params: {
                symbol: string;
                side: 'buy' | 'sell';
                qty: number;
                takeProfitLimitPrice: number;
                stopLossStopPrice: number;
            }) {
                this.submitted.push({ symbol: params.symbol, side: params.side, qty: params.qty });
                return { id: `order-${params.symbol}`, status: 'accepted' };
            }
        }

        const writes = captureStdout();
        const client = new ExecutionClient();
        const dryRunTrades = [{
            symbol: 'DRY_A',
            side: 'buy' as const,
            price: 100,
            reason: 'dry run',
            score: 5,
            relativeBreakPct: 1,
            totalVolume: 10000,
            openingRangeHigh: 101,
            openingRangeLow: 99,
            assignedRiskDollars: 100,
            stopPrice: 99,
            stopDistancePerShare: 1,
            takeProfitPrice: 104,
            qty: 2,
            plannedRiskDollars: 2,
            estimatedNotional: 200,
        }];

        env.dryRun = true;
        await executeSizedTrades(client, '2026-05-20', dryRunTrades);
        await executeSizedTrades(client, '2026-05-20', dryRunTrades);

        const output = writes.join('');
        expect(client.submitted).to.have.length(0);
        expect((output.match(/"eventType":"open"/g) ?? []).length).to.equal(1);

        env.dryRun = false;
        const liveTrades = [{
            ...dryRunTrades[0],
            symbol: 'LIVE_A',
        }];
        await executeSizedTrades(client, '2026-05-21', liveTrades);

        expect(client.submitted).to.deep.equal([{ symbol: 'LIVE_A', side: 'buy', qty: 2 }]);
    });
});