import fs from "node:fs";
import path from "node:path";
import { logPrefix, repoRoot } from "../config";
import type { PersistedLogEntry, ServiceLogEntry, ServiceLogLevel, ServiceId } from "../types";
import { getErrorKeywordPattern } from "./error-keywords";

const defaultLogsDir = path.join(repoRoot, "logs");
const defaultRetentionDays = 7;
const warnKeywordsPattern = /\b(warn|warning|retry|deprecated|slow|throttle)\b/i;
const serviceIdPattern = /^[a-z0-9][a-z0-9-_]{1,31}$/;
const cleanupState = new Set<string>();
const legacySessionHeaders = new Set<string>();
let writeFailed = false;

export function getServiceLogsRootPath(): string {
  return path.join(resolveLogsDir(), "services");
}

export function getLegacyConsolidatedLogPath(): string {
  return path.join(resolveLogsDir(), "dev-cli-services.txt");
}

export function getServiceDailyLogPath(service: ServiceId, date: Date = new Date()): string {
  validateServiceId(service);
  const day = formatDateUTC(date);
  const serviceDir = path.join(getServiceLogsRootPath(), service);
  return path.join(serviceDir, `${service}-${day}.txt`);
}

export function appendServiceLogLine(
  entry: Pick<ServiceLogEntry, "service" | "stream" | "line" | "timestamp"> & { retentionDays?: number }
): void {
  try {
    validateServiceId(entry.service);
    const message = normalizeMessage(entry.line);
    const date = new Date(entry.timestamp);
    const day = formatDateUTC(date);
    const level = resolveLogLevel(entry.stream, message);
    const retentionDays = sanitizeRetentionDays(entry.retentionDays);
    const persisted: PersistedLogEntry = {
      ts: new Date(entry.timestamp).toISOString(),
      service: entry.service,
      stream: entry.stream,
      level,
      msg: message
    };

    writeServiceLogEntry(persisted, day, retentionDays);
    writeLegacyConsolidatedEntry(entry.service, entry.stream, persisted.ts, message);
  } catch (error) {
    if (writeFailed) {
      return;
    }
    writeFailed = true;
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${logPrefix} failed to write service logs: ${message}`);
  }
}

function writeServiceLogEntry(entry: PersistedLogEntry, day: string, retentionDays: number): void {
  const serviceDir = path.join(getServiceLogsRootPath(), entry.service);
  fs.mkdirSync(serviceDir, { recursive: true });
  const filePath = path.join(serviceDir, `${entry.service}-${day}.txt`);
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  cleanupOldServiceLogFiles(entry.service, day, retentionDays);
}

function writeLegacyConsolidatedEntry(
  service: ServiceId,
  stream: "stdout" | "stderr",
  timestamp: string,
  message: string
): void {
  const logsDir = resolveLogsDir();
  const legacyConsolidatedLogPath = getLegacyConsolidatedLogPath();
  fs.mkdirSync(logsDir, { recursive: true });
  if (!legacySessionHeaders.has(legacyConsolidatedLogPath)) {
    fs.appendFileSync(legacyConsolidatedLogPath, `\n===== dev-cli log session ${new Date().toISOString()} =====\n`, "utf8");
    legacySessionHeaders.add(legacyConsolidatedLogPath);
  }

  const output = `[${timestamp}] [${service}] [${stream}] ${message}\n`;
  fs.appendFileSync(legacyConsolidatedLogPath, output, "utf8");
}

function cleanupOldServiceLogFiles(service: ServiceId, day: string, retentionDays: number): void {
  const stateKey = `${getServiceLogsRootPath()}:${service}:${day}`;
  if (cleanupState.has(stateKey)) {
    return;
  }
  cleanupState.add(stateKey);

  const serviceDir = path.join(getServiceLogsRootPath(), service);
  if (!fs.existsSync(serviceDir)) {
    return;
  }

  const files = fs.readdirSync(serviceDir, { withFileTypes: true });
  const todayDate = parseDayToUtcDate(day);
  for (const file of files) {
    if (!file.isFile()) {
      continue;
    }

    const fileDay = extractDayFromFileName(file.name, service);
    if (!fileDay) {
      continue;
    }

    const fileDate = parseDayToUtcDate(fileDay);
    if (!fileDate || !todayDate) {
      continue;
    }

    const diffDays = Math.floor((todayDate.getTime() - fileDate.getTime()) / (24 * 60 * 60 * 1000));
    if (diffDays >= retentionDays) {
      const filePath = path.join(serviceDir, file.name);
      fs.rmSync(filePath, { force: true });
    }
  }
}

function resolveLogLevel(stream: "stdout" | "stderr", message: string): ServiceLogLevel {
  if (stream === "stderr") {
    return "error";
  }

  const errorPattern = getErrorKeywordPattern();
  if (errorPattern) {
    errorPattern.lastIndex = 0;
    if (errorPattern.test(message)) {
      return "error";
    }
  }

  if (warnKeywordsPattern.test(message)) {
    warnKeywordsPattern.lastIndex = 0;
    return "warn";
  }
  warnKeywordsPattern.lastIndex = 0;

  return "info";
}

function normalizeMessage(line: string): string {
  const plainLine = stripAnsiSgr(line).replace(/\r/g, "").trimEnd();
  return plainLine.length > 0 ? plainLine : "(blank)";
}

function formatDateUTC(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function parseDayToUtcDate(day: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return null;
  }
  return new Date(`${day}T00:00:00.000Z`);
}

function extractDayFromFileName(fileName: string, service: ServiceId): string | null {
  const pattern = new RegExp(`^${service}-(\\d{4}-\\d{2}-\\d{2})\\.txt$`);
  const match = fileName.match(pattern);
  return match?.[1] ?? null;
}

function stripAnsiSgr(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*m/g, "");
}

function validateServiceId(service: string): void {
  if (!serviceIdPattern.test(service)) {
    throw new Error(`invalid service id for log persistence: ${service}`);
  }
}

function sanitizeRetentionDays(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return defaultRetentionDays;
  }
  const numeric = Math.floor(value as number);
  if (numeric < 1) {
    return defaultRetentionDays;
  }
  return Math.min(numeric, 365);
}

function resolveLogsDir(): string {
  const configuredLogRoot = process.env.DEV_CLI_LOG_ROOT?.trim();
  return configuredLogRoot ? path.resolve(configuredLogRoot) : defaultLogsDir;
}
