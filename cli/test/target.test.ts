import assert from "node:assert/strict";
import test from "node:test";
import { resolveRunTarget } from "../src/utils/target";

test("resolveRunTarget resolves known service", () => {
  const target = resolveRunTarget("api", ["api", "worker"]);
  assert.equal(target, "api");
});

test("resolveRunTarget resolves all", () => {
  const target = resolveRunTarget("all", ["api", "worker"]);
  assert.equal(target, "all");
});

test("resolveRunTarget throws for unknown service", () => {
  assert.throws(() => resolveRunTarget("unknown", ["api", "worker"]), /Invalid target/);
});
