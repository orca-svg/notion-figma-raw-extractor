import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectSlackExportZip, parseSlackExportZip } from "../server/slack-export.js";
import { runSlackMcpExtraction, parseSlackConversationTarget } from "../server/slack-mcp-extract.js";
import { buildSlackRunZip, createSlackRun, upsertRunEvent } from "../server/slack-run-store.js";
import { connectSlackWebToken, SlackWebApiError } from "../server/slack-web-client.js";
import { runSlackWebExtraction } from "../server/slack-web-extract.js";
import type { McpAdapter, SlackExtractionInput, SlackWebSession, ToolDescriptor } from "../server/types.js";

function exportZip() {
  const json = (value: unknown) => strToU8(JSON.stringify(value));
  return zipSync({
    "users.json": [json([{ id: "U1", name: "alice", real_name: "Alice", profile: { display_name: "앨리스", email: "alice@example.com" } }]), { level: 0 }],
    "channels.json": [json([{ id: "C1", name: "project", members: ["U1"] }]), { level: 0 }],
    "groups.json": [json([{ id: "G1", name: "private-project", members: ["U1"] }]), { level: 0 }],
    "dms.json": [json([{ id: "D1", members: ["U1"] }]), { level: 0 }],
    "mpims.json": [json([]), { level: 0 }],
    "project/2026-08-30.json": [json([
      { type: "message", user: "U1", text: "첫 메시지", ts: "1000.000001", reply_count: 1 },
      { type: "message", user: "U1", text: "답글", ts: "1001.000001", thread_ts: "1000.000001", reactions: [{ name: "thumbsup", users: ["U1"] }] },
      { type: "message", user: "U1", text: "파일", ts: "1002.000001", files: [{ id: "F1", name: "plan.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/private/F1" }] },
    ]), { level: 0 }],
    "D1/2026-08-30.json": [json([{ type: "message", user: "U1", text: "DM", ts: "1003.000001" }]), { level: 0 }],
  }, { level: 0 });
}

describe("Slack official Export ingestion", () => {
  it("공개 채널·DM·스레드·사용자·파일 링크를 정규화하고 ZIP을 만든다", () => {
    const data = exportZip();
    expect(inspectSlackExportZip(data).length).toBeGreaterThan(5);
    const normalized = parseSlackExportZip(data);
    expect(normalized.users[0]).toMatchObject({ id: "U1", displayName: "앨리스" });
    expect(normalized.conversations.map((conversation) => conversation.kind)).toEqual(expect.arrayContaining(["public_channel", "private_channel", "dm"]));
    expect(normalized.messages).toHaveLength(4);
    expect(normalized.messages.find((message) => message.text === "답글")).toMatchObject({ threadTs: "1000.000001", author: "앨리스" });
    expect(normalized.files[0]).toMatchObject({ id: "F1", name: "plan.pdf", url: "https://files.slack.com/private/F1" });

    const input: SlackExtractionInput = { mode: "export", includeFiles: false };
    const run = createSlackRun("session", input);
    run.normalized = normalized;
    const files = unzipSync(buildSlackRunZip(run));
    expect(JSON.parse(strFromU8(files["users.json"]))).toHaveLength(1);
    expect(strFromU8(files["conversations/C1.ndjson"])).toContain("첫 메시지");
    expect(JSON.parse(strFromU8(files["files/index.json"]))[0].url).toContain("files.slack.com");
  });

  it("상위 경로를 포함한 ZIP과 메시지가 없는 ZIP을 거부한다", () => {
    const malicious = zipSync({ "../escape.json": [strToU8("[]"), { level: 0 }] }, { level: 0 });
    expect(() => inspectSlackExportZip(malicious)).toThrow(/안전하지 않은 ZIP 경로/);
    const empty = zipSync({ "users.json": [strToU8("[]"), { level: 0 }] }, { level: 0 });
    expect(() => parseSlackExportZip(empty)).toThrow(/메시지 JSON/);
  });
});

class SlackAdapter implements McpAdapter {
  readonly tools: ToolDescriptor[] = [
    { name: "conversations_history", inputSchema: { type: "object", properties: { channel: { type: "string" }, limit: { type: "number" } } } },
    { name: "conversations_replies", inputSchema: { type: "object", properties: { channel: { type: "string" }, ts: { type: "string" } } } },
  ];
  listTools() { return Promise.resolve(this.tools); }
  callTool(name: string) {
    const payload = name.includes("replies")
      ? { messages: [{ user: "U2", text: "reply", ts: "2.0", thread_ts: "1.0" }] }
      : { messages: [{ user: "U1", text: "root", ts: "1.0", reply_count: 1 }] };
    return Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] });
  }
  close() { return Promise.resolve(); }
}

describe("Slack MCP user-scoped extraction", () => {
  it("채널 URL을 해석하고 history와 replies를 정규화한다", async () => {
    expect(parseSlackConversationTarget("https://workspace.slack.com/archives/C1234567890/p1")).toEqual(expect.objectContaining({ id: "C1234567890" }));
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(new SlackAdapter(), run, (event) => upsertRunEvent(run, event));
    expect(run.normalized).toMatchObject({ source: "slack_mcp", provenance: { access: "authenticated_user_visible_conversations_only" } });
    expect(run.normalized?.messages.map((message) => message.text)).toEqual(["root", "reply"]);
    expect(run.events.at(-1)?.type).toBe("complete");
  });
});

function editedExportZip() {
  const json = (value: unknown) => strToU8(JSON.stringify(value));
  return zipSync({
    "users.json": [json([{ id: "U1", name: "alice", profile: { display_name: "앨리스" } }]), { level: 0 }],
    "channels.json": [json([{ id: "C1", name: "project", members: ["U1"] }]), { level: 0 }],
    "project/2026-08-30.json": [json([
      { type: "message", user: "U1", text: "원문", ts: "1000.000001", edited: { user: "U1", ts: "1000.500000" } },
      {
        type: "message",
        subtype: "message_changed",
        ts: "1001.000001",
        message: { user: "U1", ts: "1000.000002", text: "고친 본문", edited: { user: "U1", ts: "1001.000000" } },
        previous_message: { user: "U1", ts: "1000.000002", text: "고치기 전 본문" },
      },
      {
        type: "message",
        subtype: "message_deleted",
        ts: "1002.000001",
        previous_message: { user: "U1", ts: "1001.500000", text: "지워진 메시지" },
      },
    ]), { level: 0 }],
  }, { level: 0 });
}

/** cursor를 돌려주는 서버. 페이지를 끝까지 따라가는지 확인한다. */
class PagedSlackAdapter implements McpAdapter {
  calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private readonly historyPages: number, private readonly repeatCursor = false) {}
  private tools: ToolDescriptor[] = [
    { name: "conversations_history", inputSchema: { type: "object", properties: { channel: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } } } },
    { name: "conversations_replies", inputSchema: { type: "object", properties: { channel: { type: "string" }, ts: { type: "string" }, cursor: { type: "string" } } } },
  ];
  listTools() { return Promise.resolve(this.tools); }
  callTool(name: string, args: Record<string, unknown>) {
    this.calls.push({ name, args });
    if (name.includes("replies")) {
      const root = String(args.ts ?? args.thread_ts);
      return Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify({ messages: [{ user: "U2", text: `reply-${root}`, ts: `${root}9` }] }) }] });
    }
    const page = this.repeatCursor ? 1 : this.calls.filter((call) => call.name === name).length;
    const last = !this.repeatCursor && page >= this.historyPages;
    const payload = {
      messages: [{ user: "U1", text: `msg-${page}`, ts: `${page}.0`, reply_count: 1 }],
      response_metadata: last ? {} : { next_cursor: this.repeatCursor ? "same" : `cursor-${page}` },
    };
    return Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] });
  }
  close() { return Promise.resolve(); }
}

describe("Slack MCP 페이지네이션", () => {
  it("cursor를 끝까지 따라가 모든 페이지의 메시지를 모은다", async () => {
    const adapter = new PagedSlackAdapter(3);
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(adapter, run, (event) => upsertRunEvent(run, event));
    expect(run.normalized?.coverage).toMatchObject({ historyPages: 3, historyTruncated: false });
    // 3페이지의 뿌리 메시지 3개 + 각 스레드 답글 3개
    expect(run.normalized?.messages).toHaveLength(6);
    expect(run.normalized?.coverage?.threadRoots).toBe(3);
    expect(run.normalized?.coverage?.threadsRead).toBe(3);
    const cursors = adapter.calls.filter((call) => call.name === "conversations_history").map((call) => call.args.cursor);
    expect(cursors).toEqual([undefined, "cursor-1", "cursor-2"]);
  });

  it("같은 cursor가 반복되면 멈추고 잘렸음을 남긴다", async () => {
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(new PagedSlackAdapter(9, true), run, (event) => upsertRunEvent(run, event));
    expect(run.normalized?.coverage?.historyTruncated).toBe(true);
    expect(run.events.at(-1)?.state).toBe("warning");
  });

  it("스레드 뿌리가 50개를 넘어도 전부 읽는다", async () => {
    const adapter = new PagedSlackAdapter(60);
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(adapter, run, (event) => upsertRunEvent(run, event));
    expect(run.normalized?.coverage).toMatchObject({ threadRoots: 60, threadsRead: 60, threadsTruncated: false });
    expect(adapter.calls.filter((call) => call.name === "conversations_replies")).toHaveLength(60);
  });
});

/** users.list를 제공하는 서버. 작성자 ID가 실명으로 바뀌는지 확인한다. */
class NamedSlackAdapter implements McpAdapter {
  constructor(private readonly userTool: "users_list" | "users_info" | "none") {}
  listTools() {
    const tools: ToolDescriptor[] = [
      { name: "conversations_history", inputSchema: { type: "object", properties: { channel: { type: "string" }, limit: { type: "number" }, cursor: { type: "string" } } } },
    ];
    if (this.userTool === "users_list") tools.push({ name: "users_list", inputSchema: { type: "object", properties: { limit: { type: "number" }, cursor: { type: "string" } } } });
    if (this.userTool === "users_info") tools.push({ name: "users_info", inputSchema: { type: "object", properties: { user: { type: "string" } } } });
    return Promise.resolve(tools);
  }
  callTool(name: string, args: Record<string, unknown>) {
    const text = (value: unknown) => Promise.resolve({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });
    if (name === "users_list") {
      return text({ members: [
        { id: "U1", team_id: "T1", name: "alice", real_name: "Alice Kim", profile: { display_name: "앨리스", email: "a@example.com" } },
        { id: "U9", team_id: "T1", name: "ghost", real_name: "지나가던 사람", profile: { display_name: "" } },
      ] });
    }
    if (name === "users_info") {
      return text({ user: { id: String(args.user), team_id: "T1", name: "alice", real_name: "Alice Kim", profile: { display_name: "앨리스" } } });
    }
    return text({ messages: [{
      user: "U1",
      text: "안녕하세요",
      ts: "1.0",
      files: [{ id: "F1", name: "plan.pdf", mimetype: "application/pdf", url_private: "https://files.slack.com/private/F1" }],
    }] });
  }
  close() { return Promise.resolve(); }
}

describe("Slack MCP 작성자 이름", () => {
  it("users_list로 작성자 ID를 실명으로 바꾸고 채널에 없는 사람은 뺀다", async () => {
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(new NamedSlackAdapter("users_list"), run, (event) => upsertRunEvent(run, event));
    expect(run.normalized?.users).toHaveLength(1);
    expect(run.normalized?.users[0]).toMatchObject({ id: "U1", displayName: "앨리스", realName: "Alice Kim" });
    expect(run.normalized?.messages[0].author).toBe("앨리스");
    expect(run.normalized?.coverage?.users).toMatchObject({ authorIds: 1, resolved: 1, source: "users_list" });
  });

  it("users_info만 있으면 등장한 작성자만 개별 조회한다", async () => {
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(new NamedSlackAdapter("users_info"), run, (event) => upsertRunEvent(run, event));
    expect(run.normalized?.coverage?.users).toMatchObject({ resolved: 1, source: "users_info" });
    expect(run.normalized?.messages[0].author).toBe("앨리스");
  });

  it("사용자 조회 Tool이 없으면 경고를 남기고 ID로 둔다", async () => {
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(new NamedSlackAdapter("none"), run, (event) => upsertRunEvent(run, event));
    expect(run.normalized?.coverage?.users).toMatchObject({ authorIds: 1, resolved: 0, source: "message_profile" });
    expect(run.normalized?.messages[0].author).toBeUndefined();
    expect(run.events.find((event) => event.id === "04-users")?.state).toBe("warning");
  });

  it("첨부 파일 객체를 사용자로 오인하지 않는다", async () => {
    const run = createSlackRun("session", { mode: "mcp", target: "C1234567890", includeFiles: false });
    await runSlackMcpExtraction(new NamedSlackAdapter("users_list"), run, (event) => upsertRunEvent(run, event));
    expect(run.normalized?.users.map((user) => user.id)).not.toContain("F1");
  });
});

describe("Slack Export 편집·삭제 메시지", () => {
  it("최상위 edited와 message_changed에 중첩된 edited를 모두 보존한다", () => {
    const messages = parseSlackExportZip(editedExportZip()).messages;

    const plain = messages.find((message) => message.text === "원문");
    expect(plain?.edited).toEqual({ user: "U1", ts: "1000.500000" });

    // message_changed는 본문과 마찬가지로 편집 정보도 중첩된 message에 들어온다.
    const changed = messages.find((message) => message.subtype === "message_changed");
    expect(changed).toMatchObject({ text: "고친 본문", edited: { user: "U1", ts: "1001.000000" } });

    const deleted = messages.find((message) => message.subtype === "message_deleted");
    expect(deleted).toMatchObject({ text: "지워진 메시지", author: "앨리스" });
  });

  it("deflate로 압축된 Export도 해제한다", () => {
    const normalized = parseSlackExportZip(zipSync({
      "users.json": strToU8(JSON.stringify([{ id: "U1", name: "alice" }])),
      "channels.json": strToU8(JSON.stringify([{ id: "C1", name: "project", members: ["U1"] }])),
      "project/2026-08-30.json": strToU8(JSON.stringify([{ type: "message", user: "U1", text: "압축된 메시지", ts: "1.0" }])),
    }));
    expect(normalized.messages.map((message) => message.text)).toEqual(["압축된 메시지"]);
  });
});

/** 중앙 디렉터리가 신고한 압축 해제 크기만 작게 고쳐, 사전 검사를 통과하는 ZIP을 만든다. */
function understateCentralDirectorySizes(zip: Uint8Array): Uint8Array {
  const patched = new Uint8Array(zip);
  const u16 = (offset: number) => patched[offset] | patched[offset + 1] << 8;
  const u32 = (offset: number) => (patched[offset] | patched[offset + 1] << 8 | patched[offset + 2] << 16 | patched[offset + 3] << 24) >>> 0;
  const setU32 = (offset: number, value: number) => {
    patched[offset] = value & 0xff;
    patched[offset + 1] = value >>> 8 & 0xff;
    patched[offset + 2] = value >>> 16 & 0xff;
    patched[offset + 3] = value >>> 24 & 0xff;
  };
  let eocd = -1;
  for (let offset = patched.length - 22; offset >= 0; offset -= 1) if (u32(offset) === 0x06054b50) { eocd = offset; break; }
  const count = u16(eocd + 10);
  let offset = u32(eocd + 16);
  for (let index = 0; index < count; index += 1) {
    setU32(offset + 24, 4096);
    offset = offset + 46 + u16(offset + 28) + u16(offset + 30) + u16(offset + 32);
  }
  return patched;
}

describe("Slack Export 압축 폭탄", () => {
  it("중앙 디렉터리가 크기를 속여도 실제 해제 단계에서 상한이 걸린다", () => {
    const bomb = zipSync({
      "users.json": strToU8(JSON.stringify([{ id: "U1", name: "alice" }])),
      "channels.json": strToU8(JSON.stringify([{ id: "C1", name: "project", members: ["U1"] }])),
      // 실제로는 60MB로 부풀지만 중앙 디렉터리에는 4KB라고 적어 둔다.
      "project/2026-08-30.json": new Uint8Array(60 * 1024 * 1024),
    });
    const patched = understateCentralDirectorySizes(bomb);

    // 사전 검사는 신고된 값만 보므로 통과한다.
    expect(() => inspectSlackExportZip(patched)).not.toThrow();
    // 실제 해제는 항목 상한에서 끊긴다.
    expect(() => parseSlackExportZip(patched)).toThrow(/50MB/);
  });
});

/** Slack Web API를 흉내 낸다. 실패도 HTTP 200에 {ok:false}로 오는 동작을 그대로 재현한다. */
function stubSlackApi(handler: (method: string, params: URLSearchParams) => unknown) {
  const calls: Array<{ method: string; params: URLSearchParams }> = [];
  vi.stubGlobal("fetch", (input: string | URL) => {
    const url = new URL(String(input));
    const method = url.pathname.replace("/api/", "");
    calls.push({ method, params: url.searchParams });
    const body = handler(method, url.searchParams);
    if (body instanceof Response) return Promise.resolve(body);
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
  });
  return calls;
}

async function connectedSession(): Promise<SlackWebSession> {
  const session: SlackWebSession = {};
  await connectSlackWebToken(session, "xoxp-test-token");
  return session;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Slack Web API 직접 추출", () => {
  it("토큰을 확인하고 워크스페이스를 기억한다", async () => {
    stubSlackApi(() => ({ ok: true, team_id: "T1", team: "AEL", user_id: "U1", user: "siwon" }));
    const session = await connectedSession();
    expect(session).toMatchObject({ tokenType: "user", teamId: "T1", teamName: "AEL", userId: "U1" });
  });

  it("xoxp-도 xoxb-도 아닌 값은 호출 전에 거른다", async () => {
    const session: SlackWebSession = {};
    await expect(connectSlackWebToken(session, "붙여넣기실패")).rejects.toThrow(/xoxp-/);
  });

  it("커서를 끝까지 따라가고 작성자 이름을 채운다", async () => {
    const calls = stubSlackApi((method, params) => {
      if (method === "auth.test") return { ok: true, team_id: "T1", team: "AEL", user_id: "U1" };
      if (method === "conversations.info") return { ok: true, channel: { id: "C1", name: "design-review", is_private: false, num_members: 4 } };
      if (method === "conversations.history") {
        return params.get("cursor")
          ? { ok: true, messages: [{ user: "U1", text: "둘째 장", ts: "2.0" }] }
          : { ok: true, messages: [{ user: "U1", text: "첫 장", ts: "1.0", reply_count: 1 }], response_metadata: { next_cursor: "c1" } };
      }
      if (method === "conversations.replies") return { ok: true, messages: [{ user: "U2", text: "답글", ts: "1.5", thread_ts: "1.0" }] };
      if (method === "users.info") {
        const id = params.get("user");
        return { ok: true, user: { id, team_id: "T1", name: id === "U1" ? "siwon" : "jun", real_name: id === "U1" ? "박시원" : "이준엽", profile: { display_name: id === "U1" ? "시원" : "준엽" } } };
      }
      return { ok: false, error: "unknown_method" };
    });

    const session = await connectedSession();
    const run = createSlackRun("session", { mode: "web", target: "C1", includeFiles: false });
    await runSlackWebExtraction(session, run, (event) => upsertRunEvent(run, event));

    expect(run.normalized?.conversations[0]).toMatchObject({ id: "C1", name: "design-review", kind: "public_channel" });
    expect(run.normalized?.messages.map((message) => message.text)).toEqual(["첫 장", "답글", "둘째 장"]);
    expect(run.normalized?.messages[0].author).toBe("시원");
    expect(run.normalized?.messages[1].author).toBe("준엽");
    expect(run.normalized?.coverage).toMatchObject({
      historyPages: 2,
      historyTruncated: false,
      threadRoots: 1,
      threadsRead: 1,
      users: { authorIds: 2, resolved: 2 },
    });
    expect(calls.filter((call) => call.method === "conversations.history").map((call) => call.params.get("cursor"))).toEqual([null, "c1"]);
    expect(run.events.at(-1)?.state).toBe("success");
  });

  it("scope가 모자라면 필요한 권한 이름을 그대로 알려준다", async () => {
    stubSlackApi((method) => {
      if (method === "auth.test") return { ok: true, team_id: "T1" };
      return { ok: false, error: "missing_scope", needed: "channels:history", provided: "channels:read" };
    });
    const session = await connectedSession();
    const run = createSlackRun("session", { mode: "web", target: "C1", includeFiles: false });
    const failure = await runSlackWebExtraction(session, run, () => undefined).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SlackWebApiError);
    expect((failure as SlackWebApiError).status).toBe(403);
    expect((failure as SlackWebApiError).message).toContain("channels:history");
    // 어느 호출에서 났는지 남아야 원인을 좁힐 수 있다.
    expect((failure as SlackWebApiError).message).toContain("conversations.info");
  });

  it("채널을 못 찾으면 404로 올리고 무엇을 확인할지 알려준다", async () => {
    stubSlackApi((method) => (method === "auth.test" ? { ok: true, team_id: "T1" } : { ok: false, error: "channel_not_found" }));
    const session = await connectedSession();
    const run = createSlackRun("session", { mode: "web", target: "C1", includeFiles: false });
    const failure = await runSlackWebExtraction(session, run, () => undefined).catch((error: unknown) => error);
    expect((failure as SlackWebApiError).status).toBe(404);
    expect((failure as SlackWebApiError).message).toMatch(/채널/);
  });

  it("429를 만나면 Retry-After만큼 쉬고 다시 부른다", async () => {
    let first = true;
    stubSlackApi((method) => {
      if (method !== "auth.test") return { ok: false, error: "unknown_method" };
      if (first) {
        first = false;
        return new Response("", { status: 429, headers: { "retry-after": "0" } });
      }
      return { ok: true, team_id: "T1", team: "AEL" };
    });
    const session = await connectedSession();
    expect(session.teamName).toBe("AEL");
  });
});
