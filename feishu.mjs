import { createHash, randomBytes } from 'node:crypto';

const credentialsCache = new Map();
const openApi = 'https://open.feishu.cn/open-apis';

function required(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`缺少${label}`);
}

function checkCredentials(appId, appSecret) {
  required(appId, '飞书 App ID');
  required(appSecret, '飞书 App Secret');
}

async function request(fetch, url, options, label) {
  let response;
  let data;
  try {
    response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    data = await response.json();
  } catch {
    throw new Error(`${label}失败，请检查网络后重试`);
  }
  if (!response.ok || data?.code !== 0) {
    const code = Number.isInteger(data?.code) ? `（错误码 ${data.code}）` : '';
    throw new Error(`${label}失败${code}，请检查应用配置和权限`);
  }
  return data;
}

function json(body) {
  return { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(body) };
}

export async function exchangeCode({ appId, appSecret, redirectUri, code, fetch = globalThis.fetch }) {
  checkCredentials(appId, appSecret);
  required(redirectUri, '登录回调地址');
  required(code, '飞书登录授权码');
  const token = await request(fetch, `${openApi}/authen/v2/oauth/token`, json({
    grant_type: 'authorization_code', client_id: appId, client_secret: appSecret,
    code, redirect_uri: redirectUri,
  }), '飞书登录');
  if (typeof token.access_token !== 'string' || !token.access_token) throw new Error('飞书登录响应缺少访问凭证');
  const user = await request(fetch, `${openApi}/authen/v1/user_info`, {
    headers: { Authorization: `Bearer ${token.access_token}` },
  }, '读取飞书身份');
  if (typeof user.data?.open_id !== 'string' || !user.data.open_id ||
      typeof user.data?.name !== 'string' || !user.data.name ||
      typeof user.data?.tenant_key !== 'string' || !user.data.tenant_key) {
    throw new Error('飞书身份响应不完整，请重新登录');
  }
  return { openId: user.data.open_id, name: user.data.name, tenantKey: user.data.tenant_key };
}

function cachedCredential(value, lifetime, obtainedAt) {
  if (typeof value !== 'string' || !value || !Number.isFinite(lifetime) || lifetime <= 0) {
    throw new Error('飞书凭证响应不完整，请重试');
  }
  return { value, expiresAt: obtainedAt + (lifetime - Math.min(60, lifetime / 10)) * 1000 };
}

export async function getJsapiConfig({ appId, appSecret, url, fetch = globalThis.fetch }) {
  checkCredentials(appId, appSecret);
  required(url, '网页地址');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('网页地址格式不正确'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('网页地址格式不正确');
  // 签名路由必须先确认此地址属于应用自己的域名。
  const key = `${appId}:${createHash('sha256').update(appSecret).digest('hex')}`;
  if (!credentialsCache.has(key)) credentialsCache.set(key, {});
  const cache = credentialsCache.get(key);
  if (!cache.ticket || cache.ticket.expiresAt <= Date.now()) {
    if (!cache.pending) {
      cache.pending = (async () => {
        if (!cache.token || cache.token.expiresAt <= Date.now()) {
          const obtainedAt = Date.now();
          const data = await request(fetch, 'https://accounts.feishu.cn/oauth/v3/token', json({
            grant_type: 'client_credentials', client_id: appId, client_secret: appSecret,
          }), '获取飞书应用凭证');
          cache.token = cachedCredential(data.access_token, data.expires_in, obtainedAt);
        }
        const obtainedAt = Date.now();
        const data = await request(fetch, `${openApi}/jssdk/ticket/get`, {
          method: 'POST', headers: { Authorization: `Bearer ${cache.token.value}`, 'Content-Type': 'application/json; charset=utf-8' },
        }, '获取飞书定位凭证');
        cache.ticket = cachedCredential(data.data?.ticket, data.data?.expire_in, obtainedAt);
      })().finally(() => { cache.pending = null; });
    }
    await cache.pending;
  }
  const timestamp = Date.now();
  const nonceStr = randomBytes(16).toString('hex');
  const signature = createHash('sha1').update(`jsapi_ticket=${cache.ticket.value}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url.split('#')[0]}`).digest('hex');
  return { appId, timestamp, nonceStr, signature, jsApiList: ['getLocation', 'requestAccess'] };
}
