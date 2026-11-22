# 自定义考勤：飞书 OpenAPI 能力核验与接入设计

核验日期：2026-11-21。本文依据飞书官方接口的请求/响应正文与官方帮助中心。当前采用独立自建考勤路线：飞书提供工作台入口、OAuth 身份和手机定位，自定义考勤负责自己的规则、排班、记录和统计。官方考勤数据同步是可选扩展，不是独立版本上线的前置条件。

## 结论与实现范围

飞书官方可以设置考勤组成员、GPS 地点和范围、多段上下班规则，以及按员工、按日期排班。但所核验的公开数据结构没有“把某个员工当天第 N 个打卡时段绑定到某个地点”的字段：地点属于考勤组，时段属于班次，日排班把员工与日期关联到考勤组和班次。官方帮助同时说明，同组多个地点允许成员在任一地点打卡。**据此判断，当前公开接口不能直接原生表达“员工 A 上午只能 A 园区、下午只能 B 园区”这一强制约束。**这是依据已核验字段作出的结论，未排除未公开、灰度或特定版本能力。[考勤组接口](https://open.feishu.cn/document/server-docs/attendance-v1/group/create)、[班次接口](https://open.feishu.cn/document/server-docs/attendance-v1/shift/create)、[GPS 规则](https://www.feishu.cn/hc/en-US/articles/360049067406-admin-set-up-gps-attendance)

本项目依据飞书网页应用接入方式独立实现个人时段地点约束。以下功能由自定义考勤实现并以自建统计为准：

| 用户场景 | 自定义考勤的处理方式 | 需要验收的行为 |
| --- | --- | --- |
| A 上午 A、下午 B | 本应用按“人＋日期＋时段”绑定唯一地点 | 上午在 B、下午在 A 均不能通过对应节点校验 |
| B 全天 A，C 全天 B | 分别把当天全部时段绑定 A / B | 每个上下班节点都验证该员工的指定地点 |
| D 楼栋周边 100 米 | 本应用存储地点坐标、坐标系与 100 米半径 | 真机范围内外、边界误差；不识别楼层 |
| 精细排班与统计 | 本应用维护班次模板、个人/批量日排班及应打卡节点 | 根据本应用排班和记录计算正常、迟到、早退与缺卡 |

实现范围如下：

| 层次 | 已有内容 | 边界 |
| --- | --- | --- |
| 独立考勤 | 人员、地点、班次模板、个人分时段排班、位置校验、上下班记录、缺卡统计及 CSV 导出 | 跨日班次、补卡审批、薪资结算、Wi-Fi/人脸防作弊尚未实现 |
| 原生审批联动 | 请假、加班状态事件、结果卡片、本人私人日历及多维表格台账 | 默认关闭，需另行配置权限与资源；加班必须在获批时段通过现场定位核验；不自动减免精细排班中的打卡节点 |
| 飞书身份 | 飞书内自动获取授权码，服务端换码、身份读取、一次性校验、会话和角色检查；浏览器 OAuth 入口 | 部署者需配置自己的应用凭据、首页重定向地址并验证真实租户登录 |
| 飞书 H5 定位 | 服务端票据缓存与签名；前端 JSSDK/config/ready/getLocation 调用 | 需要真实手机、位置权限与现场坐标验证 |
| 官方考勤 OpenAPI（可选） | 本文提供字段核验和同步设计 | 考勤组、班次、官方排班、流水导入及官方结果查询尚未连接；独立考勤不依赖这些同步 |
| 工作台与部署 | 网页应用入口与部署说明 | HTTPS、应用发布、可用范围及入口需在目标环境配置和验收 |

## 主路线：独立考勤

1. 飞书 OAuth 验证用户身份，本应用将同一应用下的 Open ID 绑定到员工档案和角色；服务器据此限制管理员和员工的数据范围。
2. 本应用维护地点及坐标系、班次模板、员工每天的时段和地点。模板生成个人排班，已发生打卡的记录保留当时规则快照。
3. 员工从飞书工作台进入网页应用，在自己的节点发起打卡。服务端使用当前时间校验本人排班，核对定位坐标系、新鲜度、精度和指定范围，再保存记录。
4. 本应用依据应打卡节点、实际记录和节点结束条件计算考勤统计；尚未到期的节点不能提前记为缺卡。缺卡、迟到、早退及导出的统计以本应用规则为准。
5. 完成 HTTPS 部署、主页/回调/可信域名配置、真实身份与定位验收、版本发布及可用范围配置后，从工作台使用。无需先创建官方考勤组、同步官方排班或导入官方流水。

飞书 OpenAPI/JSAPI 的必需接入是 OAuth、用户信息、应用凭证、JSAPI 票据与 `getLocation`，具体配置见[工作台接入文档](feishu-workbench.md)。下文官方考勤 API 的核验结论继续保留，供比较能力及未来选择同步时使用。

## 可选集成：官方考勤接口清单

下表所有路径的前缀都是 `https://open.feishu.cn/open-apis/attendance/v1`。除特别指出外，本文核验接口使用 `Authorization: Bearer tenant_access_token`；JSON 请求使用 `Content-Type: application/json; charset=utf-8`。应用自己的管理员权限不能代替飞书平台 API 权限或考勤数据范围。

| 能力 | Method 与路径 | 官方文档列出的权限 | 关键请求/返回 |
| --- | --- | --- | --- |
| 创建/修改考勤组 | `POST /groups` | `attendance:rule` | Query `employee_type`、`dept_type`；Body `group`、可选 `operator_id`；修改时传 `group.group_id` |
| 列出考勤组 | `GET /groups` | `attendance:rule` 或 `attendance:rule:readonly` | `page_size` 1–50、`page_token`；返回 `data.group_list`，每项 ID/名称 |
| 考勤组详情 | `GET /groups/:group_id` | `attendance:rule` 或 `attendance:rule:readonly` | Query `employee_type`、`dept_type`；返回 `data` 中的组详情 |
| 创建班次 | `POST /shifts` | `attendance:rule` | Body 包含 `shift_name`、`punch_times`、`punch_time_rule`；返回 `data.shift` |
| 按名称查询班次 | `POST /shifts/query` | `attendance:task:readonly` | **Query** `shift_name`，不是请求体；返回 `data` 中的班次 |
| 列出班次 | `GET /shifts` | `attendance:rule` 或 `attendance:rule:readonly` | `page_size` 1–50、`page_token`；返回 `data.shift_list` |
| 班次详情 | `GET /shifts/:shift_id` | `attendance:rule` 或 `attendance:rule:readonly` | 返回 `data` 中的班次 |
| 创建/修改日排班 | `POST /user_daily_shifts/batch_create` | `attendance:rule` | Query `employee_type`；Body `user_daily_shifts`、可选 `operator_id` |
| 查询日排班 | `POST /user_daily_shifts/query` | `attendance:task:readonly` | Query `employee_type`；Body 人员与日期范围 |
| 导入打卡流水 | `POST /user_flows/batch_create` | `attendance:task` | Query `employee_type`；Body `flow_records` |
| 查询打卡流水 | `POST /user_flows/query` | `attendance:task:readonly` | Query `employee_type`；Body 人员与秒级时间范围 |
| 查询打卡结果 | `POST /user_tasks/query` | `attendance:task:readonly` | Query `employee_type`；Body 人员与工作日范围；返回 `data.user_task_results` |

逐项官方来源：[组创建/修改](https://open.feishu.cn/document/server-docs/attendance-v1/group/create)、[组列表](https://open.feishu.cn/document/server-docs/attendance-v1/group/list)、[组详情](https://open.feishu.cn/document/server-docs/attendance-v1/group/get)、[班次创建](https://open.feishu.cn/document/server-docs/attendance-v1/shift/create)、[班次按名称查询](https://open.feishu.cn/document/server-docs/attendance-v1/shift/query)、[班次列表](https://open.feishu.cn/document/server-docs/attendance-v1/shift/list)、[班次详情](https://open.feishu.cn/document/server-docs/attendance-v1/shift/get)、[日排班写入](https://open.feishu.cn/document/server-docs/attendance-v1/user_daily_shift/batch_create)、[日排班查询](https://open.feishu.cn/document/server-docs/attendance-v1/user_daily_shift/query)、[流水写入](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/batch_create)、[流水查询](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/query)、[结果查询](https://open.feishu.cn/document/server-docs/attendance-v1/user_task/query)。

注意：班次按名称查询的权限确实与列表/详情接口不同，表格按当前官方正文记录，未自行统一为 `attendance:rule:readonly`。

## 考勤组：成员和地点的边界

`POST /groups` 同时承担创建和修改，已核验的不是一个另行猜测的 `PUT /groups/:id`。不传 `group.group_id` 时创建，修改时必须传入全部考勤组信息，因为文档明确这是覆盖式更新。`locations` 则特别注明仅追加，因此不能用提交短列表的方式假设可以删除或替换旧地点。[创建/修改考勤组](https://open.feishu.cn/document/server-docs/attendance-v1/group/create)

与本需求直接相关的字段如下；它们是关键字段映射，不是可以直接提交的完整请求体：

| 字段 | 已核验含义 |
| --- | --- |
| `group.bind_user_ids[]` | 按个人绑定，ID 类型由 `employee_type` 决定 |
| `group.bind_dept_ids[]` | 按部门绑定；`dept_type=open_id` 指部门 Open ID |
| `group.need_punch_members[]` | 条件选人；未传上面两个绑定字段时才使用；人员条件为 `scope_group_list.scope_value_type=2`、`member_ids[]` |
| `group.group_leader_ids[]` | 必填考勤主负责人，至少有考勤组管理员权限 |
| `group.group_name`、`time_zone` | 组名称与时区 |
| `group.group_type` | 固定班制、排班制、自由班制；响应正文为 0/2/3，创建正文还兼容把 1/2 都标为排班制 |
| `group.punch_day_shift_ids[]` | 固定班制按周一到周日传 7 个班次 ID，休息填 `"0"`；排班/自由班制传空数组 |
| `group.punch_type` | 位标志，GPS=1、Wi-Fi=2、考勤机=4、IP=8 |
| `group.locations[].location_type` | GPS=1、Wi-Fi=2、IP=8 |
| `group.locations[].location_name`、`latitude`、`longitude` | GPS 名称和坐标 |
| `group.locations[].map_type` | 1 高德、2 谷歌；它是地图类型，不能不经验证地等同于自定义坐标系枚举 |
| `group.gps_range` | 创建请求中的 GPS 范围字段 |
| `group.allow_out_punch` | 是否允许外勤，启用后要额外考虑绕过地点约束的路径 |
| `group.effect_now` | 是否立即生效，默认 false；详情还有生效时间字段 |
| `operator_id` | 未完成考勤后台“API 接入”流程时为必填；操作权限还受操作人管理范围限制 |

来源：[组创建字段表](https://open.feishu.cn/document/server-docs/attendance-v1/group/create)、[组详情字段表](https://open.feishu.cn/document/server-docs/attendance-v1/group/get)。

**半径字段需专项核验：**创建请求将 `locations[].gps_range` 标为历史无效字段，但组详情/响应又列出该字段，且把组级 `gps_range` 标为不建议使用。因此不能只看响应有字段就假定可以通过当前接口逐地点更新范围。真实租户需要验证哪个写入路径生效；100 米这一产品能力本身有官方 GPS 帮助依据。[组字段文档](https://open.feishu.cn/document/server-docs/attendance-v1/group/create)、[GPS 帮助](https://www.feishu.cn/hc/en-US/articles/360049067406-admin-set-up-gps-attendance)

所核验的 `locations[]` 没有个人 ID、日期、开始/结束时间或 `punch_time_rule` 序号字段。`location_id` 在详情文档还被标注为透传字段。不能构造一个文档不存在的“个人时段地点绑定”参数，也不能通过名称约定让官方打卡按钮获得这种校验能力。

## 班次：可以多段，未见逐段地点

`POST /shifts` 的必填主体为唯一的 `shift_name`、历史字段 `punch_times`、以及 `punch_time_rule[]`。有效打卡规则以数组为准；每段包括 `on_time`、`off_time`、迟到/缺卡/早退阈值、`on_advance_minutes` 与 `off_delay_minutes`。跨天结束时间以累加小时表示，例如次日 02:00 写作 `26:00`。提前上班卡最多 720 分钟、延后下班卡最多 960 分钟。还可配置弹性和休息等规则。该数组的已公开字段没有地点或经纬度。[班次创建](https://open.feishu.cn/document/server-docs/attendance-v1/shift/create)

创建接口还记录可选 `id` 为更新班次所用 ID；本文不据此扩展未核验的更新路由。班次为公司共享对象，修改会影响引用它的考勤组和计算结果，不能为了自定义应用直接改动其他业务使用的班次。[班次创建注意事项](https://open.feishu.cn/document/server-docs/attendance-v1/shift/create)

**读写语义差异：**创建请求中的 `punch_time_rule[].no_need_on/no_need_off=true` 表示无需打卡；查询正文却特别注明这两个段级字段 `true` 表示需要打卡，并提醒与创建不同。同步器不能把读取对象原样回写；必须按对应接口做映射并在租户验收中验证。部分加班、半天分割等字段限企业版或灰度，不能承诺所有租户都有。[班次按名称查询](https://open.feishu.cn/document/server-docs/attendance-v1/shift/query)、[班次详情](https://open.feishu.cn/document/server-docs/attendance-v1/shift/get)

## 日排班：按员工和日期绑定班次

写入的 `user_daily_shifts[]` 每项包括 `group_id`、`shift_id`、`user_id`、`month`（整数 `yyyyMM`）、`day_no`；`shift_id="0"` 表示休息，`is_clear_schedule=true` 会覆盖 `shift_id` 的含义并清空班次。单次最多 50 项。不存在则创建，已有则按入参修改。[日排班写入](https://open.feishu.cn/document/server-docs/attendance-v1/user_daily_shift/batch_create)

官方明确限制每人每天只能在一个考勤组中。因此“上午换进 A 组，下午换进 B 组”不能作为可靠方案。另一个容易遗漏的行为是：`code=0` 但 `msg` 包含人员和日期时，可能表示这些排班未生效，常见原因是人员与考勤组不匹配；必须读取结果并回查，不能仅凭 HTTP 200 或 `code=0` 宣称排班成功。[日排班注意事项](https://open.feishu.cn/document/server-docs/attendance-v1/user_daily_shift/batch_create)

查询使用 `user_ids[]`（最多 50 人）、`check_date_from`、`check_date_to`（整数 `yyyyMMdd`），跨度不能超过 30 天。返回用户维度的班次/考勤组关联，不是完整地点约束。写入接口只适用于排班制，固定/自由班制不能直接套用。[日排班查询](https://open.feishu.cn/document/server-docs/attendance-v1/user_daily_shift/query)、[接入指南错误说明](https://open.feishu.cn/document/server-docs/attendance-v1/attendance-development-guidelines)

## 流水导入与结果查询

### 合格记录导入

`POST /user_flows/batch_create` 每次最多 50 条。每条必填 `user_id`、`creator_id`、`location_name`、`check_time`（秒级时间戳字符串）、`comment`；打卡时间必须在 2022-01-01 之后。`external_id` 用于和本地记录对照，`idempotent_id` 用于重试去重，后者不传就不具备该幂等保证。[流水导入](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/batch_create)

导入后由官方按照员工所属考勤组和班次计算状态。`check_result`、`record_id` 作为导入参数无效；照片导入不支持，`device_id` 导入无效。已核验字段中没有坐标及精度校验参数，因此位置验证与证据需保存在自定义服务端，不能假定官方会验证传入的地点名称。`type` 有多种枚举及默认语义，不能因为写入某种枚举就宣称获得原生设备防作弊证明。[流水字段与限制](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/batch_create)

### 原始流水核对

`POST /user_flows/query` 请求 `user_ids[]`（最多 50 人）、`check_time_from`、`check_time_to`。时间为秒级字符串，范围是左闭右开 `[from,to)`；可选 `include_terminated_user` 处理工号/ID复用。官方特别说明只返回有效流水，不包含无效和待生效流水，因此查询不到不能直接推出“从未打卡”。`data.user_flow_results` 中可用于核对 `record_id`、`external_id`、人员、时间、地点名称和打卡方式。[流水查询](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/query)

### 官方结果核对

`POST /user_tasks/query` 请求 `user_ids[]`（最多 50）、`check_date_from`、`check_date_to`（`yyyyMMdd`），可选 `need_overtime_result`。Query 支持 `ignore_invalid_users`、`include_terminated_user`。最终正常/迟到/早退/缺卡读取 `data.user_task_results[].records[].check_in_result/check_out_result`，不要读取流水内部的 `check_result` 来替代；后者正文说明主要表示待生效。结果还有补卡、出差、请假等补充原因。[结果查询](https://open.feishu.cn/document/server-docs/attendance-v1/user_task/query)

结果接口按任务归并，不逐条返回所有打卡行为；相连的正常和加班时段还可能共享流水 ID。选择同步并展示官方结果时，官方缺卡与出勤判断应以官方任务为依据，不能把本地记录行数直接换算成官方出勤天数。独立版本的缺卡由本应用的应打卡节点计算，二者需要明确标识。[结果接口说明](https://open.feishu.cn/document/server-docs/attendance-v1/user_task/query)

## 人员身份和权限

独立版本使用当前应用的 Open ID 绑定员工，无需为运行自建考勤额外取得官方考勤员工 ID。只有选择同步官方考勤时，上述考勤接口才需要 `employee_type=employee_id`（即飞书 `user_id`）或 `employee_no`（工号）及可靠映射。若通过用户信息接口取得 `user_id`，需要对应字段权限 `contact:user.employee_id:readonly`；也可由企业确认工号映射。不要依据姓名自动关联员工。[考勤接入名词解释](https://open.feishu.cn/document/server-docs/attendance-v1/attendance-development-guidelines)、[用户信息字段权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)

官方“API 接入”指南包含权限、IP 白名单、发布与考勤侧接入步骤，历史导航还要求启用机器人。网页登录与定位本身不因此需要机器人；若后续接官方考勤，应在真实租户按其当前接入流程核实。`operator_id` 的条件必填与考勤数据管理范围不能由普通 OAuth 登录代替。[官方考勤接入指南](https://open.feishu.cn/document/server-docs/attendance-v1/attendance-development-guidelines)

## 可选方案：同步官方规则、流水和结果

只有后续明确需要复用官方班次、排班或把记录交给官方统计时，才采用以下可选链路。它尚未实现，不属于当前独立版本的发布前置。也可以仅选择流水同步，但需先核对官方排班与本应用规则的差异：

1. 读取官方考勤组、班次和员工日排班，明确个人、日期和每段上下班节点；或在自定义后台编排后调用官方接口并回查生效情况。须确定唯一的排班数据来源，避免两端互相覆盖。
2. 额外存储 `员工身份＋工作日＋官方班次/时段＋版本 → 地点`。班次被修改后重新核对绑定，避免仅按数组序号导致地点错配。
3. 飞书网页入口登录后，以服务端身份和时间取得本人节点；获取定位并在服务端验证坐标系、精度、新鲜度和指定围栏。
4. 验证成功后先保存带规则快照的本地记录，再以稳定 `idempotent_id` 导入官方。网络失败保留待同步状态并允许幂等重试，不能让员工重复打卡来修复同步。
5. 查询官方流水和任务结果，在界面分别展示位置校验结果、同步状态与官方考勤结果。导入成功不等于官方判定正常。

原生官方打卡按钮不会自动执行本系统的地点约束。若员工仍能直接使用原生入口，必须确定企业实际打卡入口及异常处理规则；仅在事后导入合格记录不能阻止原生入口产生额外记录。公开文档未发现自定义前置校验回调或替换官方按钮的能力，不能承诺“在原生按钮上无感增加规则”。

## 独立版本的实现与验收边界

- OAuth、服务端会话、H5 签名和已知坐标系转换校验按网页应用方式接入。部署时需配置 HTTPS、主页、回调、可信域名、发布与可用范围，并进行真机验收。
- 班次模板、时间阈值、迟到早退及缺卡统计采用本应用自己的规则并向管理员明确展示。不要把自建结果标成“官方考勤结果”，也不需要为独立运行强制改成读取官方班次。
- 当前跨日班次尚未实现。现有分两天排班可作为两个独立工作日使用，但不承诺完整夜班归属、跨日工时与缺卡统计语义；后续支持夜班时单独实现和验证。
- 缺卡统计已从排班生成的应打卡节点出发，在允许打卡窗口结束后计算；历史记录保留规则快照，避免改模板导致已完成考勤被重新解释。班次模板和缺卡统计已实现并包含自动测试；部署环境中的真实数据流程需另外验收。
- 请假和加班使用飞书原生审批，应用监听状态并联动卡片、私人日历和台账，配置与验收见[审批联动说明](workflows.md)。审批不自动调整已有精细排班或缺卡统计；补卡审批、假期余额、薪资结算和 Wi-Fi/人脸防作弊尚未实现。
- 官方 ID 映射、组/班次/排班关联、幂等导入、官方结果回查，以及全量组更新和字段语义处理，只在启用可选同步时需要。
- 分别检查应用配置、服务部署、工作台发布与真机运行；其中独立版本验证真实登录、定位和工作台入口，官方考勤读写仅在启用可选集成时另行验收。

## 部署与可选集成验收

部署独立版本时验证：运行环境、持久存储、HTTPS 和回调可达性、真实账号身份绑定、手机定位精度与坐标系、位置权限拒绝流程、班次模板和统计流程，以及工作台发布和可用范围。使用测试人员和测试地点验证，不能用本地模拟接口测试替代实际环境验收。

若启用官方同步，还需核验租户版本与灰度权限、GPS 半径写入字段冲突、原生与导入流水合并时序、官方数据范围、结果一致性时延及原生入口管理配置。这些事项属于可选同步范围，不是独立考勤运行的前提。

本文是接口核验记录和实现设计，不代表任意租户已经部署、发布或通过上述验收。App Secret、访问令牌及真实人员数据不应写入公开文档。
