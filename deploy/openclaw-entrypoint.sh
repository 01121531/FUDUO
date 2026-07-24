#!/bin/sh
set -eu

OPENCLAW="pnpm --filter @fuduo/openclaw-fuduo exec openclaw"

# OpenClaw validates plugin configuration after every write. Load the plugin,
# its required settings and the internal model atomically so no invalid
# intermediate configuration can prevent a fresh container from starting.
$OPENCLAW config set --batch-file /app/deploy/openclaw-model-config.batch.json --replace

# The WeChat agent is a read-only business assistant. Keep every built-in
# filesystem, runtime, browser, network and agent tool outside its policy.
$OPENCLAW config set tools.profile full
$OPENCLAW config set tools.allow \
  '["list_shops","get_shop_sales","compare_shop_sales","rank_shops_by_sales","get_sales_summary","get_shop_orders","get_shop_refunds","generate_daily_report","generate_weekly_report","get_data_freshness","get_sync_status","*__*"]' \
  --strict-json
$OPENCLAW config set tools.deny \
  '["group:openclaw","group:fs","group:runtime","canvas"]' \
  --strict-json

if ! $OPENCLAW plugins inspect openclaw-weixin --runtime --json >/dev/null 2>&1; then
  $OPENCLAW plugins install @tencent-weixin/openclaw-weixin@2.4.6 --force
fi

$OPENCLAW config set plugins.entries.openclaw-weixin.enabled true
$OPENCLAW config set session.dmScope per-account-channel-peer
$OPENCLAW config set channels.openclaw-weixin.dmPolicy pairing
$OPENCLAW config set logging.redactSensitive tools
$OPENCLAW config set gateway.auth.mode token
$OPENCLAW config set gateway.auth.token \
  --ref-provider default \
  --ref-source env \
  --ref-id OPENCLAW_GATEWAY_TOKEN
$OPENCLAW config validate
$OPENCLAW plugins inspect fuduo-business --runtime --json >/dev/null

exec $OPENCLAW gateway run \
  --allow-unconfigured \
  --bind lan \
  --port 18789 \
  --auth token \
  --ws-log compact
