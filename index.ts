#!/usr/bin/env node

/*  Multi‑Agent Debate Server
 *  -------------------------
 *  Lets multiple "personas" argue, rebut, and judge a claim in
 *  structured rounds.  See the TOOL description below for usage.
 */
import crypto from "crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import chalk from "chalk";

/* ---------- INTERNAL TYPES & STATE ---------- */

type Action = "register" | "argue" | "rebut" | "judge";

interface DebateData {
  agentId: string;           // e.g., "pro", "con", "judge"
  round: number;             // 1‑based debate round
  action: Action;
  content?: string;          // argument text or verdict
  targetAgentId?: string;    // who is being rebutted (optional)
  needsMoreRounds: boolean;
}

interface ArgumentRecord {
  agentId: string;
  round: number;
  action: Action;
  content: string;
  targetAgentId?: string;
  ts: number;
}

interface Verdict {
  for: string;    // e.g., "pro", "con", or "inconclusive"
  rationale: string;
  round: number;
}

/* ---------- SERVER IMPLEMENTATION ---------- */
/* One instance per MCP session — never shared across sessions. */

class MultiAgentDebateServer {
  private history: ArgumentRecord[] = [];
  private agents: Set<string> = new Set();
  private verdict?: Verdict;

  /* ---- 1. Validation & Normalisation ---- */
  private validate(input: unknown): DebateData {
    const data = input as Record<string, unknown>;

    if (!data.agentId || typeof data.agentId !== "string") {
      throw new Error("agentId must be a string");
    }
    if (!data.round || typeof data.round !== "number" || data.round < 1) {
      throw new Error("round must be a positive integer");
    }
    if (!data.action || typeof data.action !== "string") {
      throw new Error("action missing");
    }
    const action = data.action as Action;
    if (!["register", "argue", "rebut", "judge"].includes(action)) {
      throw new Error(`unknown action: ${action}`);
    }
    if (typeof data.needsMoreRounds !== "boolean") {
      throw new Error("needsMoreRounds must be boolean");
    }
    if (
      action === "rebut" &&
      (!data.targetAgentId || typeof data.targetAgentId !== "string")
    ) {
      throw new Error("targetAgentId is required for action:\"rebut\"");
    }

    return {
      agentId: data.agentId,
      round: data.round,
      action,
      content: data.content as string | undefined,
      targetAgentId: data.targetAgentId as string | undefined,
      needsMoreRounds: data.needsMoreRounds,
    };
  }

  /* ---- 2. Pretty console output ---- */
  private logRecord(rec: ArgumentRecord) {
    const colour =
      rec.action === "judge"
        ? chalk.yellow
        : rec.agentId === "pro"
          ? chalk.green
          : rec.agentId === "con"
            ? chalk.red
            : chalk.cyan;

    const header = `${colour(
      `[${rec.action.toUpperCase()}]`
    )} ${rec.agentId} (round ${rec.round})${rec.targetAgentId ? ` → ${rec.targetAgentId}` : ""
      }`;

    // Content may be multi-line; pad each line independently so the
    // box actually stays a box instead of going ragged.
    const contentLines = rec.content.split("\n");
    const innerWidth = Math.max(
      header.length,
      ...contentLines.map((l) => l.length)
    );
    const border = "─".repeat(innerWidth + 2);

    const renderedLines = contentLines
      .map((l) => `│ ${l.padEnd(innerWidth)} │`)
      .join("\n");

    console.error(`
┌${border}┐
│ ${header.padEnd(innerWidth)} │
├${border}┤
${renderedLines}
└${border}┘
`);
  }

  /* ---- 3. Main processing ---- */
  public process(input: unknown) {
    try {
      const d = this.validate(input);

      if (d.action === "register") {
        this.agents.add(d.agentId);
      } else {
        if (!this.agents.has(d.agentId)) {
          throw new Error(
            `agent ${d.agentId} is not registered – call action:"register" first`
          );
        }
        if (!d.content || d.content.trim() === "") {
          throw new Error("content required for this action");
        }
        if (d.targetAgentId && !this.agents.has(d.targetAgentId)) {
          throw new Error(
            `targetAgentId "${d.targetAgentId}" is not a registered agent`
          );
        }

        /* store history */
        const rec: ArgumentRecord = {
          agentId: d.agentId,
          round: d.round,
          action: d.action,
          content: d.content,
          targetAgentId: d.targetAgentId,
          ts: Date.now(),
        };
        this.history.push(rec);
        this.logRecord(rec);

        /* if judge, record verdict */
        if (d.action === "judge") {
          this.verdict = {
            for: d.content!.split("\n")[0].trim(), // first line: winner / inconclusive
            rationale: d.content!,
            round: d.round,
          };
        }
      }

      /* ---- 4. JSON response to caller ---- */
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                agents: Array.from(this.agents),
                totalArguments: this.history.length,
                lastAction: d.action,
                verdict: this.verdict ?? null,
                needsMoreRounds: d.needsMoreRounds,
              },
              null,
              2
            ),
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { error: err instanceof Error ? err.message : String(err) },
              null,
              2
            ),
          },
        ],
        isError: true,
      };
    }
  }
}

/* ---------- MCP TOOL DEFINITION ---------- */

const MULTI_AGENT_DEBATE_TOOL: Tool = {
  name: "multiagentdebate",
  description: `Structured multi‑persona debate tool.

Call sequence (typical):
1. Each persona registers once with action:"register".
2. Personas alternate action:"argue" (fresh point) or "rebut" (counter a targetAgentId).
3. A special persona (or either side) issues action:"judge" with a verdict text
   (first line should be "pro", "con", or "inconclusive").
4. Set needsMoreRounds:false only when the debate is finished and a verdict stands.

Parameters:
- agentId (string)            : "pro", "con", "judge", or any custom ID
- round (int ≥1)              : Debate round number
- action (string)             : "register" | "argue" | "rebut" | "judge"
- content (string, optional)  : Argument text or verdict
- targetAgentId (string opt.) : Agent being rebutted (required for action:"rebut")
- needsMoreRounds (boolean)   : True if additional debate rounds desired`,
  inputSchema: {
    type: "object",
    properties: {
      agentId: { type: "string" },
      round: { type: "integer", minimum: 1 },
      action: { type: "string", enum: ["register", "argue", "rebut", "judge"] },
      content: { type: "string" },
      targetAgentId: { type: "string" },
      needsMoreRounds: { type: "boolean" },
    },
    required: ["agentId", "round", "action", "needsMoreRounds"],
  },
};

/* ---------- PER-SESSION WIRING ---------- */

interface SessionEntry {
  transport: StreamableHTTPServerTransport;
  mcpServer: Server;
  debateServer: MultiAgentDebateServer;
  lastSeen: number;
}

const sessions: Record<string, SessionEntry> = {};

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes idle timeout
const SWEEP_INTERVAL_MS = 5 * 60 * 1000; // sweep every 5 minutes

function createMcpServerForSession(debateServer: MultiAgentDebateServer): Server {
  const mcpServer = new Server(
    {
      name: "multi-agent-debate-server",
      version: "0.2.0",
    },
    {
      capabilities: { tools: {} },
    }
  );

  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [MULTI_AGENT_DEBATE_TOOL],
  }));

  mcpServer.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name === "multiagentdebate") {
      return debateServer.process(req.params.arguments);
    }
    return {
      content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
      isError: true,
    };
  });

  return mcpServer;
}

/* Idle-session sweep: cleans up sessions that were never explicitly
 * deleted (client crashed, network dropped, browser closed, etc). */
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, entry] of Object.entries(sessions)) {
    if (now - entry.lastSeen > SESSION_TTL_MS) {
      console.log(`Sweeping idle session: ${sessionId}`);
      try {
        entry.transport.close?.();
      } catch (err) {
        console.error(`Error closing transport for ${sessionId}:`, err);
      }
      delete sessions[sessionId];
    }
  }
}, SWEEP_INTERVAL_MS);

/* ---------- HTTP BOOT ---------- */

const app = express();

app.use(express.json());

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let entry: SessionEntry;

    if (sessionId && sessions[sessionId]) {
      entry = sessions[sessionId];
      entry.lastSeen = Date.now();
      console.log(`Using existing session: ${sessionId}`);
    } else {
      // Fresh session: every session gets its own debate state.
      const debateServer = new MultiAgentDebateServer();
      const mcpServer = createMcpServerForSession(debateServer);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (newSessionId) => {
          console.log(`Session initialized: ${newSessionId}`);
          sessions[newSessionId] = {
            transport,
            mcpServer,
            debateServer,
            lastSeen: Date.now(),
          };
        },
      });

      console.log("Connecting MCP server...");
      await mcpServer.connect(transport);

      // entry is only used below for the immediate request; the real
      // bookkeeping happens in onsessioninitialized once the SDK
      // assigns the session id.
      entry = { transport, mcpServer, debateServer, lastSeen: Date.now() };
    }

    await entry.transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("POST /mcp error:", error);
    console.error(error);

    res.status(500).json({
      error: error instanceof Error ? error.stack : String(error),
    });
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !sessions[sessionId]) {
    res.status(400).send("Mcp-Session-Id header is required");
    return;
  }

  sessions[sessionId].lastSeen = Date.now();
  await sessions[sessionId].transport.handleRequest(req, res);
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && sessions[sessionId]) {
    try {
      sessions[sessionId].transport.close?.();
    } catch (err) {
      console.error(`Error closing transport for ${sessionId}:`, err);
    }
    delete sessions[sessionId];
    console.log(`Deleted session: ${sessionId}`);
  }

  res.status(200).send("Session Deleted");
});

const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Multi-Agent Debate MCP running on port ${PORT}`);
});