import { expect } from 'chai';
import { afterEach, describe, it } from 'mocha';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';

type RestoreFn = () => void;

const envSnapshot = { ...process.env };
let restores: RestoreFn[] = [];

function registerRestore(fn: RestoreFn) {
    restores.push(fn);
}

function setEnv(key: string, value: string) {
    const original = process.env[key];
    process.env[key] = value;
    registerRestore(() => {
        if (original === undefined) {
            delete process.env[key];
            return;
        }

        process.env[key] = original;
    });
}

async function closeServer(server: import('node:http').Server) {
    await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
            if (error) {
                reject(error);
                return;
            }

            resolve();
        });
    });
}

async function requestJson(baseUrl: string, pathname: string, body?: unknown) {
    const url = new URL(pathname, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);

    return await new Promise<{ status: number; json: any }>((resolve, reject) => {
        const req = request(
            url,
            {
                method: payload ? 'POST' : 'GET',
                headers: payload
                    ? {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    }
                    : undefined,
            },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
                res.on('end', () => {
                    const text = Buffer.concat(chunks).toString('utf8');
                    resolve({
                        status: res.statusCode ?? 0,
                        json: text ? JSON.parse(text) : null,
                    });
                });
            }
        );

        req.on('error', reject);

        if (payload) {
            req.write(payload);
        }

        req.end();
    });
}

afterEach(() => {
    for (const restore of restores.reverse()) {
        restore();
    }
    restores = [];
    process.env = { ...envSnapshot };
});

describe('REPLAY web API', () => {
    it('serves canonical HKIT replay data and rejects missing replay dates', async () => {
        setEnv('APCA_API_KEY_ID', 'key');
        setEnv('APCA_API_SECRET_KEY', 'secret');
        setEnv('ALLOW_LONG', 'true');
        setEnv('ALLOW_SHORT', 'true');
        setEnv('ALPACA_DATA_BASE_URL', 'https://data.alpaca.markets');
        setEnv('ALPACA_DATA_FEED', 'iex');
        setEnv('OPENING_RANGE_MINUTES', '15');
        setEnv('CANDLE_MINUTES', '1');
        setEnv('FORCE_EXIT_TIME', '15:55');
        setEnv('MAX_TOTAL_RISK', '1000');
        setEnv('HARD_BASKET_CAP', '25000');
        setEnv('MAX_POSITION_NOTIONAL', '5000');
        setEnv('MAX_POSITIONS_PER_SIDE', '3');
        setEnv('MIN_STOP_PCT', '0.0075');
        setEnv('ATR_STOP_MULTIPLE', '1');
        setEnv('QUANTITY_TO_RETRIEVE', '40');
        setEnv('STOP_LOSS_PROFIT_RATIO', '1:4');
        setEnv('SESSION_MODE', 'EMULATION');
        setEnv('SESSION_DATE', '');

        const { startWebServer } = await import('../src/web/server');
        const server = startWebServer(0);
        await new Promise<void>((resolve) => server.once('listening', () => resolve()));

        try {
            const address = server.address();
            if (!address || typeof address === 'string') {
                throw new Error('Server did not bind to an address');
            }

            const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}`;

            const missingDateResponse = await requestJson(baseUrl, '/api/orbilicious/start', {
                sessionMode: 'REPLAY',
            });
            expect(missingDateResponse.status).to.equal(400);
            const missingDateBody: any = missingDateResponse.json;
            expect(missingDateBody.message).to.equal('Replay mode requires a session date.');

            const startResponse = await requestJson(baseUrl, '/api/orbilicious/start', {
                continuous: false,
                realTimeData: false,
                sessionMode: 'REPLAY',
                emulationSessionDate: '2026-06-01',
                mostActiveSymbolLimit: 40,
                candidateTradeType: 'LONG_AND_SHORT',
            });
            expect(startResponse.status).to.equal(202);
            const startBody: any = startResponse.json;
            expect(startBody.state.sessionMode).to.equal('REPLAY');
            expect(startBody.state.runtimeStatus).to.equal('Running replay');

            const tradesResponse = await requestJson(baseUrl, '/api/orbilicious/trades?since=0');
            expect(tradesResponse.status).to.equal(200);
            const tradesBody: any = tradesResponse.json;

            const hkitOpen = tradesBody.events.find((event: any) => event.eventType === 'open' && event.symbol === 'HKIT');
            const hkitClose = tradesBody.events.find((event: any) => event.eventType === 'close' && event.symbol === 'HKIT');

            expect(hkitOpen.targetPrice).to.equal(3.6695000000000015);
            expect(hkitClose.closePrice).to.equal(3.6695000000000015);
            expect(hkitClose.timestamp).to.equal('2026-06-01T14:12:05.214Z');
            expect(JSON.stringify(tradesBody.events)).to.not.include('3.9095000000000018');
        } finally {
            await closeServer(server);
        }
    });
});