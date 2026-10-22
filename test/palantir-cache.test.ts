import { test } from "node:test";
import assert from "node:assert/strict";
import type { Api, Model } from "@earendil-works/pi-ai";
import { withPalantirCacheBreakpoints } from "../src/palantir-cache.ts";

const model: Model<"openai-responses"> = {
  id: "synthetic",
  name: "Synthetic",
  provider: "palantir",
  api: "openai-responses",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 4096,
  compat: { supportsExplicitPromptCacheMode: true },
};
const result = (id: string, output: unknown = `Evidence ${id}`) => ({
  type: "function_call_output", call_id: id, output,
});
const lesson = (text: string) => ({
  role: "user", content: [{ type: "input_text", text }],
});
const request = (input: unknown[]) => ({ prompt_cache_key: "session", input });
const breakpoint = { mode: "explicit" };

test("changing lessons retain identical marked prefixes without retaining old lessons", () => {
  const first = request([result("one"), lesson("Lesson A")]);
  const original = structuredClone(first);
  const cached = withPalantirCacheBreakpoints(first, model) as typeof first;
  const next = request([result("one"), result("two"), lesson("Lesson B")]);
  const updated = withPalantirCacheBreakpoints(next, model) as typeof next;
  assert.deepEqual(updated.input[0], cached.input[0]);
  assert.deepEqual(cached.input[0], result("one", [{
    type: "input_text", text: "Evidence one", prompt_cache_breakpoint: breakpoint,
  }]));
  assert.deepEqual(updated.input.at(-1), lesson("Lesson B"));
  assert.doesNotMatch(JSON.stringify(updated), /Lesson A/);
  assert.deepEqual(first, original, "do not mutate transcript or retry input");
  assert.deepEqual(withPalantirCacheBreakpoints(cached, model), cached);
});

test("multiple tool results and multimodal outputs preserve content and cache options", () => {
  const input = [
    result("one", [{ type: "input_text", text: "first" }, { type: "input_text", text: "last" }]),
    result("two", [{ type: "input_image", image_url: "data:image/png;base64,fixture" }]),
    result("three", [{ type: "input_file", file_id: "fixture" }]),
    lesson("Temporary guidance"),
  ];
  const payload = { ...request(input), prompt_cache_options: { ttl: "30m" } };
  const actual = withPalantirCacheBreakpoints(payload, model) as typeof payload;
  assert.deepEqual(actual.prompt_cache_options, { ttl: "30m", mode: "explicit" });
  for (let i = 0; i < 3; i++) {
    const item = actual.input[i] as ReturnType<typeof result>;
    const original = input[i] as ReturnType<typeof result>;
    const output = item.output as Record<string, unknown>[];
    const before = original.output as Record<string, unknown>[];
    assert.deepEqual(output.slice(0, -1), before.slice(0, -1));
    assert.deepEqual(output.at(-1), { ...before.at(-1), prompt_cache_breakpoint: breakpoint });
  }
  assert.deepEqual(actual.input.at(-1), input.at(-1));
});

test("provider capability and cache key are required, including cacheRetention none", () => {
  const payload = request([result("one")]);
  const unsupported: (Model<Api> | undefined)[] = [
    undefined,
    { ...model, provider: "openai" },
    { ...model, api: "openai-completions", compat: {} },
    { ...model, compat: undefined },
    { ...model, compat: { supportsExplicitPromptCacheMode: false } },
  ];
  for (const other of unsupported)
    assert.equal(withPalantirCacheBreakpoints(payload, other), payload);
  for (const key of [undefined, null, ""]) {
    const disabled = {
      ...payload, prompt_cache_key: key,
      // Pi's explicit-capable adapter disables cache writes this way for "none".
      prompt_cache_options: { mode: "explicit" },
    };
    assert.equal(withPalantirCacheBreakpoints(disabled, model), disabled);
  }
});

test("no-tool, unsupported, and malformed payloads keep automatic caching untouched", () => {
  for (const payload of [
    null, "unknown", {}, request([lesson("Initial lesson")]),
    request([null, result("empty", []), result("bad", {}), result("future", [{ type: "future" }])]),
  ]) assert.equal(withPalantirCacheBreakpoints(payload, model), payload);
});

test("branches and compacted histories derive boundaries only from current input", () => {
  withPalantirCacheBreakpoints(request([result("discarded")]), model);
  const branch = request([result("branch"), lesson("Branch lesson")]);
  const compacted = request([lesson("Summary"), result("after-summary")]);
  for (const payload of [branch, compacted]) {
    const actual = withPalantirCacheBreakpoints(payload, model) as typeof payload;
    assert.equal(actual.input.length, payload.input.length);
    assert.doesNotMatch(JSON.stringify(actual), /discarded/);
    assert.match(JSON.stringify(actual), /prompt_cache_breakpoint/);
  }
});
