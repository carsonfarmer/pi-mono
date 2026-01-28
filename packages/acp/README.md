# acp-pi

ACP server and CLI for the pi coding agent. This package exposes pi over the Agent Client Protocol (ACP) using NDJSON over stdio.

## Installation

```bash
npm install -g @mariozechner/pi-acp
```

This installs the `acp-pi` CLI.

## Usage

```bash
acp-pi
acp-pi --provider anthropic --model claude-sonnet-4-5
```

Notes:
- `--cwd` is optional. ACP clients should send an absolute `cwd` in `newSession`; otherwise the server defaults to the process working directory.
- The ACP server uses the same config directory as `@mariozechner/pi-coding-agent` (`~/.pi/agent` by default).
- Override the config directory with `PI_CODING_AGENT_DIR`.

## Zed Integration

Zed can run `acp-pi` as a custom ACP agent. Add an entry to Zed's `settings.json`:

```json
{
  "agent_servers": {
    "Pi CLI": {
      "type": "custom",
      "command": "acp-pi",
      "args": [],
      "env": {
        "PROVIDER_API_KEY": "your-key-here"
      }
    }
  }
}
```

Then open the Agent Panel in Zed and start a new thread for `Pi CLI`.

## By itself (NDJSON)

You can talk to the server directly over stdin/stdout:

```bash
acp-pi
```

Paste this into the terminal and press Enter:

```json
{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":1}}
```

You should see a response like:

```json
{"jsonrpc":"2.0","id":0,"result":{"protocolVersion":1,"agentCapabilities":{"loadSession":true,"promptCapabilities":{"embeddedContext":true,"image":true},"sessionCapabilities":{"list":{},"resume":{},"fork":{}}},"agentInfo":{"name":"pi","version":"0.48.0"}}}
```

Then send `newSession` and `prompt` requests with the returned `sessionId`.

## Documentation

See [docs/acp.md](docs/acp.md) for protocol details, session lifecycle, and examples.

## Programmatic

```ts
import { startAcpServer } from "@mariozechner/pi-acp";

await startAcpServer({ cwd: "/path/to/project" });
```
