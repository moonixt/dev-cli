import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dayMs = 24 * 60 * 60 * 1000;

function formatDayUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

test("appendServiceLogLine writes daily file and prunes files older than retention", async () => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "dev-cli-log-"));
  process.env.DEV_CLI_LOG_ROOT = tmpRoot;
  const compiledModulePath = path.resolve(__dirname, "..", "src", "utils", "service-log-file.js");
  const sourceModulePath = path.resolve(process.cwd(), "src", "utils", "service-log-file.ts");
  const modulePath = fs.existsSync(compiledModulePath) ? compiledModulePath : sourceModulePath;
  const logModule = await import(modulePath);

  const now = new Date("2026-02-21T12:00:00.000Z");
  const old = new Date(now.getTime() - 9 * dayMs);
  const oldDay = formatDayUTC(old);
  const oldFile = path.join(tmpRoot, "services", "api", `api-${oldDay}.txt`);
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, "legacy\n", "utf8");

  logModule.appendServiceLogLine({
    service: "api",
    stream: "stdout",
    line: "boot complete",
    timestamp: now.getTime(),
    retentionDays: 7
  });

  const todayPath = logModule.getServiceDailyLogPath("api", now);
  assert.equal(fs.existsSync(todayPath), true);
  assert.equal(fs.existsSync(oldFile), false);
});
