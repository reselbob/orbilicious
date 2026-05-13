import logger from './logger';

// --- Interfaces ---

interface MostActive {
    symbol: string;
    volume: number;
    trade_count: number;
}

interface MostActivesResponse {
    most_actives: MostActive[];
    last_updated: string;
}

// --- Class Implementation ---

export class ActivesList {
    private readonly url: string = 'https://data.alpaca.markets/v1beta1/screener/stocks/most-actives?by=volume&top=40';
    private readonly keyId: string;
    private readonly secretKey: string;

    constructor() {
        this.keyId = process.env.ALPACA_KEY || '';
        this.secretKey = process.env.ALPACA_SECRET || '';

        if (!this.keyId || !this.secretKey) {
            logger.warn('ActivesList initialized without Alpaca API credentials.');
        }
    }

    /**
     * Fetches the full MostActivesResponse from Alpaca.
     */
    public async fetch(): Promise<MostActivesResponse | undefined> {
        const options: RequestInit = {
            method: 'GET',
            headers: {
                'accept': 'application/json',
                'APCA-API-KEY-ID': this.keyId,
                'APCA-API-SECRET-KEY': this.secretKey,
            }
        };

        try {
            const response = await fetch(this.url, options);

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = (await response.json()) as MostActivesResponse;
            logger.info(`Successfully fetched ${data.most_actives.length} active stocks.`);
            return data;
        } catch (error: any) {
            //logger.error(`Error fetching most actives: ${error.message}`);
            //return undefined;
        }
    }

    /**
     * Helper method to return just the array of stock symbols.
     */
    public async getSymbols(): Promise<string[]> {
        const data = await this.fetch();
        if (!data || !data.most_actives) {
            return [];
        }
        return data.most_actives.map(stock => stock.symbol);
    }
}