import { expect } from 'chai';
import { describe, it } from 'mocha';
import { AlpacaClient } from '../src/alpaca';
import type { Bar } from '../src/types';
import type { SizedTrade } from '../src/basket';
import type { TradeOutcome } from '../src/reports';

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeTimestamp(sessionDate: string, hourEt: number, minuteEt: number) {
    const [year, month, day] = sessionDate.split('-').map(Number);
    const utcHour = hourEt + 4;
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}T${String(utcHour).padStart(2, '0')}:${String(minuteEt).padStart(2, '0')}:00Z`;
}

function makeDeterministicSessionBars(symbol: string, sessionDate: string): Bar[] {
    const bars: Bar[] = [];

    for (let minute = 30; minute <= 44; minute++) {
        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 100,
            high: 101,
            low: 99,
            close: 100,
            volume: 1000,
        });
    }

    for (let minute = 45; minute <= 59; minute++) {
        if (minute === 45) {
            bars.push({
                symbol,
                timestamp: makeTimestamp(sessionDate, 9, minute),
                open: 100.8,
                high: 103,
                low: 100.4,
                close: 102,
                volume: 5000,
            });
            continue;
        }

        bars.push({
            symbol,
            timestamp: makeTimestamp(sessionDate, 9, minute),
            open: 101.4,
            high: 102,
            low: 101.1,
            close: 101.6,
            volume: 2400,
        });
    }

    bars.push({
        symbol,
        timestamp: makeTimestamp(sessionDate, 10, 0),
        open: 101.7,
        high: 102.2,
        low: 100.9,
        close: 101.5,
        volume: 2600,
    });

    return bars;
}

class DeterministicWeekClient extends AlpacaClient {
    private readonly deterministicUniverse = ['SPY', 'QQQ'];

    override async getMostActiveSymbols(limit = 40): Promise<string[]> {
        return this.deterministicUniverse.slice(0, Math.max(1, limit));
    }

    override async getIntradayBars(symbol: string, sessionDate: string): Promise<Bar[]> {
        return makeDeterministicSessionBars(symbol, sessionDate);
    }
}

function removeIfExists(filePath: string) {
    if (require('fs').existsSync(filePath)) {
        require('fs').unlinkSync(filePath);
    }
}

type RunSnapshot = {
    runIndex: number;
    bySession: Record<string, {
        trades: SizedTrade[];
        outcomes: TradeOutcome[];
    }>;
};

describe('runtime determinism', () => {
    it('code runs deterministically', async function () {
        this.timeout(600_000);

        const weekDates = ['2026-05-04', '2026-05-05', '2026-05-06', '2026-05-07', '2026-05-08'];
        const runCount = 3;
        const snapshots: RunSnapshot[] = [];

        for (let run = 0; run < runCount; run++) {
            const client = new DeterministicWeekClient();
            const bySession: RunSnapshot['bySession'] = {};

            for (const sessionDate of weekDates) {
                const result = await client.generateOrbReport(sessionDate, {
                    usesHistoricData: true,
                });

                bySession[sessionDate] = {
                    trades: result.emulatedTrades,
                    outcomes: result.finalOutcomes,
                };

                removeIfExists(result.pdfReportPath);
                removeIfExists(result.htmlReportPath);
            }

            snapshots.push({ runIndex: run, bySession });

            if (run < runCount - 1) {
                await sleep(60_000);
            }
        }

        const reference = snapshots[0];

        for (let run = 1; run < snapshots.length; run++) {
            const current = snapshots[run];
            const diffs: string[] = [];

            for (const sessionDate of weekDates) {
                const refTrades = reference.bySession[sessionDate].trades;
                const curTrades = current.bySession[sessionDate].trades;
                const refOutcomes = reference.bySession[sessionDate].outcomes;
                const curOutcomes = current.bySession[sessionDate].outcomes;

                if (refTrades.length !== curTrades.length) {
                    diffs.push(`${sessionDate}: trade count changed (run0=${refTrades.length}, run${run}=${curTrades.length})`);
                    continue;
                }

                for (let t = 0; t < refTrades.length; t++) {
                    const rt = refTrades[t];
                    const ct = curTrades[t];

                    if (rt.symbol !== ct.symbol) {
                        diffs.push(`${sessionDate} trade[${t}]: symbol changed '${rt.symbol}' -> '${ct.symbol}'`);
                    }
                    if (rt.side !== ct.side) {
                        diffs.push(`${sessionDate} trade[${t}] ${rt.symbol}: side changed '${rt.side}' -> '${ct.side}'`);
                    }
                    if (rt.price !== ct.price) {
                        diffs.push(`${sessionDate} trade[${t}] ${rt.symbol}: entry price changed ${rt.price} -> ${ct.price}`);
                    }
                }

                if (refOutcomes.length !== curOutcomes.length) {
                    diffs.push(`${sessionDate}: outcome count changed (run0=${refOutcomes.length}, run${run}=${curOutcomes.length})`);
                    continue;
                }

                for (let o = 0; o < refOutcomes.length; o++) {
                    const ro = refOutcomes[o];
                    const co = curOutcomes[o];

                    if (ro.symbol !== co.symbol) {
                        diffs.push(`${sessionDate} outcome[${o}]: symbol changed '${ro.symbol}' -> '${co.symbol}'`);
                    }
                    if (ro.exitPrice !== co.exitPrice) {
                        diffs.push(`${sessionDate} outcome[${o}] ${ro.symbol}: exit price changed ${ro.exitPrice} -> ${co.exitPrice}`);
                    }
                    if (ro.pnl !== co.pnl) {
                        diffs.push(`${sessionDate} outcome[${o}] ${ro.symbol}: P&L changed ${ro.pnl} -> ${co.pnl}`);
                    }
                }
            }

            if (diffs.length > 0) {
                const report = `Run ${run} differs from run 0:\n${diffs.join('\n')}`;
                expect.fail(report);
            }
        }
    });
});
