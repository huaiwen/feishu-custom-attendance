import { DomainError } from './domain.mjs';

export function sessionFor(state, openId, adminOpenIds, demo = false) {
  const employee = state.employees.find(e => e.openId && e.openId === openId);
  if (employee?.disabled && !demo) return null;
  const managedGroupIds = state.groups.filter(g => g.adminIds.includes(employee?.id)).map(g => g.id);
  const role = demo || adminOpenIds.includes(openId) || employee?.orgAdmin === true ? 'org_admin' : managedGroupIds.length ? 'group_admin' : 'user';
  return { role, employeeId: employee?.id || null, managedGroupIds };
}

export function managesGroup(session, groupId) {
  return session.role === 'org_admin' || session.managedGroupIds.includes(groupId);
}

export function requireGroup(session, groupId, state) {
  if (!state.groups.some(g => g.id === groupId)) throw new DomainError('请选择有效的考勤组');
  if (!managesGroup(session, groupId)) throw new DomainError('只能管理自己负责的考勤组', 403);
}

export function visibleState(state, session, adminOpenIds, { includeCancelledSchedules = false } = {}) {
  const org = session.role === 'org_admin';
  const manager = session.role !== 'user';
  const canRead = item => org || item.employeeId === session.employeeId || managesGroup(session, item.groupId);
  const schedules = state.schedules.filter(s => (includeCancelledSchedules || !s.cancelledAt) && canRead(s));
  const locationIds = new Set(schedules.flatMap(s => s.segments.map(p => p.locationId)));
  const own = state.employees.find(e => e.id === session.employeeId);
  const { reminders, workflows, ...attendance } = state;
  return { ...attendance,
    groups: state.groups.filter(g => org || session.managedGroupIds.includes(g.id) || g.id === own?.groupId)
      .map(g => manager ? g : { id: g.id, name: g.name }),
    employees: state.employees.filter(e => org || e.id === session.employeeId || managesGroup(session, e.groupId)).map(e => {
      const { openId, ...profile } = e;
      return { ...profile, bound: Boolean(openId), role: adminOpenIds.includes(openId) || e.orgAdmin ? 'org_admin' : state.groups.some(g => g.adminIds.includes(e.id)) ? 'group_admin' : 'user',
        bootstrapAdmin: org && adminOpenIds.includes(openId), manageable: manager && managesGroup(session, e.groupId) };
    }),
    schedules,
    records: state.records.filter(canRead),
    locations: manager ? state.locations : state.locations.filter(l => locationIds.has(l.id)),
    shiftTemplates: manager ? state.shiftTemplates : [],
  };
}

export function validateGroup(input, state) {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new DomainError('考勤组名称应为 1 至 80 个字符');
  if (!Array.isArray(input.adminIds) || input.adminIds.length > 100 || new Set(input.adminIds).size !== input.adminIds.length ||
      input.adminIds.some(id => !state.employees.some(e => e.id === id && !e.removed))) throw new DomainError('请选择有效且不重复的组管理员');
  return { name: input.name.trim(), adminIds: [...input.adminIds] };
}

export function migrateGroups(state) {
  if (state.version === 1) {
    state.groups = [{ id: 'default-group', name: '默认考勤组', adminIds: [] }];
    for (const employee of state.employees) { employee.groupId = 'default-group'; employee.orgAdmin = false; }
    for (const schedule of state.schedules) schedule.groupId = 'default-group';
    for (const record of state.records) record.groupId = 'default-group';
    state.version = 2;
  }
  if (state.version !== 2 || !Array.isArray(state.groups) || state.groups.some(g => !g.id || !Array.isArray(g.adminIds))) throw new Error('考勤组数据结构不正确');
  const ids = new Set(state.groups.map(g => g.id));
  if (ids.size !== state.groups.length || state.employees.some(e => e.groupId && !ids.has(e.groupId)) ||
      state.schedules.some(s => !ids.has(s.groupId)) || state.records.some(r => !ids.has(r.groupId))) throw new Error('考勤组关联数据不完整');
  return state;
}
