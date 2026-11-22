import gcoord from './public/vendor/gcoord.mjs';

export class DomainError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}

function requireValue(condition, message, status) {
  if (!condition) throw new DomainError(message, status);
}

function object(value) {
  requireValue(value !== null && typeof value === 'object' && !Array.isArray(value), '请求内容必须是对象');
}

function text(value, label, max, required = false) {
  if (value === undefined && !required) return '';
  requireValue(typeof value === 'string', `${label}必须是文本`);
  const result = value.trim();
  requireValue(!required || result.length > 0, `请填写${label}`);
  requireValue(result.length <= max, `${label}不能超过 ${max} 个字符`);
  return result;
}

function number(value, label, min, max) {
  requireValue(typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max,
    `${label}必须是 ${min} 至 ${max} 之间的数值`);
  return value;
}

function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function timeMinutes(value) {
  requireValue(typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value), '时间格式应为 HH:mm（00:00–23:59）');
  const [hours, minutes] = value.split(':').map(Number);
  return hours * 60 + minutes;
}

export function validateLocation(input) {
  object(input);
  const color = input.color === undefined ? '#168b81' : input.color;
  requireValue(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color), '地点颜色必须为六位十六进制颜色');
  const coordinateSystem = input.coordinateSystem === undefined ? 'wgs84' : input.coordinateSystem;
  requireValue(coordinateSystem === 'wgs84' || coordinateSystem === 'gcj02', '地点坐标系必须为 wgs84 或 gcj02');
  return {
    name: text(input.name, '地点名称', 80, true),
    address: text(input.address, '地点地址', 300),
    latitude: number(input.latitude, '纬度', -90, 90),
    longitude: number(input.longitude, '经度', -180, 180),
    radius: number(input.radius, '打卡半径（米）', 10, 5000),
    color: color.toLowerCase(),
    coordinateSystem,
  };
}

export function validateEmployee(input) {
  object(input);
  return {
    name: text(input.name, '员工姓名', 80, true),
    department: text(input.department, '部门', 100),
    employeeNo: text(input.employeeNo, '工号', 80, true),
    openId: text(input.openId, '飞书 Open ID', 128),
  };
}

export function validateScheduleBatch(input, state) {
  object(input);
  requireValue(Array.isArray(input.employeeIds) && input.employeeIds.length > 0, '请至少选择一位员工');
  requireValue(new Set(input.employeeIds).size === input.employeeIds.length, '员工不能重复选择');
  requireValue(input.employeeIds.every(id => typeof id === 'string' && state.employees.some(employee => employee.id === id)), '选择的员工不存在');
  requireValue(Array.isArray(input.dates) && input.dates.length >= 1 && input.dates.length <= 366, '请选择 1 至 366 个排班日期');
  requireValue(input.dates.every(validDate), '排班日期无效，请使用 YYYY-MM-DD 格式');
  requireValue(new Set(input.dates).size === input.dates.length, '排班日期不能重复');
  requireValue(input.dates.length * input.employeeIds.length <= 4000, '单次最多设置 4000 条员工排班');
  requireValue(Array.isArray(input.segments) && input.segments.length >= 1 && input.segments.length <= 12, '每天应设置 1 至 12 个打卡时段');
  const segments = input.segments.map(segment => {
    object(segment);
    const start = timeMinutes(segment.start);
    const end = timeMinutes(segment.end);
    requireValue(start < end, '时段结束时间必须晚于开始时间，跨天班次请分成两天设置');
    requireValue(typeof segment.locationId === 'string' && state.locations.some(location => location.id === segment.locationId), '选择的打卡地点不存在');
    return { start: segment.start, end: segment.end, locationId: segment.locationId };
  }).sort((a, b) => a.start.localeCompare(b.start));
  for (let index = 1; index < segments.length; index++) {
    requireValue(segments[index - 1].end <= segments[index].start, '同一天的打卡时段不能重叠');
  }
  requireValue(input.overwrite === undefined || typeof input.overwrite === 'boolean', '覆盖排班选项必须为布尔值');
  return {
    employeeIds: [...input.employeeIds],
    dates: [...input.dates].sort(),
    segments,
    note: text(input.note, '排班备注', 500),
    overwrite: input.overwrite === true,
  };
}

export function clockParts(date = new Date(), timezone = 'Asia/Shanghai') {
  requireValue(date instanceof Date && Number.isFinite(date.getTime()), '时间无效');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

export function distanceMeters(lat1, lon1, lat2, lon2) {
  const radians = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
    + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lon2 - lon1) * radians / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

export function evaluatePunch(state, input, now = new Date()) {
  object(input);
  const clock = clockParts(now);
  const employee = state.employees.find(item => item.id === input.employeeId);
  requireValue(employee, '员工不存在');
  const schedule = state.schedules.find(item => item.id === input.scheduleId);
  requireValue(schedule && schedule.employeeId === employee.id, '排班不存在或不属于当前员工');
  requireValue(schedule.date === clock.date, '只能对当天排班打卡');
  requireValue(Number.isInteger(input.segmentIndex) && input.segmentIndex >= 0 && input.segmentIndex < schedule.segments.length, '打卡时段无效');
  requireValue(input.kind === 'in' || input.kind === 'out', '打卡类型应为上班或下班');
  requireValue(!state.records.some(record => record.scheduleId === schedule.id && record.segmentIndex === input.segmentIndex && record.kind === input.kind), '该时段已完成此次打卡，请勿重复提交', 409);
  const segment = schedule.segments[input.segmentIndex];
  const location = state.locations.find(item => item.id === segment.locationId);
  requireValue(location, '排班地点已不存在，请联系管理员');
  const start = timeMinutes(segment.start);
  const end = timeMinutes(segment.end);
  const inWindow = input.kind === 'in'
    ? clock.minutes >= start - 60 && clock.minutes < end
    : clock.minutes >= start && clock.minutes <= end + 120;
  requireValue(inWindow, input.kind === 'in' ? '上班打卡须在开始前 60 分钟至本时段结束前完成' : '下班打卡须在本时段开始至结束后 120 分钟内完成');
  const { distance, accuracy } = evaluateLocation(location, input, now);
  return {
    employeeId: employee.id,
    scheduleId: schedule.id,
    date: schedule.date,
    segmentIndex: input.segmentIndex,
    kind: input.kind,
    timestamp: now.toISOString(),
    locationId: location.id,
    locationName: location.name,
    employeeName: employee.name,
    distance,
    accuracy,
    status: input.kind === 'in' && clock.minutes > start ? 'late' : input.kind === 'out' && clock.minutes < end ? 'early' : 'normal',
  };
}

export function evaluateLocation(location, input, now = new Date()) {
  object(input);
  requireValue(location, '请选择有效的考勤地点');
  const coordinateSystem = input.coordinateSystem;
  requireValue(coordinateSystem === 'wgs84' || coordinateSystem === 'gcj02', '定位坐标系必须明确为 wgs84 或 gcj02，请重新获取位置');
  const centerSystem = location.coordinateSystem || 'wgs84';
  requireValue(centerSystem === 'wgs84' || centerSystem === 'gcj02', '地点坐标系无效，请联系管理员');
  const latitude = number(input.latitude, '定位纬度', -90, 90);
  const longitude = number(input.longitude, '定位经度', -180, 180);
  const accuracy = number(input.accuracy, '定位精度（米）', 0, 100000);
  requireValue(typeof input.locatedAt === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.locatedAt) && validDate(input.locatedAt.slice(0, 10)), '定位时间无效，请重新获取位置');
  const locatedAt = new Date(input.locatedAt).getTime();
  requireValue(Number.isFinite(locatedAt) && now.getTime() - locatedAt <= 120000 && locatedAt - now.getTime() <= 10000, '定位已过期或时间异常，请重新获取位置');
  requireValue(accuracy <= Math.min(location.radius, 100), `定位精度不足，请在开阔处重试（需优于 ${Math.min(location.radius, 100)} 米）`);
  const [longitudeAtCenterSystem, latitudeAtCenterSystem] = gcoord.transform([longitude, latitude], coordinateSystem === 'gcj02' ? gcoord.GCJ02 : gcoord.WGS84, centerSystem === 'gcj02' ? gcoord.GCJ02 : gcoord.WGS84);
  const distance = distanceMeters(latitudeAtCenterSystem, longitudeAtCenterSystem, location.latitude, location.longitude);
  requireValue(distance + accuracy <= location.radius + 1e-6, `当前位置不在「${location.name}」的有效打卡范围内（距中心 ${Math.round(distance)} 米，范围 ${location.radius} 米，定位误差 ${Math.round(accuracy)} 米）`);
  return { distance: Math.round(distance * 10) / 10, accuracy };
}
