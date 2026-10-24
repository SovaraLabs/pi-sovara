import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import {
  AgentSession,
  createBashToolDefinition,
  createPowerShellToolDefinition,
  VERSION,
} from "@earendil-works/pi-coding-agent";
import type { Turn } from "@sovara/sdk";

export const PARENT_ENV = "SOVARA_PI_PARENT";
type Invocation = { owner: Owner; turn?: Turn };
type ShellSpawn = { pending: boolean };
type Definition = NonNullable<ReturnType<AgentSession["getToolDefinition"]>>;
type Owner = {
  manager?: object;
  invocation?: Invocation;
  shells: Map<
    Definition,
    { original: Definition["execute"]; wrapper: Definition["execute"] }
  >;
};
const key = Symbol.for("sovara.pi.childHandoff.v1");
const identityKey = Symbol.for("sovara.pi.nativeShellIdentity.v1");
type ShellIdentities = {
  sessions: WeakMap<AgentSession, readonly (Definition | undefined)[]>;
  definitions: WeakMap<Definition, Definition["execute"]>;
};
const identities = ((
  globalThis as typeof globalThis & {
    [identityKey]?: ShellIdentities;
  }
)[identityKey] ??= {
  sessions: new WeakMap(),
  definitions: new WeakMap(),
});
type Runtime = {
  context: AsyncLocalStorage<Invocation | undefined>;
  sessions: WeakMap<object, Owner>;
  owners: Set<Owner>;
  restore: () => void;
};
const shared = globalThis as typeof globalThis & { [key]?: Runtime };

function install(): Runtime {
  // These two exported entry points cover Pi 1.2.0's native run/retry loop.
  // Recheck upstream execution boundaries before widening the supported peer.
  if (VERSION !== "1.2.0")
    throw new Error("Sovara child handoff requires Pi 1.2.0");
  if (shared[key]) return shared[key];
  const context = new AsyncLocalStorage<Invocation | undefined>();
  const shellSpawn = new AsyncLocalStorage<ShellSpawn>();
  const sessions = new WeakMap<object, Owner>();
  const restore: (() => void)[] = [];
  const runtime: Runtime = {
    context,
    sessions,
    owners: new Set(),
    restore: () => {
      for (const undo of restore.reverse()) undo();
      syncBuiltinESMExports();
      if (shared[key] === runtime) delete shared[key];
    },
  };
  for (const name of ["prompt", "sendCustomMessage"] as const) {
    const original = AgentSession.prototype[name];
    const wrapper = function (this: AgentSession, ...args: unknown[]) {
      const owner = sessions.get(this.sessionManager);
      if (owner) bindNativeShells(this, owner);
      // A nested unrelated session must not borrow its caller's authority.
      return context.run(owner ? { owner } : undefined, () =>
        Reflect.apply(original, this, args),
      );
    };
    Reflect.set(AgentSession.prototype, name, wrapper);
    restore.push(() => {
      if (AgentSession.prototype[name] === wrapper)
        Reflect.set(AgentSession.prototype, name, original);
    });
  }
  const parent = (): string | undefined => {
    const invocation = context.getStore();
    return invocation?.turn?.state === "active"
      ? JSON.stringify(invocation.turn.exportParentContext())
      : undefined;
  };
  function remember(
    session: AgentSession,
    name: string,
    definition: Definition | undefined,
  ): void {
    if (
      !identities.sessions.has(session) ||
      !definition ||
      identities.definitions.has(definition)
    )
      return;
    if (name !== "bash" && name !== "powershell") return;
    const info = session.getAllTools().find((tool) => tool.name === name);
    if (
      info?.sourceInfo.source !== "builtin" ||
      info.sourceInfo.path !== `builtin:${name}`
    )
      return;
    // In Pi1.2 SDK baseTools overrides are synthesized minimal definitions. Their
    // executors are caller-owned even though their sourceInfo also says builtin.
    const template =
      name === "bash"
        ? createBashToolDefinition(session.sessionManager.getCwd())
        : createPowerShellToolDefinition(session.sessionManager.getCwd());
    if (
      !Object.keys(template).every((key) => Object.hasOwn(definition, key)) ||
      definition.parameters !== template.parameters ||
      definition.outputSchema !== template.outputSchema
    )
      return;
    identities.definitions.set(definition, definition.execute);
  }
  // Observe the public creation/publication boundary before callers can acquire
  // a definition. A session that predates extension initialization is unknown.
  const watched = new WeakSet<object>();
  const getActive = AgentSession.prototype.getActiveToolNames;
  const getDefinition = AgentSession.prototype.getToolDefinition;
  const currentDefinitions = (session: AgentSession) =>
    ["bash", "powershell"].map(
      (name) =>
        Reflect.apply(getDefinition, session, [name]) as Definition | undefined,
    );
  function observe(session: AgentSession): void {
    const state = session.agent.state;
    if (watched.has(state)) return;
    const current = currentDefinitions(session);
    const previous = identities.sessions.get(session);
    // Empty registry is Pi1.2's constructor boundary. Reinstall/reload may reuse
    // only a registry previously observed; an unobserved rebuild is unknown.
    if (
      session.getAllTools().length !== 0 &&
      (!previous ||
        current.some((definition, index) => definition !== previous[index]))
    )
      return;
    const descriptor = Object.getOwnPropertyDescriptor(state, "tools");
    if (!descriptor?.configurable || !descriptor.get || !descriptor.set) return;
    identities.sessions.set(session, current);
    watched.add(state);
    const entry = {
      state,
      descriptor,
      wrapper: undefined as ((value: unknown) => void) | undefined,
    };
    entry.wrapper = function (this: unknown, value: unknown) {
      const definitions = currentDefinitions(session);
      for (const [index, name] of ["bash", "powershell"].entries())
        remember(session, name, definitions[index]);
      identities.sessions.set(session, definitions);
      Reflect.apply(entry.descriptor.set!, this, [value]);
    };
    Object.defineProperty(state, "tools", {
      ...descriptor,
      set: entry.wrapper,
    });
    const weak = new WeakRef(entry);
    restore.push(() => {
      const current = weak.deref();
      if (
        current &&
        Object.getOwnPropertyDescriptor(current.state, "tools")?.set ===
          current.wrapper
      )
        Object.defineProperty(current.state, "tools", current.descriptor);
    });
  }
  const activeWrapper: typeof getActive = function (this: AgentSession) {
    observe(this);
    return Reflect.apply(getActive, this, []);
  };
  AgentSession.prototype.getActiveToolNames = activeWrapper;
  restore.push(() => {
    if (AgentSession.prototype.getActiveToolNames === activeWrapper)
      AgentSession.prototype.getActiveToolNames = getActive;
  });
  const definitionWrapper: typeof getDefinition = function (
    this: AgentSession,
    name,
  ) {
    observe(this);
    const definition = Reflect.apply(getDefinition, this, [name]);
    if (watched.has(this.agent.state)) remember(this, name, definition);
    return definition;
  };
  AgentSession.prototype.getToolDefinition = definitionWrapper;
  restore.push(() => {
    if (AgentSession.prototype.getToolDefinition === definitionWrapper)
      AgentSession.prototype.getToolDefinition = getDefinition;
  });
  function bindNativeShells(session: AgentSession, owner: Owner): void {
    for (const name of ["bash", "powershell"]) {
      const definition = session.getToolDefinition(name);
      if (
        !definition ||
        owner.shells.has(definition) ||
        identities.definitions.get(definition) !== definition.execute ||
        Object.getOwnPropertyDescriptor(definition, "execute")?.writable !==
          true
      )
        continue;
      const original = definition.execute;
      const wrapper: Definition["execute"] = function (this: unknown, ...args) {
        const invoke = () => Reflect.apply(original, this, args);
        return context.getStore()?.owner === owner
          ? shellSpawn.run({ pending: true }, invoke)
          : invoke();
      };
      definition.execute = wrapper;
      owner.shells.set(definition, { original, wrapper });
    }
  }
  // All native async child APIs, including previously captured imports, reach
  // this public method after Node normalizes arguments and envPairs.
  const prototype = childProcess.ChildProcess
    .prototype as typeof childProcess.ChildProcess.prototype & {
    spawn(options: { env?: NodeJS.ProcessEnv; envPairs: string[] }): unknown;
  };
  const spawn = prototype.spawn;
  const scopedSpawn: typeof spawn = function (
    this: childProcess.ChildProcess,
    options,
  ) {
    const nativeShell = shellSpawn.getStore();
    if (!context.getStore() || (options.env != null && !nativeShell?.pending))
      return Reflect.apply(spawn, this, [options]);
    if (nativeShell) nativeShell.pending = false;
    const value = parent();
    const envPairs = options.envPairs.filter(
      (entry) => !entry.startsWith(`${PARENT_ENV}=`),
    );
    if (value !== undefined) envPairs.push(`${PARENT_ENV}=${value}`);
    return Reflect.apply(spawn, this, [{ ...options, envPairs }]);
  };
  prototype.spawn = scopedSpawn;
  restore.push(() => {
    if (prototype.spawn === scopedSpawn) prototype.spawn = spawn;
  });
  for (const name of ["spawnSync", "execFileSync", "execSync"] as const) {
    const original = childProcess[name];
    const wrapper = function (this: unknown, ...args: unknown[]) {
      if (!context.getStore()) return Reflect.apply(original, this, args);
      const index = name === "execSync" || !Array.isArray(args[1]) ? 1 : 2;
      const options = args[index];
      // Leave invalid options to Node's original validation/error behavior.
      if (
        options != null &&
        (typeof options !== "object" || Array.isArray(options))
      )
        return Reflect.apply(original, this, args);
      if ((options as { env?: unknown } | undefined)?.env != null)
        return Reflect.apply(original, this, args);
      const env = { ...process.env };
      const value = parent();
      if (value === undefined) delete env[PARENT_ENV];
      else env[PARENT_ENV] = value;
      args[index] = { ...(options as object), env };
      return Reflect.apply(original, this, args);
    };
    Reflect.set(childProcess, name, wrapper);
    restore.push(() => {
      if (childProcess[name] === wrapper)
        Reflect.set(childProcess, name, original);
    });
  }
  syncBuiltinESMExports();
  shared[key] = runtime;
  return runtime;
}

/** Incoming process context is configuration; live authority stays invocation-local. */
export function bindChildHandoff() {
  const owner: Owner = { shells: new Map() };
  let runtime: Runtime | undefined = install();
  runtime.owners.add(owner);
  return {
    bind(manager: object) {
      runtime = install();
      const previous = runtime.sessions.get(manager);
      if (previous && previous !== owner)
        throw new Error("Sovara already owns this Pi session's child handoff");
      owner.manager = manager;
      runtime.sessions.set(manager, owner);
      runtime.owners.add(owner);
    },
    activate(turn: Turn) {
      const invocation = runtime?.context.getStore();
      if (invocation?.owner !== owner) return;
      invocation.turn = turn;
      owner.invocation = invocation;
    },
    closeTurn() {
      if (owner.invocation) owner.invocation.turn = undefined;
      owner.invocation = undefined;
    },
    dispose() {
      this.closeTurn();
      for (const [definition, { original, wrapper }] of owner.shells)
        if (definition.execute === wrapper) definition.execute = original;
      owner.shells.clear();
      if (!runtime) return;
      if (owner.manager && runtime.sessions.get(owner.manager) === owner)
        runtime.sessions.delete(owner.manager);
      runtime.owners.delete(owner);
      if (!runtime.owners.size) runtime.restore();
      owner.manager = undefined;
      runtime = undefined;
    },
  };
}
