import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { executeDevCli } from "../src/cli-exec";

test("cli_exec runs dev-cli and returns exit code", async (t) => {
  const cliDist = path.resolve(process.cwd(), "tools", "cli", "dist", "cli.js");
  if (!fs.existsSync(cliDist)) {
    t.skip("tools/cli/dist/cli.js not built");
    return;
  }

  process.env.LEMARSYN_REPO_ROOT = process.cwd();
  process.env.DEV_CLI_ENTRYPOINT = cliDist;

  const result = await executeDevCli(["--help"], 10_000);
  assert.equal(result.exit_code, 0);
  assert.equal(result.truncated, false);
  assert.match(result.stdout, /Usage:\s+dev-cli/);
});
