# dev-cli

Modular CLI to run and observe local services from any stack (Node, Ruby, Python, .NET, etc.) using a project config file.

## Features

- Dynamic services from `dev-cli.config.json`
- Interactive TUI (`dev-cli shell`) with command categories
- Start/stop service processes and view live logs
- Daily JSONL logs per service with retention
- Custom error keyword highlighting

## Requirements

- Node.js 18+
- npm

## Install (Project)

```bash
cd tools/cli
npm install
npm run build
```

Run directly:

```bash
node dist/cli.js --help
```

## Install (Global)

```bash
cd tools/cli
npm install
npm run build
npm link
```

Verify:

```bash
dev-cli --help
```

## Initialize Config

In your target workspace:

```bash
dev-cli init
# or non-interactive defaults:
dev-cli init --yes
```

This creates `dev-cli.config.json`.

## Config Example

```json
{
  "version": 1,
  "workspaceName": "My Workspace",
  "services": [
    {
      "id": "web",
      "label": "WEB",
      "category": "apis",
      "cwd": ".",
      "start": {
        "command": "ruby",
        "args": ["main.rb"]
      },
      "env": {},
      "log": {
        "enabled": true,
        "retentionDays": 7
      },
      "health": {
        "kind": "none"
      }
    }
  ],
  "groups": {
    "all": ["web"]
  }
}
```

## Main Commands

```bash
dev-cli shell
dev-cli start all
dev-cli start <service-id>
dev-cli db reset
dev-cli keywords list
```

Inside shell:

- `/start <service-id>`
- `/stop <service-id>`
- `/logs <service-id>`
- `/logs all|off|clear`
- `/status`
- `/keywords ...`
- In split logs (`/logs all`): press `M` to maximize/minimize focused logs; use `[` and `]` to change pair/service.

## Config Discovery Order

1. `--config <path>`
2. `DEV_CLI_CONFIG`
3. Upward search from current directory (`dev-cli.config.json`)

If none is found, CLI starts with no services and shows an init hint.

## Logs

Default log root:

- `<workspace>/logs`

Files:

- `logs/services/<service-id>/<service-id>-YYYY-MM-DD.txt` (JSONL)
- `logs/dev-cli-services.txt` (legacy consolidated)

## Development

```bash
cd tools/cli
npm run build
npm test
```

## Publish only CLI (subtree)

If you want to publish only `tools/cli` to a separate public repo:

```bash
# from repository root
git subtree split --prefix tools/cli -b cli-only
git remote add cli-public <PUBLIC_REPO_URL>
git push cli-public cli-only:main
```

Or push subtree branch to current origin:

```bash
git subtree split --prefix tools/cli -b cli-only
git push origin cli-only
```

## Companion MCP Server

This CLI can be paired with the MCP log server in `tools/mcp-logs`.

- MCP docs: `../mcp-logs/README.md`
