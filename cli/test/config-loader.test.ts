import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadWorkspaceConfig,
  resolveConfigPath,
  validateWorkspaceConfig,
  workspaceConfigFileName
} from "../src/services/config-loader";
import type { WorkspaceConfigFile } from "../src/types";

function mkTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dev-cli-config-"));
}

function writeConfig(dir: string, payload: WorkspaceConfigFile): string {
  const filePath = path.join(dir, workspaceConfigFileName);
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

function baseConfig(): WorkspaceConfigFile {
  return {
    version: 1,
    workspaceName: "test",
    services: [
      {
        id: "api",
        cwd: ".",
        start: { command: "node", args: ["-v"] }
      }
    ],
    groups: {
      all: ["api"]
    }
  };
}

test("resolveConfigPath uses explicit argument first", () => {
  const root = mkTmpDir();
  const configPath = writeConfig(root, baseConfig());
  const resolved = resolveConfigPath({
    cwd: root,
    explicitConfigPath: configPath
  });
  assert.equal(resolved, configPath);
});

test("resolveConfigPath searches parent directories", () => {
  const root = mkTmpDir();
  const nested = path.join(root, "apps", "api");
  fs.mkdirSync(nested, { recursive: true });
  const configPath = writeConfig(root, baseConfig());
  const resolved = resolveConfigPath({ cwd: nested });
  assert.equal(resolved, configPath);
});

test("loadWorkspaceConfig returns empty workspace when config is missing", () => {
  const root = mkTmpDir();
  const loaded = loadWorkspaceConfig({ cwd: root });
  assert.equal(loaded.configPath, null);
  assert.deepEqual(loaded.serviceOrder, []);
  assert.deepEqual(loaded.groups.all, []);
});

test("validateWorkspaceConfig fails when service id is invalid", () => {
  const root = mkTmpDir();
  const payload: WorkspaceConfigFile = {
    version: 1,
    services: [
      {
        id: "A!",
        cwd: ".",
        start: { command: "node" }
      }
    ]
  };
  assert.throws(() => validateWorkspaceConfig(payload, root, "config.json"), /service.id/);
});

test("validateWorkspaceConfig fails when cwd does not exist", () => {
  const root = mkTmpDir();
  const payload: WorkspaceConfigFile = {
    version: 1,
    services: [
      {
        id: "api",
        cwd: "missing-folder",
        start: { command: "node" }
      }
    ]
  };
  assert.throws(() => validateWorkspaceConfig(payload, root, "config.json"), /cwd not found/);
});

test("validateWorkspaceConfig fails when group references unknown service", () => {
  const root = mkTmpDir();
  const payload: WorkspaceConfigFile = {
    version: 1,
    services: [
      {
        id: "api",
        cwd: ".",
        start: { command: "node" }
      }
    ],
    groups: {
      all: ["api"],
      backend: ["worker"]
    }
  };
  assert.throws(() => validateWorkspaceConfig(payload, root, "config.json"), /unknown service "worker"/);
});
