# 备份恢复与演练手册

本文命令均在 `deploy/` 目录执行。恢复服务属于 Compose 的 `recovery` profile，不会随正常的 `docker compose up` 启动，也不会直接写入当前生产数据库或 OpenClaw 在线状态卷。

## 1. 恢复前检查

1. 保留 `deploy/.env`、`CREDENTIAL_MASTER_KEY_BASE64` 和 `BACKUP_ENCRYPTION_PASSWORD` 的受控副本。数据库恢复后仍需要原主密钥解密其中的凭证。
2. 确认 PostgreSQL 和 OpenClaw 最近一次备份健康：

   ```bash
   docker compose ps backup openclaw-backup
   docker compose exec backup find /backups -maxdepth 1 -name 'fuduo-*.dump.enc' -printf '%f\n'
   docker compose exec openclaw-backup find /backups -maxdepth 1 -name 'openclaw-*.tar.gz.enc' -printf '%f\n'
   ```

3. 加密文件和同名 `.sha256` 必须成对存在。备份密码、数据库密码和加密主密钥不能互相替代。
4. `postgres-backups` 与 `openclaw-backups` 是本机卷；必须另行把密文及 `.sha256` 同步到受控异机或对象存储，并定期从异机副本执行本手册的演练。

## 2. 只验证备份

验证会先检查 SHA256，再通过管道解密并读取归档目录，不会把明文写到磁盘：

```bash
docker compose --profile recovery run --rm --no-deps \
  postgres-restore --verify fuduo-YYYYMMDDTHHMMSSZ.dump.enc

docker compose --profile recovery run --rm --no-deps \
  openclaw-state-restore --verify openclaw-YYYYMMDDTHHMMSSZ.tar.gz.enc
```

输出必须分别为 `{"status":"verified",...}`。校验和、密码或归档任一不正确都会返回非零状态。

## 3. PostgreSQL 隔离恢复演练

恢复脚本拒绝把归档写回 `POSTGRES_DATABASE` 当前指向的数据库。目标名称和二次确认必须完全一致：

```bash
docker compose --profile recovery run --rm \
  -e RESTORE_TARGET_DB=fuduo_restore_20260723 \
  -e RESTORE_CONFIRM_DATABASE=fuduo_restore_20260723 \
  postgres-restore --restore fuduo-YYYYMMDDTHHMMSSZ.dump.enc
```

脚本恢复到新数据库后检查 `_prisma_migrations` 存在且没有未完成迁移。随后用当前镜像补齐迁移并验证最终状态：

```bash
docker compose run --rm --no-deps \
  -e RESTORE_TARGET_DB=fuduo_restore_20260723 \
  --entrypoint sh migrate -ec '
    DATABASE_URL="${DATABASE_URL%/*}/$RESTORE_TARGET_DB"
    export DATABASE_URL
    pnpm --filter @fuduo/database db:deploy
    pnpm --filter @fuduo/database db:status
  '
```

正常部署中的 `migrate` 服务同样依次运行 `db:deploy` 和 `db:status`；API 与 Worker 只在它以 `service_completed_successfully` 结束后启动。

至少核对以下内容：管理员可登录；店铺、销售、订单和退款计数合理；审计记录可查询；加密凭证能用原 `CREDENTIAL_MASTER_KEY_BASE64` 解密。演练数据库通过验收前不要删除原备份。

需要切换到演练数据库时，先停止写入服务，在 `deploy/.env` 中把 `POSTGRES_DATABASE` 改为已验收的目标名，然后运行 `docker compose up -d migrate api worker web`。确认健康后再恢复 Caddy 流量；旧数据库保留到回滚窗口结束。

## 4. OpenClaw 状态隔离恢复演练

OpenClaw 归档只允许恢复到 `/restore`，该路径对应专用 `openclaw-restore-data` 卷，不会覆盖在线 `openclaw-data`：

```bash
docker compose --profile recovery run --rm --no-deps \
  -e RESTORE_CONFIRM_PATH=/restore \
  -e RESTORE_REPLACE=true \
  openclaw-state-restore --restore openclaw-YYYYMMDDTHHMMSSZ.tar.gz.enc
```

检查恢复内容时不要输出账号令牌或完整配置：

```bash
docker compose --profile recovery run --rm --no-deps \
  --entrypoint sh openclaw-state-restore -ec \
  'find /restore -maxdepth 2 -type f -printf "%P\n" | sort'
```

验收微信账号状态、pairing 文件和 OpenClaw 配置存在后，停止 `openclaw`、`openclaw-admin` 与 `openclaw-backup`，把 `deploy/.env` 的 `OPENCLAW_STATE_VOLUME` 改为 `openclaw-restore-data`，再启动三项服务。Gateway 和 Admin 健康后完成一次公司微信私聊查询。原状态卷保留到回滚窗口结束。

## 5. 演练记录

每月至少演练一次，并记录：归档时间、异机来源、校验结果、恢复开始/结束时间、迁移状态、抽样数据结果、OpenClaw 私聊结果、实际 RPO/RTO 和执行人。任何一步失败都必须保留密文归档和日志，不能用新的失败结果覆盖最近一次成功记录。
