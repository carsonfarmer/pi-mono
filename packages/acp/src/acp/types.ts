import type {
	AgentSession,
	AuthStorage,
	ModelRegistry,
	SessionInfo,
	SessionManager,
	SettingsManager,
} from "@mariozechner/pi-coding-agent";

export type ACPModeId = "code" | "read-only";

export type ACPSettingsManager = Pick<
	SettingsManager,
	"getCompactionEnabled" | "getBlockImages" | "setCompactionEnabled" | "setBlockImages"
>;

export interface ACPAgentSession {
	sessionId: AgentSession["sessionId"];
	messages: AgentSession["messages"];
	isStreaming: AgentSession["isStreaming"];
	prompt: AgentSession["prompt"];
	abort: AgentSession["abort"];
	subscribe: AgentSession["subscribe"];
	model: AgentSession["model"];
	thinkingLevel: AgentSession["thinkingLevel"];
	steeringMode: AgentSession["steeringMode"];
	followUpMode: AgentSession["followUpMode"];
	settingsManager: ACPSettingsManager;
	setModel: AgentSession["setModel"];
	setActiveToolsByName: AgentSession["setActiveToolsByName"];
	getAllTools: AgentSession["getAllTools"];
	getAvailableThinkingLevels: AgentSession["getAvailableThinkingLevels"];
	setThinkingLevel: AgentSession["setThinkingLevel"];
	setSteeringMode: AgentSession["setSteeringMode"];
	setFollowUpMode: AgentSession["setFollowUpMode"];
}

export interface ACPSessionState {
	session: ACPAgentSession;
	sessionManager: SessionManager;
	cwd: string;
	createdAt: Date;
	modeId: ACPModeId;
	unsubscribe?: () => void;
	assistantDeltaSeen?: boolean;
}

export interface ACPSessionManagerApi {
	create(cwd: string): Promise<ACPSessionState>;
	load(sessionId: string, cwd: string): Promise<ACPSessionState>;
	resume(sessionId: string, cwd: string): Promise<ACPSessionState>;
	fork(sessionId: string, cwd: string): Promise<ACPSessionState>;
	list(cwd?: string): Promise<SessionInfo[]>;
	get(sessionId: string): ACPSessionState;
}

export interface ACPConfig {
	agentDir: string;
	sessionDir: string;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	defaultCwd: string;
}
