/**
 * The DOM-free rules of the turn activity row: the display modes that the "Agent activity" setting
 * chooses, and how the row joins a turn's steps. Shared UI owns these rules; the renderer owns the
 * saved setting and passes the mode down.
 */
import type {
  ConversationActivityStep,
  ConversationActivityStepKind,
  ConversationTurnActivity,
} from "@openbot/contracts/ipc";

/**
 * How much the chat shows about each agent turn. Detailed opens every step as it happens. Compact
 * shows one line with the current step. Summary shows the row only after the turn. Off shows none.
 */
export type AgentActivityMode = "detailed" | "compact" | "summary" | "off";

export const AGENT_ACTIVITY_MODES: readonly AgentActivityMode[] = ["detailed", "compact", "summary", "off"];

export const DEFAULT_AGENT_ACTIVITY_MODE: AgentActivityMode = "compact";

/** The stored value, or the default when it is absent or invalid. */
export function parseAgentActivityMode(value: unknown): AgentActivityMode {
  return AGENT_ACTIVITY_MODES.find((mode) => mode === value) ?? DEFAULT_AGENT_ACTIVITY_MODE;
}

/** Whether the chat draws a turn's activity row in this mode. Summary waits for the turn to end. */
export function showsTurnActivity(mode: AgentActivityMode, running: boolean): boolean {
  if (mode === "off") return false;
  return mode !== "summary" || !running;
}

/**
 * One row of the log: consecutive steps of one kind, such as three commands, or one skill. A skill
 * keeps its own row, so each skill shows by name.
 */
export interface TurnActivityRow {
  id: string;
  kind: ConversationActivityStepKind;
  count: number;
  /** The memories that the joined searches or lists returned together. */
  results?: number;
  name?: string;
}

export function turnActivityRows(steps: readonly ConversationActivityStep[]): TurnActivityRow[] {
  const rows: TurnActivityRow[] = [];
  for (const step of steps) {
    const last = rows.at(-1);
    if (last && last.kind === step.kind && step.kind !== "skill") {
      last.count += 1;
      if (step.count !== undefined) last.results = (last.results ?? 0) + step.count;
      continue;
    }
    rows.push({
      id: step.id,
      kind: step.kind,
      count: 1,
      ...(step.count === undefined ? {} : { results: step.count }),
      ...(step.name === undefined ? {} : { name: step.name }),
    });
  }
  return rows;
}

/** Whether the row has anything to show: a step, or a memory change that the turn made or dropped. */
export function turnActivityHasContent(activity: ConversationTurnActivity): boolean {
  return (
    activity.steps.length > 0 ||
    (activity.memory !== undefined && (activity.memory.changes.length > 0 || activity.memory.dropped > 0))
  );
}
