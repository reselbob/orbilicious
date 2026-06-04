import { expect } from 'chai';
import { describe, it, beforeEach, afterEach } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import { AlpacaWebSocketClient, isMarketHours } from '../src/alpaca-ws';
import { installMockFetch } from './helpers/mock-fetch';

describe('Alpaca WebSocket client connection type', () => {
    describe('isMarketHours', () => {
        function withMockedNow(isoTimestamp: string, run: () => void) {
            const RealDate = Date;

            class MockDate extends RealDate {
                constructor(value?: string | number | Date) {
                    if (arguments.length === 0) {
                        super(isoTimestamp);
                        return;
                    }

                    super(value as string | number | Date);
                }

                static override now(): number {
                    return new RealDate(isoTimestamp).getTime();
                }

                static override parse(value: string): number {
                    return RealDate.parse(value);
                }

                static override UTC(
                    year: number,
                    monthIndex: number,
                    day?: number,
                    hours?: number,
                    minutes?: number,
                    seconds?: number,
                    ms?: number,
                ): number {
                    return RealDate.UTC(year, monthIndex, day, hours, minutes, seconds, ms);
                }
            }

            (global as unknown as { Date: DateConstructor }).Date = MockDate as unknown as DateConstructor;
            try {
                run();
            } finally {
                (global as unknown as { Date: DateConstructor }).Date = RealDate;
            }
        }

        it('returns true during market hours on a weekday', () => {
            // 2026-06-01T14:00:00Z = 10:00 AM New York (weekday, market open)
            withMockedNow('2026-06-01T14:00:00Z', () => {
                const result = isMarketHours();
                expect(result).to.equal(true);
            });
        });

        it('returns false on weekends', () => {
            // 2026-06-07T14:00:00Z = Sunday in New York
            withMockedNow('2026-06-07T14:00:00Z', () => {
                const result = isMarketHours();
                expect(result).to.equal(false);
            });
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

        it('getIntradayBars fetches bars via HTTP directly', async () => {
            const client = new AlpacaClient();
            const bars = await client.getIntradayBars('AAPL', '2026-05-13');
            expect(bars).to.have.length(2);
            expect(bars[0].symbol).to.equal('AAPL');
        });
    });

    describe('getIntradayBarsBatch (HTTP batch)', () => {
        let restoreFetch: (() => void) | null = null;

        beforeEach(() => {
            restoreFetch = installMockFetch([
                (url: string) => {
                    if (url.includes('/v2/stocks/AAPL/bars')) {
                        return {
                            status: 200,
                            json: {
                                bars: [
                                    { t: '2026-05-13T13:30:00Z', o: 100, h: 101, l: 99, c: 100.5, v: 1000 },
                                ],
                            },
                        };
                    }
                    if (url.includes('/v2/stocks/MSFT/bars')) {
                        return {
                            status: 200,
                            json: {
                                bars: [
                                    { t: '2026-05-13T13:30:00Z', o: 200, h: 201, l: 199, c: 200.5, v: 2000 },
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

        it('fetches bars for all symbols via concurrent HTTP calls', async () => {
            const client = new AlpacaClient();
            const map = await client.getIntradayBarsBatch(['AAPL', 'MSFT'], '2026-05-13');
            expect(map.size).to.equal(2);
            expect(map.get('AAPL')).to.have.length(1);
            expect(map.get('MSFT')).to.have.length(1);
            expect(map.get('AAPL')![0].symbol).to.equal('AAPL');
            expect(map.get('MSFT')![0].symbol).to.equal('MSFT');
        });

        it('returns map with empty arrays for symbols with no bars', async () => {
            restoreFetch = installMockFetch([
                (_url: string) => ({
                    status: 200,
                    json: { bars: [] },
                }),
            ]);
            const client = new AlpacaClient();
            const map = await client.getIntradayBarsBatch(['NODATA'], '2026-05-13');
            expect(map.get('NODATA')).to.have.length(0);
        });
    });

    describe('handleMessage (v2 streaming format)', () => {
        it('parses array-wrapped auth success and sets authenticated', () => {
            const client = new AlpacaWebSocketClient();
            const data = JSON.stringify([{ T: 'success', msg: 'authenticated' }]);
            (client as any).handleMessage(data);
            expect((client as any).authenticated).to.equal(true);
        });

        it('parses single-object auth success (backward compat)', () => {
            const client = new AlpacaWebSocketClient();
            const data = JSON.stringify({ T: 'success', msg: 'authenticated' });
            (client as any).handleMessage(data);
            expect((client as any).authenticated).to.equal(true);
        });

        it('parses error code 406 and disables reconnect', () => {
            const client = new AlpacaWebSocketClient();
            (client as any).shouldReconnect = true;
            (client as any).connecting = true;
            const data = JSON.stringify([{ T: 'error', code: 406, msg: 'connection limit exceeded' }]);
            (client as any).handleMessage(data);
            expect((client as any).shouldReconnect).to.equal(false);
        });

        it('parses bar message with v2 field names (S for symbol, flat fields)', () => {
            const client = new AlpacaWebSocketClient();
            const data = JSON.stringify([{
                T: 'b',
                S: 'SPY',
                o: 100.5,
                h: 101.0,
                l: 99.5,
                c: 100.75,
                v: 10000,
                t: '2024-01-02T14:30:00Z',
            }]);
            (client as any).handleMessage(data);
            const bars = (client as any).collectedBars.get('SPY');
            expect(bars).to.have.length(1);
            expect(bars[0].symbol).to.equal('SPY');
            expect(bars[0].open).to.equal(100.5);
            expect(bars[0].high).to.equal(101.0);
            expect(bars[0].low).to.equal(99.5);
            expect(bars[0].close).to.equal(100.75);
            expect(bars[0].volume).to.equal(10000);
            expect(bars[0].timestamp).to.equal('2024-01-02T14:30:00Z');
        });

        it('collects multiple bars for the same symbol', () => {
            const client = new AlpacaWebSocketClient();
            const data = JSON.stringify([
                { T: 'b', S: 'SPY', o: 100, h: 101, l: 99, c: 100, v: 1000, t: '2024-01-02T14:30:00Z' },
                { T: 'b', S: 'SPY', o: 101, h: 102, l: 100, c: 101, v: 1100, t: '2024-01-02T14:31:00Z' },
            ]);
            (client as any).handleMessage(data);
            const bars = (client as any).collectedBars.get('SPY');
            expect(bars).to.have.length(2);
        });

        it('sends bars to pending subscription handler', () => {
            const client = new AlpacaWebSocketClient();
            let handled = 0;
            (client as any).pendingSubscriptions.set('SPY', () => { handled++; });
            const data = JSON.stringify([{ T: 'b', S: 'SPY', o: 100, h: 101, l: 99, c: 100, v: 1000, t: '2024-01-02T14:30:00Z' }]);
            (client as any).handleMessage(data);
            expect(handled).to.equal(1);
        });

        it('ignores non-message data silently (no throw)', () => {
            const client = new AlpacaWebSocketClient();
            expect(() => (client as any).handleMessage('not json')).to.not.throw();
            expect(() => (client as any).handleMessage('')).to.not.throw();
        });
    });

    describe('unsubscribeAll', () => {
        it('clears pending subscriptions', () => {
            const client = new AlpacaWebSocketClient();
            (client as any).pendingSubscriptions.set('SPY', () => { });
            client.unsubscribeAll();
            expect((client as any).pendingSubscriptions.size).to.equal(0);
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