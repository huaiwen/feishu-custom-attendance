import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { exchangeCode, getJsapiConfig, sendReminderMessage, updateReminderCard } from '../feishu.mjs';

const response = data => ({ ok: true, json: async () => data });

test('OAuth exchanges the code server-side and returns only the verified identity', async () => {
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.redirect, 'error');
    return response(calls.length === 1
      ? { code: 0, access_token: 'private-token', expires_in: 7200 }
      : { code: 0, data: { open_id: 'ou_alice', name: '员工 A', tenant_key: 'tenant-a', email: 'private@example.com' } });
  };
  assert.deepEqual(await exchangeCode({ appId: 'cli_auth', appSecret: 'private-secret', redirectUri: 'https://example.com/auth/callback', code: 'one-use-code', fetch }),
    { openId: 'ou_alice', name: '员工 A', tenantKey: 'tenant-a' });
  assert.equal(calls[0].url, 'https://open.feishu.cn/open-apis/authen/v2/oauth/token');
  assert.deepEqual(JSON.parse(calls[0].options.body), {
    grant_type: 'authorization_code', client_id: 'cli_auth', client_secret: 'private-secret', code: 'one-use-code', redirect_uri: 'https://example.com/auth/callback',
  });
  assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/authen/v1/user_info');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer private-token');
});

test('upstream failures do not expose raw error messages or credentials', async () => {
  const input = { appId: 'cli_error', appSecret: 'private-secret', redirectUri: 'https://example.com/auth/callback', code: 'one-use-code' };
  await assert.rejects(exchangeCode({ ...input, fetch: async () => response({ code: 20002, error_description: 'private-secret private-token' }) }), error => {
    assert.match(error.message, /20002/);
    assert.doesNotMatch(error.message, /private-/);
    return true;
  });
  await assert.rejects(exchangeCode({ ...input, fetch: async () => { throw new Error('private-token network timeout'); } }), /检查网络/);
  await assert.rejects(exchangeCode({ ...input, fetch: async () => response({ code: 0 }) }), /缺少访问凭证/);
  await assert.rejects(exchangeCode({ ...input, fetch: async url => response(url.endsWith('/user_info') ? { code: 0, data: { open_id: 'ou_missing_tenant' } } : { code: 0, access_token: 'token' }) }), /身份响应不完整/);
});

test('JSAPI uses documented token and ticket expiry, shares concurrent refresh, and signs the exact URL without fragment', async t => {
  let now = 1_800_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const calls = [];
  const fetch = async (url, options) => {
    calls.push({ url, options });
    return response(url.includes('/oauth/v3/token')
      ? { code: 0, access_token: 'tenant-token', expires_in: 200 }
      : { code: 0, data: { ticket: 'ticket-secret', expire_in: 100 } });
  };
  const input = { appId: 'cli_cache', appSecret: 'secret', url: 'https://example.com/?x=hello%20world#attendance', fetch };
  const [config, concurrent] = await Promise.all([getJsapiConfig(input), getJsapiConfig(input)]);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, 'https://accounts.feishu.cn/oauth/v3/token');
  assert.deepEqual(JSON.parse(calls[0].options.body), { grant_type: 'client_credentials', client_id: 'cli_cache', client_secret: 'secret' });
  assert.equal(calls[1].url, 'https://open.feishu.cn/open-apis/jssdk/ticket/get');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer tenant-token');
  assert.equal(config.timestamp, now);
  assert.notEqual(config.nonceStr, concurrent.nonceStr);
  assert.deepEqual(config.jsApiList, ['getLocation', 'requestAccess']);
  assert.equal(config.signature, createHash('sha1').update(`jsapi_ticket=ticket-secret&noncestr=${config.nonceStr}&timestamp=${now}&url=https://example.com/?x=hello%20world`).digest('hex'));
  assert.doesNotMatch(JSON.stringify(config), /ticket-secret|tenant-token/);
  now += 89_000;
  await getJsapiConfig(input);
  assert.equal(calls.length, 2);
  now += 2_000;
  await getJsapiConfig(input);
  assert.equal(calls.length, 3, 'expired ticket refreshes while token remains valid');
  now += 100_000;
  await getJsapiConfig(input);
  assert.equal(calls.length, 5, 'expired token and ticket both refresh');
});

test('failed ticket requests can retry and credential changes cannot reuse the old cache', async () => {
  let shouldFail = true;
  let calls = 0;
  const fetch = async url => {
    calls++;
    if (url.includes('/oauth/v3/token')) return response({ code: 0, access_token: 'token', expires_in: 7200 });
    return response(shouldFail ? { code: 99991663, msg: 'private-token' } : { code: 0, data: { ticket: 'ticket', expire_in: 7200 } });
  };
  const input = { appId: 'cli_retry', appSecret: 'secret', url: 'https://example.com/', fetch };
  await assert.rejects(getJsapiConfig(input), /99991663/);
  shouldFail = false;
  await getJsapiConfig(input);
  assert.equal(calls, 3);
  await getJsapiConfig({ ...input, appSecret: 'rotated-secret' });
  assert.equal(calls, 5);
  await assert.rejects(getJsapiConfig({ ...input, url: 'file:///etc/passwd' }), /网页地址格式/);
});

test('Organization directory paginates, traverses authorized departments, and strips private fields', async () => {
  const { getDirectory, getDirectoryUsers } = await import('../feishu.mjs');
  const calls = [];
  const fetch = async input => {
    const url = new URL(input);calls.push(url);
    if (url.pathname.endsWith('/tenant_access_token/internal')) return response({code:0,tenant_access_token:'private-token',expire:7200});
    let data;
    if (url.pathname.endsWith('/scopes')) data = url.searchParams.has('page_token') ? {user_ids:['ou_b'],has_more:false} : {department_ids:['od-team'],has_more:true,page_token:'scope-next'};
    else if (url.pathname.endsWith('/departments/od-team')) data = {department:{name:'研发部'}};
    else if (url.pathname.endsWith('/departments/od-child')) data = {department:{name:'平台组'}};
    else if (url.pathname.endsWith('/departments/od-team/children')) data = {items:[{open_department_id:'od-child'}],has_more:false};
    else if (url.pathname.endsWith('/departments/od-child/children')) data = {items:[],has_more:false};
    else if (url.pathname.endsWith('/users/find_by_department')) data = url.searchParams.get('department_id') === 'od-team' ? {items:[{open_id:'ou_a',name:'甲',email:'private-email',department_ids:['od-team']}],has_more:false} : {items:[{open_id:'ou_b',name:'乙',mobile:'private-phone',department_ids:['od-child']}],has_more:false};
    else if (url.pathname.endsWith('/users/batch')) data = {items:[{open_id:'ou_b',name:'乙',email:'private-email',department_ids:['od-child']}]};
    else assert.fail(url.pathname);
    return response({code:0,data});
  };
  const options = {appId:'cli_directory',appSecret:'secret',fetch};
  const result = await getDirectory(options);
  assert.deepEqual(result.departments.map(d => d.name),['研发部','平台组']);
  assert.deepEqual(result.users.map(u => [u.openId,u.name,u.department]),[['ou_a','甲','研发部'],['ou_b','乙','平台组']]);
  assert.doesNotMatch(JSON.stringify(result),/private-/);
  assert.equal(calls.filter(u => u.pathname.endsWith('/scopes')).length,2);
  assert.ok(calls.filter(u => u.pathname.includes('/contact/')).every(u => u.searchParams.get('user_id_type') === 'open_id'));
  await assert.rejects(getDirectoryUsers({...options,openIds:['not-an-open-id']}),/无效/);
});

test('Directory rejects repeated page tokens instead of returning an incomplete organization', async () => {
  const { getDirectory } = await import('../feishu.mjs');
  const fetch = async input => response(input.includes('/tenant_access_token/') ? {code:0,tenant_access_token:'token',expire:7200} : {code:0,data:{has_more:true,page_token:'same'}});
  await assert.rejects(getDirectory({appId:'cli_bad_pages',appSecret:'secret',fetch}),/分页异常/);
});

test('Reminder messages use this application identity, direct open_id recipients and stable deduplication UUIDs', async () => {
  const calls=[];
  const fetch=async(url,options)=>{calls.push({url,options});return response(url.includes('/tenant_access_token/')?{code:0,tenant_access_token:'private-bot-token',expire:7200}:{code:0,data:{message_id:'om_result'}});};
  const card={schema:'2.0',body:{elements:[{tag:'div',text:{tag:'plain_text',content:'打卡提醒'}}]}};
  const input={appId:'cli_reminder',appSecret:'secret',openId:'ou_a',card,uuid:'reminder-123',fetch};
  assert.equal(await sendReminderMessage(input),'om_result');
  assert.equal(calls[1].url,'https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id');
  assert.deepEqual(JSON.parse(calls[1].options.body),{receive_id:'ou_a',msg_type:'interactive',content:JSON.stringify(card),uuid:input.uuid});
  assert.equal(calls[1].options.headers.Authorization,'Bearer private-bot-token');
  assert.equal(await sendReminderMessage({...input,isCurrent:()=>false}),null);
  assert.equal(calls.length,2,'revocation is checked after credential acquisition, before sending');
  await assert.rejects(sendReminderMessage({...input,openId:'email@example.com'}),/格式/);
  await assert.rejects(sendReminderMessage({...input,card:{}}),/格式/);
  await assert.rejects(sendReminderMessage({...input,card:{...card,extra:'中'.repeat(11000)}}),/过长/);
});

test('Card updates use the sending app and PATCH only a validated stored message ID',async()=>{
  const calls=[],card={schema:'2.0',config:{update_multi:true},body:{elements:[{tag:'div',text:{tag:'plain_text',content:'打卡成功'}}]}};
  const input={appId:'cli_update',appSecret:'secret',messageId:'om_original',card,fetch:async(url,options)=>{calls.push({url,options});return response(url.includes('/tenant_access_token/')?{code:0,tenant_access_token:'private-token',expire:7200}:{code:0});}};
  await updateReminderCard(input);assert.equal(calls[1].options.method,'PATCH');assert.equal(calls[1].url,'https://open.feishu.cn/open-apis/im/v1/messages/om_original');
  assert.deepEqual(JSON.parse(calls[1].options.body),{content:JSON.stringify(card)});
  await assert.rejects(updateReminderCard({...input,messageId:'om_a/../../users'}),/格式/);
  await assert.rejects(updateReminderCard({...input,card:{...card,config:{}}}),/格式/);
});
