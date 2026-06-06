import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { buildWeightedRiskTrades, normalizeTradesToConstraints } from '../src/basket';
import { env, strategyConfig } from '../src/config';
import { executeSizedTrades, findBreakoutCandidates } from '../src/app';
import { logger } from '../src/logger';
import { Bar, Position } from '../src/types';
import { Emulator } from '../src/trading/emulator';
import { LiveTrader } from '../src/trading/live-trader';

type BracketOrderParams = {
    symbol: string;
    side: 'buy' | 'sell';
    qty: number;
    takeProfitLimitPrice: number;
    stopLossStopPrice: number;
};

function makeBreakoutBars(symbol: string, sessionDate: string): Bar[] {
    const bars: Bar[] = [];
    const [year, month, day] = sessionDate.split('-');

    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: `${year}-${month}-${day}T13:${String(minute).padStart(2, '0')}:00Z`,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
        });
    }

    bars.push({
        symbol,
        timestamp: `${year}-${month}-${day}T13:45:00Z`,
        open: 101,
        high: 103,
        low: 100.5,
        close: 102,
        volume: 5000,
    });

    bars.push({
        symbol,
        timestamp: `${year}-${month}-${day}T13:46:00Z`,
        open: 101.2,
        high: 102.2,
        low: 100.9,
        close: 101.5,
        volume: 4500,
    });

    return bars;
}

class CapturingAlpacaClient extends AlpacaClient {
    requestedMostActiveLimit: number | undefined;
    submitBracketOrderCallCount = 0;

    constructor(
        private readonly symbols: string[],
        private readonly sessionDate: string
    ) {
        super();
    }

    async getMostActiveSymbols(limit = 40): Promise<string[]> {
        this.requestedMostActiveLimit = limit;
        return this.symbols;
    }

    async getOpenPosition(): Promise<Position | null> {
        return null;
    }

    async getIntradayBars(symbol: string): Promise<Bar[]> {
        return makeBreakoutBars(symbol, this.sessionDate);
    }

    async getIntradayBarsBatch(symbols: string[]): Promise<Map<string, Bar[]>> {
        const map = new Map<string, Bar[]>();
        for (const symbol of symbols) {
            map.set(symbol, await this.getIntradayBars(symbol));
        }
        return map;
    }

    async submitBracketOrder(_params: BracketOrderParams): Promise<{ id: string; status: string }> {
        this.submitBracketOrderCallCount += 1;
        throw new Error('submitBracketOrder must not be called in dry-run mode');
    }
}

class PositionManagementAlpacaClient extends AlpacaClient {
    closedSymbols: string[] = [];

    constructor(
        private readonly barsBySymbol: Record<string, Bar[]>,
        private readonly positionsBySymbol: Record<string, Position | null>
    ) {
        super();
    }

    async getMostActiveSymbols(): Promise<string[]> {
        return Object.keys(this.barsBySymbol);
    }

    async getOpenPosition(symbol: string): Promise<Position | null> {
        return this.positionsBySymbol[symbol] ?? null;
    }

    async getIntradayBars(symbol: string): Promise<Bar[]> {
        return this.barsBySymbol[symbol] ?? [];
    }

    async getIntradayBarsBatch(symbols: string[]): Promise<Map<string, Bar[]>> {
        const map = new Map<string, Bar[]>();
        for (const symbol of symbols) {
            map.set(symbol, this.barsBySymbol[symbol] ?? []);
        }
        return map;
    }

    async closePosition(symbol: string): Promise<unknown> {
        this.closedSymbols.push(symbol);
        return { symbol, status: 'closed' };
    }
}

describe('app trade execution', () => {
    it('retrieves active symbols using configured quantity and logs dry-run executions for breakout candidates', async () => {
        const sessionDate = '2099-05-13';
        const previousDryRun = env.dryRun;
        const previousQualityFiltersEnabled = env.breakoutQualityFiltersEnabled;
        const previousConfirmationMinutes = env.breakoutConfirmationCandleMinutes;
        const previousCandidateTradeType = env.candidateTradeType;
        const previousOpeningRangeMinutes = strategyConfig.openingRangeMinutes;
        env.dryRun = true;
        env.candidateTradeType = 'LONG_AND_SHORT';
        env.breakoutQualityFiltersEnabled = false;
        env.breakoutConfirmationCandleMinutes = 5;
        strategyConfig.openingRangeMinutes = 15;
        // Provide bars that guarantee breakout for all symbols
        const activeSymbols = ['AAPL', 'TSLA', 'NVDA'];
        class TestClient extends CapturingAlpacaClient {
            async getIntradayBars(symbol: string): Promise<Bar[]> {
                // 15 bars for opening range, then a breakout bar, then a confirmation bar, then a retest bar
                const bars: Bar[] = [];
                for (let m = 30; m <= 44; m++) {
                    bars.push({
                        symbol,
                        timestamp: `2099-05-13T13:${String(m).padStart(2, '0')}:00Z`,
                        open: 100,
                        high: 101,
                        low: 99,
                        close: 100,
                        volume: 1000,
                    });
                }
                // Breakout bar (close above opening range high)
                bars.push({
                    symbol,
                    timestamp: `2099-05-13T13:45:00Z`,
                    open: 101,
                    high: 103,
                    low: 100.5,
                    close: 102.5, // above opening range high
                    volume: 5000,
                });
                // Confirmation bar (not used for retest, but present)
                bars.push({
                    symbol,
                    timestamp: `2099-05-13T13:46:00Z`,
                    open: 102.6,
                    high: 103.1,
                    low: 101.9,
                    close: 102.7,
                    volume: 4500,
                });
                // Retest bar: low dips to opening range high (103), closes above it
                bars.push({
                    symbol,
                    timestamp: `2099-05-13T13:47:00Z`,
                    open: 102.8,
                    high: 103.2,
                    low: 101.0, // touches opening range high
                    close: 103.1, // closes above opening range high
                    volume: 4200,
                });
                return bars;
            }
        }
        try {
            const client = new TestClient(activeSymbols, sessionDate);
            const emulator = new Emulator(client);

            const candidates = await findBreakoutCandidates(client, emulator, sessionDate);
            const trades = normalizeTradesToConstraints(
                buildWeightedRiskTrades(candidates, 1000),
                1000,
                1_000_000
            );

            await executeSizedTrades(emulator, sessionDate, trades);

            const candidateSymbols = candidates.map((candidate) => candidate.symbol);
            const dryRunTradeSymbols = trades.map((trade) => trade.symbol);

            logger.info(
                `submitted symbols ${dryRunTradeSymbols.length}, candidate symbols ${candidateSymbols.length}, all active symbols retrieved ${activeSymbols.length}`,
                {
                    dryRunTradeSymbols: dryRunTradeSymbols.length,
                    candidateSymbols: candidateSymbols.length,
                    allActiveSymbolsRetrieved: activeSymbols.length,
                }
            );

            expect(client.requestedMostActiveLimit).to.equal(Math.min(env.quantityToRetrieve * 4, 100));
            expect(candidateSymbols.sort()).to.deep.equal(activeSymbols.sort());
            expect(dryRunTradeSymbols.sort()).to.deep.equal(activeSymbols.sort());
            expect(client.submitBracketOrderCallCount).to.equal(0);
            expect(trades).to.have.length(candidates.length);
            expect(trades.every((trade) => trade.takeProfitPrice > 0)).to.equal(true);
            expect(trades.every((trade) => trade.stopPrice > 0)).to.equal(true);
        } finally {
            env.dryRun = previousDryRun;
            env.candidateTradeType = previousCandidateTradeType;
            env.breakoutQualityFiltersEnabled = previousQualityFiltersEnabled;
            env.breakoutConfirmationCandleMinutes = previousConfirmationMinutes;
            strategyConfig.openingRangeMinutes = previousOpeningRangeMinutes;
        }
    });

    it('captures profit from force-exit window to close', async () => {
        const sessionDate = '2099-05-13';
        const makeBarsAtTimestamp = (symbol: string, timestamp: string, close: number): Bar[] =>
            makeBreakoutBars(symbol, sessionDate).map((bar, index, rows) =>
                index === rows.length - 1 ? { ...bar, timestamp, close } : bar
            );

        const barsBySymbol: Record<string, Bar[]> = {
            LONG_PROFIT: makeBarsAtTimestamp('LONG_PROFIT', `${sessionDate}T19:56:00Z`, 101),
            SHORT_PROFIT: makeBarsAtTimestamp('SHORT_PROFIT', `${sessionDate}T19:56:00Z`, 99),
            LONG_NO_PROFIT: makeBarsAtTimestamp('LONG_NO_PROFIT', `${sessionDate}T19:56:00Z`, 99),
            SHORT_NO_PROFIT: makeBarsAtTimestamp('SHORT_NO_PROFIT', `${sessionDate}T19:56:00Z`, 101),
            LONG_PRE_WINDOW: makeBarsAtTimestamp('LONG_PRE_WINDOW', `${sessionDate}T19:50:00Z`, 101),
        };

        const positionsBySymbol: Record<string, Position | null> = {
            LONG_PROFIT: { symbol: 'LONG_PROFIT', side: 'long', qty: 1, entryPrice: 100 },
            SHORT_PROFIT: { symbol: 'SHORT_PROFIT', side: 'short', qty: 1, entryPrice: 100 },
            LONG_NO_PROFIT: { symbol: 'LONG_NO_PROFIT', side: 'long', qty: 1, entryPrice: 100 },
            SHORT_NO_PROFIT: { symbol: 'SHORT_NO_PROFIT', side: 'short', qty: 1, entryPrice: 100 },
            LONG_PRE_WINDOW: { symbol: 'LONG_PRE_WINDOW', side: 'long', qty: 1, entryPrice: 100 },
        };

        const client = new PositionManagementAlpacaClient(barsBySymbol, positionsBySymbol);

        const previousDryRun = env.dryRun;
        env.dryRun = false;

        try {
            const liveTrader = new LiveTrader(client);
            const candidates = await findBreakoutCandidates(client, liveTrader, sessionDate);
            expect(candidates).to.have.length(0);
            expect(client.closedSymbols.sort()).to.deep.equal(['LONG_PROFIT', 'SHORT_PROFIT']);
        } finally {
            env.dryRun = previousDryRun;
        }
    });
});
