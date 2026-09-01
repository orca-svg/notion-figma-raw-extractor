import { strToU8 } from "fflate";
import { performance } from "node:perf_hooks";
import { buildSemanticHints, loadFigmaHistory, loadFigmaRestMetadata } from "./figma-history.js";
import { FigmaPluginBridge } from "./figma-plugin-bridge.js";
import { runPluginCodexQuestion } from "./figma-question.js";
import { figmaRestOAuthStatus } from "./figma-rest-client.js";
import { storeArtifact, storeBundleFile } from "./figma-run-store.js";
import { parseFigmaTarget } from "./figma-target.js";
import type {
  DesignContextPackage,
  EmitEvent,
  ExtractionEvent,
  FigmaExtractionInput,
  FigmaFileType,
  FigmaPageNodeIndex,
  FigmaRestOAuthSession,
  FigmaRunRecord,
  TraceOrigin,
} from "./types.js";

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9가-힣_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "node";
}

export async function runPluginFigmaExtraction(
  bridge: FigmaPluginBridge,
  ownerSessionId: string,
  restSession: FigmaRestOAuthSession,
  input: FigmaExtractionInput,
  run: FigmaRunRecord,
  emit: EmitEvent,
  signal?: AbortSignal,
): Promise<void> {
  let order = 0;
  const publish = async (event: ExtractionEvent, origin: TraceOrigin = "internal") => {
    await emit({ ...event, provider: "figma", runId: run.id, origin });
  };
  const startEvent = async (group: string, label: string, request: unknown, origin: TraceOrigin) => {
    const event: ExtractionEvent = {
      type: "step",
      id: `${String(++order).padStart(2, "0")}-${group}`,
      order,
      group,
      label,
      state: "running",
      startedAt: new Date().toISOString(),
      request,
    };
    await publish(event, origin);
    return { event, started: performance.now(), origin };
  };
  const finishEvent = async (
    started: Awaited<ReturnType<typeof startEvent>>,
    value: { state?: ExtractionEvent["state"]; response?: unknown; extracted?: unknown; message?: string; artifacts?: ExtractionEvent["artifacts"] },
  ) => {
    await publish({
      ...started.event,
      state: value.state ?? "success",
      elapsedMs: Math.round(performance.now() - started.started),
      response: value.response,
      extracted: value.extracted,
      message: value.message,
      artifacts: value.artifacts,
      responseBytes: value.response === undefined ? undefined : byteLength(value.response) + (value.artifacts ?? []).reduce((sum, artifact) => sum + artifact.bytes, 0),
    }, started.origin);
  };

  const connection = bridge.status(ownerSessionId);
  if (!connection.connected) throw new Error("Figma 플러그인을 먼저 페어링하고 열린 상태로 유지해 주세요.");
  if (!figmaRestOAuthStatus(restSession).connected) throw new Error("파일 작성자·댓글·버전 정보를 포함하려면 Figma 메타데이터 OAuth를 먼저 연결해 주세요.");
  const connectionFileKey = connection.meta.fileKey;
  if (!connectionFileKey) throw new Error("열린 Figma 파일의 file key를 확인할 수 없습니다.");
  const connectionFileType: FigmaFileType = connection.meta.editorType === "figjam" ? "figjam" : "design";

  let fileKey = connectionFileKey;
  let fileType = connectionFileType;
  let nodeTarget: ReturnType<typeof parseFigmaTarget> | undefined;
  const targetStep = await startEvent("target", input.scope === "current_page" ? "현재 Figma 페이지 범위 확인" : "Figma 링크와 Plugin 대상 확인", { target: input.target, scope: input.scope }, "internal");
  if (input.scope === "current_page") {
    run.detectedFileType = fileType;
    await finishEvent(targetStep, {
      response: { scope: input.scope, fileKey, fileType, pageId: connection.meta.pageId, pageName: connection.meta.pageName },
      extracted: { scope: input.scope, fileKey, pageName: connection.meta.pageName },
    });
  } else {
    nodeTarget = parseFigmaTarget(input.target);
    fileKey = nodeTarget.fileKey;
    fileType = nodeTarget.fileType;
    run.detectedFileType = fileType;
    await finishEvent(targetStep, { response: nodeTarget, extracted: nodeTarget });
  }

  const expectedEditor = fileType === "design" ? "figma" : "figjam";
  if (connection.meta.editorType !== expectedEditor) throw new Error(`${fileType === "design" ? "Figma Design" : "FigJam"} 파일에서 플러그인을 열어 주세요.`);
  if (connection.meta.fileKey !== fileKey) throw new Error("열린 Figma 파일과 추출 대상의 file key가 다릅니다.");

  const connectionStep = await startEvent("connection", "Figma Plugin과 메타데이터 OAuth 확인", { expectedEditor, fileKey }, "plugin");
  await finishEvent(connectionStep, {
    response: { plugin: connection.meta, restOAuth: figmaRestOAuthStatus(restSession) },
    extracted: { connected: true, editorType: connection.meta.editorType, fileKeyVerified: true, metadataOAuth: true },
  });

  const metadataStep = await startEvent("metadata", "파일 생성자·댓글·버전 메타데이터 조회", { fileKey }, "rest");
  run.restMetadata = await loadFigmaRestMetadata(restSession, fileKey, signal);
  await finishEvent(metadataStep, {
    response: run.restMetadata,
    extracted: { file: true, comments: true, versions: true, fetchedAt: run.restMetadata.fetchedAt },
    message: "버전 작성자는 해당 버전을 만든 사용자이며 개별 노드 변경의 정확한 작성자를 뜻하지 않습니다.",
  });

  const pluginStep = await startEvent(
    "current-snapshot",
    input.scope === "current_page" ? "Plugin으로 현재 페이지의 최상위 프레임 추출" : "Plugin으로 현재 노드 snapshot 추출",
    { scope: input.scope, limits: { nodesPerTopLevel: 5_000, jsonBytesPerPart: 20 * 1024 * 1024, assets: 20 } },
    "plugin",
  );
  const completed = input.scope === "current_page"
    ? await bridge.requestPageExtraction(ownerSessionId, fileKey, fileType, signal)
    : await bridge.requestExtraction(ownerSessionId, nodeTarget!, signal);
  await finishEvent(pluginStep, {
    state: completed.result.partial ? "warning" : "success",
    response: {
      scope: completed.result.scope,
      snapshot: completed.result.snapshot,
      page: completed.result.page,
      meta: completed.result.meta,
      nodeCount: completed.result.nodeCount,
      partial: completed.result.partial,
      omittedNodes: completed.result.omittedNodes,
    },
    extracted: {
      scope: completed.result.scope,
      page: completed.result.page ? { id: completed.result.page.id, name: completed.result.page.name, topLevelNodes: completed.result.page.nodes.length } : undefined,
      nodeCount: completed.result.nodeCount,
      partial: completed.result.partial,
      omittedNodes: completed.result.omittedNodes,
    },
    message: completed.result.partial ? "일부 최상위 프레임이 제한을 넘었거나 추출에 실패했습니다. page.json에서 누락 사유를 확인하세요." : undefined,
  });

  const artifactStep = await startEvent(
    "artifacts",
    input.scope === "current_page" ? "프레임 JSON·PNG와 원본 asset 저장" : "현재 PNG와 하위 이미지·SVG artifact 저장",
    { candidates: completed.result.artifacts },
    "plugin",
  );
  const artifactRefs = [] as NonNullable<ExtractionEvent["artifacts"]>;
  let storeRejected = 0;
  const assetIndex: Array<{ path: string; name: string; mimeType: string; bytes: number; usages: Array<{ nodeId: string; nodeName: string }> }> = [];
  const pageNodeIndex: FigmaPageNodeIndex[] = [];
  const bySlot = new Map(completed.result.artifacts.map((artifact) => [artifact.slot, artifact]));

  if (completed.result.page) {
    for (const node of completed.result.page.nodes) {
      const stem = `${safeFilePart(node.nodeName)}-${node.nodeId.replace(/:/g, "-")}`;
      const jsonArtifact = node.jsonSlot ? bySlot.get(node.jsonSlot) : undefined;
      const jsonUpload = node.jsonSlot ? completed.artifacts.get(node.jsonSlot) : undefined;
      const jsonPath = jsonArtifact && jsonUpload ? `nodes/${stem}.json` : undefined;
      if (jsonPath && jsonUpload && !storeBundleFile(run, jsonPath, jsonUpload.data)) storeRejected += 1;
      // 큰 트리는 서브트리 파트로 나뉘어 올라온다. 첫 파트는 위의 대표 경로를 그대로 쓰고
      // 나머지는 nodes/<stem>/ 아래에 둔다. 각 파일은 단독으로 파싱되며 __part로 서로를 가리킨다.
      const parts: NonNullable<FigmaPageNodeIndex["parts"]> = [];
      for (const [partIndex, part] of (node.parts ?? []).entries()) {
        const upload = completed.artifacts.get(part.slot);
        if (!upload) continue;
        const partPath = partIndex === 0 && jsonPath
          ? jsonPath
          : `nodes/${stem}/${String(partIndex + 1).padStart(3, "0")}-${safeFilePart(part.nodeName)}-${part.nodeId.replace(/:/g, "-")}.json`;
        if (partIndex > 0 && !storeBundleFile(run, partPath, upload.data)) { storeRejected += 1; continue; }
        parts.push({ path: partPath, nodeId: part.nodeId, name: part.nodeName, type: part.nodeType, nodeCount: part.nodeCount, parentNodeId: part.parentNodeId, bytes: part.bytes });
      }
      const screenshotArtifact = node.screenshotSlot ? bySlot.get(node.screenshotSlot) : undefined;
      const screenshotUpload = node.screenshotSlot ? completed.artifacts.get(node.screenshotSlot) : undefined;
      const candidatePath = screenshotArtifact && screenshotUpload ? `screenshots/${stem}.png` : undefined;
      // storeArtifact는 실행당 artifact 상한을 넘으면 undefined를 돌려주고 아무것도 쓰지 않는다.
      // 그때도 경로를 적어 두면 page.json이 ZIP에 없는 PNG를 가리키게 되므로 저장에 성공한 경우만 기록한다.
      let screenshotPath: string | undefined;
      let screenshotOmitted: string | undefined;
      if (candidatePath && screenshotUpload && screenshotArtifact) {
        const stored = storeArtifact(run, {
          data: screenshotUpload.data,
          mimeType: screenshotUpload.mimeType,
          kind: "screenshot",
          stem,
          path: candidatePath,
        });
        if (stored) {
          artifactRefs.push(stored);
          screenshotPath = candidatePath;
        } else {
          screenshotOmitted = "실행당 artifact 용량 상한을 넘어 PNG를 번들에 넣지 않았습니다.";
        }
      }
      pageNodeIndex.push({
        nodeId: node.nodeId,
        name: node.nodeName,
        type: node.nodeType,
        jsonPath,
        parts: parts.length > 1 ? parts : undefined,
        screenshotPath,
        screenshotOmitted,
        nodeCount: node.nodeCount,
        partial: node.partial,
        omittedNodes: node.omittedNodes,
        error: node.error,
      });
    }
  }

  for (const artifact of completed.result.artifacts) {
    if (artifact.kind === "json" || artifact.kind === "screenshot" && completed.result.page) continue;
    const uploaded = completed.artifacts.get(artifact.slot);
    if (!uploaded) continue;
    const extension = artifact.mimeType === "image/svg+xml" ? "svg" : artifact.mimeType === "image/jpeg" ? "jpg" : artifact.mimeType === "image/webp" ? "webp" : "png";
    const stored = storeArtifact(run, {
      data: uploaded.data,
      mimeType: uploaded.mimeType,
      kind: artifact.kind === "binary" ? "binary" : artifact.kind,
      stem: `plugin-${artifact.slot}-${artifact.name}`,
      path: input.scope === "current_page" && artifact.kind === "asset" ? `assets/${safeFilePart(artifact.name)}-${artifact.slot}.${extension}` : undefined,
    });
    if (stored) {
      artifactRefs.push(stored);
      if (artifact.kind === "asset" && stored.path) {
        assetIndex.push({ path: stored.path, name: artifact.name, mimeType: artifact.mimeType, bytes: artifact.bytes, usages: artifact.usages ?? [] });
      }
    } else storeRejected += 1;
  }

  // 같은 아이콘이 76번 쓰이면 예전에는 파일 76개가 나왔다. 이제 파일은 하나이고
  // 어디에 쓰였는지는 여기에 모인다. 중복 파일이 KB를 오염시키지 않게 한다.
  if (assetIndex.length > 0) {
    storeBundleFile(run, "assets/index.json", strToU8(JSON.stringify({
      schemaVersion: 1,
      note: "내용이 같은 에셋은 파일 하나로 합쳤습니다. usages가 그 에셋을 쓰는 노드 목록입니다.",
      assets: assetIndex,
    }, null, 2)));
  }

  // 에셋이 조용히 빠지면 노드 카운트 때와 같은 맹점이 생긴다. 사유를 문장으로 남긴다.
  const lost = completed.result.omittedAssets;
  const assetNotes: string[] = [];
  if (lost?.cap) assetNotes.push(`개수 상한으로 ${lost.cap}개`);
  if (lost?.oversized) assetNotes.push(`용량 상한으로 ${lost.oversized}개`);
  if (lost?.failed) assetNotes.push(`읽기 실패로 ${lost.failed}개`);
  // 중복 제거는 손실이 아니다. 경고 조건에서 빼고 안내 문구로만 남긴다.
  const dedupNote = lost?.duplicate ? `내용이 같은 에셋 ${lost.duplicate}건은 파일 하나로 합치고 assets/index.json에 사용 위치를 남겼습니다.` : undefined;
  if (storeRejected) assetNotes.push(`실행당 용량 상한으로 ${storeRejected}개`);

  await finishEvent(artifactStep, {
    state: completed.result.partial || assetNotes.length > 0 || completed.result.artifacts.some((artifact) => !completed.artifacts.has(artifact.slot)) ? "warning" : "success",
    response: { artifacts: artifactRefs, pageNodes: pageNodeIndex, omittedAssets: completed.result.omittedAssets },
    extracted: { artifacts: artifactRefs.length, jsonParts: pageNodeIndex.filter((node) => node.jsonPath).length, candidates: completed.result.artifacts.length, omittedAssets: lost },
    artifacts: artifactRefs,
    message: [
      completed.result.partial ? "page.json에 부분 추출 또는 실패한 프레임을 표시했습니다." : undefined,
      assetNotes.length > 0 ? `에셋 ${assetNotes.join(", ")}를 담지 못했습니다.` : undefined,
      dedupNote,
    ].filter(Boolean).join(" ") || undefined,
  });

  if (completed.result.page) {
    run.pagePackage = {
      schemaVersion: 1,
      fileKey,
      editorType: fileType,
      pageId: completed.result.page.id,
      pageName: completed.result.page.name,
      extractedAt: new Date().toISOString(),
      nodes: pageNodeIndex,
      partial: completed.result.partial || pageNodeIndex.some((node) => !node.jsonPath || node.partial || Boolean(node.error) || Boolean(node.screenshotOmitted)),
      assets: {
        stored: assetIndex.length,
        deduplicated: lost?.duplicate ?? 0,
        omitted: { cap: lost?.cap ?? 0, oversized: lost?.oversized ?? 0, failed: lost?.failed ?? 0, storeRejected },
      },
      provenance: [
        { source: "plugin", detail: "열린 Figma 파일의 현재 페이지와 최상위 프레임 JSON·PNG·asset을 읽었습니다." },
        { source: "figma_rest", detail: "Figma REST API에서 파일 metadata, 전체 댓글, 버전 목록을 읽었습니다." },
      ],
    };
    await publish({
      type: "complete",
      id: `${String(++order).padStart(2, "0")}-summary`,
      order,
      group: "summary",
      label: "현재 페이지 추출 완료",
      state: run.pagePackage.partial ? "warning" : "success",
      startedAt: new Date().toISOString(),
      extracted: {
        transport: "plugin",
        scope: "current_page",
        fileType,
        pageId: run.pagePackage.pageId,
        pageName: run.pagePackage.pageName,
        topLevelNodes: pageNodeIndex.length,
        nodes: completed.result.nodeCount,
        artifacts: artifactRefs.length,
        partial: run.pagePackage.partial,
      },
      message: run.pagePackage.partial ? "일부 프레임이 누락되었습니다. page.json의 error와 partial을 확인하세요." : "페이지 JSON, 프레임 PNG, 원본 asset, 파일 metadata를 ZIP으로 받을 수 있습니다.",
    }, "internal");
    return;
  }

  const snapshot = completed.result.snapshot;
  const semanticsStep = await startEvent("semantics", "노드 의미 근거 구성", { editorType: fileType }, "internal");
  const semanticHints = buildSemanticHints(snapshot, fileType);
  await finishEvent(semanticsStep, { response: semanticHints, extracted: { hints: semanticHints.length } });

  const historyStep = await startEvent("history", "최근 5개 버전의 대상 노드 비교", { fileKey, nodeId: nodeTarget!.nodeId, limit: 5 }, "rest");
  let history: DesignContextPackage["history"];
  try {
    history = await loadFigmaHistory(restSession, nodeTarget!, signal);
    await finishEvent(historyStep, {
      response: history,
      extracted: { versions: history.snapshots.length, changes: history.changes.length, actors: history.byActor.length },
      message: "버전 작성자는 버전 간 관찰된 변경에 거칠게 귀속되며 클릭 단위 감사 로그가 아닙니다.",
    });
  } catch (error) {
    // 여기서 그냥 throw하면 history 단계가 running으로 남아 타임라인 스피너가 끝나지 않는다.
    const reason = error instanceof Error ? error.message : String(error);
    await finishEvent(historyStep, { state: "error", message: reason });
    throw new Error(`필수 버전 메타데이터를 읽지 못했습니다. ${reason}`);
  }

  const context: DesignContextPackage = {
    schemaVersion: 1,
    target: nodeTarget!,
    editorType: fileType,
    currentSnapshot: snapshot,
    semanticHints,
    history,
    artifacts: artifactRefs,
    provenance: [
      { source: "plugin", detail: "열린 Figma 파일의 Plugin API에서 현재 노드와 artifact를 읽었습니다." },
      { source: "figma_rest", detail: "Figma REST API에서 파일 metadata, 댓글, 버전과 노드 스냅샷을 읽었습니다." },
    ],
    partial: completed.result.partial,
    omittedNodes: completed.result.omittedNodes,
  };
  run.contextPackage = context;

  if (input.question) {
    const answerStep = await startEvent("answer", "추출 근거로 Codex에 질문", { question: input.question }, "codex");
    const answer = await runPluginCodexQuestion(input.question, context, run.artifacts, signal);
    context.answer = answer;
    await finishEvent(answerStep, {
      response: answer,
      extracted: { evidence: answer.evidence.length, uncertainties: answer.uncertainties.length },
      message: "Plugin·REST 추출 결과만 근거로 생성한 독립 질문 답변입니다.",
    });
  }

  await publish({
    type: "complete",
    id: `${String(++order).padStart(2, "0")}-summary`,
    order,
    group: "summary",
    label: input.question ? "Plugin 추출과 질문 완료" : "Plugin 노드 추출 완료",
    state: completed.result.partial ? "warning" : "success",
    startedAt: new Date().toISOString(),
    extracted: {
      transport: "plugin",
      scope: "node",
      fileType,
      nodes: completed.result.nodeCount,
      versions: history.snapshots.length,
      changes: history.changes.length,
      actors: history.byActor.length,
      artifacts: artifactRefs.length,
      answered: Boolean(context.answer),
      partial: context.partial,
    },
    message: input.question ? "최신 노드와 필수 메타데이터를 추출하고 Codex가 질문에 답했습니다." : "최신 노드, 파일 metadata, 댓글과 버전 변화 근거를 추출했습니다.",
  }, "internal");
}
