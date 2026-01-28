# pi-acp

ACP server and CLI for the pi coding agent. This package exposes pi over the Agent Client Protocol (ACP) using NDJSON over stdio.

## Installation

```bash
npm install -g @mariozechner/pi-acp
```

## Usage

```bash
pi-acp
pi-acp --cwd /path/to/project
pi-acp --provider anthropic --model claude-sonnet-4-5
```

Notes:
- The ACP server uses the same config directory as `@mariozechner/pi-coding-agent` (`~/.pi/agent` by default).
- Override the config directory with `PI_CODING_AGENT_DIR`.

## Documentation

See [docs/acp.md](docs/acp.md) for protocol details, session lifecycle, and examples.

## Programmatic

```ts
import { startAcpServer } from "@mariozechner/pi-acp";

await startAcpServer({ cwd: "/path/to/project" });
```
