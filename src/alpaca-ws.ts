import { env } from './config';
import { logger } from './logger';
import { Bar } from './types';

export type ConnectionType = 'WSS' | 'HTTP';

interface AlpacaBarMessage {
    type: 'b';
    symbol: string;
    bar: {
        t: string;
        o: number;
        h: number;
        l: number;
        c: number;
        v: number;
    };
}

interface AlpacaAuthResponse {
    action: 'auth';
    status: 'authenticated' | 'unauthorized';
    message?: string;
}

type BarHandler = (bar: Bar) => void;

export class AlpacaWebSocketClient {
    private ws: WebSocket | null = null;
    private authenticated = false;
    private subscribedSymbols: Set<string> = new Set();
    private pendingSubscriptions: Map<string, BarHandler> = new Map();
    private collectedBars: Map<string, Bar[]> = new Map();
    private connectionType: ConnectionType = 'WSS';
    private connecting = false;
    private shouldReconnect = false;
    private reconnectAttempts = 0;
    private readonly maxReconnectAttempts = 3;
    private readonly reconnectDelayMs = 1000;

    get connection(): ConnectionType {
        return this.connectionType;
    }

    async connect(): Promise<void> {
        if (this.ws && (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
            return;
        }

        this.connecting = true;
        const wsUrl = 'wss://stream.data.alpaca.markets/v2/sip';
        logger.debug('Connecting to Alpaca WebSocket', { url: wsUrl });

        this.ws = new WebSocket(wsUrl, {
            headers: {
                'APCA-API-KEY-ID': env.apiKey,
                'APCA-API-SECRET-KEY': env.apiSecret,
            },
        });
        const ws = this.ws;

        return new Promise((resolve, reject) => {
            let authTimeout: ReturnType<typeof setTimeout>;

            const cleanup = () => {
                clearTimeout(connectionTimeout);
                clearTimeout(authTimeout);
            };

            const connectionTimeout = setTimeout(() => {
                if (this.connecting) {
                    cleanup();
                    ws.close();
                    this.connecting = false;
                    reject(new Error('WebSocket connection timeout - falling back to HTTP'));
                }
            }, 15000);

            authTimeout = setTimeout(() => {
                if (this.connecting) {
                    cleanup();
                    ws.close();
                    this.connecting = false;
                    reject(new Error('WebSocket authentication timeout - falling back to HTTP'));
                } else if (!this.authenticated) {
                    cleanup();
                    ws.close();
 reject(new Error('WebSocket authentication failed - falling back to HTTP'));
                }
            }, 20000);

            ws.onopen = () => {
                logger.debug('Alpaca WebSocket connected, authenticating...');
                this.authenticate();
            };

            ws.onmessage = (event) => {
                this.handleMessage(event.data);
                if (this.authenticated && this.connecting) {
                    cleanup();
                    this.connecting = false;
                    resolve();
                }
            };

            ws.onerror = (error) => {
                cleanup();
                this.connecting = false;
                logger.error('Alpaca WebSocket error', { error });
                reject(error);
            };

            ws.onclose = (event) => {
                cleanup();
                this.connecting = false;
                this.authenticated = false;
                logger.debug('Alpaca WebSocket closed', { code: event.code, reason: event.reason });
                if (this.connecting && this.ws) {
                    this.handleReconnect();
                }
            };
        });
    }

    private authenticate(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            return;
        }

        logger.debug('Authenticating Alpaca WebSocket');
        this.ws.send(JSON.stringify({
            action: 'auth',
            key: env.apiKey,
            secret: env.apiSecret,
        }));
    }

    private handleMessage(data: string): void {
        try {
            const message = JSON.parse(data);

            if (message.action === 'auth') {
                const authResponse = message as AlpacaAuthResponse;
                if (authResponse.status === 'authenticated') {
                    this.authenticated = true;
                    logger.info('Alpaca WebSocket authenticated', { connectionType: this.connectionType });
                    this.resubscribePending();
                } else {
                    logger.error('Alpaca WebSocket authentication failed', { message: authResponse.message });
                    this.authenticated = false;
                }
            } else if (message.type === 'b') {
                const barMessage = message as AlpacaBarMessage;
                const bar: Bar = {
                    symbol: barMessage.symbol,
                    timestamp: barMessage.bar.t,
                    open: barMessage.bar.o,
                    high: barMessage.bar.h,
                    low: barMessage.bar.l,
                    close: barMessage.bar.c,
                    volume: barMessage.bar.v,
                };

                this.pendingSubscriptions.get(barMessage.symbol)?.(bar);

                const existing = this.collectedBars.get(barMessage.symbol) ?? [];
                existing.push(bar);
                this.collectedBars.set(barMessage.symbol, existing);
            }
        } catch {
            logger.warn('Failed to parse WebSocket message', { data });
        }
    }

    private resubscribePending(): void {
        for (const symbol of this.subscribedSymbols) {
            this.sendSubscribe([symbol]);
        }
    }

    private sendSubscribe(symbols: string[]): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
            return;
        }

        const symbolsToSubscribe = symbols.filter(s => !this.subscribedSymbols.has(s));
        if (symbolsToSubscribe.length === 0) {
            return;
        }

        for (const symbol of symbolsToSubscribe) {
            this.subscribedSymbols.add(symbol);
            if (!this.collectedBars.has(symbol)) {
                this.collectedBars.set(symbol, []);
            }
        }

        this.ws.send(JSON.stringify({
            action: 'subscribe',
            bars: symbolsToSubscribe,
        }));

        logger.debug('Subscribed to symbols via WebSocket', { symbols: symbolsToSubscribe, connectionType: this.connectionType });
    }

    private sendUnsubscribe(symbols: string[]): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
            return;
        }

        this.ws.send(JSON.stringify({
            action: 'unsubscribe',
            bars: symbols,
        }));

        for (const symbol of symbols) {
            this.subscribedSymbols.delete(symbol);
        }

        logger.debug('Unsubscribed from symbols via WebSocket', { symbols });
    }

    async subscribeForBars(symbols: string[], handler: BarHandler): Promise<Map<string, Bar[]>> {
        for (const symbol of symbols) {
            this.pendingSubscriptions.set(symbol, handler);
        }

        this.sendSubscribe(symbols);

        const timeout = 5000;
        const startTime = Date.now();

        await new Promise<void>((resolve) => {
            const checkCompletion = () => {
                const allSymbolsHaveBars = symbols.every(s =>
                    (this.collectedBars.get(s) ?? []).length > 0 ||
                    !this.pendingSubscriptions.has(s)
                );

                if (allSymbolsHaveBars || Date.now() - startTime > timeout) {
                    resolve();
                } else {
                    setTimeout(checkCompletion, 100);
                }
            };
            checkCompletion();
        });

        return new Map(this.collectedBars);
    }

    async getBarsForSymbols(symbols: string[]): Promise<Map<string, Bar[]>> {
        await this.connect();

        if (!this.authenticated) {
            throw new Error('WebSocket not authenticated');
        }

        this.collectedBars.clear();

        for (const symbol of symbols) {
            this.collectedBars.set(symbol, []);
        }

        return this.subscribeForBars(symbols, () => {});
    }

    unsubscribeAll(): void {
        const symbols = Array.from(this.subscribedSymbols);
        if (symbols.length > 0) {
            this.sendUnsubscribe(symbols);
        }
        this.pendingSubscriptions.clear();
    }

    disconnect(): void {
        this.shouldReconnect = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        this.authenticated = false;
        this.subscribedSymbols.clear();
        this.pendingSubscriptions.clear();
        this.collectedBars.clear();
        this.reconnectAttempts = 0;
        logger.debug('Alpaca WebSocket disconnected');
    }

    private handleReconnect(): void {
        if (!this.shouldReconnect || this.reconnectAttempts >= this.maxReconnectAttempts) {
            if (this.reconnectAttempts >= this.maxReconnectAttempts) {
                logger.warn('Max WebSocket reconnection attempts reached', { attempts: this.reconnectAttempts });
            }
            return;
        }

        this.reconnectAttempts++;
        const delay = this.reconnectDelayMs * Math.pow(2, this.reconnectAttempts - 1);

        logger.debug('Scheduling WebSocket reconnection', { attempt: this.reconnectAttempts, delayMs: delay });

        setTimeout(async () => {
            try {
                await this.connect();
                this.reconnectAttempts = 0;
            } catch (error) {
                logger.error('WebSocket reconnection failed', { error, attempt: this.reconnectAttempts });
                this.handleReconnect();
            }
        }, delay);
    }

    isConnected(): boolean {
        return this.ws !== null &&
               (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) &&
               this.authenticated;
    }
}

export function isMarketHours(): boolean {
    const now = new Date();
    const nyHour = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false }));
    const nyMinute = parseInt(now.toLocaleString('en-US', { timeZone: 'America/New_York', minute: '2-digit' }));
    const nyDay = now.getDay();

    if (nyDay === 0 || nyDay === 6) {
        return false;
    }

    const totalMinutes = nyHour * 60 + nyMinute;
    const marketOpen = 9 * 60 + 30;
    const marketClose = 16 * 60;

    return totalMinutes >= marketOpen && totalMinutes <= marketClose;
}