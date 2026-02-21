# Dev Tools (Standalone)

This folder contains standalone developer tools:

- `cli/`: modular runtime CLI
- `mcp-logs/`: MCP server for log reading + `dev-cli` passthrough

## Quick Setup

```bash
cd tools/cli
npm install
npm run build
npm link

cd ../mcp-logs
npm install
npm run build
```

## Run

```bash
dev-cli shell
cd tools/mcp-logs && npm start
```

## Publish both as standalone (tools subtree)

```bash
# from repository root
git subtree split --prefix tools -b tools-standalone
git remote add tools-public <PUBLIC_REPO_URL>
git push tools-public tools-standalone:main
```
