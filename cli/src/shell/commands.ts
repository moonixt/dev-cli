import type { ShellCommand } from "../types";

export const shellCommands: ShellCommand[] = [
  { command: "/start api", description: "start .NET API service" },
  { command: "/start sasa", description: "start Python SASA service" },
  { command: "/start frontend", description: "start frontend service" },
  { command: "/start waha", description: "start WAHA docker logs" },
  { command: "/start all", description: "start API, SASA, frontend and WAHA" },
  { command: "/db reset", description: "run docs/queryreset.txt on SQL Server" },
  { command: "/logs", description: "enable logs from all services" },
  { command: "/logs all", description: "show logs from all services" },
  { command: "/logs api", description: "show only API logs" },
  { command: "/logs sasa", description: "show only SASA logs" },
  { command: "/logs frontend", description: "show only frontend logs" },
  { command: "/logs waha", description: "show only WAHA logs" },
  { command: "/logs off", description: "hide live log panel" },
  { command: "/logs clear", description: "clear log buffer" },
  { command: "/stop api", description: "stop .NET API service" },
  { command: "/stop sasa", description: "stop Python SASA service" },
  { command: "/stop frontend", description: "stop frontend service" },
  { command: "/stop waha", description: "stop WAHA docker logs/container" },
  { command: "/stop all", description: "stop all services" },
  { command: "/status", description: "show running services" },
  { command: "/clear", description: "redraw the terminal UI" },
  { command: "/help", description: "show command list" },
  { command: "/exit", description: "close interactive UI" }
];

export const shellCommandNames = shellCommands.map((item) => item.command);
