import { isAbsolute } from "node:path";
import {
	type Agent as ACPAgentInterface,
	type AgentSideConnection,
	type AuthenticateRequest,
	type CancelNotification,
	type ContentBlock,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type ModelInfo,
	type NewSessionRequest,
	type NewSessionResponse,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SessionConfigSelectOption,
	type SessionMode,
	type SessionModelState,
	type SessionModeState,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModelRequest,
	type SetSessionModelResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type ToolCall,
	type ToolCallContent,
	type ToolCallUpdate,
	type ToolKind,
} from "@agentclientprotocol/sdk";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import { APP_NAME, VERSION } from "../config.js";
import type { AgentSessionEvent } from "../core/agent-session.js";
import type { ACPConfig, ACPModeId, ACPSessionManagerApi, ACPSessionState } from "./types.js";

const STOP_REASON_MAP: Record<string, PromptResponse["stopReason"]> = {
	stop: "end_turn",
	toolUse: "end_turn",
	length: "max_tokens",
	aborted: "cancelled",
	error: "refusal",
};

const CONFIG_OPTION_IDS = {
	thinkingLevel: "thinking_level",
	steeringMode: "steering_mode",
	followUpMode: "follow_up_mode",
	autoCompaction: "auto_compaction",
	blockImages: "block_images",
} as const;

type ConfigOptionId = (typeof CONFIG_OPTION_IDS)[keyof typeof CONFIG_OPTION_IDS];

const MODE_DEFINITIONS: Array<{ id: ACPModeId; name: string; description: string }> = [
	{ id: "code", name: "Code", description: "Full read/write coding tools." },
	{ id: "read-only", name: "Read-only", description: "Read/search tools only." },
];

export class ACPAgent implements ACPAgentInterface {
	private connection: Pick<AgentSideConnection, "sessionUpdate">;
	private config: ACPConfig;
	private sessionManager: ACPSessionManagerApi;
	private toolCallInputs = new Map<string, { toolName: string; args: Record<string, unknown> }>();

	constructor(
		connection: Pick<AgentSideConnection, "sessionUpdate">,
		config: ACPConfig,
		sessionManager: ACPSessionManagerApi,
	) {
		this.connection = connection;
		this.config = config;
		this.sessionManager = sessionManager;
	}

	async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
		const protocolVersion = 1;
		return {
			protocolVersion,
			agentCapabilities: {
				loadSession: true,
				promptCapabilities: {
					embeddedContext: true,
					image: true,
				},
				sessionCapabilities: {
					list: {},
					resume: {},
					fork: {},
				},
			},
			agentInfo: {
				name: APP_NAME,
				version: VERSION,
			},
		};
	}

	async authenticate(_params: AuthenticateRequest): Promise<void> {
		return;
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		const cwd = this.resolveCwd(params.cwd);
		const state = await this.sessionManager.create(cwd, params.mcpServers);
		this.setupSessionSubscriptions(state);
		const response = await this.buildSessionResponse(state);
		return { sessionId: state.session.sessionId, ...response };
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		const cwd = this.resolveCwd(params.cwd);
		const state = await this.sessionManager.load(params.sessionId, cwd, params.mcpServers);
		this.setupSessionSubscriptions(state);
		await this.replayHistory(state);
		return this.buildSessionResponse(state);
	}

	async unstable_resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		const cwd = this.resolveCwd(params.cwd);
		const state = await this.sessionManager.resume(params.sessionId, cwd, params.mcpServers ?? []);
		this.setupSessionSubscriptions(state);
		return this.buildSessionResponse(state);
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		const cwd = this.resolveCwd(params.cwd);
		const state = await this.sessionManager.fork(params.sessionId, cwd, params.mcpServers ?? []);
		this.setupSessionSubscriptions(state);
		await this.replayHistory(state);
		const response = await this.buildSessionResponse(state);
		return { sessionId: state.session.sessionId, ...response };
	}

	async unstable_listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		const cwd = params.cwd ?? undefined;
		if (cwd && !isAbsolute(cwd)) {
			throw RequestError.invalidParams({ error: "cwd must be an absolute path" });
		}
		const sessions = await this.sessionManager.list(cwd);
		return {
			sessions: sessions.map((session) => ({
				sessionId: session.id,
				cwd: session.cwd,
				title: session.name ?? session.firstMessage,
				updatedAt: session.modified.toISOString(),
			})),
		};
	}

	async unstable_setSessionModel(params: SetSessionModelRequest): Promise<SetSessionModelResponse> {
		const state = this.sessionManager.get(params.sessionId);
		const model = await this.resolveModel(params.modelId);
		await state.session.setModel(model);
		return {};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const state = this.sessionManager.get(params.sessionId);
		const modeId = this.normalizeModeId(params.modeId);
		const toolNames = this.resolveToolNamesForMode(state, modeId);
		state.session.setActiveToolsByName(toolNames);
		state.modeId = modeId;
		await this.connection.sessionUpdate({
			sessionId: state.session.sessionId,
			update: { sessionUpdate: "current_mode_update", currentModeId: state.modeId },
		});
		return {};
	}

	async unstable_setSessionConfigOption(
		params: SetSessionConfigOptionRequest,
	): Promise<SetSessionConfigOptionResponse> {
		const state = this.sessionManager.get(params.sessionId);
		this.applyConfigOption(state, params.configId as ConfigOptionId, params.value);
		const configOptions = this.buildConfigOptions(state);
		await this.connection.sessionUpdate({
			sessionId: state.session.sessionId,
			update: { sessionUpdate: "config_option_update", configOptions },
		});
		return { configOptions };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const state = this.sessionManager.get(params.sessionId);
		if (state.session.isStreaming) {
			throw RequestError.invalidParams({ error: "Session is busy" });
		}

		const { text, images } = promptToPi(params.prompt);
		state.assistantDeltaSeen = false;
		await state.session.prompt(text, { images });

		const lastAssistant = getLastAssistantMessage(state.session.messages);
		if (lastAssistant && !state.assistantDeltaSeen) {
			const updates = mapMessageToSessionUpdates(lastAssistant);
			for (const update of updates) {
				await this.connection.sessionUpdate({ sessionId: state.session.sessionId, update });
			}
			state.assistantDeltaSeen = updates.length > 0;
		}

		const stopReason = lastAssistant?.stopReason ? STOP_REASON_MAP[lastAssistant.stopReason] : "end_turn";

		return { stopReason };
	}

	async cancel(params: CancelNotification): Promise<void> {
		const state = this.sessionManager.get(params.sessionId);
		await state.session.abort();
	}

	private setupSessionSubscriptions(state: ACPSessionState): void {
		if (state.unsubscribe) return;
		state.unsubscribe = state.session.subscribe((event) => {
			this.handleSessionEvent(state, event).catch(() => undefined);
		});
	}

	private async buildSessionResponse(
		state: ACPSessionState,
	): Promise<Pick<NewSessionResponse, "models" | "modes" | "configOptions">> {
		return {
			models: await this.buildModelState(state),
			modes: this.buildModeState(state),
			configOptions: this.buildConfigOptions(state),
		};
	}

	private async buildModelState(state: ACPSessionState): Promise<SessionModelState | null> {
		const availableModels = await this.config.modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			return null;
		}
		const currentModelId = state.session.model ? toModelId(state.session.model) : toModelId(availableModels[0]);
		const modelInfos: ModelInfo[] = availableModels.map((model) => ({
			modelId: toModelId(model),
			name: model.name,
			description: `${model.provider}/${model.id}`,
		}));
		return { availableModels: modelInfos, currentModelId };
	}

	private buildModeState(state: ACPSessionState): SessionModeState | null {
		const availableModes: SessionMode[] = MODE_DEFINITIONS.map((mode) => ({
			id: mode.id,
			name: mode.name,
			description: mode.description,
		}));
		return { availableModes, currentModeId: state.modeId };
	}

	private buildConfigOptions(state: ACPSessionState): SessionConfigOption[] {
		const thinkingOptions: SessionConfigSelectOption[] = state.session
			.getAvailableThinkingLevels()
			.map((level) => ({ value: level, name: level }));
		const steeringOptions: SessionConfigSelectOption[] = [
			{ value: "one-at-a-time", name: "One at a time" },
			{ value: "all", name: "All" },
		];
		const followUpOptions: SessionConfigSelectOption[] = [
			{ value: "one-at-a-time", name: "One at a time" },
			{ value: "all", name: "All" },
		];
		const autoCompactionOptions: SessionConfigSelectOption[] = [
			{ value: "enabled", name: "Enabled" },
			{ value: "disabled", name: "Disabled" },
		];
		const blockImagesOptions: SessionConfigSelectOption[] = [
			{ value: "allow", name: "Allow" },
			{ value: "block", name: "Block" },
		];

		const thinkingLevel = state.session.thinkingLevel;
		const steeringMode = state.session.steeringMode;
		const followUpMode = state.session.followUpMode;
		const autoCompaction = state.session.settingsManager.getCompactionEnabled() ? "enabled" : "disabled";
		const blockImages = state.session.settingsManager.getBlockImages() ? "block" : "allow";

		return [
			{
				type: "select",
				id: CONFIG_OPTION_IDS.thinkingLevel,
				name: "Thinking level",
				category: "thought_level",
				currentValue: thinkingLevel,
				options: thinkingOptions,
			},
			{
				type: "select",
				id: CONFIG_OPTION_IDS.steeringMode,
				name: "Steering mode",
				category: "other",
				currentValue: steeringMode,
				options: steeringOptions,
			},
			{
				type: "select",
				id: CONFIG_OPTION_IDS.followUpMode,
				name: "Follow-up mode",
				category: "other",
				currentValue: followUpMode,
				options: followUpOptions,
			},
			{
				type: "select",
				id: CONFIG_OPTION_IDS.autoCompaction,
				name: "Auto-compaction",
				category: "other",
				currentValue: autoCompaction,
				options: autoCompactionOptions,
			},
			{
				type: "select",
				id: CONFIG_OPTION_IDS.blockImages,
				name: "Block images",
				category: "other",
				currentValue: blockImages,
				options: blockImagesOptions,
			},
		];
	}

	private applyConfigOption(state: ACPSessionState, configId: ConfigOptionId, value: string): void {
		switch (configId) {
			case CONFIG_OPTION_IDS.thinkingLevel: {
				const levels = state.session.getAvailableThinkingLevels();
				if (!levels.includes(value as (typeof levels)[number])) {
					throw RequestError.invalidParams({ error: `Invalid thinking level: ${value}` });
				}
				state.session.setThinkingLevel(value as (typeof levels)[number]);
				return;
			}
			case CONFIG_OPTION_IDS.steeringMode: {
				if (value !== "all" && value !== "one-at-a-time") {
					throw RequestError.invalidParams({ error: `Invalid steering mode: ${value}` });
				}
				state.session.setSteeringMode(value);
				return;
			}
			case CONFIG_OPTION_IDS.followUpMode: {
				if (value !== "all" && value !== "one-at-a-time") {
					throw RequestError.invalidParams({ error: `Invalid follow-up mode: ${value}` });
				}
				state.session.setFollowUpMode(value);
				return;
			}
			case CONFIG_OPTION_IDS.autoCompaction: {
				if (value !== "enabled" && value !== "disabled") {
					throw RequestError.invalidParams({ error: `Invalid auto-compaction value: ${value}` });
				}
				state.session.settingsManager.setCompactionEnabled(value === "enabled");
				return;
			}
			case CONFIG_OPTION_IDS.blockImages: {
				if (value !== "allow" && value !== "block") {
					throw RequestError.invalidParams({ error: `Invalid block images value: ${value}` });
				}
				state.session.settingsManager.setBlockImages(value === "block");
				return;
			}
			default:
				throw RequestError.invalidParams({ error: `Unknown config option: ${configId}` });
		}
	}

	private normalizeModeId(modeId: string): ACPModeId {
		const match = MODE_DEFINITIONS.find((mode) => mode.id === modeId);
		if (!match) {
			throw RequestError.invalidParams({ error: `Unknown mode: ${modeId}` });
		}
		return match.id;
	}

	private resolveToolNamesForMode(state: ACPSessionState, modeId: ACPModeId): string[] {
		const allToolNames = state.session.getAllTools().map((tool) => tool.name);
		if (modeId === "read-only") {
			return allToolNames.filter((name) => name !== "edit" && name !== "write");
		}
		return allToolNames;
	}

	private resolveCwd(cwd?: string): string {
		const resolvedCwd = cwd ?? this.config.defaultCwd;
		if (!isAbsolute(resolvedCwd)) {
			throw RequestError.invalidParams({ error: "cwd must be an absolute path" });
		}
		return resolvedCwd;
	}

	private async resolveModel(modelId: string): Promise<Model<any>> {
		const [provider, ...modelParts] = modelId.split("/");
		if (!provider || modelParts.length === 0) {
			throw RequestError.invalidParams({ error: `Invalid modelId: ${modelId}` });
		}
		const modelName = modelParts.join("/");
		const model = this.config.modelRegistry.find(provider, modelName);
		if (!model) {
			throw RequestError.invalidParams({ error: `Unknown modelId: ${modelId}` });
		}
		const available = await this.config.modelRegistry.getAvailable();
		const isAvailable = available.some((entry) => entry.provider === model.provider && entry.id === model.id);
		if (!isAvailable) {
			throw RequestError.invalidParams({ error: `Model not available: ${modelId}` });
		}
		return model;
	}

	private async replayHistory(state: ACPSessionState): Promise<void> {
		for (const message of state.session.messages) {
			if (message.role !== "user" && message.role !== "assistant") {
				continue;
			}
			const updates = mapMessageToSessionUpdates(message);
			for (const update of updates) {
				await this.connection.sessionUpdate({ sessionId: state.session.sessionId, update });
			}
		}
	}

	private async handleSessionEvent(state: ACPSessionState, event: AgentSessionEvent): Promise<void> {
		if (event.type === "message_start" && event.message.role === "assistant") {
			state.assistantDeltaSeen = false;
			return;
		}

		if (event.type === "message_update") {
			if (event.assistantMessageEvent.type === "text_delta") {
				state.assistantDeltaSeen = true;
				await this.connection.sessionUpdate({
					sessionId: state.session.sessionId,
					update: {
						sessionUpdate: "agent_message_chunk",
						content: { type: "text", text: event.assistantMessageEvent.delta },
					},
				});
			}
			if (event.assistantMessageEvent.type === "thinking_delta") {
				state.assistantDeltaSeen = true;
				await this.connection.sessionUpdate({
					sessionId: state.session.sessionId,
					update: {
						sessionUpdate: "agent_thought_chunk",
						content: { type: "text", text: event.assistantMessageEvent.delta },
					},
				});
			}
			return;
		}

		if (event.type === "message_end") {
			if (event.message.role === "assistant" && !state.assistantDeltaSeen) {
				const updates = mapMessageToSessionUpdates(event.message);
				for (const update of updates) {
					await this.connection.sessionUpdate({ sessionId: state.session.sessionId, update });
				}
			}
			return;
		}

		if (event.type === "tool_execution_start") {
			this.toolCallInputs.set(event.toolCallId, { toolName: event.toolName, args: event.args ?? {} });
			const toolCall: ToolCall = {
				toolCallId: event.toolCallId,
				title: formatToolTitle(event.toolName, event.args ?? {}),
				kind: mapToolKind(event.toolName),
				status: "pending",
				rawInput: event.args,
				locations: mapToolLocations(event.toolName, event.args),
			};
			await this.connection.sessionUpdate({
				sessionId: state.session.sessionId,
				update: { sessionUpdate: "tool_call", ...toolCall },
			});
			return;
		}

		if (event.type === "tool_execution_update") {
			const update: ToolCallUpdate = {
				toolCallId: event.toolCallId,
				status: "in_progress",
				title: formatToolTitle(event.toolName, event.args ?? {}),
				kind: mapToolKind(event.toolName),
				locations: mapToolLocations(event.toolName, event.args ?? {}),
				rawInput: event.args,
				content: toToolCallContent(event.partialResult?.content),
			};
			await this.connection.sessionUpdate({
				sessionId: state.session.sessionId,
				update: { sessionUpdate: "tool_call_update", ...update },
			});
			return;
		}

		if (event.type === "tool_execution_end") {
			const inputs = this.toolCallInputs.get(event.toolCallId);
			const status = event.isError ? "failed" : "completed";
			const content = toToolCallContent(event.result?.content);
			const diff = inputs ? toToolDiffContent(inputs.toolName, inputs.args) : undefined;
			const update: ToolCallUpdate = {
				toolCallId: event.toolCallId,
				status,
				title: formatToolTitle(event.toolName, inputs?.args ?? {}),
				kind: mapToolKind(event.toolName),
				locations: mapToolLocations(event.toolName, inputs?.args ?? {}),
				rawInput: inputs?.args,
				content: diff ? [...(content ?? []), diff] : content,
				rawOutput: event.result,
			};
			await this.connection.sessionUpdate({
				sessionId: state.session.sessionId,
				update: { sessionUpdate: "tool_call_update", ...update },
			});
			this.toolCallInputs.delete(event.toolCallId);
		}
	}
}

function toModelId(model: Model<any>): string {
	return `${model.provider}/${model.id}`;
}

function promptToPi(prompt: ContentBlock[]): { text: string; images?: ImageContent[] } {
	const textParts: string[] = [];
	const images: ImageContent[] = [];

	for (const block of prompt) {
		switch (block.type) {
			case "text":
				textParts.push(block.text);
				break;
			case "image":
				if (block.data) {
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
				} else if (block.uri) {
					textParts.push(`Image: ${block.uri}`);
				}
				break;
			case "resource_link":
				textParts.push(`Resource: ${block.uri}`);
				break;
			case "resource":
				if ("text" in block.resource) {
					textParts.push(`Resource (${block.resource.uri ?? "embedded"}):\n${block.resource.text}`);
				} else {
					textParts.push(`Resource (${block.resource.uri ?? "embedded"})`);
				}
				break;
			default:
				break;
		}
	}

	const text = textParts.join("\n\n").trim();
	return { text, images: images.length > 0 ? images : undefined };
}

function mapMessageToSessionUpdates(message: AgentMessage): SessionUpdate[] {
	if (message.role === "user") {
		const contentBlocks = toContentBlocks(message.content);
		return contentBlocks.map((content) => ({ sessionUpdate: "user_message_chunk", content }));
	}
	if (message.role === "assistant") {
		const contentBlocks = toContentBlocks(message.content);
		return contentBlocks.map((content) => ({ sessionUpdate: "agent_message_chunk", content }));
	}
	return [];
}

function toContentBlocks(content: unknown): ContentBlock[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (!Array.isArray(content)) {
		return [];
	}
	const blocks: ContentBlock[] = [];
	for (const block of content) {
		if (!block || typeof block !== "object" || !("type" in block)) {
			continue;
		}
		if (block.type === "text" && "text" in block && typeof block.text === "string") {
			blocks.push({ type: "text", text: block.text });
		}
		if (block.type === "image" && "data" in block && "mimeType" in block) {
			blocks.push({ type: "image", data: String(block.data), mimeType: String(block.mimeType) });
		}
	}
	return blocks;
}

function toToolCallContent(content: Array<TextContent | ImageContent> | undefined): ToolCallContent[] | undefined {
	if (!content) return undefined;
	const blocks: ToolCallContent[] = [];
	for (const block of content) {
		if (block.type === "text") {
			blocks.push({ type: "content", content: { type: "text", text: block.text } });
		}
		if (block.type === "image") {
			blocks.push({
				type: "content",
				content: { type: "image", data: block.data, mimeType: block.mimeType },
			});
		}
	}
	return blocks.length > 0 ? blocks : undefined;
}

function toToolDiffContent(toolName: string, args: Record<string, unknown>): ToolCallContent | undefined {
	const name = toolName.toLowerCase();
	const path = typeof args.path === "string" ? args.path : undefined;
	if (!path) return undefined;
	if (name === "edit") {
		const oldText = typeof args.oldText === "string" ? args.oldText : null;
		const newText = typeof args.newText === "string" ? args.newText : "";
		return { type: "diff", path, oldText, newText };
	}
	if (name === "write") {
		const newText = typeof args.content === "string" ? args.content : "";
		return { type: "diff", path, oldText: null, newText };
	}
	return undefined;
}

function mapToolKind(toolName: string): ToolKind {
	switch (toolName.toLowerCase()) {
		case "read":
			return "read";
		case "edit":
		case "write":
			return "edit";
		case "grep":
		case "find":
		case "ls":
			return "search";
		case "bash":
			return "execute";
		default:
			return "other";
	}
}

function mapToolLocations(toolName: string, args: Record<string, unknown>): Array<{ path: string }> | undefined {
	const path = typeof args.path === "string" ? args.path : undefined;
	if (!path) return undefined;
	switch (toolName.toLowerCase()) {
		case "read":
		case "edit":
		case "write":
		case "grep":
		case "find":
		case "ls":
			return [{ path }];
		default:
			return undefined;
	}
}

function formatToolTitle(toolName: string, args: Record<string, unknown>): string {
	const normalized = toolName.toLowerCase();
	if (normalized === "bash") {
		const command = typeof args.command === "string" ? args.command : undefined;
		return command ?? toolName;
	}
	const path = typeof args.path === "string" ? args.path : undefined;
	if (!path) {
		return toolName;
	}
	switch (normalized) {
		case "read":
			return `read ${path}`;
		case "write":
			return `write ${path}`;
		case "edit":
			return `edit ${path}`;
		case "ls":
			return `ls ${path}`;
		case "grep":
			return `grep ${path}`;
		case "find":
			return `find ${path}`;
		default:
			return toolName;
	}
}

function getLastAssistantMessage(messages: AgentMessage[]) {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role === "assistant") {
			return message;
		}
	}
	return undefined;
}
