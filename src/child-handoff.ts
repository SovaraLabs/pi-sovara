import { AsyncLocalStorage } from "node:async_hooks";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { AgentSession, VERSION } from "@earendil-works/pi-coding-agent";
import type { Turn } from "@sovara/sdk";

export const PARENT_ENV = "SOVARA_PI_PARENT";
type Invocation = { owner: Owner; turn?: Turn };
type Owner = { manager?: object; invocation?: Invocation };
const key = Symbol.for("sovara.pi.childHandoff.v1");
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
    if (!context.getStore() || options.env != null)
      return Reflect.apply(spawn, this, [options]);
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
  const owner: Owner = {};
  let runtime: Runtime | undefined;
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
