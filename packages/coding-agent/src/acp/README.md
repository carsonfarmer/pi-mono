# ACP (Agent Client Protocol)

This module implements ACP server support for pi using the official `@agentclientprotocol/sdk` types and JSON-RPC transport.

## Architecture

- `agent.ts` - Implements the ACP `Agent` interface backed by `AgentSession`.
- `session.ts` - Maps ACP sessions to pi `SessionManager` + `AgentSession` instances.
- `server.ts` - JSON-RPC stdio wiring via `AgentSideConnection` + `ndJsonStream`.
- `types.ts` - Internal ACP state types.

## Usage

```bash
pi --acp
pi --acp --cwd /path/to/project
pi --acp --provider anthropic --model claude-sonnet-4-5
```

## Testing

```bash
npm run test -w @mariozechner/pi-coding-agent -- acp.test.ts
```
