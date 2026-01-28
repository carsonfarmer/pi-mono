import { RequestError } from "@agentclientprotocol/sdk";
import type { Model } from "@mariozechner/pi-ai";
import {
	createAgentSession,
	createEventBus,
	type SessionInfo,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";
import type { ACPConfig, ACPModeId, ACPSessionState } from "./types.js";

const DEFAULT_MODE_ID: ACPModeId = "code";

export class ACPSessionManager {
	private sessions = new Map<string, ACPSessionState>();
	private config: ACPConfig;
	private defaultModel?: Model<any>;

	constructor(config: ACPConfig, defaultModel?: Model<any>) {
		this.config = config;
		this.defaultModel = defaultModel;
	}

	async create(cwd: string): Promise<ACPSessionState> {
		const sessionManager = SessionManager.create(cwd, this.config.sessionDir);
		const settingsManager = SettingsManager.create(cwd, this.config.agentDir);
		const eventBus = createEventBus();
		const { session } = await createAgentSession({
			cwd,
			authStorage: this.config.authStorage,
			modelRegistry: this.config.modelRegistry,
			settingsManager,
			sessionManager,
			eventBus,
			model: this.defaultModel,
		});

		const state: ACPSessionState = {
			session,
			sessionManager,
			cwd,
			createdAt: new Date(),
			assistantDeltaSeen: false,
			modeId: DEFAULT_MODE_ID,
		};

		this.sessions.set(session.sessionId, state);
		return state;
	}

	async load(sessionId: string, cwd: string): Promise<ACPSessionState> {
		const sessionPath = await this.findSessionPath(sessionId, cwd);
		if (!sessionPath) {
			throw RequestError.resourceNotFound(sessionId);
		}

		const sessionManager = SessionManager.open(sessionPath, this.config.sessionDir);
		const settingsManager = SettingsManager.create(cwd, this.config.agentDir);
		const eventBus = createEventBus();
		const { session } = await createAgentSession({
			cwd,
			authStorage: this.config.authStorage,
			modelRegistry: this.config.modelRegistry,
			settingsManager,
			sessionManager,
			eventBus,
		});

		const state: ACPSessionState = {
			session,
			sessionManager,
			cwd,
			createdAt: new Date(),
			assistantDeltaSeen: false,
			modeId: DEFAULT_MODE_ID,
		};

		this.sessions.set(session.sessionId, state);
		return state;
	}

	async resume(sessionId: string, cwd: string): Promise<ACPSessionState> {
		return this.load(sessionId, cwd);
	}

	async fork(sessionId: string, cwd: string): Promise<ACPSessionState> {
		const sessionPath = await this.findSessionPath(sessionId, cwd);
		if (!sessionPath) {
			throw RequestError.resourceNotFound(sessionId);
		}

		const sessionManager = SessionManager.forkFrom(sessionPath, cwd, this.config.sessionDir);
		const settingsManager = SettingsManager.create(cwd, this.config.agentDir);
		const eventBus = createEventBus();
		const { session } = await createAgentSession({
			cwd,
			authStorage: this.config.authStorage,
			modelRegistry: this.config.modelRegistry,
			settingsManager,
			sessionManager,
			eventBus,
		});

		const state: ACPSessionState = {
			session,
			sessionManager,
			cwd,
			createdAt: new Date(),
			assistantDeltaSeen: false,
			modeId: DEFAULT_MODE_ID,
		};

		this.sessions.set(session.sessionId, state);
		return state;
	}

	async list(cwd?: string): Promise<SessionInfo[]> {
		const listCwd = cwd ?? this.config.defaultCwd;
		const sessions = await SessionManager.list(listCwd, this.config.sessionDir);
		if (!cwd) return sessions;
		return sessions.filter((session) => session.cwd === cwd);
	}

	get(sessionId: string): ACPSessionState {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw RequestError.invalidParams({ error: `Session not found: ${sessionId}` });
		}
		return session;
	}

	private async findSessionPath(sessionId: string, cwd: string): Promise<string | undefined> {
		const sessions = await SessionManager.list(cwd, this.config.sessionDir);
		return sessions.find((session) => session.id === sessionId)?.path;
	}
}
