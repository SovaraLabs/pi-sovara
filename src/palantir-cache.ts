import type { Api, Model } from "@earendil-works/pi-ai";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Cache stable tool results before request-only lessons, without retaining lessons. */
export function withPalantirCacheBreakpoints(
  payload: unknown,
  model: Model<Api> | undefined,
): unknown {
  if (
    model?.provider !== "palantir" ||
    model.api !== "openai-responses" ||
    !model.compat ||
    !("supportsExplicitPromptCacheMode" in model.compat) ||
    model.compat.supportsExplicitPromptCacheMode !== true ||
    !record(payload) ||
    // Pi omits the key for cacheRetention: "none". Never enable caching then.
    typeof payload.prompt_cache_key !== "string" ||
    !payload.prompt_cache_key ||
    !Array.isArray(payload.input)
  ) return payload;

  let marked = false;
  const input = payload.input.map((item: unknown) => {
    if (!record(item) || item.type !== "function_call_output") return item;
    const output: unknown[] = typeof item.output === "string"
      ? [{ type: "input_text", text: item.output }]
      : Array.isArray(item.output) ? [...item.output] : [];
    const last = output.at(-1);
    if (
      !record(last) ||
      !["input_text", "input_image", "input_file"].includes(String(last.type))
    ) return item;
    // Recreate earlier boundaries too: matching needs the previous prefix's marker.
    output[output.length - 1] = {
      ...last,
      prompt_cache_breakpoint: { mode: "explicit" },
    };
    marked = true;
    return { ...item, output };
  });
  if (!marked) return payload;
  return {
    ...payload,
    input,
    prompt_cache_options: {
      ...(record(payload.prompt_cache_options) ? payload.prompt_cache_options : {}),
      mode: "explicit",
    },
  };
}
