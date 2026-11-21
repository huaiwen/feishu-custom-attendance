import test from 'node:test';
import assert from 'node:assert/strict';
import { DomainError } from '../domain.mjs';
import { validateShiftTemplate, attendanceSummary } from '../schedule-tools.mjs';

const day = '2026-11-23';
const at = time => new Date(`${day}T${time}+08:00`);
const morning = { start: '09:00', end: '12:00', locationId: 'office' };
const afternoon = { start: '13:00', end: '18:00', locationId: 'other-office' };
const emptyCounts = { expectedCount: 0, punchedCount: 0, normalCount: 0, lateCount: 0, earlyCount: 0, missingCount: 0, pendingCount: 0 };
const fixture = (segments = [morning]) => ({ employees: [{ id: 'employee-a', name: '员工 A' }], locations: [],
  schedules: [{ id: 'schedule-a', employeeId: 'employee-a', date: day, segments }], records: [] });
const summarize = (state, now) => attendanceSummary(state, { from: day, to: day }, now);

test('Shift templates sort times, trim text and discard locations and extra fields', () => {
  const input = { name: ' 两段班 ', segments: [afternoon, morning], note: ' 备注 ', id: 'ignored', employeeId: 'ignored' };
  assert.deepEqual(validateShiftTemplate(input), { name: '两段班', note: '备注', segments: [{ start: '09:00', end: '12:00' }, { start: '13:00', end: '18:00' }] });
  assert.equal(input.segments[0], afternoon);
  assert.equal(validateShiftTemplate({ name: '相邻班', segments: [{ start: '12:00', end: '18:00' }, morning] }).note, '');
});

test('Shift templates reject overlap, cross-day times and invalid field limits', () => {
  const valid = { name: '常规班', segments: [morning] };
  const invalid = [null, [], { ...valid, name: '' }, { ...valid, name: 123 }, { ...valid, name: 'x'.repeat(81) },
    { ...valid, note: null }, { ...valid, note: 'x'.repeat(501) }, { ...valid, segments: [] },
    { ...valid, segments: Array(13).fill(morning) },
    { ...valid, segments: [morning, { start: '11:59', end: '15:00' }] },
    { ...valid, segments: [{ start: '22:00', end: '06:00' }] },
    { ...valid, segments: [{ start: '09:00', end: '09:00' }] },
    { ...valid, segments: [{ start: '9:00', end: '12:00' }] },
    { ...valid, segments: [{ start: '09:00', end: '24:00' }] }];
  for (const input of invalid) assert.throws(() => validateShiftTemplate(input), DomainError);
});

test('An empty schedule yields zero totals without counting unrelated records', () => {
  const now = at('10:00:00');
  const result = summarize({ ...fixture(), schedules: [], records: [{ scheduleId: 'other', segmentIndex: 0, kind: 'in', status: 'normal' }] }, now);
  assert.deepEqual(result, { from: day, to: day, generatedAt: now.toISOString(), rows: [], totals: { ...emptyCounts, scheduledDays: 0 } });
});

test('Future unpunched nodes stay pending; all past unpunched nodes become missing', () => {
  const state = fixture([morning, afternoon]);
  const future = summarize(state, new Date('2026-11-22T23:59:59+08:00'));
  assert.equal(future.totals.pendingCount, 4);
  assert.equal(future.totals.missingCount, 0);
  const past = summarize(state, new Date('2026-11-24T00:00:00+08:00'));
  assert.equal(past.totals.pendingCount, 0);
  assert.equal(past.totals.missingCount, 4);
  assert.equal(past.totals.scheduledDays, 1);
});

test('Today follows the actual punch windows, including end and end+120 minute boundaries', () => {
  for (const [time, missing, pending] of [['11:59:59', 0, 2], ['12:00:00', 1, 1], ['14:00:59', 1, 1], ['14:01:00', 2, 0]]) {
    const result = summarize(fixture(), at(time));
    assert.equal(result.rows[0].missingCount, missing, time);
    assert.equal(result.rows[0].pendingCount, pending, time);
  }
  const lateShift = fixture([{ start: '20:00', end: '23:30', locationId: 'office' }]);
  assert.equal(summarize(lateShift, at('23:59:59')).totals.pendingCount, 1);
  assert.equal(summarize(lateShift, new Date('2026-11-24T00:00:00+08:00')).totals.missingCount, 2);
});

test('Records contribute normal, late and early counts once per scheduled node', () => {
  const state = fixture([morning, afternoon]);
  const record = { scheduleId: 'schedule-a', employeeId: 'employee-a' };
  state.records = [
    { ...record, segmentIndex: 0, kind: 'in', status: 'normal' },
    { ...record, segmentIndex: 0, kind: 'out', status: 'early' },
    { ...record, segmentIndex: 1, kind: 'in', status: 'late' },
    { ...record, segmentIndex: 0, kind: 'in', status: 'late' },
    { ...record, scheduleId: 'unrelated', segmentIndex: 1, kind: 'out', status: 'normal' },
  ];
  const { rows, totals } = summarize(state, new Date('2026-11-24T00:00:00+08:00'));
  const expected = { expectedCount: 4, punchedCount: 3, normalCount: 1, lateCount: 1, earlyCount: 1, missingCount: 1, pendingCount: 0 };
  assert.deepEqual(rows, [{ employeeId: 'employee-a', employeeName: '员工 A', date: day, ...expected }]);
  assert.deepEqual(totals, { ...expected, scheduledDays: 1 });
});

test('Summary filters dates and orders newest date first, then employee name', () => {
  const state = fixture();
  state.employees.push({ id: 'employee-b', name: '员工 B' });
  state.schedules = [
    { ...state.schedules[0], id: 'excluded-before', date: '2026-11-21' },
    { ...state.schedules[0], id: 'old', date: '2026-11-22' },
    { ...state.schedules[0], id: 'today-b', employeeId: 'employee-b' },
    { ...state.schedules[0], id: 'today-a' },
    { ...state.schedules[0], id: 'excluded-after', date: '2026-11-24' },
  ];
  const result = attendanceSummary(state, { from: '2026-11-22', to: day }, at('10:00:00'));
  assert.deepEqual(result.rows.map(row => [row.date, row.employeeId]), [[day, 'employee-a'], [day, 'employee-b'], ['2026-11-22', 'employee-a']]);
  assert.equal(result.totals.expectedCount, 6);
  assert.equal(result.totals.scheduledDays, 3);
});

test('Summary dates must be real, ordered ISO dates covering at most 31 days', () => {
  for (const range of [undefined, null, {}, { from: '2026-02-30', to: '2026-03-01' },
    { from: '2026-1-01', to: '2026-01-02' }, { from: '2026-01-02', to: '2026-01-01' },
    { from: '2026-01-01', to: '2026-02-01' }, { from: 20260101, to: '2026-01-31' }]) {
    assert.throws(() => attendanceSummary(fixture(), range, at('10:00:00')), DomainError);
  }
  assert.equal(attendanceSummary(fixture(), { from: '2026-01-01', to: '2026-01-31' }, at('10:00:00')).totals.scheduledDays, 0);
  assert.equal(attendanceSummary(fixture(), { from: '2028-02-29', to: '2028-02-29' }, at('10:00:00')).totals.scheduledDays, 0);
});
