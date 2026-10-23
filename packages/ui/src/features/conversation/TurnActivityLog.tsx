import type {
  ConversationActivityStepKind,
  ConversationMemoryChangeAction,
  ConversationTurnActivity,
} from "@openbot/contracts/ipc";
import type { AppMessages, AppTextKey } from "@openbot/i18n";
import {
  BookMarked,
  BookOpen,
  Brain,
  Button,
  ChevronDown,
  Code,
  File,
  Globe2,
  Marker,
  MarkerContent,
  MarkerIcon,
  Pencil,
  Puzzle,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
} from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { Dynamic } from "@solidjs/web";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { formatChatTimestamp } from "./chat-timestamp";
import {
  type AgentActivityMode,
  type TurnActivityRow,
  turnActivityHasContent,
  turnActivityRows,
} from "./turn-activity";

const STEP_ICONS = {
  "memory-search": Search,
  "memory-list": BookOpen,
  skill: Puzzle,
  command: Code,
  read: File,
  edit: Pencil,
  web: Globe2,
  tool: Sparkles,
} as const satisfies Record<ConversationActivityStepKind, typeof Search>;

/** The finished step, with the count of joined steps. A skill row has its own keys. */
const STEP_LABELS = {
  "memory-search": "chat.activityLog.step.memorySearch",
  "memory-list": "chat.activityLog.step.memoryList",
  command: "chat.activityLog.step.command",
  read: "chat.activityLog.step.read",
  edit: "chat.activityLog.step.edit",
  web: "chat.activityLog.step.web",
  tool: "chat.activityLog.step.tool",
} as const satisfies Record<Exclude<ConversationActivityStepKind, "skill">, keyof AppMessages>;

const LIVE_LABELS = {
  "memory-search": "chat.activityLog.live.memorySearch",
  "memory-list": "chat.activityLog.live.memoryList",
  command: "chat.activityLog.live.command",
  read: "chat.activityLog.live.read",
  edit: "chat.activityLog.live.edit",
  web: "chat.activityLog.live.web",
  tool: "chat.activityLog.live.tool",
} as const satisfies Record<Exclude<ConversationActivityStepKind, "skill">, AppTextKey>;

const CHANGE_ICONS = {
  saved: BookMarked,
  updated: Pencil,
  forgotten: Trash2,
} as const satisfies Record<ConversationMemoryChangeAction, typeof Search>;

const CHANGE_LABELS = {
  saved: "chat.activityLog.memory.action.saved",
  updated: "chat.activityLog.memory.action.updated",
  forgotten: "chat.activityLog.memory.action.forgotten",
} as const satisfies Record<ConversationMemoryChangeAction, AppTextKey>;

const CHANGE_COUNTS = {
  saved: "chat.activityLog.memory.saved",
  updated: "chat.activityLog.memory.updated",
  forgotten: "chat.activityLog.memory.forgotten",
} as const satisfies Record<ConversationMemoryChangeAction, keyof AppMessages>;

/**
 * One agent turn as one row: its steps in order and, once the turn ends, its memory changes. The row
 * opens to list them. While the turn runs, the row names the current step; in the detailed mode the
 * list is open and grows as the agent works.
 */
export function TurnActivityLog(props: {
  activity: ConversationTurnActivity;
  mode: AgentActivityMode;
  running: boolean;
  timestamp: string;
}) {
  const { t, format } = useText();
  const [open, setOpen] = createSignal(props.mode === "detailed");
  const listId = createUniqueId();
  const rows = createMemo(() => turnActivityRows(props.activity.steps));
  const memory = () => props.activity.memory;
  const changes = () => memory()?.changes ?? [];
  const dropped = () => (memory()?.status === "dropped" ? (memory()?.dropped ?? 0) : 0);

  const rowLabel = (row: TurnActivityRow): string => {
    if (row.kind === "skill") {
      return row.name ? t("chat.activityLog.step.skill", { name: row.name }) : t("chat.activityLog.step.skillUnnamed");
    }
    const label = t(STEP_LABELS[row.kind], { count: row.count });
    return row.results === undefined
      ? label
      : `${label} · ${t("chat.activityLog.step.results", { count: row.results })}`;
  };
  const liveLabel = (row: TurnActivityRow): string => {
    if (row.kind === "skill") {
      return row.name ? t("chat.activityLog.live.skill", { name: row.name }) : t("chat.activityLog.live.skillUnnamed");
    }
    return t(LIVE_LABELS[row.kind]);
  };
  const memoryText = (): string | null => {
    if (dropped() > 0) return t("chat.activityLog.memory.dropped", { count: dropped() });
    const counts = (["saved", "updated", "forgotten"] as const)
      .map((action) => [action, changes().filter((change) => change.action === action).length] as const)
      .filter(([, count]) => count > 0)
      .map(([action, count]) => t(CHANGE_COUNTS[action], { count }));
    return counts.length ? t("chat.activityLog.memory.summary", { changes: counts.join(" · ") }) : null;
  };
  const summary = (): string => {
    const current = rows().at(-1);
    if (props.running && current) return liveLabel(current);
    const steps = props.activity.steps.length + props.activity.moreSteps;
    return [steps > 0 ? t("chat.activityLog.stepCount", { count: steps }) : null, memoryText()]
      .filter(Boolean)
      .join(" · ");
  };
  const time = () => {
    const date = new Date(props.timestamp);
    return Number.isNaN(date.getTime()) ? null : formatChatTimestamp(date, format);
  };

  return (
    <Show when={turnActivityHasContent(props.activity)}>
      <Marker
        class="chat-action-marker chat-action-marker-turn-activity"
        role="group"
        aria-label={t("chat.activityLog.label")}
        data-memory={dropped() > 0 ? "dropped" : undefined}
      >
        <div class="chat-action-marker-summary">
          <MarkerContent class="chat-action-marker-content">
            <MarkerIcon class="turn-activity-icon">
              <Show when={dropped() > 0} fallback={<Brain aria-hidden="true" />}>
                <TriangleAlert aria-hidden="true" />
              </Show>
            </MarkerIcon>
            <Button
              variant="ghost"
              type="button"
              class="chat-action-target turn-activity-toggle"
              aria-expanded={open() ? "true" : "false"}
              aria-controls={listId}
              title={t(open() ? "chat.activityLog.hide" : "chat.activityLog.show")}
              data-cuelume-tap={open() ? "close" : "open"}
              onClick={() => setOpen((value) => !value)}
            >
              <span class={{ "turn-activity-summary": true, "agent-activity-label": props.running }}>{summary()}</span>
              <ChevronDown aria-hidden="true" class="turn-activity-chevron" data-open={open() ? "true" : "false"} />
            </Button>
            <Show when={time()}>
              {(value) => (
                <time class="chat-action-marker-time" datetime={props.timestamp}>
                  {value()}
                </time>
              )}
            </Show>
          </MarkerContent>
          <Show when={open()}>
            <div class="chat-action-history-panel" data-state="open">
              <div class="chat-action-history-clip">
                <div id={listId} class="chat-action-history turn-activity-body">
                  <Show when={rows().length > 0}>
                    <ol class="subagents-step-list" aria-label={t("chat.activityLog.steps")}>
                      <For each={rows()} keyed={(row) => row.id}>
                        {(row, index) => {
                          const live = () => props.running && index() === rows().length - 1;
                          return (
                            <li class="subagents-step">
                              <Dynamic
                                component={STEP_ICONS[row().kind]}
                                class="subagents-step-glyph"
                                aria-hidden="true"
                              />
                              <span class={["subagents-step-text", { "agent-activity-label": live() }]}>
                                {live() ? liveLabel(row()) : rowLabel(row())}
                              </span>
                            </li>
                          );
                        }}
                      </For>
                      <Show when={props.activity.moreSteps > 0}>
                        <li class="subagents-step">
                          <span class="subagents-step-glyph" aria-hidden="true" />
                          <span class="subagents-step-text">
                            {t("chat.activityLog.moreSteps", { count: props.activity.moreSteps })}
                          </span>
                        </li>
                      </Show>
                    </ol>
                  </Show>
                  <Show when={changes().length > 0}>
                    <ul class="turn-activity-changes" aria-label={t("chat.activityLog.memory.changes")}>
                      <For each={changes()} keyed={(change) => `${change.action}:${change.id}`}>
                        {(change) => (
                          <li class="turn-activity-change" data-action={change().action}>
                            <Dynamic
                              component={CHANGE_ICONS[change().action]}
                              class="subagents-step-glyph"
                              aria-hidden="true"
                            />
                            <span class="turn-activity-change-text">
                              <Show when={change().action === "forgotten"} fallback={<span>{change().text}</span>}>
                                <del>{change().text}</del>
                              </Show>
                              <Show when={change().previousText}>
                                {(previous) => (
                                  <del>
                                    <span class="sr-only">{t("chat.activityLog.memory.before")} </span>
                                    {previous()}
                                  </del>
                                )}
                              </Show>
                            </span>
                            <span class="turn-activity-change-action">{t(CHANGE_LABELS[change().action])}</span>
                          </li>
                        )}
                      </For>
                    </ul>
                  </Show>
                </div>
              </div>
            </div>
          </Show>
        </div>
      </Marker>
    </Show>
  );
}
