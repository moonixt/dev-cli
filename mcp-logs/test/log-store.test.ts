import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { LogStore } from "../src/log-store";

function createTempLogRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mcp-logs-test-"));
}

function writeLines(filePath: string, lines: string[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

test("parseJsonLine parses valid JSONL entry", () => {
  const line = JSON.stringify({
    ts: "2026-02-21T15:00:00.000Z",
    service: "api",
    stream: "stdout",
    level: "info",
    msg: "ok"
  });
  const parsed = LogStore.parseJsonLine(line);
  assert.ok(parsed);
  assert.equal(parsed.service, "api");
  assert.equal(parsed.level, "info");
});

test("parseJsonLine ignores invalid JSONL entry", () => {
  const parsed = LogStore.parseJsonLine('{"ts":"bad","service":"api"}');
  assert.equal(parsed, null);
});

test("resolveFilePathForDay builds service day path", () => {
  const root = createTempLogRoot();
  const store = new LogStore({ logRoot: root });
  const filePath = store.resolveFilePathForDay("api", "2026-02-21");
  assert.equal(path.basename(filePath), "api-2026-02-21.txt");
  assert.equal(path.dirname(filePath), path.join(root, "api"));
});

test("tail and search ignore malformed lines", () => {
  const root = createTempLogRoot();
  const store = new LogStore({ logRoot: root });
  const filePath = store.resolveFilePathForDay("api", "2026-02-21");
  writeLines(filePath, [
    '{"ts":"2026-02-21T15:00:00.000Z","service":"api","stream":"stdout","level":"info","msg":"booted"}',
    "not-json",
    '{"ts":"2026-02-21T15:01:00.000Z","service":"api","stream":"stderr","level":"error","msg":"failed connect"}'
  ]);

  const tail = store.tail("api", 10, "2026-02-21");
  assert.equal(tail.entries.length, 2);

  const search = store.search("api", "failed", 10, "2026-02-21", false);
  assert.equal(search.entries.length, 1);
  assert.equal(search.entries[0]?.level, "error");
});
