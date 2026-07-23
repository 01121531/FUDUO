import { FuduoApiError, type FuduoClient, type OpsAfterSales, type OpsOrder } from "@fuduo/fuduo-sdk";

interface PaginationOptions {
  pageSize?: number;
  maxPages?: number;
}

type OrdersClient = Pick<FuduoClient, "listOrders">;
type AfterSalesClient = Pick<FuduoClient, "listAfterSales">;

export interface OrderDailyAggregate {
  orderCount: number;
  paidOrderCount: number;
  paidAmount: number | null;
}

export interface RefundDailyAggregate {
  refundCount: number;
  refundAmount: number | null;
}

export async function collectOrderDaily(
  client: OrdersClient,
  shopId: number,
  tradeDate: string,
  options: PaginationOptions = {},
): Promise<OrderDailyAggregate> {
  const window = shanghaiDayWindow(tradeDate);
  const records = await collectPages<OpsOrder>(
    (page, size) => client.listOrders(shopId, window.startAt, window.endAt, page, size),
    options,
    (record) => record.platformOrderId ?? null,
    (record) => assertRecordContext(record, shopId, window),
  );
  const paid = records.filter((record) => isPaidOrder(record));
  return {
    orderCount: records.length,
    paidOrderCount: paid.length,
    paidAmount: completeMoneyTotal(paid.map((record) => record.payAmount)),
  };
}

export async function collectRefundDaily(
  client: AfterSalesClient,
  shopId: number,
  tradeDate: string,
  options: PaginationOptions = {},
): Promise<RefundDailyAggregate> {
  const window = shanghaiDayWindow(tradeDate);
  const records = await collectPages<OpsAfterSales>(
    (page, size) => client.listAfterSales(shopId, window.startAt, window.endAt, page, size),
    options,
    (record) => record.platformRefundId ?? null,
    (record) => assertRecordContext(record, shopId, window),
  );
  return {
    refundCount: records.length,
    refundAmount: completeMoneyTotal(records.map((record) => record.refundAmount)),
  };
}

export function shanghaiDayWindow(tradeDate: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tradeDate)) throw new Error("SYNC_TRADE_DATE_INVALID");
  const start = new Date(`${tradeDate}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime()) || formatShanghaiDate(start) !== tradeDate) throw new Error("SYNC_TRADE_DATE_INVALID");
  return {
    startAt: start.toISOString(),
    endAt: new Date(start.getTime() + 86_400_000 - 1).toISOString(),
  };
}

async function collectPages<T>(
  load: (page: number, size: number) => Promise<{ records: T[]; total?: number | undefined; page?: number | undefined; size?: number | undefined }>,
  options: PaginationOptions,
  recordKey: (record: T) => string | null,
  validateRecord: (record: T) => void,
) {
  const size = options.pageSize ?? 100;
  const maximum = options.maxPages ?? 500;
  if (!Number.isInteger(size) || size < 1 || size > 500 || !Number.isInteger(maximum) || maximum < 1) {
    throw new Error("SYNC_PAGINATION_INVALID");
  }
  const records: T[] = [];
  const seenKeys = new Set<string>();
  let received = 0;
  for (let page = 1; page <= maximum; page += 1) {
    const result = await load(page, size);
    if (result.page !== undefined && result.page !== page) {
      throw new FuduoApiError("ERP_PAGINATION_INVALID", "富多经营列表返回了错误页码", 502);
    }
    if (result.size !== undefined && (!Number.isInteger(result.size) || result.size < 1)) {
      throw new FuduoApiError("ERP_PAGINATION_INVALID", "富多经营列表返回了无效分页大小", 502);
    }
    if (result.total !== undefined && (!Number.isInteger(result.total) || result.total < 0)) {
      throw new FuduoApiError("ERP_PAGINATION_INVALID", "富多经营列表返回了无效总数", 502);
    }
    received += result.records.length;
    for (const record of result.records) {
      validateRecord(record);
      const key = recordKey(record);
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);
      records.push(record);
    }
    if (result.total !== undefined) {
      if (received >= result.total) return records;
      if (result.records.length === 0) throw new FuduoApiError("ERP_PAGINATION_INVALID", "富多经营列表在读取完整前返回空页", 502);
      continue;
    }
    if (result.records.length === 0 || result.records.length < (result.size ?? size)) return records;
  }
  throw new FuduoApiError("ERP_PAGINATION_LIMIT", "富多经营列表分页超过安全限制", 502);
}

function assertRecordContext(
  record: { businessShopId?: number | undefined; platformOccurredAt?: string | null | undefined },
  shopId: number,
  window: { startAt: string; endAt: string },
) {
  if (record.businessShopId !== undefined && record.businessShopId !== shopId) {
    throw new FuduoApiError("ERP_RECORD_CONTEXT_MISMATCH", "富多经营记录属于其他店铺", 502);
  }
  if (record.platformOccurredAt) {
    const occurredAt = Date.parse(record.platformOccurredAt);
    if (!Number.isFinite(occurredAt) || occurredAt < Date.parse(window.startAt) || occurredAt > Date.parse(window.endAt)) {
      throw new FuduoApiError("ERP_RECORD_CONTEXT_MISMATCH", "富多经营记录不属于请求业务日期", 502);
    }
  }
}

function isPaidOrder(record: OpsOrder) {
  if (record.payAmount !== null) return true;
  const status = record.orderStatus === null ? "" : String(record.orderStatus).trim().toUpperCase();
  return new Set(["1", "2", "3", "PAID", "PENDING", "SHIPPED", "SIGNED", "RECEIVED", "SUCCESS"]).has(status);
}

function completeMoneyTotal(values: Array<number | null>) {
  if (values.length === 0) return 0;
  let cents = 0;
  for (const value of values) {
    if (value === null || !Number.isFinite(value)) return null;
    cents += Math.round(value * 100);
  }
  return cents / 100;
}

function formatShanghaiDate(date: Date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}
