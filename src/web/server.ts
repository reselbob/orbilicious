// Web UI server: HTTP server serving the orbilicious dashboard,
// start/stop/status endpoints, daily-session views, and
// weekly/monthly report rendering.
import fs from 'node:fs';
import path from 'node:path';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import puppeteer from 'puppeteer';
import { env, strategyConfig, APP_VERSION } from '../config';
import { logger } from '../logger';
import { findLiquidityZonesForSymbol } from '../liquidity';
import { OrbService } from '../services/orb-service';
import { toNyParts } from '../time';
import { AlpacaClient, MostActiveSymbolDetail } from '../alpaca';
import {
    compareTradeMonitorEvents,
    loadReplayTradeMonitorEventsFromRecord,
    resolveClosedTradePnl,
    toCanonicalTradeMonitorEvents,
} from './trade-monitor-utils';
import {
    buildDailySymbolCharts,
    type DailySymbolSnapshot,
} from './daily-symbol-snapshots';
import type { Bar } from '../types';

type SessionMode = 'EMULATION' | 'REPLAY' | 'PAPER' | 'LIVE';
type CandidateTradeType = 'LONG' | 'SHORT' | 'LONG_AND_SHORT';

type AppState = {
    isRunning: boolean;
    startedAt: string | null;
    runtimeStatus: string;
    orbUiMessage: string | null;
    continuous: boolean;
    sessionMode: SessionMode;
    emulationSessionDate: string | null;
    moneyInAccount: number | null;
    currentBalance: number | null;
    maxRiskPerSession: number | null;
    stopProfitRewardPart: number | null;
    mostActiveSymbolLimit: number;
    backtestProgress: {
        startSessionDate: string;
        endSessionDate: string;
        totalWeekdaySessions: number;
        processedDates: number;
        skippedDates: number;
        currentSessionDate: string | null;
        completed: boolean;
    } | null;
    pid: number | null;
    lastOutcome: 'never-started' | 'running' | 'completed' | 'failed';
    lastError: string | null;
    realtimeDataFeed: boolean;
    realtimeDataFeedError: boolean;
    initialRealtimeFeedEnabled: boolean;
    candidateTradeType: CandidateTradeType;
    breakoutConfirmationCandleMinutes: number;
    breakoutQualityFiltersEnabled: boolean;
    breakoutMinVolumeExpansion: number;
    breakoutMinRelativeStrengthPct: number;
    breakoutTrendTimeframeMinutes: number;
    breakoutTrendLookbackBars: number;
};

type StartRequest = {
    continuous?: boolean;
    sessionMode?: SessionMode;
    emulationSessionDate?: string;
    moneyInAccount?: number;
    maxRiskPerSession?: number;
    stopProfitRewardPart?: number;
    mostActiveSymbolLimit?: number;
    realTimeData?: boolean;
    candidateTradeType?: CandidateTradeType;
    breakoutConfirmationCandleMinutes?: number;
    breakoutQualityFiltersEnabled?: boolean;
    breakoutMinVolumeExpansion?: number;
    breakoutMinRelativeStrengthPct?: number;
    breakoutTrendTimeframeMinutes?: number;
    breakoutTrendLookbackBars?: number;
};

type ReportKind = 'today' | 'week' | 'month';

type GenerateReportRequest = {
    reportType?: ReportKind;
    anchorDate?: string;
};

type DownloadFormat = 'html' | 'pdf';

type DownloadReportRequest = {
    reportType?: ReportKind;
    anchorDate?: string;
    format?: DownloadFormat;
};

type ActivityLine = {
    id: number;
    timestamp: string;
    stream: 'stdout' | 'stderr' | 'system';
    message: string;
};

type TradeEvent = {
    id: number;
    eventType: 'open' | 'close';
    sessionDate: string;
    timestamp: string;
    symbol: string;
    side: 'buy' | 'sell';
    position: 'long' | 'short';
    qty: number;
    entryPrice?: number;
    stopPrice?: number;
    stopLossPct?: number;
    targetPrice?: number;
    closePrice?: number;
    pnl?: number;
    reason?: string;
};

type CandidateChartCard = {
    symbol: string;
    sessionDate: string;
    side: 'buy' | 'sell';
    position: 'long' | 'short';
    qty: number;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    closePrice: number | null;
    closeTimestamp: string | null;
    svg: string;
    determinationTimestamp: string;
};

type DailySessionRecord = {
    schemaVersion?: number;
    sessionDate: string;
    sessionMode?: string;
    status?: string;
    continuous?: boolean;
    startedAt?: string | null;
    updatedAt?: string;
    strategy?: {
        referenceSymbol?: string;
        symbol?: string;
        openingRangeMinutes?: number;
        candleMinutes?: number;
        allowLong?: boolean;
        allowShort?: boolean;
    };
    breakoutFilters?: {
        breakoutConfirmationCandleMinutes?: number;
        breakoutQualityFiltersEnabled?: boolean;
        breakoutMinVolumeExpansion?: number;
        breakoutMinRelativeStrengthPct?: number;
        breakoutTrendTimeframeMinutes?: number;
        breakoutTrendLookbackBars?: number;
        enabled?: boolean;
        confirmationCandleMinutes?: number;
        minVolumeExpansion?: number;
        minRelativeStrengthPct?: number;
        trendTimeframeMinutes?: number;
        trendLookbackBars?: number;
    };
    artifacts?: {
        htmlReportPath?: string;
        pdfReportPath?: string;
        htmlRelativePath?: string;
        pdfRelativePath?: string;
    };
    totals?: {
        totalCandidatesBoughtAtStart?: number;
        numberOfCandidatesSoldLong?: number;
        numberOfCandidatesBoughtShort?: number;
        totalCostOfBreakoutCandidatePurchases?: number;
        totalAmountOfCashAtStopLossRisk?: number;
        totalProfitLossToDate?: number;
    };
    marketScan?: {
        maxSessionBars?: number;
        candidateTradeType?: string;
        requestedLimit?: number;
        retrievedCount?: number;
    };
    evaluationRows?: Array<{
        symbol: string;
        openingPrice?: number;
        openingRangeHigh?: number;
        openingRangeLow?: number;
        breakoutPrice?: number | null;
        breakoutTimestamp?: string | null;
        confirmationRetestPrice?: number | null;
        confirmationRetestTimestamp?: string | null;
        atr1m?: number | null;
        side?: 'buy' | 'sell' | 'none';
        qualityDetail?: {
            filtersEnabled?: boolean;
            volumeExpansion?: number | null;
            minVolumeExpansion?: number;
            volumeExpansionPassed?: boolean;
            relativeStrengthPct?: number | null;
            minRelativeStrengthPct?: number;
            relativeStrengthPassed?: boolean;
            trendAligned?: boolean | null;
            trendTimeframeMinutes?: number;
            trendLookbackBars?: number;
            trendAlignmentPassed?: boolean;
            passed?: boolean;
            failReason?: string | null;
        } | null;
    }>;
    breakoutCandidates?: Array<{
        symbol: string;
        side?: 'buy' | 'sell';
        price?: number;
        qty?: number;
        stopPrice?: number;
        takeProfitPrice?: number;
        score?: number;
    }>;
    emulatedTrades?: Array<{
        symbol: string;
        side?: 'buy' | 'sell';
        price?: number;
        qty?: number;
        stopPrice?: number;
        stopLossPct?: number;
        takeProfitPrice?: number;
    }>;
    finalOutcomes?: Array<{
        symbol: string;
        side?: 'buy' | 'sell';
        entryPrice?: number;
        stopPrice?: number;
        takeProfitPrice?: number;
        qty?: number;
        status?: string;
        pnl?: number;
        exitPrice?: number | null;
        exitTimestamp?: string | null;
    }>;
    candidateTradeActivity?: Array<{
        symbol: string;
        side?: 'buy' | 'sell';
        position?: 'long' | 'short';
        qty?: number;
        entryPrice?: number;
        stopPrice?: number;
        targetPrice?: number;
        closePrice?: number | null;
        pnl?: number;
        status?: string;
        reason?: string;
        entryTimestamp?: string;
        closeTimestamp?: string | null;
    }> | {
        totalCandidatesBoughtAtStart?: number;
        numberOfCandidatesSoldLong?: number;
        numberOfCandidatesBoughtShort?: number;
        totalCostOfBreakoutCandidatePurchases?: number;
        totalAmountOfCashAtStopLossRisk?: number;
        totalProfitLossToDate?: number;
    };
    mostActiveSymbols?: MostActiveSymbolDetail[];
    mostActiveSymbolCount?: number;
    insufficientSymbols?: string[];
    sessionEvents?: Array<{
        eventId: string;
        eventType: 'open' | 'close';
        sessionDate: string;
        timestamp: string;
        symbol: string;
        side: 'buy' | 'sell';
        position: 'long' | 'short';
        qty: number;
        entryPrice?: number;
        stopPrice?: number;
        stopLossPct?: number;
        targetPrice?: number;
        closePrice?: number;
        pnl?: number;
        reason?: string;
    }>;
    symbolSnapshots?: Record<string, DailySymbolSnapshot>;
    runtimeSnapshot?: {
        runtimeStatus?: string;
        orbUiMessage?: string | null;
        isRunning?: boolean;
        candidateTradeType?: string;
        breakoutConfirmationCandleMinutes?: number;
        breakoutQualityFiltersEnabled?: boolean;
        breakoutMinVolumeExpansion?: number;
        breakoutMinRelativeStrengthPct?: number;
        breakoutTrendTimeframeMinutes?: number;
        breakoutTrendLookbackBars?: number;
    };
    notes?: string[];
};

const DEFAULT_PORT = 8787;
const publicDirCandidates = [
    path.resolve(process.cwd(), 'src', 'web', 'public'),
    path.resolve(__dirname, 'public'),
];
const publicDir = publicDirCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')))
    ?? publicDirCandidates[0];
const reportsDir = path.resolve(process.cwd(), 'reports');
const dailySessionDir = path.resolve(process.cwd(), 'data', 'daily');
const MAX_ACTIVITY_LINES = 600;
const MAX_TRADE_EVENTS = 1000;

const appState: AppState = {
    isRunning: false,
    startedAt: null,
    runtimeStatus: 'Idle',
    orbUiMessage: null,
    continuous: false,
    sessionMode: 'EMULATION',
    emulationSessionDate: null,
    moneyInAccount: null,
    currentBalance: null,
    maxRiskPerSession: null,
    stopProfitRewardPart: null,
    mostActiveSymbolLimit: env.quantityToRetrieve,
    backtestProgress: null,
    pid: null,
    lastOutcome: 'never-started',
    lastError: null,
    realtimeDataFeed: false,
    realtimeDataFeedError: false,
    initialRealtimeFeedEnabled: env.dataFeed === 'sip',
    candidateTradeType: env.candidateTradeType,
    breakoutConfirmationCandleMinutes: env.breakoutConfirmationCandleMinutes,
    breakoutQualityFiltersEnabled: env.breakoutQualityFiltersEnabled,
    breakoutMinVolumeExpansion: env.breakoutMinVolumeExpansion,
    breakoutMinRelativeStrengthPct: env.breakoutMinRelativeStrengthPct,
    breakoutTrendTimeframeMinutes: env.breakoutTrendTimeframeMinutes,
    breakoutTrendLookbackBars: env.breakoutTrendLookbackBars,
};

let appProcess: ChildProcessWithoutNullStreams | null = null;
let activityLines: ActivityLine[] = [];
let nextActivityId = 1;
let tradeEvents: TradeEvent[] = [];
let nextTradeEventId = 1;
let stopRequested = false;
const orbService = new OrbService();
orbService.alpacaClient.useRealtimeFeed = env.dataFeed === 'sip';

function contentTypeFor(filePath: string): string {
    if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
    if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
    if (filePath.endsWith('.svg')) return 'image/svg+xml';
    if (filePath.endsWith('.ico')) return 'image/x-icon';
    if (filePath.endsWith('.png')) return 'image/png';
    if (filePath.endsWith('.pdf')) return 'application/pdf';
    return 'application/octet-stream';
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        'Cache-Control': 'no-store',
    });
    try {
        res.end(body);
    } catch {
        // Client may have disconnected
    }
}

function sendFile(res: ServerResponse, filePath: string, options?: { downloadName?: string }) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
    }

    const stat = fs.statSync(filePath);
    const headers: Record<string, string | number> = {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': stat.size,
    };

    if (options?.downloadName) {
        headers['Content-Disposition'] = `attachment; filename="${options.downloadName.replace(/"/g, '')}"`;
    }

    res.writeHead(200, {
        ...headers,
    });

    fs.createReadStream(filePath).pipe(res);
}

function addActivityLine(stream: 'stdout' | 'stderr' | 'system', message: string) {
    const line = message.trim();
    if (!line) {
        return;
    }

    activityLines.push({
        id: nextActivityId++,
        timestamp: new Date().toISOString(),
        stream,
        message: line,
    });

    if (activityLines.length > MAX_ACTIVITY_LINES) {
        activityLines.splice(0, activityLines.length - MAX_ACTIVITY_LINES);
    }
}

function persistTradeEvent(event: Omit<TradeEvent, 'id'>) {
    const sessionDate = event.sessionDate;
    if (!sessionDate || !isValidSessionDate(sessionDate)) {
        return;
    }

    const existing = readDailySessionRecord(sessionDate);
    if (!existing) {
        return;
    }

    const existingEvents = Array.isArray(existing.sessionEvents) ? existing.sessionEvents : [];
    existing.sessionEvents = [
        ...existingEvents,
        {
            eventId: String(nextTradeEventId - 1),
            eventType: event.eventType as 'open' | 'close',
            sessionDate: event.sessionDate,
            timestamp: event.timestamp,
            symbol: event.symbol,
            side: event.side as 'buy' | 'sell',
            position: event.position as 'long' | 'short',
            qty: event.qty,
            entryPrice: event.entryPrice,
            stopPrice: event.stopPrice,
            stopLossPct: event.stopLossPct,
            targetPrice: event.targetPrice,
            closePrice: event.closePrice,
            pnl: event.pnl,
            reason: event.reason,
        },
    ];

    writeDailySessionRecordAtomic(sessionDate, existing);
}

function addTradeEvent(event: Omit<TradeEvent, 'id'>) {
    tradeEvents.push({
        id: nextTradeEventId++,
        ...event,
    });

    if (tradeEvents.length > MAX_TRADE_EVENTS) {
        tradeEvents.splice(0, tradeEvents.length - MAX_TRADE_EVENTS);
    }

    // Update current balance from realized P&L on trade close
    if (
        event.eventType === 'close' &&
        typeof event.pnl === 'number' &&
        appState.currentBalance !== null
    ) {
        appState.currentBalance += event.pnl;
    }

    persistTradeEvent(event);
}

function isSessionMode(value: string): value is SessionMode {
    return value === 'EMULATION' || value === 'REPLAY' || value === 'PAPER' || value === 'LIVE';
}

function normalizedSessionMode(value: unknown): SessionMode {
    if (typeof value !== 'string') {
        return 'EMULATION';
    }

    const normalized = value.toUpperCase();
    if (isSessionMode(normalized)) {
        return normalized;
    }

    return 'EMULATION';
}

function isCandidateTradeType(value: string): value is CandidateTradeType {
    return value === 'LONG' || value === 'SHORT' || value === 'LONG_AND_SHORT';
}

function normalizedCandidateTradeType(
    value: unknown,
    fallback: CandidateTradeType = env.candidateTradeType,
): CandidateTradeType {
    if (typeof value !== 'string') {
        return fallback;
    }

    const normalized = value.toUpperCase();
    if (isCandidateTradeType(normalized)) {
        return normalized;
    }

    return fallback;
}

function normalizedPositiveNumber(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }

    return Math.min(max, Math.max(min, value));
}

function normalizedPositiveInteger(value: unknown, fallback: number, min: number, max: number): number {
    const normalized = normalizedPositiveNumber(value, fallback, min, max);
    return Math.floor(normalized);
}

function isValidSessionDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const parsed = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }

    const todayIso = toNyParts(new Date(), strategyConfig.sessionTimezone).date;

    return value <= todayIso;
}

function isNyMarketOpenNow(): boolean {
    const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dayOfWeek = nyNow.getDay();
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        return false;
    }

    const currentMinutes = nyNow.getHours() * 60 + nyNow.getMinutes();
    const marketOpenMinutes = 9 * 60 + 30;
    const marketCloseMinutes = 16 * 60;
    return currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes;
}

function currentNyDateIso(): string {
    const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const year = nyNow.getFullYear();
    const month = String(nyNow.getMonth() + 1).padStart(2, '0');
    const day = String(nyNow.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function refreshRuntimeStatusFromClock() {
    if (!appState.isRunning || appState.runtimeStatus !== 'Waiting for market open') {
        return;
    }

    if (!isNyMarketOpenNow()) {
        return;
    }

    if (appState.sessionMode === 'EMULATION') {
        const isLiveEmulation = Boolean(appState.emulationSessionDate)
            && appState.emulationSessionDate === currentNyDateIso();
        if (appState.continuous && isLiveEmulation) {
            appState.runtimeStatus = 'Running in real time (emulation)';
        }
        return;
    }

    if (appState.continuous) {
        appState.runtimeStatus = 'Running in real time';
    }
}

function resolveAppEntryPoint(): { command: string; args: string[] } {
    const isSourceServerRuntime = __filename.endsWith('.ts');
    if (isSourceServerRuntime) {
        return {
            command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
            args: ['tsx', 'src/main.ts'],
        };
    }

    const compiledMain = path.resolve(process.cwd(), 'dist', 'main.js');
    if (fs.existsSync(compiledMain)) {
        return {
            command: process.execPath,
            args: [compiledMain],
        };
    }

    return {
        command: process.platform === 'win32' ? 'npx.cmd' : 'npx',
        args: ['tsx', 'src/main.ts'],
    };
}

function wireProcessOutput(stream: 'stdout' | 'stderr', source: NodeJS.ReadableStream) {
    let remainder = '';

    source.on('data', (chunk) => {
        remainder += String(chunk);
        const lines = remainder.split(/\r?\n/);
        remainder = lines.pop() ?? '';

        for (const line of lines) {
            if (line.startsWith('__BACKTEST_PROGRESS__')) {
                const payload = line.slice('__BACKTEST_PROGRESS__'.length);
                try {
                    const parsed = JSON.parse(payload) as AppState['backtestProgress'];
                    if (parsed && typeof parsed.totalWeekdaySessions === 'number') {
                        appState.backtestProgress = parsed;
                        persistCanonicalDailySession(parsed.currentSessionDate ?? undefined);
                    }
                } catch {
                    addActivityLine('system', 'Failed parsing backtest progress payload');
                }
                continue;
            }

            if (line.startsWith('__TRADE_MONITOR__')) {
                const payload = line.slice('__TRADE_MONITOR__'.length);
                try {
                    const parsed = JSON.parse(payload) as Omit<TradeEvent, 'id'>;
                    if (parsed && parsed.eventType && parsed.symbol) {
                        addTradeEvent(parsed);
                    }
                } catch {
                    addActivityLine('system', 'Failed parsing trade monitor event payload');
                }
                continue;
            }

            if (line.startsWith('__UI_STATUS__')) {
                const payload = line.slice('__UI_STATUS__'.length).trim();
                appState.orbUiMessage = payload || null;
                continue;
            }

            addActivityLine(stream, line);

            // Detect Alpaca subscription errors for real-time (SIP) data feed
            if (appState.realtimeDataFeed && !appState.realtimeDataFeedError) {
                const lower = line.toLowerCase();
                if (
                    (lower.includes('forbidden') || lower.includes('403') || lower.includes('subscription') || lower.includes('not permitted') || lower.includes('not authorized') || lower.includes('plan')) &&
                    (lower.includes('sip') || lower.includes('feed') || lower.includes('data') || lower.includes('real') || lower.includes('realtime'))
                ) {
                    appState.realtimeDataFeedError = true;
                }
            }
        }
    });

    source.on('end', () => {
        if (remainder.trim()) {
            addActivityLine(stream, remainder);
            remainder = '';
        }
    });
}

function startOrbiliciousProcess(params: {
    continuous: boolean;
    sessionMode: SessionMode;
    emulationSessionDate: string | null;
    hardBasketCap?: number;
    maxTotalRisk?: number;
    stopProfitRewardPart?: number;
    mostActiveSymbolLimit: number;
    realTimeData?: boolean;
    candidateTradeType: CandidateTradeType;
    breakoutConfirmationCandleMinutes: number;
    breakoutQualityFiltersEnabled: boolean;
    breakoutMinVolumeExpansion: number;
    breakoutMinRelativeStrengthPct: number;
    breakoutTrendTimeframeMinutes: number;
    breakoutTrendLookbackBars: number;
}) {
    const {
        continuous,
        sessionMode,
        emulationSessionDate,
        hardBasketCap,
        maxTotalRisk,
        stopProfitRewardPart,
        mostActiveSymbolLimit,
        realTimeData,
        candidateTradeType,
        breakoutConfirmationCandleMinutes,
        breakoutQualityFiltersEnabled,
        breakoutMinVolumeExpansion,
        breakoutMinRelativeStrengthPct,
        breakoutTrendTimeframeMinutes,
        breakoutTrendLookbackBars,
    } = params;
    const entry = resolveAppEntryPoint();
    const args = [...entry.args];
    if (continuous) {
        args.push('--continuous');
    }

    stopRequested = false;
    tradeEvents = [];
    nextTradeEventId = 1;
    appState.backtestProgress = null;
    appState.orbUiMessage = null;
    appState.isRunning = true;
    appState.startedAt = new Date().toISOString();

    const replayMode = sessionMode === 'REPLAY';
    const childSessionMode: SessionMode = replayMode ? 'EMULATION' : sessionMode;
    const effectiveContinuous = replayMode ? false : continuous;

    if (replayMode && emulationSessionDate) {
        appState.backtestProgress = {
            startSessionDate: emulationSessionDate,
            endSessionDate: emulationSessionDate,
            totalWeekdaySessions: 1,
            processedDates: 1,
            skippedDates: 0,
            currentSessionDate: emulationSessionDate,
            completed: true,
        };
        appState.orbUiMessage = `Replaying canonical session record for ${emulationSessionDate}.`;
        appState.runtimeStatus = 'Running replay';
        appState.isRunning = false;
        appState.continuous = false;
        appState.sessionMode = sessionMode;
        appState.emulationSessionDate = emulationSessionDate;
        appState.moneyInAccount = hardBasketCap ?? null;
        appState.currentBalance = hardBasketCap ?? null;
        appState.maxRiskPerSession = maxTotalRisk ?? null;
        appState.stopProfitRewardPart = stopProfitRewardPart ?? null;
        appState.mostActiveSymbolLimit = mostActiveSymbolLimit;
        appState.lastOutcome = 'running';
        appState.lastError = null;
        appState.realtimeDataFeed = false;
        appState.realtimeDataFeedError = false;
        appState.candidateTradeType = candidateTradeType;
        appState.breakoutConfirmationCandleMinutes = breakoutConfirmationCandleMinutes;
        appState.breakoutQualityFiltersEnabled = breakoutQualityFiltersEnabled;
        appState.breakoutMinVolumeExpansion = breakoutMinVolumeExpansion;
        appState.breakoutMinRelativeStrengthPct = breakoutMinRelativeStrengthPct;
        appState.breakoutTrendTimeframeMinutes = breakoutTrendTimeframeMinutes;
        appState.breakoutTrendLookbackBars = breakoutTrendLookbackBars;
        appState.pid = null;
        addActivityLine('system', `Loaded replay from canonical daily session record for ${emulationSessionDate}.`);
        return;
    }

    // Determine initial runtime status
    if (sessionMode === 'EMULATION' && emulationSessionDate) {
        // Check if this is live emulation (today's date) with continuous mode
        const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const nyYear = nyNow.getFullYear();
        const nyMonth = String(nyNow.getMonth() + 1).padStart(2, '0');
        const nyDay = String(nyNow.getDate()).padStart(2, '0');
        const nyTodayDate = `${nyYear}-${nyMonth}-${nyDay}`;
        const isLiveEmu = emulationSessionDate === nyTodayDate;

        if (isLiveEmu && continuous) {
            // For live emulation continuous mode, check if markets are open
            const dayOfWeek = nyNow.getDay();
            const hours = nyNow.getHours();
            const minutes = nyNow.getMinutes();
            const currentMinutes = hours * 60 + minutes;
            const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;
            const marketOpenMinutes = 9 * 60 + 30;  // 9:30 AM
            const marketCloseMinutes = 16 * 60;     // 4:00 PM

            if (isWeekday && currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes) {
                appState.runtimeStatus = 'Running in real time (emulation)';
            } else if (isWeekday && currentMinutes < marketOpenMinutes) {
                appState.runtimeStatus = 'Waiting for market open';
            } else {
                appState.runtimeStatus = 'Running historical emulation';
            }
        } else {
            appState.runtimeStatus = 'Running historical emulation';
        }
    } else if (effectiveContinuous && sessionMode !== 'EMULATION') {
        // For live continuous mode, check if markets are open
        const nyNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const dayOfWeek = nyNow.getDay();
        const hours = nyNow.getHours();
        const minutes = nyNow.getMinutes();
        const currentMinutes = hours * 60 + minutes;
        const isWeekday = dayOfWeek !== 0 && dayOfWeek !== 6;
        const marketOpenMinutes = 9 * 60 + 30;  // 9:30 AM
        const marketCloseMinutes = 16 * 60;     // 4:00 PM
        const marketsOpen = isWeekday && currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes;

        if (marketsOpen) {
            appState.runtimeStatus = 'Running in real time';
        } else {
            appState.runtimeStatus = 'Waiting for market open';
        }
    } else {
        appState.runtimeStatus = 'Running in real time';
    }

    appState.continuous = effectiveContinuous;
    appState.sessionMode = sessionMode;
    appState.emulationSessionDate = emulationSessionDate;
    appState.moneyInAccount = hardBasketCap ?? null;
    appState.currentBalance = hardBasketCap ?? null;
    appState.maxRiskPerSession = maxTotalRisk ?? null;
    appState.stopProfitRewardPart = stopProfitRewardPart ?? null;
    appState.mostActiveSymbolLimit = mostActiveSymbolLimit;
    appState.lastOutcome = 'running';
    appState.lastError = null;
    appState.realtimeDataFeed = realTimeData === true;
    appState.realtimeDataFeedError = false;
    appState.candidateTradeType = candidateTradeType;
    appState.breakoutConfirmationCandleMinutes = breakoutConfirmationCandleMinutes;
    appState.breakoutQualityFiltersEnabled = breakoutQualityFiltersEnabled;
    appState.breakoutMinVolumeExpansion = breakoutMinVolumeExpansion;
    appState.breakoutMinRelativeStrengthPct = breakoutMinRelativeStrengthPct;
    appState.breakoutTrendTimeframeMinutes = breakoutTrendTimeframeMinutes;
    appState.breakoutTrendLookbackBars = breakoutTrendLookbackBars;
    persistCanonicalDailySession();

    const child = spawn(entry.command, args, {
        cwd: process.cwd(),
        env: {
            ...process.env,
            SESSION_MODE: childSessionMode,
            SESSION_DATE: emulationSessionDate ?? '',
            HARD_BASKET_CAP: hardBasketCap ? hardBasketCap.toString() : '',
            MAX_TOTAL_RISK: maxTotalRisk ? maxTotalRisk.toString() : '',
            STOP_LOSS_PROFIT_RATIO: stopProfitRewardPart ? `1:${stopProfitRewardPart}` : '',
            QUANTITY_TO_RETRIEVE: String(mostActiveSymbolLimit),
            CANDIDATE_TRADE_TYPE: candidateTradeType,
            BREAKOUT_CONFIRMATION_CANDLE_MINUTES: String(breakoutConfirmationCandleMinutes),
            BREAKOUT_QUALITY_FILTERS_ENABLED: String(breakoutQualityFiltersEnabled),
            BREAKOUT_MIN_VOLUME_EXPANSION: String(breakoutMinVolumeExpansion),
            BREAKOUT_MIN_RELATIVE_STRENGTH_PCT: String(breakoutMinRelativeStrengthPct),
            BREAKOUT_TREND_TIMEFRAME_MINUTES: String(breakoutTrendTimeframeMinutes),
            BREAKOUT_TREND_LOOKBACK_BARS: String(breakoutTrendLookbackBars),
            ...(realTimeData ? { ALPACA_DATA_FEED: 'sip' } : {}),
        },
        stdio: 'pipe',
    });

    appProcess = child;
    appState.pid = child.pid ?? null;

    addActivityLine(
        'system',
        `Starting ORBilicious in ${sessionMode} mode${effectiveContinuous ? ' (continuous)' : ''}${emulationSessionDate ? ` for ${emulationSessionDate}` : ''}${hardBasketCap ? ` | Basket Cap: $${hardBasketCap.toLocaleString()}` : ''}${maxTotalRisk ? ` | Max Risk: $${maxTotalRisk.toLocaleString()}` : ''}${stopProfitRewardPart ? ` | Stop/Profit: 1/${stopProfitRewardPart}` : ''} | Most Active: ${mostActiveSymbolLimit} | Candidate Trades: ${candidateTradeType} | Confirm Candle: ${breakoutConfirmationCandleMinutes}m | Quality Filters: ${breakoutQualityFiltersEnabled ? 'on' : 'off'}`
    );

    wireProcessOutput('stdout', child.stdout);
    wireProcessOutput('stderr', child.stderr);

    child.on('error', (error) => {
        appState.isRunning = false;
        appState.pid = null;
        appState.runtimeStatus = 'Failed';
        appState.orbUiMessage = null;
        persistCanonicalDailySession();
        appState.lastOutcome = 'failed';
        appState.lastError = error.message;
        addActivityLine('system', `Process error: ${error.message}`);
        logger.error('Failed starting Orbilicious child process', { error, sessionMode, continuous: effectiveContinuous });
    });

    child.on('close', (code, signal) => {
        const wasStopRequested = stopRequested;
        stopRequested = false;

        const sessionDate = appState.emulationSessionDate;
        appState.isRunning = false;
        appState.pid = null;
        appState.runtimeStatus = 'Stopped';
        appState.orbUiMessage = null;
        appState.emulationSessionDate = null;

        // Re-inject in-memory trade events as sessionEvents into the canonical
        // record so REPLAY and the trade monitor reflect the actual run, even
        // though the child's generateOrbReport / writeDailySessionRecord may
        // have already overwritten the file without sessionEvents.
        if (sessionDate && tradeEvents.some((e) => e.sessionDate === sessionDate)) {
            const existing = readDailySessionRecord(sessionDate);
            if (existing) {
                const events = tradeEvents
                    .filter((e) => e.sessionDate === sessionDate)
                    .map((e) => ({
                        eventId: String(e.id),
                        eventType: e.eventType as 'open' | 'close',
                        sessionDate: e.sessionDate,
                        timestamp: e.timestamp,
                        symbol: e.symbol,
                        side: e.side as 'buy' | 'sell',
                        position: e.position as 'long' | 'short',
                        qty: e.qty,
                        entryPrice: e.entryPrice,
                        stopPrice: e.stopPrice,
                        stopLossPct: e.stopLossPct,
                        targetPrice: e.targetPrice,
                        closePrice: e.closePrice,
                        pnl: e.pnl,
                        reason: e.reason,
                    }))
                    .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

                existing.sessionEvents = events;

                // Reconcile totals to match runtime PnL from sessionEvents
                const closePnl = events
                    .filter((e) => e.eventType === 'close')
                    .reduce((sum, e) => sum + (typeof e.pnl === 'number' ? e.pnl : 0), 0);
                existing.totals = existing.totals ?? {} as NonNullable<DailySessionRecord['totals']>;
                existing.totals.totalProfitLossToDate = Number(closePnl.toFixed(2));

                writeDailySessionRecordAtomic(sessionDate, existing);
            }
        }

        if (wasStopRequested || signal === 'SIGTERM') {
            appState.lastOutcome = 'completed';
            appState.lastError = null;
            addActivityLine('system', 'ORBilicious stopped.');
        } else if (code === 0) {
            appState.lastOutcome = 'completed';
            appState.lastError = null;
            addActivityLine('system', 'ORBilicious finished successfully.');
        } else {
            appState.lastOutcome = 'failed';
            appState.lastError = `Exited with code ${code ?? 'unknown'}${signal ? ` (signal: ${signal})` : ''}`;
            addActivityLine('system', `ORBilicious exited unexpectedly: ${appState.lastError}`);
        }

        appProcess = null;
    });
}

function stopOrbiliciousProcess(): boolean {
    if (!appProcess && appState.isRunning && appState.sessionMode === 'REPLAY') {
        appState.isRunning = false;
        appState.pid = null;
        appState.runtimeStatus = 'Stopped';
        appState.orbUiMessage = null;
        appState.emulationSessionDate = null;
        appState.backtestProgress = null;
        appState.lastOutcome = 'completed';
        appState.lastError = null;
        addActivityLine('system', 'Replay stopped.');
        return true;
    }

    if (!appProcess || !appState.isRunning) {
        return false;
    }

    stopRequested = true;
    addActivityLine('system', 'Stop requested. Sending SIGTERM...');
    return appProcess.kill('SIGTERM');
}

function safeJoin(rootDir: string, requestedPath: string): string | null {
    const normalized = path.normalize(requestedPath).replace(/^([/\\])+/, '');
    const fullPath = path.resolve(rootDir, normalized);
    if (!fullPath.startsWith(rootDir)) {
        return null;
    }
    return fullPath;
}

function parseJsonBody<T>(req: IncomingMessage): Promise<T> {
    return new Promise((resolve, reject) => {
        let body = '';

        req.on('data', (chunk) => {
            body += String(chunk);
            if (body.length > 1_000_000) {
                reject(new Error('Request payload too large'));
                req.destroy();
            }
        });

        req.on('end', () => {
            if (!body.trim()) {
                resolve({} as T);
                return;
            }

            try {
                resolve(JSON.parse(body) as T);
            } catch {
                reject(new Error('Invalid JSON payload'));
            }
        });

        req.on('error', reject);
    });
}

function listReports() {
    if (!fs.existsSync(reportsDir)) {
        return [] as Array<{ name: string; relativePath: string; type: 'html' | 'pdf'; modifiedAt: string }>;
    }

    const files: Array<{ name: string; relativePath: string; type: 'html' | 'pdf'; modifiedAt: string }> = [];

    const walk = (currentDir: string) => {
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
                continue;
            }

            if (!entry.isFile()) {
                continue;
            }

            const ext = path.extname(entry.name).toLowerCase();
            if (ext !== '.html' && ext !== '.pdf') {
                continue;
            }

            const stat = fs.statSync(fullPath);
            const relativePath = path.relative(reportsDir, fullPath).split(path.sep).join('/');

            files.push({
                name: entry.name,
                relativePath,
                type: ext === '.html' ? 'html' : 'pdf',
                modifiedAt: stat.mtime.toISOString(),
            });
        }
    };

    walk(reportsDir);

    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return files;
}

function normalizeMostActiveSymbols(
    symbols: unknown,
): MostActiveSymbolDetail[] {
    if (!Array.isArray(symbols)) return [];
    return symbols.map((s) => {
        if (typeof s === 'string') {
            return { symbol: s, volume: 0, trade_count: 0 };
        }
        if (typeof s === 'object' && s !== null && typeof (s as Record<string, unknown>).symbol === 'string') {
            const obj = s as Record<string, unknown>;
            return {
                symbol: obj.symbol as string,
                volume: typeof obj.volume === 'number' ? (obj.volume as number) : 0,
                trade_count: typeof obj.trade_count === 'number' ? (obj.trade_count as number) : 0,
            };
        }
        return { symbol: String(s), volume: 0, trade_count: 0 };
    });
}

function dailySessionJsonPath(sessionDate: string): string {
    return path.join(dailySessionDir, `${sessionDate}.json`);
}

function readDailySessionRecord(sessionDate: string): DailySessionRecord | null {
    const filePath = dailySessionJsonPath(sessionDate);
    if (!fs.existsSync(filePath)) {
        return null;
    }

    try {
        const record = JSON.parse(fs.readFileSync(filePath, 'utf8')) as DailySessionRecord;
        if (record.mostActiveSymbols) {
            record.mostActiveSymbols = normalizeMostActiveSymbols(record.mostActiveSymbols);
        }
        return record;
    } catch (error) {
        logger.warn('Failed reading daily session JSON', {
            sessionDate,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
}

function makeTradeEventId(event: Omit<TradeEvent, 'id'>): string {
    return [
        event.eventType,
        event.sessionDate,
        event.timestamp,
        event.symbol,
        event.side,
        event.position,
        Number(event.qty ?? 0).toFixed(6),
        typeof event.entryPrice === 'number' ? event.entryPrice.toFixed(6) : '',
        typeof event.stopPrice === 'number' ? event.stopPrice.toFixed(6) : '',
        typeof event.targetPrice === 'number' ? event.targetPrice.toFixed(6) : '',
        typeof event.closePrice === 'number' ? event.closePrice.toFixed(6) : '',
        typeof event.pnl === 'number' ? event.pnl.toFixed(6) : '',
        event.reason ?? '',
    ].join('|');
}

function writeDailySessionRecordAtomic(sessionDate: string, record: DailySessionRecord) {
    fs.mkdirSync(dailySessionDir, { recursive: true });
    const targetPath = dailySessionJsonPath(sessionDate);
    const tmpPath = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
    fs.renameSync(tmpPath, targetPath);
}

function persistenceSessionDate(preferredSessionDate?: string): string | null {
    if (preferredSessionDate && isValidSessionDate(preferredSessionDate)) {
        return preferredSessionDate;
    }

    if (
        (appState.sessionMode === 'EMULATION' || appState.sessionMode === 'REPLAY')
        && appState.emulationSessionDate
        && isValidSessionDate(appState.emulationSessionDate)
    ) {
        return appState.emulationSessionDate;
    }

    if (appState.isRunning) {
        return nyDateString();
    }

    return null;
}

function parseCandidateSymbolsFromUiMessage(message: string | null): string[] {
    if (!message) {
        return [];
    }

    const prefix = 'Identified Breakout Candidates,';
    if (!message.startsWith(prefix)) {
        return [];
    }

    return message
        .slice(prefix.length)
        .split(',')
        .map((symbol) => symbol.trim().toUpperCase())
        .filter((symbol) => symbol.length > 0);
}

function buildLiveSessionRecordFromRuntime(
    sessionDate: string,
    existingRecord?: DailySessionRecord | null,
): DailySessionRecord {
    const existingEvents = Array.isArray(existingRecord?.sessionEvents)
        ? existingRecord.sessionEvents
        : [];
    const mergedEvents = new Map<string, NonNullable<DailySessionRecord['sessionEvents']>[number]>();

    for (const existingEvent of existingEvents) {
        if (!existingEvent || existingEvent.sessionDate !== sessionDate) {
            continue;
        }

        const payload: Omit<TradeEvent, 'id'> = {
            eventType: existingEvent.eventType,
            sessionDate: existingEvent.sessionDate,
            timestamp: existingEvent.timestamp,
            symbol: existingEvent.symbol,
            side: existingEvent.side,
            position: existingEvent.position,
            qty: existingEvent.qty,
            entryPrice: existingEvent.entryPrice,
            stopPrice: existingEvent.stopPrice,
            stopLossPct: existingEvent.stopLossPct,
            targetPrice: existingEvent.targetPrice,
            closePrice: existingEvent.closePrice,
            pnl: existingEvent.pnl,
            reason: existingEvent.reason,
        };
        const eventId = existingEvent.eventId || makeTradeEventId(payload);
        mergedEvents.set(eventId, {
            ...payload,
            eventId,
        });
    }

    for (const event of tradeEvents) {
        if (event.sessionDate !== sessionDate) {
            continue;
        }

        const payload: Omit<TradeEvent, 'id'> = {
            eventType: event.eventType,
            sessionDate: event.sessionDate,
            timestamp: event.timestamp,
            symbol: event.symbol,
            side: event.side,
            position: event.position,
            qty: event.qty,
            entryPrice: event.entryPrice,
            stopPrice: event.stopPrice,
            stopLossPct: event.stopLossPct,
            targetPrice: event.targetPrice,
            closePrice: event.closePrice,
            pnl: event.pnl,
            reason: event.reason,
        };
        const eventId = makeTradeEventId(payload);
        mergedEvents.set(eventId, {
            ...payload,
            eventId,
        });
    }

    const events = Array.from(mergedEvents.values())
        .sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime());
    const symbolsFromUi = parseCandidateSymbolsFromUiMessage(appState.orbUiMessage);

    const openBySymbol = new Map<string, Omit<TradeEvent, 'id'>>();
    const closeBySymbol = new Map<string, Omit<TradeEvent, 'id'>>();
    for (const event of events) {
        if (event.eventType === 'open') {
            openBySymbol.set(event.symbol, event);
            continue;
        }

        closeBySymbol.set(event.symbol, event);
    }

    const symbolSet = new Set<string>([
        ...symbolsFromUi,
        ...Array.from(openBySymbol.keys()),
        ...Array.from(closeBySymbol.keys()),
    ]);
    const symbols = Array.from(symbolSet.values()).sort((a, b) => a.localeCompare(b));

    const breakoutCandidates: NonNullable<DailySessionRecord['breakoutCandidates']> = [];
    const emulatedTrades: NonNullable<DailySessionRecord['emulatedTrades']> = [];
    const finalOutcomes: NonNullable<DailySessionRecord['finalOutcomes']> = [];
    const candidateTradeActivity: Exclude<DailySessionRecord['candidateTradeActivity'], undefined | {
        totalCandidatesBoughtAtStart?: number;
        numberOfCandidatesSoldLong?: number;
        numberOfCandidatesBoughtShort?: number;
        totalCostOfBreakoutCandidatePurchases?: number;
        totalAmountOfCashAtStopLossRisk?: number;
        totalProfitLossToDate?: number;
    }> = [];

    let longCount = 0;
    let shortCount = 0;
    let totalCost = 0;
    let totalRisk = 0;
    let totalPnl = 0;

    for (const symbol of symbols) {
        const open = openBySymbol.get(symbol);
        const close = closeBySymbol.get(symbol);

        if (open) {
            const qty = typeof open.qty === 'number' ? open.qty : 0;
            const entryPrice = typeof open.entryPrice === 'number' ? open.entryPrice : undefined;
            const stopPrice = typeof open.stopPrice === 'number' ? open.stopPrice : undefined;
            const targetPrice = typeof open.targetPrice === 'number' ? open.targetPrice : undefined;
            const side = open.side ?? 'buy';

            breakoutCandidates.push({
                symbol,
                side,
                price: entryPrice,
                qty,
                stopPrice,
                takeProfitPrice: targetPrice,
            });

            emulatedTrades.push({
                symbol,
                side,
                price: entryPrice,
                qty,
                stopPrice,
                takeProfitPrice: targetPrice,
            });

            const isLong = side === 'buy';
            if (isLong) {
                longCount += 1;
            } else {
                shortCount += 1;
            }

            if (typeof entryPrice === 'number') {
                totalCost += entryPrice * qty;
            }

            if (
                typeof entryPrice === 'number'
                && typeof stopPrice === 'number'
                && Number.isFinite(entryPrice)
                && Number.isFinite(stopPrice)
            ) {
                const riskPerShare = Math.abs(entryPrice - stopPrice);
                totalRisk += riskPerShare * qty;
            }

            candidateTradeActivity.push({
                symbol,
                side,
                position: open.position,
                qty,
                entryPrice,
                stopPrice,
                targetPrice,
                closePrice: typeof close?.closePrice === 'number' ? close.closePrice : null,
                pnl: typeof close?.pnl === 'number' ? close.pnl : undefined,
                status: close ? 'closed' : 'open',
                reason: close?.reason,
                entryTimestamp: open.timestamp,
                closeTimestamp: close?.timestamp ?? null,
            });
        }

        if (close) {
            const status = close.reason?.includes('stop')
                ? 'stop'
                : close.reason?.includes('profit')
                    ? 'profit'
                    : 'closed';
            const pnl = typeof close.pnl === 'number' ? close.pnl : 0;
            totalPnl += pnl;

            finalOutcomes.push({
                symbol,
                side: close.side,
                status,
                pnl,
                exitPrice: typeof close.closePrice === 'number' ? close.closePrice : null,
                exitTimestamp: close.timestamp,
            });
        }
    }

    const mostActiveSymbols: MostActiveSymbolDetail[] = (symbolsFromUi.length ? symbolsFromUi : symbols)
        .map((symbol) => ({ symbol, volume: 0, trade_count: 0 }));
    const filtersEnabled = appState.breakoutQualityFiltersEnabled;

    return {
        ...(existingRecord ?? {}),
        schemaVersion: 1,
        sessionDate,
        sessionMode: appState.sessionMode,
        status: appState.isRunning ? 'running' : 'completed',
        continuous: appState.continuous,
        startedAt: appState.startedAt,
        updatedAt: new Date().toISOString(),
        strategy: {
            referenceSymbol: strategyConfig.symbol,
            symbol: strategyConfig.symbol,
            openingRangeMinutes: strategyConfig.openingRangeMinutes,
            candleMinutes: strategyConfig.candleMinutes,
            allowLong: strategyConfig.allowLong,
            allowShort: strategyConfig.allowShort,
        },
        breakoutFilters: {
            breakoutConfirmationCandleMinutes: appState.breakoutConfirmationCandleMinutes,
            breakoutQualityFiltersEnabled: filtersEnabled,
            breakoutMinVolumeExpansion: appState.breakoutMinVolumeExpansion,
            breakoutMinRelativeStrengthPct: appState.breakoutMinRelativeStrengthPct,
            breakoutTrendTimeframeMinutes: appState.breakoutTrendTimeframeMinutes,
            breakoutTrendLookbackBars: appState.breakoutTrendLookbackBars,
            enabled: filtersEnabled,
            confirmationCandleMinutes: appState.breakoutConfirmationCandleMinutes,
            minVolumeExpansion: appState.breakoutMinVolumeExpansion,
            minRelativeStrengthPct: appState.breakoutMinRelativeStrengthPct,
            trendTimeframeMinutes: appState.breakoutTrendTimeframeMinutes,
            trendLookbackBars: appState.breakoutTrendLookbackBars,
        },
        totals: {
            totalCandidatesBoughtAtStart: breakoutCandidates.length,
            numberOfCandidatesSoldLong: longCount,
            numberOfCandidatesBoughtShort: shortCount,
            totalCostOfBreakoutCandidatePurchases: Number(totalCost.toFixed(2)),
            totalAmountOfCashAtStopLossRisk: Number(totalRisk.toFixed(2)),
            totalProfitLossToDate: Number(totalPnl.toFixed(2)),
        },
        marketScan: {
            maxSessionBars: 0,
            candidateTradeType: appState.candidateTradeType,
            requestedLimit: appState.mostActiveSymbolLimit,
            retrievedCount: mostActiveSymbols.length,
        },
        evaluationRows: [],
        breakoutCandidates,
        emulatedTrades,
        finalOutcomes,
        candidateTradeActivity,
        mostActiveSymbols,
        mostActiveSymbolCount: mostActiveSymbols.length,
        insufficientSymbols: [],
        sessionEvents: events,
        runtimeSnapshot: {
            runtimeStatus: appState.runtimeStatus,
            orbUiMessage: appState.orbUiMessage,
            isRunning: appState.isRunning,
            candidateTradeType: appState.candidateTradeType,
            breakoutConfirmationCandleMinutes: appState.breakoutConfirmationCandleMinutes,
            breakoutQualityFiltersEnabled: appState.breakoutQualityFiltersEnabled,
            breakoutMinVolumeExpansion: appState.breakoutMinVolumeExpansion,
            breakoutMinRelativeStrengthPct: appState.breakoutMinRelativeStrengthPct,
            breakoutTrendTimeframeMinutes: appState.breakoutTrendTimeframeMinutes,
            breakoutTrendLookbackBars: appState.breakoutTrendLookbackBars,
        },
        notes: [
            'Canonical session state is updated incrementally from runtime events.',
        ],
    };
}

function persistCanonicalDailySession(preferredSessionDate?: string): boolean {
    const sessionDate = persistenceSessionDate(preferredSessionDate);
    if (!sessionDate) {
        return false;
    }

    const existing = readDailySessionRecord(sessionDate);
    const hasRuntimeSignals = appState.isRunning
        || tradeEvents.some((event) => event.sessionDate === sessionDate)
        || (appState.emulationSessionDate === sessionDate && Boolean(appState.orbUiMessage));
    if (!existing && !hasRuntimeSignals) {
        return false;
    }

    const canonical = buildLiveSessionRecordFromRuntime(sessionDate, existing);
    writeDailySessionRecordAtomic(sessionDate, canonical);
    return true;
}

async function renderDailySessionView(
    record: DailySessionRecord,
    options?: { sourceDiagnostic?: string },
): Promise<string> {
    const candidateTradeActivityValue = record.candidateTradeActivity;
    const candidateTradeActivitySummary = (
        candidateTradeActivityValue
        && !Array.isArray(candidateTradeActivityValue)
    ) ? candidateTradeActivityValue : {};
    let totals = record.totals ?? candidateTradeActivitySummary;
    const sessionEventsArr = Array.isArray(record.sessionEvents) ? record.sessionEvents : [];
    const closeEventsPnl = sessionEventsArr
        .filter((e) => e.eventType === 'close' && typeof e.pnl === 'number')
        .reduce((sum, e) => sum + (e.pnl as number), 0);
    const openCount = sessionEventsArr.filter((e) => e.eventType === 'open').length;
    const closedCount = sessionEventsArr.filter((e) => e.eventType === 'close').length;
    if (closeEventsPnl !== 0) {
        totals = { ...totals, totalProfitLossToDate: Number(closeEventsPnl.toFixed(2)) };
    }
    const artifacts = record.artifacts ?? {};
    const mostActiveSymbols = record.mostActiveSymbols ?? [];
    const insufficientSymbols = record.insufficientSymbols ?? [];
    const evaluationRows = record.evaluationRows ?? [];
    const breakoutCandidates = record.breakoutCandidates ?? [];
    const emulatedTrades = record.emulatedTrades ?? [];
    const finalOutcomes = record.finalOutcomes ?? [];
    const candidateTradeActivity = Array.isArray(candidateTradeActivityValue)
        ? candidateTradeActivityValue
        : [];

    const fmt = (value: number | null | undefined, digits = 2) => (
        typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
    );
    const rowBySymbol = new Map(evaluationRows.map((row) => [row.symbol, row]));
    const emulatedBySymbol = new Map(emulatedTrades.map((row) => [row.symbol, row]));
    const outcomeBySymbol = new Map(finalOutcomes.map((row) => [row.symbol, row]));
    const activityBySymbol = new Map(candidateTradeActivity.map((row) => [row.symbol, row]));
    const drilldownCandidates = breakoutCandidates.length
        ? breakoutCandidates
        : evaluationRows
            .filter((row) => (row.side && row.side !== 'none') || row.breakoutPrice != null)
            .map((row) => ({
                symbol: row.symbol,
                side: row.side === 'sell' ? 'sell' : row.side === 'buy' ? 'buy' : undefined,
                price: row.breakoutPrice ?? undefined,
            }));

    // Override report trade/outcome/activity data with runtime sessionEvents data
    if (Array.isArray(record.sessionEvents)) {
        const openBySymbol = new Map<string, NonNullable<DailySessionRecord['sessionEvents']>[number]>();
        const closeBySymbol = new Map<string, NonNullable<DailySessionRecord['sessionEvents']>[number]>();
        for (const e of record.sessionEvents) {
            if (e.eventType === 'open') openBySymbol.set(e.symbol, e);
            else if (e.eventType === 'close') closeBySymbol.set(e.symbol, e);
        }
        for (const [symbol, close] of closeBySymbol) {
            const open = openBySymbol.get(symbol);
            const status = close.reason?.toLowerCase().includes('profit') ? 'PROFIT'
                : close.reason?.toLowerCase().includes('loss') ? 'LOSS'
                : close.pnl != null && close.pnl >= 0 ? 'PROFIT' : 'LOSS';
            emulatedBySymbol.set(symbol, {
                symbol,
                side: close.position === 'long' ? 'buy' : 'sell',
                price: close.entryPrice,
                qty: close.qty,
                stopPrice: close.stopPrice,
                stopLossPct: close.entryPrice
                    ? Math.abs((close.stopPrice ?? 0) - close.entryPrice) / close.entryPrice
                    : undefined,
                takeProfitPrice: close.targetPrice,
            });
            outcomeBySymbol.set(symbol, {
                symbol,
                side: close.side,
                entryPrice: close.entryPrice,
                stopPrice: close.stopPrice,
                takeProfitPrice: close.targetPrice,
                qty: close.qty,
                status,
                pnl: close.pnl,
                exitPrice: close.closePrice ?? null,
                exitTimestamp: close.timestamp,
            });
            activityBySymbol.set(symbol, {
                symbol,
                side: close.position === 'long' ? 'sell' : 'buy',
                position: close.position,
                qty: close.qty,
                entryPrice: close.entryPrice,
                stopPrice: close.stopPrice,
                targetPrice: close.targetPrice,
                closePrice: close.closePrice,
                pnl: close.pnl,
                status,
                reason: close.reason,
                entryTimestamp: open?.timestamp ?? close.timestamp,
                closeTimestamp: close.timestamp,
            });
        }
    }

    const drilldownCandidateSymbols = new Set(drilldownCandidates.map((c) => c.symbol));
    if (Array.isArray(record.sessionEvents)) {
        for (const e of record.sessionEvents) {
            if (e.eventType === 'close' && !drilldownCandidateSymbols.has(e.symbol)) {
                drilldownCandidates.push({
                    symbol: e.symbol,
                    side: (e.side === 'sell' && e.position === 'long') ? 'buy'
                        : (e.side === 'buy' && e.position === 'short') ? 'sell'
                        : undefined,
                    price: e.entryPrice,
                });
                drilldownCandidateSymbols.add(e.symbol);
            }
        }
    }

    const symbolSnapshots = await buildDailySymbolCharts({
        record,
        symbols: drilldownCandidates.map((candidate) => candidate.symbol),
        openingRangeMinutes: strategyConfig.openingRangeMinutes,
        barsForSessionDate,
        renderCandidateChartSvg,
        readDailySessionRecord,
        writeDailySessionRecordAtomic,
        logWarn: (message, payload) => logger.warn(message, payload),
    });

    const drilldownSummaryRows = drilldownCandidates.length
        ? drilldownCandidates.map((candidate) => {
            const symbol = candidate.symbol;
            const evalRow = rowBySymbol.get(symbol);
            const outcome = outcomeBySymbol.get(symbol);
            const trade = emulatedBySymbol.get(symbol);
            const activity = activityBySymbol.get(symbol);
            const quality = evalRow?.qualityDetail;
            const qualityLabel = quality ? (quality.passed ? 'PASS' : 'FAIL') : 'n/a';
            const statusLabel = (outcome?.status ?? 'n/a').toUpperCase();
            const resolvedPnl = resolveClosedTradePnl({
                position: trade?.side === 'sell' ? 'short' : 'long',
                entryPrice: activity?.entryPrice ?? trade?.price ?? candidate.price ?? null,
                closePrice: outcome?.exitPrice ?? activity?.closePrice ?? null,
                qty: typeof trade?.qty === 'number' ? trade.qty : (typeof activity?.qty === 'number' ? activity.qty : null),
                fallbackQty: 1,
                existingPnl: outcome?.pnl ?? activity?.pnl ?? null,
            });
            return `
            <tr>
                <td><a href="#drilldown-${escapeHtml(symbol)}">${escapeHtml(symbol)}</a></td>
                <td>${escapeHtml((candidate.side ?? 'n/a').toUpperCase())}</td>
                <td>${qualityLabel}</td>
                <td>${statusLabel}</td>
                <td>${fmt(resolvedPnl)}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="5" class="muted">No drilldown candidates were found for this session.</td></tr>';

    const referenceSymbol = record.strategy?.referenceSymbol ?? record.strategy?.symbol ?? 'n/a';
    const confirmationMinutes = record.breakoutFilters?.breakoutConfirmationCandleMinutes
        ?? record.breakoutFilters?.confirmationCandleMinutes;
    const minVolumeExpansion = record.breakoutFilters?.breakoutMinVolumeExpansion
        ?? record.breakoutFilters?.minVolumeExpansion;
    const minRelativeStrengthPct = record.breakoutFilters?.breakoutMinRelativeStrengthPct
        ?? record.breakoutFilters?.minRelativeStrengthPct;
    const trendTimeframeMinutes = record.breakoutFilters?.breakoutTrendTimeframeMinutes
        ?? record.breakoutFilters?.trendTimeframeMinutes;
    const trendLookbackBars = record.breakoutFilters?.breakoutTrendLookbackBars
        ?? record.breakoutFilters?.trendLookbackBars;
    const qualityFiltersEnabled = record.breakoutFilters?.breakoutQualityFiltersEnabled
        ?? record.breakoutFilters?.enabled;

    const breakoutCards = drilldownCandidates.length
        ? drilldownCandidates.map((candidate) => {
            const symbol = candidate.symbol;
            const evalRow = rowBySymbol.get(symbol);
            const trade = emulatedBySymbol.get(symbol);
            const outcome = outcomeBySymbol.get(symbol);
            const activity = activityBySymbol.get(symbol);
            const symbolSnapshot = symbolSnapshots.get(symbol);
            const quality = evalRow?.qualityDetail ?? null;
            const filtersEnabledForSymbol = quality?.filtersEnabled ?? qualityFiltersEnabled;
            const minVolForSymbol = quality?.minVolumeExpansion ?? minVolumeExpansion;
            const minRsForSymbol = quality?.minRelativeStrengthPct ?? minRelativeStrengthPct;
            const qualityPassedLabel = quality
                ? (quality.passed ? 'YES' : 'NO')
                : (filtersEnabledForSymbol ? 'PENDING' : 'DISABLED');
            const trendLabel = quality?.trendAligned == null
                ? (filtersEnabledForSymbol ? 'pending' : 'disabled')
                : (quality.trendAligned ? 'aligned' : 'not aligned');
            const qualityNote = quality?.failReason
                ?? (filtersEnabledForSymbol
                    ? 'Awaiting per-symbol quality evaluation data in live snapshot.'
                    : 'Quality filters disabled.');
            const chartSvg = symbolSnapshot?.chartSvg;
            const entryTimestamp = activity?.entryTimestamp
                ?? evalRow?.confirmationRetestTimestamp
                ?? evalRow?.breakoutTimestamp
                ?? 'n/a';
            const exitTimestamp = outcome?.exitTimestamp ?? activity?.closeTimestamp ?? 'n/a';
            const pnlValue = resolveClosedTradePnl({
                position: trade?.side === 'sell' ? 'short' : 'long',
                entryPrice: activity?.entryPrice ?? trade?.price ?? candidate.price ?? null,
                closePrice: outcome?.exitPrice ?? activity?.closePrice ?? null,
                qty: typeof trade?.qty === 'number' ? trade.qty : (typeof activity?.qty === 'number' ? activity.qty : null),
                fallbackQty: 1,
                existingPnl: outcome?.pnl ?? activity?.pnl ?? null,
            });
            return `
            <details class="card-detail" id="drilldown-${escapeHtml(symbol)}">
                <summary>
                    <span class="symbol">${escapeHtml(symbol)}</span>
                    <span>${escapeHtml((candidate.side ?? 'n/a').toUpperCase())}</span>
                    <span>${escapeHtml(entryTimestamp)}</span>
                    <span>${fmt(trade?.price ?? candidate.price)}</span>
                    <span>${fmt(trade?.qty, 4)}</span>
                    <span>${escapeHtml(exitTimestamp)}</span>
                    <span>${fmt(outcome?.exitPrice)}</span>
                    <span>${fmt(pnlValue)}</span>
                </summary>
                <div class="detail-grid">
                    <div class="detail-panel">
                        <h3>Breakout</h3>
                        <table class="table compact">
                            <tbody>
                                <tr><th>Opening Price</th><td>${fmt(evalRow?.openingPrice ?? symbolSnapshot?.openingPrice)}</td></tr>
                                <tr><th>OR High / Low</th><td>${fmt(evalRow?.openingRangeHigh ?? symbolSnapshot?.openingRangeHigh)} / ${fmt(evalRow?.openingRangeLow ?? symbolSnapshot?.openingRangeLow)}</td></tr>
                                <tr><th>Breakout Price</th><td>${fmt(evalRow?.breakoutPrice ?? symbolSnapshot?.breakoutPrice ?? trade?.price ?? candidate.price)}</td></tr>
                                <tr><th>Breakout Time</th><td>${escapeHtml(evalRow?.breakoutTimestamp ?? symbolSnapshot?.breakoutTimestamp ?? entryTimestamp)}</td></tr>
                                <tr><th>Retest Price</th><td>${fmt(evalRow?.confirmationRetestPrice ?? symbolSnapshot?.confirmationRetestPrice ?? activity?.entryPrice)}</td></tr>
                                <tr><th>Retest Time</th><td>${escapeHtml(evalRow?.confirmationRetestTimestamp ?? symbolSnapshot?.confirmationRetestTimestamp ?? entryTimestamp)}</td></tr>
                                <tr><th>ATR 1m</th><td>${fmt(evalRow?.atr1m ?? symbolSnapshot?.atr1m, 4)}</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="detail-panel">
                        <h3>Trade</h3>
                        <table class="table compact">
                            <tbody>
                                <tr><th>Qty</th><td>${fmt(trade?.qty, 4)}</td></tr>
                                <tr><th>Entry</th><td>${fmt(trade?.price)}</td></tr>
                                <tr><th>Stop</th><td>${fmt(trade?.stopPrice)}</td></tr>
                                <tr><th>Target</th><td>${fmt(trade?.takeProfitPrice)}</td></tr>
                                <tr><th>Exit</th><td>${fmt(outcome?.exitPrice)}</td></tr>
                                <tr><th>Exit Time</th><td>${escapeHtml(outcome?.exitTimestamp ?? 'n/a')}</td></tr>
                                <tr><th>Status</th><td>${escapeHtml((outcome?.status ?? 'n/a').toUpperCase())}</td></tr>
                                <tr><th>P/L</th><td>${fmt(pnlValue)}</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="detail-panel">
                        <h3>Quality Filters</h3>
                        <table class="table compact">
                            <tbody>
                                <tr><th>Passed</th><td>${qualityPassedLabel}</td></tr>
                                <tr><th>Vol Expansion</th><td>${fmt(quality?.volumeExpansion)} / min ${fmt(minVolForSymbol)}</td></tr>
                                <tr><th>Rel Strength %</th><td>${fmt(quality?.relativeStrengthPct)} / min ${fmt(minRsForSymbol)}</td></tr>
                                <tr><th>Trend</th><td>${trendLabel}</td></tr>
                                <tr><th>Fail Reason</th><td>${escapeHtml(qualityNote)}</td></tr>
                                <tr><th>Close Reason</th><td>${escapeHtml(activity?.reason ?? 'n/a')}</td></tr>
                            </tbody>
                        </table>
                    </div>
                    <div class="detail-panel" style="grid-column: 1 / -1;">
                        <h3>Trade Monitor Chart</h3>
                        ${chartSvg ?? '<p class="muted">Chart unavailable for this symbol (missing entry/stop/target data).</p>'}
                    </div>
                </div>
            </details>`;
        }).join('')
        : '<p class="muted">No breakout candidates were stored for this session.</p>';

    const sourceDiagnostic = options?.sourceDiagnostic?.trim();

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ORB Daily Session ${escapeHtml(record.sessionDate)}</title>
    <style>
        body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(180deg, #f8fafc, #eef2ff); color: #0f172a; padding: 24px; }
        .panel { max-width: 1100px; margin: 0 auto 18px; background: #fff; border: 1px solid #e2e8f0; border-radius: 18px; padding: 20px; box-shadow: 0 12px 30px rgba(15, 23, 42, 0.08); }
        h1, h2 { margin: 0 0 10px; }
        .muted { color: #475569; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; }
        .metric { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 14px; padding: 12px; }
        .metric-label { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #64748b; }
        .metric-value { display: block; margin-top: 6px; font-size: 24px; font-weight: 700; }
        ul { margin: 8px 0 0; padding-left: 20px; }
        a { color: #2563eb; text-decoration: none; }
        a:hover { text-decoration: underline; }
        .table { width: 100%; border-collapse: collapse; }
        .table th, .table td { border-bottom: 1px solid #e2e8f0; padding: 10px; text-align: left; }
        .table.compact th, .table.compact td { padding: 7px 8px; font-size: 13px; }
        .card-detail { border: 1px solid #e2e8f0; border-radius: 14px; margin-bottom: 10px; background: #fcfdff; }
        .card-detail summary { cursor: pointer; list-style: none; display: grid; grid-template-columns: 1.05fr .7fr 1.2fr .8fr .8fr 1.2fr .8fr .75fr; gap: 10px; padding: 12px; align-items: center; font-size: 12px; }
        .card-detail summary::-webkit-details-marker { display: none; }
        .card-detail .symbol { font-weight: 700; color: #1d4ed8; }
        .drilldown-header { display: grid; grid-template-columns: 1.05fr .7fr 1.2fr .8fr .8fr 1.2fr .8fr .75fr; gap: 10px; padding: 10px 12px; border: 1px solid #dbe4f0; border-radius: 10px; background: #f8fbff; margin-bottom: 10px; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #475569; font-weight: 700; }
        .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 10px; padding: 10px 12px 12px; border-top: 1px solid #e2e8f0; }
        .detail-panel { border: 1px solid #e2e8f0; border-radius: 10px; padding: 8px; background: #fff; }
        .detail-panel h3 { margin: 2px 0 8px; font-size: 14px; color: #334155; }
        .candidate-live-chart-svg { width: 100%; height: auto; display: block; border-radius: 8px; border: 1px solid #1e293b; background: #0f172a; }
    </style>
</head>
<body>
    <section class="panel">
        <h1>ORB Daily Session ${escapeHtml(record.sessionDate)}</h1>
        <p class="muted">This view is rendered from the canonical JSON record stored in data/daily.</p>
        ${sourceDiagnostic ? `<p class="muted" style="margin-top: 6px; font-size: 12px;"><strong>Diagnostic:</strong> ${escapeHtml(sourceDiagnostic)}</p>` : ''}
        <p class="muted">Reference Symbol: ${escapeHtml(referenceSymbol)}</p>
    </section>
    <section class="panel">
        <h2>Totals</h2>
        <div class="grid">
            <div class="metric"><span class="metric-label">Candidates Bought at Start</span><span class="metric-value">${totals.totalCandidatesBoughtAtStart ?? 0}</span></div>
            <div class="metric"><span class="metric-label">Sold Long</span><span class="metric-value">${totals.numberOfCandidatesSoldLong ?? 0}</span></div>
            <div class="metric"><span class="metric-label">Bought Short</span><span class="metric-value">${totals.numberOfCandidatesBoughtShort ?? 0}</span></div>
            <div class="metric"><span class="metric-label"># Breakout Candidates</span><span class="metric-value">${drilldownCandidates.length}</span></div>
            <div class="metric"><span class="metric-label"># Open Trades</span><span class="metric-value">${closedCount > 0 ? openCount - closedCount : 0}</span></div>
            <div class="metric"><span class="metric-label"># Closed Trades</span><span class="metric-value">${closedCount}</span></div>
            <div class="metric"><span class="metric-label">P/L to Date</span><span class="metric-value">${Number(totals.totalProfitLossToDate ?? 0).toFixed(2)}</span></div>
        </div>
    </section>
    <section class="panel">
        <h2>Market Scan</h2>
        <div class="grid">
            <div class="metric"><span class="metric-label">Max Session Bars</span><span class="metric-value">${record.marketScan?.maxSessionBars ?? 0}</span></div>
            <div class="metric"><span class="metric-label">Trade Type</span><span class="metric-value">${escapeHtml(record.marketScan?.candidateTradeType ?? 'n/a')}</span></div>
            <div class="metric"><span class="metric-label">Scanned Symbols</span><span class="metric-value">${record.mostActiveSymbolCount ?? mostActiveSymbols.length}</span></div>
            <div class="metric"><span class="metric-label">Insufficient Data</span><span class="metric-value">${insufficientSymbols.length}</span></div>
        </div>
        <details class="card-detail" style="margin-top: 12px;">
            <summary>
                <span class="symbol">Show Market Scan Symbol Lists</span>
                <span>${mostActiveSymbols.length} scanned</span>
                <span>${insufficientSymbols.length} insufficient</span>
                <span>Optional</span>
            </summary>
            <div class="detail-grid">
                <div class="detail-panel">
                    <h3>Scanned Symbols</h3>
                    <ul>${mostActiveSymbols.length ? mostActiveSymbols.map((s) => `<li>${escapeHtml(s.symbol)}</li>`).join('') : '<li>None</li>'}</ul>
                </div>
                <div class="detail-panel">
                    <h3>Insufficient Symbols</h3>
                    <ul>${insufficientSymbols.length ? insufficientSymbols.map((symbol) => `<li>${escapeHtml(symbol)}</li>`).join('') : '<li>None</li>'}</ul>
                </div>
            </div>
        </details>
    </section>
    <section class="panel">
        <h2>Breakout Filters</h2>
        <table class="table">
            <tbody>
                <tr><th>Enabled</th><td>${qualityFiltersEnabled == null ? 'n/a' : (qualityFiltersEnabled ? 'Yes' : 'No')}</td></tr>
                <tr><th>Confirmation Candle (min)</th><td>${confirmationMinutes ?? 'n/a'}</td></tr>
                <tr><th>Min Volume Expansion</th><td>${fmt(minVolumeExpansion)}</td></tr>
                <tr><th>Min Relative Strength %</th><td>${fmt(minRelativeStrengthPct)}</td></tr>
                <tr><th>Trend Timeframe (min)</th><td>${trendTimeframeMinutes ?? 'n/a'}</td></tr>
                <tr><th>Trend Lookback Bars</th><td>${trendLookbackBars ?? 'n/a'}</td></tr>
            </tbody>
        </table>
    </section>
    <section class="panel">
        <h2>Symbol Drilldown</h2>
        <p class="muted">Click any candidate row to expand details and chart.</p>
        <div class="drilldown-header">
            <span>Symbol</span>
            <span>Trade Type</span>
            <span>Entry Date</span>
            <span>Entry Price</span>
            <span>Quantity</span>
            <span>Exit Date</span>
            <span>Exit Price</span>
            <span>P/L</span>
        </div>
        ${breakoutCards}
        <details class="card-detail">
            <summary>
                <span class="symbol">Show all scanned symbols</span>
                <span>${mostActiveSymbols.length} symbols</span>
                <span>Debug View</span>
                <span>Optional</span>
            </summary>
            <div class="detail-grid">
                <div class="detail-panel" style="grid-column: 1 / -1;">
                    <h3>Scanned Symbols</h3>
                    <table class="table compact">
                        <thead>
                            <tr>
                                <th>#</th>
                                <th>Symbol</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${mostActiveSymbols.length
            ? mostActiveSymbols.map((s, index) => `
                            <tr>
                                <td>${index + 1}</td>
                                <td>${escapeHtml(s.symbol)}</td>
                            </tr>`).join('')
            : '<tr><td colspan="2" class="muted">No scanned symbols recorded for this session.</td></tr>'}
                        </tbody>
                    </table>
                </div>
            </div>
        </details>
    </section>
    <section class="panel">
        <h2>Artifacts</h2>
        <table class="table">
            <tbody>
                <tr><th>HTML</th><td>${artifacts.htmlRelativePath ? `<a href="/reports/${encodeURI(artifacts.htmlRelativePath)}" target="_self">Open HTML report</a>` : 'n/a'}</td></tr>
                <tr><th>PDF</th><td>${artifacts.pdfRelativePath ? `<a href="/reports/${encodeURI(artifacts.pdfRelativePath)}" target="_self">Open PDF report</a>` : 'n/a'}</td></tr>
            </tbody>
        </table>
    </section>
    <section class="panel">
        <h2>Notes</h2>
        <ul>${(record.notes ?? []).map((note) => `<li>${escapeHtml(note)}</li>`).join('')}</ul>
    </section>
</body>
</html>`;
}

async function loadDailySessionRecord(sessionDate: string): Promise<DailySessionRecord | null> {
    return readDailySessionRecord(sessionDate);
}

function loadReplayTradeMonitorEvents(sessionDate: string): TradeEvent[] | null {
    const record = readDailySessionRecord(sessionDate);
    return loadReplayTradeMonitorEventsFromRecord(record, strategyConfig.sessionTimezone);
}

function tradeMonitorSessionDates(): string[] {
    const dates = new Set<string>();

    if (
        appState.backtestProgress
        && isValidSessionDate(appState.backtestProgress.startSessionDate)
        && isValidSessionDate(appState.backtestProgress.endSessionDate)
    ) {
        const start = parseAnchorDateInput(appState.backtestProgress.startSessionDate).dateUtc;
        const end = parseAnchorDateInput(appState.backtestProgress.endSessionDate).dateUtc;

        for (const current = new Date(start); current.getTime() <= end.getTime(); current.setUTCDate(current.getUTCDate() + 1)) {
            const dayOfWeek = current.getUTCDay();
            if (dayOfWeek === 0 || dayOfWeek === 6) {
                continue;
            }

            dates.add(isoDateUTC(current));
        }
    }

    const preferred = persistenceSessionDate();
    if (preferred) {
        dates.add(preferred);
    }

    if (!dates.size && fs.existsSync(dailySessionDir)) {
        const latest = fs.readdirSync(dailySessionDir)
            .filter((entry) => /^\d{4}-\d{2}-\d{2}\.json$/.test(entry))
            .map((entry) => entry.slice(0, -5))
            .sort((left, right) => left.localeCompare(right))
            .pop();

        if (latest) {
            dates.add(latest);
        }
    }

    return Array.from(dates.values()).sort((left, right) => left.localeCompare(right));
}

function loadCanonicalTradeMonitorEvents(): TradeEvent[] {
    const records = tradeMonitorSessionDates()
        .map((sessionDate) => readDailySessionRecord(sessionDate))
        .filter((record): record is DailySessionRecord => record !== null);

    return toCanonicalTradeMonitorEvents({
        records,
        sessionTimezone: strategyConfig.sessionTimezone,
    });
}

function nyDateString(date = new Date()): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    });
    return formatter.format(date);
}

function parseAnchorDateInput(anchorDate?: string): { isoDate: string; dateUtc: Date } {
    const raw = typeof anchorDate === 'string' && anchorDate.trim() !== ''
        ? anchorDate.trim()
        : nyDateString();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        throw new Error('Invalid anchor date. Use YYYY-MM-DD.');
    }

    const [year, month, day] = raw.split('-').map(Number);
    const dateUtc = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(dateUtc.getTime())) {
        throw new Error('Invalid anchor date. Use YYYY-MM-DD.');
    }

    return {
        isoDate: raw,
        dateUtc,
    };
}

function isoDateUTC(date: Date): string {
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function relativeReportPath(fullPath: string): string {
    return path.relative(reportsDir, fullPath).split(path.sep).join('/');
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function candidateTradeTypeLabel(value: CandidateTradeType): string {
    if (value === 'LONG') {
        return 'Long';
    }

    if (value === 'SHORT') {
        return 'Short';
    }

    return 'Long and Short';
}

function nySessionOpenTimestampMs(sessionDate: string): number {
    const [year, month, day] = sessionDate.split('-').map(Number);
    // New York 09:30 ET is UTC+4 during DST for current project assumptions.
    return Date.UTC(year, month - 1, day, 13, 30, 0, 0);
}

function barsForSessionDate(bars: Bar[], sessionDate: string): Bar[] {
    return bars
        .filter((bar) => toNyParts(bar.timestamp, strategyConfig.sessionTimezone).date === sessionDate)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
}

function renderCandidateChartSvg(params: {
    bars: Bar[];
    sessionDate: string;
    determinationTimestamp: string;
    entryTimestamp?: string;
    entryPrice: number;
    stopPrice: number;
    targetPrice: number;
    closePrice: number | null;
    closeTimestamp?: string | null;
    openingRangeMinutes: number;
    maxBarsAfterDetermination: number;
}): string {
    const {
        bars,
        sessionDate,
        determinationTimestamp,
        entryTimestamp,
        entryPrice,
        stopPrice,
        targetPrice,
        closePrice,
        closeTimestamp,
        openingRangeMinutes,
        maxBarsAfterDetermination,
    } = params;

    if (!bars.length) {
        return '<div class="small text-muted">No bar data available for this candidate.</div>';
    }

    const determinationMs = new Date(determinationTimestamp).getTime();
    const entryMs = typeof entryTimestamp === 'string' && entryTimestamp.trim() !== ''
        ? new Date(entryTimestamp).getTime()
        : determinationMs;
    const hasEntryTimestamp = Number.isFinite(entryMs);
    const closeMs = typeof closeTimestamp === 'string' ? new Date(closeTimestamp).getTime() : Number.NaN;
    const hasCloseTimestamp = Number.isFinite(closeMs);
    const sortedBars = [...bars].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    const determinationIndex = sortedBars.findIndex((bar) => new Date(bar.timestamp).getTime() >= determinationMs);
    const determinationCutoff = determinationIndex >= 0 ? determinationIndex : sortedBars.length - 1;
    const closeIndex = hasCloseTimestamp
        ? sortedBars.findIndex((bar) => new Date(bar.timestamp).getTime() >= closeMs)
        : -1;
    const entryIndex = hasEntryTimestamp
        ? sortedBars.findIndex((bar) => new Date(bar.timestamp).getTime() >= entryMs)
        : -1;
    const closeCutoff = hasCloseTimestamp
        ? (closeIndex >= 0 ? closeIndex : sortedBars.length - 1)
        : -1;
    const entryCutoff = hasEntryTimestamp
        ? (entryIndex >= 0 ? entryIndex : sortedBars.length - 1)
        : -1;
    const eventCutoff = Math.max(determinationCutoff, closeCutoff, entryCutoff, 0);
    const chartBars = sortedBars.slice(0, Math.min(sortedBars.length, eventCutoff + 1 + maxBarsAfterDetermination));

    if (!chartBars.length) {
        return '<div class="small text-muted">No bars found in chart window.</div>';
    }

    const plotWidth = 820;
    const plotHeight = 250;
    const margin = { top: 14, right: 18, bottom: 90, left: 52 };
    const width = plotWidth + margin.left + margin.right;
    const height = plotHeight + margin.top + margin.bottom;

    const highs = chartBars.map((bar) => bar.high);
    const lows = chartBars.map((bar) => bar.low);
    const overlayValues = [entryPrice, stopPrice, targetPrice, closePrice ?? undefined].filter(
        (value): value is number => typeof value === 'number' && Number.isFinite(value)
    );
    const maxValue = Math.max(...highs, ...overlayValues);
    const minValue = Math.min(...lows, ...overlayValues);
    const pad = Math.max((maxValue - minValue) * 0.08, 0.25);
    const yMax = maxValue + pad;
    const yMin = Math.max(0, minValue - pad);
    const range = Math.max(0.0001, yMax - yMin);

    const xForIndex = (index: number) => {
        if (chartBars.length <= 1) return margin.left + plotWidth / 2;
        return margin.left + (index / (chartBars.length - 1)) * plotWidth;
    };

    const yForPrice = (price: number) => margin.top + ((yMax - price) / range) * plotHeight;
    const candleWidth = Math.max(3, Math.min(12, plotWidth / Math.max(chartBars.length * 1.9, 6)));

    const sessionOpenMs = nySessionOpenTimestampMs(sessionDate);
    const openingRangeEndMs = sessionOpenMs + openingRangeMinutes * 60 * 1000;
    const openingRangeEndIndex = chartBars.findIndex((bar) => new Date(bar.timestamp).getTime() >= openingRangeEndMs);
    const openingRangeStopIndex = openingRangeEndIndex >= 0 ? openingRangeEndIndex : Math.min(chartBars.length - 1, openingRangeMinutes - 1);
    const openingRangeShadeWidth = Math.max(0, xForIndex(openingRangeStopIndex) - xForIndex(0));
    const openingRangeBars = chartBars.filter(
        (bar) => new Date(bar.timestamp).getTime() < openingRangeEndMs
    );
    const openingRangeHigh = openingRangeBars.length
        ? Math.max(...openingRangeBars.map((bar) => bar.high))
        : null;
    const openingRangeLow = openingRangeBars.length
        ? Math.min(...openingRangeBars.map((bar) => bar.low))
        : null;

    const yTicks = Array.from({ length: 5 }, (_, i) => {
        const value = yMin + (range * i) / 4;
        return { y: yForPrice(value), label: value.toFixed(2) };
    });

    const xTickStride = Math.max(1, Math.floor(chartBars.length / 7));
    const xTicks = chartBars
        .map((bar, index) => ({ bar, index }))
        .filter(({ index }) => index % xTickStride === 0 || index === chartBars.length - 1)
        .map(({ bar, index }) => ({
            x: xForIndex(index),
            label: escapeHtml(toNyParts(bar.timestamp, strategyConfig.sessionTimezone).hhmm),
        }));

    const overlayLine = (price: number | null | undefined, color: string, dash = 'none') => {
        if (typeof price !== 'number' || !Number.isFinite(price)) return '';
        const y = yForPrice(price);
        const dashAttr = dash === 'none' ? '' : ` stroke-dasharray="${dash}"`;
        return `<line x1="${margin.left}" y1="${y}" x2="${margin.left + plotWidth}" y2="${y}" stroke="${color}" stroke-width="1.2"${dashAttr} />`;
    };

    const candlesSvg = chartBars
        .map((bar, index) => {
            const x = xForIndex(index);
            const openY = yForPrice(bar.open);
            const closeY = yForPrice(bar.close);
            const highY = yForPrice(bar.high);
            const lowY = yForPrice(bar.low);
            const bodyTop = Math.min(openY, closeY);
            const bodyHeight = Math.max(1, Math.abs(closeY - openY));
            const color = bar.close >= bar.open ? '#22c55e' : '#ef4444';
            return `<g>
                <line x1="${x}" y1="${highY}" x2="${x}" y2="${lowY}" stroke="#cbd5e1" stroke-width="1" />
                <rect x="${x - candleWidth / 2}" y="${bodyTop}" width="${candleWidth}" height="${bodyHeight}" fill="${color}" opacity="0.95" />
            </g>`;
        })
        .join('');

    const postClosePolylinePoints = chartBars
        .map((bar, index) => ({ index, close: bar.close, time: new Date(bar.timestamp).getTime() }))
        .filter((point) => point.time > determinationMs)
        .map((point) => `${xForIndex(point.index)},${yForPrice(point.close)}`)
        .join(' ');

    const xDetermination = xForIndex(Math.min(Math.max(determinationCutoff, 0), chartBars.length - 1));
    const closeCutoffInChart = hasCloseTimestamp
        ? chartBars.findIndex((bar) => new Date(bar.timestamp).getTime() >= closeMs)
        : -1;
    const xClose = hasCloseTimestamp
        ? xForIndex(Math.min(Math.max(closeCutoffInChart >= 0 ? closeCutoffInChart : chartBars.length - 1, 0), chartBars.length - 1))
        : null;
    const entryCutoffInChart = hasEntryTimestamp
        ? chartBars.findIndex((bar) => new Date(bar.timestamp).getTime() >= entryMs)
        : -1;
    const xEntry = hasEntryTimestamp
        ? xForIndex(Math.min(Math.max(entryCutoffInChart >= 0 ? entryCutoffInChart : chartBars.length - 1, 0), chartBars.length - 1))
        : null;

    const labelBaseY = margin.top + plotHeight + 8;
    const timeLabelY = margin.top + plotHeight + 20;
    const legendY = margin.top + plotHeight + 34;
    const legendStartX = margin.left + 4;
    const yEntry = Number.isFinite(entryPrice) ? yForPrice(entryPrice) : null;
    const entryMarkerSvg = xEntry == null || yEntry == null
        ? ''
        : `<polygon points="${xEntry},${yEntry - 8} ${xEntry - 6},${yEntry + 4} ${xEntry + 6},${yEntry + 4}" fill="#38bdf8" stroke="#0ea5e9" stroke-width="1" />`;
    const lineLegendItems = [
        { label: 'OR High/Low', color: '#facc15', dash: '4 4' },
        { label: 'Stop', color: '#f97316', dash: '6 3' },
        { label: 'Target', color: '#22c55e', dash: '6 3' },
        ...(typeof closePrice === 'number' && Number.isFinite(closePrice)
            ? [{ label: 'Close', color: '#a78bfa', dash: '2 3' }]
            : []),
    ] as const;
    const entryLegendX = legendStartX;
    const lineLegendStartX = legendStartX + 132;
    const legendSvg = [
        `<g>
            <polygon points="${entryLegendX + 10},${legendY - 7} ${entryLegendX + 4},${legendY + 5} ${entryLegendX + 16},${legendY + 5}" fill="#38bdf8" stroke="#0ea5e9" stroke-width="1" />
            <text x="${entryLegendX + 24}" y="${legendY + 4}" fill="#cbd5e1" font-size="11">Entry triangle</text>
        </g>`,
        ...lineLegendItems.map((item, index) => {
            const itemWidth = 126;
            const x = lineLegendStartX + index * itemWidth;
            return `<g>
                <line x1="${x}" y1="${legendY}" x2="${x + 22}" y2="${legendY}" stroke="${item.color}" stroke-width="1.8" stroke-dasharray="${item.dash}" />
                <text x="${x + 28}" y="${legendY + 4}" fill="#cbd5e1" font-size="11">${item.label}</text>
            </g>`;
        }),
    ].join('');

    return `<svg class="candidate-live-chart-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="Live candidate candlestick chart">
        <rect x="0" y="0" width="${width}" height="${height}" fill="rgba(15,23,42,0.72)" rx="8" />
        <rect x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="rgba(15,23,42,0.48)" />
        <rect x="${xForIndex(0)}" y="${margin.top}" width="${openingRangeShadeWidth}" height="${plotHeight}" fill="rgba(14,165,233,0.09)" />
        <line x1="${margin.left}" y1="${margin.top + plotHeight}" x2="${margin.left + plotWidth}" y2="${margin.top + plotHeight}" stroke="#475569" stroke-width="1" />
        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotHeight}" stroke="#475569" stroke-width="1" />
        ${yTicks.map((tick) => `<g><line x1="${margin.left}" y1="${tick.y}" x2="${margin.left + plotWidth}" y2="${tick.y}" stroke="rgba(148,163,184,0.18)" /><text x="${margin.left - 8}" y="${tick.y + 4}" fill="#cbd5e1" font-size="11" text-anchor="end">${tick.label}</text></g>`).join('')}
        ${xTicks.map((tick) => `<text x="${tick.x}" y="${timeLabelY}" fill="#cbd5e1" font-size="11" text-anchor="middle">${tick.label}</text>`).join('')}
        ${overlayLine(openingRangeHigh, '#facc15', '4 4')}
        ${overlayLine(openingRangeLow, '#facc15', '4 4')}
        ${overlayLine(stopPrice, '#f97316', '6 3')}
        ${overlayLine(targetPrice, '#22c55e', '6 3')}
        ${overlayLine(closePrice, '#a78bfa', '2 3')}
        ${candlesSvg}
        ${entryMarkerSvg}
        <line x1="${xDetermination}" y1="${margin.top}" x2="${xDetermination}" y2="${margin.top + plotHeight}" stroke="#60a5fa" stroke-width="1" stroke-dasharray="5 4" />
        ${xClose == null ? '' : `<line x1="${xClose}" y1="${margin.top}" x2="${xClose}" y2="${margin.top + plotHeight}" stroke="#a78bfa" stroke-width="1" stroke-dasharray="3 3" />`}
        ${postClosePolylinePoints ? `<polyline points="${postClosePolylinePoints}" fill="none" stroke="#60a5fa" stroke-width="1.7" />` : ''}
        <text x="${margin.left + 6}" y="${margin.top + 14}" fill="#94a3b8" font-size="11">OR window</text>
        <text x="${xDetermination}" y="${labelBaseY}" fill="#93c5fd" font-size="11" text-anchor="start" transform="rotate(90 ${xDetermination} ${labelBaseY})">Determination end</text>
        ${xClose == null ? '' : `<text x="${xClose}" y="${labelBaseY}" fill="#c4b5fd" font-size="11" text-anchor="start" transform="rotate(90 ${xClose} ${labelBaseY})">Trade close</text>`}
        ${legendSvg}
    </svg>`;
}

async function buildLiveCandidateCharts(limit = 8): Promise<CandidateChartCard[]> {
    const latestOpenBySymbol = new Map<string, TradeEvent>();
    const latestCloseBySymbol = new Map<string, TradeEvent>();

    for (const event of tradeEvents) {
        if (event.eventType === 'open') {
            latestOpenBySymbol.set(event.symbol, event);
            continue;
        }
        if (event.eventType === 'close') {
            latestCloseBySymbol.set(event.symbol, event);
        }
    }

    const candidateOpens = [...latestOpenBySymbol.values()]
        .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
        .slice(0, Math.max(1, limit));

    if (!candidateOpens.length) {
        return [];
    }

    const client = new AlpacaClient();
    const cards = await Promise.all(candidateOpens.map(async (openEvent) => {
        if (
            typeof openEvent.entryPrice !== 'number'
            || typeof openEvent.stopPrice !== 'number'
            || typeof openEvent.targetPrice !== 'number'
            || typeof openEvent.qty !== 'number'
        ) {
            return null;
        }

        const sessionDate = openEvent.sessionDate || toNyParts(openEvent.timestamp, strategyConfig.sessionTimezone).date;
        const closeEvent = latestCloseBySymbol.get(openEvent.symbol);

        try {
            const bars = await client.getIntradayBars(openEvent.symbol, sessionDate);
            const sessionBars = barsForSessionDate(bars, sessionDate);
            const svg = renderCandidateChartSvg({
                bars: sessionBars,
                sessionDate,
                determinationTimestamp: openEvent.timestamp,
                entryTimestamp: openEvent.timestamp,
                entryPrice: openEvent.entryPrice,
                stopPrice: openEvent.stopPrice,
                targetPrice: openEvent.targetPrice,
                closePrice: typeof closeEvent?.closePrice === 'number' ? closeEvent.closePrice : null,
                closeTimestamp: closeEvent?.timestamp ?? null,
                openingRangeMinutes: strategyConfig.openingRangeMinutes,
                maxBarsAfterDetermination: 30,
            });

            return {
                symbol: openEvent.symbol,
                sessionDate,
                side: openEvent.side,
                position: openEvent.position,
                qty: openEvent.qty,
                entryPrice: openEvent.entryPrice,
                stopPrice: openEvent.stopPrice,
                targetPrice: openEvent.targetPrice,
                closePrice: typeof closeEvent?.closePrice === 'number' ? closeEvent.closePrice : null,
                closeTimestamp: closeEvent?.timestamp ?? null,
                svg,
                determinationTimestamp: openEvent.timestamp,
            } as CandidateChartCard;
        } catch (error) {
            logger.warn('Failed building live candidate chart', {
                symbol: openEvent.symbol,
                sessionDate,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }));

    return cards.filter((card): card is CandidateChartCard => card !== null);
}

function writeHtmlReport(filePath: string, html: string) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, html, 'utf8');
}

function pnlClass(value: number): 'pnl-profit' | 'pnl-loss' | 'pnl-flat' {
    if (value > 0) return 'pnl-profit';
    if (value < 0) return 'pnl-loss';
    return 'pnl-flat';
}

async function renderHtmlToPdf(htmlPath: string, pdfPath: string) {
    const browser = await puppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });

    try {
        const page = await browser.newPage();
        await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle0' });
        await page.pdf({
            path: pdfPath,
            format: 'A4',
            landscape: true,
            printBackground: true,
            margin: {
                top: '0.5in',
                right: '0.5in',
                bottom: '0.5in',
                left: '0.5in',
            },
        });
    } finally {
        await browser.close();
    }
}

type DailySessionWithCharts = {
    record: DailySessionRecord;
    chartSnapshots: Map<string, DailySymbolSnapshot>;
};

type WeeklyTradingActivityReport = {
    title: string;
    weekStartDate: string;
    weekEndDate: string;
    longs: number;
    shorts: number;
    pnl: number;
    dailyRowsData: Array<{
        sessionDate: string;
        longs: number;
        shorts: number;
        pnl: number;
        breakoutCandidatesCount: number;
        openTrades: number;
        closedTrades: number;
        dailyWithCharts: DailySessionWithCharts;
    }>;
};

type MonthlyTradingActivityReport = {
    title: string;
    monthLabel: string;
    totalLongs: number;
    totalShorts: number;
    totalPnl: number;
    weeklyReports: WeeklyTradingActivityReport[];
};

async function buildWeeklyTradingActivityReport(anchorDate: Date): Promise<WeeklyTradingActivityReport> {
    const anchorIso = isoDateUTC(anchorDate);
    const anchorWeekday = anchorDate.getUTCDay();
    const mondayOffset = (anchorWeekday + 6) % 7;
    const weekStart = new Date(Date.UTC(
        anchorDate.getUTCFullYear(),
        anchorDate.getUTCMonth(),
        anchorDate.getUTCDate() - mondayOffset,
    ));
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekStart.getUTCDate() + 4);

    const weekStartDate = isoDateUTC(weekStart);
    const weekEndDate = isoDateUTC(weekEnd);
    const todayNy = nyDateString();

    const effectiveEndDate = weekEndDate < todayNy ? weekEndDate : todayNy;

    const dailyRowsData: Array<{
        sessionDate: string;
        longs: number;
        shorts: number;
        pnl: number;
        breakoutCandidatesCount: number;
        openTrades: number;
        closedTrades: number;
        dailyWithCharts: DailySessionWithCharts;
    }> = [];

    for (const current = new Date(weekStart); isoDateUTC(current) <= effectiveEndDate; current.setUTCDate(current.getUTCDate() + 1)) {
        const dayOfWeek = current.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            continue;
        }

        const sessionDate = isoDateUTC(current);

        try {
            const daily = await loadDailySessionRecord(sessionDate);
            if (!daily) {
                continue;
            }

            const candidates = daily.breakoutCandidates ?? daily.evaluationRows
                ?.filter((row) => (row.side && row.side !== 'none') || row.breakoutPrice != null)
                .map((row) => ({
                    symbol: row.symbol,
                    side: row.side === 'sell' ? 'sell' : row.side === 'buy' ? 'buy' : undefined,
                    price: row.breakoutPrice ?? undefined,
                })) ?? [];
            const symbols = candidates.map((c) => c.symbol);

            const chartSnapshots = await buildDailySymbolCharts({
                record: daily,
                symbols,
                openingRangeMinutes: strategyConfig.openingRangeMinutes,
                barsForSessionDate,
                renderCandidateChartSvg,
                readDailySessionRecord,
                writeDailySessionRecordAtomic,
                logWarn: (message, payload) => logger.warn(message, payload),
            });

            const sessionEvents = Array.isArray(daily.sessionEvents) ? daily.sessionEvents : [];
            const closeEvents = sessionEvents.filter((e) => e.eventType === 'close');
            const openEvents = sessionEvents.filter((e) => e.eventType === 'open');

            dailyRowsData.push({
                sessionDate,
                longs: daily.totals?.numberOfCandidatesSoldLong ?? 0,
                shorts: daily.totals?.numberOfCandidatesBoughtShort ?? 0,
                pnl: daily.totals?.totalProfitLossToDate ?? 0,
                breakoutCandidatesCount: candidates.length,
                openTrades: openEvents.length - closeEvents.length,
                closedTrades: closeEvents.length,
                dailyWithCharts: {
                    record: daily,
                    chartSnapshots,
                },
            });
        } catch {
            // Skip unavailable sessions (future/holiday/no data) instead of failing entire weekly report.
        }
    }

    const totalLongs = dailyRowsData.reduce((sum, day) => sum + day.longs, 0);
    const totalShorts = dailyRowsData.reduce((sum, day) => sum + day.shorts, 0);
    const totalPnl = dailyRowsData.reduce((sum, day) => sum + day.pnl, 0);

    return {
        title: `Weekly ORB Drilldown Report for the Week of ${weekStartDate} through ${weekEndDate}`,
        weekStartDate,
        weekEndDate,
        longs: totalLongs,
        shorts: totalShorts,
        pnl: totalPnl,
        dailyRowsData,
    };
}

function renderEmbeddedDailyDetail(dailyWithCharts: DailySessionWithCharts, sessionDate: string): string {
    const record = dailyWithCharts.record;
    const chartSnapshots = dailyWithCharts.chartSnapshots;

    const candidateTradeActivityValue = record.candidateTradeActivity;
    const candidateTradeActivitySummary = (
        candidateTradeActivityValue
        && !Array.isArray(candidateTradeActivityValue)
    ) ? candidateTradeActivityValue : {};
    const totals = record.totals ?? candidateTradeActivitySummary;
    const mostActiveSymbols = record.mostActiveSymbols ?? [];
    const insufficientSymbols = record.insufficientSymbols ?? [];
    const evaluationRows = record.evaluationRows ?? [];
    const breakoutCandidates = record.breakoutCandidates ?? [];
    const emulatedTrades = record.emulatedTrades ?? [];
    const finalOutcomes = record.finalOutcomes ?? [];

    const fmt = (value: number | null | undefined, digits = 2) => (
        typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
    );

    const rowBySymbol = new Map(evaluationRows.map((row) => [row.symbol, row]));
    const emulatedBySymbol = new Map(emulatedTrades.map((row) => [row.symbol, row]));
    const outcomeBySymbol = new Map(finalOutcomes.map((row) => [row.symbol, row]));

    const candidateRows = breakoutCandidates.length
        ? breakoutCandidates.map((candidate) => {
            const row = rowBySymbol.get(candidate.symbol);
            const trade = emulatedBySymbol.get(candidate.symbol);
            const outcome = outcomeBySymbol.get(candidate.symbol);
            const symbolId = `sym-${sessionDate}-${candidate.symbol}`;
            const snapshot = chartSnapshots.get(candidate.symbol);
            const chartContent = snapshot?.chartSvg
                ? `<div class="symbol-chart-container">${snapshot.chartSvg}</div>`
                : '<p class="no-chart">Chart not available.</p>';
            return `
            <tr class="symbol-row" onclick="toggleSymbolDetail('${symbolId}', this)">
                <td>${escapeHtml(candidate.symbol)}</td>
                <td>${escapeHtml((candidate.side ?? 'n/a').toUpperCase())}</td>
                <td>${fmt(trade?.price ?? candidate.price)}</td>
                <td>${fmt(trade?.qty, 4)}</td>
                <td>${fmt(outcome?.exitPrice)}</td>
                <td class="${pnlClass(outcome?.pnl ?? 0)}">${fmt(outcome?.pnl)}</td>
                <td>${escapeHtml((outcome?.status ?? 'n/a').toUpperCase())}</td>
            </tr>
            <tr class="symbol-detail-row" id="${symbolId}" style="display:none">
                <td colspan="7">
                    <div class="symbol-detail-inner">
                        <div class="symbol-detail-section">
                            <strong>Symbol Details:</strong> ${escapeHtml(candidate.symbol)} |
                            Entry: ${fmt(trade?.price ?? candidate.price)} |
                            Qty: ${fmt(trade?.qty, 4)} |
                            Exit: ${fmt(outcome?.exitPrice)} |
                            P/L: <span class="${pnlClass(outcome?.pnl ?? 0)}">${fmt(outcome?.pnl)}</span> |
                            Status: ${escapeHtml((outcome?.status ?? 'n/a').toUpperCase())}
                        </div>
                        <div class="symbol-chart-wrapper">${chartContent}</div>
                    </div>
                </td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="7">No breakout candidates for this session.</td></tr>';

    const referenceSymbol = record.strategy?.referenceSymbol ?? record.strategy?.symbol ?? 'n/a';
    const qualityFiltersEnabled = record.breakoutFilters?.breakoutQualityFiltersEnabled
        ?? record.breakoutFilters?.enabled;
    const confirmationMinutes = record.breakoutFilters?.breakoutConfirmationCandleMinutes
        ?? record.breakoutFilters?.confirmationCandleMinutes;
    const minVolumeExpansion = record.breakoutFilters?.breakoutMinVolumeExpansion
        ?? record.breakoutFilters?.minVolumeExpansion;
    const minRelativeStrengthPct = record.breakoutFilters?.breakoutMinRelativeStrengthPct
        ?? record.breakoutFilters?.minRelativeStrengthPct;

    return `
    <div class="day-detail-inner">
        <div class="day-summary-grid">
            <div class="day-metric"><span class="day-metric-label">Candidates</span><span class="day-metric-value">${totals.totalCandidatesBoughtAtStart ?? 0}</span></div>
            <div class="day-metric"><span class="day-metric-label">Sold Long</span><span class="day-metric-value">${totals.numberOfCandidatesSoldLong ?? 0}</span></div>
            <div class="day-metric"><span class="day-metric-label">Bought Short</span><span class="day-metric-value">${totals.numberOfCandidatesBoughtShort ?? 0}</span></div>
            <div class="day-metric"><span class="day-metric-label">P/L</span><span class="day-metric-value ${pnlClass(totals.totalProfitLossToDate ?? 0)}">${fmt(totals.totalProfitLossToDate)}</span></div>
        </div>
        <div class="day-section">
            <strong>Market Scan:</strong>
            Max Bars: ${record.marketScan?.maxSessionBars ?? 0} |
            Scanned: ${record.mostActiveSymbolCount ?? mostActiveSymbols.length} |
            Insufficient: ${insufficientSymbols.length} |
            Type: ${escapeHtml(record.marketScan?.candidateTradeType ?? 'n/a')}
        </div>
        <div class="day-section">
            <strong>Breakout Filters:</strong>
            ${qualityFiltersEnabled == null ? 'n/a' : (qualityFiltersEnabled ? 'Enabled' : 'Disabled')} |
            Confirm: ${confirmationMinutes ?? 'n/a'}m |
            Min Vol Exp: ${fmt(minVolumeExpansion)} |
            Min RS: ${fmt(minRelativeStrengthPct)}%
        </div>
        <div class="day-section">
            <strong>Breakout Candidates</strong> (click a row to view chart)
            <table class="day-candidates-table">
                <thead>
                    <tr>
                        <th>Symbol</th>
                        <th>Side</th>
                        <th>Entry</th>
                        <th>Qty</th>
                        <th>Exit</th>
                        <th>P/L</th>
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    ${candidateRows}
                </tbody>
            </table>
        </div>
    </div>`;
}

function renderWeeklyTradingActivityHtml(weeklyReport: WeeklyTradingActivityReport): string {
    const dailyRows = weeklyReport.dailyRowsData.length
        ? weeklyReport.dailyRowsData.map((day) => {
            const dayDetail = renderEmbeddedDailyDetail(day.dailyWithCharts, day.sessionDate);
            return `
            <tr>
                <td>${escapeHtml(day.sessionDate)}</td>
                <td>${day.longs}</td>
                <td>${day.shorts}</td>
                <td>${day.breakoutCandidatesCount}</td>
                <td>${day.openTrades}</td>
                <td>${day.closedTrades}</td>
                <td class="${pnlClass(day.pnl)}">${day.pnl.toFixed(2)}</td>
                <td><button class="day-detail-toggle" onclick="toggleDayDetail('day-${escapeHtml(day.sessionDate)}', this)">Show Details</button></td>
            </tr>
            <tr class="day-detail-row" id="day-${escapeHtml(day.sessionDate)}" style="display:none">
                <td colspan="8">
                    ${dayDetail}
                </td>
            </tr>`;
        }).join('')
        : `<tr>
            <td colspan="8">No reportable trading sessions available yet for this week.</td>
        </tr>`;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Weekly Trading Activity ${escapeHtml(weeklyReport.weekEndDate)}</title>
    <style>
        body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(180deg, #f4f7fb, #eef3f9); color: #102a43; padding: 24px; }
        .panel { background: white; border-radius: 14px; padding: 20px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08); margin-bottom: 16px; border: 1px solid #e6edf5; }
        h1, h2 { margin: 0 0 10px; letter-spacing: 0.01em; }
        p { margin: 0; color: #334e68; }
        table { width: 100%; border-collapse: collapse; border: 1px solid #d9e2ec; border-radius: 10px; overflow: hidden; }
        th, td { border-bottom: 1px solid #d9e2ec; padding: 10px; text-align: left; }
        thead th { background: #edf3fb; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
        tbody tr:nth-child(even) { background: #f9fbfe; }
        tbody tr:hover { background: #f1f6fd; }
        .pnl-profit { color: #198754; font-weight: 700; }
        .pnl-loss { color: #dc3545; font-weight: 700; }
        .pnl-flat { color: #6c757d; font-weight: 700; }
        button { color: #0d6efd; background: none; border: 1px solid #0d6efd; border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
        button:hover { background: #e7f1ff; }
        .day-detail-row td { padding: 0; background: #f8fafc; }
        .day-detail-inner { padding: 16px; }
        .day-summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px; }
        .day-metric { background: white; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px; }
        .day-metric-label { font-size: 10px; text-transform: uppercase; letter-spacing: .06em; color: #64748b; display: block; }
        .day-metric-value { font-size: 18px; font-weight: 700; display: block; margin-top: 4px; }
        .day-candidates-table { width: 100%; border-collapse: collapse; margin-top: 12px; }
        .day-candidates-table th, .day-candidates-table td { border: 1px solid #d9e2ec; padding: 6px 8px; text-align: left; font-size: 12px; }
        .day-candidates-table th { background: #edf3fb; text-transform: uppercase; font-size: 10px; }
        .day-detail-note { font-size: 11px; color: #64748b; margin-top: 8px; }
        .day-section { margin-bottom: 16px; }
        .day-section:last-child { margin-bottom: 0; }
        .symbol-row { cursor: pointer; }
        .symbol-row:hover { background: #f1f5f9; }
        .symbol-detail-row { background: #f8fafc; }
        .symbol-detail-inner { padding: 12px; }
        .symbol-detail-section { font-size: 12px; margin-bottom: 8px; }
        .symbol-chart-wrapper { margin-top: 8px; }
        .symbol-chart-wrapper svg { max-width: 100%; height: auto; }
        .no-chart { font-size: 11px; color: #64748b; font-style: italic; }
    </style>
    <script>
        function toggleDayDetail(id, btn) {
            var row = document.getElementById(id);
            if (row.style.display === 'none') {
                row.style.display = 'table-row';
                btn.textContent = 'Hide Details';
            } else {
                row.style.display = 'none';
                btn.textContent = 'Show Details';
            }
        }
        function toggleSymbolDetail(id, row) {
            var detailRow = document.getElementById(id);
            if (detailRow.style.display === 'none') {
                detailRow.style.display = 'table-row';
                row.style.background = '#e2e8f0';
            } else {
                detailRow.style.display = 'none';
                row.style.background = '';
            }
        }
    </script>
</head>
<body>
    <section class="panel">
        <h1>${escapeHtml(weeklyReport.title)}</h1>
        <p>Breakout Candidate Trade Type: ${escapeHtml(candidateTradeTypeLabel(env.candidateTradeType))}</p>
        <p>Totals | Longs: ${weeklyReport.longs} | Shorts: ${weeklyReport.shorts} | P/L: <span class="${pnlClass(weeklyReport.pnl)}">${weeklyReport.pnl.toFixed(2)}</span></p>
    </section>
    <section class="panel">
        <h2>Daily Drilldown</h2>
        <table>
            <thead>
                <tr>
                    <th>Session Date</th>
                    <th>Longs</th>
                    <th>Shorts</th>
                    <th># Breakout</th>
                    <th># Open</th>
                    <th># Closed</th>
                    <th>P/L</th>
                    <th>Details</th>
                </tr>
            </thead>
            <tbody>
                ${dailyRows}
            </tbody>
        </table>
    </section>
</body>
</html>`;
}

async function buildMonthlyTradingActivityReport(anchorDate: Date): Promise<MonthlyTradingActivityReport> {
    const year = anchorDate.getUTCFullYear();
    const month = anchorDate.getUTCMonth() + 1;
    const firstDay = new Date(Date.UTC(year, month - 1, 1));
    const lastDay = new Date(Date.UTC(year, month, 0));

    const mondayKeys = new Set<string>();
    for (const day = new Date(firstDay); day.getTime() <= lastDay.getTime(); day.setUTCDate(day.getUTCDate() + 1)) {
        const dayOfWeek = day.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            continue;
        }
        const monday = new Date(day);
        monday.setUTCDate(day.getUTCDate() - ((dayOfWeek + 6) % 7));
        mondayKeys.add(isoDateUTC(monday));
    }

    const weekAnchors = [...mondayKeys]
        .sort()
        .map((iso) => new Date(`${iso}T00:00:00Z`));

    const weeklyReports: WeeklyTradingActivityReport[] = [];

    for (const weekAnchor of weekAnchors) {
        try {
            const weeklyReport = await buildWeeklyTradingActivityReport(weekAnchor);
            weeklyReports.push(weeklyReport);
        } catch {
            // Skip weeks with no available market session data instead of failing the whole month report.
        }
    }

    if (!weeklyReports.length) {
        throw new Error(`No reportable weekly data available for month ${year}-${String(month).padStart(2, '0')}.`);
    }

    const totalLongs = weeklyReports.reduce((sum, report) => sum + report.longs, 0);
    const totalShorts = weeklyReports.reduce((sum, report) => sum + report.shorts, 0);
    const totalPnl = weeklyReports.reduce((sum, report) => sum + report.pnl, 0);
    const monthLabel = `${year}-${String(month).padStart(2, '0')}`;

    return {
        title: "Month's trading activity",
        monthLabel,
        totalLongs,
        totalShorts,
        totalPnl,
        weeklyReports,
    };
}

function renderMonthlyTradingActivityHtml(monthlyReport: MonthlyTradingActivityReport): string {
    const weeklyRows = monthlyReport.weeklyReports.map((week) => `
        <tr>
            <td>${escapeHtml(`${week.weekStartDate} to ${week.weekEndDate}`)}</td>
            <td>${week.longs}</td>
            <td>${week.shorts}</td>
            <td class="${pnlClass(week.pnl)}">${week.pnl.toFixed(2)}</td>
            <td><a href="/api/reports/render?type=week&anchorDate=${encodeURIComponent(week.weekEndDate)}" target="_self">View Week Details</a></td>
        </tr>`).join('\n');

    const summaryRow = `
        <tr>
            <th>Total</th>
            <th>${monthlyReport.totalLongs}</th>
            <th>${monthlyReport.totalShorts}</th>
            <th class="${pnlClass(monthlyReport.totalPnl)}">${monthlyReport.totalPnl.toFixed(2)}</th>
            <th>-</th>
        </tr>`;

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Monthly Trading Activity ${escapeHtml(monthlyReport.monthLabel)}</title>
    <style>
        body { font-family: 'Segoe UI', -apple-system, BlinkMacSystemFont, sans-serif; background: linear-gradient(180deg, #f4f7fb, #eef3f9); color: #102a43; padding: 24px; }
        .panel { background: white; border-radius: 14px; padding: 20px; box-shadow: 0 10px 28px rgba(15, 23, 42, 0.08); margin-bottom: 16px; border: 1px solid #e6edf5; }
        h1, h2 { margin: 0 0 10px; letter-spacing: 0.01em; }
        p { margin: 0; color: #334e68; }
        table { width: 100%; border-collapse: collapse; border: 1px solid #d9e2ec; border-radius: 10px; overflow: hidden; }
        th, td { border-bottom: 1px solid #d9e2ec; padding: 10px; text-align: left; }
        thead th { background: #edf3fb; font-size: 12px; text-transform: uppercase; letter-spacing: 0.04em; }
        tfoot th { background: #e6edf5; }
        tbody tr:nth-child(even) { background: #f9fbfe; }
        tbody tr:hover { background: #f1f6fd; }
        .pnl-profit { color: #198754; font-weight: 700; }
        .pnl-loss { color: #dc3545; font-weight: 700; }
        .pnl-flat { color: #6c757d; font-weight: 700; }
        a { color: #0d6efd; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <section class="panel">
        <h1>Month's Trading Activity</h1>
        <p>Month: ${escapeHtml(monthlyReport.monthLabel)}</p>
        <p>Breakout Candidate Trade Type: ${escapeHtml(candidateTradeTypeLabel(env.candidateTradeType))}</p>
        <p>Totals | Longs: ${monthlyReport.totalLongs} | Shorts: ${monthlyReport.totalShorts} | P/L: <span class="${pnlClass(monthlyReport.totalPnl)}">${monthlyReport.totalPnl.toFixed(2)}</span></p>
    </section>
    <section class="panel">
        <h2>Weekly Drilldown</h2>
        <table>
            <thead>
                <tr>
                    <th>Week</th>
                    <th>Longs</th>
                    <th>Shorts</th>
                    <th>P/L</th>
                    <th>Details</th>
                </tr>
            </thead>
            <tbody>
                ${weeklyRows}
            </tbody>
            <tfoot>
                ${summaryRow}
            </tfoot>
        </table>
    </section>
</body>
</html>`;
}

type RenderedReportResult = {
    title: string;
    html: string;
    pdfHtml?: string;
    baseName: string;
};

function renderDailySessionPdfHtml(record: DailySessionRecord): string {
    const totals = record.totals ?? {};
    const evaluationRows = record.evaluationRows ?? [];
    const breakoutCandidates = record.breakoutCandidates ?? [];
    const emulatedTrades = record.emulatedTrades ?? [];
    const finalOutcomes = record.finalOutcomes ?? [];
    const mostActiveSymbols = record.mostActiveSymbols ?? [];
    const insufficientSymbols = record.insufficientSymbols ?? [];
    const breakoutFilters = record.breakoutFilters ?? {};
    const rowBySymbol = new Map(evaluationRows.map((row) => [row.symbol, row]));
    const tradeBySymbol = new Map(emulatedTrades.map((row) => [row.symbol, row]));
    const outcomeBySymbol = new Map(finalOutcomes.map((row) => [row.symbol, row]));
    const candidateMap = new Map<string, { symbol: string; side?: 'buy' | 'sell'; price?: number }>();

    for (const candidate of breakoutCandidates) {
        candidateMap.set(candidate.symbol, {
            symbol: candidate.symbol,
            side: candidate.side,
            price: candidate.price,
        });
    }

    for (const row of evaluationRows) {
        if (!candidateMap.has(row.symbol) && ((row.side && row.side !== 'none') || row.breakoutPrice != null)) {
            candidateMap.set(row.symbol, {
                symbol: row.symbol,
                side: row.side === 'sell' ? 'sell' : row.side === 'buy' ? 'buy' : undefined,
                price: row.breakoutPrice ?? undefined,
            });
        }
    }

    const candidates = [...candidateMap.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
    const fmt = (value: number | null | undefined, digits = 2) => (
        typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : 'n/a'
    );
    const qualityValue = (symbol: string) => {
        const quality = rowBySymbol.get(symbol)?.qualityDetail;
        if (!quality) return 'n/a';
        return quality.passed ? 'PASS' : `FAIL (${quality.failReason ?? 'rule'})`;
    };

    const candidateRows = candidates.length
        ? candidates.map((candidate) => {
            const symbol = candidate.symbol;
            const row = rowBySymbol.get(symbol);
            const trade = tradeBySymbol.get(symbol);
            const outcome = outcomeBySymbol.get(symbol);
            const entryTs = row?.confirmationRetestTimestamp ?? row?.breakoutTimestamp ?? 'n/a';
            const exitTs = outcome?.exitTimestamp ?? 'n/a';
            return `<tr>
                <td>${escapeHtml(symbol)}</td>
                <td>${escapeHtml((candidate.side ?? 'n/a').toUpperCase())}</td>
                <td>${escapeHtml(entryTs)}</td>
                <td>${fmt(trade?.price ?? candidate.price)}</td>
                <td>${fmt(trade?.qty, 4)}</td>
                <td>${escapeHtml(exitTs)}</td>
                <td>${fmt(outcome?.exitPrice)}</td>
                <td>${fmt(outcome?.pnl)}</td>
                <td>${escapeHtml(qualityValue(symbol))}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="9">No breakout candidates were recorded for this date.</td></tr>';

    const evaluationRowsHtml = evaluationRows.length
        ? evaluationRows.map((row) => {
            const quality = row.qualityDetail;
            const qualityLabel = quality
                ? (quality.passed ? 'PASS' : `FAIL (${quality.failReason ?? 'rule'})`)
                : 'n/a';
            return `<tr>
                <td>${escapeHtml(row.symbol)}</td>
                <td>${escapeHtml((row.side ?? 'none').toUpperCase())}</td>
                <td>${fmt(row.openingPrice)}</td>
                <td>${fmt(row.openingRangeHigh)}</td>
                <td>${fmt(row.openingRangeLow)}</td>
                <td>${fmt(row.breakoutPrice)}</td>
                <td>${escapeHtml(row.breakoutTimestamp ?? 'n/a')}</td>
                <td>${fmt(row.confirmationRetestPrice)}</td>
                <td>${escapeHtml(row.confirmationRetestTimestamp ?? 'n/a')}</td>
                <td>${fmt(row.atr1m, 4)}</td>
                <td>${escapeHtml(qualityLabel)}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="11">No evaluation rows were recorded for this date.</td></tr>';

    const tradeRows = emulatedTrades.length
        ? emulatedTrades.map((trade) => {
            const outcome = outcomeBySymbol.get(trade.symbol);
            return `<tr>
                <td>${escapeHtml(trade.symbol)}</td>
                <td>${escapeHtml((trade.side ?? 'n/a').toUpperCase())}</td>
                <td>${fmt(trade.price)}</td>
                <td>${fmt(trade.qty, 4)}</td>
                <td>${fmt(trade.stopPrice)}</td>
                <td>${fmt(trade.takeProfitPrice)}</td>
                <td>${escapeHtml((outcome?.status ?? 'n/a').toUpperCase())}</td>
                <td>${fmt(outcome?.exitPrice)}</td>
                <td>${escapeHtml(outcome?.exitTimestamp ?? 'n/a')}</td>
                <td>${fmt(outcome?.pnl)}</td>
            </tr>`;
        }).join('')
        : '<tr><td colspan="10">No emulated trades were executed for this date.</td></tr>';

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>ORB Daily Session ${escapeHtml(record.sessionDate)}</title>
    <style>
        @page { size: A4 landscape; margin: 0.45in; }
        body { font-family: 'Segoe UI', Arial, sans-serif; color: #111827; margin: 0; }
        h1, h2 { margin: 0 0 8px; }
        h3 { margin: 0 0 8px; font-size: 14px; }
        .subtitle { color: #4b5563; margin-bottom: 8px; }
        .panel { border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
        .grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
        .metric { border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; }
        .metric-label { font-size: 11px; color: #6b7280; text-transform: uppercase; }
        .metric-value { font-size: 18px; font-weight: 700; margin-top: 4px; }
        table { width: 100%; border-collapse: collapse; font-size: 11px; }
        th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; vertical-align: top; }
        th { background: #f3f4f6; text-transform: uppercase; font-size: 11px; letter-spacing: .02em; }
        .pill-list { font-size: 11px; color: #374151; line-height: 1.45; }
        .pill-list strong { color: #111827; }
        .tight { margin-top: 6px; }
    </style>
</head>
<body>
    <section class="panel">
        <h1>ORB Daily Session Report</h1>
        <p class="subtitle">Session Date: ${escapeHtml(record.sessionDate)}</p>
        <div class="grid">
            <div class="metric"><div class="metric-label">Candidates</div><div class="metric-value">${totals.totalCandidatesBoughtAtStart ?? 0}</div></div>
            <div class="metric"><div class="metric-label">Sold Long</div><div class="metric-value">${totals.numberOfCandidatesSoldLong ?? 0}</div></div>
            <div class="metric"><div class="metric-label">Bought Short</div><div class="metric-value">${totals.numberOfCandidatesBoughtShort ?? 0}</div></div>
            <div class="metric"><div class="metric-label">P/L</div><div class="metric-value">${Number(totals.totalProfitLossToDate ?? 0).toFixed(2)}</div></div>
        </div>
    </section>
    <section class="panel">
        <h2>Market Scan & Filters</h2>
        <div class="grid">
            <div class="metric"><div class="metric-label">Max Session Bars</div><div class="metric-value">${record.marketScan?.maxSessionBars ?? 0}</div></div>
            <div class="metric"><div class="metric-label">Scanned Symbols</div><div class="metric-value">${record.mostActiveSymbolCount ?? mostActiveSymbols.length}</div></div>
            <div class="metric"><div class="metric-label">Insufficient</div><div class="metric-value">${insufficientSymbols.length}</div></div>
            <div class="metric"><div class="metric-label">Trade Type</div><div class="metric-value">${escapeHtml(record.marketScan?.candidateTradeType ?? 'n/a')}</div></div>
        </div>
        <p class="pill-list tight"><strong>Breakout Filters:</strong>
            Confirm Candle ${breakoutFilters.breakoutConfirmationCandleMinutes ?? 'n/a'}m,
            Quality ${breakoutFilters.breakoutQualityFiltersEnabled === true ? 'Enabled' : breakoutFilters.breakoutQualityFiltersEnabled === false ? 'Disabled' : 'n/a'},
            Min Vol Exp ${fmt(breakoutFilters.breakoutMinVolumeExpansion)},
            Min Rel Strength ${fmt(breakoutFilters.breakoutMinRelativeStrengthPct)}%,
            Trend ${breakoutFilters.breakoutTrendTimeframeMinutes ?? 'n/a'}m x ${breakoutFilters.breakoutTrendLookbackBars ?? 'n/a'} bars
        </p>
        <p class="pill-list tight"><strong>Scanned Symbols:</strong> ${escapeHtml(mostActiveSymbols.map((s) => s.symbol).join(', ') || 'None')}</p>
        <p class="pill-list tight"><strong>Insufficient Symbols:</strong> ${escapeHtml(insufficientSymbols.join(', ') || 'None')}</p>
    </section>
    <section class="panel">
        <h2>Breakout Candidate Detail</h2>
        <table>
            <thead>
                <tr>
                    <th>Symbol</th>
                    <th>Trade Type</th>
                    <th>Entry Date</th>
                    <th>Entry Price</th>
                    <th>Quantity</th>
                    <th>Exit Date</th>
                    <th>Exit Price</th>
                    <th>P/L</th>
                    <th>Quality</th>
                </tr>
            </thead>
            <tbody>${candidateRows}</tbody>
        </table>
    </section>
    <section class="panel">
        <h2>Evaluation Rows</h2>
        <table>
            <thead>
                <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Open</th>
                    <th>OR High</th>
                    <th>OR Low</th>
                    <th>Breakout</th>
                    <th>Breakout Time</th>
                    <th>Retest</th>
                    <th>Retest Time</th>
                    <th>ATR</th>
                    <th>Quality</th>
                </tr>
            </thead>
            <tbody>${evaluationRowsHtml}</tbody>
        </table>
    </section>
    <section class="panel">
        <h2>Executed Trades & Outcomes</h2>
        <table>
            <thead>
                <tr>
                    <th>Symbol</th>
                    <th>Side</th>
                    <th>Entry</th>
                    <th>Qty</th>
                    <th>Stop</th>
                    <th>Target</th>
                    <th>Status</th>
                    <th>Exit</th>
                    <th>Exit Time</th>
                    <th>P/L</th>
                </tr>
            </thead>
            <tbody>${tradeRows}</tbody>
        </table>
    </section>
</body>
</html>`;
}

function renderWeeklyTradingActivityPdfHtml(weeklyReport: WeeklyTradingActivityReport): string {
    const rows = weeklyReport.dailyRowsData.length
        ? weeklyReport.dailyRowsData.map((day) => `<tr>
            <td>${escapeHtml(day.sessionDate)}</td>
            <td>${day.longs}</td>
            <td>${day.shorts}</td>
            <td>${day.breakoutCandidatesCount}</td>
            <td>${day.openTrades}</td>
            <td>${day.closedTrades}</td>
            <td>${day.pnl.toFixed(2)}</td>
        </tr>`).join('')
        : '<tr><td colspan="7">No reportable sessions for this week.</td></tr>';

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(weeklyReport.title)}</title>
    <style>
        @page { size: A4 portrait; margin: 0.5in; }
        body { font-family: 'Segoe UI', Arial, sans-serif; color: #111827; }
        h1, h2 { margin: 0 0 8px; }
        .panel { border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
        .summary { color: #4b5563; margin: 0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #d1d5db; padding: 7px; text-align: left; }
        th { background: #f3f4f6; text-transform: uppercase; font-size: 11px; }
    </style>
</head>
<body>
    <section class="panel">
        <h1>${escapeHtml(weeklyReport.title)}</h1>
        <p class="summary">Totals | Longs: ${weeklyReport.longs} | Shorts: ${weeklyReport.shorts} | P/L: ${weeklyReport.pnl.toFixed(2)}</p>
    </section>
    <section class="panel">
        <h2>Daily Summary</h2>
        <table>
            <thead><tr><th>Session Date</th><th>Longs</th><th>Shorts</th><th># Breakout</th><th># Open</th><th># Closed</th><th>P/L</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </section>
</body>
</html>`;
}

function renderMonthlyTradingActivityPdfHtml(monthlyReport: MonthlyTradingActivityReport): string {
    const rows = monthlyReport.weeklyReports.length
        ? monthlyReport.weeklyReports.map((week) => `<tr>
            <td>${escapeHtml(`${week.weekStartDate} to ${week.weekEndDate}`)}</td>
            <td>${week.longs}</td>
            <td>${week.shorts}</td>
            <td>${week.pnl.toFixed(2)}</td>
        </tr>`).join('')
        : '<tr><td colspan="4">No reportable weekly data for this month.</td></tr>';

    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Monthly Trading Activity ${escapeHtml(monthlyReport.monthLabel)}</title>
    <style>
        @page { size: A4 portrait; margin: 0.5in; }
        body { font-family: 'Segoe UI', Arial, sans-serif; color: #111827; }
        h1, h2 { margin: 0 0 8px; }
        .panel { border: 1px solid #d1d5db; border-radius: 10px; padding: 12px; margin-bottom: 10px; }
        .summary { color: #4b5563; margin: 0; }
        table { width: 100%; border-collapse: collapse; font-size: 12px; }
        th, td { border: 1px solid #d1d5db; padding: 7px; text-align: left; }
        th { background: #f3f4f6; text-transform: uppercase; font-size: 11px; }
    </style>
</head>
<body>
    <section class="panel">
        <h1>Month's Trading Activity</h1>
        <p class="summary">Month: ${escapeHtml(monthlyReport.monthLabel)} | Longs: ${monthlyReport.totalLongs} | Shorts: ${monthlyReport.totalShorts} | P/L: ${monthlyReport.totalPnl.toFixed(2)}</p>
    </section>
    <section class="panel">
        <h2>Weekly Summary</h2>
        <table>
            <thead><tr><th>Week</th><th>Longs</th><th>Shorts</th><th>P/L</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>
    </section>
</body>
</html>`;
}

async function buildRenderedReport(reportType: ReportKind, anchorDate?: string): Promise<RenderedReportResult> {
    const anchor = parseAnchorDateInput(anchorDate);

    if (reportType === 'today') {
        let sourceDiagnostic = 'Loaded from existing canonical JSON.';
        let dailyRecord = await loadDailySessionRecord(anchor.isoDate);
        if (!dailyRecord && anchor.isoDate === nyDateString()) {
            persistCanonicalDailySession(anchor.isoDate);
            dailyRecord = await loadDailySessionRecord(anchor.isoDate);
            if (dailyRecord) {
                sourceDiagnostic = 'Loaded from just-persisted canonical JSON.';
            }
        }

        if (!dailyRecord) {
            throw new Error(`No daily report JSON was found for ${anchor.isoDate}.`);
        }

        return {
            title: "Today's trading activity",
            html: await renderDailySessionView(dailyRecord, { sourceDiagnostic }),
            pdfHtml: renderDailySessionPdfHtml(dailyRecord),
            baseName: `daily-trading-activity-${anchor.isoDate}`,
        };
    }

    if (reportType === 'week') {
        const weekly = await buildWeeklyTradingActivityReport(anchor.dateUtc);
        return {
            title: weekly.title,
            html: renderWeeklyTradingActivityHtml(weekly),
            pdfHtml: renderWeeklyTradingActivityPdfHtml(weekly),
            baseName: `weekly-trading-activity-${weekly.weekEndDate}`,
        };
    }

    const monthly = await buildMonthlyTradingActivityReport(anchor.dateUtc);
    return {
        title: monthly.title,
        html: renderMonthlyTradingActivityHtml(monthly),
        pdfHtml: renderMonthlyTradingActivityPdfHtml(monthly),
        baseName: `monthly-trading-activity-${monthly.monthLabel}`,
    };
}

async function writeRenderedReportArtifact(
    report: RenderedReportResult,
    format: DownloadFormat,
): Promise<{ relativePath: string; downloadName: string }> {
    fs.mkdirSync(reportsDir, { recursive: true });

    if (format === 'html') {
        const htmlReportPath = path.join(reportsDir, `${report.baseName}.html`);
        writeHtmlReport(htmlReportPath, report.html);
        return {
            relativePath: relativeReportPath(htmlReportPath),
            downloadName: `${report.baseName}.html`,
        };
    }

    const pdfSourceHtmlPath = path.join(reportsDir, `${report.baseName}-pdf-source.html`);
    const pdfReportPath = path.join(reportsDir, `${report.baseName}.pdf`);
    writeHtmlReport(pdfSourceHtmlPath, report.pdfHtml ?? report.html);
    await renderHtmlToPdf(pdfSourceHtmlPath, pdfReportPath);
    fs.unlinkSync(pdfSourceHtmlPath);

    return {
        relativePath: relativeReportPath(pdfReportPath),
        downloadName: `${report.baseName}.pdf`,
    };
}

async function generateReportByType(reportType: ReportKind, anchorDate?: string): Promise<{
    title: string;
    viewRelativePath: string;
}> {
    const anchor = parseAnchorDateInput(anchorDate);
    const rendered = await buildRenderedReport(reportType, anchor.isoDate);
    return {
        title: rendered.title,
        viewRelativePath: `/api/reports/render?type=${encodeURIComponent(reportType)}&anchorDate=${encodeURIComponent(anchor.isoDate)}`,
    };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
    // Dynamic optimal filter values endpoint
    if (req.method === 'GET' && pathname === '/api/optimal-filters') {
        const symbol = (url.searchParams.get('symbol') || '').trim().toUpperCase() || 'SPY';
        const sessionDate = url.searchParams.get('sessionDate') || '';
        try {
            const filters = await orbService.getOptimalFilters(symbol, sessionDate);
            sendJson(res, 200, { ok: true, symbol, filters, usedFallback: false });
        } catch (error) {
            const fallbackFilters = orbService.getDefaultOptimalFilters();
            sendJson(res, 200, {
                ok: true,
                symbol,
                filters: fallbackFilters,
                usedFallback: true,
                message: error instanceof Error ? error.message : String(error),
            });
        }
        return;
    }
    if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'orbilicious-web' });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/orbilicious/status') {
        refreshRuntimeStatusFromClock();
        sendJson(res, 200, {
            ...appState,
            realtimeFeedEnabled: orbService.alpacaClient.useRealtimeFeed,
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/alpaca/set-realtime-feed') {
        try {
            const body = await parseJsonBody<{ realtimeFeed: boolean }>(req);
            const realtimeFeed = body?.realtimeFeed === true;
            orbService.alpacaClient.useRealtimeFeed = realtimeFeed;
            sendJson(res, 200, { ok: true, realtimeFeed });
        } catch (error) {
            sendJson(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'GET' && pathname === '/api/alpaca/check-sip') {
        try {
            const supported = await orbService.checkRealtimeDataFeedSupported();
            sendJson(res, 200, { supported });
        } catch (error) {
            sendJson(res, 200, { supported: false, detail: error instanceof Error ? error.message : String(error) });
        }
        return;
    }

    if (req.method === 'GET' && pathname === '/api/orbilicious/activity') {
        const sinceParam = url.searchParams.get('since');
        const since = sinceParam ? Number(sinceParam) : 0;
        const lowerBound = Number.isFinite(since) ? since : 0;
        const lines = activityLines.filter((line) => line.id > lowerBound);
        const nextCursor = activityLines.length ? activityLines[activityLines.length - 1].id : lowerBound;
        sendJson(res, 200, { lines, nextCursor });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/orbilicious/trades') {
        const sinceParam = url.searchParams.get('since');
        const since = sinceParam ? Number(sinceParam) : 0;
        const lowerBound = Number.isFinite(since) ? since : 0;

        if (appState.sessionMode === 'REPLAY' && appState.emulationSessionDate) {
            const replayEvents = loadReplayTradeMonitorEvents(appState.emulationSessionDate);
            if (!replayEvents) {
                sendJson(res, 409, {
                    ok: false,
                    message: `Replay data for ${appState.emulationSessionDate} is unavailable because sessionEvents are missing from the canonical daily JSON.`,
                });
                return;
            }

            const events = replayEvents.filter((event) => event.id > lowerBound);
            const nextCursor = replayEvents.length ? replayEvents[replayEvents.length - 1].id : lowerBound;
            sendJson(res, 200, { events, nextCursor });
            return;
        }

        const events = tradeEvents.filter((event) => event.id > lowerBound);
        const nextCursor = tradeEvents.length ? tradeEvents[tradeEvents.length - 1].id : lowerBound;
        sendJson(res, 200, { events, nextCursor });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/orbilicious/candidate-chart') {
        const symbolRaw = url.searchParams.get('symbol') || '';
        const sessionDateRaw = url.searchParams.get('sessionDate') || '';
        const determinationTimestampRaw = url.searchParams.get('determinationTimestamp') || '';
        const entryTimestampRaw = url.searchParams.get('entryTimestamp') || '';
        const entryPrice = Number(url.searchParams.get('entryPrice'));
        const stopPrice = Number(url.searchParams.get('stopPrice'));
        const targetPrice = Number(url.searchParams.get('targetPrice'));
        const closePriceParam = url.searchParams.get('closePrice');
        const closePrice = closePriceParam == null || closePriceParam === '' ? null : Number(closePriceParam);
        const closeTimestampRaw = url.searchParams.get('closeTimestamp') || '';

        const symbol = symbolRaw.trim().toUpperCase();
        const sessionDate = sessionDateRaw.trim();
        const determinationTimestamp = determinationTimestampRaw.trim();
        const entryTimestamp = entryTimestampRaw.trim() || determinationTimestamp;
        const closeTimestamp = closeTimestampRaw.trim() || null;
        const hasValidSessionDate = /^\d{4}-\d{2}-\d{2}$/.test(sessionDate);

        if (appState.sessionMode === 'REPLAY' && symbol.length > 0 && hasValidSessionDate) {
            const record = readDailySessionRecord(sessionDate);
            const persistedSnapshot = record?.symbolSnapshots?.[symbol];
            if (persistedSnapshot?.chartSvg) {
                sendJson(res, 200, {
                    ok: true,
                    symbol,
                    sessionDate,
                    svg: persistedSnapshot.chartSvg,
                    source: 'daily-json',
                });
                return;
            }
        }

        const determinationMs = new Date(determinationTimestamp).getTime();
        const entryMs = new Date(entryTimestamp).getTime();
        const closeMs = closeTimestamp === null ? Number.NaN : new Date(closeTimestamp).getTime();
        const hasValidCoreParams = symbol.length > 0
            && hasValidSessionDate
            && Number.isFinite(determinationMs)
            && Number.isFinite(entryMs)
            && Number.isFinite(entryPrice)
            && Number.isFinite(stopPrice)
            && Number.isFinite(targetPrice)
            && (closePrice === null || Number.isFinite(closePrice))
            && (closeTimestamp === null || Number.isFinite(closeMs));

        if (!hasValidCoreParams) {
            sendJson(res, 400, {
                ok: false,
                message: 'Missing or invalid chart parameters.',
            });
            return;
        }

        try {
            const client = new AlpacaClient();
            const bars = await client.getIntradayBars(symbol, sessionDate);
            const sessionBars = barsForSessionDate(bars, sessionDate);
            const svg = renderCandidateChartSvg({
                bars: sessionBars,
                sessionDate,
                determinationTimestamp,
                entryTimestamp,
                entryPrice,
                stopPrice,
                targetPrice,
                closePrice,
                closeTimestamp,
                openingRangeMinutes: strategyConfig.openingRangeMinutes,
                maxBarsAfterDetermination: 30,
            });

            sendJson(res, 200, {
                ok: true,
                symbol,
                sessionDate,
                svg,
            });
        } catch (error) {
            logger.error('Failed generating candidate chart', {
                symbol,
                sessionDate,
                error,
            });
            sendJson(res, 500, {
                ok: false,
                message: error instanceof Error ? error.message : 'Failed generating candidate chart',
            });
        }
        return;
    }

    if (req.method === 'GET' && pathname === '/api/orbilicious/candidate-charts') {
        const limitParam = Number(url.searchParams.get('limit') || 8);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 12) : 8;

        try {
            const charts = await buildLiveCandidateCharts(limit);
            sendJson(res, 200, {
                charts,
                count: charts.length,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Failed generating live candidate charts', { error });
            sendJson(res, 500, {
                ok: false,
                message: error instanceof Error ? error.message : 'Failed generating candidate charts',
            });
        }
        return;
    }

    if (req.method === 'GET' && pathname === '/api/liquidity-zones') {
        const sessionDateParam = url.searchParams.get('sessionDate') || '';
        const sessionDate = sessionDateParam.trim() || toNyParts(new Date(), strategyConfig.sessionTimezone).date;
        const limitParam = Number(url.searchParams.get('limit') || env.quantityToRetrieve);
        const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 50) : env.quantityToRetrieve;
        const maxZonesPerSymbol = 3;

        if (!isValidSessionDate(sessionDate)) {
            sendJson(res, 400, {
                ok: false,
                message: 'Invalid sessionDate. Use YYYY-MM-DD and do not select a future date.',
            });
            return;
        }

        try {
            const client = new AlpacaClient();
            const symbols = await client.getMostActiveSymbols(limit);
            const settled = await Promise.all(
                symbols.map(async (symbol) => {
                    try {
                        const bars = await client.getIntradayBars(symbol, sessionDate);
                        return findLiquidityZonesForSymbol(symbol, sessionDate, bars, maxZonesPerSymbol);
                    } catch (error) {
                        logger.warn('Skipping liquidity scan for symbol due to data error', {
                            symbol,
                            sessionDate,
                            error,
                        });
                        return null;
                    }
                })
            );

            const symbolsWithZones = settled.filter((entry): entry is NonNullable<typeof entry> => entry !== null);
            const zones = symbolsWithZones
                .flatMap((entry) => entry.zones)
                .sort((left, right) => {
                    if (right.strengthScore !== left.strengthScore) {
                        return right.strengthScore - left.strengthScore;
                    }

                    return left.nearestPriceDistancePct - right.nearestPriceDistancePct;
                });

            sendJson(res, 200, {
                ok: true,
                sessionDate,
                requestedLimit: limit,
                retrievedSymbols: symbols.length,
                scannedSymbols: symbolsWithZones.length,
                maxZonesPerSymbol,
                zones,
                symbols: symbolsWithZones,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Failed generating liquidity zones', { sessionDate, limit, error });
            sendJson(res, 500, {
                ok: false,
                message: error instanceof Error ? error.message : 'Failed generating liquidity zones',
            });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/orbilicious/start') {
        if (appState.isRunning) {
            sendJson(res, 409, {
                ok: false,
                message: 'ORBilicious is already running',
                state: appState,
            });
            return;
        }

        let payload: StartRequest;

        try {
            payload = await parseJsonBody<StartRequest>(req);
        } catch (error) {
            sendJson(res, 400, {
                ok: false,
                message: error instanceof Error ? error.message : 'Bad request payload',
            });
            return;
        }

        const continuous = payload.continuous === true;
        const realTimeData = payload.realTimeData === true;
        const sessionMode = normalizedSessionMode(payload.sessionMode);
        const emulationSessionDate = (sessionMode === 'EMULATION' || sessionMode === 'REPLAY')
            ? (typeof payload.emulationSessionDate === 'string' && payload.emulationSessionDate.trim() !== ''
                ? payload.emulationSessionDate.trim()
                : null)
            : null;
        const hardBasketCap = typeof payload.moneyInAccount === 'number' && payload.moneyInAccount > 0
            ? payload.moneyInAccount
            : undefined;
        const maxTotalRisk = typeof payload.maxRiskPerSession === 'number' && payload.maxRiskPerSession > 0
            ? payload.maxRiskPerSession
            : undefined;
        const stopProfitRewardPart = typeof payload.stopProfitRewardPart === 'number' && payload.stopProfitRewardPart >= 1 && payload.stopProfitRewardPart <= 20
            ? payload.stopProfitRewardPart
            : undefined;
        const mostActiveSymbolLimit = normalizedPositiveInteger(
            payload.mostActiveSymbolLimit,
            appState.mostActiveSymbolLimit,
            1,
            200,
        );
        const candidateTradeType = normalizedCandidateTradeType(payload.candidateTradeType, env.candidateTradeType);
        const breakoutConfirmationCandleMinutes = normalizedPositiveInteger(
            payload.breakoutConfirmationCandleMinutes,
            appState.breakoutConfirmationCandleMinutes,
            1,
            30,
        );
        const breakoutQualityFiltersEnabled = payload.breakoutQualityFiltersEnabled == null
            ? appState.breakoutQualityFiltersEnabled
            : payload.breakoutQualityFiltersEnabled === true;
        const breakoutMinVolumeExpansion = normalizedPositiveNumber(
            payload.breakoutMinVolumeExpansion,
            appState.breakoutMinVolumeExpansion,
            0.5,
            10,
        );
        const breakoutMinRelativeStrengthPct = normalizedPositiveNumber(
            payload.breakoutMinRelativeStrengthPct,
            appState.breakoutMinRelativeStrengthPct,
            0,
            5,
        );
        const breakoutTrendTimeframeMinutes = normalizedPositiveInteger(
            payload.breakoutTrendTimeframeMinutes,
            appState.breakoutTrendTimeframeMinutes,
            1,
            60,
        );
        const breakoutTrendLookbackBars = normalizedPositiveInteger(
            payload.breakoutTrendLookbackBars,
            appState.breakoutTrendLookbackBars,
            2,
            20,
        );

        if ((sessionMode === 'EMULATION' || sessionMode === 'REPLAY') && emulationSessionDate && !isValidSessionDate(emulationSessionDate)) {
            sendJson(res, 400, {
                ok: false,
                message: 'Invalid emulation date. Use YYYY-MM-DD and do not select a future date.',
            });
            return;
        }

        if (sessionMode === 'REPLAY' && emulationSessionDate === currentNyDateIso() && isNyMarketOpenNow()) {
            sendJson(res, 400, {
                ok: false,
                message: "Replays for the current day will run when today's NY Market's close.",
            });
            return;
        }

        if (sessionMode === 'REPLAY' && !emulationSessionDate) {
            sendJson(res, 400, {
                ok: false,
                message: 'Replay mode requires a session date.',
            });
            return;
        }

        if (sessionMode === 'REPLAY' && emulationSessionDate && !readDailySessionRecord(emulationSessionDate)) {
            sendJson(res, 404, {
                ok: false,
                message: `No canonical daily session record was found for ${emulationSessionDate}.`,
            });
            return;
        }

        if (sessionMode === 'REPLAY' && emulationSessionDate) {
            const replayRecord = readDailySessionRecord(emulationSessionDate);
            const hasSessionEvents = Array.isArray(replayRecord?.sessionEvents) && replayRecord.sessionEvents.length > 0;
            const hasEmulatedTrades = Array.isArray(replayRecord?.emulatedTrades) && replayRecord.emulatedTrades.length > 0;
            if (!hasSessionEvents && !hasEmulatedTrades) {
                sendJson(res, 409, {
                    ok: false,
                    message: `Replay for ${emulationSessionDate} requires canonical sessionEvents or emulatedTrades in data/daily/${emulationSessionDate}.json.`,
                });
                return;
            }
        }

        startOrbiliciousProcess({
            continuous,
            sessionMode,
            emulationSessionDate,
            hardBasketCap,
            maxTotalRisk,
            stopProfitRewardPart,
            mostActiveSymbolLimit,
            realTimeData,
            candidateTradeType,
            breakoutConfirmationCandleMinutes,
            breakoutQualityFiltersEnabled,
            breakoutMinVolumeExpansion,
            breakoutMinRelativeStrengthPct,
            breakoutTrendTimeframeMinutes,
            breakoutTrendLookbackBars,
        });

        sendJson(res, 202, {
            ok: true,
            message: `ORBilicious started in ${sessionMode} mode`,
            state: appState,
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/orbilicious/stop') {
        const didSendSignal = stopOrbiliciousProcess();
        if (!didSendSignal) {
            sendJson(res, 409, {
                ok: false,
                message: 'ORBilicious is not running',
                state: appState,
            });
            return;
        }

        sendJson(res, 202, {
            ok: true,
            message: 'Stop signal sent to ORBilicious',
            state: appState,
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/reports/generate') {
        let payload: GenerateReportRequest;
        try {
            payload = await parseJsonBody<GenerateReportRequest>(req);
        } catch (error) {
            sendJson(res, 400, {
                ok: false,
                message: error instanceof Error ? error.message : 'Bad request payload',
            });
            return;
        }

        const reportType = payload.reportType;
        if (reportType !== 'today' && reportType !== 'week' && reportType !== 'month') {
            sendJson(res, 400, {
                ok: false,
                message: 'Invalid report type. Use today, week, or month.',
            });
            return;
        }

        try {
            const report = await generateReportByType(reportType, payload.anchorDate);
            sendJson(res, 200, {
                ok: true,
                report,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Failed generating report', { reportType, anchorDate: payload.anchorDate, error });
            sendJson(res, 500, {
                ok: false,
                message: error instanceof Error ? error.message : 'Failed generating report',
            });
        }
        return;
    }

    if (req.method === 'GET' && pathname === '/api/reports/view') {
        const relativePath = url.searchParams.get('path') || '';
        if (!relativePath) {
            sendJson(res, 400, { ok: false, message: 'Missing query parameter: path' });
            return;
        }

        const fullPath = safeJoin(reportsDir, relativePath);
        if (!fullPath) {
            sendJson(res, 400, { ok: false, message: 'Invalid report path' });
            return;
        }

        const download = url.searchParams.get('download') === '1';
        sendFile(res, fullPath, download ? { downloadName: path.basename(fullPath) } : undefined);
        return;
    }

    if (req.method === 'GET' && pathname === '/api/reports/render') {
        const reportType = (url.searchParams.get('type') || '').trim() as ReportKind;
        const anchorDate = (url.searchParams.get('anchorDate') || '').trim();

        if (reportType !== 'today' && reportType !== 'week' && reportType !== 'month') {
            sendJson(res, 400, { ok: false, message: 'Invalid report type. Use today, week, or month.' });
            return;
        }

        try {
            const rendered = await buildRenderedReport(reportType, anchorDate);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            res.end(rendered.html);
        } catch (error) {
            logger.error('Failed rendering report', { reportType, anchorDate, error });
            sendJson(res, 500, {
                ok: false,
                message: error instanceof Error ? error.message : 'Failed rendering report',
            });
        }
        return;
    }

    if (req.method === 'POST' && pathname === '/api/reports/download') {
        let payload: DownloadReportRequest;
        try {
            payload = await parseJsonBody<DownloadReportRequest>(req);
        } catch (error) {
            sendJson(res, 400, {
                ok: false,
                message: error instanceof Error ? error.message : 'Bad request payload',
            });
            return;
        }

        const reportType = payload.reportType;
        const format: DownloadFormat = payload.format === 'pdf' ? 'pdf' : 'html';
        if (reportType !== 'today' && reportType !== 'week' && reportType !== 'month') {
            sendJson(res, 400, {
                ok: false,
                message: 'Invalid report type. Use today, week, or month.',
            });
            return;
        }

        try {
            const rendered = await buildRenderedReport(reportType, payload.anchorDate);
            const written = await writeRenderedReportArtifact(rendered, format);
            sendJson(res, 200, {
                ok: true,
                relativePath: written.relativePath,
                format,
                downloadUrl: `/api/reports/view?path=${encodeURIComponent(written.relativePath)}&download=1`,
                generatedAt: new Date().toISOString(),
            });
        } catch (error) {
            logger.error('Failed preparing report download', { reportType, anchorDate: payload.anchorDate, format, error });
            sendJson(res, 500, {
                ok: false,
                message: error instanceof Error ? error.message : 'Failed preparing report download',
            });
        }
        return;
    }

    if (req.method === 'GET' && pathname === '/api/reports/daily') {
        const sessionDate = (url.searchParams.get('date') || '').trim();
        if (!isValidSessionDate(sessionDate)) {
            sendJson(res, 400, { ok: false, message: 'Missing or invalid date. Use YYYY-MM-DD.' });
            return;
        }

        const record = await loadDailySessionRecord(sessionDate);
        if (!record) {
            sendJson(res, 404, { ok: false, message: `No daily report available for ${sessionDate}` });
            return;
        }

        const html = await renderDailySessionView(record);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(html);
        return;
    }

    sendJson(res, 404, { ok: false, message: 'API route not found' });
}

function handlePublic(req: IncomingMessage, res: ServerResponse, pathname: string) {
    const requestedFile = pathname === '/' ? 'index.html' : pathname.slice(1);
    const fullPath = safeJoin(publicDir, requestedFile);

    if (!fullPath) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Bad request');
        return;
    }

    sendFile(res, fullPath);
}

function legacyDailyReportDateFromPath(pathname: string): string | null {
    const match = pathname.match(/\/orb-report-(\d{4}-\d{2}-\d{2})\.html$/);
    return match ? match[1] : null;
}

function stampHtmlVersion() {
    try {
        const htmlPath = path.resolve(publicDir, 'index.html');
        let html = fs.readFileSync(htmlPath, 'utf-8');
        const updated = html
            .replace(/(<title>ORBilicious Control Panel<\/title>)/, `<title>ORBilicious Web Client ${APP_VERSION}</title>`)
            .replace(/(<h1 class="h3 mb-1">ORBilicious Web Client<\/h1>)/, `<h1 class="h3 mb-1">ORBilicious Web Client ${APP_VERSION}</h1>`);
        if (updated !== html) {
            fs.writeFileSync(htmlPath, updated, 'utf-8');
        }
    } catch {
        // Non-fatal.
    }
}

export function startWebServer(port = DEFAULT_PORT) {
    stampHtmlVersion();

    const server = createServer(async (req, res) => {
        if (!req.url) {
            sendJson(res, 400, { ok: false, message: 'Bad request' });
            return;
        }

        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;


        // Serve OpenAPI spec and Swagger UI HTML directly
        if (pathname === '/api/openapi.yaml') {
            // Try both possible locations
            const openapiPaths = [
                path.resolve(__dirname, 'openapi.yaml'),
                path.resolve(process.cwd(), 'src', 'web', 'openapi.yaml'),
            ];
            const foundPath = openapiPaths.find((p) => fs.existsSync(p));
            if (foundPath) {
                sendFile(res, foundPath);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
            }
            return;
        }
        if (pathname === '/api.html') {
            const apiHtmlPath = path.resolve(publicDir, 'api.html');
            if (fs.existsSync(apiHtmlPath)) {
                sendFile(res, apiHtmlPath);
            } else {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Not Found');
            }
            return;
        }

        if (pathname.startsWith('/api/')) {
            await handleApi(req, res, pathname, url);
            return;
        }

        if (pathname.startsWith('/reports/')) {
            const legacyDailyDate = legacyDailyReportDateFromPath(pathname);
            if (legacyDailyDate) {
                const record = await loadDailySessionRecord(legacyDailyDate);
                if (record) {
                    const html = await renderDailySessionView(record);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                    res.end(html);
                    return;
                }
            }

            const relativePath = pathname.replace('/reports/', '');
            const reportPath = safeJoin(reportsDir, relativePath);
            if (!reportPath) {
                sendJson(res, 400, { ok: false, message: 'Invalid report path' });
                return;
            }

            sendFile(res, reportPath);
            return;
        }

        handlePublic(req, res, pathname);
    });

    server.listen(port, () => {
        logger.info('Web server started', {
            port,
            publicDir,
            reportsDir,
        });
    });

    return server;
}

process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled promise rejection', { reason: String(reason), promise: String(promise) });
});

process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error: error.message, stack: error.stack });
});

function shutdown(signal: string) {
    logger.info('Shutting down', { signal });
    if (appProcess) {
        logger.info('Killing child process', { pid: appProcess.pid });
        appProcess.kill('SIGTERM');
    }
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

if (require.main === module) {
    const rawPort = process.env.WEB_PORT;
    const parsed = rawPort ? Number(rawPort) : DEFAULT_PORT;
    const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
    startWebServer(port);
}
