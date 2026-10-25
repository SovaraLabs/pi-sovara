import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

// A real stdio MCP server with controlled, independently counted execution.
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.id === undefined) continue;
  let result = {};
  if (request.method === "initialize")
    result = {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "controlled-fixture", version: "1" },
    };
  if (request.method === "tools/list")
    result = {
      tools: [
        {
          name: "lookup",
          description: "Controlled fixture lookup",
          inputSchema: {
            type: "object",
            properties: { fail: { type: "boolean" } },
          },
        },
      ],
    };
  if (request.method === "tools/call") {
    appendFileSync(
      process.argv[2],
      JSON.stringify({ method: request.method, name: request.params.name }) +
        "\n",
    );
    result = {
      content: [
        {
          type: "text",
          text: request.params.arguments?.fail
            ? "Controlled MCP error result"
            : "Controlled MCP success",
        },
      ],
      isError: request.params.arguments?.fail === true,
    };
  }
  if (request.method === "resources/list")
    result = {
      resources: [
        {
          uri: "fixture://evidence",
          name: "Controlled evidence",
          mimeType: "text/plain",
        },
      ],
    };
  if (request.method === "resources/templates/list")
    result = { resourceTemplates: [] };
  if (request.method === "resources/read") {
    appendFileSync(
      process.argv[2],
      JSON.stringify({ method: request.method }) + "\n",
    );
    result = {
      contents: [
        {
          uri: request.params.uri,
          mimeType: "text/plain",
          text: "Controlled resource evidence",
        },
      ],
    };
  }
  process.stdout.write(
    JSON.stringify({ jsonrpc: "2.0", id: request.id, result }) + "\n",
  );
}
