import { INPUT_LIMITS } from "./input-limits";
import { isBoundedString, isIdentifier } from "./ipc-bounded-values";
import { isDynamicRecord, isOneOf } from "./runtime-values";

/**
 * What an agent did in one turn: its tool steps in order, the memories it read, the skills it used,
 * and, once the turn ends, the memory changes that the turn committed or dropped. The backend keeps
 * it on one system message of the turn, as it keeps the plan and the subagents. The message stays
 * on this computer: the Team API leaves it out, so its text is empty.
 */
export const CONVERSATION_ACTIVITY_ITEM_TYPE = "turn_activity";

/** The id of the activity message of a turn. */
export function conversationActivityMessageId(turnId: string): string {
  return `${turnId}:activity`;
}

export const CONVERSATION_ACTIVITY_STEP_KINDS = [
  "memory-search",
  "memory-list",
  "skill",
  "command",
  "read",
  "edit",
  "web",
  "tool",
] as const;
export type ConversationActivityStepKind = (typeof CONVERSATION_ACTIVITY_STEP_KINDS)[number];

export interface ConversationActivityStep {
  /** The provider's item id, so a step that starts and then completes stays one step. */
  id: string;
  kind: ConversationActivityStepKind;
  /** The skill name, on a `skill` step. */
  name?: string;
  /** How many memories the agent got back, on a `memory-search` or `memory-list` step. */
  count?: number;
}

export const CONVERSATION_MEMORY_CHANGE_ACTIONS = ["saved", "updated", "forgotten"] as const;
export type ConversationMemoryChangeAction = (typeof CONVERSATION_MEMORY_CHANGE_ACTIONS)[number];

export interface ConversationMemoryChange {
  /** The memory id. */
  id: string;
  action: ConversationMemoryChangeAction;
  /** The new text of a saved or updated memory, and the old text of a forgotten one. */
  text: string;
  /** The text before an update. */
  previousText?: string;
}

/**
 * The memory changes of a finished turn. A turn that did not complete commits nothing: its staged
 * changes are `dropped`.
 */
export interface ConversationTurnMemory {
  status: "committed" | "dropped";
  changes: ConversationMemoryChange[];
  /** How many staged changes the turn dropped. */
  dropped: number;
}

export interface ConversationTurnActivity {
  /** The first steps of the turn, up to `CONVERSATION_ACTIVITY_STEP_LIMIT`. */
  steps: ConversationActivityStep[];
  /** How many later steps did not fit. */
  moreSteps: number;
  memory?: ConversationTurnMemory;
}

export const CONVERSATION_ACTIVITY_STEP_LIMIT = 100;
export const CONVERSATION_MEMORY_CHANGE_LIMIT = 64;
const NAME_LIMIT = 128;

export function isConversationTurnActivity(value: unknown): value is ConversationTurnActivity {
  return (
    isDynamicRecord(value) &&
    Array.isArray(value.steps) &&
    value.steps.length <= CONVERSATION_ACTIVITY_STEP_LIMIT &&
    value.steps.every(isConversationActivityStep) &&
    isCount(value.moreSteps) &&
    (value.memory === undefined || isConversationTurnMemory(value.memory))
  );
}

function isConversationActivityStep(value: unknown): value is ConversationActivityStep {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isOneOf(CONVERSATION_ACTIVITY_STEP_KINDS, value.kind) &&
    (value.name === undefined || (isBoundedString(value.name, NAME_LIMIT) && value.name.length > 0)) &&
    (value.count === undefined || isCount(value.count))
  );
}

function isConversationTurnMemory(value: unknown): value is ConversationTurnMemory {
  return (
    isDynamicRecord(value) &&
    (value.status === "committed" || value.status === "dropped") &&
    Array.isArray(value.changes) &&
    value.changes.length <= CONVERSATION_MEMORY_CHANGE_LIMIT &&
    value.changes.every(isConversationMemoryChange) &&
    isCount(value.dropped)
  );
}

function isConversationMemoryChange(value: unknown): value is ConversationMemoryChange {
  return (
    isDynamicRecord(value) &&
    isIdentifier(value.id) &&
    isOneOf(CONVERSATION_MEMORY_CHANGE_ACTIONS, value.action) &&
    isBoundedString(value.text, INPUT_LIMITS.agentMemoryText) &&
    (value.previousText === undefined || isBoundedString(value.previousText, INPUT_LIMITS.agentMemoryText))
  );
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The activity with one more step, or with the step of the same id replaced. A step past the limit
 * counts in `moreSteps` only when it completes, so a step that starts and completes counts once.
 */
export function withConversationActivityStep(
  activity: ConversationTurnActivity,
  step: ConversationActivityStep,
  completed: boolean,
): ConversationTurnActivity {
  if (activity.steps.some((candidate) => candidate.id === step.id)) {
    return { ...activity, steps: activity.steps.map((candidate) => (candidate.id === step.id ? step : candidate)) };
  }
  if (activity.steps.length >= CONVERSATION_ACTIVITY_STEP_LIMIT) {
    return completed ? { ...activity, moreSteps: activity.moreSteps + 1 } : activity;
  }
  return { ...activity, steps: [...activity.steps, step] };
}

/** The memory changes inside the bounds of `isConversationTurnMemory`. */
export function clampConversationTurnMemory(memory: ConversationTurnMemory): ConversationTurnMemory {
  const clamp = (text: string) => text.slice(0, INPUT_LIMITS.agentMemoryText);
  return {
    status: memory.status,
    changes: memory.changes.slice(0, CONVERSATION_MEMORY_CHANGE_LIMIT).map((change) => ({
      id: change.id.slice(0, INPUT_LIMITS.identifier),
      action: change.action,
      text: clamp(change.text),
      ...(change.previousText === undefined ? {} : { previousText: clamp(change.previousText) }),
    })),
    dropped: memory.dropped,
  };
}

/** A skill name cut to the bound that `isConversationTurnActivity` checks, or undefined when blank. */
export function conversationActivityName(value: string): string | undefined {
  return value.replace(/\s+/gu, " ").trim().slice(0, NAME_LIMIT) || undefined;
}
