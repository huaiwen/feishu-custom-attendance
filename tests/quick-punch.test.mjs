import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createContext,runInContext} from 'node:vm';
import {createAttendanceServer} from '../server.mjs';
import {punchReminder} from '../reminders.mjs';
import {clockParts} from '../domain.mjs';

test('Card punch requires its owner, real current GPS and same origin; retries return the saved punch',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'daka-card-')),file=join(dir,'state.json'),key='a'.repeat(40);
  const env={PORT:'0',FEISHU_APP_ID:'cli_card',FEISHU_APP_SECRET:'secret-test',BASE_URL:'https://attendance.example.com',ADMIN_OPEN_IDS:'ou_admin',FEISHU_TENANT_KEY:'tenant-test'};
  const state={version:2,employees:[{id:'e',name:'本人',openId:'ou_user',employeeNo:'T1',groupId:'g'},{id:'other',name:'他人',openId:'ou_other',employeeNo:'T2',groupId:'g'}],
    groups:[{id:'g',name:'测试组',adminIds:[]}],locations:[{id:'l',name:'测试地点',latitude:40,longitude:116,coordinateSystem:'wgs84',radius:100}],
    schedules:[{id:'s',employeeId:'e',groupId:'g',date:clockParts().date,segments:[{start:'00:00',end:'23:59',locationId:'l'}]}],records:[],shiftTemplates:[],reminders:{preferences:{},deliveries:[]}};
  const reminder=punchReminder(state,{baseUrl:env.BASE_URL},{key,openId:'ou_user',schedule:state.schedules[0],segmentIndex:0,kind:'out',dueAt:Date.now()});
  state.reminders.deliveries.push({...reminder,card:undefined,status:'sent',sentAt:Date.now(),messageId:'om_card'});
  await writeFile(file,JSON.stringify(state));const {server}=createAttendanceServer({env,dataFile:file});server.address=()=>({port:4173});
  t.after(async()=>{server.removeAllListeners();await rm(dir,{recursive:true,force:true});});
  let identity='ou_user';
  t.mock.method(globalThis,'fetch',async url=>Response.json(url.endsWith('/oauth/token')?{code:0,access_token:'test-access'}:{code:0,data:{open_id:identity,name:'测试',tenant_key:'tenant-test'}}));
  const request=(path,{method='GET',body,cookie='',origin=env.BASE_URL}={})=>new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);Object.assign(req,{url:path,method,headers:{host:'attendance.example.com',origin,cookie,'content-type':'application/json'}});
    const headers=new Headers(),res={status:200,headersSent:false,setHeader(k,v){headers.set(k,v);},writeHead(status,values){this.status=status;this.headersSent=true;Object.entries(values||{}).forEach(([k,v])=>headers.set(k,v));},end(value){resolve(new Response(value,{status:this.status,headers}));}};server.emit('request',req,res);
  });
  const login=async()=>{const bootstrap=await request('/api/auth/bootstrap'),{nonce}=await bootstrap.json();const response=await request('/auth/feishu',{method:'POST',body:{nonce,code:'code'},cookie:bootstrap.headers.get('set-cookie').split(';')[0]});return response.headers.get('set-cookie').split(';')[0];};
  const cookie=await login(),url=`/api/reminders/punch?key=${key}`;
  assert.equal((await request(url)).status,401);assert.equal((await request(url,{cookie})).status,200);
  identity='ou_other';const other=await login();assert.equal((await request(url,{cookie:other})).status,404);
  const body={reminderKey:key,employeeId:'other',scheduleId:'forged',kind:'in',latitude:40,longitude:116,coordinateSystem:'wgs84',accuracy:5,locatedAt:new Date().toISOString()};
  assert.equal((await request('/api/checkin',{method:'POST',cookie,body,origin:'https://evil.example'})).status,403);
  assert.equal((await request('/api/checkin',{method:'POST',cookie:other,body})).status,404);
  assert.equal((await request('/api/checkin',{method:'POST',cookie,body:{...body,latitude:41}})).status,400);
  const saved=await request('/api/checkin',{method:'POST',cookie,body});assert.equal(saved.status,200);
  const {record}=await saved.json();assert.equal(record.employeeId,'e');assert.equal(record.kind,'out');
  const again=await(await request('/api/checkin',{method:'POST',cookie,body:{reminderKey:key}})).json();assert.equal(again.record.id,record.id);
  assert.equal(JSON.parse(await readFile(file)).records.length,1);
  const redirect=await request(`/auth/login?view=punch%3D${key}`);assert.equal(redirect.status,302);
});

const source=await readFile(new URL('../public/app.js',import.meta.url),'utf8');
function client({completed=false,failLocation=false,leave=false,cardUpdated=true}={}) {
  const key='b'.repeat(40),requests=[],main={innerHTML:'',querySelector(){return {insertAdjacentHTML(){}};}},record={timestamp:'2040-01-02T01:00:00Z',locationName:'测试园区',status:'normal'};
  let locations=0,closes=0;
  const context=createContext({ui:{db:{today:'2040-01-02'},busy:false},location:{hash:`#punch=${key}`},document:{visibilityState:'visible'},main,
    Date,icon:()=>'',esc:String,displayTime:()=> '09:00',toast(){},setTimeout:fn=>fn(),loadFeishuScript:async()=>{},window:{h5sdk:{ready:fn=>fn()},tt:{closeWindow(){closes++;}}},
    getPosition:async()=>{locations++;if(failLocation)throw new Error('请允许定位');if(leave)context.location.hash='#checkin';return {latitude:40,longitude:116,accuracy:5,coordinateSystem:'wgs84',timestamp:Date.now()};},
    api:async(path,body)=>{requests.push({path,body});if(path==='/api/checkin')return {record};return {date:'2040-01-02',locationName:'测试园区',input:{kind:'in'},record:completed||requests.length>1?record:null,cardUpdated:requests.length>1&&cardUpdated};},
  });
  runInContext(source.slice(source.indexOf('async function quickPunch()'),source.indexOf('async function preview(')),context);
  return {context,main,requests,locations:()=>locations,closes:()=>closes};
}

test('One card tap locates and submits once, waits for the original card, then returns to chat',async()=>{
  const app=client();await app.context.quickPunch();assert.equal(app.locations(),1);assert.equal(app.requests.filter(r=>r.path==='/api/checkin').length,1);assert.equal(app.closes(),1);assert.match(app.main.innerHTML,/打卡成功/);
  const repeated=client({completed:true});await repeated.context.quickPunch();assert.equal(repeated.locations(),0);assert.equal(repeated.requests.filter(r=>r.path==='/api/checkin').length,0);
});

test('Denied location or leaving the locating screen cannot punch; card delay never repeats a saved punch',async()=>{
  for (const options of [{failLocation:true},{leave:true}]) {const app=client(options);await app.context.quickPunch();assert.equal(app.requests.filter(r=>r.path==='/api/checkin').length,0);assert.equal(app.closes(),0);}
  const app=client({cardUpdated:false});await app.context.quickPunch();assert.equal(app.requests.filter(r=>r.path==='/api/checkin').length,1);assert.match(app.main.innerHTML,/记录已保存/);assert.equal(app.closes(),0);
});
