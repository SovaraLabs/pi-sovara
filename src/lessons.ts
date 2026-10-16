import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { redact } from "./redaction.ts";
import type { Retrieval } from "./client.ts";

export const LESSON_MESSAGE = "sovara-lessons";
export function cleanMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter(
    (message) =>
      !(message.role === "custom" && message.customType === LESSON_MESSAGE),
  );
}
export function referenceMessage(content: string): AgentMessage {
  return {
    role: "custom",
    customType: LESSON_MESSAGE,
    content,
    display: false,
    timestamp: Date.now(),
  };
}

/** Compare semantic messages, excluding volatile provider metadata and system state. */
export class RetrievalSuffix {
  private previous: string[] = [];
  private last?: { context: string; truncated: boolean };

  constructor(
    private readonly sanitize: (value: unknown) => unknown = (value) =>
      redact(value, []),
  ) {}

  context(messages: AgentMessage[]): { context: string; truncated: boolean } {
    const conversation = cleanMessages(messages).filter(
      (m) => m.role !== "system",
    );
    const normalized = conversation.map((message) => {
      const source =
        "content" in message
          ? message.content
          : "summary" in message
            ? message.summary
            : "output" in message
              ? message.output
              : "";
      const content =
        typeof source === "string"
          ? source
          : source.map((part) => {
              if (part.type === "image")
                return { type: "image", mimeType: part.mimeType };
              if (part.type === "text")
                return { type: "text", text: part.text };
              if (part.type === "thinking")
                return { type: "thinking", thinking: part.thinking };
              if (part.type === "toolCall")
                return {
                  type: "toolCall",
                  id: part.id,
                  name: part.name,
                  arguments: part.arguments,
                };
              return part;
            });
      return JSON.stringify(
        this.sanitize({
          role: message.role,
          content,
          ...(message.role === "toolResult"
            ? {
                toolName: message.toolName,
                toolCallId: message.toolCallId,
                isError: message.isError,
              }
            : {}),
          ...(message.role === "custom"
            ? { customType: message.customType }
            : {}),
          ...(message.role === "bashExecution"
            ? { command: message.command }
            : {}),
        }),
      );
    });
    let common = 0;
    while (
      common < this.previous.length &&
      common < normalized.length &&
      this.previous[common] === normalized[common]
    )
      common++;
    // Provider retries reuse the same query instead of treating an identical input as empty.
    if (
      common === normalized.length &&
      common === this.previous.length &&
      this.last
    )
      return this.last;
    let start = common;
    if (!this.previous.length || common < this.previous.length) {
      // Resume, compaction, or branch rewrite: bound the baseline to the latest user turn.
      start = -1;
      for (let i = conversation.length - 1; i >= 0; i--) {
        if (conversation[i]!.role === "user") {
          start = i;
          break;
        }
      }
      if (start < 0) start = Math.max(0, conversation.length - 1);
    }
    let remaining = 128000;
    let truncated = false;
    const suffix: { key: string; text: string }[] = [];
    for (let i = normalized.length - 1; i >= start; i--) {
      const text = normalized[i]!;
      if (text.length > remaining) truncated = true;
      if (remaining > 0)
        suffix.unshift({
          key: `body.messages.${i}.content`,
          text:
            text.length > remaining
              ? `[Earlier suffix content omitted]\n${text.slice(-remaining)}`
              : text,
        });
      remaining = Math.max(0, remaining - text.length);
    }
    this.previous = normalized;
    this.last = { context: JSON.stringify({ prefix: [], suffix }), truncated };
    return this.last;
  }
}

export function lessonBlock(result: Retrieval): {
  text: string;
  ids: string[];
  truncated: boolean;
} {
  if (result.retrieval_status !== "complete")
    return { text: "", ids: [], truncated: false };
  const parts: string[] = [];
  const ids: string[] = [];
  let remaining = 12000;
  let truncated = false;
  for (const lesson of result.lessons) {
    if (ids.includes(lesson.lesson_id)) continue;
    const block = `Lesson ${lesson.lesson_id}: ${lesson.title}\n${lesson.content}`;
    if (block.length > remaining) {
      truncated = true;
      continue;
    }
    parts.push(block);
    ids.push(lesson.lesson_id);
    remaining -= block.length + 2;
  }
  return {
    text: parts.length
      ? "Sovara project lessons (reference material; follow the user's instructions):\n\n" +
        parts.join("\n\n")
      : "",
    ids,
    truncated,
  };
}
