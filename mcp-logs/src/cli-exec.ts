import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { CliExecResult } from "./types";

const defaultTimeoutMs = 30_000;
const defaultOutputLimitBytes = 64 * 1024;

export async function executeDevCli(
  args: string[],
  timeoutMs?: number
): Promise<CliExecResult> {
  const safeTimeout = sanitizeTimeout(timeoutMs);
  const cliPath = resolveCliEntrypointPath();
  if (!fs.existsSync(cliPath)) {
    return {
      exit_code: 127,
      stdout: "",
      stderr: `dev-cli build not found at ${cliPath}. Run: cd tools/cli && npm run build`,
      truncated: false
    };
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: getRepoRoot(),
      env: process.env,
      windowsHide: true
    });

    const stdoutState = createOutputState(defaultOutputLimitBytes);
    const stderrState = createOutputState(defaultOutputLimitBytes);
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      finalize(124, true);
    }, safeTimeout);

    child.stdout?.on("data", (chunk: Buffer | string) => appendOutput(stdoutState, chunk));
    child.stderr?.on("data", (chunk: Buffer | string) => appendOutput(stderrState, chunk));
    child.on("error", (error) => {
      appendOutput(stderrState, error.message);
      finalize(1, false);
    });
    child.on("exit", (code, signal) => {
      if (signal && code === null) {
        finalize(1, false);
        return;
      }
      finalize(code ?? 1, false);
    });

    function finalize(exitCode: number, timedOut: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);

      const timedOutText = timedOut ? `\n[cli_exec] timed out after ${safeTimeout}ms` : "";
      resolve({
        exit_code: exitCode,
        stdout: `${stdoutState.value}${timedOutText}`.trim(),
        stderr: `${stderrState.value}${timedOutText}`.trim(),
        truncated: stdoutState.truncated || stderrState.truncated
      });
    }
  });
}

type OutputState = {
  value: string;
  bytes: number;
  truncated: boolean;
  limitBytes: number;
};

function createOutputState(limitBytes: number): OutputState {
  return {
    value: "",
    bytes: 0,
    truncated: false,
    limitBytes
  };
}

function appendOutput(state: OutputState, chunk: Buffer | string): void {
  const text = chunk.toString();
  const textBytes = Buffer.byteLength(text);
  const remaining = state.limitBytes - state.bytes;
  if (remaining <= 0) {
    state.truncated = true;
    return;
  }

  if (textBytes <= remaining) {
    state.value += text;
    state.bytes += textBytes;
    return;
  }

  state.value += sliceTextByBytes(text, remaining);
  state.bytes = state.limitBytes;
  state.truncated = true;
}

function sliceTextByBytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }

  let result = "";
  let used = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char);
    if (used + charBytes > maxBytes) {
      break;
    }
    result += char;
    used += charBytes;
  }

  return result;
}

function sanitizeTimeout(timeoutMs?: number): number {
  if (!Number.isFinite(timeoutMs)) {
    return defaultTimeoutMs;
  }
  const value = Math.floor(timeoutMs as number);
  return Math.min(Math.max(value, 1_000), 5 * 60_000);
}

function resolveCliEntrypointPath(): string {
  const explicitEntrypoint = process.env.DEV_CLI_ENTRYPOINT?.trim();
  if (explicitEntrypoint) {
    return path.resolve(explicitEntrypoint);
  }
  return path.join(getRepoRoot(), "tools", "cli", "dist", "cli.js");
}

function getRepoRoot(): string {
  const envRepoRoot = process.env.LEMARSYN_REPO_ROOT?.trim();
  if (envRepoRoot) {
    return path.resolve(envRepoRoot);
  }
  return path.resolve(__dirname, "..", "..", "..");
}
