# 原生审批、日历与考勤台账

本应用按[飞书官方人员与考勤管理示例](https://open.feishu.cn/document/quick-start-of-personnel-and-attendance-management-system/overview)接入服务端 API。审批仍由飞书原生流程负责；自定义考勤监听结果、发送交互卡片并同步日历和台账。

## 使用流程

1. 员工从“请假与加班”打开原生审批表，填写起止时间和事由。
2. 原生流程交给教师组审批，使用飞书审批自带的通知与处理入口。组织管理员维护审批人；若使用指定成员，教师组变动后也要更新流程。
3. 请假通过后，员工收到“加入我的日历”卡片，点击后再次核对原生状态并创建私人日程。
4. 加班通过后，员工在获批时段到现场，通过飞书定位核验已配置地点的围栏和精度，再加入本人日历。每个加班时段独立核验。
5. 普通打卡只进入考勤记录和台账。审批取消、撤销或时间变化时，撤回对应旧日程；加班时间变化要求重新核验。

日程建在应用机器人的主日历中，设置为私人，仅邀请申请人。原生审批表的事由和附件不复制到考勤数据库、消息或台账。该流程不计算请假余额、薪资，也不自动修改已有精细排班；查看原审批单仍由飞书权限控制。

## 配置资源

先在飞书审批管理后台准备“请假”和“加班”两种原生定义，配置教师组和审批人缺失时的兜底规则。分别取得 `approval_code` 和网页链接中的定义 ID。两者用途不同：Code 用于服务端读取和订阅，ID 用于打开原生申请表。

台账使用一个私有多维表格，建立下列 **文本类型** 字段，字段名须完全一致：

`业务编号`、`类型`、`员工`、`部门`、`开始`、`结束`、`地点`、`状态`、`日历`

只向本应用和授权组织管理员开放该表。普通用户和考勤组管理员通过应用中的角色过滤查看和导出，不能把完整台账分享给所有成员。时间以带时区的 ISO 字符串写入，避免表格时区改变业务时间。

```dotenv
FEISHU_WORKFLOWS_ENABLED=true
FEISHU_LEAVE_APPROVAL_CODE=REPLACE_LEAVE_CODE
FEISHU_LEAVE_APPROVAL_ID=REPLACE_NUMERIC_ID
FEISHU_OVERTIME_APPROVAL_CODE=REPLACE_OVERTIME_CODE
FEISHU_OVERTIME_APPROVAL_ID=REPLACE_NUMERIC_ID
FEISHU_BITABLE_APP_TOKEN=REPLACE_BASE_TOKEN
FEISHU_BITABLE_TABLE_ID=REPLACE_TABLE_ID
```

未完成授权和资源配置时保持 `FEISHU_WORKFLOWS_ENABLED=false`。启用时配置不完整会阻止启动，避免显示已接通却丢失记录。

## 接口与事件

服务端使用锁定版本的 `@larksuiteoapi/node-sdk`。安装和部署都需要 `npm ci --omit=dev --ignore-scripts`，并包含 `package-lock.json`、`workflows.mjs` 和 `feishu-workflows.mjs`。

| 能力 | 使用的官方接口 |
| --- | --- |
| 读取审批并订阅 | `approval.instance.get`、`approval.approval.subscribe` |
| 私人日程 | `calendar.calendar.primary`、`calendar.calendarEvent.create/delete`、`calendar.calendarEventAttendee.create` |
| 考勤台账 | `bitable.appTableRecord.search/create/update` |
| 组织变动 | `contact.user.get`，沿用组织目录只读权限 |
| 本人消息 | 现有 `im:message:send_as_bot` 发送 Card JSON 2.0 |

在“事件与回调”启用官方长连接模式，订阅：

- `approval_instance`：审批实例状态变化。
- `contact.user.created_v3`、`contact.user.updated_v3`、`contact.user.deleted_v3`：成员基本信息变化和离职停用。

在“回调配置”同样选择长连接，订阅 `card.action.trigger`，处理本人点击“加入我的日历”。事件和回调的接收方式需分别保存。

代码通过官方长连接接收可信事件，不增加公网 HTTP 回调。审批事件到达时先持久化再返回，后台读取当前原生审批状态；迟到的“通过”通知不能覆盖当前拒绝或撤回状态。程序还会对配置的两种审批 Code 调用订阅接口，只有平台勾选事件并不够。

平台权限与表格自身访问权限都必须开通。审批使用 `approval:approval:readonly`（访问审批应用，供实例与事件使用）和 `approval:definition`（订阅定义）。后者包含原生定义管理能力，不能把整组权限称作纯只读；应用代码仅订阅定义和读取实例，审批决策始终交给原生流程的教师审批人。

日历使用 `calendar:calendar:read` 和 `calendar:calendar.event:create/update/delete`；台账使用 `base:record:retrieve/create/update`，并单独将本应用授权为该私有台账的协作者。现有通讯录权限保持只读，不申请 `contact:contact`，程序不提供成员或部门写入接口。

## 重试与数据范围

- 事件、消息、日程和台账均按业务编号去重。成功创建日程后先保存日程 ID，再邀请员工，邀请失败不会再建一个日程。
- 已删除日程和已完成审批订阅按官方错误码作为成功处理；权限不足和网络失败保留重试。
- 离职事件立即停用本应用内身份，后续请求重新检查身份。不会自动导入全部组织成员。
- 台账按固定业务编号搜索后更新或创建。审批事由、原始 GPS 不写入台账；打卡原始位置仍按既有规则保存在自己的考勤服务器。
- 自动测试使用合成数据和模拟接口。真实审批通过/拒绝/撤回、卡片按钮、私人日程、台账权限及 iPhone 现场核验需要部署后验证。

服务仍为单进程 JSON 存储。长期断开事件连接可能错过新的审批实例，应核对原生审批记录；上线验收需检查后台连接、待处理数量及最后事件时间。

官方依据：[订阅审批](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/approval-v4/approval/subscribe)、[审批实例详情](https://open.feishu.cn/document/server-docs/approval-v4/instance/get)、[创建日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/create)、[删除日程](https://open.feishu.cn/document/server-docs/calendar-v4/calendar-event/delete)、[官方 Node SDK](https://github.com/larksuite/node-sdk)。
