# 工作台「灵活考勤」小组件

使用飞书原生 Block（TTML / TTSS / JavaScript），高度 150px，可添加到工作台「我的常用」，或由管理员放入定制工作台。显示本人今日剩余次数、已完成进度、下一次时间与地点、待打地点概览。长地点省略显示，完整安排从「去打卡」进入现有应用查看。已完成或无排班时进入本人记录。

跨端布局须显式约束容器宽度、文字行高和弹性基准：移动端 Native 的 `flex` 仅等同于 `flex-grow`，且文字样式不会从父容器继承。按钮文字直接设置字号和颜色，剩余空间用 `flex-basis: 0px` 分配，避免手机端长地点撑宽或文字挤出按钮。不能仅凭桌面预览认定 iPhone 排版已验收。参见官方 [TTSS 说明](https://open.feishu.cn/document/client-docs/block/block-frame/code-components-and-structure/view-layer/ttss/ttss)与 [flex 说明](https://open.feishu.cn/document/client-docs/block/block-frame/code-components-and-structure/view-layer/ttss/attributes/flexbox/flex)。

打开、返回工作台或点击刷新时，通过 `tt.login` 获取一次性授权码，再调用本服务器 `POST /api/widget/today`。服务器用本自建应用的 app_access_token 验证代码，并核对本人绑定和停用状态；配置租户限制时也校验租户。管理员也只返回本人当天数据。不接受员工 ID，不返回组织成员、原始坐标、登录凭证或管理数据；不建立网页登录会话。

组件点击通过 `tt.openSchema` 的网页应用 AppLink 进入现有免登录、飞书定位打卡流程；查看工作台不会申请定位或自动打卡。失败显示重试入口，更新期间不把旧数量伪装成最新值。剩余次数和机器人提醒共用同一统计函数；上班、下班各算一次，过时未打仍属于未完成。

## 部署

1. 在现有企业自建应用启用工作台小组件，获得 BlockTypeID；不扩大应用可用范围。
2. 将 `widget/` 复制到独立发布目录，填写 `project.config.json` 的 appid、`block/index.json` 的 blockTypeID，以及 `block/config.js` 的相同 App ID 和 HTTPS 考勤根地址。公开模板不包含部署身份或密钥。小组件内不可加入 App Secret。
3. 服务器设置 `FEISHU_WIDGET_ORIGIN=https://your-company.feishu.cn`，可用 `FEISHU_TENANT_KEY` 增加租户限制。只允许这个精确企业来源；原生请求没有 Origin 时仍须校验本应用一次性登录码和已绑定成员。其他网页接口的来源检查不变。
4. 使用官方工具 `opdev upload <发布目录> -t block -v <版本> -d <说明>` 上传。在开发者后台选择版本，配置 240×240 PNG 图标、名称、介绍与「标准小组件」「非标准小组件」，发布现有应用。协议白名单加入官方 `https://applink.feishu.cn`，以支持在飞书内打开本应用打卡页；不填通配符。
5. 在本人飞书工作台「我的常用 → 添加」选择应用小组件，或在定制工作台编辑器添加自建小组件并设置可见人员，核对今日真实数据及进入应用、返回刷新。不同租户的可用功能取决于飞书版本与工作台授权；不自动购买或改动企业套餐。

组件更新不需要新增业务 API 权限。登录码仅发送到既有考勤服务器，由飞书服务端验证；不使用聊天或通讯录写入权限。工作台能力能否使用应在组织实际客户端验收，不能用网页仿制预览替代。

官方文档：[工作台小组件](https://open.feishu.cn/document/client-docs/block/hosting-scenario-introduction/workplace)、[配置参考](https://open.feishu.cn/document/client-docs/block/block-frame/config)、[小组件登录](https://open.feishu.cn/document/client-docs/block/api/user/login)、[服务端校验登录码](https://open.feishu.cn/document/client-docs/gadget/-web-app-api/open-ability/login/code2session)。
