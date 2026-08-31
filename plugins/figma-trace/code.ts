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
};

type PageNodeResult = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  jsonSlot?: string;
  screenshotSlot?: string;
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

function pruneSnapshot(value: unknown, maxNodes: number): { value: unknown; kept: number } {
  let kept = 0;
  const visit = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(visit).filter((item) => item !== undefined);
    if (!isRecord(candidate)) return candidate;
    const isNode = typeof candidate.id === "string" && typeof candidate.type === "string";
    if (isNode) {
      if (kept >= maxNodes) return undefined;
      kept += 1;
    }
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(candidate)) {
      if (key === "children" && Array.isArray(child)) result[key] = child.map(visit).filter((item) => item !== undefined);
      else result[key] = visit(child);
    }
    return result;
  };
  return { value: visit(value), kept };
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

async function sourceAssets(nodes: SceneNode[], options: BridgeJobOptions): Promise<ArtifactPayload[]> {
  const artifacts: ArtifactPayload[] = [];
  const imageHashes = new Set<string>();
  for (const node of nodes) {
    if (artifacts.length >= options.maxAssets) break;
    if (!("fills" in node) || !Array.isArray(node.fills)) continue;
    for (const paint of node.fills) {
      if (paint.type !== "IMAGE" || !paint.imageHash || imageHashes.has(paint.imageHash)) continue;
      imageHashes.add(paint.imageHash);
      const image = figma.getImageByHash(paint.imageHash);
      if (!image) continue;
      try {
        const data = await image.getBytesAsync();
        if (data.byteLength > options.maxAssetBytes) continue;
        const mimeType = mimeFromBytes(data);
        const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/gif" ? "gif" : mimeType === "image/webp" ? "webp" : "png";
        artifacts.push({ slot: `image-${artifacts.length + 1}`, kind: "asset", mimeType, name: `${safeName(node.name)}.${extension}`, data });
      } catch { /* inaccessible image */ }
      if (artifacts.length >= options.maxAssets) break;
    }
  }
  const vectorTypes = new Set<SceneNode["type"]>(["VECTOR", "BOOLEAN_OPERATION", "STAR", "POLYGON", "LINE"]);
  for (const node of nodes) {
    if (artifacts.length >= options.maxAssets) break;
    if (!vectorTypes.has(node.type) || !/(icon|logo|glyph|mark|symbol)/i.test(node.name) || !("exportAsync" in node)) continue;
    try {
      const data = await node.exportAsync({ format: "SVG" });
      if (data.byteLength > options.maxAssetBytes) continue;
      artifacts.push({ slot: `svg-${artifacts.length + 1}`, kind: "asset", mimeType: "image/svg+xml", name: `${safeName(node.name)}.svg`, data });
    } catch { /* unsupported vector export */ }
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
  const totalKnown = countSceneNodes(node, job.options.maxNodes + 1, scanned);
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
      const totalKnown = countSceneNodes(node, job.options.maxNodes + 1, localNodes);
      scanned.push(...localNodes.slice(0, Math.max(0, job.options.maxNodes - scanned.length)));
      const snapshot = serializedSnapshot(await node.exportAsync({ format: "JSON_REST_V1" }), job.options.maxNodes, job.options.maxJsonBytes);
      const partial = totalKnown > job.options.maxNodes || snapshot.kept < totalKnown;
      const preview = await screenshot(node, job.options.maxDimension, job.options.maxAssetBytes, screenshotSlot);
      payloads.push({ slot: jsonSlot, kind: "json", mimeType: "application/json", name: `${safeName(node.name)}-${node.id.replace(/:/g, "-")}.json`, data: snapshot.encoded });
      if (preview) payloads.push(preview);
      pageNodes.push({
        nodeId: node.id,
        nodeName: node.name,
        nodeType: node.type,
        jsonSlot,
        screenshotSlot: preview?.slot,
        nodeCount: snapshot.kept,
        partial,
        omittedNodes: partial ? Math.max(1, totalKnown - snapshot.kept) : undefined,
      });
      nodeCount += snapshot.kept;
      omittedNodes += partial ? Math.max(1, totalKnown - snapshot.kept) : 0;
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
    figma.ui.resize(280, 176);
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
