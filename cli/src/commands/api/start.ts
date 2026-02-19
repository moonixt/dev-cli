import { spawn, type ChildProcess } from "node:child_process";
import { Command } from "commander";
import { logPrefix } from "../../config";
import { assertPathsExist, getServiceConfig } from "../../services/service-config";
import type { RunTarget, ServiceConfig, ServiceName, StartCommandOptions } from "../../types";
import { terminateProcess } from "../../utils/process";
import { normalizeTarget } from "../../utils/target";

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .alias("run")
    .alias("/start")
    .description("Start API, SASA, or both")
    .argument("[target]", "api | sasa | all", "all")
    .option("--dotnet <command>", "Override dotnet executable", "dotnet")
    .option("--python <command>", "Override python executable", "python")
    .action(async (targetInput: string, options: StartCommandOptions) => {
      const services = getServiceConfig(options.dotnet, options.python);
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
    console.log(`${logPrefix} Starting API and SASA`);
    const api = spawnProcess(services.api, "api");
    const sasa = spawnProcess(services.sasa, "sasa");
    const children: ChildProcess[] = [api, sasa];

    let finished = 0;
    let resolved = false;
    let finalCode = 0;

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

    api.on("exit", onExit("api"));
    sasa.on("exit", onExit("sasa"));
  });
}

function spawnProcess(service: ServiceConfig, serviceName: ServiceName): ChildProcess {
  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    stdio: "inherit",
    env: process.env
  });

  child.on("error", (error) => {
    console.error(`${logPrefix} Failed to start ${serviceName}: ${error.message}`);
  });

  return child;
}
