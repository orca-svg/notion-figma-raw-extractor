import { describe, expect, it } from "vitest";
import { DemoMcpAdapter } from "../server/demo-adapter.js";
import { redactSignedUrl, runExtraction, type ArtifactSink } from "../server/extract.js";
import { buildNotionRunZip, createNotionRun, storeArtifact } from "../server/notion-run-store.js";
import type { ExtractionEvent, ExtractionInput } from "../server/types.js";

const baseInput: ExtractionInput = {
  target: "https://www.notion.so/11111111111141118111111111111111?v=22222222222242228222222222222222",
  expectedEmail: "demo@notion.local",
  searchQuery: "오류",
  maxRows: 3,
  includeArchived: true,
  includeComments: true,
  includeTranscript: false,
  includeWorkspace: false,
  mode: "demo",
};

async function collect(input: ExtractionInput, sink?: ArtifactSink): Promise<ExtractionEvent[]> {
  const adapter = await DemoMcpAdapter.create();
  const events: ExtractionEvent[] = [];
  try {
    await runExtraction(adapter, input, (event) => {
      const index = events.findIndex((current) => current.id === event.id);
      if (index === -1) events.push(event);
      else events[index] = event;
    }, sink);
    return events;
  } finally {
    await adapter.close();
  }
}

describe("단계별 추출 파이프라인", () => {
  it("모든 읽기 경로를 실행하고 26행 fixture에서 선택한 수만큼 본문을 읽는다", async () => {
    const events = await collect(baseInput);
    const groups = new Set(events.map((event) => event.group));
    for (const group of ["discovery", "connection", "search", "target", "schema", "view", "sql", "page", "comments", "summary"]) {
      expect(groups.has(group as ExtractionEvent["group"]), `${group} 단계 누락`).toBe(true);
    }
    expect(events.some((event) => event.group === "view" && event.label.includes("활성"))).toBe(true);
    expect(events.some((event) => event.group === "view" && event.label.includes("보관"))).toBe(true);
    expect(events.some((event) => event.group === "sql")).toBe(true);
    expect(events.filter((event) => event.group === "page" && event.state === "success")).toHaveLength(3);
    expect(events.at(-1)?.type).toBe("complete");
  }, 20_000);

  it("대상 접근 실패를 오류로 남기고 종속 단계를 건너뛴다", async () => {
    const events = await collect({ ...baseInput, target: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    expect(events.find((event) => event.group === "target")?.state).toBe("error");
    for (const group of ["schema", "view", "sql", "page", "comments"]) {
      expect(events.find((event) => event.group === group)?.state).toBe("skipped");
    }
    expect(events.at(-1)?.state).toBe("warning");
  }, 10_000);

  it("워크스페이스 옵션이 꺼져 있으면 호출하지 않고 사유를 남긴다", async () => {
    const events = await collect(baseInput);
    const workspace = events.filter((event) => event.group === "workspace");
    expect(workspace).toHaveLength(1);
    expect(workspace[0]?.state).toBe("skipped");
    expect(workspace[0]?.tool).toBeUndefined();
  }, 20_000);

  it("워크스페이스 옵션을 켜면 사용자와 팀스페이스를 모두 조회한다", async () => {
    const events = await collect({ ...baseInput, includeWorkspace: true });
    const workspace = events.filter((event) => event.group === "workspace");
    expect(workspace.map((event) => event.tool)).toEqual(["notion-get-users", "notion-get-teams"]);
    expect(workspace.every((event) => event.state === "success")).toBe(true);

    const summary = events.at(-1);
    expect(summary?.type).toBe("complete");
    const extracted = summary?.extracted as { workspaceMembers?: number; workspaceTeams?: number };
    expect(extracted.workspaceMembers).toBe(3);
    expect(extracted.workspaceTeams).toBe(2);
  }, 20_000);

  it("워크스페이스 조회는 대상 조회보다 먼저 실행된다", async () => {
    const events = await collect({ ...baseInput, includeWorkspace: true });
    const workspaceIndexes = events.flatMap((event, index) => (event.group === "workspace" ? [index] : []));
    const firstTarget = events.findIndex((event) => event.group === "target");
    expect(workspaceIndexes.length).toBeGreaterThan(0);
    expect(Math.max(...workspaceIndexes)).toBeLessThan(firstTarget);
  }, 20_000);

  it("sink가 있으면 첨부 원본을 내려받아 artifact로 이벤트에 싣는다", async () => {
    const run = createNotionRun("session-1", baseInput);
    const events = await collect(baseInput, (artifact) => storeArtifact(run, artifact));

    const attachments = events.filter((event) => event.group === "attachment");
    expect(attachments.length).toBeGreaterThan(0);
    expect(attachments.every((event) => event.state === "success")).toBe(true);

    const refs = attachments.flatMap((event) => event.artifacts ?? []);
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0].mimeType).toBe("image/png");
    expect(refs[0].kind).toBe("asset");
    expect(refs[0].path).toMatch(/^artifacts\/assets\//);
    expect(run.artifacts.size).toBe(refs.length);

    const summary = events.at(-1)?.extracted as { storedAttachments?: number };
    expect(summary.storedAttachments).toBe(refs.length);
  }, 20_000);

  it("sink가 없으면 내려받지 않고 건너뛴 사유를 남긴다", async () => {
    const events = await collect(baseInput);
    const attachments = events.filter((event) => event.group === "attachment");
    expect(attachments).toHaveLength(1);
    expect(attachments[0]?.state).toBe("skipped");
    expect(attachments[0]?.artifacts).toBeUndefined();
  }, 20_000);

  it("서명 URL과 data URL을 트레이스에 그대로 남기지 않는다", () => {
    expect(redactSignedUrl("https://s3.example.com/secure/file.png?X-Amz-Signature=deadbeef")).toBe(
      "https://s3.example.com/secure/file.png?…",
    );
    expect(redactSignedUrl("data:image/png;base64,iVBORw0KGgoAAAANSUhEUg")).toBe("data:image/png;base64,…");
  });

  it("ZIP 번들에 첨부 원본과 manifest가 담긴다", async () => {
    const run = createNotionRun("session-1", baseInput);
    const events = await collect(baseInput, (artifact) => storeArtifact(run, artifact));
    for (const event of events) {
      const index = run.events.findIndex((current) => current.id === event.id);
      if (index === -1) run.events.push(event);
      else run.events[index] = event;
    }
    const zip = buildNotionRunZip(run);
    expect(zip.byteLength).toBeGreaterThan(0);
    const text = Buffer.from(zip).toString("latin1");
    expect(text).toContain("manifest.json");
    expect(text).toContain("artifacts/assets/");
  }, 20_000);

  it("입력 이메일과 연결 이메일이 다르면 대상 조회 전에 멈춘다", async () => {
    const events = await collect({ ...baseInput, expectedEmail: "wrong@example.com" });
    expect(events.some((event) => event.type === "fatal" && event.group === "connection")).toBe(true);
    expect(events.some((event) => event.group === "target")).toBe(false);
  });
});
