import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { installMockFetch } from './helpers/mock-fetch';

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
});