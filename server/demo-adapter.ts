import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpAdapter, ToolDescriptor } from "./types.js";

type DemoRow = Record<string, string> & { _id: string; _url: string };

const DEMO_SOURCE = "collection://11111111-1111-4111-8111-111111111111";
const DEMO_DATABASE = "11111111-1111-4111-8111-111111111111";
const DEMO_VIEW = "22222222-2222-4222-8222-222222222222";

function textResult(payload: unknown, isError = false): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], isError };
}

// 데모 첨부는 외부 네트워크 없이 받아지도록 data: URL을 쓴다. 8x8 회색 PNG.
const DEMO_IMAGE_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAHUlEQVR42mNkYPhfz0AEYBxVSF+FjAwMDIzUdCMAyxsF5Kn7QYUAAAAASUVORK5CYII=";

// 실제 워크스페이스 명부 대신 쓰는 합성 fixture. 실제 계정과 겹치지 않도록 .local 도메인만 쓴다.
const DEMO_USERS = [
  { id: "demo-user-1", name: "데모 멤버 1", email: "member-1@notion.local", type: "person", avatar_url: null },
  { id: "demo-user-2", name: "데모 멤버 2", email: "member-2@notion.local", type: "person", avatar_url: null },
  { id: "demo-bot-1", name: "데모 연동 봇", email: null, type: "bot", avatar_url: null },
];

const DEMO_TEAMS = [
  { id: "demo-team-1", name: "제품팀", description: "데모 팀스페이스", member_count: 2 },
  { id: "demo-team-2", name: "운영팀", description: "데모 팀스페이스", member_count: 1 },
];

function uuidFor(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

export class DemoMcpAdapter implements McpAdapter {
  private constructor(private readonly rows: DemoRow[]) {}

  static async create(): Promise<DemoMcpAdapter> {
    const csvPath = fileURLToPath(new URL("../notion_sample_rows_26.csv", import.meta.url));
    const csv = await readFile(csvPath, "utf8");
    const records = parse(csv, { columns: true, skip_empty_lines: true }) as Array<Record<string, string>>;
    const rows = records.map((record, index) => {
      const id = uuidFor(index);
      return { ...record, _id: id, _url: `https://www.notion.so/${id.replace(/-/g, "")}` };
    });
    return new DemoMcpAdapter(rows);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    return [
      { name: "notion-fetch" },
      { name: "notion-search" },
      { name: "notion-query-data-sources" },
      { name: "notion-get-comments" },
      { name: "notion-get-users" },
      { name: "notion-get-teams" },
    ];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    await new Promise((resolve) => setTimeout(resolve, 180));
    if (name === "notion-search") {
      const query = String(args.query ?? "").toLowerCase();
      const results = this.rows
        .filter((row) => Object.values(row).join(" ").toLowerCase().includes(query) || !query)
        .slice(0, 10)
        .map((row) => ({ id: row._id, url: row._url, type: "page", title: row["오류 상세 및 설명"], highlight: row["오류 상세 및 설명"], timestamp: "2026-08-11T00:00:00.000Z" }));
      return textResult({ results, type: "workspace_search", demo: true });
    }
    if (name === "notion-query-data-sources") {
      const data = args.data as Record<string, unknown>;
      const archived = data?.is_archived === true;
      return textResult({
        results: archived ? [] : this.rows.map((row) => ({ object: "page", id: row._id, url: row._url, properties: row })),
        has_more: false,
        next_cursor: null,
        demo: true,
      });
    }
    if (name === "notion-get-users") {
      return textResult({
        results: DEMO_USERS,
        has_more: false,
        next_cursor: null,
        demo: true,
      });
    }
    if (name === "notion-get-teams") {
      return textResult({
        results: DEMO_TEAMS,
        has_more: false,
        next_cursor: null,
        demo: true,
      });
    }
    if (name === "notion-get-comments") {
      return {
        content: [{ type: "text", text: `<discussions page-id="${String(args.page_id)}"><discussion resolved="false"><comment author="검증 계정">데모 댓글입니다. 실제 MCP 모드에서는 Notion 댓글이 여기에 표시됩니다.</comment></discussion></discussions>` }],
      };
    }
    if (name === "notion-fetch") {
      const id = String(args.id ?? "");
      const normalizedId = id.replace(/-/g, "");
      if (id === "self") {
        return textResult({
          metadata: { type: "self" },
          self: {
            workspace: { id: "demo-workspace", name: "검증용 워크스페이스" },
            user: { id: "demo-user", name: "데모 계정", email: "demo@notion.local", type: "person" },
            current_tool_access: {
              search: { status: "available" },
              fetch: { status: "available" },
              query_data_sources: { status: "available" },
              get_comments: { status: "available" },
              get_users: { status: "available" },
              get_teams: { status: "available" },
            },
          },
        });
      }
      if (id === DEMO_SOURCE) {
        return textResult({
          metadata: { type: "data_source" },
          title: "오류 관리",
          url: DEMO_SOURCE,
          text: `CREATE TABLE "${DEMO_SOURCE}" (\n  "오류 상세 및 설명" TITLE,\n  "원본 ID" TEXT,\n  "OS" SELECT,\n  "중요도" SELECT,\n  "구분" MULTI_SELECT,\n  "진행상태" STATUS,\n  "기기종류" SELECT\n);`,
        });
      }
      const row = this.rows.find((candidate) => candidate._id.replace(/-/g, "") === id.replace(/-/g, "") || candidate._url === id);
      if (row) {
        return textResult({
          metadata: { type: "page" },
          title: row["오류 상세 및 설명"],
          url: row._url,
          text: `# ${row["오류 상세 및 설명"]}\n\n- 진행상태: ${row["진행상태"]}\n- 중요도: ${row["중요도"]}\n\n<image src="${DEMO_IMAGE_URL}" alt="데모 첨부 이미지"/>\n\n<page-discussions count="1"><discussion url="discussion://${row._id}/block/demo"/></page-discussions>`,
        });
      }
      if (normalizedId.includes(DEMO_DATABASE.replace(/-/g, ""))) {
        return textResult({
          metadata: { type: "database" },
          title: "오류 관리",
          url: `https://www.notion.so/${DEMO_DATABASE.replace(/-/g, "")}?v=${DEMO_VIEW.replace(/-/g, "")}`,
          text: `<database url="https://www.notion.so/${DEMO_DATABASE.replace(/-/g, "")}">오류 관리</database>\n<data-source url="{{${DEMO_SOURCE}}}">오류 관리</data-source>\n<view url="{{view://${DEMO_VIEW}}}">전체 보기</view>`,
        });
      }
      return textResult({ code: "object_not_found", message: `데모에서 찾을 수 없는 ID입니다: ${id}` }, true);
    }
    return textResult({ code: "tool_not_found", message: `${name}은 데모 어댑터에 없습니다.` }, true);
  }

  async close(): Promise<void> {
    // No connection to close in demo mode.
  }
}
