export interface ReportAccessScope {
  permissions: string[];
  allShops: boolean;
  shopIds: string[];
}

export function canReceiveReport(scope: ReportAccessScope, reportShopIds: string[]) {
  if (!scope.permissions.includes("*") && !scope.permissions.includes("reports:read")) return false;
  if (scope.allShops) return true;
  if (!reportShopIds.length) return false;
  const allowed = new Set(scope.shopIds);
  return reportShopIds.every((shopId) => allowed.has(shopId));
}
