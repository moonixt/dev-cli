export type LogStream = "stdout" | "stderr";
export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  ts: string;
  service: string;
  stream: LogStream;
  level: LogLevel;
  msg: string;
};

export type LogsListServicesResult = {
  services: string[];
};

export type LogsListFilesResult = {
  service: string;
  files: string[];
};

export type LogsTailResult = {
  service: string;
  file: string | null;
  entries: LogEntry[];
};

export type LogsSearchResult = {
  service: string;
  query: string;
  entries: LogEntry[];
};

export type LogsErrorsResult = {
  service: string | "all";
  entries: LogEntry[];
};

export type CliExecResult = {
  exit_code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
};
