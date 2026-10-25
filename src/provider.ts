import type { AssistantMessage, Provider } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ScopeHandle } from "@sovara/sdk";

type Invocation = {
  scope: ScopeHandle;
  onResult?: (message?: AssistantMessage) => void;
};

type Binding = {
  wrapper: Provider;
  previousNative?: Provider;
  previousConfig: ReturnType<
    ExtensionContext["modelRegistry"]["getRegisteredProviderConfig"]
  >;
  owners: Map<object, Map<AbortSignal, Invocation>>;
};

// Sessions sharing one ModelRuntime share its registration, but never its scope.
const wrappers = new WeakMap<Provider, Binding>();

export function bindProviders(pi: ExtensionAPI) {
  const owner = {};
  const scopes = new Map<AbortSignal, Invocation>();
  const installed = new Map<
    string,
    { binding: Binding; registry: ExtensionContext["modelRegistry"] }
  >();

  function release(id: string): void {
    const current = installed.get(id);
    if (!current) return;
    installed.delete(id);
    const { binding, registry } = current;
    binding.owners.delete(owner);
    if (
      binding.owners.size ||
      registry.getRegisteredNativeProvider(id) !== binding.wrapper
    )
      return;
    pi.unregisterProvider(id);
    if (binding.previousNative) pi.registerProvider(binding.previousNative);
    else if (binding.previousConfig)
      pi.registerProvider(id, binding.previousConfig);
  }

  return {
    bind(
      signal: AbortSignal | undefined,
      scope: ScopeHandle,
      onResult?: Invocation["onResult"],
    ): boolean {
      if (!signal) return false;
      scopes.set(signal, { scope, onResult });
      return true;
    },
    unbind(signal: AbortSignal | undefined): void {
      if (signal) scopes.delete(signal);
    },
    install(ctx: ExtensionContext): void {
      const registry = ctx.modelRegistry;
      const ids = new Set(registry.getAll().map((model) => model.provider));
      if (ctx.model) ids.add(ctx.model.provider);
      for (const id of ids) {
        const native = registry.getRegisteredNativeProvider(id);
        const existing = installed.get(id);
        if (
          existing?.registry === registry &&
          native === existing.binding.wrapper
        )
          continue;
        release(id);
        let binding = native && wrappers.get(native);
        if (!binding) {
          const original = registry.getProvider(id);
          if (!original) continue;
          const owners: Binding["owners"] = new Map();
          const wrapper = new Proxy(original, {
            get(target, key) {
              const value = Reflect.get(target, key, target);
              if (
                (key === "stream" || key === "streamSimple") &&
                typeof value === "function"
              ) {
                return (...args: Parameters<Provider["streamSimple"]>) => {
                  const signal = args[2]?.signal;
                  const invocation =
                    signal &&
                    [...owners.values()]
                      .map((map) => map.get(signal))
                      .find((value) => value?.scope.state === "active");
                  const invoke = () =>
                    Reflect.apply(value, target, args) as ReturnType<
                      Provider["streamSimple"]
                    >;
                  try {
                    const stream = invocation
                      ? invocation.scope.run(invoke)
                      : invoke();
                    if (invocation?.onResult)
                      void stream
                        .result()
                        .then(invocation.onResult, () =>
                          invocation.onResult?.(),
                        )
                        .catch(() => {});
                    return stream;
                  } catch (error) {
                    try {
                      invocation?.onResult?.();
                    } catch {
                      /* Preserve the native provider error. */
                    }
                    throw error;
                  }
                };
              }
              return typeof value === "function" ? value.bind(target) : value;
            },
          });
          binding = {
            wrapper,
            previousNative: native,
            previousConfig: registry.getRegisteredProviderConfig(id),
            owners,
          };
          wrappers.set(wrapper, binding);
          pi.registerProvider(wrapper);
        }
        binding.owners.set(owner, scopes);
        installed.set(id, { binding, registry });
      }
    },
    dispose(): void {
      scopes.clear();
      for (const id of [...installed.keys()]) release(id);
    },
  };
}
