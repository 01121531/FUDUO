import type { SalesMetric } from "@fuduo/shared";

export interface SalesSummary {
  salesAmount: number;
  transactionCount: number;
  payBuyerCount: number;
  refundAmount: number;
  averageOrderValue: number | null;
  includedShops: number;
  missingShops: string[];
  partial: boolean;
}

export function summarizeSales(metrics: SalesMetric[]): SalesSummary {
  const valid = metrics.filter((metric) => metric.salesAmount !== null);
  const transactionCount = valid.reduce((sum, item) => sum + (item.transactionCount ?? 0), 0);
  const salesAmount = sumMoney(valid.map((item) => item.salesAmount));
  const refundAmount = sumMoney(valid.map((item) => item.refundAmount));

  return {
    salesAmount,
    transactionCount,
    payBuyerCount: valid.reduce((sum, item) => sum + (item.payBuyerCount ?? 0), 0),
    refundAmount,
    averageOrderValue: transactionCount > 0 ? Math.round((salesAmount / transactionCount) * 100) / 100 : null,
    includedShops: valid.length,
    missingShops: metrics.filter((metric) => metric.salesAmount === null).map((metric) => metric.shopName),
    partial: valid.length !== metrics.length,
  };
}

function sumMoney(values: Array<number | null>): number {
  const cents = values.reduce<number>((sum, value) => sum + Math.round((value ?? 0) * 100), 0);
  return cents / 100;
}

export function rankBySales(metrics: SalesMetric[]): SalesMetric[] {
  return [...metrics].sort((a, b) => (b.salesAmount ?? -Infinity) - (a.salesAmount ?? -Infinity));
}

export function calculateChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return (current - previous) / previous;
}
