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
