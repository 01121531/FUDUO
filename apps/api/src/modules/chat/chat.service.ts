import { randomUUID } from "node:crypto";
import { Inject, Injectable, NotFoundException, UnauthorizedException, type MessageEvent } from "@nestjs/common";
import { formatCurrency } from "@fuduo/shared";
import type { Prisma } from "@fuduo/database";
import { Observable, ReplaySubject, of } from "rxjs";
import { BusinessToolService } from "../tools/business-tool.service.js";
import { ModelProviderService } from "../models/model-provider.service.js";
import { DatabaseService } from "../database/database.service.js";
import { planChatTurn } from "./chat-planner.js";

type TurnStatus = "RECEIVED" | "AUTHORIZED" | "PLANNING" | "TOOL_RUNNING" | "COMPOSING" | "COMPLETED" | "FAILED" | "CANCELLED";
interface TurnRecord {
  id: string;
  userId: string;
  conversationId: string;
  message: string;
  history: ModelConversationMessage[];
  status: TurnStatus;
  terminal: boolean;
  committing: boolean;
  streamedContent: string;
  events: ReplaySubject<MessageEvent>;
  abortController: AbortController;
  persistence: Promise<void>;
}

interface ModelConversationMessage {
  role: "user" | "assistant";
  content: string;
}

interface DemoConversation {
  id: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  createdAt: string;
  tool: {
    name: string;
    status: string;
    durationMs: number | null;
    dataAsOf: string | null;
    params: unknown;
    resultMeta: unknown;
  } | null;
}

const CHAT_TURN_RUN_NAME = "__chat_turn__";
const TERMINAL_TURN_STATUSES = ["COMPLETED", "FAILED", "CANCELLED"] as const;

@Injectable()
export class ChatService {
  private readonly turns = new Map<string, TurnRecord>();
  private readonly demoConversations = new Map<string, DemoConversation>();

  constructor(
    @Inject(BusinessToolService) private readonly tools: BusinessToolService,
    @Inject(ModelProviderService) private readonly models: ModelProviderService,
    @Inject(DatabaseService) private readonly database: DatabaseService,
  ) {}

  async listConversations(userId?: string) {
    const actorId = this.actorId(userId);
    if (!this.database.enabled) {
      return [...this.demoConversations.values()]
        .filter((item) => item.userId === actorId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map((item) => ({ id: item.id, title: item.title, updatedAt: item.updatedAt, messageCount: item.messages.length }));
    }
    const rows = await this.database.prisma.conversation.findMany({
      where: { userId: actorId, channel: "WEB", revokedAt: null },
      include: { _count: { select: { messages: true } } },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return rows.map((row) => ({
      id: row.id,
      title: row.title ?? "新对话",
      updatedAt: row.updatedAt.toISOString(),
      messageCount: row._count.messages,
    }));
  }

  async createConversation(userId?: string, title?: string) {
    const actorId = this.actorId(userId);
    const normalizedTitle = normalizeTitle(title ?? "新对话");
    if (!this.database.enabled) {
      const now = new Date().toISOString();
      const conversation: DemoConversation = {
        id: `conversation_${randomUUID()}`,
        userId: actorId,
        title: normalizedTitle,
        createdAt: now,
        updatedAt: now,
        messages: [],
      };
      this.demoConversations.set(conversation.id, conversation);
      return { id: conversation.id, title: conversation.title, updatedAt: conversation.updatedAt, messageCount: 0 };
    }
    const row = await this.database.prisma.conversation.create({
      data: { userId: actorId, channel: "WEB", title: normalizedTitle },
    });
    return { id: row.id, title: row.title ?? "新对话", updatedAt: row.updatedAt.toISOString(), messageCount: 0 };
  }

  async listMessages(conversationId: string, userId?: string): Promise<ChatMessage[]> {
    const actorId = this.actorId(userId);
    if (!this.database.enabled) {
      const conversation = this.demoConversations.get(conversationId);
      if (!conversation || conversation.userId !== actorId) throw new NotFoundException("对话不存在");
      return conversation.messages;
    }
    const conversation = await this.database.prisma.conversation.findFirst({
      where: { id: conversationId, userId: actorId, channel: "WEB", revokedAt: null },
      include: { messages: { include: { toolRuns: { where: { name: { not: CHAT_TURN_RUN_NAME } }, take: 1 } }, orderBy: { createdAt: "asc" } } },
    });
    if (!conversation) throw new NotFoundException("对话不存在");
    return conversation.messages.map((message) => toChatMessage(message));
  }

  async start(message: string, conversationId?: string, userId?: string) {
    const actorId = this.actorId(userId);
    const conversation = conversationId
      ? await this.assertConversation(conversationId, actorId)
      : await this.createConversation(actorId, message);
    const history = conversationId ? await this.loadModelHistory(conversation.id, actorId) : [];
    const turnId = this.database.enabled ? randomUUID() : `turn_${randomUUID()}`;
    await this.saveUserMessage(conversation.id, actorId, message, turnId);

    const turn: TurnRecord = {
      id: turnId,
      userId: actorId,
      conversationId: conversation.id,
      message,
      history,
      status: "RECEIVED",
      terminal: false,
      committing: false,
      streamedContent: "",
      events: new ReplaySubject<MessageEvent>(100),
      abortController: new AbortController(),
      persistence: Promise.resolve(),
    };
    this.turns.set(turn.id, turn);
    this.emitStatus(turn, "RECEIVED");
    setImmediate(() => void this.run(turn));
    return { id: turn.id, conversationId: turn.conversationId, status: turn.status };
  }

  async events(turnId: string, userId?: string): Promise<Observable<MessageEvent>> {
    const actorId = this.actorId(userId);
    const local = this.turns.get(turnId);
    if (local) {
      if (local.userId !== actorId) throw new NotFoundException("对话轮次不存在");
      return local.events.asObservable();
    }
    if (!this.database.enabled) throw new NotFoundException("对话轮次不存在");
    return this.restoreEvents(turnId, actorId);
  }

  async cancel(turnId: string, userId?: string) {
    const actorId = this.actorId(userId);
    const turn = this.turns.get(turnId);
    if (!turn) {
      if (!this.database.enabled) throw new NotFoundException("对话轮次不存在");
      return this.cancelPersistedTurn(turnId, actorId);
    }
    if (turn.userId !== actorId) throw new NotFoundException("对话轮次不存在");
    // Once persistence starts, completing the turn is safer than reporting a
    // cancellation while an assistant message is already being committed.
    if (!turn.terminal && !turn.committing) {
      turn.abortController.abort();
      await this.finish(turn, "CANCELLED");
    }
    return { id: turn.id, conversationId: turn.conversationId, status: turn.status };
  }

  private async run(turn: TurnRecord) {
    if (turn.terminal) return;
    try {
      this.emitStatus(turn, "AUTHORIZED");
      this.emitStatus(turn, "PLANNING");
      const started = Date.now();
      const catalogRun = await this.tools.invokeTracked("list_shops", {}, { userId: turn.userId });
      const catalog = catalogRun.result as { shops?: Array<{ id?: string | number; name?: string }> };
      const visibleShops = (catalog.shops ?? [])
        .filter((shop): shop is { id: string | number; name: string } => (typeof shop.id === "string" || typeof shop.id === "number") && typeof shop.name === "string")
        .map((shop) => ({ shopId: String(shop.id), shopName: shop.name }));
      const proposed = await this.models.planTool(turn.message, visibleShops, turn.abortController.signal, turn.history);
      if (turn.terminal) return;
      const selected = planChatTurn(turn.message, visibleShops, proposed?.content);
      if (selected.kind === "clarify") {
        this.emitStatus(turn, "COMPOSING", { toolName: "list_shops" });
        const durationMs = Date.now() - started;
        const message = await this.commitAssistantMessage(turn, () => this.saveAssistantMessage(
          turn, selected.message, "deterministic-business-clarifier", "list_shops", {}, durationMs, null, catalogRun.toolRunId,
        ));
        if (!message || turn.terminal) return;
        this.streamContent(turn, selected.message);
        await this.finish(turn, "COMPLETED", { message });
        return;
      }
      this.emitStatus(turn, "TOOL_RUNNING", { toolName: selected.name });
      const tracked = selected.name === "list_shops"
        ? catalogRun
        : await this.tools.invokeTracked(selected.name, selected.params, { userId: turn.userId });
      const result = tracked.result;
      if (turn.terminal) return;

      const durationMs = Date.now() - started;
      const dataAsOf = result && typeof result === "object" && "dataAsOf" in result ? String(result.dataAsOf ?? "") || null : null;
      this.emitStatus(turn, "COMPOSING", { toolName: selected.name });
      const completion = await this.models.complete(
        turn.message,
        result,
        turn.abortController.signal,
        selected.name === "rank_shops_by_sales" ? "analysis_model" : "default_chat_model",
        turn.history,
        (delta) => this.streamDelta(turn, delta),
      );
      if (turn.terminal) return;

      const content = completion?.content ?? deterministicAnswer(selected.name, result);
      const model = completion?.model ?? "deterministic-business-formatter";
      const message = await this.commitAssistantMessage(turn, () => this.saveAssistantMessage(
        turn, content, model, selected.name, selected.params, durationMs, dataAsOf, tracked.toolRunId,
      ));
      if (!message || turn.terminal) return;
      if (!turn.streamedContent) this.streamContent(turn, content);
      await this.finish(turn, "COMPLETED", { message });
    } catch (error) {
      if (turn.terminal || turn.abortController.signal.aborted) return;
      await this.finish(turn, "FAILED", {
        error: {
          code: "CHAT_TURN_FAILED",
          message: "本次查询未能完成",
          recovery: "请检查数据同步和模型配置后重试",
        },
      });
    }
  }

  private async assertConversation(conversationId: string, actorId: string) {
    if (!this.database.enabled) {
      const conversation = this.demoConversations.get(conversationId);
      if (!conversation || conversation.userId !== actorId) throw new NotFoundException("对话不存在");
      return conversation;
    }
    const conversation = await this.database.prisma.conversation.findFirst({
      where: { id: conversationId, userId: actorId, channel: "WEB", revokedAt: null },
    });
    if (!conversation) throw new NotFoundException("对话不存在");
    return conversation;
  }

  private async loadModelHistory(conversationId: string, actorId: string): Promise<ModelConversationMessage[]> {
    if (!this.database.enabled) {
      const conversation = this.demoConversations.get(conversationId);
      if (!conversation || conversation.userId !== actorId) throw new NotFoundException("对话不存在");
      return boundedCompleteHistory(conversation.messages.map(({ role, content }) => ({ role, content })));
    }
    const conversation = await this.database.prisma.conversation.findFirst({
      where: { id: conversationId, userId: actorId, channel: "WEB", revokedAt: null },
      select: {
        messages: {
          where: { role: { in: ["user", "assistant"] } },
          select: { role: true, content: true },
          orderBy: { createdAt: "desc" },
          // Fetch more than the final context window so unanswered failed or
          // cancelled prompts can be discarded without losing valid pairs.
          take: 48,
        },
      },
    });
    if (!conversation) throw new NotFoundException("对话不存在");
    return boundedCompleteHistory(conversation.messages.reverse().map((entry) => ({
      role: entry.role === "user" ? "user" : "assistant",
      content: entry.content,
    })));
  }

  private async saveUserMessage(conversationId: string, userId: string, content: string, turnId: string) {
    if (!this.database.enabled) {
      const conversation = this.demoConversations.get(conversationId)!;
      const now = new Date().toISOString();
      conversation.messages.push({ id: `message_${randomUUID()}`, role: "user", content, model: null, createdAt: now, tool: null });
      if (conversation.messages.length === 1) conversation.title = normalizeTitle(content);
      conversation.updatedAt = now;
      return;
    }
    await this.database.prisma.$transaction(async (transaction) => {
      const firstMessage = await transaction.message.count({ where: { conversationId } }) === 0;
      const message = await transaction.message.create({ data: { conversationId, role: "user", content } });
      await transaction.toolRun.create({
        data: {
          id: turnId,
          userId,
          messageId: message.id,
          name: CHAT_TURN_RUN_NAME,
          status: "RECEIVED",
          resultMeta: { conversationId, schemaVersion: 1 },
        },
      });
      await transaction.conversation.update({
        where: { id: conversationId },
        data: { ...(firstMessage ? { title: normalizeTitle(content) } : {}), updatedAt: new Date() },
      });
    });
  }

  private async saveAssistantMessage(
    turn: TurnRecord,
    content: string,
    model: string,
    toolName: string,
    params: Record<string, unknown>,
    durationMs: number,
    dataAsOf: string | null,
    toolRunId: string | null,
  ): Promise<ChatMessage> {
    const createdAt = new Date();
    if (!this.database.enabled) {
      const message: ChatMessage = {
        id: `message_${randomUUID()}`,
        role: "assistant",
        content,
        model,
        createdAt: createdAt.toISOString(),
        tool: {
          name: toolName,
          status: "SUCCEEDED",
          durationMs,
          dataAsOf,
          params: redactToolJson(params),
          resultMeta: { dataAsOf },
        },
      };
      const conversation = this.demoConversations.get(turn.conversationId)!;
      conversation.messages.push(message);
      conversation.updatedAt = message.createdAt;
      return message;
    }
    const message = await this.database.prisma.$transaction(async (transaction) => {
      const created = await transaction.message.create({
        data: { conversationId: turn.conversationId, role: "assistant", content, model, toolName, toolRunId },
      });
      if (toolRunId) {
        await transaction.toolRun.update({ where: { id: toolRunId }, data: { messageId: created.id, dataAsOf: dataAsOf ? new Date(dataAsOf) : null } });
      } else {
        const fallbackRun = await transaction.toolRun.create({
          data: {
            userId: turn.userId,
            messageId: created.id,
            name: toolName,
            status: "SUCCEEDED",
            params: params as Prisma.InputJsonObject,
            resultMeta: { dataAsOf },
            dataAsOf: dataAsOf ? new Date(dataAsOf) : null,
            durationMs,
          },
        });
        await transaction.message.update({ where: { id: created.id }, data: { toolRunId: fallbackRun.id } });
      }
      await transaction.conversation.update({ where: { id: turn.conversationId }, data: { updatedAt: createdAt } });
      await transaction.toolRun.update({
        where: { id: turn.id },
        data: {
          status: "COMPLETED",
          resultMeta: { conversationId: turn.conversationId, schemaVersion: 1, assistantMessageId: created.id },
          durationMs,
        },
      });
      return created;
    });
    return {
      id: message.id,
      role: "assistant",
      content: message.content,
      model: message.model,
      createdAt: message.createdAt.toISOString(),
      tool: {
        name: toolName,
        status: "SUCCEEDED",
        durationMs,
        dataAsOf,
        params: redactToolJson(params),
        resultMeta: { dataAsOf },
      },
    };
  }

  private async commitAssistantMessage(turn: TurnRecord, save: () => Promise<ChatMessage>) {
    if (turn.terminal) return null;
    turn.committing = true;
    try {
      await turn.persistence;
      if (turn.terminal) return null;
      return await save();
    } finally {
      turn.committing = false;
    }
  }

  private emitStatus(turn: TurnRecord, status: TurnStatus, extra: Record<string, unknown> = {}) {
    if (turn.terminal) return;
    turn.status = status;
    turn.events.next({ type: "status", data: { turnId: turn.id, conversationId: turn.conversationId, status, ...extra } });
    this.queueTurnStatus(turn, status);
  }

  private streamContent(turn: TurnRecord, content: string) {
    for (const delta of content.match(/.{1,18}/gs) ?? [content]) {
      this.streamDelta(turn, delta);
    }
  }

  private streamDelta(turn: TurnRecord, delta: string) {
    if (turn.terminal || !delta) return;
    turn.streamedContent += delta;
    turn.events.next({
      type: "delta",
      data: { turnId: turn.id, delta, content: turn.streamedContent },
    });
  }

  private async finish(turn: TurnRecord, status: Extract<TurnStatus, "COMPLETED" | "FAILED" | "CANCELLED">, extra: Record<string, unknown> = {}) {
    if (turn.terminal) return;
    turn.status = status;
    turn.terminal = true;
    await turn.persistence;
    await this.persistTerminalTurn(turn, status, extra);
    turn.events.next({ type: status.toLowerCase(), data: { turnId: turn.id, conversationId: turn.conversationId, status, ...extra } });
    turn.events.complete();
    const timer = setTimeout(() => this.turns.delete(turn.id), 10 * 60_000);
    timer.unref();
  }

  private actorId(userId?: string) {
    if (userId) return userId;
    if (!this.database.enabled) return "demo-user";
    throw new UnauthorizedException("请先登录");
  }

  private queueTurnStatus(turn: TurnRecord, status: TurnStatus) {
    if (!this.database.enabled) return;
    turn.persistence = turn.persistence
      .then(async () => {
        await this.database.prisma.toolRun.updateMany({
          where: { id: turn.id, name: CHAT_TURN_RUN_NAME, status: { notIn: [...TERMINAL_TURN_STATUSES] } },
          data: { status },
        });
      })
      .catch(() => undefined);
  }

  private async persistTerminalTurn(
    turn: TurnRecord,
    status: Extract<TurnStatus, "COMPLETED" | "FAILED" | "CANCELLED">,
    extra: Record<string, unknown>,
  ) {
    if (!this.database.enabled || status === "COMPLETED") return;
    const error = isChatError(extra.error) ? extra.error : undefined;
    await this.database.prisma.toolRun.updateMany({
      where: { id: turn.id, name: CHAT_TURN_RUN_NAME, status: { notIn: [...TERMINAL_TURN_STATUSES] } },
      data: {
        status,
        ...(error ? { errorCode: error.code } : {}),
        resultMeta: {
          conversationId: turn.conversationId,
          schemaVersion: 1,
          ...(error ? { error } : {}),
        },
      },
    }).catch(() => undefined);
  }

  private async restoreEvents(turnId: string, actorId: string): Promise<Observable<MessageEvent>> {
    const row = await this.database.prisma.toolRun.findFirst({
      where: { id: turnId, name: CHAT_TURN_RUN_NAME, userId: actorId },
      include: { message: { include: { conversation: true } } },
    });
    if (!row?.message || row.message.conversation.userId !== actorId || row.message.conversation.channel !== "WEB" || row.message.conversation.revokedAt) {
      throw new NotFoundException("对话轮次不存在");
    }
    const status = normalizedPersistedStatus(row.status);
    if (isTerminalStatus(status)) {
      return of(await this.persistedTerminalEvent(row, status));
    }

    const claim = `RESUMING:${randomUUID()}`;
    const claimed = await this.database.prisma.toolRun.updateMany({
      where: { id: turnId, name: CHAT_TURN_RUN_NAME, status: row.status },
      data: { status: claim },
    });
    if (claimed.count !== 1) return this.restoreEvents(turnId, actorId);

    const turn: TurnRecord = {
      id: turnId,
      userId: actorId,
      conversationId: row.message.conversationId,
      message: row.message.content,
      history: await this.loadModelHistory(row.message.conversationId, actorId),
      status: "RECEIVED",
      terminal: false,
      committing: false,
      streamedContent: "",
      events: new ReplaySubject<MessageEvent>(100),
      abortController: new AbortController(),
      persistence: Promise.resolve(),
    };
    this.turns.set(turn.id, turn);
    this.emitStatus(turn, "RECEIVED", { recovered: true });
    setImmediate(() => void this.run(turn));
    return turn.events.asObservable();
  }

  private async persistedTerminalEvent(
    row: {
      id: string;
      status: string;
      resultMeta: unknown;
      message: { conversationId: string } | null;
    },
    status: Extract<TurnStatus, "COMPLETED" | "FAILED" | "CANCELLED">,
  ): Promise<MessageEvent> {
    const meta = asRecord(row.resultMeta);
    let message: ChatMessage | undefined;
    if (status === "COMPLETED" && typeof meta.assistantMessageId === "string") {
      const persisted = await this.database.prisma.message.findUnique({
        where: { id: meta.assistantMessageId },
        include: { toolRuns: { where: { name: { not: CHAT_TURN_RUN_NAME } }, take: 1 } },
      });
      if (persisted) message = toChatMessage(persisted);
    }
    const error = isChatError(meta.error) ? meta.error : undefined;
    return {
      type: status.toLowerCase(),
      data: {
        turnId: row.id,
        conversationId: row.message?.conversationId,
        status,
        ...(message ? { message } : {}),
        ...(error ? { error } : {}),
      },
    };
  }

  private async cancelPersistedTurn(turnId: string, actorId: string): Promise<{ id: string; conversationId: string; status: TurnStatus }> {
    const row = await this.database.prisma.toolRun.findFirst({
      where: { id: turnId, name: CHAT_TURN_RUN_NAME, userId: actorId },
      include: { message: { include: { conversation: true } } },
    });
    if (!row?.message || row.message.conversation.userId !== actorId || row.message.conversation.channel !== "WEB" || row.message.conversation.revokedAt) {
      throw new NotFoundException("对话轮次不存在");
    }
    const current = normalizedPersistedStatus(row.status);
    if (isTerminalStatus(current)) return { id: row.id, conversationId: row.message.conversationId, status: current };
    const result = await this.database.prisma.toolRun.updateMany({
      where: { id: turnId, name: CHAT_TURN_RUN_NAME, status: row.status },
      data: {
        status: "CANCELLED",
        resultMeta: { conversationId: row.message.conversationId, schemaVersion: 1 },
      },
    });
    if (result.count !== 1) return this.cancelPersistedTurn(turnId, actorId);
    return { id: row.id, conversationId: row.message.conversationId, status: "CANCELLED" as const };
  }
}

function toChatMessage(message: {
  id: string;
  role: string;
  content: string;
  model: string | null;
  createdAt: Date;
  toolRuns: Array<{
    name: string;
    status: string;
    durationMs: number | null;
    dataAsOf: Date | null;
    params: unknown;
    resultMeta: unknown;
  }>;
}): ChatMessage {
  const tool = message.toolRuns[0];
  return {
    id: message.id,
    role: message.role === "user" ? "user" : "assistant",
    content: message.content,
    model: message.model,
    createdAt: message.createdAt.toISOString(),
    tool: tool ? {
      name: tool.name,
      status: tool.status,
      durationMs: tool.durationMs,
      dataAsOf: tool.dataAsOf?.toISOString() ?? null,
      params: redactToolJson(tool.params),
      resultMeta: redactToolJson(tool.resultMeta),
    } : null,
  };
}

function redactToolJson(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => redactToolJson(item, depth + 1));
  if (!value || typeof value !== "object") {
    return typeof value === "string" && value.length > 2_000 ? `${value.slice(0, 2_000)}…` : value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [
    key,
    /authorization|cookie|token|api[-_]?key|secret|password/i.test(key) ? "[REDACTED]" : redactToolJson(item, depth + 1),
  ]));
}

function normalizeTitle(value: string) {
  const title = value.replace(/\s+/g, " ").trim();
  return title ? title.slice(0, 36) : "新对话";
}

function boundedCompleteHistory(history: ModelConversationMessage[]) {
  const completePairs: ModelConversationMessage[] = [];
  let pendingUser: ModelConversationMessage | null = null;
  for (const entry of history) {
    if (entry.role === "user") {
      // A newer user prompt supersedes an unanswered prompt. This prevents a
      // failed turn in the middle of a conversation from leaking into a later
      // model request as an apparently valid part of the dialogue.
      pendingUser = entry;
    } else if (pendingUser) {
      completePairs.push(pendingUser, entry);
      pendingUser = null;
    }
  }
  return completePairs
    .slice(-12)
    .map((entry) => ({ role: entry.role, content: entry.content.slice(0, 2_000) }));
}

function normalizedPersistedStatus(status: string): TurnStatus {
  if (status.startsWith("RESUMING:")) return "RECEIVED";
  const known: TurnStatus[] = ["RECEIVED", "AUTHORIZED", "PLANNING", "TOOL_RUNNING", "COMPOSING", "COMPLETED", "FAILED", "CANCELLED"];
  return known.includes(status as TurnStatus) ? status as TurnStatus : "FAILED";
}

function isTerminalStatus(status: TurnStatus): status is Extract<TurnStatus, "COMPLETED" | "FAILED" | "CANCELLED"> {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function isChatError(value: unknown): value is { code: string; message: string; recovery: string } {
  if (!value || typeof value !== "object") return false;
  const error = value as Record<string, unknown>;
  return typeof error.code === "string" && typeof error.message === "string" && typeof error.recovery === "string";
}

function deterministicAnswer(name: string, raw: unknown): string {
  const result = raw as { summary?: { salesAmount?: number | null; transactionCount?: number | null; refundAmount?: number | null }; shops?: Array<{ shopName?: string; salesAmount?: number | null; freshness?: string; dataAsOf?: string | null }>; rows?: Array<{ orderCount?: number | null; paidOrderCount?: number | null; paidAmount?: number | null; refundCount?: number | null; refundAmount?: number | null }>; dataAsOf?: string | null; runs?: unknown[] };
  if (name === "get_sync_status") return `最近同步任务 ${result.runs?.length ?? 0} 条。请在同步中心查看失败原因和重试状态。`;
  if (name === "list_shops") return `当前可查看 ${result.shops?.length ?? 0} 家店铺。`;
  if (name === "get_data_freshness") {
    const stale = (result.shops ?? []).filter((shop) => shop.freshness === "STALE" || shop.freshness === "UNKNOWN");
    return `共检查 ${result.shops?.length ?? 0} 家店铺，${stale.length ? `${stale.map((shop) => shop.shopName ?? "未命名店铺").join("、")}的数据需要更新。` : "数据状态正常。"}`;
  }
  if (name === "get_shop_orders") {
    const rows = result.rows ?? [];
    const orders = rows.reduce((sum, row) => sum + (row.orderCount ?? 0), 0);
    const paid = rows.reduce((sum, row) => sum + (row.paidOrderCount ?? 0), 0);
    const amount = rows.reduce((sum, row) => sum + Math.round((row.paidAmount ?? 0) * 100), 0) / 100;
    return rows.length ? `订单 ${orders} 笔，其中支付订单 ${paid} 笔，支付金额 ${formatCurrency(amount)}。` : "当前日期范围内没有可用的订单数据。";
  }
  if (name === "get_shop_refunds") {
    const rows = result.rows ?? [];
    const count = rows.reduce((sum, row) => sum + (row.refundCount ?? 0), 0);
    const amount = rows.reduce((sum, row) => sum + Math.round((row.refundAmount ?? 0) * 100), 0) / 100;
    return rows.length ? `退款 ${count} 笔，退款金额 ${formatCurrency(amount)}。` : "当前日期范围内没有可用的退款数据。";
  }
  if (name === "rank_shops_by_sales") {
    const ranking = (result.shops ?? []).map((shop, index) => `${index + 1}. ${shop.shopName ?? "未命名店铺"} ${formatCurrency(shop.salesAmount ?? null)}`).join("；");
    return `${ranking || "当前没有可用的店铺销售数据。"}${result.dataAsOf ? `数据截止 ${new Date(result.dataAsOf).toLocaleString("zh-CN", { hour12: false })}。` : "当前没有可用的同步时间。"}`;
  }
  const top = result.shops?.[0];
  const summary = result.summary;
  return `销售额 ${formatCurrency(summary?.salesAmount ?? null)}，订单 ${summary?.transactionCount ?? "—"} 笔，退款 ${formatCurrency(summary?.refundAmount ?? null)}。${top ? `销售额最高的是${top.shopName ?? "未命名店铺"}，为 ${formatCurrency(top.salesAmount ?? null)}。` : ""}${result.dataAsOf ? `数据截止 ${new Date(result.dataAsOf).toLocaleString("zh-CN", { hour12: false })}。` : "当前没有可用的同步时间。"}`;
}
