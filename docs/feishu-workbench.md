# 把“自定义考勤”接入飞书工作台

本项目作为独立的企业自建考勤网页应用运行。飞书提供工作台入口、OAuth 身份和手机定位；本应用负责人员、地点、班次模板、精细排班、打卡记录与自建考勤统计。官方排班、流水和结果同步是可选扩展，独立版本上线不以这些同步为前提。

仓库提供 OAuth 登录、H5 JSAPI 签名和手机定位代码。部署者需创建或选择自己的企业自建应用，并验证真实账号登录、定位及工作台入口。以下统一使用 `https://attendance.example.com` 作为占位地址，需替换为实际 HTTPS 根地址。

## 1. 准备服务地址

将项目部署到员工手机、飞书客户端和企业网络都能访问、证书有效且受信任的 HTTPS 根地址。可以使用域名，也可评估带有效 IP 证书的公网 IP，不要求先购买域名。以下入口、回调与环境变量使用示例域名；实际根地址改变时应统一替换。

飞书官方教程直接用 IP 配置桌面/移动主页和 **H5 可信域名**，另有 IP 配置重定向 URL 的示例；这不是从 OAuth 能力推断 H5 支持。教程针对内网开发，正式上线要求公网地址；生产 HTTPS IP 的后台保存、证书校验、真实手机访问和 JSAPI 验签仍需实测。[官方主页与 H5 IP 示例](https://open.feishu.cn/document/integrating-web-apps-in-5-minutes/step-4-configure-the-home-page-address?lang=zh-CN)、[官方重定向与 H5 IP 示例](https://open.feishu.cn/document/quickly-create-a-login-free-web-app/configure-the-web-application-access-address)

Let's Encrypt 已于 2026 年 1 月 15 日一般开放 IP 证书，IP 证书有效期为 **160 小时**。若采用该方案，部署时必须落实自动续期和续期后代理重载，再把 HTTPS 请求代理到本项目服务端。[官方公告](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[自动续期说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

本地 `127.0.0.1:4173` 只用于这台电脑上的演示：手机访问自己的 `127.0.0.1` 无法连接开发电脑。飞书工作台提供入口，不代为托管本项目服务和数据库。[官方创建与配置指南](https://open.feishu.cn/document/uYjL24iN/uMTMuMTMuMTM/development-guide/step1)

## 2. 配置企业自建应用

1. 在[飞书开发者后台](https://open.feishu.cn/app)创建企业自建应用，或选择已有应用。
2. 确认名称为 **自定义考勤**；说明可填写“按员工、日期、时段和地点设置精细排班与打卡范围”。
3. 添加 **网页应用** 能力，进入配置页。
4. 在“应用能力 → 网页应用”设置桌面端主页 `https://attendance.example.com/#schedules`、移动端主页 `https://attendance.example.com/#checkin`；替换示例域名后保存并验证。
5. 保持主页在飞书客户端内打开。移动端定位需要飞书客户端 JSAPI，不要给主页添加跳到外部浏览器的参数。[官方配置步骤](https://open.feishu.cn/document/uYjL24iN/uMTMuMTMuMTM/development-guide/step1)

本项目使用网页应用入口，不要求额外添加工作台小组件。应用若已启用其他能力，发布时仍需满足它们各自的必填配置。

## 3. 配置凭据、回调和可信域名

在“凭证与基础信息”获取 App ID 和 App Secret，将它们写入服务器 `.env`；不要写入前端代码、截图、日志或提交到 Git。

```dotenv
PORT=4173
FEISHU_APP_ID=cli_REPLACE_WITH_APP_ID
FEISHU_APP_SECRET=REPLACE_WITH_APP_SECRET
BASE_URL=https://attendance.example.com
ADMIN_OPEN_IDS=ou_REPLACE_WITH_ADMIN_OPEN_ID
# 建议填写本企业标识，防止错误租户接入
# FEISHU_TENANT_KEY=REPLACE_WITH_TENANT_KEY
# 仅在反向代理或容器需要访问时设置
HOST=0.0.0.0
```

`ADMIN_OPEN_IDS` 是本项目管理员名单，多个 ID 用逗号分隔。Open ID 是用户在这个应用内的标识，不能直接使用其他应用获取的 Open ID。员工首次登录后仍需绑定管理员配置的员工档案和排班；不要用姓名匹配来授权。

在应用“安全设置”中配置：

| 配置项 | 示例值 |
| --- | --- |
| 重定向 URL | `https://attendance.example.com/auth/callback` |
| H5 可信域名 | `attendance.example.com`；若使用非标准端口，同时包含实际端口，按后台校验结果确认 |

回调地址必须与服务端 `BASE_URL` 派生出的地址完全一致；本项目回调路径为 `/auth/callback`，不要照搬其他教程的末尾斜杠。H5 可信域名对应页面实际所在主机。部署在根路径，避免前缀路径或代理改写导致 OAuth 回调、静态资源和 JSAPI 验签不一致。[重定向 URL 配置](https://open.feishu.cn/document/develop-web-apps/configure-redirect-urls)、[OAuth 授权码与回调规则](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code)、[H5 JSAPI 鉴权规则](https://open.feishu.cn/document/uYjL24iN/uEzM4YjLxMDO24SMzgjN)

## 4. 权限最小集

| 能力 | 当前需要的授权 |
| --- | --- |
| 飞书登录与基础身份 | OAuth 用户同意和应用可用范围；获取 `open_id`、姓名、`tenant_key` 不要求额外用户信息字段权限 |
| 手机获取当前位置 | H5 JSAPI 鉴权；用户同意 `scope.userLocation`；手机系统允许飞书访问精确位置 |
| 自定义班次、排班、地点、打卡与统计 | 存储和计算在本项目，不需要官方考勤读写权限 |

当前不需要机器人、消息发送、通讯录全量读取、人脸、摄像头或 `offline_access` 权限。`scope.userLocation` 是客户端用户位置授权，不应把它当作 OAuth `scope` 字符串或考勤管理权限。定位被拒绝时应引导用户检查授权，不能绕过拒绝继续打卡。[用户信息字段权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)、[客户端 API 权限](https://open.feishu.cn/document/uYjL24iN/uITMuITMuITM)

如果将来选择同步官方考勤，才按实际需求申请 `attendance:task`；若同步官方排班，还需要 `attendance:rule`，读取官方结果则需要对应只读权限及考勤侧数据范围。届时还要维护本应用 Open ID 与官方所需员工 ID/工号的映射，不能直接把 Open ID 填进 `employee_id`。这些都是可选同步的配置，不是独立版本发布条件。[流水导入接口](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/batch_create)、[排班接口](https://open.feishu.cn/document/server-docs/attendance-v1/user_daily_shift/batch_create)

## 5. 发布到工作台

1. 进入“应用发布 → 版本管理与发布 → 创建版本”。
2. 填写版本号、更新说明，移动端与 PC 端默认能力均选择 **网页应用**。
3. 配置可用范围，先包含管理员和参与验证的员工。仅在范围内的用户可以搜索和使用应用。
4. 保存后“申请线上发布”，完成企业管理员审核。
5. 发布成功后，在飞书手机端或桌面端 **工作台** 中搜索“自定义考勤”并打开。[官方发布与使用步骤](https://open.feishu.cn/document/uYjL24iN/uMTMuMTMuMTM/development-guide/step-4)

发布成功与服务启动是两件事：应用发布后，服务器仍需持续运行。修改应用权限、可用范围和相关应用配置后，按后台要求发布新版本；仅更新已部署网页代码通常不需要重新发布飞书应用版本。[网页应用概述](https://open.feishu.cn/document/client-docs/h5/introduction)

## 6. 现场验证

使用真实的测试账号与真实坐标验证，确认后再安排正式考勤：

- 管理员能维护排班；普通员工只能看到自己的安排，不能选择其他人代打卡。
- 员工 A 上午绑定 A 园区、下午绑定 B 园区；上午在 B 园区应被拒绝。
- 员工 B/C 分别全天绑定 A/B 园区；员工 D 绑定楼栋坐标及 100 米范围。
- 班次模板正确生成个人排班；已保存记录的规则快照不随模板编辑改写。
- 统计使用本应用规则，未到打卡截止时间的节点不记为缺卡；截止后未打卡节点应能计入缺卡，并与明细核对。
- 在范围内、范围外、围栏边缘分别验证；拒绝定位、定位超时、定位误差过大时不能记为成功。
- 为每个地点选择与坐标来源一致的坐标系：`wgs84` 或 `gcj02`，默认 `wgs84`。普通浏览器定位使用 WGS84，飞书定位以 `tt.getLocation` 实际返回的 `type` 为准；检查两种相同坐标系的定位均能使用，坐标系不一致或定位缺失坐标系时应拒绝打卡。
- 退出后重登、换设备、重复点击打卡、刷新页面后检查身份与数据是否正确。

## 7. 当前限制

100 米表示围绕指定经纬度的平面地理范围，不识别楼层，不保证员工位于楼内。定位结果会受到设备、室内环境和系统授权精度影响；`accuracy: 'best'` 只是期望约 20 米精度，不构成精度保证。`getLocation` 支持移动端网页应用，不支持 PC，手机端必须授予定位权限。[getLocation 文档](https://open.feishu.cn/document/uYjL24iN/uUTOz4SN5MjL1kzM)

地点支持 WGS84 和 GCJ-02，但同一次校验的地点坐标与定位结果必须使用同一坐标系；本项目不做隐式转换或近似转换。请按地图数据的实际来源设置地点，不要仅更改坐标系标签来消除提示。若浏览器返回 WGS84、目标地点配置为 GCJ-02，需要使用能提供匹配坐标系的定位来源，或由管理员取得正确坐标后更新地点。

打卡只校验打卡时刻的位置，不能证明某人全天持续在岗。浏览器或客户端提交的坐标也不构成不可伪造的硬件证明。当前未实现跨日班次、请假/加班审批、补卡审批、假期余额、薪资结算及 Wi-Fi/人脸防作弊；这些功能有独立的开发与验收范围，不能仅靠调用登录或流水 API 获得。

官方 GPS 考勤地点按考勤组设置，同组多个地点允许在其中任一地点打卡。已核验的公开字段没有直接表达本项目个人时段地点约束，因此采用自建入口和自建统计。若后续选择导入流水，官方 `check_result` 入参不会覆盖官方判定，届时应区分自建结果和官方结果。[官方 GPS 规则](https://www.feishu.cn/hc/en-US/articles/360049067406-admin-set-up-gps-attendance)、[导入流水限制](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/batch_create)

## 实现使用的官方接口

- 用户授权：`https://accounts.feishu.cn/open-apis/authen/v1/authorize`。
- 授权码换用户凭证：`POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`，读取顶层 `access_token`。[文档](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)
- 用户身份：`GET https://open.feishu.cn/open-apis/authen/v1/user_info`。[文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)
- 应用凭证：`POST https://accounts.feishu.cn/oauth/v3/token`，`grant_type=client_credentials`，读取 `access_token` 和 `expires_in`。[当前版本文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)
- JSAPI 票据：`POST https://open.feishu.cn/open-apis/jssdk/ticket/get`，读取 `data.ticket` 与 `data.expire_in`；服务端缓存并在过期前刷新。[文档](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/h5_js_sdk/authorization)
- JSSDK：`https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.48.js`。[官方 SDK 引入说明](https://open.feishu.cn/document/client-docs/h5/introduction)

已登录的前端通过 `GET /api/feishu/jsapi-config?url=...` 获取 JSAPI 配置，`url` 使用 `encodeURIComponent(location.href.split('#')[0])`。服务端仅为 `BASE_URL` 同源页面签名。前端把配置交给 `h5sdk.config`，在 `h5sdk.ready` 后调用 `tt.getLocation({ timeout: 15, cacheTimeout: 0, accuracy: 'best', success, fail })`。前端保留实际返回的坐标系 `type`，后端强制检查它与地点的 `coordinateSystem` 相同；允许 `wgs84` 或 `gcj02`，不允许缺失或混用。地图坐标系选择由管理员显式配置，默认 WGS84。

本地测试覆盖 API 请求字段、错误脱敏、凭证过期、并发刷新与签名计算；它不等于真实飞书租户、真实手机或现场定位验收。
