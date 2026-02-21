import fs from "node:fs";
import path from "node:path";
import { cliRoot } from "../config";

const defaultErrorKeywords = [
  "fail",
  "failed",
  "failure",
  "error",
  "errors",
  "fatal",
  "exception",
  "denied",
  "timeout",
  "timed out",
  "invalid",
  "missing"
];

const configFilePath = path.join(cliRoot, ".error-keywords.json");

type PersistedKeywords = {
  keywords?: unknown;
};

let cachedKeywords: string[] | undefined;

export function getErrorKeywords(): string[] {
  if (cachedKeywords) {
    return [...cachedKeywords];
  }

  const fromDisk = readKeywordsFromDisk();
  if (fromDisk) {
    cachedKeywords = fromDisk;
    return [...cachedKeywords];
  }

  const fromEnv = parseEnvKeywords(process.env.DEV_CLI_ERROR_KEYWORDS);
  cachedKeywords = fromEnv.length > 0 ? fromEnv : [...defaultErrorKeywords];
  return [...cachedKeywords];
}

export function getDefaultErrorKeywords(): string[] {
  return [...defaultErrorKeywords];
}

export function getErrorKeywordsConfigPath(): string {
  return configFilePath;
}

export function hasPersistedErrorKeywords(): boolean {
  return fs.existsSync(configFilePath);
}

export function setErrorKeywords(keywords: string[]): string[] {
  const normalized = normalizeKeywordList(keywords);
  if (normalized.length === 0) {
    throw new Error("at least one keyword is required");
  }

  persistKeywords(normalized);
  cachedKeywords = normalized;
  return [...normalized];
}

export function addErrorKeyword(keyword: string): { updatedKeywords: string[]; added: boolean; keyword: string } {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    throw new Error("keyword cannot be empty");
  }

  const current = getErrorKeywords();
  if (current.includes(normalizedKeyword)) {
    return {
      updatedKeywords: current,
      added: false,
      keyword: normalizedKeyword
    };
  }

  const updated = [...current, normalizedKeyword];
  persistKeywords(updated);
  cachedKeywords = updated;
  return {
    updatedKeywords: [...updated],
    added: true,
    keyword: normalizedKeyword
  };
}

export function removeErrorKeyword(keyword: string): { updatedKeywords: string[]; removed: boolean; keyword: string } {
  const normalizedKeyword = normalizeKeyword(keyword);
  if (!normalizedKeyword) {
    throw new Error("keyword cannot be empty");
  }

  const current = getErrorKeywords();
  const updated = current.filter((item) => item !== normalizedKeyword);
  if (updated.length === current.length) {
    return {
      updatedKeywords: current,
      removed: false,
      keyword: normalizedKeyword
    };
  }

  persistKeywords(updated);
  cachedKeywords = updated;
  return {
    updatedKeywords: [...updated],
    removed: true,
    keyword: normalizedKeyword
  };
}

export function resetErrorKeywords(): string[] {
  persistKeywords(defaultErrorKeywords);
  cachedKeywords = [...defaultErrorKeywords];
  return [...defaultErrorKeywords];
}

export function getErrorKeywordPattern(): RegExp | null {
  const keywords = getErrorKeywords();
  if (keywords.length === 0) {
    return null;
  }

  const tokenPattern = keywords
    .map((keyword) => keyword.replace(/\s+/g, " "))
    .map(escapeRegExp)
    .map((escapedKeyword) => escapedKeyword.replace(/\\ /g, "\\s+"))
    .sort((left, right) => right.length - left.length)
    .join("|");

  if (!tokenPattern) {
    return null;
  }

  return new RegExp(`\\b(?:${tokenPattern})\\b`, "gi");
}

function normalizeKeywordList(keywords: string[]): string[] {
  const normalized = keywords.map(normalizeKeyword).filter((keyword): keyword is string => keyword.length > 0);
  return Array.from(new Set(normalized));
}

function normalizeKeyword(keyword: string): string {
  return keyword.trim().replace(/\s+/g, " ").toLowerCase();
}

function parseEnvKeywords(rawKeywords: string | undefined): string[] {
  if (!rawKeywords) {
    return [];
  }

  return normalizeKeywordList(rawKeywords.split(","));
}

function readKeywordsFromDisk(): string[] | null {
  if (!fs.existsSync(configFilePath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(configFilePath, "utf8");
    const parsed = JSON.parse(raw) as PersistedKeywords | unknown[];
    if (Array.isArray(parsed)) {
      const asArray = normalizeKeywordList(parsed.filter((value): value is string => typeof value === "string"));
      return asArray.length > 0 ? asArray : null;
    }

    if (parsed && typeof parsed === "object") {
      const keywordsValue = (parsed as PersistedKeywords).keywords;
      if (!Array.isArray(keywordsValue)) {
        return null;
      }
      const keywords = normalizeKeywordList(keywordsValue.filter((value): value is string => typeof value === "string"));
      return keywords.length > 0 ? keywords : null;
    }
  } catch {
    return null;
  }

  return null;
}

function persistKeywords(keywords: string[]): void {
  const normalized = normalizeKeywordList(keywords);
  const payload = JSON.stringify({ keywords: normalized }, null, 2);
  fs.writeFileSync(configFilePath, `${payload}\n`, "utf8");
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
