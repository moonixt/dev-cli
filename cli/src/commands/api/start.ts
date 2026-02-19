import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { Command } from "commander";
import { logPrefix } from "../../config";
import { assertPathsExist, getServiceConfig } from "../../services/service-config";
import type { RunTarget, ServiceConfig, ServiceName, StartCommandOptions } from "../../types";
import { terminateProcess } from "../../utils/process";
import { normalizeTarget } from "../../utils/target";

const defaultNpmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const defaultDockerCommand = "docker";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .alias("run")
    .alias("/start")
    .description("Start API, SASA, frontend, WAHA, or all")
    .argument("[target]", "api | sasa | frontend | waha | all", "all")
    .option("--dotnet <command>", "Override dotnet executable", "dotnet")
    .option("--python <command>", "Override python executable", "python")
    .option("--npm <command>", "Override npm executable", defaultNpmCommand)
    .option("--docker <command>", "Override docker executable", defaultDockerCommand)
    .action(async (targetInput: string, options: StartCommandOptions) => {
      const services = getServiceConfig(options.dotnet, options.python, options.npm, options.docker);
      assertPathsExist(services);
      const target = normalizeTarget(targetInput);
      process.exitCode = await executeStart(target, services);
    });
}

export async function executeStart(
  target: RunTarget,
  services: Record<ServiceName, ServiceConfig>
): Promise<number> {
  if (target === "all") {
    return runAll(services);
  }

  return runSingle(target, services[target]);
}

function runSingle(name: ServiceName, service: ServiceConfig): Promise<number> {
  return new Promise((resolve) => {
    console.log(`${logPrefix} Starting ${service.label} in ${service.cwd}`);
    const child = spawnProcess(service, name);
    if (!child) {
      resolve(1);
      return;
    }

    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`${logPrefix} ${service.label} exited from signal ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function runAll(services: Record<ServiceName, ServiceConfig>): Promise<number> {
  return new Promise((resolve) => {
    const targets: ServiceName[] = ["api", "sasa", "frontend", "waha"];
    console.log(`${logPrefix} Starting API, SASA, FRONTEND and WAHA`);
    const childrenByService = new Map<ServiceName, ChildProcess>();
    let finalCode = 0;
    for (const serviceName of targets) {
      const child = spawnProcess(services[serviceName], serviceName);
      if (child) {
        childrenByService.set(serviceName, child);
      } else {
        finalCode = 1;
      }
    }
    const children = Array.from(childrenByService.values());
    if (children.length === 0) {
      resolve(1);
      return;
    }

    let finished = 0;
    let resolved = false;

    const resolveOnce = (code: number): void => {
      if (!resolved) {
        resolved = true;
        resolve(code);
      }
    };

    const stopAll = (): void => {
      for (const child of children) {
        terminateProcess(child);
      }
    };

    const onSignal = (signal: NodeJS.Signals): void => {
      console.log(`${logPrefix} Received ${signal}, stopping services`);
      stopAll();
      resolveOnce(0);
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const onExit = (serviceName: ServiceName) => (code: number | null, signal: NodeJS.Signals | null): void => {
      finished += 1;

      if (signal) {
        console.error(`${logPrefix} ${serviceName} exited from signal ${signal}`);
        finalCode = finalCode || 1;
      } else if ((code ?? 1) !== 0) {
        console.error(`${logPrefix} ${serviceName} exited with code ${code}`);
        finalCode = finalCode || (code ?? 1);
        stopAll();
      }

      if (finished >= children.length) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolveOnce(finalCode);
      }
    };

    for (const serviceName of targets) {
      const child = childrenByService.get(serviceName);
      if (child) {
        child.on("exit", onExit(serviceName));
      }
    }
  });
}

function spawnProcess(service: ServiceConfig, serviceName: ServiceName): ChildProcess | null {
  if (service.dockerContainerId) {
    const ensureRunning = ensureDockerContainerRunning(service);
    if (!ensureRunning.ok) {
      console.error(`${logPrefix} Failed to start ${serviceName} container: ${ensureRunning.message}`);
      return null;
    }
  }

  let child: ChildProcess;
  try {
    child = spawn(service.command, service.args, {
      cwd: service.cwd,
      stdio: "inherit",
      env: process.env
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} Failed to start ${serviceName}: ${message}`);
    return null;
  }

  child.on("error", (error) => {
    console.error(`${logPrefix} Failed to start ${serviceName}: ${error.message}`);
  });

  return child;
}

function ensureDockerContainerRunning(service: ServiceConfig): { ok: boolean; message: string } {
  if (!service.dockerContainerId) {
    return { ok: true, message: "" };
  }

  const result = spawnSync(service.command, ["start", service.dockerContainerId], {
    cwd: service.cwd,
    env: process.env,
    windowsHide: true,
    encoding: "utf8"
  });

  if (result.error) {
    return { ok: false, message: result.error.message };
  }

  if (result.status === 0) {
    return { ok: true, message: "started" };
  }

  const stderr = (result.stderr ?? "").toString().trim();
  const stdout = (result.stdout ?? "").toString().trim();
  const combined = `${stdout} ${stderr}`.toLowerCase();
  if (combined.includes("already running")) {
    return { ok: true, message: "already running" };
  }

  return { ok: false, message: stderr || stdout || `exit code ${result.status ?? "?"}` };
}
