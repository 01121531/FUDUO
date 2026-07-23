"use client";

import { useEffect, useId, useRef } from "react";
import type { ECharts, EChartsOption } from "echarts";
import { formatCurrency } from "@fuduo/shared";

export interface SalesChartPoint {
  date: string;
  sales: number | null;
  previous: number | null;
}

export function SalesChart({
  data,
  label = "销售趋势图",
  currentName = "本期销售",
  previousName = "上期同期",
  dataAsOf = null,
  valueKind = "currency",
}: {
  data: SalesChartPoint[];
  label?: string;
  currentName?: string;
  previousName?: string;
  dataAsOf?: string | null;
  valueKind?: "currency" | "number";
}) {
  const root = useRef<HTMLDivElement>(null);
  const descriptionId = useId();

  useEffect(() => {
    if (!root.current) return;
    let chart: ECharts | undefined;
    let disposed = false;
    let observer: ResizeObserver | undefined;
    void import("echarts").then((echarts) => {
      if (disposed || !root.current) return;
      chart = echarts.init(root.current);
      chart.setOption(buildOption(data, currentName, previousName, dataAsOf, valueKind));
      observer = new ResizeObserver(() => chart?.resize());
      observer.observe(root.current);
    });
    return () => {
      disposed = true;
      observer?.disconnect();
      chart?.dispose();
    };
  }, [data, currentName, previousName, dataAsOf, valueKind]);

  const summary = data.length
    ? `${label}，统计日期从 ${data[0]?.date} 到 ${data.at(-1)?.date}。`
    : `${label}，当前没有可展示的数据。`;

  return (
    <div className="chart-with-data">
      <p id={descriptionId} className="sr-only">{summary}</p>
      <div
        ref={root}
        className="business-chart"
        role="img"
        aria-label={label}
        aria-describedby={descriptionId}
      />
      <details className="chart-data-table">
        <summary>查看图表数据</summary>
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr><th>统计日期</th><th className="number">{currentName}</th><th className="number">{previousName}</th><th className="number">变化率</th></tr>
            </thead>
            <tbody>
              {data.map((point) => (
                <tr key={point.date}>
                  <td>{point.date}</td>
                  <td className="number">{formatValue(point.sales, valueKind)}</td>
                  <td className="number">{formatValue(point.previous, valueKind)}</td>
                  <td className="number">{formatChange(point.sales, point.previous)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  );
}

function buildOption(
  data: SalesChartPoint[],
  currentName: string,
  previousName: string,
  dataAsOf: string | null,
  valueKind: "currency" | "number",
): EChartsOption {
  return {
    animation: false,
    color: ["#0d7c5b", "#4f73c9"],
    grid: { top: 42, right: 20, bottom: 36, left: 70 },
    legend: { top: 0, icon: "roundRect", itemWidth: 18, itemHeight: 3, textStyle: { color: "#637069" } },
    tooltip: {
      trigger: "axis",
      backgroundColor: "#18221e",
      borderColor: "#18221e",
      textStyle: { color: "#ffffff" },
      extraCssText: "box-shadow: 0 10px 28px rgba(18,28,23,.18); border-radius: 6px; padding: 10px 12px;",
      formatter: (rawParams: unknown) => {
        const params = Array.isArray(rawParams) ? rawParams as Array<{ axisValue?: string; seriesName?: string; value?: number | null; color?: string }> : [];
        const current = numericValue(params.find((item) => item.seriesName === currentName)?.value);
        const previous = numericValue(params.find((item) => item.seriesName === previousName)?.value);
        const rows = params.map((item) => `${item.seriesName ?? ""}：${formatValue(numericValue(item.value), valueKind)}`);
        return [
          `<strong>${escapeHtml(params[0]?.axisValue ?? "")}</strong>`,
          ...rows.map(escapeHtml),
          `变化率：${escapeHtml(formatChange(current, previous))}`,
          dataAsOf ? `数据更新：${escapeHtml(formatDateTime(dataAsOf))}` : "",
        ].filter(Boolean).join("<br/>");
      },
    },
    xAxis: {
      type: "category",
      data: data.map((point) => point.date),
      boundaryGap: false,
      axisLine: { lineStyle: { color: "#d8dfdb" } },
      axisTick: { show: false },
      axisLabel: { color: "#637069", hideOverlap: true },
    },
    yAxis: {
      type: "value",
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: "#e3e8e5", type: "dashed" } },
      axisLabel: {
        color: "#637069",
        formatter: (value: number) => value >= 10_000 ? `${Math.round(value / 10_000)}万` : String(Math.round(value)),
      },
    },
    series: [
      {
        name: currentName,
        type: "line",
        smooth: 0.2,
        showSymbol: data.length <= 31,
        symbolSize: 6,
        connectNulls: false,
        lineStyle: { width: 3 },
        data: data.map((point) => point.sales),
      },
      {
        name: previousName,
        type: "line",
        smooth: 0.2,
        showSymbol: false,
        connectNulls: false,
        lineStyle: { width: 2, type: "dashed" },
        data: data.map((point) => point.previous),
      },
    ],
  };
}

function numericValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function formatChange(current: number | null, previous: number | null) {
  if (current === null || previous === null || previous === 0) return "暂无";
  const percent = ((current - previous) / previous) * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(1)}%`;
}

function formatValue(value: number | null, kind: "currency" | "number") {
  if (kind === "currency") return formatCurrency(value);
  return value?.toLocaleString("zh-CN") ?? "暂无";
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[character] ?? character);
}
