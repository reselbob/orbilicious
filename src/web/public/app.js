// Optimal/max-profit settings for breakout confirmation and quality filters
const MAX_PROFIT_FILTERS = {
    breakoutConfirmationCandleMinutes: 5,
    breakoutQualityFiltersEnabled: true,
    breakoutMinVolumeExpansion: 1.1,
    breakoutMinRelativeStrengthPct: 0.15,
    breakoutTrendTimeframeMinutes: 5,
    breakoutTrendLookbackBars: 3,
    atrStopMultiple: 1,
    minStopPct: 0.75,
    maxRiskPctPerSymbol: 20,
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
            if (typeof filters.atrStopMultiple === 'number') {
                atrStopMultipleInput.value = String(filters.atrStopMultiple);
            }
            if (typeof filters.minStopPct === 'number') {
                minStopPctInput.value = String(filters.minStopPct);
            }
            if (typeof filters.maxRiskPctPerSymbol === 'number') {
                maxRiskPctPerSymbolInput.value = String(filters.maxRiskPctPerSymbol);
            }
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
            atrStopMultipleInput.value = String(MAX_PROFIT_FILTERS.atrStopMultiple);
            minStopPctInput.value = String(MAX_PROFIT_FILTERS.minStopPct);
            maxRiskPctPerSymbolInput.value = String(MAX_PROFIT_FILTERS.maxRiskPctPerSymbol);
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
const reportDownloadFormat = document.getElementById('reportDownloadFormat');
const downloadReportBtn = document.getElementById('downloadReportBtn');
const liquiditySessionDateInput = document.getElementById('liquiditySessionDate');
const liquiditySymbolLimitInput = document.getElementById('liquiditySymbolLimit');
const liquidityScanBtn = document.getElementById('liquidityScanBtn');
const liquidityScanStatus = document.getElementById('liquidityScanStatus');
const liquiditySummary = document.getElementById('liquiditySummary');
const liquiditySortMode = document.getElementById('liquiditySortMode');
const liquidityZoneBody = document.getElementById('liquidityZoneBody');
const liquidityChartModal = document.getElementById('liquidityChartModal');
const liquidityChartTitle = document.getElementById('liquidityChartTitle');
const liquidityChartBody = document.getElementById('liquidityChartBody');
const closeLiquidityChartModalBtn = document.getElementById('closeLiquidityChartModalBtn');
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
const currentBalanceDisplay = document.getElementById('currentBalanceDisplay');
const stopProfitRatioSpinner = document.getElementById('stopProfitRatio');
const breakoutConfirmationCandleMinutesInput = document.getElementById('breakoutConfirmationCandleMinutes');
const breakoutQualityFiltersEnabledInput = document.getElementById('breakoutQualityFiltersEnabled');
const breakoutMinVolumeExpansionInput = document.getElementById('breakoutMinVolumeExpansion');
const breakoutMinRelativeStrengthPctInput = document.getElementById('breakoutMinRelativeStrengthPct');
const breakoutTrendTimeframeMinutesInput = document.getElementById('breakoutTrendTimeframeMinutes');
const breakoutTrendLookbackBarsInput = document.getElementById('breakoutTrendLookbackBars');
const atrStopMultipleInput = document.getElementById('atrStopMultiple');
const minStopPctInput = document.getElementById('minStopPct');
const maxRiskPctPerSymbolInput = document.getElementById('maxRiskPctPerSymbol');
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
const confirmAtrStopMultiple = document.getElementById('confirmAtrStopMultiple');
const confirmMinStopPct = document.getElementById('confirmMinStopPct');
const confirmMaxRiskPctPerSymbol = document.getElementById('confirmMaxRiskPctPerSymbol');
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
let activeReportType = '';
let activeReportAnchorDate = '';
let latestOrbUiMessage = '';
let latestRuntimeStatus = '';
let latestIsRunning = false;
let latestLiquidityPayload = null;
let activeLiquidityRowIndex = -1;
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
        text: 'EMULATION runs dry-run strategy logic (historical or live-style, depending on date/time) without placing real orders. REPLAY loads a completed session from a prior trading day and displays its trades. Replay is not available for the current day while NY markets are open — wait until after market close. PAPER submits orders to your Alpaca paper account. LIVE uses your live Alpaca account and real orders.',
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
        text: 'When enabled, ORBilicious stays active and waits for the next market conditions instead of ending immediately after one pass. In emulation it is useful for live-style replay behavior. OFF = selected date only | ON = selected date through today.',
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
    atrStopMultiple: {
        title: 'ATR Stop Multiple',
        subtitle: 'Multiplier applied to ATR(1m) to set stop-loss distance.',
        text: 'Higher values (e.g. 2.0) give trades more room to breathe through intraday noise but risk larger losses. Lower values (e.g. 1.0) are tighter but prone to stop-outs on normal volatility.',
    },
    minStopPct: {
        title: 'Minimum Stop Percentage',
        subtitle: 'Hard floor on stop-loss distance as a percentage of entry price.',
        text: 'Ensures the stop is never placed too tight regardless of ATR. E.g., 1.5% means the stop is at least 1.5% away from entry. Higher values reduce stop-outs but increase per-trade risk.',
    },
    maxRiskPctPerSymbol: {
        title: 'Maximum % of Max Risk per Trading Day',
        subtitle: 'Per-symbol cap on risk allocation.',
        text: 'Limits how much of the daily risk budget any single position can consume. Default 20% caps any single position at 20% of the daily budget (e.g., $200 of a $1000 budget). Set higher (e.g., 200%) to effectively disable the cap for concentrated bets on high-scoring breakouts.',
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

function isBeforeNyMarketOpen() {
    const now = new Date();
    const nyTime = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const dayOfWeek = nyTime.getDay();
    // Markets closed on weekends (0 = Sunday, 6 = Saturday)
    if (dayOfWeek === 0 || dayOfWeek === 6) {
        return false;
    }
    const hours = nyTime.getHours();
    const minutes = nyTime.getMinutes();
    const currentMinutes = hours * 60 + minutes;
    const marketOpenMinutes = 9 * 60 + 30;  // 9:30 AM = 570 minutes
    return currentMinutes < marketOpenMinutes;
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

function isReplayMode() {
    return sessionMode.value === 'REPLAY';
}

function isDateBasedHistoricalMode() {
    return isEmulationMode() || isReplayMode();
}

function isLiveEmulation() {
    if (!isEmulationMode()) return false;
    const emulationDate = emulationDateInput.value;
    if (!emulationDate) return false;
    const today = todayIsoDate();
    if (emulationDate !== today) return false;
    return true;
}

function syncEmulationControls() {
    const isHistoricalMode = isDateBasedHistoricalMode();
    emulationDateGroup.classList.toggle('d-none', !isHistoricalMode);

    const isReplay = isReplayMode();
    const isLiveEmu = isLiveEmulation();
    const isHistoricalEmu = isHistoricalMode && !isReplay && !isLiveEmu;
    const isRunningHistorical = isHistoricalEmu && latestIsRunning;
    const isContinuous = continuousMode.checked;
    const hasOrbUiMessage = typeof latestOrbUiMessage === 'string' && latestOrbUiMessage.trim() !== '';
    const isWaitingForMarketOpen = latestRuntimeStatus === 'Waiting for market open';
    const shouldShowWarning = isReplay || isLiveEmu || isRunningHistorical || (isHistoricalMode && hasOrbUiMessage) || isWaitingForMarketOpen;
    liveEmulationWarning.classList.toggle('d-none', !shouldShowWarning);

    if (isReplay) {
        liveEmulationWarningText.textContent = 'Replay mode runs a historical session replay for the selected date.';
    } else if (isWaitingForMarketOpen) {
        liveEmulationWarningText.textContent = 'Waiting for markets to open.';
    } else if (isHistoricalMode && hasOrbUiMessage) {
        liveEmulationWarningText.textContent = latestOrbUiMessage;
    } else if (isRunningHistorical) {
        liveEmulationWarningText.textContent = 'Running against historic data.';
    } else if (isLiveEmu && !hasOrbUiMessage) {
        const marketsOpen = areNYMarketsOpen();
        if (marketsOpen) {
            liveEmulationWarningText.textContent = isContinuous
                ? 'Emulation is running live and in continuous mode, but no trades will actually be executed against your account.'
                : 'Emulation is running live. No trades will actually be executed against your account.';
        } else {
            liveEmulationWarningText.textContent = isContinuous
                ? 'Emulation is running live and in continuous mode, but no trades will be executed until the NY Markets open.'
                : 'NY Markets are closed. ORBilicious will get Most Active Stocks and discover Breakout Candidates once the NY Markets open.';
        }
    } else if (isLiveEmu && !hasOrbUiMessage) {
        const marketsOpen = areNYMarketsOpen();
        if (marketsOpen) {
            liveEmulationWarningText.textContent = 'Emulation is running live, but no trades will actually be executed against your account.';
        } else {
            liveEmulationWarningText.textContent = 'Emulation is running live, but no trades will be executed until the NY Markets open.';
        }
    }

    continuousMode.disabled = isReplay;
    if (isReplay) {
        continuousMode.checked = false;
    }
}

function formatPrice(value) {
    if (typeof value !== 'number' || Number.isNaN(value)) {
        return '-';
    }
    return value.toFixed(2);
}

function formatQty(value) {
    if (typeof value !== 'number' || Number.isNaN(value) || value <= 0) {
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

function resolveClosedTradePnl(rowEvent, sourceEvent) {
    if (!rowEvent || rowEvent.eventType !== 'close') {
        return null;
    }

    if (typeof rowEvent.pnl === 'number' && Number.isFinite(rowEvent.pnl)) {
        return rowEvent.pnl;
    }

    const entryPrice = typeof rowEvent.entryPrice === 'number'
        ? rowEvent.entryPrice
        : (sourceEvent && typeof sourceEvent.entryPrice === 'number' ? sourceEvent.entryPrice : null);
    const closePrice = typeof rowEvent.closePrice === 'number'
        ? rowEvent.closePrice
        : null;
    if (entryPrice === null || closePrice === null) {
        return null;
    }

    const qty = typeof rowEvent.qty === 'number' && Number.isFinite(rowEvent.qty) && rowEvent.qty > 0
        ? rowEvent.qty
        : (sourceEvent && typeof sourceEvent.qty === 'number' && sourceEvent.qty > 0 ? sourceEvent.qty : 1);
    const position = rowEvent.position || (sourceEvent && sourceEvent.position) || 'long';

    return position === 'short'
        ? (entryPrice - closePrice) * qty
        : (closePrice - entryPrice) * qty;
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

function dateFromIsoParts(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) {
        return null;
    }

    const [year, month, day] = value.split('-').map((part) => Number(part));
    const date = new Date(Date.UTC(year, month - 1, day));
    if (Number.isNaN(date.getTime())) {
        return null;
    }

    return date;
}

function isoFromUtcDate(date) {
    const year = String(date.getUTCFullYear()).padStart(4, '0');
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function weekdayRangeInclusive(startIso, endIso) {
    const start = dateFromIsoParts(startIso);
    const end = dateFromIsoParts(endIso);
    if (!start || !end || start.getTime() > end.getTime()) {
        return [];
    }

    const rows = [];
    for (const current = new Date(start); current.getTime() <= end.getTime(); current.setUTCDate(current.getUTCDate() + 1)) {
        const dayOfWeek = current.getUTCDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
            continue;
        }
        rows.push(isoFromUtcDate(current));
    }

    return rows;
}

function renderDailySummary() {
    const dailyTotals = new Map();
    const dailyClosedCounts = new Map();
    const dailyOpenEvents = new Map();
    const openEventsByKey = new Map();
    const dailyUniqueSymbols = new Map();
    const isReplay = isReplayMode();

    for (const event of tradeEvents) {
        const sessionDate = eventSessionDate(event);
        if (!sessionDate || !event.symbol) {
            continue;
        }

        if (!dailyUniqueSymbols.has(sessionDate)) {
            dailyUniqueSymbols.set(sessionDate, new Set());
        }
        dailyUniqueSymbols.get(sessionDate).add(event.symbol);

        const key = `${sessionDate}|${event.symbol}`;

        if (event.eventType === 'open') {
            openEventsByKey.set(key, event);
            dailyOpenEvents.set(sessionDate, (dailyOpenEvents.get(sessionDate) || 0) + 1);
            continue;
        }

        if (isReplay) {
            const sourceEvent = openEventsByKey.get(key) || null;
            const pnlValue = resolveClosedTradePnl(event, sourceEvent);
            if (typeof pnlValue !== 'number' || Number.isNaN(pnlValue)) {
                continue;
            }

            const previous = dailyTotals.get(sessionDate) || 0;
            dailyTotals.set(sessionDate, previous + pnlValue);
            dailyClosedCounts.set(sessionDate, (dailyClosedCounts.get(sessionDate) || 0) + 1);
            continue;
        }

        if (typeof event.pnl !== 'number' || Number.isNaN(event.pnl)) {
            continue;
        }

        const previous = dailyTotals.get(sessionDate) || 0;
        dailyTotals.set(sessionDate, previous + event.pnl);
        dailyClosedCounts.set(sessionDate, (dailyClosedCounts.get(sessionDate) || 0) + 1);
    }

    const grandTotalPnl = Array.from(dailyTotals.values()).reduce((sum, value) => sum + value, 0);
    const summaryClass = grandTotalPnl > 0 ? 'result-profit' : grandTotalPnl < 0 ? 'result-loss' : 'result-open';
    dailySummaryHeaderValue.classList.remove('result-profit', 'result-loss', 'result-open');
    dailySummaryHeaderValue.classList.add(summaryClass);
    dailySummaryHeaderValue.textContent = formatPnl(grandTotalPnl);

    const allSessionDates = new Set(dailyTotals.keys());

    if (latestBacktestProgress
        && typeof latestBacktestProgress.startSessionDate === 'string'
        && typeof latestBacktestProgress.endSessionDate === 'string') {
        const backtestDates = weekdayRangeInclusive(
            latestBacktestProgress.startSessionDate,
            latestBacktestProgress.endSessionDate,
        );
        for (const date of backtestDates) {
            allSessionDates.add(date);
        }
    }

    for (const event of tradeEvents) {
        const sessionDate = eventSessionDate(event);
        if (sessionDate) {
            allSessionDates.add(sessionDate);
        }
    }

    if (!allSessionDates.size) {
        dailySummaryBody.innerHTML = '<tr><td colspan="5" class="text-muted">No closed trades yet.</td></tr>';
        return;
    }

    const rows = Array.from(allSessionDates.values())
        .sort((a, b) => a.localeCompare(b))
        .map((date) => {
            const pnl = dailyTotals.get(date) || 0;
            const closed = dailyClosedCounts.get(date) || 0;
            const opened = dailyOpenEvents.get(date) || 0;
            const openTrades = Math.max(0, opened - closed);
            const candidates = dailyUniqueSymbols.has(date) ? dailyUniqueSymbols.get(date).size : 0;
            const pnlClass = pnl > 0 ? 'result-profit' : pnl < 0 ? 'result-loss' : 'result-open';
            const noTradeBadge = pnl === 0
                ? '<span class="badge text-bg-secondary daily-summary-flat-badge">NO TRADES</span>'
                : '';
            return `
                <tr>
                    <td>${date}</td>
                    <td class="text-end">${candidates}</td>
                    <td class="text-end">${closed}</td>
                    <td class="text-end">${openTrades}</td>
                    <td class="text-end trade-price ${pnlClass}">${formatPnl(pnl)}${noTradeBadge}</td>
                </tr>`;
        })
        .join('');

    dailySummaryBody.innerHTML = rows;
}

function renderTrades() {
    if (!tradeEvents.length) {
        tradeMonitorBody.innerHTML = '<tr><td colspan="11" class="text-muted">No entries or closes have been recorded yet.</td></tr>';
        renderDailySummary();
        return;
    }

    const isReplay = isReplayMode();
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
            const stopPct = event.eventType === 'open' && typeof event.stopLossPct === 'number'
                ? (event.stopLossPct * 100).toFixed(2) + '%'
                : '-';
            const riskAmt = event.eventType === 'open' && typeof event.stopLossPct === 'number' && typeof event.entryPrice === 'number' && typeof event.qty === 'number'
                ? '$' + (event.stopLossPct * event.entryPrice * event.qty).toFixed(2)
                : '-';
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
            const sourceEvent = chartSourceEvent(sortedEvents, index);
            const pnl = event.eventType === 'close'
                ? (isReplay
                    ? (() => {
                        const pnlValue = resolveClosedTradePnl(event, sourceEvent);
                        return typeof pnlValue === 'number' ? formatPnl(pnlValue) : 'Open';
                    })()
                    : formatPnl(event.pnl))
                : 'Open';
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
                    <td class="trade-price">${stopPct}</td>
                    <td class="trade-price">${riskAmt}</td>
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
    const isHistoricalMode = session === 'EMULATION' || session === 'REPLAY';
    const emulationDate = isHistoricalMode && emulationDateInput.value ? emulationDateInput.value : 'N/A';
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
    const atrStopMultiple = getAtrStopMultiple();
    const minStopPct = getMinStopPct();
    const maxRiskPctPerSymbol = getMaxRiskPctPerSymbol();

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
    confirmAtrStopMultiple.textContent = String(atrStopMultiple);
    confirmMinStopPct.textContent = `${minStopPct.toFixed(2)}%`;
    confirmMaxRiskPctPerSymbol.textContent = `${maxRiskPctPerSymbol}%`;

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
        if (typeof payload.currentBalance === 'number') {
            currentBalanceDisplay.textContent = `$${payload.currentBalance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
        } else {
            currentBalanceDisplay.textContent = '--';
        }
        latestOrbUiMessage = typeof payload.orbUiMessage === 'string' ? payload.orbUiMessage : '';
        latestRuntimeStatus = typeof payload.runtimeStatus === 'string' ? payload.runtimeStatus : '';
        latestIsRunning = payload.isRunning === true;
        if (payload.realtimeDataFeedError === true || sipProbeUnsupported) {
            realTimeDataFeedError.classList.remove('d-none');
        } else {
            realTimeDataFeedError.classList.add('d-none');
        }
        if (payload.realtimeFeedEnabled === true && !realTimeDataFeed.checked) {
            realTimeDataFeed.checked = true;
            try {
                await fetch('/api/alpaca/set-realtime-feed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ realtimeFeed: true }),
                });
            } catch {
            }
        }
        if (payload.initialRealtimeFeedEnabled === true && !realTimeDataFeed.checked) {
            realTimeDataFeed.checked = true;
            try {
                await fetch('/api/alpaca/set-realtime-feed', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ realtimeFeed: true }),
                });
            } catch {
            }
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
    if (typeof payload.atrStopMultiple === 'number') {
        atrStopMultipleInput.value = String(payload.atrStopMultiple);
    }
    if (typeof payload.minStopPct === 'number') {
        minStopPctInput.value = String(payload.minStopPct);
    }
    if (typeof payload.maxRiskPctPerSymbol === 'number') {
        maxRiskPctPerSymbolInput.value = String(payload.maxRiskPctPerSymbol);
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
        if (isReplayMode() && emulationDateInput.value === todayIsoDate() && areNYMarketsOpen()) {
            alert("Replays for the current day will run when today's NY Market's close.");
            return;
        }

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
                emulationSessionDate: isDateBasedHistoricalMode() ? emulationDateInput.value : undefined,
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
                atrStopMultiple: getAtrStopMultiple(),
                minStopPct: getMinStopPct(),
                maxRiskPctPerSymbol: getMaxRiskPctPerSymbol(),
            }),
        });

        const payload = await readJson(response);

        if (!response.ok) {
            alert(payload.message || 'Failed to start ORBilicious');
            return;
        }

        tradeCursor = 0;
        tradeEvents = [];
        renderTrades();

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
        const reportPath = report?.viewRelativePath;
        if (!report || !reportPath) {
            alert('Report generated, but response was missing file paths.');
            return;
        }

        activeTopLevelReportSrc = reportPath;
        activeReportType = reportType;
        activeReportAnchorDate = anchorDate;
        if (downloadReportBtn) {
            downloadReportBtn.disabled = false;
        }
        reportFrame.src = activeTopLevelReportSrc;
    } catch (error) {
        alert(`Failed to generate report: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        reportGenerationStatus.classList.add('d-none');
        generateReportBtn.disabled = false;
    }
}

async function downloadSelectedReport() {
    if (!activeReportType || !activeReportAnchorDate) {
        alert('Generate a report before downloading.');
        return;
    }

    const format = reportDownloadFormat && reportDownloadFormat.value === 'pdf' ? 'pdf' : 'html';
    if (downloadReportBtn) {
        downloadReportBtn.disabled = true;
    }

    try {
        const response = await fetch('/api/reports/download', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                reportType: activeReportType,
                anchorDate: activeReportAnchorDate,
                format,
            }),
        });
        const payload = await readJson(response);
        if (!response.ok) {
            alert(payload.message || 'Failed to download report');
            return;
        }

        if (!payload.downloadUrl) {
            alert('Download path was not returned by the server.');
            return;
        }

        window.location.href = payload.downloadUrl;
    } catch (error) {
        alert(`Failed to download report: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
        if (downloadReportBtn) {
            downloadReportBtn.disabled = false;
        }
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

function liquidityTypeColor(zoneType) {
    if (zoneType === 'swing-high') return '#f97316';
    if (zoneType === 'swing-low') return '#22c55e';
    return '#38bdf8';
}

function closeLiquidityChartModal() {
    if (!liquidityChartModal) return;
    liquidityChartModal.classList.add('d-none');
    if (liquidityChartBody) {
        liquidityChartBody.innerHTML = '';
    }
}

function formatLiquidityChartTimeLabel(timestamp) {
    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(new Date(timestamp));
    } catch {
        return '';
    }
}

function renderLiquidityLegendHtml() {
    return `<div class="liquidity-chart-modal-legend">
        <div class="fw-semibold mb-2">Legend</div>
        <div class="liquidity-legend-item"><span class="liquidity-legend-line liquidity-legend-line-latest"></span><span>Dotted yellow line: latest price</span></div>
        <div class="liquidity-legend-item"><span class="liquidity-legend-line liquidity-legend-line-zone"></span><span>Dotted colored line: zone reference price</span></div>
        <div class="liquidity-legend-item"><span class="liquidity-legend-swatch liquidity-legend-swatch-high"></span><span>Orange zone: swing high</span></div>
        <div class="liquidity-legend-item"><span class="liquidity-legend-swatch liquidity-legend-swatch-low"></span><span>Green zone: swing low</span></div>
        <div class="liquidity-legend-item"><span class="liquidity-legend-swatch liquidity-legend-swatch-volume"></span><span>Blue zone: volume node</span></div>
        <div class="liquidity-legend-item"><span class="liquidity-legend-line liquidity-legend-line-candle-up"></span><span>Green candle: close above open</span></div>
        <div class="liquidity-legend-item"><span class="liquidity-legend-line liquidity-legend-line-candle-down"></span><span>Red candle: close below open</span></div>
    </div>`;
}

function renderLiquidityZoneChartSvg(symbol, sessionDate, zones, selectedZone, chartBars) {
    if (!Array.isArray(zones) || !zones.length) {
        return '<div class="small text-light">No zone data available for chart.</div>';
    }

    const latestPrice = zones[0]?.latestPrice;
    const values = [];
    for (const zone of zones) {
        if (typeof zone.zoneLow === 'number') values.push(zone.zoneLow);
        if (typeof zone.zoneHigh === 'number') values.push(zone.zoneHigh);
        if (typeof zone.referencePrice === 'number') values.push(zone.referencePrice);
    }
    if (typeof latestPrice === 'number') values.push(latestPrice);

    const bars = Array.isArray(chartBars)
        ? chartBars
            .map((bar) => {
                const timeMs = new Date(bar.timestamp).getTime();
                const open = Number(bar.open);
                const high = Number(bar.high);
                const low = Number(bar.low);
                const close = Number(bar.close);
                if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
                    return null;
                }
                values.push(open);
                values.push(high);
                values.push(low);
                values.push(close);
                return {
                    timestamp: bar.timestamp,
                    timeMs,
                    open,
                    high,
                    low,
                    close,
                };
            })
            .filter((bar) => bar !== null)
            .sort((left, right) => left.timeMs - right.timeMs)
        : [];

    const minPrice = Math.min(...values);
    const maxPrice = Math.max(...values);
    const pad = Math.max((maxPrice - minPrice) * 0.12, 0.08);
    const yMin = Math.max(0, minPrice - pad);
    const yMax = maxPrice + pad;
    const range = Math.max(0.0001, yMax - yMin);

    const width = 860;
    const height = 520;
    const margin = { top: 26, right: 20, bottom: 58, left: 86 };
    const plotW = width - margin.left - margin.right;
    const plotH = height - margin.top - margin.bottom;
    const zoneBandW = plotW;
    const zoneStartX = margin.left;
    const zoneEndX = zoneStartX + zoneBandW;

    const yFor = (price) => margin.top + ((yMax - price) / range) * plotH;
    const minTimeMs = bars.length ? bars[0].timeMs : 0;
    const maxTimeMs = bars.length ? bars[bars.length - 1].timeMs : 1;
    const timeRangeMs = Math.max(1, maxTimeMs - minTimeMs);
    const xForTime = (timeMs) => margin.left + ((timeMs - minTimeMs) / timeRangeMs) * plotW;
    const ticks = Array.from({ length: 6 }, (_, index) => {
        const value = yMin + (range * index) / 5;
        return { value, y: yFor(value) };
    });
    const timeTicks = bars.length
        ? Array.from({ length: 6 }, (_, index) => {
            const ratio = index / 5;
            const timeMs = minTimeMs + (timeRangeMs * ratio);
            return {
                x: margin.left + (plotW * ratio),
                label: formatLiquidityChartTimeLabel(timeMs),
            };
        })
        : [];

    const rows = zones
        .slice()
        .sort((a, b) => b.strengthScore - a.strengthScore)
        .map((zone) => {
            const yTop = yFor(zone.zoneHigh);
            const yBottom = yFor(zone.zoneLow);
            const rectY = Math.min(yTop, yBottom);
            const rectH = Math.max(2, Math.abs(yBottom - yTop));
            const selected =
                selectedZone
                && zone.symbol === selectedZone.symbol
                && zone.zoneLow === selectedZone.zoneLow
                && zone.zoneHigh === selectedZone.zoneHigh
                && zone.zoneType === selectedZone.zoneType;
            const color = liquidityTypeColor(zone.zoneType);
            const stroke = selected ? '#f8fafc' : '#1e293b';
            const strokeWidth = selected ? 2.2 : 1.2;
            const refY = yFor(zone.referencePrice);
            return `<g>
                <rect x="${zoneStartX}" y="${rectY}" width="${zoneBandW}" height="${rectH}" fill="${color}" fill-opacity="0.35" stroke="${stroke}" stroke-width="${strokeWidth}" />
                <line x1="${zoneStartX}" y1="${refY}" x2="${zoneEndX}" y2="${refY}" stroke="${color}" stroke-width="1.2" stroke-dasharray="3 3" />
            </g>`;
        })
        .join('');

    const candleSlotWidth = bars.length ? (plotW / bars.length) : plotW;
    const candleBodyWidth = Math.max(2, Math.min(10, candleSlotWidth * 0.65));
    const candlesticks = bars
        .map((bar) => {
            const x = xForTime(bar.timeMs);
            const yOpen = yFor(bar.open);
            const yClose = yFor(bar.close);
            const yHigh = yFor(bar.high);
            const yLow = yFor(bar.low);
            const bullish = bar.close >= bar.open;
            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(1.2, Math.abs(yClose - yOpen));
            const color = bullish ? '#22c55e' : '#ef4444';
            return `<g>
                <line x1="${x}" y1="${yHigh}" x2="${x}" y2="${yLow}" stroke="${color}" stroke-width="1" />
                <rect x="${x - (candleBodyWidth / 2)}" y="${bodyTop}" width="${candleBodyWidth}" height="${bodyHeight}" fill="${color}" fill-opacity="0.9" stroke="${color}" stroke-width="1" />
            </g>`;
        })
        .join('');

    const latestPriceLine = typeof latestPrice === 'number'
        ? (() => {
            const y = yFor(latestPrice);
            return `<g>
                <line x1="${margin.left}" y1="${y}" x2="${margin.left + plotW}" y2="${y}" stroke="#facc15" stroke-width="1.4" stroke-dasharray="6 3" />
                <text x="${margin.left + 4}" y="${y - 6}" fill="#fde68a" font-size="11">Latest ${latestPrice.toFixed(2)}</text>
            </g>`;
        })()
        : '';

    return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Liquidity zone chart for ${symbol} on ${sessionDate}">
        <rect x="0" y="0" width="${width}" height="${height}" fill="#0b1220" rx="8" />
        <text x="${margin.left}" y="18" fill="#e2e8f0" font-size="14" font-weight="700">${symbol} Liquidity Zones - ${sessionDate}</text>
        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${margin.top + plotH}" stroke="#475569" />
        <line x1="${margin.left}" y1="${margin.top + plotH}" x2="${margin.left + plotW}" y2="${margin.top + plotH}" stroke="#475569" />
        <text x="${margin.left - 64}" y="${margin.top - 8}" fill="#cbd5e1" font-size="11">Price ($)</text>
        <text x="${margin.left + plotW - 96}" y="${margin.top + plotH + 34}" fill="#cbd5e1" font-size="11">Time (ET)</text>
        ${ticks.map((tick) => `<g>
            <line x1="${margin.left}" y1="${tick.y}" x2="${margin.left + plotW}" y2="${tick.y}" stroke="rgba(148,163,184,0.2)" />
            <text x="${margin.left - 10}" y="${tick.y + 4}" fill="#cbd5e1" font-size="11" text-anchor="end">${tick.value.toFixed(2)}</text>
        </g>`).join('')}
        ${timeTicks.map((tick) => `<g>
            <line x1="${tick.x}" y1="${margin.top + plotH}" x2="${tick.x}" y2="${margin.top + plotH + 5}" stroke="#94a3b8" />
            <text x="${tick.x}" y="${margin.top + plotH + 20}" fill="#cbd5e1" font-size="10" text-anchor="middle">${tick.label}</text>
        </g>`).join('')}
        ${rows}
        ${candlesticks}
        ${latestPriceLine}
    </svg>`;
}

function openLiquidityZoneChart(zone) {
    if (!liquidityChartModal || !liquidityChartTitle || !liquidityChartBody) {
        return;
    }
    if (!latestLiquidityPayload || !Array.isArray(latestLiquidityPayload.zones)) {
        return;
    }

    const symbol = String(zone.symbol || '');
    const sessionDate = String(zone.sessionDate || latestLiquidityPayload.sessionDate || '');
    const symbolSnapshot = Array.isArray(latestLiquidityPayload.symbols)
        ? latestLiquidityPayload.symbols.find((entry) => String(entry.symbol || '') === symbol && String(entry.sessionDate || '') === sessionDate)
        : null;
    const chartBars = symbolSnapshot && Array.isArray(symbolSnapshot.chartBars)
        ? symbolSnapshot.chartBars
        : [];
    const symbolZones = latestLiquidityPayload.zones
        .filter((entry) => String(entry.symbol || '') === symbol && String(entry.sessionDate || '') === sessionDate)
        .slice()
        .sort((left, right) => right.strengthScore - left.strengthScore);

    liquidityChartTitle.textContent = `${symbol} Liquidity Zones`;
    const svg = renderLiquidityZoneChartSvg(symbol, sessionDate, symbolZones, zone, chartBars);
    const metaRows = symbolZones
        .map((entry) => `<tr>
            <td>${liquidityTypeLabel(entry.zoneType)}</td>
            <td>${formatPrice(entry.zoneLow)} - ${formatPrice(entry.zoneHigh)}</td>
            <td>${entry.strengthScore.toFixed(1)}</td>
            <td>${entry.touchCount}</td>
            <td>${formatPercent(entry.nearestPriceDistancePct)}</td>
        </tr>`)
        .join('');
    liquidityChartBody.innerHTML = `${svg}
        <div class="liquidity-chart-modal-bottom">
            <div class="liquidity-chart-modal-meta">
                <div class="fw-semibold mb-2">Zones for ${symbol} (${sessionDate})</div>
                <table class="table table-sm table-dark table-striped align-middle mb-0">
                    <thead><tr><th>Type</th><th>Zone</th><th>Strength</th><th>Touches</th><th>Distance</th></tr></thead>
                    <tbody>${metaRows}</tbody>
                </table>
            </div>
            ${renderLiquidityLegendHtml()}
        </div>`;
    liquidityChartModal.classList.remove('d-none');
}

function getLiquidityRows() {
    if (!liquidityZoneBody) return [];
    return Array.from(liquidityZoneBody.querySelectorAll('tr.liquidity-zone-row'));
}

function setActiveLiquidityRow(index, options = {}) {
    const { focus = true } = options;
    const rows = getLiquidityRows();
    if (!rows.length) {
        activeLiquidityRowIndex = -1;
        return;
    }

    const normalizedIndex = Math.max(0, Math.min(index, rows.length - 1));
    activeLiquidityRowIndex = normalizedIndex;

    rows.forEach((row, rowIndex) => {
        const isActive = rowIndex === normalizedIndex;
        row.tabIndex = isActive ? 0 : -1;
        row.classList.toggle('liquidity-zone-row-selected', isActive);
    });

    if (focus) {
        rows[normalizedIndex].focus();
    }
}

function activateLiquidityRow(row) {
    if (!(row instanceof HTMLElement)) {
        return;
    }

    const zoneIndex = Number(row.getAttribute('data-zone-index'));
    const zones = sortedLiquidityZones(latestLiquidityPayload);
    const zone = Number.isFinite(zoneIndex) ? zones[zoneIndex] : null;
    if (!zone) return;
    openLiquidityZoneChart(zone);
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
        .map((zone, index) => {
            const lastTouch = zone.lastTouchedAt ? formatTradeDateTime(zone.lastTouchedAt) : '-';
            return `
                <tr class="liquidity-zone-row" tabindex="-1" data-zone-index="${index}" data-symbol="${zone.symbol}" data-zone-low="${zone.zoneLow}" data-zone-high="${zone.zoneHigh}" data-zone-type="${zone.zoneType}">
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

    setActiveLiquidityRow(0, { focus: false });
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

function getAtrStopMultiple() {
    return clampNumber(atrStopMultipleInput.value, 1, 0.5, 10);
}

function getMinStopPct() {
    return clampNumber(minStopPctInput.value, 0.75, 0.1, 10);
}

function getMaxRiskPctPerSymbol() {
    return Math.floor(clampNumber(maxRiskPctPerSymbolInput.value, 20, 1, 1000));
}

function applyBreakoutQualityInputsEnabled() {
    const enabled = getBreakoutQualityFiltersEnabled();
    breakoutConfirmationCandleMinutesInput.disabled = !enabled;
    breakoutMinVolumeExpansionInput.disabled = !enabled;
    breakoutMinRelativeStrengthPctInput.disabled = !enabled;
    breakoutTrendTimeframeMinutesInput.disabled = !enabled;
    breakoutTrendLookbackBarsInput.disabled = !enabled;
    atrStopMultipleInput.disabled = !enabled;
    minStopPctInput.disabled = !enabled;
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

if (closeLiquidityChartModalBtn) {
    closeLiquidityChartModalBtn.addEventListener('click', closeLiquidityChartModal);
}

if (liquidityChartModal) {
    liquidityChartModal.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target) return;
        if (target.id === 'liquidityChartModal') {
            closeLiquidityChartModal();
        }
    });
}

if (liquidityZoneBody) {
    liquidityZoneBody.addEventListener('click', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (!target || !latestLiquidityPayload || !Array.isArray(latestLiquidityPayload.zones)) {
            return;
        }

        const row = target.closest('tr.liquidity-zone-row');
        if (!(row instanceof HTMLElement)) {
            return;
        }

        const rows = getLiquidityRows();
        const rowIndex = rows.indexOf(row);
        if (rowIndex >= 0) {
            setActiveLiquidityRow(rowIndex, { focus: false });
        }
        activateLiquidityRow(row);
    });

    liquidityZoneBody.addEventListener('keydown', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const row = target ? target.closest('tr.liquidity-zone-row') : null;
        if (!(row instanceof HTMLElement)) {
            return;
        }

        const rows = getLiquidityRows();
        const rowIndex = rows.indexOf(row);
        if (rowIndex < 0) {
            return;
        }

        if (event.key === 'ArrowDown') {
            event.preventDefault();
            setActiveLiquidityRow(rowIndex + 1, { focus: true });
            return;
        }

        if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActiveLiquidityRow(rowIndex - 1, { focus: true });
            return;
        }

        if (event.key === 'Enter') {
            event.preventDefault();
            setActiveLiquidityRow(rowIndex, { focus: true });
            activateLiquidityRow(row);
        }
    });

    liquidityZoneBody.addEventListener('focusin', (event) => {
        const target = event.target instanceof Element ? event.target : null;
        const row = target ? target.closest('tr.liquidity-zone-row') : null;
        if (!(row instanceof HTMLElement)) {
            return;
        }
        const rows = getLiquidityRows();
        const rowIndex = rows.indexOf(row);
        if (rowIndex >= 0) {
            setActiveLiquidityRow(rowIndex, { focus: false });
        }
    });
}

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        closeFieldHelp();
        closeTradeChartTooltip();
        closeLiquidityChartModal();
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
if (downloadReportBtn) {
    downloadReportBtn.addEventListener('click', downloadSelectedReport);
}
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
    const enabled = realTimeDataFeed.checked;

    try {
        const res = await fetch('/api/alpaca/set-realtime-feed', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ realtimeFeed: enabled }),
        });
        const payload = await res.json();
        if (payload.ok) {
            if (enabled) {
                sipProbeUnsupported = true;
                realTimeDataFeedError.classList.remove('d-none');
                try {
                    const sipRes = await fetch('/api/alpaca/check-sip');
                    const sipPayload = await sipRes.json();
                    sipProbeUnsupported = sipPayload.supported !== true;
                } catch {
                    sipProbeUnsupported = true;
                }
                if (sipProbeUnsupported) {
                    realTimeDataFeedError.classList.remove('d-none');
                } else {
                    realTimeDataFeedError.classList.add('d-none');
                }
            } else {
                sipProbeUnsupported = false;
                realTimeDataFeedError.classList.add('d-none');
            }
        }
    } catch {
        if (enabled) {
            realTimeDataFeedError.classList.remove('d-none');
        }
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
