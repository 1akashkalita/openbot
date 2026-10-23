import { Heading, Text } from "@openbot/ui";
import { TurnActivityLog } from "@openbot/ui/features/conversation/TurnActivityLog";
import type { AgentActivityMode } from "@openbot/ui/features/conversation/turn-activity";
import type { Meta, StoryObj } from "storybook-solidjs-vite";
import { STORY_TURN_ACTIVITY } from "./fixtures";

const timestamp = "2026-10-23T10:03:00.000Z";

const meta = {
  title: "Conversation/Turn Activity Log",
  component: TurnActivityLog,
  parameters: { layout: "fullscreen", a11y: { test: "error" } },
} satisfies Meta<typeof TurnActivityLog>;

export default meta;
type Story = StoryObj<typeof meta>;

/** A finished turn in each mode that draws the row. Detailed opens the steps and the memory changes. */
export const Modes: Story = {
  render: () => (
    <main class="foundation-story">
      <Heading as="h1" size="lg">
        Turn activity
      </Heading>
      <Text tone="secondary">The steps of one agent turn, and the memory changes that it committed.</Text>
      <section class="chat-primitives-gallery" aria-label="Turn activity modes">
        {(["detailed", "compact", "summary"] as const satisfies readonly AgentActivityMode[]).map((mode) => (
          <TurnActivityLog activity={STORY_TURN_ACTIVITY} mode={mode} running={false} timestamp={timestamp} />
        ))}
      </section>
    </main>
  ),
};

/** A running turn names its current step. Detailed shows the steps so far, and the newest one shimmers. */
export const Running: Story = {
  render: () => (
    <main class="foundation-story">
      <section class="chat-primitives-gallery" aria-label="Running turn activity">
        {(["detailed", "compact"] as const satisfies readonly AgentActivityMode[]).map((mode) => (
          <TurnActivityLog
            activity={{ steps: STORY_TURN_ACTIVITY.steps.slice(0, 2), moreSteps: 0 }}
            mode={mode}
            running
            timestamp={timestamp}
          />
        ))}
      </section>
    </main>
  ),
};

/** A turn that stopped commits no memory change, and the row says how many it dropped. */
export const Stopped: Story = {
  render: () => (
    <main class="foundation-story">
      <section class="chat-primitives-gallery" aria-label="Stopped turn activity">
        <TurnActivityLog
          activity={{
            steps: [{ id: "stopped-search", kind: "memory-search", count: 0 }],
            moreSteps: 0,
            memory: { status: "dropped", changes: [], dropped: 1 },
          }}
          mode="detailed"
          running={false}
          timestamp={timestamp}
        />
      </section>
    </main>
  ),
};

/** A long turn joins steps of one kind and counts the steps past the limit. */
export const LongTurn: Story = {
  render: () => (
    <main class="foundation-story">
      <section class="chat-primitives-gallery" aria-label="Long turn activity">
        <TurnActivityLog
          activity={{
            steps: [
              ...Array.from({ length: 12 }, (_, index) => ({ id: `read-${index}`, kind: "read" as const })),
              { id: "skill-unnamed", kind: "skill" },
              ...Array.from({ length: 7 }, (_, index) => ({ id: `edit-${index}`, kind: "edit" as const })),
              ...Array.from({ length: 4 }, (_, index) => ({ id: `command-${index}`, kind: "command" as const })),
              { id: "web", kind: "web" },
              { id: "tool", kind: "tool" },
            ],
            moreSteps: 37,
          }}
          mode="detailed"
          running={false}
          timestamp={timestamp}
        />
      </section>
    </main>
  ),
};
