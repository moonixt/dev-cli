import { spawn, type ChildProcess } from "node:child_process";
import { logPrefix } from "../config";

type RunCommandOptions = {
  silent?: boolean;
};

export function runCommand(command: string, args: string[], cwd: string, options?: RunCommandOptions): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      stdio: options?.silent ? "ignore" : "inherit",
      env: process.env,
      windowsHide: true
    });

    child.on("error", (error) => {
      console.error(`${logPrefix} failed to start ${command}: ${error.message}`);
      resolve(1);
    });

    child.on("exit", (code, signal) => {
      if (signal) {
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

export function terminateProcess(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid || child.killed) {
    return;
  }

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      stdio: "ignore",
      windowsHide: true
    });
    return;
  }

  child.kill("SIGTERM");
}
