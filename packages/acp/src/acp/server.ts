import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { AgentSideConnection, ndJsonStream } from "@agentclientprotocol/sdk";
import { APP_NAME, discoverAuthStorage, discoverModels, getAgentDir } from "@mariozechner/pi-coding-agent";
import { ACPAgent } from "./agent.js";
import { ACPSessionManager } from "./session.js";
import type { ACPConfig } from "./types.js";

export interface ACPServerOptions {
	cwd?: string;
	provider?: string;
	model?: string;
}

export async function startAcpServer(options: ACPServerOptions = {}): Promise<void> {
	const agentDir = getAgentDir();
	const authStorage = discoverAuthStorage(agentDir);
	const modelRegistry = discoverModels(authStorage, agentDir);

	const sessionDir = join(agentDir, "sessions", "acp");
	mkdirSync(sessionDir, { recursive: true });

	const config: ACPConfig = {
		agentDir,
		sessionDir,
		authStorage,
		modelRegistry,
		defaultCwd: options.cwd ?? process.cwd(),
	};

	const defaultModel =
		options.provider && options.model ? modelRegistry.find(options.provider, options.model) : undefined;
	if (options.provider && options.model && !defaultModel) {
		throw new Error(`Model not found: ${options.provider}/${options.model}`);
	}

	const stdoutWrite = process.stdout.write.bind(process.stdout);
	const stderrWrite = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding, cb?: (err?: Error | null) => void) =>
		stderrWrite(chunk, encoding, cb)) as typeof process.stdout.write;

	const acpOutput = new Writable({
		write(chunk, _encoding, callback) {
			stdoutWrite(chunk);
			callback();
		},
	});

	try {
		const sessionManager = new ACPSessionManager(config, defaultModel);
		const stream = ndJsonStream(Writable.toWeb(acpOutput), Readable.toWeb(process.stdin));
		const connection = new AgentSideConnection((conn) => new ACPAgent(conn, config, sessionManager), stream);

		if (process.stdin.isTTY) {
			process.stderr.write(`${APP_NAME} acp is running (stdio)\n`);
		}
		await connection.closed;
	} finally {
		process.stdout.write = stdoutWrite;
	}
}
