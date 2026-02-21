import { spawn, type ChildProcess } from "node:child_process";
import { Command } from "commander";
import path from "node:path";
import type { Readable } from "node:stream";
import { logPrefix } from "../../config";
import { loadWorkspaceConfig } from "../../services/config-loader";
import type { RunTarget, ServiceId, ServiceRuntimeConfig } from "../../types";
import { bold, colorService, cyan, green, red, yellow } from "../../utils/colors";
import { terminateProcess } from "../../utils/process";
import {
  appendServiceLogLine,
  getLegacyConsolidatedLogPath,
  getServiceLogsRootPath
} from "../../utils/service-log-file";
import { resolveRunTarget } from "../../utils/target";

type StartCommandOptions = {
  config?: string;
};

const logTag = bold(cyan(logPrefix));
const errorTag = bold(cyan(logPrefix, process.stderr), process.stderr);

export function registerStartCommand(program: Command): void {
  program
    .command("start")
    .alias("run")
    .alias("/start")
    .description("Start one configured service or all")
    .argument("[target]", "service id | all", "all")
    .option("--config <path>", "Path to dev-cli.config.json")
    .action(async (targetInput: string, options: StartCommandOptions) => {
      const workspace = loadWorkspaceConfig({
        explicitConfigPath: options.config,
        cwd: process.cwd()
      });
      process.env.DEV_CLI_LOG_ROOT = process.env.DEV_CLI_LOG_ROOT?.trim()
        ? process.env.DEV_CLI_LOG_ROOT
        : path.join(workspace.workspaceRoot, "logs");

      if (workspace.serviceOrder.length === 0) {
        console.error(
          `${errorTag} ${red('No services configured. Run "dev-cli init" to create dev-cli.config.json', process.stderr)}`
        );
        process.exitCode = 1;
        return;
      }

      const allTargets = workspace.groups.all?.length ? workspace.groups.all : workspace.serviceOrder;
      let target: RunTarget;
      try {
        target = resolveRunTarget(targetInput, workspace.serviceOrder);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`${errorTag} ${red(message, process.stderr)}`);
        process.exitCode = 1;
        return;
      }

      process.exitCode = await executeStart(target, workspace.services, allTargets);
    });
}

export async function executeStart(
  target: RunTarget,
  services: Record<ServiceId, ServiceRuntimeConfig>,
  allTargets: ServiceId[]
): Promise<number> {
  if (target === "all") {
    return runAll(allTargets, services);
  }

  const service = services[target];
  if (!service) {
    console.error(`${errorTag} ${red(`Unknown service "${target}"`, process.stderr)}`);
    return 1;
  }
  return runSingle(service.id, service);
}

function runSingle(serviceId: ServiceId, service: ServiceRuntimeConfig): Promise<number> {
  return new Promise((resolve) => {
    console.log(`${logTag} ${green("Starting")} ${colorService(serviceId, service.label)} ${yellow("in")} ${service.cwd}`);
    console.log(
      `${logTag} ${yellow("Writing logs to")} ${getServiceLogsRootPath()} ${yellow("| consolidated:")} ${getLegacyConsolidatedLogPath()}`
    );

    const child = spawnProcess(service, serviceId);
    if (!child) {
      resolve(1);
      return;
    }

    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(
          `${errorTag} ${colorService(serviceId, service.label, process.stderr)} ${red(`exited from signal ${signal}`, process.stderr)}`
        );
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function runAll(allTargets: ServiceId[], services: Record<ServiceId, ServiceRuntimeConfig>): Promise<number> {
  return new Promise((resolve) => {
    if (allTargets.length === 0) {
      console.error(`${errorTag} ${red("No services in group all", process.stderr)}`);
      resolve(1);
      return;
    }

    const serviceLabels = allTargets
      .map((serviceId) => colorService(serviceId, services[serviceId]?.label ?? serviceId))
      .join(", ");
    console.log(`${logTag} ${green("Starting")} ${serviceLabels}`);
    console.log(
      `${logTag} ${yellow("Writing logs to")} ${getServiceLogsRootPath()} ${yellow("| consolidated:")} ${getLegacyConsolidatedLogPath()}`
    );

    const childrenByService = new Map<ServiceId, ChildProcess>();
    let finalCode = 0;
    for (const serviceId of allTargets) {
      const service = services[serviceId];
      if (!service) {
        console.error(`${errorTag} ${red(`Unknown service "${serviceId}"`, process.stderr)}`);
        finalCode = 1;
        continue;
      }
      const child = spawnProcess(service, serviceId);
      if (child) {
        childrenByService.set(serviceId, child);
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
      console.log(`${logTag} ${yellow(`Received ${signal}, stopping services`)}`);
      stopAll();
      resolveOnce(0);
    };

    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const onExit = (serviceId: ServiceId) => (code: number | null, signal: NodeJS.Signals | null): void => {
      finished += 1;

      if (signal) {
        console.error(
          `${errorTag} ${colorService(serviceId, services[serviceId]?.label ?? serviceId, process.stderr)} ${red(`exited from signal ${signal}`, process.stderr)}`
        );
        finalCode = finalCode || 1;
      } else if ((code ?? 1) !== 0) {
        console.error(
          `${errorTag} ${colorService(serviceId, services[serviceId]?.label ?? serviceId, process.stderr)} ${red(`exited with code ${code}`, process.stderr)}`
        );
        finalCode = finalCode || (code ?? 1);
        stopAll();
      }

      if (finished >= children.length) {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
        resolveOnce(finalCode);
      }
    };

    for (const serviceId of allTargets) {
      const child = childrenByService.get(serviceId);
      if (child) {
        child.on("exit", onExit(serviceId));
      }
    }
  });
}

function spawnProcess(service: ServiceRuntimeConfig, serviceId: ServiceId): ChildProcess | null {
  let child: ChildProcess;
  try {
    child = spawn(service.command, service.args, {
      cwd: service.cwd,
      stdio: ["inherit", "pipe", "pipe"],
      env: {
        ...process.env,
        ...service.env
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `${errorTag} ${red("Failed to start", process.stderr)} ${colorService(serviceId, service.label, process.stderr)}: ${red(message, process.stderr)}`
    );
    return null;
  }

  child.on("error", (error) => {
    console.error(
      `${errorTag} ${red("Failed to start", process.stderr)} ${colorService(serviceId, service.label, process.stderr)}: ${red(error.message, process.stderr)}`
    );
  });

  attachProcessLogForwarding(child, service);
  return child;
}

function attachProcessLogForwarding(child: ChildProcess, service: ServiceRuntimeConfig): void {
  if (child.stdout) {
    forwardStreamToConsoleAndFile(child.stdout, process.stdout, service, "stdout");
  }
  if (child.stderr) {
    forwardStreamToConsoleAndFile(child.stderr, process.stderr, service, "stderr");
  }
}

function forwardStreamToConsoleAndFile(
  stream: Readable,
  output: NodeJS.WriteStream,
  service: ServiceRuntimeConfig,
  streamType: "stdout" | "stderr"
): void {
  let buffered = "";
  stream.on("data", (chunk: Buffer | string) => {
    output.write(chunk);
    buffered += chunk.toString();
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      if (!service.logEnabled) {
        continue;
      }
      appendServiceLogLine({
        service: service.id,
        stream: streamType,
        line: sanitizeLogLine(line),
        timestamp: Date.now(),
        retentionDays: service.logRetentionDays
      });
    }
  });

  stream.on("end", () => {
    if (buffered.length === 0 || !service.logEnabled) {
      return;
    }
    appendServiceLogLine({
      service: service.id,
      stream: streamType,
      line: sanitizeLogLine(buffered),
      timestamp: Date.now(),
      retentionDays: service.logRetentionDays
    });
    buffered = "";
  });
}

function sanitizeLogLine(line: string): string {
  const clean = line
    .replace(/\r/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, (sequence) => (sequence.endsWith("m") ? sequence : ""))
    .replace(/\u001b(?!\[[0-9;?]*[ -/]*m)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trimEnd();

  const visible = clean.replace(/\u001b\[[0-9;?]*[ -/]*m/g, "").trim();
  return visible.length === 0 ? "(blank)" : clean;
}
