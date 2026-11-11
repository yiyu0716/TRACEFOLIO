import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { bridgeMessages, bridgeTools, startModelBridge } from "./model-bridge";
import { runCodexTailoring } from "./codex-app-server";
import { createCareerTools } from "@/lib/tasks/career-tools";
import { startCareerMcpServer } from "@/lib/tasks/mcp-server";
import { testProposal, testSnapshot } from "@/lib/tasks/test-fixtures";

afterEach(() => vi.unstubAllGlobals());
const nativeFetch = globalThis.fetch;
describe("Codex model protocol adapter", () => {
  it("rejects unsupported native tools and images rather than dropping them", () => {
    expect(() => bridgeTools([{ type: "web_search" }])).toThrow();
    expect(() =>
      bridgeMessages(
        {
          input: [
            {
              role: "user",
              content: [{ type: "input_image", image_url: "private" }],
            },
          ],
        },
        [],
        new Map(),
      ),
    ).toThrow();
  });
  it("requires its per-run token and retains original provider credentials", async () => {
    const observed: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        observed.push(new Headers(init.headers).get("Authorization")!);
        return Response.json({
          id: "fake",
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }),
    );
    const bridge = await startModelBridge({
      apiKey: "private-byok",
      model: "fake",
      baseUrl: "https://fake.invalid/v1",
      timeoutMs: 1000,
    });
    try {
      expect(
        (
          await nativeFetch(`${bridge.baseUrl}/responses`, {
            method: "POST",
            body: "{}",
          })
        ).status,
      ).toBe(401);
      const response = await nativeFetch(`${bridge.baseUrl}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bridge.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: "fake", input: "synthetic" }),
      });
      expect(response.status).toBe(200);
      expect(observed).toEqual(["Bearer private-byok"]);
    } finally {
      await bridge.close();
    }
  });
  it("runs the actual pinned Codex CLI and MCP tools through a fake Chat Completions provider", async () => {
    let requests = 0;
    const seen: Record<string, unknown>[] = [];
    const provider = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      seen.push(body);
      requests++;
      const desired = [
        "read_resume",
        "read_job",
        "read_evidence",
        "submit_tailoring_proposal",
      ][requests - 1];
      const tools = body.tools as {
        function: { name: string; description: string };
      }[];
      const name = desired
        ? tools.find((t) => t.function.name.endsWith(`_${desired}`))?.function
            .name
        : undefined;
      const message = name
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call-${requests}`,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(
                    desired === "submit_tailoring_proposal" ? testProposal : {},
                  ),
                },
              },
            ],
          }
        : { role: "assistant", content: JSON.stringify(testProposal) };
      res
        .writeHead(200, { "Content-Type": "application/json" })
        .end(
          JSON.stringify({
            id: `chat-${requests}`,
            object: "chat.completion",
            created: 1,
            model: "fake",
            choices: [
              {
                index: 0,
                message,
                finish_reason: name ? "tool_calls" : "stop",
              },
            ],
            usage: {
              prompt_tokens: 100,
              completion_tokens: 50,
              total_tokens: 150,
            },
          }),
        );
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    const address = provider.address();
    if (!address || typeof address === "string") throw new Error("port");
    const bridge = await startModelBridge({
      apiKey: "synthetic-key",
      model: "fake-model",
      providerId: "custom-openai-compatible",
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      protocol: "chat_completions",
      timeoutMs: 25000,
    });
    const tools = createCareerTools(testSnapshot, async () => {}),
      mcp = await startCareerMcpServer(tools);
    try {
      const result = await runCodexTailoring({
        config: {
          apiKey: bridge.apiKey,
          baseUrl: bridge.baseUrl,
          model: "fake-model",
          timeoutMs: 30000,
        },
        signal: new AbortController().signal,
        tools: { ...mcp, getProposal: () => tools.proposal },
      });
      expect(result.proposal).toEqual(testProposal);
      expect(requests).toBe(5);
      expect(seen[1].messages).toEqual(
        expect.arrayContaining([expect.objectContaining({ role: "tool" })]),
      );
      expect(result.metrics.usage?.inputTokens).toBe(500);
    } finally {
      await bridge.close();
      await mcp.close();
      provider.closeAllConnections();
      await new Promise<void>((resolve) => provider.close(() => resolve()));
    }
  }, 35000);
});
