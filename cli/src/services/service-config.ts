import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../config";
import type { ServiceConfig, ServiceName } from "../types";

export function getServiceConfig(dotnetCommand: string, pythonCommand: string): Record<ServiceName, ServiceConfig> {
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
