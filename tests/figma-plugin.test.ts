import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { strFromU8, strToU8, unzipSync } from "fflate";
import { buildSemanticHints, diffFigmaSnapshots, groupChangesByActor, loadFigmaHistory } from "../server/figma-history.js";
import { FigmaPluginBridge } from "../server/figma-plugin-bridge.js";
import { runPluginFigmaExtraction } from "../server/figma-plugin-extract.js";
import { buildFigmaRunZip, createFigmaRun, upsertRunEvent } from "../server/figma-run-store.js";
import { codexQuestionFailureMessage, normalizeCodexBridgeAnswer } from "../server/figma-question.js";
import { FigmaRestApiError, figmaRestJson } from "../server/figma-rest-client.js";
import type { FigmaExtractionInput, FigmaVersionSnapshot } from "../server/types.js";
import { openTicket, sealTicket, sha256Base64Url, verifyRedeemSecret } from "../oauth-broker/lib/tickets.js";
import { localCallbackOrigin, requiredEnv } from "../oauth-broker/lib/http.js";
import prepareOAuth from "../oauth-broker/api/oauth/prepare.js";
import refreshOAuth from "../oauth-broker/api/oauth/refresh.js";

const target = {
  fileKey: "GogGd3tXMYjbd0bJpwWglb",
  nodeId: "66:27616",
  fileType: "design" as const,
  sourceUrl: "https://www.figma.com/design/GogGd3tXMYjbd0bJpwWglb/File?node-id=66-27616",
};

function connect(bridge: FigmaPluginBridge, owner = "owner") {
  const pairing = bridge.createPairing(owner);
  return bridge.completePairing(pairing.code, {
    pluginVersion: "1.0.0",
    editorType: "figma",
    fileKey: target.fileKey,
    fileName: "Trace Fixture",
    pageName: "Page 1",
    user: { id: "user-1", name: "Jun" },
  }, "127.0.0.1");
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Figma Plugin manifest", () => {
  it("Figma가 허용하는 localhost 개발 origin을 UI와 동일하게 사용한다", () => {
    const manifest = JSON.parse(readFileSync(new URL("../plugins/figma-trace/manifest.json", import.meta.url), "utf8"));
    const ui = readFileSync(new URL("../plugins/figma-trace/ui.html", import.meta.url), "utf8");
    const code = readFileSync(new URL("../plugins/figma-trace/code.ts", import.meta.url), "utf8");

    expect(manifest.networkAccess.devAllowedDomains).toEqual(["http://localhost:8787"]);
    expect(ui).toContain('const API = "http://localhost:8787";');
    expect(code).toContain("width: 320, height: 330");
    expect(code).toContain("figma.ui.resize(280, 176)");
    expect(ui).toContain('type: "compact-ui"');
  });
});

describe("Figma Plugin pairing bridge", () => {
  it("5분짜리 6자리 코드로 메모리 세션을 만들고 bearer 작업을 완료한다", async () => {
    const bridge = new FigmaPluginBridge();
    const pairing = bridge.createPairing("session-a");
    expect(pairing.code).toMatch(/^\d{6}$/);
    const connection = bridge.completePairing(pairing.code, {
      pluginVersion: "1.0.0", editorType: "figma", fileKey: target.fileKey,
    }, "source-a");
    expect(connection.sessionToken).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(bridge.nextJob("invalid-token", undefined, 1)).rejects.toThrow(/세션/);

    const pending = bridge.requestExtraction("session-a", target);
    const job = await bridge.nextJob(connection.sessionToken, undefined, 100);
    expect(job).toMatchObject({ type: "extract_node", target, options: { maxNodes: 5_000, maxJsonBytes: 20 * 1024 * 1024 } });
    const png = Uint8Array.from([137, 80, 78, 71]);
    bridge.uploadArtifact(connection.sessionToken, job!.id, "screenshot", "image/png", png);
    bridge.submitResult(connection.sessionToken, job!.id, {
      scope: "node",
      snapshot: { id: target.nodeId, type: "FRAME", name: "Feed" },
      nodeCount: 1,
      partial: false,
      meta: { pluginVersion: "1.0.0", editorType: "figma", fileKey: target.fileKey, nodeId: target.nodeId },
      artifacts: [{ slot: "screenshot", kind: "screenshot", mimeType: "image/png", name: "feed.png", bytes: png.byteLength }],
    });
    await expect(pending).resolves.toMatchObject({ result: { nodeCount: 1 }, artifacts: expect.any(Map) });

    const replacementCode = bridge.createPairing("session-a");
    const replacement = bridge.completePairing(replacementCode.code, { pluginVersion: "1.0.0", editorType: "figma", fileKey: target.fileKey }, "source-a");
    expect(replacement.sessionToken).not.toBe(connection.sessionToken);
    await expect(bridge.nextJob(connection.sessionToken, undefined, 1)).rejects.toThrow(/만료/);
  });

  it("만료 코드, 반복 오입력, 동시 실행과 file key 불일치를 거부한다", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-18T00:00:00Z"));
    const expired = new FigmaPluginBridge();
    const pairing = expired.createPairing("expired");
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);
    expect(() => expired.completePairing(pairing.code, { pluginVersion: "1", editorType: "figma" }, "source-expired")).toThrow(/만료/);

    const limited = new FigmaPluginBridge();
    for (let attempt = 0; attempt < 5; attempt += 1) expect(() => limited.completePairing("999999", { pluginVersion: "1", editorType: "figma" }, "same-source")).toThrow();
    expect(() => limited.completePairing("999999", { pluginVersion: "1", editorType: "figma" }, "same-source")).toThrow(/시도가 너무 많/);

    const bridge = new FigmaPluginBridge();
    const connection = connect(bridge);
    const first = bridge.requestExtraction("owner", target);
    await expect(bridge.requestExtraction("owner", target)).rejects.toThrow(/이미 다른 추출/);
    const job = await bridge.nextJob(connection.sessionToken, undefined, 100);
    bridge.submitResult(connection.sessionToken, job!.id, {
      scope: "node",
      snapshot: {}, nodeCount: 0, partial: false,
      meta: { pluginVersion: "1", editorType: "figma", fileKey: "wrong", nodeId: target.nodeId },
      artifacts: [],
    });
    await expect(first).rejects.toThrow(/file key/);
  });

  it("가짜 플러그인이 long-poll로 현재 snapshot과 artifact를 반환하는 전체 흐름을 실행한다", async () => {
    const bridge = new FigmaPluginBridge();
    const connection = connect(bridge);
    const input: FigmaExtractionInput = {
      target: target.sourceUrl,
      targetMode: "link",
      scope: "node",
      transport: "plugin",
      includeVariables: true,
      includeCodeConnect: true,
      includeMotion: true,
      includeLibraries: false,
      includeAssets: true,
      clientFrameworks: "unknown",
      clientLanguages: "unknown",
      mode: "live",
    };
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.includes("/meta")) return Response.json({ file: { creator: { id: "owner", name: "Owner" } } });
      if (url.includes("/comments")) return Response.json({ comments: [] });
      if (url.endsWith("/versions")) return Response.json({ versions: [] });
      return Response.json({
        lastModified: "2026-08-18T00:00:00Z",
        document: {
          id: "0:0",
          children: [{ id: target.nodeId, type: "FRAME", name: "News Feed", children: [{ id: "66:27617", type: "TEXT", name: "Primary CTA", characters: "기사 읽기" }] }],
        },
      });
    }));
    const run = createFigmaRun("owner", input);
    const execution = runPluginFigmaExtraction(bridge, "owner", { accessToken: "access", expiresAt: Date.now() + 10 * 60_000 }, input, run, (event) => upsertRunEvent(run, event));
    const job = await bridge.nextJob(connection.sessionToken, undefined, 1_000);
    const png = Uint8Array.from([137, 80, 78, 71]);
    bridge.uploadArtifact(connection.sessionToken, job!.id, "screenshot", "image/png", png);
    bridge.submitResult(connection.sessionToken, job!.id, {
      scope: "node",
      snapshot: {
        id: target.nodeId,
        type: "FRAME",
        name: "News Feed",
        children: [{ id: "66:27617", type: "TEXT", name: "Primary CTA", characters: "기사 읽기" }],
      },
      nodeCount: 2,
      partial: false,
      meta: { pluginVersion: "1.0.0", editorType: "figma", fileKey: target.fileKey, nodeId: target.nodeId, nodeName: "News Feed", nodeType: "FRAME" },
      artifacts: [{ slot: "screenshot", kind: "screenshot", mimeType: "image/png", name: "feed.png", bytes: png.byteLength }],
    });
    await execution;
    expect(run.contextPackage).toMatchObject({ target, partial: false, history: { snapshots: [{ current: true }], changes: [] } });
    expect(run.restMetadata).toMatchObject({ file: { file: { creator: { id: "owner" } } }, comments: { comments: [] } });
    expect(run.contextPackage?.semanticHints.some((hint) => hint.nodeId === "66:27617" && hint.provenance.some((source) => source.source === "text"))).toBe(true);
    expect(run.artifacts.size).toBe(1);
    expect(run.events.map((event) => event.group)).toEqual(["target", "connection", "metadata", "current-snapshot", "artifacts", "semantics", "history", "summary"]);
  });

  it("현재 페이지의 최상위 프레임 JSON·PNG와 필수 REST metadata를 ZIP으로 조립한다", async () => {
    const bridge = new FigmaPluginBridge();
    const connection = connect(bridge);
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.includes("/meta")) return Response.json({ file: { creator: { id: "owner", name: "Owner" }, last_touched_by: { id: "editor", name: "Editor" } } });
      if (url.includes("/comments")) return Response.json({ comments: [{ id: "comment-1", message: "검토 필요", user: { id: "reviewer" } }] });
      if (url.endsWith("/versions")) return Response.json({ versions: [{ id: "v1", created_at: "2026-08-18T00:00:00Z", user: { id: "editor", name: "Editor" } }] });
      return Response.json({});
    }));
    const input: FigmaExtractionInput = {
      target: "",
      targetMode: "link",
      scope: "current_page",
      transport: "plugin",
      includeVariables: true,
      includeCodeConnect: true,
      includeMotion: true,
      includeLibraries: false,
      includeAssets: true,
      clientFrameworks: "unknown",
      clientLanguages: "unknown",
      mode: "live",
    };
    const run = createFigmaRun("owner", input);
    const execution = runPluginFigmaExtraction(bridge, "owner", { accessToken: "access", expiresAt: Date.now() + 10 * 60_000 }, input, run, (event) => upsertRunEvent(run, event));
    const job = await bridge.nextJob(connection.sessionToken, undefined, 1_000);
    expect(job).toMatchObject({ type: "extract_page", fileKey: target.fileKey });
    const nodeJson = strToU8(JSON.stringify({ id: "1:2", type: "FRAME", name: "Home" }));
    const png = Uint8Array.from([137, 80, 78, 71]);
    bridge.uploadArtifact(connection.sessionToken, job!.id, "node-json-1", "application/json", nodeJson);
    bridge.uploadArtifact(connection.sessionToken, job!.id, "frame-png-1", "image/png", png);
    bridge.submitResult(connection.sessionToken, job!.id, {
      scope: "current_page",
      nodeCount: 1,
      partial: false,
      meta: { pluginVersion: "1.1.0", editorType: "figma", fileKey: target.fileKey, pageId: "0:1", pageName: "Main" },
      page: { id: "0:1", name: "Main", nodes: [{ nodeId: "1:2", nodeName: "Home", nodeType: "FRAME", jsonSlot: "node-json-1", screenshotSlot: "frame-png-1", nodeCount: 1, partial: false }] },
      artifacts: [
        { slot: "node-json-1", kind: "json", mimeType: "application/json", name: "Home.json", bytes: nodeJson.byteLength },
        { slot: "frame-png-1", kind: "screenshot", mimeType: "image/png", name: "Home.png", bytes: png.byteLength },
      ],
    });
    await execution;
    expect(run.pagePackage).toMatchObject({ pageId: "0:1", pageName: "Main", partial: false, nodes: [{ jsonPath: "nodes/Home-1-2.json", screenshotPath: "screenshots/Home-1-2.png" }] });
    const zip = unzipSync(buildFigmaRunZip(run));
    expect(JSON.parse(strFromU8(zip["page.json"])).pageName).toBe("Main");
    expect(JSON.parse(strFromU8(zip["nodes/Home-1-2.json"]))).toMatchObject({ id: "1:2" });
    expect(zip["screenshots/Home-1-2.png"]).toEqual(png);
    expect(JSON.parse(strFromU8(zip["metadata/comments.json"])).comments[0].id).toBe("comment-1");
  });
});

describe("Figma version and semantic analysis", () => {
  const snapshot = (id: string, createdAt: string, text: string, userId = "actor-1"): FigmaVersionSnapshot => ({
    id,
    createdAt,
    user: { id: userId, name: userId === "actor-1" ? "Alice" : "Bob" },
    node: {
      id: "1:1", type: "FRAME", name: "Feed",
      children: [{ id: "1:2", type: "TEXT", name: "Headline", characters: text, fills: [{ type: "SOLID", color: { r: 1, g: 1, b: 1 } }] }],
    },
  });

  it("이름·텍스트·이동·생성·삭제를 새 버전 작성자에게 coarse attribution한다", () => {
    const older = snapshot("v1", "2026-08-18T01:00:00Z", "Before");
    const newer = snapshot("v2", "2026-08-18T02:00:00Z", "After");
    (newer.node as any).children[0].name = "Title";
    (newer.node as any).children.push({ id: "1:3", type: "RECTANGLE", name: "New" });
    const changes = diffFigmaSnapshots(older, newer);
    expect(changes.map((change) => change.category)).toEqual(expect.arrayContaining(["name", "text", "created"]));
    expect(changes.every((change) => change.versionId === "v2" && change.actor?.id === "actor-1" && change.attribution === "coarse_version_attribution")).toBe(true);
  });

  it("동일 작성자를 ID로 묶고 ID가 없을 때 이름을 정규화한다", () => {
    const first = diffFigmaSnapshots(snapshot("v1", "2026-08-18T01:00:00Z", "A"), snapshot("v2", "2026-08-18T02:00:00Z", "B"));
    const noIdOlder = snapshot("v2", "2026-08-18T02:00:00Z", "B");
    const noIdNewer = snapshot("v3", "2026-08-18T03:00:00Z", "C");
    noIdNewer.user = { name: "  Alice  " };
    const grouped = groupChangesByActor([...first, ...diffFigmaSnapshots(noIdOlder, noIdNewer)]);
    expect(grouped.map((entry) => entry.actorKey)).toEqual(expect.arrayContaining(["id:actor-1", "name:alice"]));
  });

  it("현재 버전이 목록에 없으면 과거 4개와 현재 snapshot만 시간순으로 유지한다", async () => {
    const versions = Array.from({ length: 6 }, (_, index) => ({
      id: `v${index + 1}`,
      created_at: `2026-08-1${index + 1}T00:00:00Z`,
      user: { id: index % 2 ? "actor-2" : "actor-1", name: index % 2 ? "Bob" : "Alice" },
    }));
    vi.stubGlobal("fetch", vi.fn(async (request: string | URL | Request) => {
      const url = String(request);
      if (url.endsWith("/versions")) return Response.json({ versions });
      const parsed = new URL(url);
      const version = parsed.searchParams.get("version");
      const value = version ? Number(version.slice(1)) : 7;
      return Response.json({
        lastModified: version ? undefined : "2026-08-18T00:00:00Z",
        document: { id: "0:0", children: [{ id: target.nodeId, type: "FRAME", name: "Feed", children: [{ id: "2:1", type: "TEXT", name: "Title", characters: `V${value}` }] }] },
      });
    }));
    const history = await loadFigmaHistory({ accessToken: "access", expiresAt: Date.now() + 60 * 60 * 1000 }, target);
    expect(history.snapshots).toHaveLength(5);
    expect(history.snapshots.slice(0, 4).map((item) => item.id)).toEqual(["v3", "v4", "v5", "v6"]);
    expect(history.snapshots.at(-1)?.current).toBe(true);
    expect(history.changes.length).toBeGreaterThan(0);
  });

  it("Design과 FigJam 의미 힌트에 confidence와 provenance를 남긴다", () => {
    const design = buildSemanticHints({ id: "1:1", type: "FRAME", name: "Checkout", children: [{ id: "1:2", type: "TEXT", name: "Primary CTA", characters: "결제하기", interactions: [{ trigger: "ON_CLICK" }] }] }, "design");
    const figjam = buildSemanticHints({ id: "2:1", type: "SECTION", name: "User Flow", children: [{ id: "2:2", type: "CONNECTOR", name: "Next" }] }, "figjam");
    expect(design.find((hint) => hint.nodeId === "1:2")).toMatchObject({ role: "action-control", confidence: "high" });
    expect(design.find((hint) => hint.nodeId === "1:2")?.provenance.map((item) => item.source)).toEqual(expect.arrayContaining(["text", "hierarchy", "prototype"]));
    expect(figjam.find((hint) => hint.nodeId === "2:2")).toMatchObject({ role: "flow-connection", confidence: "high" });
  });
});

describe("Figma REST OAuth broker tickets", () => {
  const secret = "a-long-private-broker-secret-at-least-32-characters";

  it("PKCE state를 암호화하고 redeem secret과 변조를 검증한다", () => {
    const redeemSecret = "local-only-redeem-secret";
    const ticket = sealTicket({
      type: "flow",
      codeVerifier: "a".repeat(43),
      redeemSecretHash: sha256Base64Url(redeemSecret),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }, secret);
    expect(openTicket(ticket, secret, "flow").codeVerifier).toBe("a".repeat(43));
    expect(verifyRedeemSecret(redeemSecret, sha256Base64Url(redeemSecret))).toBe(true);
    const parts = ticket.split(".");
    const middle = Math.floor(parts[2].length / 2);
    parts[2] = `${parts[2].slice(0, middle)}${parts[2][middle] === "A" ? "B" : "A"}${parts[2].slice(middle + 1)}`;
    expect(() => openTicket(parts.join("."), secret, "flow")).toThrow(/검증/);
  });

  it("만료된 티켓과 다른 종류의 티켓을 거부한다", () => {
    const ticket = sealTicket({ type: "flow", codeVerifier: "a".repeat(43), redeemSecretHash: "hash", createdAt: 1, expiresAt: Date.now() - 1 }, secret);
    expect(() => openTicket(ticket, secret, "flow")).toThrow(/만료/);
    const current = sealTicket({ type: "flow", codeVerifier: "a".repeat(43), redeemSecretHash: "hash", createdAt: Date.now(), expiresAt: Date.now() + 1000 }, secret);
    expect(() => openTicket(current, secret, "result")).toThrow(/종류/);
  });

  it("prepare endpoint가 PKCE·요청 scope·암호화 state를 구성한다", () => {
    vi.stubEnv("BROKER_TICKET_SECRET", secret);
    vi.stubEnv("FIGMA_REST_CLIENT_ID", "client-id");
    vi.stubEnv("BROKER_PUBLIC_ORIGIN", "https://broker.example.com");
    const body: { authUrl?: string; message?: string } = {};
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(function status() { return response; }),
      json: vi.fn((value: typeof body) => Object.assign(body, value)),
    };
    const verifier = "v".repeat(64);
    prepareOAuth({ method: "POST", body: { codeVerifier: verifier, redeemSecretHash: sha256Base64Url("redeem") }, headers: {} } as any, response as any);
    const url = new URL(body.authUrl!);
    expect(url.searchParams.get("scope")).toBe("current_user:read file_content:read file_metadata:read file_comments:read file_versions:read");
    expect(url.searchParams.get("code_challenge")).toBe(sha256Base64Url(verifier));
    expect(openTicket(url.searchParams.get("state")!, secret, "flow")).toMatchObject({ codeVerifier: verifier });
  });

  it("localhost callback allowlist와 필수 비밀값 누락을 거부한다", () => {
    vi.stubEnv("LOCAL_CALLBACK_ORIGIN", "https://attacker.example.com");
    expect(() => localCallbackOrigin()).toThrow(/127\.0\.0\.1/);
    vi.stubEnv("LOCAL_CALLBACK_ORIGIN", "http://127.0.0.1:8787/");
    expect(localCallbackOrigin()).toBe("http://127.0.0.1:8787");
    vi.stubEnv("FIGMA_REST_CLIENT_SECRET", "");
    expect(() => requiredEnv("FIGMA_REST_CLIENT_SECRET")).toThrow(/환경 변수/);
  });

  it("refresh grant를 Figma token endpoint에서 갱신하고 새 암호화 grant를 반환한다", async () => {
    vi.stubEnv("BROKER_TICKET_SECRET", secret);
    vi.stubEnv("FIGMA_REST_CLIENT_ID", "client-id");
    vi.stubEnv("FIGMA_REST_CLIENT_SECRET", "client-secret");
    const redeemSecret = "local-redeem";
    const grant = sealTicket({
      type: "refresh",
      refreshToken: "refresh-old",
      userId: "user-1",
      redeemSecretHash: sha256Base64Url(redeemSecret),
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    }, secret);
    const fetchMock = vi.fn(async () => Response.json({ access_token: "access-new", refresh_token: "refresh-new", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);
    const body: Record<string, unknown> = {};
    const response = {
      setHeader: vi.fn(),
      status: vi.fn(function status() { return response; }),
      json: vi.fn((value: Record<string, unknown>) => Object.assign(body, value)),
    };
    await refreshOAuth({ method: "POST", body: { refreshGrant: grant, redeemSecret }, headers: {} } as any, response as any);
    expect(fetchMock).toHaveBeenCalledWith("https://api.figma.com/v1/oauth/refresh", expect.objectContaining({ method: "POST" }));
    expect(body.accessToken).toBe("access-new");
    expect(openTicket(String(body.refreshGrant), secret, "refresh").refreshToken).toBe("refresh-new");
  });
});

describe("Figma REST failure handling", () => {
  it("401은 세션을 지우고 403은 권한, 429는 재시도와 업그레이드 링크를 보존한다", async () => {
    const session401 = { accessToken: "expired", expiresAt: Date.now() + 10 * 60_000 };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "expired" }), { status: 401 })));
    await expect(figmaRestJson(session401, "/files/file")).rejects.toThrow(/재인증/);
    expect(session401.accessToken).toBeUndefined();

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "forbidden" }), { status: 403 })));
    await expect(figmaRestJson({ accessToken: "access", expiresAt: Date.now() + 10 * 60_000 }, "/files/file")).rejects.toThrow(/접근할 수 없/);

    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "rate limited" }), {
      status: 429,
      headers: { "Retry-After": "12", "X-Figma-Upgrade-Link": "https://figma.com/upgrade" },
    })));
    const error = await figmaRestJson({ accessToken: "access", expiresAt: Date.now() + 10 * 60_000 }, "/files/file").then(() => undefined, (reason) => reason as FigmaRestApiError);
    expect(error).toMatchObject({ status: 429, retryAfter: 12, upgradeUrl: "https://figma.com/upgrade" });
    expect(error?.message).toMatch(/12초.*업그레이드 안내/);
  });
});

describe("Plugin Codex question answer contract", () => {
  it("Structured Output의 evidence 객체는 모든 속성을 required nullable로 선언한다", () => {
    const schema = JSON.parse(readFileSync(new URL("../server/figma-answer.schema.json", import.meta.url), "utf8"));
    const evidenceItem = schema.properties.evidence.items;

    expect(evidenceItem.required).toEqual(Object.keys(evidenceItem.properties));
    for (const key of ["nodeId", "versionId", "artifactId", "tool", "detail"]) {
      expect(evidenceItem.properties[key].type).toEqual(["string", "null"]);
    }
  });

  it("Codex JSONL의 실제 실패를 사용하고 원시 stderr 내부 지침은 노출하지 않는다", () => {
    const stdout = `${JSON.stringify({
      type: "turn.failed",
      error: { message: JSON.stringify({ error: { code: "invalid_json_schema", message: "Missing nodeId" }, status: 400 }) },
    })}\n`;
    const stderr = "Base Risk Taxonomy\\nprivate model instructions\\n...[truncated 32165 characters]";
    const message = codexQuestionFailureMessage(stdout, stderr, 1);

    expect(message).toMatch(/출력 형식/);
    expect(message).not.toContain("Base Risk Taxonomy");
    expect(message).not.toContain("private model instructions");
  });

  it("근거와 불확실성이 있는 구조화 답변만 수용한다", () => {
    const answer = normalizeCodexBridgeAnswer(JSON.stringify({
      answer: "이 노드는 주요 기사를 탐색하는 피드입니다.",
      evidence: [{ kind: "node", nodeId: "66:27616" }, { kind: "artifact", artifactId: "image-1" }],
      uncertainties: ["실제 비즈니스 KPI는 디자인 근거에 없습니다."],
    }));
    expect(answer).toMatchObject({ evidence: [{ nodeId: "66:27616" }, { artifactId: "image-1" }], promptVersion: "figma-node-qa-v1" });
    expect(answer.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(() => normalizeCodexBridgeAnswer("not-json")).toThrow(/JSON/);
    expect(() => normalizeCodexBridgeAnswer(JSON.stringify({ answer: "", evidence: [], uncertainties: [] }))).toThrow(/본문/);
  });
});
