import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createContext,runInContext} from 'node:vm';

const source = readFileSync(new URL('../public/app.js',import.meta.url),'utf8').replace(/\ninit\(\);\s*$/,'');
function screen(role) {
  const nodes = new Map();
  const context = createContext({
    document:{querySelector:selector => {if (!nodes.has(selector)) nodes.set(selector,{innerHTML:'',addEventListener(){}});return nodes.get(selector);},addEventListener(){}},
    window:{addEventListener(){}},location:{hash:'#schedules'},Intl,URL,Set,
  });
  runInContext(source,context);
  const db = {mode:'feishu',timezone:'Asia/Shanghai',today:'2026-11-23',now:'2026-11-23T01:00:00Z',session:{role,employeeId:'self',managedGroupIds:role === 'group_admin' ? ['g1'] : []},groups:[{id:'g1',name:'本组',adminIds:[]}],employees:[{id:'self',name:'本人',department:'研发部',employeeNo:'',groupId:'g1',manageable:role !== 'user',role,bound:true}],locations:[],schedules:[],records:[],shiftTemplates:[],integration:{configured:true}};
  runInContext(`ui.db = ${JSON.stringify(db)}; ui.week='2026-11-23'; render();`,context);
  return {nodes,context,views:JSON.parse(runInContext('JSON.stringify(visibleViews())',context))};
}

test('Ordinary users get personal pages and cannot open management drawers through UI handlers', () => {
  const {nodes,context,views} = screen('user');
  assert.deepEqual(views,['checkin','schedules','records']);
  assert.match(nodes.get('#main').innerHTML,/我的排班/);
  assert.doesNotMatch(nodes.get('#main').innerHTML,/data-action="new-schedule"|data-tab="templates"/);
  assert.doesNotMatch(nodes.get('#navigation').innerHTML,/人员管理|考勤组|考勤地点|飞书接入/);
  runInContext("openDrawer('schedule');openDrawer('location');",context);
  assert.equal(runInContext('ui.drawer',context),null);
  runInContext("ui.view='groups';render();",context);
  assert.equal(runInContext('ui.view',context),'checkin');
});

test('Group and organization administrators have different workspaces and authority controls', () => {
  const manager = screen('group_admin');
  assert.deepEqual(manager.views,['schedules','employees','groups','records','checkin']);
  assert.doesNotMatch(manager.nodes.get('#navigation').innerHTML,/考勤地点|飞书接入/);
  runInContext("openDrawer('access');openDrawer('location');openDrawer('group');",manager.context);
  assert.equal(runInContext('ui.drawer',manager.context),null);
  const org = screen('org_admin');
  assert.ok(org.views.includes('locations') && org.views.includes('integration'));
  assert.match(org.nodes.get('#user-label').innerHTML,/组织管理员/);
});
