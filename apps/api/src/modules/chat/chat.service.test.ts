import { describe, expect, it, vi } from "vitest";
import type { MessageEvent } from "@nestjs/common";
import type { Observable } from "rxjs";
import { ChatService } from "./chat.service.js";

function createService() {
  const tools = {
    invokeTracked: vi.fn(async (name: string) => ({
      result: name === "list_shops" ? {
        shops: [
          { id: 101, name: "第一店铺" },
          { id: 102, name: "第二店铺" },
          { id: 103, name: "第三店铺" },
        ],
      } : {
        summary: { salesAmount: 128.5, transactionCount: 3, refundAmount: 4.2 },
        shops: [
          { shopName: "第一店铺", salesAmount: 128.5 },
          { shopName: "第二店铺", salesAmount: 96.2 },
          { shopName: "第三店铺", salesAmount: 80.1 },
        ],
        dataAsOf: "2026-07-21T08:35:00.000Z",
      },
      toolRunId: null,
    })),
  };
  const models = {
    planTool: vi.fn(async (..._args: unknown[]) => null),
    complete: vi.fn(async (..._args: unknown[]): Promise<{ content: string; model: string } | null> => null),
  };
  const database = { enabled: false };
  return {
    service: new ChatService(tools as never, models as never, database as never),
    tools,
    models,
  };
}

function collect(observable: Observable<MessageEvent>) {
  return new Promise<MessageEvent[]>((resolve, reject) => {
    const events: MessageEvent[] = [];
    observable.subscribe({ next: (event) => events.push(event), error: reject, complete: () => resolve(events) });
  });
}

describe("ChatService", () => {
  it("streams a complete turn and stores conversation history", async () => {
    const { service, tools, models } = createService();
    const turn = await service.start("今天所有店铺销售额是多少？");
    const events = await collect(await service.events(turn.id));

    expect(events.map((event) => event.type)).toEqual(expect.arrayContaining([
      "status",
      "delta",
      "completed",
    ]));
    const statuses = events
      .filter((event) => event.type === "status")
      .map((event) => (event.data as { status: string }).status);
    expect(statuses).toEqual(["RECEIVED", "AUTHORIZED", "PLANNING", "TOOL_RUNNING", "COMPOSING"]);
    expect(tools.invokeTracked).toHaveBeenCalledTimes(2);
    expect(models.planTool).toHaveBeenCalledOnce();
    expect(models.complete).toHaveBeenCalledOnce();

    const conversations = await service.listConversations();
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.messageCount).toBe(2);
    const messages = await service.listMessages(turn.conversationId);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[1]?.tool?.name).toBe("get_sales_summary");
  });

  it("cancels a queued turn without producing an assistant message", async () => {
    const { service, tools, models } = createService();
    const turn = await service.start("查询销售额");
    const eventsPromise = collect(await service.events(turn.id));
    expect((await service.cancel(turn.id)).status).toBe("CANCELLED");
    const events = await eventsPromise;

    expect(events.at(-1)?.type).toBe("cancelled");
    expect(tools.invokeTracked).not.toHaveBeenCalled();
    expect(models.complete).not.toHaveBeenCalled();
    const messages = await service.listMessages(turn.conversationId);
    expect(messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("formats every returned ranking row when no model is configured", async () => {
    const { service } = createService();
    const turn = await service.start("销售额最高的三个店铺");
    await collect(await service.events(turn.id));
    const messages = await service.listMessages(turn.conversationId);
    expect(messages[1]?.content).toContain("1. 第一店铺");
    expect(messages[1]?.content).toContain("2. 第二店铺");
    expect(messages[1]?.content).toContain("3. 第三店铺");
  });

  it("asks for a shop instead of guessing an order query", async () => {
    const { service, tools, models } = createService();
    const turn = await service.start("昨天订单情况怎么样");
    await collect(await service.events(turn.id));
    const messages = await service.listMessages(turn.conversationId);

    expect(messages[1]?.content).toContain("请说明要查询的店铺名称");
    expect(tools.invokeTracked).toHaveBeenCalledTimes(1);
    expect(models.complete).not.toHaveBeenCalled();
  });

  it("passes recent persisted messages into the next turn planner", async () => {
    const { service, models } = createService();
    const first = await service.start("今天所有店铺销售额是多少？");
    await collect(await service.events(first.id));

    const second = await service.start("那第二家呢？", first.conversationId);
    await collect(await service.events(second.id));

    expect(models.planTool).toHaveBeenLastCalledWith(
      "那第二家呢？",
      expect.any(Array),
      expect.any(AbortSignal),
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "今天所有店铺销售额是多少？" }),
        expect.objectContaining({ role: "assistant" }),
      ]),
    );
  });

  it("forwards live model deltas with cumulative content for reconnect-safe rendering", async () => {
    const { service, models } = createService();
    models.complete.mockImplementationOnce(async (...args: unknown[]) => {
      const onDelta = args[5] as ((delta: string) => void) | undefined;
      onDelta?.("实时");
      onDelta?.("回答");
      return { content: "实时回答", model: "Provider/model" };
    });

    const turn = await service.start("今天销售怎么样？");
    const events = await collect(await service.events(turn.id));
    const deltas = events.filter((event) => event.type === "delta").map((event) => event.data as { delta: string; content: string });

    expect(deltas).toEqual([
      expect.objectContaining({ delta: "实时", content: "实时" }),
      expect.objectContaining({ delta: "回答", content: "实时回答" }),
    ]);
  });

  it("aborts an in-flight model request and does not persist its partial answer", async () => {
    const { service, models } = createService();
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => { requestStarted = resolve; });
    models.complete.mockImplementationOnce(async (...args: unknown[]) => {
      const signal = args[2] as AbortSignal;
      const onDelta = args[5] as ((delta: string) => void) | undefined;
      onDelta?.("未完成");
      requestStarted();
      await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      return null;
    });

    const turn = await service.start("查询销售额");
    const eventsPromise = collect(await service.events(turn.id));
    await started;
    expect((await service.cancel(turn.id)).status).toBe("CANCELLED");
    const events = await eventsPromise;

    expect(events.at(-1)?.type).toBe("cancelled");
    const messages = await service.listMessages(turn.conversationId);
    expect(messages.map((message) => message.role)).toEqual(["user"]);
  });

  it("excludes a failed unanswered prompt from the next turn history", async () => {
    const { service, models } = createService();
    models.complete.mockRejectedValueOnce(new Error("upstream failed"));
    const failed = await service.start("这条查询会失败");
    await collect(await service.events(failed.id));

    const retried = await service.start("换个问题", failed.conversationId);
    await collect(await service.events(retried.id));

    expect(models.planTool).toHaveBeenLastCalledWith("换个问题", expect.any(Array), expect.any(AbortSignal), []);
  });

  it("keeps failed prompts out of context after a later turn succeeds", async () => {
    const { service, models } = createService();
    const first = await service.start("第一条有效问题");
    await collect(await service.events(first.id));

    models.complete.mockRejectedValueOnce(new Error("upstream failed"));
    const failed = await service.start("不要带入后续上下文", first.conversationId);
    await collect(await service.events(failed.id));

    const recovered = await service.start("恢复后的有效问题", first.conversationId);
    await collect(await service.events(recovered.id));
    const next = await service.start("继续追问", first.conversationId);
    await collect(await service.events(next.id));

    const history = models.planTool.mock.calls.at(-1)?.[3] as Array<{ role: string; content: string }>;
    expect(history.map((entry) => entry.content)).toEqual(expect.arrayContaining(["第一条有效问题", "恢复后的有效问题"]));
    expect(history.map((entry) => entry.content)).not.toContain("不要带入后续上下文");
    expect(history).toHaveLength(4);
  });

  it("does not report cancellation after assistant persistence has started", async () => {
    const { service } = createService();
    let persistenceStarted!: () => void;
    let releasePersistence!: () => void;
    const started = new Promise<void>((resolve) => { persistenceStarted = resolve; });
    const release = new Promise<void>((resolve) => { releasePersistence = resolve; });
    const internals = service as unknown as {
      saveAssistantMessage: (...args: unknown[]) => Promise<unknown>;
    };
    const original = internals.saveAssistantMessage.bind(service);
    internals.saveAssistantMessage = vi.fn(async (...args: unknown[]) => {
      persistenceStarted();
      await release;
      return original(...args);
    });

    const turn = await service.start("查询销售额");
    const eventsPromise = collect(await service.events(turn.id));
    await started;

    expect((await service.cancel(turn.id)).status).toBe("COMPOSING");
    releasePersistence();
    const events = await eventsPromise;

    expect(events.at(-1)?.type).toBe("completed");
    expect((await service.listMessages(turn.conversationId)).map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("claims and resumes a persisted non-terminal turn after service restart", async () => {
    const turnId = "11111111-1111-4111-8111-111111111111";
    const userId = "22222222-2222-4222-8222-222222222222";
    const conversationId = "33333333-3333-4333-8333-333333333333";
    const updateMany = vi.fn(async (_input: unknown) => ({ count: 1 }));
    const database = {
      enabled: true,
      prisma: {
        toolRun: {
          findFirst: vi.fn(async () => ({
            id: turnId,
            userId,
            status: "PLANNING",
            resultMeta: { conversationId },
            message: {
              id: "44444444-4444-4444-8444-444444444444",
              conversationId,
              content: "服务重启前的问题",
              conversation: { id: conversationId, userId, channel: "WEB", revokedAt: null },
            },
          })),
          updateMany,
        },
        conversation: {
          findFirst: vi.fn(async () => ({ messages: [{ role: "user", content: "服务重启前的问题" }] })),
        },
      },
    };
    const service = new ChatService({} as never, {} as never, database as never);
    const run = vi.fn((turn: { id: string; history: unknown[]; events: { next: (event: MessageEvent) => void; complete: () => void } }) => {
      turn.events.next({ type: "completed", data: { turnId: turn.id, status: "COMPLETED" } });
      turn.events.complete();
    });
    (service as unknown as { run: typeof run }).run = run;

    const events = await collect(await service.events(turnId, userId));

    expect(events[0]).toEqual(expect.objectContaining({ type: "status", data: expect.objectContaining({ status: "RECEIVED", recovered: true }) }));
    expect(events.at(-1)?.type).toBe("completed");
    expect(updateMany.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      where: expect.objectContaining({ id: turnId, status: "PLANNING" }),
      data: expect.objectContaining({ status: expect.stringMatching(/^RESUMING:/) }),
    }));
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ id: turnId, message: "服务重启前的问题", history: [] }));
  });

  it("replays a persisted completed turn with its committed assistant message", async () => {
    const createdAt = new Date("2026-07-22T12:00:00.000Z");
    const database = {
      enabled: true,
      prisma: {
        toolRun: {
          findFirst: vi.fn(async () => ({
            id: "11111111-1111-4111-8111-111111111111",
            userId: "22222222-2222-4222-8222-222222222222",
            status: "COMPLETED",
            resultMeta: { assistantMessageId: "55555555-5555-4555-8555-555555555555" },
            message: {
              conversationId: "33333333-3333-4333-8333-333333333333",
              conversation: {
                userId: "22222222-2222-4222-8222-222222222222",
                channel: "WEB",
                revokedAt: null,
              },
            },
          })),
        },
        message: {
          findUnique: vi.fn(async () => ({
            id: "55555555-5555-4555-8555-555555555555",
            role: "assistant",
            content: "已持久化的回答",
            model: "Provider/model",
            createdAt,
            toolRuns: [],
          })),
        },
      },
    };
    const service = new ChatService({} as never, {} as never, database as never);

    const events = await collect(await service.events(
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ));

    expect(events).toEqual([expect.objectContaining({
      type: "completed",
      data: expect.objectContaining({
        status: "COMPLETED",
        message: expect.objectContaining({ content: "已持久化的回答", createdAt: createdAt.toISOString() }),
      }),
    })]);
  });
});
