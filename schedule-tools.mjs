import { DomainError, clockParts } from './domain.mjs';

const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const ZERO_COUNTS = { expectedCount: 0, punchedCount: 0, normalCount: 0, lateCount: 0, earlyCount: 0, missingCount: 0, pendingCount: 0 };

export function validateShiftTemplate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new DomainError('班次模板必须是对象');
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name || name.length > 80) throw new DomainError('模板名称须为 1 至 80 个字符');
  const note = input.note === undefined ? '' : input.note;
  if (typeof note !== 'string' || note.trim().length > 500) throw new DomainError('模板备注须为不超过 500 个字符的文本');
  if (!Array.isArray(input.segments) || input.segments.length < 1 || input.segments.length > 12) throw new DomainError('模板应包含 1 至 12 个时段');
  const segments = input.segments.map(segment => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)
        || typeof segment.start !== 'string' || !TIME.test(segment.start)
        || typeof segment.end !== 'string' || !TIME.test(segment.end)) throw new DomainError('时段时间格式应为 HH:mm（00:00–23:59）');
    if (segment.start >= segment.end) throw new DomainError('时段结束时间必须晚于开始时间，跨天班次请分成两天设置');
    return { start: segment.start, end: segment.end };
  }).sort((a, b) => a.start.localeCompare(b.start));
  if (segments.some((segment, index) => index > 0 && segments[index - 1].end > segment.start)) throw new DomainError('模板中的时段不能重叠');
  return { name, segments, note: note.trim() };
}

export function attendanceSummary(state, range, now = new Date()) {
  if (!range || typeof range !== 'object' || Array.isArray(range)) throw new DomainError('请提供统计起止日期');
  const { from, to } = range;
  for (const date of [from, to]) {
    const parsed = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? new Date(`${date}T00:00:00Z`) : new Date(NaN);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new DomainError('统计日期无效，请使用 YYYY-MM-DD 格式');
  }
  if (from > to || Date.parse(to) - Date.parse(from) > 30 * 86400000) throw new DomainError('统计日期须按先后顺序选择，最多包含 31 天');
  const clock = clockParts(now);
  const names = new Map(state.employees.map(employee => [employee.id, employee.name]));
  const punches = new Map();
  for (const record of state.records) {
    const key = `${record.scheduleId}:${record.segmentIndex}:${record.kind}`;
    if (!punches.has(key)) punches.set(key, record);
  }
  const byEmployeeDay = new Map();
  for (const schedule of state.schedules) {
    if (schedule.date < from || schedule.date > to) continue;
    const key = `${schedule.employeeId}:${schedule.date}`;
    const row = byEmployeeDay.get(key) || { employeeId: schedule.employeeId,
      employeeName: names.get(schedule.employeeId) || schedule.employeeId, date: schedule.date, ...ZERO_COUNTS };
    const cutoff = schedule.cancelledAt ? clockParts(new Date(schedule.cancelledAt)) : clock;
    schedule.segments.forEach((segment, index) => {
      const [hours, minutes] = segment.end.split(':').map(Number);
      const end = hours * 60 + minutes;
      for (const kind of ['in', 'out']) {
        const record = punches.get(`${schedule.id}:${index}:${kind}`);
        if (record && record.employeeId === schedule.employeeId) {
          if (!['normal', 'late', 'early'].includes(record.status)) throw new DomainError('考勤记录状态无效，无法生成统计');
          row.expectedCount++;
          row.punchedCount++;
          row[`${record.status}Count`]++;
        } else {
          const overdue = schedule.date < cutoff.date || (schedule.date === cutoff.date
            && (kind === 'in' ? cutoff.minutes >= end : cutoff.minutes > end + 120));
          if (schedule.cancelledAt && !overdue) continue;
          row.expectedCount++;
          row[overdue ? 'missingCount' : 'pendingCount']++;
        }
      }
    });
    byEmployeeDay.set(key, row);
  }
  const rows = [...byEmployeeDay.values()].sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName, 'zh-CN') || a.employeeId.localeCompare(b.employeeId));
  const totals = { ...ZERO_COUNTS, scheduledDays: rows.length };
  for (const row of rows) for (const key of Object.keys(ZERO_COUNTS)) totals[key] += row[key];
  return { from, to, generatedAt: now.toISOString(), rows, totals };
}
