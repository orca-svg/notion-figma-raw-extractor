type BridgeJobOptions = {
  maxNodes: number;
  maxJsonBytes: number;
  maxDimension: number;
  maxAssets: number;
  maxAssetBytes: number;
};

type BridgeJob = {
  id: string;
  type: "extract_node";
  target: { fileKey: string; nodeId: string; fileType: "design" | "figjam"; sourceUrl: string };
  options: BridgeJobOptions;
} | {
  id: string;
  type: "extract_page";
  fileKey: string;
  fileType: "design" | "figjam";
  options: BridgeJobOptions;
};

type ArtifactPayload = {
  slot: string;
  kind: "screenshot" | "asset" | "binary" | "json";
  mimeType: string;
  name: string;
  data: Uint8Array;
  /** 같은 내용을 쓰는 노드들. 중복 파일 대신 위치를 모아 남긴다. */
  usages?: Array<{ nodeId: string; nodeName: string }>;
};

type PageNodeResult = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  jsonSlot?: string;
  screenshotSlot?: string;
  /** 예산을 넘어 서브트리 단위로 나뉜 조각들. 각 조각은 단독으로 파싱된다. */
  parts?: Array<{ slot: string; nodeId: string; nodeName: string; nodeType: string; nodeCount: number; parentNodeId?: string; bytes: number }>;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  error?: string;
};

type PluginResult = {
  scope: "node" | "current_page";
  snapshot?: unknown;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  meta: ReturnType<typeof pluginMeta> & { nodeId?: string; nodeName?: string; nodeType?: string };
  page?: { id: string; name: string; nodes: PageNodeResult[] };
  /** 담지 못한 에셋의 사유별 개수. 0이면 생략한다. */
  omittedAssets?: { cap: number; oversized: number; failed: number; duplicate: number };
  artifacts: Array<Omit<ArtifactPayload, "data"> & { bytes: number }>;
};

figma.skipInvisibleInstanceChildren = true;
figma.showUI(__html__, { width: 320, height: 330, themeColors: true });

function pluginMeta() {
  return {
    pluginVersion: "1.1.0",
    editorType: figma.editorType === "figjam" ? "figjam" as const : "figma" as const,
    fileKey: figma.fileKey,
    fileName: figma.root.name,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    user: figma.currentUser ? { id: figma.currentUser.id, name: figma.currentUser.name, photoUrl: figma.currentUser.photoUrl } : undefined,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 직렬화 예산(maxNodes)에서 스캔을 멈추면 총계를 알 수 없어 "3천 개를 잃고 1개 누락"이라고 적게 된다.
 * 누락 개수를 정직하게 보고하려면 트리를 끝까지 세야 한다. 병적으로 큰 파일만 이 천장에서 멈춘다.
 */
const SCAN_CEILING = 200_000;

function countSceneNodes(node: BaseNode, limit: number, collector?: SceneNode[]): number {
  let count = "id" in node ? 1 : 0;
  if (collector && "type" in node && node.type !== "DOCUMENT" && node.type !== "PAGE") collector.push(node as SceneNode);
  if (count >= limit || !("children" in node)) return count;
  for (const child of node.children) {
    count += countSceneNodes(child, limit - count, collector);
    if (count >= limit) break;
  }
  return count;
}

/**
 * id와 type만 보고 노드를 세면 boundVariables의 VARIABLE_ALIAS까지 노드로 잡힌다.
 * 실제 파일에서 별칭 2,889개가 5,000 예산의 58%를 먹어 진짜 노드가 잘려나갔다.
 * 노드는 document 또는 children을 통해서만 도달하므로 그 자리에서만 센다.
 */
function pruneSnapshot(value: unknown, maxNodes: number): { value: unknown; kept: number } {
  let kept = 0;
  const visit = (candidate: unknown, nodePosition: boolean): unknown => {
    if (Array.isArray(candidate)) return candidate.map((item) => visit(item, nodePosition)).filter((item) => item !== undefined);
    if (!isRecord(candidate)) return candidate;
    const isNode = nodePosition && typeof candidate.id === "string" && typeof candidate.type === "string";
    if (isNode) {
      if (kept >= maxNodes) return undefined;
      kept += 1;
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate)) {
      const childIsNodePosition = key === "children" || key === "document";
      if (childIsNodePosition && Array.isArray(child)) result[key] = child.map((item) => visit(item, true)).filter((item) => item !== undefined);
      else result[key] = visit(child, childIsNodePosition);
    }
    return result;
  };
  return { value: visit(value, true), kept };
}

function mimeFromBytes(data: Uint8Array): string {
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return "image/png";
  if (data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return "image/gif";
  if (data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46) return "image/webp";
  return "application/octet-stream";
}

function safeName(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9가-힣_-]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "asset";
}

function utf8Bytes(value: string): Uint8Array {
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    let code = value.charCodeAt(index);
    if (code < 0x80) bytes.push(code);
    else if (code < 0x800) bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const low = value.charCodeAt(index + 1);
      if (low >= 0xdc00 && low <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
        bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
        index += 1;
      } else bytes.push(0xef, 0xbf, 0xbd);
    } else bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
  }
  return Uint8Array.from(bytes);
}

type SnapshotPart = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  value: unknown;
  nodeCount: number;
  parentNodeId?: string;
};

/** children을 뺀 자기 속성만의 직렬화 길이. 트리 크기를 한 번의 순회로 아래에서 위로 합산한다. */
function measureTree(node: Record<string, unknown>, sizes: Map<Record<string, unknown>, number>): number {
  let own = 2;
  for (const [key, value] of Object.entries(node)) {
    if (key === "children") continue;
    own += JSON.stringify(key).length + 1 + JSON.stringify(value === undefined ? null : value).length + 1;
  }
  let total = own;
  for (const child of nodeChildren(node)) total += measureTree(child, sizes) + 1;
  sizes.set(node, total);
  return total;
}

function nodeChildren(node: Record<string, unknown>): Array<Record<string, unknown>> {
  const children = node.children;
  if (!Array.isArray(children)) return [];
  return children.filter((child): child is Record<string, unknown> => isRecord(child) && typeof child.id === "string" && typeof child.type === "string");
}

/** 서브트리의 노드 개수. 예산에 통째로 들어간 가지를 셀 때 쓴다. */
function countTreeNodes(node: Record<string, unknown>): number {
  let count = 1;
  for (const child of nodeChildren(node)) count += countTreeNodes(child);
  return count;
}

/**
 * 트리를 "예산에 들어가는 서브트리" 단위로 쪼갠다. JSON을 바이트로 자르면 조각이 파싱되지 않으므로
 * 경계를 항상 노드에 맞추고, 떼어낸 자리에는 __part 참조 스텁을 남겨 다시 이어붙일 수 있게 한다.
 */
function splitIntoParts(document: Record<string, unknown>, maxBytesPerPart: number): SnapshotPart[] {
  const sizes = new Map<Record<string, unknown>, number>();
  measureTree(document, sizes);
  const parts: SnapshotPart[] = [];
  const pending: Array<{ node: Record<string, unknown>; parentNodeId?: string }> = [{ node: document }];

  while (pending.length > 0) {
    const { node, parentNodeId } = pending.shift()!;
    // 자기 속성만으로 이미 예산을 넘으면 더 쪼갤 수 없다. 그 노드는 그대로 두고 넘어간다.
    let left = maxBytesPerPart;
    let count = 0;

    const build = (current: Record<string, unknown>): Record<string, unknown> => {
      const copy: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(current)) if (key !== "children") copy[key] = value;
      count += 1;
      const children = nodeChildren(current);
      if (children.length === 0) return copy;
      const kept: unknown[] = [];
      for (const child of children) {
        const size = sizes.get(child) ?? 0;
        if (size <= left) {
          // 통째로 들어간다. 예산에서 한 번만 빼고 내부는 더 계산하지 않는다.
          left -= size;
          kept.push(child);
          count += countTreeNodes(child);
        } else {
          kept.push({ id: child.id, type: child.type, name: child.name, __part: String(child.id) });
          pending.push({ node: child, parentNodeId: String(current.id) });
        }
      }
      copy.children = kept;
      return copy;
    };

    const value = build(node);
    parts.push({
      nodeId: String(node.id),
      nodeName: String(node.name ?? ""),
      nodeType: String(node.type ?? ""),
      value,
      nodeCount: count,
      parentNodeId,
    });
  }

  return parts;
}

function serializedSnapshot(rawSnapshot: unknown, maxNodes: number, maxBytes: number) {
  let pruned = pruneSnapshot(rawSnapshot, maxNodes);
  let serialized = JSON.stringify(pruned.value);
  let encoded = utf8Bytes(serialized);
  while (encoded.byteLength > maxBytes && pruned.kept > 100) {
    pruned = pruneSnapshot(rawSnapshot, Math.max(100, Math.floor(pruned.kept / 2)));
    serialized = JSON.stringify(pruned.value);
    encoded = utf8Bytes(serialized);
  }
  if (encoded.byteLength > maxBytes) throw new Error(`JSON이 ${Math.round(maxBytes / 1024 / 1024)}MB 제한을 넘습니다.`);
  return { ...pruned, encoded };
}

async function screenshot(node: SceneNode, maxDimension: number, maxBytes: number, slot = "screenshot"): Promise<ArtifactPayload | undefined> {
  if (!("exportAsync" in node)) return undefined;
  const bounds = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
  const longest = bounds ? Math.max(bounds.width, bounds.height) : 0;
  let scale = longest > 0 ? Math.min(1, maxDimension / longest) : 1;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const data = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value: Math.max(0.01, scale) } });
      if (data.byteLength <= maxBytes) return { slot, kind: "screenshot", mimeType: "image/png", name: `${safeName(node.name)}.png`, data };
      scale *= .65;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** 담지 못한 에셋의 사유별 집계. 침묵하면 무엇을 잃었는지 알 길이 없다. */
const assetLoss = { cap: 0, oversized: 0, failed: 0, duplicate: 0 };

/** 샌드박스에 crypto가 없다. 내용 동일성 판정에는 FNV-1a로 충분하고 길이를 함께 봐 충돌을 막는다. */
function contentKey(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < data.length; index += 1) {
    hash ^= data[index];
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `${data.length}-${hash.toString(16)}`;
}

async function sourceAssets(nodes: SceneNode[], options: BridgeJobOptions): Promise<ArtifactPayload[]> {
  const artifacts: ArtifactPayload[] = [];
  const imageHashes = new Set<string>();
  // 같은 아이콘이 76번 쓰이면 예전에는 파일 76개가 나왔다. 내용이 같으면 하나만 담고
  // 어디에 쓰였는지는 usages로 모은다. 중복이 예산을 먹어 고유 자산을 밀어내지 않게 한다.
  const byContent = new Map<string, ArtifactPayload>();
  assetLoss.cap = 0;
  assetLoss.oversized = 0;
  assetLoss.failed = 0;
  assetLoss.duplicate = 0;

  const remember = (key: string, node: SceneNode, make: () => ArtifactPayload): void => {
    const existing = byContent.get(key);
    if (existing) {
      existing.usages = existing.usages ?? [];
      if (existing.usages.length < 500) existing.usages.push({ nodeId: node.id, nodeName: node.name });
      assetLoss.duplicate += 1;
      return;
    }
    if (artifacts.length >= options.maxAssets) { assetLoss.cap += 1; return; }
    const artifact = make();
    artifact.usages = [{ nodeId: node.id, nodeName: node.name }];
    byContent.set(key, artifact);
    artifacts.push(artifact);
  };

  for (const node of nodes) {
    if (!("fills" in node) || !Array.isArray(node.fills)) continue;
    for (const paint of node.fills) {
      if (paint.type !== "IMAGE" || !paint.imageHash) continue;
      if (imageHashes.has(paint.imageHash)) {
        const existing = byContent.get(`image:${paint.imageHash}`);
        if (existing) {
          existing.usages = existing.usages ?? [];
          if (existing.usages.length < 500) existing.usages.push({ nodeId: node.id, nodeName: node.name });
        }
        continue;
      }
      imageHashes.add(paint.imageHash);
      const image = figma.getImageByHash(paint.imageHash);
      if (!image) { assetLoss.failed += 1; continue; }
      try {
        const data = await image.getBytesAsync();
        if (data.byteLength > options.maxAssetBytes) { assetLoss.oversized += 1; continue; }
        const mimeType = mimeFromBytes(data);
        const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "png";
        remember(`image:${paint.imageHash}`, node, () => ({ slot: `image-${artifacts.length + 1}`, kind: "asset", mimeType, name: `${safeName(node.name)}.${extension}`, data }));
      } catch { assetLoss.failed += 1; }
    }
  }

  const vectorTypes = new Set<SceneNode["type"]>(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
  for (const node of nodes) {
    if (!vectorTypes.has(node.type) || !/(icon|logo|glyph|mark|symbol)/i.test(node.name) || !("exportAsync" in node)) continue;
    try {
      const data = await node.exportAsync({ format: "SVG" });
      if (data.byteLength > options.maxAssetBytes) { assetLoss.oversized += 1; continue; }
      remember(`svg:${contentKey(data)}`, node, () => ({ slot: `svg-${artifacts.length + 1}`, kind: "asset", mimeType: "image/svg+xml", name: `${safeName(node.name)}.svg`, data }));
    } catch { assetLoss.failed += 1; }
  }
  return artifacts;
}

function validateFile(job: BridgeJob) {
  if (!figma.fileKey) throw new Error("개발 플러그인의 Private Plugin API에서 file key를 읽지 못했습니다.");
  const fileKey = job.type === "extract_node" ? job.target.fileKey : job.fileKey;
  const fileType = job.type === "extract_node" ? job.target.fileType : job.fileType;
  if (figma.fileKey !== fileKey) throw new Error("열린 Figma 파일과 Trace Studio 대상의 file key가 다릅니다.");
  const expectedEditor = fileType === "design" ? "figma" : "figjam";
  if (pluginMeta().editorType !== expectedEditor) throw new Error(`${fileType === "design" ? "Figma Design" : "FigJam"} 파일에서 플러그인을 열어 주세요.`);
}

async function extractNode(job: Extract<BridgeJob, { type: "extract_node" }>): Promise<{ result: PluginResult; payloads: ArtifactPayload[] }> {
  const base = await figma.getNodeByIdAsync(job.target.nodeId);
  if (!base || base.type === "DOCUMENT" || base.type === "PAGE" || !("exportAsync" in base)) throw new Error("링크의 프레임 또는 레이어를 현재 파일에서 찾지 못했습니다.");
  const node = base as SceneNode;
  const scanned: SceneNode[] = [];
  const totalKnown = countSceneNodes(node, SCAN_CEILING, scanned);
  const snapshot = serializedSnapshot(await node.exportAsync({ format: "JSON_REST_V1" }), job.options.maxNodes, job.options.maxJsonBytes);
  const payloads: ArtifactPayload[] = [];
  const preview = await screenshot(node, job.options.maxDimension, job.options.maxAssetBytes);
  if (preview) payloads.push(preview);
  payloads.push(...await sourceAssets(scanned.slice(0, job.options.maxNodes), job.options));
  const partial = totalKnown > job.options.maxNodes || snapshot.kept < totalKnown;
  return {
    result: {
      scope: "node",
      snapshot: snapshot.value,
      nodeCount: snapshot.kept,
      partial,
      omittedNodes: partial ? Math.max(1, totalKnown - snapshot.kept) : undefined,
      meta: { ...pluginMeta(), nodeId: node.id, nodeName: node.name, nodeType: node.type },
      artifacts: payloads.map(({ data, ...artifact }) => ({ ...artifact, bytes: data.byteLength })),
    },
    payloads,
  };
}

async function extractPage(job: Extract<BridgeJob, { type: "extract_page" }>): Promise<{ result: PluginResult; payloads: ArtifactPayload[] }> {
  await figma.currentPage.loadAsync();
  const page = figma.currentPage;
  const payloads: ArtifactPayload[] = [];
  const pageNodes: PageNodeResult[] = [];
  const scanned: SceneNode[] = [];
  let nodeCount = 0;
  let omittedNodes = 0;
  for (const [index, node] of page.children.entries()) {
    const jsonSlot = `node-json-${index + 1}`;
    const screenshotSlot = `frame-png-${index + 1}`;
    try {
      const localNodes: SceneNode[] = [];
      const totalKnown = countSceneNodes(node, SCAN_CEILING, localNodes);
      // 8만 개를 전개하면 "too many arguments in function call (only 65534 allowed)"로 죽는다.
      for (const candidate of localNodes) scanned.push(candidate);
      const exported = await node.exportAsync({ format: "JSON_REST_V1" });
      const wrapper = isRecord(exported) && isRecord(exported.document) ? exported : { document: exported };
      const document = wrapper.document as Record<string, unknown>;
      // 예산을 넘으면 노드 경계에서 나눈다. 조각마다 유효한 JSON이라 그대로 KB에 넣을 수 있다.
      const split = splitIntoParts(document, job.options.maxJsonBytes);
      const preview = await screenshot(node, job.options.maxDimension, job.options.maxAssetBytes, screenshotSlot);
      const parts: NonNullable<PageNodeResult["parts"]> = [];
      let kept = 0;
      for (const [partIndex, part] of split.entries()) {
        const slot = partIndex === 0 ? jsonSlot : `${jsonSlot}-part-${partIndex + 1}`;
        const body: Record<string, unknown> = { ...wrapper, document: part.value };
        if (partIndex > 0) delete body.components, delete body.componentSets, delete body.styles;
        body.partOf = { nodeId: node.id, index: partIndex + 1, total: split.length };
        if (part.parentNodeId) body.parentNodeId = part.parentNodeId;
        const encoded = utf8Bytes(JSON.stringify(body));
        payloads.push({ slot, kind: "json", mimeType: "application/json", name: `${safeName(part.nodeName || node.name)}-${part.nodeId.replace(/:/g, "-")}.json`, data: encoded });
        parts.push({ slot, nodeId: part.nodeId, nodeName: part.nodeName, nodeType: part.nodeType, nodeCount: part.nodeCount, parentNodeId: part.parentNodeId, bytes: encoded.byteLength });
        kept += part.nodeCount;
      }
      if (preview) payloads.push(preview);
      const partial = kept < totalKnown;
      pageNodes.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        jsonSlot,
        screenshotSlot: preview?.slot,
        parts,
        nodeCount: kept,
        partial,
        omittedNodes: partial ? totalKnown - kept : undefined,
      });
      nodeCount += kept;
      omittedNodes += partial ? totalKnown - kept : 0;
    } catch (error) {
      pageNodes.push({ nodeId: node.id, nodeName: node.name, nodeType: node.type, nodeCount: 0, partial: true, error: error instanceof Error ? error.message : String(error) });
      omittedNodes += 1;
    }
  }
  payloads.push(...await sourceAssets(scanned, job.options));
  const partial = pageNodes.some((node) => node.partial || Boolean(node.error));
  return {
    result: {
      scope: "current_page",
      nodeCount,
      partial,
      omittedNodes: omittedNodes || undefined,
      meta: pluginMeta(),
      page: { id: page.id, name: page.name, nodes: pageNodes },
      omittedAssets: assetLoss.cap + assetLoss.oversized + assetLoss.failed > 0 ? { ...assetLoss } : undefined,
      artifacts: payloads.map(({ data, ...artifact }) => ({ ...artifact, bytes: data.byteLength })),
    },
    payloads,
  };
}

async function extract(job: BridgeJob): Promise<{ result: PluginResult; payloads: ArtifactPayload[] }> {
  validateFile(job);
  return job.type === "extract_page" ? extractPage(job) : extractNode(job);
}

figma.ui.onmessage = async (message: { type?: string; job?: BridgeJob }) => {
  if (message.type === "compact-ui") {
    figma.ui.resize(280, 204);
    return;
  }
  if (message.type === "expand-ui") {
    figma.ui.resize(320, 330);
    return;
  }
  if (message.type !== "job" || !message.job) return;
  try {
    const completed = await extract(message.job);
    figma.ui.postMessage({ type: "job-result", jobId: message.job.id, ...completed });
  } catch (error) {
    figma.ui.postMessage({ type: "job-error", jobId: message.job.id, message: error instanceof Error ? error.message : String(error) });
  }
};

figma.ui.postMessage({ type: "plugin-ready", meta: pluginMeta() });
