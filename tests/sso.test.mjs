import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';
import {createContext,runInContext} from 'node:vm';
import {createAttendanceServer} from '../server.mjs';

test('Native SSO requires same-origin nonce and exchanges a one-use code without an OAuth redirect', async t=>{
  const dir=await mkdtemp(join(tmpdir(),'daka-sso-')),file=join(dir,'state.json');
  await writeFile(file,JSON.stringify({version:1,employees:[{id:'e',name:'本人',openId:'ou_user',employeeNo:'T1',groupId:'default-group'}],locations:[],schedules:[],records:[],shiftTemplates:[]}));
  const env={PORT:'0',FEISHU_APP_ID:'cli_sso',FEISHU_APP_SECRET:'secret-test',BASE_URL:'https://attendance.example.com',ADMIN_OPEN_IDS:'ou_admin',FEISHU_TENANT_KEY:'tenant-test'};
  const {server}=createAttendanceServer({env,dataFile:file});
  server.address=()=>({port:4173});
  t.after(async()=>{server.removeAllListeners();await rm(dir,{recursive:true,force:true});});
  let user='ou_user',tenant='tenant-test',exchanges=0;
  t.mock.method(globalThis,'fetch',async(url,options)=>{
    if (url.endsWith('/oauth/token')) {exchanges++;const body=JSON.parse(options.body);assert.equal(body.code,'native-code');assert.equal(body.client_id,'cli_sso');assert.equal('redirect_uri' in body,false);return Response.json({code:0,access_token:'test-access'});}
    assert.ok(url.endsWith('/user_info'));return Response.json({code:0,data:{open_id:user,name:'测试',tenant_key:tenant}});
  });
  const request=(path,{method='GET',body,cookie='',origin=env.BASE_URL}={})=>new Promise(resolve=>{
    const req=Readable.from(body===undefined?[]:[Buffer.from(JSON.stringify(body))]);
    Object.assign(req,{url:path,method,headers:{host:'attendance.example.com',origin,cookie,'content-type':'application/json'}});
    const headers=new Headers();
    const res={status:200,headersSent:false,setHeader(k,v){headers.set(k,v);},writeHead(status,values){this.status=status;this.headersSent=true;Object.entries(values||{}).forEach(([k,v])=>headers.set(k,v));},end(value){resolve(new Response(value,{status:this.status,headers}));}};
    server.emit('request',req,res);
  });
  async function bootstrap(){const response=await request('/api/auth/bootstrap');const data=await response.json();assert.equal(data.appId,'cli_sso');assert.equal(JSON.stringify(data).includes('secret-test'),false);return {body:{nonce:data.nonce,code:'native-code'},cookie:response.headers.get('set-cookie').split(';')[0],method:'POST'};}
  const login=await bootstrap();
  assert.equal((await request('/auth/feishu',{...login,cookie:''})).status,403);
  assert.equal((await request('/auth/feishu',{...login,origin:'https://evil.example'})).status,403);
  assert.equal(exchanges,0);
  const authorized=await request('/auth/feishu',login);assert.equal(authorized.status,200);
  const sessionCookie=authorized.headers.get('set-cookie');assert.match(sessionCookie,/attendance_session=.+;.*HttpOnly;.*Secure/);
  assert.equal((await request('/auth/feishu',login)).status,403);
  assert.equal(exchanges,1);
  const state=await(await request('/api/state',{cookie:sessionCookie.split(';')[0]})).json();assert.equal(state.session.employeeId,'e');
  assert.equal(JSON.stringify(state).includes('test-access'),false);
  user='ou_outsider';assert.equal((await request('/auth/feishu',await bootstrap())).status,403);
  user='ou_user';tenant='other';assert.equal((await request('/auth/feishu',await bootstrap())).status,403);
});

test('Feishu opens with requestAccess automatically, preserves card destination, and keeps manual fallback',async()=>{
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\ninit\(\);\s*$/,'');
  let loggedIn=false,reloaded=false,authCalls=0,locationCalls=0;
  const nodes=new Map();
  const context=createContext({
    document:{querySelector(selector){if(!nodes.has(selector))nodes.set(selector,{innerHTML:'',addEventListener(){}});return nodes.get(selector);},addEventListener(){}},
    navigator:{userAgent:'iPhone Feishu'},location:{hash:'#checkin',search:'?recordDate=2026-11-22',reload(){reloaded=true;}},
    window:{addEventListener(){},h5sdk:{ready(fn){fn();}},tt:{requestAccess(options){authCalls++;assert.equal(options.appID,'cli_sso');assert.equal(options.scopeList.length,0);options.success({code:'native-code'});},getLocation(){locationCalls++;}}},
    URLSearchParams,setTimeout,clearTimeout,Intl,URL,Set,
    fetch:async(path,options)=>{
      if(path==='/api/state') return Response.json({error:'请登录'},{status:401});
      if(path==='/api/auth/bootstrap')return Response.json({appId:'cli_sso',nonce:'nonce'});
      assert.equal(path,'/auth/feishu');assert.deepEqual(JSON.parse(options.body),{nonce:'nonce',code:'native-code'});loggedIn=true;return Response.json({ok:true});
    },
  });
  runInContext(source,context);await context.init();
  assert.ok(loggedIn && reloaded);assert.equal(authCalls,1);assert.equal(locationCalls,0,'SSO itself must not request location');assert.equal(context.location.hash,'#checkin');
  context.location.search='?signedOut=1';runInContext('triedNativeLogin=false',context);await context.init();
  assert.equal(authCalls,1);assert.match(nodes.get('#main').innerHTML,/使用飞书身份登录/);
  context.location.search='';context.navigator.userAgent='Safari';runInContext('triedNativeLogin=false',context);await context.init();assert.equal(authCalls,1);
});

test('Native SSO only falls back for unsupported clients and exposes numeric diagnostic codes',async()=>{
  const source=(await readFile(new URL('../public/app.js',import.meta.url),'utf8')).replace(/\ninit\(\);\s*$/,'');
  for (const mode of ['missing','unsupported','denied','configuration']) {
    let legacyCalls=0,exchanges=0,html='';
    const context=createContext({
      document:{querySelector(){return {set innerHTML(value){html=value;},addEventListener(){}};},addEventListener(){}},
      navigator:{userAgent:'iPhone Feishu'},location:{hash:'#checkin',search:'',reload(){}},
      window:{addEventListener(){},h5sdk:{ready(fn){fn();}},tt:{
        ...(mode==='missing'?{}:{requestAccess({fail}){fail(mode==='unsupported'?{errno:103}:mode==='denied'?{errno:102}:{errno:2700002,errString:'Authorization terminated unexpectedly. Error code: 20029; private diagnostic'});}}),
        requestAuthCode({appId,success}){legacyCalls++;assert.equal(appId,'cli_sso');success({code:'legacy-code'});},
      }},
      URLSearchParams,setTimeout,clearTimeout,Intl,URL,Set,
      fetch:async(path,options)=>{
        if(path==='/api/state')return Response.json({error:'请登录'},{status:401});
        if(path==='/api/auth/bootstrap')return Response.json({appId:'cli_sso',nonce:'nonce'});
        assert.equal(path,'/auth/feishu');assert.equal(JSON.parse(options.body).code,'legacy-code');exchanges++;return Response.json({ok:true});
      },
    });
    runInContext(source,context);await context.init();
    assert.equal(legacyCalls,['missing','unsupported'].includes(mode)?1:0);
    assert.equal(exchanges,legacyCalls);
    if(mode==='configuration') {assert.match(html,/2700002 \/ 20029/);assert.doesNotMatch(html,/private diagnostic/);}
  }
});
