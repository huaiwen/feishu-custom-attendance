import { createHash } from 'node:crypto';
import { DomainError } from './domain.mjs';
import { sessionFor } from './access.mjs';

const MINUTE = 60_000;
const WINDOW = 5 * MINUTE;
const defaults = { checkinEnabled: true, beforeMinutes: 15, reviewEnabled: true, afterMinutes: 60 };

export function reminderPreferences(state, openId, role) {
  const value = { ...defaults, ...state.reminders?.preferences[openId] };
  return role === 'user' ? { checkinEnabled: value.checkinEnabled, beforeMinutes: value.beforeMinutes } : value;
}

export function validateReminderPreferences(input, role) {
  const allowed = role === 'user' ? ['checkinEnabled', 'beforeMinutes'] : Object.keys(defaults);
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new DomainError('只能修改本人的提醒设置', 403);
  if (typeof input.checkinEnabled !== 'boolean' || ![15, 30].includes(input.beforeMinutes)) throw new DomainError('打卡提醒请选择提前 15 或 30 分钟');
  if (role !== 'user' && (typeof input.reviewEnabled !== 'boolean' || !Number.isInteger(input.afterMinutes) || input.afterMinutes < 1 || input.afterMinutes > 1440)) throw new DomainError('查看记录提醒请设置为打卡时点后 1 至 1440 分钟');
  return Object.fromEntries(allowed.map(key => [key, input[key]]));
}

export function initializeReminders(state) {
  state.reminders ??= { preferences: {}, deliveries: [] };
  const { preferences, deliveries } = state.reminders;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences) || !Array.isArray(deliveries)) throw new Error('提醒数据结构不正确');
  return state.reminders;
}

export function reminderHistory(state, openId) {
  return (state.reminders?.deliveries || []).filter(item => item.openId === openId).slice(-10).reverse()
    .map(({ type, attemptedAt, sentAt, status, error }) => ({ type, attemptedAt, sentAt, status, error }));
}

export function dueReminders(state, config, now) {
  const candidates = new Map();
  const add = (type, openId, subject, schedule, kind, time, dueAt) => {
    if (now < dueAt || now >= dueAt + WINDOW) return;
    const key = createHash('sha256').update(JSON.stringify([type, openId, subject, schedule.date, kind, time])).digest('hex').slice(0, 40);
    const label = kind === 'in' ? '上班' : '下班';
    const text = type === 'checkin'
      ? `打卡提醒\n${schedule.date} ${time} ${label}，请按排班到指定地点打卡。\n已打卡请忽略。\n打开今日打卡：${config.baseUrl}/#checkin`
      : `考勤记录提醒\n${state.groups.find(g => g.id === schedule.groupId)?.name || '考勤组'} · ${schedule.date} ${time} ${label}\n请查看该组的打卡记录与异常情况。\n查看考勤记录：${config.baseUrl}/?recordDate=${schedule.date}&group=${encodeURIComponent(schedule.groupId)}#records`;
    candidates.set(key, { key, openId, type, dueAt, text });
  };
  const orgAdmins = [...new Set([...config.adminOpenIds, ...state.employees.filter(e => e.orgAdmin).map(e => e.openId).filter(Boolean)])];
  for (const schedule of state.schedules) {
    const employee = state.employees.find(e => e.id === schedule.employeeId);
    if (!employee) continue;
    const group = state.groups.find(g => g.id === schedule.groupId);
    if (!group) continue;
    const groupAdmins = state.employees.filter(e => group.adminIds.includes(e.id) && e.openId).map(e => e.openId);
    const reviewers = [...new Set(groupAdmins.length ? groupAdmins : orgAdmins)];
    for (const [index, segment] of schedule.segments.entries()) {
      for (const [kind, time] of [['in', segment.start], ['out', segment.end]]) {
        const scheduledAt = Date.parse(`${schedule.date}T${time}:00+08:00`);
        if (employee.openId) {
          const pref = reminderPreferences(state, employee.openId, 'user');
          const punched = state.records.some(r => r.scheduleId === schedule.id && r.segmentIndex === index && r.kind === kind);
          if (pref.checkinEnabled && !punched) add('checkin', employee.openId, employee.id, schedule, kind, time, scheduledAt - pref.beforeMinutes * MINUTE);
        }
        for (const openId of reviewers) {
          const pref = reminderPreferences(state, openId, sessionFor(state, openId, config.adminOpenIds).role);
          if (pref.reviewEnabled) add('review', openId, group.id, schedule, kind, time, scheduledAt + pref.afterMinutes * MINUTE);
        }
      }
    }
  }
  return [...candidates.values()];
}

export function createReminderDispatcher({ getState, commit, config, send, now = Date.now }) {
  let running = false;
  const current = key => dueReminders(getState(), config, now()).some(item => item.key === key);
  const saveAttempt = item => commit(state => {
    const data = initializeReminders(state);
    data.deliveries = data.deliveries.filter(row => row.attemptedAt > now() - 30 * 86400000);
    const previous = data.deliveries.find(row => row.key === item.key);
    const row = { key: item.key, openId: item.openId, type: item.type, attemptedAt: now(), attempts: (previous?.attempts || 0) + 1, status: 'pending' };
    if (previous) Object.assign(previous, row); else data.deliveries.push(row);
  });
  const deliver = async (item, isCurrent) => {
    saveAttempt(item);
    let status, messageId, error;
    try {
      messageId = await send({ openId: item.openId, text: item.text, uuid: item.key, isCurrent });
      status = messageId ? 'sent' : 'cancelled';
    } catch (failure) {
      status = 'failed';
      const code = failure.message?.match(/错误码 (\d+)/)?.[1];
      error = code ? `飞书发送失败（错误码 ${code}），请联系组织管理员检查应用权限或可用范围` : '飞书发送暂未成功，请检查网络或联系组织管理员';
    }
    commit(state => {
      const row = state.reminders.deliveries.find(row => row.key === item.key);
      Object.assign(row, { status, error, ...(messageId ? { messageId, sentAt: now() } : {}) });
    });
    return { status, error };
  };
  return {
    async run() {
      if (running || !config.remindersEnabled) return;
      running = true;
      try {
        for (const item of dueReminders(getState(), config, now())) {
          const previous = getState().reminders?.deliveries.find(row => row.key === item.key);
          if (previous && (['sent', 'cancelled'].includes(previous.status) || previous.attempts >= 3 || now() - previous.attemptedAt < MINUTE)) continue;
          if (current(item.key)) await deliver(item, () => current(item.key));
        }
      } finally { running = false; }
    },
    async test(openId) {
      if (!config.remindersEnabled) throw new DomainError('飞书提醒尚未启用，请联系组织管理员', 503);
      if (getState().reminders?.deliveries.some(row => row.type === 'test' && row.openId === openId && now() - row.attemptedAt < WINDOW)) throw new DomainError('测试提醒每 5 分钟可发送一次，请稍后重试', 429);
      return deliver({ key: createHash('sha256').update(`${openId}:${now()}`).digest('hex').slice(0, 40), openId, type: 'test',
        text: `自定义考勤 · 测试提醒\n提醒通道已接通。你可以在“我的提醒”设置提前 15 或 30 分钟收到打卡提醒；管理员可设置查看记录的提醒时间。\n打开考勤：${config.baseUrl}/#checkin` },
      () => config.adminOpenIds.includes(openId) || getState().employees.some(e => e.openId === openId));
    },
  };
}
