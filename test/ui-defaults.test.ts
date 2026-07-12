import { expect } from 'chai';
import { describe, it } from 'mocha';
import * as fs from 'fs';
import * as path from 'path';

const htmlPath = path.resolve(__dirname, '..', 'src', 'web', 'public', 'index.html');
const jsPath = path.resolve(__dirname, '..', 'src', 'web', 'public', 'app.js');

describe('UI defaults (index.html)', () => {
    const html = fs.readFileSync(htmlPath, 'utf-8');

    it('sets breakout quality filters checkbox checked by default', () => {
        const match = html.match(
            /<input class="form-check-input" type="checkbox"\s+id="breakoutQualityFiltersEnabled" checked\s*\/>/,
        );
        expect(match).to.not.be.null;
    });

    it('removes the Maximize Profit Probability button', () => {
        expect(html).to.not.contain('maximizeProfitBtn');
        expect(html).to.not.contain('Maximize Profit Probability');
    });

    it('removes the maximize profit status div', () => {
        expect(html).to.not.contain('maximizeProfitStatus');
    });

    it('defaults breakoutMinVolumeExpansion to 1.5', () => {
        const match = html.match(/id="breakoutMinVolumeExpansion"[^>]*value="([^"]+)"/);
        expect(match).to.not.be.null;
        expect(match![1]).to.equal('1.5');
    });

    it('defaults breakoutMinRelativeStrengthPct to 0.50', () => {
        const match = html.match(/id="breakoutMinRelativeStrengthPct"[^>]*value="([^"]+)"/);
        expect(match).to.not.be.null;
        expect(match![1]).to.equal('0.50');
    });

    it('defaults atrStopMultiple to 1.5', () => {
        const match = html.match(/id="atrStopMultiple"[^>]*value="([^"]+)"/);
        expect(match).to.not.be.null;
        expect(match![1]).to.equal('1.5');
    });

    it('defaults minStopPct to 1.25', () => {
        const match = html.match(/id="minStopPct"[^>]*value="([^"]+)"/);
        expect(match).to.not.be.null;
        expect(match![1]).to.equal('1.25');
    });

    it('defaults mostActiveSymbolLimit to 30', () => {
        const match = html.match(/id="mostActiveSymbolLimit"[^>]*value="([^"]+)"/);
        expect(match).to.not.be.null;
        expect(match![1]).to.equal('30');
    });

    it('defaults stopProfitRatio to 3', () => {
        const match = html.match(/id="stopProfitRatio"[^>]*value="([^"]+)"/);
        expect(match).to.not.be.null;
        expect(match![1]).to.equal('3');
    });
});

describe('UI defaults (app.js)', () => {
    const js = fs.readFileSync(jsPath, 'utf-8');

    it('removes the MAX_PROFIT_FILTERS constant', () => {
        expect(js).to.not.contain('MAX_PROFIT_FILTERS');
    });

    it('removes the setMaximizeProfitFilters function', () => {
        expect(js).to.not.contain('setMaximizeProfitFilters');
    });

    it('removes the maximizeProfitBtn event listener', () => {
        expect(js).to.not.contain('maximizeProfitBtn');
    });

    it('removes the maximizeProfit help key', () => {
        expect(js).to.not.contain('maximizeProfit');
    });

    it('defaults getStopProfitRatio fallback to 3', () => {
        expect(js).to.contain('getStopProfitRatio() {\n    const value = stopProfitRatioSpinner.value ? parseFloat(stopProfitRatioSpinner.value) : 3;');
    });

    it('defaults getMostActiveSymbolLimit fallback to 30', () => {
        expect(js).to.contain('clampNumber(mostActiveSymbolLimitInput.value, 30, 1, 200)');
    });

    it('defaults getBreakoutMinVolumeExpansion fallback to 1.5', () => {
        expect(js).to.contain('clampNumber(breakoutMinVolumeExpansionInput.value, 1.5, 0.5, 10)');
    });

    it('defaults getBreakoutMinRelativeStrengthPct fallback to 0.5', () => {
        expect(js).to.contain('clampNumber(breakoutMinRelativeStrengthPctInput.value, 0.5, 0, 5)');
    });

    it('defaults getAtrStopMultiple fallback to 1.5', () => {
        expect(js).to.contain('clampNumber(atrStopMultipleInput.value, 1.5, 0.5, 10)');
    });

    it('defaults getMinStopPct fallback to 1.25', () => {
        expect(js).to.contain('clampNumber(minStopPctInput.value, 1.25, 0.1, 10)');
    });

    it('adds $750 option to maxRiskPerSession dropdown', () => {
        expect(js).to.contain("opt750.value = '750'");
        expect(js).to.contain("opt750.textContent = '$750'");
        expect(js).to.contain("insertBefore(opt750, maxRiskPerSessionSelect.options[1])");
        expect(js).to.contain("maxRiskPerSessionSelect.value = '750'");
    });

    it('shows start message when not running', () => {
        expect(js).to.contain("'Click the Start ORBilicious button to start'");
    });

    it('shows not-running state in shouldShowWarning', () => {
        expect(js).to.contain('!latestIsRunning');
    });

    it('shows markets closed message when running and waiting for open', () => {
        expect(js).to.contain("'NY Markets are closed. ORBilicious will get Most Active Stocks and discover Breakout Candidates once the NY Markets open.'");
    });
});
