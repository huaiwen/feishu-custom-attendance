import test from 'node:test';
import assert from 'node:assert/strict';
import {createWorkflows,initializeWorkflows,workflowConfiguration,approvalRanges,approvalLink,workflowView} from '../workflows.mjs';
import {createFeishuWorkflowApi,feishuResult} from '../feishu-workflows.mjs';
import {sessionFor,visibleState} from '../access.mjs';

const env={FEISHU_WORKFLOWS_ENABLED:'true',FEISHU_LEAVE_APPROVAL_CODE:'leave-code',FEISHU_LEAVE_APPROVAL_ID:'123',FEISHU_OVERTIME_APPROVAL_CODE:'work-code',FEISHU_OVERTIME_APPROVAL_ID:'456',FEISHU_BITABLE_APP_TOKEN:'basetest12345',FEISHU_BITABLE_TABLE_ID:'tbltest12345'};
const range={start:'2026-11-22T10:00:00+08:00',end:'2026-11-22T12:00:00+08:00'};
const form=JSON.stringify([{id:'interval',type:'dateInterval',value:range}]);
function fixture() {
  let time=Date.parse('2026-11-22T11:00:00+08:00');
  let state={version:2,employees:[{id:'self',name:'本人',department:'教师组',openId:'ou_self',groupId:'g1'},{id:'other',name:'其他成员',openId:'ou_other',groupId:'g2'}],groups:[{id:'g1',name:'一组',adminIds:[]},{id:'g2',name:'二组',adminIds:[]}],locations:[{id:'site',name:'办公室',latitude:40,longitude:116,radius:100}],schedules:[],records:[],shiftTemplates:[],reminders:{preferences:{},deliveries:[]}};
  initializeWorkflows(state);
  const config={workflows:workflowConfiguration(env),baseUrl:'https://attendance.example.com',appId:'cli_test',tenantKey:'tenant',adminOpenIds:['ou_admin']};
  const native={instance_code:'instance1',approval_code:'leave-code',open_id:'ou_self',status:'APPROVED',form};
  const calls={messages:[],creates:[],invites:[],deletes:[],archives:[],subscriptions:[]};
  const api={instance:async id=>({...native,instance_code:id}),subscribe:async code=>calls.subscriptions.push(code),send:async data=>{calls.messages.push(data);return 'message';},
    createCalendar:async data=>{calls.creates.push(data);return {calendarId:'cal',eventId:`event${calls.creates.length}`};},
    inviteCalendar:async(...data)=>calls.invites.push(data),deleteCalendar:async data=>calls.deletes.push(data),
    archive:async data=>{calls.archives.push(data);return data.recordId || `record${calls.archives.length}`;},contact:async()=>({name:'新名字',status:{}})};
  const commit=fn=>{const next=structuredClone(state);fn(next);state=next;};
  const options={getState:()=>state,commit,config,api,now:()=>time};
  let service=createWorkflows(options);
  return {get state(){return state;},get service(){return service;},native,calls,config,api,commit,advance:ms=>time+=ms,
    restart(){service=createWorkflows(options);},
    event(status=native.status,uuid='event1'){service.acceptApproval({app_id:'cli_test',tenant_key:'tenant',approval_code:native.approval_code,instance_code:native.instance_code,status,uuid});},
    position(){return {rangeIndex:0,locationId:'site',latitude:40,longitude:116,accuracy:5,coordinateSystem:'wgs84',locatedAt:new Date(time).toISOString()};}};
}

test('Approval configuration is explicit and original form data cannot become links',()=>{
  assert.equal(workflowConfiguration({}).enabled,false);
  assert.throws(()=>workflowConfiguration({...env,FEISHU_BITABLE_TABLE_ID:''}),/多维表格/);
  assert.throws(()=>workflowConfiguration({...env,FEISHU_OVERTIME_APPROVAL_CODE:'leave-code'}),/不同/);
  const url=new URL(approvalLink('123',{form:true}));assert.equal(url.hostname,'applink.feishu.cn');assert.equal(url.searchParams.get('path'),'pages/approval-form/index?id=123');
  assert.throws(()=>approvalLink('javascript:alert(1)'),/编号/);
});

test('Native approval date groups and multiple overtime intervals are parsed without guessing',()=>{
  assert.deepEqual(approvalRanges(form),[{start:'2026-11-22T02:00:00.000Z',end:'2026-11-22T04:00:00.000Z'}]);
  const pair=(start,end)=>[{id:'widgetWorkGroupStartTime',type:'date',value:start},{id:'widgetWorkGroupEndTime',type:'date',value:end}];
  const work=[{type:'workGroup',value:[{type:'fieldList',value:[pair(range.start,range.end),pair('2026-11-22T14:00:00+08:00','2026-11-22T16:00:00+08:00')]}]}];
  assert.equal(approvalRanges(JSON.stringify(work)).length,2);
  for(const invalid of ['{}','[]','invalid',JSON.stringify([{type:'dateInterval',value:{start:'2026-11-22',end:'2026-11-23'}}]),JSON.stringify([{type:'dateInterval',value:{start:range.end,end:range.start}}])]) assert.throws(()=>approvalRanges(invalid));
  assert.throws(()=>approvalRanges(JSON.stringify([{type:'dateInterval',value:range},{type:'dateInterval',value:range}])),/重叠/);
});

test('Events are durable and deduplicated; private form reasons never leave native approval',async()=>{
  const f=fixture();f.event();f.event();assert.equal(f.state.workflows.jobs.length,1);
  f.restart();await f.service.run();await f.service.run();
  assert.equal(f.state.workflows.requests.length,1);assert.equal(f.calls.messages.length,1);
  assert.equal(f.calls.messages[0].card.schema,'2.0');assert.equal(f.calls.messages[0].card.body.elements[1].behaviors[0].type,'callback');
  f.event();f.restart();await f.service.run();assert.equal(f.calls.messages.length,1);
  assert.equal(f.calls.subscriptions.length,2);assert.equal(f.calls.archives.length,1);
  assert.equal('form' in f.state.workflows.requests[0],false);
  assert.equal(f.calls.creates.length,0,'approval alone cannot enroll a user into a calendar');
});

test('Only the applicant can use calendar cards; native approval is checked again and sync survives restart',async()=>{
  const f=fixture();f.event();await f.service.run();
  const action={operator:{open_id:'ou_other'},action:{value:{action:'sync_calendar',instanceId:'instance1'}},event_id:'card1'};
  assert.equal(f.service.cardAction(action).toast.type,'error');
  await assert.rejects(f.service.requestCalendar('instance1','ou_other'),/本人/);
  action.operator.open_id='ou_self';assert.equal(f.service.cardAction(action).toast.type,'success');
  f.restart();await f.service.run();
  assert.equal(f.calls.creates.length,1);assert.equal(f.calls.invites.length,1);
  assert.equal(f.calls.invites[0][1],'ou_self');
  f.service.cardAction(action);f.restart();await f.service.run();assert.equal(f.calls.creates.length,1);
  f.native.status='CANCELED';f.event('CANCELED','cancel1');await f.service.run();
  assert.equal(f.calls.deletes.length,1);assert.equal(f.state.workflows.requests[0].calendars.length,0);
  await assert.rejects(f.service.requestCalendar('instance1','ou_self'),/通过后/);
});

test('A forged callback or late APPROVED event cannot override the current native status',async()=>{
  const f=fixture();f.event();await f.service.run();f.native.status='REJECTED';
  assert.equal(f.service.cardAction({event_id:'card',operator:{open_id:'ou_self'},action:{value:{action:'sync_calendar',instanceId:'instance1'}}}).toast.type,'success');
  f.event('APPROVED','late');await f.service.run();
  assert.equal(f.calls.creates.length,0);assert.equal(f.state.workflows.requests[0].status,'REJECTED');
  f.service.acceptApproval({tenant_key:'evil',approval_code:'leave-code',instance_code:'instance2'});assert.equal(f.state.workflows.jobs.some(j=>j.instanceId==='instance2'),false);
});

test('Overtime needs a real current position during the approved interval, including accuracy at the fence',async()=>{
  const f=fixture();f.native.approval_code='work-code';f.event();await f.service.run();
  await assert.rejects(f.service.requestCalendar('instance1','ou_self',{}),/加班时段/);
  await assert.rejects(f.service.requestCalendar('instance1','ou_self',{...f.position(),latitude:41}),/有效打卡范围/);
  await assert.rejects(f.service.requestCalendar('instance1','ou_self',{...f.position(),accuracy:120}),/精度不足/);
  await assert.rejects(f.service.requestCalendar('instance1','ou_self',{...f.position(),locatedAt:'2026-11-22T10:00:00+08:00'}),/过期/);
  f.advance(2*3600000);await assert.rejects(f.service.requestCalendar('instance1','ou_self',f.position()),/获批/);f.advance(-2*3600000);
  await f.service.requestCalendar('instance1','ou_self',f.position());await f.service.run();
  assert.equal(f.calls.creates.length,1);assert.equal(f.calls.creates[0].locationName,'办公室');
  assert.equal('latitude' in f.state.workflows.requests[0].verifications[0],false);
  assert.equal(f.state.workflows.requests[0].verifications[0].distance,0);
});

test('One bad form is visible but cannot produce a calendar; contact departure revokes the employee',async()=>{
  const f=fixture();f.native.form='[]';f.event();await f.service.run();
  await assert.rejects(f.service.requestCalendar('instance1','ou_self'),/没有识别/);
  f.service.acceptContact('deleted',{tenant_key:'tenant',event_id:'left',object:{open_id:'ou_self',user_id:'user-self'}});
  assert.equal(sessionFor(f.state,'ou_self',[]),null);await f.service.run();
  await assert.rejects(f.service.requestCalendar('instance1','ou_self'),/本人/);
  assert.equal(f.calls.messages.filter(m=>m.openId==='ou_admin').length,1);
});

test('Personal, group and organization views hide private queues and restrict request exports',async()=>{
  const f=fixture();f.event();await f.service.run();f.native.instance_code='instance2';f.native.open_id='ou_other';f.event('APPROVED','event2');await f.service.run();
  const user=sessionFor(f.state,'ou_self',[]);
  assert.equal(workflowView(f.state,user,f.config).requests.length,1);
  assert.equal(workflowView(f.state,{role:'group_admin',employeeId:null,managedGroupIds:['g2']},f.config).requests[0].employeeId,'other');
  const view=visibleState(f.state,user,[]);assert.equal('workflows' in view,false);assert.equal('reminders' in view,false);
  const publicView=JSON.stringify(workflowView(f.state,user,f.config));assert.equal(publicView.includes('ou_self'),false);assert.equal(publicView.includes('basetest12345'),false);
});

test('External retries reuse a created event, do not recreate it when invitation fails',async()=>{
  const f=fixture();f.event();await f.service.run();await f.service.requestCalendar('instance1','ou_self');
  const invite=f.api.inviteCalendar;f.api.inviteCalendar=async()=>{throw new Error('network');};await f.service.run();
  assert.equal(f.calls.creates.length,1);assert.equal(f.state.workflows.requests[0].calendars[0].invited,false);
  f.api.inviteCalendar=invite;f.restart();f.advance(60001);await f.service.run();assert.equal(f.calls.creates.length,1);assert.equal(f.calls.invites.length,1);
});

test('Approval range changes remove obsolete calendars before another overtime location check',async()=>{
  for (const kind of ['leave-code','work-code']) {
    const f=fixture();f.native.approval_code=kind;f.event();await f.service.run();
    await f.service.requestCalendar('instance1','ou_self',f.position());await f.service.run();
    assert.equal(f.calls.creates.length,1);
    f.native.form=JSON.stringify([{type:'dateInterval',value:{start:range.start,end:'2026-11-22T13:00:00+08:00'}}]);
    f.event('APPROVED','changed');await f.service.run();
    assert.equal(f.calls.deletes.length,1);
    assert.equal(f.calls.creates.length,kind==='leave-code'?2:1);
    assert.equal(f.state.workflows.requests[0].verifications.length,0);
  }
  const f=fixture();f.native.form=JSON.stringify([{type:'dateInterval',value:range},{type:'dateInterval',value:{start:'2026-11-22T14:00:00+08:00',end:'2026-11-22T15:00:00+08:00'}}]);
  f.event();await f.service.run();await f.service.requestCalendar('instance1','ou_self');await f.service.run();
  assert.equal(f.calls.creates.length,2);f.native.form=form;f.event('APPROVED','shorter');await f.service.run();
  assert.equal(f.calls.deletes.length,1);assert.equal(f.state.workflows.requests[0].calendars.length,1);
});

test('Ordinary punches archive automatically and never create calendar events',async()=>{
  const f=fixture();f.commit(s=>s.records.push({id:'punch1',employeeId:'self',employeeName:'本人',kind:'in',timestamp:new Date().toISOString(),locationName:'办公室',latitude:40,longitude:116,status:'normal'}));
  await f.service.run();await f.service.run();assert.equal(f.calls.archives.length,1);assert.equal(f.calls.creates.length,0);
  const text=JSON.stringify(f.calls.archives[0]);assert.equal(text.includes('latitude'),false);assert.equal(text.includes('longitude'),false);assert.match(text,/上班打卡/);
});

test('SDK requests use a private bot calendar and an idempotent Bitable upsert',async()=>{
  const calendarCreates=[],invites=[],records=[];
  const client={calendar:{calendar:{primary:async()=>({code:0,data:{calendars:[{calendar:{calendar_id:'cal'}}]}})},calendarEvent:{create:async p=>{calendarCreates.push(p);return {code:0,data:{event:{event_id:'event'}}};}},calendarEventAttendee:{create:async p=>{invites.push(p);return {code:0,data:{}};}}},bitable:{appTableRecord:{search:async()=>({code:0,data:{items:[{record_id:'existing'}]}}),update:async p=>{records.push(p);return {code:0,data:{record:{record_id:'existing'}}};}}}};
  const api=createFeishuWorkflowApi({workflows:workflowConfiguration(env)},client);
  const event=await api.createCalendar({summary:'请假',range,key:'stable-key'});await api.inviteCalendar(event,'ou_self');
  assert.equal(calendarCreates[0].data.visibility,'private');assert.equal(calendarCreates[0].params.idempotency_key,'stable-key');assert.equal(invites[0].data.attendees[0].user_id,'ou_self');
  assert.equal(await api.archive({fields:{业务编号:'punch:1'},key:'record-key'}),'existing');assert.equal(records[0].path.record_id,'existing');
  const created=[];
  client.bitable.appTableRecord.search=async()=>({code:0,data:{items:[]}});
  client.bitable.appTableRecord.create=async p=>{created.push(p);return {code:0,data:{record:{record_id:'new'}}};};
  for (let attempt=0;attempt<2;attempt++) await api.archive({fields:{业务编号:'punch:2'},key:'record-key-2'});
  assert.match(created[0].params.client_token,/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(created[0].params.client_token,created[1].params.client_token);
  await assert.rejects(feishuResult(Promise.resolve({code:999,msg:'private-secret'})),e=>!e.message.includes('private-secret'));
});

test('Retrying deletion and approval subscription accepts only documented already-done responses',async()=>{
  for(const rejected of [false,true]) {
    let code=193003;
    const client={calendar:{calendarEvent:{delete:async()=>{if(rejected)throw {response:{data:{code}}};return {code};}}}};
    const api=createFeishuWorkflowApi({workflows:workflowConfiguration(env)},client);
    await api.deleteCalendar({calendarId:'cal',eventId:'event'});
    code=193002;await assert.rejects(api.deleteCalendar({calendarId:'cal',eventId:'event'}));
    const subscriptions=createFeishuWorkflowApi({workflows:workflowConfiguration(env)},{approval:{approval:{subscribe:async()=>{if(rejected)throw {response:{data:{code:1390007}}};return {code:1390007};}}}});
    await subscriptions.subscribe('leave-code');
  }
});
