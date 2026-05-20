import fs from 'node:fs';
import path from 'node:path';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import puppeteer from 'puppeteer';
import { env, strategyConfig } from '../config';
import { logger } from '../logger';
import { findLiquidityZonesForSymbol } from '../liquidity';
import { OrbService } from '../services/orb-service';
import { toNyParts } from '../time';
import { AlpacaClient } from '../alpaca';
import type { Bar } from '../types';

type SessionMode = 'EMULATION' | 'PAPER' | 'LIVE';
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

const DEFAULT_PORT = 8787;
const publicDirCandidates = [
    path.resolve(__dirname, 'public'),
    path.resolve(process.cwd(), 'src', 'web', 'public'),
];
const publicDir = publicDirCandidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')))
    ?? publicDirCandidates[0];
const reportsDir = path.resolve(process.cwd(), 'reports');
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
    maxRiskPerSession: null,
    stopProfitRewardPart: null,
    mostActiveSymbolLimit: env.quantityToRetrieve,
    backtestProgress: null,
    pid: null,
    lastOutcome: 'never-started',
    lastError: null,
    realtimeDataFeed: false,
    realtimeDataFeedError: false,
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
    res.end(body);
}

function sendFile(res: ServerResponse, filePath: string) {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
        return;
    }

    const stat = fs.statSync(filePath);
    res.writeHead(200, {
        'Content-Type': contentTypeFor(filePath),
        'Content-Length': stat.size,
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
        activityLines = activityLines.slice(activityLines.length - MAX_ACTIVITY_LINES);
    }
}

function addTradeEvent(event: Omit<TradeEvent, 'id'>) {
    tradeEvents.push({
        id: nextTradeEventId++,
        ...event,
    });

    if (tradeEvents.length > MAX_TRADE_EVENTS) {
        tradeEvents = tradeEvents.slice(tradeEvents.length - MAX_TRADE_EVENTS);
    }
}

function isSessionMode(value: string): value is SessionMode {
    return value === 'EMULATION' || value === 'PAPER' || value === 'LIVE';
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

    const today = new Date();
    const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

    return value <= todayIso;
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
            const marketsOpen = isWeekday && currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes;

            if (marketsOpen) {
                appState.runtimeStatus = 'Running in real time (emulation)';
            } else {
                appState.runtimeStatus = 'Waiting for market open';
            }
        } else {
            appState.runtimeStatus = 'Running historical emulation';
        }
    } else if (continuous && sessionMode !== 'EMULATION') {
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

    appState.continuous = continuous;
    appState.sessionMode = sessionMode;
    appState.emulationSessionDate = emulationSessionDate;
    appState.moneyInAccount = hardBasketCap ?? null;
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

    const child = spawn(entry.command, args, {
        cwd: process.cwd(),
        env: {
            ...process.env,
            SESSION_MODE: sessionMode,
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
        `Starting ORBilicious in ${sessionMode} mode${continuous ? ' (continuous)' : ''}${emulationSessionDate ? ` for ${emulationSessionDate}` : ''}${hardBasketCap ? ` | Basket Cap: $${hardBasketCap.toLocaleString()}` : ''}${maxTotalRisk ? ` | Max Risk: $${maxTotalRisk.toLocaleString()}` : ''}${stopProfitRewardPart ? ` | Stop/Profit: 1/${stopProfitRewardPart}` : ''} | Most Active: ${mostActiveSymbolLimit} | Candidate Trades: ${candidateTradeType} | Confirm Candle: ${breakoutConfirmationCandleMinutes}m | Quality Filters: ${breakoutQualityFiltersEnabled ? 'on' : 'off'}`
    );

    wireProcessOutput('stdout', child.stdout);
    wireProcessOutput('stderr', child.stderr);

    child.on('error', (error) => {
        appState.isRunning = false;
        appState.pid = null;
        appState.runtimeStatus = 'Failed';
        appState.orbUiMessage = null;
        appState.lastOutcome = 'failed';
        appState.lastError = error.message;
        addActivityLine('system', `Process error: ${error.message}`);
        logger.error('Failed starting Orbilicious child process', { error, sessionMode, continuous });
    });

    child.on('close', (code, signal) => {
        const wasStopRequested = stopRequested;
        stopRequested = false;

        appState.isRunning = false;
        appState.pid = null;
        appState.runtimeStatus = 'Stopped';
        appState.orbUiMessage = null;

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

async function generateWeeklyTradingActivityReport(anchorDate: Date): Promise<{
    title: string;
    htmlRelativePath: string;
    pdfRelativePath: string;
    weekStartDate: string;
    weekEndDate: string;
    longs: number;
    shorts: number;
    pnl: number;
}> {
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
        detailLink: string;
    }> = [];

    for (const current = new Date(weekStart); isoDateUTC(current) <= effectiveEndDate; current.setUTCDate(current.getUTCDate() + 1)) {
        const dayOfWeek = current.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            continue;
        }

        const sessionDate = isoDateUTC(current);

        try {
            const daily = await orbService.generateDailyReport(sessionDate, { usesHistoricData: true });
            dailyRowsData.push({
                sessionDate,
                longs: daily.numberOfCandidatesSoldLong,
                shorts: daily.numberOfCandidatesBoughtShort,
                pnl: daily.totalProfitLossToDate,
                detailLink: `/reports/${encodeURI(relativeReportPath(daily.htmlReportPath))}`,
            });
        } catch {
            // Skip unavailable sessions (future/holiday/no data) instead of failing entire weekly report.
        }
    }

    const totalLongs = dailyRowsData.reduce((sum, day) => sum + day.longs, 0);
    const totalShorts = dailyRowsData.reduce((sum, day) => sum + day.shorts, 0);
    const totalPnl = dailyRowsData.reduce((sum, day) => sum + day.pnl, 0);

    const reportDir = path.resolve(process.cwd(), 'reports');
    const htmlReportPath = path.join(reportDir, `weekly-trading-activity-${weekEndDate}.html`);
    const pdfReportPath = path.join(reportDir, `weekly-trading-activity-${weekEndDate}.pdf`);
    const pdfSourceHtmlPath = path.join(reportDir, `weekly-trading-activity-${weekEndDate}-pdf-source.html`);

    const dailyRows = dailyRowsData.length
        ? dailyRowsData.map((day) => `
        <tr>
            <td>${escapeHtml(day.sessionDate)}</td>
            <td>${day.longs}</td>
            <td>${day.shorts}</td>
            <td class="${pnlClass(day.pnl)}">${day.pnl.toFixed(2)}</td>
            <td><a href="${day.detailLink}" target="_self">View Day Details</a></td>
        </tr>`)
        : [
            `<tr>
                <td colspan="5">No reportable trading sessions available yet for this week.</td>
            </tr>`,
        ];

    const html = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Weekly Trading Activity ${escapeHtml(weekEndDate)}</title>
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
        a { color: #0d6efd; text-decoration: none; }
        a:hover { text-decoration: underline; }
    </style>
</head>
<body>
    <section class="panel">
        <h1>Weekly ORB Drilldown Report for the Week of ${escapeHtml(weekStartDate)} through ${escapeHtml(weekEndDate)}</h1>
        <p>Breakout Candidate Trade Type: ${escapeHtml(candidateTradeTypeLabel(env.candidateTradeType))}</p>
        <p>Totals | Longs: ${totalLongs} | Shorts: ${totalShorts} | P/L: <span class="${pnlClass(totalPnl)}">${totalPnl.toFixed(2)}</span></p>
    </section>
    <section class="panel">
        <h2>Daily Drilldown</h2>
        <table>
            <thead>
                <tr>
                    <th>Session Date</th>
                    <th>Longs</th>
                    <th>Shorts</th>
                    <th>P/L</th>
                    <th>Details</th>
                </tr>
            </thead>
            <tbody>
                ${dailyRows.join('\n')}
            </tbody>
        </table>
    </section>
</body>
</html>`;

    writeHtmlReport(htmlReportPath, html);
    writeHtmlReport(pdfSourceHtmlPath, html);
    await renderHtmlToPdf(pdfSourceHtmlPath, pdfReportPath);
    fs.unlinkSync(pdfSourceHtmlPath);

    return {
        title: `Weekly ORB Drilldown Report for the Week of ${weekStartDate} through ${weekEndDate}`,
        htmlRelativePath: relativeReportPath(htmlReportPath),
        pdfRelativePath: relativeReportPath(pdfReportPath),
        weekStartDate,
        weekEndDate,
        longs: totalLongs,
        shorts: totalShorts,
        pnl: totalPnl,
    };
}

async function generateMonthlyTradingActivityReport(anchorDate: Date): Promise<{
    title: string;
    htmlRelativePath: string;
    pdfRelativePath: string;
}> {
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

    const weeklyReports: Array<{
        title: string;
        htmlRelativePath: string;
        pdfRelativePath: string;
        weekStartDate: string;
        weekEndDate: string;
        longs: number;
        shorts: number;
        pnl: number;
    }> = [];

    for (const weekAnchor of weekAnchors) {
        try {
            const weeklyReport = await generateWeeklyTradingActivityReport(weekAnchor);
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

    const reportDir = path.resolve(process.cwd(), 'reports');
    const htmlReportPath = path.join(reportDir, `monthly-trading-activity-${monthLabel}.html`);
    const pdfReportPath = path.join(reportDir, `monthly-trading-activity-${monthLabel}.pdf`);
    const pdfSourceHtmlPath = path.join(reportDir, `monthly-trading-activity-${monthLabel}-pdf-source.html`);

    const weeklyRows = weeklyReports.map((week) => `
        <tr>
            <td>${escapeHtml(`${week.weekStartDate} to ${week.weekEndDate}`)}</td>
            <td>${week.longs}</td>
            <td>${week.shorts}</td>
            <td class="${pnlClass(week.pnl)}">${week.pnl.toFixed(2)}</td>
            <td><a href="/reports/${encodeURI(week.htmlRelativePath)}" target="_self">View Week Details</a></td>
        </tr>`).join('\n');

    const summaryRow = `
        <tr>
            <th>Total</th>
            <th>${totalLongs}</th>
            <th>${totalShorts}</th>
            <th class="${pnlClass(totalPnl)}">${totalPnl.toFixed(2)}</th>
            <th>-</th>
        </tr>`;

    const html = `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Monthly Trading Activity ${escapeHtml(monthLabel)}</title>
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
        <p>Month: ${escapeHtml(monthLabel)}</p>
        <p>Breakout Candidate Trade Type: ${escapeHtml(candidateTradeTypeLabel(env.candidateTradeType))}</p>
        <p>Totals | Longs: ${totalLongs} | Shorts: ${totalShorts} | P/L: <span class="${pnlClass(totalPnl)}">${totalPnl.toFixed(2)}</span></p>
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

    writeHtmlReport(htmlReportPath, html);
    writeHtmlReport(pdfSourceHtmlPath, html);
    await renderHtmlToPdf(pdfSourceHtmlPath, pdfReportPath);
    fs.unlinkSync(pdfSourceHtmlPath);

    return {
        title: "Month's trading activity",
        htmlRelativePath: relativeReportPath(htmlReportPath),
        pdfRelativePath: relativeReportPath(pdfReportPath),
    };
}

async function generateReportByType(reportType: ReportKind, anchorDate?: string): Promise<{
    title: string;
    htmlRelativePath: string;
    pdfRelativePath: string;
}> {
    const anchor = parseAnchorDateInput(anchorDate);

    if (reportType === 'today') {
        const daily = await orbService.generateDailyReport(anchor.isoDate, { usesHistoricData: true });
        return {
            title: "Today's trading activity",
            htmlRelativePath: relativeReportPath(daily.htmlReportPath),
            pdfRelativePath: relativeReportPath(daily.pdfReportPath),
        };
    }

    if (reportType === 'week') {
        const weekly = await generateWeeklyTradingActivityReport(anchor.dateUtc);
        return {
            title: weekly.title,
            htmlRelativePath: weekly.htmlRelativePath,
            pdfRelativePath: weekly.pdfRelativePath,
        };
    }

    return generateMonthlyTradingActivityReport(anchor.dateUtc);
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string, url: URL) {
    if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, service: 'orbilicious-web' });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/orbilicious/status') {
        sendJson(res, 200, appState);
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
        const emulationSessionDate = sessionMode === 'EMULATION'
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

        if (sessionMode === 'EMULATION' && emulationSessionDate && !isValidSessionDate(emulationSessionDate)) {
            sendJson(res, 400, {
                ok: false,
                message: 'Invalid emulation date. Use YYYY-MM-DD and do not select a future date.',
            });
            return;
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

        sendFile(res, fullPath);
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

export function startWebServer(port = DEFAULT_PORT) {
    const server = createServer(async (req, res) => {
        if (!req.url) {
            sendJson(res, 400, { ok: false, message: 'Bad request' });
            return;
        }

        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;

        if (pathname.startsWith('/api/')) {
            await handleApi(req, res, pathname, url);
            return;
        }

        if (pathname.startsWith('/reports/')) {
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

if (require.main === module) {
    const rawPort = process.env.WEB_PORT;
    const parsed = rawPort ? Number(rawPort) : DEFAULT_PORT;
    const port = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PORT;
    startWebServer(port);
}
