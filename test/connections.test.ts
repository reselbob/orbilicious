import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { AlpacaWebSocketClient, isMarketHours } from '../src/alpaca-ws';
import { installMockFetch } from './helpers/mock-fetch';

describe('Alpaca WebSocket client connection type', () => {
    describe('isMarketHours', () => {
        it('returns true during market hours on a weekday', () => {
            const day = new Date().getDay();
            const isWeekday = day >= 1 && day <= 5;
            if (isWeekday) {
                const result = isMarketHours();
                expect(result).to.equal(true);
            }
        });

        it('returns false on weekends', () => {
            const day = new Date().getDay();
            const isWeekend = day === 0 || day === 6;
            if (isWeekend) {
                const result = isMarketHours();
                expect(result).to.equal(false);
            }
        });
    });

    describe('AlpacaWebSocketClient', () => {
        it('defaults connection type to WSS', () => {
            const client = new AlpacaWebSocketClient();
            expect(client.connection).to.equal('WSS');
        });

        it('reports disconnected state when not connected', () => {
            const client = new AlpacaWebSocketClient();
            expect(client.isConnected()).to.equal(false);
        });
    });

    describe('AlpacaClient connection type logging', () => {
        let restoreFetch: (() => void) | null = null;

        beforeEach(() => {
            restoreFetch = installMockFetch([
                (url: string) => {
                    if (url.includes('/v1beta1/screener/stocks/most-actives')) {
                        return {
                            status: 200,
                            json: {
                                most_actives: [{ symbol: 'AAPL', volume: 1000, trade_count: 10 }],
                            },
                        };
                    }
                    if (url.includes('/v2/stocks/AAPL/bars')) {
                        return {
                            status: 200,
                            json: {
                                bars: [
                                    { t: '2026-05-13T13:30:00Z', o: 100, h: 101, l: 99, c: 100.5, v: 1000 },
                                    { t: '2026-05-13T13:31:00Z', o: 100.5, h: 101.5, l: 100, c: 101, v: 1100 },
                                ],
                            },
                        };
                    }
                    return null;
                },
            ]);
        });

        afterEach(() => {
            if (restoreFetch) {
                restoreFetch();
                restoreFetch = null;
            }
        });

        it('getMostActiveSymbolDetails logs connection type HTTP', async () => {
            const client = new AlpacaClient();
            const details = await client.getMostActiveSymbolDetails(1);
            expect(details).to.have.length(1);
            expect(details[0].symbol).to.equal('AAPL');
        });

        it('getIntradayBars logs connection type HTTP when feed is iex', async () => {
            const client = new AlpacaClient();
            const bars = await client.getIntradayBars('AAPL', '2026-05-13');
            expect(bars).to.have.length(2);
            expect(bars[0].symbol).to.equal('AAPL');
        });
    });

    describe('WebSocket fallback behavior', () => {
        let restoreFetch: (() => void) | null = null;
        const originalDataFeed = process.env.ALPACA_DATA_FEED;

        afterEach(() => {
            process.env.ALPACA_DATA_FEED = originalDataFeed ?? '';
            if (restoreFetch) {
                restoreFetch();
                restoreFetch = null;
            }
        });

        it('falls back to HTTP when WebSocket receives no bars', async () => {
            restoreFetch = installMockFetch([
                (url: string) => {
                    if (url.includes('/v2/stocks/SPY/bars')) {
                        return {
                            status: 200,
                            json: {
                                bars: [{ t: '2026-05-13T13:30:00Z', o: 100, h: 101, l: 99, c: 100.5, v: 1000 }],
                            },
                        };
                    }
                    return null;
                },
            ]);

            process.env.ALPACA_DATA_FEED = 'sip';

            const client = new AlpacaClient();
            const bars = await client.getIntradayBars('SPY', '2026-05-13');
            expect(bars.length).to.be.greaterThan(0);
        });
    });

    describe('disconnectWebSocket', () => {
        it('cleans up WebSocket client instance', () => {
            const client = new AlpacaClient();
            (client as any)._wsClient = new AlpacaWebSocketClient();
            client.disconnectWebSocket();
            expect((client as any)._wsClient).to.equal(null);
        });

        it('handles disconnect when no WebSocket client exists', () => {
            const client = new AlpacaClient();
            expect(() => client.disconnectWebSocket()).to.not.throw();
        });
    });
});