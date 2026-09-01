import { unzipSync, strFromU8 } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { FigmaDemoAdapter, FIGMA_DEMO_TARGET } from "../server/figma-demo-adapter.js";
import { runFigmaExtraction } from "../server/figma-extract.js";
import { createFigmaOAuthClientMetadata, createFigmaOAuthSession, describeFigmaOAuthStartError } from "../server/figma-mcp-client.js";
import { buildFigmaRunZip, createFigmaRun, upsertRunEvent } from "../server/figma-run-store.js";
import { parseFigmaTarget } from "../server/figma-target.js";
import { buildCodexExecArgs, captureCodexResponse, parseCodexFigmaItem } from "../server/codex-figma-bridge.js";
import type { ExtractionEvent, FigmaExtractionInput, McpAdapter, ToolDescriptor } from "../server/types.js";

const baseInput: FigmaExtractionInput = {
  target: FIGMA_DEMO_TARGET,
  targetMode: "link",
  scope: "node",
  transport: "desktop",
  includeVariables: true,
  includeCodeConnect: true,
  includeMotion: true,
  includeLibraries: false,
  includeAssets: false,
  clientFrameworks: "unknown",
  clientLanguages: "unknown",
  mode: "demo",
};

afterEach(() => vi.unstubAllGlobals());

describe("Figma Remote OAuth", () => {
  it("Figma가 지원하는 confidential client 방식과 MCP scope를 요청한다", () => {
    const callbackUrl = "http://127.0.0.1:8787/api/figma/auth/callback";
    expect(createFigmaOAuthClientMetadata(callbackUrl)).toEqual({
      client_name: "MCP Trace Studio",
      redirect_uris: [callbackUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_basic",
      scope: "mcp:connect",
    });
  });

  it("OAuth 세션마다 예측할 수 없는 state를 생성한다", () => {
    const first = createFigmaOAuthSession();
    const second = createFigmaOAuthSession();
    expect(first.state).toMatch(/^[a-f0-9]{64}$/);
    expect(second.state).toMatch(/^[a-f0-9]{64}$/);
    expect(first.state).not.toBe(second.state);
  });

  it("미승인 클라이언트의 403을 사용자가 조치할 수 있는 메시지로 바꾼다", () => {
    expect(describeFigmaOAuthStartError(new Error("HTTP 403: Forbidden"))).toMatch(/Catalog.*승인/);
    expect(describeFigmaOAuthStartError(new Error("network timeout"))).toContain("network timeout");
  });
});

describe("Figma target parser", () => {
  it("Design, branch, FigJam 링크를 file key와 node id로 정규화한다", () => {
    expect(parseFigmaTarget("https://www.figma.com/design/abc/File?node-id=12-34")).toMatchObject({ fileKey: "abc", nodeId: "12:34", fileType: "design" });
    expect(parseFigmaTarget("https://figma.com/design/base/branch/branchKey/File?node-id=8%3A9")).toMatchObject({ fileKey: "branchKey", nodeId: "8:9", fileType: "design" });
    expect(parseFigmaTarget("https://www.figma.com/board/jamKey/Map?node-id=1-2")).toMatchObject({ fileKey: "jamKey", nodeId: "1:2", fileType: "figjam" });
  });

  it("파일 전체 링크와 지원하지 않는 유형을 거부한다", () => {
    expect(() => parseFigmaTarget("https://figma.com/design/abc/File")).toThrow(/node-id/);
    expect(() => parseFigmaTarget("https://figma.com/slides/abc/Deck?node-id=1-2")).toThrow(/지원하지/);
  });
});

describe("Codex Figma bridge event parser", () => {
  it("plugin MCP transport를 불완전한 config override로 덮어쓰지 않는다", () => {
    const args = buildCodexExecArgs({ ...baseInput, transport: "codex", mode: "live" });
    expect(args.some((value) => value.includes("mcp_servers.figma"))).toBe(false);
    expect(args).toContain("--json");
    expect(args).toContain("read-only");
  });

  it("질문 실행은 구조화 출력 schema와 prompt injection 격리를 요구한다", () => {
    const args = buildCodexExecArgs({ ...baseInput, transport: "codex", mode: "live", question: "이 화면의 제품 의미는?" });
    expect(args).toContain("--output-schema");
    expect(args.at(-1)).toContain("untrusted evidence");
    expect(args.at(-1)).toContain("이 화면의 제품 의미는?");
  });

  it("Codex JSONL의 Figma MCP 시작·완료 이벤트만 추출한다", () => {
    const started = parseCodexFigmaItem({
      type: "item.started",
      item: { id: "call-1", type: "mcp_tool_call", server: "figma", tool: "get_screenshot", arguments: { nodeId: "1:2" } },
    });
    const completed = parseCodexFigmaItem({
      type: "item.completed",
      item: { id: "call-1", type: "mcp_tool_call", server: "figma", tool: "get_screenshot", result: { content: [{ type: "text", text: "ok" }] }, status: "completed" },
    });
    expect(started).toMatchObject({ phase: "started", tool: "get_screenshot", state: "running", request: { nodeId: "1:2" } });
    expect(completed).toMatchObject({ phase: "completed", tool: "get_screenshot", state: "success" });
    expect(parseCodexFigmaItem({ type: "item.completed", item: { id: "x", type: "mcp_tool_call", server: "notion", tool: "fetch" } })).toBeUndefined();
  });

  it("namespace형 Tool 이름과 오류를 정규화한다", () => {
    expect(parseCodexFigmaItem({
      type: "item.completed",
      item: { id: "call-2", type: "mcp_tool_call", name: "mcp__figma__get_design_context", error: "forbidden" },
    })).toMatchObject({ tool: "get_design_context", state: "error", message: "forbidden" });
  });

  it("Codex 텍스트 응답의 Figma screenshot URL을 artifact로 저장한다", async () => {
    const run = createFigmaRun("codex-session", { ...baseInput, transport: "codex", mode: "live" });
    const fetchMock = vi.fn(async () => new Response(Uint8Array.from([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } }));
    vi.stubGlobal("fetch", fetchMock);
    const response = {
      content: [{ type: "text", text: JSON.stringify({ image_url: "https://www.figma.com/api/mcp/asset/example.png", width: 100, height: 200 }) }],
    };
    const captured = await captureCodexResponse(response, run, 5, "get_screenshot");
    expect(fetchMock).toHaveBeenCalledWith("https://www.figma.com/api/mcp/asset/example.png", expect.objectContaining({ redirect: "follow" }));
    expect(captured.artifacts).toHaveLength(1);
    expect(captured.artifacts[0]).toMatchObject({ kind: "screenshot", mimeType: "image/png", bytes: 4 });
    expect(run.artifacts.size).toBe(1);
  });
});

describe("Figma extraction pipeline", () => {
  it("Design 예제의 읽기 Tool을 추적하고 screenshot을 artifact로 분리한다", async () => {
    const run = createFigmaRun("test-session", baseInput);
    const adapter = new FigmaDemoAdapter();
    await runFigmaExtraction(adapter, baseInput, run, (event) => upsertRunEvent(run, event));

    const tools = run.events.filter((event) => event.tool).map((event) => event.tool);
    expect(tools).toContain("get_design_context");
    expect(tools).toContain("get_screenshot");
    expect(tools).toContain("get_variable_defs");
    expect(tools).toContain("get_code_connect_map");
    expect(tools).toContain("get_motion_context");
    expect(run.detectedFileType).toBe("design");
    expect(run.artifacts.size).toBeGreaterThan(0);
    expect(run.events.at(-1)?.type).toBe("complete");
    expect(run.events.every((event) => event.provider === "figma" && event.runId === run.id)).toBe(true);

    const screenshot = run.events.find((event) => event.group === "screenshot");
    expect(screenshot?.artifacts?.[0].mimeType).toBe("image/svg+xml");
    expect(JSON.stringify(screenshot?.response)).not.toContain("PHN2Zy");

    const zip = unzipSync(buildFigmaRunZip(run));
    expect(Object.keys(zip)).toContain("manifest.json");
    expect(Object.keys(zip)).toContain("trace.ndjson");
    expect(Object.keys(zip)).toContain("README.md");
    expect(Object.keys(zip).some((name) => name.startsWith("responses/") && name.includes("get_screenshot"))).toBe(true);
    expect(Object.keys(zip).some((name) => name.startsWith("artifacts/screenshots/"))).toBe(true);
    expect(JSON.parse(strFromU8(zip["manifest.json"])).provider).toBe("figma");
  });

  it("Desktop 현재 선택이 Design 유형 오류를 내면 FigJam으로 전환한다", async () => {
    const calls: string[] = [];
    const text = (value: string, isError = false): CallToolResult => ({ content: [{ type: "text", text: value }], isError });
    const adapter: McpAdapter = {
      async listTools(): Promise<ToolDescriptor[]> {
        return [{ name: "get_design_context" }, { name: "get_figjam" }, { name: "get_screenshot" }];
      },
      async callTool(name): Promise<CallToolResult> {
        calls.push(name);
        if (name === "get_design_context") return text("This is a FigJam board and is not supported by the Design tool.", true);
        if (name === "get_figjam") return text("<figjam><sticky id=\"1:2\">Flow</sticky></figjam>");
        return text("screenshot-url");
      },
      async close() {},
    };
    const input: FigmaExtractionInput = { ...baseInput, target: "", targetMode: "selection", mode: "live" };
    const run = createFigmaRun("test-session", input);
    const events: ExtractionEvent[] = [];
    await runFigmaExtraction(adapter, input, run, (event) => { events.push(event); upsertRunEvent(run, event); });

    expect(calls.slice(0, 2)).toEqual(["get_design_context", "get_figjam"]);
    expect(run.detectedFileType).toBe("figjam");
    expect(events.some((event) => event.group === "figjam" && event.state === "success")).toBe(true);
  });
});
