import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
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
import { appendServiceLogLine } from "../utils/service-log-file";

const maxShellLogLines = 1000;
const serviceOrder: ServiceName[] = ["api", "sasa", "frontend", "waha"];

export function createShellState(): ShellState {
  return {
    running: new Map<ServiceName, BackgroundService>(),
    logs: [],
    logView: "off",
    logScrollOffset: { api: 0, sasa: 0, frontend: 0, waha: 0 },
    splitLogFocus: "api",
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

  const parts = serviceOrder
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
  shellState.logScrollOffset.api = 0;
  shellState.logScrollOffset.sasa = 0;
  shellState.logScrollOffset.frontend = 0;
  shellState.logScrollOffset.waha = 0;
  if (shellState.onChange) {
    shellState.onChange();
  }
}

export function getVisibleLogs(shellState: ShellState, limit: number): ServiceLogEntry[] {
  if (shellState.logView === "off") {
    return [];
  }

  if (shellState.logView === "all") {
    return sliceWithOffset(shellState.logs, limit, 0);
  }

  const filtered = shellState.logs.filter((entry) => entry.service === shellState.logView);
  return sliceWithOffset(filtered, limit, shellState.logScrollOffset[shellState.logView]);
}

export function getServiceLogs(shellState: ShellState, serviceName: ServiceName, limit: number): ServiceLogEntry[] {
  const filtered = shellState.logs.filter((entry) => entry.service === serviceName);
  return sliceWithOffset(filtered, limit, shellState.logScrollOffset[serviceName]);
}

export function getSplitLogFocus(shellState: ShellState): ServiceName {
  return shellState.splitLogFocus;
}

export function getLogScrollOffset(shellState: ShellState, serviceName: ServiceName): number {
  return shellState.logScrollOffset[serviceName];
}

export function setSplitLogFocus(shellState: ShellState, serviceName: ServiceName): void {
  if (shellState.splitLogFocus === serviceName) {
    return;
  }

  shellState.splitLogFocus = serviceName;
  if (shellState.onChange) {
    shellState.onChange();
  }
}

export function scrollFocusedLog(
  shellState: ShellState,
  delta: number,
  visibleLines: number
): { changed: boolean; service: ServiceName; offset: number } {
  const targetService = resolveFocusedService(shellState);
  const changed = scrollServiceLogs(shellState, targetService, delta, visibleLines);
  return {
    changed,
    service: targetService,
    offset: shellState.logScrollOffset[targetService]
  };
}

export function resetFocusedLogScroll(
  shellState: ShellState
): { changed: boolean; service: ServiceName; offset: number } {
  const targetService = resolveFocusedService(shellState);
  const changed = shellState.logScrollOffset[targetService] !== 0;
  shellState.logScrollOffset[targetService] = 0;
  if (changed && shellState.onChange) {
    shellState.onChange();
  }

  return {
    changed,
    service: targetService,
    offset: shellState.logScrollOffset[targetService]
  };
}

export function startBackground(
  target: RunTarget,
  services: Record<ServiceName, ServiceConfig>,
  shellState: ShellState
): number {
  const targets: ServiceName[] = target === "all" ? serviceOrder : [target];
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

export function stopBackground(
  target: RunTarget,
  services: Record<ServiceName, ServiceConfig>,
  shellState: ShellState
): number {
  const targets: ServiceName[] = target === "all" ? serviceOrder : [target];
  const messages: string[] = [];
  let hasError = false;

  for (const serviceName of targets) {
    const result = stopServiceInBackground(serviceName, shellState, services[serviceName]);
    messages.push(result.message);
    if (!result.ok) {
      hasError = true;
    }
  }

  writeShellOutput(shellState, messages.join(" | "));
  return hasError ? 1 : 0;
}

export function stopAllRunning(shellState: ShellState, services?: Record<ServiceName, ServiceConfig>): void {
  const active = Array.from(shellState.running.keys());
  for (const serviceName of active) {
    const running = shellState.running.get(serviceName);
    if (!running) {
      continue;
    }

    if (running.external) {
      continue;
    }

    stopServiceInBackground(serviceName, shellState, services?.[serviceName]);
  }
}

export function hydrateRunningServices(
  shellState: ShellState,
  services: Record<ServiceName, ServiceConfig>
): void {
  for (const serviceName of serviceOrder) {
    if (shellState.running.has(serviceName)) {
      continue;
    }

    const service = services[serviceName];
    const pid = service.dockerContainerId
      ? findRunningDockerContainerPid(service)
      : findRunningProcessByCwd(service);

    if (!pid || pid <= 0) {
      continue;
    }

    shellState.running.set(serviceName, { pid, external: true });
  }
}

export function attachExternalLogStreams(
  shellState: ShellState,
  services: Record<ServiceName, ServiceConfig>,
  targets: ServiceName[]
): void {
  for (const serviceName of targets) {
    const running = shellState.running.get(serviceName);
    if (!running?.external || running.child) {
      continue;
    }

    const service = services[serviceName];
    // Today only WAHA has a safe way to attach history + follow logs for an existing process.
    if (!service.dockerContainerId) {
      continue;
    }

    const result = startServiceInBackground(serviceName, service, shellState);
    if (!result.ok) {
      writeShellOutput(shellState, result.message);
    }
  }
}

export function isSuggestionRunning(command: string, shellState: ShellState): boolean {
  if (command === "/start api") {
    return shellState.running.has("api");
  }

  if (command === "/start sasa") {
    return shellState.running.has("sasa");
  }

  if (command === "/start frontend") {
    return shellState.running.has("frontend");
  }

  if (command === "/start waha") {
    return shellState.running.has("waha");
  }

  if (command === "/start all") {
    return serviceOrder.every((serviceName) => shellState.running.has(serviceName));
  }

  return false;
}

function resolveFocusedService(shellState: ShellState): ServiceName {
  if (shellState.logView === "api" || shellState.logView === "sasa" || shellState.logView === "frontend" || shellState.logView === "waha") {
    return shellState.logView;
  }

  return shellState.splitLogFocus;
}

function startServiceInBackground(
  serviceName: ServiceName,
  service: ServiceConfig,
  shellState: ShellState
): { ok: boolean; message: string } {
  if (shellState.running.has(serviceName)) {
    const existing = shellState.running.get(serviceName);
    if (existing?.external && service.dockerContainerId) {
      shellState.running.delete(serviceName);
    } else {
      return { ok: false, message: `${serviceName} already running (${existing?.pid ?? "?"})` };
    }
  }

  if (service.dockerContainerId) {
    const ensureRunning = ensureDockerContainerRunning(service);
    if (!ensureRunning.ok) {
      return { ok: false, message: `${serviceName} failed to start container: ${ensureRunning.message}` };
    }
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(service.command, service.args, {
      cwd: service.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
        CLICOLOR_FORCE: process.env.CLICOLOR_FORCE ?? "1"
      },
      windowsHide: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${serviceName} failed to spawn: ${message}` };
  }

  child.on("error", (error) => {
    const running = shellState.running.get(serviceName);
    if (running?.child === child) {
      shellState.running.delete(serviceName);
    }
    writeShellOutput(shellState, `${serviceName} error: ${error.message}`);
  });

  const pid = child.pid;
  if (!pid) {
    return { ok: false, message: `${serviceName} failed to start (${service.command})` };
  }

  shellState.running.set(serviceName, { child, pid });
  attachStreamReader(serviceName, "stdout", child.stdout, shellState);
  attachStreamReader(serviceName, "stderr", child.stderr, shellState);

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

function stopServiceInBackground(
  serviceName: ServiceName,
  shellState: ShellState,
  service?: ServiceConfig
): { ok: boolean; message: string } {
  const running = shellState.running.get(serviceName);
  let processStopped = false;
  let processMessage = `${serviceName} is not running`;

  if (running?.external) {
    processStopped = stopExternalProcessByPid(running.pid);
    processMessage = processStopped ? `${serviceName} external process stopping` : `${serviceName} external process not found`;
    if (processStopped) {
      shellState.running.delete(serviceName);
    }
  } else if (running) {
    shellState.running.delete(serviceName);
    if (running.child) {
      terminateProcess(running.child);
      processStopped = true;
      processMessage = `${serviceName} stopping`;
    }
  }

  if (!service?.dockerContainerId) {
    return processStopped
      ? { ok: true, message: processMessage }
      : { ok: false, message: processMessage };
  }

  const containerStop = stopDockerContainer(service);
  if (!processStopped && !containerStop.ok) {
    return { ok: false, message: `${serviceName} is not running` };
  }

  if (processStopped && containerStop.ok) {
    return { ok: true, message: `${serviceName} stopping | container stopping` };
  }

  if (processStopped && !containerStop.ok) {
    return { ok: false, message: `${serviceName} stopping | container stop failed: ${containerStop.message}` };
  }

  return { ok: true, message: `${serviceName} container stopping` };
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
  appendServiceLogLine(entry);

  if (shellState.logScrollOffset[entry.service] > 0) {
    shellState.logScrollOffset[entry.service] += 1;
  }

  shellState.logs.push(entry);
  if (shellState.logs.length > maxShellLogLines) {
    shellState.logs.splice(0, shellState.logs.length - maxShellLogLines);
  }

  if (shellState.onChange && shellState.logView !== "off") {
    shellState.onChange();
  }
}

function sanitizeLogLine(line: string): string {
  const clean = stripControlSequences(line).trimEnd();
  const visible = stripAnsiSgr(clean).trim();
  return visible.length === 0 ? "(blank)" : clean;
}

function stripControlSequences(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, (sequence) => (sequence.endsWith("m") ? sequence : ""))
    .replace(/\u001b(?!\[[0-9;?]*[ -/]*m)/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function stripAnsiSgr(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*m/g, "");
}

function stopExternalProcessByPid(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }

  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      encoding: "utf8"
    });
    return result.status === 0;
  }

  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
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

function stopDockerContainer(service: ServiceConfig): { ok: boolean; message: string } {
  if (!service.dockerContainerId) {
    return { ok: true, message: "" };
  }

  const result = spawnSync(service.command, ["stop", service.dockerContainerId], {
    cwd: service.cwd,
    env: process.env,
    windowsHide: true,
    encoding: "utf8"
  });

  if (result.error) {
    return { ok: false, message: result.error.message };
  }

  if (result.status === 0) {
    return { ok: true, message: "stopped" };
  }

  const stderr = (result.stderr ?? "").toString().trim();
  const stdout = (result.stdout ?? "").toString().trim();
  const combined = `${stdout} ${stderr}`.toLowerCase();
  if (combined.includes("is not running")) {
    return { ok: false, message: "container not running" };
  }

  return { ok: false, message: stderr || stdout || `exit code ${result.status ?? "?"}` };
}

type ProcessSnapshot = {
  pid: number;
  commandLine: string;
};

function findRunningProcessByCwd(service: ServiceConfig): number | null {
  const processes = readProcessList();
  if (processes.length === 0) {
    return null;
  }

  const cwdNorm = normalizePathForMatch(service.cwd);
  const match = processes.find((item) => normalizePathForMatch(item.commandLine).includes(cwdNorm));
  return match?.pid ?? null;
}

function readProcessList(): ProcessSnapshot[] {
  if (process.platform === "win32") {
    const command = "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
    const result = spawnSync("powershell", ["-NoProfile", "-Command", command], {
      windowsHide: true,
      encoding: "utf8"
    });

    if (result.error || result.status !== 0) {
      return [];
    }

    const raw = (result.stdout ?? "").toString().trim();
    if (!raw) {
      return [];
    }

    try {
      const parsed = JSON.parse(raw) as
        | { ProcessId?: number; CommandLine?: string }
        | Array<{ ProcessId?: number; CommandLine?: string }>;
      const list = Array.isArray(parsed) ? parsed : [parsed];
      return list
        .map((item) => ({
          pid: Number(item.ProcessId ?? 0),
          commandLine: String(item.CommandLine ?? "")
        }))
        .filter((item) => item.pid > 0 && item.commandLine.length > 0);
    } catch {
      return [];
    }
  }

  const result = spawnSync("ps", ["-eo", "pid=,args="], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return [];
  }

  return (result.stdout ?? "")
    .toString()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const firstSpace = line.indexOf(" ");
      if (firstSpace <= 0) {
        return { pid: 0, commandLine: "" };
      }
      const pid = Number(line.slice(0, firstSpace).trim());
      const commandLine = line.slice(firstSpace + 1).trim();
      return { pid, commandLine };
    })
    .filter((item) => item.pid > 0 && item.commandLine.length > 0);
}

function normalizePathForMatch(value: string): string {
  return path.normalize(value).replace(/\\/g, "/").toLowerCase();
}

function findRunningDockerContainerPid(service: ServiceConfig): number | null {
  if (!service.dockerContainerId) {
    return null;
  }

  const inspectFormat = "{{.State.Running}} {{.State.Pid}}";
  const result = spawnSync(service.command, ["inspect", "-f", inspectFormat, service.dockerContainerId], {
    cwd: service.cwd,
    env: process.env,
    windowsHide: true,
    encoding: "utf8"
  });

  if (result.error || result.status !== 0) {
    return null;
  }

  const output = (result.stdout ?? "").toString().trim().toLowerCase();
  if (!output.startsWith("true")) {
    return null;
  }

  const pidText = output.split(/\s+/)[1] ?? "";
  const pid = Number(pidText);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function sliceWithOffset(entries: ServiceLogEntry[], limit: number, offset: number): ServiceLogEntry[] {
  if (entries.length === 0 || limit <= 0) {
    return [];
  }

  const maxOffset = Math.max(0, entries.length - limit);
  const safeOffset = Math.min(Math.max(0, offset), maxOffset);
  const end = entries.length - safeOffset;
  const start = Math.max(0, end - limit);
  return entries.slice(start, end);
}

function scrollServiceLogs(shellState: ShellState, serviceName: ServiceName, delta: number, visibleLines: number): boolean {
  const entries = shellState.logs.filter((entry) => entry.service === serviceName);
  const maxOffset = Math.max(0, entries.length - Math.max(1, visibleLines));
  const current = shellState.logScrollOffset[serviceName];
  const next = Math.min(Math.max(0, current + delta), maxOffset);
  if (next === current) {
    return false;
  }

  shellState.logScrollOffset[serviceName] = next;
  if (shellState.onChange) {
    shellState.onChange();
  }
  return true;
}
