import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanMessages,
  lessonBlock,
  referenceMessage,
  RetrievalSuffix,
} from "../src/lessons.ts";

test("retrieval input excludes old injections without mutating the conversation", () => {
  const user = { role: "user" as const, content: "task", timestamp: 1 };
  const messages = [user, referenceMessage("old lessons")];
  assert.deepEqual(cleanMessages(messages), [user]);
  assert.equal(messages.length, 2);
  assert.doesNotMatch(
    new RetrievalSuffix().context(messages).context,
    /old lessons/,
  );
});

test("lesson blocks are bounded and deduplicated; huge queries are marked", () => {
  const lesson = {
    lesson_id: "1",
    title: "one",
    content: "use deterministic tests",
  };
  const block = lessonBlock({
    lessons: [
      lesson,
      lesson,
      { ...lesson, lesson_id: "2", content: "x".repeat(13000) },
    ],
    rendered_lessons_block: "unused",
    retrieval_status: "complete",
  });
  assert.deepEqual(block.ids, ["1"]);
  assert.equal(block.truncated, true);
  assert.equal(
    new RetrievalSuffix().context([
      { role: "user", content: "x".repeat(130000), timestamp: 1 },
    ]).truncated,
    true,
  );
});

test("suffix tracks appended messages, ignores metadata, and retries the same query", () => {
  const tracker = new RetrievalSuffix();
  const user = { role: "user" as const, content: "current task", timestamp: 1 };
  const initial = tracker.context([user]);
  assert.deepEqual(JSON.parse(initial.context).prefix, []);
  assert.equal(
    tracker.context([{ ...user, timestamp: 99 }]).context,
    initial.context,
  );
  const tool = {
    role: "toolResult" as const,
    toolCallId: "a",
    toolName: "read",
    content: [{ type: "text" as const, text: "new evidence" }],
    isError: false,
    timestamp: 2,
  };
  const next = tracker.context([user, tool]);
  assert.match(next.context, /new evidence/);
  assert.doesNotMatch(next.context, /current task/);
  assert.equal(tracker.context([user, tool]).context, next.context);
});

test("resume and rewritten histories use only the latest user turn", () => {
  const tracker = new RetrievalSuffix();
  const old = { role: "user" as const, content: "old task", timestamp: 1 };
  const current = { ...old, content: "new task", timestamp: 2 };
  assert.doesNotMatch(tracker.context([old, current]).context, /old task/);
  const rewritten = tracker.context([
    { ...old, content: "compacted history" },
    current,
  ]);
  assert.match(rewritten.context, /new task/);
  assert.doesNotMatch(rewritten.context, /compacted history/);
});

test("suffix keeps structured JSON under truncation and excludes system and image bytes", () => {
  const query = new RetrievalSuffix().context([
    { role: "system", content: "private system instructions", timestamp: 1 },
    {
      role: "user",
      content: [
        { type: "text", text: "x".repeat(130000) },
        { type: "image", mimeType: "image/png", data: "base64-image-payload" },
      ],
      timestamp: 2,
    },
  ]);
  assert.equal(query.truncated, true);
  assert.deepEqual(JSON.parse(query.context).prefix, []);
  assert.doesNotMatch(
    query.context,
    /private system instructions|base64-image-payload/,
  );
});
