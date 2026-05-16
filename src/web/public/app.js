const statusBox = document.getElementById('statusBox');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshStatusBtn = document.getElementById('refreshStatusBtn');
const continuousMode = document.getElementById('continuousMode');
const sessionMode = document.getElementById('sessionMode');
const emulationDateGroup = document.getElementById('emulationDateGroup');
const emulationDateInput = document.getElementById('emulationDate');
const reportSelect = document.getElementById('reportSelect');
const refreshReportsBtn = document.getElementById('refreshReportsBtn');
const openReportBtn = document.getElementById('openReportBtn');
const reportFrame = document.getElementById('reportFrame');
const tradeMonitorBody = document.getElementById('tradeMonitorBody');
const clearActivityBtn = document.getElementById('clearActivityBtn');
const backtestProgressSummary = document.getElementById('backtestProgressSummary');

let tradeCursor = 0;
let tradeEvents = [];

function todayIsoDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function isEmulationMode() {
    return sessionMode.value === 'EMULATION';
}

function syncEmulationControls() {
    const isEmulation = isEmulationMode();
    emulationDateGroup.classList.toggle('d-none', !isEmulation);

    if (isEmulation) {
        continuousMode.checked = false;
    }

    continuousMode.disabled = isEmulation;
}

function formatPrice(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '-';
    }
    return value.toFixed(2);
}

function formatQty(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '-';
    }
    return value.toFixed(4);
}

function formatTradeTime(iso) {
    const value = typeof iso === 'string' ? new Date(iso) : null;
    if (!value || Number.isNaN(value.getTime())) {
        return '-';
    }

    return value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderTrades() {
    if (!tradeEvents.length) {
        tradeMonitorBody.innerHTML = '<tr><td colspan="10" class="text-muted">No entries or closes have been recorded yet.</td></tr>';
        return;
    }

    const rows = tradeEvents
        .slice()
        .sort((a, b) => (a.id || 0) - (b.id || 0))
        .map((event) => {
            const statusBadge = event.eventType === 'open'
                ? '<span class="badge text-bg-success">OPEN</span>'
                : '<span class="badge text-bg-secondary">CLOSED</span>';
            const sideBadge = event.side === 'buy'
                ? '<span class="badge text-bg-primary">BUY</span>'
                : '<span class="badge text-bg-warning">SELL</span>';
            const entry = event.eventType === 'open' ? formatPrice(event.entryPrice) : '-';
            const stop = event.eventType === 'open' ? formatPrice(event.stopPrice) : '-';
            const target = event.eventType === 'open' ? formatPrice(event.targetPrice) : '-';
            const close = event.eventType === 'close' ? formatPrice(event.closePrice) : '-';

            let resultState = 'open';
            if (event.eventType === 'close') {
                const hasPrices = typeof event.entryPrice === 'number' && typeof event.closePrice === 'number';
                if (hasPrices) {
                    if (event.position === 'long') {
                        resultState = event.closePrice > event.entryPrice ? 'profit' : event.closePrice < event.entryPrice ? 'loss' : 'open';
                    } else {
                        resultState = event.closePrice < event.entryPrice ? 'profit' : event.closePrice > event.entryPrice ? 'loss' : 'open';
                    }
                } else {
                    const reason = typeof event.reason === 'string' ? event.reason.toLowerCase() : '';
                    if (reason.includes('profit')) resultState = 'profit';
                    else if (reason.includes('loss')) resultState = 'loss';
                    else resultState = 'open';
                }
            }

            const resultClass = resultState === 'profit'
                ? 'result-dot result-dot-profit'
                : resultState === 'loss'
                    ? 'result-dot result-dot-loss'
                    : 'result-dot result-dot-open';
            const resultLabel = resultState === 'profit' ? 'Profit' : resultState === 'loss' ? 'Loss' : 'Open';

            return `
                <tr>
                    <td>${formatTradeTime(event.timestamp)}</td>
                    <td>${statusBadge}</td>
                    <td><span class="trade-symbol">${event.symbol || '-'}</span></td>
                    <td>${sideBadge}</td>
                    <td class="trade-price">${formatQty(event.qty)}</td>
                    <td class="trade-price">${entry}</td>
                    <td class="trade-price">${stop}</td>
                    <td class="trade-price">${target}</td>
                    <td class="trade-price">${close}</td>
                    <td><span class="${resultClass}" title="${resultLabel}" aria-label="${resultLabel}"></span></td>
                </tr>`;
        })
        .join('');

    tradeMonitorBody.innerHTML = rows;
}

function clearActivity() {
    tradeEvents = [];
    renderTrades();
}

function setStatusText(value) {
    statusBox.textContent = value;
}

function renderBacktestProgress(progress) {
    if (!progress || typeof progress.totalWeekdaySessions !== 'number') {
        backtestProgressSummary.textContent = 'No backtest running.';
        return;
    }

    const processed = progress.processedDates || 0;
    const total = progress.totalWeekdaySessions || 0;
    const skipped = progress.skippedDates || 0;
    const current = progress.currentSessionDate ? ` | Current: ${progress.currentSessionDate}` : '';
    const done = progress.completed ? 'Completed' : 'Running';
    backtestProgressSummary.textContent = `${done} | ${processed}/${total} processed | ${skipped} skipped${current}`;
}

async function readJson(response) {
    const text = await response.text();
    try {
        return JSON.parse(text);
    } catch {
        return { message: text || 'Unexpected response body' };
    }
}

function formatState(state) {
    return JSON.stringify(state, null, 2);
}

async function refreshStatus() {
    try {
        const response = await fetch('/api/orbilicious/status');
        const payload = await readJson(response);

        if (!response.ok) {
            setStatusText(`Failed to load status: ${payload.message || response.status}`);
            return;
        }

        setStatusText(formatState(payload));
        startBtn.disabled = payload.isRunning === true;
        stopBtn.disabled = payload.isRunning !== true;
        if (typeof payload.sessionMode === 'string') {
            sessionMode.value = payload.sessionMode;
        }
        if (typeof payload.emulationSessionDate === 'string' && payload.emulationSessionDate) {
            emulationDateInput.value = payload.emulationSessionDate;
        }
        renderBacktestProgress(payload.backtestProgress || null);
        syncEmulationControls();
    } catch (error) {
        setStatusText(`Status request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}

async function refreshTrades() {
    try {
        const response = await fetch(`/api/orbilicious/trades?since=${encodeURIComponent(String(tradeCursor))}`);
        const payload = await readJson(response);

        if (!response.ok) {
            return;
        }

        if (Array.isArray(payload.events) && payload.events.length) {
            tradeEvents.push(...payload.events);
            if (tradeEvents.length > 1000) {
                tradeEvents = tradeEvents.slice(tradeEvents.length - 1000);
            }
            renderTrades();
        }

        if (typeof payload.nextCursor === 'number') {
            tradeCursor = payload.nextCursor;
        }
    } catch {
        // Keep polling silently.
    }
}

async function startOrbilicious() {
    startBtn.disabled = true;
    stopBtn.disabled = true;

    try {
        const response = await fetch('/api/orbilicious/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                continuous: continuousMode.checked,
                sessionMode: sessionMode.value,
                emulationSessionDate: isEmulationMode() ? emulationDateInput.value : undefined,
            }),
        });

        const payload = await readJson(response);

        if (!response.ok) {
            alert(payload.message || 'Failed to start Orbilicious');
            return;
        }

        await refreshStatus();
        await refreshTrades();
    } catch (error) {
        alert(`Failed to start Orbilicious: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await refreshStatus();
    }
}

async function stopOrbilicious() {
    stopBtn.disabled = true;

    try {
        const response = await fetch('/api/orbilicious/stop', {
            method: 'POST',
        });
        const payload = await readJson(response);

        if (!response.ok) {
            alert(payload.message || 'Failed to stop Orbilicious');
            return;
        }

        await refreshStatus();
        await refreshTrades();
    } catch (error) {
        alert(`Failed to stop Orbilicious: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await refreshStatus();
    }
}

async function refreshReports() {
    try {
        const response = await fetch('/api/reports');
        const payload = await readJson(response);

        if (!response.ok) {
            alert(payload.message || 'Failed to load reports');
            return;
        }

        const reports = Array.isArray(payload.reports) ? payload.reports : [];
        const previous = reportSelect.value;
        reportSelect.innerHTML = '<option value="">Choose a report...</option>';

        for (const report of reports) {
            const option = document.createElement('option');
            option.value = report.relativePath;
            option.textContent = `${report.relativePath} (${report.type.toUpperCase()})`;
            reportSelect.appendChild(option);
        }

        if (previous) {
            reportSelect.value = previous;
        }
    } catch (error) {
        alert(`Failed to load reports: ${error instanceof Error ? error.message : String(error)}`);
    }
}

function openSelectedReport() {
    const selected = reportSelect.value;
    if (!selected) {
        alert('Select a report first.');
        return;
    }

    reportFrame.src = `/reports/${encodeURI(selected)}`;
}

startBtn.addEventListener('click', startOrbilicious);
stopBtn.addEventListener('click', stopOrbilicious);
refreshStatusBtn.addEventListener('click', refreshStatus);
refreshReportsBtn.addEventListener('click', refreshReports);
openReportBtn.addEventListener('click', openSelectedReport);
clearActivityBtn.addEventListener('click', clearActivity);
sessionMode.addEventListener('change', syncEmulationControls);

const today = todayIsoDate();
emulationDateInput.value = today;
emulationDateInput.max = today;
syncEmulationControls();

refreshStatus();
refreshReports();
refreshTrades();
window.setInterval(refreshStatus, 3000);
window.setInterval(refreshTrades, 1500);
