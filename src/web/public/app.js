const statusBox = document.getElementById('statusBox');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshStatusBtn = document.getElementById('refreshStatusBtn');
const continuousMode = document.getElementById('continuousMode');
const sessionMode = document.getElementById('sessionMode');
const emulationDateGroup = document.getElementById('emulationDateGroup');
const emulationDateInput = document.getElementById('emulationDate');
const reportSelect = document.getElementById('reportSelect');
const reportAnchorDateInput = document.getElementById('reportAnchorDate');
const generateReportBtn = document.getElementById('generateReportBtn');
const closeReportDetailBtn = document.getElementById('closeReportDetailBtn');
const reportGenerationStatus = document.getElementById('reportGenerationStatus');
const reportFrame = document.getElementById('reportFrame');
const tradeMonitorBody = document.getElementById('tradeMonitorBody');
const dailySummaryBody = document.getElementById('dailySummaryBody');
const dailySummaryHeaderDetail = document.getElementById('dailySummaryHeaderDetail');
const dailySummaryHeaderValue = document.getElementById('dailySummaryHeaderValue');
const clearActivityBtn = document.getElementById('clearActivityBtn');
const backtestProgressSummary = document.getElementById('backtestProgressSummary');
const paneExpandButtons = document.querySelectorAll('.pane-expand-btn');
const moneyInAccountSelect = document.getElementById('moneyInAccount');
const maxRiskPerSessionSelect = document.getElementById('maxRiskPerSession');
const stopProfitRatioSpinner = document.getElementById('stopProfitRatio');
const startConfirmationPane = document.getElementById('startConfirmationPane');
const confirmStartBtn = document.getElementById('confirmStartBtn');
const cancelStartBtn = document.getElementById('cancelStartBtn');
const confirmSessionMode = document.getElementById('confirmSessionMode');
const confirmEmulationDate = document.getElementById('confirmEmulationDate');
const confirmContinuousMode = document.getElementById('confirmContinuousMode');
const confirmMoneyInAccount = document.getElementById('confirmMoneyInAccount');
const confirmMaxRiskPerSession = document.getElementById('confirmMaxRiskPerSession');
const confirmStopProfitRatio = document.getElementById('confirmStopProfitRatio');

let tradeCursor = 0;
let tradeEvents = [];
let latestBacktestProgress = null;
let activeTopLevelReportSrc = '';

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

function formatTradeDateTime(iso) {
    const value = typeof iso === 'string' ? new Date(iso) : null;
    if (!value || Number.isNaN(value.getTime())) {
        return '-';
    }

    const datePart = value.toLocaleDateString([], { year: 'numeric', month: '2-digit', day: '2-digit' });
    const timePart = value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `${datePart} ${timePart}`;
}

function formatPnl(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '-';
    }

    return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function eventSessionDate(event) {
    if (typeof event.sessionDate === 'string' && event.sessionDate) {
        return event.sessionDate;
    }

    if (typeof event.timestamp === 'string' && event.timestamp.length >= 10) {
        return event.timestamp.slice(0, 10);
    }

    return null;
}

function renderDailySummary() {
    const dailyTotals = new Map();

    for (const event of tradeEvents) {
        if (event.eventType !== 'close') {
            continue;
        }

        if (typeof event.pnl !== 'number' || Number.isNaN(event.pnl)) {
            continue;
        }

        const sessionDate = eventSessionDate(event);
        if (!sessionDate) {
            continue;
        }

        const previous = dailyTotals.get(sessionDate) || 0;
        dailyTotals.set(sessionDate, previous + event.pnl);
    }

    const grandTotalPnl = Array.from(dailyTotals.values()).reduce((sum, value) => sum + value, 0);
    const summaryClass = grandTotalPnl > 0 ? 'result-profit' : grandTotalPnl < 0 ? 'result-loss' : 'result-open';
    dailySummaryHeaderValue.classList.remove('result-profit', 'result-loss', 'result-open');
    dailySummaryHeaderValue.classList.add(summaryClass);
    dailySummaryHeaderValue.textContent = formatPnl(grandTotalPnl);

    if (!dailyTotals.size) {
        dailySummaryBody.innerHTML = '<tr><td colspan="2" class="text-muted">No closed trades yet.</td></tr>';
        return;
    }

    const rows = Array.from(dailyTotals.entries())
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([date, pnl]) => {
            const pnlClass = pnl > 0 ? 'result-profit' : pnl < 0 ? 'result-loss' : 'result-open';
            return `
                <tr>
                    <td>${date}</td>
                    <td class="text-end trade-price ${pnlClass}">${formatPnl(pnl)}</td>
                </tr>`;
        })
        .join('');

    dailySummaryBody.innerHTML = rows;
}

function renderTrades() {
    if (!tradeEvents.length) {
        tradeMonitorBody.innerHTML = '<tr><td colspan="10" class="text-muted">No entries or closes have been recorded yet.</td></tr>';
        renderDailySummary();
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
                if (typeof event.pnl === 'number' && !Number.isNaN(event.pnl)) {
                    resultState = event.pnl > 0 ? 'profit' : event.pnl < 0 ? 'loss' : 'open';
                } else {
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
            }

            const resultClass = resultState === 'profit'
                ? 'result-profit'
                : resultState === 'loss'
                    ? 'result-loss'
                    : 'result-open';
            const pnl = event.eventType === 'close' ? formatPnl(event.pnl) : 'Open';

            return `
                <tr>
                    <td>${formatTradeDateTime(event.timestamp)}</td>
                    <td>${statusBadge}</td>
                    <td><span class="trade-symbol">${event.symbol || '-'}</span></td>
                    <td>${sideBadge}</td>
                    <td class="trade-price">${formatQty(event.qty)}</td>
                    <td class="trade-price">${entry}</td>
                    <td class="trade-price">${stop}</td>
                    <td class="trade-price">${target}</td>
                    <td class="trade-price">${close}</td>
                    <td class="trade-price ${resultClass}">${pnl}</td>
                </tr>`;
        })
        .join('');

    tradeMonitorBody.innerHTML = rows;
    renderDailySummary();
}

function clearActivity() {
    tradeEvents = [];
    renderTrades();
}

function setStatusText(value) {
    statusBox.textContent = value;
}

function renderBacktestProgress(progress) {
    latestBacktestProgress = progress;

    if (!progress || typeof progress.totalWeekdaySessions !== 'number') {
        backtestProgressSummary.textContent = 'No backtest running.';
        renderDailySummary();
        return;
    }

    const processed = progress.processedDates || 0;
    const total = progress.totalWeekdaySessions || 0;
    const skipped = progress.skippedDates || 0;
    const current = progress.currentSessionDate ? ` | Current: ${progress.currentSessionDate}` : '';
    const done = progress.completed ? 'Completed' : 'Running';
    backtestProgressSummary.textContent = `${done} | ${processed}/${total} processed | ${skipped} skipped${current}`;
    renderDailySummary();
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

function formatCurrency(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '-';
    }
    return `$${value.toLocaleString()}`;
}

function showStartConfirmationPane() {
    const session = sessionMode.value || '-';
    const isEmulation = session === 'EMULATION';
    const emulationDate = isEmulation && emulationDateInput.value ? emulationDateInput.value : 'N/A';
    const continuous = continuousMode.checked ? 'Enabled' : 'Disabled';
    const moneyInAccount = getMoneyInAccount();
    const maxRiskPerSession = getMaxRiskPerSession();
    const stopProfitRatio = getStopProfitRatio();

    confirmSessionMode.textContent = session;
    confirmEmulationDate.textContent = emulationDate;
    confirmContinuousMode.textContent = continuous;
    confirmMoneyInAccount.textContent = formatCurrency(moneyInAccount);
    confirmMaxRiskPerSession.textContent = formatCurrency(maxRiskPerSession);
    confirmStopProfitRatio.textContent = `1:${stopProfitRatio}`;

    startConfirmationPane.classList.remove('d-none');
}

function hideStartConfirmationPane() {
    startConfirmationPane.classList.add('d-none');
}

async function refreshStatus() {
    try {
        const response = await fetch('/api/orbilicious/status');
        const payload = await readJson(response);

        if (!response.ok) {
            setStatusText(`Failed to load status: ${payload.message || response.status}`);
            return payload;
        }

        setStatusText(formatState(payload));
        startBtn.disabled = payload.isRunning === true;
        stopBtn.disabled = payload.isRunning !== true;
        renderBacktestProgress(payload.backtestProgress || null);
        syncEmulationControls();
        return payload;
    } catch (error) {
        setStatusText(`Status request failed: ${error instanceof Error ? error.message : String(error)}`);
        return null;
    }
}

function syncDropdownsFromServer(payload) {
    if (!payload) return;
    if (typeof payload.sessionMode === 'string') {
        sessionMode.value = payload.sessionMode;
    }
    if (typeof payload.emulationSessionDate === 'string' && payload.emulationSessionDate) {
        emulationDateInput.value = payload.emulationSessionDate;
    }
    syncEmulationControls();
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

async function submitStartOrbilicious() {
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
                moneyInAccount: getMoneyInAccount(),
                maxRiskPerSession: getMaxRiskPerSession(),
                stopProfitRewardPart: getStopProfitRatio(),
            }),
        });

        const payload = await readJson(response);

        if (!response.ok) {
            alert(payload.message || 'Failed to start ORBilicious');
            return;
        }

        await refreshStatus();
        await refreshTrades();
    } catch (error) {
        alert(`Failed to start ORBilicious: ${error instanceof Error ? error.message : String(error)}`);
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
            alert(payload.message || 'Failed to stop ORBilicious');
            return;
        }

        await refreshStatus();
        await refreshTrades();
    } catch (error) {
        alert(`Failed to stop ORBilicious: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        await refreshStatus();
    }
}

async function generateSelectedReport() {
    const reportType = reportSelect.value;
    const anchorDate = reportAnchorDateInput.value;
    if (!reportType) {
        alert('Select a report type first.');
        return;
    }

    if (!anchorDate) {
        alert('Select a report date first.');
        return;
    }

    const isLongRunningReport = reportType === 'week' || reportType === 'month';

    generateReportBtn.disabled = true;
    reportGenerationStatus.classList.toggle('d-none', !isLongRunningReport);

    try {
        const response = await fetch('/api/reports/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reportType, anchorDate }),
        });
        const payload = await readJson(response);

        if (!response.ok) {
            alert(payload.message || 'Failed to generate report');
            return;
        }

        const report = payload.report;
        if (!report || !report.htmlRelativePath) {
            alert('Report generated, but response was missing file paths.');
            return;
        }

        activeTopLevelReportSrc = `/reports/${encodeURI(report.htmlRelativePath)}`;
        reportFrame.src = activeTopLevelReportSrc;
    } catch (error) {
        alert(`Failed to generate report: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        reportGenerationStatus.classList.add('d-none');
        generateReportBtn.disabled = false;
    }
}

function closeReportDetail() {
    const frameWindow = reportFrame.contentWindow;
    const frameLocation = frameWindow?.location?.href || '';

    if (frameWindow && frameLocation && activeTopLevelReportSrc && !frameLocation.endsWith(activeTopLevelReportSrc)) {
        frameWindow.history.back();
        return;
    }

    if (!activeTopLevelReportSrc) {
        reportFrame.src = 'about:blank';
        return;
    }

    reportFrame.src = activeTopLevelReportSrc;
}

function togglePaneExpansion(button) {
    const targetId = button.getAttribute('data-target');
    if (!targetId) {
        return;
    }

    const pane = document.getElementById(targetId);
    if (!pane) {
        return;
    }

    const expanded = pane.classList.toggle('expanded');
    button.textContent = expanded ? 'Collapse' : 'Expand';
    button.setAttribute('aria-expanded', expanded ? 'true' : 'false');
}

function populateDropdownRange(selectElement, start, end, increment, formatter) {
    selectElement.innerHTML = '';
    for (let value = start; value <= end; value += increment) {
        const option = document.createElement('option');
        option.value = value.toString();
        option.textContent = formatter(value);
        selectElement.appendChild(option);
    }
}

function initializeAccountAndRiskSpinners() {
    populateDropdownRange(moneyInAccountSelect, 500, 100000, 500, (v) => `$${v.toLocaleString()}`);
    populateDropdownRange(maxRiskPerSessionSelect, 500, 20000, 500, (v) => `$${v.toLocaleString()}`);
    moneyInAccountSelect.value = '25000';
    maxRiskPerSessionSelect.value = '1000';
}

function getMoneyInAccount() {
    return moneyInAccountSelect.value ? parseFloat(moneyInAccountSelect.value) || undefined : undefined;
}

function getMaxRiskPerSession() {
    return maxRiskPerSessionSelect.value ? parseFloat(maxRiskPerSessionSelect.value) || undefined : undefined;
}

function getStopProfitRatio() {
    const value = stopProfitRatioSpinner.value ? parseFloat(stopProfitRatioSpinner.value) : 4;
    return Math.max(1, Math.min(20, value));
}

startBtn.addEventListener('click', showStartConfirmationPane);
confirmStartBtn.addEventListener('click', async () => {
    hideStartConfirmationPane();
    await submitStartOrbilicious();
});
cancelStartBtn.addEventListener('click', hideStartConfirmationPane);
stopBtn.addEventListener('click', stopOrbilicious);
refreshStatusBtn.addEventListener('click', refreshStatus);
generateReportBtn.addEventListener('click', generateSelectedReport);
closeReportDetailBtn.addEventListener('click', closeReportDetail);
clearActivityBtn.addEventListener('click', clearActivity);
sessionMode.addEventListener('change', syncEmulationControls);

for (const button of paneExpandButtons) {
    button.addEventListener('click', () => togglePaneExpansion(button));
}

const today = todayIsoDate();
emulationDateInput.value = today;
emulationDateInput.max = today;
reportAnchorDateInput.value = today;
syncEmulationControls();
initializeAccountAndRiskSpinners();

refreshStatus().then((payload) => {
    syncDropdownsFromServer(payload);
});
refreshTrades();
window.setInterval(refreshStatus, 3000);
window.setInterval(refreshTrades, 1500);
