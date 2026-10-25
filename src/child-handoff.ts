import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ParentContext, Turn } from "@sovara/sdk";

export const PARENT_ENV = "SOVARA_PI_PARENT";
type Owner = { manager?: object; turn?: Turn };
const key = Symbol.for("sovara.pi.explicitParentContext.v1");
const shared = globalThis as typeof globalThis & {
  [key]?: WeakMap<object, Owner>;
};
// Separate trusted extensions can import another physical copy of this package.
// Only exact session-manager identity shares a binding; there is no ambient owner.
const sessions = (shared[key] ??= new WeakMap<object, Owner>());

/** Export a deliberate snapshot for one child launch. Never log or persist it. */
export function exportParentContext(
  ctx: Pick<ExtensionContext, "sessionManager">,
): ParentContext {
  // Read Pi's public getter each time: disposed/reloaded extension contexts reject
  // access rather than borrowing the replacement runner's active session.
  const owner = sessions.get(ctx.sessionManager);
  if (!owner?.turn || owner.turn.state !== "active")
    throw new Error("Sovara parent context requires an active recorded Pi turn");
  return owner.turn.exportParentContext();
}

/** Register only the session's active turn; never alter execution or environment. */
export function bindChildHandoff() {
  const owner: Owner = {};
  return {
    bind(manager: object) {
      const previous = sessions.get(manager);
      if (previous && previous !== owner)
        throw new Error("Sovara already owns this Pi session's parent context");
      if (owner.manager && owner.manager !== manager)
        sessions.delete(owner.manager);
      owner.manager = manager;
      sessions.set(manager, owner);
    },
    activate(turn: Turn) {
      if (!owner.manager || sessions.get(owner.manager) !== owner)
        throw new Error("Sovara parent context requires an initialized Pi session");
      owner.turn = turn;
    },
    closeTurn() {
      owner.turn = undefined;
    },
    dispose() {
      this.closeTurn();
      if (owner.manager && sessions.get(owner.manager) === owner)
        sessions.delete(owner.manager);
      owner.manager = undefined;
    },
  };
}
