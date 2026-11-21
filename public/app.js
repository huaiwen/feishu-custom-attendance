'use strict';

const icons = {
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 11h18M8 15h2M14 15h2"/>',
  pin:'<path d="M20 10c0 6-8 11-8 11S4 16 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/>',
  users:'<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  records:'<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6M9 12h6M9 17h4"/>',
  checkin:'<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  link:'<path d="m10 13 4-4M15 13l2-2a4 4 0 0 0-6-6l-2 2M9 11l-2 2a4 4 0 0 0 6 6l2-2"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  left:'<path d="m14 6-6 6 6 6"/>',
  right:'<path d="m10 6 6 6-6 6"/>',
  arrow:'<path d="M4 12h16m-5-5 5 5-5 5"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  info:'<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  download:'<path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/>',
  building:'<path d="M4 21V8l8-5 8 5v13H4ZM9 21v-5h6v5M8 10h1M15 10h1M8 13h1M15 13h1"/>',
  edit:'<path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/>'
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeColor = value => /^#[a-fA-F0-9]{6}$/.test(value || '') ? value : '#3370ff';
const weekdays = ['一','二','三','四','五','六','日'];
const views = {schedules:['精细化排班','calendar','排班'],locations:['考勤地点','pin','地点'],employees:['人员管理','users','人员'],records:['考勤记录','records','记录'],checkin:['员工打卡','checkin','打卡'],integration:['飞书接入','link','接入']};
const ui = {db:null,view:'schedules',week:null,search:'',employee:'',recordFrom:'',recordTo:'',recordEmployee:'',recordStatus:'',scheduleTab:'personal',recordTab:'flow',summaryFrom:'',summaryTo:'',summary:null,summaryError:'',summaryLoading:false,drawer:null,busy:false};
const main = document.querySelector('#main');
const drawer = document.querySelector('#drawer');
let toastTimer;
let summaryRequest = 0;

function addDays(date, days) {const d = new Date(`${date}T12:00:00Z`);d.setUTCDate(d.getUTCDate() + days);return d.toISOString().slice(0,10);}
function monday(date) {const day = new Date(`${date}T12:00:00Z`).getUTCDay();return addDays(date, -(day === 0 ? 6 : day - 1));}
function monthDay(date) {return `${Number(date.slice(5,7))}月${Number(date.slice(8,10))}日`;}
function displayTime(timestamp) {return new Intl.DateTimeFormat('zh-CN',{timeZone:ui.db.timezone || 'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(timestamp));}
function locationById(id) {return ui.db.locations.find(location => location.id === id);}
function employeeById(id) {return ui.db.employees.find(employee => employee.id === id);}
function toast(message, error = false) {const node = document.querySelector('#toast');node.textContent = message;node.className = `toast visible${error ? ' error' : ''}`;clearTimeout(toastTimer);toastTimer = setTimeout(() => node.classList.remove('visible'), error ? 6000 : 3500);}
async function api(path, body, method = 'POST') {
  const options = body === undefined ? {headers:{Accept:'application/json'}} : {method,headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body)};
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {const error = new Error(data.error || '请求失败，请稍后再试');error.status = response.status;throw error;}
  return data;
}
async function refresh() {ui.db = await api('/api/state');if (!ui.week) ui.week = monday(ui.db.today);if (!ui.employee) ui.employee = ui.db.session?.employeeId || ui.db.employees[0]?.id || '';}
function isAdmin() {return ui.db.session?.role === 'admin';}
function visibleViews() {return isAdmin() ? Object.keys(views) : ['checkin','records'];}
function renderShell() {
  document.querySelector('#navigation').innerHTML = visibleViews().map(key => `${key === 'checkin' && isAdmin() ? '<div class="nav-separator"></div>' : ''}<button class="nav-button ${ui.view === key ? 'active' : ''}" data-action="navigate" data-view="${key}" aria-label="${views[key][0]}" ${ui.view === key ? 'aria-current="page"' : ''} title="${views[key][0]}">${icon(views[key][1])}<span class="nav-label-full">${views[key][0]}</span><span class="nav-label-mobile" aria-hidden="true">${views[key][2]}</span></button>`).join('');
  document.querySelector('#breadcrumb-label').textContent = views[ui.view][0];
  document.querySelector('#mode-label').textContent = ui.db.mode === 'demo' ? '本地演示' : '飞书应用';
  document.querySelector('#session-logout').hidden = ui.db.mode !== 'feishu';
  document.querySelector('#workspace-mode').textContent = ui.db.mode === 'demo' ? '示例数据 · 仅本机使用' : '企业自建应用';
  document.querySelector('#topbar-date').textContent = `${ui.db.today.replaceAll('-','.')} · ${ui.db.timezone || 'Asia/Shanghai'}`;
  document.querySelector('#connection-label').innerHTML = ui.db.mode === 'demo' ? '本地工作空间<small>尚未连接飞书企业</small>' : '飞书身份已连接<small>个人 · 时段 · 地点</small>';
  const employee = employeeById(ui.db.session?.employeeId);
  document.querySelector('#user-label').innerHTML = `${esc(employee?.name || '考勤管理员')}<small>${isAdmin() ? '管理工作台' : '个人考勤'}</small>`;
  document.title = `${views[ui.view][0]} · 自定义考勤`;
}
function pageHeader(title, subtitle, action = '') {return `<div class="page-header"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;}
function render() {
  if (!ui.db) return;
  if (!visibleViews().includes(ui.view)) ui.view = isAdmin() ? 'schedules' : 'checkin';
  renderShell();main.className = `${ui.view === 'checkin' ? 'checkin-page ' : ''}view-enter`;
  const renderers = {schedules:renderSchedules,locations:renderLocations,employees:renderEmployees,records:renderRecords,checkin:renderCheckin,integration:renderIntegration};
  renderers[ui.view]();
}
function scheduleTable() {
  const dates = Array.from({length:7},(_,i) => addDays(ui.week,i));
  const employees = ui.db.employees.filter(employee => `${employee.name} ${employee.department} ${employee.employeeNo}`.toLowerCase().includes(ui.search.toLowerCase()));
  return `<div class="table-scroll"><table class="schedule-table"><thead><tr><th>员工 / 部门</th>${dates.map((date,i) => `<th class="${i > 4 ? 'weekend' : ''}"><div class="day-header ${date === ui.db.today ? 'is-today' : ''}"><span>周${weekdays[i]}</span><span class="day-number">${Number(date.slice(8))}</span></div></th>`).join('')}</tr></thead><tbody>${employees.map(employee => `<tr><td class="employee-cell"><div class="employee-identity"><span class="avatar">${esc(employee.name.slice(-1))}</span><div><strong>${esc(employee.name)}</strong><small>${esc(employee.department || employee.employeeNo)}</small></div></div></td>${dates.map((date,i) => {const schedule = ui.db.schedules.find(s => s.employeeId === employee.id && s.date === date);return `<td class="${i > 4 ? 'weekend' : ''}"><button class="schedule-cell-button" data-action="edit-schedule" data-employee="${esc(employee.id)}" data-date="${date}" aria-label="编辑${esc(employee.name)}${monthDay(date)}排班">${schedule ? schedule.segments.map(segment => {const location = locationById(segment.locationId);return `<span class="shift" style="--location:${safeColor(location?.color)}"><span class="shift-location">${esc(location?.name || '地点不可用')}</span><span class="shift-time">${esc(segment.start)} – ${esc(segment.end)}</span></span>`;}).join('') : '<span class="empty-cell"><b>+</b>未排班</span>'}</button></td>`;}).join('')}</tr>`).join('')}</tbody></table>${!employees.length ? '<div class="empty-state inline">没有匹配的员工</div>' : ''}</div>`;
}
function scheduleTabs() {return `<nav class="page-tabs" aria-label="排班视图"><button data-action="schedule-tab" data-tab="personal" class="${ui.scheduleTab === 'personal' ? 'active' : ''}" aria-pressed="${ui.scheduleTab === 'personal'}">个人排班</button><button data-action="schedule-tab" data-tab="templates" class="${ui.scheduleTab === 'templates' ? 'active' : ''}" aria-pressed="${ui.scheduleTab === 'templates'}">班次模板</button></nav>`;}
function renderTemplates() {
  const templates = ui.db.shiftTemplates || [];
  main.innerHTML = `${pageHeader('精细化排班','保存常用班次，排班时再为每个时段指定地点。',`<button class="button primary" data-action="new-template">${icon('plus')}新增班次</button>`)}${scheduleTabs()}<section class="panel"><div class="table-scroll"><table class="data-table template-table"><thead><tr><th>班次名称</th><th>工作时段</th><th>备注</th><th>操作</th></tr></thead><tbody>${templates.map(template => `<tr><td><strong>${esc(template.name)}</strong><small>${template.segments.length} 个工作时段</small></td><td><div class="template-times">${template.segments.map(segment => `<span>${esc(segment.start)}–${esc(segment.end)}</span>`).join('')}</div></td><td>${esc(template.note || '—')}</td><td><button class="text-button" data-action="edit-template" data-id="${esc(template.id)}">编辑班次</button></td></tr>`).join('')}</tbody></table>${!templates.length ? `<div class="empty-state">${icon('clock')}还没有班次模板<p>将常用工作时间保存为模板，方便批量安排员工排班。</p><button class="button" data-action="new-template">新增班次</button></div>` : ''}</div><div class="panel-footer"><span>共 ${templates.length} 个班次模板</span><span>修改或删除模板不会影响已保存的排班</span></div></section>`;
}
function renderSchedules() {
  if (ui.scheduleTab === 'templates') return renderTemplates();
  const weekSchedules = ui.db.schedules.filter(s => s.date >= ui.week && s.date <= addDays(ui.week,6));
  const totalSegments = weekSchedules.reduce((total,s) => total+s.segments.length,0);
  main.innerHTML = `${pageHeader('精细化排班','按员工安排工作时段，指定每个时段的打卡地点。',`<button class="button primary" data-action="new-schedule">${icon('plus')}新增排班</button>`)}${scheduleTabs()}
    <section class="panel" aria-label="员工周排班表"><div class="toolbar"><div class="week-control"><span class="week-label">${monthDay(ui.week)} — ${monthDay(addDays(ui.week,6))}</span><button class="icon-button" data-action="previous-week" aria-label="上一周">${icon('left')}</button><button class="icon-button" data-action="next-week" aria-label="下一周">${icon('right')}</button><button class="today-button" data-action="this-week">本周</button></div><label class="search-box">${icon('search')}<input type="search" id="schedule-search" placeholder="搜索姓名、部门或工号" value="${esc(ui.search)}" aria-label="搜索员工"></label><span class="view-label">${icon('calendar')}周排班</span></div><div id="schedule-grid">${scheduleTable()}</div><div class="panel-footer"><div class="location-legend">${ui.db.locations.map(location => `<span class="legend-item"><i class="dot" style="--location:${safeColor(location.color)}"></i>${esc(location.name)} · ${location.radius} 米</span>`).join('')}</div><span>${new Set(weekSchedules.map(s => s.employeeId)).size} 位员工已排班 · ${totalSegments} 个工作时段</span></div></section>
    <div class="hint-line">${icon('info')}<span>点击单元格编辑当天排班。每个时段分别校验指定地点，未排班日期无需打卡。${ui.db.mode === 'demo' ? '当前使用示例数据。' : ''}</span></div>`;
}
function renderLocations() {
  main.innerHTML = `${pageHeader('考勤地点','设置园区与楼栋位置，按米配置打卡范围。',`<button class="button primary" data-action="new-location">${icon('plus')}新增地点</button>`)}${ui.db.mode === 'demo' ? `<div class="info-banner warning">${icon('info')}<p>以下为示例坐标。正式使用前，请录入实测的园区或楼栋中心位置，并核实坐标系。</p></div>` : ''}<div class="location-grid">${ui.db.locations.map(location => `<article class="location-tile"><div class="location-diagram" aria-label="${esc(location.name)}半径${location.radius}米范围示意"><div class="radius-circle">${icon('building')}<span>半径 ${location.radius} m</span></div><span class="diagram-label">范围示意 · 非实景地图</span></div><div class="location-body"><div class="location-title"><h3><i class="dot" style="--location:${safeColor(location.color)}"></i>${esc(location.name)}</h3><button class="icon-button" data-action="edit-location" data-id="${esc(location.id)}" aria-label="编辑${esc(location.name)}">${icon('edit')}</button></div><p>${esc(location.address || '尚未填写地址')}</p><div class="coordinate"><span>${location.coordinateSystem === 'gcj02' ? 'GCJ-02' : 'WGS84'}</span><span>${Number(location.latitude).toFixed(6)}, ${Number(location.longitude).toFixed(6)}</span></div></div></article>`).join('')}</div>${!ui.db.locations.length ? `<div class="panel empty-state">${icon('pin')}尚未添加考勤地点<p>先设置地点，再为员工安排工作时段。</p><button class="button" data-action="new-location">新增地点</button></div>` : ''}<div class="hint-line">${icon('info')}<span>打卡时同时校验距离和定位精度；位置误差范围需要完全处于打卡半径内。楼栋半径可设置为 100 米。</span></div>`;
}
function employeeRows() {
  const employees = ui.db.employees.filter(employee => `${employee.name} ${employee.department} ${employee.employeeNo}`.toLowerCase().includes(ui.search.toLowerCase()));
  return `<table class="data-table"><thead><tr><th>员工</th><th>部门</th><th>工号</th><th>飞书身份</th><th>操作</th></tr></thead><tbody>${employees.map(employee => `<tr><td><div class="employee-identity"><span class="avatar">${esc(employee.name.slice(-1))}</span><strong>${esc(employee.name)}</strong></div></td><td>${esc(employee.department || '—')}</td><td>${esc(employee.employeeNo)}</td><td>${employee.openId ? `<span class="status">已绑定</span><small>${esc(employee.openId)}</small>` : '<span class="status muted">未绑定</span>'}</td><td><button class="text-button" data-action="edit-employee" data-id="${esc(employee.id)}">编辑资料</button></td></tr>`).join('')}</tbody></table>${!employees.length ? '<div class="empty-state">暂无匹配的员工</div>' : ''}`;
}
function renderEmployees() {
  main.innerHTML = `${pageHeader('人员管理','管理参与考勤的员工与飞书身份绑定。',`<button class="button primary" data-action="new-employee">${icon('plus')}新增员工</button>`)}<section class="panel"><div class="toolbar"><strong style="font-size:12px">全部员工 <span class="muted">${ui.db.employees.length}</span></strong><label class="search-box">${icon('search')}<input type="search" id="employee-search" placeholder="搜索姓名、部门或工号" value="${esc(ui.search)}" aria-label="搜索员工"></label></div><div class="table-scroll" id="employee-grid">${employeeRows()}</div></section><div class="hint-line">${icon('info')}<span>正式接入飞书后，员工通过企业身份登录，仅可为本人打卡；员工的 Open ID 必须来自当前自建应用。</span></div>`;
}
function filteredRecords() {
  return ui.db.records.filter(record => (!ui.recordFrom || record.date >= ui.recordFrom) && (!ui.recordTo || record.date <= ui.recordTo) && (!ui.recordEmployee || record.employeeId === ui.recordEmployee) && (!ui.recordStatus || record.status === ui.recordStatus)).sort((a,b) => b.timestamp.localeCompare(a.timestamp));
}
function recordTabs() {return `<nav class="page-tabs" aria-label="考勤记录视图"><button data-action="record-tab" data-tab="flow" class="${ui.recordTab === 'flow' ? 'active' : ''}" aria-pressed="${ui.recordTab === 'flow'}">打卡流水</button><button data-action="record-tab" data-tab="summary" class="${ui.recordTab === 'summary' ? 'active' : ''}" aria-pressed="${ui.recordTab === 'summary'}">考勤统计</button></nav>`;}
function renderAttendanceSummary() {
  if (!ui.summaryFrom) ui.summaryFrom = monday(ui.db.today);
  if (!ui.summaryTo) ui.summaryTo = ui.db.today;
  main.innerHTML = `${pageHeader('考勤记录','按排班统计应打、已打和缺卡情况。')}${recordTabs()}<section class="panel"><div class="toolbar records-toolbar"><label class="filter-field">开始<input type="date" id="summary-from" value="${ui.summaryFrom}" aria-label="统计开始日期"></label><label class="filter-field">结束<input type="date" id="summary-to" value="${ui.summaryTo}" aria-label="统计结束日期"></label><button class="button small" data-action="load-summary">查询统计</button><span class="toolbar-note ml-auto">每次最多查询 31 天</span></div><div id="summary-content" aria-live="polite"></div></section><div class="hint-line">${icon('info')}<span>缺卡指打卡窗口已结束但尚未打卡；待打指窗口尚未结束。未排班日期不计入应打次数。</span></div>`;
  loadAttendanceSummary();
}
function renderSummaryContent() {
  const target = document.querySelector('#summary-content');
  if (!target || ui.view !== 'records' || ui.recordTab !== 'summary') return;
  if (ui.summaryLoading) {target.innerHTML = '<div class="empty-state"><span class="spinner"></span> 正在统计…</div>';return;}
  if (ui.summaryError) {target.innerHTML = `<div class="empty-state summary-error" role="alert">统计加载失败<p>${esc(ui.summaryError)}</p><button class="button" data-action="load-summary">重新查询</button></div>`;return;}
  if (!ui.summary) {target.innerHTML = '<div class="empty-state">请选择日期范围后查询</div>';return;}
  const {rows,totals,generatedAt} = ui.summary;
  const metrics = [['scheduledDays','排班人天'],['expectedCount','应打'],['punchedCount','已打'],['lateCount','迟到'],['earlyCount','早退'],['missingCount','缺卡'],['pendingCount','待打']];
  target.innerHTML = `<div class="metric-strip">${metrics.map(([key,label]) => `<div><span>${label}</span><strong class="${key === 'missingCount' && totals[key] > 0 ? 'missing-number' : ''}">${esc(totals[key])}</strong></div>`).join('')}</div><div class="table-scroll"><table class="data-table summary-table"><thead><tr><th>日期</th><th>员工</th><th>应打</th><th>已打</th><th>迟到</th><th>早退</th><th>缺卡</th><th>待打</th></tr></thead><tbody>${rows.map(row => `<tr><td class="nowrap">${esc(row.date)}</td><td><strong>${esc(row.employeeName)}</strong></td><td>${esc(row.expectedCount)}</td><td>${esc(row.punchedCount)}</td><td>${esc(row.lateCount)}</td><td>${esc(row.earlyCount)}</td><td class="${row.missingCount > 0 ? 'missing-number' : ''}">${esc(row.missingCount)}</td><td>${esc(row.pendingCount)}</td></tr>`).join('')}</tbody></table>${!rows.length ? '<div class="empty-state">所选日期范围内没有排班</div>' : ''}</div><div class="panel-footer"><span>${esc(ui.summary.from)} 至 ${esc(ui.summary.to)}</span><span>统计截至 ${displayTime(generatedAt)} · 北京时间</span></div>`;
}
async function loadAttendanceSummary() {
  const request = ++summaryRequest;
  ui.summary = null;ui.summaryError = '';ui.summaryLoading = true;renderSummaryContent();
  try {
    const start = new Date(`${ui.summaryFrom}T00:00:00Z`), end = new Date(`${ui.summaryTo}T00:00:00Z`);
    if (!ui.summaryFrom || !ui.summaryTo || !Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error('请选择有效的开始和结束日期');
    if (start > end) throw new Error('结束日期不能早于开始日期');
    if ((end-start)/86400000 > 30) throw new Error('每次最多查询 31 天，请缩小日期范围');
    const data = await api(`/api/attendance-summary?from=${encodeURIComponent(ui.summaryFrom)}&to=${encodeURIComponent(ui.summaryTo)}`);
    if (request !== summaryRequest) return;
    ui.summary = data;
  } catch (error) {if (request === summaryRequest) ui.summaryError = error.message;}
  finally {if (request === summaryRequest) {ui.summaryLoading = false;renderSummaryContent();}}
}
function renderRecords() {
  if (ui.recordTab === 'summary') return renderAttendanceSummary();
  const records = filteredRecords();
  const statusLabel = {normal:'正常',late:'迟到',early:'早退'};
  main.innerHTML = `${pageHeader('考勤记录','查看员工打卡时间、指定地点与定位校验结果。',isAdmin() ? `<a class="button" href="/api/records.csv" download>${icon('download')}导出全部记录</a>` : '')}${recordTabs()}<section class="panel"><div class="toolbar records-toolbar"><label class="filter-field">开始<input type="date" id="record-from" value="${ui.recordFrom}" aria-label="记录开始日期"></label><label class="filter-field">结束<input type="date" id="record-to" value="${ui.recordTo}" aria-label="记录结束日期"></label><label class="filter-field">员工<select id="record-employee"><option value="">全部员工</option>${ui.db.employees.map(e => `<option value="${esc(e.id)}" ${ui.recordEmployee === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label><label class="filter-field">状态<select id="record-status"><option value="">全部状态</option>${Object.entries(statusLabel).map(([value,label]) => `<option value="${value}" ${ui.recordStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button class="text-button ml-auto" data-action="reset-record-filters">重置筛选</button></div><div class="table-scroll"><table class="data-table"><thead><tr><th>员工 / 日期</th><th>打卡时间</th><th>指定地点</th><th>距中心 / 精度</th><th>状态</th><th>来源</th></tr></thead><tbody>${records.map(record => `<tr><td><strong>${esc(record.employeeName || employeeById(record.employeeId)?.name || '未知员工')}</strong><small>${esc(record.date)}</small></td><td><strong>${displayTime(record.timestamp)}</strong><small>第 ${record.segmentIndex+1} 时段 · ${record.kind === 'in' ? '上班' : '下班'}</small></td><td>${esc(record.locationName || locationById(record.locationId)?.name || '未知地点')}</td><td>${Number(record.distance).toFixed(1)} m <span class="muted">/ ±${Number(record.accuracy).toFixed(0)} m</span></td><td><span class="status ${record.status === 'normal' ? '' : 'warn'}">${statusLabel[record.status] || esc(record.status)}</span></td><td><span class="status muted">${record.source === 'demo' ? '演示打卡' : '飞书身份'}</span></td></tr>`).join('')}</tbody></table>${!records.length ? `<div class="empty-state">${icon('records')}暂无打卡记录<p>实际打卡成功后会在这里保存记录；规则试算不会写入记录。</p></div>` : ''}</div><div class="panel-footer"><span>共 ${records.length} 条记录</span><span>时间均为北京时间 · Asia/Shanghai</span></div></section>`;
}
function currentEmployeeId() {return ui.db.mode === 'demo' ? ui.employee : ui.db.session?.employeeId;}
function currentSchedule() {return ui.db.schedules.find(s => s.employeeId === currentEmployeeId() && s.date === ui.db.today);}
function recorded(schedule, index, kind) {return ui.db.records.find(r => r.scheduleId === schedule.id && r.segmentIndex === index && r.kind === kind);}
function renderCheckin() {
  const employee = employeeById(currentEmployeeId());
  const schedule = currentSchedule();
  const currentMinutes = displayTime(ui.db.now || new Date().toISOString()).split(':').reduce((hours,value,index) => hours + Number(value)*(index === 0 ? 60 : 1),0);
  const suggestedIndex = schedule ? schedule.segments.findIndex((segment,index) => {const [hour,minute] = segment.end.split(':').map(Number);return hour*60+minute+120 >= currentMinutes && (!recorded(schedule,index,'in') || !recorded(schedule,index,'out'));}) : -1;
  main.innerHTML = `${pageHeader('今日打卡','按排班到达指定地点，完成上、下班打卡。')}${ui.db.mode === 'demo' ? `<div class="info-banner warning">${icon('info')}<p>本地演示 · 可切换示例员工。定位打卡保存演示记录；规则试算不产生记录。</p></div>` : ''}<div class="checkin-layout"><section class="panel"><div class="checkin-header"><div><strong>${esc(employee?.name || '尚未绑定员工身份')}</strong><p>${ui.db.today} · 今日排班</p></div>${ui.db.mode === 'demo' ? `<select class="employee-switch" id="checkin-employee" aria-label="切换演示员工">${ui.db.employees.map(e => `<option value="${esc(e.id)}" ${e.id === ui.employee ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>` : '<span class="status">本人打卡</span>'}</div>${schedule ? schedule.segments.map((segment,index) => {const location = locationById(segment.locationId);return `<div class="checkin-day ${index === suggestedIndex ? 'current' : ''}"><div class="checkin-period"><span>时段 ${index+1}</span>${index === suggestedIndex ? '<span class="status muted">待完成</span>' : ''}</div><div class="checkin-time">${esc(segment.start)} <span class="muted">—</span> ${esc(segment.end)}</div><div class="checkin-place">${icon('pin')}${esc(location?.name || '未知地点')}</div><div class="checkin-radius">${esc(location?.address || '考勤地点')} · 打卡半径 ${location?.radius || 0} 米</div><div class="checkin-actions">${['in','out'].map(kind => {const record = recorded(schedule,index,kind);return `<button class="button ${index === suggestedIndex && kind === (recorded(schedule,index,'in') ? 'out' : 'in') ? 'primary' : ''}" data-action="checkin" data-index="${index}" data-kind="${kind}" ${record ? 'disabled' : ''}>${icon(record ? 'checkin' : 'pin')}${record ? `${kind === 'in' ? '上班' : '下班'}已打卡 ${displayTime(record.timestamp)}` : `${kind === 'in' ? '上班' : '下班'}定位打卡`}</button>`;}).join('')}</div></div>`;}).join('') : `<div class="empty-state">${icon('calendar')}${employee ? '今日未安排班次' : '请先绑定员工身份'}<p>${employee ? '请联系管理员确认今天的考勤安排。' : '管理员需将飞书 Open ID 绑定到员工资料。'}</p></div>`}</section><aside class="help-panel"><details class="rule-details"><summary>查看打卡规则</summary><ol><li><strong>按时段核对地点</strong><br>每个时段分别完成上、下班打卡，跨园区排班按照对应地点校验。</li><li><strong>允许定位权限</strong><br>使用手机并开启高精度定位。位置误差范围需完全落入考勤半径，精度须不大于半径且不超过 100 米。</li><li><strong>以服务器时间为准</strong><br>上班可提前 60 分钟打卡；下班最晚可在时段结束后 120 分钟打卡。晚到、早走将标记异常。</li></ol></details>${ui.db.mode === 'demo' && schedule ? `<div class="simulation"><h3>${icon('info')}规则试算 <span class="status muted">不写入记录</span></h3><p>使用指定位置和时段开始/结束时间，检查地点规则。</p><select id="preview-segment" aria-label="试算工作时段">${schedule.segments.map((segment,index) => `<option value="${index}">${segment.start}–${segment.end} · ${esc(locationById(segment.locationId)?.name)}</option>`).join('')}</select><select id="preview-kind" aria-label="试算打卡类型"><option value="in">上班打卡 · 时段开始时</option><option value="out">下班打卡 · 时段结束时</option></select><select id="preview-scenario" aria-label="试算定位场景"><option value="center">在指定地点中心 · 精度 5 米</option><option value="outside">偏离指定地点约 1 公里</option><option value="inaccurate">位于中心但定位精度不足</option></select><button class="button" data-action="preview">运行规则试算</button><div id="preview-result" role="status"></div></div>` : ''}</aside></div>`;
}
function renderIntegration() {
  const configured = ui.db.integration?.configured;
  main.innerHTML = `${pageHeader('飞书接入','查看接入进度，配置企业工作台入口。')}<div class="integration-layout"><div class="info-banner">${icon('info')}<p>自定义考勤独立管理班次、排班、打卡与统计。飞书提供工作台入口、员工身份和手机定位。</p></div><section class="panel"><div class="integration-head"><div class="integration-logo">${icon('link')}</div><div><h3>自定义考勤</h3><p>企业自建网页应用</p></div><span class="status muted">${configured ? '待实机验证' : '本地演示'}</span></div><div class="setup-step"><span class="step-number">1</span><div><h3>登录与定位 <span class="status ${configured ? '' : 'muted'}">${configured ? '已配置 · 待验证' : '代码已就绪 · 待配置'}</span></h3><p>${configured ? `App ID：${esc(ui.db.integration.appId)}。请使用实际企业账号和手机飞书验证。` : '已提供飞书登录与手机定位代码。需要配置自建应用凭据、HTTPS 地址、安全域名与回调地址。'}</p></div></div><div class="setup-step"><span class="step-number">2</span><div><h3>官方考勤同步 <span class="status muted">可选 · 未接入</span></h3><p>如需将结果交给官方考勤统一处理，可另行接入同步；独立使用不依赖官方考勤应用。</p></div></div><div class="setup-step"><span class="step-number">3</span><div><h3>上线前准备</h3><p>配置自建应用的工作台入口，绑定员工身份，录入实测地点与坐标系，再用手机验证园区边界、定位精度及打卡记录。</p><a href="https://open.feishu.cn/app" target="_blank" rel="noopener noreferrer">打开飞书开放平台 ↗</a></div></div></section><div class="hint-line">${icon('info')}<span>配置步骤与官方接口方案见项目文档。当前页面不会向官方考勤写入数据。</span></div></div>`;
}

function locationOptions(selected) {return ui.db.locations.map(location => `<option value="${esc(location.id)}" ${selected === location.id ? 'selected' : ''}>${esc(location.name)}</option>`).join('');}
function segmentRow(segment = {start:'09:00',end:'18:00',locationId:ui.db.locations[0]?.id}, withLocation = true) {return `<div class="segment-row ${withLocation ? '' : 'template-row'}"><label class="field">开始<input type="time" class="segment-start" value="${esc(segment.start)}" required></label><label class="field">结束<input type="time" class="segment-end" value="${esc(segment.end)}" required></label>${withLocation ? `<label class="field">考勤地点<select class="segment-location" required>${locationOptions(segment.locationId)}</select></label>` : ''}<button type="button" class="icon-button" data-action="remove-segment" aria-label="删除该时段">×</button></div>`;}
function applyTemplate() {
  const template = (ui.db.shiftTemplates || []).find(item => item.id === document.querySelector('#shift-template-select').value);
  if (!template) return toast('请先选择班次模板',true);
  const locationIds = [...document.querySelectorAll('#segment-list .segment-location')].map(select => select.value);
  document.querySelector('#segment-list').innerHTML = template.segments.map((segment,index) => segmentRow({...segment,locationId:locationIds[index] || ui.db.locations[0]?.id})).join('');
  toast('已应用班次时间，请逐段确认考勤地点');
}
function openDrawer(type, item = null, employeeId = '', date = ui.db.today) {
  ui.drawer = {type,item,employeeId,date};
  const title = type === 'schedule' ? item ? '编辑个人排班' : '新增排班' : type === 'template' ? item ? '编辑班次模板' : '新增班次模板' : type === 'location' ? item ? '编辑考勤地点' : '新增考勤地点' : item ? '编辑员工资料' : '新增员工';
  document.querySelector('#drawer-title').textContent = title;
  document.querySelector('#drawer-eyebrow').textContent = title;
  document.querySelector('#form-error').textContent = '';
  const body = document.querySelector('#drawer-body');
  if (type === 'schedule') {
    if (!ui.db.employees.length || !ui.db.locations.length) {toast('请先添加员工和考勤地点',true);return;}
    const selectedEmployee = item?.employeeId || employeeId;
    const selectedDate = item?.date || date;
    body.innerHTML = `<div class="field"><span class="field-label">选择员工<span class="required">*</span></span><div class="employee-options">${ui.db.employees.map(employee => `<label class="check-option"><input type="checkbox" name="employeeIds" value="${esc(employee.id)}" ${selectedEmployee === employee.id ? 'checked' : ''} ${item && selectedEmployee !== employee.id ? 'disabled' : ''}><span>${esc(employee.name)}</span><small>${esc(employee.department || employee.employeeNo)}</small></label>`).join('')}</div><small>可一次为多位员工安排相同的时段和地点。</small></div><div class="field-grid"><label class="field"><span class="field-label">开始日期<span class="required">*</span></span><input type="date" name="startDate" value="${selectedDate}" required ${item ? 'readonly' : ''}></label><label class="field"><span class="field-label">结束日期<span class="required">*</span></span><input type="date" name="endDate" value="${selectedDate}" required ${item ? 'readonly' : ''}></label></div>${!item ? `<div class="field"><span class="field-label">应用到星期</span><div class="weekday-options">${weekdays.map((day,index) => `<label class="weekday-option"><input type="checkbox" name="weekdays" value="${(index+1)%7}" checked><span>${day}</span></label>`).join('')}</div></div>` : ''}<div class="field"><span class="field-label">使用班次模板</span><div class="template-apply"><select id="shift-template-select" aria-label="选择班次模板"><option value="">选择模板（可选）</option>${(ui.db.shiftTemplates || []).map(template => `<option value="${esc(template.id)}">${esc(template.name)}</option>`).join('')}</select><button type="button" class="button" data-action="apply-template">应用班次</button></div><small>替换工作时间，地点按原顺序保留，请逐段确认。</small></div><div class="form-section-title"><span>工作时段与地点<span class="required">*</span></span><small>各时段不可重叠</small></div><div id="segment-list">${(item?.segments || [{start:'09:00',end:'12:00',locationId:ui.db.locations[0].id},{start:'13:30',end:'18:00',locationId:ui.db.locations[0].id}]).map(segment => segmentRow(segment)).join('')}</div><button type="button" class="text-button" data-action="add-segment">${icon('plus')}增加工作时段</button><p class="field-hint" style="margin:12px 0 22px">跨园区时，为上午与下午分别选择地点；全天固定地点可以设置为一个时段。</p><label class="field"><span class="field-label">备注</span><textarea name="note" maxlength="200" placeholder="例如：下午前往 B 园区办公">${esc(item?.note || '')}</textarea></label>${!item ? '<label class="overwrite-label"><input type="checkbox" name="overwrite"><span>覆盖所选员工在这些日期已有的排班<br><small class="muted">不勾选时，如有已有排班将停止保存。</small></span></label>' : '<div class="info-banner">已产生打卡记录的排班不能修改或删除。</div>'}`;
  } else if (type === 'template') {
    body.innerHTML = `<label class="field"><span class="field-label">班次名称<span class="required">*</span></span><input name="name" required maxlength="80" value="${esc(item?.name || '')}" placeholder="例如：标准日班 / 上午班"></label><div class="form-section-title"><span>工作时段<span class="required">*</span></span><small>同一天内，各时段不可重叠</small></div><div id="segment-list">${(item?.segments || [{start:'09:00',end:'12:00'},{start:'13:30',end:'18:00'}]).map(segment => segmentRow(segment,false)).join('')}</div><button type="button" class="text-button" data-action="add-segment">${icon('plus')}增加工作时段</button><p class="field-hint" style="margin:12px 0 22px">班次模板只保存时间，打卡地点在个人排班中设置。</p><label class="field"><span class="field-label">备注</span><textarea name="note" maxlength="500" placeholder="班次说明">${esc(item?.note || '')}</textarea></label>`;
  } else if (type === 'location') {
    body.innerHTML = `<label class="field"><span class="field-label">地点名称<span class="required">*</span></span><input name="name" required maxlength="60" value="${esc(item?.name || '')}" placeholder="例如：A 园区 / 研发楼"></label><label class="field"><span class="field-label">详细地址</span><input name="address" maxlength="200" value="${esc(item?.address || '')}" placeholder="填写园区地址或楼栋说明"></label><div class="field-grid"><label class="field"><span class="field-label">纬度<span class="required">*</span></span><input type="number" step="any" min="-90" max="90" name="latitude" required value="${item?.latitude ?? ''}" placeholder="例如：40.000000"></label><label class="field"><span class="field-label">经度<span class="required">*</span></span><input type="number" step="any" min="-180" max="180" name="longitude" required value="${item?.longitude ?? ''}" placeholder="例如：116.000000"></label></div><label class="field"><span class="field-label">坐标系<span class="required">*</span></span><select name="coordinateSystem"><option value="wgs84" ${item?.coordinateSystem !== 'gcj02' ? 'selected' : ''}>WGS84 · GPS / 浏览器定位</option><option value="gcj02" ${item?.coordinateSystem === 'gcj02' ? 'selected' : ''}>GCJ-02 · 高德 / 腾讯地图</option></select><small>打卡定位必须与地点坐标系一致。请先用实际手机核对飞书定位返回的坐标系；百度坐标不可直接使用。</small></label><div class="field-grid"><label class="field"><span class="field-label">打卡半径（米）<span class="required">*</span></span><input type="number" name="radius" min="10" max="5000" step="1" required value="${item?.radius ?? 100}"><small>以地点中心计算地面直线距离。</small></label><label class="field color-field"><span class="field-label">地点标识颜色</span><input type="color" name="color" value="${safeColor(item?.color || '#3370ff')}"></label></div>`;
  } else {
    body.innerHTML = `<label class="field"><span class="field-label">员工姓名<span class="required">*</span></span><input name="name" required maxlength="60" value="${esc(item?.name || '')}" placeholder="输入员工姓名"></label><label class="field"><span class="field-label">工号<span class="required">*</span></span><input name="employeeNo" required maxlength="40" value="${esc(item?.employeeNo || '')}" placeholder="例如：E001"><small>工号必须唯一。</small></label><label class="field"><span class="field-label">部门</span><input name="department" maxlength="60" value="${esc(item?.department || '')}" placeholder="例如：技术研发部"></label><label class="field"><span class="field-label">飞书 Open ID</span><input name="openId" maxlength="128" value="${esc(item?.openId || '')}" placeholder="ou_…"><small>来自当前自建应用的员工标识。演示环境可以留空；正式使用需要绑定。</small></label>`;
  }
  document.querySelector('#drawer-footer').innerHTML = `${type === 'schedule' && item ? '<button type="button" class="button danger delete-button" data-action="delete-schedule">删除排班</button>' : type === 'template' && item ? '<button type="button" class="button danger delete-button" data-action="delete-template">删除班次</button>' : ''}<button type="button" class="button" data-action="close-drawer">取消</button><button type="submit" class="button primary" id="save-button">保存${type === 'schedule' ? '排班' : type === 'template' ? '班次' : type === 'location' ? '地点' : '员工'}</button>`;
  drawer.showModal();
}
function closeDrawer() {drawer.close();ui.drawer = null;}
async function saveDrawer(event) {
  event.preventDefault();
  if (ui.busy) return;
  const form = new FormData(event.target);
  const {type,item} = ui.drawer;
  const button = document.querySelector('#save-button');
  ui.busy = true;button.disabled = true;document.querySelector('#form-error').textContent = '';
  try {
    if (type === 'schedule') {
      const employeeIds = form.getAll('employeeIds');
      if (!employeeIds.length) throw new Error('请至少选择一位员工');
      const start = form.get('startDate'), end = form.get('endDate');
      if (start > end) throw new Error('结束日期不能早于开始日期');
      const days = (new Date(`${end}T12:00:00Z`) - new Date(`${start}T12:00:00Z`)) / 86400000;
      if (days > 365) throw new Error('每次最多安排 366 天，请缩小日期范围');
      const selectedWeekdays = form.getAll('weekdays').map(Number);
      const dates = [];
      for (let i=0;i<=days;i++) {const date = addDays(start,i);if (item || selectedWeekdays.includes(new Date(`${date}T12:00:00Z`).getUTCDay())) dates.push(date);}
      if (!dates.length) throw new Error('日期范围内没有选中的星期，请调整选择');
      const segments = [...document.querySelectorAll('.segment-row')].map(row => ({start:row.querySelector('.segment-start').value,end:row.querySelector('.segment-end').value,locationId:row.querySelector('.segment-location').value}));
      const result = await api('/api/schedules',{employeeIds,dates,segments,note:form.get('note').trim(),overwrite:!!item || form.has('overwrite')});
      toast(`已保存 ${result.count || dates.length*employeeIds.length} 份个人排班`);
    } else if (type === 'template') {
      const segments = [...document.querySelectorAll('.segment-row')].map(row => ({start:row.querySelector('.segment-start').value,end:row.querySelector('.segment-end').value}));
      await api(`/api/shift-templates${item ? `/${encodeURIComponent(item.id)}` : ''}`,{name:form.get('name').trim(),note:form.get('note').trim(),segments},item ? 'PATCH' : 'POST');
      toast('班次模板已保存');
    } else {
      const body = Object.fromEntries(form);
      for (const key of ['latitude','longitude','radius']) if (key in body) body[key] = Number(body[key]);
      for (const key of ['name','department','employeeNo','openId','address']) if (key in body) body[key] = body[key].trim();
      const resource = type === 'employee' ? 'employees' : 'locations';
      await api(`/api/${resource}${item ? `/${encodeURIComponent(item.id)}` : ''}`,body,item ? 'PATCH' : 'POST');
      toast(type === 'employee' ? '员工资料已保存' : '考勤地点已保存');
    }
    closeDrawer();await refresh();render();
  } catch (error) {document.querySelector('#form-error').textContent = error.message;}
  finally {ui.busy = false;button.disabled = false;}
}
async function deleteSchedule() {
  const schedule = ui.drawer?.item;
  if (!schedule || !window.confirm(`确定删除 ${employeeById(schedule.employeeId)?.name || '该员工'} ${schedule.date} 的排班？`)) return;
  try {await api(`/api/schedules/${encodeURIComponent(schedule.id)}`,{},'DELETE');closeDrawer();await refresh();render();toast('已删除该日排班');} catch (error) {document.querySelector('#form-error').textContent = error.message;}
}
async function deleteTemplate() {
  const template = ui.drawer?.item;
  if (!template || ui.busy || !window.confirm(`删除班次「${template.name}」？已保存的排班不受影响。`)) return;
  ui.busy = true;
  try {await api(`/api/shift-templates/${encodeURIComponent(template.id)}`,{},'DELETE');closeDrawer();await refresh();render();toast('班次模板已删除');}
  catch (error) {document.querySelector('#form-error').textContent = error.message;}
  finally {ui.busy = false;}
}
let feishuSdkReady;
async function prepareFeishuSdk() {
  if (!feishuSdkReady) {
    feishuSdkReady = (async () => {
      if (!window.h5sdk) {
        await new Promise((resolve,reject) => {
          const script = document.createElement('script');
          const timeout = setTimeout(() => {script.remove();reject(new Error('飞书定位组件加载超时，请重试'));},15000);
          script.src = 'https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.48.js';
          script.onload = () => {clearTimeout(timeout);resolve();};
          script.onerror = () => {clearTimeout(timeout);script.remove();reject(new Error('飞书定位组件加载失败，请检查网络'));};
          document.head.append(script);
        });
      }
      if (!window.h5sdk || !window.tt) throw new Error('请在手机飞书工作台中打开应用后定位');
      const config = await api(`/api/feishu/jsapi-config?url=${encodeURIComponent(location.href.split('#')[0])}`);
      await new Promise((resolve,reject) => {
        const timeout = setTimeout(() => reject(new Error('飞书定位认证超时，请重新打开应用')),15000);
        const fail = () => {clearTimeout(timeout);reject(new Error('飞书定位认证失败，请检查应用权限与安全域名'));};
        window.h5sdk.error(fail);
        window.h5sdk.ready(() => {clearTimeout(timeout);resolve();});
        window.h5sdk.config({...config,onSuccess:() => {},onFail:fail});
      });
    })().catch(error => {feishuSdkReady = null;throw error;});
  }
  return feishuSdkReady;
}
async function getPosition() {
  if (ui.db.mode === 'feishu' && /Lark|Feishu/i.test(navigator.userAgent)) {
    await prepareFeishuSdk();
    return new Promise((resolve,reject) => {
      const timeout = setTimeout(() => reject(new Error('飞书定位超时，请开启高精度定位并重试')),20000);
      window.tt.getLocation({timeout:15,cacheTimeout:0,accuracy:'best',success:result => {
        clearTimeout(timeout);
        if (!['wgs84','gcj02'].includes(result.type)) return reject(new Error('飞书未返回可识别的坐标系，请更新客户端或联系管理员'));
        const position = {latitude:Number(result.latitude),longitude:Number(result.longitude),accuracy:Number(result.horizontalAccuracy ?? result.accuracy),timestamp:Number(result.timestamp),coordinateSystem:result.type};
        if (![position.latitude,position.longitude,position.accuracy,position.timestamp].every(Number.isFinite) || position.timestamp <= 0) return reject(new Error('飞书定位信息不完整，请重新定位'));
        resolve(position);
      },fail:() => {clearTimeout(timeout);reject(new Error('飞书定位失败，请在手机端允许定位权限并重试'));}});
    });
  }
  return new Promise((resolve,reject) => {
    if (!navigator.geolocation) return reject(new Error('当前设备不支持定位，请在手机浏览器中打开'));
    navigator.geolocation.getCurrentPosition(position => resolve({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,timestamp:position.timestamp,coordinateSystem:'wgs84'}),error => reject(new Error(({1:'定位权限未开启，请允许访问位置后重试',2:'暂时无法获取位置，请移至开阔处后重试',3:'获取定位超时，请开启高精度定位后重试'})[error.code] || '获取位置失败')),{enableHighAccuracy:true,maximumAge:0,timeout:20000});
  });
}
async function checkin(button) {
  const schedule = currentSchedule();if (!schedule || ui.busy) return;
  ui.busy = true;const oldText = button.innerHTML;button.disabled = true;button.innerHTML = '<span class="spinner"></span>正在获取位置…';
  try {
    const position = await getPosition();
    button.innerHTML = '<span class="spinner"></span>正在校验打卡…';
    await api('/api/checkin',{employeeId:currentEmployeeId(),scheduleId:schedule.id,segmentIndex:Number(button.dataset.index),kind:button.dataset.kind,latitude:position.latitude,longitude:position.longitude,accuracy:position.accuracy,coordinateSystem:position.coordinateSystem,locatedAt:new Date(position.timestamp).toISOString()});
    await refresh();render();toast(ui.db.mode === 'demo' ? '打卡成功，已保存为演示记录' : '打卡成功');
  } catch (error) {toast(error.message,true);button.disabled = false;button.innerHTML = oldText;}
  finally {ui.busy = false;}
}
async function preview(button) {
  const schedule = currentSchedule();if (!schedule || ui.busy) return;
  const index = Number(document.querySelector('#preview-segment').value), kind = document.querySelector('#preview-kind').value;
  const segment = schedule.segments[index], location = locationById(segment.locationId), scenario = document.querySelector('#preview-scenario').value;
  const timestamp = `${schedule.date}T${kind === 'in' ? segment.start : segment.end}:00+08:00`;
  const result = document.querySelector('#preview-result');button.disabled = true;ui.busy = true;
  try {
    const data = await api('/api/checkin/preview',{employeeId:currentEmployeeId(),scheduleId:schedule.id,segmentIndex:index,kind,latitude:location.latitude+(scenario === 'outside' ? .01 : 0),longitude:location.longitude,coordinateSystem:location.coordinateSystem || 'wgs84',accuracy:scenario === 'inaccurate' ? Math.max(location.radius+10,150) : 5,locatedAt:timestamp,timestamp});
    result.className = 'preview-result';result.textContent = `校验通过 · 距地点中心 ${Number(data.record?.distance || 0).toFixed(1)} 米\n这是规则试算，未保存打卡记录。`;
  } catch (error) {result.className = 'preview-result error';result.textContent = `校验未通过：${error.message}\n这是规则试算，未保存打卡记录。`;}
  finally {button.disabled = false;ui.busy = false;}
}
function navigate(view) {if (!views[view]) return;ui.view = view;ui.search = '';if (location.hash !== `#${view}`) location.hash = view;else render();}

document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]');if (!button || button.disabled) return;
  const action = button.dataset.action;
  switch (action) {
    case 'navigate': navigate(button.dataset.view);break;
    case 'schedule-tab':ui.scheduleTab = button.dataset.tab;renderSchedules();break;
    case 'record-tab':ui.recordTab = button.dataset.tab;renderRecords();break;
    case 'load-summary':await loadAttendanceSummary();break;
    case 'new-template':openDrawer('template');break;
    case 'edit-template':openDrawer('template',(ui.db.shiftTemplates || []).find(item => item.id === button.dataset.id));break;
    case 'apply-template':applyTemplate();break;
    case 'delete-template':await deleteTemplate();break;
    case 'logout':try {await api('/auth/logout',{});location.reload();} catch (error) {toast(error.message,true);}break;
    case 'previous-week':ui.week = addDays(ui.week,-7);renderSchedules();break;
    case 'next-week':ui.week = addDays(ui.week,7);renderSchedules();break;
    case 'this-week':ui.week = monday(ui.db.today);renderSchedules();break;
    case 'new-schedule':openDrawer('schedule');break;
    case 'edit-schedule':openDrawer('schedule',ui.db.schedules.find(s => s.employeeId === button.dataset.employee && s.date === button.dataset.date),button.dataset.employee,button.dataset.date);break;
    case 'new-location':openDrawer('location');break;
    case 'edit-location':openDrawer('location',locationById(button.dataset.id));break;
    case 'new-employee':openDrawer('employee');break;
    case 'edit-employee':openDrawer('employee',employeeById(button.dataset.id));break;
    case 'close-drawer':if (!ui.busy) closeDrawer();break;
    case 'add-segment':{const rows = document.querySelectorAll('.segment-row');if (rows.length >= 12) return toast('每个工作日最多安排 12 个时段',true);document.querySelector('#segment-list').insertAdjacentHTML('beforeend',segmentRow({start:'18:00',end:'20:00',locationId:ui.db.locations[0]?.id},ui.drawer?.type !== 'template'));break;}
    case 'remove-segment':if (document.querySelectorAll('.segment-row').length <= 1) return toast('请至少保留一个工作时段',true);button.closest('.segment-row').remove();break;
    case 'delete-schedule':await deleteSchedule();break;
    case 'reset-record-filters':ui.recordFrom = '';ui.recordTo = '';ui.recordEmployee = '';ui.recordStatus = '';renderRecords();break;
    case 'checkin':await checkin(button);break;
    case 'preview':await preview(button);break;
    case 'retry':await init();break;
  }
});
document.addEventListener('input', event => {if (event.target.id === 'schedule-search') {ui.search = event.target.value;document.querySelector('#schedule-grid').innerHTML = scheduleTable();}if (event.target.id === 'employee-search') {ui.search = event.target.value;document.querySelector('#employee-grid').innerHTML = employeeRows();}});
document.addEventListener('change', event => {
  const fields = {'record-from':'recordFrom','record-to':'recordTo','record-employee':'recordEmployee','record-status':'recordStatus'};
  if (fields[event.target.id]) {ui[fields[event.target.id]] = event.target.value;renderRecords();}
  if (event.target.id === 'summary-from') ui.summaryFrom = event.target.value;
  if (event.target.id === 'summary-to') ui.summaryTo = event.target.value;
  if (event.target.id === 'checkin-employee') {ui.employee = event.target.value;renderCheckin();}
});
document.querySelector('#drawer-form').addEventListener('submit',saveDrawer);
drawer.addEventListener('cancel',event => {if (ui.busy) event.preventDefault();else ui.drawer = null;});
window.addEventListener('hashchange',() => {ui.view = location.hash.slice(1) || 'schedules';if (!views[ui.view]) ui.view = 'schedules';render();});
async function init() {
  try {await refresh();ui.view = location.hash.slice(1) || (isAdmin() ? 'schedules' : 'checkin');if (!views[ui.view]) ui.view = 'schedules';render();}
  catch (error) {main.innerHTML = `<div class="error-page"><h2>${error.status === 401 || error.status === 403 ? '登录自定义考勤' : '暂时无法加载'}</h2><p>${esc(error.message)}</p>${error.status === 401 || error.status === 403 ? `<a class="button primary" href="/auth/login${location.hash === '#checkin' ? '?view=checkin' : ''}">使用飞书身份登录</a>` : '<button class="button primary" data-action="retry">重新加载</button>'}</div>`;}
}
init();
