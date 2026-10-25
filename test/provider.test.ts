import { AsyncLocalStorage } from "node:async_hooks";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  ModelRegistry,
  ModelRuntime,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ScopeHandle } from "@sovara/sdk";
import { bindProviders } from "../src/provider.ts";

const active = new AsyncLocalStorage<string>();
function scope(id: string): ScopeHandle {
  return {
    traceId: id,
    recordingId: id,
    state: "active",
    run: (fn) => active.run(id, fn),
    finish: async () => {},
    fail: async () => {},
    cancel: async () => {},
  };
}
async function setup() {
  const cwd = await mkdtemp(join(tmpdir(), "pi-provider-binding-"));
  const runtime = await ModelRuntime.create({
    authPath: join(cwd, "auth.json"),
    modelsPath: null,
    modelsStorePath: join(cwd, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const config = {
    api: "openai-completions",
    apiKey: "CONTROLLED_PROVIDER_KEY",
    baseUrl: "https://fixture.invalid/v1",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text" as const],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 10000,
        maxTokens: 500,
      },
    ],
  };
  runtime.registerProvider("fixture", config);
  const registry = new ModelRegistry(runtime);
  const pi = {
    registerProvider: registry.registerProvider.bind(registry),
    unregisterProvider: registry.unregisterProvider.bind(registry),
  } as ExtensionAPI;
  const ctx = {
    modelRegistry: registry,
    model: runtime.getModel("fixture", "fixture"),
  } as ExtensionContext;
  const requests: { scope?: string; auth: string | null; url: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push({
      scope: active.getStore(),
      auth: request.headers.get("authorization"),
      url: request.url,
    });
    return new Response(
      'data: {"id":"response","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"role":"assistant","content":"ACK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { "content-type": "text/event-stream" } },
    );
  };
  const run = (signal?: AbortSignal) =>
    runtime.completeSimple(
      ctx.model!,
      { messages: [{ role: "user", content: "controlled", timestamp: 1 }] },
      { signal, fetch },
    );
  return {
    runtime,
    registry,
    pi,
    ctx,
    config,
    requests,
    run,
    close: () => rm(cwd, { recursive: true, force: true }),
  };
}

test("public native registration preserves configured auth and binds each lazy request by signal", async () => {
  const h = await setup();
  const binding = bindProviders(h.pi);
  try {
    const config = h.registry.getRegisteredProviderConfig("fixture");
    const before = await h.run();
    binding.install(h.ctx);
    const first = new AbortController(),
      second = new AbortController();
    binding.bind(first.signal, scope("first"));
    binding.bind(second.signal, scope("second"));
    const messages = await Promise.all([
      h.run(first.signal),
      h.run(second.signal),
      h.run(),
    ]);
    assert(
      messages.every((message) => message.stopReason === before.stopReason),
    );
    assert.deepEqual(
      h.requests.map((request) => request.scope),
      [undefined, "first", "second", undefined],
    );
    assert(
      h.requests.every(
        (request) =>
          request.auth === "Bearer CONTROLLED_PROVIDER_KEY" &&
          request.url === "https://fixture.invalid/v1/chat/completions",
      ),
    );
    assert.equal(active.getStore(), undefined);
    binding.dispose();
    assert.deepEqual(h.registry.getRegisteredProviderConfig("fixture"), config);
    await h.run(first.signal);
    assert.equal(h.requests.at(-1)?.scope, undefined);
  } finally {
    binding.dispose();
    await h.close();
  }
});

test("two sessions share registration without sharing scope or restoring over a newer provider", async () => {
  const h = await setup();
  const first = bindProviders(h.pi),
    second = bindProviders(h.pi);
  try {
    first.install(h.ctx);
    const wrapper = h.registry.getRegisteredNativeProvider("fixture");
    first.install(h.ctx);
    second.install(h.ctx);
    assert.equal(h.registry.getRegisteredNativeProvider("fixture"), wrapper);
    const a = new AbortController(),
      b = new AbortController();
    first.bind(a.signal, scope("first"));
    second.bind(b.signal, scope("second"));
    await Promise.all([h.run(a.signal), h.run(b.signal)]);
    first.dispose();
    assert.equal(h.registry.getRegisteredNativeProvider("fixture"), wrapper);
    await h.run(b.signal);
    assert.deepEqual(
      h.requests.map((request) => request.scope),
      ["first", "second", "second"],
    );
    h.registry.registerProvider("fixture", {
      ...h.config,
      baseUrl: "https://new-owner.invalid/v1",
    });
    const newer = h.registry.getRegisteredProviderConfig("fixture");
    second.dispose();
    assert.equal(h.registry.getRegisteredProviderConfig("fixture"), newer);
  } finally {
    first.dispose();
    second.dispose();
    await h.close();
  }
});
