export function mergeStreamContent(current: string, payload: { delta?: string; content?: string }) {
  if (typeof payload.content === "string") {
    if (current.startsWith(payload.content)) return current;
    return payload.content;
  }
  return current + (payload.delta ?? "");
}

export function isTerminalTurnStatus(status: string | undefined): status is "COMPLETED" | "FAILED" | "CANCELLED" {
  return status === "COMPLETED" || status === "FAILED" || status === "CANCELLED";
}

export function chatFailureMessage(error?: { message?: string; recovery?: string }) {
  const message = error?.message?.trim() || "本次查询未能完成";
  const recovery = error?.recovery?.trim();
  return recovery ? `${message}。${recovery}` : `${message}。请稍后重试`;
}
