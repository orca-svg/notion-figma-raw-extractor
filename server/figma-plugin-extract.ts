import { strFromU8, strToU8 } from "fflate";
import { performance } from "node:perf_hooks";
import { buildSemanticHints, loadFigmaHistory, loadFigmaRestMetadata } from "./figma-history.js";
import { FigmaPluginBridge } from "./figma-plugin-bridge.js";
import { runPluginCodexQuestion } from "./figma-question.js";
import { figmaRestOAuthStatus } from "./figma-rest-client.js";
import { storeArtifact, storeBundleFile } from "./figma-run-store.js";
import { buildScreensViewer } from "./figma-screens-viewer.js";
import { SpecMarkCollector, type SpecAnnotationRef, type SpecScreenRef } from "./figma-spec-marks.js";
import { parseFigmaTarget } from "./figma-target.js";
import type {
  DesignContextPackage,
  EmitEvent,
  ExtractionEvent,
  FigmaExtractionInput,
  FigmaFileType,
  FigmaPageNodeIndex,
  FigmaPagePackage,
  FigmaPluginExtractionResult,
  FigmaRestOAuthSession,
  FigmaRunRecord,
  FigmaScreenProposal,
  TraceOrigin,
} from "./types.js";

function byteLength(value: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(value)); } catch { return 0; }
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9가-힣_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "node";
}

type PluginPage = NonNullable<FigmaPluginExtractionResult["page"]>;

/**
 * 화면·기능 묶음 PNG를 기기별 폴더에 두고, 무엇이 어디 있는지 screens.json 하나로 색인한다.
 * 섹션(화면 안의 영역)은 이미지로 자르지 않는다. 화면 이미지와 좌표만 있으면 필요할 때 잘라 쓸 수 있다.
 */
function storeScreens(
  page: PluginPage,
  uploads: Map<string, { data: Uint8Array; mimeType: string }>,
  run: FigmaRunRecord,
  artifactRefs: NonNullable<ExtractionEvent["artifacts"]>,
): { summary: NonNullable<FigmaPagePackage["screens"]>; rejected: number; specRefs: { screens: SpecScreenRef[]; annotations: SpecAnnotationRef[] } } | undefined {
  const screens = page.screens ?? [];
  const groups = page.groups ?? [];
  const annotations = page.annotations ?? [];
  if (screens.length === 0 && groups.length === 0 && annotations.length === 0) return undefined;
  let rejected = 0;
  // 저장에 성공한 경로만 돌려준다. 실패한 경로를 색인에 적으면 ZIP에 없는 파일을 가리키게 된다.
  const store = (slot: string | undefined, path: string): string | undefined => {
    const upload = slot ? uploads.get(slot) : undefined;
    if (!upload) return undefined;
    const stored = storeArtifact(run, { data: upload.data, mimeType: upload.mimeType, kind: "screenshot", stem: path.replace(/\.png$/, ""), path });
    if (!stored) { rejected += 1; return undefined; }
    artifactRefs.push(stored);
    return path;
  };
  const stemOf = (name: string, nodeId: string) => `${safeFilePart(name)}-${nodeId.replace(/:/g, "-")}`;
  // Figma 단위 사각형을 이미지 픽셀로. 이미지 원점은 그려진 범위의 왼쪽 위라 renderOffset만큼 민다.
  const toImage = (rect: { x: number; y: number; width: number; height: number }, scale: number, offset?: { x: number; y: number }) => ({
    x: Math.round((rect.x + (offset?.x ?? 0)) * scale),
    y: Math.round((rect.y + (offset?.y ?? 0)) * scale),
    width: Math.round(rect.width * scale),
    height: Math.round(rect.height * scale),
  });
  const offsetPx = (offset: { x: number; y: number } | undefined, scale: number) => ({ x: Math.round((offset?.x ?? 0) * scale), y: Math.round((offset?.y ?? 0) * scale) });
  const annotationCount = new Map<string, number>();
  for (const annotation of annotations) if (annotation.screenNodeId) annotationCount.set(annotation.screenNodeId, (annotationCount.get(annotation.screenNodeId) ?? 0) + 1);

  const screenEntries = screens.map((screen) => {
    const base = `screens/${safeFilePart(screen.device)}/${stemOf(screen.nodeName, screen.nodeId)}`;
    const viewportPath = store(screen.slot, `${base}.png`);
    return {
      nodeId: screen.nodeId,
      name: screen.nodeName,
      type: screen.nodeType,
      device: screen.device,
      size: { width: screen.width, height: screen.height },
      path: screen.path,
      groupNodeId: screen.groupNodeId,
      images: {
        viewport: viewportPath ? { path: viewportPath, scale: screen.scale, offset: offsetPx(screen.renderOffset, screen.scale ?? 1) } : undefined,
      },
      annotations: annotationCount.get(screen.nodeId) || undefined,
      error: viewportPath ? undefined : screen.error ?? "화면 이미지를 저장하지 못했습니다.",
    };
  });

  const groupEntries = groups.map((group) => {
    const imagePath = store(group.slot, `groups/${stemOf(group.nodeName, group.nodeId)}.png`);
    const scale = group.scale ?? 1;
    return {
      nodeId: group.nodeId,
      name: group.nodeName,
      type: group.nodeType,
      path: group.path,
      size: { width: group.width, height: group.height },
      image: imagePath ? { path: imagePath, scale, offset: offsetPx(group.renderOffset, scale) } : undefined,
      screens: group.screens.map((screen) => {
        const rect = { x: screen.x, y: screen.y, width: screen.width, height: screen.height };
        return { nodeId: screen.nodeId, rect, imageRect: toImage(rect, scale, group.renderOffset) };
      }),
      error: imagePath ? undefined : group.error ?? "기능 묶음 이미지를 저장하지 못했습니다.",
    };
  });

  const screenById = new Map(screens.map((screen) => [screen.nodeId, screen]));
  const groupById = new Map(groups.map((group) => [group.nodeId, group]));
  const categoryById = new Map((page.annotationCategories ?? []).map((category) => [category.id, category]));
  const annotationEntries = annotations.map((annotation) => {
    const screen = annotation.screenNodeId ? screenById.get(annotation.screenNodeId) : undefined;
    const group = !screen && annotation.groupNodeId ? groupById.get(annotation.groupNodeId) : undefined;
    // 주석이 가리키는 영역을 그 화면(없으면 묶음) 이미지 위 픽셀로 옮긴다. 이미지가 없으면 좌표만 남긴다.
    const image = screen?.slot && annotation.rect
      ? toImage(annotation.rect, screen.scale ?? 1, screen.renderOffset)
      : group?.slot && annotation.rect ? toImage(annotation.rect, group.scale ?? 1, group.renderOffset) : undefined;
    return {
      nodeId: annotation.nodeId,
      nodeName: annotation.nodeName,
      nodeType: annotation.nodeType,
      category: annotation.categoryId ? categoryById.get(annotation.categoryId)?.label ?? annotation.categoryId : undefined,
      label: annotation.label,
      labelMarkdown: annotation.labelMarkdown,
      properties: annotation.properties,
      screenNodeId: annotation.screenNodeId,
      groupNodeId: annotation.groupNodeId,
      rect: annotation.rect,
      imageRect: image,
    };
  });

  const byDevice: Record<string, number> = {};
  for (const screen of screens) byDevice[screen.device] = (byDevice[screen.device] ?? 0) + 1;
  const indexPath = "screens.json";
  const index = {
    schemaVersion: 1,
    note: [
      "화면 = 이 파일에서 배운 기기 크기에 맞는 가장 바깥 프레임입니다. devices의 source는 근거입니다. name은 기기 이름이 붙은 프레임, repeat은 이름 없이 화면 밖에서 3번 이상 반복된 크기, default는 둘 다 없어 쓴 모바일 기본 범위(360~430폭)입니다. repeat과 default는 추정이므로 확인이 필요합니다.",
      "images.viewport는 Figma 화면에서 보이는 그대로의 화면입니다. 뷰포트가 가린 스크롤 영역은 이미지로 꺼내지 않으며, 그 내용은 nodes/의 노드 JSON에 있습니다.",
      "ignoredDevices는 화면 크기로 인정하지 않은 후보입니다. 이름은 기기 같지만 모두 다른 화면 안에 있는 크기(컴포넌트)와, 다른 화면 크기 프레임을 여럿 품은 반복 크기(기능 묶음)가 여기에 남습니다.",
      "groups는 화면을 둘 이상 품은 가장 안쪽 컨테이너입니다. rect는 Figma 단위, imageRect는 묶음 이미지 픽셀입니다.",
      "이미지 원점은 프레임이 아니라 그려진 범위(그림자·프레임 밖으로 넘친 내용 포함)의 왼쪽 위입니다. images.viewport.offset과 image.offset은 프레임 원점이 이미지 안에서 놓인 픽셀 위치이고, 모든 imageRect에는 이미 반영되어 있습니다.",
      "annotations는 Figma 기본 주석입니다. 노드에 직접 붙어 있으므로 screenNodeId·groupNodeId는 붙은 노드의 조상에서 정했습니다. rect는 화면 원점(화면 밖이면 묶음 원점, 둘 다 없으면 페이지) 기준 Figma 단위, imageRect는 그 화면(또는 묶음) 이미지 픽셀입니다. category는 파일의 주석 카테고리 이름입니다.",
    ],
    devices: page.devices ?? [],
    ignoredDevices: page.ignoredDevices ?? [],
    screens: screenEntries,
    groups: groupEntries,
    annotationCategories: page.annotationCategories ?? [],
    annotations: annotationEntries,
  };
  storeBundleFile(run, indexPath, strToU8(JSON.stringify(index, null, 2)));
  // 번들을 푼 폴더에서 더블클릭으로 화면·묶음·주석을 한 번에 본다. PNG를 하나씩 열지 않아도 된다.
  // 화면 이미지와 같은 screens/에 두어 찾기 쉽게 하고, 번들 루트 기준 경로는 한 단계 위에서 읽는다.
  storeBundleFile(run, "screens/screens.html", strToU8(buildScreensViewer(index, `${page.name} 화면`, "../")));

  return {
    summary: {
      total: screens.length,
      byDevice,
      groups: groupEntries.filter((group) => group.image).length,
      failed: screenEntries.filter((screen) => screen.error).length + groupEntries.filter((group) => group.error).length,
      annotations: annotationEntries.length,
      indexPath,
    },
    rejected,
    // 번호 배지 표시를 화면 이미지 위 좌표로 옮기고, 설명 문장과 주석을 대조할 때 쓴다.
    specRefs: {
      screens: screenEntries.map((screen) => ({
        nodeId: screen.nodeId,
        image: screen.images.viewport ? { scale: screen.images.viewport.scale ?? 1, offset: screen.images.viewport.offset } : undefined,
      })),
      annotations: annotationEntries.map((annotation) => ({ screenNodeId: annotation.screenNodeId, text: annotation.label ?? annotation.labelMarkdown ?? "" })),
    },
  };
}

/**
 * 번호 배지 표시와 설명 칸을 이은 spec-marks.json. 이미 저장한 노드 JSON 조각을 하나씩 읽어 가벼운 트리로 줄인 뒤 만든다.
 * 명세 배지를 쓰지 않는 페이지면 파일을 만들지 않는다. 여기서 실패해도 추출은 멈추지 않고 사유만 남긴다.
 */
function storeSpecMarks(
  run: FigmaRunRecord,
  refs: { screens: SpecScreenRef[]; annotations: SpecAnnotationRef[] } | undefined,
): { summary: NonNullable<FigmaPagePackage["specMarks"]> } | { error: string } | undefined {
  try {
    const collector = new SpecMarkCollector();
    for (const [path, data] of run.bundleFiles) {
      if (path.startsWith("nodes/") && path.endsWith(".json")) collector.addPart(JSON.parse(strFromU8(data)));
    }
    const index = collector.build({ screens: refs?.screens ?? [], annotations: refs?.annotations ?? [] });
    if (index.summary.marks === 0 && index.summary.legends === 0) return undefined;
    const indexPath = "spec-marks.json";
    if (!storeBundleFile(run, indexPath, strToU8(JSON.stringify(index, null, 2)))) return { error: "실행당 용량 상한으로 spec-marks.json을 저장하지 못했습니다." };
    return { summary: { ...index.summary, indexPath } };
  } catch (error) {
    return { error: `번호 배지 색인을 만들지 못했습니다: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/**
 * 추출 전 확인 화면용 스캔. 플러그인이 이미지 없이 화면 크기 후보를 계산하므로 빠르다.
 * 운영자가 고른 후보는 추출 요청의 screenDevices로 다시 들어온다.
 */
export async function scanPluginScreens(bridge: FigmaPluginBridge, ownerSessionId: string, signal?: AbortSignal): Promise<FigmaScreenProposal> {
  const connection = bridge.status(ownerSessionId);
  if (!connection.connected) throw new Error("Figma 플러그인을 먼저 페어링하고 열린 상태로 유지해 주세요.");
  const fileKey = connection.meta.fileKey;
  if (!fileKey) throw new Error("열린 Figma 파일의 file key를 확인할 수 없습니다.");
  const fileType: FigmaFileType = connection.meta.editorType === "figjam" ? "figjam" : "design";
  const completed = await bridge.requestPageExtraction(ownerSessionId, fileKey, fileType, signal, { scanOnly: true });
  const page = completed.result.page;
  if (!page) throw new Error("플러그인이 현재 페이지 정보를 돌려주지 않았습니다.");
  const screens = page.screens ?? [];
  return {
    fileKey,
    fileName: connection.meta.fileName,
    pageId: page.id,
    pageName: page.name,
    nodeCount: completed.result.nodeCount,
    devices: page.devices ?? [],
    ignoredDevices: page.ignoredDevices ?? [],
    screens: screens.length,
    groups: page.groups?.length ?? 0,
  };
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
    ? await bridge.requestPageExtraction(ownerSessionId, fileKey, fileType, signal, { devices: input.screenDevices, expectedPageId: input.screenPageId })
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

  // 화면 단위 이미지. 최상위 노드 한 장은 페이지 배치도로 남기고, 화면을 읽는 이미지는 여기서 따로 둔다.
  const screenIndex = completed.result.page ? storeScreens(completed.result.page, completed.artifacts, run, artifactRefs) : undefined;
  if (screenIndex) storeRejected += screenIndex.rejected;
  // 노드 JSON 조각이 모두 저장된 뒤에 만든다. 조각을 이어 붙여야 설명 칸과 표시의 공통 조상을 본다.
  const specMarks = completed.result.page ? storeSpecMarks(run, screenIndex?.specRefs) : undefined;

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
  // 화면 이미지가 빠지면 KB에서 그 화면이 통째로 사라진다. screens.json을 열지 않아도 보이게 한다.
  const screenNote = screenIndex ? `화면 ${screenIndex.summary.total}개(${Object.entries(screenIndex.summary.byDevice).map(([device, count]) => `${device} ${count}`).join(", ")}), 기능 묶음 ${screenIndex.summary.groups}장, 주석 ${screenIndex.summary.annotations}건을 저장했습니다.${screenIndex.summary.failed ? ` ${screenIndex.summary.failed}건은 이미지를 만들지 못했습니다(screens.json의 error 참고).` : ""}` : undefined;
  if (storeRejected) assetNotes.push(`실행당 용량 상한으로 ${storeRejected}개`);
  const specNote = specMarks && "summary" in specMarks
    ? `번호 배지 표시 ${specMarks.summary.marks}개를 설명 칸 ${specMarks.summary.legends}개와 이었습니다(확정 ${specMarks.summary.linked}, 확인 필요 ${specMarks.summary.ambiguous}, 설명 없음 ${specMarks.summary.unlinked}; spec-marks.json).`
    : specMarks?.error;

  await finishEvent(artifactStep, {
    state: completed.result.partial || assetNotes.length > 0 || Boolean(screenIndex?.summary.failed) || completed.result.artifacts.some((artifact) => !completed.artifacts.has(artifact.slot)) ? "warning" : "success",
    response: { artifacts: artifactRefs, pageNodes: pageNodeIndex, omittedAssets: completed.result.omittedAssets },
    extracted: { artifacts: artifactRefs.length, jsonParts: pageNodeIndex.filter((node) => node.jsonPath).length, candidates: completed.result.artifacts.length, omittedAssets: lost },
    artifacts: artifactRefs,
    message: [
      completed.result.partial ? "page.json에 부분 추출 또는 실패한 프레임을 표시했습니다." : undefined,
      assetNotes.length > 0 ? `에셋 ${assetNotes.join(", ")}를 담지 못했습니다.` : undefined,
      dedupNote,
      screenNote,
      specNote,
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
      screens: screenIndex?.summary,
      specMarks: specMarks && "summary" in specMarks ? specMarks.summary : undefined,
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
