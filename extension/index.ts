/**
 * pmux — Pi Multi-Agent Coordination
 *
 * Terminal-agnostic multi-agent coordination for Pi.
 * Communication uses file-based inboxes (no tmux dependency).
 * tmux integration is optional (visual enhancements only).
 *
 * Agent lifecycle:
 *   /pmux_register  — create a new agent (UUID, name, team, role)
 *   /pmux_login     — resume an existing offline agent
 *   session shutdown — agent goes offline (persists for later login)
 *
 * Tools: pmux_role, pmux_list, pmux_send, pmux_broadcast
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "@earendil-works/pi-ai";
import { StringEnum } from "@earendil-works/pi-ai";
import type { FSWatcher } from "node:fs";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  type AgentInfo,
  type RoleDefinition,
  readRegistry,
  readAllRegistries,
  registerAgent,
  removeAgent,
  updateAgent,
  updateHeartbeat,
  goOnline,
  goOffline,
  newAgentId,
  findByName,
  findById,
  getOnlineAgents,
  getOfflineAgents,
  resolveAgent,
  formatAddress,
  readRoles,
  getRole,
  addRole,
  removeRole,
  readSessionConfig,
  writeSessionConfig,
} from "./registry";
import {
  ensureInbox,
  sendToInbox,
  getRecoverableMessages,
  markAsDelivered,
  confirmDelivered,
  appendToHistory,
  watchInbox,
  newMessageId,
  type InboxMessage,
} from "./messaging";
import { detectTmux, setPaneTitle, setWindowName } from "./tmux";

const HEARTBEAT_INTERVAL_MS = 30_000;

export default function (pi: ExtensionAPI) {
  // ── State ────────────────────────────────────────────────────
  let myId: string | undefined; // UUID — stable across restarts
  let myName: string | undefined;
  let myRole: string | undefined;
  let myRoleName: string | undefined;
  let myRoleInstructions: string | undefined;
  let myTeam: string | undefined;
  let mySession: string | undefined;
  let myPane: string | undefined; // only if tmux
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let inboxWatcher: FSWatcher | undefined;
  let currentCtx: ExtensionContext | undefined;

  function myAddress(): string {
    return formatAddress(mySession!, myName!);
  }

  function myPrefix(): string {
    const addr = myAddress();
    return myRoleName ? `[pmux:${addr} (${myRoleName})]` : `[pmux:${addr}]`;
  }

  // ── Agent Startup/Shutdown Helpers ───────────────────────────

  /** Common setup after register or login. */
  async function startAgent(ctx: ExtensionContext): Promise<void> {
    if (!myId || !mySession || !myName) return;

    // Mark online
    await goOnline(mySession, myId, process.pid, myPane);

    // Ensure inbox and artifact directories exist
    ensureInbox(mySession, myId);
    ensureArtifactDirs();

    // Start heartbeat
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(async () => {
      if (mySession && myId) {
        await updateHeartbeat(mySession, myId).catch(() => {});
      }
    }, HEARTBEAT_INTERVAL_MS);

    // Start inbox watcher — deliver messages via pi.sendUserMessage
    if (inboxWatcher) inboxWatcher.close();
    inboxWatcher = watchInbox(mySession, myId, (msg, filename) => {
      // Crash-safe: history first, then mark delivered, then queue
      appendToHistory(mySession!, msg);
      markAsDelivered(mySession!, myId!, filename);

      const prefix = msg.fromRole
        ? `[pmux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})]`
        : `[pmux:${msg.fromSession}/${msg.fromName}]`;
      pi.sendUserMessage(`${prefix} ${msg.message}`, {
        deliverAs: "followUp",
      });
    });

    // Deliver pending + crash-recovery messages
    const recoverable = getRecoverableMessages(mySession, myId);
    for (const { msg, filename } of recoverable) {
      // Only append to history for new messages (not already-delivered ones)
      if (filename.endsWith(".json")) {
        appendToHistory(mySession, msg);
        markAsDelivered(mySession, myId, filename);
      }

      const prefix = msg.fromRole
        ? `[pmux:${msg.fromSession}/${msg.fromName} (${msg.fromRole})]`
        : `[pmux:${msg.fromSession}/${msg.fromName}]`;
      pi.sendUserMessage(`${prefix} ${msg.message}`, {
        deliverAs: "followUp",
      });
    }

    // Persist UUID in pi session (survives /reload)
    pi.appendEntry("pmux-agent", { id: myId, session: mySession });

    // tmux visual enhancements (optional)
    updateTitles(ctx);
    await refreshStatusWidget(ctx);
  }

  /** Cleanup on shutdown. */
  function stopAgent(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (inboxWatcher) {
      inboxWatcher.close();
      inboxWatcher = undefined;
    }
  }

  /** Set tmux pane title and window name (no-op without tmux). */
  function updateTitles(ctx: ExtensionContext): void {
    const name = myName ?? "pi";
    const paneTitle = myRoleName ? `${name} (${myRoleName})` : name;

    ctx.ui.setTitle(paneTitle);

    if (myPane) {
      setPaneTitle(myPane, paneTitle);
      if (myTeam) setWindowName(myPane, myTeam);
    }
  }

  /** Load role instructions from roles.json. */
  async function loadRoleInstructions(session: string, roleName: string): Promise<boolean> {
    const role = await getRole(session, roleName);
    if (!role) return false;
    myRoleName = role.name;
    myRole = role.name;
    myRoleInstructions = role.instructions;
    return true;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;

    // Determine session name
    const tmux = await detectTmux();
    mySession = process.env.PMUX_SESSION || tmux?.session || "default";
    myPane = tmux?.pane;

    // Ensure session directory exists
    const config = await readSessionConfig(mySession);
    if (!config.createdAt) {
      config.createdAt = new Date().toISOString();
      if (process.env.PMUX_MODEL && !config.model) {
        config.model = process.env.PMUX_MODEL;
      }
      await writeSessionConfig(mySession, config);
    }

    // Try to recover UUID from pi session entries (reload recovery)
    let recoveredId: string | undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "pmux-agent") {
        recoveredId = (entry.data as { id: string }).id;
      }
    }

    if (recoveredId) {
      // Reload recovery — resume agent
      const agent = await findById(mySession, recoveredId);
      if (agent) {
        myId = agent.id;
        myName = agent.name;
        myRole = agent.role;
        myTeam = agent.team;
        if (agent.roleName) {
          await loadRoleInstructions(mySession, agent.roleName);
        }
        await startAgent(ctx);
        ctx.ui.notify(`pmux: resumed as "${myName}" in session "${mySession}"`, "info");
        return;
      }
    }

    // Auto-register from env vars (config-based flow)
    if (process.env.PMUX_AGENT) {
      const existingName = process.env.PMUX_AGENT;
      const existing = await findByName(mySession, existingName);

      if (existing && existing.status === "offline") {
        // Login as existing agent
        myId = existing.id;
        myName = existing.name;
        myRole = existing.role;
        myTeam = existing.team || process.env.PMUX_TEAM;
        if (existing.roleName) {
          await loadRoleInstructions(mySession, existing.roleName);
        }
      } else if (!existing) {
        // Create new agent
        myId = newAgentId();
        myName = existingName;
        myRole = process.env.PMUX_ROLE || `Agent ${existingName}`;
        myTeam = process.env.PMUX_TEAM;

        const envRoleName = process.env.PMUX_ROLE_NAME;
        if (envRoleName) {
          await loadRoleInstructions(mySession, envRoleName);
        }

        const agent: AgentInfo = {
          id: myId,
          name: myName,
          session: mySession,
          team: myTeam,
          role: myRole,
          roleName: myRoleName,
          cwd: ctx.cwd,
          pane: myPane,
          pid: process.pid,
          status: "online",
          registeredAt: new Date().toISOString(),
          lastHeartbeat: new Date().toISOString(),
        };
        await registerAgent(mySession, agent);
      }

      if (myId) {
        await startAgent(ctx);
        ctx.ui.notify(`pmux: registered as "${myName}" in session "${mySession}"`, "info");
        return;
      }
    }

    // Apply default model
    await applyDefaultModel(ctx);

    // No agent identity yet — wait for /pmux_register or /pmux_login
    ctx.ui.notify(
      `pmux: session "${mySession}". Use /pmux_register or /pmux_login to join.`,
      "info"
    );
  });

  pi.on("session_shutdown", async (event) => {
    stopAgent();

    // Mark offline (unless reloading — keep online for recovery)
    if (event.reason !== "reload" && mySession && myId) {
      await goOffline(mySession, myId).catch(() => {});
    }

    currentCtx = undefined;
  });

  // ── Agent Status Tracking ────────────────────────────────────

  pi.on("agent_start", async () => {
    if (mySession && myId) {
      await updateHeartbeat(mySession, myId).catch(() => {});
    }
  });

  pi.on("agent_end", async () => {
    if (mySession && myId) {
      await updateHeartbeat(mySession, myId).catch(() => {});
      // Clean up .delivered files — messages confirmed processed
      confirmDelivered(mySession, myId);
    }
    if (currentCtx) {
      await refreshStatusWidget(currentCtx);
    }
  });

  // ── System Prompt Injection ──────────────────────────────────

  pi.on("before_agent_start", async (event) => {
    if (!mySession || !myName) return;

    let extra = "";

    // Inject role instructions
    if (myRoleInstructions) {
      extra += `\n\n## Your Role: ${myRoleName}\n${myRoleInstructions}`;
    }

    // Inject project context (CONTEXT.md)
    const projectCtx = readContextFile(projectArtifactsDir());
    if (projectCtx) {
      extra += `\n\n## Project Context\n${projectCtx}`;
    }

    // Inject team context (CONTEXT.md)
    if (myTeam) {
      const teamCtx = readContextFile(teamArtifactsDir(myTeam));
      if (teamCtx) {
        extra += `\n\n## Team "${myTeam}" Context\n${teamCtx}`;
      }
    }

    // Inject available roles summary
    const roles = await readRoles(mySession);
    const roleEntries = Object.values(roles);
    if (roleEntries.length > 0) {
      const roleList = roleEntries
        .map((r) => `- ${r.name}: ${r.instructions.split("\n")[0]?.slice(0, 120) ?? ""}`)
        .join("\n");
      extra += `\n\n## Available Roles\n${roleList}`;
    }

    // Gather online agents
    const onlineAgents = await getOnlineAgents(mySession);
    const sameSessionOthers = onlineAgents.filter((a) => a.id !== myId);

    // Cross-session agents
    const allAgents = await readAllRegistries();
    const crossSessionAgents = allAgents.filter(
      (a) => a.session !== mySession && a.status === "online"
    );

    const hasOthers = sameSessionOthers.length > 0 || crossSessionAgents.length > 0;

    if (!hasOthers && !extra) return;

    if (hasOthers) {
      extra += `\n\n## Multi-Agent Environment (pmux)`;
      extra += `\nYou are agent "${myName}" in session "${mySession}" (full address: ${myAddress()}).`;
      if (myRoleName) extra += `\nRole: ${myRoleName}.`;
      if (myTeam) extra += `\nTeam: ${myTeam}.`;

      if (sameSessionOthers.length > 0) {
        const list = sameSessionOthers
          .map((a) => {
            const parts = [a.team, a.roleName || a.role, a.name].filter(Boolean);
            return `  - ${a.name} (${formatAddress(a.session, a.name)}): ${parts.join(":")} [${a.status}]`;
          })
          .join("\n");
        extra += `\n\nSame-session agents (address as "${mySession}/<name>" or just "<name>"):\n${list}`;
      }

      if (crossSessionAgents.length > 0) {
        const list = crossSessionAgents
          .map((a) => {
            const parts = [a.team, a.roleName || a.role, a.name].filter(Boolean);
            return `  - ${formatAddress(a.session, a.name)}: ${parts.join(":")} [${a.status}]`;
          })
          .join("\n");
        extra += `\nCross-session agents (must use full address "session/name"):\n${list}`;
      }

      extra += `\n
### Addressing
- Same-session agents: use just the name (e.g., "backend") or full address ("${mySession}/backend")
- Cross-session agents: always use the full address ("othersession/agentname")

### Communication
- Use pmux_send to delegate tasks or ask questions to other agents.
- Use pmux_list to refresh the list of available agents (set allSessions=true for cross-session).
- Messages from other agents appear as "[pmux:session/agent (role)] message".
- When you receive a [pmux:...] message, treat it as a request from a teammate and respond helpfully.
- Reply using pmux_send with the sender's address.`;
    }

    // Artifact paths — always include when agent has identity
    if (myId) {
      extra += `\n\n### Shared Artifacts\nRead and write shared documents using the standard read/write/edit tools.`;
      extra += `\n- Project (all agents): ${projectArtifactsDir()}`;
      if (myTeam) extra += `\n- Team "${myTeam}" (team members): ${teamArtifactsDir(myTeam)}`;
      extra += `\n- Private (you only): ${agentArtifactsDir(myId)}`;
    }

    return { systemPrompt: event.systemPrompt + extra };
  });

  // ── Tools ────────────────────────────────────────────────────

  // ─ pmux_role ─────────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_role",
    label: "Manage Roles",
    description:
      "Add, list, or remove role definitions for the current pmux session. " +
      "Roles define a name and instructions that shape an agent's behavior. " +
      "Agents register with a role using /pmux_register.",
    promptSnippet: "Add, list, or remove pmux role definitions",
    promptGuidelines: [
      "Use pmux_role to define roles before agents register with /pmux_register.",
      "Each pmux_role has a name and instructions that guide the agent's behavior.",
    ],
    parameters: Type.Object({
      action: StringEnum(["add", "list", "remove"] as const),
      name: Type.Optional(
        Type.String({ description: 'Role name (required for "add" and "remove")' })
      ),
      instructions: Type.Optional(
        Type.String({
          description:
            'Instructions for the role — what the agent should do, focus on, and how to behave (required for "add")',
        })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("pmux session not active");

      switch (params.action) {
        case "add": {
          if (!params.name) throw new Error("Role name is required for add.");
          if (!params.instructions) throw new Error("Instructions are required for add.");
          await addRole(mySession, { name: params.name, instructions: params.instructions });
          return {
            content: [{ type: "text", text: `Role "${params.name}" added. Agents can register with: /pmux_register` }],
            details: { role: { name: params.name, instructions: params.instructions } },
          };
        }
        case "list": {
          const roles = await readRoles(mySession);
          const entries = Object.values(roles);
          if (entries.length === 0) {
            return {
              content: [{ type: "text", text: "No roles defined. Use pmux_role with action=add to create one." }],
              details: { roles: [] },
            };
          }
          const lines = entries.map(
            (r) => `- ${r.name}: ${r.instructions.slice(0, 120)}${r.instructions.length > 120 ? "…" : ""}`
          );
          return { content: [{ type: "text", text: lines.join("\n") }], details: { roles: entries } };
        }
        case "remove": {
          if (!params.name) throw new Error("Role name is required for remove.");
          const removed = await removeRole(mySession, params.name);
          if (!removed) throw new Error(`Role "${params.name}" not found.`);
          return { content: [{ type: "text", text: `Role "${params.name}" removed.` }], details: {} };
        }
        default:
          throw new Error(`Unknown action: ${params.action}`);
      }
    },
  });

  // ─ pmux_list ─────────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_list",
    label: "List Agents",
    description:
      "List online pmux agents with their session, name, role, team, and status. " +
      "Set allSessions=true to include agents from other sessions.",
    promptSnippet: "List online pmux agents and their roles/status (supports cross-session discovery)",
    parameters: Type.Object({
      allSessions: Type.Optional(
        Type.Boolean({ description: "If true, list agents from all sessions. Default: false." })
      ),
    }),

    async execute(_id, params) {
      if (!mySession) throw new Error("pmux session not active");

      let agents: AgentInfo[];
      if (params.allSessions) {
        agents = (await readAllRegistries()).filter((a) => a.status === "online");
      } else {
        agents = await getOnlineAgents(mySession);
      }

      if (agents.length === 0) {
        return { content: [{ type: "text", text: "No agents online." }], details: { agents: [] } };
      }

      // Group by session
      const bySession = new Map<string, AgentInfo[]>();
      for (const a of agents) {
        const sess = a.session || mySession;
        if (!bySession.has(sess)) bySession.set(sess, []);
        bySession.get(sess)!.push(a);
      }

      const sections: string[] = [];
      for (const [session, sessionAgents] of bySession) {
        const isCurrent = session === mySession;
        const header = isCurrent ? `Session: ${session} (current)` : `Session: ${session}`;
        const lines = sessionAgents.map((a) => {
          const isMe = a.id === myId;
          const marker = isMe ? " (you)" : "";
          const addr = formatAddress(session, a.name);
          const label = [a.team, a.roleName, a.name].filter(Boolean).join(":");
          return `  - ${addr}${marker} [${a.status}]: ${label} (cwd: ${a.cwd})`;
        });
        sections.push(`${header}\n${lines.join("\n")}`);
      }

      return { content: [{ type: "text", text: sections.join("\n\n") }], details: { agents } };
    },
  });

  // ─ pmux_send ─────────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_send",
    label: "Send to Agent",
    description:
      'Send a message to another pmux agent. Use "name" for same-session or "session/name" for cross-session. ' +
      "Delivered to the agent's inbox — works even if they're busy or offline.",
    promptSnippet: "Send a message to a pmux agent by name or session/name address",
    promptGuidelines: [
      "Use pmux_list first to see which agents are available before using pmux_send.",
      "When using pmux_send, be specific about what you need from the other agent.",
      'For cross-session agents, use the full address in pmux_send: "session/name".',
      "After using pmux_send, do not wait — continue with your own work unless you need their response first.",
    ],
    parameters: Type.Object({
      to: Type.String({ description: '"name" for same session, or "session/name" for cross-session' }),
      message: Type.String({ description: "Message or instruction to send" }),
    }),

    async execute(_id, params) {
      if (!mySession || !myId || !myName) {
        throw new Error("Not registered. Use /pmux_register or /pmux_login first.");
      }

      const target = await resolveAgent(params.to, mySession);
      if (!target) {
        const all = await readAllRegistries();
        const online = all.filter((a) => a.status === "online" && a.id !== myId);
        const available = online.map((a) => formatAddress(a.session, a.name)).join(", ");
        throw new Error(`Agent "${params.to}" not found. Available: ${available || "none"}`);
      }

      if (target.id === myId) throw new Error("Cannot send a message to yourself.");

      const msg: InboxMessage = {
        id: newMessageId(),
        from: myId,
        fromName: myName,
        fromRole: myRoleName,
        fromSession: mySession,
        timestamp: new Date().toISOString(),
        message: params.message,
      };

      sendToInbox(target.session, target.id, msg);

      const targetAddr = formatAddress(target.session, target.name);
      return {
        content: [{ type: "text", text: `Message sent to ${targetAddr} (${target.roleName || target.role}).` }],
        details: { to: targetAddr, targetId: target.id },
      };
    },
  });

  // ─ pmux_broadcast ────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_broadcast",
    label: "Broadcast",
    description:
      "Send a message to all other online agents. Set allSessions=true for cross-session. " +
      "Use sparingly — prefer targeted pmux_send.",
    promptSnippet: "Broadcast a message to online pmux agents",
    parameters: Type.Object({
      message: Type.String({ description: "Message to broadcast" }),
      allSessions: Type.Optional(
        Type.Boolean({ description: "Broadcast to all sessions. Default: false." })
      ),
    }),

    async execute(_id, params) {
      if (!mySession || !myId || !myName) {
        throw new Error("Not registered. Use /pmux_register or /pmux_login first.");
      }

      let agents: AgentInfo[];
      if (params.allSessions) {
        agents = (await readAllRegistries()).filter((a) => a.status === "online");
      } else {
        agents = await getOnlineAgents(mySession);
      }

      const others = agents.filter((a) => a.id !== myId);
      if (others.length === 0) throw new Error("No other agents online.");

      const errors: string[] = [];
      for (const agent of others) {
        try {
          const msg: InboxMessage = {
            id: newMessageId(),
            from: myId,
            fromName: myName,
            fromRole: myRoleName,
            fromSession: mySession,
            timestamp: new Date().toISOString(),
            message: params.message,
          };
          sendToInbox(agent.session, agent.id, msg);
        } catch (err) {
          errors.push(`${agent.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      const recipients = others.map((a) => formatAddress(a.session, a.name));
      let text = `Broadcast sent to ${recipients.length} agent(s): ${recipients.join(", ")}`;
      if (errors.length > 0) text += `\nFailed: ${errors.join("; ")}`;

      return { content: [{ type: "text", text }], details: { recipients, errors } };
    },
  });

  // ─ pmux_artifacts ────────────────────────────────────────────

  pi.registerTool({
    name: "pmux_artifacts",
    label: "List Artifacts",
    description:
      "List shared documents at project, team, and agent levels. " +
      "Use read/write/edit tools to work with the files directly.",
    promptSnippet: "List shared artifacts at project, team, or agent level",
    parameters: Type.Object({}),

    async execute() {
      if (!mySession || !myId) {
        throw new Error("Not registered. Use /pmux_register or /pmux_login first.");
      }

      const sections: string[] = [];

      // Project level
      const projDir = projectArtifactsDir();
      const projFiles = listFiles(projDir);
      sections.push(`Project (${projDir}):\n` +
        (projFiles.length > 0 ? projFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"));

      // Team level
      if (myTeam) {
        const tDir = teamArtifactsDir(myTeam);
        const tFiles = listFiles(tDir);
        sections.push(`Team \"${myTeam}\" (${tDir}):\n` +
          (tFiles.length > 0 ? tFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"));
      }

      // Agent level
      const aDir = agentArtifactsDir(myId);
      const aFiles = listFiles(aDir);
      sections.push(`Private (${aDir}):\n` +
        (aFiles.length > 0 ? aFiles.map((f) => `  - ${f}`).join("\n") : "  (empty)"));

      return {
        content: [{ type: "text", text: sections.join("\n\n") }],
        details: { project: projFiles, team: myTeam ? listFiles(teamArtifactsDir(myTeam)) : [], agent: aFiles },
      };
    },
  });

  // ── Commands ─────────────────────────────────────────────────

  // ─ /pmux — status ────────────────────────────────────────────

  pi.registerCommand("pmux", {
    description: "Show pmux status ('/pmux all' for cross-session)",
    handler: async (args, ctx) => {
      if (!mySession) {
        ctx.ui.notify("pmux session not active", "warning");
        return;
      }

      const showAll = args.trim() === "all";
      let agents: AgentInfo[];
      if (showAll) {
        agents = (await readAllRegistries()).filter((a) => a.status === "online");
      } else {
        agents = await getOnlineAgents(mySession);
      }

      const identity = myId
        ? `you: ${myAddress()} (${myRoleName || "no role"})`
        : "not registered";

      const lines = agents.map((a) => {
        const isMe = a.id === myId;
        const marker = isMe ? " ◆" : "";
        const addr = formatAddress(a.session, a.name);
        const label = [a.team, a.roleName].filter(Boolean).join(":");
        return `${addr}${marker} [${a.status}] ${label || a.role}`;
      });

      const header = showAll
        ? `pmux: all sessions (${identity})`
        : `pmux: ${mySession} (${identity})`;

      ctx.ui.notify(`${header}\n${lines.join("\n") || "(no agents online)"}`, "info");
    },
  });

  // ─ /pmux_register — create new agent ─────────────────────────

  pi.registerCommand("pmux_register", {
    description: "Create a new agent with name, team, and role (interactive)",
    handler: async (_args, ctx) => {
      if (!mySession) {
        ctx.ui.notify("pmux session not active", "warning");
        return;
      }

      // 1. Check roles exist
      const roles = await readRoles(mySession);
      const roleNames = Object.keys(roles);
      if (roleNames.length === 0) {
        ctx.ui.notify(
          "No roles defined yet.\n\nAsk the LLM to create roles first, e.g.:\n" +
            '> Create a pmux role called "developer" with instructions to write clean code.',
          "warning"
        );
        return;
      }

      // 2. Agent name
      const name = await ctx.ui.input("Agent name:", myName);
      if (!name) { ctx.ui.notify("Cancelled.", "info"); return; }

      // 3. Team
      let team: string | undefined;
      const registry = await readRegistry(mySession);
      const existingTeams = [...new Set(
        Object.values(registry).map((a) => a.team).filter((t): t is string => !!t)
      )];

      if (existingTeams.length > 0) {
        const CREATE_NEW = "+ Create new team";
        const choice = await ctx.ui.select("Team:", [...existingTeams, CREATE_NEW]);
        if (!choice) { ctx.ui.notify("Cancelled.", "info"); return; }
        team = choice === CREATE_NEW
          ? await ctx.ui.input("New team name:")
          : choice;
        if (!team) { ctx.ui.notify("Cancelled.", "info"); return; }
      } else {
        team = await ctx.ui.input("Team name:", myTeam);
        if (!team) { ctx.ui.notify("Cancelled.", "info"); return; }
      }

      // 4. Role
      const roleName = await ctx.ui.select("Choose a role:", roleNames);
      if (!roleName) { ctx.ui.notify("Cancelled.", "info"); return; }
      const role = roles[roleName]!;

      // 5. If replacing an existing identity, go offline first
      if (myId && mySession) {
        await goOffline(mySession, myId);
      }

      // 6. Create new agent
      myId = newAgentId();
      myName = name;
      myTeam = team;
      myRoleName = role.name;
      myRole = role.name;
      myRoleInstructions = role.instructions;

      const agent: AgentInfo = {
        id: myId,
        name: myName,
        session: mySession,
        team: myTeam,
        role: role.name,
        roleName: role.name,
        cwd: ctx.cwd,
        pane: myPane,
        pid: process.pid,
        status: "online",
        registeredAt: new Date().toISOString(),
        lastHeartbeat: new Date().toISOString(),
      };
      await registerAgent(mySession, agent);

      await startAgent(ctx);

      ctx.ui.notify(
        `Registered as "${myName}" in team "${team}" with role "${role.name}".`,
        "info"
      );
    },
  });

  // ─ /pmux_login — resume existing agent ───────────────────────

  pi.registerCommand("pmux_login", {
    description: "Log in as an existing offline agent",
    handler: async (_args, ctx) => {
      if (!mySession) {
        ctx.ui.notify("pmux session not active", "warning");
        return;
      }

      const offline = await getOfflineAgents(mySession);
      if (offline.length === 0) {
        ctx.ui.notify(
          "No offline agents to log in as.\nUse /pmux_register to create a new agent.",
          "info"
        );
        return;
      }

      // Build selection list
      const options = offline.map((a) => {
        const parts = [a.team, a.roleName, a.name].filter(Boolean).join(":");
        return `${a.name} — ${parts}`;
      });

      const choice = await ctx.ui.select("Log in as:", options);
      if (!choice) { ctx.ui.notify("Cancelled.", "info"); return; }

      // Find the selected agent
      const selectedName = choice.split(" — ")[0]!;
      const agent = offline.find((a) => a.name === selectedName);
      if (!agent) { ctx.ui.notify("Agent not found.", "error"); return; }

      // If replacing an existing identity, go offline first
      if (myId && mySession && myId !== agent.id) {
        await goOffline(mySession, myId);
      }

      // Resume as this agent
      myId = agent.id;
      myName = agent.name;
      myRole = agent.role;
      myTeam = agent.team;
      myRoleName = agent.roleName;
      if (agent.roleName) {
        await loadRoleInstructions(mySession, agent.roleName);
      }

      // Update pane and go online
      await updateAgent(mySession, myId, { pane: myPane, cwd: ctx.cwd });
      await startAgent(ctx);

      // Check for pending messages
      const pending = getRecoverableMessages(mySession, myId);
      const pendingNote = pending.length > 0 ? ` ${pending.length} message(s) waiting.` : "";

      ctx.ui.notify(
        `Logged in as "${myName}" (${myRoleName || "no role"}).${pendingNote}`,
        "info"
      );
    },
  });

  // ── Helpers ──────────────────────────────────────────────────

  // ── Artifacts ────────────────────────────────────────────────

  const PMUX_BASE = join(homedir(), ".pmux", "sessions");

  function projectArtifactsDir(): string {
    return join(PMUX_BASE, mySession!, "artifacts", "project");
  }

  function teamArtifactsDir(team: string): string {
    return join(PMUX_BASE, mySession!, "artifacts", "teams", team);
  }

  function agentArtifactsDir(agentId: string): string {
    return join(PMUX_BASE, mySession!, "artifacts", "agents", agentId);
  }

  function ensureArtifactDirs(): void {
    if (!mySession || !myId) return;
    mkdirSync(projectArtifactsDir(), { recursive: true });
    if (myTeam) mkdirSync(teamArtifactsDir(myTeam), { recursive: true });
    mkdirSync(agentArtifactsDir(myId), { recursive: true });
  }

  function listFiles(dir: string): string[] {
    try {
      return readdirSync(dir).filter((f) => !f.startsWith("."));
    } catch {
      return [];
    }
  }

  const MAX_CONTEXT_SIZE = 4096;

  /** Read a CONTEXT.md file if it exists, with size guard. */
  function readContextFile(dir: string): string | null {
    const path = join(dir, "CONTEXT.md");
    if (!existsSync(path)) return null;
    try {
      let content = readFileSync(path, "utf8").trim();
      if (content.length > MAX_CONTEXT_SIZE) {
        content = content.slice(0, MAX_CONTEXT_SIZE) + `\n\n[truncated — see full file at ${path}]`;
      }
      return content || null;
    } catch {
      return null;
    }
  }

  async function applyDefaultModel(ctx: ExtensionContext): Promise<void> {
    const modelStr = process.env.PMUX_MODEL;
    if (!modelStr) {
      if (mySession) {
        const config = await readSessionConfig(mySession);
        if (config.model) await trySetModel(ctx, config.model);
      }
      return;
    }
    await trySetModel(ctx, modelStr);
  }

  async function trySetModel(ctx: ExtensionContext, modelStr: string): Promise<void> {
    let found = false;

    if (modelStr.includes("/")) {
      const [provider, id] = modelStr.split("/", 2);
      const model = ctx.modelRegistry.find(provider!, id!);
      if (model) found = !!(await pi.setModel(model));
    }

    if (!found) {
      for (const provider of ["anthropic", "openai", "google", "local-openai"]) {
        const model = ctx.modelRegistry.find(provider, modelStr);
        if (model) {
          found = !!(await pi.setModel(model));
          if (found) break;
        }
      }
    }

    if (!found) {
      ctx.ui.notify(`pmux: model "${modelStr}" not found — using default`, "warning");
    }
  }

  async function refreshStatusWidget(ctx: ExtensionContext): Promise<void> {
    if (!mySession) return;

    try {
      const agents = await getOnlineAgents(mySession);
      const theme = ctx.ui.theme;
      const sessionLabel = theme.fg("dim", `[${mySession}] `);

      if (agents.length === 0) {
        ctx.ui.setStatus("pmux", sessionLabel + theme.fg("dim", "no agents"));
        return;
      }

      const parts = agents.map((a) => {
        const icon = a.id === myId ? "◆" : "○";
        const color: "accent" | "success" = a.id === myId ? "accent" : "success";
        const label = [a.team, a.roleName, a.name].filter(Boolean).join(":");
        return theme.fg(color, `${icon} ${label}`);
      });

      ctx.ui.setStatus("pmux", sessionLabel + parts.join(theme.fg("dim", " │ ")));
    } catch {
      // Ignore widget errors
    }
  }
}
