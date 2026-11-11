import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { CareerError } from "@/lib/career/store";
import { toolDefinitions, type CareerToolName, type createCareerTools } from "./career-tools";

export async function startCareerMcpServer(tools: ReturnType<typeof createCareerTools>) {
  const token = randomBytes(32).toString("hex");
  const transports = new Set<StreamableHTTPServerTransport>();
  const server = createServer(async (request, response) => {
    const given = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) { response.writeHead(401).end(); return; }
    if (request.url !== "/mcp" || request.method !== "POST") { response.writeHead(405).end(); return; }
    if (Number(request.headers["content-length"] ?? 0) > 512 * 1024) { response.writeHead(413).end(); return; }
    const mcp = new McpServer({ name: "tracefolio-career", version: "1.0.0" });
    for (const name of Object.keys(toolDefinitions) as CareerToolName[]) {
      const definition = toolDefinitions[name];
      mcp.registerTool(name, {
        description: definition.description,
        inputSchema: definition.schema,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      }, async (args: unknown) => {
        try {
          return { content: [{ type: "text" as const, text: JSON.stringify(await tools.call(name, args)) }] };
        } catch (error) {
          const message = error instanceof CareerError ? error.message : error instanceof z.ZodError ? "工具参数不符合约定，请核对提案字段和长度。" : "工具暂时无法完成，请停止本次任务。";
          return { isError: true, content: [{ type: "text" as const, text: message }] };
        }
      });
    }
    const listener = server.address();
    const host = listener && typeof listener !== "string" ? `127.0.0.1:${listener.port}` : "127.0.0.1";
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, allowedHosts: [host], enableDnsRebindingProtection: true });
    transports.add(transport);
    response.on("close", () => { transports.delete(transport); void mcp.close().catch(() => {}); });
    try { await mcp.connect(transport); await transport.handleRequest(request, response); }
    catch { if (!response.headersSent) response.writeHead(500).end(); else response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("MCP listener unavailable");
  return {
    url: `http://127.0.0.1:${address.port}/mcp`, token,
    async close() {
      await Promise.allSettled([...transports].map((transport) => transport.close()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
