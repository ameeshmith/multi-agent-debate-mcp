#!/usr/bin/env node

/*  Multi‑Agent Debate Server
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
    const border = "─".repeat(Math.max(header.length, rec.content.length) + 4);

    console.error(`
┌${border}┐
│ ${header.padEnd(border.length - 2)} │
├${border}┤
│ ${rec.content.padEnd(border.length - 2)} │
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
- targetAgentId (string opt.) : Agent being rebutted (only for action:"rebut")
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

/* ---------- MCP SERVER WIRING ---------- */

const server = new Server(
  {
    name: "multi-agent-debate-server",
    version: "0.1.0",
  },
  {
    capabilities: { tools: {} },
  }
);

const debateServer = new MultiAgentDebateServer();

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [MULTI_AGENT_DEBATE_TOOL],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "multiagentdebate") {
    return debateServer.process(req.params.arguments);
  }
  return {
    content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }],
    isError: true,
  };
});

/* ---------- HTTP BOOT ---------- */

const app = express();

app.use(express.json());

const transports: Record<string, StreamableHTTPServerTransport> = {};

app.post("/mcp", async (req, res) => {
  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      transport = transports[sessionId];
      console.log(`Using existing session: ${sessionId}`);
    } else {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        onsessioninitialized: (sessionId) => {
          console.log(`Session initialized: ${sessionId}`);
          transports[sessionId] = transport;
        },
      });

      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error("POST /mcp error:", error);
    res.status(500).send("MCP Error");
  }
});

app.get("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Mcp-Session-Id header is required");
    return;
  }

  await transports[sessionId].handleRequest(req, res);
  return;
});

app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  if (sessionId && transports[sessionId]) {
    delete transports[sessionId];
    console.log(`Deleted session: ${sessionId}`);
  }

  res.status(200).send("Session Deleted");
});


const PORT = process.env.PORT || 3001;

app.listen(PORT, () => {
  console.log(`Multi-Agent Debate MCP running on port ${PORT}`);
});