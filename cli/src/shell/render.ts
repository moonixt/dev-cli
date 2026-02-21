import readline from "node:readline";
import { cliVersion, repoRoot } from "../config";
import { shellCategoryLabels, shellCategoryOrder, shellCommands } from "./commands";
import {
  getLogScrollOffset,
  getRunningSummary,
  getServiceLogs,
  getSplitLogFocus,
  getVisibleLogs,
  isSuggestionRunning
} from "./state";
import type { ServiceName, ShellCommand, ShellCommandCategory, ShellState } from "../types";
import {
  bold,
  colorService,
  cyan,
  dim,
  getAnsiReset,
  green,
  hasAnsi,
  highlightErrorKeywords,
  stripAnsi,
  yellow
} from "../utils/colors";

const splitServices: ServiceName[] = ["api", "sasa", "frontend", "waha"];
const splitPageSize = 2;

export function printShellHelp(): void {
  const maxCommandLength = shellCommands.reduce((max, item) => Math.max(max, item.command.length), 0);
  const lines: string[] = [];
  for (const category of shellCategoryOrder) {
    const commandsByCategory = shellCommands.filter((item) => item.category === category);
    if (commandsByCategory.length === 0) {
      continue;
    }

    lines.push(colorCategoryLabel(category));
    for (const item of commandsByCategory) {
      const paddedCommand = item.command.padEnd(maxCommandLength, " ");
      lines.push(`  ${cyan(paddedCommand)}  ${dim(item.description)}`);
    }
    lines.push("");
  }
  process.stdout.write(`${lines.join("\n").trimEnd()}\n`);
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
  const renderedSuggestionLines = renderSuggestions(input, activeIndex, suggestions, shellState);

  readline.moveCursor(process.stdout, 0, -(renderedSuggestionLines + 1));
  readline.cursorTo(process.stdout, input.length + 2);
}

export function filterShellCommands(input: string): ShellCommand[] {
  const normalized = normalizeCommandPrefix(input.trim().toLowerCase());
  if (!normalized.startsWith("/")) {
    return [];
  }

  if (normalized === "/") {
    return shellCommands;
  }

  return shellCommands.filter((item) => item.command.startsWith(normalized));
}

function renderSuggestions(
  input: string,
  activeIndex: number,
  suggestions: ShellCommand[],
  shellState: ShellState
): number {
  const showingAllCommands = normalizeCommandPrefix(input.trim().toLowerCase()) === "/";
  if (!showingAllCommands) {
    process.stdout.write("\n");
    for (let index = 0; index < suggestions.length; index += 1) {
      const suggestion = suggestions[index];
      process.stdout.write(renderSuggestionLine(suggestion, index === activeIndex, shellState));
    }
    return suggestions.length + 1;
  }

  let renderedLines = 1;
  let index = 0;
  process.stdout.write("\n");
  for (const category of shellCategoryOrder) {
    const byCategory = suggestions.filter((item) => item.category === category);
    if (byCategory.length === 0) {
      continue;
    }

    process.stdout.write(`${colorCategoryLabel(category)}\n`);
    renderedLines += 1;
    for (const suggestion of byCategory) {
      process.stdout.write(renderSuggestionLine(suggestion, index === activeIndex, shellState));
      index += 1;
      renderedLines += 1;
    }
  }

  return renderedLines;
}

function renderSuggestionLine(suggestion: ShellCommand, isActive: boolean, shellState: ShellState): string {
  const marker = isActive ? green(">") : " ";
  const isRunning = isSuggestionRunning(suggestion.command, shellState);
  const paddedCommand = suggestion.command.padEnd(18, " ");
  const commandText = isRunning ? yellow(paddedCommand) : cyan(paddedCommand);
  const categoryText = dim(`[${shellCategoryLabels[suggestion.category]}]`);
  const descriptionText = isRunning ? `${suggestion.description} ${yellow("running")}` : suggestion.description;
  return `${marker} ${categoryText} ${commandText} ${descriptionText}\n`;
}

function normalizeCommandPrefix(input: string): string {
  if (input === "/keyword") {
    return "/keywords";
  }

  if (input.startsWith("/keyword ")) {
    return `/keywords ${input.slice(9)}`.trimEnd();
  }

  if (input === "/kw") {
    return "/keywords";
  }

  if (input.startsWith("/kw ")) {
    return `/keywords ${input.slice(4)}`.trimEnd();
  }

  return input;
}

function printShellHeader(shellState: ShellState): void {
  const lines = [
    `> ${bold(cyan("dev-cli"))} ${dim(`(${cliVersion})`)}`,
    `${bold("workspace:")} ${repoRoot}`,
    `${bold("directory:")} ${process.cwd()}`,
    `${bold("running:")} ${getRunningSummary(shellState)}`,
    `${bold("log view:")} ${shellState.logView}`,
    dim("type / to list commands")
  ];

  console.log(drawBox(lines));
  console.log("");
  console.log(dim("Tip: type / and use Up/Down arrows to select commands."));
  if (shellState.message) {
    console.log(`${yellow("Info:")} ${shellState.message}`);
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

  process.stdout.write(`${bold("Logs")} (${shellState.logView}, scroll +${offset}):\n`);
  if (logLines.length === 0) {
    process.stdout.write(`  ${dim("(no logs yet)")}\n\n`);
    return;
  }

  for (const entry of logLines) {
    const prefix = colorService(entry.service, `[${entry.service}]`);
    const line = `${prefix} ${highlightErrorKeywords(entry.line)}`;
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
    lines: getServiceLogs(shellState, serviceName, panelHeight).map((entry) => highlightErrorKeywords(entry.line))
  }));
  const maxLines = Math.max(
    panelHeight,
    ...serviceLogs.map((item) => item.lines.length)
  );
  const titles = serviceLogs.map((item) => {
    const serviceLabel = item.serviceName.toUpperCase();
    const label = splitFocus === item.serviceName
      ? `${serviceLabel}* (+${item.offset})`
      : `${serviceLabel} (+${item.offset})`;
    return splitFocus === item.serviceName
      ? bold(colorService(item.serviceName, label))
      : colorService(item.serviceName, label);
  });
  const titleRow = titles.map((title) => padCell(title, columnWidth)).join(separator);
  const dividerRow = visibleServices.map(() => "-".repeat(columnWidth)).join(separator);

  const showingLabel = visibleServices.join(" | ");
  const fullLabel = splitServices.join(" | ");
  const pageIndex = Math.floor(Math.max(0, splitServices.indexOf(splitFocus)) / splitPageSize);
  const pageCount = Math.ceil(splitServices.length / splitPageSize);
  process.stdout.write(
    `${bold("Logs")} (split: ${showingLabel}) ${dim(`[page ${pageIndex + 1}/${pageCount} | all: ${fullLabel}]`)}:\n`
  );
  process.stdout.write(`${titleRow}\n`);
  process.stdout.write(`${dim(dividerRow)}\n`);

  for (let index = 0; index < maxLines; index += 1) {
    const row = serviceLogs
      .map((item) => item.lines[index] ?? (index === 0 && item.lines.length === 0 ? dim("(no logs yet)") : ""))
      .map((line) => padCell(line, columnWidth))
      .join(separator);
    process.stdout.write(`${row}\n`);
  }

  process.stdout.write(
    `${dim("Controls: [ prev pair | ] next pair | PgUp/PgDn scroll | Home/End latest")}\n`
  );
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
  return hasAnsi(line) ? `${truncated}...${getAnsiReset()}` : `${truncated}...`;
}

function padCell(line: string, width: number): string {
  const truncated = truncateLine(line, width);
  const padding = Math.max(0, width - visibleLength(truncated));
  return `${truncated}${" ".repeat(padding)}`;
}

function drawBox(lines: string[]): string {
  const width = lines.reduce((max, line) => Math.max(max, visibleLength(line)), 0);
  const top = `+${"-".repeat(width + 2)}+`;
  const middle = lines.map((line) => `| ${padVisible(line, width)} |`);
  return [top, ...middle, top].join("\n");
}

function padVisible(line: string, width: number): string {
  const padding = Math.max(0, width - visibleLength(line));
  return `${line}${" ".repeat(padding)}`;
}

function colorCategoryLabel(category: ShellCommandCategory): string {
  const label = `[${shellCategoryLabels[category]}]`;
  switch (category) {
    case "api":
      return bold(cyan(label));
    case "logs":
      return bold(yellow(label));
    case "database":
      return bold(green(label));
    case "keywords":
      return bold(colorService("sasa", label));
    case "system":
      return bold(dim(label));
    default:
      return bold(label);
  }
}

function resolveVisibleSplitServices(splitFocus: ServiceName): ServiceName[] {
  const focusIndex = Math.max(0, splitServices.indexOf(splitFocus));
  const startIndex = Math.floor(focusIndex / splitPageSize) * splitPageSize;
  const visible = splitServices.slice(startIndex, startIndex + splitPageSize);
  return visible.length > 0 ? visible : splitServices.slice(0, splitPageSize);
}

function visibleLength(line: string): number {
  return stripAnsi(line).length;
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
