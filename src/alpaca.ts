import { env, strategyConfig } from './config';
import { logger } from './logger';
import { toNyParts } from './time';
import { Bar, Position } from './types';
import type {
    OrbReportResult,
    RunningSummaryOrbReportResult,
    WeeklySummaryOrbReportResult,
} from './reports';

type AlpacaOrderResponse = {
    id: string;
    status: string;
    [key: string]: unknown;
};

function headers() {
    return {
        'APCA-API-KEY-ID': env.apiKey,
        'APCA-API-SECRET-KEY': env.apiSecret,
        'Content-Type': 'application/json',
    };
}

function normalizeSessionDate(sessionDate?: Date | string): string {
    if (sessionDate instanceof Date) {
        return toNyParts(sessionDate, strategyConfig.sessionTimezone).date;
    }

    if (typeof sessionDate === 'string' && sessionDate.trim() !== '') {
        const parts = sessionDate.trim().split('-').map((part) => Number(part));
        if (parts.length === 3 && parts.every((part) => Number.isFinite(part) && part > 0)) {
            const [year, month, day] = parts;
            return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        }

        throw new Error(`Invalid sessionDate format: ${sessionDate}. Expected YYYY-MM-DD`);
    }

    return toNyParts(new Date(), strategyConfig.sessionTimezone).date;
}

export class AlpacaClient {
    public readonly client = this;

    async generateWeeklySummaryOrbReports(date: Date): Promise<WeeklySummaryOrbReportResult> {
        const { Reports } = await import('./reports');
        return Reports.generateWeeklySummaryOrbReports(this, date);
    }

    async generateRunningSummaryOrbReports(
        anchorDate: Date,
    ): Promise<RunningSummaryOrbReportResult> {
        const { Reports } = await import('./reports');
        return Reports.generateRunningSummaryOrbReports(this, anchorDate);
    }

    async generateOrbReport(
        sessionDate?: Date | string,
        options?: { usesHistoricData?: boolean; generateArtifacts?: boolean }
    ): Promise<OrbReportResult> {
        const normalizedDate = normalizeSessionDate(sessionDate);
        const { Reports } = await import('./reports');
        return Reports.generateOrbReport(this, normalizedDate, options);
    }

    async getAccount(): Promise<{ buyingPower: number; tradingBlocked: boolean }> {
        logger.debug('Fetching Alpaca account');

        const res = await fetch(`${env.tradingBaseUrl}/v2/account`, {
            headers: headers(),
        });

        if (!res.ok) {
            const body = await res.text();
            logger.error('Account request failed', { status: res.status, body });
            throw new Error(`Account request failed: ${res.status} ${body}`);
        }

        const json = await res.json() as {
            buying_power: string;
            trading_blocked: boolean;
        };

        const result = {
            buyingPower: Number(json.buying_power),
            tradingBlocked: json.trading_blocked,
        };

        logger.info('Fetched Alpaca account', result);
        return result;
    }

    async checkSipFeedSupported(): Promise<boolean> {
        // Probe a single known bar with feed=sip to detect whether the account
        // has a subscription plan that permits SIP (real-time) data.
        const url = `${env.dataBaseUrl}/v2/stocks/SPY/bars?timeframe=1Min&start=2024-01-02T14%3A30%3A00Z&end=2024-01-02T14%3A31%3A00Z&limit=1&adjustment=raw&feed=sip`;
        logger.debug('Probing SIP feed support');
        const res = await fetch(url, { headers: headers() });
        if (res.ok) {
            logger.debug('SIP feed supported');
            return true;
        }
        const body = await res.text();
        logger.debug('SIP feed not supported', { status: res.status, body });
        return false;
    }

    async getMostActiveSymbols(limit = 40): Promise<string[]> {
        const url =
            `${env.dataBaseUrl}/v1beta1/screener/stocks/most-actives` +
            `?top=${encodeURIComponent(String(limit))}` +
            `&by=volume`;

        logger.debug('Fetching most active symbols', { limit });

        const res = await fetch(url, { headers: headers() });
        if (!res.ok) {
            const body = await res.text();
            logger.error('Most actives request failed', { status: res.status, body });
            throw new Error(`Most actives request failed: ${res.status} ${body}`);
        }

        const json = await res.json() as {
            most_actives?: Array<{ symbol: string }>;
            data?: Array<{ symbol: string }>;
        };

        const rows = json.most_actives ?? json.data ?? [];
        const symbols = rows.map((row) => row.symbol).filter(Boolean);

        logger.info('Fetched most active symbols', { count: symbols.length, symbols });
        return symbols;
    }

    async getIntradayBars(symbol: string, sessionDate: string): Promise<Bar[]> {
        const start = `${sessionDate}T09:30:00-04:00`;
        const end = `${sessionDate}T16:00:00-04:00`;
        const url = `${env.dataBaseUrl}/v2/stocks/${encodeURIComponent(symbol)}/bars?timeframe=1Min&start=${encodeURIComponent(start)}&end=${encodeURIComponent(end)}&limit=10000&adjustment=raw&feed=${encodeURIComponent(env.dataFeed)}`;

        logger.debug('Fetching intraday bars', { symbol, sessionDate });

        const res = await fetch(url, { headers: headers() });
        if (!res.ok) {
            const body = await res.text();
            logger.error('Bars request failed', { symbol, sessionDate, status: res.status, body });
            throw new Error(`Bars request failed: ${res.status} ${body}`);
        }

        const json = await res.json() as {
            bars?: Array<{ t: string; o: number; h: number; l: number; c: number; v: number }>;
        };

        const bars = (json.bars ?? []).map((b) => ({
            symbol,
            timestamp: b.t,
            open: b.o,
            high: b.h,
            low: b.l,
            close: b.c,
            volume: b.v,
        }));

        logger.debug('Fetched intraday bars', { symbol, sessionDate, count: bars.length });
        return bars;
    }

    async getOpenPosition(symbol: string): Promise<Position | null> {
        logger.debug('Fetching open position', { symbol });

        const res = await fetch(`${env.tradingBaseUrl}/v2/positions/${encodeURIComponent(symbol)}`, {
            headers: headers(),
        });

        if (res.status === 404) {
            logger.debug('No open position found', { symbol });
            return null;
        }

        if (!res.ok) {
            const body = await res.text();
            logger.error('Position request failed', { symbol, status: res.status, body });
            throw new Error(`Position request failed: ${res.status} ${body}`);
        }

        const json = await res.json() as {
            symbol: string;
            side: 'long' | 'short';
            qty: string;
            avg_entry_price?: string;
        };

        const position = {
            symbol: json.symbol,
            side: json.side,
            qty: Number(json.qty),
            entryPrice: json.avg_entry_price ? Number(json.avg_entry_price) : undefined,
        };

        logger.info('Fetched open position', position);
        return position;
    }

    async submitBracketOrder(params: {
        symbol: string;
        side: 'buy' | 'sell';
        qty: number;
        takeProfitLimitPrice: number;
        stopLossStopPrice: number;
    }): Promise<AlpacaOrderResponse> {
        const payload = {
            symbol: params.symbol,
            qty: Number(params.qty.toFixed(4)),
            side: params.side,
            type: 'market',
            time_in_force: 'gtc',
            order_class: 'bracket',
            take_profit: {
                limit_price: Number(params.takeProfitLimitPrice.toFixed(2)),
            },
            stop_loss: {
                stop_price: Number(params.stopLossStopPrice.toFixed(2)),
            },
        };

        logger.info('Submitting bracket order', payload);

        const res = await fetch(`${env.tradingBaseUrl}/v2/orders`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const body = await res.text();
            logger.error('Bracket order request failed', {
                status: res.status,
                body,
                payload,
            });
            throw new Error(`Bracket order request failed: ${res.status} ${body}`);
        }

        const json = (await res.json()) as AlpacaOrderResponse;
        logger.info('Bracket order submitted', { symbol: params.symbol, response: json });
        return json;
    }

    async closePosition(symbol: string) {
        logger.warn('Closing position', { symbol });

        const res = await fetch(`${env.tradingBaseUrl}/v2/positions/${encodeURIComponent(symbol)}`, {
            method: 'DELETE',
            headers: headers(),
        });

        if (!res.ok) {
            const body = await res.text();
            logger.error('Close position failed', { symbol, status: res.status, body });
            throw new Error(`Close position failed: ${res.status} ${body}`);
        }

        const json = await res.json();
        logger.info('Position closed', { symbol, response: json });
        return json;
    }
}