import readline from "node:readline";
import { Command } from "commander";
import { runDbResetWithOutput } from "./db/reset";
import { assertPathsExist, getServiceConfig } from "../services/service-config";
import { shellCommandNames } from "../shell/commands";
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
  writeShellOutput
} from "../shell/state";
import type { ServiceConfig, ServiceName, ShellState, StartCommandOptions } from "../types";
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
import { normalizeTarget } from "../utils/target";

const splitOrder: ServiceName[] = ["api", "sasa", "frontend", "waha"];
const splitPageSize = 2;
const defaultNpmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const defaultDockerCommand = "docker";

export function registerShellCommand(program: Command): void {
  program
    .command("shell", { isDefault: true })
    .alias("ui")
    .description("Interactive terminal UI with slash commands")
    .option("--dotnet <command>", "Override dotnet executable", "dotnet")
    .option("--python <command>", "Override python executable", "python")
    .option("--npm <command>", "Override npm executable", defaultNpmCommand)
    .option("--docker <command>", "Override docker executable", defaultDockerCommand)
    .action(async (options: StartCommandOptions) => {
      const services = getServiceConfig(options.dotnet, options.python, options.npm, options.docker);
      assertPathsExist(services);
      process.exitCode = await runShell(services);
    });
}

async function runShell(services: Record<ServiceName, ServiceConfig>): Promise<number> {
  const shellState = createShellState();
  setShellMessage(
    shellState,
    `service logs dir: ${getServiceLogsRootPath()} | consolidated: ${getLegacyConsolidatedLogPath()}`
  );
  hydrateRunningServices(shellState, services);
  const externalServices = Array.from(shellState.running.entries())
    .filter(([, running]) => running.external)
    .map(([serviceName]) => serviceName);
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

function runShellVisual(services: Record<ServiceName, ServiceConfig>, shellState: ShellState): Promise<number> {
  return new Promise((resolve) => {
    const stdin = process.stdin;
    const logScrollStep = 5;
    const logPageStep = 12;
    let lastExitCode = 0;
    let input = "";
    let selectedIndex = 0;
    let busy = false;
    let closed = false;
    const onSignal = (): void => {
      cleanup(130);
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
      const suggestions = filterShellCommands(input);
      if (command.startsWith("/") && suggestions.length > 0) {
        const selected = suggestions[Math.max(0, Math.min(selectedIndex, suggestions.length - 1))];
        const isExactCommand = shellCommandNames.includes(command);
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
        // Cursor stays on the input row while suggestions are drawn below.
        // Move to the bottom and clear so command output does not overlap suggestion text.
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
          setSplitLogFocus(shellState, previousSplitFocus(shellState.splitLogFocus));
          return true;
        }
        if (str === "]") {
          setSplitLogFocus(shellState, nextSplitFocus(shellState.splitLogFocus));
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

      if (key.ctrl && key.name === "up") {
        scrollFocusedLog(shellState, logScrollStep, getLogPanelHeight());
        return true;
      }

      if (key.ctrl && key.name === "down") {
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
        const suggestions = filterShellCommands(input || "/");
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
        const suggestions = filterShellCommands(input || "/");
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
    shellState.onChange = () => {
      if (!closed && !busy) {
        renderLiveShell(input, selectedIndex, shellState);
      }
    };

    renderLiveShell(input, selectedIndex, shellState);
  });
}

function runShellFallback(services: Record<ServiceName, ServiceConfig>, shellState: ShellState): Promise<number> {
  return new Promise((resolve) => {
    let lastExitCode = 0;
    let commandInProgress = false;
    let closing = false;
    const queue: string[] = [];

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: "> ",
      completer: shellCompleter
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

function shellCompleter(input: string): [string[], string] {
  const trimmed = normalizeShellPrefix(input.trim());
  const matches = shellCommandNames.filter((command) => command.startsWith(trimmed));
  if (matches.length > 0) {
    return [matches, input];
  }
  return [shellCommandNames, input];
}

async function handleShellInput(
  input: string,
  services: Record<ServiceName, ServiceConfig>,
  shellState: ShellState
): Promise<{ continueShell: boolean; exitCode: number }> {
  if (!input) {
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/" || input === "/help" || input === "help") {
    if (shellState.onChange) {
      setShellMessage(shellState, "Use /start, /stop, /logs, /db, /keywords, /status, /clear, /exit");
    } else {
      printShellHelp();
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

  if (input === "/logs clear") {
    clearLogs(shellState);
    setShellMessage(shellState, "logs cleared");
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/logs" || input === "logs") {
    setLogView(shellState, "all");
    attachExternalLogStreams(shellState, services, splitOrder);
    setShellMessage(shellState, "log view set to all");
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/logs off") {
    setLogView(shellState, "off");
    setShellMessage(shellState, "logs hidden");
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/logs all" || input === "/logs api" || input === "/logs sasa" || input === "/logs frontend" || input === "/logs waha") {
    const view = (input.split(/\s+/)[1] ?? "all") as "all" | "api" | "sasa" | "frontend" | "waha";
    setLogView(shellState, view);
    if (view === "all") {
      attachExternalLogStreams(shellState, services, splitOrder);
    } else {
      attachExternalLogStreams(shellState, services, [view]);
    }
    setShellMessage(shellState, `log view set to ${view}`);
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/exit" || input === "/quit" || input === "exit" || input === "quit") {
    return { continueShell: false, exitCode: 0 };
  }

  const normalized = normalizeShellPrefix(input.startsWith("/") ? input : `/${input}`);
  if (normalized.startsWith("/keywords")) {
    return { continueShell: true, exitCode: handleKeywordShellCommand(normalized, shellState) };
  }

  if (normalized.startsWith("/start") || normalized.startsWith("/run")) {
    const parts = normalized.split(/\s+/).filter(Boolean);
    const target = normalizeTarget(parts[1] ?? "all");
    return { continueShell: true, exitCode: startBackground(target, services, shellState) };
  }

  if (normalized === "/db reset") {
    const exitCode = await runDbResetWithOutput({}, { silent: true });
    setShellMessage(shellState, exitCode === 0 ? "queryreset executed successfully" : "queryreset failed");
    return { continueShell: true, exitCode };
  }

  if (normalized.startsWith("/stop")) {
    const parts = normalized.split(/\s+/).filter(Boolean);
    const target = normalizeTarget(parts[1] ?? "all");
    return { continueShell: true, exitCode: stopBackground(target, services, shellState) };
  }

  writeShellOutput(shellState, `Unknown command: ${input}`);
  return { continueShell: true, exitCode: 1 };
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
    let rawKeyword = hasExplicitAction
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
    let rawKeyword = input.replace(/^\/keywords\s+remove\s*/i, "").trim();
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
  if (text.length >= 2) {
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      return text.slice(1, -1).trim();
    }
  }
  return text;
}

function formatKeywords(keywords: string[]): string {
  return keywords.length > 0 ? keywords.join(", ") : "(none)";
}

function nextSplitFocus(current: ServiceName): ServiceName {
  return shiftSplitFocusByPage(current, 1);
}

function previousSplitFocus(current: ServiceName): ServiceName {
  return shiftSplitFocusByPage(current, -1);
}

function shiftSplitFocusByPage(current: ServiceName, direction: 1 | -1): ServiceName {
  const pageCount = Math.ceil(splitOrder.length / splitPageSize);
  const currentIndex = splitOrder.indexOf(current);
  const safeIndex = currentIndex >= 0 ? currentIndex : 0;
  const currentPage = Math.floor(safeIndex / splitPageSize);
  const columnOffset = safeIndex % splitPageSize;
  const nextPage = (currentPage + direction + pageCount) % pageCount;
  const nextIndex = Math.min(nextPage * splitPageSize + columnOffset, splitOrder.length - 1);
  return splitOrder[nextIndex];
}
