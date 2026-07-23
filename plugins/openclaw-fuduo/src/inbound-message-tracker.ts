import { createHash } from "node:crypto";

export interface InboundMessageIdentity {
  channel: string;
  accountId: string;
  externalMessageId: string;
}

interface MessageReceivedEvent {
  runId?: string;
  messageId?: string;
  from?: string;
  content?: string;
  timestamp?: number;
}

interface MessageContext {
  channelId?: string;
  accountId?: string;
}

interface ToolCallEvent {
  runId?: string;
  toolCallId?: string;
}

interface TimedIdentity extends InboundMessageIdentity { expiresAt: number }

/** Correlates the inbound hook's stable message identity with a later tool call. */
export class InboundMessageTracker {
  private readonly runs = new Map<string, TimedIdentity>();
  private readonly tools = new Map<string, TimedIdentity>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  recordMessage(event: MessageReceivedEvent, context: MessageContext): void {
    if (!event.runId) return;
    const channel = normalize(context.channelId, 100);
    const accountId = normalize(context.accountId, 200) ?? "default";
    const externalMessageId = stableMessageId(channel, event);
    if (!channel || !externalMessageId) return;
    this.prune();
    this.runs.set(event.runId, { channel, accountId, externalMessageId, expiresAt: this.now() + this.ttlMs });
  }

  bindToolCall(event: ToolCallEvent): void {
    if (!event.runId || !event.toolCallId) return;
    this.prune();
    const identity = this.runs.get(event.runId);
    if (identity) this.tools.set(event.toolCallId, identity);
  }

  identityForTool(toolCallId: string): InboundMessageIdentity | undefined {
    this.prune();
    const identity = this.tools.get(toolCallId);
    if (!identity) return undefined;
    return { channel: identity.channel, accountId: identity.accountId, externalMessageId: identity.externalMessageId };
  }

  releaseTool(toolCallId: string): void {
    this.tools.delete(toolCallId);
  }

  private prune(): void {
    const now = this.now();
    for (const [key, value] of this.runs) if (value.expiresAt <= now) this.runs.delete(key);
    for (const [key, value] of this.tools) if (value.expiresAt <= now) this.tools.delete(key);
  }
}

function stableMessageId(channel: string | undefined, event: MessageReceivedEvent): string | undefined {
  // Tencent's 2.4.6 adapter replaces message_id with a random MessageSid. Its
  // sender + provider timestamp + body are stable across long-poll redelivery.
  if (channel === "openclaw-weixin" && event.from && event.timestamp !== undefined) {
    return `fingerprint:${createHash("sha256").update(`${event.from}\0${event.timestamp}\0${event.content ?? ""}`).digest("hex")}`;
  }
  return normalize(event.messageId, 512);
}

function normalize(value: string | undefined, maxLength: number): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}
