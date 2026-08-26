import * as d from 'date-fns';

/**
 * Maps a card purchase date to the month of the statement that bills it.
 *
 * Statement cycles close on `closingDay`, and the closed statement is paid
 * in the following month (the common Portuguese pattern - e.g. Santander
 * closes on the 15th and debits on the 5th of the next month). A purchase
 * on or before the closing day belongs to the statement paid next month
 * (+1 month); a purchase after the closing day only enters the following
 * cycle, paid the month after that (+2 months). The day of month is kept
 * (clamped to the target month's length) so transactions keep their
 * relative order within the month.
 */
export function shiftToStatementMonth(
  date: string,
  closingDay: number,
): string {
  const parsed = d.parseISO(date);
  if (!d.isValid(parsed)) {
    return date;
  }

  const clampedClosingDay = Math.min(Math.max(Math.trunc(closingDay), 1), 31);
  const monthsAhead = parsed.getDate() > clampedClosingDay ? 2 : 1;
  const targetMonth = d.addMonths(d.startOfMonth(parsed), monthsAhead);
  const day = Math.min(parsed.getDate(), d.getDaysInMonth(targetMonth));
  return d.format(d.setDate(targetMonth, day), 'yyyy-MM-dd');
}
