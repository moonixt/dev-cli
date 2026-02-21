# mcp-logs

MCP server for log debugging and `dev-cli` command passthrough.

## Features

- List services found in `logs/services/*`
- Tail/search/error-query over JSONL logs
- Execute `dev-cli` commands via MCP (`cli_exec`)
- `stdio` transport for local Codex integration

## Requirements

- Node.js 18+
- Built `dev-cli` entrypoint

## Install

```bash
cd tools/mcp-logs
npm install
npm run build
```

## Run

```bash
cd tools/mcp-logs
npm start
```

## Environment Variables

- `LOG_ROOT`: defaults to `<repo>/logs/services`
- `LEMARSYN_REPO_ROOT`: defaults to auto-detected repo root
- `DEV_CLI_ENTRYPOINT`: defaults to `<repo>/tools/cli/dist/cli.js`

## Register in Codex

```bash
codex mcp add lemarsynLogs \
  --env LOG_ROOT=/path/to/project/logs/services \
  --env LEMARSYN_REPO_ROOT=/path/to/project \
  --env DEV_CLI_ENTRYPOINT=/path/to/project/tools/cli/dist/cli.js \
  -- node /path/to/project/tools/mcp-logs/dist/server.js
```

## Exposed MCP Tools

- `logs_list_services()`
- `logs_list_files(service)`
- `logs_tail(service, lines?, day?)`
- `logs_search(service, query, day?, limit?, regex?)`
- `logs_errors(service?, since_minutes?, limit?)`
- `cli_exec(args, timeout_ms?)`

`cli_exec` executes only `dev-cli` (not arbitrary shell).

## Standalone Publish (subtree)

```bash
# from repository root
git subtree split --prefix tools/mcp-logs -b mcp-only
git remote add mcp-public <PUBLIC_REPO_URL>
git push mcp-public mcp-only:main
```
