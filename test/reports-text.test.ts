import { expect } from 'chai';
import { describe, it } from 'mocha';
import { Reports } from '../src/reports';

describe('orb report subtitle text', () => {
    it('uses historic-data copy for historical runs', () => {
        const subtitle = Reports.buildReportSubtitle('2026-05-08', true);

        expect(subtitle).to.equal(
            'ORB activity for the New York session on 2026-05-08 using historic data from the first 15 minutes for the opening range and the following 15 minutes for breakout detection, then managing positions until market close.'
        );
    });

    it('uses default copy for non-historical runs', () => {
        const subtitle = Reports.buildReportSubtitle('2026-05-08', false);

        expect(subtitle).to.equal(
            'ORB activity for the New York session on 2026-05-08 using the first 15 minutes for the opening range and the following 15 minutes for breakout detection, then managing positions until market close.'
        );
    });
});
