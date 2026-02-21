import fs from "node:fs";
import path from "node:path";
import type {
  LogEntry,
  LogsErrorsResult,
  LogsListFilesResult,
  LogsListServicesResult,
  LogsSearchResult,
  LogsTailResult,
  ServiceName
} from "./types";

const knownServices: ServiceName[] = ["api", "sasa", "frontend", "waha"];

type ServiceFile = {
  name: string;
  path: string;
};

export type LogStoreOptions = {
  logRoot?: string;
  now?: Date;
};

export class LogStore {
  private readonly logRoot: string;
  private readonly now: Date;

  constructor(options?: LogStoreOptions) {
    this.logRoot = options?.logRoot ?? getDefaultLogRoot();
    this.now = options?.now ?? new Date();
  }

  listServices(): LogsListServicesResult {
    const result = new Set<string>(knownServices);
    if (fs.existsSync(this.logRoot)) {
      for (const item of fs.readdirSync(this.logRoot, { withFileTypes: true })) {
        if (item.isDirectory()) {
          result.add(item.name);
        }
      }
    }

    return { services: Array.from(result).sort() };
  }

  listFiles(service: string): LogsListFilesResult {
    return { service, files: this.getServiceFiles(service).map((item) => item.name) };
  }

  tail(service: string, lines: number, day?: string): LogsTailResult {
    const safeLines = clamp(lines, 1, 2000);
    const targetFile = this.resolveServiceFile(service, day);
    if (!targetFile) {
      return { service, file: null, entries: [] };
    }

    const entries = readJsonlEntries(targetFile.path).slice(-safeLines);
    return { service, file: targetFile.name, entries };
  }

  search(service: string, query: string, limit: number, day?: string, regex?: boolean): LogsSearchResult {
    const safeLimit = clamp(limit, 1, 5000);
    const matcher = createMatcher(query, Boolean(regex));
    const files = this.resolveSearchFiles(service, day);
    const results: LogEntry[] = [];

    for (const file of files) {
      const entries = readJsonlEntries(file.path);
      for (const entry of entries) {
        if (!matcher(entry)) {
          continue;
        }
        results.push(entry);
        if (results.length >= safeLimit) {
          return { service, query, entries: results };
        }
      }
    }

    return { service, query, entries: results };
  }

  errors(service: string | undefined, sinceMinutes: number, limit: number): LogsErrorsResult {
    const safeLimit = clamp(limit, 1, 5000);
    const safeSinceMinutes = clamp(sinceMinutes, 1, 60 * 24 * 30);
    const thresholdMs = this.now.getTime() - safeSinceMinutes * 60_000;
    const services = service ? [service] : this.listServices().services;
    const results: LogEntry[] = [];

    for (const serviceName of services) {
      const files = this.getServiceFiles(serviceName);
      for (const file of files) {
        const entries = readJsonlEntries(file.path);
        for (const entry of entries) {
          if (entry.level !== "error") {
            continue;
          }
          const ts = new Date(entry.ts).getTime();
          if (!Number.isFinite(ts) || ts < thresholdMs) {
            continue;
          }
          results.push(entry);
          if (results.length >= safeLimit) {
            return {
              service: service ?? "all",
              entries: results.sort((a, b) => b.ts.localeCompare(a.ts))
            };
          }
        }
      }
    }

    return {
      service: service ?? "all",
      entries: results.sort((a, b) => b.ts.localeCompare(a.ts))
    };
  }

  getLogRoot(): string {
    return this.logRoot;
  }

  resolveFilePathForDay(service: string, day: string): string {
    validateDay(day);
    return path.join(this.logRoot, service, `${service}-${day}.txt`);
  }

  static parseJsonLine(line: string): LogEntry | null {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return null;
    }

    try {
      const parsed = JSON.parse(trimmed) as Partial<LogEntry>;
      if (!isValidLogEntry(parsed)) {
        return null;
      }
      return parsed;
    } catch {
      return null;
    }
  }

  private getServiceFiles(service: string): ServiceFile[] {
    const serviceDir = path.join(this.logRoot, service);
    if (!fs.existsSync(serviceDir)) {
      return [];
    }

    return fs
      .readdirSync(serviceDir, { withFileTypes: true })
      .filter((item) => item.isFile() && item.name.endsWith(".txt"))
      .map((item) => ({
        name: item.name,
        path: path.join(serviceDir, item.name)
      }))
      .sort((left, right) => right.name.localeCompare(left.name));
  }

  private resolveServiceFile(service: string, day?: string): ServiceFile | null {
    if (day) {
      validateDay(day);
      const explicitPath = this.resolveFilePathForDay(service, day);
      if (fs.existsSync(explicitPath)) {
        return { name: path.basename(explicitPath), path: explicitPath };
      }
      return null;
    }

    const files = this.getServiceFiles(service);
    return files[0] ?? null;
  }

  private resolveSearchFiles(service: string, day?: string): ServiceFile[] {
    if (day) {
      const single = this.resolveServiceFile(service, day);
      return single ? [single] : [];
    }

    return this.getServiceFiles(service);
  }
}

function getDefaultLogRoot(): string {
  const envRoot = process.env.LOG_ROOT;
  if (envRoot && envRoot.trim().length > 0) {
    return path.resolve(envRoot.trim());
  }

  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  return path.join(repoRoot, "logs", "services");
}

function readJsonlEntries(filePath: string): LogEntry[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const entries: LogEntry[] = [];
  for (const line of lines) {
    const parsed = LogStore.parseJsonLine(line);
    if (parsed) {
      entries.push(parsed);
    }
  }

  return entries;
}

function isValidLogEntry(entry: Partial<LogEntry> | null | undefined): entry is LogEntry {
  if (!entry) {
    return false;
  }

  const validService = typeof entry.service === "string" && knownServices.includes(entry.service as ServiceName);
  const validStream = entry.stream === "stdout" || entry.stream === "stderr";
  const validLevel = entry.level === "info" || entry.level === "warn" || entry.level === "error";
  const validTs = typeof entry.ts === "string" && Number.isFinite(new Date(entry.ts).getTime());
  const validMsg = typeof entry.msg === "string";
  return validService && validStream && validLevel && validTs && validMsg;
}

function validateDay(day: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    throw new Error("Invalid day format. Expected YYYY-MM-DD");
  }
}

function createMatcher(query: string, regex: boolean): (entry: LogEntry) => boolean {
  const normalized = query.trim();
  if (!normalized) {
    return () => true;
  }

  if (regex) {
    const rx = new RegExp(normalized, "i");
    return (entry) => rx.test(entry.msg);
  }

  const lowered = normalized.toLowerCase();
  return (entry) => entry.msg.toLowerCase().includes(lowered);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(Math.max(Math.floor(value), min), max);
}

export function parseServiceDayFromFilename(fileName: string, service: string): string | null {
  const match = fileName.match(new RegExp(`^${escapeRegExp(service)}-(\\d{4}-\\d{2}-\\d{2})\\.txt$`));
  return match?.[1] ?? null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
