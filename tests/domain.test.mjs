import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DomainError, validateLocation, validateEmployee, validateScheduleBatch,
  clockParts, distanceMeters, evaluatePunch,
} from '../domain.mjs';

const day = '2026-11-23';
const at = time => new Date(`${day}T${time}:00+08:00`);
const locations = [
  { id: 'a', name: 'A 园区', latitude: 40, longitude: 116, radius: 300 },
  { id: 'b', name: 'B 园区', latitude: 40.01, longitude: 116.01, radius: 300 },
  { id: 'building', name: '研发楼', latitude: 40.02, longitude: 116.02, radius: 100 },
];
const state = {
  employees: ['A', 'B', 'C', 'D'].map(id => ({ id, name: `员工 ${id}` })),
  locations,
  schedules: [
    { id: 'sA', employeeId: 'A', date: day, segments: [{ start: '09:00', end: '12:00', locationId: 'a' }, { start: '13:00', end: '18:00', locationId: 'b' }] },
    ...[['B', 'a'], ['C', 'b'], ['D', 'building']].map(([employeeId, locationId]) => ({
      id: `s${employeeId}`, employeeId, date: day, segments: [{ start: '09:00', end: '18:00', locationId }],
    })),
  ],
  records: [],
};

function input(employeeId = 'A', time = '09:00', segmentIndex = 0, changes = {}) {
  const locationId = state.schedules.find(item => item.employeeId === employeeId).segments[segmentIndex].locationId;
  const location = locations.find(item => item.id === locationId);
  return { employeeId, scheduleId: `s${employeeId}`, segmentIndex, kind: 'in', latitude: location.latitude, longitude: location.longitude, accuracy: 5, locatedAt: at(time).toISOString(), coordinateSystem: 'wgs84', ...changes };
}

test('A 上午仅在 A 园区，下午仅在 B 园区；B、C 全天固定园区', () => {
  assert.equal(evaluatePunch(state, input('A'), at('09:00')).locationId, 'a');
  assert.equal(evaluatePunch(state, input('A', '13:00', 1), at('13:00')).locationId, 'b');
  assert.throws(() => evaluatePunch(state, input('A', '13:00', 1, { latitude: 40, longitude: 116 }), at('13:00')), /不在.*B 园区/);
  assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { latitude: 40.01, longitude: 116.01 }), at('09:00')), /不在.*A 园区/);
  for (const employeeId of ['B', 'C']) {
    for (const time of ['09:00', '15:00']) {
      assert.equal(evaluatePunch(state, input(employeeId, time), at(time)).locationId, employeeId === 'B' ? 'a' : 'b');
    }
  }
});

test('D 楼栋 100 米范围包含定位误差，边界按未四舍五入的距离判断', () => {
  const north = meters => 40.02 + meters / 6371000 * 180 / Math.PI;
  assert.equal(evaluatePunch(state, input('D', '09:00', 0, { latitude: north(95), accuracy: 5 }), at('09:00')).distance, 95);
  assert.equal(evaluatePunch(state, input('D', '09:00', 0, { latitude: north(100), accuracy: 0 }), at('09:00')).distance, 100);
  assert.throws(() => evaluatePunch(state, input('D', '09:00', 0, { latitude: north(95.01), accuracy: 5 }), at('09:00')), /有效打卡范围/);
  assert.throws(() => evaluatePunch(state, input('D', '09:00', 0, { accuracy: 101 }), at('09:00')), /定位精度不足/);
  assert.equal(distanceMeters(40, 116, 40, 116), 0);
  assert.ok(Math.abs(distanceMeters(0, 0, 0, 180) - Math.PI * 6371000) < 0.001);
});

test('GCJ-02 同系可打卡，混用 WGS84 或未知坐标系必须拒绝', () => {
  const gcjState = { ...state, locations: state.locations.map(location => ({ ...location, coordinateSystem: 'gcj02' })) };
  assert.equal(evaluatePunch(gcjState, input('A', '09:00', 0, { coordinateSystem: 'gcj02' }), at('09:00')).status, 'normal');
  assert.throws(() => evaluatePunch(gcjState, input(), at('09:00')), /定位与地点坐标系不一致/);
  assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { coordinateSystem: 'gcj02' }), at('09:00')), /定位与地点坐标系不一致/);
  assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { coordinateSystem: 'bd09' }), at('09:00')), /定位坐标系必须/);
  for (const coordinateSystem of [undefined, null, '']) {
    assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { coordinateSystem }), at('09:00')), /定位坐标系必须明确/);
  }
  assert.equal(validateLocation({ name: '坐标测试', latitude: 40, longitude: 116, radius: 100 }).coordinateSystem, 'wgs84');
  assert.throws(() => validateLocation({ name: '坐标测试', latitude: 40, longitude: 116, radius: 100, coordinateSystem: 'bd09' }), /地点坐标系必须/);
});

test('打卡窗口与迟到、早退状态：窗口端点和分钟边界', () => {
  assert.equal(evaluatePunch(state, input('A', '08:00'), at('08:00')).status, 'normal');
  assert.throws(() => evaluatePunch(state, input('A', '07:59'), at('07:59')), /开始前 60 分钟/);
  assert.equal(evaluatePunch(state, input('A', '09:00'), at('09:00')).status, 'normal');
  assert.equal(evaluatePunch(state, input('A', '09:01'), at('09:01')).status, 'late');
  assert.throws(() => evaluatePunch(state, input('A', '12:00'), at('12:00')), /上班打卡/);
  assert.equal(evaluatePunch(state, input('A', '11:59', 0, { kind: 'out' }), at('11:59')).status, 'early');
  assert.equal(evaluatePunch(state, input('A', '12:00', 0, { kind: 'out' }), at('12:00')).status, 'normal');
  assert.equal(evaluatePunch(state, input('A', '14:00', 0, { kind: 'out' }), at('14:00')).status, 'normal');
  assert.throws(() => evaluatePunch(state, input('A', '14:01', 0, { kind: 'out' }), at('14:01')), /下班打卡/);
  assert.throws(() => evaluatePunch(state, input('A', '08:59', 0, { kind: 'out' }), at('08:59')), /下班打卡/);
});

test('服务器时间决定打卡结果；校验身份、日期与重复打卡', () => {
  const record = evaluatePunch(state, input('A', '09:01', 0, { timestamp: at('08:00').toISOString() }), at('09:01'));
  assert.equal(record.status, 'late');
  assert.equal(record.timestamp, at('09:01').toISOString());
  assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { scheduleId: 'sB' }), at('09:00')), /不属于当前员工/);
  assert.throws(() => evaluatePunch(state, input(), new Date('2026-11-24T09:00:00+08:00')), /当天排班/);
  assert.throws(() => evaluatePunch({ ...state, records: [record] }, input(), at('09:00')), error => error instanceof DomainError && error.status === 409);
  assert.equal(evaluatePunch({ ...state, records: [record] }, input('A', '12:00', 0, { kind: 'out' }), at('12:00')).kind, 'out');
  assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { segmentIndex: 0.5 }), at('09:00')), /时段无效/);
});

test('拒绝过期、异常和非数值定位，定位有效期边界可用', () => {
  const locatedAt = delta => new Date(at('09:00').getTime() + delta).toISOString();
  for (const delta of [-120001, 10001]) {
    assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { locatedAt: locatedAt(delta) }), at('09:00')), /定位已过期/);
  }
  for (const delta of [-120000, 10000]) {
    assert.equal(evaluatePunch(state, input('A', '09:00', 0, { locatedAt: locatedAt(delta) }), at('09:00')).status, 'normal');
  }
  for (const changes of [{ latitude: null }, { longitude: '' }, { accuracy: -1 }, { accuracy: Infinity }, { latitude: '40' }]) {
    assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, changes), at('09:00')), DomainError);
  }
  assert.throws(() => evaluatePunch(state, input('A', '09:00', 0, { locatedAt: '2026-11-23 09:00:00' }), at('09:00')), /定位时间无效/);
});

const batch = { employeeIds: ['A', 'D'], dates: [day], segments: [{ start: '09:00', end: '12:00', locationId: 'a' }] };

test('批量排班仅保留允许字段，默认不覆盖，排序且允许相邻时段', () => {
  const result = validateScheduleBatch({ ...batch, role: 'admin', segments: [{ start: '13:00', end: '18:00', locationId: 'b' }, { start: '09:00', end: '13:00', locationId: 'a' }] }, state);
  assert.equal(result.overwrite, false);
  assert.equal(result.segments[0].start, '09:00');
  assert.equal(result.role, undefined);
  assert.equal(result.note, '');
  assert.deepEqual(batch.employeeIds, ['A', 'D']);
});

test('排班拒绝重叠、跨天、无效日期与缺失员工/地点', () => {
  const invalid = [
    { dates: ['2026-02-30'] }, { dates: ['2026-1-01'] }, { dates: [day, day] },
    { employeeIds: ['A', 'A'] }, { employeeIds: ['unknown'] }, { overwrite: 'true' },
    { segments: [{ start: '18:00', end: '09:00', locationId: 'a' }] },
    { segments: [{ start: '09:00', end: '24:00', locationId: 'a' }] },
    { segments: [{ start: '09:00', end: '12:00', locationId: 'unknown' }] },
    { segments: [...batch.segments, { start: '11:59', end: '13:00', locationId: 'b' }] },
    { segments: [] }, { note: 'x'.repeat(501) },
  ];
  for (const change of invalid) assert.throws(() => validateScheduleBatch({ ...batch, ...change }, state), DomainError);
  assert.equal(validateScheduleBatch({ ...batch, dates: ['2028-02-29'] }, state).dates[0], '2028-02-29');
});

test('人员地点字段校验、白名单与上海时区', () => {
  const location = validateLocation({ name: '  研发楼  ', latitude: 40, longitude: 116, radius: 100, color: '#ABCDEF', secret: 'discard' });
  assert.equal(location.name, '研发楼');
  assert.equal(location.color, '#abcdef');
  assert.equal(location.secret, undefined);
  for (const change of [{ latitude: null }, { longitude: '' }, { radius: 9 }, { radius: 5001 }, { color: 'red' }]) {
    assert.throws(() => validateLocation({ ...location, ...change }), DomainError);
  }
  assert.deepEqual(validateEmployee({ name: ' 员工 A ', employeeNo: '001', role: 'admin' }), { name: '员工 A', employeeNo: '001', department: '', openId: '' });
  assert.throws(() => validateEmployee({ name: 'A', employeeNo: '' }), /工号/);
  assert.deepEqual(clockParts(new Date('2026-11-23T16:00:00Z')), { date: '2026-11-24', minutes: 0 });
});
