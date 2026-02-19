import type { ChildProcess } from "node:child_process";

export type RunTarget = "api" | "sasa" | "frontend" | "waha" | "all";
export type ServiceName = "api" | "sasa" | "frontend" | "waha";

export type ServiceConfig = {
  command: string;
  args: string[];
  cwd: string;
  label: string;
  dockerContainerId?: string;
};

export type StartCommandOptions = {
  dotnet: string;
  python: string;
  npm: string;
  docker: string;
};

export type ShellCommand = {
  command: string;
  description: string;
};

export type LogView = "off" | "all" | ServiceName;

export type ServiceLogEntry = {
  service: ServiceName;
  stream: "stdout" | "stderr";
  line: string;
  timestamp: number;
};

export type BackgroundService = {
  child?: ChildProcess;
  pid: number;
  external?: boolean;
};

export type ShellState = {
  running: Map<ServiceName, BackgroundService>;
  logs: ServiceLogEntry[];
  logView: LogView;
  logScrollOffset: Record<ServiceName, number>;
  splitLogFocus: ServiceName;
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
