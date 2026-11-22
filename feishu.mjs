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
  if (redirectUri !== undefined) required(redirectUri, '登录回调地址');
  required(code, '飞书登录授权码');
  const token = await request(fetch, `${openApi}/authen/v2/oauth/token`, json({
    grant_type: 'authorization_code', client_id: appId, client_secret: appSecret,
    code, ...(redirectUri ? {redirect_uri: redirectUri} : {}),
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

async function tenantToken({ appId, appSecret, fetch = globalThis.fetch }) {
  checkCredentials(appId, appSecret);
  const key = `tenant:${appId}:${createHash('sha256').update(appSecret).digest('hex')}`;
  let token = credentialsCache.get(key);
  if (!token || token.expiresAt <= Date.now()) {
    const obtainedAt = Date.now();
    const data = await request(fetch, `${openApi}/auth/v3/tenant_access_token/internal`, json({ app_id: appId, app_secret: appSecret }), '获取飞书应用凭证');
    token = cachedCredential(data.tenant_access_token, data.expire, obtainedAt);
    credentialsCache.set(key, token);
  }
  return token.value;
}

async function directoryClient(options) {
  const token = await tenantToken(options);
  const fetch = options.fetch || globalThis.fetch;
  return async (path, params = []) => {
    const query = new URLSearchParams([['user_id_type', 'open_id'], ['department_id_type', 'open_department_id'], ...params]);
    const data = await request(fetch, `${openApi}/contact/v3/${path}?${query}`, { headers: { Authorization: `Bearer ${token}` } }, '读取组织通讯录');
    if (!data.data || typeof data.data !== 'object') throw new Error('组织通讯录响应不完整');
    return data.data;
  };
}

function directoryUser(user, departments = new Map()) {
  if (typeof user?.open_id !== 'string' || !/^ou_[a-zA-Z0-9]+$/.test(user.open_id) || typeof user.name !== 'string' || !user.name.trim()) throw new Error('人员姓名或身份不完整，请开通“获取用户基本信息”权限');
  return { openId: user.open_id, name: user.name, departmentIds: user.department_ids || [],
    department: (user.department_ids || []).map(id => departments.get(id)).filter(Boolean).join(' / ') };
}

export async function getDirectoryUsers(options) {
  const { openIds } = options;
  if (!Array.isArray(openIds) || !openIds.length || openIds.length > 50 || openIds.some(id => typeof id !== 'string' || !/^ou_[a-zA-Z0-9]+$/.test(id))) throw new Error('无效的组织人员选择');
  const get = await directoryClient(options);
  const data = await get('users/batch', openIds.map(id => ['user_ids', id]));
  if (!Array.isArray(data.items)) throw new Error('组织人员响应不完整');
  const users = data.items.filter(u => !u.status?.is_resigned && !u.status?.is_exited && !u.status?.is_frozen).map(u => directoryUser(u));
  if (users.some(u => !openIds.includes(u.openId)) || new Set(users.map(u => u.openId)).size !== users.length) throw new Error('组织人员响应不匹配');
  return users;
}

export async function getDirectory(options) {
  const get = await directoryClient(options);
  const departments = new Map(), users = new Map(), directIds = new Set(), pendingDepartments = new Set();
  const pages = async (path, params, visit) => {
    let token = '';
    const seen = new Set();
    do {
      const data = await get(path, [...params, ['page_size', '50'], ...(token ? [['page_token', token]] : [])]);
      visit(data);
      if (!data.has_more) break;
      if (typeof data.page_token !== 'string' || !data.page_token || seen.has(data.page_token) || seen.size >= 200) throw new Error('组织分页异常，请缩小通讯录授权范围后重试');
      token = data.page_token; seen.add(token);
    } while (token);
  };
  let groupScopes = false;
  await pages('scopes', [], data => {
    for (const id of data.user_ids || []) directIds.add(id);
    for (const id of data.department_ids || []) pendingDepartments.add(id);
    groupScopes ||= Boolean(data.group_ids?.length);
  });
  for (const id of pendingDepartments) {
    if (departments.has(id)) continue;
    if (departments.size >= 1000) throw new Error('组织部门数量过多，请缩小通讯录授权范围');
    const data = await get(`departments/${encodeURIComponent(id)}`);
    if (!data.department?.name) throw new Error('部门名称缺失，请开通“获取部门基础信息”权限');
    departments.set(id, data.department.name);
    await pages(`departments/${encodeURIComponent(id)}/children`, [['fetch_child', 'false']], page => {
      for (const department of page.items || []) pendingDepartments.add(department.open_department_id);
    });
    await pages('users/find_by_department', [['department_id', id]], page => {
      for (const user of page.items || []) {
        if (user.status?.is_resigned || user.status?.is_exited || user.status?.is_frozen) continue;
        const normalized = directoryUser(user);
        const existing = users.get(normalized.openId);
        users.set(normalized.openId, { ...normalized, departmentIds: [...new Set([...(existing?.departmentIds || []), ...normalized.departmentIds, id])] });
      }
    });
  }
  const ids = [...directIds];
  for (let i = 0; i < ids.length; i += 50) {
    for (const user of await getDirectoryUsers({ ...options, openIds: ids.slice(i, i + 50) })) if (!users.has(user.openId)) users.set(user.openId, user);
  }
  return { departments: [...departments].map(([id, name]) => ({ id, name })),
    users: [...users.values()].map(user => ({ ...user, department: user.departmentIds.map(id => departments.get(id)).filter(Boolean).join(' / ') })),
    notice: groupScopes ? '当前显示按部门和成员授权的人员；若缺少成员，请组织管理员将对应部门加入应用通讯录范围。' : '' };
}

export async function sendReminderMessage({ appId, appSecret, openId, card, uuid, isCurrent = () => true, fetch = globalThis.fetch }) {
  if (!/^ou_[a-zA-Z0-9]+$/.test(openId) || card?.schema !== '2.0' || !Array.isArray(card.body?.elements) || !card.body.elements.length || !/^[a-zA-Z0-9-]{1,50}$/.test(uuid)) throw new Error('提醒消息格式不正确');
  const content = JSON.stringify(card);
  if (Buffer.byteLength(content) > 30 * 1024) throw new Error('提醒卡片内容过长');
  const token = await tenantToken({ appId, appSecret, fetch });
  if (!isCurrent()) return null;
  const options = json({ receive_id: openId, msg_type: 'interactive', content, uuid });
  options.headers.Authorization = `Bearer ${token}`;
  const data = await request(fetch, `${openApi}/im/v1/messages?receive_id_type=open_id`, options, '发送飞书提醒');
  if (typeof data.data?.message_id !== 'string' || !data.data.message_id) throw new Error('飞书未返回提醒发送结果');
  return data.data.message_id;
}
