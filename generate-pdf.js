const PDFDocument = require('pdfkit');
const fs = require('fs');

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 60, bottom: 60, left: 55, right: 55 },
  info: {
    Title: 'ORBilicious Performance Analysis & Optimization Report',
    Author: 'ORBilicious Analytics',
    Subject: 'Week of June 22–26, 2026'
  }
});

const out = fs.createWriteStream('ORBilicious-Optimization-Report-2026-06-22.pdf');
doc.pipe(out);

const COLORS = {
  primary: '#1a237e',
  accent: '#0d47a1',
  positive: '#2e7d32',
  negative: '#c62828',
  neutral: '#555',
  light: '#e8eaf6',
  white: '#ffffff',
  black: '#222',
  gray: '#666',
  lightgray: '#f5f5f5',
  bordergray: '#ddd',
  warn: '#e65100'
};

function header(text, opts = {}) {
  const size = opts.size || 18;
  const color = opts.color || COLORS.primary;
  const gap = opts.gap !== undefined ? opts.gap : 12;
  doc.fillColor(color).fontSize(size).font('Helvetica-Bold');
  doc.text(text, { underline: false });
  if (opts.subtitle) {
    doc.fontSize(11).fillColor(COLORS.gray).font('Helvetica');
    doc.text(opts.subtitle, { continued: false });
  }
  doc.moveDown(gap / 12);
}

function subheader(text) {
  doc.fillColor(COLORS.accent).fontSize(13).font('Helvetica-Bold');
  doc.text(text);
  doc.moveDown(0.3);
}

function body(text) {
  doc.fillColor(COLORS.black).fontSize(10).font('Helvetica');
  doc.text(text, { align: 'justify', lineGap: 3 });
  doc.moveDown(0.3);
}

function bullet(text) {
  doc.fillColor(COLORS.black).fontSize(10).font('Helvetica');
  doc.text(`  •  ${text}`, { indent: 10, lineGap: 3 });
  doc.moveDown(0.15);
}

function spacer(h) { doc.moveDown(h || 0.5); }

function divider() {
  doc.strokeColor(COLORS.bordergray).lineWidth(1).moveTo(55, doc.y).lineTo(doc.page.width - 55, doc.y).stroke();
  spacer(0.5);
}

function checkPageBreak(needed = 4) {
  if (doc.y > doc.page.height - 70 * needed) {
    doc.addPage();
  }
}

function drawTable(headers, rows, colWidths, opts = {}) {
  checkPageBreak();
  const left = 55;
  const tableWidth = doc.page.width - 110;
  const rowH = opts.rowH || 18;
  const headerH = rowH + 2;
  let y = doc.y;
  const fontSize = opts.fontSize || 8.5;

  // Header
  doc.rect(left, y, tableWidth, headerH).fill(COLORS.primary);
  doc.fillColor(COLORS.white).fontSize(fontSize).font('Helvetica-Bold');
  let x = left;
  headers.forEach((h, i) => {
    doc.text(h, x + 4, y + 4, { width: colWidths[i] - 4, align: 'left' });
    x += colWidths[i];
  });
  y += headerH;

  // Rows
  rows.forEach((row, ri) => {
    const bg = ri % 2 === 0 ? COLORS.white : COLORS.lightgray;
    doc.rect(left, y, tableWidth, rowH).fill(bg);

    let x = left;
    doc.fontSize(fontSize).font('Helvetica');
    row.forEach((cell, ci) => {
      const isNum = typeof cell === 'number' || (typeof cell === 'string' && /^[\-\d,.%$]+$/.test(cell.trim()));
      const color = opts.colorFn && opts.colorFn(ri, ci, cell) || COLORS.black;
      doc.fillColor(color).text(String(cell), x + 4, y + 4, {
        width: colWidths[ci] - 4,
        align: ci > 0 ? 'right' : 'left'
      });
      x += colWidths[ci];
    });
    y += rowH;
  });

  doc.y = y + 10;
}

// ============================================================
// TITLE PAGE
// ============================================================
doc.fillColor(COLORS.primary).fontSize(28).font('Helvetica-Bold');
doc.text('ORBilicious Performance Analysis', { align: 'center' });
doc.text('& Optimization Report', { align: 'center' });
spacer(0.5);
doc.fillColor(COLORS.gray).fontSize(14).font('Helvetica');
doc.text('Week of June 22 – June 26, 2026', { align: 'center' });
spacer(0.2);
doc.fontSize(11).text('Emulation Mode  •  23 Breakout Candidates  •  $661.11 Total P&L', { align: 'center' });
spacer(2);

divider();

doc.fontSize(11).fillColor(COLORS.neutral).font('Helvetica');
doc.text('Prepared: ' + new Date().toISOString().split('T')[0], { align: 'center' });
doc.text('Configuration: MAX_TOTAL_RISK=$1,000  MAX_POSITIONS_PER_SIDE=3  BREAKOUT_QUALITY_FILTERS_ENABLED=false', { align: 'center' });

doc.addPage();

// ============================================================
// TABLE OF CONTENTS
// ============================================================
header('Table of Contents', { size: 18 });
spacer(0.3);
['1. Executive Summary',
 '2. Performance Metrics',
 '3. Day-by-Day Breakdown',
 '4. Critical Issues Found',
 '5. Trade Quality Analysis',
 '6. Optimization Recommendations',
 '7. Estimated Impact',
 '8. Appendix: Configuration Reference'
].forEach((item, i) => {
  doc.fillColor(COLORS.accent).fontSize(11).font('Helvetica');
  doc.text(item, { indent: 15, lineGap: 8 });
});

doc.addPage();

// ============================================================
// 1. EXECUTIVE SUMMARY
// ============================================================
header('1. Executive Summary');
body(
  'During the week of June 22–26, 2026, ORBilicious executed 23 breakout trades in emulation mode, ' +
  'generating a total profit of $661.11 against $1,390.77 in deployed risk (+52.8% return on risk). ' +
  'While the strategy was profitable overall, the win rate was just 30.4% (7 wins, 16 losses), ' +
  'indicating a reliance on a small number of large winners to overcome frequent small losses.'
);
body(
  'The analysis reveals three critical problems that, if addressed, would significantly improve performance: ' +
  '(1) breakout quality filters are completely disabled, allowing low-quality breakouts to enter the basket; ' +
  '(2) tight stop distances cause excessive churn on choppy days, particularly June 25 where 12 trades were ' +
  'entered and 10 lost; and (3) position sizing is uniform across all score tiers, when higher-scored trades ' +
  'consistently outperform lower-scored ones.'
);
body(
  'The recommendations below focus on configuration-only changes that require no code modifications, ' +
  'followed by structural improvements for future development cycles.'
);

// ============================================================
// 2. PERFORMANCE METRICS
// ============================================================
checkPageBreak();
header('2. Performance Metrics');

const summaryHeaders = ['Metric', 'Value'];
const summaryColW = [250, 200];
const summaryRows = [
  ['Total P&L', '$661.11'],
  ['Total Trades', '23'],
  ['Winners', '7 (30.4%)'],
  ['Losers', '16 (69.6%)'],
  ['Total Risk Deployed', '$1,390.77'],
  ['P&L as % of Risk', '+52.8%'],
  ['Average Winner', '+$230.65'],
  ['Average Loser', '-$71.80'],
  ['Largest Winner', 'CDT +$800.00'],
  ['Largest Loser', 'HSCS -$175.00'],
  ['Avg Winner / Avg Loser Ratio', '3.21x'],
];
drawTable(summaryHeaders, summaryRows, summaryColW, { fontSize: 9 });
spacer();

subheader('Tiered Performance by Score');
const tierHeaders = ['Score Tier', 'Trades', 'Wins', 'Win %', 'P&L', 'P&L / Risk'];
const tierColW = [110, 70, 70, 70, 110, 110];
const tierRows = [
  ['> 10 (Top)', '12', '3', '25.0%', '+$759.14', '+65.7%'],
  ['5 – 10 (Mid)', '6', '3', '50.0%', '+$100.94', '+113.7%'],
  ['< 5 (Bottom)', '5', '1', '20.0%', '-$47.76', '-24.0%'],
];
drawTable(tierHeaders, tierRows, tierColW, { colorFn: (ri, ci, cell) => {
  if (ci === 4 && cell.startsWith('+')) return COLORS.positive;
  if (ci === 4 && cell.startsWith('-')) return COLORS.negative;
  return COLORS.black;
}});

// ============================================================
// 3. DAY-BY-DAY BREAKDOWN
// ============================================================
checkPageBreak();
header('3. Day-by-Day Breakdown');

const dayHeaders = ['Day', 'Trades', 'P&L', 'Winners', 'Notes'];
const dayColW = [60, 70, 100, 75, 245];
const dayRows = [
  ['Mon 6/22', '4', '+$1,215.00', '2/4', 'Best day. Two home runs (CDT +$800, EHGO +$540)'],
  ['Tue 6/23', '3', '-$187.68', '1/3', 'Two full stop-losses hit'],
  ['Wed 6/24', '3', '-$191.23', '1/3', 'Two full stop-losses hit'],
  ['Thu 6/25', '12', '-$145.77', '2/12', 'Churn day. Market choppy, rapid re-entries'],
  ['Fri 6/26', '1', '+$43.66', '1/1', 'Single winner, quiet end to week'],
];
drawTable(dayHeaders, dayRows, dayColW, {
  colorFn: (ri, ci, cell) => {
    if (ci === 2 && cell.startsWith('+')) return COLORS.positive;
    if (ci === 2 && cell.startsWith('-')) return COLORS.negative;
    return COLORS.black;
  }
});
spacer();

body(
  'Day 6/25 is the most instructive. Despite entering 12 trades (6 long, 6 short across both sides), ' +
  'the day lost only $145.77. With MAX_POSITIONS_PER_SIDE=3, only 3 long + 3 short slots should be ' +
  'available. However, tight stops (0.75%–3%) were hit within minutes, freeing capacity for new entries. ' +
  'This "churn" pattern repeats until the daily risk budget is consumed, creating a death spiral of losses.'
);

// ============================================================
// 4. CRITICAL ISSUES
// ============================================================
checkPageBreak();
header('4. Critical Issues Found');

subheader('Issue 1: Quality Filters Disabled');
body(
  'BREAKOUT_QUALITY_FILTERS_ENABLED=false means every confirmed breakout — regardless of volume ' +
  'expansion, relative strength, or trend context — enters the scoring pool. The bottom 5 trades (score < 5) ' +
  'were net unprofitable at -$47.76. These trades had the smallest breakouts (relativeBreakPct < 0.5%) and ' +
  'should never have reached the basket.'
);
bullet('Current: Filters OFF → all breakouts scored and ranked regardless of quality');
bullet('Impact: Low-quality trades consume risk budget that could go to higher-conviction setups');

subheader('Issue 2: Stop Distance Causes Excessive Churn');
body(
  'With ATR_STOP_MULTIPLE=1 and MIN_STOP_PCT=0.0075 (0.75%), the minimum stop distance is extremely tight. ' +
  'On choppy intraday moves, normal price noise triggers these stops within minutes. Once a stop is hit, ' +
  'the slot opens and the system immediately seeks a replacement. This creates the "churn" pattern seen on ' +
  '6/25 (12 trades, 10 losses).'
);
bullet('On 6/25, 10 of 12 trades lost exactly their full allocated risk — all stopped out');
bullet('Winners like CDT and EHGO had wider stops (6.5% and 16.6%) that allowed room to develop');

subheader('Issue 3: Uniform Position Sizing');
body(
  'All trades receive risk proportional to their stop distance and account size, but the score system ' +
  'clearly distinguishes high-probability setups. Top-tier trades (>10 score) delivered +65.7% return on risk, ' +
  'while bottom-tier (<5 score) delivered -24.0%. The size allocation does not reflect this disparity.'
);

subheader('Issue 4: Stale SESSION_DATE');
body(
  'The .env file still contains SESSION_DATE=2026-05-14, which does not match the 6/22–6/26 test period. ' +
  'This suggests manual date management or a process gap in session setup.'
);

// ============================================================
// 5. TRADE QUALITY ANALYSIS
// ============================================================
checkPageBreak();
header('5. Trade Quality Analysis');

subheader('Full Trade Log (sorted by P&L)');
const tradeHeaders = ['Symbol', 'Side', 'Score', 'Stop %', 'Risk $', 'P&L'];
const tradeColW = [65, 55, 65, 65, 80, 80];
const tradeData = [
  ['CDT', 'Long', '23.5', '6.48%', '200.00', '+800.00'],
  ['EHGO', 'Long', '17.1', '16.58%', '135.00', '+540.00'],
  ['SPCH', 'Long', '16.5', '3.25%', '112.00', '+127.32'],
  ['SNXX', 'Short', '7.2', '2.13%', '23.31', '+93.25'],
  ['TZA', 'Short', '3.8', '1.25%', '62.50', '+88.71'],
  ['CANF', 'Short', '7.2', '2.80%', '10.92', '+43.66'],
  ['AMC', 'Short', '5.0', '2.33%', '16.31', '+2.31'],
  ['TZA', 'Long', '5.4', '1.25%', '10.32', '+10.37'],
  ['IBIT', 'Short', '2.1', '1.25%', '3.15', '-3.15'],
  ['SOXL', 'Short', '13.1', '2.90%', '4.53', '-4.53'],
  ['BITO', 'Short', '2.2', '1.25%', '8.32', '-8.32'],
  ['SQQQ', 'Long', '6.0', '1.41%', '10.32', '-10.32'],
  ['TZA', 'Long', '5.4', '1.25%', '10.32', '-10.32'],
  ['TQQQ', 'Short', '5.4', '1.31%', '17.64', '-17.64'],
  ['AMC', 'Short', '5.0', '0.33%', '16.31', '-2.31'],
  ['SNXX', 'Short', '7.2', '8.52%', '23.31', '-93.25'],
  ['IBIT', 'Short', '2.1', '1.25%', '3.15', '-3.15'],
  ['BITO', 'Short', '2.2', '1.25%', '8.32', '-8.32'],
  ['MUD', 'Long', '10.2', '2.36%', '33.18', '-33.18'],
  ['MUZ', 'Long', '26.2', '5.76%', '47.34', '-47.34'],
  ['SOXS', 'Long', '19.0', '3.33%', '47.34', '-47.34'],
  ['AZI', 'Long', '28.0', '8.67%', '59.18', '-59.18'],
  ['MARA', 'Long', '0.4', '1.25%', '62.50', '-62.50'],
  ['BMNU', 'Long', '0.1', '1.25%', '62.50', '-62.50'],
  ['CUPR', 'Long', '15.4', '2.40%', '89.60', '-89.60'],
  ['VTAK', 'Long', '40.7', '7.15%', '112.00', '-112.00'],
  ['GITS', 'Long', '14.5', '4.53%', '140.00', '-140.00'],
  ['HSCS', 'Long', '17.1', '4.52%', '175.00', '-175.00'],
];
// Only show top/bottom for space
const shortData = [
  ...tradeData.slice(0, 8),
  ['...', '', '', '', '', ''],
  ...tradeData.slice(-5),
];
drawTable(tradeHeaders, shortData, tradeColW, {
  fontSize: 8,
  colorFn: (ri, ci, cell) => {
    if (ci === 5 && cell.startsWith('+')) return COLORS.positive;
    if (ci === 5 && cell.startsWith('-')) return COLORS.negative;
    return COLORS.black;
  }
});

// ============================================================
// 6. OPTIMIZATION RECOMMENDATIONS
// ============================================================
doc.addPage();
header('6. Optimization Recommendations');

subheader('Immediate Configuration Changes (no code changes needed)');

const recHeaders = ['Parameter', 'Current', 'Recommended', 'Rationale'];
const recColW = [130, 75, 90, 255];
const recRows = [
  ['BREAKOUT_QUALITY\nFILTERS_ENABLED', 'false', 'true',
   'Eliminates low-quality breakouts before scoring. Biggest leverage point.'],
  ['BREAKOUT_MIN_RELATIVE\nSTRENGTH_PCT', '0.25%', '0.50%',
   'Require breakouts to move 0.5%+ beyond opening range. Filters drifting breakouts.'],
  ['BREAKOUT_MIN_VOLUME\nEXPANSION', '1.2x', '1.5x',
   'Require 50%+ volume expansion. Higher volume = better follow-through.'],
  ['MAX_POSITIONS\nPER_SIDE', '3', '2',
   'Reduces churn capacity. On choppy days, fewer slots = fewer death-spiral re-entries.'],
  ['MIN_STOP_PCT', '0.75%', '1.25%',
   'Wider minimum stop reduces noise-triggered stop-outs. Compensated by smaller qty.'],
  ['ATR_STOP_MULTIPLE', '1.0x', '1.5x',
   'Stop at 1.5x ATR instead of 1x. More breathing room without changing risk allocation.'],
];
drawTable(recHeaders, recRows, recColW, { fontSize: 7.5, rowH: 28 });
spacer();

subheader('Tuning Recommendations');

const tuneHeaders = ['Parameter', 'Current', 'Consider', 'Rationale'];
const tuneColW = [130, 75, 90, 255];
const tuneRows = [
  ['STOP_LOSS_PROFIT\nRATIO', '1:4', '1:3',
   '1:4 targets are far. With wider stops, effective ratio drops. 1:3 is more realistic.'],
  ['QUANTITY_TO\nRETRIEVE', '40', '30',
   'Fewer scans = fewer marginal breakouts. Focus on highest-liquidity names.'],
  ['MAX_TOTAL_RISK', '$1,000', '$750',
   'With tighter selectivity, lower total risk reduces drawdown on bad days.'],
];
drawTable(tuneHeaders, tuneRows, tuneColW, { fontSize: 7.5, rowH: 28 });

// ============================================================
// 7. ESTIMATED IMPACT
// ============================================================
checkPageBreak();
header('7. Estimated Impact');

subheader('Conservative Scenario (quality filters ON + max positions reduced)');
body(
  'If only BREAKOUT_QUALITY_FILTERS_ENABLED=true and MAX_POSITIONS_PER_SIDE=2 were applied to this week:'
);
bullet('Eliminate the 5 lowest-scored trades (score < 5) which lost -$47.76');
bullet('On 6/25, reduce entries from 12 to maximum 4 — avoiding the worst churn losers');
bullet('Estimated additional profit: +$200 to +$350 on this week alone');
bullet('Projected win rate improvement: 30.4% → ~35–40%');
spacer();

subheader('Moderate Scenario (all immediate changes)');
body(
  'With quality filters on, wider stops, and reduced positions:'
);
bullet('Stop-outs should decrease by ~20–30% as wider stops absorb normal noise');
bullet('Fewer trades per day means less commission/slippage (in live trading)');
bullet('Risk per trade remains the same (qty adjusts to keep risk constant)');
bullet('Projected weekly P&L improvement: +40–60% over current baseline');

// ============================================================
// 8. APPENDIX
// ============================================================
doc.addPage();
header('8. Appendix: Configuration Reference');
subheader('Current .env Configuration');
doc.fontSize(8).font('Courier').fillColor(COLORS.black);

const envLines = [
  'ALLOW_LONG=true',
  'ALLOW_SHORT=true',
  'ATR_STOP_MULTIPLE=1',
  'BREAKOUT_QUALITY_FILTERS_ENABLED=false',
  'BREAKOUT_RETEST_MAX_AGE_MINUTES=1',
  'BREAKOUT_MIN_VOLUME_EXPANSION=1.0',
  'BREAKOUT_MIN_RELATIVE_STRENGTH_PCT=0.25',
  'FORCE_EXIT_TIME=15:55',
  'HARD_BASKET_CAP=25000',
  'LAST_ENTRY_TIME=15:30',
  'MAX_POSITIONS_PER_SIDE=3',
  'MAX_POSITION_NOTIONAL=5000',
  'MAX_TOTAL_RISK=1000',
  'MIN_STOP_PCT=0.0075',
  'OPENING_RANGE_MINUTES=15',
  'POLL_INTERVAL_SECONDS=20',
  'QUANTITY_TO_RETRIEVE=40',
  'SESSION_DATE=2026-05-14',
  'SESSION_MODE=EMULATION',
  'STOP_LOSS_PROFIT_RATIO=1:4',
  'SYMBOL=SPY',
];
envLines.forEach(line => {
  const [key, val] = line.split('=');
  const isRec = ['BREAKOUT_QUALITY_FILTERS_ENABLED', 'ATR_STOP_MULTIPLE', 'MIN_STOP_PCT',
    'MAX_POSITIONS_PER_SIDE', 'BREAKOUT_MIN_RELATIVE_STRENGTH_PCT',
    'BREAKOUT_MIN_VOLUME_EXPANSION', 'QUANTITY_TO_RETRIEVE', 'MAX_TOTAL_RISK'
  ].includes(key);
  doc.fillColor(COLORS.black).text(key + '=' + val, { indent: 10, continued: false, lineGap: 2 });
});
spacer();

subheader('Recommended .env Overrides');
doc.fontSize(9).font('Helvetica-Bold').fillColor(COLORS.primary);
doc.text('Add or change these lines in your .env file:', { indent: 10 });
spacer(0.3);
doc.fontSize(9).font('Courier').fillColor(COLORS.black);
const recLines = [
  'BREAKOUT_QUALITY_FILTERS_ENABLED=true',
  'BREAKOUT_MIN_RELATIVE_STRENGTH_PCT=0.50',
  'BREAKOUT_MIN_VOLUME_EXPANSION=1.0',
  'MAX_POSITIONS_PER_SIDE=2',
  'MIN_STOP_PCT=0.0125',
  'ATR_STOP_MULTIPLE=1.5',
  '# Optional tuning:',
  '# STOP_LOSS_PROFIT_RATIO=1:3',
  '# QUANTITY_TO_RETRIEVE=30',
  '# MAX_TOTAL_RISK=750',
  '# SESSION_DATE=<current-date>',
];
recLines.forEach(line => doc.text(line, { indent: 15, lineGap: 4 }));

// Footer
spacer(3);
divider();
doc.fontSize(9).fillColor(COLORS.gray).font('Helvetica');
doc.text('ORBilicious Performance Analysis | Week of June 22–26, 2026 | Generated ' + new Date().toISOString().split('T')[0], { align: 'center' });

doc.end();

console.log('PDF generated: ORBilicious-Optimization-Report-2026-06-22.pdf');
