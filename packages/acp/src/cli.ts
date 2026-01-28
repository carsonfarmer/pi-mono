#!/usr/bin/env node
import { APP_NAME, runMigrations, VERSION } from "@mariozechner/pi-coding-agent";
import chalk from "chalk";
import { startAcpServer } from "./acp/server.js";

const CLI_NAME = `${APP_NAME}-acp`;

interface AcpArgs {
	cwd?: string;
	provider?: string;
	model?: string;
	help?: boolean;
	version?: boolean;
}

function parseAcpArgs(args: string[]): AcpArgs {
	const parsed: AcpArgs = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
		} else if (arg === "--version" || arg === "-v") {
			parsed.version = true;
		} else if (arg === "--cwd" && i + 1 < args.length) {
			parsed.cwd = args[++i];
		} else if (arg === "--provider" && i + 1 < args.length) {
			parsed.provider = args[++i];
		} else if (arg === "--model" && i + 1 < args.length) {
			parsed.model = args[++i];
		}
	}

	return parsed;
}

function printHelp(): void {
	console.log(
		`${chalk.bold(CLI_NAME)} - Agent Client Protocol server for ${APP_NAME}\n\n${chalk.bold("Usage:")}\n  ${CLI_NAME} [options]\n\n${chalk.bold("Options:")}\n  --cwd <path>         Working directory for new sessions\n  --provider <name>    Default provider override\n  --model <id>         Default model override\n  --help, -h           Show this help\n  --version, -v        Show version\n\n${chalk.bold("Examples:")}\n  ${CLI_NAME}\n  ${CLI_NAME} --cwd /path/to/project\n  ${CLI_NAME} --provider anthropic --model claude-sonnet-4-5\n`,
	);
}

async function run(): Promise<void> {
	const parsed = parseAcpArgs(process.argv.slice(2));

	if (parsed.version) {
		console.log(VERSION);
		return;
	}

	if (parsed.help) {
		printHelp();
		return;
	}

	const originalLog = console.log;
	const originalInfo = console.info;
	const originalWarn = console.warn;
	console.log = (...messages) => console.error(...messages);
	console.info = (...messages) => console.error(...messages);
	console.warn = (...messages) => console.error(...messages);

	try {
		runMigrations(process.cwd());
		await startAcpServer({ cwd: parsed.cwd, provider: parsed.provider, model: parsed.model });
	} finally {
		console.log = originalLog;
		console.info = originalInfo;
		console.warn = originalWarn;
	}
}

run();
