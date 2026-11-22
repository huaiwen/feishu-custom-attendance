import { createHash } from 'node:crypto';
import { DomainError, evaluateLocation } from './domain.mjs';
import { reminderCard } from './reminders.mjs';

const codePattern = /^[A-Za-z0-9_-]{1,100}$/;
export const workflowLabels = { leave: '请假', overtime: '加班' };
export const approvalStatuses = { PENDING:'审批中', APPROVED:'已通过', REJECTED:'已拒绝', CANCELED:'已撤回', DELETED:'已停用', REVERTED:'已撤销' };
const hash = value => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex').slice(0,40);
const active = (state, openId) => state.employees.find(e => e.openId === openId && !e.disabled);

export function workflowConfiguration(env) {
  const enabled = env.FEISHU_WORKFLOWS_ENABLED === 'true';
  if (env.FEISHU_WORKFLOWS_ENABLED && !['true','false'].includes(env.FEISHU_WORKFLOWS_ENABLED)) throw new Error('FEISHU_WORKFLOWS_ENABLED 必须为 true 或 false');
  const definitions = Object.fromEntries(Object.keys(workflowLabels).map(kind => {
    const prefix = `FEISHU_${kind.toUpperCase()}_APPROVAL_`;
    const code = env[`${prefix}CODE`]?.trim() || '', id = env[`${prefix}ID`]?.trim() || '';
    if (code && !codePattern.test(code) || id && !/^\d{1,30}$/.test(id)) throw new Error('审批配置格式不正确');
    if (enabled && (!code || !id)) throw new Error('开启审批联动前，请配置请假和加班的审批编号');
    return [kind,{code,id}];
  }));
  const appToken = env.FEISHU_BITABLE_APP_TOKEN?.trim() || '', tableId = env.FEISHU_BITABLE_TABLE_ID?.trim() || '';
  if (appToken && !/^[a-zA-Z0-9]{10,100}$/.test(appToken) || tableId && !/^tbl[a-zA-Z0-9]{5,100}$/.test(tableId)) throw new Error('多维表格配置格式不正确');
  if (enabled && (!appToken || !tableId)) throw new Error('开启审批联动前，请配置考勤多维表格');
  if (enabled && definitions.leave.code === definitions.overtime.code) throw new Error('请假和加班需要不同的审批定义');
  return {enabled,definitions,appToken,tableId};
}

export function initializeWorkflows(state) {
  state.workflows ??= {requests:[],jobs:[],archive:{},subscriptions:[]};
  const w = state.workflows;
  if (!Array.isArray(w.requests) || !Array.isArray(w.jobs) || !Array.isArray(w.subscriptions) || !w.archive || typeof w.archive !== 'object' || Array.isArray(w.archive)) throw new Error('审批联动数据结构不正确');
  return w;
}

export function approvalLink(id, {form = false, desktop = false} = {}) {
  if (!codePattern.test(id)) throw new DomainError('审批编号不正确');
  const path = form ? `${desktop ? 'pc/pages/create-form' : 'pages/approval-form'}/index?id=${id}` : `${desktop ? 'pc/pages/in-process' : 'pages/detail'}/index?instanceId=${id}`;
  return `https://applink.feishu.cn/client/mini_program/open?${new URLSearchParams({appId:'cli_9cb844403dbb9108',...(desktop ? {mode:'appCenter'} : {}),path})}`;
}

export function approvalRanges(form) {
  let fields;
  try {fields = JSON.parse(form);} catch {throw new DomainError('审批时间格式不正确，请联系组织管理员');}
  if (!Array.isArray(fields)) throw new DomainError('审批表单格式不正确');
  const ranges = [];
  const add = (start,end) => {
    const valid = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
    if (!valid(start) || !valid(end) || Date.parse(end) <= Date.parse(start)) throw new DomainError('审批中的起止时间不完整，请检查原审批单');
    ranges.push({start:new Date(start).toISOString(),end:new Date(end).toISOString()});
  };
  const walk = (items, depth = 0) => {
    if (!Array.isArray(items) || depth > 6 || items.length > 200) throw new DomainError('审批时间结构不支持，请联系组织管理员');
    const dates = items.filter(f => f?.type === 'date');
    const starts = dates.filter(f => ['widgetLeaveGroupStartTime','widgetWorkGroupStartTime'].includes(f.id) || f.name === '开始时间');
    const ends = dates.filter(f => ['widgetLeaveGroupEndTime','widgetWorkGroupEndTime'].includes(f.id) || f.name === '结束时间');
    if (starts.length || ends.length) {
      if (starts.length !== 1 || ends.length !== 1) throw new DomainError('审批中有多组未配对时间，请联系组织管理员');
      add(starts[0].value,ends[0].value);
    }
    for (const f of items) {
      if (Array.isArray(f)) {walk(f,depth+1);continue;}
      if (f?.type === 'dateInterval') add(f.value?.start,f.value?.end);
      else if (['leaveGroup','leaveGroupV2','workGroup','fieldList'].includes(f?.type)) {
        if (Array.isArray(f.value)) walk(f.value,depth+1);
        else if (f.value && typeof f.value === 'object') add(f.value.start,f.value.end);
      }
    }
  };
  walk(fields);
  if (!ranges.length || ranges.length > 30) throw new DomainError('没有识别到有效的审批时段，请联系组织管理员');
  ranges.sort((a,b) => Date.parse(a.start)-Date.parse(b.start));
  if (ranges.some((r,i) => i && Date.parse(r.start) < Date.parse(ranges[i-1].end))) throw new DomainError('审批时段重叠，请检查原审批单');
  return ranges;
}

function enqueue(w, job) {
  if (w.jobs.some(j => j.id === job.id)) return;
  if (w.jobs.filter(j => j.status !== 'done').length >= 5000) throw new DomainError('联动队列已满，请联系组织管理员',503);
  w.jobs.push({...job,status:'pending',attempts:0,nextAt:0});
  const done = w.jobs.filter(j => j.status === 'done');
  if (done.length > 1000) {const discard = new Set(done.slice(0,done.length-1000).map(j=>j.id));w.jobs = w.jobs.filter(j=>!discard.has(j.id));}
}

export function workflowView(state, session, config) {
  const w = initializeWorkflows(state), org = session.role === 'org_admin';
  const readable = r => org || r.employeeId === session.employeeId || session.managedGroupIds.includes(r.groupId);
  const requests = w.requests.filter(readable).map(r => ({id:r.id,kind:r.kind,employeeId:r.employeeId,employeeName:r.employeeName,groupId:r.groupId,status:r.status,ranges:r.ranges,error:r.error,
    verified:r.verifications?.map(v=>({rangeIndex:v.rangeIndex,locationName:v.locationName,at:v.at})) || [],
    calendarStatus:r.calendarWanted ? r.calendars?.length === r.ranges.length && r.calendars.every(c=>c.invited) ? 'synced' : 'pending' : 'none',
    archiveStatus:w.archive[`approval:${r.id}`]?.version === hash(approvalArchive(r)) ? 'synced' : 'pending',
    nativeUrl:approvalLink(r.id),nativeDesktopUrl:approvalLink(r.id,{desktop:true})})).reverse();
  return {enabled:config.workflows.enabled,requests,
    definitions:Object.fromEntries(Object.entries(config.workflows.definitions).map(([kind,d])=>[kind,d.id ? {url:approvalLink(d.id,{form:true}),desktopUrl:approvalLink(d.id,{form:true,desktop:true})} : null])),
    locations:state.locations.map(l=>({id:l.id,name:l.name})),
    ...(org ? {status:{lastEventAt:w.lastEventAt || null,error:w.error || null,pending:w.jobs.filter(j=>j.status !== 'done').length,archived:Object.keys(w.archive).length},tableUrl:config.workflows.appToken ? `https://feishu.cn/base/${config.workflows.appToken}?table=${config.workflows.tableId}` : null} : {})};
}

export function approvalArchive(r) {
  return {'业务编号':`approval:${r.id}`,'类型':workflowLabels[r.kind],'员工':r.employeeName,'部门':r.department || '',
    '开始':r.ranges.map(v=>v.start).join('\n'),'结束':r.ranges.map(v=>v.end).join('\n'),
    '地点':(r.verifications || []).map(v=>v.locationName).join('、'),'状态':approvalStatuses[r.status] || r.status,
    '日历':r.calendars?.some(c=>c.invited) ? '已同步' : r.calendarWanted ? '同步中' : '未同步'};
}

export function createWorkflows({getState,commit,config,api,now = Date.now}) {
  let running = false;
  const settings = config.workflows;
  const kindFor = code => Object.keys(workflowLabels).find(k=>settings.definitions[k].code === code);
  const requireEnabled = () => {if (!settings.enabled) throw new DomainError('审批、日历和多维表格正在接入，请稍后再试',503);};
  const ownRequest = (id,openId) => {
    const r = getState().workflows.requests.find(r=>r.id===id);
    if (!r || !active(getState(),openId) || r.openId !== openId) throw new DomainError('只能操作本人的审批申请',403);
    return r;
  };
  const storeInstance = async (id, expectedCode) => {
    const data = await api.instance(id);
    if (data.instance_code !== id || data.approval_code !== expectedCode) throw new DomainError('审批实例与定义不匹配',403);
    const kind = kindFor(data.approval_code), employee = /^ou_[a-zA-Z0-9]+$/.test(data.open_id || '') && active(getState(),data.open_id);
    if (!kind || !employee) return null;
    let ranges = [], error = '';
    try {ranges = approvalRanges(data.form);} catch (e) {error = e.message;}
    const status = data.reverted ? 'REVERTED' : data.status;
    if (!Object.hasOwn(approvalStatuses,status)) throw new DomainError('审批状态不支持');
    commit(state=>{
      const w=initializeWorkflows(state);
      let r=w.requests.find(r=>r.id===id);
      if (!r) {r={id,openId:data.open_id,kind,calendars:[],verifications:[]};w.requests.push(r);}
      // A changed approved interval needs a fresh on-site check, never an old location proof.
      if (hash(r.ranges) !== hash(ranges)) r.verifications=[];
      Object.assign(r,{employeeId:employee.id,employeeName:employee.name,department:employee.department,groupId:employee.groupId,status,ranges,error,updatedAt:now()});
      if (status !== 'APPROVED') {r.calendarWanted=false;r.verifications=[];}
      const version = hash([status,ranges,error]);
      if (r.notifiedVersion !== version) enqueue(w,{id:`notice:${id}:${version}`,type:'notice',requestId:id,version});
    });
    return getState().workflows.requests.find(r=>r.id===id);
  };
  const acceptApproval = data => {
    if (!settings.enabled || !kindFor(data.approval_code) || !codePattern.test(data.instance_code || '')) return;
    if (config.tenantKey && data.tenant_key !== config.tenantKey || data.app_id && data.app_id !== config.appId) return;
    const id = hash([data.event_id || data.uuid,data.instance_code,data.operate_time,data.status]);
    commit(state=>{
      const w=initializeWorkflows(state);w.lastEventAt=now();
      if (['DELETED','REVERTED'].includes(data.status)) {
        const r=w.requests.find(r=>r.id===data.instance_code && r.kind===kindFor(data.approval_code));
        if (r) {r.status=data.status;r.calendarWanted=false;r.verifications=[];}
      }
      enqueue(w,{id:`event:${id}`,type:'approval',instanceId:data.instance_code,code:data.approval_code});
    });
  };
  const acceptContact = (type,data) => {
    if (!settings.enabled || config.tenantKey && data.tenant_key !== config.tenantKey || data.app_id && data.app_id !== config.appId) return;
    const openId = data.object?.open_id;
    if (!/^ou_[a-zA-Z0-9]+$/.test(openId || '')) return;
    commit(state=>{
      const w=initializeWorkflows(state);w.lastEventAt=now();
      if (type === 'deleted') {const e=state.employees.find(e=>e.openId===openId);if(e) e.disabled=true;}
      enqueue(w,{id:`contact:${hash([type,data.event_id,openId])}`,type:'contact',change:type,openId});
    });
  };
  const requestCalendar = async (id,openId,input = {}) => {
    requireEnabled();const previous = ownRequest(id,openId);
    const r = await storeInstance(id,settings.definitions[previous.kind].code);
    ownRequest(id,openId);
    if (!r || r.status !== 'APPROVED') throw new DomainError('审批通过后才可以加入日历',409);
    if (r.error) throw new DomainError(r.error);
    let proof;
    if (r.kind === 'overtime') {
      const index = input.rangeIndex;
      if (!Number.isInteger(index) || !r.ranges[index]) throw new DomainError('请选择加班时段');
      const range = r.ranges[index], time = now();
      if (time < Date.parse(range.start) || time > Date.parse(range.end)) throw new DomainError('请在获批的加班时段内到现场核验');
      const location = getState().locations.find(l=>l.id===input.locationId);
      const position = evaluateLocation(location,input,new Date(time));
      proof = {rangeIndex:index,locationId:location.id,locationName:location.name,at:new Date(time).toISOString(),...position};
    }
    commit(state=>{
      const item=state.workflows.requests.find(v=>v.id===id);
      if (proof) item.verifications=[...item.verifications.filter(v=>v.rangeIndex!==proof.rangeIndex),proof];
      item.calendarWanted=true;
    });
    return {queued:true};
  };
  const cardAction = data => {
    const id=data.action?.value?.instanceId, openId=data.operator?.open_id;
    if (data.action?.value?.action !== 'sync_calendar' || !codePattern.test(id || '')) return {toast:{type:'error',content:'无效的日历操作'}};
    try {
      requireEnabled();const r=ownRequest(id,openId);
      if (r.kind !== 'leave' || r.status !== 'APPROVED') throw new DomainError('请打开申请页面确认当前状态');
      commit(state=>enqueue(state.workflows,{id:`calendar-action:${id}:${hash(data.event_id || data.token)}`,type:'calendar-action',requestId:id,openId}));
      return {toast:{type:'success',content:'正在核对审批并同步日历，可在我的申请查看结果'}};
    } catch (e) {return {toast:{type:'error',content:e instanceof DomainError ? e.message : '操作未完成，请重试'}};}
  };
  const sendNotice = async job => {
    const r=getState().workflows.requests.find(r=>r.id===job.requestId);
    if (!r || !active(getState(),r.openId) || r.notifiedVersion === job.version || hash([r.status,r.ranges,r.error]) !== job.version) return;
    const approved=r.status==='APPROVED' && !r.error;
    const card=reminderCard(`${workflowLabels[r.kind]}${approvalStatuses[r.status]}`,r.ranges.length ? r.ranges[0].start.slice(0,10) : '审批状态更新',
      approved ? r.kind==='leave' ? '审批已通过。点击下方按钮，将请假安排加入自己的飞书日历。' : '审批已通过。到达加班地点后，打开申请完成位置核验并加入日历。' : r.error || '请在飞书原生审批中查看详情。',
      approved ? r.kind==='leave' ? '加入我的日历' : '核验加班地点' : '查看申请',`${config.baseUrl}/?request=${encodeURIComponent(r.id)}#requests`);
    if (approved && r.kind==='leave') card.body.elements[1].behaviors=[{type:'callback',value:{action:'sync_calendar',instanceId:r.id}}];
    await api.send({openId:r.openId,card,uuid:hash(job.id)});
    commit(state=>{state.workflows.requests.find(v=>v.id===r.id).notifiedVersion=job.version;});
  };
  const syncCalendar = async r => {
    // Re-read native approval before each external write; delayed events cannot grant approval.
    if (!['DELETED','REVERTED'].includes(r.status)) r=await storeInstance(r.id,settings.definitions[r.kind].code);
    if (!r) return;
    if (r.status !== 'APPROVED' || r.error) {
      for (const event of r.calendars || []) await api.deleteCalendar(event);
      if (r.calendars.length) commit(state=>{state.workflows.requests.find(v=>v.id===r.id).calendars=[];});
      return;
    }
    for (const old of r.calendars.filter(event=>{
      const range=r.ranges[event.index];
      return !range || event.start!==range.start || event.end!==range.end || r.kind==='overtime' && !r.verifications.some(v=>v.rangeIndex===event.index);
    })) {
      await api.deleteCalendar(old);
      commit(state=>{const item=state.workflows.requests.find(v=>v.id===r.id);item.calendars=item.calendars.filter(v=>v.eventId!==old.eventId);});
    }
    r=getState().workflows.requests.find(v=>v.id===r.id);
    for (let index=0;index<r.ranges.length;index++) {
      const range=r.ranges[index], proof=r.verifications.find(v=>v.rangeIndex===index);
      if (r.kind==='overtime' && !proof) continue;
      let event=r.calendars.find(v=>v.index===index && v.start===range.start && v.end===range.end);
      if (!event) {
        const created=await api.createCalendar({summary:workflowLabels[r.kind],range,locationName:proof?.locationName,key:hash([r.id,index,range])});
        event={...created,index,...range,invited:false};
        commit(state=>state.workflows.requests.find(v=>v.id===r.id).calendars.push(event));
      }
      if (!active(getState(),r.openId)) return;
      if (!event.invited) {
        await api.inviteCalendar(event,r.openId);
        commit(state=>{state.workflows.requests.find(v=>v.id===r.id).calendars.find(v=>v.eventId===event.eventId).invited=true;});
      }
    }
  };
  const syncArchive = async (key,fields) => {
    const previous=getState().workflows.archive[key], version=hash(fields);
    if (previous?.version===version) return false;
    const recordId=await api.archive({fields,recordId:previous?.recordId,key:hash(key)});
    commit(state=>{state.workflows.archive[key]={recordId,version};});
    return true;
  };
  const run = async () => {
    if (running || !settings.enabled) return;
    running=true;
    try {
      for (const d of Object.values(settings.definitions)) if (!getState().workflows.subscriptions.includes(d.code)) {
        await api.subscribe(d.code);commit(state=>state.workflows.subscriptions.push(d.code));
      }
      for (const job of getState().workflows.jobs.filter(j=>j.status!=='done' && j.nextAt<=now()).slice(0,20)) {
        try {
          if (job.type==='approval') await storeInstance(job.instanceId,job.code);
          if (job.type==='notice') await sendNotice(job);
          if (job.type==='calendar-action') await requestCalendar(job.requestId,job.openId);
          if (job.type==='contact') {
            const user=job.change==='deleted' ? null : await api.contact(job.openId);
            commit(state=>{const e=state.employees.find(e=>e.openId===job.openId);if(e && user) {e.name=user.name;e.disabled=Boolean(user.status?.is_resigned || user.status?.is_exited || user.status?.is_frozen);}});
            if (job.change!=='updated') {
              const name=user?.name || getState().employees.find(e=>e.openId===job.openId)?.name || '一位组织成员';
              for (const openId of [...new Set([...config.adminOpenIds,...getState().employees.filter(e=>e.orgAdmin && !e.disabled).map(e=>e.openId)])].filter(Boolean)) {
                await api.send({openId,uuid:hash([job.id,openId]),card:reminderCard('组织成员变动',job.change==='deleted' ? '成员已离职' : '新成员已加入',`${name}的组织状态已更新，请核对考勤成员与排班。`,'查看成员',`${config.baseUrl}/#employees`)});
              }
            }
          }
          commit(state=>{const j=state.workflows.jobs.find(v=>v.id===job.id);j.status='done';delete j.error;});
        } catch (e) {
          commit(state=>{const j=state.workflows.jobs.find(v=>v.id===job.id);j.attempts++;j.nextAt=now()+Math.min(3600000,30000*2**Math.min(j.attempts,7));j.error=e instanceof DomainError ? e.message : '飞书联动失败，将自动重试';if (e instanceof DomainError && e.status<500) j.status='done';});
        }
      }
      let count=0;
      for (const r of getState().workflows.requests) {
        const signature=hash([r.status,r.ranges,r.verifications,r.calendars]);
        if ((r.calendarWanted || r.calendars.length) && r.calendarChecked!==signature && (!r.retryAt || r.retryAt<=now())) {
          try {
            await syncCalendar(r);
            commit(state=>{const item=state.workflows.requests.find(v=>v.id===r.id);item.calendarChecked=hash([item.status,item.ranges,item.verifications,item.calendars]);delete item.syncError;});
          } catch {commit(state=>{const item=state.workflows.requests.find(v=>v.id===r.id);item.syncError='日历同步未完成，将自动重试';item.retryAt=now()+60000;});}
        }
        const current=getState().workflows.requests.find(v=>v.id===r.id);
        if (count<25 && await syncArchive(`approval:${r.id}`,approvalArchive(current))) count++;
      }
      count=0;
      for (const r of getState().records) {
        if (getState().workflows.archive[`punch:${r.id}`]) continue;
        await syncArchive(`punch:${r.id}`,{'业务编号':`punch:${r.id}`,'类型':r.kind==='in'?'上班打卡':'下班打卡','员工':r.employeeName,'部门':getState().employees.find(e=>e.id===r.employeeId)?.department || '',
          '开始':r.timestamp,'结束':'','地点':r.locationName,'状态':{normal:'正常',late:'迟到',early:'早退'}[r.status] || r.status,'日历':'不写入日历'});
        if (++count>=25) break;
      }
      commit(state=>{delete state.workflows.error;});
    } catch {commit(state=>{state.workflows.error='联动暂未完成，请检查飞书权限、审批配置和多维表格访问权限；系统会自动重试。';});}
    finally {running=false;}
  };
  return {acceptApproval,acceptContact,cardAction,requestCalendar,run,view:session=>workflowView(getState(),session,config)};
}
