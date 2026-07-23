export const demoDashboard = {
  period: "today",
  range: { period: "today", start: "2026-07-21", end: "2026-07-21", previousStart: "2026-07-20", previousEnd: "2026-07-20", dayCount: 1, label: "今天", comparisonLabel: "较昨天" },
  summary: { salesAmount: 62783.55, transactionCount: 1066, payBuyerCount: 991, refundAmount: 2010.3, averageOrderValue: 58.9, includedShops: 5, missingShops: [], partial: false },
  changes: { salesAmount: 0.097, transactionCount: 0.062, payBuyerCount: 0.058, refundAmount: -0.084, averageOrderValue: 0.034 },
  rankings: [
    { shopId: 10218, shopName: "云野生活馆", tradeDate: "2026-07-21", salesAmount: 18642.3, transactionCount: 328, payBuyerCount: 305, averageOrderValue: 56.84, refundAmount: 642.8, freshness: "LIVE", dataAsOf: "2026-07-21T08:35:00.000Z" },
    { shopId: 10232, shopName: "拾光家居", tradeDate: "2026-07-21", salesAmount: 15480.2, transactionCount: 271, payBuyerCount: 252, averageOrderValue: 57.12, refundAmount: 388.5, freshness: "LIVE", dataAsOf: "2026-07-21T08:35:00.000Z" },
    { shopId: 10257, shopName: "简物优选", tradeDate: "2026-07-21", salesAmount: 12690.45, transactionCount: 206, payBuyerCount: 192, averageOrderValue: 61.6, refundAmount: 521.2, freshness: "LIVE", dataAsOf: "2026-07-21T08:35:00.000Z" },
    { shopId: 10271, shopName: "晴川百货", tradeDate: "2026-07-21", salesAmount: 8642, transactionCount: 142, payBuyerCount: 132, averageOrderValue: 60.86, refundAmount: 292, freshness: "STALE", dataAsOf: "2026-07-21T07:01:00.000Z" },
    { shopId: 10305, shopName: "良品日用", tradeDate: "2026-07-21", salesAmount: 7328.6, transactionCount: 119, payBuyerCount: 110, averageOrderValue: 61.58, refundAmount: 165.8, freshness: "LIVE", dataAsOf: "2026-07-21T08:35:00.000Z" },
  ],
  trend: [
    { date: "07-15", sales: 48210, previous: 45180 },
    { date: "07-16", sales: 52140, previous: 47620 },
    { date: "07-17", sales: 49780, previous: 48830 },
    { date: "07-18", sales: 58620, previous: 51420 },
    { date: "07-19", sales: 54880, previous: 53690 },
    { date: "07-20", sales: 60120, previous: 55940 },
    { date: "07-21", sales: 62783.55, previous: 57240 },
  ],
  freshness: "STALE",
  dataAsOf: "2026-07-21T08:35:00.000Z",
  alerts: [
    { id: "alert-1", level: "warning", title: "晴川百货数据已过期", detail: "最后成功同步于 1 小时 34 分钟前" },
    { id: "alert-2", level: "info", title: "退款金额较昨日下降 8.4%", detail: "当前累计退款 ¥2,010.30" },
  ],
};

export const demoShops = demoDashboard.rankings.map((item, index) => ({
  id: item.shopId,
  accountId: 2255 + index,
  name: item.shopName,
  platform: "pdd",
  loginStatus: item.freshness === "STALE" ? "待重新登录" : "正常",
  todaySales: item.salesAmount,
  todayOrders: item.transactionCount,
  refundAmount: item.refundAmount,
  lastSyncedAt: item.dataAsOf,
}));
