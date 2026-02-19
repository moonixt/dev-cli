import { spawn } from "node:child_process";
import readline from "node:readline";
import type { Readable } from "node:stream";
import type {
  BackgroundService,
  LogView,
  RunTarget,
  ServiceConfig,
  ServiceLogEntry,
  ServiceName,
  ShellState
} from "../types";
import { terminateProcess } from "../utils/process";

const maxShellLogLines = 1000;

export function createShellState(): ShellState {
  return {
    running: new Map<ServiceName, BackgroundService>(),
    logs: [],
    logView: "all",
    message: ""
  };
}

export function setShellMessage(shellState: ShellState, message: string): void {
  shellState.message = message;
  if (shellState.onChange) {
    shellState.onChange();
  }
}

export function writeShellOutput(shellState: ShellState, message: string): void {
  setShellMessage(shellState, message);
  if (!shellState.onChange && message) {
    process.stdout.write(`${message}\n`);
  }
}

export function getRunningSummary(shellState: ShellState): string {
  if (shellState.running.size === 0) {
    return "none";
  }

  const order: ServiceName[] = ["api", "sasa"];
  const parts = order
    .filter((serviceName) => shellState.running.has(serviceName))
    .map((serviceName) => {
      const running = shellState.running.get(serviceName);
      return `${serviceName} (${running?.pid ?? "?"})`;
    });

  return parts.join(", ");
}

export function setLogView(shellState: ShellState, view: LogView): void {
  shellState.logView = view;
  if (shellState.onChange) {
    shellState.onChange();
  }
}

export function clearLogs(shellState: ShellState): void {
  shellState.logs = [];
  if (shellState.onChange) {
    shellState.onChange();
  }
}

export function getVisibleLogs(shellState: ShellState, limit: number): ServiceLogEntry[] {
  const filtered =
    shellState.logView === "all"
      ? shellState.logs
      : shellState.logs.filter((entry) => entry.service === shellState.logView);
  if (filtered.length <= limit) {
    return filtered;
  }

  return filtered.slice(filtered.length - limit);
}

export function startBackground(
  target: RunTarget,
  services: Record<ServiceName, ServiceConfig>,
  shellState: ShellState
): number {
  const targets: ServiceName[] = target === "all" ? ["api", "sasa"] : [target];
  const messages: string[] = [];
  let hasError = false;

  for (const serviceName of targets) {
    const result = startServiceInBackground(serviceName, services[serviceName], shellState);
    messages.push(result.message);
    if (!result.ok) {
      hasError = true;
    }
  }

  writeShellOutput(shellState, messages.join(" | "));
  return hasError ? 1 : 0;
}

export function stopBackground(target: RunTarget, shellState: ShellState): number {
  const targets: ServiceName[] = target === "all" ? ["api", "sasa"] : [target];
  const messages: string[] = [];
  let hasError = false;

  for (const serviceName of targets) {
    const result = stopServiceInBackground(serviceName, shellState);
    messages.push(result.message);
    if (!result.ok) {
      hasError = true;
    }
  }

  writeShellOutput(shellState, messages.join(" | "));
  return hasError ? 1 : 0;
}

export function stopAllRunning(shellState: ShellState): void {
  const active = Array.from(shellState.running.keys());
  for (const serviceName of active) {
    const running = shellState.running.get(serviceName);
    if (!running) {
      continue;
    }
    shellState.running.delete(serviceName);
    terminateProcess(running.child);
  }
}

export function isSuggestionRunning(command: string, shellState: ShellState): boolean {
  if (command === "/start api") {
    return shellState.running.has("api");
  }

  if (command === "/start sasa") {
    return shellState.running.has("sasa");
  }

  if (command === "/start all") {
    return shellState.running.has("api") && shellState.running.has("sasa");
  }

  return false;
}

function startServiceInBackground(
  serviceName: ServiceName,
  service: ServiceConfig,
  shellState: ShellState
): { ok: boolean; message: string } {
  if (shellState.running.has(serviceName)) {
    const existing = shellState.running.get(serviceName);
    return { ok: false, message: `${serviceName} already running (${existing?.pid ?? "?"})` };
  }

  const child = spawn(service.command, service.args, {
    cwd: service.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
    windowsHide: true
  });

  const pid = child.pid;
  if (!pid) {
    return { ok: false, message: `${serviceName} failed to start` };
  }

  shellState.running.set(serviceName, { child, pid });
  attachStreamReader(serviceName, "stdout", child.stdout, shellState);
  attachStreamReader(serviceName, "stderr", child.stderr, shellState);

  child.on("error", (error) => {
    const running = shellState.running.get(serviceName);
    if (running?.child === child) {
      shellState.running.delete(serviceName);
    }
    writeShellOutput(shellState, `${serviceName} error: ${error.message}`);
  });

  child.on("exit", (code, signal) => {
    const running = shellState.running.get(serviceName);
    if (running?.child === child) {
      shellState.running.delete(serviceName);
    }

    if (signal || code !== 0) {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      writeShellOutput(shellState, `${serviceName} stopped (${reason})`);
    } else {
      writeShellOutput(shellState, `${serviceName} stopped`);
    }
  });

  return { ok: true, message: `${serviceName} started (${pid})` };
}

function stopServiceInBackground(serviceName: ServiceName, shellState: ShellState): { ok: boolean; message: string } {
  const running = shellState.running.get(serviceName);
  if (!running) {
    return { ok: false, message: `${serviceName} is not running` };
  }

  shellState.running.delete(serviceName);
  terminateProcess(running.child);
  return { ok: true, message: `${serviceName} stopping` };
}

function attachStreamReader(
  serviceName: ServiceName,
  streamType: "stdout" | "stderr",
  stream: Readable | null,
  shellState: ShellState
): void {
  if (!stream) {
    return;
  }

  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    addLog(shellState, {
      service: serviceName,
      stream: streamType,
      line: sanitizeLogLine(line),
      timestamp: Date.now()
    });
  });
}

function addLog(shellState: ShellState, entry: ServiceLogEntry): void {
  shellState.logs.push(entry);
  if (shellState.logs.length > maxShellLogLines) {
    shellState.logs.splice(0, shellState.logs.length - maxShellLogLines);
  }

  if (shellState.onChange) {
    shellState.onChange();
  }
}

function sanitizeLogLine(line: string): string {
  const clean = line.replace(/\r/g, "").trimEnd();
  return clean.length === 0 ? "(blank)" : clean;
}
