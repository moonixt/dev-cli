import type { ChildProcess } from "node:child_process";

export type ServiceId = string;
export type RunTarget = ServiceId | "all";

export type ServiceRuntimeConfig = {
  id: ServiceId;
  label: string;
  category: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  logEnabled: boolean;
  logRetentionDays: number;
};

export type WorkspaceServiceConfigFile = {
  id: string;
  label?: string;
  category?: string;
  cwd: string;
  start: {
    command: string;
    args?: string[];
  };
  env?: Record<string, string>;
  log?: {
    enabled?: boolean;
    retentionDays?: number;
  };
  health?: {
    kind?: string;
  };
};

export type WorkspaceConfigFile = {
  version: number;
  workspaceName?: string;
  services: WorkspaceServiceConfigFile[];
  groups?: Record<string, string[]>;
};

export type LoadedWorkspaceConfig = {
  configPath: string | null;
  workspaceRoot: string;
  workspaceName: string;
  services: Record<ServiceId, ServiceRuntimeConfig>;
  serviceOrder: ServiceId[];
  groups: Record<string, ServiceId[]>;
};

export type ShellCommandCategory = string;

export type ShellCommand = {
  category: ShellCommandCategory;
  command: string;
  description: string;
};

export type ShellCommandCatalog = {
  commands: ShellCommand[];
  commandNames: string[];
  categoryOrder: string[];
  categoryLabels: Record<string, string>;
};

export type LogView = "off" | "all" | ServiceId;

export type ServiceLogEntry = {
  service: ServiceId;
  stream: "stdout" | "stderr";
  line: string;
  timestamp: number;
  retentionDays?: number;
};

export type ServiceLogLevel = "info" | "warn" | "error";

export type PersistedLogEntry = {
  ts: string;
  service: ServiceId;
  stream: "stdout" | "stderr";
  level: ServiceLogLevel;
  msg: string;
};

export type BackgroundService = {
  child?: ChildProcess;
  pid: number;
  external?: boolean;
};

export type ShellState = {
  running: Map<ServiceId, BackgroundService>;
  logs: ServiceLogEntry[];
  logView: LogView;
  logScrollOffset: Map<ServiceId, number>;
  splitLogFocus: ServiceId | null;
  serviceOrder: ServiceId[];
  allTargets: ServiceId[];
  commandCatalog: ShellCommandCatalog;
  workspaceRoot: string;
  workspaceName: string;
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
