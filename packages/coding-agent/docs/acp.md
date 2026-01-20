# ACP Mode

ACP mode exposes pi over the Agent Client Protocol (ACP) using NDJSON over stdin/stdout. Use this to integrate pi with ACP-compliant clients (for example, editors or custom UIs) without the interactive TUI.

This document describes the ACP surface pi implements, the session lifecycle, events, and current limitations. For ACP schema details, use the official SDK types and Zod validators from `@agentclientprotocol/sdk`.

## Prerequisites

- `pi` built or runnable via `tsx`
- A configured model provider (for example `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN`)

## Starting ACP Mode

```bash
pi acp --cwd /path/to/project --provider anthropic --model claude-sonnet-4-5
```

Notes:
- ACP mode is headless and communicates only via stdin/stdout.
- Any non-ACP output is redirected to stderr.
- `--cwd` must be an absolute path.

## Protocol Overview

- **Transport**: NDJSON over stdin/stdout using the ACP SDK stream helpers.
- **Protocol version**: `1`.
- **Request/response model**: ACP RPC methods over the `Agent` interface.
- **Session updates**: streamed through `sessionUpdate` notifications.

### Supported Capabilities

ACP `initialize` returns:
- `agentCapabilities.loadSession = true`
- `agentCapabilities.promptCapabilities.embeddedContext = true`
- `agentCapabilities.promptCapabilities.image = true`
- `agentCapabilities.sessionCapabilities.list`, `resume`, `fork`

## Sessions

pi implements ACP session lifecycle methods:
- `newSession`
- `loadSession`
- `unstable_resumeSession`
- `unstable_forkSession`
- `unstable_listSessions`

Session IDs map to pi session files stored under `~/.pi/agent/sessions/acp`. Loading or forking a session replays historical user/assistant messages as ACP `sessionUpdate` events.

### Session Models

ACP models are exposed as `provider/model` identifiers. For example: `anthropic/claude-sonnet-4-5`.

- `initialize` returns a model list in `SessionModelState`.
- `unstable_setSessionModel` accepts a `modelId` in `provider/model` format.

If the model is not available or does not have valid credentials, the request fails with an ACP `invalidParams` error.

## Prompting

`prompt` accepts ACP `ContentBlock[]` and converts it into a pi prompt:
- `text` blocks are concatenated in order.
- `image` blocks with inline data are sent as image attachments.
- `resource_link` and `resource` blocks are converted to text with a `Resource:` prefix.

The prompt request fails if the session is already streaming.

### Prompt Response

pi maps internal stop reasons to ACP `PromptResponse.stopReason`:
- `stop` and `toolUse` → `end_turn`
- `length` → `max_tokens`
- `aborted` → `cancelled`
- `error` → `refusal`

## Modes (Tool Access)

ACP modes map to pi tool sets:

| Mode | Description | Tools |
| --- | --- | --- |
| `code` | Full read/write | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` (as configured) |
| `read-only` | Read/search only | Same as `code`, minus `edit`/`write` |

Use `setSessionMode` to switch modes. pi emits a `current_mode_update` session update when the mode changes.

## Config Options

ACP config options are exposed as select inputs via `configOptions`:

- `thinking_level`: available levels reported by the current model
- `steering_mode`: `one-at-a-time` or `all`
- `follow_up_mode`: `one-at-a-time` or `all`
- `auto_compaction`: `enabled` or `disabled`
- `block_images`: `allow` or `block`

Use `unstable_setSessionConfigOption` to update an option. pi responds with updated `configOptions` and emits a `config_option_update` session update.

## Session Updates (Events)

pi emits ACP session updates through `sessionUpdate` notifications. Key update types:

### Messaging
- `user_message_chunk`: user messages (from history replay)
- `agent_message_chunk`: assistant text chunks (streaming) and replayed messages
- `agent_thought_chunk`: assistant thinking chunks (when enabled)

### Tool Execution
- `tool_call`: tool call start (includes tool name, input, and locations when applicable)
- `tool_call_update`: tool call progress and completion
  - `status`: `pending`, `in_progress`, `completed`, or `failed`
  - `content`: streamed text/image output
  - `rawOutput`: final tool result
  - `diff` content is added for `edit`/`write` tool calls when a file path is available

### Session State
- `current_mode_update`: current mode changed
- `config_option_update`: config options changed

## Limitations

- ACP is stdio only; no HTTP transport is provided.
- Prompting is single-flight per session. A second `prompt` while streaming returns `invalidParams`.
- Resource blocks are flattened into text (no rich resource rendering).
- `resource_link` blocks are represented as text with a `Resource:` prefix.
- Tool locations are only reported for file-based tools with a `path` argument.

## Client Guidance

For ACP-compliant clients, use the official SDK to validate schema compliance and handle NDJSON transport.

Minimal initialization flow:
1. `initialize` with `protocolVersion: 1`
2. `newSession` (or `loadSession`/`resumeSession`)
3. `prompt` with `ContentBlock[]`
4. Consume `sessionUpdate` notifications for streaming text, tool activity, and state updates

### SDK Example (Node.js)

```js
import { ClientSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import {
  zInitializeResponse,
  zNewSessionResponse,
  zPromptResponse,
  zSessionNotification,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { Readable, Writable } from "node:stream";

const stream = ndJsonStream(
  Writable.toWeb(process.stdout),
  Readable.toWeb(process.stdin)
);

const client = {
  async sessionUpdate(params) {
    zSessionNotification.parse(params);
    if (params.update.sessionUpdate === "agent_message_chunk") {
      if (params.update.content.type === "text") {
        process.stderr.write(params.update.content.text);
      }
    }
  },
  async requestPermission(params) {
    return {
      outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow" },
    };
  },
};

const connection = new ClientSideConnection(() => client, stream);

zInitializeResponse.parse(await connection.initialize({ protocolVersion: 1 }));
const session = await connection.newSession({ cwd: process.cwd(), mcpServers: [] });
const sessionResult = zNewSessionResponse.parse(session);

const response = await connection.prompt({
  sessionId: sessionResult.sessionId,
  prompt: [{ type: "text", text: "Say hello" }],
});

zPromptResponse.parse(response);
process.stderr.write("\nDone\n");
```

## Troubleshooting

- **JSON parsing errors**: verify the server is running in ACP mode (`pi acp`) and not interactive TUI mode.
- **Model not found**: ensure the `provider/model` identifier exists and credentials are configured.
- **Session not found**: use `unstable_listSessions` to confirm available session IDs.
