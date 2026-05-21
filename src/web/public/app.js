// Optimal/max-profit settings for breakout confirmation and quality filters
const MAX_PROFIT_FILTERS = {
    breakoutConfirmationCandleMinutes: 5,
    breakoutQualityFiltersEnabled: true,
    breakoutMinVolumeExpansion: 1.1,
    breakoutMinRelativeStrengthPct: 0.15,
    breakoutTrendTimeframeMinutes: 5,
    breakoutTrendLookbackBars: 3,
};

function setMaximizeProfitStatus(message, tone = 'muted') {
    const statusEl = document.getElementById('maximizeProfitStatus');
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.remove('text-muted', 'text-success', 'text-warning', 'text-danger');
    if (tone === 'success') statusEl.classList.add('text-success');
    else if (tone === 'warning') statusEl.classList.add('text-warning');
    else if (tone === 'danger') statusEl.classList.add('text-danger');
    else statusEl.classList.add('text-muted');
}

function setMaximizeProfitFilters() {
    const sessionDate = emulationDateInput && emulationDateInput.value ? emulationDateInput.value : '';
    const symbol = 'SPY';

    // Maximize Profit Probability always enables breakout quality filters.
    breakoutQualityFiltersEnabledInput.checked = true;
    breakoutQualityFiltersEnabledInput.dispatchEvent(new Event('input', { bubbles: true }));
    breakoutQualityFiltersEnabledInput.dispatchEvent(new Event('change', { bubbles: true }));

    setMaximizeProfitStatus('Loading dynamic filter values...', 'muted');

    fetch(`/api/optimal-filters?symbol=${encodeURIComponent(symbol)}&sessionDate=${encodeURIComponent(sessionDate)}`)
        .then(async (res) => {
            const data = await res.json().catch(() => ({ ok: false, message: 'Invalid server response.' }));
            if (!res.ok || !data.ok || !data.filters) {
                throw new Error(data.message || `Request failed (${res.status}).`);
            }
            return data;
        })
        .then((data) => {
            const filters = data.filters;
            breakoutConfirmationCandleMinutesInput.value = filters.breakoutConfirmationCandleMinutes;
            breakoutQualityFiltersEnabledInput.checked = true;
            breakoutQualityFiltersEnabledInput.dispatchEvent(new Event('input', { bubbles: true }));
            breakoutQualityFiltersEnabledInput.dispatchEvent(new Event('change', { bubbles: true }));
            breakoutMinVolumeExpansionInput.value = filters.breakoutMinVolumeExpansion;
            breakoutMinRelativeStrengthPctInput.value = filters.breakoutMinRelativeStrengthPct;
            breakoutTrendTimeframeMinutesInput.value = filters.breakoutTrendTimeframeMinutes;
            breakoutTrendLookbackBarsInput.value = filters.breakoutTrendLookbackBars;
            requestAnimationFrame(() => applyBreakoutQualityInputsEnabled());
            if (data.usedFallback) {
                setMaximizeProfitStatus('Applied fallback max-profit filters (dynamic analysis unavailable).', 'warning');
            } else {
                setMaximizeProfitStatus('Applied dynamic max-profit filters from market data.', 'success');
            }
        })
        .catch((err) => {
            breakoutConfirmationCandleMinutesInput.value = MAX_PROFIT_FILTERS.breakoutConfirmationCandleMinutes;
            breakoutQualityFiltersEnabledInput.checked = true;
            breakoutQualityFiltersEnabledInput.dispatchEvent(new Event('input', { bubbles: true }));
            breakoutQualityFiltersEnabledInput.dispatchEvent(new Event('change', { bubbles: true }));
            breakoutMinVolumeExpansionInput.value = MAX_PROFIT_FILTERS.breakoutMinVolumeExpansion;
            breakoutMinRelativeStrengthPctInput.value = MAX_PROFIT_FILTERS.breakoutMinRelativeStrengthPct;
            breakoutTrendTimeframeMinutesInput.value = MAX_PROFIT_FILTERS.breakoutTrendTimeframeMinutes;
            breakoutTrendLookbackBarsInput.value = MAX_PROFIT_FILTERS.breakoutTrendLookbackBars;
            requestAnimationFrame(() => applyBreakoutQualityInputsEnabled());
            setMaximizeProfitStatus(`Applied local fallback max-profit filters: ${err.message}`, 'danger');
        });
}

const maximizeProfitBtn = document.getElementById('maximizeProfitBtn');
if (maximizeProfitBtn) {
    maximizeProfitBtn.addEventListener('click', setMaximizeProfitFilters);
}
const statusBox = document.getElementById('statusBox');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const refreshStatusBtn = document.getElementById('refreshStatusBtn');
const continuousMode = document.getElementById('continuousMode');
const candidateTradeType = document.getElementById('candidateTradeType');
const realTimeDataFeed = document.getElementById('realTimeDataFeed');
const realTimeDataFeedError = document.getElementById('realTimeDataFeedError');
const sessionMode = document.getElementById('sessionMode');
const emulationDateGroup = document.getElementById('emulationDateGroup');
const emulationDateInput = document.getElementById('emulationDate');
const mostActiveSymbolLimitInput = document.getElementById('mostActiveSymbolLimit');
const liveEmulationWarning = document.getElementById('liveEmulationWarning');
const liveEmulationWarningText = document.getElementById('liveEmulationWarningText');
const reportSelect = document.getElementById('reportSelect');
const reportAnchorDateInput = document.getElementById('reportAnchorDate');
const generateReportBtn = document.getElementById('generateReportBtn');
const closeReportDetailBtn = document.getElementById('closeReportDetailBtn');
const reportGenerationStatus = document.getElementById('reportGenerationStatus');
const reportFrame = document.getElementById('reportFrame');
const liquiditySessionDateInput = document.getElementById('liquiditySessionDate');
const liquiditySymbolLimitInput = document.getElementById('liquiditySymbolLimit');
const liquidityScanBtn = document.getElementById('liquidityScanBtn');
const liquidityScanStatus = document.getElementById('liquidityScanStatus');
const liquiditySummary = document.getElementById('liquiditySummary');
const liquiditySortMode = document.getElementById('liquiditySortMode');
const liquidityZoneBody = document.getElementById('liquidityZoneBody');
const tradeMonitorBody = document.getElementById('tradeMonitorBody');
const dailySummaryBody = document.getElementById('dailySummaryBody');
const dailySummaryHeaderDetail = document.getElementById('dailySummaryHeaderDetail');
const dailySummaryHeaderValue = document.getElementById('dailySummaryHeaderValue');
const clearActivityBtn = document.getElementById('clearActivityBtn');
const browserLocalTime = document.getElementById('browserLocalTime');
const backtestProgressSummary = document.getElementById('backtestProgressSummary');
const paneExpandButtons = document.querySelectorAll('.pane-expand-btn');
const topTabButtons = document.querySelectorAll('[data-tab-target]');
const topTabPanels = document.querySelectorAll('.top-tab-panel');
const moneyInAccountSelect = document.getElementById('moneyInAccount');
const maxRiskPerSessionSelect = document.getElementById('maxRiskPerSession');
const stopProfitRatioSpinner = document.getElementById('stopProfitRatio');
const breakoutConfirmationCandleMinutesInput = document.getElementById('breakoutConfirmationCandleMinutes');
const breakoutQualityFiltersEnabledInput = document.getElementById('breakoutQualityFiltersEnabled');
const breakoutMinVolumeExpansionInput = document.getElementById('breakoutMinVolumeExpansion');
const breakoutMinRelativeStrengthPctInput = document.getElementById('breakoutMinRelativeStrengthPct');
const breakoutTrendTimeframeMinutesInput = document.getElementById('breakoutTrendTimeframeMinutes');
const breakoutTrendLookbackBarsInput = document.getElementById('breakoutTrendLookbackBars');
const startConfirmationPane = document.getElementById('startConfirmationPane');
const confirmStartBtn = document.getElementById('confirmStartBtn');
const cancelStartBtn = document.getElementById('cancelStartBtn');
const confirmSessionMode = document.getElementById('confirmSessionMode');
const confirmEmulationDate = document.getElementById('confirmEmulationDate');
const confirmMostActiveSymbolLimit = document.getElementById('confirmMostActiveSymbolLimit');
const confirmContinuousMode = document.getElementById('confirmContinuousMode');
const confirmCandidateTradeType = document.getElementById('confirmCandidateTradeType');
const confirmMoneyInAccount = document.getElementById('confirmMoneyInAccount');
const confirmMaxRiskPerSession = document.getElementById('confirmMaxRiskPerSession');
const confirmStopProfitRatio = document.getElementById('confirmStopProfitRatio');
const confirmBreakoutConfirmationCandleMinutes = document.getElementById('confirmBreakoutConfirmationCandleMinutes');
const confirmBreakoutQualityFiltersEnabled = document.getElementById('confirmBreakoutQualityFiltersEnabled');
const confirmBreakoutMinVolumeExpansion = document.getElementById('confirmBreakoutMinVolumeExpansion');
const confirmBreakoutMinRelativeStrengthPct = document.getElementById('confirmBreakoutMinRelativeStrengthPct');
const confirmBreakoutTrendTimeframeMinutes = document.getElementById('confirmBreakoutTrendTimeframeMinutes');
const confirmBreakoutTrendLookbackBars = document.getElementById('confirmBreakoutTrendLookbackBars');
const fieldHelpPopover = document.getElementById('fieldHelpPopover');
const fieldHelpTitle = document.getElementById('fieldHelpTitle');
const fieldHelpSubtitle = document.getElementById('fieldHelpSubtitle');
const fieldHelpText = document.getElementById('fieldHelpText');
const closeFieldHelpBtn = document.getElementById('closeFieldHelpBtn');
const tradeChartTooltip = document.getElementById('tradeChartTooltip');
const tradeChartTooltipTitle = document.getElementById('tradeChartTooltipTitle');
const tradeChartTooltipBody = document.getElementById('tradeChartTooltipBody');
const tradeChartTooltipPnl = document.getElementById('tradeChartTooltipPnl');
const closeTradeChartTooltipBtn = document.getElementById('closeTradeChartTooltipBtn');

let tradeCursor = 0;
let tradeEvents = [];
let latestBacktestProgress = null;
let activeTopLevelReportSrc = '';
let latestOrbUiMessage = '';
let latestRuntimeStatus = '';
let latestIsRunning = false;
let latestLiquidityPayload = null;
let sipProbeUnsupported = false;
let activeFieldHelpAnchor = null;
let activeTradeChartAnchor = null;
let activeTradeChartKey = '';

const fieldHelpContent = {
    maximizeProfit: {
        title: 'Maximize Profit',
        subtitle: 'Set optimal filter values for profit',
        text: 'Clicking this button automatically adjusts all Breakout Confirmation and Quality Filters to values that maximize the probability of capturing the largest possible profits, based on historical analysis and best practices. You can further fine-tune these values if desired before starting ORBilicious.',
    },
    sessionMode: {
        title: 'Session mode',
        subtitle: 'Choose how ORBilicious should run.',
        text: 'EMULATION replays historical market data without placing live orders. PAPER submits orders to your Alpaca paper account. LIVE uses your live Alpaca account and real orders.',
    },
    emulationDate: {
        title: 'Emulation session date',
        subtitle: 'Select the trading day to replay.',
        text: 'Use a current or past New York trading session when running historical emulation. The app will replay that session’s breakout logic and trade management against historical data.',
    },
    mostActiveSymbolLimit: {
        title: 'Most active stocks to scan',
        subtitle: 'Set universe size before candidate discovery.',
        text: 'This sets how many most-active symbols are retrieved before breakout candidates are evaluated. Higher values broaden the universe but increase scan time.',
    },
    continuousMode: {
        title: 'Continuous mode',
        subtitle: 'Keep ORBilicious running between sessions.',
        text: 'When enabled, ORBilicious stays active and waits for the next market conditions instead of ending immediately after one pass. In emulation it is useful for live-style replay behavior.',
    },
    candidateTradeType: {
        title: 'Breakout Candidate Trade Type',
        subtitle: 'Control which breakout directions are allowed.',
        text: 'Long selects only bullish breakout candidates. Short selects only bearish breakout candidates. Both allows either direction and is the default.',
    },
    realTimeDataFeed: {
        title: 'Run in real time',
        subtitle: 'Use Alpaca real-time data when available.',
        text: 'Enable this only if your Alpaca subscription supports SIP or real-time market data. If the account does not support it, ORBilicious will show a warning and continue using the configured fallback behavior.',
    },
    moneyInAccount: {
        title: 'Money in Account',
        subtitle: 'Set the account value used for sizing.',
        text: 'This value is used by the trade sizing logic to determine how much notional capital is available for the run. It does not change your real Alpaca account balance.',
    },
    maxRiskPerSession: {
        title: 'Max Amount to Risk Per Trading Day',
        subtitle: 'Cap the total risk for the session.',
        text: 'ORBilicious uses this as the maximum total dollars it can place at risk across all breakout candidates for the selected trading day.',
    },
    stopProfitRatio: {
        title: 'Stop/Profit Limit Ratio',
        subtitle: 'Set the reward multiple after the stop loss.',
        text: 'A ratio of 1:4 means the profit target is four times the stop distance. Larger ratios seek more reward for the same risk and smaller ratios exit sooner.',
    },
    breakoutConfirmationCandleMinutes: {
        title: 'Breakout Confirmation Candle',
        subtitle: 'Require a close outside the range on this timeframe.',
        text: 'Default is 5 minutes to reduce 1-minute noise spikes. Lower values react faster; higher values are stricter.',
    },
    breakoutQualityFiltersEnabled: {
        title: 'Breakout Quality Filters',
        subtitle: 'Enable quality gating before candidate acceptance.',
        text: 'When enabled, candidates must pass volume expansion, relative strength/weakness, and higher-timeframe trend alignment checks.',
    },
    breakoutMinVolumeExpansion: {
        title: 'Min Volume Expansion',
        subtitle: 'Volume requirement for breakout quality.',
        text: 'Breakout-candle volume must be at least this multiple of recent confirmation-candle volume. Example: 1.2 means 20% higher volume.',
    },
    breakoutMinRelativeStrengthPct: {
        title: 'Min Relative Strength (%)',
        subtitle: 'Distance outside opening range required on breakout close.',
        text: 'For longs, close must be at least this percent above OR high. For shorts, this percent below OR low.',
    },
    breakoutTrendTimeframeMinutes: {
        title: 'Trend Timeframe (minutes)',
        subtitle: 'Higher-timeframe bars used for trend alignment.',
        text: 'Defines the aggregation period used to measure trend direction before breakout quality is approved.',
    },
    breakoutTrendLookbackBars: {
        title: 'Trend Lookback Bars',
        subtitle: 'How many higher-timeframe bars define trend context.',
        text: 'Higher values smooth trend checks; lower values react faster but can be noisier.',
    },
};

function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function positionFieldHelpPopover(anchor) {
    if (!fieldHelpPopover || !anchor) return;

    const rect = anchor.getBoundingClientRect();
    const popoverWidth = Math.min(320, window.innerWidth - 16);
    const popoverHeight = fieldHelpPopover.offsetHeight || 180;
    const gap = 10;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const showBelow = spaceBelow >= popoverHeight + gap || spaceBelow >= spaceAbove;

    const left = Math.max(8, Math.min(rect.left, window.innerWidth - popoverWidth - 8));
    const top = showBelow
        ? Math.min(rect.bottom + gap, window.innerHeight - popoverHeight - 8)
        : Math.max(8, rect.top - popoverHeight - gap);

    fieldHelpPopover.style.left = `${left}px`;
    fieldHelpPopover.style.top = `${top}px`;
    fieldHelpPopover.dataset.placement = showBelow ? 'bottom' : 'top';
}

function openFieldHelp(key, anchor) {
    const help = fieldHelpContent[key];
    if (!help || !fieldHelpPopover || !fieldHelpTitle || !fieldHelpSubtitle || !fieldHelpText) {
        return;
    }

    fieldHelpTitle.textContent = help.title;
    fieldHelpSubtitle.textContent = help.subtitle;
    fieldHelpText.textContent = help.text;
    activeFieldHelpAnchor = anchor || null;
    fieldHelpPopover.classList.remove('d-none');
    fieldHelpPopover.style.visibility = 'hidden';

    requestAnimationFrame(() => {
        if (fieldHelpPopover.classList.contains('d-none')) return;
        positionFieldHelpPopover(activeFieldHelpAnchor);
        fieldHelpPopover.style.visibility = 'visible';
    });
}

function closeFieldHelp() {
    if (!fieldHelpPopover) return;
    fieldHelpPopover.classList.add('d-none');
    fieldHelpPopover.style.visibility = '';
    activeFieldHelpAnchor = null;
}

function todayIsoDate() {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function areNYMarketsOpen() {
    const now = new Date();
    const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dayOfWeek = nyTime.getDay();
    const hours = nyTime.getHours();
    const minutes = nyTime.getMinutes();
    const currentMinutes = hours * 60 + minutes;

    // Markets closed on weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        return false;
    }

    // Market open: 9:30 AM to 4:00 PM (16:00) NY time
    const marketOpenMinutes = 9 * 60 + 30;  // 9:30 AM = 570 minutes
    const marketCloseMinutes = 16 * 60;     // 4:00 PM = 960 minutes

    return currentMinutes >= marketOpenMinutes && currentMinutes < marketCloseMinutes;
}

function isEmulationMode() {
    return sessionMode.value === 'EMULATION';
}

function isLiveEmulation() {
    if (!isEmulationMode()) return false;
    const emulationDate = emulationDateInput.value;
    if (!emulationDate) return false;
    const today = todayIsoDate();
    return emulationDate === today;
}

function syncEmulationControls() {
    const isEmulation = isEmulationMode();
    emulationDateGroup.classList.toggle('d-none', !isEmulation);

    const isLiveEmu = isLiveEmulation();
    const isHistoricalEmu = isEmulation && !isLiveEmu;
    const isRunningHistorical = isHistoricalEmu && latestIsRunning;
    const isContinuous = continuousMode.checked;
    const hasOrbUiMessage = typeof latestOrbUiMessage === 'string' && latestOrbUiMessage.trim() !== '';
    const isWaitingForMarketOpen = latestRuntimeStatus === 'Waiting for market open';
    const shouldShowWarning = isLiveEmu || isRunningHistorical || (isEmulation && hasOrbUiMessage) || isWaitingForMarketOpen;
    liveEmulationWarning.classList.toggle('d-none', !shouldShowWarning);

    if (isWaitingForMarketOpen) {
        liveEmulationWarningText.textContent = 'Waiting for markets to open.';
    } else if (isEmulation && hasOrbUiMessage) {
        liveEmulationWarningText.textContent = latestOrbUiMessage;
    } else if (isRunningHistorical) {
        liveEmulationWarningText.textContent = 'Running against historic data.';
    }

    // Update message based on continuous mode
    if (isLiveEmu && isContinuous && !hasOrbUiMessage) {
        const marketsOpen = areNYMarketsOpen();
        if (marketsOpen) {
            liveEmulationWarningText.textContent = 'Emulation is running live and in continuous mode, but no trades will actually be executed against your account.';
        } else {
            liveEmulationWarningText.textContent = 'Emulation is running live and in continuous mode, but no trades will be executed until the NY Markets open.';
        }
    } else if (isLiveEmu && !hasOrbUiMessage) {
        const marketsOpen = areNYMarketsOpen();
        if (marketsOpen) {
            liveEmulationWarningText.textContent = 'Emulation is running live, but no trades will actually be executed against your account.';
        } else {
            liveEmulationWarningText.textContent = 'Emulation is running live, but no trades will be executed until the NY Markets open.';
        }
    }

    if (isEmulation && !isLiveEmu) {
        continuousMode.checked = false;
        continuousMode.disabled = true;
    } else {
        continuousMode.disabled = false;
    }
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

    const datePart = value.toLocaleDateString([], { month: '2-digit', day: '2-digit' });
    const timePart = value.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${datePart} ${timePart}`;
}

function formatPnl(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '-';
    }

    return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function positionTradeChartTooltip(anchor) {
    if (!tradeChartTooltip || !anchor) return;

    const rect = anchor.getBoundingClientRect();
    const tooltipWidth = Math.min(780, window.innerWidth - 16);
    const tooltipHeight = tradeChartTooltip.offsetHeight || 380;
    const gap = 10;
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const showBelow = spaceBelow >= tooltipHeight + gap || spaceBelow >= spaceAbove;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - tooltipWidth - 8));
    const top = showBelow
        ? Math.min(rect.bottom + gap, window.innerHeight - tooltipHeight - 8)
        : Math.max(8, rect.top - tooltipHeight - gap);

    tradeChartTooltip.style.left = `${left}px`;
    tradeChartTooltip.style.top = `${top}px`;
}

function closeTradeChartTooltip() {
    if (!tradeChartTooltip) return;
    tradeChartTooltip.classList.add('d-none');
    tradeChartTooltip.style.visibility = '';
    activeTradeChartAnchor = null;
    activeTradeChartKey = '';
}

function chartSourceEvent(events, rowIndex) {
    const event = events[rowIndex];
    if (!event || !event.symbol) {
        return null;
    }

    const hasOpenFields = typeof event.entryPrice === 'number'
        && typeof event.stopPrice === 'number'
        && typeof event.targetPrice === 'number';

    if (event.eventType === 'open' && hasOpenFields) {
        return event;
    }

    for (let i = rowIndex - 1; i >= 0; i -= 1) {
        const candidate = events[i];
        if (
            candidate
            && candidate.eventType === 'open'
            && candidate.symbol === event.symbol
            && eventSessionDate(candidate) === eventSessionDate(event)
            && typeof candidate.entryPrice === 'number'
            && typeof candidate.stopPrice === 'number'
            && typeof candidate.targetPrice === 'number'
        ) {
            return candidate;
        }
    }

    return null;
}

function chartButtonMarkup(rowEvent, sourceEvent) {
    if (!sourceEvent) {
        return '<span class="text-muted">-</span>';
    }

    const sessionDate = eventSessionDate(sourceEvent);
    if (!sessionDate || typeof sourceEvent.timestamp !== 'string') {
        return '<span class="text-muted">-</span>';
    }

    const closePrice = rowEvent.eventType === 'close' && typeof rowEvent.closePrice === 'number'
        ? rowEvent.closePrice
        : '';
    const closeTimestamp = rowEvent.eventType === 'close' && typeof rowEvent.timestamp === 'string'
        ? rowEvent.timestamp
        : '';
    const pnlValue = rowEvent.eventType === 'close' && typeof rowEvent.pnl === 'number' && !Number.isNaN(rowEvent.pnl)
        ? rowEvent.pnl
        : '';

    return `<button type="button" class="btn btn-sm btn-outline-secondary trade-chart-trigger"
        data-symbol="${sourceEvent.symbol}"
        data-session-date="${sessionDate}"
        data-determination-timestamp="${sourceEvent.timestamp}"
        data-entry-timestamp="${sourceEvent.timestamp}"
        data-entry-price="${sourceEvent.entryPrice}"
        data-stop-price="${sourceEvent.stopPrice}"
        data-target-price="${sourceEvent.targetPrice}"
        data-close-price="${closePrice}"
        data-close-timestamp="${closeTimestamp}"
        data-pnl="${pnlValue}"
        aria-label="Show chart for ${sourceEvent.symbol}"
        title="Show chart">
        <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" fill="currentColor">
            <path d="M1.25 1.25a.75.75 0 0 1 .75.75v11.5h11.5a.75.75 0 0 1 0 1.5h-12A1.25 1.25 0 0 1 .25 13.75v-12a.75.75 0 0 1 .75-.75Z"/>
            <path d="M4.47 11.03a.75.75 0 0 1 0-1.06l2.53-2.53a.75.75 0 0 1 1.06 0l1.19 1.19 2.78-3.58a.75.75 0 1 1 1.18.92l-3.3 4.25a.75.75 0 0 1-1.11.08L7.53 9.03l-2 2a.75.75 0 0 1-1.06 0Z"/>
        </svg>
    </button>`;
}

async function openTradeChartTooltip(button) {
    if (!tradeChartTooltip || !tradeChartTooltipBody || !tradeChartTooltipTitle) {
        return;
    }

    const symbol = button.dataset.symbol || '';
    const sessionDate = button.dataset.sessionDate || '';
    const determinationTimestamp = button.dataset.determinationTimestamp || '';
    const entryTimestamp = button.dataset.entryTimestamp || '';
    const entryPrice = button.dataset.entryPrice || '';
    const stopPrice = button.dataset.stopPrice || '';
    const targetPrice = button.dataset.targetPrice || '';
    const closePrice = button.dataset.closePrice || '';
    const closeTimestamp = button.dataset.closeTimestamp || '';
    const pnl = button.dataset.pnl || '';
    const requestKey = `${symbol}|${sessionDate}|${determinationTimestamp}|${entryTimestamp}|${entryPrice}|${stopPrice}|${targetPrice}|${closePrice}|${closeTimestamp}|${pnl}`;

    if (activeTradeChartAnchor === button && !tradeChartTooltip.classList.contains('d-none')) {
        closeTradeChartTooltip();
        return;
    }

    activeTradeChartAnchor = button;
    activeTradeChartKey = requestKey;
    tradeChartTooltip.classList.remove('d-none');
    tradeChartTooltip.style.visibility = 'hidden';
    tradeChartTooltipTitle.textContent = `${symbol || '-'} ${sessionDate || ''}`.trim();
    if (tradeChartTooltipPnl) {
        const pnlNum = Number(pnl);
        const hasPnl = pnl !== '' && Number.isFinite(pnlNum);
        const pnlText = hasPnl ? `P/L: ${formatPnl(pnlNum)}` : 'P/L: Open';
        const pnlClass = hasPnl ? (pnlNum > 0 ? 'result-profit' : pnlNum < 0 ? 'result-loss' : 'result-open') : 'result-open';
        tradeChartTooltipPnl.textContent = pnlText;
        tradeChartTooltipPnl.classList.remove('result-profit', 'result-loss', 'result-open');
        tradeChartTooltipPnl.classList.add(pnlClass);
    }
    tradeChartTooltipBody.innerHTML = '<div class="text-light small">Loading chart...</div>';

    requestAnimationFrame(() => {
        if (tradeChartTooltip.classList.contains('d-none')) return;
        positionTradeChartTooltip(activeTradeChartAnchor);
        tradeChartTooltip.style.visibility = 'visible';
    });

    try {
        const query = new URLSearchParams({
            symbol,
            sessionDate,
            determinationTimestamp,
            entryTimestamp,
            entryPrice,
            stopPrice,
            targetPrice,
        });
        if (closePrice) {
            query.set('closePrice', closePrice);
        }
        if (closeTimestamp) {
            query.set('closeTimestamp', closeTimestamp);
        }

        const response = await fetch(`/api/orbilicious/candidate-chart?${query.toString()}`);
        const payload = await readJson(response);
        if (requestKey !== activeTradeChartKey) {
            return;
        }

        if (!response.ok) {
            tradeChartTooltipBody.innerHTML = `<div class="text-warning small">${payload.message || 'Unable to load chart.'}</div>`;
            positionTradeChartTooltip(activeTradeChartAnchor);
            return;
        }

        tradeChartTooltipBody.innerHTML = typeof payload.svg === 'string'
            ? payload.svg
            : '<div class="text-warning small">No chart content returned.</div>';
        positionTradeChartTooltip(activeTradeChartAnchor);
    } catch {
        if (requestKey !== activeTradeChartKey) {
            return;
        }
        tradeChartTooltipBody.innerHTML = '<div class="text-warning small">Unable to load chart.</div>';
        positionTradeChartTooltip(activeTradeChartAnchor);
    }
}

function formatPercent(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '-';
    }

    return `${value.toFixed(2)}%`;
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

    const sortedEvents = tradeEvents
        .slice()
        .sort((a, b) => (a.id || 0) - (b.id || 0));

    const rows = sortedEvents
        .map((event, index) => {
            const statusBadge = event.eventType === 'open'
                ? '<span class="badge text-bg-success">OPEN</span>'
                : '<span class="badge text-bg-secondary">CLOSED</span>';
            const positionValue = event.position === 'short'
                ? 'SHORT'
                : 'LONG';
            const sideBadge = positionValue === 'SHORT'
                ? '<span class="badge text-bg-warning">SHORT</span>'
                : '<span class="badge text-bg-primary">LONG</span>';
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
            const sourceEvent = chartSourceEvent(sortedEvents, index);
            const chartButton = chartButtonMarkup(event, sourceEvent);

            return `
                <tr>
                    <td class="trade-datetime" title="${formatTradeDateTime(event.timestamp)}">${formatTradeDateTime(event.timestamp)}</td>
                    <td>${statusBadge}</td>
                    <td>
                        <div class="d-inline-flex align-items-center gap-2">
                            <span class="trade-symbol">${event.symbol || '-'}</span>
                            ${chartButton}
                        </div>
                    </td>
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
    const candidateTradeTypeLabel = candidateTradeType.value === 'LONG'
        ? 'Long'
        : candidateTradeType.value === 'SHORT'
            ? 'Short'
            : 'Both';
    const moneyInAccount = getMoneyInAccount();
    const maxRiskPerSession = getMaxRiskPerSession();
    const stopProfitRatio = getStopProfitRatio();
    const mostActiveSymbolLimit = getMostActiveSymbolLimit();
    const breakoutConfirmationCandleMinutes = getBreakoutConfirmationCandleMinutes();
    const breakoutQualityFiltersEnabled = getBreakoutQualityFiltersEnabled();
    const breakoutMinVolumeExpansion = getBreakoutMinVolumeExpansion();
    const breakoutMinRelativeStrengthPct = getBreakoutMinRelativeStrengthPct();
    const breakoutTrendTimeframeMinutes = getBreakoutTrendTimeframeMinutes();
    const breakoutTrendLookbackBars = getBreakoutTrendLookbackBars();

    confirmSessionMode.textContent = session;
    confirmEmulationDate.textContent = emulationDate;
    confirmMostActiveSymbolLimit.textContent = String(mostActiveSymbolLimit);
    confirmContinuousMode.textContent = continuous;
    confirmCandidateTradeType.textContent = candidateTradeTypeLabel;
    confirmMoneyInAccount.textContent = formatCurrency(moneyInAccount);
    confirmMaxRiskPerSession.textContent = formatCurrency(maxRiskPerSession);
    confirmStopProfitRatio.textContent = `1:${stopProfitRatio}`;
    confirmBreakoutConfirmationCandleMinutes.textContent = `${breakoutConfirmationCandleMinutes}m`;
    confirmBreakoutQualityFiltersEnabled.textContent = breakoutQualityFiltersEnabled ? 'Enabled' : 'Disabled';
    confirmBreakoutMinVolumeExpansion.textContent = breakoutMinVolumeExpansion.toFixed(2);
    confirmBreakoutMinRelativeStrengthPct.textContent = `${breakoutMinRelativeStrengthPct.toFixed(2)}%`;
    confirmBreakoutTrendTimeframeMinutes.textContent = `${breakoutTrendTimeframeMinutes}m`;
    confirmBreakoutTrendLookbackBars.textContent = String(breakoutTrendLookbackBars);

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
        latestOrbUiMessage = typeof payload.orbUiMessage === 'string' ? payload.orbUiMessage : '';
        latestRuntimeStatus = typeof payload.runtimeStatus === 'string' ? payload.runtimeStatus : '';
        latestIsRunning = payload.isRunning === true;
        if (payload.realtimeDataFeedError === true || sipProbeUnsupported) {
            realTimeDataFeedError.classList.remove('d-none');
        } else {
            realTimeDataFeedError.classList.add('d-none');
        }
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
    if (typeof payload.candidateTradeType === 'string' && candidateTradeType) {
        candidateTradeType.value = payload.candidateTradeType;
    }
    if (typeof payload.breakoutConfirmationCandleMinutes === 'number') {
        breakoutConfirmationCandleMinutesInput.value = String(payload.breakoutConfirmationCandleMinutes);
    }
    if (typeof payload.mostActiveSymbolLimit === 'number') {
        mostActiveSymbolLimitInput.value = String(payload.mostActiveSymbolLimit);
    }
    if (typeof payload.breakoutQualityFiltersEnabled === 'boolean') {
        breakoutQualityFiltersEnabledInput.checked = payload.breakoutQualityFiltersEnabled;
    }
    if (typeof payload.breakoutMinVolumeExpansion === 'number') {
        breakoutMinVolumeExpansionInput.value = String(payload.breakoutMinVolumeExpansion);
    }
    if (typeof payload.breakoutMinRelativeStrengthPct === 'number') {
        breakoutMinRelativeStrengthPctInput.value = String(payload.breakoutMinRelativeStrengthPct);
    }
    if (typeof payload.breakoutTrendTimeframeMinutes === 'number') {
        breakoutTrendTimeframeMinutesInput.value = String(payload.breakoutTrendTimeframeMinutes);
    }
    if (typeof payload.breakoutTrendLookbackBars === 'number') {
        breakoutTrendLookbackBarsInput.value = String(payload.breakoutTrendLookbackBars);
    }
    applyBreakoutQualityInputsEnabled();
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
        const marketsOpen = areNYMarketsOpen();
        const isContinuous = continuousMode.checked;
        const showMarketClosedMessage = isContinuous && !marketsOpen;

        const response = await fetch('/api/orbilicious/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                continuous: continuousMode.checked,
                realTimeData: realTimeDataFeed.checked,
                sessionMode: sessionMode.value,
                emulationSessionDate: isEmulationMode() ? emulationDateInput.value : undefined,
                mostActiveSymbolLimit: getMostActiveSymbolLimit(),
                candidateTradeType: candidateTradeType.value,
                moneyInAccount: getMoneyInAccount(),
                maxRiskPerSession: getMaxRiskPerSession(),
                stopProfitRewardPart: getStopProfitRatio(),
                breakoutConfirmationCandleMinutes: getBreakoutConfirmationCandleMinutes(),
                breakoutQualityFiltersEnabled: getBreakoutQualityFiltersEnabled(),
                breakoutMinVolumeExpansion: getBreakoutMinVolumeExpansion(),
                breakoutMinRelativeStrengthPct: getBreakoutMinRelativeStrengthPct(),
                breakoutTrendTimeframeMinutes: getBreakoutTrendTimeframeMinutes(),
                breakoutTrendLookbackBars: getBreakoutTrendLookbackBars(),
            }),
        });

        const payload = await readJson(response);

        if (!response.ok) {
            alert(payload.message || 'Failed to start ORBilicious');
            return;
        }

        const statusPayload = await refreshStatus();
        syncDropdownsFromServer(statusPayload);
        await refreshTrades();

        if (showMarketClosedMessage) {
            const infoMsg = document.createElement('div');
            infoMsg.className = 'alert alert-info mt-2';
            infoMsg.textContent = 'Markets are closed. Will start to run continuously once the markets open.';
            const statusContainer = statusBox.parentElement;
            if (statusContainer) {
                statusContainer.insertBefore(infoMsg, statusBox.nextSibling);
                setTimeout(() => infoMsg.remove(), 10000);
            }
        }
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

function liquidityTypeLabel(value) {
    if (value === 'swing-high') return 'Swing High';
    if (value === 'swing-low') return 'Swing Low';
    if (value === 'volume-node') return 'Volume Node';
    return value || '-';
}

function sortedLiquidityZones(payload) {
    if (!payload || !Array.isArray(payload.zones)) {
        return [];
    }

    const mode = liquiditySortMode?.value === 'symbol' ? 'symbol' : 'strength';
    const rows = payload.zones.slice();

    if (mode === 'symbol') {
        rows.sort((left, right) => {
            const symbolSort = String(left.symbol || '').localeCompare(String(right.symbol || ''));
            if (symbolSort !== 0) {
                return symbolSort;
            }

            if (right.strengthScore !== left.strengthScore) {
                return right.strengthScore - left.strengthScore;
            }

            return left.nearestPriceDistancePct - right.nearestPriceDistancePct;
        });
        return rows;
    }

    rows.sort((left, right) => {
        if (right.strengthScore !== left.strengthScore) {
            return right.strengthScore - left.strengthScore;
        }

        return left.nearestPriceDistancePct - right.nearestPriceDistancePct;
    });
    return rows;
}

function renderLiquidityZones(payload) {
    latestLiquidityPayload = payload;

    if (!payload || !Array.isArray(payload.zones) || !payload.zones.length) {
        liquidityZoneBody.innerHTML = '<tr><td colspan="7" class="text-muted">No liquidity zones were found for the selected trading day.</td></tr>';
        liquiditySummary.textContent = 'No qualifying liquidity zones were found.';
        return;
    }

    const maxZonesPerSymbol = typeof payload.maxZonesPerSymbol === 'number' && payload.maxZonesPerSymbol > 0
        ? payload.maxZonesPerSymbol
        : 3;
    liquiditySummary.textContent = `Scanned ${payload.retrievedSymbols} most-active symbols for ${payload.sessionDate}. ${payload.scannedSymbols} symbols produced zones. Showing ${payload.zones.length} ranked zones (up to ${maxZonesPerSymbol} per symbol).`;

    const zones = sortedLiquidityZones(payload);

    liquidityZoneBody.innerHTML = zones
        .map((zone) => {
            const lastTouch = zone.lastTouchedAt ? formatTradeDateTime(zone.lastTouchedAt) : '-';
            return `
                <tr>
                    <td><span class="trade-symbol">${zone.symbol}</span></td>
                    <td class="trade-price">${formatPrice(zone.zoneLow)} - ${formatPrice(zone.zoneHigh)}</td>
                    <td>${liquidityTypeLabel(zone.zoneType)}</td>
                    <td class="trade-price">${zone.strengthScore.toFixed(1)}</td>
                    <td class="trade-price">${zone.touchCount}</td>
                    <td class="trade-price">${formatPercent(zone.nearestPriceDistancePct)}</td>
                    <td>${lastTouch}</td>
                </tr>`;
        })
        .join('');
}

async function generateLiquidityZones() {
    const sessionDate = liquiditySessionDateInput.value;
    const limitValue = Number(liquiditySymbolLimitInput.value || 20);
    const limit = Number.isFinite(limitValue) && limitValue > 0 ? Math.min(Math.floor(limitValue), 50) : 20;

    if (!sessionDate) {
        alert('Select a trading day first.');
        return;
    }

    liquidityScanBtn.disabled = true;
    liquidityScanStatus.textContent = 'Scanning most-active symbols for liquidity zones...';

    try {
        const query = new URLSearchParams({
            sessionDate,
            limit: String(limit),
        });
        const response = await fetch(`/api/liquidity-zones?${query.toString()}`);
        const payload = await readJson(response);

        if (!response.ok) {
            liquidityScanStatus.textContent = payload.message || 'Liquidity scan failed.';
            alert(payload.message || 'Failed to scan liquidity zones');
            return;
        }

        renderLiquidityZones(payload);
        liquidityScanStatus.textContent = `Liquidity scan completed at ${new Date().toLocaleTimeString()}.`;
    } catch (error) {
        liquidityScanStatus.textContent = 'Liquidity scan failed.';
        alert(`Failed to scan liquidity zones: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        liquidityScanBtn.disabled = false;
    }
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

function activateTopTab(targetId) {
    for (const button of topTabButtons) {
        const isActive = button.getAttribute('data-tab-target') === targetId;
        button.classList.toggle('active', isActive);
        button.setAttribute('aria-selected', isActive ? 'true' : 'false');
        button.setAttribute('tabindex', isActive ? '0' : '-1');
    }

    for (const panel of topTabPanels) {
        const isActive = panel.id === targetId;
        panel.classList.toggle('active', isActive);
        panel.hidden = !isActive;
    }
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

function getMostActiveSymbolLimit() {
    return Math.floor(clampNumber(mostActiveSymbolLimitInput.value, 40, 1, 200));
}

function getBreakoutConfirmationCandleMinutes() {
    return Math.floor(clampNumber(breakoutConfirmationCandleMinutesInput.value, 5, 1, 30));
}

function getBreakoutQualityFiltersEnabled() {
    return breakoutQualityFiltersEnabledInput.checked === true;
}

function getBreakoutMinVolumeExpansion() {
    return clampNumber(breakoutMinVolumeExpansionInput.value, 1.2, 0.5, 10);
}

function getBreakoutMinRelativeStrengthPct() {
    return clampNumber(breakoutMinRelativeStrengthPctInput.value, 0.25, 0, 5);
}

function getBreakoutTrendTimeframeMinutes() {
    return Math.floor(clampNumber(breakoutTrendTimeframeMinutesInput.value, 5, 1, 60));
}

function getBreakoutTrendLookbackBars() {
    return Math.floor(clampNumber(breakoutTrendLookbackBarsInput.value, 3, 2, 20));
}

function applyBreakoutQualityInputsEnabled() {
    const enabled = getBreakoutQualityFiltersEnabled();
    breakoutConfirmationCandleMinutesInput.disabled = !enabled;
    breakoutMinVolumeExpansionInput.disabled = !enabled;
    breakoutMinRelativeStrengthPctInput.disabled = !enabled;
    breakoutTrendTimeframeMinutesInput.disabled = !enabled;
    breakoutTrendLookbackBarsInput.disabled = !enabled;
}

function updateBrowserLocalTime() {
    if (!browserLocalTime) {
        return;
    }

    const now = new Date();
    const formatted = now.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short',
    });

    browserLocalTime.textContent = `Local time: ${formatted}`;
}

document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;

    const chartButton = target.closest('.trade-chart-trigger');
    if (chartButton instanceof HTMLElement) {
        openTradeChartTooltip(chartButton);
        return;
    }

    const helpButton = target.closest('[data-help-key]');
    if (helpButton) {
        const key = helpButton.getAttribute('data-help-key');
        if (key) {
            openFieldHelp(key, helpButton);
        }
        return;
    }

    if (fieldHelpPopover && !fieldHelpPopover.classList.contains('d-none') && !target.closest('#fieldHelpPopover')) {
        closeFieldHelp();
    }

    if (tradeChartTooltip && !tradeChartTooltip.classList.contains('d-none') && !target.closest('#tradeChartTooltip')) {
        closeTradeChartTooltip();
    }
});

if (closeFieldHelpBtn) {
    closeFieldHelpBtn.addEventListener('click', closeFieldHelp);
}

if (closeTradeChartTooltipBtn) {
    closeTradeChartTooltipBtn.addEventListener('click', closeTradeChartTooltip);
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeFieldHelp();
        closeTradeChartTooltip();
    }
});

window.addEventListener('resize', () => {
    if (!fieldHelpPopover || fieldHelpPopover.classList.contains('d-none') || !activeFieldHelpAnchor) {
        if (tradeChartTooltip && !tradeChartTooltip.classList.contains('d-none') && activeTradeChartAnchor) {
            positionTradeChartTooltip(activeTradeChartAnchor);
        }
        return;
    }

    positionFieldHelpPopover(activeFieldHelpAnchor);
    if (tradeChartTooltip && !tradeChartTooltip.classList.contains('d-none') && activeTradeChartAnchor) {
        positionTradeChartTooltip(activeTradeChartAnchor);
    }
});

window.addEventListener('scroll', () => {
    if (!fieldHelpPopover || fieldHelpPopover.classList.contains('d-none') || !activeFieldHelpAnchor) {
        if (tradeChartTooltip && !tradeChartTooltip.classList.contains('d-none') && activeTradeChartAnchor) {
            positionTradeChartTooltip(activeTradeChartAnchor);
        }
        return;
    }

    positionFieldHelpPopover(activeFieldHelpAnchor);
    if (tradeChartTooltip && !tradeChartTooltip.classList.contains('d-none') && activeTradeChartAnchor) {
        positionTradeChartTooltip(activeTradeChartAnchor);
    }
}, true);

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
liquidityScanBtn.addEventListener('click', generateLiquidityZones);
liquiditySortMode.addEventListener('change', () => {
    if (latestLiquidityPayload) {
        renderLiquidityZones(latestLiquidityPayload);
    }
});
sessionMode.addEventListener('change', syncEmulationControls);
emulationDateInput.addEventListener('change', syncEmulationControls);
continuousMode.addEventListener('change', syncEmulationControls);
breakoutQualityFiltersEnabledInput.addEventListener('change', applyBreakoutQualityInputsEnabled);

realTimeDataFeed.addEventListener('change', async () => {
    if (!realTimeDataFeed.checked) {
        sipProbeUnsupported = false;
        realTimeDataFeedError.classList.add('d-none');
        return;
    }

    sipProbeUnsupported = true;
    realTimeDataFeedError.classList.remove('d-none');

    try {
        const res = await fetch('/api/alpaca/check-sip');
        const payload = await res.json();
        sipProbeUnsupported = payload.supported !== true;
    } catch {
        sipProbeUnsupported = true;
    }
    if (sipProbeUnsupported) {
        realTimeDataFeedError.classList.remove('d-none');
    } else {
        realTimeDataFeedError.classList.add('d-none');
    }
});

for (const button of paneExpandButtons) {
    button.addEventListener('click', () => togglePaneExpansion(button));
}

for (const button of topTabButtons) {
    button.addEventListener('click', () => {
        const targetId = button.getAttribute('data-tab-target');
        if (targetId) {
            activateTopTab(targetId);
        }
    });
}

const today = todayIsoDate();
candidateTradeType.value = 'LONG_AND_SHORT';
emulationDateInput.value = today;
emulationDateInput.max = today;
reportAnchorDateInput.value = today;
liquiditySessionDateInput.value = today;
liquiditySessionDateInput.max = today;
syncEmulationControls();
initializeAccountAndRiskSpinners();
applyBreakoutQualityInputsEnabled();
activateTopTab('dashboardTab');

refreshStatus().then((payload) => {
    syncDropdownsFromServer(payload);
});
refreshTrades();
updateBrowserLocalTime();
window.setInterval(refreshStatus, 3000);
window.setInterval(refreshTrades, 1500);
window.setInterval(updateBrowserLocalTime, 1000);
