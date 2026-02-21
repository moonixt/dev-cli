import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { executeDevCli } from "./cli-exec";
import { LogStore } from "./log-store";

const server = new McpServer({
  name: "lemarsyn-logs",
  version: "0.1.0"
});

server.tool(
  "logs_list_services",
  "List all available log services",
  {},
  async () => formatToolResult(new LogStore().listServices())
);

server.tool(
  "logs_list_files",
  "List JSONL log files for a service",
  {
    service: z.string().min(1)
  },
  async ({ service }) => formatToolResult(new LogStore().listFiles(service))
);

server.tool(
  "logs_tail",
  "Return last N log entries for a service (optionally from a specific day)",
  {
    service: z.string().min(1),
    lines: z.number().int().positive().optional(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional()
  },
  async ({ service, lines, day }) => formatToolResult(new LogStore().tail(service, lines ?? 200, day))
);

server.tool(
  "logs_search",
  "Search entries in service logs by plain text or regex",
  {
    service: z.string().min(1),
    query: z.string(),
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    limit: z.number().int().positive().optional(),
    regex: z.boolean().optional()
  },
  async ({ service, query, day, limit, regex }) => formatToolResult(new LogStore().search(service, query, limit ?? 200, day, regex))
);

server.tool(
  "logs_errors",
  "Get error-level entries for one service or all services in a time window",
  {
    service: z.string().min(1).optional(),
    since_minutes: z.number().int().positive().optional(),
    limit: z.number().int().positive().optional()
  },
  async ({ service, since_minutes, limit }) => formatToolResult(new LogStore().errors(service, since_minutes ?? 60, limit ?? 200))
);

server.tool(
  "cli_exec",
  "Execute dev-cli with full argument passthrough. Example: [\"start\",\"api\"], [\"db\",\"reset\",...]",
  {
    args: z.array(z.string()).min(1),
    timeout_ms: z.number().int().positive().optional()
  },
  async ({ args, timeout_ms }) => formatToolResult(await executeDevCli(args, timeout_ms))
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

function formatToolResult(payload: unknown): { content: Array<{ type: "text"; text: string }>; structuredContent: unknown } {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload
  };
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[lemarsyn-logs] fatal: ${message}\n`);
  process.exit(1);
});
