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
import type { ShellCommand, ShellState } from "../types";

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
    const paddedCommand = suggestion.command.padEnd(12, " ");
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
  const columnWidth = Math.max(24, Math.floor((width - separator.length) / 2));
  const splitFocus = getSplitLogFocus(shellState);
  const apiOffset = getLogScrollOffset(shellState, "api");
  const sasaOffset = getLogScrollOffset(shellState, "sasa");
  const apiLogs = getServiceLogs(shellState, "api", panelHeight).map((entry) => entry.line);
  const sasaLogs = getServiceLogs(shellState, "sasa", panelHeight).map((entry) => entry.line);
  const maxLines = Math.max(panelHeight, apiLogs.length, sasaLogs.length);
  const apiTitle = splitFocus === "api" ? `API* (+${apiOffset})` : `API (+${apiOffset})`;
  const sasaTitle = splitFocus === "sasa" ? `SASA* (+${sasaOffset})` : `SASA (+${sasaOffset})`;

  process.stdout.write("Logs (split: api | sasa):\n");
  process.stdout.write(`${padCell(apiTitle, columnWidth)}${separator}${padCell(sasaTitle, columnWidth)}\n`);
  process.stdout.write(`${"-".repeat(columnWidth)}${separator}${"-".repeat(columnWidth)}\n`);

  for (let index = 0; index < maxLines; index += 1) {
    const apiLine = apiLogs[index] ?? (index === 0 && apiLogs.length === 0 ? "(no logs yet)" : "");
    const sasaLine = sasaLogs[index] ?? (index === 0 && sasaLogs.length === 0 ? "(no logs yet)" : "");
    process.stdout.write(`${padCell(apiLine, columnWidth)}${separator}${padCell(sasaLine, columnWidth)}\n`);
  }

  process.stdout.write("Controls: [ focus API ] focus SASA | PgUp/PgDn scroll | Home/End latest\n");
  process.stdout.write("\n");
}

function getLogPanelHeight(): number {
  const rows = process.stdout.rows ?? 40;
  // Reserve space for header, input and suggestions.
  return Math.max(6, Math.min(18, rows - 20));
}

function truncateLine(line: string, maxWidth: number): string {
  if (line.length <= maxWidth) {
    return line;
  }
  if (maxWidth <= 3) {
    return line.slice(0, maxWidth);
  }
  return `${line.slice(0, maxWidth - 3)}...`;
}

function padCell(line: string, width: number): string {
  return truncateLine(line, width).padEnd(width, " ");
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
