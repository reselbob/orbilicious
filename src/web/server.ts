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

type SessionMode = 'EMULATION' | 'PAPER' | 'LIVE';

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
};

type StartRequest = {
    continuous?: boolean;
    sessionMode?: SessionMode;
    emulationSessionDate?: string;
    moneyInAccount?: number;
    maxRiskPerSession?: number;
    stopProfitRewardPart?: number;
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
    backtestProgress: null,
    pid: null,
    lastOutcome: 'never-started',
    lastError: null,
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
}) {
    const { continuous, sessionMode, emulationSessionDate, hardBasketCap, maxTotalRisk, stopProfitRewardPart } = params;
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
    appState.lastOutcome = 'running';
    appState.lastError = null;

    const child = spawn(entry.command, args, {
        cwd: process.cwd(),
        env: {
            ...process.env,
            SESSION_MODE: sessionMode,
            SESSION_DATE: emulationSessionDate ?? '',
            HARD_BASKET_CAP: hardBasketCap ? hardBasketCap.toString() : '',
            MAX_TOTAL_RISK: maxTotalRisk ? maxTotalRisk.toString() : '',
            STOP_LOSS_PROFIT_RATIO: stopProfitRewardPart ? `1:${stopProfitRewardPart}` : '',
        },
        stdio: 'pipe',
    });

    appProcess = child;
    appState.pid = child.pid ?? null;

    addActivityLine(
        'system',
        `Starting ORBilicious in ${sessionMode} mode${continuous ? ' (continuous)' : ''}${emulationSessionDate ? ` for ${emulationSessionDate}` : ''}${hardBasketCap ? ` | Basket Cap: $${hardBasketCap.toLocaleString()}` : ''}${maxTotalRisk ? ` | Max Risk: $${maxTotalRisk.toLocaleString()}` : ''}${stopProfitRewardPart ? ` | Stop/Profit: 1/${stopProfitRewardPart}` : ''}`
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

        if (sessionMode === 'EMULATION' && emulationSessionDate && !isValidSessionDate(emulationSessionDate)) {
            sendJson(res, 400, {
                ok: false,
                message: 'Invalid emulation date. Use YYYY-MM-DD and do not select a future date.',
            });
            return;
        }

        startOrbiliciousProcess({ continuous, sessionMode, emulationSessionDate, hardBasketCap, maxTotalRisk, stopProfitRewardPart });

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
