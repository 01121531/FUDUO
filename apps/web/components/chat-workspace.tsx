"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import {
  Bot,
  Database,
  List,
  PanelRight,
  Plus,
  Send,
  Square,
  UserRound,
  X,
} from "lucide-react";
import { chatFailureMessage, isTerminalTurnStatus, mergeStreamContent } from "./chat-stream";
import { Tooltip } from "./tooltip";

interface Conversation {
  id: string;
  title: string;
  updatedAt: string;
  messageCount: number;
}

interface ToolRun {
  name: string;
  status: string;
  durationMs: number | null;
  dataAsOf: string | null;
  params: unknown;
  resultMeta: unknown;
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  model: string | null;
  createdAt: string;
  tool: ToolRun | null;
}

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: { message?: string };
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "/api";
const suggestions = [
  "今天所有店铺销售额是多少？",
  "销售额最高的三个店铺",
  "哪些店铺数据需要重新同步？",
];

export function ChatWorkspace() {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [turnStatus, setTurnStatus] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [mobileHistoryOpen, setMobileHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const turnIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const historyButtonRef = useRef<HTMLButtonElement>(null);
  const contextButtonRef = useRef<HTMLButtonElement>(null);
  const closeMobileHistory = useCallback(() => setMobileHistoryOpen(false), []);
  const closeContext = useCallback(() => setContextOpen(false), []);

  const loadConversations = useCallback(async () => {
    try {
      setHistoryError(null);
      const response = await fetch(`${API_URL}/chat/conversations`, { credentials: "include", cache: "no-store" });
      const body = await response.json() as ApiEnvelope<Conversation[]>;
      if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? "会话列表加载失败。");
      setConversations(body.data);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : "会话列表加载失败。");
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConversations();
    return () => sourceRef.current?.close();
  }, [loadConversations]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  useSheetDialog(mobileHistoryOpen, closeMobileHistory, historyButtonRef);
  useSheetDialog(contextOpen, closeContext, contextButtonRef);

  async function openConversation(conversationId: string) {
    if (loading || conversationId === activeConversationId) {
      setMobileHistoryOpen(false);
      return;
    }
    setHistoryLoading(true);
    try {
      const nextMessages = await requestConversationMessages(conversationId);
      setActiveConversationId(conversationId);
      setMessages(nextMessages);
      setTurnStatus(null);
      setMobileHistoryOpen(false);
    } catch (error) {
      appendSystemError(error instanceof Error ? error.message : "历史消息加载失败。");
    } finally {
      setHistoryLoading(false);
    }
  }

  function newConversation() {
    if (loading) return;
    setActiveConversationId(null);
    setMessages([]);
    setInput("");
    setTurnStatus(null);
    setMobileHistoryOpen(false);
  }

  async function submit(value = input) {
    const content = value.trim();
    if (!content || loading || cancelling) return;
    const optimistic: Message = {
      id: `local_${crypto.randomUUID()}`,
      role: "user",
      content,
      model: null,
      createdAt: new Date().toISOString(),
      tool: null,
    };
    setMessages((current) => [...current, optimistic]);
    setInput("");
    setLoading(true);
    setTurnStatus("RECEIVED");
    try {
      const response = await fetch(`${API_URL}/chat/turns`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: content, ...(activeConversationId ? { conversationId: activeConversationId } : {}) }),
      });
      const body = await response.json() as ApiEnvelope<{ id: string; conversationId: string; status: string }>;
      if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? "对话请求失败。");
      setActiveConversationId(body.data.conversationId);
      listenToTurn(body.data.id, body.data.conversationId);
    } catch (error) {
      appendSystemError(error instanceof Error ? error.message : "对话请求失败。");
      setLoading(false);
      setTurnStatus(null);
    }
  }

  function listenToTurn(turnId: string, conversationId: string) {
    sourceRef.current?.close();
    turnIdRef.current = turnId;
    const source = new EventSource(`${API_URL}/chat/turns/${encodeURIComponent(turnId)}/events`, { withCredentials: true });
    sourceRef.current = source;
    const streamedMessageId = `stream_${turnId}`;
    let streamedContent = "";

    source.addEventListener("status", (event) => {
      const payload = parseEvent<{ status?: string }>(event);
      if (payload?.status) setTurnStatus(payload.status);
    });
    source.addEventListener("delta", (event) => {
      const payload = parseEvent<{ delta?: string; content?: string }>(event);
      if (!payload) return;
      streamedContent = mergeStreamContent(streamedContent, payload);
      if (!streamedContent) return;
      setMessages((current) => upsertStreamedMessage(current, streamedMessageId, streamedContent));
    });
    source.addEventListener("completed", (event) => {
      const payload = parseEvent<{ message?: Message }>(event);
      if (payload?.message) {
        setMessages((current) => replaceStreamedMessage(current, streamedMessageId, payload.message!));
      }
      finishTurn(source);
      if (!payload?.message) void refreshConversation(conversationId);
      void loadConversations();
    });
    source.addEventListener("failed", (event) => {
      const payload = parseEvent<{ error?: { message?: string; recovery?: string } }>(event);
      setMessages((current) => removeStreamedMessage(current, streamedMessageId));
      appendSystemError(chatFailureMessage(payload?.error));
      finishTurn(source);
      void loadConversations();
    });
    source.addEventListener("cancelled", () => {
      setMessages((current) => removeStreamedMessage(current, streamedMessageId));
      finishTurn(source);
      void loadConversations();
    });
    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED && turnIdRef.current === turnId) {
        setMessages((current) => removeStreamedMessage(current, streamedMessageId));
        appendSystemError("对话连接已断开。后台任务可能仍在继续，请稍后重新打开当前会话。");
        finishTurn(source);
      } else if (turnIdRef.current === turnId) {
        setTurnStatus("RECONNECTING");
      }
    };
  }

  async function cancel() {
    const turnId = turnIdRef.current;
    if (!turnId || cancelling) return;
    const source = sourceRef.current;
    setCancelling(true);
    try {
      const response = await fetch(`${API_URL}/chat/turns/${encodeURIComponent(turnId)}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      const body = await response.json() as ApiEnvelope<{ status?: string }>;
      if (!response.ok || !body.success || !body.data?.status) throw new Error(body.error?.message ?? "停止请求失败。");
      if (body.data.status === "CANCELLED") {
        setMessages((current) => removeStreamedMessage(current, `stream_${turnId}`));
        finishTurn(source);
        void loadConversations();
      } else if (isTerminalTurnStatus(body.data.status)) {
        finishTurn(source);
        if (activeConversationId) await refreshConversation(activeConversationId);
        if (body.data.status === "FAILED") appendSystemError(chatFailureMessage());
        void loadConversations();
      } else {
        setTurnStatus("COMPLETING");
      }
    } catch (error) {
      appendSystemError(error instanceof Error ? `${error.message} 当前任务仍在继续。` : "停止请求失败，当前任务仍在继续。");
    } finally {
      setCancelling(false);
    }
  }

  function finishTurn(source: EventSource | null) {
    if (!source || sourceRef.current !== source) return;
    source.close();
    sourceRef.current = null;
    turnIdRef.current = null;
    setLoading(false);
    setTurnStatus(null);
  }

  function appendSystemError(content: string) {
    setMessages((current) => [...current, {
      id: `error_${crypto.randomUUID()}`,
      role: "assistant",
      content,
      model: null,
      createdAt: new Date().toISOString(),
      tool: null,
    }]);
  }

  async function refreshConversation(conversationId: string) {
    try {
      const nextMessages = await requestConversationMessages(conversationId);
      setActiveConversationId(conversationId);
      setMessages(nextMessages);
    } catch (error) {
      appendSystemError(error instanceof Error ? error.message : "历史消息加载失败。");
    }
  }

  const activeConversation = conversations.find((item) => item.id === activeConversationId) ?? null;
  const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
  const latestTool = [...messages].reverse().find((message) => message.tool)?.tool ?? null;
  const dataAsOf = latestTool?.dataAsOf;

  const conversationPane = (
    <ConversationPane
      conversations={conversations}
      activeConversationId={activeConversationId}
      loading={historyLoading}
      error={historyError}
      turnRunning={loading}
      onNew={newConversation}
      onOpen={(id) => void openConversation(id)}
    />
  );
  const contextPane = (
    <ContextPane
      conversation={activeConversation}
      messageCount={messages.length}
      model={latestAssistant?.model ?? null}
      tool={latestTool}
    />
  );

  return (
    <div className={`chat-layout ${contextOpen ? "context-open" : ""}`}>
      <aside className="conversation-list" aria-label="会话列表">{conversationPane}</aside>

      <section className="chat-main">
        <header className="chat-header">
          <Tooltip label="打开会话列表" side="bottom" className="chat-mobile-tooltip"><button
            ref={historyButtonRef}
            className="button icon-button chat-mobile-action"
            type="button"
            aria-label="打开会话列表"
            aria-haspopup="dialog"
            aria-expanded={mobileHistoryOpen}
            onClick={() => setMobileHistoryOpen(true)}
          >
            <List size={18} />
          </button></Tooltip>
          <div className="chat-heading">
            <strong>经营数据助手</strong>
            <div className="muted">
              {turnStatus ? statusLabel(turnStatus) : dataAsOf ? `数据截止 ${formatTime(dataAsOf)}` : "全部店铺"}
            </div>
          </div>
          <span className="chat-model-label">{latestAssistant?.model ?? "模型自动路由"}</span>
          <Tooltip label={contextOpen ? "关闭上下文" : "打开上下文"} side="bottom"><button
            ref={contextButtonRef}
            className="button icon-button"
            type="button"
            aria-label={contextOpen ? "关闭上下文" : "打开上下文"}
            aria-haspopup="dialog"
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((current) => !current)}
          >
            <PanelRight size={18} />
          </button></Tooltip>
        </header>

        <div className="message-scroll" aria-live="polite" ref={scrollRef}>
          {messages.length === 0 ? (
            <article className="message assistant">
              <div className="message-avatar"><Bot size={18} /></div>
              <div className="message-content">
                <div className="message-label">富多助手</div>
                <p>下午好。我可以查询店铺销售、订单、退款、排名和数据同步状态。</p>
              </div>
            </article>
          ) : null}
          {messages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <div className="message-avatar">{message.role === "assistant" ? <Bot size={18} /> : <UserRound size={18} />}</div>
              <div className="message-content">
                <div className="message-label">{message.role === "assistant" ? "富多助手" : "你"}</div>
                <p>{message.content}</p>
                {message.tool ? <ToolRunView tool={message.tool} /> : null}
              </div>
            </article>
          ))}
          {loading && !messages.some((message) => message.id === `stream_${turnIdRef.current}`) ? (
            <article className="message assistant">
              <div className="message-avatar"><Bot size={18} /></div>
              <div className="message-content">
                <div className="message-label">富多助手</div>
                <div className="thinking"><span /><span /><span />{statusLabel(turnStatus)}</div>
              </div>
            </article>
          ) : null}
        </div>

        <div className="chat-composer-wrap">
          {messages.length === 0 ? (
            <div className="suggestions">
              {suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => void submit(suggestion)}>{suggestion}</button>)}
            </div>
          ) : null}
          <div className="chat-composer">
            <textarea
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void submit();
                }
              }}
              placeholder="询问销售、订单、退款或店铺表现"
              aria-label="发送消息"
              rows={2}
              disabled={loading || cancelling}
            />
            <Tooltip label={loading ? (cancelling ? "正在停止" : "停止生成") : "发送消息"} side="top"><button
              className="button primary icon-button"
              type="button"
              onClick={() => loading ? void cancel() : void submit()}
              disabled={cancelling || (!loading && !input.trim())}
              aria-label={loading ? (cancelling ? "正在停止" : "停止生成") : "发送消息"}
            >
              {loading ? <Square size={16} /> : <Send size={17} />}
            </button></Tooltip>
          </div>
          <div className="composer-hint">回答会标明数据截止时间；金额和排名由业务服务计算。</div>
        </div>
      </section>

      {contextOpen ? <aside className="chat-context" aria-label="当前对话上下文">{contextPane}</aside> : null}

      {mobileHistoryOpen ? (
        <div className="chat-sheet-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setMobileHistoryOpen(false);
        }}>
          <section className="chat-sheet" role="dialog" aria-modal="true" aria-labelledby="chat-history-title">
            <header><strong id="chat-history-title">会话</strong><Tooltip label="关闭会话列表" side="left"><button className="icon-button" type="button" aria-label="关闭会话列表" onClick={() => setMobileHistoryOpen(false)}><X size={18} /></button></Tooltip></header>
            {conversationPane}
          </section>
        </div>
      ) : null}

      {contextOpen ? (
        <div className="chat-context-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setContextOpen(false);
        }}>
          <section className="chat-sheet context-sheet" role="dialog" aria-modal="true" aria-labelledby="chat-context-title">
            <header><strong id="chat-context-title">上下文</strong><Tooltip label="关闭上下文" side="left"><button className="icon-button" type="button" aria-label="关闭上下文" onClick={() => setContextOpen(false)}><X size={18} /></button></Tooltip></header>
            {contextPane}
          </section>
        </div>
      ) : null}
    </div>
  );
}

function ConversationPane({
  conversations,
  activeConversationId,
  loading,
  error,
  turnRunning,
  onNew,
  onOpen,
}: {
  conversations: Conversation[];
  activeConversationId: string | null;
  loading: boolean;
  error: string | null;
  turnRunning: boolean;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  return (
    <div className="conversation-pane">
      <button className="button" type="button" onClick={onNew} disabled={turnRunning}><Plus size={17} />新建对话</button>
      <div className="nav-label">最近对话</div>
      <div className="conversation-items">
        {loading && conversations.length === 0 ? <div className="conversation-empty">正在加载</div> : null}
        {error ? <div className="conversation-empty" role="alert">{error}</div> : null}
        {!loading && conversations.length === 0 ? <div className="conversation-empty">暂无历史对话</div> : null}
        {conversations.map((conversation) => (
          <button
            type="button"
            className={`conversation ${conversation.id === activeConversationId ? "active" : ""}`}
            key={conversation.id}
            onClick={() => onOpen(conversation.id)}
          >
            {conversation.title}
            <span>{relativeTime(conversation.updatedAt)} · {conversation.messageCount} 条消息</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function ContextPane({
  conversation,
  messageCount,
  model,
  tool,
}: {
  conversation: Conversation | null;
  messageCount: number;
  model: string | null;
  tool: ToolRun | null;
}) {
  return (
    <div className="context-pane">
      <div className="context-group"><span>当前会话</span><strong>{conversation?.title ?? "新对话"}</strong></div>
      <div className="context-group"><span>消息数量</span><strong>{messageCount} 条</strong></div>
      <div className="context-group"><span>回答模型</span><strong>{model ?? "自动路由"}</strong></div>
      <div className="context-group"><span>最近工具</span><strong>{tool ? toolName(tool.name) : "尚未调用"}</strong></div>
      <div className="context-group"><span>数据截止</span><strong>{tool?.dataAsOf ? formatTime(tool.dataAsOf) : "暂无"}</strong></div>
    </div>
  );
}

function ToolRunView({ tool }: { tool: ToolRun }) {
  return (
    <div className="tool-run">
      <Database size={15} />
      <span>
        <strong>{toolName(tool.name)}</strong>
        <small>{toolSummary(tool)} · {tool.durationMs ?? "暂无"}ms{tool.dataAsOf ? ` · 数据截止 ${formatTime(tool.dataAsOf)}` : ""}</small>
        <details>
          <summary>技术详情</summary>
          <div className="tool-json-grid">
            <div><span>参数</span><pre>{safeJson(tool.params)}</pre></div>
            <div><span>结果元数据</span><pre>{safeJson(tool.resultMeta)}</pre></div>
          </div>
        </details>
      </span>
    </div>
  );
}

function useSheetDialog(open: boolean, close: () => void, triggerRef: RefObject<HTMLButtonElement | null>) {
  useEffect(() => {
    if (!open || !window.matchMedia("(max-width: 760px)").matches) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = document.querySelector<HTMLElement>(".chat-sheet[role='dialog']");
      if (!dialog) return;
      const controls = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter((element) => element.offsetParent !== null);
      if (!controls.length) return;
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".chat-sheet[role='dialog'] button")?.focus());
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
      window.setTimeout(() => triggerRef.current?.focus(), 0);
    };
  }, [open, close, triggerRef]);
}

function parseEvent<T>(event: Event): T | null {
  try {
    return JSON.parse((event as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

async function requestConversationMessages(conversationId: string) {
  const response = await fetch(`${API_URL}/chat/conversations/${encodeURIComponent(conversationId)}/messages`, {
    credentials: "include",
    cache: "no-store",
  });
  const body = await response.json() as ApiEnvelope<Message[]>;
  if (!response.ok || !body.success || !body.data) throw new Error(body.error?.message ?? "历史消息加载失败。");
  return body.data;
}

function upsertStreamedMessage(messages: Message[], id: string, content: string) {
  const existing = messages.findIndex((message) => message.id === id);
  const streamed: Message = { id, role: "assistant", content, model: null, createdAt: new Date().toISOString(), tool: null };
  if (existing < 0) return [...messages, streamed];
  return messages.map((message, index) => index === existing ? { ...message, content } : message);
}

function replaceStreamedMessage(messages: Message[], id: string, completed: Message) {
  const existing = messages.findIndex((message) => message.id === id);
  if (existing < 0) return [...messages, completed];
  return messages.map((message, index) => index === existing ? completed : message);
}

function removeStreamedMessage(messages: Message[], id: string) {
  return messages.filter((message) => message.id !== id);
}

function statusLabel(status?: string | null) {
  const labels: Record<string, string> = {
    RECEIVED: "已收到问题",
    AUTHORIZED: "正在校验权限",
    PLANNING: "正在分析问题",
    TOOL_RUNNING: "正在查询经营数据",
    COMPOSING: "正在组织回答",
    COMPLETING: "回答即将完成",
    RECONNECTING: "连接中断，正在恢复",
  };
  return status ? labels[status] ?? "正在处理" : "正在处理";
}

function toolName(name: string) {
  const names: Record<string, string> = {
    list_shops: "读取店铺列表",
    get_shop_sales: "查询店铺销售",
    compare_shop_sales: "比较店铺销售",
    rank_shops_by_sales: "店铺销售排名",
    get_sales_summary: "汇总销售数据",
    get_shop_orders: "查询店铺订单",
    get_shop_refunds: "查询店铺退款",
    get_data_freshness: "检查数据状态",
    generate_daily_report: "生成日报",
    generate_weekly_report: "生成周报",
  };
  return names[name] ?? name;
}

function toolSummary(tool: ToolRun) {
  return tool.status === "SUCCEEDED" ? "经营数据查询已完成" : `工具状态 ${tool.status}`;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return "无法显示";
  }
}

function formatTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function relativeTime(value: string) {
  const elapsed = Date.now() - new Date(value).getTime();
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
}
