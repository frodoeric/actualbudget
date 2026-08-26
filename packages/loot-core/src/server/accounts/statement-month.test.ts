import { shiftToStatementMonth } from './statement-month';

describe('shiftToStatementMonth', () => {
  it('bills purchases up to the closing day in the next month (Santander: closes the 15th)', () => {
    expect(shiftToStatementMonth('2026-08-05', 15)).toBe('2026-09-05');
    expect(shiftToStatementMonth('2026-08-07', 15)).toBe('2026-09-07');
    expect(shiftToStatementMonth('2026-08-15', 15)).toBe('2026-09-15');
  });

  it('bills purchases after the closing day two months ahead', () => {
    expect(shiftToStatementMonth('2026-08-16', 15)).toBe('2026-10-16');
    expect(shiftToStatementMonth('2026-08-20', 15)).toBe('2026-10-20');
  });

  it('shifts everything one month with an end-of-month close', () => {
    expect(shiftToStatementMonth('2026-08-01', 31)).toBe('2026-09-01');
    expect(shiftToStatementMonth('2026-08-31', 31)).toBe('2026-09-30');
  });

  it('clamps the day to the target month length', () => {
    expect(shiftToStatementMonth('2026-01-31', 31)).toBe('2026-02-28');
    expect(shiftToStatementMonth('2028-01-30', 31)).toBe('2028-02-29');
  });

  it('clamps out-of-range closing days', () => {
    expect(shiftToStatementMonth('2026-08-01', 0)).toBe('2026-09-01');
    expect(shiftToStatementMonth('2026-08-02', 0)).toBe('2026-10-02');
    expect(shiftToStatementMonth('2026-08-30', 99)).toBe('2026-09-30');
  });

  it('returns invalid dates unchanged', () => {
    expect(shiftToStatementMonth('not-a-date', 15)).toBe('not-a-date');
  });
});
