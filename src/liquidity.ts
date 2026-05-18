import { strategyConfig } from './config';
import { toNyParts } from './time';
import { Bar } from './types';

export type LiquidityZoneType = 'swing-high' | 'swing-low' | 'volume-node';

type LiquidityCandidate = {
    type: LiquidityZoneType;
    level: number;
    weight: number;
    tolerance: number;
    timestamp: string;
};

type LiquidityCluster = {
    candidates: LiquidityCandidate[];
    weightedLevelSum: number;
    totalWeight: number;
    minLevel: number;
    maxLevel: number;
    maxTolerance: number;
};

export type LiquidityZone = {
    symbol: string;
    sessionDate: string;
    zoneType: LiquidityZoneType;
    zoneLow: number;
    zoneHigh: number;
    referencePrice: number;
    strengthScore: number;
    touchCount: number;
    sourceCount: number;
    latestPrice: number;
    nearestPriceDistancePct: number;
    totalVolume: number;
    lastTouchedAt: string | null;
};

export type SymbolLiquiditySnapshot = {
    symbol: string;
    sessionDate: string;
    latestPrice: number;
    totalVolume: number;
    zones: LiquidityZone[];
};

function priceTolerance(price: number): number {
    return Math.max(price * 0.003, 0.05);
}

function weightedLevel(cluster: LiquidityCluster): number {
    return cluster.weightedLevelSum / cluster.totalWeight;
}

function isSwingHigh(bars: Bar[], index: number, lookaround = 2): boolean {
    const bar = bars[index];
    for (let offset = 1; offset <= lookaround; offset += 1) {
        if (!bars[index - offset] || !bars[index + offset]) {
            return false;
        }

        if (bar.high < bars[index - offset].high || bar.high < bars[index + offset].high) {
            return false;
        }
    }

    return true;
}

function isSwingLow(bars: Bar[], index: number, lookaround = 2): boolean {
    const bar = bars[index];
    for (let offset = 1; offset <= lookaround; offset += 1) {
        if (!bars[index - offset] || !bars[index + offset]) {
            return false;
        }

        if (bar.low > bars[index - offset].low || bar.low > bars[index + offset].low) {
            return false;
        }
    }

    return true;
}

function buildCandidates(sessionBars: Bar[]): LiquidityCandidate[] {
    if (sessionBars.length < 5) {
        return [];
    }

    const averageVolume = sessionBars.reduce((sum, bar) => sum + bar.volume, 0) / sessionBars.length;
    const candidates: LiquidityCandidate[] = [];

    for (let index = 2; index < sessionBars.length - 2; index += 1) {
        const bar = sessionBars[index];
        const volumeRatio = averageVolume > 0 ? bar.volume / averageVolume : 1;

        if (isSwingHigh(sessionBars, index)) {
            candidates.push({
                type: 'swing-high',
                level: bar.high,
                weight: 2 + Math.min(2.5, volumeRatio),
                tolerance: priceTolerance(bar.high),
                timestamp: bar.timestamp,
            });
        }

        if (isSwingLow(sessionBars, index)) {
            candidates.push({
                type: 'swing-low',
                level: bar.low,
                weight: 2 + Math.min(2.5, volumeRatio),
                tolerance: priceTolerance(bar.low),
                timestamp: bar.timestamp,
            });
        }

        if (volumeRatio >= 1.8) {
            const level = (bar.high + bar.low + bar.close) / 3;
            candidates.push({
                type: 'volume-node',
                level,
                weight: 1.5 + Math.min(3, volumeRatio),
                tolerance: priceTolerance(level),
                timestamp: bar.timestamp,
            });
        }
    }

    return candidates;
}

function clusterCandidates(candidates: LiquidityCandidate[]): LiquidityCluster[] {
    const sorted = candidates.slice().sort((left, right) => left.level - right.level);
    const clusters: LiquidityCluster[] = [];

    for (const candidate of sorted) {
        const last = clusters[clusters.length - 1];
        const candidateTolerance = candidate.tolerance;

        if (!last) {
            clusters.push({
                candidates: [candidate],
                weightedLevelSum: candidate.level * candidate.weight,
                totalWeight: candidate.weight,
                minLevel: candidate.level,
                maxLevel: candidate.level,
                maxTolerance: candidateTolerance,
            });
            continue;
        }

        const clusterCenter = weightedLevel(last);
        const clusterTolerance = Math.max(last.maxTolerance, candidateTolerance);
        if (Math.abs(candidate.level - clusterCenter) <= clusterTolerance) {
            last.candidates.push(candidate);
            last.weightedLevelSum += candidate.level * candidate.weight;
            last.totalWeight += candidate.weight;
            last.minLevel = Math.min(last.minLevel, candidate.level);
            last.maxLevel = Math.max(last.maxLevel, candidate.level);
            last.maxTolerance = Math.max(last.maxTolerance, candidateTolerance);
            continue;
        }

        clusters.push({
            candidates: [candidate],
            weightedLevelSum: candidate.level * candidate.weight,
            totalWeight: candidate.weight,
            minLevel: candidate.level,
            maxLevel: candidate.level,
            maxTolerance: candidateTolerance,
        });
    }

    return clusters;
}

function dominantZoneType(cluster: LiquidityCluster): LiquidityZoneType {
    const weights = new Map<LiquidityZoneType, number>();
    for (const candidate of cluster.candidates) {
        weights.set(candidate.type, (weights.get(candidate.type) ?? 0) + candidate.weight);
    }

    const ranked = Array.from(weights.entries()).sort((left, right) => right[1] - left[1]);
    return ranked[0]?.[0] ?? 'volume-node';
}

function buildZone(symbol: string, sessionDate: string, sessionBars: Bar[], cluster: LiquidityCluster): LiquidityZone | null {
    const latestBar = sessionBars[sessionBars.length - 1];
    if (!latestBar) {
        return null;
    }

    const referencePrice = weightedLevel(cluster);
    const halfPadding = Math.max(cluster.maxTolerance * 0.45, 0.03);
    const zoneLow = Math.max(0, Math.min(cluster.minLevel, referencePrice) - halfPadding);
    const zoneHigh = Math.max(zoneLow, Math.max(cluster.maxLevel, referencePrice) + halfPadding);
    const barsTouchingZone = sessionBars.filter((bar) => bar.high >= zoneLow && bar.low <= zoneHigh);
    const touchCount = barsTouchingZone.length;
    const lastTouchedAt = barsTouchingZone.length ? barsTouchingZone[barsTouchingZone.length - 1].timestamp : null;
    const sourceCount = cluster.candidates.length;
    const totalVolume = sessionBars.reduce((sum, bar) => sum + bar.volume, 0);
    const latestPrice = latestBar.close;
    const nearestPriceDistancePct = latestPrice > 0
        ? (Math.abs(referencePrice - latestPrice) / latestPrice) * 100
        : 0;
    const typeBonus = dominantZoneType(cluster) === 'volume-node' ? 0.8 : 1.15;
    const rawStrength = (cluster.totalWeight * 2.2) + (touchCount * 1.4) + (sourceCount * 2.5);
    const strengthScore = Number((rawStrength * typeBonus).toFixed(1));

    return {
        symbol,
        sessionDate,
        zoneType: dominantZoneType(cluster),
        zoneLow: Number(zoneLow.toFixed(2)),
        zoneHigh: Number(zoneHigh.toFixed(2)),
        referencePrice: Number(referencePrice.toFixed(2)),
        strengthScore,
        touchCount,
        sourceCount,
        latestPrice: Number(latestPrice.toFixed(2)),
        nearestPriceDistancePct: Number(nearestPriceDistancePct.toFixed(2)),
        totalVolume,
        lastTouchedAt,
    };
}

export function findLiquidityZonesForSymbol(
    symbol: string,
    sessionDate: string,
    bars: Bar[],
    maxZonesPerSymbol = 3,
): SymbolLiquiditySnapshot | null {
    const sessionBars = bars
        .filter((bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate)
        .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());

    if (sessionBars.length < 15) {
        return null;
    }

    const candidates = buildCandidates(sessionBars);
    if (!candidates.length) {
        return null;
    }

    const zones = clusterCandidates(candidates)
        .map((cluster) => buildZone(symbol, sessionDate, sessionBars, cluster))
        .filter((zone): zone is LiquidityZone => zone !== null)
        .filter((zone) => zone.touchCount >= 2)
        .sort((left, right) => {
            if (right.strengthScore !== left.strengthScore) {
                return right.strengthScore - left.strengthScore;
            }

            return left.nearestPriceDistancePct - right.nearestPriceDistancePct;
        })
        .slice(0, maxZonesPerSymbol);

    if (!zones.length) {
        return null;
    }

    const latestPrice = sessionBars[sessionBars.length - 1].close;
    const totalVolume = sessionBars.reduce((sum, bar) => sum + bar.volume, 0);

    return {
        symbol,
        sessionDate,
        latestPrice: Number(latestPrice.toFixed(2)),
        totalVolume,
        zones,
    };
}