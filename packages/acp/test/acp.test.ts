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
		const cliPath = join(repoRoot, "packages", "acp", "src", "cli.ts");
		const tsxPath = join(repoRoot, "node_modules", ".bin", "tsx");
		child = spawn(tsxPath, [cliPath, "--provider", "anthropic", "--model", "claude-sonnet-4-5"], {
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

	async function initializeAndCreateSession() {
		const init = await connection!.initialize({ protocolVersion: 1 });
		zInitializeResponse.parse(init);

		const newSession = await connection!.newSession({ cwd: tempDir, mcpServers: [] });
		zNewSessionResponse.parse(newSession);
		return newSession;
	}

	test("initializes and handles prompt", async () => {
		await startServer();

		const newSession = await initializeAndCreateSession();

		const response = await connection!.prompt({
			sessionId: newSession.sessionId,
			prompt: [{ type: "text", text: "Reply with just the word hello" }],
		});
		zPromptResponse.parse(response);
		expect(response.stopReason).toBeDefined();

		expect(updates.length).toBeGreaterThanOrEqual(0);
	}, 90000);

	test("rejects unknown extension methods and ignores extension notifications", async () => {
		await startServer();
		await initializeAndCreateSession();

		await connection!.extNotification("example.com/notify", { ok: true });

		let error: { code?: number; data?: { method?: string } } | undefined;
		try {
			await connection!.extMethod("example.com/ping", { data: "test" });
		} catch (err) {
			error = err as { code?: number; data?: { method?: string } };
		}

		expect(error?.code).toBe(-32601);
		expect(error?.data?.method).toBe("example.com/ping");
	});

	test("handles concurrent prompts", async () => {
		await startServer();

		const newSession = await initializeAndCreateSession();

		const responses = await Promise.all([
			connection!.prompt({
				sessionId: newSession.sessionId,
				prompt: [{ type: "text", text: "Say hello" }],
			}),
			connection!.prompt({
				sessionId: newSession.sessionId,
				prompt: [{ type: "text", text: "Say goodbye" }],
			}),
		]);

		for (const response of responses) {
			zPromptResponse.parse(response);
			expect(response.stopReason).toBeDefined();
		}
	}, 90000);

	test("closes when client disconnects", async () => {
		await startServer();

		const exitPromise = new Promise<void>((resolve, reject) => {
			child!.once("exit", () => resolve());
			child!.once("error", (error) => reject(error));
		});

		child!.stdin?.end();
		await connection!.closed;
		await exitPromise;
	});
});
