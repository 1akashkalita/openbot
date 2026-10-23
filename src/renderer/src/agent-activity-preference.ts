import {
  type AgentActivityMode,
  DEFAULT_AGENT_ACTIVITY_MODE,
  parseAgentActivityMode,
} from "@openbot/ui/features/conversation/turn-activity";
import { createSignal } from "solid-js";

const AGENT_ACTIVITY_STORAGE_KEY = "openbot:agent-activity-mode";

export type { AgentActivityMode };

type PreferenceStorage = Pick<Storage, "getItem" | "setItem">;

/** The choice for this page after the browser did not save it. It wins over an older saved value. */
let unsavedPreference: AgentActivityMode | undefined;

/**
 * How much the chat shows about each agent turn on this device and browser. Reading
 * `window.localStorage` throws when the browser blocks storage, so it is read inside the guard.
 */
export function readAgentActivityMode(storage?: PreferenceStorage): AgentActivityMode {
  if (unsavedPreference !== undefined) return unsavedPreference;
  try {
    return parseAgentActivityMode((storage ?? window.localStorage).getItem(AGENT_ACTIVITY_STORAGE_KEY));
  } catch {
    return DEFAULT_AGENT_ACTIVITY_MODE;
  }
}

function writeAgentActivityMode(mode: AgentActivityMode, storage?: PreferenceStorage): void {
  try {
    (storage ?? window.localStorage).setItem(AGENT_ACTIVITY_STORAGE_KEY, mode);
    unsavedPreference = undefined;
  } catch {
    // Blocked or full storage keeps the choice for this page only.
    unsavedPreference = mode;
  }
}

const [agentActivityMode, setAgentActivityModeSignal] = createSignal<AgentActivityMode>(readAgentActivityMode());

function readStorageIntoSignal(event: StorageEvent): void {
  if (event.key !== null && event.key !== AGENT_ACTIVITY_STORAGE_KEY) return;
  setAgentActivityModeSignal(readAgentActivityMode());
}

if (typeof window !== "undefined") {
  // One registration per page: addEventListener ignores the same listener twice, and HMR
  // disposal removes it when this module is replaced.
  window.addEventListener("storage", readStorageIntoSignal);
  import.meta.hot?.dispose(() => {
    window.removeEventListener("storage", readStorageIntoSignal);
  });
}

/** The shared reactive preference. Every chat on this page follows the same signal. */
export function useAgentActivityMode(): () => AgentActivityMode {
  return agentActivityMode;
}

export function setAgentActivityMode(mode: AgentActivityMode): void {
  writeAgentActivityMode(mode);
  setAgentActivityModeSignal(mode);
}
