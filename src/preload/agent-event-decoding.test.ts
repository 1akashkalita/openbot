import type { ConversationMessage, ScopedAgentEvent } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { decodeScopedAgentEvent } from "./agent-event-decoding";

const delta = {
  serverId: "local",
  event: {
    type: "conversation-delta",
    agentId: "agent-1",
    threadId: "thread-1",
    turnId: "turn-1",
    messageId: "message-1",
    delta: "Hello",
    createdAt: "2026-09-23T10:00:00.000Z",
    revision: 3,
  },
} satisfies ScopedAgentEvent;

// Larger than the Team API limits: 100,000 characters for a command and 100 paths for a list.
const largeApproval = {
  serverId: "local",
  event: {
    type: "approval",
    approval: {
      requestId: 7,
      agentId: "agent-1",
      threadId: "thread-1",
      turnId: "turn-1",
      kind: "permissions",
      command: "x".repeat(100_001),
      cwd: "/workspace",
      reason: null,
      grantRoot: null,
      permissions: {
        fileSystem: { read: [], write: Array.from({ length: 101 }, (_, index) => `/workspace/${index}`) },
        network: false,
      },
    },
  },
} satisfies ScopedAgentEvent;

const activityMessage: ConversationMessage & { activity: NonNullable<ConversationMessage["activity"]> } = {
  id: "turn-1:activity",
  turnId: "turn-1",
  author: "system",
  source: "system",
  status: "completed",
  itemType: "turn_activity",
  text: "",
  createdAt: "2026-10-23T10:00:00.000Z",
  activity: {
    steps: [
      { id: "step-1", kind: "memory-search", count: 3 },
      { id: "step-2", kind: "skill", name: "todoist-cli" },
    ],
    moreSteps: 0,
    memory: {
      status: "committed",
      changes: [{ id: "memory-1", action: "updated", text: "New text", previousText: "Old text" }],
      dropped: 0,
    },
  },
};

const activityConversation = {
  serverId: "local",
  event: {
    type: "conversation",
    snapshot: {
      agentId: "agent-1",
      threadId: "thread-1",
      activeTurnId: null,
      revision: 4,
      messages: [activityMessage],
    },
  },
} satisfies ScopedAgentEvent;

/** The conversation event with the activity of its one message changed. */
function withActivity(activity: unknown) {
  return {
    ...activityConversation,
    event: {
      ...activityConversation.event,
      snapshot: { ...activityConversation.event.snapshot, messages: [{ ...activityMessage, activity }] },
    },
  };
}

const hiddenAgents = {
  serverId: "server-1",
  event: { type: "hidden-agents-changed", agents: [{ agentId: "agent-1", hiddenAt: "2026-10-16T09:00:00.000Z" }] },
} satisfies ScopedAgentEvent;

describe("decodeScopedAgentEvent", () => {
  it.each([
    ["an event", delta],
    [
      "a buffered live event",
      { serverId: "server-1", event: { type: "queue-invalidated", agentId: "agent-1" }, bufferedLive: true },
    ],
    ["a hidden agents change", hiddenAgents],
    ["an empty hidden agents change", { serverId: "local", event: { type: "hidden-agents-changed", agents: [] } }],
    ["a turn's activity", activityConversation],
  ] satisfies [string, ScopedAgentEvent][])("keeps %s", (_name, value) => {
    expect(decodeScopedAgentEvent(value)).toEqual(value);
  });

  it.each([
    ["no server", { event: delta.event }],
    ["an unknown event type", { serverId: "local", event: { type: "made-up" } }],
    ["an event with a missing field", { serverId: "local", event: { ...delta.event, delta: undefined } }],
    [
      "an approval of an unknown kind",
      {
        serverId: "local",
        event: { ...largeApproval.event, approval: { ...largeApproval.event.approval, kind: "network" } },
      },
    ],
    [
      "a hidden agent with a time that is not a date",
      { ...hiddenAgents, event: { ...hiddenAgents.event, agents: [{ agentId: "agent-1", hiddenAt: "yesterday" }] } },
    ],
    [
      "a hidden agent that is named two times",
      {
        ...hiddenAgents,
        event: { ...hiddenAgents.event, agents: [...hiddenAgents.event.agents, ...hiddenAgents.event.agents] },
      },
    ],
    ["hidden agents that are not a list", { ...hiddenAgents, event: { ...hiddenAgents.event, agents: null } }],
    ["a bufferedLive that is not a boolean", { ...delta, bufferedLive: "yes" }],
    [
      "an activity step of an unknown kind",
      withActivity({ ...activityMessage.activity, steps: [{ id: "step-1", kind: "shell" }] }),
    ],
    [
      "an activity step with a negative count",
      withActivity({ ...activityMessage.activity, steps: [{ id: "step-1", kind: "memory-search", count: -1 }] }),
    ],
    [
      "a memory change longer than a memory",
      withActivity({
        ...activityMessage.activity,
        memory: {
          status: "committed",
          changes: [{ id: "memory-1", action: "saved", text: "x".repeat(501) }],
          dropped: 0,
        },
      }),
    ],
    [
      "too many activity steps",
      withActivity({
        steps: Array.from({ length: 101 }, (_, index) => ({ id: `step-${index}`, kind: "read" })),
        moreSteps: 0,
      }),
    ],
    ["a value that is not a record", "event"],
  ])("rejects %s", (_name, value) => {
    expect(() => decodeScopedAgentEvent(value)).toThrow(/^Invalid /);
  });
});
