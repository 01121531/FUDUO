#!/bin/sh
set -eu

OPENCLAW="pnpm --filter @fuduo/openclaw-fuduo exec openclaw"

$OPENCLAW config set plugins.load.paths '["/app/plugins/openclaw-fuduo"]' --strict-json
$OPENCLAW config set plugins.entries.fuduo-business.enabled true
$OPENCLAW config set plugins.entries.fuduo-business.config.apiBaseUrl http://api:3001/api
$OPENCLAW config set plugins.entries.fuduo-business.config.serviceToken \
  --ref-provider default \
  --ref-source env \
  --ref-id FUDUO_INTERNAL_SERVICE_TOKEN

# The WeChat agent is a read-only business assistant. Keep every built-in
# filesystem, runtime, browser, network and agent tool outside its policy.
$OPENCLAW config set tools.profile full
$OPENCLAW config set tools.allow \
  '["list_shops","get_shop_sales","compare_shop_sales","rank_shops_by_sales","get_sales_summary","get_shop_orders","get_shop_refunds","generate_daily_report","generate_weekly_report","get_data_freshness","get_sync_status","*__*"]' \
  --strict-json
$OPENCLAW config set tools.deny \
  '["group:openclaw","group:fs","group:runtime","canvas"]' \
  --strict-json

# OpenClaw only sees a fixed internal model. The API resolves the currently
# selected default and fallback profiles for every request.
$OPENCLAW config set --batch-file /app/deploy/openclaw-model-config.batch.json --replace

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
