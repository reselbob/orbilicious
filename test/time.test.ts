import { expect } from 'chai';
import { describe, it } from 'mocha';
import { toNyParts, todayNyDate } from '../src/time';

describe('time utilities', () => {
    it('converts a timestamp into New York date parts', () => {
        const parts = toNyParts('2026-05-13T13:31:00Z', 'America/New_York');
        expect(parts.date).to.equal('2026-05-13');
        expect(parts.hour).to.equal(9);
        expect(parts.minute).to.equal(31);
    });

    it('returns a YYYY-MM-DD date for New York today', () => {
        const result = todayNyDate();
        expect(result).to.match(/^\d{4}-\d{2}-\d{2}$/);
    });
});