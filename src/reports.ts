import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer";
import { AlpacaClient } from "./alpaca";
import {
    BreakoutCandidate,
    SizedTrade,
    buildWeightedRiskTrades,
    computeCandidateScore,
    normalizeTradesToConstraints,
} from "./basket";
import { env, strategyConfig } from "./config";
import { logger } from "./logger";
import { Bar } from "./types";
import { toNyParts } from "./time";

export type ExitStatus = "profit" | "loss" | "pending";

export type TradeOutcome = {
    symbol: string;
    side: "buy" | "sell";
    entryPrice: number;
    stopPrice: number;
    takeProfitPrice: number;
    qty: number;
    status: ExitStatus;
    exitPrice: number | null;
    pnl: number;
};

export type AtrBreakoutCandidate = BreakoutCandidate & {
    atr1m: number;
};

export type OrbEvaluationRow = {
    symbol: string;
    openingPrice: number;
    openingRangeHigh: number;
    openingRangeLow: number;
    breakoutPrice: number | null;
    breakoutTimestamp: string | null;
    confirmationRetestPrice: number | null;
    confirmationRetestTimestamp: string | null;
    atr1m: number | null;
    side: "buy" | "sell" | "none";
};

export type OrbReportResult = {
    sessionDate: string;
    symbols: string[];
    evaluationRows: OrbEvaluationRow[];
    breakoutCandidates: AtrBreakoutCandidate[];
    emulatedTrades: SizedTrade[];
    htmlReportPath: string;
    pdfReportPath: string;
    maxSessionBars: number;
    insufficientSymbols: string[];
    totalCandidatesBoughtAtStart: number;
    numberOfCandidatesSoldLong: number;
    numberOfCandidatesBoughtShort: number;
    totalCostOfBreakoutCandidatePurchases: number;
    totalAmountOfCashAtStopLossRisk: number;
    totalProfitLossToDate: number;
};

export class Reports {
    public static buildReportSubtitle(
        sessionDate: string,
        usesHistoricData = false,
    ): string {
        const dataSourcePhrase = usesHistoricData
            ? "using historic data from"
            : "using";
        return `ORB activity for the New York session on ${Reports.escapeHtml(sessionDate)} ${dataSourcePhrase} the first 15 minutes for the opening range and the following 15 minutes for breakout detection, then managing positions until market close.`;
    }

    private static escapeHtml(text: string): string {
        return text
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#39;");
    }

    private static writeHtmlReport(filePath: string, html: string) {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, html, "utf8");
    }

    private static async renderHtmlToPdf(htmlPath: string, pdfPath: string) {
        const browser = await puppeteer.launch({
            headless: true,
            args: ["--no-sandbox", "--disable-setuid-sandbox"],
        });

        try {
            const page = await browser.newPage();
            await page.goto(`file://${htmlPath}`, { waitUntil: "networkidle0" });
            await page.pdf({
                path: pdfPath,
                format: "A4",
                landscape: true,
                printBackground: true,
                margin: {
                    top: "0.5in",
                    right: "0.5in",
                    bottom: "0.5in",
                    left: "0.5in",
                },
            });
        } finally {
            await browser.close();
        }
    }

    private static dedupeAndSortBars(bars: Bar[]): Bar[] {
        const byTimestamp = new Map<string, Bar>();
        for (const bar of bars) {
            byTimestamp.set(bar.timestamp, bar);
        }

        return [...byTimestamp.values()].sort(
            (a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );
    }

    private static formatNyTime(timestamp: string | null): string {
        if (!timestamp) {
            return "";
        }

        return toNyParts(timestamp, strategyConfig.sessionTimezone).hhmm;
    }

    private static calculateAtr1m(bars: Bar[], period = 14): number | null {
        if (bars.length < 2) {
            return null;
        }

        const sortedBars = [...bars].sort(
            (a, b) =>
                new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime(),
        );

        const trueRanges: number[] = [];
        for (let index = 1; index < sortedBars.length; index++) {
            const current = sortedBars[index];
            const previous = sortedBars[index - 1];
            const rangeHighLow = current.high - current.low;
            const rangeHighPrevClose = Math.abs(current.high - previous.close);
            const rangeLowPrevClose = Math.abs(current.low - previous.close);
            trueRanges.push(
                Math.max(rangeHighLow, rangeHighPrevClose, rangeLowPrevClose),
            );
        }

        const atrWindow = trueRanges.slice(-period);
        if (atrWindow.length === 0) {
            return null;
        }

        const atr =
            atrWindow.reduce((sum, value) => sum + value, 0) / atrWindow.length;
        return atr > 0 ? atr : null;
    }

    private static emulateExit(
        trade: SizedTrade,
        barsAfterEntry: Bar[],
    ): TradeOutcome {
        for (const bar of barsAfterEntry) {
            if (trade.side === "buy") {
                const stopHit = bar.low <= trade.stopPrice;
                const tpHit = bar.high >= trade.takeProfitPrice;

                if (stopHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "loss",
                        exitPrice: trade.stopPrice,
                        pnl: (trade.stopPrice - trade.price) * trade.qty,
                    };
                }

                if (tpHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "profit",
                        exitPrice: trade.takeProfitPrice,
                        pnl: (trade.takeProfitPrice - trade.price) * trade.qty,
                    };
                }
            } else {
                const stopHit = bar.high >= trade.stopPrice;
                const tpHit = bar.low <= trade.takeProfitPrice;

                if (stopHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "loss",
                        exitPrice: trade.stopPrice,
                        pnl: (trade.price - trade.stopPrice) * trade.qty,
                    };
                }

                if (tpHit) {
                    return {
                        symbol: trade.symbol,
                        side: trade.side,
                        entryPrice: trade.price,
                        stopPrice: trade.stopPrice,
                        takeProfitPrice: trade.takeProfitPrice,
                        qty: trade.qty,
                        status: "profit",
                        exitPrice: trade.takeProfitPrice,
                        pnl: (trade.price - trade.takeProfitPrice) * trade.qty,
                    };
                }
            }
        }

        return {
            symbol: trade.symbol,
            side: trade.side,
            entryPrice: trade.price,
            stopPrice: trade.stopPrice,
            takeProfitPrice: trade.takeProfitPrice,
            qty: trade.qty,
            status: "pending",
            exitPrice: null,
            pnl: 0,
        };
    }

    public static async generateOrbReport(
        client: AlpacaClient,
        sessionDate: string,
        options?: { usesHistoricData?: boolean },
    ): Promise<OrbReportResult> {
        const symbols = await client.getMostActiveSymbols(env.quantityToRetrieve);
        const reportDir = path.resolve(process.cwd(), "reports");
        const htmlReportDir = path.resolve(reportDir, "html", sessionDate);
        fs.mkdirSync(reportDir, { recursive: true });
        const htmlReportPath = path.join(htmlReportDir, `orb-report-${sessionDate}.html`);
        const pdfSourceHtmlPath = path.join(reportDir, `orb-report-${sessionDate}.html`);
        const pdfReportPath = path.join(reportDir, `orb-report-${sessionDate}.pdf`);

        logger.info("Generating ORB report", {
            sessionDate,
            symbolCount: symbols.length,
        });

        const openingRangeBars = 15;
        const evaluationWindowBars = 15;
        const evaluationRows: OrbEvaluationRow[] = [];
        const breakoutCandidates: AtrBreakoutCandidate[] = [];
        const insufficientSymbols: string[] = [];

        const barResults = await Promise.all(
            symbols.map(async (symbol) => {
                try {
                    const bars = await client.getIntradayBars(symbol, sessionDate);
                    return { symbol, bars: Reports.dedupeAndSortBars(bars) };
                } catch (error) {
                    logger.warn("Failed loading bars for ORB report", {
                        symbol,
                        sessionDate,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return { symbol, bars: [] as Bar[] };
                }
            }),
        );

        const sessionBarCounts = barResults.map(
            ({ bars }) =>
                bars.filter(
                    (bar) =>
                        toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                        sessionDate,
                ).length,
        );
        const maxSessionBars =
            sessionBarCounts.length > 0 ? Math.max(...sessionBarCounts) : 0;

        for (const { symbol, bars } of barResults) {
            const sessionBars = bars.filter(
                (bar) =>
                    toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                    sessionDate,
            );

            if (sessionBars.length < openingRangeBars + evaluationWindowBars) {
                insufficientSymbols.push(symbol);
                continue;
            }

            const openingBars = sessionBars.slice(0, openingRangeBars);
            const openingPrice = openingBars[0].open;
            const openingRangeHigh = Math.max(...openingBars.map((bar) => bar.high));
            const openingRangeLow = Math.min(...openingBars.map((bar) => bar.low));
            const evaluationBars = sessionBars.slice(
                openingRangeBars,
                openingRangeBars + evaluationWindowBars,
            );

            let breakoutBar: Bar | null = null;
            let confirmationRetestBar: Bar | null = null;
            let side: "buy" | "sell" | "none" = "none";
            let preBreakoutWickPrice: number | null = null;

            for (const evaluationBar of evaluationBars) {
                if (evaluationBar.close > openingRangeHigh) {
                    breakoutBar = evaluationBar;
                    side = "buy";
                    break;
                }

                if (evaluationBar.close < openingRangeLow) {
                    breakoutBar = evaluationBar;
                    side = "sell";
                    break;
                }
            }

            if (breakoutBar && side !== "none") {
                const breakoutIndex = sessionBars.findIndex(
                    (bar) => bar.timestamp === breakoutBar.timestamp,
                );
                const preBreakoutBar = breakoutIndex > 0 ? sessionBars[breakoutIndex - 1] : null;
                preBreakoutWickPrice = preBreakoutBar
                    ? side === "buy"
                        ? preBreakoutBar.high
                        : preBreakoutBar.low
                    : null;

                const postBreakoutBars = sessionBars.filter(
                    (bar) =>
                        new Date(bar.timestamp).getTime() >
                        new Date(breakoutBar.timestamp).getTime(),
                );

                for (const retestBar of postBreakoutBars) {
                    if (
                        side === "buy" &&
                        retestBar.low <= openingRangeHigh &&
                        retestBar.close > openingRangeHigh
                    ) {
                        confirmationRetestBar = retestBar;
                        break;
                    }

                    if (
                        side === "sell" &&
                        retestBar.high >= openingRangeLow &&
                        retestBar.close < openingRangeLow
                    ) {
                        confirmationRetestBar = retestBar;
                        break;
                    }
                }
            }

            const atrSourceBars = confirmationRetestBar
                ? sessionBars.filter(
                    (bar) =>
                        new Date(bar.timestamp).getTime() <=
                        new Date(confirmationRetestBar.timestamp).getTime(),
                )
                : sessionBars;
            const atr1m = Reports.calculateAtr1m(atrSourceBars, 14);

            evaluationRows.push({
                symbol,
                openingPrice: Number(openingPrice.toFixed(2)),
                openingRangeHigh: Number(openingRangeHigh.toFixed(2)),
                openingRangeLow: Number(openingRangeLow.toFixed(2)),
                breakoutPrice: breakoutBar
                    ? Number(breakoutBar.close.toFixed(2))
                    : null,
                breakoutTimestamp: breakoutBar ? breakoutBar.timestamp : null,
                confirmationRetestPrice: confirmationRetestBar
                    ? Number(confirmationRetestBar.close.toFixed(2))
                    : null,
                confirmationRetestTimestamp: confirmationRetestBar
                    ? confirmationRetestBar.timestamp
                    : null,
                atr1m: atr1m ? Number(atr1m.toFixed(4)) : null,
                side,
            });

            if (side === "none" || !confirmationRetestBar || !atr1m) {
                continue;
            }

            const scoreMetrics = computeCandidateScore({
                bars: sessionBars,
                breakoutSide: side,
                latestClose: confirmationRetestBar.close,
                openingRangeHigh,
                openingRangeLow,
            });

            breakoutCandidates.push({
                symbol,
                side,
                price: confirmationRetestBar.close,
                reason: `post-opening-range ${side === "buy" ? "upside" : "downside"} breakout`,
                score: scoreMetrics.score,
                relativeBreakPct: scoreMetrics.relativeBreakPct,
                totalVolume: scoreMetrics.totalVolume,
                openingRangeHigh,
                openingRangeLow,
                preBreakoutWickPrice: preBreakoutWickPrice ?? undefined,
                atr1m,
            });
        }

        const atrSizedTrades = buildWeightedRiskTrades(
            breakoutCandidates,
            env.maxTotalRisk,
            env.takeProfitMultiple,
        );
        const emulatedTrades = normalizeTradesToConstraints(
            atrSizedTrades,
            env.maxTotalRisk,
            env.hardBasketCap,
            env.maxPositionNotional,
        );
        const tradeBySymbol = new Map(
            emulatedTrades.map((trade) => [trade.symbol, trade]),
        );
        const sessionBarsBySymbol = new Map<string, Bar[]>();

        for (const { symbol, bars } of barResults) {
            const sessionBars = bars.filter(
                (bar) =>
                    toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date ===
                    sessionDate,
            );
            if (sessionBars.length === 0) continue;
            sessionBarsBySymbol.set(symbol, sessionBars);
        }

        const totalCandidatesBoughtAtStart = emulatedTrades.length;
        const numberOfCandidatesSoldLong = emulatedTrades.filter(
            (trade) => trade.side === "buy",
        ).length;
        const numberOfCandidatesBoughtShort = emulatedTrades.filter(
            (trade) => trade.side === "sell",
        ).length;
        const totalCostOfBreakoutCandidatePurchases = emulatedTrades.reduce(
            (sum, trade) => sum + trade.estimatedNotional,
            0,
        );
        const totalAmountOfCashAtStopLossRisk = emulatedTrades.reduce(
            (sum, trade) => sum + trade.plannedRiskDollars,
            0,
        );
        const closedOutcomeBySymbol = new Map<string, TradeOutcome>();
        const finalOutcomeBySymbol = new Map<string, TradeOutcome>();

        evaluationRows.forEach((row) => {
            const trade = tradeBySymbol.get(row.symbol);
            if (!trade || !row.confirmationRetestTimestamp) return;

            const sessionBars = sessionBarsBySymbol.get(row.symbol) ?? [];
            const barsAfterEntry = sessionBars.filter(
                (bar) =>
                    new Date(bar.timestamp).getTime() >
                    new Date(row.confirmationRetestTimestamp!).getTime(),
            );

            const outcome = Reports.emulateExit(trade, barsAfterEntry);
            if (outcome.status !== "pending") {
                closedOutcomeBySymbol.set(row.symbol, outcome);
                finalOutcomeBySymbol.set(row.symbol, outcome);
                return;
            }

            const finalBar = sessionBars[sessionBars.length - 1];
            if (!finalBar) return;

            const pnlAtClose =
                trade.side === "buy"
                    ? (finalBar.close - trade.price) * trade.qty
                    : (trade.price - finalBar.close) * trade.qty;

            finalOutcomeBySymbol.set(row.symbol, {
                symbol: trade.symbol,
                side: trade.side,
                entryPrice: trade.price,
                stopPrice: trade.stopPrice,
                takeProfitPrice: trade.takeProfitPrice,
                qty: trade.qty,
                status: "pending",
                exitPrice: finalBar.close,
                pnl: pnlAtClose,
            });
        });

        const totalProfitLossToDate = [...finalOutcomeBySymbol.values()].reduce(
            (sum, outcome) => sum + outcome.pnl,
            0,
        );

        const openingPriceRowsHtml = evaluationRows
            .map(
                (row) => `
                <tr>
                    <td>${Reports.escapeHtml(row.symbol)}</td>
                    <td>${row.openingPrice.toFixed(2)}</td>
                    <td>${row.openingRangeHigh.toFixed(2)}</td>
                    <td>${row.openingRangeLow.toFixed(2)}</td>
                </tr>`,
            )
            .join("");

        const confirmedTradeRowsHtml = emulatedTrades
            .map((trade, index) => {
                const row = evaluationRows.find(
                    (evaluationRow) => evaluationRow.symbol === trade.symbol,
                );
                const closedOutcome = closedOutcomeBySymbol.get(trade.symbol);
                const finalOutcome = finalOutcomeBySymbol.get(trade.symbol);
                const closedProfitLoss = finalOutcome
                    ? finalOutcome.pnl.toFixed(2)
                    : "Open";
                const exitPrice =
                    finalOutcome?.exitPrice != null
                        ? finalOutcome.exitPrice.toFixed(2)
                        : "n/a";
                const exitType = closedOutcome
                    ? "Stop/Target"
                    : finalOutcome
                        ? "Market Close"
                        : "Open";
                const stopDistance =
                    trade.side === "buy"
                        ? trade.price - trade.stopPrice
                        : trade.stopPrice - trade.price;
                const targetDistance =
                    trade.side === "buy"
                        ? trade.takeProfitPrice - trade.price
                        : trade.price - trade.takeProfitPrice;
                const riskMultiple =
                    stopDistance > 0 ? `${(targetDistance / stopDistance).toFixed(2)}R` : "n/a";

                return `
                <tr>
                    <td>${index + 1}</td>
                    <td>${Reports.escapeHtml(trade.symbol)}</td>
                    <td>${trade.qty.toFixed(4)}</td>
                    <td>${Reports.escapeHtml(trade.side)}</td>
                    <td>${row?.breakoutPrice != null ? row.breakoutPrice.toFixed(2) : "n/a"}</td>
                    <td>${Reports.escapeHtml(Reports.formatNyTime(row?.breakoutTimestamp ?? null) || "n/a")}</td>
                    <td>${row?.confirmationRetestPrice != null ? row.confirmationRetestPrice.toFixed(2) : "n/a"}</td>
                    <td>${Reports.escapeHtml(Reports.formatNyTime(row?.confirmationRetestTimestamp ?? null) || "n/a")}</td>
                    <td>${trade.preBreakoutWickPrice != null ? trade.preBreakoutWickPrice.toFixed(2) : "n/a"}</td>
                    <td>${trade.price.toFixed(2)}</td>
                    <td>${trade.stopPrice.toFixed(2)}</td>
                    <td>${trade.takeProfitPrice.toFixed(2)}</td>
                    <td>${riskMultiple}</td>
                    <td>${exitPrice}</td>
                    <td>${closedProfitLoss}</td>
                    <td>${exitType}</td>
                </tr>`;
            })
            .join("");

        const interactiveCandidateCardsHtml = emulatedTrades
            .map((trade) => {
                const row = evaluationRows.find(
                    (evaluationRow) => evaluationRow.symbol === trade.symbol,
                );
                const closedOutcome = closedOutcomeBySymbol.get(trade.symbol);
                const finalOutcome = finalOutcomeBySymbol.get(trade.symbol);
                const exitPrice =
                    finalOutcome?.exitPrice != null
                        ? finalOutcome.exitPrice.toFixed(2)
                        : "n/a";
                const exitType = closedOutcome
                    ? "Stop/Target"
                    : finalOutcome
                        ? "Market Close"
                        : "Open";

                return `
                <details class="candidate-card" id="candidate-${Reports.escapeHtml(trade.symbol)}">
                    <summary class="candidate-summary">
                        <span class="candidate-symbol">${Reports.escapeHtml(trade.symbol)}</span>
                        <span>${Reports.escapeHtml(trade.side)}</span>
                        <span>${trade.qty.toFixed(4)}</span>
                        <span>${trade.price.toFixed(2)}</span>
                        <span>${exitPrice}</span>
                        <span>${finalOutcome ? finalOutcome.pnl.toFixed(2) : "Open"}</span>
                    </summary>
                    <div class="candidate-drilldown">
                        <table class="candidate-drilldown-table">
                            <tbody>
                                <tr><th>Breakout Price</th><td>${row?.breakoutPrice != null ? row.breakoutPrice.toFixed(2) : "n/a"}</td></tr>
                                <tr><th>Breakout Time</th><td>${Reports.escapeHtml(Reports.formatNyTime(row?.breakoutTimestamp ?? null) || "n/a")}</td></tr>
                                <tr><th>Retest Time</th><td>${Reports.escapeHtml(Reports.formatNyTime(row?.confirmationRetestTimestamp ?? null) || "n/a")}</td></tr>
                                <tr><th>Previous Candle Hi/Lo</th><td>${trade.preBreakoutWickPrice != null ? trade.preBreakoutWickPrice.toFixed(2) : "n/a"}</td></tr>
                                <tr><th>Stop</th><td>${trade.stopPrice.toFixed(2)}</td></tr>
                                <tr><th>Target</th><td>${trade.takeProfitPrice.toFixed(2)}</td></tr>
                                <tr><th>Exit Price</th><td>${exitPrice}</td></tr>
                                <tr><th>Exit Type</th><td>${Reports.escapeHtml(exitType)}</td></tr>
                            </tbody>
                        </table>
                    </div>
                </details>`;
            })
            .join("");

        const htmlDrilldownReport = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ORB Drilldown Report ${Reports.escapeHtml(sessionDate)}</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #111827;
            --ink: #f9fafb;
            --muted: #cbd5e1;
            --accent: #34d399;
            --border: rgba(255,255,255,0.12);
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: radial-gradient(circle at top, #1f2937, var(--bg) 60%);
            color: var(--ink);
        }
        .page { max-width: 1280px; margin: 0 auto; padding: 32px 20px 72px; }
        .hero {
            background: linear-gradient(135deg, rgba(52,211,153,0.15), rgba(96,165,250,0.12));
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 24px 60px rgba(0,0,0,0.28);
        }
        h1 { margin: 0; font-size: 42px; letter-spacing: -0.03em; }
        .subtitle { margin: 10px 0 0; color: var(--muted); font-size: 16px; }
        .section {
            margin-top: 24px;
            background: rgba(31,41,55,0.92);
            border: 1px solid var(--border);
            border-radius: 22px;
            padding: 20px;
        }
        h2 { margin: 0 0 10px; font-size: 22px; }
        .summary-table {
            width: 100%;
            border-collapse: collapse;
        }
        .summary-table th,
        .summary-table td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
            text-align: left;
            vertical-align: top;
            font-size: 13px;
        }
        .summary-table th {
            color: var(--muted);
            font-weight: 600;
            width: 55%;
        }
        .summary-table tr:last-child th,
        .summary-table tr:last-child td { border-bottom: none; }
        .candidate-table-head {
            display: grid;
            grid-template-columns: 1.6fr 0.9fr 1fr 1fr 1fr 1fr;
            gap: 10px;
            padding: 0 12px 12px;
            color: var(--muted);
            font-size: 12px;
            text-transform: uppercase;
            letter-spacing: 0.08em;
        }
        .candidate-card {
            border: 1px solid var(--border);
            border-radius: 18px;
            background: linear-gradient(180deg, rgba(36,50,68,0.98), rgba(31,41,55,0.98));
            margin-bottom: 12px;
            overflow: hidden;
        }
        .candidate-summary {
            list-style: none;
            display: grid;
            grid-template-columns: 1.6fr 0.9fr 1fr 1fr 1fr 1fr;
            gap: 10px;
            align-items: center;
            padding: 16px 12px;
            cursor: pointer;
            user-select: none;
        }
        .candidate-summary::-webkit-details-marker { display: none; }
        .candidate-symbol { color: var(--accent); font-weight: 700; letter-spacing: 0.02em; }
        .candidate-drilldown { border-top: 1px solid var(--border); padding: 12px; background: rgba(15,23,42,0.35); }
        .candidate-drilldown-table { width: 100%; border-collapse: collapse; }
        .candidate-drilldown-table th,
        .candidate-drilldown-table td {
            padding: 10px 12px;
            border-bottom: 1px solid var(--border);
            text-align: left;
            vertical-align: top;
            font-size: 13px;
        }
        .candidate-drilldown-table th { width: 240px; color: var(--muted); font-weight: 600; }
        .candidate-drilldown-table tr:last-child th,
        .candidate-drilldown-table tr:last-child td { border-bottom: none; }
        .note { margin-top: 14px; color: var(--muted); font-size: 13px; }
    </style>
</head>
<body>
    <main class="page">
        <section class="hero">
            <h1>ORB Drilldown Report</h1>
            <p class="subtitle">${Reports.buildReportSubtitle(sessionDate, options?.usesHistoricData === true)}</p>
        </section>

        <section class="section">
            <h2>Summary</h2>
            <table class="summary-table">
                <tbody>
                    <tr><th>Total Number of Candidates Bought at Start</th><td>${totalCandidatesBoughtAtStart}</td></tr>
                    <tr><th>Number of Candidates Sold Long</th><td>${numberOfCandidatesSoldLong}</td></tr>
                    <tr><th>Number of Candidates Bought Short</th><td>${numberOfCandidatesBoughtShort}</td></tr>
                    <tr><th>Total cost of Breakout Candidate purchases</th><td>${totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td></tr>
                    <tr><th>Total amount of cash at stop loss risk</th><td>${totalAmountOfCashAtStopLossRisk.toFixed(2)}</td></tr>
                    <tr><th>Stop Loss Profit Ratio</th><td>${Reports.escapeHtml(env.stopLossProfitRatio)}</td></tr>
                    <tr><th>Total Profit (Loss) to Date</th><td>${totalProfitLossToDate.toFixed(2)}</td></tr>
                </tbody>
            </table>
        </section>

        <section class="section">
            <h2>Breakout Candidates</h2>
            <div class="candidate-table-head">
                <div>Symbol</div>
                <div>Side</div>
                <div>Num of Shares Bought</div>
                <div>Entry Price</div>
                <div>Exit Price</div>
                <div>Profit (Loss)</div>
            </div>
            ${interactiveCandidateCardsHtml}
            <div class="note">Click a symbol row to drill into the breakout, retest, stop, target, and exit data for that symbol.</div>
        </section>
    </main>
</body>
</html>`;

        const htmlReport = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ORB Verification Report ${Reports.escapeHtml(sessionDate)}</title>
    <style>
        :root {
            color-scheme: light;
            --bg: #f5efe5;
            --panel: #fffaf2;
            --ink: #1f2937;
            --muted: #6b7280;
            --accent: #0f766e;
            --accent-soft: #d9f3ee;
            --border: #e7dcc8;
            --warn: #9a3412;
        }
        * { box-sizing: border-box; }
        body {
            margin: 0;
            font-family: Georgia, 'Times New Roman', serif;
            background: linear-gradient(180deg, #efe4d2 0%, var(--bg) 35%, #f9f4ec 100%);
            color: var(--ink);
        }
        .page {
            max-width: 1200px;
            margin: 0 auto;
            padding: 40px 24px 64px;
        }
        .hero {
            background: radial-gradient(circle at top left, #fff6e7, var(--panel));
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 28px;
            box-shadow: 0 18px 60px rgba(31, 41, 55, 0.08);
        }
        .eyebrow {
            margin: 0 0 8px;
            font-size: 12px;
            letter-spacing: 0.18em;
            text-transform: uppercase;
            color: var(--accent);
        }
        h1 {
            margin: 0;
            font-size: 42px;
            line-height: 1.05;
        }
        .subtitle {
            margin: 12px 0 0;
            font-size: 17px;
            color: var(--muted);
        }
        .metrics {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 14px;
            margin-top: 24px;
        }
        .metric {
            background: var(--accent-soft);
            border-radius: 18px;
            padding: 16px 18px;
        }
        .metric-label {
            font-size: 12px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
            color: var(--muted);
        }
        .metric-value {
            display: block;
            margin-top: 6px;
            font-size: 28px;
            font-weight: 700;
            color: var(--accent);
        }
        .section {
            margin-top: 28px;
            background: var(--panel);
            border: 1px solid var(--border);
            border-radius: 24px;
            padding: 24px;
            box-shadow: 0 12px 40px rgba(31, 41, 55, 0.05);
        }
        h2 {
            margin: 0 0 6px;
            font-size: 24px;
        }
        .section-copy {
            margin: 0 0 18px;
            color: var(--muted);
        }
        table {
            width: 100%;
            border-collapse: collapse;
            overflow: hidden;
            border-radius: 16px;
            table-layout: fixed;
        }
        thead th {
            background: #f1e6d7;
            color: #3f3f46;
            font-size: 10px;
            letter-spacing: 0.08em;
            text-transform: uppercase;
        }
        th, td {
            padding: 8px 8px;
            border-bottom: 1px solid var(--border);
            text-align: left;
            vertical-align: top;
            font-size: 10px;
            line-height: 1.2;
            word-break: break-word;
        }
        tbody tr:nth-child(even) {
            background: #fffcf7;
        }
        .note {
            margin-top: 14px;
            padding: 14px 16px;
            border-radius: 16px;
            background: #fff4ed;
            color: var(--warn);
        }
    </style>
</head>
<body>
    <main class="page">
        <section class="hero">
            <p class=\"eyebrow\">Orbilicious Report for ${Reports.escapeHtml(sessionDate)}</p>
            <h1>Opening Range Breakout</h1>
            <p class=\"subtitle\">${Reports.buildReportSubtitle(sessionDate, options?.usesHistoricData === true)}</p>
            <div class="metrics">
                <div class="metric"><span class="metric-label">Symbols Requested</span><span class="metric-value">${env.quantityToRetrieve}</span></div>
                <div class="metric"><span class="metric-label">Symbols Received</span><span class="metric-value">${symbols.length}</span></div>
                <div class="metric"><span class="metric-label">Max Session Bars</span><span class="metric-value">${maxSessionBars}</span></div>
                <div class="metric"><span class="metric-label">Confirmed Candidates</span><span class="metric-value">${breakoutCandidates.length}</span></div>
                <div class="metric"><span class="metric-label">Emulated Trades</span><span class="metric-value">${emulatedTrades.length}</span></div>
            </div>
        </section>

        <section class="section">
            <h2>Opening Prices</h2>
            <p class="section-copy">Each most-active symbol with its market opening price and the derived opening-range high and low.</p>
            <table>
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Open</th>
                        <th>15 Min High</th>
                        <th>15 Min Low</th>
                    </tr>
                </thead>
                <tbody>${openingPriceRowsHtml}</tbody>
            </table>
        </section>

        <section class="section">
            <h2>Summary</h2>
            <p class="section-copy">Current run summary based on emulated ORB entries and latest available session prices.</p>
            <table>
                <thead>
                    <tr>
                        <th>Metric</th>
                        <th>Value</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td>Total Number of Candidates Bought at Start</td><td>${totalCandidatesBoughtAtStart}</td></tr>
                    <tr><td>Number of Candidates Sold Long</td><td>${numberOfCandidatesSoldLong}</td></tr>
                    <tr><td>Number of Candidates Bought Short</td><td>${numberOfCandidatesBoughtShort}</td></tr>
                    <tr><td>Total cost of Breakout Candidate purchases</td><td>${totalCostOfBreakoutCandidatePurchases.toFixed(2)}</td></tr>
                    <tr><td>Total amount of cash at stop loss risk</td><td>${totalAmountOfCashAtStopLossRisk.toFixed(2)}</td></tr>
                    <tr><td>Stop Loss Profit Ratio</td><td>${Reports.escapeHtml(env.stopLossProfitRatio)}</td></tr>
                    <tr><td>Total Profit (Loss) to Date</td><td>${totalProfitLossToDate.toFixed(2)}</td></tr>
                </tbody>
            </table>
        </section>

        <section class="section">
            <h2>Breakout Candidates</h2>
            <p class="section-copy">Detected breakout symbols, breakout timing, retest confirmation timing, and emulated entry/exit details from the current risk algorithm.</p>
            <table>
                <thead>
                    <tr>
                        <th>#</th>
                        <th>Symbol</th>
                        <th>Number of Shares Bought</th>
                        <th>Side</th>
                        <th>Breakout Price</th>
                        <th>Breakout Time</th>
                        <th>Retest Price</th>
                        <th>Retest Time</th>
                        <th>Previous Candle Hi/Lo</th>
                        <th>Entry</th>
                        <th>Stop</th>
                        <th>Target</th>
                        <th>Risk Multiple</th>
                        <th>Exit Price</th>
                        <th>Profit (Loss)</th>
                        <th>Exit</th>
                    </tr>
                </thead>
                <tbody>${confirmedTradeRowsHtml}</tbody>
            </table>
            <div class="note">
                Symbols with fewer than 30 session bars: <strong>${insufficientSymbols.length}</strong>
                <br />
                ${Reports.escapeHtml(insufficientSymbols.length > 0 ? insufficientSymbols.join(", ") : "None")}
            </div>
        </section>
    </main>
</body>
</html>`;

        Reports.writeHtmlReport(htmlReportPath, htmlDrilldownReport);
        Reports.writeHtmlReport(pdfSourceHtmlPath, htmlReport);
        await Reports.renderHtmlToPdf(pdfSourceHtmlPath, pdfReportPath);
        fs.unlinkSync(pdfSourceHtmlPath);
        logger.info("PDF report written", { sessionDate, pdfReportPath });

        if (maxSessionBars < openingRangeBars + evaluationWindowBars) {
            throw new Error(
                `Session ${sessionDate} has fewer than 30 session bars. Highest session bar count found: ${maxSessionBars}`,
            );
        }

        return {
            sessionDate,
            symbols,
            evaluationRows,
            breakoutCandidates,
            emulatedTrades,
            htmlReportPath,
            pdfReportPath,
            maxSessionBars,
            insufficientSymbols,
            totalCandidatesBoughtAtStart,
            numberOfCandidatesSoldLong,
            numberOfCandidatesBoughtShort,
            totalCostOfBreakoutCandidatePurchases,
            totalAmountOfCashAtStopLossRisk,
            totalProfitLossToDate,
        };
    }
}
