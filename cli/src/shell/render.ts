import readline from "node:readline";
import { ansiRed, ansiReset, cliVersion, repoRoot } from "../config";
import { shellCommands } from "./commands";
import {
  getLogScrollOffset,
  getRunningSummary,
  getServiceLogs,
  getSplitLogFocus,
  getVisibleLogs,
  isSuggestionRunning
} from "./state";
import type { ServiceName, ShellCommand, ShellState } from "../types";

const splitServices: ServiceName[] = ["api", "sasa", "frontend", "waha"];
const splitPageSize = 2;
const ansiSgrPattern = /\u001b\[[0-9;?]*[ -/]*m/g;

export function printShellHelp(): void {
  const maxCommandLength = shellCommands.reduce((max, item) => Math.max(max, item.command.length), 0);
  const lines = shellCommands.map((item) => {
    const paddedCommand = item.command.padEnd(maxCommandLength, " ");
    return `${paddedCommand}  ${item.description}`;
  });
  process.stdout.write(`${lines.join("\n")}\n`);
}

export function renderShellHome(shellState: ShellState): void {
  console.clear();
  printShellHeader(shellState);
}

export function renderLiveShell(input: string, selectedIndex: number, shellState: ShellState): void {
  console.clear();
  printShellHeader(shellState);
  renderLogPanel(shellState);
  process.stdout.write(`> ${input}`);

  const suggestions = filterShellCommands(input);
  if (suggestions.length === 0) {
    return;
  }

  const activeIndex = Math.max(0, Math.min(selectedIndex, suggestions.length - 1));
  process.stdout.write("\n");
  for (let index = 0; index < suggestions.length; index += 1) {
    const suggestion = suggestions[index];
    const marker = index === activeIndex ? ">" : " ";
    const isRunning = isSuggestionRunning(suggestion.command, shellState);
    const paddedCommand = suggestion.command.padEnd(16, " ");
    const commandText = isRunning ? colorRed(paddedCommand) : paddedCommand;
    const descriptionText = isRunning ? `${suggestion.description} ${colorRed("running")}` : suggestion.description;
    process.stdout.write(`${marker} ${commandText} ${descriptionText}\n`);
  }

  readline.moveCursor(process.stdout, 0, -(suggestions.length + 1));
  readline.cursorTo(process.stdout, input.length + 2);
}

export function filterShellCommands(input: string): ShellCommand[] {
  const normalized = input.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    return [];
  }

  if (normalized === "/") {
    return shellCommands;
  }

  return shellCommands.filter((item) => item.command.startsWith(normalized));
}

function printShellHeader(shellState: ShellState): void {
  const lines = [
    `> dev-cli (${cliVersion})`,
    `workspace: ${repoRoot}`,
    `directory: ${process.cwd()}`,
    `running: ${getRunningSummary(shellState)}`,
    `log view: ${shellState.logView}`,
    "type / to list commands"
  ];

  console.log(drawBox(lines));
  console.log("");
  console.log("Tip: type / and use Up/Down arrows to select commands.");
  if (shellState.message) {
    console.log(`Info: ${shellState.message}`);
  }
  console.log("");
}

function renderLogPanel(shellState: ShellState): void {
  if (shellState.logView === "off") {
    return;
  }

  if (shellState.logView === "all") {
    renderSplitLogPanel(shellState);
    return;
  }

  const logLines = getVisibleLogs(shellState, getLogPanelHeight());
  const width = Math.max(60, (process.stdout.columns ?? 120) - 2);
  const offset = getLogScrollOffset(shellState, shellState.logView);

  process.stdout.write(`Logs (${shellState.logView}, scroll +${offset}):\n`);
  if (logLines.length === 0) {
    process.stdout.write("  (no logs yet)\n\n");
    return;
  }

  for (const entry of logLines) {
    const prefix = `[${entry.service}]`;
    const line = `${prefix} ${entry.line}`;
    process.stdout.write(`${truncateLine(line, width)}\n`);
  }
  process.stdout.write("\n");
}

function renderSplitLogPanel(shellState: ShellState): void {
  const panelHeight = getLogPanelHeight();
  const width = Math.max(60, (process.stdout.columns ?? 120) - 2);
  const separator = " | ";
  const splitFocus = getSplitLogFocus(shellState);
  const visibleServices = resolveVisibleSplitServices(splitFocus);
  const separatorWidth = separator.length * (visibleServices.length - 1);
  const columnWidth = Math.max(18, Math.floor((width - separatorWidth) / visibleServices.length));

  const serviceLogs = visibleServices.map((serviceName) => ({
    serviceName,
    offset: getLogScrollOffset(shellState, serviceName),
    lines: getServiceLogs(shellState, serviceName, panelHeight).map((entry) => entry.line)
  }));
  const maxLines = Math.max(
    panelHeight,
    ...serviceLogs.map((item) => item.lines.length)
  );
  const titles = serviceLogs.map((item) => {
    const serviceLabel = item.serviceName.toUpperCase();
    return splitFocus === item.serviceName
      ? `${serviceLabel}* (+${item.offset})`
      : `${serviceLabel} (+${item.offset})`;
  });
  const titleRow = titles.map((title) => padCell(title, columnWidth)).join(separator);
  const dividerRow = visibleServices.map(() => "-".repeat(columnWidth)).join(separator);

  const showingLabel = visibleServices.join(" | ");
  const fullLabel = splitServices.join(" | ");
  const pageIndex = Math.floor(Math.max(0, splitServices.indexOf(splitFocus)) / splitPageSize);
  const pageCount = Math.ceil(splitServices.length / splitPageSize);
  process.stdout.write(`Logs (split: ${showingLabel}) [page ${pageIndex + 1}/${pageCount} | all: ${fullLabel}]:\n`);
  process.stdout.write(`${titleRow}\n`);
  process.stdout.write(`${dividerRow}\n`);

  for (let index = 0; index < maxLines; index += 1) {
    const row = serviceLogs
      .map((item) => item.lines[index] ?? (index === 0 && item.lines.length === 0 ? "(no logs yet)" : ""))
      .map((line) => padCell(line, columnWidth))
      .join(separator);
    process.stdout.write(`${row}\n`);
  }

  process.stdout.write("Controls: [ prev pair | ] next pair | PgUp/PgDn scroll | Home/End latest\n");
  process.stdout.write("\n");
}

function getLogPanelHeight(): number {
  const rows = process.stdout.rows ?? 40;
  // Reserve less space for chrome so logs stay readable.
  return Math.max(8, Math.min(24, rows - 14));
}

function truncateLine(line: string, maxWidth: number): string {
  if (visibleLength(line) <= maxWidth) {
    return line;
  }
  if (maxWidth <= 3) {
    return sliceAnsiByVisibleWidth(line, maxWidth);
  }
  const truncated = sliceAnsiByVisibleWidth(line, maxWidth - 3);
  return line.includes("\u001b[") ? `${truncated}...${ansiReset}` : `${truncated}...`;
}

function padCell(line: string, width: number): string {
  const truncated = truncateLine(line, width);
  const padding = Math.max(0, width - visibleLength(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}

function drawBox(lines: string[]): string {
  const width = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const top = `+${"-".repeat(width + 2)}+`;
  const middle = lines.map((line) => `| ${line.padEnd(width, " ")} |`);
  return [top, ...middle, top].join("\n");
}

function colorRed(text: string): string {
  if (!process.stdout.isTTY) {
    return text;
  }

  return `${ansiRed}${text}${ansiReset}`;
}

function resolveVisibleSplitServices(splitFocus: ServiceName): ServiceName[] {
  const focusIndex = Math.max(0, splitServices.indexOf(splitFocus));
  const startIndex = Math.floor(focusIndex / splitPageSize) * splitPageSize;
  const visible = splitServices.slice(startIndex, startIndex + splitPageSize);
  return visible.length > 0 ? visible : splitServices.slice(0, splitPageSize);
}

function visibleLength(line: string): number {
  return line.replace(ansiSgrPattern, "").length;
}

function sliceAnsiByVisibleWidth(line: string, maxWidth: number): string {
  if (maxWidth <= 0) {
    return "";
  }

  let index = 0;
  let visibleCount = 0;
  let result = "";

  while (index < line.length && visibleCount < maxWidth) {
    if (line[index] === "\u001b") {
      const match = line.slice(index).match(/^\u001b\[[0-9;?]*[ -/]*m/);
      if (match) {
        result += match[0];
        index += match[0].length;
        continue;
      }

      index += 1;
      continue;
    }

    result += line[index];
    index += 1;
    visibleCount += 1;
  }

  return result;
}
