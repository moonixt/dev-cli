import type { ChildProcess } from "node:child_process";

export type RunTarget = "api" | "sasa" | "all";
export type ServiceName = "api" | "sasa";

export type ServiceConfig = {
  command: string;
  args: string[];
  cwd: string;
  label: string;
};

export type StartCommandOptions = {
  dotnet: string;
  python: string;
};

export type ShellCommand = {
  command: string;
  description: string;
};

export type LogView = "all" | ServiceName;

export type ServiceLogEntry = {
  service: ServiceName;
  stream: "stdout" | "stderr";
  line: string;
  timestamp: number;
};

export type BackgroundService = {
  child: ChildProcess;
  pid: number;
};

export type ShellState = {
  running: Map<ServiceName, BackgroundService>;
  logs: ServiceLogEntry[];
  logView: LogView;
  message: string;
  onChange?: () => void;
};

export type DbResetOptions = {
  server?: string;
  database?: string;
  user?: string;
  password?: string;
  trusted?: boolean;
  trustServerCertificate?: boolean;
};
