/**
 * Session events to the host as `{t:"event", event}`.
 *
 * Every `AgentSession` event goes through {@link SessionEventForwarder}, so
 * `message_start` / `message_update` / `message_end` carry a `messageId` ("msg-N", unique per process) and
 * `message_update` is a delta by default:
 *   {type:"message_update", messageId, message:{role}, assistantMessageEvent}
 * where `assistantMessageEvent` drops the accumulated `partial` (see {@link toDelta}).
 * `set_event_filter {messageUpdates:"full"}` sends the whole partial instead; a host that lost a delta base
 * switches to full until the message ends, then back to delta.
 *
 * Events that are not plain AgentSession events:
 *   agent_end                  {type, messages, isTerminal, yielded, awaitingAsyncWork?}  one per stopped model loop: omp's `agent_pause` is `isTerminal: false`, the run's `agent_end` `isTerminal: true`, both via omp's `toWireEvent`
 *   session_settled            {type}                              the session went quiet after activity (omp's `RpcSessionSettleWatcher`)
 *   available_commands_update  {type, commands}                    at subscribe, on command-metadata change, after a session change
 *   session_info_update        {type, title?, sessionId}           the session name changed (TUI /rename, auto title, host rename)
 *   notice (source "session-persistence")  {type, level, message, source}  store failure (error) or session moved to a new file (warning)
 *
 * Stamped fields (correlation.ts): `clientMessageId` on message_start/message_end of a host-submitted message, and
 * `clientMessageIds` on queue_update; an extra identity-only queue_update follows once a queued message is named.
 */
import type { AssistantMessage, AssistantMessageEvent } from "@oh-my-pi/pi-ai";
import { formatPersistenceFailure, formatPersistenceNotice } from "@oh-my-pi/pi-coding-agent/modes/persistence-failure";
import {
	RpcSessionSettleWatcher,
	watchedScheduledTurnProbe,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { toWireEvent, type WireSessionEvent } from "@oh-my-pi/pi-coding-agent/session/loop-end-wire";
import { buildAvailableSlashCommands } from "@oh-my-pi/pi-coding-agent/slash-commands/available-commands";
import type { CommandContext, CommandTable } from "./commands/types";
import { onClientQueueChange, stampClientMessageId } from "./correlation";

type MessageUpdates = "full" | "delta";

/**
 * The shell of a block a `*_start` opens. The snapshot behind a start event is cloned when the agent loop consumes the
 * event, after the provider may have streamed more into the same partial, so its streamed content is not trustworthy:
 * empty it, and every following delta applies cleanly. The matching `*_end` carries the final content.
 */
function openedBlock(block: AssistantMessage["content"][number] | undefined) {
	switch (block?.type) {
		case "text":
			return { ...block, text: "" };
		case "thinking":
			return { ...block, thinking: "" };
		case "toolCall":
			return { ...block, arguments: {} };
		default:
			return block;
	}
}

/** Drops the accumulated snapshot a streaming event carries, keeping what a client needs to rebuild it; `done` and `error` have none. */
function toDelta(event: AssistantMessageEvent): object {
	switch (event.type) {
		case "done":
		case "error":
			return event;
		case "start": {
			const { partial, ...rest } = event;
			return { ...rest, message: partial };
		}
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta": {
			const { partial: _partial, ...increment } = event;
			return increment;
		}
		case "text_end": {
			// `content` already carries the text; the block adds only what it cannot (the signature).
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "text") return rest;
			const { text: _text, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "thinking_end": {
			const { partial, ...rest } = event;
			const block = partial.content[event.contentIndex];
			if (block?.type !== "thinking") return rest;
			const { thinking: _thinking, ...meta } = block;
			return { ...rest, block: meta };
		}
		case "image_end":
		case "toolcall_end": {
			// `content` / `toolCall` is the whole block.
			const { partial: _partial, ...rest } = event;
			return rest;
		}
		default: {
			const { partial, ...rest } = event;
			const block = openedBlock(partial.content[event.contentIndex]);
			return block === undefined ? rest : { ...rest, block };
		}
	}
}

/**
 * Stamps message lifecycle events with a `messageId` and applies `set_event_filter`. Ids are assigned whether or
 * not the event passes the filter, so changing the filter mid-message never splits one message across two ids.
 */
class SessionEventForwarder {
	#filter: Set<string> | undefined;
	#messageUpdates: MessageUpdates = "delta";
	#messageCount = 0;
	/** Ids of started, unfinished messages. External records (advisor cards, IRC) nest inside a streaming reply. */
	#openMessageIds: string[] = [];
	readonly #output: (frame: object) => void;

	constructor(output: (frame: object) => void) {
		this.#output = output;
	}

	/** Forward only the listed event types; `null` forwards everything. Returns the active selection. */
	setFilter(events: readonly string[] | null, messageUpdates: MessageUpdates): string[] | null {
		this.#filter = events === null ? undefined : new Set(events);
		this.#messageUpdates = messageUpdates;
		return this.#filter ? Array.from(this.#filter) : null;
	}

	forward(sessionEvent: AgentSessionEvent): void {
		// Loop pauses and the run's end go out as per-loop `agent_end` frames (isTerminal/yielded), the shape ompweb reads.
		const event = toWireEvent(sessionEvent);
		const messageId = this.#stamp(event);
		if (this.#filter && !this.#filter.has(event.type)) return;
		if (event.type === "message_update" && this.#messageUpdates === "delta") {
			this.#output({
				...event,
				messageId,
				message: { role: event.message.role },
				assistantMessageEvent: toDelta(event.assistantMessageEvent),
			});
			return;
		}
		this.#output(messageId === undefined ? event : { ...event, messageId });
	}

	#stamp(event: WireSessionEvent): string | undefined {
		switch (event.type) {
			case "message_start": {
				const messageId = this.#mintMessageId();
				this.#openMessageIds.push(messageId);
				return messageId;
			}
			case "message_update": {
				let messageId = this.#openMessageIds.at(-1);
				if (messageId === undefined) {
					messageId = this.#mintMessageId();
					this.#openMessageIds.push(messageId);
				}
				return messageId;
			}
			case "message_end":
				return this.#openMessageIds.pop() ?? this.#mintMessageId();
			case "agent_end":
				// A run never leaves a message open; drop anything a dropped frame stranded.
				this.#openMessageIds.length = 0;
				return undefined;
			default:
				return undefined;
		}
	}

	#mintMessageId(): string {
		return `msg-${++this.#messageCount}`;
	}
}

interface HostEvents {
	forwarder: SessionEventForwarder;
	settle: RpcSessionSettleWatcher;
	emitCommands(): Promise<void>;
}

const bridges = new WeakMap<AgentSession, HostEvents>();
/** A host-scheduled turn not yet admitted (a goal continuation); set by the prompting commands, possibly before the bridge exists. */
const scheduledTurns = new WeakMap<AgentSession, () => boolean>();

export function subscribeHostEvents(session: AgentSession, send: CommandContext["send"]): () => void {
	const event = (frame: object) => send({ t: "event", event: frame });
	const forwarder = new SessionEventForwarder(event);
	const settle = new RpcSessionSettleWatcher(session, event, () => scheduledTurns.get(session)?.() ?? false);
	const emitCommands = async () => {
		event({ type: "available_commands_update", commands: await buildAvailableSlashCommands(session) });
	};
	bridges.set(session, { forwarder, settle, emitCommands });

	const unsubscribers = [
		session.subscribe(sessionEvent => {
			// Synchronous: the stamp reads the live queues.
			forwarder.forward(stampClientMessageId(session, sessionEvent));
			settle.observe(sessionEvent);
		}),
		onClientQueueChange(session, queueEvent => forwarder.forward(queueEvent)),
		session.subscribeCommandMetadataChanged(() => void emitCommands()),
		session.sessionManager.onSessionNameChanged(() =>
			event({ type: "session_info_update", title: session.sessionName, sessionId: session.sessionId }),
		),
		// Straight to the host, not session.emitNotice: dispose clears session listeners before it closes the store.
		session.sessionManager.onPersistenceError(error =>
			event({
				type: "notice",
				level: "error",
				message: formatPersistenceFailure(error.message),
				source: "session-persistence",
			}),
		),
		session.sessionManager.onPersistenceNotice(notice =>
			event({
				type: "notice",
				level: "warning",
				message: formatPersistenceNotice(notice),
				source: "session-persistence",
			}),
		),
	];
	void emitCommands();
	return () => {
		for (const unsubscribe of unsubscribers) unsubscribe();
		bridges.delete(session);
	};
}

/**
 * The probe prompt results read: reports whether `pending` holds a turn, and every "pending" answer
 * opens a settle stretch so an abandoned continuation still ends with `session_settled`.
 */
export function scheduledTurnProbe(session: AgentSession, pending: () => boolean): () => boolean {
	scheduledTurns.set(session, pending);
	return watchedScheduledTurnProbe(pending, () => bridges.get(session)?.settle);
}

/** Re-check settlement where no run `agent_end` will (an abandoned goal turn, a prompt that settled without a run). */
export function checkSettled(session: AgentSession): void {
	void bridges.get(session)?.settle.check();
}

/** After new/switch/branch/fork/open session: the detached run sends no `agent_end`, and the command catalog may differ. */
export async function afterSessionChange(session: AgentSession): Promise<void> {
	const bridge = bridges.get(session);
	if (!bridge) return;
	void bridge.settle.check();
	await bridge.emitCommands();
}

export const eventsCommands: CommandTable = {
	async set_event_filter({ session }, { events, messageUpdates = "delta" }) {
		if (
			events !== null &&
			(!Array.isArray(events) || !events.every(type => typeof type === "string" && type.length > 0))
		) {
			throw new Error("set_event_filter: events must be null or an array of non-empty event type strings");
		}
		if (messageUpdates !== "full" && messageUpdates !== "delta") {
			throw new Error('set_event_filter: messageUpdates must be "full" or "delta"');
		}
		const bridge = bridges.get(session);
		if (!bridge) throw new Error("set_event_filter: no host event subscription on this session");
		return { events: bridge.forwarder.setFilter(events, messageUpdates), messageUpdates };
	},
};
