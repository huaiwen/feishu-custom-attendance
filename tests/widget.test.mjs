import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createContext, runInContext } from 'node:vm';
import { createAttendanceServer, configuration } from '../server.mjs';
import { exchangeBlockCode } from '../feishu.mjs';

test('Block login validates its one-use code server-side and discards session and user tokens', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({url, options});
    return Response.json(url.endsWith('/app_access_token/internal')
      ? {code:0, app_access_token:'private-app-token', expire:7200}
      : {code:0, data:{open_id:'ou_user', tenant_key:'test-tenant', session_key:'private-session', access_token:'private-user-token'}});
  };
  const options = {appId:'cli_widget_exchange', appSecret:'private-secret', code:'one-use', fetch};
  assert.deepEqual(await exchangeBlockCode(options), {openId:'ou_user', tenantKey:'test-tenant'});
  assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/mina/v2/tokenLoginValidate');
  assert.deepEqual(JSON.parse(calls[1].options.body), {code:'one-use'});
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-app-token');
  await exchangeBlockCode({...options, code:'new-code'});
  assert.equal(calls.length, 3);
  await assert.rejects(exchangeBlockCode({...options, fetch:async()=>Response.json({code:10213, msg:'private diagnostic'})}), error => !error.message.includes('private') && error.message.includes('10213'));
  await assert.rejects(exchangeBlockCode({...options, fetch:async()=>Response.json({code:0,data:{open_id:'ou_user'}})}), /身份响应不完整/);
});

test('Workbench data is own-only, bound to the enterprise and independent of web login cookies', async t => {
  const dir=await mkdtemp(join(tmpdir(),'daka-widget-')), file=join(dir,'state.json');
  const date='2026-11-22';
  t.mock.method(Date,'now',()=>Date.parse(`${date}T08:45:00+08:00`));
  const state={version:2, employees:[{id:'self',openId:'ou_admin',name:'本人',groupId:'default-group'},{id:'other',openId:'ou_other',name:'其他人',groupId:'other-group'},{id:'disabled',openId:'ou_disabled',disabled:true}],
    groups:[{id:'additional',name:'协作组',adminIds:['self']},{id:'default-group',name:'本组',adminIds:['self']},{id:'other-group',name:'其他组',adminIds:[]}],
    locations:[{id:'place',name:'测试园区',latitude:1,longitude:2}], records:[], shiftTemplates:[],
    schedules:[{id:'mine',employeeId:'self',groupId:'default-group',date,segments:[{start:'09:00',end:'12:00',locationId:'place'}]},{id:'theirs',employeeId:'other',groupId:'other-group',date,segments:[{start:'14:00',end:'18:00',locationId:'place'}]}]};
  await writeFile(file,JSON.stringify(state));
  const env={PORT:'0',FEISHU_APP_ID:'cli_widget_route',FEISHU_APP_SECRET:'secret',BASE_URL:'https://attendance.example.com',ADMIN_OPEN_IDS:'ou_admin',FEISHU_TENANT_KEY:'tenant',FEISHU_WIDGET_ORIGIN:'https://company.feishu.cn'};
  assert.throws(()=>configuration({...env,FEISHU_WIDGET_ORIGIN:'https://evil.example'}),/飞书企业域名/);
  const {server}=createAttendanceServer({env,dataFile:file});
  t.after(async()=>{server.removeAllListeners();await rm(dir,{recursive:true,force:true});});
  let user='ou_admin', tenant='tenant', exchanges=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if(url.endsWith('/app_access_token/internal')) return Response.json({code:0,app_access_token:'private',expire:7200});
    exchanges++; assert.equal(JSON.parse(options.body).code,'code');
    return Response.json({code:0,data:{open_id:user,tenant_key:tenant}});
  });
  const request=({path='/api/widget/today',method='POST',origin=env.FEISHU_WIDGET_ORIGIN,body={code:'code'}}={})=>new Promise(resolve=>{
    const req=Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{url:path,method,headers:{host:'attendance.example.com',origin,'content-type':'application/json',cookie:'attendance_session=not-used'}});
    const headers=new Headers();
    const res={status:200,headersSent:false,setHeader(k,v){headers.set(k,v);},writeHead(status,values){this.status=status;this.headersSent=true;Object.entries(values||{}).forEach(([k,v])=>headers.set(k,v));},end(value){resolve(new Response(value,{status:this.status,headers}));}};
    server.emit('request',req,res);
  });
  const preflight=await request({method:'OPTIONS'});
  assert.equal(preflight.status,204); assert.equal(preflight.headers.get('access-control-allow-origin'),env.FEISHU_WIDGET_ORIGIN);
  assert.equal(preflight.headers.has('access-control-allow-credentials'),false);
  assert.equal((await request({origin:'https://evil.example'})).status,403);
  assert.equal((await request({body:{code:'code',employeeId:'other'}})).status,400);
  assert.equal(exchanges,0);
  const response=await request(); assert.equal(response.status,200);
  const data=await response.json(); assert.equal(data.total,2); assert.equal(data.remaining.length,2);
  assert.deepEqual(data.remaining.map(p=>p.time),['09:00','12:00']);
  assert.deepEqual(data.leadership,{groupName:'本组',groupCount:2});
  assert.deepEqual(data.punches, [{time:'09:00',kind:'in',locationName:'测试园区',expired:false,done:false},{time:'12:00',kind:'out',locationName:'测试园区',expired:false,done:false}]);
  assert.doesNotMatch(JSON.stringify(data),/ou_|latitude|longitude|secret|theirs|其他人|其他组|default-group/);
  assert.equal(response.headers.has('set-cookie'),false);
  assert.equal((await request({origin:''})).status,200,'native requests may omit Origin but still must exchange a code');
  assert.equal((await request({path:'/api/schedules',body:{},origin:env.FEISHU_WIDGET_ORIGIN})).status,403,'widget CORS does not relax other routes');
  user='ou_other';assert.equal((await (await request()).json()).leadership,null);
  user='ou_disabled';assert.equal((await request()).status,403);
  user='ou_unbound';assert.equal((await request()).status,403);
  user='ou_admin';tenant='foreign';assert.equal((await request()).status,403);
});

test('Native widget auto signs in, refreshes after returning, and never requests or submits GPS itself', async () => {
  const source=await readFile(new URL('../widget/block/index.js',import.meta.url),'utf8');
  let definition, logins=0, pending, opened, now=1000, menuListener, menuRegistrations=0, resizeListener;
  const context=createContext({require:()=>({baseUrl:'https://attendance.example.com',appId:'cli_test'}),Date:{now:()=>now},Block:value=>{definition=value;},
    tt:{login({success}){logins++;success({code:'fresh-code'});},request(options){assert.deepEqual(JSON.parse(JSON.stringify(options.data)),{code:'fresh-code'});pending=options;return {abort(){}};},openSchema(options){opened=options;},
      onMenuItemTap(listener){menuListener=listener;menuRegistrations++;},offMenuItemTap(listener){assert.equal(listener,menuListener);menuListener=null;},
      getContainerRect({success}){success({width:370,height:106});},onContainerResize(listener){resizeListener=listener;},offContainerResize(listener){assert.equal(listener,resizeListener);resizeListener=null;}}});
  runInContext(source,context);
  const widget={data:structuredClone(definition.data),setData(patch){Object.assign(this.data,patch);}};
  definition.onLoad.call(widget);definition.onShow.call(widget);assert.equal(logins,1);
  definition.onReady.call(widget);assert.equal(widget.data.expanded,false);
  resizeListener({width:416,height:239});assert.equal(widget.data.expanded,false);
  resizeListener({width:416,height:240});assert.equal(widget.data.expanded,true);
  resizeListener({width:370,height:241});assert.equal(widget.data.expanded,true);
  assert.equal(menuRegistrations,1);menuListener({key:'unrelated'});assert.equal(logins,1);
  pending.success({statusCode:200,data:{date:'2026-11-22',completed:1,total:4,leadership:{groupName:'研发组',groupCount:2},remaining:[{time:'12:00',kind:'out',locationName:'第一园区',expired:true},{time:'13:00',kind:'in',locationName:'第二园区',expired:false},{time:'18:00',kind:'out',locationName:'第二园区',expired:false}]}});
  assert.equal(widget.data.remaining,3);assert.equal(widget.data.places,'待打地点：第一园区、第二园区');assert.equal(widget.data.next,'13:00 上班 · 第二园区');
  assert.equal(widget.data.leadGroup,'研发组');assert.equal(widget.data.leadRole,'考勤组长 · 共 2 组');
  assert.equal(widget.data.punches.length,2);assert.equal(widget.data.punches[0].status,'未完成');assert.equal(widget.data.punches[1].status,'待打卡');
  definition.methods.openRecords.call(widget);assert.equal(new URL(opened.schema).searchParams.get('lk_target_url'),'https://attendance.example.com/#records');
  definition.methods.openAttendance.call(widget);assert.equal(new URL(opened.schema).origin,'https://applink.feishu.cn');assert.equal(new URL(opened.schema).searchParams.get('appId'),'cli_test');assert.equal(new URL(opened.schema).searchParams.get('lk_target_url'),'https://attendance.example.com/#checkin');assert.equal(opened.external,false);
  definition.onShow.call(widget);assert.equal(logins,1);
  now+=2000;definition.onShow.call(widget);assert.equal(logins,2);
  pending.success({statusCode:200,data:{date:'2026-11-22',completed:4,total:4,remaining:[],punches:[{time:'09:00',kind:'in',locationName:'第一园区',done:true},{time:'12:00',kind:'out',locationName:'第一园区',done:true}]}});
  assert.equal(widget.data.leadGroup,'');
  assert.equal(widget.data.punches[0].status,'已打卡');assert.equal(widget.data.punches[0].label,'09:00 上班 · 第一园区');
  resizeListener({width:370,height:106});assert.equal(widget.data.expanded,false);
  assert.equal(widget.data.remaining,0);definition.methods.openAttendance.call(widget);assert.equal(new URL(opened.schema).searchParams.get('lk_target_url'),'https://attendance.example.com/#records');
  definition.methods.refresh.call(widget);pending.fail();assert.match(widget.data.error,/连接失败/);assert.equal(widget.data.loading,false);
  menuListener({key:'refresh'});assert.equal(logins,4);pending.fail({errno:100,errCode:20001,errMsg:'request:fail internal_code=-105 / secret=one-use-code'});
  assert.equal(widget.data.error,'连接失败（100/20001/-105）');
  assert.doesNotMatch(widget.data.errorDetail,/one-use-code/);
  menuListener({menuItem:{key:'refresh'}});assert.equal(logins,5);pending.fail({errno:'private-token',errCode:'https://private.example',errMsg:'secret=one-use-code'});
  assert.equal(widget.data.error,'连接失败');
  assert.doesNotMatch(widget.data.errorDetail,/one-use-code|private/);
  assert.equal(menuRegistrations,1);
  definition.onDestroy.call(widget);definition.methods.refresh.call(widget);assert.equal(logins,5);assert.equal(menuListener,null);assert.equal(resizeListener,null);
});
