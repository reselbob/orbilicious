import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { buildWeightedRiskTrades, normalizeTradesToConstraints } from '../src/basket';
import { executeSizedTrades, findBreakoutCandidates } from '../src/app';
import { logger } from '../src/logger';
import { Bar, Position } from '../src/types';

type SubmittedBracketOrder = {
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
    readonly submittedBracketOrders: SubmittedBracketOrder[] = [];

    constructor(private readonly symbols: string[]) {
        super();
    }

    async getMostActiveSymbols(): Promise<string[]> {
        return this.symbols;
    }

    async getOpenPosition(): Promise<Position | null> {
        return null;
    }

    async getIntradayBars(symbol: string): Promise<Bar[]> {
        return makeBreakoutBars(symbol);
    }

    async submitBracketOrder(params: SubmittedBracketOrder): Promise<{ id: string; status: string }> {
        this.submittedBracketOrders.push(params);
        return { id: `order-${params.symbol}`, status: 'accepted' };
    }
}

describe('app trade execution', () => {
    it('submits one bracket order for every symbol returned by findBreakoutCandidates', async () => {
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
        const submittedSymbols = client.submittedBracketOrders.map((order) => order.symbol);

        logger.info('Submitted symbol coverage', {
            submittedSymbols: submittedSymbols.length,
            candidateSymbols: candidateSymbols.length,
            allActiveSymbolsRetrieved: activeSymbols.length,
        });

        expect(candidateSymbols).to.deep.equal(activeSymbols);
        expect(submittedSymbols).to.deep.equal(activeSymbols);
        expect(client.submittedBracketOrders).to.have.length(candidates.length);
        expect(client.submittedBracketOrders.every((order) => order.takeProfitLimitPrice > 0)).to.equal(true);
        expect(client.submittedBracketOrders.every((order) => order.stopLossStopPrice > 0)).to.equal(true);
    });
});
