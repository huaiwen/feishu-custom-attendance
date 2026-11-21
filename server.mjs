import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, renameSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { DomainError, validateEmployee, validateLocation, validateScheduleBatch, evaluatePunch, clockParts } from './domain.mjs';
import { exchangeCode, getJsapiConfig } from './feishu.mjs';
import { validateShiftTemplate, attendanceSummary } from './schedule-tools.mjs';

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
  return { mode: enabled ? 'feishu' : 'demo', host: enabled ? (env.HOST || '127.0.0.1') : '127.0.0.1', port, baseUrl,
    appId: env.FEISHU_APP_ID, appSecret: env.FEISHU_APP_SECRET, adminOpenIds, tenantKey: env.FEISHU_TENANT_KEY };
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
    if (state.version !== 1 || !['employees', 'locations', 'schedules', 'records'].every(key => Array.isArray(state[key]))) throw new Error('数据结构或版本不正确');
    if (state.shiftTemplates !== undefined && !Array.isArray(state.shiftTemplates)) throw new Error('班次模板数据结构不正确');
    state.shiftTemplates ??= [];
    return state;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`读取考勤数据失败，原文件已保留：${error.message}`);
    const state = initialState(mode);
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
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Permissions-Policy', 'geolocation=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' https://lf-scm-cn.feishucdn.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://*.feishu.cn https://*.larksuite.com");
    try {
      const allowedHosts = config.mode === 'demo' ? [`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`] : [new URL(config.baseUrl).host];
      if (!allowedHosts.includes(req.headers.host)) throw new DomainError('无效的访问域名', 403);
      const origin = config.baseUrl || `http://${req.headers.host}`;
      const url = new URL(req.url, origin);
      const now = Date.now();
      for (const [id, session] of sessions) if (session.expires < now) sessions.delete(id);
      for (const [id, pending] of oauthStates) if (pending.expires < now) oauthStates.delete(id);
      const auth = config.mode === 'demo' ? { role: 'admin', employeeId: null } : sessions.get(cookie(req, 'attendance_session'));
      // Resolve employee bindings on every request so account changes take effect immediately.
      const session = auth && config.mode === 'feishu' ? { role: config.adminOpenIds.includes(auth.openId) ? 'admin' : 'employee', employeeId: state.employees.find(e => e.openId === auth.openId)?.id || null, openId: auth.openId } : auth;
      const requireAuth = () => { if (!session) throw new DomainError('请先使用飞书登录', 401); };
      const requireAdmin = () => { requireAuth(); if (session.role !== 'admin') throw new DomainError('此操作需要考勤管理员权限', 403); };
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
        if (!config.adminOpenIds.includes(identity.openId) && !state.employees.some(e => e.openId === identity.openId)) throw new DomainError(`尚未添加到考勤人员，请将 Open ID ${identity.openId} 交给管理员绑定`, 403);
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
        const admin = session.role === 'admin';
        const visible = { ...state,
          shiftTemplates: admin ? state.shiftTemplates : [],
          employees: state.employees.filter(e => admin || e.id === session.employeeId).map(e => admin ? e : { id: e.id, name: e.name, department: e.department, employeeNo: e.employeeNo }),
          schedules: state.schedules.filter(s => admin || s.employeeId === session.employeeId),
          records: state.records.filter(r => admin || r.employeeId === session.employeeId) };
        return json(200, { ...visible, mode: config.mode, timezone: ZONE, today: clockParts().date, now: new Date().toISOString(), session: { role: session.role, employeeId: session.employeeId }, integration: { configured: config.mode === 'feishu', appId: config.appId || null } });
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
        const ownState = session.role === 'admin' ? state : { ...state,
          employees: state.employees.filter(e => e.id === session.employeeId),
          schedules: state.schedules.filter(s => s.employeeId === session.employeeId),
          records: state.records.filter(r => r.employeeId === session.employeeId) };
        return json(200, attendanceSummary(ownState, { from, to }));
      }
      const templateMatch = url.pathname.match(/^\/api\/shift-templates(?:\/([^/]+))?$/);
      if (templateMatch && ((req.method === 'POST' && !templateMatch[1]) || (req.method === 'PATCH' && templateMatch[1]))) {
        requireAdmin();
        const input = validateShiftTemplate(await readBody(req));
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
        requireAdmin();
        const rows = [['姓名', '工号', '日期', '时段', '类型', '打卡时间（北京时间）', '地点', '距中心(米)', '精度(米)', '状态', '来源']];
        for (const r of state.records) rows.push([r.employeeName, r.employeeNo, r.date, `${r.scheduledStart}–${r.scheduledEnd}`, r.kind === 'in' ? '上班' : '下班', new Date(r.timestamp).toLocaleString('sv-SE', { timeZone: ZONE }), r.locationName, r.distance, r.accuracy, { normal: '正常', late: '迟到', early: '早退' }[r.status], r.source === 'demo' ? '演示记录' : '飞书']);
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="attendance-${clockParts().date}.csv"` });
        return res.end('\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n'));
      }
      const employeeMatch = url.pathname.match(/^\/api\/employees(?:\/([^/]+))?$/);
      if (employeeMatch && ['POST', 'PATCH'].includes(req.method)) {
        requireAdmin();
        const input = validateEmployee(await readBody(req));
        const id = req.method === 'PATCH' ? employeeMatch[1] : randomUUID();
        if (req.method === 'PATCH' && !state.employees.some(e => e.id === id)) throw new DomainError('员工不存在', 404);
        if (state.employees.some(e => e.id !== id && (e.employeeNo === input.employeeNo || (input.openId && e.openId === input.openId)))) throw new DomainError('工号或飞书 Open ID 已被其他员工使用', 409);
        const employee = { id, ...input };
        commit(next => { next.employees = [...next.employees.filter(e => e.id !== id), employee]; });
        return json(200, { employee });
      }
      const locationMatch = url.pathname.match(/^\/api\/locations(?:\/([^/]+))?$/);
      if (locationMatch && ['POST', 'PATCH'].includes(req.method)) {
        requireAdmin();
        const input = validateLocation(await readBody(req));
        const id = req.method === 'PATCH' ? locationMatch[1] : randomUUID();
        if (req.method === 'PATCH' && !state.locations.some(l => l.id === id)) throw new DomainError('地点不存在', 404);
        const location = { id, ...input };
        commit(next => { next.locations = [...next.locations.filter(l => l.id !== id), location]; });
        return json(200, { location });
      }
      if (url.pathname === '/api/schedules' && req.method === 'POST') {
        requireAdmin();
        const input = validateScheduleBatch(await readBody(req), state);
        const existing = state.schedules.filter(s => input.employeeIds.includes(s.employeeId) && input.dates.includes(s.date));
        if (existing.length && !input.overwrite) throw new DomainError(`有 ${existing.length} 条已有排班，请确认覆盖后重试`, 409);
        if (existing.some(s => state.records.some(r => r.scheduleId === s.id))) throw new DomainError('所选排班已有打卡记录，不能覆盖；请选择其他日期', 409);
        commit(next => {
          const ids = new Set(existing.map(s => s.id));
          next.schedules = next.schedules.filter(s => !ids.has(s.id));
          for (const employeeId of input.employeeIds) for (const date of input.dates) next.schedules.push({ id: randomUUID(), employeeId, date, segments: input.segments, note: input.note });
        });
        return json(200, { count: input.employeeIds.length * input.dates.length });
      }
      const scheduleMatch = url.pathname.match(/^\/api\/schedules\/([^/]+)$/);
      if (scheduleMatch && req.method === 'DELETE') {
        requireAdmin();
        const id = scheduleMatch[1];
        if (!state.schedules.some(s => s.id === id)) throw new DomainError('排班不存在', 404);
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
        const record = { ...draft, id: randomUUID(), source: config.mode, employeeNo: employee.employeeNo,
          latitude: input.latitude, longitude: input.longitude, locatedAt: input.locatedAt,
          radius: location.radius, coordinateSystem: location.coordinateSystem || 'wgs84', centerLatitude: location.latitude, centerLongitude: location.longitude, scheduledStart: segment.start, scheduledEnd: segment.end };
        if (!preview) commit(next => { next.records.push(record); });
        return json(200, { preview, record });
      }
      if (url.pathname.startsWith('/api/')) throw new DomainError('接口不存在', 404);
      const files = { '/': ['index.html', 'text/html'], '/index.html': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/styles.css': ['styles.css', 'text/css'] };
      const asset = files[url.pathname];
      if (!asset || !['GET', 'HEAD'].includes(req.method)) throw new DomainError('页面不存在', 404);
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
