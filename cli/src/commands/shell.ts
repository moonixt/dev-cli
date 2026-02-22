import readline from "node:readline";
import { Command } from "commander";
import path from "node:path";
import { runDbResetWithOutput } from "./db/reset";
import { loadWorkspaceConfig } from "../services/config-loader";
import { generateShellCommandCatalog } from "../shell/commands";
import { filterShellCommands, printShellHelp, renderLiveShell, renderShellHome } from "../shell/render";
import {
  attachExternalLogStreams,
  clearLogs,
  createShellState,
  hydrateRunningServices,
  getRunningSummary,
  resetFocusedLogScroll,
  scrollFocusedLog,
  setLogView,
  setSplitLogFocus,
  setShellMessage,
  startBackground,
  stopAllRunning,
  stopBackground,
  toggleSplitLogMaximized,
  writeShellOutput
} from "../shell/state";
import type { LoadedWorkspaceConfig, ServiceId, ServiceRuntimeConfig, ShellState } from "../types";
import {
  addErrorKeyword,
  getErrorKeywords,
  getErrorKeywordsConfigPath,
  hasPersistedErrorKeywords,
  removeErrorKeyword,
  resetErrorKeywords,
  setErrorKeywords
} from "../utils/error-keywords";
import { getLegacyConsolidatedLogPath, getServiceLogsRootPath } from "../utils/service-log-file";
import { resolveRunTarget } from "../utils/target";

type ShellCommandOptions = {
  config?: string;
};

const splitPageSize = 2;

export function registerShellCommand(program: Command): void {
  program
    .command("shell", { isDefault: true })
    .alias("ui")
    .description("Interactive terminal UI with slash commands")
    .option("--config <path>", "Path to dev-cli.config.json")
    .action(async (options: ShellCommandOptions) => {
      const workspace = loadWorkspaceConfig({
        explicitConfigPath: options.config,
        cwd: process.cwd()
      });
      process.env.DEV_CLI_LOG_ROOT = process.env.DEV_CLI_LOG_ROOT?.trim()
        ? process.env.DEV_CLI_LOG_ROOT
        : path.join(workspace.workspaceRoot, "logs");
      process.exitCode = await runShell(workspace);
    });
}

async function runShell(workspace: LoadedWorkspaceConfig): Promise<number> {
  const services = workspace.services;
  const commandCatalog = generateShellCommandCatalog(services, workspace.serviceOrder);
  const allTargets = workspace.groups.all?.length ? workspace.groups.all : workspace.serviceOrder;
  const shellState = createShellState(
    workspace.serviceOrder,
    allTargets,
    commandCatalog,
    workspace.workspaceRoot,
    workspace.workspaceName
  );

  setShellMessage(
    shellState,
    `service logs dir: ${getServiceLogsRootPath()} | consolidated: ${getLegacyConsolidatedLogPath()}`
  );
  if (workspace.serviceOrder.length === 0) {
    setShellMessage(shellState, 'no services configured. run "dev-cli init" to create dev-cli.config.json');
  }

  hydrateRunningServices(shellState, services);
  const externalServices = Array.from(shellState.running.entries())
    .filter(([, running]) => running.external)
    .map(([serviceId]) => serviceId);
  if (externalServices.length > 0) {
    setShellMessage(
      shellState,
      `detected running services: ${externalServices.join(", ")} | logs: ${getServiceLogsRootPath()}`
    );
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return runShellFallback(services, shellState);
  }

  return runShellVisual(services, shellState);
}

function runShellVisual(services: Record<ServiceId, ServiceRuntimeConfig>, shellState: ShellState): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const logScrollStep = 5;
    const logPageStep = 12;
    let lastExitCode = 0;
    let input = "";
    let selectedIndex = 0;
    let busy = false;
    let closed = false;
    let queuedRender = false;

    const onSignal = (): void => {
      cleanup(130);
    };

    const requestRender = (): void => {
      if (closed || busy || queuedRender) {
        return;
      }

      queuedRender = true;
      setImmediate(() => {
        queuedRender = false;
        if (!closed && !busy) {
          renderLiveShell(input, selectedIndex, shellState);
        }
      });
    };

    const onResize = (): void => {
      requestRender();
    };

    const cleanup = (exitCode: number): void => {
      if (closed) {
        return;
      }

      stopAllRunning(shellState, services);
      closed = true;
      stdin.off("keypress", onKeypress);
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      process.stdout.off("resize", onResize);
      shellState.onChange = undefined;
      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      stdin.pause();
      process.stdout.write("\n");
      resolve(exitCode);
    };

    const executeInput = async (): Promise<void> => {
      let command = input.trim();
      const suggestions = filterShellCommands(input, shellState);
      if (command.startsWith("/") && suggestions.length > 0) {
        const selected = suggestions[Math.max(0, Math.min(selectedIndex, suggestions.length - 1))];
        const isExactCommand = shellState.commandCatalog.commandNames.includes(command);
        if (!isExactCommand) {
          command = selected.command;
        }
      }

      input = "";
      selectedIndex = 0;
      if (!command) {
        renderLiveShell(input, selectedIndex, shellState);
        return;
      }

      if (stdin.isTTY) {
        stdin.setRawMode(false);
      }
      if (suggestions.length > 0) {
        readline.moveCursor(process.stdout, 0, suggestions.length);
      }
      readline.clearScreenDown(process.stdout);
      process.stdout.write("\n");

      const result = await handleShellInput(command, services, shellState);
      lastExitCode = result.exitCode;

      if (!result.continueShell) {
        cleanup(lastExitCode);
        return;
      }

      if (stdin.isTTY) {
        stdin.setRawMode(true);
      }
      renderLiveShell(input, selectedIndex, shellState);
    };

    const getLogPanelHeight = (): number => {
      const rows = process.stdout.rows ?? 40;
      return Math.max(6, Math.min(18, rows - 20));
    };

    const handleLogNavigationKey = (str: string, key: readline.Key): boolean => {
      if (shellState.logView === "off") {
        return false;
      }

      if (shellState.logView === "all" && input.length === 0) {
        if (str === "[") {
          const previous = previousSplitFocus(
            shellState.splitLogFocus,
            shellState.serviceOrder,
            shellState.splitLogMaximized ? "service" : "pair"
          );
          if (previous) {
            setSplitLogFocus(shellState, previous);
            return true;
          }
        }
        if (str === "]") {
          const next = nextSplitFocus(
            shellState.splitLogFocus,
            shellState.serviceOrder,
            shellState.splitLogMaximized ? "service" : "pair"
          );
          if (next) {
            setSplitLogFocus(shellState, next);
            return true;
          }
        }
        if (key.name === "m" && !key.ctrl && !key.meta) {
          toggleSplitLogMaximized(shellState);
          return true;
        }
      }

      if (key.name === "pageup") {
        scrollFocusedLog(shellState, logPageStep, getLogPanelHeight());
        return true;
      }
      if (key.name === "pagedown") {
        scrollFocusedLog(shellState, -logPageStep, getLogPanelHeight());
        return true;
      }
      if (key.name === "home") {
        scrollFocusedLog(shellState, Number.MAX_SAFE_INTEGER, getLogPanelHeight());
        return true;
      }
      if (key.name === "end") {
        resetFocusedLogScroll(shellState);
        return true;
      }
      if (isFineScrollUpKey(str, key)) {
        scrollFocusedLog(shellState, logScrollStep, getLogPanelHeight());
        return true;
      }
      if (isFineScrollDownKey(str, key)) {
        scrollFocusedLog(shellState, -logScrollStep, getLogPanelHeight());
        return true;
      }

      return false;
    };

    const onKeypress = (str: string, key: readline.Key): void => {
      if (closed || busy) {
        return;
      }

      if (key.ctrl && key.name === "c") {
        cleanup(130);
        return;
      }

      if (handleLogNavigationKey(str, key)) {
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        busy = true;
        void executeInput().finally(() => {
          busy = false;
        });
        return;
      }

      if (key.name === "backspace") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          selectedIndex = 0;
          renderLiveShell(input, selectedIndex, shellState);
        }
        return;
      }

      if (key.name === "escape") {
        input = "";
        selectedIndex = 0;
        renderLiveShell(input, selectedIndex, shellState);
        return;
      }

      if (key.name === "up" || key.name === "down") {
        const suggestions = filterShellCommands(input || "/", shellState);
        if (suggestions.length === 0) {
          return;
        }

        if (key.name === "down") {
          selectedIndex = (selectedIndex + 1) % suggestions.length;
        } else {
          selectedIndex = (selectedIndex - 1 + suggestions.length) % suggestions.length;
        }
        renderLiveShell(input, selectedIndex, shellState);
        return;
      }

      if (key.name === "tab") {
        const suggestions = filterShellCommands(input || "/", shellState);
        if (suggestions.length > 0) {
          const selected = suggestions[Math.max(0, Math.min(selectedIndex, suggestions.length - 1))];
          input = selected.command;
          selectedIndex = 0;
        }
        renderLiveShell(input, selectedIndex, shellState);
        return;
      }

      if (str && !key.ctrl && !key.meta && str >= " " && str !== "\u007f") {
        input += str;
        selectedIndex = 0;
        renderLiveShell(input, selectedIndex, shellState);
      }
    };

    readline.emitKeypressEvents(stdin);
    stdin.setEncoding("utf8");
    if (stdin.isTTY) {
      stdin.setRawMode(true);
    }
    stdin.resume();
    stdin.on("keypress", onKeypress);
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);
    process.stdout.on("resize", onResize);
    shellState.onChange = () => {
      requestRender();
    };

    renderLiveShell(input, selectedIndex, shellState);
  });
}

function runShellFallback(services: Record<ServiceId, ServiceRuntimeConfig>, shellState: ShellState): Promise<number> {
  return new Promise((resolve) => {
    let lastExitCode = 0;
    let commandInProgress = false;
    let closing = false;
    const queue: string[] = [];

    const completer = (input: string): [string[], string] => {
      const trimmed = normalizeShellPrefix(input.trim());
      const matches = shellState.commandCatalog.commandNames.filter((command) => command.startsWith(trimmed));
      if (matches.length > 0) {
        return [matches, input];
      }
      return [shellState.commandCatalog.commandNames, input];
    };

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
      completer
    });

    const onSignal = (): void => {
      if (closing) {
        return;
      }
      closing = true;
      lastExitCode = 130;
      stopAllRunning(shellState, services);
      rl.close();
    };

    renderShellHome(shellState);
    rl.prompt();

    const processQueue = async (): Promise<void> => {
      if (commandInProgress || closing) {
        return;
      }

      const nextLine = queue.shift();
      if (nextLine === undefined) {
        return;
      }

      commandInProgress = true;
      const result = await handleShellInput(nextLine.trim(), services, shellState);
      commandInProgress = false;
      lastExitCode = result.exitCode;

      if (!result.continueShell) {
        closing = true;
        rl.close();
        return;
      }

      rl.prompt();
      await processQueue();
    };

    rl.on("line", (line) => {
      queue.push(line);
      void processQueue();
    });
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    rl.on("close", () => {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      stopAllRunning(shellState, services);
      resolve(lastExitCode);
    });
  });
}

async function handleShellInput(
  input: string,
  services: Record<ServiceId, ServiceRuntimeConfig>,
  shellState: ShellState
): Promise<{ continueShell: boolean; exitCode: number }> {
  if (!input) {
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/" || input === "/help" || input === "help") {
    if (shellState.onChange) {
      setShellMessage(shellState, "Use /start, /stop, /logs, /db, /keywords, /status, /clear, /exit");
    } else {
      printShellHelp(shellState);
    }
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/clear" || input === "clear") {
    setShellMessage(shellState, "");
    renderShellHome(shellState);
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/status" || input === "status") {
    writeShellOutput(shellState, getRunningSummary(shellState));
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/exit" || input === "/quit" || input === "exit" || input === "quit") {
    return { continueShell: false, exitCode: 0 };
  }

  const normalized = normalizeShellPrefix(input.startsWith("/") ? input : `/${input}`);
  if (normalized.startsWith("/keywords")) {
    return { continueShell: true, exitCode: handleKeywordShellCommand(normalized, shellState) };
  }

  if (normalized.startsWith("/logs")) {
    return handleLogsShellCommand(normalized, services, shellState);
  }

  if (normalized === "/db reset") {
    const exitCode = await runDbResetWithOutput({}, { silent: true });
    setShellMessage(shellState, exitCode === 0 ? "queryreset executed successfully" : "queryreset failed");
    return { continueShell: true, exitCode };
  }

  if (normalized.startsWith("/start") || normalized.startsWith("/run")) {
    const parts = normalized.split(/\s+/).filter(Boolean);
    try {
      const target = resolveRunTarget(parts[1] ?? "all", shellState.serviceOrder);
      return { continueShell: true, exitCode: startBackground(target, services, shellState) };
    } catch (error) {
      writeShellOutput(shellState, error instanceof Error ? error.message : String(error));
      return { continueShell: true, exitCode: 1 };
    }
  }

  if (normalized.startsWith("/stop")) {
    const parts = normalized.split(/\s+/).filter(Boolean);
    try {
      const target = resolveRunTarget(parts[1] ?? "all", shellState.serviceOrder);
      return { continueShell: true, exitCode: stopBackground(target, services, shellState) };
    } catch (error) {
      writeShellOutput(shellState, error instanceof Error ? error.message : String(error));
      return { continueShell: true, exitCode: 1 };
    }
  }

  writeShellOutput(shellState, `Unknown command: ${input}`);
  return { continueShell: true, exitCode: 1 };
}

function handleLogsShellCommand(
  normalized: string,
  services: Record<ServiceId, ServiceRuntimeConfig>,
  shellState: ShellState
): { continueShell: boolean; exitCode: number } {
  const parts = normalized.split(/\s+/).filter(Boolean);
  const view = parts[1] ?? "all";

  if (view === "clear") {
    clearLogs(shellState);
    setShellMessage(shellState, "logs cleared");
    return { continueShell: true, exitCode: 0 };
  }

  if (view === "off") {
    setLogView(shellState, "off");
    setShellMessage(shellState, "logs hidden");
    return { continueShell: true, exitCode: 0 };
  }

  if (view === "all") {
    setLogView(shellState, "all");
    attachExternalLogStreams(shellState, services, shellState.serviceOrder);
    setShellMessage(shellState, "log view set to all");
    return { continueShell: true, exitCode: 0 };
  }

  if (!shellState.serviceOrder.includes(view)) {
    writeShellOutput(shellState, `Unknown log target: ${view}`);
    return { continueShell: true, exitCode: 1 };
  }

  setLogView(shellState, view);
  attachExternalLogStreams(shellState, services, [view]);
  setShellMessage(shellState, `log view set to ${view}`);
  return { continueShell: true, exitCode: 0 };
}

function normalizeShellPrefix(input: string): string {
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

function handleKeywordShellCommand(input: string, shellState: ShellState): number {
  const tokens = parseShellTokens(input);
  const actionToken = (tokens[1] ?? "list").toLowerCase();
  const knownActions = new Set(["list", "add", "remove", "set", "reset"]);
  const hasExplicitAction = knownActions.has(actionToken);
  const action = hasExplicitAction ? actionToken : (tokens.length > 1 ? "add" : "list");

  if (action === "list") {
    const list = getErrorKeywords();
    const configState = hasPersistedErrorKeywords() ? "persisted" : "defaults/env";
    writeShellOutput(shellState, `keywords (${configState}): ${formatKeywords(list)}`);
    writeShellOutput(shellState, `config: ${getErrorKeywordsConfigPath()}`);
    setShellMessage(shellState, "keywords listed");
    return 0;
  }

  if (action === "reset") {
    const updated = resetErrorKeywords();
    writeShellOutput(shellState, `keywords reset: ${formatKeywords(updated)}`);
    setShellMessage(shellState, "keywords reset");
    return 0;
  }

  if (action === "add") {
    const rawKeyword = hasExplicitAction
      ? input.replace(/^\/keywords\s+add\s*/i, "").trim()
      : tokens.slice(1).join(" ").trim();
    const keyword = stripMatchingQuotes(rawKeyword);
    if (!keyword) {
      writeShellOutput(shellState, "Usage: /keywords add <keyword>");
      return 1;
    }

    try {
      const result = addErrorKeyword(keyword);
      if (!result.added) {
        writeShellOutput(shellState, `keyword already exists: ${result.keyword}`);
        setShellMessage(shellState, "keyword unchanged");
        return 0;
      }
      writeShellOutput(shellState, `keyword added: ${result.keyword}`);
      writeShellOutput(shellState, `keywords: ${formatKeywords(result.updatedKeywords)}`);
      setShellMessage(shellState, "keyword added");
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeShellOutput(shellState, `keywords add failed: ${message}`);
      return 1;
    }
  }

  if (action === "remove") {
    const rawKeyword = input.replace(/^\/keywords\s+remove\s*/i, "").trim();
    const keyword = stripMatchingQuotes(rawKeyword);
    if (!keyword) {
      writeShellOutput(shellState, "Usage: /keywords remove <keyword>");
      return 1;
    }

    try {
      const result = removeErrorKeyword(keyword);
      if (!result.removed) {
        writeShellOutput(shellState, `keyword not found: ${result.keyword}`);
        setShellMessage(shellState, "keyword not found");
        return 0;
      }
      writeShellOutput(shellState, `keyword removed: ${result.keyword}`);
      writeShellOutput(shellState, `keywords: ${formatKeywords(result.updatedKeywords)}`);
      setShellMessage(shellState, "keyword removed");
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeShellOutput(shellState, `keywords remove failed: ${message}`);
      return 1;
    }
  }

  if (action === "set") {
    const values = tokens.slice(2);
    if (values.length === 0) {
      writeShellOutput(shellState, 'Usage: /keywords set fail error panic "timed out"');
      return 1;
    }

    try {
      const updated = setErrorKeywords(values);
      writeShellOutput(shellState, `keywords replaced: ${formatKeywords(updated)}`);
      setShellMessage(shellState, "keywords replaced");
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      writeShellOutput(shellState, `keywords set failed: ${message}`);
      return 1;
    }
  }

  writeShellOutput(shellState, "Unknown keywords command. Use: /keywords list|add|remove|set|reset");
  return 1;
}

function parseShellTokens(input: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null = regex.exec(input);
  while (match) {
    tokens.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
    match = regex.exec(input);
  }
  return tokens.filter((token) => token.length > 0);
}

function stripMatchingQuotes(text: string): string {
  if (
    text.length >= 2 &&
    ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function formatKeywords(keywords: string[]): string {
  return keywords.length > 0 ? keywords.join(", ") : "(none)";
}

type SplitShiftMode = "pair" | "service";

function nextSplitFocus(
  current: ServiceId | null,
  serviceOrder: ServiceId[],
  mode: SplitShiftMode = "pair"
): ServiceId | null {
  if (mode === "service") {
    return shiftSplitFocusByService(current, serviceOrder, 1);
  }
  return shiftSplitFocusByPage(current, serviceOrder, 1);
}

function previousSplitFocus(
  current: ServiceId | null,
  serviceOrder: ServiceId[],
  mode: SplitShiftMode = "pair"
): ServiceId | null {
  if (mode === "service") {
    return shiftSplitFocusByService(current, serviceOrder, -1);
  }
  return shiftSplitFocusByPage(current, serviceOrder, -1);
}

function shiftSplitFocusByPage(
  current: ServiceId | null,
  serviceOrder: ServiceId[],
  direction: 1 | -1
): ServiceId | null {
  if (serviceOrder.length === 0) {
    return null;
  }
  const pageCount = Math.ceil(serviceOrder.length / splitPageSize);
  const currentIndex = current ? serviceOrder.indexOf(current) : 0;
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentPage = Math.floor(safeIndex / splitPageSize);
  const columnOffset = safeIndex % splitPageSize;
  const nextPage = (currentPage + direction + pageCount) % pageCount;
  const nextIndex = Math.min(nextPage * splitPageSize + columnOffset, serviceOrder.length - 1);
  return serviceOrder[nextIndex];
}

function shiftSplitFocusByService(
  current: ServiceId | null,
  serviceOrder: ServiceId[],
  direction: 1 | -1
): ServiceId | null {
  if (serviceOrder.length === 0) {
    return null;
  }

  const currentIndex = current ? serviceOrder.indexOf(current) : 0;
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const nextIndex = (safeIndex + direction + serviceOrder.length) % serviceOrder.length;
  return serviceOrder[nextIndex];
}

function isFineScrollUpKey(str: string, key: readline.Key): boolean {
  if ((key.ctrl || key.meta) && key.name === "up") {
    return true;
  }
  const sequence = key.sequence ?? str;
  return isModifiedArrowSequence(sequence, "A");
}

function isFineScrollDownKey(str: string, key: readline.Key): boolean {
  if ((key.ctrl || key.meta) && key.name === "down") {
    return true;
  }
  const sequence = key.sequence ?? str;
  return isModifiedArrowSequence(sequence, "B");
}

function isModifiedArrowSequence(sequence: string | undefined, directionCode: "A" | "B"): boolean {
  if (!sequence) {
    return false;
  }

  return (
    sequence === `\u001b[1;5${directionCode}` ||
    sequence === `\u001b[5${directionCode}` ||
    sequence === `\u001b[1;3${directionCode}` ||
    sequence === `\u001b[3${directionCode}` ||
    sequence === `\u001bO5${directionCode}` ||
    sequence === `\u001bO3${directionCode}`
  );
}
