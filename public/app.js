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
const icon = name => `<svg class="app-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.info}</svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const safeColor = value => /^#[a-fA-F0-9]{6}$/.test(value || '') ? value : '#3370ff';
const weekdays = ['一','二','三','四','五','六','日'];
const views = {overview:['首页','building','首页'],locations:['考勤地点','pin','地点'],groups:['考勤组','building','考勤组'],employees:['人员管理','users','人员'],schedules:['排班','calendar','排班'],records:['考勤记录','records','记录'],checkin:['我的打卡','checkin','打卡'],requests:['请假与加班','calendar','申请'],integration:['飞书接入','link','接入']};
const ui = {previewRole:'',group:'',directory:null,directorySearch:'',directoryDepartment:'',directorySelected:new Set(),db:null,view:'overview',guided:false,week:null,search:'',employee:'',recordFrom:'',recordTo:'',recordEmployee:'',recordStatus:'',scheduleTab:'personal',recordTab:'flow',summaryFrom:'',summaryTo:'',summary:null,summaryError:'',summaryLoading:false,drawer:null,busy:false};
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
function activeLocations() {return ui.db.locations.filter(location => !location.archived);}
function activeEmployees() {return ui.db.employees.filter(employee => !employee.removed);}
function hasPunches(schedule) {return ui.db.records.some(record => record.scheduleId === schedule.id);}
function toast(message, error = false) {const node = document.querySelector('#toast');node.textContent = message;node.className = `toast visible${error ? ' error' : ''}`;clearTimeout(toastTimer);toastTimer = setTimeout(() => node.classList.remove('visible'), error ? 6000 : 3500);}
async function api(path, body, method = 'POST') {
  if (ui.previewRole && body !== undefined) throw new Error('角色预览仅供查看。切回组织管理员后再操作。');
  const options = body === undefined ? {headers:{Accept:'application/json'}} : {method,headers:{'Content-Type':'application/json','X-Requested-With':'fetch'},body:JSON.stringify(body)};
  if (ui.previewRole) options.headers['X-Attendance-Preview'] = ui.previewRole;
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) {const error = new Error(data.error || '请求失败，请稍后再试');error.status = response.status;throw error;}
  return data;
}
async function refresh() {ui.db = await api('/api/state');if (ui.group && !ui.db.groups.some(g => g.id === ui.group)) ui.group = '';if (!ui.week) ui.week = monday(ui.db.today);if (!employeeById(ui.employee) || employeeById(ui.employee).disabled) ui.employee = ui.db.session?.employeeId || activeEmployees().find(e => !e.disabled)?.id || '';}
function isAdmin() {return ['org_admin','group_admin'].includes(ui.db.session?.role);}
function isOrgAdmin() {return ui.db.session?.role === 'org_admin';}
const roleLabels = {user:'普通用户',group_admin:'组长',org_admin:'组织管理员'};
function managedGroups() {return ui.db.groups.filter(g => isOrgAdmin() || ui.db.session.managedGroupIds.includes(g.id));}
function groupName(id) {return ui.db.groups.find(g => g.id === id)?.name || '未分组';}
function visibleViews() {return isOrgAdmin() ? Object.keys(views) : isAdmin() ? ['overview','groups','employees','schedules','records','checkin','requests'] : ['checkin','schedules','requests','records'];}
function previewControl() {
  if (!ui.db.previewGroups) return '';
  const options = [['','组织管理员'],['user','普通成员'],...ui.db.previewGroups.map(g => [`group:${g.id}`,`组长 · ${g.name}`])];
  return `<label class="preview-control"><span>角色预览</span><select data-role-preview aria-label="预览角色">${options.map(([value,label]) => `<option value="${esc(value)}" ${ui.previewRole === value ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></label>`;
}
async function switchPreview(value) {
  if (ui.busy || ui.previewRole === value) return;
  const previous = ui.previewRole;
  ui.previewRole = value;
  ui.busy = true;
  workflowLoad++;
  try {
    await refresh();
    ui.group = ui.recordFrom = ui.recordTo = ui.recordEmployee = ui.recordStatus = '';
    ui.summary = null;summaryRequest++;
    ui.recordTab = 'flow';ui.scheduleTab = 'personal';ui.guided = false;
    ui.employee = ui.db.session?.employeeId || ui.db.employees.find(e => !e.disabled)?.id || '';
    navigate(isAdmin() ? 'overview' : 'checkin');
  } catch (error) {
    ui.previewRole = previous;
    render();
    toast(error.message,true);
  } finally {ui.busy = false;}
}
function renderShell() {
  const available=visibleViews(), primary=isAdmin() ? ['overview','schedules','records','checkin'] : available;
  const secondary=available.filter(key=>!primary.includes(key));
  const navButton=(key,extra='')=>`<button class="nav-button ${extra} ${ui.view === key ? 'active' : ''}" data-action="navigate" data-view="${key}" aria-label="${views[key][0]}" ${ui.view === key ? 'aria-current="page"' : ''} title="${views[key][0]}">${icon(views[key][1])}<span class="nav-label-full">${!isAdmin() && key === 'schedules' ? '我的排班' : views[key][0]}</span><span class="nav-label-mobile" aria-hidden="true">${views[key][2]}</span></button>`;
  const reminderButton = extra => `<button class="nav-button ${extra}" type="button" data-action="reminders" title="我的提醒" aria-label="我的提醒">${icon('clock')}<span class="nav-label-full">我的提醒</span></button>`;
  document.querySelector('#navigation').innerHTML=available.map(key=>`${key === 'checkin' && isAdmin() ? '<div class="nav-separator"></div>' : ''}${navButton(key,secondary.includes(key)?'nav-secondary':'')}`).join('')+
    reminderButton('nav-secondary') +
    `<details class="nav-more"><summary class="nav-button ${secondary.includes(ui.view)?'active':''}">${icon('plus')}<span>更多</span></summary><div class="nav-more-panel">${secondary.map(key=>navButton(key)).join('')}${reminderButton('')}${previewControl()}</div></details>`;
  document.querySelector('#role-preview').innerHTML = previewControl();
  document.querySelector('#breadcrumb-label').textContent = !isAdmin() && ui.view === 'schedules' ? '我的排班' : views[ui.view][0];
  document.querySelector('#mode-label').hidden = ui.db.mode !== 'demo';
  const notice = document.querySelector('#preview-notice');
  notice.hidden = !ui.previewRole;
  notice.textContent = ui.previewRole ? `${roleLabels[ui.db.session.role]}视角 · 只读预览` : '';


  const employee = employeeById(ui.db.session?.employeeId);
  document.querySelector('.sidebar-user .avatar').textContent = employee?.name.slice(-1) || '管';
  document.querySelector('#user-label').innerHTML = `${esc(employee?.name || '组织管理员')}<small>${roleLabels[ui.db.session.role]}</small>`;
  document.title = `${views[ui.view][0]} · 灵活考勤`;
}
function pageHeader(title, subtitle, action = '') {return `<div class="page-header"><div><h1>${title}</h1><p>${subtitle}</p></div>${action}</div>`;}
function render() {
  if (!ui.db) return;
  if (ui.view === 'departments' && isAdmin()) ui.view = 'employees';
  if (!visibleViews().includes(ui.view)) ui.view = isAdmin() ? 'overview' : 'checkin';
  renderShell();main.className = `${ui.view === 'checkin' ? 'checkin-page ' : ''}view-enter`;
  const renderers = {overview:renderOverview,schedules:renderSchedules,locations:renderLocations,employees:renderEmployees,groups:renderGroups,records:renderRecords,checkin:renderCheckin,requests:renderRequests,integration:renderIntegration};
  renderers[ui.view]();
}
function labelTableCells(root = main) {
  for (const table of root.querySelectorAll('.data-table')) {
    table.setAttribute('role', 'table');
    const labels = [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
    for (const row of table.querySelectorAll('tbody tr')) [...row.cells].forEach((cell, index) => {cell.dataset.label = labels[index] || '';});
  }
}
function setupSteps() {
  const active = activeEmployees();
  const groups = managedGroups().filter(g => (!ui.group || g.id === ui.group) &&
    (g.id !== 'default-group' || g.name !== '默认考勤组' || active.some(e => e.groupId === g.id)));
  const ids = new Set(groups.map(g => g.id));
  const employees = active.filter(e => !e.disabled && ids.has(e.groupId));
  const locations = activeLocations();
  const schedules = ui.db.schedules.filter(s => ids.has(s.groupId) && s.date >= ui.db.today);
  return [
    ...(isOrgAdmin() ? [
      {id:'locations',title:'设置考勤地点',done:locations.length > 0,detail:locations.length ? `已有 ${locations.length} 个地点。` : '搜索园区或楼栋，在地图选点并确认打卡半径。',button:'设置地点'},
      {id:'groups',title:'建立考勤组',done:groups.length > 0,detail:groups.length ? `当前可使用${groups.length === 1 ? `“${groups[0].name}”` : ` ${groups.length} 个考勤组`}，也可以新建组。` : '按团队建立考勤组，之后从组织选择成员。',button:'管理考勤组'},
    ] : []),
    {id:'employees',title:'从组织选择成员',done:employees.some(e => e.bound || ui.db.mode === 'demo'),detail:employees.length ? `当前范围已有 ${employees.length} 位成员；角色和所属组可在人员管理中调整。` : '选择飞书部门和成员，加入当前考勤组，自动绑定打卡身份。',button:'选择成员'},
    {id:'schedules',title:'安排工作时间和地点',done:schedules.length > 0,detail:schedules.length ? `已有 ${schedules.length} 份今天或之后的排班，保存后成员即可看到。` : '选择成员和日期，为每个工作时段指定打卡地点。',button:'安排排班'},
  ];
}
function renderOverview() {
  if (!isOrgAdmin()) return renderLeader();
  const steps = setupSteps(), next = steps.find(step => !step.done);
  const ready = !schedulePrerequisite();
  main.innerHTML = `${pageHeader(isOrgAdmin() ? '开始管理考勤' : '考勤组工作台',isOrgAdmin() ? '按顺序完成配置，让成员在手机飞书中顺利打卡。' : '从组内成员到排班、打卡记录，只管理你负责的考勤组。')}
    <section class="panel setup-guide" aria-label="考勤配置进度">${groupFilter()}
    <div class="setup-next"><div><h2>${next ? next.title : '考勤已开始运行'}</h2><p>${esc(next ? next.detail : '继续安排班次，及时核对打卡记录与异常。')}</p></div><button class="button primary" data-action="setup-step" data-step="${next?.id || 'schedules'}">${next?.button || '管理排班'}${icon('arrow')}</button></div>
    <ol class="setup-list">${steps.map((step,index) => `<li ${next === step ? 'aria-current="step"' : ''}><span class="setup-index ${step.done ? 'done' : ''}">${step.done ? icon('checkin') : index+1}</span><div><h3>${step.title}<span class="status ${step.done ? '' : 'muted'}">${step.done ? '已具备' : next === step ? '下一步' : '待完成'}</span></h3><p>${esc(step.detail)}</p></div><button class="text-button" data-action="setup-step" data-step="${step.id}">${step.done ? '查看' : step.button}</button></li>`).join('')}</ol></section>
    ${!isOrgAdmin() && !activeLocations().length ? `<div class="info-banner warning">${icon('info')}<p>还没有考勤地点，请组织管理员先设置地点。</p></div>` : ''}
    <div class="overview-actions"><button class="button" data-action="navigate" data-view="schedules" ${ready ? '' : 'disabled'}>查看排班</button><button class="button" data-action="navigate" data-view="records">核对打卡记录</button><button class="text-button" data-action="navigate" data-view="checkin">我的打卡</button></div>`;
}
function renderLeader() {
  const groups = managedGroups().filter(g => !ui.group || ui.group === g.id);
  const today = ui.db.today;
  const panels = groups.map(group => {
    const records = ui.db.records.filter(r => r.groupId === group.id && r.date === today);
    const schedules = ui.db.schedules.filter(s => s.groupId === group.id && s.date === today);
    const members = activeEmployees().filter(e => e.groupId === group.id && !e.disabled);
    return `<section class="panel leader-panel" aria-label="${esc(group.name)}">
      <div class="toolbar"><h2>${esc(group.name)}</h2><span>${members.length} 位成员 · ${records.length} 条今日打卡</span>
      <button class="text-button ml-auto" data-action="leader-records" data-id="${esc(group.id)}">查看组内记录</button></div>
      <div class="table-scroll"><table class="data-table"><thead><tr><th>成员</th><th>今日打卡</th><th>最近一次</th></tr></thead>
      <tbody>${members.map(member => {
        const punches = records.filter(r => r.employeeId === member.id);
        const latest = punches.reduce((last,r) => !last || r.timestamp > last.timestamp ? r : last,null);
        const schedule = schedules.find(s => s.employeeId === member.id);
        const count = schedule ? punches.filter(r => r.scheduleId === schedule.id).length : 0;
        const result = schedule ? `已打 ${count} / ${schedule.segments.length * 2}` : punches.length ? `已打 ${punches.length} 次` : '未排班';
        const latestStatus = latest && ({normal:'正常',late:'迟到',early:'早退'}[latest.status] || '');
        return `<tr><td><strong>${esc(member.name)}</strong></td><td>${result}</td><td>${latest ? `${displayTime(latest.timestamp)} · ${latest.kind === 'in' ? '上班' : '下班'} · ${latestStatus}` : '—'}</td></tr>`;
      }).join('')}</tbody></table></div>
      ${members.length ? '' : '<p class="empty-state">本组暂无成员</p>'}</section>`;
  });
  main.innerHTML = `${pageHeader('组长工作台',`${today} · 组内打卡情况`)}${groups.length > 1 || ui.group ? groupFilter() : ''}${panels.join('')}`;
  labelTableCells();
}
async function startSetupStep(id) {
  if (!isAdmin()) return;
  const step = setupSteps().find(item => item.id === id);if (!step) return;
  ui.guided = true;
  if (id === 'schedules') ui.scheduleTab = 'personal';
  navigate(step.id);
  if (id === 'locations' && !step.done) openDrawer('location');
  if (id === 'groups' && !step.done) openDrawer('group');
  if (id === 'employees' && !step.done) {if (ui.db.mode === 'feishu') await openDirectory();else openDrawer('employee');}
  if (id === 'schedules' && !step.done) openDrawer('schedule');
}
function schedulePrerequisite() {
  if (!activeLocations().length) return {text:isOrgAdmin() ? '先设置打卡地点，再安排工作时段。' : '请联系组织管理员设置考勤地点。',view:isOrgAdmin() ? 'locations' : 'overview',action:isOrgAdmin() ? '去设置地点' : '返回首页'};
  if (!managedGroups().length) return {text:'请先创建考勤组。',view:'groups',action:'去建考勤组'};
  if (!activeEmployees().some(e => !e.disabled && e.manageable && (!ui.group || e.groupId === ui.group))) return {text:'当前范围还没有可排班成员，请先从组织选择成员。',view:'employees',action:'去选择成员'};
  return null;
}
function scheduleTable() {
  const dates = Array.from({length:7},(_,i) => addDays(ui.week,i));
  const employees = ui.db.employees.filter(employee => (!employee.removed || dates.some(date => ui.db.schedules.some(s => s.employeeId === employee.id && s.date === date))) && (!ui.group || employee.groupId === ui.group) && `${employee.name} ${employee.department} ${employee.employeeNo}`.toLowerCase().includes(ui.search.toLowerCase()));
  return `<div class="table-scroll"><table class="schedule-table" role="table"><thead><tr><th>员工 / 部门</th>${dates.map((date,i) => `<th class="${i > 4 ? 'weekend' : ''}"><div class="day-header ${date === ui.db.today ? 'is-today' : ''}"><span>周${weekdays[i]}</span><span class="day-number">${Number(date.slice(8))}</span></div></th>`).join('')}</tr></thead><tbody>${employees.map(employee => `<tr><td class="employee-cell"><div class="employee-identity"><span class="avatar">${esc(employee.name.slice(-1))}</span><div><strong>${esc(employee.name)}</strong><small>${esc(employee.department || employee.employeeNo)}</small></div></div></td>${dates.map((date,i) => {const schedule = ui.db.schedules.find(s => s.employeeId === employee.id && s.date === date);return `<td class="${i > 4 ? 'weekend' : ''}" data-label="周${weekdays[i]} ${Number(date.slice(5,7))}/${Number(date.slice(8))}"><button class="schedule-cell-button" data-action="edit-schedule" data-employee="${esc(employee.id)}" data-date="${date}" aria-label="${schedule ? '查看' : '新增'}${esc(employee.name)}${monthDay(date)}排班" ${employee.manageable && (schedule || !employee.disabled) ? '' : 'disabled'}>${schedule ? schedule.segments.map(segment => {const location = locationById(segment.locationId);return `<span class="shift" style="--location:${safeColor(location?.color)}"><span class="shift-location">${esc(location?.name || '地点不可用')}</span><span class="shift-time">${esc(segment.start)} – ${esc(segment.end)}</span></span>`;}).join('') : '<span class="empty-cell"><b>+</b>未排班</span>'}</button></td>`;}).join('')}</tr>`).join('')}</tbody></table>${!employees.length ? '<div class="empty-state inline">没有匹配的员工</div>' : ''}</div>`;
}
function scheduleTabs() {if (!isOrgAdmin()) return '';return `<nav class="page-tabs" aria-label="排班视图"><button data-action="schedule-tab" data-tab="personal" class="${ui.scheduleTab === 'personal' ? 'active' : ''}" aria-pressed="${ui.scheduleTab === 'personal'}">个人排班</button><button data-action="schedule-tab" data-tab="templates" class="${ui.scheduleTab === 'templates' ? 'active' : ''}" aria-pressed="${ui.scheduleTab === 'templates'}">班次模板</button></nav>`;}
function renderTemplates() {
  const templates = ui.db.shiftTemplates || [];
  main.innerHTML = `${pageHeader('排班','先配好时间和地点，再把班次分给成员。',`<button class="button primary" data-action="new-template">${icon('plus')}新增班次</button>`)}${scheduleTabs()}<section class="panel"><div class="table-scroll"><table class="data-table template-table"><thead><tr><th>班次名称</th><th>工作时段</th><th>备注</th><th>操作</th></tr></thead><tbody>${templates.map(template => `<tr><td><strong>${esc(template.name)}</strong><small>${template.segments.length} 个工作时段</small></td><td><div class="template-times">${template.segments.map(segment => `<span>${esc(segment.start)}–${esc(segment.end)} · ${esc((!locationById(segment.locationId)?.archived && locationById(segment.locationId)?.name) || '待设置地点')}</span>`).join('')}</div></td><td>${esc(template.note || '—')}</td><td><div class="row-actions"><button class="text-button" data-action="assign-template" data-id="${esc(template.id)}">分配人员</button><button class="text-button" data-action="edit-template" data-id="${esc(template.id)}">编辑班次</button></div></td></tr>`).join('')}</tbody></table>${!templates.length ? `<div class="empty-state">${icon('clock')}还没有班次模板<p>将常用工作时间保存为模板，方便批量安排员工排班。</p><button class="button" data-action="new-template">新增班次</button></div>` : ''}</div><div class="panel-footer"><span>共 ${templates.length} 个班次模板</span><span>修改或删除模板不会影响已保存的排班</span></div></section>`;
  labelTableCells();
}
function renderSchedules() {
  if (!isAdmin()) return renderPersonalSchedule();
  if (ui.scheduleTab === 'templates' && isOrgAdmin()) return renderTemplates();
  const prerequisite = schedulePrerequisite();
  if (prerequisite && !ui.db.schedules.length) {main.innerHTML = `${pageHeader('排班','先准备地点和成员，再安排工作时段。')}${scheduleTabs()}<section class="panel empty-state">${icon('calendar')}<h2>还差一步就能排班</h2><p>${esc(prerequisite.text)}</p><button class="button primary" data-action="navigate" data-view="${prerequisite.view}">${prerequisite.action}</button></section>`;return;}
  const weekSchedules = ui.db.schedules.filter(s => s.date >= ui.week && s.date <= addDays(ui.week,6));
  const totalSegments = weekSchedules.reduce((total,s) => total+s.segments.length,0);
  main.innerHTML = `${pageHeader('排班','一次安排一段时间，也可以按需添加多个时段。',isAdmin() ? `<button class="button primary" data-action="new-schedule" ${prerequisite ? 'disabled' : ''}>${icon('plus')}新增排班</button>` : '')}${scheduleTabs()}
    <section class="panel" aria-label="员工周排班表"><div class="toolbar"><div class="week-control"><span class="week-label">${monthDay(ui.week)} — ${monthDay(addDays(ui.week,6))}</span><button class="icon-button" data-action="previous-week" aria-label="上一周">${icon('left')}</button><button class="icon-button" data-action="next-week" aria-label="下一周">${icon('right')}</button><button class="today-button" data-action="this-week">本周</button></div><label class="search-box">${icon('search')}<input type="search" id="schedule-search" placeholder="搜索姓名、部门或工号" value="${esc(ui.search)}" aria-label="搜索员工"></label><label class="jump-date">跳到日期 <input type="date" id="jump-schedule-date" value="${ui.week}"></label></div>${isAdmin() ? groupFilter() : ''}<div id="schedule-grid">${scheduleTable()}</div><div class="panel-footer"><div class="location-legend">${activeLocations().map(location => `<span class="legend-item"><i class="dot" style="--location:${safeColor(location.color)}"></i>${esc(location.name)} · ${location.radius} 米</span>`).join('')}</div><span>${new Set(weekSchedules.map(s => s.employeeId)).size} 位员工已排班 · ${totalSegments} 个工作时段</span></div></section>
    <div class="hint-line">${icon('info')}<span>每个时段分别校验指定地点，未排班日期无需打卡。${ui.db.mode === 'demo' ? '当前使用示例数据。' : ''}</span></div>`;
}
function renderPersonalSchedule() {
  const dates = Array.from({length:7},(_,index) => addDays(ui.week,index));
  main.innerHTML = `${pageHeader('我的排班','确认工作时间和地点，到指定地点完成打卡。',`<button class="button primary" data-action="navigate" data-view="checkin">今日打卡</button>`)}<section class="panel personal-schedule"><div class="toolbar"><div class="week-control"><span class="week-label">${monthDay(ui.week)} — ${monthDay(addDays(ui.week,6))}</span><button class="icon-button" data-action="previous-week" aria-label="上一周">${icon('left')}</button><button class="icon-button" data-action="next-week" aria-label="下一周">${icon('right')}</button><button class="today-button" data-action="this-week">本周</button></div></div><ol class="personal-days">${dates.map((date,index) => {const schedule = ui.db.schedules.find(s => s.employeeId === currentEmployeeId() && s.date === date);return `<li><div class="personal-date"><strong>${monthDay(date)} · 周${weekdays[index]}</strong>${date === ui.db.today ? '<span class="status">今天</span>' : ''}</div><div>${schedule ? schedule.segments.map(segment => `<p><strong>${esc(segment.start)}–${esc(segment.end)}</strong><span>${esc(locationById(segment.locationId)?.name || '地点待确认')}</span></p>`).join('') : '<p class="muted">未安排班次</p>'}</div></li>`;}).join('')}</ol></section>`;
}
function renderLocations() {
  const locations = activeLocations();
  main.innerHTML = `${pageHeader('考勤地点','设置园区与楼栋位置，按米配置打卡范围。',`<button class="button primary" data-action="new-location">${icon('plus')}新增地点</button>`)}${ui.db.mode === 'demo' ? `<div class="info-banner warning">${icon('info')}<p>以下为演示地点。正式使用前，请搜索真实园区或楼栋并确认打卡范围。</p></div>` : ''}<div class="location-grid">${locations.map(location => `<article class="location-tile"><div class="location-diagram" aria-label="${esc(location.name)}半径${location.radius}米范围示意"><div class="radius-circle">${icon('building')}<span>半径 ${location.radius} m</span></div><span class="diagram-label">范围示意 · 非实景地图</span></div><div class="location-body"><div class="location-title"><h3><i class="dot" style="--location:${safeColor(location.color)}"></i>${esc(location.name)}</h3></div><p>${esc(location.address || '尚未填写地址')}</p><div class="row-actions"><button class="text-button" data-action="edit-location" data-id="${esc(location.id)}">编辑</button><button class="text-button danger" data-action="remove-location" data-id="${esc(location.id)}">删除地点</button></div></div></article>`).join('')}</div>${!locations.length ? `<div class="panel empty-state">${icon('pin')}尚未添加考勤地点<p>先设置地点，再为员工安排工作时段。</p><button class="button" data-action="new-location">新增地点</button></div>` : ''}<div class="hint-line">${icon('info')}<span>打卡时同时校验距离和定位精度；位置误差范围需要完全处于打卡半径内。楼栋半径可设置为 100 米。</span></div>`;
}
function groupFilter() {return `<div class="group-filter"><label>考勤组 <select id="group-filter"><option value="">全部可见考勤组</option>${managedGroups().map(g => `<option value="${esc(g.id)}" ${ui.group === g.id ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label></div>`;}
function employeeRows() {
  const employees = activeEmployees().filter(e => (!ui.group || e.groupId === ui.group) && `${e.name} ${e.department} ${e.employeeNo}`.toLowerCase().includes(ui.search.toLowerCase()));
  return `<table class="data-table"><thead><tr><th>成员</th><th>部门</th><th>考勤组</th><th>角色</th><th>飞书身份</th>${isOrgAdmin() ? '<th>操作</th>' : ''}</tr></thead><tbody>${employees.map(e => `<tr><td><div class="employee-identity"><span class="avatar">${esc(e.name.slice(-1))}</span><div><strong>${esc(e.name)}</strong><small>${esc(e.employeeNo || '')}</small></div></div></td><td>${esc(e.department || '—')}</td><td>${esc(groupName(e.groupId))}</td><td>${roleLabels[e.role] || '普通用户'}</td><td><span class="status ${e.bound ? '' : 'muted'}">${e.disabled ? '组织账号已停用' : e.bound ? '已绑定' : '演示人员'}</span></td>${isOrgAdmin() ? `<td><div class="row-actions"><button class="text-button" data-action="${ui.db.mode === 'demo' ? 'edit-employee' : 'edit-access'}" data-id="${esc(e.id)}">编辑</button>${!e.bootstrapAdmin && e.id !== ui.db.session.employeeId ? `<button class="text-button danger" data-action="remove-employee" data-id="${esc(e.id)}">移除</button>` : ''}</div></td>` : ''}</tr>`).join('')}</tbody></table>${!employees.length ? '<div class="empty-state">暂无匹配的成员</div>' : ''}`;
}
function renderEmployees() {
  const canAdd = managedGroups().length > 0;
  const add = ui.db.mode === 'feishu' ? 'open-directory' : 'new-employee';
  main.innerHTML = `${pageHeader('人员管理',isOrgAdmin() ? '从飞书组织选择成员，设置考勤组和角色。' : '管理所负责考勤组的成员。',canAdd ? `<button class="button primary" data-action="${add}">${icon('plus')}${ui.db.mode === 'feishu' ? '从组织添加' : '新增演示人员'}</button>` : `<button class="button primary" data-action="navigate" data-view="groups">先创建考勤组</button>`)}<section class="panel"><div class="toolbar"><strong>成员 ${activeEmployees().filter(e => !ui.group || e.groupId === ui.group).length}</strong><label class="search-box">${icon('search')}<input type="search" id="employee-search" placeholder="搜索姓名、部门或工号" value="${esc(ui.search)}" aria-label="搜索员工"></label></div>${groupFilter()}<div class="table-scroll" id="employee-grid">${employeeRows()}</div></section>`;
  labelTableCells();
}
function renderGroups() {
  main.innerHTML = `${pageHeader('考勤组',isOrgAdmin() ? '从飞书添加组员，再指定组长。' : '仅可管理自己负责的考勤组。',isOrgAdmin() ? `<button class="button primary" data-action="new-group">${icon('plus')}新增考勤组</button>` : '')}<section class="panel"><div class="table-scroll"><table class="data-table"><thead><tr><th>考勤组</th><th>成员</th><th>组长</th><th>操作</th></tr></thead><tbody>${managedGroups().map(g => `<tr><td><strong>${esc(g.name)}</strong></td><td>${activeEmployees().filter(e => e.groupId === g.id).length} 人</td><td>${g.adminIds.map(id => esc(employeeById(id)?.name || '已指定管理员')).join('、') || '由组织管理员管理'}</td><td><div class="row-actions"><button class="text-button" data-action="group-schedules" data-id="${esc(g.id)}">安排排班</button><button class="text-button" data-action="group-members" data-id="${esc(g.id)}">查看成员</button>${ui.db.mode === 'feishu' ? `<button class="text-button" data-action="group-add-members" data-id="${esc(g.id)}">添加成员</button>` : ''}${isOrgAdmin() ? `<button class="text-button" data-action="edit-group" data-id="${esc(g.id)}">编辑</button><button class="text-button danger" data-action="remove-group" data-id="${esc(g.id)}">删除组</button>` : ''}</div></td></tr>`).join('')}</tbody></table></div></section>`;
  labelTableCells();
}
function groupOptions(selected) {return managedGroups().map(g => `<option value="${esc(g.id)}" ${g.id === selected ? 'selected' : ''}>${esc(g.name)}</option>`).join('');}
function renderDirectoryUsers() {
  const target = document.querySelector('#directory-users');if (!target || !ui.directory) return;
  const users = ui.directory.users.filter(u => (!ui.directoryDepartment || u.departmentIds?.includes(ui.directoryDepartment)) && `${u.name} ${u.department}`.toLowerCase().includes(ui.directorySearch.toLowerCase()));
  target.innerHTML = users.map(u => `<label class="check-option"><input type="checkbox" data-directory-id="${esc(u.openId)}" ${ui.directorySelected.has(u.openId) ? 'checked' : ''}><span>${esc(u.name)}</span><small>${esc(u.department || '组织成员')}</small></label>`).join('') || '<p class="empty-state">没有匹配的组织成员</p>';
  document.querySelector('#directory-count').textContent = `已选择 ${ui.directorySelected.size} 人（最多 50 人）`;
}
async function openDirectory() {
  if (!isAdmin() || ui.busy) return;
  if (!managedGroups().length) {navigate('groups');return;}
  ui.directory = null;ui.directorySearch = '';ui.directoryDepartment = '';ui.directorySelected.clear();
  ui.drawer = {type:'directory'};const editing = ui.drawer;
  document.querySelector('#drawer-title').textContent = '从飞书组织添加成员';
  document.querySelector('#drawer-eyebrow').textContent = '人员管理';
  document.querySelector('#form-error').textContent = '';
  document.querySelector('#drawer-body').innerHTML = `<label class="field"><span class="field-label">加入考勤组</span><select name="groupId" required>${groupOptions(ui.group)}</select></label><div id="directory-content" aria-live="polite"><span class="spinner"></span> 正在读取飞书组织…</div>`;
  document.querySelector('#drawer-footer').innerHTML = '<button type="button" class="button" data-action="close-drawer">取消</button><button type="submit" class="button primary" id="save-button" disabled>添加所选成员</button>';
  if (!drawer.open) drawer.showModal();
  drawer.scrollTop = 0;
  try {
    const data = await api('/api/directory');if (ui.drawer !== editing) return;ui.directory = data;
    document.querySelector('#directory-content').innerHTML = `<p class="field-hint">仅显示应用已获授权的组织成员。选择后自动绑定飞书身份。</p>${data.notice ? `<p class="field-hint">${esc(data.notice)}</p>` : ''}<label class="field">搜索成员<input type="search" id="directory-search" placeholder="输入姓名或部门"></label><label class="field">部门<select id="directory-department"><option value="">全部授权部门</option>${data.departments.map(d => `<option value="${esc(d.id)}">${esc(d.name)}</option>`).join('')}</select></label><p id="directory-count" role="status"></p><div id="directory-users" class="employee-options directory-list"></div>`;
    renderDirectoryUsers();document.querySelector('#save-button').disabled = false;
  } catch (error) {if (ui.drawer === editing) document.querySelector('#directory-content').innerHTML = `<p role="alert">${esc(error.message)}</p><button type="button" class="button" data-action="open-directory">重试读取</button>`;}
}
function filteredRecords() {
  return ui.db.records.filter(record => (!ui.group || record.groupId === ui.group) && (!ui.recordFrom || record.date >= ui.recordFrom) && (!ui.recordTo || record.date <= ui.recordTo) && (!ui.recordEmployee || record.employeeId === ui.recordEmployee) && (!ui.recordStatus || record.status === ui.recordStatus)).sort((a,b) => b.timestamp.localeCompare(a.timestamp));
}
function recordTabs() {return `<nav class="page-tabs" aria-label="考勤记录视图"><button data-action="record-tab" data-tab="flow" class="${ui.recordTab === 'flow' ? 'active' : ''}" aria-pressed="${ui.recordTab === 'flow'}">打卡流水</button><button data-action="record-tab" data-tab="summary" class="${ui.recordTab === 'summary' ? 'active' : ''}" aria-pressed="${ui.recordTab === 'summary'}">考勤统计</button></nav>`;}
function recordActions() {
  if (!isAdmin() || ui.previewRole) return '';
  const ledger = ui.db.integration?.ledgerUrl;
  return `<div class="record-actions">${ledger ? `<a class="button primary" href="${esc(ledger)}" target="_blank" rel="noopener noreferrer">${icon('link')}打开飞书考勤台账</a>` : ''}<a class="button" href="/api/records.csv" download>${icon('download')}导出记录</a></div>`;
}
function renderAttendanceSummary() {
  if (!ui.summaryFrom) ui.summaryFrom = monday(ui.db.today);
  if (!ui.summaryTo) ui.summaryTo = ui.db.today;
  main.innerHTML = `${pageHeader('考勤记录','按排班统计应打、已打和缺卡情况。',recordActions())}${recordTabs()}<section class="panel"><div class="toolbar records-toolbar"><label class="filter-field">开始<input type="date" id="summary-from" value="${ui.summaryFrom}" aria-label="统计开始日期"></label><label class="filter-field">结束<input type="date" id="summary-to" value="${ui.summaryTo}" aria-label="统计结束日期"></label><button class="button small" data-action="load-summary">查询统计</button><span class="toolbar-note ml-auto">每次最多查询 31 天</span></div><div id="summary-content" aria-live="polite"></div></section><div class="hint-line">${icon('info')}<span>缺卡指打卡窗口已结束但尚未打卡；待打指窗口尚未结束。未排班日期不计入应打次数。</span></div>`;
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
  labelTableCells();
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
  main.innerHTML = `${pageHeader(isAdmin() ? '考勤记录' : '我的打卡记录',isAdmin() ? '核对打卡时间、指定地点与异常情况。' : '查看自己的打卡结果与异常情况。',recordActions())}${recordTabs()}${isAdmin() ? groupFilter() : ''}<section class="panel"><div class="toolbar records-toolbar"><label class="filter-field">开始<input type="date" id="record-from" value="${ui.recordFrom}" aria-label="记录开始日期"></label><label class="filter-field">结束<input type="date" id="record-to" value="${ui.recordTo}" aria-label="记录结束日期"></label><label class="filter-field">员工<select id="record-employee"><option value="">全部员工</option>${ui.db.employees.map(e => `<option value="${esc(e.id)}" ${ui.recordEmployee === e.id ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select></label><label class="filter-field">状态<select id="record-status"><option value="">全部状态</option>${Object.entries(statusLabel).map(([value,label]) => `<option value="${value}" ${ui.recordStatus === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label><button class="text-button ml-auto" data-action="reset-record-filters">重置筛选</button></div><div class="table-scroll"><table class="data-table"><thead><tr><th>员工 / 日期</th><th>打卡时间</th><th>指定地点</th><th>距中心 / 精度</th><th>状态</th><th>来源</th></tr></thead><tbody>${records.map(record => `<tr><td><strong>${esc(record.employeeName || employeeById(record.employeeId)?.name || '未知员工')}</strong><small>${esc(record.date)}</small></td><td><strong>${displayTime(record.timestamp)}</strong><small>第 ${record.segmentIndex+1} 时段 · ${record.kind === 'in' ? '上班' : '下班'}</small></td><td>${esc(record.locationName || locationById(record.locationId)?.name || '未知地点')}</td><td>${Number(record.distance).toFixed(1)} m <span class="muted">/ ±${Number(record.accuracy).toFixed(0)} m</span></td><td><span class="status ${record.status === 'normal' ? '' : 'warn'}">${statusLabel[record.status] || esc(record.status)}</span></td><td><span class="status muted">${record.source === 'demo' ? '演示打卡' : '飞书身份'}</span></td></tr>`).join('')}</tbody></table>${!records.length ? `<div class="empty-state">${icon('records')}暂无打卡记录<p>实际打卡成功后会在这里保存记录；规则试算不会写入记录。</p></div>` : ''}</div><div class="panel-footer"><span>共 ${records.length} 条记录</span><span>时间均为北京时间 · Asia/Shanghai</span></div></section>`;
  labelTableCells();
}
function currentEmployeeId() {return ui.db.mode === 'demo' && !ui.previewRole ? ui.employee : ui.db.session?.employeeId;}
function currentSchedule() {return ui.db.schedules.find(s => s.employeeId === currentEmployeeId() && s.date === ui.db.today);}
function recorded(schedule, index, kind) {return ui.db.records.find(r => r.scheduleId === schedule.id && r.segmentIndex === index && r.kind === kind);}
function renderCheckin() {
  const employee = employeeById(currentEmployeeId());
  const schedule = currentSchedule();
  const currentMinutes = displayTime(ui.db.now || new Date().toISOString()).split(':').reduce((hours,value,index) => hours + Number(value)*(index === 0 ? 60 : 1),0);
  const suggestedIndex = schedule ? schedule.segments.findIndex((segment,index) => {const [hour,minute] = segment.end.split(':').map(Number);return hour*60+minute+120 >= currentMinutes && (!recorded(schedule,index,'in') || !recorded(schedule,index,'out'));}) : -1;
  main.innerHTML = `${pageHeader('今日打卡','按排班到达指定地点，完成上、下班打卡。')}${ui.db.mode === 'demo' ? `<div class="info-banner warning">${icon('info')}<p>本地演示 · 可切换示例员工。定位打卡保存演示记录；规则试算不产生记录。</p></div>` : ''}<div class="checkin-layout"><section class="panel"><div class="checkin-header"><div><strong>${esc(employee?.name || '尚未绑定员工身份')}</strong><p>${ui.db.today} · 今日排班</p></div>${ui.db.mode === 'demo' && !ui.previewRole ? `<select class="employee-switch" id="checkin-employee" aria-label="切换演示员工">${activeEmployees().filter(e => !e.disabled).map(e => `<option value="${esc(e.id)}" ${e.id === ui.employee ? 'selected' : ''}>${esc(e.name)}</option>`).join('')}</select>` : '<span class="status">本人打卡</span>'}</div>${schedule ? schedule.segments.map((segment,index) => {const location = locationById(segment.locationId);return `<div class="checkin-day ${index === suggestedIndex ? 'current' : ''}"><div class="checkin-period"><span>时段 ${index+1}</span>${index === suggestedIndex ? '<span class="status muted">待完成</span>' : ''}</div><div class="checkin-time">${esc(segment.start)} <span class="muted">—</span> ${esc(segment.end)}</div><div class="checkin-place">${icon('pin')}${esc(location?.name || '未知地点')}</div><div class="checkin-radius">${esc(location?.address || '考勤地点')} · 打卡半径 ${location?.radius || 0} 米</div><div class="checkin-actions">${['in','out'].map(kind => {const record = recorded(schedule,index,kind);return `<button class="button ${index === suggestedIndex && kind === (recorded(schedule,index,'in') ? 'out' : 'in') ? 'primary' : ''}" data-action="checkin" data-index="${index}" data-kind="${kind}" ${record ? 'disabled' : ''}>${icon(record ? 'checkin' : 'pin')}${record ? `${kind === 'in' ? '上班' : '下班'}已打卡 ${displayTime(record.timestamp)}` : `${kind === 'in' ? '上班' : '下班'}定位打卡`}</button>`;}).join('')}</div></div>`;}).join('') : `<div class="empty-state">${icon('calendar')}${employee ? '今日未安排班次' : '请先绑定员工身份'}<p>${employee ? isAdmin() ? '先完成地点和成员配置，再安排今天的班次。' : '请联系考勤组管理员确认今天的安排。' : '请联系管理员从飞书组织中将你加入考勤组。'}</p><button class="button" data-action="navigate" data-view="${isAdmin() ? 'overview' : 'schedules'}">${isAdmin() ? '继续配置考勤' : '查看我的排班'}</button></div>`}</section><aside class="help-panel"><details class="rule-details"><summary>查看打卡规则</summary><ol><li><strong>按时段核对地点</strong><br>每个时段分别完成上、下班打卡，跨园区排班按照对应地点校验。</li><li><strong>允许定位权限</strong><br>使用手机并开启高精度定位。位置误差范围需完全落入考勤半径，精度须不大于半径且不超过 100 米。</li><li><strong>以服务器时间为准</strong><br>上班可提前 60 分钟打卡；下班最晚可在时段结束后 120 分钟打卡。晚到、早走将标记异常。</li></ol></details>${ui.db.mode === 'demo' && schedule ? `<div class="simulation"><h3>${icon('info')}规则试算 <span class="status muted">不写入记录</span></h3><p>使用指定位置和时段开始/结束时间，检查地点规则。</p><select id="preview-segment" aria-label="试算工作时段">${schedule.segments.map((segment,index) => `<option value="${index}">${segment.start}–${segment.end} · ${esc(locationById(segment.locationId)?.name)}</option>`).join('')}</select><select id="preview-kind" aria-label="试算打卡类型"><option value="in">上班打卡 · 时段开始时</option><option value="out">下班打卡 · 时段结束时</option></select><select id="preview-scenario" aria-label="试算定位场景"><option value="center">在指定地点中心 · 精度 5 米</option><option value="outside">偏离指定地点约 1 公里</option><option value="inaccurate">位于中心但定位精度不足</option></select><button class="button" data-action="preview">运行规则试算</button><div id="preview-result" role="status"></div></div>` : ''}</aside></div>`;
}
const requestStatusLabels = {PENDING:'审批中',APPROVED:'已通过',REJECTED:'已拒绝',CANCELED:'已撤回',DELETED:'已停用',REVERTED:'已撤销'};
const kindLabels = {leave:'请假',overtime:'加班'};
let workflowLoad = 0;
function fullDate(value) {return new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(new Date(value));}
function nativeLink(item) {return /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent) ? item.url || item.nativeUrl : item.desktopUrl || item.nativeDesktopUrl;}
async function renderRequests() {
  const request = ++workflowLoad;
  main.innerHTML = `${pageHeader('请假与加班','在飞书审批中提交申请，由教师组审批；通过后安排日历。','<button class="button" data-action="refresh-requests">刷新状态</button>')}<p role="status">正在读取申请…</p>`;
  try {
    const data = await api('/api/workflows');
    if (request !== workflowLoad || ui.view !== 'requests') return;
    ui.workflows = data;
    const requested = new URLSearchParams(location.search).get('request');
    const mine = data.requests.filter(r => r.employeeId === ui.db.session.employeeId);
    const others = data.requests.filter(r => r.employeeId !== ui.db.session.employeeId);
    const requestItem = r => `<article class="panel request-item" ${r.id === requested ? 'aria-label="当前申请"' : ''}>
      <div class="request-heading"><h2>${esc(kindLabels[r.kind])}${r.employeeId === ui.db.session.employeeId ? '' : ` · ${esc(r.employeeName)}`}</h2><span class="status ${r.status === 'APPROVED' ? '' : 'muted'}">${esc(requestStatusLabels[r.status])}</span></div>
      ${r.error ? `<p class="form-error" role="alert">${esc(r.error)}</p>` : r.ranges.map((range,index) => {
        const proof = r.verified.find(v => v.rangeIndex === index);
        return `<div class="request-range"><p><strong>${esc(fullDate(range.start))} — ${esc(fullDate(range.end))}</strong></p>
        ${r.kind === 'overtime' ? `<p class="subtle">${proof ? `已在${esc(proof.locationName)}核验 · ${esc(fullDate(proof.at))}` : '在获批时段内，到现场核验后加入日历。'}</p>` : ''}
        ${r.employeeId === ui.db.session.employeeId && r.kind === 'overtime' && r.status === 'APPROVED' && !proof ? `<div class="request-location"><label class="field">加班地点<select id="overtime-${esc(r.id)}-${index}" aria-label="加班地点">${data.locations.map(l=>`<option value="${esc(l.id)}">${esc(l.name)}</option>`).join('')}</select></label><button class="button primary" data-action="workflow-calendar" data-id="${esc(r.id)}" data-index="${index}" ${data.locations.length ? '' : 'disabled'}>定位核验并加入日历</button></div>` : ''}</div>`;
      }).join('')}
      <div class="request-footer"><a class="text-button" href="${esc(nativeLink(r))}">查看原审批</a>
      ${r.employeeId === ui.db.session.employeeId && r.kind === 'leave' && r.status === 'APPROVED' && !r.error && r.calendarStatus === 'none' ? `<button class="button primary" data-action="workflow-calendar" data-id="${esc(r.id)}">加入我的日历</button>` : ''}
      <span class="subtle">${r.calendarStatus === 'synced' ? '日历已同步' : r.calendarStatus === 'pending' ? '等待核验或日历同步' : '尚未加入日历'} · ${r.archiveStatus === 'synced' ? '已归档' : '等待归档'}</span></div></article>`;
    main.innerHTML = `${pageHeader('请假与加班','在飞书审批中提交申请，由教师组审批；通过后安排日历。','<button class="button" data-action="refresh-requests">刷新状态</button>')}
      ${!data.enabled ? '<div class="info-banner"><p>审批、日历和考勤台账正在接入。现有排班与打卡可继续使用。</p></div>' : ''}
      <div class="request-start">${Object.entries(kindLabels).map(([kind,label])=>`<section class="panel request-item"><h2>${label}</h2><p>${kind === 'leave' ? '填写请假时间与事由。审批通过后，卡片可一键加入自己的日历。' : '申请加班时间。审批通过后，抵达现场核验位置，再加入自己的日历。'}</p>${ui.previewRole ? '' : data.enabled && data.definitions[kind] ? `<a class="button primary" href="${esc(nativeLink(data.definitions[kind]))}">申请${label}</a>` : '<button class="button" disabled>等待接通</button>'}</section>`).join('')}</div>
      <div class="section-heading"><h2>我的申请</h2>${ui.previewRole ? '' : '<a class="text-button" href="/api/workflows.csv">导出申请记录</a>'}</div>
      <div class="request-list">${mine.map(requestItem).join('') || '<section class="panel empty-state">还没有申请。提交后返回此页，可查看审批与日历状态。</section>'}</div>
      ${isAdmin() && others.length ? `<div class="section-heading"><h2>管理范围内的申请</h2></div><div class="request-list">${others.map(requestItem).join('')}</div>` : ''}`;
  } catch (error) {if (ui.view === 'requests') main.innerHTML += `<p class="form-error" role="alert">${esc(error.message)}</p>`;}
}
async function workflowCalendar(button) {
  if (ui.busy) return;
  ui.busy=true;button.disabled=true;const old=button.textContent;
  try {
    const input={};
    if (button.dataset.index !== undefined) {
      input.rangeIndex=Number(button.dataset.index);
      input.locationId=document.getElementById(`overtime-${button.dataset.id}-${input.rangeIndex}`).value;
      button.textContent='正在通过飞书核验位置…';
      const position=await getPosition();
      Object.assign(input,{latitude:position.latitude,longitude:position.longitude,accuracy:position.accuracy,coordinateSystem:position.coordinateSystem,locatedAt:new Date(position.timestamp).toISOString()});
    }
    await api(`/api/workflows/${encodeURIComponent(button.dataset.id)}/calendar`,input);
    toast('已提交日历同步，稍后刷新可查看结果');await renderRequests();
  } catch(error) {toast(error.message,true);button.disabled=false;button.textContent=old;}
  finally {ui.busy=false;}
}
async function renderIntegration() {
  main.innerHTML=`${pageHeader('飞书接入','统一查看身份、审批、日历和考勤台账的连接状态。')}<p role="status">正在核对连接…</p>`;
  try {
    const data=await api('/api/workflows');if(ui.view!=='integration') return;
    main.innerHTML=`${pageHeader('飞书接入','统一查看身份、审批、日历和考勤台账的连接状态。')}<section class="panel request-item"><h2>灵活考勤</h2><p>工作台提供免登、排班、手机定位与个人记录；机器人提供打卡提醒和审批结果卡片。</p>
      <dl class="integration-status"><div><dt>飞书身份与组织选人</dt><dd>${ui.db.mode==='feishu'?'已接通':'本地演示'}</dd></div><div><dt>请假、加班与日历</dt><dd>${data.enabled?'已启用':'等待权限与审批配置'}</dd></div><div><dt>最近组织或审批事件</dt><dd>${data.status.lastEventAt?esc(fullDate(data.status.lastEventAt)):'尚未收到'}</dd></div><div><dt>自动归档</dt><dd>${data.status.archived} 条已同步 · ${data.status.pending} 项待处理</dd></div></dl>
      ${data.status.error?`<p class="form-error" role="alert">${esc(data.status.error)}</p>`:''}
      <div class="overview-actions"><button class="button" data-action="navigate" data-view="requests">查看申请</button>${data.tableUrl?`<a class="button" href="${esc(data.tableUrl)}" target="_blank" rel="noopener noreferrer">打开考勤台账</a>`:''}<a class="text-button" href="/api/records.csv">导出打卡记录</a></div></section>`;
  } catch(error) {if(ui.view==='integration') main.innerHTML+=`<p class="form-error" role="alert">${esc(error.message)}</p>`;}
}

function locationOptions(selected) {
  return '<option value="">选择地点</option>' + activeLocations().map(location =>
    `<option value="${esc(location.id)}" ${selected === location.id ? 'selected' : ''}>${esc(location.name)}</option>`).join('');
}
function segmentRow(segment = {start:'09:00',end:'18:00',locationId:activeLocations()[0]?.id}) {
  return `<div class="segment-row">
    <label class="field">上班时间<input type="time" class="segment-start" value="${esc(segment.start)}" required></label>
    <label class="field">下班时间<input type="time" class="segment-end" value="${esc(segment.end)}" required></label>
    <label class="field">考勤地点<select class="segment-location" required>${locationOptions(segment.locationId)}</select></label>
    <button type="button" class="icon-button" data-action="remove-segment" aria-label="移除时段">×</button>
  </div>`;
}
function shiftFields(segments) {
  return `<fieldset class="plan-fieldset"><legend>工作时间和地点</legend>
    <div id="segment-list">${segments?.map(segmentRow).join('') || segmentRow()}</div>
    <button type="button" class="text-button" data-action="add-segment">${icon('plus')}添加时段 · 精细排班</button>
  </fieldset>`;
}
function readSegments() {
  return [...document.querySelectorAll('#segment-list .segment-row')].map(row => ({
    start: row.querySelector('.segment-start').value,
    end: row.querySelector('.segment-end').value,
    locationId: row.querySelector('.segment-location').value,
  }));
}
function applyTemplate(templateId) {
  const template = ui.db.shiftTemplates.find(item => item.id === templateId);
  if (template) document.querySelector('#segment-list').innerHTML = template.segments.map(segmentRow).join('');
}
function scheduleForm(item, employeeId, date, template) {
  const members = ui.db.employees.filter(e => e.manageable && !e.disabled && (item ? e.id === item.employeeId : !ui.group || e.groupId === ui.group));
  const selectedDay = esc(item?.date || date);
  const selectedMember = item?.employeeId || employeeId;
  const templateOptions = (ui.db.shiftTemplates || []).map(t =>
    `<option value="${esc(t.id)}" ${t.id === template?.id ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
  const dates = item
    ? `<label class="field">排班日期<input type="date" name="startDate" value="${selectedDay}" required></label>`
    : `<div class="field-grid">
        <label class="field">开始日期<input type="date" name="startDate" value="${selectedDay}" required></label>
        <label class="field">结束日期<input type="date" name="endDate" min="${selectedDay}" value="${selectedDay}" required></label>
      </div>
      <label class="field">安排哪几天<select name="dayMode">
        <option value="all">每天</option><option value="weekday">工作日（周一至周五）</option>
        <option value="weekend">周六和周日</option><option value="custom">自选星期</option></select></label>
      <fieldset id="custom-weekdays" class="plan-fieldset" hidden><legend>选择星期</legend><div class="weekday-options">${weekdays.map((day,index) =>
        `<label class="weekday-option"><input type="checkbox" name="weekdays" value="${(index+1)%7}" checked aria-label="周${day}"><span>${day}</span></label>`).join('')}</div></fieldset>`;
  return `${!item && templateOptions ? `<label class="field">班次模板<select id="shift-template-select"><option value="">手动安排</option>${templateOptions}</select></label>` : ''}
    ${dates}
    ${shiftFields(item?.segments || template?.segments)}
    <fieldset class="plan-fieldset"><legend>人员</legend>${item ? `<strong>${esc(members[0]?.name)}</strong><input type="hidden" name="employeeIds" value="${esc(selectedMember)}">` :
      `<div class="employee-options">${members.map(e => `<label class="check-option"><input type="checkbox" name="employeeIds" value="${esc(e.id)}" ${e.id === selectedMember ? 'checked' : ''}><span>${esc(e.name)}</span><small>${esc(e.department)}</small></label>`).join('')}</div>`}
    </fieldset>
    <details class="schedule-options" ${item?.note ? 'open' : ''}><summary>备注与覆盖选项</summary>
      <label class="field">备注<textarea name="note" maxlength="200">${esc(item?.note || '')}</textarea></label>
      ${item ? '' : '<label class="overwrite-label"><input type="checkbox" name="overwrite">覆盖所选日期中尚未打卡的排班</label>'}
    </details>`;
}
function selectedScheduleDates(form, item) {
  const start = form.get('startDate'), end = item ? start : form.get('endDate');
  if (!start || !end || start > end) throw new Error('请确认开始日期和结束日期');
  const days = (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) / 86400000;
  if (!Number.isFinite(days) || days > 365) throw new Error('每次最多安排 366 天，请缩小日期范围');
  const mode = form.get('dayMode');
  const custom = form.getAll('weekdays').map(Number);
  const allowed = mode === 'weekday' ? [1,2,3,4,5] : mode === 'weekend' ? [0,6] : mode === 'custom' ? custom : [0,1,2,3,4,5,6];
  const dates = Array.from({length:days+1},(_,index) => addDays(start,index))
    .filter(date => allowed.includes(new Date(`${date}T12:00:00Z`).getUTCDay()));
  if (!dates.length) throw new Error('这个日期范围没有符合条件的日期，请调整日期或安排哪几天');
  return dates;
}
async function openReminders() {
  ui.drawer = {type:'reminders'};const editing = ui.drawer;
  document.querySelector('#drawer-title').textContent = '我的提醒';
  document.querySelector('#drawer-eyebrow').textContent = '个人设置';
  document.querySelector('#form-error').textContent = '';
  document.querySelector('#drawer-body').innerHTML = '<p role="status">正在读取提醒设置…</p>';
  document.querySelector('#drawer-footer').innerHTML = '<button type="button" class="button" data-action="close-drawer">取消</button><button type="submit" class="button primary" id="save-button" disabled>保存设置</button>';
  drawer.showModal();drawer.scrollTop = 0;
  try {
    const data = await api('/api/reminders');if (ui.drawer !== editing) return;
    const pref = data.preferences;
    const statuses = {sent:'已发送',failed:'发送失败',pending:'处理中',cancelled:'已取消'};
    document.querySelector('#drawer-body').innerHTML = `<p class="field-hint">按北京时间与个人排班发送飞书消息。设置只对你本人有效。</p>${data.enabled ? '' : '<div class="info-banner">提醒通道尚未启用，可以先保存你的设置。启用后按未来时点发送，不补发旧提醒。</div>'}<div class="form-section-title">打卡提醒</div><label class="check-option"><input type="checkbox" name="checkinEnabled" ${pref.checkinEnabled ? 'checked' : ''}><span>提醒我上下班打卡</span></label><label class="field">提前多久提醒<select name="beforeMinutes"><option value="15" ${pref.beforeMinutes === 15 ? 'selected' : ''}>提前 15 分钟</option><option value="30" ${pref.beforeMinutes === 30 ? 'selected' : ''}>提前 30 分钟</option></select><small>每个时段的上班、下班各提醒一次；已打卡则跳过。</small></label>${isAdmin() ? `<div class="form-section-title">查看记录提醒</div><label class="check-option"><input type="checkbox" name="reviewEnabled" ${pref.reviewEnabled ? 'checked' : ''}><span>提醒我查看负责组的记录</span></label><label class="field">打卡时点后多久提醒（分钟）<input type="number" name="afterMinutes" min="1" max="1440" step="1" required value="${pref.afterMinutes}"><small>默认 60 分钟。每个上班、下班时点汇总为一条提醒；没有组管理员时由组织管理员接收。</small></label>` : ''}<div class="form-section-title">确认消息能收到</div><p class="field-hint">发送一条测试消息到你自己的飞书，每 5 分钟可测试一次。</p><button type="button" class="button" data-action="test-reminder" ${data.enabled ? '' : 'disabled'}>向我发送测试提醒</button><p id="reminder-test-status" class="field-hint" role="status"></p><div class="form-section-title">最近发送结果</div>${data.history.length ? data.history.map(row => `<p>${esc({checkin:'打卡提醒',review:'查看记录',test:'测试提醒'}[row.type] || '提醒')} · ${displayTime(row.attemptedAt)} · ${statuses[row.status] || '处理中'}${row.error ? `<br><small>${esc(row.error)}</small>` : ''}</p>`).join('') : '<p class="field-hint">暂无发送记录。提醒会在所设时间发送到飞书。</p>'}`;
    document.querySelector('#save-button').disabled = false;
  } catch (error) {if (ui.drawer === editing) document.querySelector('#form-error').textContent = error.message;}
}
async function testReminder(button) {
  const editing = ui.drawer;button.disabled = true;
  const target = document.querySelector('#reminder-test-status');
  target.textContent = '正在发送到你的飞书…';
  try {await api('/api/reminders/test',{});if (ui.drawer === editing) target.textContent = '测试提醒已发送，请在飞书消息中查看“灵活考勤”。';}
  catch (error) {if (ui.drawer === editing) target.textContent = error.message;}
  finally {if (ui.drawer === editing) button.disabled = false;}
}
function openDrawer(type, item = null, employeeId = '', date = ui.db.today, template = null) {
  if (!isAdmin() || (['location','template','employee','group','access'].includes(type) && !isOrgAdmin())) return;
  if (type === 'schedule' && employeeId && !employeeById(employeeId)?.manageable) return;
  if (type === 'schedule' && !item && schedulePrerequisite()) {const missing = schedulePrerequisite();toast(missing.text,true);navigate(missing.view);return;}
  const locked = type === 'schedule' && item && (hasPunches(item) || employeeById(item.employeeId)?.disabled || !activeLocations().length);
  const reschedule = locked && hasPunches(item) && !employeeById(item.employeeId)?.disabled &&
    item.segments.every(segment => activeLocations().some(location => location.id === segment.locationId));
  ui.drawer = {type,item,employeeId,date,reschedule};
  const title = type === 'group' ? item ? '考勤组设置' : '新增考勤组' : type === 'access' ? '成员考勤设置' : type === 'schedule' ? locked ? '查看排班' : item ? '编辑排班' : '新增排班' : type === 'template' ? item ? '编辑班次模板' : '新增班次模板' : type === 'location' ? item ? '编辑考勤地点' : '新增考勤地点' : item ? '编辑员工资料' : '新增员工';
  document.querySelector('#drawer-title').textContent = title;
  document.querySelector('#drawer-eyebrow').textContent = title;
  document.querySelector('#form-error').textContent = '';
  const body = document.querySelector('#drawer-body');
  if (locked) {
    const reason = hasPunches(item) ? '原日期的打卡记录和到期结果会保留。删除或改期后，剩余打卡与提醒会取消。' : '当前成员或考勤地点不可用于重新排班。';
    body.innerHTML = `<p><strong>${esc(employeeById(item.employeeId)?.name)}</strong> · ${esc(item.date)}</p>
      <ul class="schedule-details">${item.segments.map(segment => `<li>${esc(segment.start)}–${esc(segment.end)} · ${esc(locationById(segment.locationId)?.name || '地点不可用')}</li>`).join('')}</ul>
      ${item.note ? `<p>${esc(item.note)}</p>` : ''}<p class="field-hint">${reason}</p>
      ${reschedule ? `<label class="field reschedule-date">改到其他日期<input type="date" name="startDate" required></label>
        <input type="hidden" name="employeeIds" value="${esc(item.employeeId)}">` : ''}`;
  } else if (type === 'schedule') {
    body.innerHTML = scheduleForm(item, employeeId, date, template);
  } else if (type === 'template') {
    body.innerHTML = `<label class="field">班次名称<input name="name" required maxlength="80" value="${esc(item?.name || '')}" placeholder="例如：园区日班"></label>
      ${shiftFields(item?.segments)}
      <label class="field">备注<textarea name="note" maxlength="500">${esc(item?.note || '')}</textarea></label>`;
  } else if (type === 'group') {
    body.innerHTML = `<label class="field">考勤组名称<input name="name" required maxlength="80" value="${esc(item?.name || '')}" placeholder="例如：研发园区考勤组"></label><div class="field"><span class="field-label">组长</span><div class="employee-options">${activeEmployees().filter(e => !e.disabled && (e.groupId === item?.id || item?.adminIds.includes(e.id))).map(e => `<label class="check-option"><input type="checkbox" name="adminIds" value="${esc(e.id)}" ${item?.adminIds.includes(e.id) ? 'checked' : ''}><span>${esc(e.name)}</span><small>${esc(e.department || '')}</small></label>`).join('')}</div><small>组长可查看本组打卡情况和管理本组排班。请先把成员加入该组。</small></div>`;
  } else if (type === 'access') {
    body.innerHTML = `<p><strong>${esc(item.name)}</strong> · ${esc(item.department || '组织成员')}</p><label class="field">所属考勤组<select name="groupId" required>${groupOptions(item.groupId)}</select></label><label class="field">用户角色<select name="role" ${item.bootstrapAdmin ? 'disabled' : ''}>${Object.entries(roleLabels).map(([value,label]) => `<option value="${value}" ${item.role === value ? 'selected' : ''}>${label}</option>`).join('')}</select>${item.bootstrapAdmin ? '<small>初始组织管理员由服务器配置保留。</small>' : ''}</label><div class="field" id="managed-groups-field" ${item.role === 'group_admin' ? '' : 'hidden'}><span class="field-label">负责的考勤组</span><div class="employee-options">${ui.db.groups.map(g => `<label class="check-option"><input type="checkbox" name="managedGroupIds" value="${esc(g.id)}" ${g.adminIds.includes(item.id) ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('')}</div><small>考勤组管理员至少负责一个组。</small></div>`;
  } else if (type === 'location') {
    body.innerHTML = `<label class="field">搜索地点<div class="map-search"><input type="search" id="map-search" maxlength="100" placeholder="输入城市、园区或楼栋名称"><button type="button" class="button" id="map-search-button">搜索</button></div></label><div id="map-results" class="map-results" aria-live="polite"></div><div class="map-tools"><button type="button" class="button small" id="map-locate">重新定位</button><button type="button" class="button small" id="select-map-center">选取地图中心</button></div><div id="location-map" class="location-map" role="region" aria-label="高德地图选取考勤中心"></div><p id="map-status" class="field-hint" role="status">搜索地点或拖动地图，点击园区或楼栋中心选点。</p><button type="button" class="button small" id="map-retry" hidden>重新加载高德地图</button><label class="field"><span class="field-label">地点名称<span class="required">*</span></span><input name="name" required maxlength="60" value="${esc(item?.name || '')}" placeholder="例如：A 园区 / 研发楼"></label><label class="field">详细地址<input name="address" maxlength="200" value="${esc(item?.address || '')}" placeholder="填写园区地址或楼栋说明"></label><div class="field-grid"><label class="field">打卡半径（米）<input type="number" name="radius" min="10" max="5000" step="1" required value="${item?.radius ?? 100}"></label><label class="field color-field">地点标识颜色<input type="color" name="color" value="${safeColor(item?.color || '#3370ff')}"></label></div><input type="hidden" name="latitude" value="${item?.latitude ?? ''}"><input type="hidden" name="longitude" value="${item?.longitude ?? ''}"><input type="hidden" name="coordinateSystem" value="${item?.coordinateSystem || (item ? 'wgs84' : 'gcj02')}">`;

  } else {
    body.innerHTML = `<label class="field">考勤组<select name="groupId" required>${groupOptions(item?.groupId || ui.group)}</select></label><label class="field"><span class="field-label">员工姓名<span class="required">*</span></span><input name="name" required maxlength="60" value="${esc(item?.name || '')}" placeholder="输入员工姓名"></label><label class="field"><span class="field-label">工号<span class="required">*</span></span><input name="employeeNo" required maxlength="40" value="${esc(item?.employeeNo || '')}" placeholder="例如：E001"><small>工号必须唯一。</small></label><label class="field"><span class="field-label">部门</span><input name="department" maxlength="60" value="${esc(item?.department || '')}" placeholder="例如：技术研发部"></label><label class="field"><span class="field-label">飞书 Open ID</span><input name="openId" maxlength="128" value="${esc(item?.openId || '')}" placeholder="ou_…"><small>来自当前自建应用的员工标识。演示环境可以留空；正式使用需要绑定。</small></label>`;
  }
  const removeLabel = item && (type === 'schedule' ? '删除排班' : type === 'template' ? '删除班次' : '');
  const remove = removeLabel ? `<button type="button" class="button danger delete-button" data-action="remove-${type}">${removeLabel}</button>` : '';
  const save = reschedule ? '<button type="submit" class="button primary" id="save-button">确认改期</button>' :
    locked ? '' : `<button type="submit" class="button primary" id="save-button">保存${type === 'schedule' ? '排班' : type === 'template' ? '班次' : type === 'location' ? '地点' : type === 'group' || type === 'access' ? '设置' : '员工'}</button>`;
  document.querySelector('#drawer-footer').innerHTML = `${remove}<button type="button" class="button" data-action="close-drawer">${locked ? '关闭' : '取消'}</button>${save}`;
  drawer.showModal();drawer.scrollTop = 0;
  if (type === 'location') {
    const editing = ui.drawer;
    import('/location-map.mjs').then(module => {if (drawer.open && ui.drawer === editing) editing.cleanup = module.mountLocationMap(document.querySelector('#drawer-form'),getMapPosition,reportLocationTiming);}).catch(() => {if (ui.drawer === editing) document.querySelector('#map-status').textContent = '高德地图加载失败，请关闭面板后重试。';});
  }
}
function closeDrawer() {ui.drawer?.cleanup?.();drawer.close();ui.drawer = null;}
async function saveDrawer(event) {
  event.preventDefault();
  if (ui.busy || !ui.drawer || ui.drawer.type === 'remove') return;
  const form = new FormData(event.target);
  const {type,item,reschedule} = ui.drawer;const guided = ui.guided;
  const button = document.querySelector('#save-button');
  if (!button || button.disabled) return;
  ui.busy = true;button.disabled = true;document.querySelector('#form-error').textContent = '';
  try {
    if (type === 'reminders') {
      await api('/api/reminders',{checkinEnabled:form.has('checkinEnabled'),beforeMinutes:Number(form.get('beforeMinutes')),...(isAdmin() ? {reviewEnabled:form.has('reviewEnabled'),afterMinutes:Number(form.get('afterMinutes'))} : {})},'PUT');toast('提醒设置已保存');
    } else if (type === 'directory') {
      const result = await api('/api/employees/import',{openIds:[...ui.directorySelected],groupId:form.get('groupId')});ui.group = form.get('groupId');toast(`已添加 ${result.count} 位组织成员`);
    } else if (type === 'group') {
      const result = await api(`/api/groups${item ? `/${encodeURIComponent(item.id)}` : ''}`,{name:form.get('name').trim(),adminIds:form.getAll('adminIds')},item ? 'PATCH' : 'POST');ui.group = result.group.id;toast('考勤组已保存');
    } else if (type === 'access') {
      await api(`/api/employees/${encodeURIComponent(item.id)}/access`,{groupId:form.get('groupId'),role:item.bootstrapAdmin ? 'org_admin' : form.get('role'),managedGroupIds:form.getAll('managedGroupIds')},'PATCH');toast('成员考勤设置已保存');
    } else if (type === 'schedule') {
      const employeeIds = form.getAll('employeeIds');
      if (!employeeIds.length) throw new Error('请至少选择一位员工');
      const dates = selectedScheduleDates(form,item);
      const result = await api('/api/schedules',{employeeIds,dates,segments:reschedule ? item.segments : readSegments(),
        note:reschedule ? (item.note || '') : form.get('note').trim(),
        ...(item ? {replaceScheduleId:item.id} : {overwrite:form.has('overwrite')})});
      toast(`已保存 ${result.count || dates.length*employeeIds.length} 份个人排班`);
    } else if (type === 'template') {
      const segments = readSegments();
      await api(`/api/shift-templates${item ? `/${encodeURIComponent(item.id)}` : ''}`,{name:form.get('name').trim(),note:form.get('note').trim(),segments},item ? 'PATCH' : 'POST');
      toast('班次模板已保存');
    } else {
      const body = Object.fromEntries(form);
      if (type === 'location' && (!body.latitude || !body.longitude)) throw new Error('请先搜索并选择一个地点，或点击地图确认考勤中心');
      for (const key of ['latitude','longitude','radius']) if (key in body) body[key] = Number(body[key]);
      for (const key of ['name','department','employeeNo','openId','address']) if (key in body) body[key] = body[key].trim();
      const resource = type === 'employee' ? 'employees' : 'locations';
      await api(`/api/${resource}${item ? `/${encodeURIComponent(item.id)}` : ''}`,body,item ? 'PATCH' : 'POST');
      toast(type === 'employee' ? '员工资料已保存' : '考勤地点已保存');
    }
    closeDrawer();await refresh();
    if (type === 'schedule') {ui.week = monday(selectedScheduleDates(form,item)[0]);ui.scheduleTab = 'personal';}
    if (guided) navigate('overview');else render();
  } catch (error) {document.querySelector('#form-error').textContent = error.message;}
  finally {ui.busy = false;button.disabled = false;}
}
function openRemoval(resource, item, label, detail, action = '确认删除') {
  if (!item || ui.busy) return;
  ui.drawer?.cleanup?.();
  ui.drawer = {type:'remove',resource,item};
  document.querySelector('#drawer-title').textContent = label;
  document.querySelector('#drawer-eyebrow').textContent = '';
  document.querySelector('#form-error').textContent = '';
  document.querySelector('#drawer-body').innerHTML = `<p>${esc(detail)}</p>`;
  document.querySelector('#drawer-footer').innerHTML = `<button type="button" class="button" data-action="close-drawer" autofocus>取消</button><button type="button" class="button danger" data-action="confirm-remove">${action}</button>`;
  if (!drawer.open) drawer.showModal();
  drawer.scrollTop = 0;
  drawer.querySelector('[data-action="close-drawer"][autofocus]').focus();
}
async function confirmRemoval(button) {
  if (ui.busy || ui.drawer?.type !== 'remove') return;
  const {resource,item} = ui.drawer;
  const errorNode = document.querySelector('#form-error');
  ui.busy = true;button.disabled = true;errorNode.textContent = '';
  try {
    await api(`/api/${resource}/${encodeURIComponent(item.id)}`,{},'DELETE');
    closeDrawer();
    try {await refresh();render();toast(resource === 'employees' ? '已移除成员' : '已删除');}
    catch {toast('操作已完成。请重新打开应用以查看最新列表。',true);}
  } catch (error) {errorNode.textContent = error.message;}
  finally {ui.busy = false;button.disabled = false;}
}
let feishuSdkReady;
function loadFeishuScript() {
  return window.h5sdk ? Promise.resolve() : new Promise((resolve,reject) => {
          const script = document.createElement('script');
          const timeout = setTimeout(() => {script.remove();reject(new Error('飞书定位组件加载超时，请重试'));},15000);
          script.src = '/vendor/feishu-h5-sdk-1.5.48.js';
          script.onload = () => {clearTimeout(timeout);if (!window.h5sdk) {script.remove();reject(new Error("飞书组件未就绪，请从飞书工作台重新打开"));return;}resolve();};
          script.onerror = () => {clearTimeout(timeout);script.remove();reject(new Error('飞书定位组件加载失败，请检查网络'));};
          document.head.append(script);
        });
}

function reportLocationTiming(stage, started, outcome) {
  if (ui.db.mode === 'feishu') api('/api/location-timing',{stage,durationMs:Math.max(0,Date.now()-started),outcome}).catch(() => {});
}
async function prepareFeishuSdk() {
  if (!feishuSdkReady) {
    feishuSdkReady = (async () => {
      const scriptReady = loadFeishuScript();
      const [,config] = await Promise.all([scriptReady,api(`/api/feishu/jsapi-config?url=${encodeURIComponent(location.href.split('#')[0])}`)]);
      if (!window.h5sdk || !window.tt) throw new Error('请在手机飞书工作台中打开应用后定位');
      await new Promise((resolve,reject) => {
        let sdkReady = false, authenticated = false;
        const timeout = setTimeout(() => reject(new Error('飞书定位认证超时，请重新打开应用')),15000);
        const fail = () => {clearTimeout(timeout);reject(new Error('飞书定位认证失败，请检查应用权限与安全域名'));};
        // ready 只表示 SDK 初始化完成，调用定位还必须等待鉴权成功。
        const complete = () => {if (sdkReady && authenticated) {clearTimeout(timeout);resolve();}};
        window.h5sdk.error(fail);
        window.h5sdk.ready(() => {sdkReady = true;complete();});
        window.h5sdk.config({...config,onSuccess:() => {authenticated = true;complete();},onFail:fail});
      });
    })().catch(error => {feishuSdkReady = null;throw error;});
  }
  return feishuSdkReady;
}
async function requestPosition() {
  if (ui.db.mode === 'feishu') {
    if (!/Lark|Feishu/i.test(navigator.userAgent)) throw new Error('请在手机飞书工作台中打开应用，使用飞书定位');
    let started = Date.now(), outcome = 'error';
    try {await prepareFeishuSdk();outcome = 'ok';}
    finally {reportLocationTiming('prepare',started,outcome);}
    started = Date.now();outcome = 'error';
    try {
      const position = await new Promise((resolve,reject) => {
      const timeout = setTimeout(() => reject(new Error('飞书定位超时，请开启高精度定位并重试')),20000);
      window.tt.getLocation({timeout:5,cacheTimeout:0,accuracy:'best',success:result => {
        clearTimeout(timeout);
        if (!['wgs84','gcj02'].includes(result.type)) return reject(new Error('飞书返回的位置暂不可用，请更新客户端或联系管理员'));
        const position = {latitude:Number(result.latitude),longitude:Number(result.longitude),accuracy:Number(result.horizontalAccuracy ?? result.accuracy),timestamp:Number(result.timestamp),coordinateSystem:result.type};
        if (![position.latitude,position.longitude,position.accuracy,position.timestamp].every(Number.isFinite) || position.timestamp <= 0 || Math.abs(position.latitude) > 90 || Math.abs(position.longitude) > 180 || position.accuracy <= 0) return reject(new Error('飞书定位信息不完整，请重新定位'));
        resolve(position);
      },fail:() => {clearTimeout(timeout);reject(new Error('飞书定位失败，请在手机端允许定位权限并重试'));}});
      });
      outcome = 'ok';return position;
    } finally {reportLocationTiming('locate',started,outcome);}
  }
  return new Promise((resolve,reject) => {
    if (!navigator.geolocation) return reject(new Error('当前设备不支持定位，请在手机浏览器中打开'));
    navigator.geolocation.getCurrentPosition(position => resolve({latitude:position.coords.latitude,longitude:position.coords.longitude,accuracy:position.coords.accuracy,timestamp:position.timestamp,coordinateSystem:'wgs84'}),error => reject(new Error(({1:'定位权限未开启，请允许访问位置后重试',2:'暂时无法获取位置，请移至开阔处后重试',3:'获取定位超时，请开启高精度定位后重试'})[error.code] || '获取位置失败')),{enableHighAccuracy:true,maximumAge:0,timeout:20000});
  });
}
let nearbyPosition, nearbyRequest;
function getPosition({maxAge = 15_000} = {}) {
  const age = nearbyPosition ? Date.now() - nearbyPosition.timestamp : Infinity;
  // Reuse only a recent precise fix; the server still checks its timestamp, accuracy and fence.
  if (age >= 0 && age < maxAge && nearbyPosition.accuracy <= 20) return Promise.resolve(nearbyPosition);
  if (!nearbyRequest) {
    nearbyPosition = null;
    nearbyRequest = requestPosition().then(position => {nearbyPosition = position;return position;}).finally(() => {nearbyRequest = null;});
  }
  return nearbyRequest;
}
function getMapPosition({fresh = false} = {}) {return getPosition({maxAge:fresh ? 0 : 60_000});}
function warmLocation() {
  if (ui.db.mode === 'feishu' && /Lark|Feishu/i.test(navigator.userAgent) && /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent)) {
    // One foreground request, shared with the map and punch button; no continuous tracking.
    getMapPosition().catch(() => {});
  }
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
async function quickPunch() {
  if (ui.busy) return;
  const destination=location.hash,key=destination.match(/^#punch=([a-f0-9]{40})$/)?.[1];
  ui.busy=true;
  const show=(title,detail,loading=false)=>{main.innerHTML=`<section class="quick-punch-panel" aria-live="polite">${loading?'<span class="spinner"></span>':icon('checkin')}<h1>${esc(title)}</h1><p>${esc(detail)}</p>${!loading?'<button class="button primary" data-action="close-punch">返回消息</button><a href="#checkin">查看今日考勤</a>':''}</section>`;};
  try {
    show('正在准备打卡','正在核对这张卡片对应的班次…',true);
    if (!key) throw new Error('这张打卡卡片无效，请查看今日考勤');
    let result=await api(`/api/reminders/punch?key=${key}`);
    if (!result.record) {
      if (result.date!==ui.db.today) throw new Error('这张卡片不是今天的班次，请查看今日考勤');
      show(`正在${result.input.kind==='in'?'上班':'下班'}打卡`,`${result.locationName} · 正在通过飞书获取位置…`,true);
      const position=await getPosition();
      // A closed or backgrounded locating screen must not submit a delayed punch.
      if (location.hash!==destination || document.visibilityState==='hidden') return;
      show('正在校验打卡',`${result.locationName} · 正在核对位置与打卡范围…`,true);
      const saved=await api('/api/checkin',{reminderKey:key,latitude:position.latitude,longitude:position.longitude,accuracy:position.accuracy,coordinateSystem:position.coordinateSystem,locatedAt:new Date(position.timestamp).toISOString()});
      result={...result,record:saved.record};
    }
    const status={normal:'正常',late:'迟到',early:'早退'}[result.record.status] || result.record.status;
    show('打卡成功',`${displayTime(result.record.timestamp)} · ${result.record.locationName} · ${status}\n正在更新原提醒卡片…`,true);
    for (let attempt=0;attempt<6 && !result.cardUpdated;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,800));
      if (location.hash!==destination) return;
      try {result=await api(`/api/reminders/punch?key=${key}`);} catch {break;}
    }
    if (location.hash!==destination) return;
    show('打卡成功',`${displayTime(result.record.timestamp)} · ${result.record.locationName} · ${status}\n${result.cardUpdated?'原提醒卡片已更新，可以返回消息。':'记录已保存，提醒卡片稍后自动更新，无需重复打卡。'}`);
    if (result.cardUpdated) await closePunch();
  } catch (error) {
    if (location.hash===destination) {
      show('暂未完成打卡',error.message);
      main.querySelector('.quick-punch-panel').insertAdjacentHTML('beforeend','<button class="text-button" data-action="quick-punch">重新定位并打卡</button>');
    }
  } finally {ui.busy=false;}
}
async function closePunch() {
  const fallback=()=>toast('请关闭当前窗口，返回飞书消息');
  try {await loadFeishuScript();window.h5sdk.ready(()=>{if(typeof window.tt?.closeWindow==='function') window.tt.closeWindow({fail:fallback});else fallback();});}
  catch {fallback();}
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
  if (ui.previewRole && ['checkin','quick-punch','workflow-calendar','test-reminder','confirm-remove'].includes(action)) {
    toast('角色预览仅供查看。切回组织管理员后再操作。',true);
    return;
  }
  switch (action) {
    case 'quick-punch':await quickPunch();break;
    case 'close-punch':closePunch();break;
    case 'refresh-requests':await renderRequests();break;
    case 'workflow-calendar':await workflowCalendar(button);break;
    case 'setup-step':await startSetupStep(button.dataset.step);break;
    case 'group-schedules':ui.guided = false;ui.group = button.dataset.id;ui.scheduleTab = 'personal';navigate('schedules');break;
    case 'reminders':await openReminders();break;
    case 'test-reminder':await testReminder(button);break;
    case 'new-group':openDrawer('group');break;
    case 'edit-group':openDrawer('group',ui.db.groups.find(g => g.id === button.dataset.id));break;
    case 'edit-access':openDrawer('access',employeeById(button.dataset.id));break;
    case 'leader-records':
      ui.group = button.dataset.id;ui.recordTab = 'flow';ui.recordFrom = ui.recordTo = ui.db.today;ui.recordEmployee = ui.recordStatus = '';navigate('records');break;
    case 'group-members':ui.guided = false;ui.group = button.dataset.id;navigate('employees');break;
    case 'group-add-members':ui.guided = false;ui.group = button.dataset.id;navigate('employees');await openDirectory();break;
    case 'open-directory':await openDirectory();break;
    case 'navigate': ui.guided = false;if (button.closest('#navigation')) ui.group = '';navigate(button.dataset.view);break;
    case 'schedule-tab':ui.scheduleTab = button.dataset.tab;renderSchedules();break;
    case 'record-tab':ui.recordTab = button.dataset.tab;renderRecords();break;
    case 'load-summary':await loadAttendanceSummary();break;
    case 'new-template':openDrawer('template');break;
    case 'edit-template':openDrawer('template',(ui.db.shiftTemplates || []).find(item => item.id === button.dataset.id));break;
    case 'assign-template': {
      const template = ui.db.shiftTemplates.find(t => t.id === button.dataset.id);
      if (template) openDrawer('schedule',null,'',ui.db.today,template);
      break;
    }
    case 'remove-template': {const item = ui.drawer?.item;if (item) openRemoval('shift-templates',item,'删除班次',`删除「${item.name}」？已保存的排班继续有效。`);break;}
    case 'remove-location': {const item = locationById(button.dataset.id);if (item) openRemoval('locations',item,'删除考勤地点',`从可用地点中移除「${item.name}」？历史排班和打卡记录会保留地点信息。`);break;}
    case 'remove-employee': {const item = employeeById(button.dataset.id);if (item) openRemoval('employees',item,'移除考勤成员',`移除「${item.name}」后，将停止其考勤访问和提醒，并取消从今天起尚无打卡记录的排班。历史记录保留，飞书通讯录中的成员身份不受影响。`,'确认移除');break;}
    case 'remove-group': {const item = ui.db.groups.find(g => g.id === button.dataset.id);if (item) openRemoval('groups',item,'删除考勤组',`删除「${item.name}」？仅可删除没有成员、排班和历史记录的组。`);break;}
    case 'confirm-remove':await confirmRemoval(button);break;
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
    case 'add-segment': {
      const rows = readSegments();
      if (rows.length >= 12) return toast('每天最多安排 12 个时段',true);
      const previous = rows.at(-1);
      const end = previous?.end || '18:00';
      document.querySelector('#segment-list').insertAdjacentHTML('beforeend',segmentRow({start:end,end:'',locationId:previous?.locationId}));
      document.querySelector('#segment-list .segment-row:last-child .segment-end').focus();
      break;
    }
    case 'remove-segment':if (document.querySelectorAll('.segment-row').length <= 1) return toast('请至少保留一个工作时段',true);button.closest('.segment-row').remove();break;
    case 'remove-schedule': {
      const item = ui.drawer?.item;
      if (!item) break;
      const name = employeeById(item.employeeId)?.name || '该成员';
      const history = hasPunches(item) ? ' 已有打卡记录和到期考勤结果会保留。还未到期的打卡与提醒将取消。' : '';
      openRemoval('schedules',item,'删除排班',`删除「${name}」${item.date} 的整天排班？${history}`);
      break;
    }
    case 'reset-record-filters':ui.group = '';ui.recordFrom = '';ui.recordTo = '';ui.recordEmployee = '';ui.recordStatus = '';renderRecords();break;
    case 'checkin':await checkin(button);break;
    case 'preview':await preview(button);break;
    case 'retry':await init();break;
  }
});
document.addEventListener('input', event => {if (event.target.id === 'directory-search') {ui.directorySearch = event.target.value;renderDirectoryUsers();}if (event.target.id === 'schedule-search') {ui.search = event.target.value;document.querySelector('#schedule-grid').innerHTML = scheduleTable();}if (event.target.id === 'employee-search') {ui.search = event.target.value;document.querySelector('#employee-grid').innerHTML = employeeRows();labelTableCells();}});
document.addEventListener('change', event => {
  if (event.target.matches('select[data-role-preview]')) {void switchPreview(event.target.value);return;}
  if (event.target.id === 'shift-template-select') applyTemplate(event.target.value);
  if (event.target.name === 'dayMode') document.querySelector('#custom-weekdays').hidden = event.target.value !== 'custom';
  if (event.target.name === 'startDate' && ui.drawer?.type === 'schedule') {
    const end = drawer.querySelector('[name="endDate"]');
    if (end) {
      end.min = event.target.value;
      if (end.value < end.min) end.value = end.min;
    }
  }
  if (event.target.id === 'jump-schedule-date' && event.target.value) {
    ui.week = monday(event.target.value);renderSchedules();
  }

  if (event.target.name === 'role' && ui.drawer?.type === 'access') document.querySelector('#managed-groups-field').hidden = event.target.value !== 'group_admin';
  if (event.target.id === 'group-filter') {ui.group = event.target.value;render();}
  if (event.target.id === 'directory-department') {ui.directoryDepartment = event.target.value;renderDirectoryUsers();}
  if (event.target.dataset.directoryId) {if (event.target.checked) ui.directorySelected.add(event.target.dataset.directoryId);else ui.directorySelected.delete(event.target.dataset.directoryId);document.querySelector('#directory-count').textContent = `已选择 ${ui.directorySelected.size} 人（最多 50 人）`;}

  const fields = {'record-from':'recordFrom','record-to':'recordTo','record-employee':'recordEmployee','record-status':'recordStatus'};
  if (fields[event.target.id]) {ui[fields[event.target.id]] = event.target.value;renderRecords();}
  if (event.target.id === 'summary-from') ui.summaryFrom = event.target.value;
  if (event.target.id === 'summary-to') ui.summaryTo = event.target.value;
  if (event.target.id === 'checkin-employee') {ui.employee = event.target.value;renderCheckin();}
});
document.querySelector('#drawer-form').addEventListener('submit',saveDrawer);
document.querySelector('#drawer-form').addEventListener('invalid',event => event.target.closest('details')?.setAttribute('open',''),true);
drawer.addEventListener('cancel',event => {if (ui.busy) event.preventDefault();else {ui.drawer?.cleanup?.();ui.drawer = null;}});
window.addEventListener('hashchange',() => {if (location.hash.startsWith('#punch=')) {void init();return;}document.body?.classList.remove('quick-punch');ui.view = location.hash.slice(1) || (isAdmin() ? 'overview' : 'checkin');render();});
function reminderLinkFilters() {
  const params = new URLSearchParams(location.search);
  const date = params.get('recordDate');
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) ui.recordFrom = ui.recordTo = date;
  const group = params.get('group');
  if (ui.db.groups.some(g => g.id === group)) ui.group = group;
}
function loginLink() {
  const query = new URLSearchParams(location.search);
  const params = new URLSearchParams({view:location.hash.slice(1)});
  for (const name of ['recordDate','group','request']) if (query.has(name)) params.set(name,query.get(name));
  return `/auth/login?${params}`;
}
let triedNativeLogin=false;
async function nativeLogin() {
  const [config]=await Promise.all([api('/api/auth/bootstrap'),loadFeishuScript()]);
  const code=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('飞书免登超时，请点击登录按钮重试')),15000);
    const success=result=>{clearTimeout(timeout);resolve(result.code);};
    const fail=error=>{
      clearTimeout(timeout);
      const errno=Number(error?.errno), detail=String(error?.errString || error?.errMsg || '').match(/(?:code|错误码)\s*[:：=]\s*(\d+)/i)?.[1];
      reject(new Error(`飞书自动授权失败${Number.isInteger(errno) ? `（错误码 ${errno}${detail ? ` / ${detail}` : ''}）` : ''}，请重试`));
    };
    const legacyLogin=()=>{
      if (!window.tt?.requestAuthCode) {clearTimeout(timeout);reject(new Error('当前飞书版本不支持免登，请更新飞书或点击登录按钮'));return;}
      window.tt.requestAuthCode({appId:config.appId,success,fail});
    };
    window.h5sdk.ready(()=>{
      if (!window.tt?.requestAccess) {legacyLogin();return;}
      window.tt.requestAccess({appID:config.appId,scopeList:[],success,fail:error=>Number(error?.errno)===103 ? legacyLogin() : fail(error)});
    });
  });
  await api('/auth/feishu',{nonce:config.nonce,code});
}
async function init() {
  document.body?.classList.toggle('quick-punch',location.hash.startsWith('#punch='));
  try {await refresh();if (location.hash.startsWith('#punch=')) {await quickPunch();return;}warmLocation();reminderLinkFilters();const requested = location.hash.slice(1);ui.view = requested || (isAdmin() ? 'overview' : 'checkin');render();}
  catch (error) {
    if (error.status===401 && !triedNativeLogin && !new URLSearchParams(location.search).has('signedOut') && /Lark|Feishu/i.test(navigator.userAgent)) {
      triedNativeLogin=true;main.innerHTML='<div class="loading"><span class="spinner"></span>正在使用飞书身份进入…</div>';
      try {await nativeLogin();location.reload();return;} catch (loginError) {error.message=loginError.message;}
    }
    main.innerHTML = `<div class="error-page"><h2>${error.status === 401 || error.status === 403 ? '登录灵活考勤' : '暂时无法加载'}</h2><p>${esc(error.message)}</p>${error.status === 401 || error.status === 403 ? `<a class="button primary" href="${esc(loginLink())}">使用飞书身份登录</a>` : '<button class="button primary" data-action="retry">重新加载</button>'}</div>`;}
}
init();
