import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ContentBlock, RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import { zSessionNotification } from "@agentclientprotocol/sdk/dist/schema/zod.gen.js";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Model, TextContent } from "@mariozechner/pi-ai";
import { describe, expect, test } from "vitest";
import { ACPAgent } from "../src/acp/agent.js";
import type { ACPSessionState } from "../src/acp/types.js";
import type { AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import type { SessionInfo } from "../src/core/session-manager.js";

class FakeConnection {
	updates: SessionNotification[] = [];

	async sessionUpdate(params: SessionNotification): Promise<void> {
		zSessionNotification.parse(params);
		this.updates.push(params);
	}
}

class FakeSettingsManager {
	private compactionEnabled = true;
	private blockImages = false;

	getCompactionEnabled(): boolean {
		return this.compactionEnabled;
	}

	setCompactionEnabled(enabled: boolean): void {
		this.compactionEnabled = enabled;
	}

	getBlockImages(): boolean {
		return this.blockImages;
	}

	setBlockImages(blocked: boolean): void {
		this.blockImages = blocked;
	}
}

class FakeAgentSession {
	sessionId: string;
	messages: AgentMessage[] = [];
	isStreaming = false;
	model: Model<any> | undefined;
	thinkingLevel: ACPSessionState["session"]["thinkingLevel"] = "off";
	steeringMode: ACPSessionState["session"]["steeringMode"] = "one-at-a-time";
	followUpMode: ACPSessionState["session"]["followUpMode"] = "one-at-a-time";
	settingsManager = new FakeSettingsManager();
	private listeners = new Set<(event: AgentSessionEvent) => void>();
	private abortCalled = false;
	private emitAssistantDelta = false;
	private allTools = [
		{ name: "read", description: "" },
		{ name: "bash", description: "" },
		{ name: "edit", description: "" },
		{ name: "write", description: "" },
		{ name: "grep", description: "" },
		{ name: "find", description: "" },
		{ name: "ls", description: "" },
	];
	private activeToolNames = new Set(this.allTools.map((tool) => tool.name));

	constructor(sessionId: string, model?: Model<any>) {
		this.sessionId = sessionId;
		this.model = model;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	setEmitAssistantDelta(value: boolean) {
		this.emitAssistantDelta = value;
	}

	async prompt(text: string): Promise<void> {
		const userMessage = createUserMessage(text);
		this.messages.push(userMessage);
		this.emit({ type: "message_end", message: userMessage });

		const assistantMessage = createAssistantMessage("hello");
		if (this.emitAssistantDelta) {
			this.emit({ type: "message_start", message: assistantMessage });
			this.emit({
				type: "message_update",
				message: assistantMessage,
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello", partial: assistantMessage },
			});
		}
		this.messages.push(assistantMessage);
		this.emit({ type: "message_end", message: assistantMessage });
	}

	async abort(): Promise<void> {
		this.abortCalled = true;
	}

	async setModel(model: Model<any>): Promise<void> {
		this.model = model;
	}

	setActiveToolsByName(toolNames: string[]): void {
		this.activeToolNames = new Set(toolNames);
	}

	getAllTools(): Array<{ name: string; description: string }> {
		return this.allTools;
	}

	getActiveToolNames(): string[] {
		return [...this.activeToolNames];
	}

	getAvailableThinkingLevels(): ACPSessionState["session"]["thinkingLevel"][] {
		return ["off", "minimal", "low", "medium", "high"];
	}

	setThinkingLevel(level: ACPSessionState["session"]["thinkingLevel"]): void {
		this.thinkingLevel = level;
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.steeringMode = mode;
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.followUpMode = mode;
	}

	wasAbortCalled(): boolean {
		return this.abortCalled;
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

class FakeSessionManager {
	state: ACPSessionState;
	created = false;
	loaded = false;
	resumed = false;
	forked = false;
	lastCwd?: string;
	lastMcp?: unknown;
	listSessions: SessionInfo[] = [];

	constructor(state: ACPSessionState) {
		this.state = state;
	}

	async create(cwd: string, mcpServers: unknown[]): Promise<ACPSessionState> {
		this.created = true;
		this.lastCwd = cwd;
		this.lastMcp = mcpServers;
		return this.state;
	}

	async load(_sessionId: string, cwd: string, mcpServers: unknown[]): Promise<ACPSessionState> {
		this.loaded = true;
		this.lastCwd = cwd;
		this.lastMcp = mcpServers;
		return this.state;
	}

	async resume(_sessionId: string, cwd: string, mcpServers: unknown[]): Promise<ACPSessionState> {
		this.resumed = true;
		this.lastCwd = cwd;
		this.lastMcp = mcpServers;
		return this.state;
	}

	async fork(_sessionId: string, cwd: string, mcpServers: unknown[]): Promise<ACPSessionState> {
		this.forked = true;
		this.lastCwd = cwd;
		this.lastMcp = mcpServers;
		return this.state;
	}

	async list(_cwd?: string): Promise<SessionInfo[]> {
		return this.listSessions;
	}

	get(sessionId: string): ACPSessionState {
		if (sessionId !== this.state.session.sessionId) {
			throw RequestError.invalidParams({ error: "unknown session" });
		}
		return this.state;
	}
}

const modelStub = buildModel("anthropic", "claude-sonnet-4-5", "Claude Sonnet 4.5");
const authStorage = new AuthStorage(join(tmpdir(), "pi-test-auth.json"));

class FakeModelRegistry extends ModelRegistry {
	constructor() {
		super(authStorage, join(tmpdir(), "pi-test-models.json"));
	}

	override getAvailable() {
		return [modelStub];
	}

	override find(provider: string, modelId: string) {
		if (provider === modelStub.provider && modelId === modelStub.id) {
			return modelStub;
		}
		return undefined;
	}
}

const fakeModelRegistry = new FakeModelRegistry();

describe("ACPAgent", () => {
	test("initialize advertises capabilities", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-1", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		const response = await agent.initialize({ protocolVersion: 1 });
		expect(response.protocolVersion).toBe(1);
		expect(response.agentCapabilities?.loadSession).toBe(true);
		expect(response.agentCapabilities?.sessionCapabilities?.list).toBeDefined();
		expect(response.agentCapabilities?.sessionCapabilities?.resume).toBeDefined();
		expect(response.agentCapabilities?.sessionCapabilities?.fork).toBeDefined();
		expect(response.agentCapabilities?.promptCapabilities?.embeddedContext).toBe(true);
		expect(response.agentCapabilities?.promptCapabilities?.image).toBe(true);
	});

	test("newSession wires subscriptions and returns sessionId", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-2", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		const response = await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		expect(response.sessionId).toBe("session-2");
		expect(manager.created).toBe(true);

		session.emit({
			type: "tool_execution_start",
			toolCallId: "tool-1",
			toolName: "read",
			args: { path: "/tmp/file.txt" },
		});
		expect(connection.updates.some((update) => update.update.sessionUpdate === "tool_call")).toBe(true);
	});

	test("prompt sends user and assistant updates", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-3", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		await agent.prompt({
			sessionId: "session-3",
			prompt: [{ type: "text", text: "Hello" }],
		});

		const updateTypes = connection.updates.map((update) => update.update.sessionUpdate);
		expect(updateTypes).toContain("agent_message_chunk");
	});

	test("prompt forwards embedded resources", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-4", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		const promptBlocks: ContentBlock[] = [
			{ type: "text", text: "Check context" },
			{ type: "resource", resource: { uri: "file:///tmp/info.txt", text: "hello" } },
		];

		await agent.prompt({ sessionId: "session-4", prompt: promptBlocks });
		const updateTypes = connection.updates.map((update) => update.update.sessionUpdate);
		expect(updateTypes).toContain("agent_message_chunk");
	});

	test("cancel aborts session", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-5", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		await agent.cancel({ sessionId: "session-5" });
		expect(session.wasAbortCalled()).toBe(true);
	});

	test("tool updates map to ACP tool_call_update", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-6", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		session.emit({
			type: "tool_execution_update",
			toolCallId: "tool-2",
			toolName: "edit",
			args: { path: "/tmp/file.txt" },
			partialResult: { content: [{ type: "text", text: "working" }], details: {} },
		});
		session.emit({
			type: "tool_execution_end",
			toolCallId: "tool-2",
			toolName: "edit",
			result: { content: [{ type: "text", text: "done" }], details: {} },
			isError: false,
		});

		const updateTypes = connection.updates.map((update) => update.update.sessionUpdate);
		expect(updateTypes).toContain("tool_call_update");
	});

	test("setSessionMode updates tool selection", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-7", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		await agent.setSessionMode({ sessionId: "session-7", modeId: "read-only" });
		const updateTypes = connection.updates.map((update) => update.update.sessionUpdate);
		expect(updateTypes).toContain("current_mode_update");
		expect(session.getActiveToolNames()).not.toContain("edit");
		expect(session.getActiveToolNames()).not.toContain("write");
	});

	test("setSessionConfigOption updates config options", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-8", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		await agent.unstable_setSessionConfigOption({
			sessionId: "session-8",
			configId: "thinking_level",
			value: "minimal",
		});

		const updateTypes = connection.updates.map((update) => update.update.sessionUpdate);
		expect(updateTypes).toContain("config_option_update");
		expect(session.thinkingLevel).toBe("minimal");
	});

	test("setSessionModel changes current model", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-9");
		const manager = new FakeSessionManager(buildSessionState(session));
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		await agent.newSession({ cwd: "/tmp", mcpServers: [] });
		await agent.unstable_setSessionModel({
			sessionId: "session-9",
			modelId: `${modelStub.provider}/${modelStub.id}`,
		});
		expect(session.model).toBe(modelStub);
	});

	test("listSessions maps session info", async () => {
		const connection = new FakeConnection();
		const session = new FakeAgentSession("session-10", modelStub);
		const manager = new FakeSessionManager(buildSessionState(session));
		manager.listSessions = [
			{
				path: "/tmp/session.jsonl",
				id: "session-10",
				cwd: "/tmp",
				name: "Test session",
				created: new Date("2024-01-01T00:00:00Z"),
				modified: new Date("2024-01-02T00:00:00Z"),
				messageCount: 1,
				firstMessage: "Hello",
				allMessagesText: "Hello",
			},
		];
		const agent = new ACPAgent(
			connection,
			{
				agentDir: "",
				sessionDir: "",
				authStorage,
				modelRegistry: fakeModelRegistry,
				defaultCwd: "/tmp",
			},
			manager,
		);

		const response = await agent.unstable_listSessions({});
		expect(response.sessions).toHaveLength(1);
		expect(response.sessions[0]?.sessionId).toBe("session-10");
		expect(response.sessions[0]?.title).toBe("Test session");
	});
});

function buildSessionState(session: FakeAgentSession): ACPSessionState {
	return {
		session,
		sessionManager: {} as ACPSessionState["sessionManager"],
		cwd: "/tmp",
		mcpServers: [],
		createdAt: new Date(),
		assistantDeltaSeen: false,
		modeId: "code",
	};
}

function createUserMessage(text: string): AgentMessage {
	const content: TextContent[] = [{ type: "text", text }];
	return { role: "user", content, timestamp: Date.now() };
}

function createAssistantMessage(text: string): AssistantMessage {
	const content: TextContent[] = [{ type: "text", text }];
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function buildModel(provider: string, id: string, name: string): Model<any> {
	return {
		id,
		name,
		api: "anthropic-messages",
		provider,
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 1000,
	};
}
