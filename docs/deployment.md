# Docker 部署

本文说明如何部署独立自建考勤应用并接入飞书工作台。项目已实现班次模板、个人分时段排班、地点围栏、打卡记录、缺卡统计与导出、飞书登录与定位签名。官方考勤流水同步是尚未实现的可选扩展，不是独立版本上线的前置条件；当前也未覆盖官方假勤、审批或薪酬功能。上线前需要真实手机与企业账号验收。

## 部署条件

- 一台可运行 Docker 的服务器，或支持持久卷和单实例运行的云平台。
- 一个员工设备可访问、证书有效且受信任的 HTTPS 根地址，不能带子路径。可使用域名，也可评估带有效 IP 证书的公网 IP；不要求先购买域名。本文以 `https://attendance.example.com` 为占位地址，部署时替换为实际 HTTPS 根地址。
- 在该飞书应用下取得的管理员 Open ID，以及服务端保存的 App ID、App Secret。
- `/app/data` 必须持久化。当前使用 JSON 文件存储，只允许一个 Node 进程、一个应用实例访问这份数据；云平台副本数固定为 1，升级时先停旧实例。不要使用临时磁盘保存正式记录。

## 构建与启动

在项目根目录构建镜像。镜像基于官方 `node:24-alpine`，无需执行 `npm install`，以非 root 的 `node` 用户运行。构建只复制运行文件；`.env`、实际数据和测试产物被排除。

```sh
docker build --pull -t custom-attendance:local .
```

在服务器私密保存 `.env`，设置权限为 `600`。以下均为占位值，需替换为实际应用凭据和 HTTPS 根地址；不要把 App Secret 写入 Dockerfile、镜像、仓库或公开日志。

```dotenv
FEISHU_APP_ID=cli_REPLACEWITHAPPID
FEISHU_APP_SECRET=REPLACEWITHAPPSECRET
BASE_URL=https://attendance.example.com
ADMIN_OPEN_IDS=ou_REPLACEWITHADMINID
```

`BASE_URL` 必须与浏览器实际访问的 HTTPS 根地址一致，不带子路径。多个管理员 Open ID 用英文逗号分隔，必须来自同一个飞书应用。若需要额外限制企业身份，可设置 `FEISHU_TENANT_KEY` 为该企业真实的 tenant key；没有此值时不要填写占位字符串。缺少必需配置会阻止服务启动。

使用运行时环境变量注入配置，不将 `.env` 挂入或复制进镜像：

```sh
chmod 600 .env
docker volume create custom-attendance-data
docker run -d \
  --name custom-attendance \
  --restart unless-stopped \
  --env-file .env \
  --env HOST=0.0.0.0 \
  --env PORT=4173 \
  --mount type=volume,source=custom-attendance-data,target=/app/data \
  --publish 127.0.0.1:4173:4173 \
  custom-attendance:local
```

这里容器内部监听 `0.0.0.0`，宿主机仅向本机代理开放 `4173`。首次创建的命名卷继承镜像中数据目录的权限。若改用已有卷或宿主机目录，确保目录及数据文件可由容器的 UID/GID `1000:1000` 读写，不要通过改为 root 运行解决权限问题。

云平台使用同样的镜像，设置相同环境变量、内部端口 `4173`、挂载点 `/app/data`，并禁止同时启动多个副本。更新容器时保留命名卷；不要删除数据卷。服务重启会清除内存登录会话，用户需要重新登录。

## HTTPS 与飞书配置

飞书官方教程直接将 IP 地址填入网页应用主页及 H5 可信域名，正式上线要求主页为公网地址。这为 IP 配置提供了直接依据；教程使用内网开发地址，未承诺所有生产 HTTPS IP 场景。候选公网 IP 仍需验证当前后台是否接受配置、手机 HTTPS 访问及 H5 JSAPI 验签。[官方主页与 H5 IP 示例](https://open.feishu.cn/document/integrating-web-apps-in-5-minutes/step-4-configure-the-home-page-address?lang=zh-CN)、[官方重定向与 H5 IP 示例](https://open.feishu.cn/document/quickly-create-a-login-free-web-app/configure-the-web-application-access-address)

Let's Encrypt 自 2026 年 1 月 15 日起一般开放 IP 地址证书，IP 证书必须采用 `shortlived` 配置，有效期为 **160 小时**。本项目采用该方案时必须配置并验收自动续期、续期后代理重载及到期监测，不能依赖人工每周更新。证书必须覆盖实际访问 IP，且来自受信任的正式签发环境。[一般开放公告](https://letsencrypt.org/2026/01/15/6day-and-ip-general-availability)、[Certbot 自动续期与重载说明](https://letsencrypt.org/2026/03/11/shorter-certs-certbot)

由反向代理终止 HTTPS，并将请求转发至 `http://127.0.0.1:4173`。必须保留浏览器的 `Host`，使其与 `BASE_URL` 的主机部分一致；不能把 `Host` 改成 `localhost` 或容器名称，否则服务会返回 403。下例展示 Nginx 站点配置，示例域名和证书路径需替换为实际值：

```nginx
server {
    listen 443 ssl;
    server_name attendance.example.com;
    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:4173;
        proxy_set_header Host $http_host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

在飞书开放平台配置桌面端主页为 `BASE_URL/#schedules`、移动端主页为 `BASE_URL/#checkin`，登录回调为 `BASE_URL/auth/callback`，H5 可信域名填完整的 `BASE_URL`（示例 `https://attendance.example.com`，非标准端口需保留），并配置所需能力和可用人员范围。完整说明见 [飞书工作台接入配置](feishu-workbench.md)。正式模式初始数据为空，由管理员添加人员、绑定各自 Open ID，再设置真实地点和排班。

## 备份

正式数据保存在卷内 `/app/data/attendance.json`。定期备份到受限目录，并将备份另存至独立持久存储；不要把考勤记录提交到代码仓库。下面的命令复制一次当前数据快照，不会删除或修改在线记录：

```sh
mkdir -p backups
chmod 700 backups
docker cp custom-attendance:/app/data/attendance.json "backups/attendance-$(date +%Y%m%d-%H%M%S).json"
chmod 600 backups/attendance-*.json
```

首次成功启动后才会有数据文件。恢复时先停止应用，保留现有文件副本，再将确认可用的备份恢复到同一卷的 `attendance.json`，保持 `1000:1000` 所有权和 `600` 权限，然后启动。不要让旧实例与恢复后的实例同时写同一卷。

## 部署后验收

- HTTPS 根地址正常打开且证书有效、受信任，页面显示飞书登录；非登录用户不能读取人员或记录。若使用 IP 短期证书，确认自动续期与代理重载正常。
- 管理员能新增地点、人员和排班；普通员工只看到本人排班，不能代他人打卡或进入管理操作。
- 班次模板能生成个人排班；考勤统计区分待打卡与已过截止时间的缺卡，统计和导出可与记录核对。
- 用飞书手机端实测 A 上午 A 园区、下午 B 园区；分别验证正确地点通过、错误园区拒绝。
- 实测 100 米楼栋范围内、范围外及定位精度不足；核对地图中心与手机实际定位，检查 WGS84 / GCJ-02 转换及边界。
- 一次成功打卡仅产生一条记录，重复提交被拒绝，时间与导出记录正确。
- 重启容器后排班与记录仍在；重新登录后可继续使用，并确认已留存可恢复的备份。

请在自己的目标环境完成上述验收，并验证证书续期、反向代理、容器重启与数据恢复流程。自动测试和部署示例不代表实际企业环境已上线。

版本 0.2.0 引入三级角色与考勤组，首次启动自动把 v1 数据迁移为 v2。先备份数据并保留旧发布包；回退旧程序时需一并恢复 v1 备份。新增 `access.mjs` 及 `public/vendor/` 是运行文件，部署包不能遗漏。坐标转换库固定版本并附许可证；高德地图使用在线官方 JavaScript API 2.0，无需安装 npm 依赖。
