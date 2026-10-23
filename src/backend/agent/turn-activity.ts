import {
  CONVERSATION_ACTIVITY_ITEM_TYPE,
  type ConversationActivityStepKind,
  type ConversationMessage,
  type ConversationTurnActivity,
  conversationActivityName,
} from "@openbot/contracts/ipc";
import { isString } from "@openbot/contracts/runtime-values";
import { getString, type ThreadItem } from "../protocol";
import { toolUsage } from "./thread-items";

/** A step of the turn's activity, before the memory count of a search or list is known. */
export interface ActivityItemStep {
  kind: ConversationActivityStepKind;
  name?: string;
}

/** OpenBot's memory tools that read. The memory tools that write show as the turn's memory changes. */
const MEMORY_READ_STEPS = new Map<string, ConversationActivityStepKind>([
  ["search_memories", "memory-search"],
  ["list_memories", "memory-list"],
]);
const MEMORY_WRITE_TOOLS = new Set(["remember", "forget_memory", "set_memory_inclusion"]);

/** OpenBot's catalog lookups: how an agent finds a tool, not a step of the work. */
const CATALOG_TOOLS = new Set(["tool_search", "tool_describe"]);

/** Claude tools that are part of how the turn shows itself, not work: the plan has its own row. */
const QUIET_CLAUDE_TOOLS = new Set(["TodoWrite", "ToolSearch"]);

/** A skill's instructions file, as a provider that has no skill tool reads it. */
const SKILL_FILE = /(?:^|[\\/])skills[\\/]([^\\/\s"'`]+)[\\/]SKILL\.md\b/u;

/**
 * The step that a provider's tool item adds to its turn's activity, or null for an item that is not
 * a tool step or that the chat shows another way (subagents, generated images, the plan).
 *
 * A skill shows by name: Claude names it in its `Skill` tool, and Codex and ACP agents read the
 * skill's `SKILL.md`. The step keeps the skill name only; it never keeps a command, a path or an
 * argument.
 */
export function activityStepForItem(item: ThreadItem, filePaths: readonly unknown[]): ActivityItemStep | null {
  if (item.type === "toolCall" && getString(item, "name") === "Skill") {
    const name = conversationActivityName(getString(item, "skill") ?? "");
    return { kind: "skill", ...(name ? { name } : {}) };
  }
  if (item.type === "toolCall" && QUIET_CLAUDE_TOOLS.has(getString(item, "name") ?? "")) return null;
  const usage = toolUsage(item);
  if (!usage) return null;
  if (usage.kind === "mcp" && usage.server === "openbot" && usage.tool) {
    const memoryStep = MEMORY_READ_STEPS.get(usage.tool);
    if (memoryStep) return { kind: memoryStep };
    if (MEMORY_WRITE_TOOLS.has(usage.tool) || CATALOG_TOOLS.has(usage.tool)) return null;
  }
  if (usage.kind === "file_read" || usage.kind === "command") {
    const skill = skillFileName(item, filePaths);
    if (skill) return { kind: "skill", name: skill };
  }
  switch (usage.kind) {
    case "subagent":
    case "image_generation":
      return null;
    case "command":
      return { kind: "command" };
    case "file_read":
      return { kind: "read" };
    case "file_change":
      return { kind: "edit" };
    case "web_search":
    case "web_fetch":
      return { kind: "web" };
    default:
      return { kind: "tool" };
  }
}

function skillFileName(item: ThreadItem, filePaths: readonly unknown[]): string | undefined {
  const command = item.command;
  const candidates = [
    ...filePaths.filter(isString),
    ...(isString(command) ? [command] : Array.isArray(command) ? command.filter(isString) : []),
    ...(item.arguments === undefined ? [] : [JSON.stringify(item.arguments)]),
  ];
  for (const candidate of candidates) {
    const name = SKILL_FILE.exec(candidate)?.[1];
    if (name) return conversationActivityName(name);
  }
  return undefined;
}

/** A new activity message for a turn. Its text is empty: the Team API leaves the message out. */
export function newActivityMessage(id: string, turnId: string): ConversationMessage {
  return {
    id,
    turnId,
    author: "system",
    source: "system",
    status: "completed",
    createdAt: new Date().toISOString(),
    itemType: CONVERSATION_ACTIVITY_ITEM_TYPE,
    text: "",
    activity: emptyActivity(),
  };
}

export function emptyActivity(): ConversationTurnActivity {
  return { steps: [], moreSteps: 0 };
}
