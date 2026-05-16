import fs from 'node:fs';
import path from 'node:path';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { logger } from '../logger';

type SessionMode = 'EMULATION' | 'PAPER' | 'LIVE';

type AppState = {
    isRunning: boolean;
    startedAt: string | null;
    continuous: boolean;
    sessionMode: SessionMode;
    emulationSessionDate: string | null;
    moneyInAccount: number | null;
    maxRiskPerSession: number | null;
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
    continuous: false,
    sessionMode: 'EMULATION',
    emulationSessionDate: null,
    moneyInAccount: null,
    maxRiskPerSession: null,
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

function contentTypeFor(filePath: string): string {
    if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
    if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
    if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
    if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
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
}) {
    const { continuous, sessionMode, emulationSessionDate, hardBasketCap, maxTotalRisk } = params;
    const entry = resolveAppEntryPoint();
    const args = [...entry.args];
    if (continuous) {
        args.push('--continuous');
    }

    stopRequested = false;
    tradeEvents = [];
    nextTradeEventId = 1;
    appState.backtestProgress = null;
    appState.isRunning = true;
    appState.startedAt = new Date().toISOString();
    appState.continuous = continuous;
    appState.sessionMode = sessionMode;
    appState.emulationSessionDate = emulationSessionDate;
    appState.moneyInAccount = hardBasketCap ?? null;
    appState.maxRiskPerSession = maxTotalRisk ?? null;
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
        },
        stdio: 'pipe',
    });

    appProcess = child;
    appState.pid = child.pid ?? null;

    addActivityLine(
        'system',
        `Starting Orbilicious in ${sessionMode} mode${continuous ? ' (continuous)' : ''}${emulationSessionDate ? ` for ${emulationSessionDate}` : ''}${hardBasketCap ? ` | Basket Cap: $${hardBasketCap.toLocaleString()}` : ''}${maxTotalRisk ? ` | Max Risk: $${maxTotalRisk.toLocaleString()}` : ''}`
    );

    wireProcessOutput('stdout', child.stdout);
    wireProcessOutput('stderr', child.stderr);

    child.on('error', (error) => {
        appState.isRunning = false;
        appState.pid = null;
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

        if (wasStopRequested || signal === 'SIGTERM') {
            appState.lastOutcome = 'completed';
            appState.lastError = null;
            addActivityLine('system', 'Orbilicious stopped.');
        } else if (code === 0) {
            appState.lastOutcome = 'completed';
            appState.lastError = null;
            addActivityLine('system', 'Orbilicious finished successfully.');
        } else {
            appState.lastOutcome = 'failed';
            appState.lastError = `Exited with code ${code ?? 'unknown'}${signal ? ` (signal: ${signal})` : ''}`;
            addActivityLine('system', `Orbilicious exited unexpectedly: ${appState.lastError}`);
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

    if (req.method === 'POST' && pathname === '/api/orbilicious/start') {
        if (appState.isRunning) {
            sendJson(res, 409, {
                ok: false,
                message: 'Orbilicious is already running',
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

        if (sessionMode === 'EMULATION' && emulationSessionDate && !isValidSessionDate(emulationSessionDate)) {
            sendJson(res, 400, {
                ok: false,
                message: 'Invalid emulation date. Use YYYY-MM-DD and do not select a future date.',
            });
            return;
        }

        startOrbiliciousProcess({ continuous, sessionMode, emulationSessionDate, hardBasketCap, maxTotalRisk });

        sendJson(res, 202, {
            ok: true,
            message: `Orbilicious started in ${sessionMode} mode`,
            state: appState,
        });
        return;
    }

    if (req.method === 'POST' && pathname === '/api/orbilicious/stop') {
        const didSendSignal = stopOrbiliciousProcess();
        if (!didSendSignal) {
            sendJson(res, 409, {
                ok: false,
                message: 'Orbilicious is not running',
                state: appState,
            });
            return;
        }

        sendJson(res, 202, {
            ok: true,
            message: 'Stop signal sent to Orbilicious',
            state: appState,
        });
        return;
    }

    if (req.method === 'GET' && pathname === '/api/reports') {
        sendJson(res, 200, { reports: listReports() });
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
