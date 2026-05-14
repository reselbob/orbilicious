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

function makeBreakoutBars(symbol: string): Bar[] {
    const bars: Bar[] = [];

    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: `2026-05-13T13:${String(minute).padStart(2, '0')}:00Z`,
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
        });
    }

    bars.push({
        symbol,
        timestamp: '2026-05-13T13:45:00Z',
        open: 101,
        high: 103,
        low: 100.5,
        close: 102,
        volume: 5000,
    });

    return bars;
}

class CapturingAlpacaClient extends AlpacaClient {
    requestedMostActiveLimit: number | undefined;
    submitBracketOrderCallCount = 0;

    constructor(private readonly symbols: string[]) {
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
        return makeBreakoutBars(symbol);
    }

    async submitBracketOrder(_params: BracketOrderParams): Promise<{ id: string; status: string }> {
        this.submitBracketOrderCallCount += 1;
        throw new Error('submitBracketOrder must not be called in dry-run mode');
    }
}

describe('app trade execution', () => {
    it('retrieves active symbols using configured quantity and logs dry-run executions for breakout candidates', async () => {
        const activeSymbols = ['AAPL', 'TSLA', 'NVDA'];
        const client = new CapturingAlpacaClient(activeSymbols);

        const candidates = await findBreakoutCandidates(client, '2026-05-13');
        const trades = normalizeTradesToConstraints(
            buildWeightedRiskTrades(candidates, 1000),
            1000,
            1_000_000
        );

        await executeSizedTrades(client, '2026-05-13', trades);

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
});
