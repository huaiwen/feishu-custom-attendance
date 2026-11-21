import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError, validateEmployee, validateLocation, validateScheduleBatch, evaluatePunch, clockParts } from './domain.mjs';
import { exchangeCode, getJsapiConfig, getDirectory } from './feishu.mjs';
import { validateShiftTemplate, attendanceSummary } from './schedule-tools.mjs';
import { sessionFor, managesGroup, requireGroup, visibleState, validateGroup, migrateGroups } from './access.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const ZONE = 'Asia/Shanghai';
const MAX_BODY = 128 * 1024;
const SESSION_MS = 8 * 60 * 60 * 1000;

export function configuration(env = process.env) {
  const keys = ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'BASE_URL', 'ADMIN_OPEN_IDS'];
  const enabled = keys.some(key => Boolean(env[key]));
  if (enabled && !keys.every(key => env[key]?.trim())) throw new Error('飞书模式需要同时配置 FEISHU_APP_ID、FEISHU_APP_SECRET、BASE_URL、ADMIN_OPEN_IDS');
  let baseUrl;
  if (enabled) {
    const url = new URL(env.BASE_URL);
    if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('BASE_URL 必须是 HTTPS 根域名，例如 https://attendance.example.com');
    baseUrl = url.origin;
  }
  const port = Number(env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须是有效端口');
  if (!enabled && env.HOST && env.HOST !== '127.0.0.1') throw new Error('本地演示只允许监听 127.0.0.1；请先配置飞书身份验证再部署');
  const adminOpenIds = (env.ADMIN_OPEN_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (enabled && (!adminOpenIds.length || adminOpenIds.some(id => !/^ou_[a-zA-Z0-9]+$/.test(id)))) throw new Error('ADMIN_OPEN_IDS 必须包含有效的管理员 Open ID（ou_ 开头）');
  const amapKey = env.AMAP_JS_KEY?.trim() || '', amapSecurityCode = env.AMAP_SECURITY_JS_CODE?.trim() || '';
  if (Boolean(amapKey) !== Boolean(amapSecurityCode)) throw new Error('高德地图需要同时配置 AMAP_JS_KEY 和 AMAP_SECURITY_JS_CODE');
  if ([amapKey, amapSecurityCode].some(value => value && !/^[a-zA-Z0-9_-]{16,128}$/.test(value))) throw new Error('高德地图配置格式不正确');
  return { mode: enabled ? 'feishu' : 'demo', host: enabled ? (env.HOST || '127.0.0.1') : '127.0.0.1', port, baseUrl,
    appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, adminOpenIds, tenantKey: env.FEISHU_TENANT_KEY, amapKey, amapSecurityCode };
}

function initialState(mode) {
  const state = { version: 1, employees: [], locations: [], schedules: [], records: [], shiftTemplates: [
    { id: 'standard-shift', name: '标准双时段', segments: [{ start: '09:00', end: '12:00' }, { start: '13:30', end: '18:00' }], note: '应用班次后，为员工分别指定每个时段的地点。' }
  ] };
  if (mode !== 'demo') return state;
  state.employees = ['A', 'B', 'C', 'D'].map((letter, i) => ({ id: `emp-${letter.toLowerCase()}`, name: `员工 ${letter}`, department: i < 2 ? '产品研发部' : '运营支持部', employeeNo: `100${i + 1}`, openId: '' }));
  state.locations = [
    { id: 'loc-a', name: 'A 园区', address: '示例地点 · 请替换为实际园区坐标', latitude: 40.0, longitude: 116.32, radius: 300, color: '#148579' },
    { id: 'loc-b', name: 'B 园区', address: '示例地点 · 请替换为实际园区坐标', latitude: 40.01, longitude: 116.34, radius: 300, color: '#5278b5' },
    { id: 'loc-building', name: '1 号楼', address: '示例地点 · 以楼栋中心为圆心', latitude: 40.002, longitude: 116.322, radius: 100, color: '#a67d40' }
  ];
  const today = clockParts().date;
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  for (let day = 0; day < 7; day++) {
    const date = new Date(monday.getTime() + day * 86400000).toISOString().slice(0, 10);
    for (const employee of state.employees) {
      const first = employee.id === 'emp-c' ? 'loc-b' : employee.id === 'emp-d' ? 'loc-building' : 'loc-a';
      const second = employee.id === 'emp-a' ? 'loc-b' : first;
      state.schedules.push({ id: randomUUID(), employeeId: employee.id, date, segments: [{ start: '09:00', end: '12:00', locationId: first }, { start: '13:30', end: '18:00', locationId: second }], note: '示例排班' });
    }
  }
  return state;
}

function persist(file, state) {
  // shortcut: single-process JSON storage; use a database before running multiple instances.
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  const fd = openSync(temporary, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, file);
}

function readState(file, mode) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'));
    if (![1, 2].includes(state.version) || !['employees', 'locations', 'schedules', 'records'].every(key => Array.isArray(state[key]))) throw new Error('数据结构或版本不正确');
    if (state.shiftTemplates !== undefined && !Array.isArray(state.shiftTemplates)) throw new Error('班次模板数据结构不正确');
    state.shiftTemplates ??= [];
    const previousVersion = state.version;
    migrateGroups(state);
    if (previousVersion !== state.version) persist(file, state);
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`读取考勤数据失败，原文件已保留：${error.message}`);
    const state = migrateGroups(initialState(mode));
    persist(file, state);
    return state;
  }
}

async function readBody(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new DomainError('请使用 JSON 请求', 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new DomainError('请求内容过大', 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new DomainError('JSON 格式不正确'); }
}

function cookie(req, name) {
  return (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
}

function csvCell(value) {
  let text = String(value ?? '');
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function createAttendanceServer({ env = process.env, dataFile } = {}) {
  const config = configuration(env);
  const file = resolve(dataFile || join(ROOT, 'data', config.mode === 'demo' ? 'demo.json' : 'attendance.json'));
  let state = readState(file, config.mode);
  const sessions = new Map();
  const oauthStates = new Map();
  const commit = mutate => {
    const next = structuredClone(state);
    const result = mutate(next);
    persist(file, next);
    state = next;
    return result;
  };
  const server = http.createServer(async (req, res) => {
    const json = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    const redirect = url => { res.writeHead(302, { Location: url }); res.end(); };
    const setCookie = (name, value, seconds) => res.setHeader('Set-Cookie', `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${seconds}${config.mode === 'feishu' ? '; Secure' : ''}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'geolocation=(self)');
    const contentSecurityPolicy = "default-src 'self'; script-src 'self' https://lf-scm-cn.feishucdn.com https://webapi.amap.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.amap.com https://*.autonavi.com; connect-src 'self' https://*.amap.com https://*.autonavi.com; worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://*.feishu.cn https://*.larksuite.com";
    res.setHeader('Content-Security-Policy', contentSecurityPolicy);
    try {
      const allowedHosts = config.mode === 'demo' ? [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`] : [new URL(config.baseUrl).host];
      if (!allowedHosts.includes(req.headers.host)) throw new DomainError('无效的访问域名', 403);
      const origin = config.baseUrl || `http://${req.headers.host}`;
      const url = new URL(req.url, origin);
      const now = Date.now();
      for (const [id, session] of sessions) if (session.expires < now) sessions.delete(id);
      for (const [id, pending] of oauthStates) if (pending.expires < now) oauthStates.delete(id);
      const auth = config.mode === 'demo' ? {} : sessions.get(cookie(req, 'attendance_session'));
      // Resolve employee bindings on every request so account changes take effect immediately.
      const currentSession = () => auth && sessionFor(state, auth.openId, config.adminOpenIds, config.mode === 'demo');
      const session = currentSession();
      const requireAuth = () => { if (!session) throw new DomainError('请先使用飞书登录', 401); };
      const requireAdmin = () => { requireAuth(); if (currentSession().role !== 'org_admin') throw new DomainError('此操作需要组织管理员权限', 403); };
      const requireManager = () => { requireAuth(); if (currentSession().role === 'user') throw new DomainError('此操作需要考勤组管理员权限', 403); };
      const scopedState = () => visibleState(state, currentSession(), config.adminOpenIds);
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== origin) throw new DomainError('请求来源校验失败，请从应用页面重试', 403);

      if (url.pathname === '/auth/login' && req.method === 'GET') {
        if (config.mode === 'demo') return redirect('/');
        if (oauthStates.size >= 1000) throw new DomainError('登录请求过多，请稍后重试', 429);
        const nonce = randomBytes(32).toString('hex');
        oauthStates.set(nonce, { expires: now + 300000, returnTo: url.searchParams.get('view') === 'checkin' ? '/#checkin' : '/' });
        setCookie('attendance_oauth', nonce, 300);
        const authorize = new URL('https://accounts.feishu.cn/open-apis/authen/v1/authorize');
        authorize.search = new URLSearchParams({ client_id: config.appId, response_type: 'code', redirect_uri: `${config.baseUrl}/auth/callback`, state: nonce });
        return redirect(authorize.href);
      }
      if (url.pathname === '/auth/callback' && req.method === 'GET') {
        if (config.mode !== 'feishu') throw new DomainError('尚未配置飞书登录');
        const nonce = url.searchParams.get('state');
        if (!nonce || cookie(req, 'attendance_oauth') !== nonce || !oauthStates.has(nonce)) throw new DomainError('登录验证已失效，请重新登录', 403);
        const { returnTo } = oauthStates.get(nonce);
        oauthStates.delete(nonce);
        const code = url.searchParams.get('code');
        if (!code) throw new DomainError('未获得飞书授权，请重新登录', 401);
        let identity;
        try { identity = await exchangeCode({ appId: config.appId, appSecret: config.appSecret, redirectUri: `${config.baseUrl}/auth/callback`, code }); }
        catch { throw new DomainError('飞书登录失败，请检查应用配置、回调地址或重新授权', 502); }
        if (config.tenantKey && identity.tenantKey !== config.tenantKey) throw new DomainError('此账号不属于配置的企业', 403);
        if (!config.adminOpenIds.includes(identity.openId) && !state.employees.some(e => e.openId === identity.openId)) throw new DomainError('尚未加入考勤，请联系管理员从飞书组织中添加你', 403);
        const id = randomBytes(32).toString('hex');
        sessions.set(id, { openId: identity.openId, expires: now + SESSION_MS });
        setCookie('attendance_session', id, SESSION_MS / 1000);
        return redirect(returnTo);
      }
      if (url.pathname === '/auth/logout' && req.method === 'POST') {
        sessions.delete(cookie(req, 'attendance_session'));
        setCookie('attendance_session', '', 0);
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/state' && req.method === 'GET') {
        requireAuth();
        return json(200, { ...scopedState(), mode: config.mode, timezone: ZONE, today: clockParts().date, now: new Date().toISOString(), session, integration: { configured: config.mode === 'feishu', appId: config.appId || null, mapConfigured: Boolean(config.amapKey && config.amapSecurityCode) } });
      }
      if (url.pathname === '/api/maps/config' && req.method === 'GET') {
        requireAdmin();
        if (!config.amapKey || !config.amapSecurityCode) throw new DomainError('高德地图尚未接通，请联系组织管理员完成地图配置', 503);
        return json(200, { key: config.amapKey });
      }
      if (url.pathname.startsWith('/_AMapService/')) {
        requireAdmin();
        if (req.method !== 'GET') throw new DomainError('地图服务仅支持读取', 405);
        if (!config.amapKey || !config.amapSecurityCode) throw new DomainError('高德地图尚未接通', 503);
        const path = url.pathname.slice('/_AMapService'.length);
        const targets = { '/v4/map/styles': 'https://webapi.amap.com', '/v3/place/text': 'https://restapi.amap.com' };
        if (!targets[path] || url.search.length > 4096) throw new DomainError('不支持的地图请求', 400);
        const callback = url.searchParams.get('callback');
        if (callback && !/^[a-zA-Z_$][\w$.]{0,100}$/.test(callback)) throw new DomainError('无效的地图回调', 400);
        const target = new URL(path, targets[path]);
        target.search = url.search;
        target.searchParams.set('key', config.amapKey);
        target.searchParams.set('jscode', config.amapSecurityCode);
        let response, body;
        try {
          response = await fetch(target, { headers: { Referer: `${origin}/` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
          if (!response.ok) throw new Error();
          const chunks = [];let length = 0;
          for await (const chunk of response.body) {
            length += chunk.length;
            if (length > 2 * 1024 * 1024) throw new Error();
            chunks.push(chunk);
          }
          body = Buffer.concat(chunks).toString('utf8').replaceAll(config.amapSecurityCode, '[redacted]');
        } catch { throw new DomainError('高德地图服务暂时不可用，请稍后重试', 502); }
        requireAdmin();
        res.writeHead(200, { 'Content-Type': callback ? 'text/javascript; charset=utf-8' : 'application/json; charset=utf-8' });
        return res.end(body);
      }
      if (url.pathname === '/api/feishu/jsapi-config' && req.method === 'GET') {
        requireAuth();
        if (config.mode !== 'feishu') throw new DomainError('请先配置飞书应用');
        const page = new URL(url.searchParams.get('url') || config.baseUrl);
        if (page.origin !== config.baseUrl || page.username || page.password) throw new DomainError('只能签名当前应用域名', 403);
        page.hash = '';
        try { return json(200, await getJsapiConfig({ appId: config.appId, appSecret: config.appSecret, url: page.href })); }
        catch { throw new DomainError('飞书定位鉴权失败，请检查应用配置和 H5 可信域名', 502); }
      }
      if (url.pathname === '/api/attendance-summary' && req.method === 'GET') {
        requireAuth();
        const from = url.searchParams.get('from') || clockParts().date;
        const to = url.searchParams.get('to') || from;
        return json(200, attendanceSummary(scopedState(), { from, to }));
      }
      const templateMatch = url.pathname.match(/^\/api\/shift-templates(?:\/([^/]+))?$/);
      if (templateMatch && ((req.method === 'POST' && !templateMatch[1]) || (req.method === 'PATCH' && templateMatch[1]))) {
        requireAdmin();
        const input = validateShiftTemplate(await readBody(req));
        requireAdmin();
        const id = templateMatch[1] || randomUUID();
        if (req.method === 'PATCH' && !state.shiftTemplates.some(t => t.id === id)) throw new DomainError('班次模板不存在', 404);
        if (state.shiftTemplates.some(t => t.id !== id && t.name === input.name)) throw new DomainError('班次名称已存在', 409);
        const template = { id, ...input };
        commit(next => { next.shiftTemplates = [...next.shiftTemplates.filter(t => t.id !== id), template]; });
        return json(200, { template });
      }
      if (templateMatch?.[1] && req.method === 'DELETE') {
        requireAdmin();
        if (!state.shiftTemplates.some(t => t.id === templateMatch[1])) throw new DomainError('班次模板不存在', 404);
        commit(next => { next.shiftTemplates = next.shiftTemplates.filter(t => t.id !== templateMatch[1]); });
        return json(200, { ok: true });
      }
      if (url.pathname === '/api/records.csv' && req.method === 'GET') {
        requireManager();
        const rows = [['姓名', '工号', '日期', '时段', '类型', '打卡时间（北京时间）', '地点', '距中心(米)', '精度(米)', '状态', '来源']];
        for (const r of scopedState().records) rows.push([r.employeeName, r.employeeNo, r.date, `${r.scheduledStart}–${r.scheduledEnd}`, r.kind === 'in' ? '上班' : '下班', new Date(r.timestamp).toLocaleString('sv-SE', { timeZone: ZONE }), r.locationName, r.distance, r.accuracy, { normal: '正常', late: '迟到', early: '早退' }[r.status], r.source === 'demo' ? '演示记录' : '飞书']);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="attendance-${clockParts().date}.csv"` });
        return res.end('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
      }
      const groupMatch = url.pathname.match(/^\/api\/groups(?:\/([^/]+))?$/);
      if (groupMatch && ((req.method === 'POST' && !groupMatch[1]) || (req.method === 'PATCH' && groupMatch[1]))) {
        requireAdmin();
        const input = validateGroup(await readBody(req), state);
        requireAdmin();
        const id = groupMatch[1] || randomUUID();
        if (req.method === 'PATCH' && !state.groups.some(g => g.id === id)) throw new DomainError('考勤组不存在', 404);
        if (state.groups.some(g => g.id !== id && g.name === input.name)) throw new DomainError('考勤组名称已存在', 409);
        const group = { id, ...input };
        commit(next => { next.groups = [...next.groups.filter(g => g.id !== id), group]; });
        return json(200, { group });
      }
      if (url.pathname === '/api/directory' && req.method === 'GET') {
        requireManager();
        if (config.mode !== 'feishu') return json(200, { departments: [], users: state.employees.map(e => ({ openId: e.id, name: e.name, department: e.department })), demo: true });
        try {
          const directory = await getDirectory(config);
          requireManager();
          return json(200, directory);
        } catch (error) {
          if (error instanceof DomainError) throw error;
          throw new DomainError(`无法读取飞书组织：${error.message}`, 502);
        }
      }
      if (url.pathname === '/api/employees/import' && req.method === 'POST') {
        requireManager();
        const input = await readBody(req);
        requireGroup(currentSession(), input.groupId, state);
        if (!Array.isArray(input.openIds) || !input.openIds.length || input.openIds.length > 50 ||
            new Set(input.openIds).size !== input.openIds.length || input.openIds.some(id => typeof id !== 'string' || !/^ou_[a-zA-Z0-9]+$/.test(id))) throw new DomainError('请从飞书组织中选择 1 至 50 位成员');
        let users;
        try { users = (await getDirectory(config)).users.filter(user => input.openIds.includes(user.openId)); }
        catch (error) { throw new DomainError(`添加失败：${error.message}`, 502); }
        // Recheck authority after the external lookup; role changes take effect immediately.
        requireManager();
        requireGroup(currentSession(), input.groupId, state);
        if (users.length !== input.openIds.length) throw new DomainError('部分成员不在应用的通讯录授权范围内，请刷新后重试', 403);
        commit(next => {
          for (const user of users) {
            let employee = next.employees.find(e => e.openId === user.openId);
            if (employee && !managesGroup(currentSession(), employee.groupId)) throw new DomainError('不能移动其他考勤组的成员，请联系组织管理员', 403);
            if (!employee) {
              employee = { id: randomUUID(), employeeNo: '', openId: user.openId, orgAdmin: false };
              next.employees.push(employee);
            }
            Object.assign(employee, { name: user.name, department: user.department, groupId: input.groupId });
          }
        });
        return json(200, { count: users.length });
      }
      const accessMatch = url.pathname.match(/^\/api\/employees\/([^/]+)\/access$/);
      if (accessMatch && req.method === 'PATCH') {
        requireAdmin();
        const input = await readBody(req);
        requireAdmin();
        const employee = state.employees.find(e => e.id === accessMatch[1]);
        if (!employee) throw new DomainError('员工不存在', 404);
        requireGroup(currentSession(), input.groupId, state);
        if (!['user', 'group_admin', 'org_admin'].includes(input.role)) throw new DomainError('请选择有效的角色');
        if (!Array.isArray(input.managedGroupIds) || new Set(input.managedGroupIds).size !== input.managedGroupIds.length || input.managedGroupIds.some(id => !state.groups.some(g => g.id === id)) || (input.role === 'group_admin' && !input.managedGroupIds.length)) throw new DomainError('考勤组管理员须选择至少一个负责的组');
        if (config.adminOpenIds.includes(employee.openId) && input.role !== 'org_admin') throw new DomainError('初始组织管理员由服务器配置保留，不能在此撤销', 409);
        commit(next => {
          Object.assign(next.employees.find(e => e.id === employee.id), { groupId: input.groupId, orgAdmin: input.role === 'org_admin' });
          for (const group of next.groups) {
            group.adminIds = group.adminIds.filter(id => id !== employee.id);
            if (input.role === 'group_admin' && input.managedGroupIds.includes(group.id)) group.adminIds.push(employee.id);
          }
        });
        return json(200, { ok: true });
      }
      const employeeMatch = url.pathname.match(/^\/api\/employees(?:\/([^/]+))?$/);
      if (employeeMatch && ['POST', 'PATCH'].includes(req.method)) {
        requireAdmin();
        if (config.mode === 'feishu') throw new DomainError('请从飞书组织选择成员；已绑定身份不能手动改写', 403);
        const input = validateEmployee(await readBody(req));
        requireAdmin();
        const id = req.method === 'PATCH' ? employeeMatch[1] : randomUUID();
        if (req.method === 'PATCH' && !state.employees.some(e => e.id === id)) throw new DomainError('员工不存在', 404);
        if (state.employees.some(e => e.id !== id && (e.employeeNo === input.employeeNo || (input.openId && e.openId === input.openId)))) throw new DomainError('工号或飞书 Open ID 已被其他员工使用', 409);
        const employee = { ...state.employees.find(e => e.id === id), id, groupId: state.employees.find(e => e.id === id)?.groupId || state.groups[0].id, ...input };
        commit(next => { next.employees = [...next.employees.filter(e => e.id !== id), employee]; });
        return json(200, { employee });
      }
      const locationMatch = url.pathname.match(/^\/api\/locations(?:\/([^/]+))?$/);
      if (locationMatch && ['POST', 'PATCH'].includes(req.method)) {
        requireAdmin();
        const input = validateLocation(await readBody(req));
        requireAdmin();
        const id = req.method === 'PATCH' ? locationMatch[1] : randomUUID();
        if (req.method === 'PATCH' && !state.locations.some(l => l.id === id)) throw new DomainError('地点不存在', 404);
        const location = { id, ...input };
        commit(next => { next.locations = [...next.locations.filter(l => l.id !== id), location]; });
        return json(200, { location });
      }
      if (url.pathname === '/api/schedules' && req.method === 'POST') {
        requireManager();
        const input = validateScheduleBatch(await readBody(req), state);
        for (const employeeId of input.employeeIds) requireGroup(currentSession(), state.employees.find(e => e.id === employeeId).groupId, state);
        const existing = state.schedules.filter(s => input.employeeIds.includes(s.employeeId) && input.dates.includes(s.date));
        for (const schedule of existing) requireGroup(currentSession(), schedule.groupId, state);
        if (existing.length && !input.overwrite) throw new DomainError(`有 ${existing.length} 条已有排班，请确认覆盖后重试`, 409);
        if (existing.some(s => state.records.some(r => r.scheduleId === s.id))) throw new DomainError('所选排班已有打卡记录，不能覆盖；请选择其他日期', 409);
        commit(next => {
          const ids = new Set(existing.map(s => s.id));
          next.schedules = next.schedules.filter(s => !ids.has(s.id));
          for (const employeeId of input.employeeIds) for (const date of input.dates) next.schedules.push({ id: randomUUID(), employeeId, groupId: next.employees.find(e => e.id === employeeId).groupId, date, segments: input.segments, note: input.note });
        });
        return json(200, { count: input.employeeIds.length * input.dates.length });
      }
      const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch && req.method === 'DELETE') {
        requireManager();
        const id = scheduleMatch[1];
        const schedule = state.schedules.find(s => s.id === id);
        if (!schedule) throw new DomainError('排班不存在', 404);
        requireGroup(currentSession(), schedule.groupId, state);
        if (state.records.some(r => r.scheduleId === id)) throw new DomainError('已有打卡记录，不能删除该排班', 409);
        commit(next => { next.schedules = next.schedules.filter(s => s.id !== id); });
        return json(200, { ok: true });
      }
      if (['/api/checkin', '/api/checkin/preview'].includes(url.pathname) && req.method === 'POST') {
        requireAuth();
        const preview = url.pathname.endsWith('/preview');
        if (preview && config.mode !== 'demo') throw new DomainError('规则试算仅在本地演示开放', 403);
        const input = await readBody(req);
        if (config.mode === 'feishu' && input.employeeId !== session.employeeId) throw new DomainError('只能为本人打卡', 403);
        const timestamp = preview && input.timestamp ? new Date(input.timestamp) : new Date();
        if (!Number.isFinite(timestamp.getTime())) throw new DomainError('试算时间格式不正确');
        const draft = evaluatePunch(preview ? { ...state, records: [] } : state, input, timestamp);
        const employee = state.employees.find(e => e.id === draft.employeeId);
        const location = state.locations.find(l => l.id === draft.locationId);
        const segment = state.schedules.find(s => s.id === draft.scheduleId).segments[draft.segmentIndex];
        const record = { ...draft, id: randomUUID(), groupId: state.schedules.find(s => s.id === draft.scheduleId).groupId, source: config.mode, employeeNo: employee.employeeNo,
          latitude: input.latitude, longitude: input.longitude, locatedAt: input.locatedAt,
          radius: location.radius, coordinateSystem: input.coordinateSystem, centerCoordinateSystem: location.coordinateSystem || 'wgs84', centerLatitude: location.latitude, centerLongitude: location.longitude, scheduledStart: segment.start, scheduledEnd: segment.end };
        if (!preview) commit(next => { next.records.push(record); });
        return json(200, { preview, record });
      }
      if (url.pathname.startsWith('/api/')) throw new DomainError('接口不存在', 404);
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      for (const path of ['location-map.mjs', 'vendor/gcoord.mjs']) files[`/${path}`] = [path, 'text/javascript'];
      const asset = files[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(req.method)) throw new DomainError('页面不存在', 404);
      // AMap dynamically compiles its plugins; keep this exception off employee and signed-out pages.
      if (asset[1] === 'text/html' && config.amapKey && session?.role === 'org_admin') res.setHeader('Content-Security-Policy', contentSecurityPolicy.replace("script-src 'self'", "script-src 'self' 'unsafe-eval' https://jsapi-service.amap.com"));
      res.writeHead(200, { 'Content-Type': `${asset[1]}; charset=utf-8` });
      res.end(req.method === 'HEAD' ? undefined : readFileSync(join(ROOT, 'public', asset[0])));
    } catch (error) {
      if (res.headersSent) return res.end();
      const status = error instanceof DomainError ? error.status : 500;
      if (status === 500) console.error('Request failed:', error.name);
      json(status, { error: status === 500 ? '服务暂时不可用，请稍后重试；数据未更新' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return { server, config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { server, config } = createAttendanceServer();
    server.on('error', error => { console.error(`服务启动失败：${error.code}，请检查端口占用与监听权限`); process.exitCode = 1; });
    server.listen(config.port, config.host, () => console.log(`自定义考勤 · ${config.mode === 'demo' ? '本地演示' : '飞书模式'} · ${config.baseUrl || `http://${config.host}:${server.address().port}`}`));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
