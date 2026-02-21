import type { ServiceName } from "../types";
import { getErrorKeywordPattern } from "./error-keywords";

const ansiReset = "\u001b[0m";
const ansiStripPattern = /\u001b\[[0-9;?]*[ -/]*m/g;
const ansiDetectPattern = /\u001b\[[0-9;?]*[ -/]*m/;

type ColorStream = NodeJS.WriteStream;

function colorsEnabled(stream: ColorStream): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined) {
    return false;
  }

  const forceColor = process.env.FORCE_COLOR;
  if (forceColor !== undefined) {
    return forceColor !== "0";
  }

  return Boolean(stream.isTTY);
}

function applyColor(text: string, sgrCodes: string, stream: ColorStream = process.stdout): string {
  if (!colorsEnabled(stream) || text.length === 0) {
    return text;
  }

  return `\u001b[${sgrCodes}m${text}${ansiReset}`;
}

export function bold(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "1", stream);
}

export function dim(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "2", stream);
}

export function red(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "31", stream);
}

export function green(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "32", stream);
}

export function yellow(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "33", stream);
}

export function blue(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "34", stream);
}

export function magenta(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "35", stream);
}

export function cyan(text: string, stream: ColorStream = process.stdout): string {
  return applyColor(text, "36", stream);
}

export function colorService(service: ServiceName, text: string, stream: ColorStream = process.stdout): string {
  switch (service) {
    case "api":
      return cyan(text, stream);
    case "sasa":
      return magenta(text, stream);
    case "frontend":
      return blue(text, stream);
    case "waha":
      return yellow(text, stream);
    default:
      return text;
  }
}

export function highlightErrorKeywords(text: string, stream: ColorStream = process.stdout): string {
  const keywordPattern = getErrorKeywordPattern();
  if (!keywordPattern) {
    return text;
  }

  return text.replace(keywordPattern, (match) => red(match, stream));
}

export function stripAnsi(text: string): string {
  return text.replace(ansiStripPattern, "");
}

export function hasAnsi(text: string): boolean {
  return ansiDetectPattern.test(text);
}

export function getAnsiReset(): string {
  return ansiReset;
}
