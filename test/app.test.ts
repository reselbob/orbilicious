import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { buildWeightedRiskTrades, normalizeTradesToConstraints } from '../src/basket';
import { env } from '../src/config';
import { executeSizedTrades, findBreakoutCandidates } from '../src/app';
import { logger } from '../src/logger';
import { Bar, Position } from '../src/types';

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

    async closePosition(symbol: string): Promise<unknown> {
        this.closedSymbols.push(symbol);
        return { symbol, status: 'closed' };
    }
}

describe('app trade execution', () => {
    it('retrieves active symbols using configured quantity and logs dry-run executions for breakout candidates', async () => {
        const sessionDate = '2099-05-13';
        const activeSymbols = ['AAPL', 'TSLA', 'NVDA'];
        const client = new CapturingAlpacaClient(activeSymbols, sessionDate);

        const candidates = await findBreakoutCandidates(client, sessionDate);
        const trades = normalizeTradesToConstraints(
            buildWeightedRiskTrades(candidates, 1000),
            1000,
            1_000_000
        );

        await executeSizedTrades(client, sessionDate, trades);

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

        expect(client.requestedMostActiveLimit).to.equal(env.quantityToRetrieve);
        expect(candidateSymbols).to.deep.equal(activeSymbols);
        expect(dryRunTradeSymbols).to.deep.equal(activeSymbols);
        expect(client.submitBracketOrderCallCount).to.equal(0);
        expect(trades).to.have.length(candidates.length);
        expect(trades.every((trade) => trade.takeProfitPrice > 0)).to.equal(true);
        expect(trades.every((trade) => trade.stopPrice > 0)).to.equal(true);
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
            const candidates = await findBreakoutCandidates(client, sessionDate);
            expect(candidates).to.have.length(0);
            expect(client.closedSymbols.sort()).to.deep.equal(['LONG_PROFIT', 'SHORT_PROFIT']);
        } finally {
            env.dryRun = previousDryRun;
        }
    });
});
