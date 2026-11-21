import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createAttendanceServer, configuration } from '../server.mjs';

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
  const input = { name: '午后班', segments: [{ start: '13:00', end: '17:00' }], note: '' };
  const created = await (await app.request('/api/shift-templates', { method: 'POST', data: input })).json();
  assert.ok(created.template.id);
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
  assert.equal((await app.request(`/api/schedules/${updated.id}`, { method: 'DELETE' })).status, 200);
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

test('Concurrent punches create one historical record, protect its schedule and safely export CSV', async t => {
  const { app } = await fixture(t);
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
  assert.equal((await app.request(`/api/schedules/${schedule.id}`, { method: 'DELETE' })).status, 409);
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
  async function login(code) {
    const response = await app.request('/auth/login', { headers });
    assert.equal(response.status, 302);
    const nonce = new URL(response.headers.get('location')).searchParams.get('state');
    const oauthCookie = response.headers.get('set-cookie').split(';')[0];
    assert.equal((await app.request(`/auth/callback?state=wrong&code=${code}`, { headers: { ...headers, Cookie: oauthCookie } })).status, 403);
    const callback = `/auth/callback?state=${nonce}&code=${code}`;
    const authorized = await app.request(callback, { headers: { ...headers, Cookie: oauthCookie } });
    assert.equal(authorized.status, 302);
    assert.equal(authorized.headers.get('location'), '/');
    assert.match(authorized.headers.get('set-cookie'), /attendance_session=[0-9a-f]{64};.*HttpOnly;.*Secure/);
    assert.equal((await app.request(callback, { headers: { ...headers, Cookie: oauthCookie } })).status, 403);
    return { ...headers, Cookie: authorized.headers.get('set-cookie').split(';')[0] };
  }
  const workerHeaders = await login('worker');
  const visible = await (await app.request('/api/state', { headers: workerHeaders })).json();
  assert.deepEqual(visible.session, { role: 'employee', employeeId: 'worker' });
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
  assert.equal(all.session.role, 'admin');
  assert.equal(all.employees.length, 2);
  assert.equal(all.schedules.length, 2);
  assert.equal(all.records.length, 2);
  assert.equal(all.employees[0].openId, 'ou_worker');
  assert.equal((await app.request('/api/locations', { method: 'POST', data: location, headers: adminHeaders })).status, 200);
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
