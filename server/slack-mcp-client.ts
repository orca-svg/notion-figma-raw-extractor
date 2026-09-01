import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAdapter, ToolDescriptor } from "./types.js";

export const SLACK_MCP_ENDPOINT = "https://mcp.slack.com/mcp";

class SlackMcpAdapter implements McpAdapter {
  private lastCallAt = 0;

  constructor(private readonly client: Client) {}

  async listTools(): Promise<ToolDescriptor[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    const waitMs = Math.max(0, 250 - (Date.now() - this.lastCallAt));
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    this.lastCallAt = Date.now();
    return await this.client.callTool({ name, arguments: args }) as CallToolResult;
  }

  close(): Promise<void> {
    return this.client.close();
  }
}

export async function connectToSlackMcp(accessToken: string): Promise<McpAdapter> {
  const client = new Client({ name: "mcp-trace-studio-slack", version: "1.0.0" }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(SLACK_MCP_ENDPOINT), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}`, "User-Agent": "MCP-Trace-Studio/1.0" } },
  });
  try {
    await client.connect(transport);
    return new SlackMcpAdapter(client);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw new Error(`Slack MCP 연결에 실패했습니다. ${error instanceof Error ? error.message : String(error)}`);
  }
}
