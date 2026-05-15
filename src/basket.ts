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
};

export type SizedTrade = BreakoutCandidate & {
    assignedRiskDollars: number;
    stopPrice: number;
    stopDistancePerShare: number;
    takeProfitPrice: number;
    qty: number;
    plannedRiskDollars: number;
    estimatedNotional: number;
};

export const MIN_QTY = 0.0001;
export const MIN_SCORE = 0.0000001;

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

export function rankAndSelectCandidates(candidates: BreakoutCandidate[]) {
    const longs = candidates
        .filter((c) => c.side === 'buy')
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    const shorts = candidates
        .filter((c) => c.side === 'sell')
        .sort((a, b) => b.score - a.score)
        .slice(0, 10);

    return { longs, shorts };
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

            const stopPrice =
                candidate.side === 'buy'
                    ? candidate.openingRangeLow
                    : candidate.openingRangeHigh;

            const stopDistancePerShare = Math.abs(candidate.price - stopPrice);
            if (stopDistancePerShare <= 0) return null;

            const qty = assignedRiskDollars / stopDistancePerShare;
            if (qty < MIN_QTY) return null;

            const takeProfitPrice =
                candidate.side === 'buy'
                    ? candidate.price + takeProfitMultiple * stopDistancePerShare
                    : candidate.price - takeProfitMultiple * stopDistancePerShare;

            const plannedRiskDollars = qty * stopDistancePerShare;
            const estimatedNotional = qty * candidate.price;

            return {
                ...candidate,
                assignedRiskDollars,
                stopPrice,
                stopDistancePerShare,
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
    availableBuyingPower: number
): SizedTrade[] {
    if (!trades.length) return [];

    const totalPlannedRisk = trades.reduce((sum, t) => sum + t.plannedRiskDollars, 0);
    const totalEstimatedNotional = trades.reduce((sum, t) => sum + t.estimatedNotional, 0);

    if (totalPlannedRisk <= 0 || totalEstimatedNotional <= 0) return [];

    const riskScale = maxTotalRisk / totalPlannedRisk;
    const buyingPowerScale = availableBuyingPower / totalEstimatedNotional;
    const finalScale = Math.min(1, riskScale, buyingPowerScale);

    return trades
        .map((trade) => {
            const scaledQty = trade.qty * finalScale;
            if (scaledQty < MIN_QTY) return null;

            const roundedQty = Number(scaledQty.toFixed(4));
            const plannedRiskDollars = roundedQty * trade.stopDistancePerShare;
            const estimatedNotional = roundedQty * trade.price;

            return {
                ...trade,
                qty: roundedQty,
                assignedRiskDollars: plannedRiskDollars,
                plannedRiskDollars,
                estimatedNotional,
            };
        })
        .filter((x): x is SizedTrade => x !== null);
}