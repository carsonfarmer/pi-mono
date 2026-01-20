import chalk from "chalk";
import { startAcpServer } from "../acp/server.js";
import { APP_NAME } from "../config.js";
import { runMigrations } from "../migrations.js";

export interface AcpArgs {
	cwd?: string;
	provider?: string;
	model?: string;
	help?: boolean;
}

export function parseAcpArgs(args: string[]): AcpArgs {
	const parsed: AcpArgs = {};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--help" || arg === "-h") {
			parsed.help = true;
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

export function printAcpHelp(): void {
	console.log(
		`${chalk.bold(APP_NAME)} --acp - Agent Client Protocol server\n\n${chalk.bold("Usage:")}\n  ${APP_NAME} --acp [options]\n\n${chalk.bold("Options:")}\n  --cwd <path>         Working directory for new sessions\n  --provider <name>    Default provider override\n  --model <id>         Default model override\n  --help, -h           Show this help\n\n${chalk.bold("Examples:")}\n  ${APP_NAME} --acp\n  ${APP_NAME} --acp --cwd /path/to/project\n  ${APP_NAME} --acp --provider anthropic --model claude-sonnet-4-5\n`,
	);
}

export async function runAcp(args: string[]): Promise<void> {
	const parsed = parseAcpArgs(args);
	if (parsed.help) {
		printAcpHelp();
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
