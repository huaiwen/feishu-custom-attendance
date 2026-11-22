import test from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, createReminderDispatcher, initializeReminders, reminderPreferences, validateReminderPreferences, reminderHistory } from '../reminders.mjs';
import { visibleState, sessionFor } from '../access.mjs';

const config = { baseUrl: 'https://attendance.example.com', adminOpenIds: ['ou_org'], remindersEnabled: true };
const at = time => Date.parse(`2040-01-02T${time}:00+08:00`);
function fixture() {
  const state = { version: 2, employees: [{ id:'a',openId:'ou_a',groupId:'g1' },{ id:'b',openId:'ou_b',groupId:'g1' },{id:'m',openId:'ou_manager',groupId:'g2'}],
    groups: [{id:'g1',name:'一组',adminIds:['m']},{id:'g2',name:'二组',adminIds:[]}], locations: [], records: [], shiftTemplates: [],
    schedules: ['a','b'].map(employeeId => ({id:employeeId,employeeId,groupId:'g1',date:'2040-01-02',segments:[{start:'09:00',end:'18:00'}]})) };
  initializeReminders(state);return state;
}

test('Each person chooses 15 or 30 minutes; admin delay defaults to 60 and ordinary users cannot set review settings', () => {
  const state = fixture();
  assert.deepEqual(reminderPreferences(state,'ou_a','user'),{checkinEnabled:true,beforeMinutes:15});
  assert.equal(reminderPreferences(state,'ou_manager','group_admin').afterMinutes,60);
  assert.throws(() => validateReminderPreferences({checkinEnabled:true,beforeMinutes:20},'user'),/15 或 30/);
  assert.throws(() => validateReminderPreferences({checkinEnabled:true,beforeMinutes:15,openId:'ou_other'},'user'),/本人/);
  assert.throws(() => validateReminderPreferences({checkinEnabled:true,beforeMinutes:15,reviewEnabled:true,afterMinutes:60},'user'),/本人/);
  for (const afterMinutes of [0,1441,1.5,'60']) assert.throws(() => validateReminderPreferences({checkinEnabled:true,beforeMinutes:30,reviewEnabled:true,afterMinutes},'org_admin'),/1 至 1440/);
  state.reminders.preferences.ou_a = {checkinEnabled:true,beforeMinutes:30};
  assert.deepEqual(dueReminders(state,config,at('08:30')).map(x=>x.openId),['ou_a']);
  assert.deepEqual(dueReminders(state,config,at('08:45')).map(x=>x.openId),['ou_b']);
  assert.equal(dueReminders(state,config,at('08:50')).length,0,'old reminders are not caught up');
  state.records.push({scheduleId:'b',segmentIndex:0,kind:'in'});
  assert.equal(dueReminders(state,config,at('08:45')).length,0,'completed punches are not reminded');
  state.reminders.preferences.ou_a.checkinEnabled=false;
  assert.equal(dueReminders(state,config,at('17:30')).length,0);
});

test('Review reminders aggregate by group and punch time, follow current managers, and fallback to organization admins', () => {
  const state = fixture();
  let items = dueReminders(state,config,at('10:00'));
  assert.equal(items.length,1);assert.equal(items[0].openId,'ou_manager');
  assert.match(items[0].card.body.elements.at(-1).behaviors[0].default_url,/group=g1#records/);
  assert.doesNotMatch(JSON.stringify(items[0].card),/ou_a|ou_b/);
  state.groups[0].adminIds=[];
  items = dueReminders(state,config,at('10:00'));
  assert.deepEqual(items.map(x=>x.openId),['ou_org']);
  state.reminders.preferences.ou_org={reviewEnabled:true,afterMinutes:90};
  assert.equal(dueReminders(state,config,at('10:00')).length,0);
  assert.equal(dueReminders(state,config,at('10:30')).length,1);
});

test('Employee reminders are native cards with shift time, a plain-text location and one direct punch button', () => {
  const state=fixture();state.locations=[{id:'office',name:'测试楼 <at id=all> & [链接](https://example.org)'}];
  state.schedules[0].segments[0].locationId='office';
  const {card}=dueReminders(state,config,at('08:45')).find(item=>item.openId==='ou_a');
  assert.equal(card.schema,'2.0');assert.equal(card.config.enable_forward,false);
  assert.equal(card.header.title.content,'上班打卡提醒');assert.match(card.header.subtitle.content,/2040-01-02.*09:00/);
  const details=card.body.elements[0].columns[0].elements[0].text;
  assert.equal(details.tag,'plain_text');assert.ok(details.content.includes(state.locations[0].name),'names cannot inject card mentions or links');
  const button=card.body.elements.at(-1);
  assert.equal(button.text.content,'去打卡');assert.equal(button.type,'primary_filled');
  assert.deepEqual(button.behaviors,[{type:'open_url',default_url:'https://attendance.example.com/#checkin'}]);
  assert.equal(card.body.elements.filter(element=>element.tag==='button').length,1);
  assert.equal(dueReminders(state,config,at('17:45'))[0].card.header.title.content,'下班打卡提醒');
});

test('Reminders cross midnight using schedule dates in Beijing time', () => {
  const state=fixture();state.schedules[0].segments=[{start:'00:10',end:'23:30'}];state.schedules.splice(1);
  assert.equal(dueReminders(state,config,Date.parse('2040-01-01T23:55:00+08:00'))[0].type,'checkin');
  assert.equal(dueReminders(state,config,Date.parse('2040-01-03T00:30:00+08:00'))[0].type,'review');
});

test('Deliveries persist, deduplicate across restarts and preference changes, retry with the same UUID, and never leak through state', async () => {
  let state=fixture(), now=at('08:45'), calls=[];
  state.schedules.splice(1);
  const options={getState:()=>state,config,now:()=>now,commit:mutate=>{const next=structuredClone(state);mutate(next);state=next;},send:async item=>{calls.push(item);if(calls.length===1)throw new Error('private-token');return 'om_sent';}};
  const worker=createReminderDispatcher(options);
  await worker.run();assert.equal(calls.length,1);assert.equal(state.reminders.deliveries[0].status,'failed');
  await worker.run();assert.equal(calls.length,1,'backoff');
  now+=60_000;await worker.run();assert.equal(calls.length,2);assert.equal(calls[0].uuid,calls[1].uuid);
  const restarted=createReminderDispatcher(options);await restarted.run();assert.equal(calls.length,2);
  assert.equal(state.reminders.deliveries[0].status,'sent');
  for (const openId of ['ou_a','ou_manager','ou_org']) assert.equal('reminders' in visibleState(state,sessionFor(state,openId,config.adminOpenIds),config.adminOpenIds),false);
  assert.equal(reminderHistory(state,'ou_b').length,0);
  assert.doesNotMatch(JSON.stringify(reminderHistory(state,'ou_a')),/private-token|ou_a|om_sent/);
  assert.equal(reminderHistory(state,'ou_a')[0].status,'sent');
});

test('Overlapping ticks are single-flight and a changed schedule cancels sending before the API call', async () => {
  let state=fixture();state.schedules.splice(1);let finish,calls=0;
  const worker=createReminderDispatcher({getState:()=>state,config,now:()=>at('08:45'),commit:fn=>fn(state),send:async item=>{calls++;await new Promise(resolve=>{finish=resolve;});return item.isCurrent()?'om_sent':null;}});
  const pending=worker.run();await worker.run();assert.equal(calls,1);
  state.schedules=[];finish();await pending;
  assert.equal(state.reminders.deliveries[0].status,'cancelled');
});

test('Retries stop after three attempts and disabled service never sends; test reminders are private and rate-limited', async () => {
  const state=fixture();state.schedules.splice(1);let now=at('08:45'), calls=0;
  const options={getState:()=>state,config,now:()=>now,commit:fn=>fn(state),send:async()=>{calls++;throw new Error('private-secret');}};
  const worker=createReminderDispatcher(options);
  for(let i=0;i<5;i++){await worker.run();now+=60_000;}
  assert.equal(calls,3);
  assert.doesNotMatch(JSON.stringify(state.reminders),/private-secret/);
  await createReminderDispatcher({...options,config:{...config,remindersEnabled:false}}).run();assert.equal(calls,3);
  const tester=createReminderDispatcher({...options,send:async item=>{assert.equal(item.openId,'ou_a');assert.match(item.card.header.title.content,/测试提醒/);assert.equal(item.card.body.elements.at(-1).text.content,'去打卡');return 'om_test';}});
  await tester.test('ou_a');await assert.rejects(tester.test('ou_a'),/5 分钟/);
});
