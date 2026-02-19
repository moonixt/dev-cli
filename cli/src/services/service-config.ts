import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../config";
import type { ServiceConfig, ServiceName } from "../types";

export function getServiceConfig(
  dotnetCommand: string,
  pythonCommand: string,
  npmCommand: string,
  dockerCommand: string
): Record<ServiceName, ServiceConfig> {
  const frontendRunner = resolveFrontendRunner(npmCommand);
  const wahaContainerId = (
    process.env.DEV_CLI_WAHA_CONTAINER ??
    "b84dd53b268f9012c1abfb0a5c53e35c8b571d8ebddf1389aa6316beac05d591"
  ).trim();

  return {
    api: {
      command: dotnetCommand,
      args: ["run"],
      cwd: path.join(repoRoot, "apps", "api"),
      label: "API"
    },
    sasa: {
      command: pythonCommand,
      args: ["app.py"],
      cwd: path.join(repoRoot, "apps", "sasa"),
      label: "SASA"
    },
    frontend: {
      command: frontendRunner.command,
      args: frontendRunner.args,
      cwd: path.join(repoRoot, "apps", "Frontend", "chat-motiristas"),
      label: "FRONTEND"
    },
    waha: {
      command: dockerCommand,
      args: ["logs", "--tail", "200", "-f", wahaContainerId],
      cwd: repoRoot,
      label: "WAHA",
      dockerContainerId: wahaContainerId
    }
  };
}

export function assertPathsExist(services: Record<ServiceName, ServiceConfig>): void {
  const missing = Object.values(services)
    .filter((service) => !fs.existsSync(service.cwd))
    .map((service) => service.cwd);

  if (missing.length > 0) {
    throw new Error(`Missing service folder(s): ${missing.join(", ")}`);
  }
}

function resolveFrontendRunner(npmCommand: string): { command: string; args: string[] } {
  const normalized = (npmCommand ?? "").trim().toLowerCase();
  const isDefaultNpm = normalized === "npm" || normalized === "npm.cmd";

  if (process.platform === "win32" && isDefaultNpm) {
    const npmCli = path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    );

    if (fs.existsSync(npmCli)) {
      return {
        command: process.execPath,
        args: [npmCli, "run", "start"]
      };
    }
  }

  return {
    command: npmCommand,
    args: ["run", "start"]
  };
}
