import { createHash } from 'node:crypto';
import { DomainError, clockParts } from './domain.mjs';
import { sessionFor } from './access.mjs';

const MINUTE = 60_000;
const WINDOW = 5 * MINUTE;
const defaults = { checkinEnabled: true, beforeMinutes: 15, reviewEnabled: true, afterMinutes: 60 };

export function reminderPreferences(state, openId, role) {
  const value = { ...defaults, ...state.reminders?.preferences[openId] };
  return role === 'user' ? { checkinEnabled: value.checkinEnabled, beforeMinutes: value.beforeMinutes } : value;
}

export function validateReminderPreferences(input, role) {
  const allowed = role === 'user' ? ['checkinEnabled', 'beforeMinutes'] : Object.keys(defaults);
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new DomainError('只能修改本人的提醒设置', 403);
  if (typeof input.checkinEnabled !== 'boolean' || ![15, 30].includes(input.beforeMinutes)) throw new DomainError('打卡提醒请选择提前 15 或 30 分钟');
  if (role !== 'user' && (typeof input.reviewEnabled !== 'boolean' || !Number.isInteger(input.afterMinutes) || input.afterMinutes < 1 || input.afterMinutes > 1440)) throw new DomainError('查看记录提醒请设置为打卡时点后 1 至 1440 分钟');
  return Object.fromEntries(allowed.map(key => [key, input[key]]));
}

export function initializeReminders(state) {
  state.reminders ??= { preferences: {}, deliveries: [] };
  const { preferences, deliveries } = state.reminders;
  if (!preferences || typeof preferences !== 'object' || Array.isArray(preferences) || !Array.isArray(deliveries)) throw new Error('提醒数据结构不正确');
  return state.reminders;
}

export function reminderHistory(state, openId) {
  return (state.reminders?.deliveries || []).filter(item => item.openId === openId).slice(-10).reverse()
    .map(({ type, attemptedAt, sentAt, status, error }) => ({ type, attemptedAt, sentAt, status, error }));
}

function cardLink(config, url) {
  return {type:'open_url',default_url:url,
    pc_url:`https://applink.feishu.cn/client/web_app/open?${new URLSearchParams({appId:config.appId,mode:'appCenter',reload:'true',lk_target_url:url})}`};
}

export function reminderCard(config, title, subtitle, details, button, url) {
  return { schema:'2.0', config:{width_mode:'compact',enable_forward:false,update_multi:true,summary:{content:`${title} · ${subtitle}`}},
    header:{title:{tag:'plain_text',content:title},subtitle:{tag:'plain_text',content:subtitle},template:'blue'},
    body:{direction:'vertical',padding:'12px',vertical_spacing:'12px',elements:[
      {tag:'div',text:{tag:'plain_text',content:details}},
      {tag:'button',text:{tag:'plain_text',content:button},type:'primary_filled',width:'fill',size:'large',behaviors:[cardLink(config,url)]},
    ]},
  };
}

export function dailyAttendance(state, employeeId, date, now) {
  const punches=state.schedules.filter(s=>s.employeeId===employeeId && s.date===date).flatMap(schedule=>schedule.segments.flatMap((segment,segmentIndex)=>
    ['in','out'].map(kind=>({scheduleId:schedule.id,segmentIndex,kind,time:kind==='in'?segment.start:segment.end,
      locationName:state.locations.find(l=>l.id===segment.locationId)?.name || '排班指定地点',
      done:state.records.some(r=>r.scheduleId===schedule.id && r.segmentIndex===segmentIndex && r.kind===kind),
      // Punch windows use whole minutes and end at local midnight, even for the last shift.
      expired:now>=Math.min(Date.parse(`${date}T${segment.end}:00+08:00`)+(kind==='out'?121:0)*MINUTE,Date.parse(`${date}T00:00:00+08:00`)+86400000),
    })))).sort((a,b)=>a.time.localeCompare(b.time));
  const remaining=punches.filter(p=>!p.done), completed=punches.length-remaining.length;
  return {date,punches,remaining,completed,total:punches.length};
}

function attendanceCard(state, config, {employeeId,date,target,record,now,test=false}) {
  const today=clockParts(new Date(now)).date, day=date===today?'今日':date;
  const {punches,remaining,completed}=dailyAttendance(state,employeeId,date,now);
  const current=target && punches.find(p=>p.scheduleId===target.scheduleId && p.segmentIndex===target.segmentIndex && p.kind===target.kind);
  const label=(record?.kind || target?.kind)==='in'?'上班':'下班';
  const status=record && ({normal:'正常',late:'迟到',early:'早退'}[record.status] || record.status);
  const progress=remaining.length?`${day}还剩 ${remaining.length} 次打卡`:punches.length?`${day}打卡已全部完成`:`${day}暂无排班`;
  const text=(content,size='normal',color='default')=>({tag:'div',text:{tag:'plain_text',content,text_size:size,text_color:color}});
  const time=record?new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(record.timestamp)):current?.time;
  const title=test?'灵活考勤 · 测试提醒':record?'打卡成功':`${label}打卡提醒`;
  const focus=record || current;
  const fields=[`打卡日期：${date}`];
  if (focus) fields.push(`打卡类型：${label}`,`${record?'打卡时间':'计划时间'}：${time}`,`打卡地点：${focus.locationName}`);
  if (record) fields.push(`打卡结果：${status}`);
  const details=[text(fields.join('\n')),
    text(`${progress}\n已完成 ${completed} / ${punches.length} 次${!record && current && !current.done?' · 剩余含本次':''}`)];
  if (remaining.length) details.push(text(remaining.map(p=>`${p.time} ${p.kind==='in'?'上班':'下班'} · ${p.locationName}${p.expired?'（已过可打时间）':p===current?'（本次）':''}`).join('\n')));
  if (!punches.length) details.push(text('安排班次后，这里会显示时间和地点。','notation','grey'));
  if (remaining.some(p=>p.expired)) details.push(text('过时未打的记录，请联系考勤管理员。','notation','grey'));
  const canPunch=current && !current.done && !current.expired && !record && !test;
  return {schema:'2.0',config:{width_mode:'compact',enable_forward:false,update_multi:true,summary:{content:`${title} · ${progress}`}},
    header:{title:{tag:'plain_text',content:title},template:record?'green':'blue',padding:'12px'},
    body:{direction:'vertical',padding:'12px',vertical_spacing:'12px',elements:[
      ...details,
      ...(canPunch?[text(target.kind==='out'?'点击即定位并提交，提前下班会记为早退。':'点击即通过飞书定位并提交打卡。','notation','grey')]:[]),
      {tag:'button',text:{tag:'plain_text',content:canPunch?'去打卡':record?'查看我的记录':'查看今日打卡'},type:'primary_filled',width:'fill',size:'large',behaviors:[cardLink(config,canPunch?`${config.baseUrl}/#punch=${target.key}`:record?`${config.baseUrl}/?recordDate=${date}#records`:`${config.baseUrl}/#checkin`)]},
    ]},
  };
}

function punchSignature(state, schedule, index) {
  const segment=schedule.segments[index];
  return createHash('sha256').update(JSON.stringify([schedule.employeeId,schedule.groupId,schedule.date,segment,state.locations.find(l=>l.id===segment?.locationId)])).digest('hex');
}

export function reminderPunch(state, openId, key) {
  const row=state.reminders?.deliveries.find(r=>r.key===key && r.openId===openId && r.type==='checkin' && r.status==='sent');
  const employee=state.employees.find(e=>e.openId===openId && !e.disabled);
  if (!row?.punch || !employee) throw new DomainError('这张打卡卡片不可用，请从飞书工作台打开考勤',404);
  const {scheduleId,segmentIndex,kind,signature}=row.punch;
  const schedule=state.schedules.find(s=>s.id===scheduleId && s.employeeId===employee.id);
  if (!schedule || !schedule.segments[segmentIndex] || !['in','out'].includes(kind)) throw new DomainError('排班已调整，请从飞书工作台查看最新安排',409);
  const record=state.records.find(r=>r.employeeId===employee.id && r.scheduleId===scheduleId && r.segmentIndex===segmentIndex && r.kind===kind);
  if (!record && signature!==punchSignature(state,schedule,segmentIndex)) throw new DomainError('排班或地点已调整，请从飞书工作台查看最新安排',409);
  const segment=schedule.segments[segmentIndex];
  return {input:{employeeId:employee.id,scheduleId,segmentIndex,kind},date:schedule.date,time:kind==='in'?segment.start:segment.end,
    locationName:state.locations.find(l=>l.id===segment.locationId)?.name || '排班地点',record:record || null,cardUpdated:Boolean(record && row.updatedRecordId===record.id)};
}

export function punchReminder(state, config, {key,openId,schedule,segmentIndex,kind,dueAt,now=dueAt ?? Date.now()}) {
  const punch={scheduleId:schedule.id,segmentIndex,kind,signature:punchSignature(state,schedule,segmentIndex)};
  return {key,openId,type:'checkin',dueAt,punch,
    card:attendanceCard(state,config,{employeeId:schedule.employeeId,date:schedule.date,target:{...punch,key},now})};
}

export function dueReminders(state, config, now) {
  const candidates = new Map();
  const add = (type, openId, subject, schedule, segment, kind, time, dueAt) => {
    if (now < dueAt || now >= dueAt + WINDOW) return;
    const key = createHash('sha256').update(JSON.stringify([type, openId, subject, schedule.date, kind, time])).digest('hex').slice(0, 40);
    const label = kind === 'in' ? '上班' : '下班';
    if (type==='checkin') {
      candidates.set(key,punchReminder(state,config,{key,openId,schedule,segmentIndex:schedule.segments.indexOf(segment),kind,dueAt,now}));return;
    }
    const card = reminderCard(config,'考勤记录待查看',`${schedule.date} · ${time} ${label}`,
        `考勤组：${state.groups.find(g => g.id === schedule.groupId)?.name || '考勤组'}\n请查看本次打卡记录与异常情况。`,'查看记录',`${config.baseUrl}/?recordDate=${schedule.date}&group=${encodeURIComponent(schedule.groupId)}#records`);
    candidates.set(key, { key, openId, type, dueAt, card });
  };
  const orgAdmins = [...new Set([...config.adminOpenIds, ...state.employees.filter(e => e.orgAdmin && !e.disabled).map(e => e.openId).filter(Boolean)])].filter(id=>sessionFor(state,id,config.adminOpenIds));
  for (const schedule of state.schedules) {
    const employee = state.employees.find(e => e.id === schedule.employeeId);
    if (!employee || employee.disabled) continue;
    const group = state.groups.find(g => g.id === schedule.groupId);
    if (!group) continue;
    const groupAdmins = state.employees.filter(e => group.adminIds.includes(e.id) && e.openId && !e.disabled).map(e => e.openId);
    const reviewers = [...new Set(groupAdmins.length ? groupAdmins : orgAdmins)];
    for (const [index, segment] of schedule.segments.entries()) {
      for (const [kind, time] of [['in', segment.start], ['out', segment.end]]) {
        const scheduledAt = Date.parse(`${schedule.date}T${time}:00+08:00`);
        if (employee.openId) {
          const pref = reminderPreferences(state, employee.openId, 'user');
          const punched = state.records.some(r => r.scheduleId === schedule.id && r.segmentIndex === index && r.kind === kind);
          if (pref.checkinEnabled && !punched) add('checkin', employee.openId, employee.id, schedule, segment, kind, time, scheduledAt - pref.beforeMinutes * MINUTE);
        }
        for (const openId of reviewers) {
          const pref = reminderPreferences(state, openId, sessionFor(state, openId, config.adminOpenIds).role);
          if (pref.reviewEnabled) add('review', openId, group.id, schedule, segment, kind, time, scheduledAt + pref.afterMinutes * MINUTE);
        }
      }
    }
  }
  return [...candidates.values()];
}

export function createReminderDispatcher({ getState, commit, config, send, update, now = Date.now }) {
  let running = false, updating=false;
  const cardVersion=card=>createHash('sha256').update(JSON.stringify(card)).digest('hex');
  const current = key => dueReminders(getState(), config, now()).some(item => item.key === key);
  const saveAttempt = item => commit(state => {
    const data = initializeReminders(state);
    data.deliveries = data.deliveries.filter(row => row.attemptedAt > now() - 30 * 86400000);
    const previous = data.deliveries.find(row => row.key === item.key);
    const row = { key: item.key, openId: item.openId, type: item.type, ...(item.punch?{punch:item.punch,cardVersion:cardVersion(item.card)}:{}), attemptedAt: now(), attempts: (previous?.attempts || 0) + 1, status: 'pending' };
    if (previous) Object.assign(previous, row); else data.deliveries.push(row);
  });
  const deliver = async (item, isCurrent) => {
    saveAttempt(item);
    let status, messageId, error;
    try {
      messageId = await send({ openId: item.openId, card: item.card, uuid: item.key, isCurrent });
      status = messageId ? 'sent' : 'cancelled';
    } catch (failure) {
      status = 'failed';
      const code = failure.message?.match(/错误码 (\d+)/)?.[1];
      error = code ? `飞书发送失败（错误码 ${code}），请联系组织管理员检查应用权限或可用范围` : '飞书发送暂未成功，请检查网络或联系组织管理员';
    }
    commit(state => {
      const row = state.reminders.deliveries.find(row => row.key === item.key);
      Object.assign(row, { status, error, ...(messageId ? { messageId, sentAt: now() } : {}) });
    });
    return { status, error };
  };
  const syncCompleted=async()=>{
    if (updating || !update || !config.remindersEnabled) return;
    updating=true;
    try {
      let count=0;
      for (const row of getState().reminders?.deliveries || []) {
        if (row.type!=='checkin' || row.status!=='sent' || !row.punch || !row.messageId || now()-row.sentAt>=14*86400000 || now()-(row.updateAttemptedAt || 0)<MINUTE) continue;
        let result;try {result=reminderPunch(getState(),row.openId,row.key);} catch {continue;}
        const card=attendanceCard(getState(),config,{employeeId:result.input.employeeId,date:result.date,target:{...row.punch,key:row.key},record:result.record,now:now()});
        const version=cardVersion(card);
        if (row.cardVersion===version) continue;
        commit(next=>{next.reminders.deliveries.find(r=>r.key===row.key).updateAttemptedAt=now();});
        try {
          await update({messageId:row.messageId,card});
          commit(next=>{const item=next.reminders.deliveries.find(r=>r.key===row.key);item.cardVersion=version;delete item.updateAttemptedAt;if(result.record)item.updatedRecordId=result.record.id;});
        } catch { /* The persisted punch is authoritative; retry only the card on the next tick. */ }
        if (++count>=10) break;
      }
    } finally {updating=false;}
  };
  return {
    syncCompleted,
    async run() {
      if (running || !config.remindersEnabled) return;
      running = true;
      try {
        for (const item of dueReminders(getState(), config, now())) {
          const previous = getState().reminders?.deliveries.find(row => row.key === item.key);
          if (previous && (['sent', 'cancelled'].includes(previous.status) || previous.attempts >= 3 || now() - previous.attemptedAt < MINUTE)) continue;
          if (current(item.key)) await deliver(item, () => current(item.key));
        }
        await syncCompleted();
      } finally { running = false; }
    },
    async test(openId) {
      if (!config.remindersEnabled) throw new DomainError('飞书提醒尚未启用，请联系组织管理员', 503);
      if (getState().reminders?.deliveries.some(row => row.type === 'test' && row.openId === openId && now() - row.attemptedAt < WINDOW)) throw new DomainError('测试提醒每 5 分钟可发送一次，请稍后重试', 429);
      return deliver({ key: createHash('sha256').update(`${openId}:${now()}`).digest('hex').slice(0, 40), openId, type: 'test',
        card: attendanceCard(getState(),config,{employeeId:getState().employees.find(e=>e.openId===openId && !e.disabled)?.id,date:clockParts(new Date(now())).date,now:now(),test:true}) },
      () => config.adminOpenIds.includes(openId) || getState().employees.some(e => e.openId === openId));
    },
  };
}
