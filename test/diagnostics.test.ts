import { test } from "node:test";
import assert from "node:assert/strict";
import { CompatibilityError } from "@sovara/sdk";
import { explainError } from "../src/diagnostics.ts";
test("diagnostics expose known recovery guidance without remote errors", () => {
  assert.match(explainError({ status: 401, message: "PRIVATE" }), /Sign in/);
  assert.match(explainError({ status: 403 }), /access/);
  assert.match(
    explainError(new CompatibilityError("test", "PRIVATE")),
    /capability/,
  );
  assert.doesNotMatch(explainError(new Error("PRIVATE")), /PRIVATE/);
});
