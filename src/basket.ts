import { env } from './config';
import { Bar } from './types';

export type BreakoutCandidate = {
    symbol: string;
    side: 'buy' | 'sell';
    price: number;
    reason: string;
    score: number;
    relativeBreakPct: number;
    totalVolume: number;
    openingRangeHigh: number;
    openingRangeLow: number;
    atr1m?: number;
    preBreakoutWickPrice?: number;
};

export type SizedTrade = BreakoutCandidate & {
    assignedRiskDollars: number;
    stopPrice: number;
    stopDistancePerShare: number;
    stopLossPct: number;
    takeProfitPrice: number;
    qty: number;
    plannedRiskDollars: number;
    estimatedNotional: number;
};

export const MIN_QTY = 0.0001;
export const MIN_SCORE = 0.0000001;

function areEqualAtExecutionPrecision(a: number, b: number): boolean {
    return Number(a.toFixed(2)) === Number(b.toFixed(2));
}

export function sumVolume(bars: Bar[]): number {
    return bars.reduce((sum, bar) => sum + bar.volume, 0);
}

export function computeCandidateScore(params: {
    bars: Bar[];
    breakoutSide: 'buy' | 'sell';
    latestClose: number;
    openingRangeHigh: number;
    openingRangeLow: number;
}): {
    score: number;
    relativeBreakPct: number;
    totalVolume: number;
} {
    const { bars, breakoutSide, latestClose, openingRangeHigh, openingRangeLow } = params;

    const totalVolume = sumVolume(bars);
    const breakoutReference = breakoutSide === 'buy' ? openingRangeHigh : openingRangeLow;
    const relativeBreakPct =
        Math.abs((latestClose - breakoutReference) / breakoutReference) * 100;

    const volumeScore = Math.log10(Math.max(totalVolume, 1));
    const score = relativeBreakPct * volumeScore;

    return {
        score,
        relativeBreakPct,
        totalVolume,
    };
}

export function rankAndSelectCandidates(
    candidates: BreakoutCandidate[],
    maxPositionsPerSide = 10
) {
    const longs = candidates
        .filter((c) => c.side === 'buy')
        .sort((a, b) => b.score - a.score)
        .slice(0, maxPositionsPerSide);

    const shorts = candidates
        .filter((c) => c.side === 'sell')
        .sort((a, b) => b.score - a.score)
        .slice(0, maxPositionsPerSide);

    return { longs, shorts };
}

function applyScale(trade: SizedTrade, scale: number): SizedTrade | null {
    const scaledQty = trade.qty * scale;
    if (scaledQty < MIN_QTY) return null;

    const roundedQty = Math.floor(scaledQty * 10_000) / 10_000;
    if (roundedQty < MIN_QTY) return null;

    const plannedRiskDollars = roundedQty * trade.stopDistancePerShare;
    const estimatedNotional = roundedQty * trade.price;

    return {
        ...trade,
        qty: roundedQty,
        assignedRiskDollars: plannedRiskDollars,
        plannedRiskDollars,
        estimatedNotional,
    };
}

export function buildWeightedRiskTrades(
    candidates: BreakoutCandidate[],
    maxTotalRisk: number,
    takeProfitMultiple = 4
): SizedTrade[] {
    const positiveScoreCandidates = candidates.filter((c) => c.score > MIN_SCORE);
    if (!positiveScoreCandidates.length) return [];

    const totalScore = positiveScoreCandidates.reduce((sum, c) => sum + c.score, 0);
    if (totalScore <= 0) return [];

    return positiveScoreCandidates
        .map((candidate) => {
            const assignedRiskDollars = maxTotalRisk * (candidate.score / totalScore);

            const wickAnchoredStopPrice = candidate.preBreakoutWickPrice;

            const minStopBound = candidate.side === 'buy'
                ? candidate.price - candidate.price * env.minStopPct
                : candidate.price + candidate.price * env.minStopPct;

            const stopPrice = wickAnchoredStopPrice != null
                ? candidate.side === 'buy'
                    ? Math.min(wickAnchoredStopPrice, minStopBound)
                    : Math.max(wickAnchoredStopPrice, minStopBound)
                : candidate.side === 'buy'
                    ? Math.min(
                        candidate.openingRangeLow,
                        candidate.price - (candidate.atr1m ?? 0) * env.atrStopMultiple,
                        minStopBound
                    )
                    : Math.max(
                        candidate.openingRangeHigh,
                        candidate.price + (candidate.atr1m ?? 0) * env.atrStopMultiple,
                        minStopBound
                    );

            const stopDistancePerShare =
                candidate.side === 'buy'
                    ? candidate.price - stopPrice
                    : stopPrice - candidate.price;
            if (stopDistancePerShare <= 0) return null;
            if (areEqualAtExecutionPrecision(candidate.price, stopPrice)) return null;

            const qty = assignedRiskDollars / stopDistancePerShare;
            if (qty < MIN_QTY) return null;

            const takeProfitPrice =
                candidate.side === 'buy'
                    ? candidate.price + takeProfitMultiple * stopDistancePerShare
                    : candidate.price - takeProfitMultiple * stopDistancePerShare;

            const plannedRiskDollars = qty * stopDistancePerShare;
            const estimatedNotional = qty * candidate.price;
            const stopLossPct = stopDistancePerShare / candidate.price;

            return {
                ...candidate,
                assignedRiskDollars,
                stopPrice,
                stopDistancePerShare,
                stopLossPct,
                takeProfitPrice,
                qty,
                plannedRiskDollars,
                estimatedNotional,
            };
        })
        .filter((x): x is SizedTrade => x !== null);
}

export function normalizeTradesToConstraints(
    trades: SizedTrade[],
    maxTotalRisk: number,
    availableBuyingPower: number,
    maxPositionNotional = Number.POSITIVE_INFINITY
): SizedTrade[] {
    if (!trades.length) return [];

    const individuallyCappedTrades = trades
        .map((trade) => {
            if (!Number.isFinite(maxPositionNotional) || maxPositionNotional <= 0) {
                return trade;
            }

            const perTradeScale = Math.min(1, maxPositionNotional / trade.estimatedNotional);
            return applyScale(trade, perTradeScale);
        })
        .filter((x): x is SizedTrade => x !== null);

    if (!individuallyCappedTrades.length) return [];

    const totalPlannedRisk = individuallyCappedTrades.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
    const totalEstimatedNotional = individuallyCappedTrades.reduce((sum, t) => sum + t.estimatedNotional, 0);

    if (totalPlannedRisk <= 0 || totalEstimatedNotional <= 0) return [];

    const riskScale = maxTotalRisk / totalPlannedRisk;
    const buyingPowerScale = availableBuyingPower / totalEstimatedNotional;
    const finalScale = Math.min(1, riskScale, buyingPowerScale);

    return individuallyCappedTrades
        .map((trade) => applyScale(trade, finalScale))
        .filter((x): x is SizedTrade => x !== null);
}