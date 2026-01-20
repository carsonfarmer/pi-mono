import type { McpServer } from "@agentclientprotocol/sdk";
import type { AgentSession } from "../core/agent-session.js";
import type { AuthStorage } from "../core/auth-storage.js";
import type { ModelRegistry } from "../core/model-registry.js";
import type { SessionInfo, SessionManager } from "../core/session-manager.js";
import type { SettingsManager } from "../core/settings-manager.js";

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
	mcpServers: McpServer[];
	createdAt: Date;
	modeId: ACPModeId;
	unsubscribe?: () => void;
	assistantDeltaSeen?: boolean;
}

export interface ACPSessionManagerApi {
	create(cwd: string, mcpServers: McpServer[]): Promise<ACPSessionState>;
	load(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ACPSessionState>;
	resume(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ACPSessionState>;
	fork(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ACPSessionState>;
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
