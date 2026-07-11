import { SizedTrade } from '../basket';
import { Bar } from '../types';

export interface PositionInfo {
    symbol: string;
    side: 'long' | 'short';
    qty: number;
    entryPrice: number;
    entryTime?: string;
}

export interface AccountInfo {
    buyingPower: number;
    tradingBlocked: boolean;
}

export interface PositionActionResult {
    action: 'closed' | 'holding' | 'none';
    pnl?: number;
    exitPrice?: number;
    closeReason?: string;
}

export interface TradeRecord {
    symbol: string;
    side: 'long' | 'short';
    qty: number;
    entryPrice: number;
    entryTime: string;
    stopPrice: number;
    takeProfitPrice: number;
    exitPrice?: number;
    exitTime?: string;
    pnl?: number;
    status: 'open' | 'closed';
}

export interface ITrader {
    readonly dryRun: boolean;

    getAccount(): Promise<AccountInfo>;

    getPosition(symbol: string): Promise<PositionInfo | null>;

    getAllPositions(): Promise<PositionInfo[]>;

    getTradeHistory(): TradeRecord[];

    closePosition(symbol: string, sessionDate: string, reason?: string): Promise<void>;

    executeTrades(trades: SizedTrade[], sessionDate: string): Promise<void>;

    computeUsedRisk(): number;

    getCumulativeRealizedLoss(): number;

    resetCumulativeRealizedLoss?(): void;

    managePosition(symbol: string, position: PositionInfo, sessionDate: string, sessionBars: Bar[], latestBar: Bar): Promise<PositionActionResult>;
}
