import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { inspectSlackExportZip, parseSlackExportZip } from "../server/slack-export.js";
import { runSlackMcpExtraction, parseSlackConversationTarget } from "../server/slack-mcp-extract.js";
import { buildSlackRunZip, createSlackRun, upsertRunEvent } from "../server/slack-run-store.js";
import type { McpAdapter, SlackExtractionInput, ToolDescriptor } from "../server/types.js";

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
