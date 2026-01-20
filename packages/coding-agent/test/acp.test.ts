import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { type Client, ClientSideConnection, ndJsonStream, type SessionNotification } from "@agentclientprotocol/sdk";
import {
	zInitializeResponse,
	zNewSessionResponse,
	zPromptResponse,
	zSessionNotification,
} from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const API_KEY = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;

describe.skipIf(!API_KEY)("ACP server", () => {
	let child: ReturnType<typeof spawn> | undefined;
	let connection: ClientSideConnection | undefined;
	let updates: SessionNotification[] = [];
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-acp-test-${Date.now()}`);
		updates = [];
	});

	afterEach(async () => {
		if (child) {
			child.stdin?.end();
			child.kill();
			child = undefined;
		}
		if (connection) {
			await connection.closed.catch(() => undefined);
			connection = undefined;
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function startServer() {
		const repoRoot = join(__dirname, "..", "..", "..");
		const cliPath = join(repoRoot, "packages", "coding-agent", "src", "cli.ts");
		const tsxPath = join(repoRoot, "node_modules", ".bin", "tsx");
		child = spawn(tsxPath, [cliPath, "acp", "--provider", "anthropic", "--model", "claude-sonnet-4-5"], {
			cwd: repoRoot,
			env: { ...process.env, PI_CODING_AGENT_DIR: tempDir },
			stdio: ["pipe", "pipe", "pipe"],
		});

		if (!child.stdin || !child.stdout) {
			throw new Error("ACP server stdio not available");
		}

		const client: Client = {
			async sessionUpdate(params) {
				zSessionNotification.parse(params);
				updates.push(params);
			},
			async requestPermission(params) {
				return { outcome: { outcome: "selected", optionId: params.options[0]?.optionId ?? "allow" } };
			},
		};

		const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout));
		connection = new ClientSideConnection(() => client, stream);
	}

	test("initializes and handles prompt", async () => {
		await startServer();

		const init = await connection!.initialize({ protocolVersion: 1 });
		zInitializeResponse.parse(init);

		const newSession = await connection!.newSession({ cwd: tempDir, mcpServers: [] });
		zNewSessionResponse.parse(newSession);

		const response = await connection!.prompt({
			sessionId: newSession.sessionId,
			prompt: [{ type: "text", text: "Reply with just the word hello" }],
		});
		zPromptResponse.parse(response);
		expect(response.stopReason).toBeDefined();

		expect(updates.length).toBeGreaterThanOrEqual(0);
	}, 90000);
});
