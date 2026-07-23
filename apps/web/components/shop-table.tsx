import Link from "next/link";
import { formatCurrency } from "@fuduo/shared";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { StatusBadge } from "./status-badge";
import {
  freshnessOf,
  nextShopSort,
  shopSortState,
  type ShopRow,
  type ShopSort,
  type ShopSortColumn,
} from "./shops-utils";

export type { ShopRow } from "./shops-utils";

interface ShopTableProps {
  shops: ShopRow[];
  sort: ShopSort;
  onSortChange: (sort: ShopSort) => void;
}

export function ShopTable({ shops, sort, onSortChange }: ShopTableProps) {
  return (
    <div className="data-table-wrap">
      <table className="data-table desktop-table">
        <thead>
          <tr>
            <SortableHeader column="NAME" label="店铺" sort={sort} onSortChange={onSortChange} />
            <th>平台</th><th>shopId</th><th>accountId</th><th>登录状态</th>
            <SortableHeader className="number" column="SALES" label="今日销售额" sort={sort} onSortChange={onSortChange} />
            <SortableHeader className="number" column="ORDERS" label="订单量" sort={sort} onSortChange={onSortChange} />
            <SortableHeader className="number" column="REFUNDS" label="退款金额" sort={sort} onSortChange={onSortChange} />
            <SortableHeader column="SYNCED" label="最近同步" sort={sort} onSortChange={onSortChange} />
          </tr>
        </thead>
        <tbody>
          {shops.map((shop) => (
            <tr key={shop.id}>
              <td><Link className="table-link" href={`/shops/${shop.id}`}>{shop.name}</Link></td>
              <td>拼多多</td>
              <td className="tabular">{shop.id}</td>
              <td className="tabular">{shop.accountId ?? "—"}</td>
              <td><StatusBadge status={shop.loginStatus ?? "未知"} /></td>
              <td className="number">{formatCurrency(shop.todaySales)}</td>
              <td className="number">{shop.todayOrders?.toLocaleString("zh-CN") ?? "—"}</td>
              <td className="number">{formatCurrency(shop.refundAmount)}</td>
              <td className="muted">{shop.lastSyncedAt ? new Date(shop.lastSyncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "从未同步"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mobile-shop-list">
        {shops.map((shop) => (
          <Link href={`/shops/${shop.id}`} className="mobile-shop-row" key={shop.id}>
            <span className="mobile-shop-main"><strong>{shop.name}</strong><small>{shop.id} · 拼多多</small><span className="mobile-shop-status"><StatusBadge status={shop.loginStatus ?? "未知"} /><StatusBadge status={freshnessOf(shop)} /></span><small>最近同步 {shop.lastSyncedAt ? new Date(shop.lastSyncedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "从未同步"}</small></span>
            <span className="mobile-shop-values"><small>今日销售额</small><strong>{formatCurrency(shop.todaySales)}</strong><small>{shop.todayOrders ?? "—"} 笔订单</small><small>退款 {formatCurrency(shop.refundAmount)}</small></span>
          </Link>
        ))}
      </div>
    </div>
  );
}

interface SortableHeaderProps {
  column: ShopSortColumn;
  label: string;
  sort: ShopSort;
  onSortChange: (sort: ShopSort) => void;
  className?: string;
}

function SortableHeader({ column, label, sort, onSortChange, className }: SortableHeaderProps) {
  const state = shopSortState(sort);
  const active = state.column === column;
  const nextSort = nextShopSort(sort, column);
  const nextDirection = shopSortState(nextSort).direction;
  const ariaSort = active ? state.direction === "ASC" ? "ascending" : "descending" : undefined;
  const Icon = !active ? ArrowUpDown : state.direction === "ASC" ? ArrowUp : ArrowDown;

  return (
    <th className={className} aria-sort={ariaSort}>
      <button
        className="shop-sort-button"
        type="button"
        aria-label={`${label}：${active ? `当前${directionLabel(state.direction)}，` : ""}按${directionLabel(nextDirection)}排序`}
        onClick={() => onSortChange(nextSort)}
      >
        <span>{label}</span>
        <Icon size={14} aria-hidden="true" />
      </button>
    </th>
  );
}

function directionLabel(direction: "ASC" | "DESC") {
  return direction === "ASC" ? "升序" : "降序";
}
