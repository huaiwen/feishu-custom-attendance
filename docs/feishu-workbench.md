# 把“自定义考勤”接入飞书工作台

本项目作为独立的企业自建考勤网页应用运行。飞书提供工作台入口、OAuth 身份和手机定位；本应用负责人员、地点、班次模板、精细排班、打卡记录与自建考勤统计。官方排班、流水和结果同步是可选扩展，独立版本上线不以这些同步为前提。

仓库提供飞书客户端免登、OAuth 登录、H5 JSAPI 签名和手机定位代码。部署者需创建或选择自己的企业自建应用，并验证真实账号登录、定位及工作台入口。以下统一使用 `https://attendance.example.com` 作为占位地址，需替换为实际 HTTPS 根地址。

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

`ADMIN_OPEN_IDS` 是本项目初始组织管理员名单，多个 ID 用逗号分隔。Open ID 是用户在这个应用内的标识，不能直接使用其他应用获取的 Open ID。管理员在“人员管理 → 从组织添加”中选择真实成员，自动绑定当前应用的 Open ID；不要用姓名匹配来授权。

在应用“安全设置”中配置：

| 配置项 | 示例值 |
| --- | --- |
| 重定向 URL（普通浏览器登录） | `https://attendance.example.com/auth/callback` |
| 重定向 URL（飞书客户端免登） | `https://attendance.example.com/`，保留末尾斜杠 |
| H5 可信域名 | `https://attendance.example.com`；使用实际 HTTPS 根地址，非标准端口也需包含在地址中 |

回调地址必须与服务端 `BASE_URL` 派生出的地址完全一致；本项目回调路径为 `/auth/callback`，不要照搬其他教程的末尾斜杠。2026-11-21 后台实测，H5 可信域名字段要求完整 HTTP/HTTPS URL，裸 `主机:端口` 无法保存；使用与 `BASE_URL` 相同的 HTTPS 根地址并回读确认。部署在根路径，避免前缀路径或代理改写导致 OAuth 回调、静态资源和 JSAPI 验签不一致。[重定向 URL 配置](https://open.feishu.cn/document/develop-web-apps/configure-redirect-urls)、[OAuth 授权码与回调规则](https://open.feishu.cn/document/common-capabilities/sso/api/obtain-oauth-code)、[H5 JSAPI 鉴权规则](https://open.feishu.cn/document/uYjL24iN/uEzM4YjLxMDO24SMzgjN)

免登使用 `tt.requestAccess({appID,scopeList:[]})`；飞书会校验当前网页地址，因此只添加 `/auth/callback` 不够，缺少首页时会出现 `2700002 / 20029`。旧客户端仅在接口缺失或返回 `errno=103` 时使用 `tt.requestAuthCode({appId})`。用户拒绝或其他失败不会触发降级。服务端使用同源、HttpOnly Cookie 和一次性 nonce 校验，授权码通过 POST 交换，不放进链接或日志。[官方免登兼容示例](https://open.feishu.cn/document/client-docs/h5/development-guide/step-3)、[SDK 常见问题](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/server-side-sdk/faq)

## 4. 权限最小集

| 能力 | 当前需要的授权 |
| --- | --- |
| 飞书登录与基础身份 | OAuth 用户同意和应用可用范围；获取 `open_id`、姓名、`tenant_key` 不要求额外用户信息字段权限 |
| 从组织选择成员 | 应用身份权限 `contact:contact.base:readonly`、`contact:user.base:readonly`、`contact:department.base:readonly`，以及明确授权的部门/成员通讯录数据范围 |
| 手机获取当前位置 | H5 JSAPI 鉴权；用户同意 `scope.userLocation`；手机系统允许飞书访问精确位置 |
| 排班提醒与管理员查看记录提醒 | 应用机器人 + `im:message:send_as_bot`，见 [提醒配置](reminders.md) |
| 自定义班次、排班、地点、打卡与统计 | 存储和计算在本项目，不需要官方考勤读写权限 |

不申请手机号、邮箱、通讯录写入、聊天读取、人脸、摄像头或 `offline_access` 权限。通讯录数据范围与应用可用范围是两项独立配置；按部署需要选择部门或全部成员，变更权限后发布新版本。`scope.userLocation` 是客户端用户位置授权，不应把它当作 OAuth `scope` 字符串或考勤管理权限。定位被拒绝时应引导用户检查授权，不能绕过拒绝继续打卡。[用户信息字段权限](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)、[客户端 API 权限](https://open.feishu.cn/document/uYjL24iN/uITMuITMuITM)

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
- 新增地点自动请求飞书位置，授权后地图移到附近；搜索选点并保存半径，界面无需设置经纬度或坐标系。被拒绝时仍能搜索。编辑已有地点保留原中心；定位返回前已搜索、拖动或选点时不覆盖用户操作。
- 退出后重登、换设备、重复点击打卡、刷新页面后检查身份与数据是否正确。

## 7. 当前限制

100 米表示围绕指定经纬度的平面地理范围，不识别楼层，不保证员工位于楼内。定位结果会受到设备、室内环境和系统授权精度影响；`accuracy: 'best'` 只是期望约 20 米精度，不构成精度保证。`getLocation` 支持移动端网页应用，不支持 PC，手机端必须授予定位权限。[getLocation 文档](https://open.feishu.cn/document/uYjL24iN/uUTOz4SN5MjL1kzM)

管理员搜索地点后在地图上确认中心、调整半径。底图使用高德地图，新地点按 GCJ-02 保存；旧 WGS84 点显示时由固定版本 gcoord 转换。服务端以手机实际返回的坐标系转换后校验距离，记录同时保留定位坐标系和中心坐标系。未知或缺失坐标系仍拒绝。地图标注误差和转换不能替代实际手机的现场校准。

打卡只校验打卡时刻的位置，不能证明某人全天持续在岗。浏览器或客户端提交的坐标也不构成不可伪造的硬件证明。请假与加班通过原生审批联动，见[接入说明](workflows.md)。当前未实现跨日班次、补卡审批、假期余额、薪资结算及 Wi-Fi/人脸防作弊。

官方 GPS 考勤地点按考勤组设置，同组多个地点允许在其中任一地点打卡。已核验的公开字段没有直接表达本项目个人时段地点约束，因此采用自建入口和自建统计。若后续选择导入流水，官方 `check_result` 入参不会覆盖官方判定，届时应区分自建结果和官方结果。[官方 GPS 规则](https://www.feishu.cn/hc/en-US/articles/360049067406-admin-set-up-gps-attendance)、[导入流水限制](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/attendance-v1/user_flow/batch_create)

## 实现使用的官方接口

- 用户授权：`https://accounts.feishu.cn/open-apis/authen/v1/authorize`。
- 授权码换用户凭证：`POST https://open.feishu.cn/open-apis/authen/v2/oauth/token`，读取顶层 `access_token`。[文档](https://open.feishu.cn/document/authentication-management/access-token/get-user-access-token)
- 用户身份：`GET https://open.feishu.cn/open-apis/authen/v1/user_info`。[文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/user_info/get)
- 应用凭证：`POST https://accounts.feishu.cn/oauth/v3/token`，`grant_type=client_credentials`，读取 `access_token` 和 `expires_in`。[当前版本文档](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token)
- JSAPI 票据：`POST https://open.feishu.cn/open-apis/jssdk/ticket/get`，读取 `data.ticket` 与 `data.expire_in`；服务端缓存并在过期前刷新。[文档](https://open.feishu.cn/document/ukTMukTMukTM/uYTM5UjL2ETO14iNxkTN/h5_js_sdk/authorization)
- JSSDK：`https://lf-scm-cn.feishucdn.com/lark/op/h5-js-sdk-1.5.48.js`。[官方 SDK 引入说明](https://open.feishu.cn/document/client-docs/h5/introduction)

当前内置该固定版本的 JSSDK，仅将两处获取全局对象的 `new Function("return this;")()` 改为 `globalThis`，避免未登录页面因 CSP 禁止动态执行而加载失败。修改和文件哈希见 `public/vendor/FEISHU-SDK-NOTICE.md`；这没有放宽登录页、普通用户或组管理员的 CSP。

已登录的前端通过 `GET /api/feishu/jsapi-config?url=...` 获取 JSAPI 配置，`url` 使用 `encodeURIComponent(location.href.split('#')[0])`。服务端仅为 `BASE_URL` 同源页面签名。前端把配置交给 `h5sdk.config`，同时等待 `h5sdk.ready` 和 `config.onSuccess` 后才调用 `tt.getLocation({ timeout: 5, cacheTimeout: 0, accuracy: 'best', success, fail })`；鉴权失败或超时会停止定位并允许重试。使用官方默认的五秒等待时间，仍请求约 20 米的最佳精度；返回结果继续由服务端按实际精度和围栏校验，不能把超时参数当成成功保证。前端保留实际返回的坐标系 `type`，后端仅接受 `wgs84` 或 `gcj02`，按实际坐标系转换后计算距离，不允许缺失或误标。新增地点的地图选点默认保存 GCJ-02，旧地点保持原坐标系。

本地测试覆盖 API 请求字段、错误脱敏、凭证过期、并发刷新与签名计算；它不等于真实飞书租户、真实手机或现场定位验收。

手机应用打开后提前定位，组件脚本和服务端签名并行加载；启动、地图、打卡共享进行中的请求，打卡仅复用 15 秒内且误差不超过 20 米的内存结果。服务器围栏、精度与新鲜度规则保持独立校验。

排查慢定位时，前端向同源 `POST /api/location-timing` 上报连接准备、手机取点、高德组件和底图各阶段耗时及成功/失败。接口要求登录、同源、枚举与数值白名单，每个登录会话每分钟最多 30 条，仅写运行日志，不写考勤数据；不接受坐标、身份、设备信息或原始错误。诊断失败不影响定位。网页应用和小程序均使用同一 `getLocation` 接口，改换应用形态不能保证缩短手机取点时间。

## 角色与组织选择

- 普通用户：个人打卡、排班、记录和统计。
- 考勤组管理员：负责组的成员、排班、记录、统计和导出；不能修改其他组或授予角色。
- 组织管理员：全部考勤组、人员角色、公共地点和班次设置。这里的组织管理员是本应用内的角色，不会自动授予飞书企业管理后台权限。

人员目录只展示应用已获授权的部门及成员；通过服务端重新读取目录核验所选身份后保存。读取基本信息只保留姓名、身份标识和部门，不把上游手机、邮箱等字段交给前端。当前通过部门/成员数据范围组织目录；若仅以飞书用户组授权，请将相应部门或成员加入范围。工号未提供时显示为空，不伪造正式工号。

成员转组不改写历史排班和打卡归属。初始组织管理员由 `ADMIN_OPEN_IDS` 保留；其他角色由组织管理员在成员考勤设置中指定，组管理员也可在考勤组设置中指定。

接口依据：[通讯录授权范围](https://open.feishu.cn/document/server-docs/contact-v3/scope/list)、[部门直属成员](https://open.feishu.cn/document/server-docs/contact-v3/user/find_by_department)、[批量用户](https://open.feishu.cn/document/server-docs/contact-v3/user/batch)、[子部门列表](https://open.feishu.cn/document/server-docs/contact-v3/department/children)。
