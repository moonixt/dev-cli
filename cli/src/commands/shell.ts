import readline from "node:readline";
import { Command } from "commander";
import { runDbReset } from "./db/reset";
import { assertPathsExist, getServiceConfig } from "../services/service-config";
import { shellCommandNames } from "../shell/commands";
import { filterShellCommands, printShellHelp, renderLiveShell, renderShellHome } from "../shell/render";
import {
  clearLogs,
  createShellState,
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
import { normalizeTarget } from "../utils/target";

export function registerShellCommand(program: Command): void {
  program
    .command("shell", { isDefault: true })
    .alias("ui")
    .description("Interactive terminal UI with slash commands")
    .option("--dotnet <command>", "Override dotnet executable", "dotnet")
    .option("--python <command>", "Override python executable", "python")
    .action(async (options: StartCommandOptions) => {
      const services = getServiceConfig(options.dotnet, options.python);
      assertPathsExist(services);
      process.exitCode = await runShell(services);
    });
}

async function runShell(services: Record<ServiceName, ServiceConfig>): Promise<number> {
  const shellState = createShellState();
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

      stopAllRunning(shellState);

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
          setSplitLogFocus(shellState, "api");
          return true;
        }
        if (str === "]") {
          setSplitLogFocus(shellState, "sasa");
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
      stopAllRunning(shellState);
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
      stopAllRunning(shellState);
      resolve(lastExitCode);
    });
  });
}

function shellCompleter(input: string): [string[], string] {
  const trimmed = input.trim();
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
      setShellMessage(shellState, "Use /start, /stop, /logs, /status, /clear, /db reset, /exit");
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
    setShellMessage(shellState, "log view set to all");
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/logs off") {
    setLogView(shellState, "off");
    setShellMessage(shellState, "logs hidden");
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/logs all" || input === "/logs api" || input === "/logs sasa") {
    const view = (input.split(/\s+/)[1] ?? "all") as "all" | "api" | "sasa";
    setLogView(shellState, view);
    setShellMessage(shellState, `log view set to ${view}`);
    return { continueShell: true, exitCode: 0 };
  }

  if (input === "/exit" || input === "/quit" || input === "exit" || input === "quit") {
    return { continueShell: false, exitCode: 0 };
  }

  const normalized = input.startsWith("/") ? input : `/${input}`;
  if (normalized.startsWith("/start") || normalized.startsWith("/run")) {
    const parts = normalized.split(/\s+/).filter(Boolean);
    const target = normalizeTarget(parts[1] ?? "all");
    return { continueShell: true, exitCode: startBackground(target, services, shellState) };
  }

  if (normalized === "/db reset") {
    const exitCode = await runDbReset({});
    setShellMessage(shellState, exitCode === 0 ? "queryreset executed successfully" : "queryreset failed");
    return { continueShell: true, exitCode };
  }

  if (normalized.startsWith("/stop")) {
    const parts = normalized.split(/\s+/).filter(Boolean);
    const target = normalizeTarget(parts[1] ?? "all");
    return { continueShell: true, exitCode: stopBackground(target, shellState) };
  }

  writeShellOutput(shellState, `Unknown command: ${input}`);
  return { continueShell: true, exitCode: 1 };
}
