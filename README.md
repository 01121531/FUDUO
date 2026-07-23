# 富多店铺智能助手

面向公司内部的云端经营数据与 AI 对话平台。系统通过富多 ERP API 获取店铺经营数据，并通过 Web 与 OpenClaw 微信私聊提供查询、对比和报表能力。

## 开发启动

先复制 `.env.example` 为 `.env`，配置 PostgreSQL、Redis、加密主密钥、内部服务密钥和富多授权所需环境。项目默认使用真实模式，不会在缺少配置或连接失败时回退到演示数据。

```bash
pnpm install
pnpm dev
```

- Web: `http://127.0.0.1:3000`
- API: `http://127.0.0.1:3001/api/health/live`

只有显式设置 `DEMO_MODE=true` 才会启用固定测试数据。该模式仅用于自动化测试和界面预览，Playwright 已在自身配置中显式启用。

### 数据实时性

- Worker 每 5 分钟同步销售、订单和退款，每 10 分钟同步店铺目录；
- 仪表盘在页面可见时每 30 秒重新读取 PostgreSQL 中的最新结果；
- “立即同步”会同时创建销售、订单和退款任务，并在任务结束后刷新页面；
- 当查询范围包含今天时，实时状态以今天的最近成功同步为准，已完整入库的历史日期不会因抓取时间较早而被误判为过期；
- 缺失日期、部分成功或最近一次尝试失败仍会明确显示为不完整或过期。

### 本地生产构建演示

Windows 上可启动已经构建的 API、Web、OpenClaw Gateway 与管理服务，验证实际生产产物而不是开发服务器：

```powershell
pnpm build
pnpm verify:runtime
pnpm demo:start
```

- 页面：`http://127.0.0.1:3100/dashboard`
- API 健康检查：`http://127.0.0.1:3001/api/health/live`
- OpenClaw Gateway：`http://127.0.0.1:18789/readyz`
- 微信接入：`http://127.0.0.1:3100/settings/wechat`
- 停止：`pnpm demo:stop`
- PID 与启动日志：`.runtime/`

`verify:runtime` 会使用工作区包的 `production` 导出启动编译后的 API，并等待健康检查成功；该步骤已经包含在 `pnpm verify:release` 中。

## 云端部署

1. 将 `deploy/.env.example` 复制为 `deploy/.env`，填写域名和随机密钥。
2. 把域名解析到服务器，并开放 TCP 80/443 与 UDP 443。
3. 在 `deploy` 目录执行 `docker compose up -d --build`。
4. 打开 `https://你的域名/login`，使用引导管理员账号、密码和 TOTP 登录。
5. 在“富多授权”完成企业微信扫码，在“模型管理”配置默认模型。
6. 进入 OpenClaw 容器完成 `@tencent-weixin/openclaw-weixin` 的微信扫码。员工发送首条私聊后，在网站“设置 → 微信接入”中选择内部员工并批准 pairing。

可在 Linux 服务器上生成部署密钥：

```bash
openssl rand -base64 32  # CREDENTIAL_MASTER_KEY_BASE64
openssl rand -hex 32     # INTERNAL_SERVICE_TOKEN
openssl rand -hex 32     # CAPTURE_UPLOAD_SECRET
openssl rand -hex 32     # OPENCLAW_GATEWAY_TOKEN
openssl rand -base64 36  # POSTGRES_PASSWORD / REDIS_PASSWORD / BACKUP_ENCRYPTION_PASSWORD
```

API、Worker 和 OpenClaw Admin 会在建立数据库、Redis 或监听端口前验证生产配置。缺少必要变量、继续使用示例占位值、主密钥不是 32 字节 Base64、生产环境启用演示模式、Web 来源不是精确 HTTPS Origin，或内部服务 URL/端口无效时，进程会立即退出；错误只包含变量名和原因，不输出变量值。

API、Worker、Web、OpenClaw 和 OpenClaw Admin 镜像均使用非 root `node` 用户。Compose 对业务容器启用只读根文件系统、移除全部 Linux capabilities、禁止提权，并只为 Chromium、Next 缓存和 OpenClaw 缓存提供有容量上限的临时目录。OpenClaw 持久状态位于共享卷的 `/home/node/.openclaw`。部署前可执行 `pnpm deploy:validate` 检查这些约束和环境变量文档是否完整。

部署变量中的 `BACKUP_ENCRYPTION_PASSWORD` 必须使用与数据库密码、主加密密钥不同的随机值，并至少包含 32 个字符。`backup` 容器启动后立即执行一次 `pg_dump`，随后按 `BACKUP_INTERVAL_SECONDS` 周期运行；备份以 AES-256-CBC/PBKDF2 加密后写入 `postgres-backups` 卷，默认保留 14 天。生成过程使用命名管道，数据库明文不会写入备份卷。

首次管理员由部署环境变量创建并启用 TOTP。登录后可在“设置 → 账号安全”中轮换身份验证器；轮换需要当前密码和当前动态码，新二维码确认成功后才会替换密钥，并撤销其他登录会话。

微信配对由仅限 Docker 内网访问的 `openclaw-admin:18790` 管理服务执行。它与 OpenClaw Gateway 共享 `openclaw-data` 卷，通过 `X-Internal-Service-Token` 鉴权，不经 Caddy，也不向公网发布端口。管理员可以在微信接入页面批准、撤销配对，并清理 OpenClaw 已批准但尚未绑定内部员工的异常授权。

OpenClaw 的模型固定指向 API 内部的 `fuduo-runtime/default`。API 会在每次微信请求时读取后台当前的默认和备用模型，因此切换模型后下一次请求即生效；模型供应商 API Key 只保存在加密数据库字段中，不复制到 OpenClaw 配置或共享卷。

## AI 扩展工厂

在 Web 对话中输入“创建一个 Skill……”或“生成一个 MCP……”，系统会调用后台模型生成扩展草案。也可以在“设置 → 扩展工厂”中明确选择 Skill 或 MCP 后填写需求。AI 只生成待审批草案，不会直接执行或安装代码。

草案会保存版本、文件包、工具定义和网络、环境变量、文件系统权限清单，并经过路径穿越、包体积、嵌入凭据、动态代码执行、子进程和破坏性文件操作检查。只有管理员可以确认安装或拒绝草案：

- Skill 安装到 OpenClaw workspace 的 `skills/<slug>`；
- MCP 安装到 `mcp/<slug>`，随后执行 `openclaw mcp set` 和 `openclaw mcp probe`；
- MCP 探测失败会撤销注册、恢复上一版本文件与注册，不会标记为已安装；
- 每个已审批版本归档到 OpenClaw 状态卷，并记录安装审计日志。

生产环境必须先配置模型管理中的分析模型，并保证 `openclaw-admin` 与 OpenClaw 共享状态卷。普通员工可以创建和查看自己的草案，只有带 `extensions:manage` 或 `*` 权限的管理员可以安装或拒绝。

## 在线更新

“设置 → 在线更新”会检查 GitHub 最新 Release 并显示当前版本、最新版本及适用命令。更新动作在宿主机执行，API 容器不挂载 Docker Socket。

Linux Docker 部署：

```bash
./deploy/update.sh --mode docker
./deploy/update.sh --mode docker --version v0.2.0
./deploy/update.sh --mode docker --rollback v0.1.0
```

Windows Docker 部署使用 `.\deploy\update.ps1 -Mode docker`。源码部署把 `docker` 改为 `source`；源码模式要求工作区无本地改动，并在目标服务器具备 Git、Node.js 和 pnpm。Release 工作流会构建并推送带版本标签的 GHCR 镜像，同时附加更新器压缩包和 SHA256 文件。

生产探针使用 `/api/health/live` 检查进程、使用 `/api/health/ready` 检查 PostgreSQL 与 Redis。Prometheus 文本指标位于 `/api/metrics`，生产环境必须使用 `Authorization: Bearer <INTERNAL_SERVICE_TOKEN>` 或 `X-Internal-Service-Token` 访问；指标不记录请求正文、Cookie、Authorization 或对话内容。

同步 Worker 在容器内的 `127.0.0.1:3002` 提供 `/health/live` 和 `/health/ready`。就绪探针同时检查 BullMQ Worker、PostgreSQL 和 Redis，任一不可用即返回 503；该端口不发布到宿主机或公网，仅供 Docker 健康检查使用。

登录、TOTP、富多二维码创建、插件凭证上报、Web Chat 和 OpenClaw 模型代理均启用 Redis 固定窗口限流。超限响应为 HTTP 429，错误码为 `RATE_LIMIT_EXCEEDED`，并包含 `Retry-After`；身份材料只以 SHA-256 摘要写入 Redis 键。生产环境 Redis 不可用时这些敏感入口默认拒绝请求，健康检查同时进入未就绪状态，普通只读查询和健康探针不受限流影响。

生产模式会把登录结果、经营查询、店铺查询、同步操作、富多授权、Web Chat 和报表读取写入追加式审计日志。审计事件仅保存用户、动作、路由模板、HTTP 状态、资源 ID、耗时和 Trace ID，不保存 URL 查询串、请求正文、Authorization、Cookie 或聊天内容；同一 Trace ID 可关联一条链路中的多个审计和工具事件。

## 备份与恢复

查看备份状态和文件：

```bash
docker compose ps backup
docker compose exec backup ls -lh /backups
```

每个 `*.dump.enc` 都附带 SHA256 文件。恢复前先在备份容器中解密并检查归档目录，不产生明文文件：

```bash
docker compose run --rm --no-deps --entrypoint sh \
  -e RESTORE_FILE=fuduo-YYYYMMDDTHHMMSSZ.dump.enc backup -c '
    test -f "/backups/$RESTORE_FILE" &&
    openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -md sha256 \
      -pass env:BACKUP_ENCRYPTION_PASSWORD -in "/backups/$RESTORE_FILE" |
    pg_restore --list >/dev/null
  '
```

正式恢复时应先恢复到新建的空数据库并完成核对，再安排维护窗口切换，不能直接覆盖正在运行的主库。`postgres-backups` 仍位于同一服务器，生产环境还应定期把加密文件和 SHA256 文件同步到受控的异机或对象存储。

销售、订单和退款请求由云端 API/Worker 直接发送；Windows 捕获插件只作为 Authorization 上报兜底，不转发业务请求。订单和退款当前使用富多聚合接口 `/api/v1/ops/orders/list` 与 `/api/v1/ops/aftersales/list`，按北京时间自然日分页汇总并写入 `order_daily`、`refund_daily`。Worker 每天凌晨统一校正最近 7 天的销售、订单和退款，并把全部日期和数据类型累计为一条同步运行记录。

富多 GET 及已声明为只读幂等的订单、售后 POST 查询会对瞬时错误执行有界退避；核心定时同步、网页手动同步和定时报表均配置最多 3 次 BullMQ 尝试。登录、Token 刷新和店铺会话准备 POST 不自动重放。

销售、订单和退款按“数据类型 + 富多店铺 ID + 北京时间业务日”获取 Redis 租约，避免定时任务与手动任务重复执行同一单店同步。部分失败在剩余尝试期间显示为“等待重试”，最后一次仍失败才固定为“部分成功”或“失败”。

定时任务首次执行后会把 `SyncRun` ID 写回 BullMQ job data，因此一次任务的全部重试共享同一条运行记录，不会留下永久“等待重试”的孤立记录。

富多凭证进入 `REAUTH_REQUIRED` 后，销售、订单和退款任务在批量并发前停止，不再逐店发送无效请求。Worker 通过内部鉴权接口通知仍有效配对的管理员微信账号，并按 `tokenVersion` 在 Redis 中去重；告警正文不包含 Authorization 或其他凭证。

`ERP_REAUTH_REQUIRED` 和 `ERP_TOKEN_MISSING` 会被标记为 BullMQ 不可恢复错误，不消耗剩余任务尝试；重新扫码写入新凭证后，后续定时任务自动恢复。

捕获插件上报 `POST /api/fuduo/credential/upload` 时必须发送毫秒时间戳 `X-Capture-Timestamp`，并用 `CAPTURE_UPLOAD_SECRET` 对 `时间戳 + "." + Authorization` 计算 SHA-256 HMAC，放入 `X-Capture-Signature`。服务端只接受 5 分钟内的签名请求。

## 方案文档

- [总体开发方案](./FUDUO_CLOUD_ASSISTANT_PLAN.md)
- [UI/UX 设计方案](./UI_UX_DESIGN_PLAN.md)
- [项目设计逻辑](./PROJECT_DESIGN_LOGIC.md)
- [实施状态与生产验收缺口](./IMPLEMENTATION_STATUS.md)
