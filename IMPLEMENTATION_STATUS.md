# 富多店铺智能助手实施状态

更新时间：2026-07-24

本文件将三份方案中的交付项映射到当前代码和验收证据。状态含义：

- `已验证（本地）`：实现存在，并由当前工作区自动化测试或构建证明。
- `待真实环境验收`：实现存在，但必须连接真实富多、腾讯微信、模型、PostgreSQL/Redis 或云服务器才能证明。
- `未完成`：当前实现或证据仍缺失，不能用于生产发布。

## 交付矩阵

| 范围 | 状态 | 实现证据 | 当前验收证据 |
| --- | --- | --- | --- |
| Monorepo、API、Web、Worker、数据库、Redis/BullMQ 边界 | 已验证（本地） | `apps/`、`packages/`、`plugins/` | `pnpm typecheck`、`pnpm build` |
| 内部登录、TOTP、RBAC、店铺权限、审计 | 已验证（本地） | `apps/api/src/modules/auth`、`audit`、`settings` | API 单元测试 |
| Credential Vault、Token 校验/刷新/撤销、插件上传 | 已验证（本地） | `apps/api/src/modules/credentials`、`packages/credential-vault` | 凭证、HMAC、刷新竞态测试 |
| 富多二维码隔离浏览器、SSE、取消/过期/终态清理 | 待真实环境验收 | `apps/api/src/modules/qr-session` | 状态机和 URL 策略测试；缺真实扫码证据 |
| 富多 SDK Schema 与客户端行为 | 已验证（本地） | `packages/fuduo-sdk` | 合成脱敏 Fixture 契约测试 |
| 富多真实响应兼容性、云端出口、Token 刷新、销售口径 | 待真实环境验收 | `packages/fuduo-sdk/contracts/manifest.json` | 所有条目仍为 `realResponseVerified: false` |
| PDD 会话、请求边界和代理传输接口 | 已验证（本地） | `packages/pdd-sdk` | 合成 Fixture、主机/路径/Header/重试测试 |
| PDD 真实业务端点、Cookie 与出口绑定 | 未完成 | `packages/pdd-sdk/contracts/manifest.json` | 缺批准端点、真实脱敏响应和代理绑定实验 |
| 店铺、销售、订单、退款同步与 7 天校正 | 已验证（本地） | `apps/worker/src/sync-service.ts` | Worker 单元测试 |
| PostgreSQL + Redis + BullMQ 幂等、锁与并发 | 待真实环境验收 | `apps/worker`、`packages/database` | 当前仅 mock 测试；缺容器化集成测试结果 |
| Dashboard、店铺详情、图表、数据新鲜度 | 已验证（本地） | `apps/web/app/(workspace)`、`components` | Web 单测与四视口 Playwright |
| Web Chat、只读工具、模型路由和备用模型 | 已验证（本地） | `apps/api/src/modules/chat`、`models`、`tools` | API 单测和 Demo E2E |
| AI 对话生成 Skill/MCP 草案、校验、审批、安装和失败回滚 | 已验证（本地） | `apps/api/src/modules/extensions`、`apps/openclaw-admin/src/extension-installer.ts`、`apps/web/components/extension-workbench.tsx` | API 与 OpenClaw Admin 单元测试、OpenClaw MCP CLI 检查 |
| 真实模型供应商与 Token 用量指标 | 待真实环境验收 | `apps/api/src/modules/models` | 缺真实供应商调用；`model_tokens_total` 尚无可靠数据源 |
| OpenClaw 微信私聊、pairing、白名单、昵称和状态 | 待真实环境验收 | `apps/openclaw-admin`、`plugins/openclaw-fuduo` | 本地管理协议测试；缺腾讯账号实测 |
| 日报、周报、计划和渠道投递 | 已验证（本地） | `apps/api/src/modules/reports`、`apps/worker/src/report-*` | 单元测试和 Demo E2E |
| Docker Compose、HTTPS、迁移、健康检查、加密备份 | 已验证（静态） | `deploy/` | `pnpm deploy:validate`；缺实际容器启动和恢复 |
| GitHub Release、GHCR 镜像、在线版本检查和宿主机更新/回滚脚本 | 已验证（静态） | `.github/workflows/release.yml`、`deploy/update.*` | `v0.1.0` 云端镜像构建成功；更新器待目标服务器演练 |
| 日志/备份敏感值扫描 | 已验证（工具） | `scripts/scan-sensitive-output.mjs` | 脚本测试与本地 `.runtime` 扫描 |
| 生产日志、PostgreSQL 备份、OpenClaw 归档扫描 | 待真实环境验收 | `deploy/SECURITY_VALIDATION.md` | 必须对部署产物显式执行扫描 |

## 本地发布门禁

```bash
pnpm verify:release
```

门禁依次生成 Prisma Client，执行全仓类型检查、单元/契约测试、生产构建、部署配置校验、Playwright E2E 和默认运行产物敏感扫描。

2026-07-24 最近一次本地验证：

- 11 个工作区包类型检查通过；
- 360 项业务单元/契约测试与 3 项敏感输出扫描器测试通过；
- 11 个工作区包生产构建通过；
- 编译后的 API 使用 `production` 工作区导出启动并通过健康检查；
- 74 项 Playwright E2E 通过，包含扩展工厂完整安装流程及新页面四视口检查；
- 默认 `.runtime` 敏感输出扫描与 CI YAML 解析通过。

Playwright 使用 `DEMO_MODE=true` 和 `REQUIRE_AUTH=false`，只能证明页面与本地业务交互，不替代真实登录、扫码、数据库、模型和微信验收。

## 生产发布阻塞项

1. 在目标云服务器记录富多云端 IP 可达性，并把授权后的真实响应脱敏为 `observed-redacted` Fixture。
2. 完成企业微信富多二维码扫码、数字确认、取消、过期、重复扫码和 Token 刷新全链路。
3. 对同日期销售、订单、退款与富多客户端进行逐店对账。
4. 明确 PDD 业务端点，并验证 Cookie 是否绑定代理、设备或出口 IP。
5. 在 PostgreSQL、Redis、BullMQ 容器上执行 10 店并发、重复同步、部分失败和恢复集成测试。
6. 用真实模型、OpenClaw Gateway 和腾讯微信账号完成私聊、pairing、撤销和报表投递。
7. 完成镜像构建、迁移、健康检查、故障演练、加密备份与异机恢复，记录 RPO/RTO。
8. 显式扫描生产日志、数据库备份和 OpenClaw 状态归档，并保存不含凭证明文的验收结果。
