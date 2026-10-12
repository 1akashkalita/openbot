import type {
  AvatarImageInput,
  InviteSummary,
  McpServerConfig,
  McpSignInAppState,
  McpSignInRelayPage,
  McpTestResult,
  SaveMcpSignInAppInput,
  ServerSummary,
  TeamInviteSummary,
  TeamPresenceMember,
  TeamPresenceSnapshot,
  UpdateTeamMemberInput,
} from "@openbot/contracts/ipc";
import { relayCallbackQuery, type SignInRelayStatus } from "@openbot/contracts/ipc";
import { sourceText } from "@openbot/i18n/source";
import { runTeamEffect } from "@openbot/team-client";
import {
  cancelMcpSignIn as cancelMcpSignInRequest,
  cancelSignInRelay,
  completeSignInRelay,
  listMcpServers,
  listMcpSignIns as listMcpSignInsRequest,
  mcpSignInApp as mcpSignInAppRequest,
  mcpSignInStatus,
  removeMcpServer as removeMcpServerRequest,
  removeMcpSignInApp as removeMcpSignInAppRequest,
  saveMcpServer as saveMcpServerRequest,
  saveMcpSignInApp as saveMcpSignInAppRequest,
  setMcpServerEnabled as setMcpServerEnabledRequest,
  signInRelayStatus,
  signOutMcpServer as signOutMcpServerRequest,
  startMcpSignIn,
  startMcpSignInRelay,
  testMcpServer as testMcpServerRequest,
  updateHostIdentity,
} from "@openbot/team-client/team-admin-requests";
import { currentText } from "@openbot/ui/text";
import { Effect } from "effect";
import { createEffect, createStore, untrack } from "solid-js";
import { mcpSignInRecord } from "../servers/mcp-servers";
import { serverCanAdminister, serverRoleCanAdminister } from "../servers/server-capabilities";
import type { WebAdminRuntime } from "./web-runtime";

interface WebServerSettingsState {
  open: boolean;
  members: TeamPresenceMember[];
  invites: TeamInviteSummary[];
  loading: boolean;
  error: string | null;
  mcp: McpServerConfig[];
  mcpError: string | null;
  /** Which http rows the host holds a sign-in for, by id. Empty for a host without `mcp-sign-in-v1`. */
  mcpSignIns: Record<string, boolean>;
  /** The host tab of each sign-in page, by the address it signs in to, while the sign-in waits. */
  mcpSignInPages: Record<string, string>;
  /** The relayed sign-in page of each sign-in that waits in this browser (`sign-in-relay-v1`). */
  mcpSignInRelays: Record<string, McpSignInRelayPage>;
}

/** A relayed sign-in that waits for the address the user pastes. */
interface RelayWait {
  page: URL;
  state: string | null;
  receive: (query: string) => void;
}

/**
 * The settings dialog of the connected host, as the desktop `server-settings.tsx` shows it for a
 * remote server. The web connects to one host at a time, so the dialog is for that host only.
 *
 * Every mutation ends in a new read rather than a patch of the lists: the account service and the
 * host are the authority, and a failed write must not leave a row that they did not accept.
 */
/** How often a sign-in asks the host whether it ended. */
const MCP_SIGN_IN_POLL_MS = 1_000;

export function createWebServerSettings(options: {
  server: () => ServerSummary | undefined;
  admin: () => WebAdminRuntime | undefined;
  presence: () => TeamPresenceSnapshot | null;
  refreshHosts: () => Promise<void>;
  /** Whether the host relays sign-ins (`sign-in-relay-v1`), so the page opens in this browser. */
  relaySupported: () => boolean;
}) {
  const [state, setState] = createStore<WebServerSettingsState>({
    open: false,
    members: [],
    invites: [],
    loading: false,
    error: null,
    mcp: [],
    mcpError: null,
    mcpSignIns: {},
    mcpSignInPages: {},
    mcpSignInRelays: {},
  });
  const relayWaits = new Map<string, RelayWait>();
  /** Bumped by every open and refresh, so a slower earlier load cannot paint over a newer one. */
  let request = 0;
  /** The same guard for the MCP list. It loads from a different event, so it has its own counter. */
  let mcpRequest = 0;
  let restoreTarget: HTMLElement | null = null;

  function requireAdmin(): { server: ServerSummary; admin: WebAdminRuntime } {
    const server = options.server();
    const admin = options.admin();
    if (!server || !admin || server.state !== "online")
      throw new Error(currentText().t("webClient.error.connectServerFirst"));
    return { server, admin };
  }

  // Typing updates do not read the account service again. Membership and online changes are enough
  // to show an accepted invitation.
  let previousPresence = "";
  createEffect(
    () => (state.open ? options.presence() : null),
    (presence) => {
      if (!presence) return;
      const signature = untrack(() =>
        JSON.stringify(presence.members.map((member) => [member.id, member.role, member.disabled, member.online])),
      );
      if (signature === previousPresence) return;
      previousPresence = signature;
      void untrack(refresh);
    },
  );

  // A member change revokes every session on the host, this one too. Load again after it reconnects.
  let previousState: ServerSummary["state"] | undefined;
  createEffect(
    () => (state.open ? options.server()?.state : undefined),
    (serverState) => {
      const reconnected = serverState === "online" && previousState !== undefined && previousState !== "online";
      previousState = serverState;
      if (reconnected) void untrack(refresh);
    },
  );

  async function refresh(): Promise<void> {
    const current = ++request;
    setState((draft) => {
      draft.loading = true;
      draft.error = null;
    });
    try {
      const { server, admin } = requireAdmin();
      const canManage = serverRoleCanAdminister(server);
      const [presence, members, invites] = await Promise.all([
        admin.team.getPresence(),
        canManage ? admin.team.listMembers() : Promise.resolve(null),
        canManage ? admin.team.listInvites() : Promise.resolve([]),
      ]);
      if (current !== request) return;
      const presenceById = new Map(presence.members.map((member) => [member.id, member]));
      setState((draft) => {
        draft.members = (members ?? presence.members).map((member) => ({
          ...member,
          online: presenceById.get(member.id)?.online ?? false,
          typingAgentId: presenceById.get(member.id)?.typingAgentId ?? null,
        }));
        draft.invites = invites;
      });
    } catch (error) {
      if (current === request)
        setState((draft) => {
          draft.error = currentText().errorMessage(error, currentText().t("server.settings.loadFailed"));
        });
    } finally {
      if (current === request)
        setState((draft) => {
          draft.loading = false;
        });
    }
  }

  function open(trigger: HTMLElement | null): void {
    request += 1;
    mcpRequest += 1;
    restoreTarget = trigger;
    previousPresence = "";
    setState((draft) => {
      draft.open = true;
      draft.members = [];
      draft.invites = [];
      draft.mcp = [];
      draft.mcpError = null;
      draft.error = null;
    });
    void refresh();
  }

  function setOpen(value: boolean): void {
    setState((draft) => {
      draft.open = value;
    });
  }

  async function saveIdentity(input: { serverName: string; logo?: AvatarImageInput | null }): Promise<void> {
    const { server, admin } = requireAdmin();
    if (!serverCanAdminister(server, "host-admin-v1"))
      throw new Error(currentText().t("server.settings.identityLocalOnly"));
    await runTeamEffect(updateHostIdentity(admin.request, input).pipe(Effect.mapError((error) => error.cause)));
    await options.refreshHosts();
    await refresh();
  }

  async function mutateTeam<T>(mutate: (admin: WebAdminRuntime) => Promise<T>): Promise<T> {
    const result = await mutate(requireAdmin().admin);
    await refresh();
    return result;
  }

  async function refreshMcp(): Promise<void> {
    const current = ++mcpRequest;
    try {
      const configs = await runTeamEffect(
        listMcpServers(requireAdmin().admin.request).pipe(Effect.mapError((error) => error.cause)),
      );
      if (current !== mcpRequest) return;
      setState((draft) => {
        draft.mcp = configs;
        draft.mcpError = null;
      });
    } catch (error) {
      // Shown in the panel: nothing waits for this promise when a section opens.
      if (current === mcpRequest)
        setState((draft) => {
          draft.mcpError = currentText().errorMessage(error, currentText().t("mcp.server.loadFailed"));
        });
    }
  }

  /** A badge beside the list, not the list: a failed read shows no badge. Only for a host with `mcp-sign-in-v1`. */
  async function refreshMcpSignIns(): Promise<void> {
    const { admin } = requireAdmin();
    const states = await runTeamEffect(
      listMcpSignInsRequest(admin.request).pipe(Effect.mapError((error) => error.cause)),
    ).catch(() => []);
    setState((draft) => {
      draft.mcpSignIns = mcpSignInRecord(states);
    });
  }

  function setMcpSignInPage(url: string, tabId: string | null): void {
    setState((draft) => {
      if (tabId) draft.mcpSignInPages[url] = tabId;
      else delete draft.mcpSignInPages[url];
    });
  }

  /**
   * The host runs the sign-in and opens the page in its own browser. One request cannot wait for a
   * person to sign in, so the status is read until the sign-in ends; the page shows meanwhile.
   */
  async function signInMcpServer(config: McpServerConfig): Promise<McpTestResult> {
    const { admin } = requireAdmin();
    const url = config.url;
    const run = <T>(effect: Effect.Effect<T, { cause: unknown }>) =>
      runTeamEffect(effect.pipe(Effect.mapError((error) => error.cause)));
    if (options.relaySupported()) return signInRelayed(admin, config, run);
    await run(startMcpSignIn(admin.request, { config }));
    try {
      while (true) {
        const status = await run(mcpSignInStatus(admin.request, { url }));
        if (status.result) return status.result;
        setMcpSignInPage(url, status.tabId);
        await new Promise((resolve) => setTimeout(resolve, MCP_SIGN_IN_POLL_MS));
      }
    } catch (error) {
      // Nobody watches the page any more, so it must not stay open on the host for the full timeout.
      void run(cancelMcpSignInRequest(admin.request, { url })).catch(() => undefined);
      throw error;
    } finally {
      setMcpSignInPage(url, null);
      void refreshMcpSignIns().catch(() => undefined);
    }
  }

  /**
   * The host starts the sign-in and opens no page. This browser cannot listen for the callback, so the
   * user opens the page from the dialog and pastes the address that the browser shows at the end. Only
   * its query goes to the host.
   */
  async function signInRelayed(
    admin: WebAdminRuntime,
    config: McpServerConfig,
    run: <T>(effect: Effect.Effect<T, { cause: unknown }>) => Promise<T>,
  ): Promise<McpTestResult> {
    const url = config.url;
    const { flowId } = await run(startMcpSignInRelay(admin.request, { config }));
    const status = () => run(signInRelayStatus(admin.request, flowId));
    const pause = () => new Promise<null>((resolve) => setTimeout(() => resolve(null), MCP_SIGN_IN_POLL_MS));
    try {
      let current: SignInRelayStatus = await status();
      while (!current.result && !current.authorizeUrl) {
        await pause();
        current = await status();
      }
      if (current.result) return current.result;
      const page = webPage(current.authorizeUrl ?? "");
      if (!page) return { toolCount: 0, error: sourceText("error.backend.mcpSignInNotWebPage") };
      let receive: (query: string) => void = () => undefined;
      const pasted = new Promise<string>((resolve) => {
        receive = resolve;
      });
      relayWaits.set(url, { page, state: page.searchParams.get("state"), receive });
      setState((draft) => {
        draft.mcpSignInRelays[url] = { authorizeHost: page.host, listening: false };
      });
      // The host can end the sign-in first: its deadline passed, or the user cancelled.
      while (true) {
        const query = await Promise.race([pasted, pause()]);
        if (query !== null) {
          relayWaits.delete(url);
          current = await run(completeSignInRelay(admin.request, flowId, query));
          break;
        }
        current = await status();
        if (current.result) return current.result;
      }
      while (!current.result) {
        await pause();
        current = await status();
      }
      return current.result;
    } catch (error) {
      void run(cancelSignInRelay(admin.request, flowId)).catch(() => undefined);
      throw error;
    } finally {
      relayWaits.delete(url);
      setState((draft) => {
        delete draft.mcpSignInRelays[url];
      });
      void refreshMcpSignIns().catch(() => undefined);
    }
  }

  /** The address that the browser shows at the end of a relayed sign-in. */
  function pasteMcpSignInRelay(url: string, address: string): Promise<void> {
    const wait = relayWaits.get(url);
    if (!wait) return Promise.reject(new Error(sourceText("error.mcp.relayEnded")));
    const query = relayCallbackQuery(address, wait.state);
    if (query === null) return Promise.reject(new Error(sourceText("error.mcp.relayAddressInvalid")));
    wait.receive(query);
    return Promise.resolve();
  }

  /** Opens the page from a click, so the browser does not block it. */
  function openMcpSignInRelay(url: string): void {
    const wait = relayWaits.get(url);
    if (wait) window.open(wait.page, "_blank", "noopener,noreferrer");
  }

  /** The host answers each change with the whole list. A read still in flight has the old list. */
  async function mutateMcp(mutate: (admin: WebAdminRuntime) => Promise<McpServerConfig[]>): Promise<void> {
    const configs = await mutate(requireAdmin().admin);
    mcpRequest += 1;
    setState((draft) => {
      draft.mcp = configs;
      draft.mcpError = null;
    });
  }

  /** A changed or removed app drops the sign-in that the old client held, so the badges are read again. */
  async function changeMcpSignInApp(
    change: (admin: WebAdminRuntime) => Effect.Effect<McpSignInAppState, { cause: unknown }>,
  ): Promise<McpSignInAppState> {
    const result = await runTeamEffect(change(requireAdmin().admin).pipe(Effect.mapError((error) => error.cause)));
    void refreshMcpSignIns().catch(() => undefined);
    return result;
  }

  return {
    state,
    restoreTarget: () => restoreTarget,
    open,
    setOpen,
    refresh,
    saveIdentity,
    createInvite: (input: { role: "admin" | "member"; email?: string; permanent?: boolean }): Promise<InviteSummary> =>
      mutateTeam((admin) => admin.team.createInvite(input)),
    updateMember: async (input: UpdateTeamMemberInput): Promise<void> => {
      await mutateTeam((admin) => admin.team.updateMember(input));
    },
    removeMember: (memberId: string): Promise<void> => mutateTeam((admin) => admin.team.removeMember(memberId)),
    revokeInvite: (inviteId: string): Promise<void> => mutateTeam((admin) => admin.team.revokeInvite(inviteId)),
    refreshMcp,
    saveMcpServer: (config: McpServerConfig) =>
      mutateMcp((admin) =>
        runTeamEffect(saveMcpServerRequest(admin.request, { config }).pipe(Effect.mapError((error) => error.cause))),
      ),
    removeMcpServer: (mcpServerId: string) =>
      mutateMcp((admin) =>
        runTeamEffect(
          removeMcpServerRequest(admin.request, { mcpServerId }).pipe(Effect.mapError((error) => error.cause)),
        ),
      ),
    setMcpServerEnabled: (mcpServerId: string, enabled: boolean) =>
      mutateMcp((admin) =>
        runTeamEffect(
          setMcpServerEnabledRequest(admin.request, { mcpServerId, enabled }).pipe(
            Effect.mapError((error) => error.cause),
          ),
        ),
      ),
    refreshMcpSignIns,
    signInMcpServer,
    pasteMcpSignInRelay,
    openMcpSignInRelay,
    cancelMcpSignIn: async (url: string): Promise<void> => {
      await runTeamEffect(
        cancelMcpSignInRequest(requireAdmin().admin.request, { url }).pipe(Effect.mapError((error) => error.cause)),
      );
    },
    signOutMcpServer: async (mcpServerId: string): Promise<void> => {
      const states = await runTeamEffect(
        signOutMcpServerRequest(requireAdmin().admin.request, { mcpServerId }).pipe(
          Effect.mapError((error) => error.cause),
        ),
      );
      setState((draft) => {
        draft.mcpSignIns = mcpSignInRecord(states);
      });
    },
    mcpSignInApp: (mcpServerId: string): Promise<McpSignInAppState> =>
      runTeamEffect(
        mcpSignInAppRequest(requireAdmin().admin.request, { mcpServerId }).pipe(
          Effect.mapError((error) => error.cause),
        ),
      ),
    saveMcpSignInApp: (input: SaveMcpSignInAppInput) =>
      changeMcpSignInApp((admin) => saveMcpSignInAppRequest(admin.request, input)),
    removeMcpSignInApp: (mcpServerId: string) =>
      changeMcpSignInApp((admin) => removeMcpSignInAppRequest(admin.request, { mcpServerId })),
    testMcpServer: (config: McpServerConfig): Promise<McpTestResult> =>
      runTeamEffect(
        testMcpServerRequest(requireAdmin().admin.request, { config }).pipe(Effect.mapError((error) => error.cause)),
      ),
  };
}

/** The page address, when it is a web page. The host chose it, so this browser opens nothing else. */
function webPage(address: string): URL | null {
  try {
    const url = new URL(address);
    return url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
