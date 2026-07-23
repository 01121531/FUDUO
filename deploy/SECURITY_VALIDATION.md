# 运行产物敏感信息验收

每次生产发布、备份生成和恢复演练后，扫描运行日志、数据库备份与 OpenClaw 状态归档：

```bash
pnpm security:scan-output -- \
  /path/to/runtime.log \
  /path/to/postgres.dump \
  /path/to/openclaw-state.tar.gz
```

脚本支持普通文件、PostgreSQL 自定义备份的原始字节扫描和 `.gz` 解压后扫描。发现未脱敏的 Bearer、JWT 或 Cookie 时会输出文件名和字节位置，并以非零状态退出；不会回显凭证原文。

默认不传路径时只扫描项目下的 `.runtime`，避免将 Playwright 报告等第三方测试资产误判为运行凭证。生产发布验收必须显式传入实际日志、PostgreSQL 备份和 OpenClaw 状态归档路径。
