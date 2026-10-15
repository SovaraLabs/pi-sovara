import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

export interface LessonBridge {
  url: string;
  token: string;
  close(): Promise<void>;
}

/** A real MCP transport with one capability: retrieve from the active recording's project. */
export async function startLessonBridge(
  retrieve: (
    context: string,
    signal: AbortSignal,
  ) => Promise<Record<string, unknown>>,
): Promise<LessonBridge> {
  const token = randomBytes(32).toString("hex");
  const active = new Set<McpServer>();
  let server: Server;
  server = createServer(async (request, response) => {
    if (
      request.url !== "/mcp" ||
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers.origin
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const mcp = new McpServer({ name: "sovara-pi-lessons", version: "0.1.0" });
    active.add(mcp);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    mcp.registerTool(
      "retrieve",
      {
        description:
          "Retrieve relevant lessons from the Sovara project bound to this Pi session. Describe the task and current evidence. Project selection is automatic and cannot be changed by this tool.",
        inputSchema: { context: z.string().trim().min(1).max(128000) },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async ({ context }, extra) => {
        try {
          const result = await retrieve(context, extra.signal);
          return {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: "Sovara retrieval failed. Continue without lessons; do not repeatedly retry this step.",
              },
            ],
          };
        }
      },
    );
    response.on("close", () => {
      active.delete(mcp);
      void mcp.close();
    });
    try {
      await mcp.connect(transport);
      await transport.handleRequest(request, response);
    } catch {
      if (!response.headersSent) response.writeHead(500).end();
      else response.end();
      active.delete(mcp);
      await mcp.close();
    }
  });
  server.requestTimeout = 20000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Could not start Sovara MCP adapter");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    token,
    async close() {
      await Promise.allSettled([...active].map((mcp) => mcp.close()));
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
