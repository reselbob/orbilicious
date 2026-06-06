import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { env } from '../src/config';
import { buildWeightedRiskTrades, normalizeTradesToConstraints } from '../src/basket';
import { executeSizedTrades, findBreakoutCandidates } from '../src/app';
import { installMockFetch } from './helpers/mock-fetch';
import { Bar, Position } from '../src/types';
import { LiveTrader } from '../src/trading/live-trader';

describe('alpaca client integration', () => {
    it('reads buying power from account response', async () => {
        const restore = installMockFetch([
            (url) => {
                if (url.endsWith('/v2/account')) {
                    return {
                        status: 200,
                        json: {
                            buying_power: '25000.55',
                            trading_blocked: false,
                        },
                    };
                }
                return null;
            },
        ]);

        try {
            const client = new AlpacaClient();
            const account = await client.getAccount();
            expect(account.buyingPower).to.equal(25000.55);
            expect(account.tradingBlocked).to.equal(false);
        } finally {
            restore();
        }
    });

    it('returns null when no open position exists', async () => {
        const restore = installMockFetch([
            (url) => {
                if (url.includes('/v2/positions/SPY')) {
                    return {
                        status: 404,
                        text: 'not found',
                    };
                }
                return null;
            },
        ]);

        try {
            const client = new AlpacaClient();
            const position = await client.getOpenPosition('SPY');
            expect(position).to.equal(null);
        } finally {
            restore();
        }
    });

    it('reads intraday bars from Alpaca bar response', async () => {
        const restore = installMockFetch([
            (url) => {
                if (url.includes('/v2/stocks/SPY/bars')) {
                    return {
                        status: 200,
                        json: {
                            bars: [
                                {
                                    t: '2026-05-13T13:30:00Z',
                                    o: 100,
                                    h: 101,
                                    l: 99,
                                    c: 100.5,
                                    v: 1000,
                                },
                            ],
                        },
                    };
                }
                return null;
            },
        ]);

        try {
            const client = new AlpacaClient();
            const bars = await client.getIntradayBars('SPY', '2026-05-13');
            expect(bars).to.have.length(1);
            expect(bars[0].symbol).to.equal('SPY');
            expect(bars[0].close).to.equal(100.5);
        } finally {
            restore();
        }
    });

    it('reads the most active screener universe', async () => {
        const restore = installMockFetch([
            (url) => {
                if (url.includes('/v1beta1/screener/stocks/most-actives')) {
                    return {
                        status: 200,
                        json: {
                            most_actives: [{ symbol: 'AAPL' }, { symbol: 'TSLA' }, { symbol: 'NVDA' }],
                        },
                    };
                }
                return null;
            },
        ]);

        try {
            const client = new AlpacaClient();
            const symbols = await client.getMostActiveSymbols(3);
            expect(symbols).to.deep.equal(['AAPL', 'TSLA', 'NVDA']);
        } finally {
            restore();
        }
    });

    it('builds a correct bracket-order payload without executing a real trade', async () => {
        let capturedBody: string | undefined;

        const restore = installMockFetch([
            (url, init) => {
                if (url.endsWith('/v2/orders') && init?.method === 'POST') {
                    capturedBody = String(init.body);
                    return {
                        status: 200,
                        json: {
                            id: 'test-order-id',
                            status: 'accepted',
                        },
                    };
                }
                return null;
            },
        ]);

        try {
            const client = new AlpacaClient();
            const response = await client.submitBracketOrder({
                symbol: 'SPY',
                side: 'buy',
                qty: 12.34567,
                takeProfitLimitPrice: 444.567,
                stopLossStopPrice: 430.123,
            });

            const payload = JSON.parse(capturedBody!);

            expect(response.status).to.equal('accepted');
            expect(payload.symbol).to.equal('SPY');
            expect(payload.side).to.equal('buy');
            expect(payload.order_class).to.equal('bracket');
            expect(payload.qty).to.equal(12.3457);
            expect(payload.take_profit.limit_price).to.equal(444.57);
            expect(payload.stop_loss.stop_price).to.equal(430.12);
        } finally {
            restore();
        }
    });

    it('gets actual most active stocks from Alpaca API using QUANTITY_TO_RETRIEVE', async () => {
        const client = new AlpacaClient();
        const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);

        expect(symbols).to.be.an('array');
        expect(symbols.length).to.equal(env.quantityToRetrieve);
        expect(symbols.length).to.be.greaterThan(0);

        // Verify all elements are strings (symbols)
        symbols.forEach((symbol) => {
            expect(symbol).to.be.a('string');
            expect(symbol.length).to.be.greaterThan(0);
        });
    });

    it('executes each sized breakout candidate trade in parallel promises using runtime pricing and risk rules', async () => {
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

        const activeSymbols = ['AAPL', 'TSLA', 'NVDA', 'MSFT'];
        const submittedOrders: Array<{
            symbol: string;
            side: 'buy' | 'sell';
            qty: number;
            takeProfitLimitPrice: number;
            stopLossStopPrice: number;
            startedAt: number;
        }> = [];

        class RuntimeNoTradeClient extends AlpacaClient {
            async getMostActiveSymbols(): Promise<string[]> {
                return activeSymbols;
            }

            async getOpenPosition(): Promise<Position | null> {
                return null;
            }

            async getIntradayBars(symbol: string): Promise<Bar[]> {
                return makeBreakoutBars(symbol);
            }

            async submitBracketOrder(params: {
                symbol: string;
                side: 'buy' | 'sell';
                qty: number;
                takeProfitLimitPrice: number;
                stopLossStopPrice: number;
            }): Promise<{ id: string; status: string }> {
                submittedOrders.push({
                    symbol: params.symbol,
                    side: params.side,
                    qty: params.qty,
                    takeProfitLimitPrice: params.takeProfitLimitPrice,
                    stopLossStopPrice: params.stopLossStopPrice,
                    startedAt: Date.now(),
                });

                await new Promise((resolve) => setTimeout(resolve, 50));

                return {
                    id: `sim-${params.symbol}`,
                    status: 'accepted',
                };
            }
        }

        const client = new RuntimeNoTradeClient();
        const sessionDate = '2026-05-13';
        const liveTrader = new LiveTrader(client);

        const candidates = await findBreakoutCandidates(client, liveTrader, sessionDate);
        const weightedTrades = buildWeightedRiskTrades(
            candidates,
            env.maxTotalRisk,
            env.takeProfitMultiple
        );
        const trades = normalizeTradesToConstraints(weightedTrades, env.maxTotalRisk, 1_000_000);

        const totalRisk = trades.reduce((sum, trade) => sum + trade.plannedRiskDollars, 0);
        expect(totalRisk).to.be.at.most(env.maxTotalRisk + 0.0001);

        const previousDryRun = env.dryRun;
        env.dryRun = false;

        try {
            await executeSizedTrades(liveTrader, sessionDate, trades);
        } finally {
            env.dryRun = previousDryRun;
        }

        expect(submittedOrders.length).to.equal(trades.length);

        trades.forEach((trade) => {
            const submitted = submittedOrders.find((order) => order.symbol === trade.symbol);
            expect(submitted).to.not.equal(undefined);
            expect(submitted!.qty).to.equal(trade.qty);
            expect(submitted!.stopLossStopPrice).to.equal(trade.stopPrice);
            expect(submitted!.takeProfitLimitPrice).to.equal(trade.takeProfitPrice);
        });

        const startTimes = submittedOrders.map((order) => order.startedAt);
        const startRangeMs = Math.max(...startTimes) - Math.min(...startTimes);
        expect(startRangeMs).to.be.lessThan(100);
    });
});