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

export interface ITrader {
    readonly dryRun: boolean;

    getAccount(): Promise<AccountInfo>;

    getPosition(symbol: string): Promise<PositionInfo | null>;

    closePosition(symbol: string, sessionDate: string, reason?: string): Promise<void>;

    executeTrades(trades: SizedTrade[], sessionDate: string): Promise<void>;

    computeUsedRisk(): number;

    managePosition(symbol: string, position: PositionInfo, sessionDate: string, sessionBars: Bar[], latestBar: Bar): Promise<PositionActionResult>;
}
