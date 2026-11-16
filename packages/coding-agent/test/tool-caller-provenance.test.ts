import { afterEach, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import {
	EPHEMERAL_MODEL_CHANGE_ROLE,
	PREWALK_MODEL_CHANGE_ROLE,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { AgentToolCaller } from "../src/tools/context";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { localSession } from "./helpers/local-session";

interface HarnessOptions {
	modelRole?: string;
	beforePrompt?: (sessionManager: SessionManager) => void;
}

async function captureCaller(options: HarnessOptions): Promise<{
	caller: AgentToolCaller | undefined;
	lastModelRole: string | undefined;
}> {
	const root = TempDir.createSync("@pi-tool-caller-");
	const auth = createInMemoryAuthStorage();
	auth.keys.setRuntime("mock", "test-key");
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "probe-1", name: "probe", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
		],
	});
	const sessionManager = SessionManager.inMemory(root.path());
	let caller: AgentToolCaller | undefined;
	const probe: AgentTool = {
		name: "probe",
		label: "Probe",
		description: "Capture execution context",
		parameters: type({}),
		execute: async (_id, _params, _signal, _onUpdate, context) => {
			caller = context?.caller;
			return { content: [{ type: "text", text: "captured" }] };
		},
	};
	const registry = new ModelRegistry(auth);
	try {
		const { session } = await sdkModule.createAgentSession({
			cwd: root.path(),
			agentDir: root.path(),
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"retry.enabled": false,
				"todo.enabled": false,
				"todo.reminders": false,
			}),
			modelRegistry: registry,
			model: mock,
			modelRole: options.modelRole,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: {
				rootPath: root.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			toolNames: [],
		});
		try {
			session.agent.setTools([probe]);
			session.agent.streamFn = mock.stream;
			options.beforePrompt?.(sessionManager);
			await session.prompt("Run probe.");
			return { caller, lastModelRole: sessionManager.getLastModelChangeRole({ skipEphemeral: true }) };
		} finally {
			await session.dispose();
		}
	} finally {
		auth.close();
		root.removeSync();
	}
}

interface OverlapHarness {
	session: AgentSession;
	started: Promise<void>;
	release(): void;
	prompt(): Promise<boolean>;
	caller(): AgentToolCaller | undefined;
}

async function createOverlapHarness(options: {
	root: TempDir;
	registry: ModelRegistry;
	agentId: string;
	startupModelRole?: string;
	toolCallerModelRole?: string;
	parentTaskPrefix?: string;
	reject?: boolean;
}): Promise<OverlapHarness> {
	const started = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let caller: AgentToolCaller | undefined;
	const mock = createMockModel({
		id: "shared-role-model",
		responses: [
			{
				content: [{ type: "toolCall", id: `${options.agentId}-probe`, name: "probe", arguments: {} }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
		],
	});
	const probe: AgentTool = {
		name: "probe",
		label: "Probe",
		description: "Capture overlapping caller provenance",
		parameters: type({}),
		async execute(_id, _params, _signal, _update, context) {
			caller = context?.caller;
			started.resolve();
			await gate.promise;
			if (options.reject) throw new Error("isolated rejection");
			return { content: [{ type: "text", text: "ok" }] };
		},
	};
	const created = await sdkModule.createAgentSession({
		cwd: options.root.path(),
		agentDir: options.root.path(),
		sessionManager: SessionManager.inMemory(options.root.path()),
		settings: Settings.isolated({
			"compaction.enabled": false,
			"retry.enabled": false,
			"todo.enabled": false,
			"todo.reminders": false,
		}),
		modelRegistry: options.registry,
		model: mock,
		agentId: options.agentId,
		modelRole: options.startupModelRole,
		toolCallerModelRole: options.toolCallerModelRole,
		parentTaskPrefix: options.parentTaskPrefix,
		disableExtensionDiscovery: true,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
		workspaceTree: {
			rootPath: options.root.path(),
			rendered: "",
			truncated: false,
			totalLines: 0,
			agentsMdFiles: [],
		},
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		toolNames: [],
	});
	created.session.agent.setTools([probe]);
	created.session.agent.streamFn = mock.stream;
	return {
		session: created.session,
		started: started.promise,
		release: gate.resolve,
		prompt: () => created.session.prompt("Run probe."),
		caller: () => caller,
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("tool caller provenance", () => {
	it("uses the role active for the main session's current turn", async () => {
		const result = await captureCaller({
			modelRole: "task",
			beforePrompt: sessionManager => {
				sessionManager.appendModelChange("mock/current", "plan");
				sessionManager.appendModelChange("mock/temporary", PREWALK_MODEL_CHANGE_ROLE);
				sessionManager.appendModelChange("mock/fallback", EPHEMERAL_MODEL_CHANGE_ROLE);
			},
		});

		expect(result.caller).toEqual({ agentId: "Main", modelRole: "plan" });
		expect(result.lastModelRole).toBe("plan");
	});
	it("keeps a roleless explicit-model session's caller role absent", async () => {
		const result = await captureCaller({
			beforePrompt: sessionManager => {
				sessionManager.appendModelChange("mock/explicit");
			},
		});

		expect(result.caller).toEqual({ agentId: "Main" });
		expect(result.lastModelRole).toBe("default");
	});

	it("keeps spawned semantic role separate from retry routing at the live tool boundary", async () => {
		const root = TempDir.createSync("@pi-tool-caller-spawn-");
		const auth = createInMemoryAuthStorage();
		const sourceId = `tool-caller-${crypto.randomUUID()}`;
		const agentId = "Parent.Child";
		registerMockApi(sourceId);
		const lifecycle = AgentLifecycleManager.global();
		auth.keys.setRuntime("mock", "test-key");
		const model = createMockModel({
			id: "role-worker",
			responses: [
				{
					content: [{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "missing.txt" } }],
					stopReason: "toolUse",
				},
				{ content: [{ type: "text", text: "done" }], stopReason: "stop" },
			],
			handler: () => {
				throw new Error("429 usage_limit_reached: primary exhausted");
			},
		});
		const defaultFallback = createMockModel({
			id: "default-fallback",
			handler: () => ({ content: ["wrong chain"] }),
		});
		const taskFallback = createMockModel({
			id: "task-fallback",
			responses: [
				{
					content: [{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "missing.txt" } }],
					stopReason: "toolUse",
				},
				{ content: [{ type: "text", text: "task fallback" }], stopReason: "stop" },
			],
		});
		const registry = new ModelRegistry(auth);
		const find = registry.find.bind(registry);
		vi.spyOn(registry, "find").mockImplementation((provider, id) => {
			if (provider === "mock" && id === model.id) return model;
			if (provider === "mock" && id === defaultFallback.id) return defaultFallback;
			if (provider === "mock" && id === taskFallback.id) return taskFallback;
			return find(provider, id);
		});
		let warm = false;
		vi.spyOn(registry, "getAvailable").mockImplementation(() => (warm ? [model, defaultFallback, taskFallback] : []));
		vi.spyOn(registry, "getAll").mockReturnValue([model, defaultFallback, taskFallback]);
		const callers: Array<AgentToolCaller | undefined> = [];
		const retryRoles: Array<string | undefined> = [];
		let sawDeferredSelection = false;
		const createAgentSession = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected session options");
			sawDeferredSelection = options.model === undefined && options.modelPattern !== undefined;
			warm = true;
			const created = await createAgentSession(options);
			const read = created.session.agent.state.tools.find(tool => tool.name === "read");
			if (!read) throw new Error("Expected read tool");
			const wrapped: AgentTool = {
				...read,
				execute(toolCallId, params, signal, onUpdate, context) {
					callers.push(context?.caller);
					retryRoles.push(created.session.sessionManager.getLastModelChangeRole({ skipEphemeral: true }));
					return read.execute.call(read, toolCallId, params, signal, onUpdate, context);
				},
			};
			created.session.agent.setTools(
				created.session.agent.state.tools.map(tool => (tool === read ? wrapped : tool)),
			);
			return created;
		});
		const agent: AgentDefinition = {
			name: "task",
			description: "Role-backed worker",
			systemPrompt: "Use read, then answer.",
			source: "bundled",
			tools: ["read"],
		};
		try {
			const result = await runSubprocess({
				cwd: root.path(),
				agent,
				task: "Read missing.txt, then answer.",
				index: 0,
				id: agentId,
				modelOverride: [`mock/${model.id}`],
				modelRole: "task",
				settings: Settings.isolated({
					"compaction.enabled": false,
					"todo.enabled": false,
					modelRoles: { default: `mock/${defaultFallback.id}`, task: `mock/${model.id}` },
					"retry.fallbackChains": {
						default: [`mock/${defaultFallback.id}`],
						task: [`mock/${model.id}`, `mock/${taskFallback.id}`],
					},
				}),
				authStorage: auth,
				modelRegistry: registry,
				enableLsp: false,
				enableMCP: false,
				enableIrc: false,
				contextFiles: [],
				skills: [],
				promptTemplates: [],
				rules: [],
				workspaceTree: {
					rootPath: root.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				structured: false,
				keepAlive: true,
			});

			expect(result.exitCode).toBe(0);
			expect(sawDeferredSelection).toBe(true);
			const live = AgentRegistry.global().get(agentId)?.session;
			if (!live) throw new Error("Expected warm subagent session");
			await live.prompt("Read missing.txt again.");
			expect(callers).toEqual([
				{ agentId, modelRole: "task" },
				{ agentId, modelRole: "task" },
			]);
			expect(retryRoles).toEqual([`subagent:${agentId}`, `subagent:${agentId}`]);
			expect(taskFallback.calls.length).toBeGreaterThan(0);
			expect(defaultFallback.calls).toHaveLength(0);
		} finally {
			await lifecycle.release(agentId);
			unregisterCustomApis(sourceId);
			auth.close();
			root.removeSync();
		}
	});

	it("isolates overlapping parent, child, and grandchild callers on one resolved model", async () => {
		const root = TempDir.createSync("@pi-tool-caller-overlap-");
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		const registry = new ModelRegistry(auth);
		const parent = await createOverlapHarness({
			root,
			registry,
			agentId: "Parent",
			startupModelRole: "task",
		});
		const child = await createOverlapHarness({
			root,
			registry,
			agentId: "Parent.Child",
			parentTaskPrefix: "Parent.Child",
			toolCallerModelRole: "plan",
			reject: true,
		});
		const grandchild = await createOverlapHarness({
			root,
			registry,
			agentId: "Parent.Child.Grandchild",
			parentTaskPrefix: "Parent.Child.Grandchild",
		});
		const sessions = [parent, child, grandchild];
		try {
			const parentPrompt = parent.prompt();
			let childSettled = false;
			const childPrompt = child.prompt().finally(() => {
				childSettled = true;
			});
			const grandchildPrompt = grandchild.prompt();
			await Promise.all(sessions.map(harness => harness.started));

			parent.release();
			grandchild.release();
			await Promise.all([parentPrompt, grandchildPrompt]);
			expect(childSettled).toBe(false);
			child.release();
			await childPrompt;

			expect(parent.caller()).toEqual({ agentId: "Parent", modelRole: "task" });
			expect(child.caller()).toEqual({ agentId: "Parent.Child", modelRole: "plan" });
			expect(grandchild.caller()).toEqual({ agentId: "Parent.Child.Grandchild" });
			expect(parent.session.agent.state.messages.find(message => message.role === "toolResult")?.isError).toBe(
				false,
			);
			expect(child.session.agent.state.messages.find(message => message.role === "toolResult")?.isError).toBe(true);
			expect(grandchild.session.agent.state.messages.find(message => message.role === "toolResult")?.isError).toBe(
				false,
			);
		} finally {
			for (const harness of sessions) {
				harness.release();
				await harness.session.dispose();
				AgentRegistry.global().unregister(harness.caller()?.agentId ?? "");
			}
			auth.close();
			root.removeSync();
		}
	});
});
describe("real nested task provenance", () => {
	it("preserves identity and role across a real nested spawn chain and warm revival", async () => {
		const root = TempDir.createSync("@pi-tool-caller-chain-");
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("mock", "test-key");
		await Bun.write(
			path.join(root.path(), ".omp", "agents", "provenance-child.md"),
			`---
name: provenance-child
description: Spawn a nested provenance probe.
model: "@plan"
tools: [read]
spawns: [provenance-grandchild]
blocking: true
---
Read the probe file and spawn the nested reviewer.`,
		);
		await Bun.write(
			path.join(root.path(), ".omp", "agents", "provenance-grandchild.md"),
			`---
name: provenance-grandchild
description: Read the probe file.
model: "@review"
tools: [read]
blocking: true
---
Read the probe file.`,
		);
		await Bun.write(path.join(root.path(), "probe.txt"), "provenance probe");
		const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({
			content: [{ type: "toolCall" as const, id, name, arguments: args }],
			stopReason: "toolUse" as const,
		});
		const models = [
			createMockModel({
				id: "provenance-parent",
				responses: [
					toolCall("parent-read", "read", { path: "probe.txt" }),
					toolCall("parent-child", "task", {
						agent: "provenance-child",
						name: "Child",
						task: "Run a nested provenance check.",
					}),
					{ content: ["parent done"], stopReason: "stop" },
				],
			}),
			createMockModel({
				id: "provenance-child",
				responses: [
					toolCall("child-read", "read", { path: "probe.txt" }),
					toolCall("child-grandchild", "task", {
						agent: "provenance-grandchild",
						name: "Grandchild",
						task: "Read the probe file.",
					}),
					{ content: ["child done"], stopReason: "stop" },
				],
			}),
			createMockModel({
				id: "provenance-grandchild",
				responses: [
					toolCall("grandchild-read", "read", { path: "probe.txt" }),
					{ content: ["done"], stopReason: "stop" },
				],
			}),
		];
		const registry = new ModelRegistry(auth);
		const find = registry.find.bind(registry);
		vi.spyOn(registry, "find").mockImplementation(
			(provider, id) => models.find(model => provider === "mock" && model.id === id) ?? find(provider, id),
		);
		vi.spyOn(registry, "getAvailable").mockReturnValue(models);
		vi.spyOn(registry, "getAll").mockReturnValue(models);
		const creations: Array<{ id: string; parentAgentId?: string; modelRole?: string }> = [];
		const callers: Array<AgentToolCaller | undefined> = [];
		const lifecycle = AgentLifecycleManager.global();
		const sessionManager = SessionManager.create(root.path(), path.join(root.path(), "sessions"));
		const createAgentSession = sdkModule.createAgentSession;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			if (!options) throw new Error("Expected nested session options");
			const created = await createAgentSession(options);
			const id = options.agentId ?? "Main";
			const model = models.find(candidate => candidate.id === created.session.agent.state.model.id);
			if (!model) throw new Error(`No scripted model for ${created.session.agent.state.model.id}`);
			created.session.agent.streamFn = model.stream;
			const read = created.session.agent.state.tools.find(tool => tool.name === "read");
			if (!read) throw new Error(`Expected read tool for ${id}`);
			const wrapped: AgentTool = {
				...read,
				execute(toolCallId, params, signal, onUpdate, context) {
					callers.push(context?.caller);
					return read.execute.call(read, toolCallId, params, signal, onUpdate, context);
				},
			};
			created.session.agent.setTools(
				created.session.agent.state.tools.map(tool => (tool === read ? wrapped : tool)),
			);
			creations.push({
				id,
				parentAgentId: options.parentAgentId,
				modelRole: options.toolCallerModelRole ?? options.modelRole,
			});
			return created;
		});
		let main: AgentSession | undefined;
		let childId: string | undefined;
		let grandchildId: string | undefined;
		try {
			({ session: main } = await sdkModule.createAgentSession({
				cwd: root.path(),
				agentDir: root.path(),
				sessionManager,
				settings: Settings.isolated({
					"async.enabled": false,
					"compaction.enabled": false,
					"retry.enabled": false,
					"task.maxRecursionDepth": 3,
					"todo.enabled": false,
					"todo.reminders": false,
					modelRoles: {
						task: "mock/provenance-parent",
						plan: "mock/provenance-child",
						review: "mock/provenance-grandchild",
					},
				}),
				authStorage: auth,
				modelRegistry: registry,
				model: models[0],
				modelRole: "task",
				agentId: "Main",
				spawns: "*",
				toolNames: ["read", "task"],
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				workspaceTree: {
					rootPath: root.path(),
					rendered: "",
					truncated: false,
					totalLines: 0,
					agentsMdFiles: [],
				},
				enableMCP: false,
				enableLsp: false,
				enableIrc: false,
			}));
			await sessionManager.ensureOnDisk();
			await main.prompt("Read the probe and delegate a nested check.");

			const child = creations.find(entry => entry.parentAgentId === "Main");
			if (!child) throw new Error("Expected the parent to spawn a child");
			const grandchild = creations.find(entry => entry.parentAgentId === child.id);
			if (!grandchild) throw new Error("Expected the child to spawn a grandchild");
			childId = child.id;
			grandchildId = grandchild.id;
			expect(creations.slice(0, 3)).toEqual([
				{ id: "Main", parentAgentId: undefined, modelRole: "task" },
				{ id: childId, parentAgentId: "Main", modelRole: "plan" },
				{ id: grandchildId, parentAgentId: childId, modelRole: "review" },
			]);
			expect(callers.slice(0, 3)).toEqual([
				{ agentId: "Main", modelRole: "task" },
				{ agentId: childId, modelRole: "plan" },
				{ agentId: grandchildId, modelRole: "review" },
			]);

			const retryHistory = (session: AgentSession) =>
				session.sessionManager
					.getBranch()
					.filter(entry => entry.type === "model_change")
					.map(entry => [entry.model, entry.role]);
			const childHistory = retryHistory(localSession(AgentRegistry.global().get(childId)?.session));
			const grandchildHistory = retryHistory(localSession(AgentRegistry.global().get(grandchildId)?.session));
			await lifecycle.park(childId);
			await lifecycle.park(grandchildId);
			const warmChild = localSession(await lifecycle.ensureLive(childId));
			warmChild.agent.streamFn = createMockModel({
				responses: [
					toolCall("child-warm-read", "read", { path: "probe.txt" }),
					{ content: ["warm"], stopReason: "stop" },
				],
			}).stream;
			await warmChild.prompt("Read the probe after warm revival.");
			const warmGrandchild = localSession(await lifecycle.ensureLive(grandchildId));
			warmGrandchild.agent.streamFn = createMockModel({
				responses: [
					toolCall("grandchild-warm-read", "read", { path: "probe.txt" }),
					{ content: ["warm"], stopReason: "stop" },
				],
			}).stream;
			await warmGrandchild.prompt("Read the probe after warm revival.");
			expect(callers).toEqual([
				{ agentId: "Main", modelRole: "task" },
				{ agentId: childId, modelRole: "plan" },
				{ agentId: grandchildId, modelRole: "review" },
				{ agentId: childId, modelRole: "plan" },
				{ agentId: grandchildId, modelRole: "review" },
			]);
			expect(retryHistory(warmChild)).toEqual(childHistory);
			expect(retryHistory(warmGrandchild)).toEqual(grandchildHistory);
		} finally {
			if (grandchildId) await lifecycle.release(grandchildId);
			if (childId) await lifecycle.release(childId);
			await main?.dispose();
			await sessionManager.close();
			auth.close();
			root.removeSync();
		}
	});
});
