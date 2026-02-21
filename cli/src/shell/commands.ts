import type { ShellCommand, ShellCommandCategory } from "../types";

export const shellCategoryOrder: ShellCommandCategory[] = ["api", "logs", "database", "keywords", "system"];

export const shellCategoryLabels: Record<ShellCommandCategory, string> = {
  api: "APIs",
  logs: "Logs",
  database: "Database",
  keywords: "Keywords",
  system: "System"
};

export const shellCommands: ShellCommand[] = [
  { category: "api", command: "/start api", description: "start .NET API service" },
  { category: "api", command: "/start sasa", description: "start Python SASA service" },
  { category: "api", command: "/start frontend", description: "start frontend service" },
  { category: "api", command: "/start waha", description: "start WAHA docker logs" },
  { category: "api", command: "/start all", description: "start API, SASA, frontend and WAHA" },
  { category: "api", command: "/stop api", description: "stop .NET API service" },
  { category: "api", command: "/stop sasa", description: "stop Python SASA service" },
  { category: "api", command: "/stop frontend", description: "stop frontend service" },
  { category: "api", command: "/stop waha", description: "stop WAHA docker logs/container" },
  { category: "api", command: "/stop all", description: "stop all services" },
  { category: "api", command: "/status", description: "show running services" },
  { category: "logs", command: "/logs", description: "enable logs from all services" },
  { category: "logs", command: "/logs all", description: "show logs from all services" },
  { category: "logs", command: "/logs api", description: "show only API logs" },
  { category: "logs", command: "/logs sasa", description: "show only SASA logs" },
  { category: "logs", command: "/logs frontend", description: "show only frontend logs" },
  { category: "logs", command: "/logs waha", description: "show only WAHA logs" },
  { category: "logs", command: "/logs off", description: "hide live log panel" },
  { category: "logs", command: "/logs clear", description: "clear log buffer" },
  { category: "database", command: "/db reset", description: "run docs/queryreset.txt on SQL Server" },
  { category: "keywords", command: "/keywords list", description: "list active error keywords" },
  { category: "keywords", command: "/keywords add", description: "add one error keyword (or use /keywords <term>)" },
  { category: "keywords", command: "/keywords remove", description: "remove one error keyword" },
  { category: "keywords", command: "/keywords set", description: "replace all error keywords" },
  { category: "keywords", command: "/keywords reset", description: "reset error keywords to defaults" },
  { category: "system", command: "/clear", description: "redraw the terminal UI" },
  { category: "system", command: "/help", description: "show command list" },
  { category: "system", command: "/exit", description: "close interactive UI" }
];

export const shellCommandNames = shellCommands.map((item) => item.command);
