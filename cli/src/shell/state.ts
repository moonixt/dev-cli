import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import type { Readable } from "node:stream";
import type {
  BackgroundService,
  LogView,
  RunTarget,
  ServiceId,
  ServiceLogEntry,
  ServiceRuntimeConfig,
  ShellCommandCatalog,
  ShellState
} from "../types";
import { terminateProcess } from "../utils/process";
import { appendServiceLogLine } from "../utils/service-log-file";

const maxShellLogLines = 1000;

export function createShellState(
  serviceOrder: ServiceId[],
  allTargets: ServiceId[],
  commandCatalog: ShellCommandCatalog,
  workspaceRoot: string,
  workspaceName: string
): ShellState {
  return {
    running: new Map<ServiceId, BackgroundService>(),
    logs: [],
    logView: "off",
    logScrollOffset: new Map(serviceOrder.map((serviceId) => [serviceId, 0])),
    splitLogFocus: serviceOrder[0] ?? null,
    serviceOrder: [...serviceOrder],
    allTargets: [...allTargets],
    commandCatalog,
    workspaceRoot,
    workspaceName,
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

  const orderedIds = [
    ...shellState.serviceOrder,
    ...Array.from(shellState.running.keys()).filter((serviceId) => !shellState.serviceOrder.includes(serviceId))
  ];
  const unique = Array.from(new Set(orderedIds));
  const parts = unique
    .filter((serviceId) => shellState.running.has(serviceId))
    .map((serviceId) => {
      const running = shellState.running.get(serviceId);
      return `${serviceId} (${running?.pid ?? "?"})`;
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
  for (const serviceId of shellState.serviceOrder) {
    shellState.logScrollOffset.set(serviceId, 0);
  }
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
  return sliceWithOffset(filtered, limit, getLogScrollOffset(shellState, shellState.logView));
}

export function getServiceLogs(shellState: ShellState, serviceId: ServiceId, limit: number): ServiceLogEntry[] {
  const filtered = shellState.logs.filter((entry) => entry.service === serviceId);
  return sliceWithOffset(filtered, limit, getLogScrollOffset(shellState, serviceId));
}

export function getSplitLogFocus(shellState: ShellState): ServiceId | null {
  return shellState.splitLogFocus;
}

export function getLogScrollOffset(shellState: ShellState, serviceId: ServiceId): number {
  return shellState.logScrollOffset.get(serviceId) ?? 0;
}

export function setSplitLogFocus(shellState: ShellState, serviceId: ServiceId): void {
  if (!shellState.serviceOrder.includes(serviceId)) {
    return;
  }

  if (shellState.splitLogFocus === serviceId) {
    return;
  }

  shellState.splitLogFocus = serviceId;
  if (shellState.onChange) {
    shellState.onChange();
  }
}

export function scrollFocusedLog(
  shellState: ShellState,
  delta: number,
  visibleLines: number
): { changed: boolean; service: ServiceId | null; offset: number } {
  const targetService = resolveFocusedService(shellState);
  if (!targetService) {
    return { changed: false, service: null, offset: 0 };
  }

  const changed = scrollServiceLogs(shellState, targetService, delta, visibleLines);
  return {
    changed,
    service: targetService,
    offset: getLogScrollOffset(shellState, targetService)
  };
}

export function resetFocusedLogScroll(
  shellState: ShellState
): { changed: boolean; service: ServiceId | null; offset: number } {
  const targetService = resolveFocusedService(shellState);
  if (!targetService) {
    return { changed: false, service: null, offset: 0 };
  }

  const currentOffset = getLogScrollOffset(shellState, targetService);
  const changed = currentOffset !== 0;
  shellState.logScrollOffset.set(targetService, 0);
  if (changed && shellState.onChange) {
    shellState.onChange();
  }

  return {
    changed,
    service: targetService,
    offset: getLogScrollOffset(shellState, targetService)
  };
}

export function startBackground(
  target: RunTarget,
  services: Record<ServiceId, ServiceRuntimeConfig>,
  shellState: ShellState
): number {
  const targets = target === "all" ? shellState.allTargets : [target];
  if (targets.length === 0) {
    writeShellOutput(shellState, 'no services configured. run "dev-cli init"');
    return 1;
  }

  const messages: string[] = [];
  let hasError = false;
  for (const serviceId of targets) {
    const service = services[serviceId];
    if (!service) {
      messages.push(`unknown service: ${serviceId}`);
      hasError = true;
      continue;
    }
    const result = startServiceInBackground(serviceId, service, shellState);
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
  services: Record<ServiceId, ServiceRuntimeConfig>,
  shellState: ShellState
): number {
  const targets = target === "all" ? shellState.allTargets : [target];
  if (targets.length === 0) {
    writeShellOutput(shellState, 'no services configured. run "dev-cli init"');
    return 1;
  }

  const messages: string[] = [];
  let hasError = false;
  for (const serviceId of targets) {
    const result = stopServiceInBackground(serviceId, shellState, services[serviceId]);
    messages.push(result.message);
    if (!result.ok) {
      hasError = true;
    }
  }

  writeShellOutput(shellState, messages.join(" | "));
  return hasError ? 1 : 0;
}

export function stopAllRunning(
  shellState: ShellState,
  services?: Record<ServiceId, ServiceRuntimeConfig>
): void {
  const active = Array.from(shellState.running.keys());
  for (const serviceId of active) {
    const running = shellState.running.get(serviceId);
    if (!running || running.external) {
      continue;
    }
    stopServiceInBackground(serviceId, shellState, services?.[serviceId]);
  }
}

export function hydrateRunningServices(
  shellState: ShellState,
  services: Record<ServiceId, ServiceRuntimeConfig>
): void {
  for (const serviceId of shellState.serviceOrder) {
    if (shellState.running.has(serviceId)) {
      continue;
    }

    const service = services[serviceId];
    if (!service) {
      continue;
    }

    const pid = findRunningProcessByCwd(service);
    if (!pid || pid <= 0) {
      continue;
    }
    shellState.running.set(serviceId, { pid, external: true });
  }
}

export function attachExternalLogStreams(
  _shellState: ShellState,
  _services: Record<ServiceId, ServiceRuntimeConfig>,
  _targets: ServiceId[]
): void {
  // Generic process discovery can detect external PIDs by cwd, but there is no safe
  // cross-platform way to attach stdout/stderr streams to an already-running process.
}

export function isSuggestionRunning(command: string, shellState: ShellState): boolean {
  if (command === "/start all") {
    if (shellState.allTargets.length === 0) {
      return false;
    }
    return shellState.allTargets.every((serviceId) => shellState.running.has(serviceId));
  }

  const match = command.match(/^\/start\s+([a-z0-9][a-z0-9-_]{1,31})$/i);
  if (!match) {
    return false;
  }
  const serviceId = match[1].toLowerCase();
  return shellState.running.has(serviceId);
}

function resolveFocusedService(shellState: ShellState): ServiceId | null {
  if (
    shellState.logView !== "off" &&
    shellState.logView !== "all" &&
    shellState.serviceOrder.includes(shellState.logView)
  ) {
    return shellState.logView;
  }

  if (shellState.splitLogFocus && shellState.serviceOrder.includes(shellState.splitLogFocus)) {
    return shellState.splitLogFocus;
  }

  return shellState.serviceOrder[0] ?? null;
}

function startServiceInBackground(
  serviceId: ServiceId,
  service: ServiceRuntimeConfig,
  shellState: ShellState
): { ok: boolean; message: string } {
  if (shellState.running.has(serviceId)) {
    const existing = shellState.running.get(serviceId);
    if (existing?.external) {
      shellState.running.delete(serviceId);
    } else {
      return { ok: false, message: `${serviceId} already running (${existing?.pid ?? "?"})` };
    }
  }

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(service.command, service.args, {
      cwd: service.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...service.env,
        FORCE_COLOR: process.env.FORCE_COLOR ?? "1",
        CLICOLOR_FORCE: process.env.CLICOLOR_FORCE ?? "1"
      },
      windowsHide: true
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `${serviceId} failed to spawn: ${message}` };
  }

  child.on("error", (error) => {
    const running = shellState.running.get(serviceId);
    if (running?.child === child) {
      shellState.running.delete(serviceId);
    }
    writeShellOutput(shellState, `${serviceId} error: ${error.message}`);
  });

  const pid = child.pid;
  if (!pid) {
    return { ok: false, message: `${serviceId} failed to start (${service.command})` };
  }

  shellState.running.set(serviceId, { child, pid });
  attachStreamReader(serviceId, "stdout", child.stdout, service, shellState);
  attachStreamReader(serviceId, "stderr", child.stderr, service, shellState);

  child.on("exit", (code, signal) => {
    const running = shellState.running.get(serviceId);
    if (running?.child === child) {
      shellState.running.delete(serviceId);
    }

    if (signal || code !== 0) {
      const reason = signal ? `signal ${signal}` : `code ${code}`;
      writeShellOutput(shellState, `${serviceId} stopped (${reason})`);
    } else {
      writeShellOutput(shellState, `${serviceId} stopped`);
    }
  });

  return { ok: true, message: `${serviceId} started (${pid})` };
}

function stopServiceInBackground(
  serviceId: ServiceId,
  shellState: ShellState,
  _service?: ServiceRuntimeConfig
): { ok: boolean; message: string } {
  const running = shellState.running.get(serviceId);
  let stopped = false;
  let message = `${serviceId} is not running`;

  if (running?.external) {
    stopped = stopExternalProcessByPid(running.pid);
    message = stopped ? `${serviceId} external process stopping` : `${serviceId} external process not found`;
    if (stopped) {
      shellState.running.delete(serviceId);
    }
  } else if (running) {
    shellState.running.delete(serviceId);
    if (running.child) {
      terminateProcess(running.child);
      stopped = true;
      message = `${serviceId} stopping`;
    }
  }

  return stopped ? { ok: true, message } : { ok: false, message };
}

function attachStreamReader(
  serviceId: ServiceId,
  streamType: "stdout" | "stderr",
  stream: Readable | null,
  service: ServiceRuntimeConfig,
  shellState: ShellState
): void {
  if (!stream) {
    return;
  }

  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => {
    addLog(
      shellState,
      {
        service: serviceId,
        stream: streamType,
        line: sanitizeLogLine(line),
        timestamp: Date.now(),
        retentionDays: service.logRetentionDays
      },
      service.logEnabled
    );
  });
}

function addLog(shellState: ShellState, entry: ServiceLogEntry, persist: boolean): void {
  if (persist) {
    appendServiceLogLine(entry);
  }

  const currentOffset = getLogScrollOffset(shellState, entry.service);
  if (currentOffset > 0) {
    shellState.logScrollOffset.set(entry.service, currentOffset + 1);
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

type ProcessSnapshot = {
  pid: number;
  commandLine: string;
};

function findRunningProcessByCwd(service: ServiceRuntimeConfig): number | null {
  const processes = readProcessList();
  if (processes.length === 0) {
    return null;
  }

  const cwdNorm = normalizePathForMatch(service.cwd);
  const match = processes.find((item) => {
    const commandNorm = normalizePathForMatch(item.commandLine);
    return commandNorm.includes(cwdNorm) && item.pid !== process.pid;
  });
  return match?.pid ?? null;
}

function readProcessList(): ProcessSnapshot[] {
  if (process.platform === "win32") {
    const command =
      "Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress";
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

function scrollServiceLogs(
  shellState: ShellState,
  serviceId: ServiceId,
  delta: number,
  visibleLines: number
): boolean {
  const entries = shellState.logs.filter((entry) => entry.service === serviceId);
  const maxOffset = Math.max(0, entries.length - Math.max(1, visibleLines));
  const current = getLogScrollOffset(shellState, serviceId);
  const next = Math.min(Math.max(0, current + delta), maxOffset);
  if (next === current) {
    return false;
  }

  shellState.logScrollOffset.set(serviceId, next);
  if (shellState.onChange) {
    shellState.onChange();
  }
  return true;
}
