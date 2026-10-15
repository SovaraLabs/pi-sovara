import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanMessages,
  lessonBlock,
  needsReminder,
  referenceMessage,
  retrievalContext,
  LESSON_MESSAGE,
  REMINDER_MESSAGE,
  RETRIEVE_TOOL,
} from "../src/lessons.ts";

test("retrieval input excludes old injections without mutating the conversation", () => {
  const user = { role: "user" as const, content: "task", timestamp: 1 };
  const messages = [
    user,
    referenceMessage(LESSON_MESSAGE, "old lessons"),
    referenceMessage(REMINDER_MESSAGE, "reminder"),
  ];
  assert.deepEqual(cleanMessages(messages), [user]);
  assert.equal(messages.length, 3);
  assert.doesNotMatch(
    retrievalContext(messages).context,
    /old lessons|reminder/,
  );
});

test("reminders stop after retrieval and re-arm on substantive tool results", () => {
  const user = { role: "user" as const, content: "task", timestamp: 1 };
  const retrieval = {
    role: "toolResult" as const,
    toolCallId: "one",
    toolName: RETRIEVE_TOOL,
    content: [{ type: "text" as const, text: "lessons" }],
    isError: false,
    timestamp: 2,
  };
  assert.equal(needsReminder([user]), true);
  assert.equal(needsReminder([user, retrieval]), false);
  assert.equal(needsReminder([user, { ...retrieval, isError: true }]), false);
  assert.equal(
    needsReminder([user, retrieval, { ...retrieval, toolName: "read" }]),
    true,
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
    retrievalContext([
      { role: "user", content: "x".repeat(130000), timestamp: 1 },
    ]).truncated,
    true,
  );
});
