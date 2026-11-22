import * as lark from '@larksuiteoapi/node-sdk';
import { createHash } from 'node:crypto';
import { DomainError } from './domain.mjs';
import { sendReminderMessage } from './feishu.mjs';

// SDK errors may include credentials or approval forms; only log a fixed operational message.
const logger = {error:()=>console.error('飞书连接请求失败'),warn:()=>{},info:()=>{},debug:()=>{},trace:()=>{}};
export function feishuClient(config) {
  lark.defaultHttpInstance.defaults.timeout=10000;
  return new lark.Client({appId:config.appId,appSecret:config.appSecret,appType:lark.AppType.SelfBuild,domain:lark.Domain.Feishu,logger});
}
export async function feishuResult(promise, alreadyDoneCode) {
  let result;
  try {result=await promise;} catch (error) {
    if (Number.isInteger(alreadyDoneCode) && error?.response?.data?.code===alreadyDoneCode) return {};
    throw new DomainError('飞书请求未完成，请检查连接后重试',502);
  }
  if (Number.isInteger(alreadyDoneCode) && result?.code===alreadyDoneCode) return {};
  if (result?.code!==0) throw new DomainError(`飞书操作失败${Number.isInteger(result?.code) ? `（${result.code}）` : ''}，请检查权限和配置`,502);
  return result.data || {};
}
export function createFeishuWorkflowApi(config, client=feishuClient(config)) {
  const w=config.workflows;
  const tablePath={app_token:w.appToken,table_id:w.tableId};
  return {
    instance:id=>feishuResult(client.approval.instance.get({path:{instance_id:id},params:{user_id_type:'open_id',locale:'zh-CN',nested_mutable_group:true}})),
    subscribe:code=>feishuResult(client.approval.approval.subscribe({path:{approval_code:code}}),1390007),
    send:options=>sendReminderMessage({...config,...options}),
    async contact(id) {
      const data=await feishuResult(client.contact.user.get({path:{user_id:id},params:{user_id_type:'open_id',department_id_type:'open_department_id'}}));
      if (!data.user?.name) throw new DomainError('成员基本信息不完整',502);
      return data.user;
    },
    async createCalendar({summary,range,locationName,key}) {
      const primary=await feishuResult(client.calendar.calendar.primary({params:{user_id_type:'open_id'}}));
      const calendarId=primary.calendars?.[0]?.calendar?.calendar_id;
      if (!calendarId) throw new DomainError('应用主日历尚未就绪',502);
      const data=await feishuResult(client.calendar.calendarEvent.create({path:{calendar_id:calendarId},params:{user_id_type:'open_id',idempotency_key:key},data:{
        summary,description:'来自灵活考勤的已通过审批',start_time:{timestamp:String(Date.parse(range.start)/1000),timezone:'Asia/Shanghai'},end_time:{timestamp:String(Date.parse(range.end)/1000),timezone:'Asia/Shanghai'},
        visibility:'private',attendee_ability:'none',free_busy_status:'busy',need_notification:false,vchat:{vc_type:'no_meeting'},...(locationName?{location:{name:locationName}}:{})}}));
      if (!data.event?.event_id) throw new DomainError('飞书未返回日程编号',502);
      return {calendarId,eventId:data.event.event_id};
    },
    inviteCalendar:({calendarId,eventId},openId)=>feishuResult(client.calendar.calendarEventAttendee.create({path:{calendar_id:calendarId,event_id:eventId},params:{user_id_type:'open_id'},data:{attendees:[{type:'user',user_id:openId}],need_notification:true}})),
    deleteCalendar:({calendarId,eventId})=>feishuResult(client.calendar.calendarEvent.delete({path:{calendar_id:calendarId,event_id:eventId},params:{need_notification:'true'}}),193003),
    async archive({fields,recordId,key}) {
      if (!recordId) {
        const found=await feishuResult(client.bitable.appTableRecord.search({path:tablePath,params:{page_size:2},data:{field_names:['业务编号'],filter:{conjunction:'and',conditions:[{field_name:'业务编号',operator:'is',value:[fields['业务编号']]}]}}}));
        if ((found.items?.length || 0)>1) throw new DomainError('台账存在重复业务编号，请管理员核对',409);
        recordId=found.items?.[0]?.record_id;
      }
      // Bitable requires a UUID v4 shaped token; keep it stable across retries and restarts.
      const digest=createHash('sha256').update(key).digest('hex');
      const clientToken=`${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`;
      const data=await feishuResult(recordId
        ? client.bitable.appTableRecord.update({path:{...tablePath,record_id:recordId},data:{fields}})
        : client.bitable.appTableRecord.create({path:tablePath,params:{client_token:clientToken},data:{fields}}));
      const id=data.record?.record_id;
      if (!id) throw new DomainError('多维表格未返回记录编号',502);
      return id;
    },
  };
}

export function startFeishuEvents(config, workflows) {
  const ws=new lark.WSClient({appId:config.appId,appSecret:config.appSecret,domain:lark.Domain.Feishu,logger});
  const eventDispatcher=new lark.EventDispatcher({logger}).register({
    approval_instance:data=>workflows.acceptApproval(data),
    'card.action.trigger':data=>workflows.cardAction(data),
    'contact.user.created_v3':data=>workflows.acceptContact('created',data),
    'contact.user.updated_v3':data=>workflows.acceptContact('updated',data),
    'contact.user.deleted_v3':data=>workflows.acceptContact('deleted',data),
  });
  ws.start({eventDispatcher}).catch(()=>console.error('飞书事件连接未建立，请核对长连接配置'));
  return ws;
}
