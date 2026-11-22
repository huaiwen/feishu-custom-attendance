import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const source = readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\ninit\(\);\s*$/,'');
function screen(role) {
  const nodes = new Map();
  const context = createContext({
    document:{querySelector:selector => {if (!nodes.has(selector)) nodes.set(selector,{innerHTML:'',addEventListener(){},querySelectorAll(){return [];}});return nodes.get(selector);},addEventListener(){}},
    window:{addEventListener(){}},location:{hash:'#schedules'},Intl,URL,Set,
  });
  runInContext(source,context);
  const db = {mode:'feishu',timezone:'Asia/Shanghai',today:'2026-11-23',now:'2026-11-23T01:00:00Z',session:{role,employeeId:'self',managedGroupIds:role === 'group_admin' ? ['g1'] : []},groups:[{id:'g1',name:'本组',adminIds:[]}],employees:[{id:'self',name:'本人',department:'研发部',employeeNo:'',groupId:'g1',manageable:role !== 'user',role,bound:true}],locations:[],schedules:[],records:[],shiftTemplates:[],integration:{configured:true}};
  runInContext(`ui.db = ${JSON.stringify(db)}; ui.week='2026-11-23'; ui.view='schedules'; render();`,context);
  return {nodes,context,views:JSON.parse(runInContext('JSON.stringify(visibleViews())',context))};
}

test('Ordinary users get personal pages and cannot open management drawers through UI handlers', () => {
  const {nodes,context,views} = screen('user');
  assert.deepEqual(views,['checkin','schedules','requests','records']);
  assert.match(nodes.get('#main').innerHTML,/我的排班/);
  assert.doesNotMatch(nodes.get('#main').innerHTML,/data-action="new-schedule"|data-tab="templates"/);
  assert.doesNotMatch(nodes.get('#navigation').innerHTML,/人员管理|考勤组|考勤地点|飞书接入/);
  assert.doesNotMatch(nodes.get('#navigation').innerHTML,/nav-more|nav-secondary/);
  runInContext("openDrawer('schedule');openDrawer('location');",context);
  assert.equal(runInContext('ui.drawer',context),null);
  runInContext("ui.view='groups';render();",context);
  assert.equal(runInContext('ui.view',context),'checkin');
});

test('Group and organization administrators have different workspaces and authority controls', () => {
  const manager = screen('group_admin');
  assert.deepEqual(manager.views,['overview','groups','employees','schedules','records','checkin','requests']);
  assert.doesNotMatch(manager.nodes.get('#navigation').innerHTML,/考勤地点|飞书接入/);
  runInContext("openDrawer('access');openDrawer('location');openDrawer('group');",manager.context);
  assert.equal(runInContext('ui.drawer',manager.context),null);
  const org = screen('org_admin');
  assert.ok(org.views.includes('locations') && org.views.includes('integration'));
  assert.match(org.nodes.get('#user-label').innerHTML,/组织管理员/);
  const nav=org.nodes.get('#navigation').innerHTML;
  assert.doesNotMatch(nav,/组织部门|企业工作台|工作空间/);
  assert.match(nav,/<summary[^>]*>[\s\S]*?更多<\/span><\/summary>/);
  assert.equal((nav.split('<details')[0].match(/data-action="navigate"/g)||[]).length-(nav.split('<details')[0].match(/nav-secondary/g)||[]).length,4);
});


test('Setup chooses the next missing requirement from real data and keeps group context', () => {
  const {nodes,context} = screen('org_admin');
  const next = () => runInContext('setupSteps().find(s => !s.done)?.id',context);
  assert.equal(next(),'locations');
  runInContext("ui.view='overview';render();",context);
  assert.match(nodes.get('#main').innerHTML,/设置考勤地点/);
  assert.match(nodes.get('#main').innerHTML,/data-step="locations"/);
  runInContext("ui.db.locations.push({id:'place',name:'办公楼',radius:100});",context);
  assert.equal(next(),'schedules','existing default group and bound member need not be recreated');
  runInContext("ui.db.schedules.push({id:'past',groupId:'g1',employeeId:'self',date:'2026-11-22',segments:[]});",context);
  assert.equal(next(),'schedules','past schedules do not satisfy upcoming work');
  runInContext("ui.db.schedules.push({id:'today',groupId:'g1',employeeId:'self',date:ui.db.today,segments:[]});",context);
  assert.equal(next(),undefined);
  runInContext("ui.db.groups.push({id:'g2',name:'新组',adminIds:[]});ui.group='g2';",context);
  assert.equal(next(),'employees','new group cannot inherit another group’s completed setup');
  const manager = screen('group_admin');
  assert.deepEqual(JSON.parse(runInContext('JSON.stringify(setupSteps().map(s => s.id))',manager.context)),['employees','schedules']);
});

test('Scheduling prerequisites point to an actionable page; personal schedules remain read-only', () => {
  const org = screen('org_admin');
  assert.equal(runInContext('schedulePrerequisite().view',org.context),'locations');
  assert.match(org.nodes.get('#main').innerHTML,/去设置地点/);
  const manager = screen('group_admin');
  assert.equal(runInContext('schedulePrerequisite().view',manager.context),'overview');
  assert.match(manager.nodes.get('#main').innerHTML,/联系组织管理员/);
  runInContext("ui.db.locations=[{id:'place'}];ui.group='empty';",org.context);
  assert.equal(runInContext('schedulePrerequisite().view',org.context),'employees');
  const user = screen('user');
  assert.match(user.nodes.get('#main').innerHTML,/personal-days/);
  assert.doesNotMatch(user.nodes.get('#main').innerHTML,/schedule-cell-button|data-action="new-schedule"/);
  runInContext("ui.view='checkin';render();",user.context);
  assert.match(user.nodes.get('#main').innerHTML,/查看我的排班/);
  assert.doesNotMatch(user.nodes.get('#main').innerHTML,/继续配置考勤/);
});
