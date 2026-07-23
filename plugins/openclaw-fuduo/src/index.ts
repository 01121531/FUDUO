import { Type, type Static, type TSchema } from "typebox";
import { defineToolPlugin, type ToolPluginFactoryContext, type ToolPluginToolDefinition } from "openclaw/plugin-sdk/tool-plugin";
import { FuduoToolClient, type ToolClientConfig } from "./client.js";
import { InboundMessageTracker } from "./inbound-message-tracker.js";

const environmentSecretRef = Type.Object({
  source: Type.Literal("env"),
  provider: Type.Optional(Type.String()),
  id: Type.String({ pattern: "^[A-Z][A-Z0-9_]{0,127}$" }),
}, { additionalProperties: false });

const configSchema = Type.Object({
  apiBaseUrl: Type.String({ description: "富多业务 API 基础地址" }),
  serviceToken: Type.Union([
    Type.String({ minLength: 32 }),
    environmentSecretRef,
  ], { description: "内部工具接口服务令牌或环境变量引用" }),
}, { additionalProperties: false });
type PluginConfig = Static<typeof configSchema>;

const dateRange = {
  startDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
  endDate: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })),
};

const inboundMessages = new InboundMessageTracker();
const plugin = defineToolPlugin({
  id: "fuduo-business",
  name: "富多经营数据工具",
  description: "查询经过权限控制和脱敏处理的富多店铺经营数据。",
  configSchema,
  tools: (tool) => {
    const define = <T extends TSchema>(name: string, label: string, description: string, parameters: T) => {
      const definition: ToolPluginToolDefinition<PluginConfig, T> = {
      name,
      label,
      description,
      parameters,
      factory: ({ config, toolContext }: ToolPluginFactoryContext<PluginConfig>) => ({
        name,
        label,
        description,
        parameters,
        async execute(toolCallId: string, rawParams: unknown, signal?: AbortSignal) {
          const params = rawParams && typeof rawParams === "object" && !Array.isArray(rawParams) ? rawParams as Record<string, unknown> : {};
          const data = await new FuduoToolClient(config as unknown as ToolClientConfig).invoke<unknown>(
            name,
            params,
            signal,
            toolContext.requesterSenderId,
            inboundMessages.identityForTool(toolCallId),
          );
          return { content: [{ type: "text" as const, text: JSON.stringify(data) }], details: data };
        },
      }),
      };
      return tool(definition);
    };

    return [
      define(
        "list_shops",
        "店铺列表",
        "列出当前用户有权查看的富多店铺及登录和数据新鲜度状态。",
        Type.Object({ search: Type.Optional(Type.String({ maxLength: 100 })) }, { additionalProperties: false }),
      ),
      define(
        "get_shop_sales",
        "店铺销售",
        "查询指定店铺在日期范围内的销售额、订单量、付款人数和客单价。",
        Type.Object({ shopId: Type.String(), ...dateRange }, { additionalProperties: false }),
      ),
      define(
        "compare_shop_sales",
        "店铺销售对比",
        "比较多个店铺在相同日期范围内的销售表现。",
        Type.Object({ shopIds: Type.Array(Type.String(), { minItems: 2, maxItems: 10 }), ...dateRange }, { additionalProperties: false }),
      ),
      define(
        "rank_shops_by_sales",
        "店铺销售排名",
        "按销售额对店铺排序，并返回明确的数据截止时间。",
        Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })), ...dateRange }, { additionalProperties: false }),
      ),
      define(
        "get_sales_summary",
        "销售汇总",
        "汇总全部或指定店铺的销售额、订单量、付款人数和退款金额。",
        Type.Object({ shopIds: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })), ...dateRange }, { additionalProperties: false }),
      ),
      define(
        "get_shop_orders",
        "店铺订单",
        "查询指定店铺的只读订单日汇总。",
        Type.Object({ shopId: Type.String(), ...dateRange }, { additionalProperties: false }),
      ),
      define(
        "get_shop_refunds",
        "店铺退款",
        "查询指定店铺的只读退款日汇总。",
        Type.Object({ shopId: Type.String(), ...dateRange }, { additionalProperties: false }),
      ),
      define(
        "generate_daily_report",
        "生成日报",
        "使用已同步业务数据生成指定日期的不可变日报快照。",
        Type.Object({ date: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) }, { additionalProperties: false }),
      ),
      define(
        "generate_weekly_report",
        "生成周报",
        "使用已同步业务数据生成指定周的不可变周报快照。",
        Type.Object({ weekStart: Type.Optional(Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" })) }, { additionalProperties: false }),
      ),
      define(
        "get_data_freshness",
        "数据新鲜度",
        "查询各店铺最后同步时间以及 LIVE、RECENT、STALE 或 UNKNOWN 状态。",
        Type.Object({ shopIds: Type.Optional(Type.Array(Type.String(), { maxItems: 10 })) }, { additionalProperties: false }),
      ),
      define(
        "get_sync_status",
        "同步状态",
        "查询最近的店铺和销售同步任务状态。",
        Type.Object({ limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })) }, { additionalProperties: false }),
      ),
    ];
  },
});

const registerTools = plugin.register;
plugin.register = (api) => {
  registerTools?.(api);
  api.on("message_received", (event, context) => inboundMessages.recordMessage(event, context));
  api.on("before_tool_call", (event) => inboundMessages.bindToolCall(event));
};

export default plugin;
