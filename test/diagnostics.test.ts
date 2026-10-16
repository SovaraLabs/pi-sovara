import { test } from "node:test";
import assert from "node:assert/strict";
import { explainError } from "../src/diagnostics.ts";
import { SovaraError } from "../src/client.ts";

test("setup errors give safe, actionable instructions", () => {
  assert.match(
    explainError(new SovaraError("cli_not_found")),
    /Install it from https.*restart Pi/,
  );
  assert.match(
    explainError(new SovaraError("request_failed", 401)),
    /Sign in.*\/reload/,
  );
  assert.match(
    explainError(new SovaraError("request_failed", 403)),
    /access this project/,
  );
  assert.doesNotMatch(explainError(new Error("PRIVATE CLI OUTPUT")), /PRIVATE/);
  assert.match(
    explainError(new TypeError("PRIVATE", { cause: { code: "ECONNREFUSED" } })),
    /network or VPN/,
  );
});
