import test from 'node:test';
import assert from 'node:assert/strict';
import { dueReminders, createReminderDispatcher, initializeReminders, reminderPreferences, validateReminderPreferences, reminderHistory, reminderPunch, dailyAttendance, punchReminder } from '../reminders.mjs';
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
  const {card,key}=dueReminders(state,config,at('08:45')).find(item=>item.openId==='ou_a');
  assert.equal(card.schema,'2.0');assert.equal(card.config.enable_forward,false);
  assert.equal(card.header.title.content,'上班打卡提醒');assert.equal(card.header.template,'blue');
  const details=card.body.elements[0].text;
  assert.match(details.content,/打卡日期：2040-01-02/);assert.match(details.content,/计划时间：09:00/);
  assert.equal(details.tag,'plain_text');assert.ok(details.content.includes(state.locations[0].name),'names cannot inject card mentions or links');
  const button=card.body.elements.at(-1);
  assert.equal(button.text.content,'去打卡');assert.equal(button.type,'primary_filled');
  assert.deepEqual(button.behaviors,[{type:'open_url',default_url:`https://attendance.example.com/#punch=${key}`}]);
  assert.equal(card.config.update_multi,true);
  assert.equal(card.body.elements.filter(element=>element.tag==='button').length,1);
  assert.equal(dueReminders(state,config,at('17:45'))[0].card.header.title.content,'下班打卡提醒');
});

test('A reminder binds to its recipient and exact shift; edits invalidate an uncompleted card',async()=>{
  let state=fixture();state.schedules.splice(1);
  const worker=createReminderDispatcher({getState:()=>state,config,now:()=>at('08:45'),commit:fn=>fn(state),send:async()=> 'om_bound'});
  await worker.run();const row=state.reminders.deliveries[0];
  assert.equal(reminderPunch(state,'ou_a',row.key).input.kind,'in');
  assert.throws(()=>reminderPunch(state,'ou_b',row.key),/不可用/);
  state.schedules[0].segments[0].start='10:00';
  assert.throws(()=>reminderPunch(state,'ou_a',row.key),/已调整/);
  state.schedules[0].segments[0].start='09:00';state.employees[0].disabled=true;
  assert.throws(()=>reminderPunch(state,'ou_a',row.key),/不可用/);
});

test('Completed punches update only the original card; a failed update retries after restart without sending or punching again',async()=>{
  let state=fixture(),now=at('08:45'),updates=0;state.schedules.splice(1);
  const options={getState:()=>state,config,now:()=>now,commit:fn=>{state=structuredClone(state);fn(state);},send:async()=> 'om_original',update:async({messageId,card})=>{
    updates++;assert.equal(messageId,'om_original');assert.equal(card.header.title.content,'打卡成功');assert.equal(card.config.update_multi,true);
    assert.doesNotMatch(JSON.stringify(card),/longitude|latitude|ou_a|#punch=/);
    if(updates===1)throw new Error('network-private');
  }};
  const worker=createReminderDispatcher(options);await worker.run();
  state.records.push({id:'r',employeeId:'a',scheduleId:'a',segmentIndex:0,kind:'in',date:'2040-01-02',timestamp:new Date(at('09:00')).toISOString(),locationName:'园区',status:'normal'});
  await worker.syncCompleted();assert.equal(updates,1);await worker.syncCompleted();assert.equal(updates,1);
  now+=60_000;await createReminderDispatcher(options).syncCompleted();assert.equal(updates,2);
  assert.equal(reminderPunch(state,'ou_a',state.reminders.deliveries[0].key).cardUpdated,true);
  await worker.syncCompleted();assert.equal(updates,2);assert.equal(state.records.length,1);
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
  const tester=createReminderDispatcher({...options,send:async item=>{assert.equal(item.openId,'ou_a');assert.match(item.card.header.title.content,/测试提醒/);assert.equal(item.card.body.elements.at(-1).text.content,'查看今日打卡');return 'om_test';}});
  await tester.test('ou_a');await assert.rejects(tester.test('ou_a'),/5 分钟/);
});

test('Daily cards count individual punches, list every remaining site and isolate the employee and date',()=>{
  const state=fixture();state.locations=[{id:'east',name:'东楼'},{id:'west',name:'西楼'}];
  state.schedules[0].segments=[{start:'09:00',end:'12:00',locationId:'east'},{start:'14:00',end:'18:00',locationId:'west'}];
  state.schedules.push({...state.schedules[0],id:'tomorrow',date:'2040-01-03'});
  state.records.push({employeeId:'a',scheduleId:'a',segmentIndex:0,kind:'in'});
  const day=dailyAttendance(state,'a','2040-01-02',at('11:45'));
  assert.equal(day.total,4);assert.equal(day.completed,1);assert.equal(day.remaining.length,3);
  assert.deepEqual(day.remaining.map(p=>[p.time,p.kind,p.locationName]),[['12:00','out','东楼'],['14:00','in','西楼'],['18:00','out','西楼']]);
  const card=dueReminders(state,config,at('11:45')).find(r=>r.openId==='ou_a').card;
  assert.match(card.config.summary.content,/今日还剩 3 次打卡/);
  assert.doesNotMatch(JSON.stringify(card),/ou_b|2040-01-03|longitude|latitude/);
  const night=punchReminder(state,config,{key:'a'.repeat(40),openId:'ou_a',schedule:state.schedules.at(-1),segmentIndex:0,kind:'in',dueAt:at('23:59')}).card;
  assert.match(night.config.summary.content,/2040-01-03还剩 4 次/);assert.doesNotMatch(night.config.summary.content,/今日/);
});

test('Daily card expiry follows minute boundaries and midnight without concealing missed punches',()=>{
  const state=fixture();state.schedules[0].segments=[{start:'09:00',end:'12:00'}];
  assert.deepEqual(dailyAttendance(state,'a','2040-01-02',at('12:00')).remaining.map(p=>p.expired),[true,false]);
  assert.equal(dailyAttendance(state,'a','2040-01-02',at('14:00')+59000).remaining[1].expired,false);
  assert.equal(dailyAttendance(state,'a','2040-01-02',at('14:01')).remaining[1].expired,true);
  state.schedules[0].segments[0].end='23:59';
  assert.equal(dailyAttendance(state,'a','2040-01-02',Date.parse('2040-01-03T00:00:00+08:00')).remaining[1].expired,true);
});

test('Original success cards refresh remaining counts after later punches and remain quiet when unchanged',async()=>{
  const state=fixture();state.schedules.splice(1);const cards=[];
  const worker=createReminderDispatcher({getState:()=>state,commit:fn=>fn(state),config,now:()=>at('09:00'),send:async()=> 'om_original',update:async({card})=>cards.push(card)});
  const reminder=punchReminder(state,config,{key:'b'.repeat(40),openId:'ou_a',schedule:state.schedules[0],segmentIndex:0,kind:'in',dueAt:at('08:45')});
  state.reminders.deliveries.push({...reminder,status:'sent',messageId:'om_original',sentAt:at('08:45')});
  const record={id:'in',employeeId:'a',scheduleId:'a',segmentIndex:0,kind:'in',date:'2040-01-02',timestamp:new Date(at('09:00')).toISOString(),locationName:'东楼',status:'normal'};
  state.records.push(record);await worker.syncCompleted();
  assert.match(cards.at(-1).config.summary.content,/今日还剩 1 次/);
  state.records.push({...record,id:'out',kind:'out'});await worker.syncCompleted();
  assert.equal(cards.length,2);assert.match(cards.at(-1).config.summary.content,/今日打卡已全部完成/);
  assert.doesNotMatch(JSON.stringify(cards.at(-1)),/#punch=/);
  await worker.syncCompleted();assert.equal(cards.length,2);
});

test('The largest supported daily checklist fits the native card payload limit with long Chinese names',()=>{
  const state=fixture();state.locations=[{id:'site',name:'楼'.repeat(80)}];
  state.schedules[0].segments=Array.from({length:12},(_,i)=>({start:`${String(i*2).padStart(2,'0')}:00`,end:`${String(i*2+1).padStart(2,'0')}:00`,locationId:'site'}));
  const {card}=punchReminder(state,config,{key:'c'.repeat(40),openId:'ou_a',schedule:state.schedules[0],segmentIndex:0,kind:'in',dueAt:at('00:00')});
  assert.match(card.config.summary.content,/24 次/);
  assert.ok(Buffer.byteLength(JSON.stringify(card))<=30000);
});
