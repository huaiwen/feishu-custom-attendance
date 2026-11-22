import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createAttendanceServer, configuration } from '../server.mjs';
import { clockParts } from '../domain.mjs';

async function start(file, env = { PORT: '0' }) {
  const app = createAttendanceServer({ env, dataFile: file });
  // The sandbox forbids listening sockets; exercise the real request handler in process.
  app.server.address = () => ({ port: 4173 });
  app.url = 'http://127.0.0.1:4173';
  app.request = async (path, { method = 'GET', data, headers = {}, ...options } = {}) => {
    const body = data === undefined ? options.body : JSON.stringify(data);
    const req = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
    req.method = method;
    req.url = path;
    req.headers = Object.fromEntries(Object.entries({ Host: '127.0.0.1:4173', Origin: app.url, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }).map(([key, value]) => [key.toLowerCase(), value]));
    return new Promise(resolve => {
      const responseHeaders = new Headers();
      const res = {
        headersSent: false,
        status: 200,
        setHeader(name, value) { responseHeaders.set(name, value); },
        writeHead(status, values) {
          this.status = status;
          this.headersSent = true;
          for (const [name, value] of Object.entries(values || {})) this.setHeader(name, value);
        },
        end(value) { resolve(new Response(value, { status: this.status, headers: responseHeaders })); },
      };
      app.server.emit('request', req, res);
    });
  };
  app.state = async () => (await app.request('/api/state')).json();
  app.close = async () => { app.server.removeAllListeners(); };
  return app;
}

async function fixture(t, env) {
  const directory = await mkdtemp(join(tmpdir(), 'daka-server-test-'));
  const file = join(directory, 'state.json');
  const app = await start(file, env);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  return { app, file };
}

const employee = { name: '测试员工', department: '测试部门', employeeNo: 'T001', openId: '' };
const location = { name: '测试园区', address: '测试地址', latitude: 40, longitude: 116, radius: 100, color: '#168b81' };

test('Shift templates persist independently of applied schedules, and summaries validate date ranges', async t => {
  const { app } = await fixture(t);
  const before = await app.state();
  const input = { name: '午后班', segments: [{ start: '13:00', end: '17:00',locationId:before.locations[0].id }], note: '' };
  const created = await (await app.request('/api/shift-templates', { method: 'POST', data: input })).json();
  assert.ok(created.template.id);
  assert.deepEqual(created.template.segments,input.segments);
  assert.equal((await app.request('/api/shift-templates', { method: 'POST', data: { ...input, segments: [{...input.segments[0],locationId:'unknown'}] } })).status, 400);
  assert.equal((await app.request('/api/shift-templates', { method: 'POST', data: input })).status, 409);
  assert.equal((await app.request(`/api/shift-templates/${created.template.id}`, { method: 'PATCH', data: { ...input, name: '午后短班' } })).status, 200);
  assert.equal((await app.state()).shiftTemplates.find(s => s.id === created.template.id).name, '午后短班');
  assert.equal((await app.request(`/api/shift-templates/${created.template.id}`, { method: 'DELETE', data: {} })).status, 200);
  assert.deepEqual((await app.state()).schedules, before.schedules);
  const summary = await (await app.request(`/api/attendance-summary?from=${before.today}&to=${before.today}`)).json();
  assert.equal(summary.rows.length, 4);
  assert.equal(summary.totals.expectedCount, 16);
  assert.equal(summary.totals.punchedCount, 0);
  assert.equal(summary.totals.missingCount + summary.totals.pendingCount, 16);
  assert.equal((await app.request('/api/attendance-summary?from=2026-01-01&to=2026-03-01')).status, 400);
});

test('CRUD validates values and uniqueness, keeps data across a restart', async t => {
  const { app, file } = await fixture(t);
  const seeded = await app.state();
  assert.equal(seeded.mode, 'demo');
  assert.equal(seeded.employees.length, 4);
  assert.equal(seeded.schedules.length, 28);
  const created = await (await app.request('/api/employees', { method: 'POST', data: employee })).json();
  assert.ok(created.employee.id);
  assert.equal((await app.request('/api/employees', { method: 'POST', data: employee })).status, 409);
  assert.equal((await app.request(`/api/employees/${created.employee.id}`, { method: 'PATCH', data: { ...employee, name: '已更新员工' } })).status, 200);
  assert.equal((await app.request('/api/locations', { method: 'POST', data: { ...location, latitude: null } })).status, 400);
  const createdLocation = await (await app.request('/api/locations', { method: 'POST', data: location })).json();
  assert.equal((await app.request(`/api/locations/${createdLocation.location.id}`, { method: 'PATCH', data: { ...location, radius: 120 } })).status, 200);
  await app.close();
  const restarted = await start(file);
  t.after(() => restarted.close());
  const persisted = await restarted.state();
  assert.equal(persisted.employees.find(e => e.id === created.employee.id).name, '已更新员工');
  assert.equal(persisted.locations.find(l => l.id === createdLocation.location.id).radius, 120);
  assert.equal((await restarted.request(`/api/locations/${createdLocation.location.id}`, { method: 'DELETE' })).status, 200);
  assert.ok(!(await restarted.state()).locations.some(l => l.id === createdLocation.location.id));
  assert.equal((await restarted.request('/api/locations/loc-a', { method: 'DELETE' })).status, 409);
});

test('Host, Origin, JSON body and protected file paths are enforced', async t => {
  const { app } = await fixture(t);
  assert.equal((await app.request('/api/state', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await app.request('/api/employees', { method: 'POST', data: employee, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await app.request('/api/employees', { method: 'POST', body: '{}', headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await app.request('/api/employees', { method: 'POST', body: '{', headers: { 'Content-Type': 'application/json' } })).status, 400);
  assert.equal((await app.request('/api/employees', { method: 'POST', data: [] })).status, 400);
  assert.equal((await app.request('/api/employees', { method: 'POST', data: { ...employee, name: 'x'.repeat(130 * 1024) } })).status, 413);
  assert.equal((await app.request('/data/demo.json')).status, 404);
  assert.equal((await app.state()).employees.length, 4);
});

test('Batch schedules are atomic, require explicit overwrite and can be deleted', async t => {
  const { app } = await fixture(t);
  const state = await app.state();
  const data = { employeeIds: state.employees.slice(0, 2).map(e => e.id), dates: ['2040-01-05', '2040-01-06'], segments: [{ start: '09:00', end: '17:00', locationId: state.locations[0].id }] };
  assert.equal((await app.request('/api/schedules', { method: 'POST', data: { ...data, dates: [...data.dates, '2040-02-30'] } })).status, 400);
  assert.equal((await app.state()).schedules.length, state.schedules.length);
  const response = await app.request('/api/schedules', { method: 'POST', data });
  assert.deepEqual(await response.json(), { count: 4 });
  const saved = await app.state();
  assert.equal(saved.schedules.length, state.schedules.length + 4);
  assert.equal((await app.request('/api/schedules', { method: 'POST', data })).status, 409);
  assert.deepEqual((await app.state()).schedules, saved.schedules);
  assert.equal((await app.request('/api/schedules', { method: 'POST', data: { ...data, overwrite: true, note: '更新' } })).status, 200);
  const updated = (await app.state()).schedules.find(s => s.date === data.dates[0]);
  assert.equal(updated.note, '更新');
  const edit = {employeeIds:[updated.employeeId],segments:data.segments,dates:[data.dates[1]],replaceScheduleId:updated.id};
  assert.equal((await app.request('/api/schedules',{method:'POST',data:edit})).status,409);
  assert.ok((await app.state()).schedules.some(s => s.id === updated.id));
  const target = '2040-01-07';
  assert.equal((await app.request('/api/schedules',{method:'POST',data:{...edit,dates:[target]}})).status,200);
  const changed = (await app.state()).schedules.filter(s => s.employeeId === updated.employeeId);
  assert.ok(!changed.some(s => s.date === updated.date));
  const moved = changed.find(s => s.date === target);
  assert.ok(moved);
  assert.equal((await app.request(`/api/schedules/${moved.id}`, { method: 'DELETE' })).status, 200);
  assert.equal((await app.request(`/api/schedules/${updated.id}`, { method: 'DELETE' })).status, 404);
});

test('Rule preview uses supplied demonstration time and never persists a punch', async t => {
  const { app, file } = await fixture(t);
  const state = await app.state();
  const schedule = state.schedules.find(s => s.date === state.today);
  const point = state.locations.find(l => l.id === schedule.segments[0].locationId);
  const timestamp = `${state.today}T09:00:00+08:00`;
  const before = await readFile(file, 'utf8');
  const response = await app.request('/api/checkin/preview', { method: 'POST', data: { employeeId: schedule.employeeId, scheduleId: schedule.id, segmentIndex: 0, kind: 'in', latitude: point.latitude, longitude: point.longitude, accuracy: 5, locatedAt: timestamp, timestamp, coordinateSystem: 'wgs84' } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.preview, true);
  assert.equal(result.record.status, 'normal');
  assert.equal((await app.state()).records.length, 0);
  assert.equal(await readFile(file, 'utf8'), before);
});

test('A punched schedule can be deleted and replaced without losing its punch or duplicating the day in reports', async t => {
  const { app, file } = await fixture(t);
  const state = await app.state();
  const created = await (await app.request('/api/employees', { method: 'POST', data: { ...employee, name: '=SUM("1",2)', employeeNo: '+001' } })).json();
  const scheduleData = { employeeIds: [created.employee.id], dates: [state.today], segments: [{ start: '00:00', end: '23:59', locationId: state.locations[0].id }] };
  assert.equal((await app.request('/api/schedules', { method: 'POST', data: scheduleData })).status, 200);
  const schedule = (await app.state()).schedules.find(s => s.employeeId === created.employee.id);
  const data = { employeeId: created.employee.id, scheduleId: schedule.id, segmentIndex: 0, kind: 'out', latitude: state.locations[0].latitude, longitude: state.locations[0].longitude, accuracy: 5, locatedAt: new Date().toISOString(), timestamp: '2000-01-01T00:00:00Z', coordinateSystem: 'wgs84' };
  const responses = await Promise.all([app.request('/api/checkin', { method: 'POST', data }), app.request('/api/checkin', { method: 'POST', data })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [200, 409]);
  const saved = await app.state();
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].source, 'demo');
  assert.ok(Math.abs(Date.now() - Date.parse(saved.records[0].timestamp)) < 5000);
  assert.equal((await app.request('/api/schedules', { method: 'POST', data: { ...scheduleData, overwrite: true } })).status, 409);
  assert.equal((await app.request(`/api/schedules/${schedule.id}`, { method: 'DELETE' })).status, 200);
  const afterDelete = await app.state();
  assert.ok(!afterDelete.schedules.some(s => s.id === schedule.id));
  assert.deepEqual(afterDelete.records, saved.records);
  const archived = JSON.parse(await readFile(file,'utf8')).schedules.find(s => s.id === schedule.id);
  assert.ok(archived.cancelledAt);
  assert.deepEqual(archived.segments, schedule.segments);
  const stale = await app.request('/api/checkin', { method:'POST', data:{ ...data, kind:'in' } });
  assert.equal(stale.status,409);
  assert.match((await stale.json()).error,/排班已删除/);
  assert.equal((await app.request(`/api/schedules/${schedule.id}`, { method:'DELETE' })).status,404);
  assert.equal((await app.request('/api/schedules', { method:'POST', data:scheduleData })).status,200);
  const replacement = (await app.state()).schedules.find(s => s.employeeId === created.employee.id);
  assert.notEqual(replacement.id,schedule.id);
  const summary = await (await app.request(`/api/attendance-summary?from=${state.today}&to=${state.today}`)).json();
  const rows = summary.rows.filter(r => r.employeeId === created.employee.id);
  assert.equal(rows.length,1);
  assert.equal(rows[0].punchedCount,1);
  const cutoff = clockParts(new Date(archived.cancelledAt));
  assert.equal(rows[0].expectedCount, cutoff.date > state.today || cutoff.minutes === 1439 ? 4 : 3);
  const csv = await (await app.request('/api/records.csv')).text();
  assert.ok(csv.includes('"\'=SUM(""1"",2)"'));
  assert.ok(csv.includes('"\'+001"'));
  assert.ok(csv.includes('演示记录'));
});

test('Production configuration rejects partial and insecure setup; unauthenticated users cannot read state', async t => {
  assert.throws(() => configuration({ FEISHU_APP_ID: 'cli_test' }), /同时配置/);
  assert.throws(() => configuration({ HOST: '0.0.0.0' }), /127.0.0.1/);
  const env = { PORT: '0', FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'test-secret', BASE_URL: 'https://attendance.example.com', ADMIN_OPEN_IDS: 'ou_admin' };
  assert.throws(() => configuration({ ...env, ADMIN_OPEN_IDS: ', , ' }), /管理员 Open ID/);
  assert.throws(() => configuration({ ...env, BASE_URL: 'http://attendance.example.com' }), /HTTPS/);
  assert.throws(() => configuration({ ...env, BASE_URL: 'https://attendance.example.com/app' }), /根域名/);
  const { app } = await fixture(t, env);
  const headers = { Host: 'attendance.example.com', Origin: env.BASE_URL };
  assert.equal((await app.request('/api/state', { headers })).status, 401);
  assert.equal((await app.request('/api/records.csv', { headers })).status, 401);
  assert.equal((await app.request('/api/employees', { method: 'POST', data: employee, headers })).status, 401);
  const login = await app.request('/auth/login', { headers });
  assert.equal(login.status, 302);
  assert.ok(login.headers.get('set-cookie').includes('HttpOnly; SameSite=Lax; Max-Age=300; Secure'));
  const destination = new URL(login.headers.get('location'));
  assert.equal(destination.hostname, 'accounts.feishu.cn');
  assert.equal(destination.searchParams.get('redirect_uri'), `${env.BASE_URL}/auth/callback`);
  assert.equal((await app.request('/auth/callback?state=wrong&code=wrong', { headers })).status, 403);
});

test('OAuth sessions enforce employee isolation, administrator access and logout', { concurrency: false }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'daka-oauth-test-'));
  const file = join(directory, 'state.json');
  const employees = [
    { ...employee, id: 'worker', employeeNo: 'W001', openId: 'ou_worker' },
    { ...employee, id: 'other', employeeNo: 'W002', openId: 'ou_other' },
  ];
  await writeFile(file, JSON.stringify({ version: 1, employees, locations: [{ ...location, id: 'office' }],
    schedules: employees.map(e => ({ id: `schedule-${e.id}`, employeeId: e.id, date: '2026-11-23', segments: [{ start: '09:00', end: '18:00', locationId: 'office' }], note: '' })),
    records: employees.map(e => ({ id: `record-${e.id}`, employeeId: e.id, scheduleId: `schedule-${e.id}`, date: '2026-11-23', segmentIndex: 0, kind: 'in', timestamp: '2026-11-23T01:00:00Z', source: 'feishu', status: 'normal' })),
    shiftTemplates: [{ id: 'template', name: '标准班', segments: [{ start: '09:00', end: '18:00' }], note: '' }],
  }));
  const env = { PORT: '0', FEISHU_APP_ID: 'cli_test', FEISHU_APP_SECRET: 'test-secret', BASE_URL: 'https://attendance.example.com', ADMIN_OPEN_IDS: 'ou_admin', FEISHU_TENANT_KEY: 'tenant-test' };
  const app = await start(file, env);
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  const headers = { Host: 'attendance.example.com', Origin: env.BASE_URL };
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url === 'https://open.feishu.cn/open-apis/authen/v2/oauth/token') {
      const body = JSON.parse(options.body);
      assert.equal(body.client_id, env.FEISHU_APP_ID);
      assert.equal(body.client_secret, env.FEISHU_APP_SECRET);
      assert.equal(body.redirect_uri, `${env.BASE_URL}/auth/callback`);
      assert.equal(body.grant_type, 'authorization_code');
      assert.ok(['worker', 'admin'].includes(body.code));
      return Response.json({ code: 0, access_token: `access-${body.code}`, token_type: 'Bearer', expires_in: 7200 });
    }
    if (url === 'https://open.feishu.cn/open-apis/authen/v1/user_info') {
      const identity = { 'Bearer access-worker': 'ou_worker', 'Bearer access-admin': 'ou_admin' }[options.headers.Authorization];
      assert.ok(identity);
      return Response.json({ code: 0, data: { open_id: identity, name: identity, tenant_key: 'tenant-test' } });
    }
    assert.fail(`Unexpected external request: ${url}`);
  });
  async function login(code, target = '') {
    const response = await app.request('/auth/login' + target, { headers });
    assert.equal(response.status, 302);
    const nonce = new URL(response.headers.get('location')).searchParams.get('state');
    const oauthCookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.request(`/auth/callback?state=wrong&code=${code}`, { headers: { ...headers, Cookie: oauthCookie } })).status, 403);
    const callback = `/auth/callback?state=${nonce}&code=${code}`;
    const authorized = await app.request(callback, { headers: { ...headers, Cookie: oauthCookie } });
    assert.equal(authorized.status, 302);
    assert.equal(authorized.headers.get('location'), target ? '/?recordDate=2026-11-23&group=default-group#records' : '/');
    assert.match(authorized.headers.get('set-cookie'), /attendance_session=[0-9a-f]{64};.*HttpOnly;.*Secure/);
    assert.equal((await app.request(callback, { headers: { ...headers, Cookie: oauthCookie } })).status, 403);
    return { ...headers, Cookie: authorized.headers.get('set-cookie').split(';')[0] };
  }
  const workerHeaders = await login('worker','?view=records&recordDate=2026-11-23&group=default-group&redirect=https://evil.example');
  const timing = {stage:'locate',durationMs:15300,outcome:'ok'};
  const timingLogs = t.mock.method(console,'info',() => {});
  const beforeTiming = await readFile(file,'utf8');
  assert.equal((await app.request('/api/location-timing',{method:'POST',headers,data:timing})).status,401);
  assert.equal((await app.request('/api/location-timing',{method:'POST',headers:{...workerHeaders,Origin:'https://evil.example'},data:timing})).status,403);
  for (const data of [{...timing,latitude:40},{...timing,openId:'ou_worker'},{...timing,durationMs:-1},{...timing,durationMs:180001},{...timing,durationMs:'500'},{...timing,stage:'unknown'},{...timing,outcome:'raw SDK error'}]) {
    assert.equal((await app.request('/api/location-timing',{method:'POST',headers:workerHeaders,data})).status,400);
  }
  for(let i=0;i<30;i++) assert.equal((await app.request('/api/location-timing',{method:'POST',headers:workerHeaders,data:timing})).status,200);
  assert.equal((await app.request('/api/location-timing',{method:'POST',headers:workerHeaders,data:timing})).status,429);
  assert.deepEqual(timingLogs.mock.calls[0].arguments,['location-timing',JSON.stringify(timing)]);
  assert.equal(timingLogs.mock.calls.length,30);
  assert.equal(await readFile(file,'utf8'),beforeTiming,'diagnostics never change attendance data');
  const visible = await (await app.request('/api/state', { headers: workerHeaders })).json();
  assert.deepEqual(visible.session, { role: 'user', employeeId: 'worker', managedGroupIds: [] });
  assert.deepEqual(visible.employees.map(e => e.id), ['worker']);
  assert.equal(visible.employees[0].openId, undefined);
  assert.deepEqual(visible.schedules.map(s => s.employeeId), ['worker']);
  assert.deepEqual(visible.records.map(r => r.employeeId), ['worker']);
  assert.deepEqual(visible.shiftTemplates, []);
  const ownSummary = await (await app.request('/api/attendance-summary?from=2026-11-23&to=2026-11-23', { headers: workerHeaders })).json();
  assert.deepEqual(ownSummary.rows.map(r => r.employeeId), ['worker']);
  assert.equal((await app.request('/api/shift-templates', { method: 'POST', data: {}, headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/shift-templates/template', { method: 'DELETE', headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/employees', { method: 'POST', data: employee, headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/locations', { method: 'POST', data: location, headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/schedules', { method: 'POST', data: {}, headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/schedules/schedule-worker', { method: 'DELETE', headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/records.csv', { headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/checkin', { method: 'POST', data: { employeeId: 'other' }, headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/checkin/preview', { method: 'POST', data: { employeeId: 'worker' }, headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/feishu/jsapi-config?url=https%3A%2F%2Fevil.example%2F', { headers: workerHeaders })).status, 403);
  const adminHeaders = await login('admin');
  const all = await (await app.request('/api/state', { headers: adminHeaders })).json();
  assert.equal(all.session.role, 'org_admin');
  assert.equal(all.employees.length, 2);
  assert.equal(all.schedules.length, 2);
  assert.equal(all.records.length, 2);
  assert.equal(all.employees[0].bound, true);
  assert.equal((await app.request('/api/locations', { method: 'POST', data: location, headers: adminHeaders })).status, 200);
  assert.equal((await app.request('/api/employees/other', { method: 'DELETE', headers: workerHeaders })).status, 403);
  assert.equal((await app.request('/api/employees/worker', { method: 'DELETE', headers: adminHeaders })).status, 200);
  assert.equal((await app.request('/api/state', { headers: workerHeaders })).status, 401);
  const afterRemoval = await (await app.request('/api/state', { headers: adminHeaders })).json();
  assert.equal(afterRemoval.employees.find(e => e.id === 'worker').removed, true);
  assert.deepEqual(afterRemoval.records, all.records, 'member removal preserves records');
  assert.deepEqual(afterRemoval.schedules, all.schedules, 'member removal preserves punched schedules');
  assert.equal((await app.request('/auth/logout', { method: 'POST', headers: workerHeaders })).status, 200);
  assert.equal((await app.request('/api/state', { headers: workerHeaders })).status, 401);
  assert.equal((await app.request('/api/state', { headers: adminHeaders })).status, 200);
  assert.equal(fetchMock.mock.callCount(), 4);
});

test('Corrupt persistence fails closed and leaves the original file untouched', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'daka-corrupt-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.json');
  await writeFile(file, '{broken');
  assert.throws(() => createAttendanceServer({ env: { PORT: '0' }, dataFile: file }), /原文件已保留/);
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('Three roles enforce group boundaries, verified directory imports and immediate revocation', { concurrency: false }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'daka-roles-'));
  const file = join(directory, 'state.json');
  const employees = ['admin','manager','worker','other'].map(id => ({ id, name:id, openId:`ou_${id}`, employeeNo:id, department:'', orgAdmin:false, groupId:id === 'other' ? 'g2' : 'g1' }));
  const date = '2040-01-05';
  const stored = {version:2,employees,groups:[{id:'g1',name:'一组',adminIds:['manager']},{id:'g2',name:'二组',adminIds:[]}],locations:[{...location,id:'office'}],shiftTemplates:[],
    schedules:['worker','other'].map(id => ({id:`s-${id}`,employeeId:id,groupId:id === 'worker' ? 'g1' : 'g2',date,segments:[{start:'09:00',end:'18:00',locationId:'office'}]})),
    records:['worker','other'].map(id => ({id:`r-${id}`,employeeId:id,employeeName:id,groupId:id === 'worker' ? 'g1' : 'g2',scheduleId:`s-${id}`,date,segmentIndex:0,kind:'in',timestamp:'2040-01-05T01:00:00Z',status:'normal',source:'feishu'}))};
  await writeFile(file,JSON.stringify(stored));
  const env = {PORT:'0',FEISHU_APP_ID:'cli_roles',FEISHU_APP_SECRET:'test-secret',BASE_URL:'https://attendance.example.com',ADMIN_OPEN_IDS:'ou_admin',FEISHU_TENANT_KEY:'tenant-test',AMAP_JS_KEY:'test-key-1234567890',AMAP_SECURITY_JS_CODE:'test-security-1234567890'};
  const app = await start(file,env);
  t.after(async () => {await app.close();await rm(directory,{recursive:true,force:true});});
  const headers = {Host:'attendance.example.com',Origin:env.BASE_URL};
  const directoryUsers = [{open_id:'ou_new',name:'来自组织的成员',email:'private@example.com',mobile:'private-phone'},...employees.map(e => ({open_id:e.openId,name:e.name}))];
  t.mock.method(globalThis,'fetch',async (input,options) => {
    const url = new URL(input);
    if (url.pathname.endsWith('/authen/v2/oauth/token')) return Response.json({code:0,access_token:JSON.parse(options.body).code});
    if (url.pathname.endsWith('/authen/v1/user_info')) return Response.json({code:0,data:{open_id:`ou_${options.headers.Authorization.slice(7)}`,name:'Test',tenant_key:'tenant-test'}});
    if (url.pathname.endsWith('/tenant_access_token/internal')) return Response.json({code:0,tenant_access_token:'directory-token',expire:7200});
    if (url.pathname.endsWith('/contact/v3/scopes')) return Response.json({code:0,data:{user_ids:['ou_new'],department_ids:[],has_more:false}});
    if (url.pathname.endsWith('/users/batch')) return Response.json({code:0,data:{items:directoryUsers.filter(u => url.searchParams.getAll('user_ids').includes(u.open_id))}});
    assert.fail(`Unexpected upstream URL ${url.pathname}`);
  });
  const login = async code => {
    const initial = await app.request('/auth/login',{headers});
    const nonce = new URL(initial.headers.get('location')).searchParams.get('state');
    const response = await app.request(`/auth/callback?code=${code}&state=${nonce}`,{headers:{...headers,Cookie:initial.headers.get('set-cookie').split(';')[0]}});
    assert.equal(response.status,302);
    return {...headers,Cookie:response.headers.get('set-cookie').split(';')[0]};
  };
  const org = await login('admin'), manager = await login('manager'), worker = await login('worker');
  const asGroup = {...org,'X-Attendance-Preview':'group:g2'};
  const asMember = {...org,'X-Attendance-Preview':'user'};
  const groupPreview = await (await app.request('/api/state',{headers:asGroup})).json();
  assert.deepEqual(groupPreview.session.managedGroupIds,['g2']);
  assert.equal(groupPreview.session.role,'group_admin');
  assert.deepEqual(groupPreview.records.map(r => r.employeeId),['other']);
  const memberPreview = await (await app.request('/api/state',{headers:asMember})).json();
  assert.equal(memberPreview.session.role,'user');
  assert.deepEqual(memberPreview.employees.map(e => e.id),['admin']);
  assert.deepEqual(memberPreview.records,[]);
  assert.equal((await app.request('/api/state',{headers:{...worker,'X-Attendance-Preview':'group:g2'}})).status,403);
  assert.equal((await app.request('/api/schedules/s-other',{method:'DELETE',headers:asGroup})).status,403);
  const personal = {checkinEnabled:true,beforeMinutes:30};
  assert.equal((await app.request('/api/reminders',{headers})).status,401);
  assert.equal((await app.request('/api/reminders',{headers:worker,method:'PUT',data:personal})).status,200);
  assert.equal((await (await app.request('/api/reminders',{headers:worker})).json()).preferences.beforeMinutes,30);
  assert.equal((await (await app.request('/api/reminders',{headers:manager})).json()).preferences.beforeMinutes,15);
  assert.equal((await app.request('/api/reminders',{headers:worker,method:'PUT',data:{...personal,afterMinutes:60}})).status,403);
  assert.equal((await app.request('/api/reminders',{headers:manager,method:'PUT',data:{...personal,reviewEnabled:true,afterMinutes:90}})).status,200);
  assert.equal((await app.request('/api/reminders/test',{headers:worker,method:'POST',data:{}})).status,503);
  const privateData = JSON.parse(await readFile(file,'utf8'));
  assert.equal(privateData.reminders.preferences.ou_worker.beforeMinutes,30);
  assert.equal(privateData.reminders.preferences.ou_manager.afterMinutes,90);
  for (const actor of [worker,manager,org]) assert.equal('reminders' in await (await app.request('/api/state',{headers:actor})).json(),false);

  for (const [actor,allowed] of [[org,true],[manager,false],[worker,false],[headers,false]]) {
    const page=await app.request('/',{headers:actor});
    assert.equal(page.headers.get('content-security-policy').includes("'unsafe-eval'"),allowed,'AMap plugin compatibility is limited to authenticated organization admins');
    assert.equal(page.headers.get('content-security-policy').includes('https://jsapi-service.amap.com'),allowed);
  }
  const stateAs = async who => (await app.request('/api/state',{headers:who})).json();
  const call = (who,path,data,method='POST') => app.request(path,{headers:who,data,method});
  for (const path of ['/api/locations/office','/api/groups/g1','/api/employees/worker']) {
    assert.equal((await call(manager,path,undefined,'DELETE')).status,403);
  }
  const visible = await stateAs(manager);
  assert.equal(visible.session.role,'group_admin');
  assert.deepEqual(visible.groups.map(g => g.id),['g1']);
  assert.deepEqual(visible.schedules.map(s => s.employeeId),['worker']);
  assert.deepEqual(visible.records.map(r => r.employeeId),['worker']);
  assert.ok(visible.employees.every(e => e.openId === undefined && e.groupId === 'g1'));
  const csv = await (await app.request('/api/records.csv',{headers:manager})).text();
  assert.match(csv,/worker/);assert.doesNotMatch(csv,/other/);
  const summary = await (await app.request(`/api/attendance-summary?from=${date}&to=${date}`,{headers:manager})).json();
  assert.deepEqual(summary.rows.map(r => r.employeeId),['worker']);
  for (const path of ['/api/groups','/api/employees/manager/access','/api/locations','/api/shift-templates']) assert.equal((await call(manager,path,{},path.includes('/access') ? 'PATCH' : 'POST')).status,403);
  const schedule = {employeeIds:['other'],dates:['2041-01-05'],segments:[{start:'09:00',end:'18:00',locationId:'office'}]};
  assert.equal((await call(manager,'/api/schedules',schedule)).status,403);
  assert.equal((await call(manager,'/api/schedules/s-other',{},'DELETE')).status,403);
  assert.equal((await call(manager,'/api/schedules',{...schedule,employeeIds:['worker']})).status,200);
  assert.equal((await app.request('/api/directory',{headers:worker})).status,403);
  for (const actor of [worker,manager]) for (const path of ['/api/maps/config','/_AMapService/v3/place/text']) assert.equal((await app.request(path,{headers:actor})).status,403);
  const listed = await (await app.request('/api/directory',{headers:manager})).json();
  assert.equal(listed.users[0].name,'来自组织的成员');
  assert.doesNotMatch(JSON.stringify(listed),/private-|directory-token/);
  const before = await readFile(file,'utf8');
  assert.equal((await call(manager,'/api/employees/import',{openIds:['ou_external'],groupId:'g1'})).status,403);
  assert.equal(await readFile(file,'utf8'),before);
  assert.equal((await call(manager,'/api/employees/import',{openIds:['ou_new','ou_other'],groupId:'g1'})).status,403);
  assert.equal(await readFile(file,'utf8'),before,'mixed batch must be atomic');
  assert.equal((await call(manager,'/api/employees/import',{openIds:['ou_new'],groupId:'g2'})).status,403);
  assert.equal((await call(manager,'/api/employees/import',{openIds:['ou_new'],groupId:'g1',orgAdmin:true,role:'org_admin',name:'Forged'})).status,200);
  const imported = (await stateAs(org)).employees.find(e => e.name === '来自组织的成员');
  assert.ok(imported);assert.equal(imported.role,'user');assert.equal(imported.bound,true);
  assert.equal((await call(org,'/api/employees/import',{openIds:['ou_new'],groupId:'g1'})).status,200);
  assert.equal((await stateAs(org)).employees.filter(e => e.id === imported.id).length,1);
  assert.equal((await call(org,'/api/employees/admin/access',{groupId:'g1',role:'user',managedGroupIds:[]},'PATCH')).status,409);
  assert.equal((await call(org,'/api/employees/admin',undefined,'DELETE')).status,409);
  assert.equal((await call(org,'/api/groups/g1',undefined,'DELETE')).status,409);
  const emptyGroup = (await (await call(org,'/api/groups',{name:'空组',adminIds:[]})).json()).group;
  assert.equal((await call(org,`/api/groups/${emptyGroup.id}`,undefined,'DELETE')).status,200);
  assert.equal((await call(org,'/api/schedules',{...schedule,employeeIds:[imported.id]})).status,200);
  assert.equal((await call(org,`/api/employees/${imported.id}`,undefined,'DELETE')).status,200);
  assert.ok(!(await stateAs(org)).schedules.some(s => s.employeeId === imported.id));
  assert.equal((await call(org,'/api/schedules',{...schedule,employeeIds:[imported.id]})).status,400);
  assert.equal((await call(org,'/api/employees/import',{openIds:['ou_new'],groupId:'g1'})).status,200);
  assert.equal((await stateAs(org)).employees.find(e => e.id === imported.id).disabled,false);
  assert.equal((await call(org,'/api/employees/worker/access',{groupId:'g1',role:'group_admin',managedGroupIds:[]},'PATCH')).status,400);
  assert.equal((await call(org,'/api/employees/worker/access',{groupId:'g1',role:'group_admin',managedGroupIds:['g2']},'PATCH')).status,200);
  assert.equal((await stateAs(worker)).session.role,'group_admin');
  assert.deepEqual((await stateAs(worker)).session.managedGroupIds,['g2']);
  assert.equal((await call(org,'/api/groups/g1',{name:'一组',adminIds:[]},'PATCH')).status,200);
  assert.equal((await stateAs(manager)).session.role,'user');
  assert.deepEqual((await stateAs(manager)).employees.map(e => e.id),['manager']);
  assert.equal((await app.request('/api/records.csv',{headers:manager})).status,403);
  assert.equal((await call(manager,'/api/schedules',{...schedule,employeeIds:['worker']})).status,403);
  assert.equal((await call(org,'/api/employees',{...employee,openId:'ou_forged'})).status,403,'production bindings must come from the organization');
  const moveWithHistory = {employeeIds:['other'],dates:['2040-01-06'],segments:schedule.segments,replaceScheduleId:'s-other'};
  assert.equal((await call(org,'/api/schedules',moveWithHistory)).status,200);
  const rescheduled = await stateAs(org);
  assert.ok(!rescheduled.schedules.some(s => s.id === 's-other'));
  assert.ok(rescheduled.schedules.some(s => s.employeeId === 'other' && s.date === '2040-01-06'));
  assert.equal(rescheduled.records.find(r => r.id === 'r-other').scheduleId,'s-other');
  assert.ok(JSON.parse(await readFile(file,'utf8')).schedules.find(s => s.id === 's-other').cancelledAt);
  assert.equal((await call(org,'/api/employees/worker/access',{groupId:'g2',role:'group_admin',managedGroupIds:['g2']},'PATCH')).status,200);
  const movedMember = await stateAs(org);
  assert.equal(movedMember.schedules.find(s => s.id === 's-worker').groupId,'g1','recorded history remains with the original group');
  assert.equal(movedMember.schedules.find(s => s.employeeId === 'worker' && s.date === '2041-01-05').groupId,'g2');
});


test('AMap keeps its security code private and only proxies authenticated, bounded allowlisted requests', async t => {
  assert.throws(() => configuration({AMAP_JS_KEY:'test-key-1234567890'}),/同时配置/);
  assert.throws(() => configuration({AMAP_JS_KEY:'bad key',AMAP_SECURITY_JS_CODE:'test-security-1234567890'}),/格式/);
  const env = {PORT:'0',AMAP_JS_KEY:'test-key-1234567890',AMAP_SECURITY_JS_CODE:'test-security-1234567890'};
  const {app} = await fixture(t,env);
  assert.match((await app.request('/')).headers.get('content-security-policy'),/'unsafe-eval'/);
  const config = await (await app.request('/api/maps/config')).json();
  assert.deepEqual(config,{key:env.AMAP_JS_KEY});
  const state = await app.state();
  assert.equal(state.integration.mapConfigured,true);
  assert.doesNotMatch(JSON.stringify(state),/test-security|test-key/);
  let calls = 0;
  t.mock.method(globalThis,'fetch',async (input,options) => {
    calls++;
    const url = new URL(input);
    assert.equal(url.origin,'https://restapi.amap.com');
    assert.equal(url.pathname,'/v3/place/text');
    assert.equal(url.searchParams.get('key'),env.AMAP_JS_KEY);
    assert.equal(url.searchParams.get('jscode'),env.AMAP_SECURITY_JS_CODE);
    assert.equal(options.redirect,'error');
    assert.deepEqual(options.headers,{Referer:app.url+'/'},'send only the verified application origin, never browser credentials');
    return new Response(`callback_1({"status":"1","debug":"${env.AMAP_SECURITY_JS_CODE}"})`);
  });
  const response = await app.request('/_AMapService/v3/place/text?keywords=office&callback=callback_1&key=attacker&jscode=attacker');
  assert.equal(response.status,200);
  assert.match(response.headers.get('content-type'),/javascript/);
  assert.equal(await response.text(),'callback_1({"status":"1","debug":"[redacted]"})');
  assert.equal(calls,1);
  for (const path of ['/_AMapService/v3/ip','/_AMapService/https://evil.example/','/_AMapService/v3/place/text?callback=alert(1)','/_AMapService/v3/place/text?q='+ 'a'.repeat(4097)]) assert.equal((await app.request(path)).status,400);
  assert.equal((await app.request('/_AMapService/v3/place/text',{method:'POST',data:{}})).status,405);
  assert.equal(calls,1,'invalid requests must not reach AMap');
  t.mock.method(globalThis,'fetch',async () => {throw new Error('private upstream details');});
  const failed = await app.request('/_AMapService/v3/place/text');
  assert.equal(failed.status,502);assert.doesNotMatch(await failed.text(),/private upstream|test-security/);
  const {app:missing} = await fixture(t);
  assert.equal((await missing.request('/api/maps/config')).status,503);
  assert.doesNotMatch((await missing.request('/')).headers.get('content-security-policy'),/'unsafe-eval'/);
  const {app:production} = await fixture(t,{...env,FEISHU_APP_ID:'cli_amap',FEISHU_APP_SECRET:'test-secret',ADMIN_OPEN_IDS:'ou_admin',BASE_URL:'https://attendance.example.com'});
  const headers = {Host:'attendance.example.com'};
  for (const path of ['/api/maps/config','/_AMapService/v3/place/text']) assert.equal((await production.request(path,{headers})).status,401);
});

test('Reminder configuration is explicit and requires Feishu authentication', () => {
  assert.equal(configuration({PORT:'0'}).remindersEnabled,false);
  assert.throws(() => configuration({REMINDERS_ENABLED:'yes'}),/true 或 false/);
  assert.throws(() => configuration({REMINDERS_ENABLED:'true'}),/飞书应用/);
});
