type BridgeJobOptions = {
  maxNodes: number;
  maxJsonBytes: number;
  maxDimension: number;
  maxAssets: number;
  maxAssetBytes: number;
  /** 페이지 추출: 이미지와 JSON 없이 화면 크기 후보만 계산한다. 추출 전 확인 화면용. */
  scanOnly?: boolean;
  /** 페이지 추출: 운영자가 확인 화면에서 고른 화면 크기. 주어지면 스스로 학습하지 않는다. */
  devices?: DeviceResult[];
  /** 페이지 추출: 확인 화면의 후보를 찾은 페이지. 지금 열린 페이지가 다르면 추출하지 않는다. */
  expectedPageId?: string;
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

/** 이 파일에서 "화면"으로 보는 기기 크기. 이름에 기기가 적힌 프레임에서 배운다. */
type DeviceResult = {
  device: string;
  width?: number;
  height?: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight?: number;
  /**
   * name: 기기 이름이 붙은 프레임에서 배움. repeat: 이름은 없지만 화면 밖에서 같은 크기가 여러 번 나옴.
   * default: 둘 다 없어 모바일 기본 범위를 씀.
   */
  source: "name" | "repeat" | "default";
  examples: string[];
  screens: number;
  /** 운영자가 확인 화면에서 고른 크기로 추출했으면 true. */
  selected?: boolean;
};

/** 이름은 기기처럼 보였지만 기기 크기로 인정하지 않은 것. 운영자가 판단을 되짚을 수 있게 남긴다. */
type IgnoredDevice = { device: string; width?: number; height?: number; examples: string[]; reason: string };

type ScreenResult = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  device: string;
  width: number;
  height: number;
  /** 자동 이름(Frame 123)을 뺀 상위 이름. 기능 묶음 경로로 쓴다. */
  path: string[];
  groupNodeId?: string;
  slot?: string;
  scale?: number;
  /** 프레임 원점이 이미지 안에서 놓인 위치(Figma 단위). 그림자·넘친 내용 때문에 이미지가 프레임보다 크면 0이 아니다. */
  renderOffset?: Offset;
  error?: string;
};

type Offset = { x: number; y: number };

/** Figma 기본 주석 하나. 붙은 노드와, 그 노드를 품은 화면·기능 묶음을 함께 적는다. */
type AnnotationResult = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  label?: string;
  labelMarkdown?: string;
  categoryId?: string;
  /** 주석에 고정한 속성 종류(width, fills 등). 값은 노드 JSON에 있다. */
  properties?: string[];
  screenNodeId?: string;
  groupNodeId?: string;
  /** 붙은 노드의 위치. 화면이 있으면 화면 원점, 없으면 기능 묶음 원점, 둘 다 없으면 페이지 기준 Figma 단위다. */
  rect?: BoxRect;
};

type AnnotationCategoryResult = { id: string; label: string; color: string; isPreset: boolean };

type GroupResult = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  path: string[];
  width: number;
  height: number;
  slot?: string;
  scale?: number;
  renderOffset?: Offset;
  /** 소속 화면의 위치. 묶음 원점 기준 Figma 단위이며, 이미지 픽셀은 (값 + renderOffset) × scale이다. */
  screens: Array<{ nodeId: string; x: number; y: number; width: number; height: number }>;
  error?: string;
};

type PluginResult = {
  scope: "node" | "current_page";
  snapshot?: unknown;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  meta: ReturnType<typeof pluginMeta> & { nodeId?: string; nodeName?: string; nodeType?: string };
  page?: { id: string; name: string; nodes: PageNodeResult[]; devices?: DeviceResult[]; ignoredDevices?: IgnoredDevice[]; screens?: ScreenResult[]; groups?: GroupResult[]; annotations?: AnnotationResult[]; annotationCategories?: AnnotationCategoryResult[] };
  /** 담지 못한 에셋의 사유별 개수. 0이면 생략한다. */
  omittedAssets?: { cap: number; oversized: number; failed: number; duplicate: number };
  artifacts: Array<Omit<ArtifactPayload, "data"> & { bytes: number }>;
};

figma.skipInvisibleInstanceChildren = true;
figma.showUI(__html__, { width: 320, height: 330, themeColors: true });

function pluginMeta() {
  return {
    pluginVersion: "1.3.0",
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

/**
 * 목표 배율로 찍되 긴 변이 maxEdge를 넘지 않게 줄이고, 용량을 넘으면 0.65배씩 줄여 최대 4번 찍는다.
 * 실패 사유를 돌려주는 이유: 화면 이미지가 조용히 빠지면 KB에서 그 화면이 통째로 사라진다.
 */
async function exportPng(
  node: SceneNode,
  targetScale: number,
  maxEdge: number,
  maxBytes: number,
): Promise<{ data: Uint8Array; scale: number } | { error: string }> {
  if (!("exportAsync" in node)) return { error: "이 노드는 이미지로 내보낼 수 없습니다." };
  // exportAsync는 그림자·넘친 내용까지 그려진 범위를 내보낸다. 긴 변 한도도 그 범위로 잰다.
  const bounds = ("absoluteRenderBounds" in node ? node.absoluteRenderBounds : null) ?? ("absoluteBoundingBox" in node ? node.absoluteBoundingBox : null);
  const longest = bounds ? Math.max(bounds.width, bounds.height) : 0;
  let scale = longest > 0 ? Math.min(targetScale, maxEdge / longest) : targetScale;
  try {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const value = Math.max(0.01, scale);
      const data = await node.exportAsync({ format: "PNG", constraint: { type: "SCALE", value } });
      if (data.byteLength > maxBytes) { scale *= .65; continue; }
      return { data, scale: value };
    }
    return { error: `배율을 네 번 낮춰도 ${Math.round(maxBytes / 1024 / 1024)}MB를 넘었습니다.` };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

async function screenshot(node: SceneNode, maxDimension: number, maxBytes: number, slot = "screenshot"): Promise<ArtifactPayload | undefined> {
  const exported = await exportPng(node, 1, maxDimension, maxBytes);
  if ("error" in exported) return undefined;
  return { slot, kind: "screenshot", mimeType: "image/png", name: `${safeName(node.name)}.png`, data: exported.data };
}

/*
 * 화면 단위 스크린샷.
 *
 * 최상위 노드 한 장만 찍으면 페이지가 Section 하나일 때 87,000개 노드가 2,048px 한 장에 눌려
 * 모바일 화면이 47px 폭이 된다. 그래서 기기 크기의 프레임을 화면으로 골라 따로 찍는다.
 * 기기 크기는 고정 범위가 아니라 이 파일의 이름 붙은 프레임에서 배운다. 실제 파일에서
 * 태블릿이 1366×1024, 폴드가 768×852여서 범용 범위로는 둘 다 놓쳤다.
 */
const DEVICE_NAMES: Array<{ device: string; pattern: RegExp }> = [
  { device: "fold", pattern: /fold|폴드/i },
  { device: "mobile", pattern: /mobile|모바일/i },
  { device: "tablet", pattern: /tablet|태블릿|ipad/i },
  { device: "desktop", pattern: /desktop|데스크탑|데스크톱/i },
];
const DEVICE_TOLERANCE = 8;
/** 모바일은 스크롤 길이가 화면마다 달라 폭만 본다. 이보다 짧은 375폭 노드는 화면 속 섹션이다. */
const MOBILE_MIN_HEIGHT = 600;
/** 휴대폰은 2~3배 밀도로 그린다. 1배 이미지의 작은 글씨는 뭉개진다. */
const SCREEN_SCALE = 2;
const SCREEN_MAX_EDGE = 8_192;
/** 기능 묶음은 흐름과 배치를 보는 이미지다. 화면을 읽는 용도는 화면 이미지가 맡는다. */
const GROUP_MAX_EDGE = 4_096;
const AUTO_NAME = /^(Frame|Group|Rectangle|Vector|Ellipse)\s+\d+$/;

type BoxRect = { x: number; y: number; width: number; height: number };

function rectOf(node: SceneNode): BoxRect | undefined {
  const bounds = "absoluteBoundingBox" in node ? node.absoluteBoundingBox : null;
  if (!bounds) return undefined;
  return { x: bounds.x ?? 0, y: bounds.y ?? 0, width: bounds.width, height: bounds.height };
}

/**
 * 이미지 원점은 프레임이 아니라 그려진 범위의 왼쪽 위다. 그림자 여백이나 프레임 밖으로 넘친 내용이 있으면
 * 둘이 어긋나 좌표가 밀린다(NH 주식 페이지 162장 중 13장). 그 차이를 Figma 단위로 돌려준다.
 */
function renderOffsetOf(node: SceneNode): Offset | undefined {
  const box = rectOf(node);
  const render = "absoluteRenderBounds" in node ? node.absoluteRenderBounds : null;
  if (!box || !render) return undefined;
  const x = Math.round((box.x - render.x) * 100) / 100;
  const y = Math.round((box.y - render.y) * 100) / 100;
  return x === 0 && y === 0 ? undefined : { x, y };
}

function annotationsOf(node: SceneNode): readonly Annotation[] {
  try {
    return "annotations" in node ? (node as SceneNode & { annotations: readonly Annotation[] }).annotations ?? [] : [];
  } catch {
    return [];
  }
}

/** 카테고리 이름(Description·콘텐츠 등)은 노드 JSON에 없고 id만 있다. 파일의 카테고리 목록에서 읽는다. */
/**
 * 주석이 붙은 노드 id를 이미 내보낸 노드 JSON에서 찾는다. 노드마다 annotations를 물으면
 * 8만 개 페이지에서 수만 번 샌드박스를 오가 추출이 10분 넘게 늘어졌다. JSON 순회는 JS 안에서 끝난다.
 */
function collectAnnotatedIds(value: unknown, into: Set<string>): void {
  if (!isRecord(value)) return;
  if (typeof value.id === "string" && Array.isArray(value.annotations) && value.annotations.length > 0) into.add(value.id);
  if (Array.isArray(value.children)) for (const child of value.children) collectAnnotatedIds(child, into);
}

async function annotationCategories(): Promise<AnnotationCategoryResult[]> {
  try {
    if (!figma.annotations) return [];
    const categories = await figma.annotations.getAnnotationCategoriesAsync();
    return categories.map((category) => ({ id: category.id, label: category.label, color: category.color, isPreset: category.isPreset }));
  } catch {
    return [];
  }
}

function isScreenCandidateType(node: SceneNode): boolean {
  return node.type === "FRAME" || node.type === "COMPONENT" || node.type === "INSTANCE";
}

function visibleChildren(node: SceneNode): SceneNode[] {
  if (!("children" in node)) return [];
  return (node.children as readonly SceneNode[]).filter((child) => child.visible !== false);
}

/** 배운 크기마다 근거가 된 프레임들. 나중에 그 근거가 전부 다른 화면 안에 있으면 크기를 버린다. */
const deviceSupport = new Map<DeviceResult, SceneNode[]>();

function learnDevices(nodes: SceneNode[]): DeviceResult[] {
  deviceSupport.clear();
  const devices: DeviceResult[] = [];
  for (const node of nodes) {
    if (!isScreenCandidateType(node) || node.visible === false || / > /.test(node.name)) continue;
    const rect = rectOf(node);
    // 컨테이너(2,515폭 "… > 모바일 > …")와 바(1,920×36 "Top_desktop")는 기기 크기가 아니다.
    if (!rect || rect.width < 300 || rect.width > 2_600 || rect.height < 400) continue;
    const named = DEVICE_NAMES.find(({ pattern }) => pattern.test(node.name));
    if (!named) continue;
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    const mobile = named.device === "mobile";
    const known = devices.find((device) => device.device === named.device
      && Math.abs((device.width ?? 0) - width) <= DEVICE_TOLERANCE
      && (mobile || Math.abs((device.height ?? 0) - height) <= DEVICE_TOLERANCE));
    if (known) {
      if (known.examples.length < 3 && !known.examples.includes(node.name)) known.examples.push(node.name);
      deviceSupport.get(known)?.push(node);
      continue;
    }
    const learned: DeviceResult = {
      device: named.device,
      width,
      height: mobile ? undefined : height,
      minWidth: width - DEVICE_TOLERANCE,
      maxWidth: width + DEVICE_TOLERANCE,
      minHeight: mobile ? MOBILE_MIN_HEIGHT : height - DEVICE_TOLERANCE,
      maxHeight: mobile ? undefined : height + DEVICE_TOLERANCE,
      source: "name",
      examples: [node.name],
      screens: 0,
    };
    devices.push(learned);
    deviceSupport.set(learned, [node]);
  }
  return devices;
}

/** 이름도 반복도 근거가 없을 때만 쓰는 추측. 증거가 하나라도 있으면 쓰지 않는다. */
function defaultDevices(): DeviceResult[] {
  return [{ device: "mobile", minWidth: 360, maxWidth: 430, minHeight: MOBILE_MIN_HEIGHT, source: "default", examples: [], screens: 0 }];
}

function matchDevice(node: SceneNode, devices: DeviceResult[]): DeviceResult | undefined {
  if (!isScreenCandidateType(node)) return undefined;
  const rect = rectOf(node);
  if (!rect) return undefined;
  return devices.find((device) => rect.width >= device.minWidth && rect.width <= device.maxWidth
    && rect.height >= device.minHeight && (device.maxHeight === undefined || rect.height <= device.maxHeight));
}

/** 같은 크기의 자식 하나만 감싼 포장 프레임. 이때만 안으로 내려간다. 375폭 섹션을 품은 화면은 포장이 아니다. */
function isPureWrapper(node: SceneNode, devices: DeviceResult[]): boolean {
  const children = visibleChildren(node);
  if (children.length !== 1 || !matchDevice(children[0], devices)) return false;
  const outer = rectOf(node);
  const inner = rectOf(children[0]);
  if (!outer || !inner) return false;
  return Math.abs(outer.x - inner.x) <= DEVICE_TOLERANCE && Math.abs(outer.y - inner.y) <= DEVICE_TOLERANCE
    && Math.abs(outer.width - inner.width) <= DEVICE_TOLERANCE && Math.abs(outer.height - inner.height) <= DEVICE_TOLERANCE;
}

type FoundScreen = { node: SceneNode; device: DeviceResult; ancestors: SceneNode[] };

function findScreens(node: SceneNode, devices: DeviceResult[], ancestors: SceneNode[], found: FoundScreen[]): void {
  if (node.visible === false) return;
  const device = matchDevice(node, devices);
  if (device && !isPureWrapper(node, devices)) {
    found.push({ node, device, ancestors });
    return;
  }
  for (const child of visibleChildren(node)) findScreens(child, devices, [...ancestors, node], found);
}

function insideAny(node: SceneNode, ids: Set<string>): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) if (ids.has(parent.id)) return true;
  return false;
}

/** 이보다 적게 나오는 크기는 팝업·카드가 우연히 같은 크기일 수 있어 화면으로 보지 않는다. */
const MIN_REPEAT = 3;

/**
 * 기기 이름이 없는 화면 크기. NH 파일은 이름 규칙이 섞여 있어 미니모드 360×600 창 32개와 스플릿뷰
 * 1536×1000 프레임 44개가 이름으로는 하나도 잡히지 않았다. 대신 화면은 같은 크기로 여러 장 그린다는
 * 점을 쓴다. 이미 찾은 화면 안의 노드와 화면을 품은 컨테이너는 세지 않는다. 그래야 목록 카드 같은
 * 반복 컴포넌트나 여러 화면을 담은 묶음 프레임이 화면 크기로 올라오지 않는다.
 */
function learnRepeatedSizes(nodes: SceneNode[], found: FoundScreen[], known: DeviceResult[]): DeviceResult[] {
  const screenIds = new Set(found.map((screen) => screen.node.id));
  const containers = new Set(found.flatMap((screen) => screen.ancestors.map((ancestor) => ancestor.id)));
  const sizes: Array<{ width: number; height: number; nodes: SceneNode[] }> = [];
  for (const node of nodes) {
    // 화면은 프레임으로 그리고, 패널·팝업·위젯은 컴포넌트 인스턴스로 가져다 쓴다. NH 스플릿뷰에서 사이드 패널
    // 인스턴스 84개가 화면 52개로 올라왔다. 그래서 횟수는 프레임만 센다. 인정된 크기의 인스턴스는 나중에 화면으로 잡힌다.
    if (node.type !== "FRAME" || node.visible === false || / > /.test(node.name)) continue;
    if (screenIds.has(node.id) || containers.has(node.id) || matchDevice(node, known) || insideAny(node, screenIds)) continue;
    const rect = rectOf(node);
    if (!rect || rect.width < 300 || rect.width > 2_600 || rect.height < 400) continue;
    const size = sizes.find((candidate) => Math.abs(candidate.width - rect.width) <= DEVICE_TOLERANCE && Math.abs(candidate.height - rect.height) <= DEVICE_TOLERANCE);
    if (size) size.nodes.push(node);
    else sizes.push({ width: Math.round(rect.width), height: Math.round(rect.height), nodes: [node] });
  }
  return sizes
    .filter((size) => size.nodes.length >= MIN_REPEAT)
    .sort((a, b) => b.nodes.length - a.nodes.length)
    .map((size) => {
      const device: DeviceResult = {
        device: `repeated-${size.width}x${size.height}`,
        width: size.width,
        height: size.height,
        minWidth: size.width - DEVICE_TOLERANCE,
        maxWidth: size.width + DEVICE_TOLERANCE,
        minHeight: size.height - DEVICE_TOLERANCE,
        maxHeight: size.height + DEVICE_TOLERANCE,
        source: "repeat",
        examples: [...new Set(size.nodes.map((node) => node.name))].slice(0, 3),
        screens: 0,
      };
      deviceSupport.set(device, size.nodes);
      return device;
    });
}

function meaningfulPath(ancestors: SceneNode[]): string[] {
  return ancestors.map((ancestor) => ancestor.name).filter((name) => name.trim() && !AUTO_NAME.test(name.trim()));
}

function detectScreens(roots: readonly SceneNode[], candidates: DeviceResult[]): FoundScreen[] {
  const result: FoundScreen[] = [];
  for (const root of roots) findScreens(root, candidates, [], result);
  return result;
}

/**
 * 운영자가 추출 전에 고를 화면 크기 후보. 이름 → 반복 → 기본값 순으로 근거를 쌓고,
 * 컴포넌트나 묶음으로 판단해 뺀 후보는 사유와 함께 ignoredDevices에 남긴다.
 */
function proposeDevices(roots: readonly SceneNode[], scanned: SceneNode[]): { devices: DeviceResult[]; ignoredDevices: IgnoredDevice[]; found: FoundScreen[] } {
  const detect = (candidates: DeviceResult[]) => detectScreens(roots, candidates);
  let devices = learnDevices(scanned);
  let found = detect(devices);

  // "Fold"는 폴더블 기기이면서 접기 카드의 이름이기도 했다. 근거 프레임이 전부 다른 화면 안에 있으면
  // 그 크기는 기기가 아니라 화면 속 컴포넌트다. 버리고 한 번 더 찾는다.
  const screenIds = new Set(found.map((screen) => screen.node.id));
  const ignoredDevices: IgnoredDevice[] = [];
  const kept = devices.filter((device) => {
    const support = deviceSupport.get(device);
    if (!support || support.some((node) => !insideAny(node, screenIds))) return true;
    ignoredDevices.push({ device: device.device, width: device.width, height: device.height, examples: device.examples, reason: "이 크기의 기기 이름 프레임이 모두 다른 화면 안에 있어 화면 속 컴포넌트로 봤습니다." });
    return false;
  });
  if (ignoredDevices.length > 0) {
    devices = kept;
    found = detect(devices);
  }

  // 이름으로 찾은 화면 밖에서 반복되는 크기를 더한다. 둘 다 없을 때만 모바일 기본 범위로 추측한다.
  const learnedRepeats = learnRepeatedSizes(scanned, found, devices);
  // Step처럼 여러 화면을 담는 묶음 프레임도 같은 크기로 반복된다. 근거 프레임 대부분이 다른 후보 크기의
  // 프레임을 둘 이상 품고 있으면 화면이 아니라 묶음이다. 화면으로 두면 안의 화면을 전부 삼킨다.
  const everyCandidate = [...devices, ...learnedRepeats];
  const repeated = learnedRepeats.filter((device) => {
    const others = everyCandidate.filter((other) => other !== device);
    const support = deviceSupport.get(device) ?? [];
    const holders = support.filter((node) => {
      let inner = 0;
      const visit = (current: SceneNode): void => {
        for (const child of visibleChildren(current)) {
          if (matchDevice(child, others)) { inner += 1; continue; }
          visit(child);
        }
      };
      visit(node);
      return inner >= 2;
    });
    if (holders.length * 2 <= support.length) return true;
    ignoredDevices.push({ device: device.device, width: device.width, height: device.height, examples: device.examples, reason: "이 크기의 프레임 대부분이 다른 화면 크기의 프레임을 둘 이상 품고 있어 기능 묶음으로 봤습니다." });
    return false;
  });
  if (repeated.length > 0) devices = [...devices, ...repeated];
  if (devices.length === 0) devices = defaultDevices();
  if (repeated.length > 0 || devices[0]?.source === "default") found = detect(devices);
  return { devices, ignoredDevices, found };
}

async function captureScreens(
  roots: readonly SceneNode[],
  scanned: SceneNode[],
  options: BridgeJobOptions,
  /** false면 화면과 묶음을 찾기만 하고 이미지는 찍지 않는다. 추출 전 확인 화면용이다. */
  exportImages = true,
  /** 노드 JSON에서 찾은 주석 노드 id. 이 노드들만 다시 읽어 카테고리를 얻는다. */
  annotatedIds: ReadonlySet<string> = new Set(),
): Promise<{ devices: DeviceResult[]; ignoredDevices: IgnoredDevice[]; screens: ScreenResult[]; groups: GroupResult[]; annotations: AnnotationResult[]; payloads: ArtifactPayload[] }> {
  let devices: DeviceResult[];
  let ignoredDevices: IgnoredDevice[] = [];
  let found: FoundScreen[];
  if (options.devices && options.devices.length > 0) {
    // 운영자가 고른 크기가 있으면 그대로 쓴다. 스스로 다시 배우면 확인 화면에서 끈 크기가 되살아난다.
    devices = options.devices.map((device) => ({ ...device, examples: [...device.examples], screens: 0, selected: true }));
    found = detectScreens(roots, devices);
  } else {
    ({ devices, ignoredDevices, found } = proposeDevices(roots, scanned));
  }

  // 기능 묶음 = 화면을 둘 이상 품은 가장 안쪽 조상. 그보다 위는 이름 경로로 표현한다.
  const screensPerAncestor = new Map<string, number>();
  for (const screen of found) for (const ancestor of screen.ancestors) screensPerAncestor.set(ancestor.id, (screensPerAncestor.get(ancestor.id) ?? 0) + 1);
  const groupOf = (screen: FoundScreen) => [...screen.ancestors].reverse().find((ancestor) => (screensPerAncestor.get(ancestor.id) ?? 0) >= 2);

  const payloads: ArtifactPayload[] = [];
  const screens: ScreenResult[] = [];
  const groups = new Map<string, { node: SceneNode; result: GroupResult }>();

  for (const [index, entry] of found.entries()) {
    const rect = rectOf(entry.node)!;
    const group = groupOf(entry);
    entry.device.screens += 1;
    const slot = `screen-${index + 1}`;
    const result: ScreenResult = {
      nodeId: entry.node.id,
      nodeName: entry.node.name,
      nodeType: entry.node.type,
      device: entry.device.device,
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      path: meaningfulPath(entry.ancestors),
      groupNodeId: group?.id,
    };
    const viewport = exportImages ? await exportPng(entry.node, SCREEN_SCALE, SCREEN_MAX_EDGE, options.maxAssetBytes) : undefined;
    if (viewport && "error" in viewport) result.error = viewport.error;
    else if (viewport) {
      payloads.push({ slot, kind: "screenshot", mimeType: "image/png", name: `${safeName(entry.node.name)}.png`, data: viewport.data });
      result.slot = slot;
      result.scale = viewport.scale;
      result.renderOffset = renderOffsetOf(entry.node);
    }
    screens.push(result);

    if (group) {
      let known = groups.get(group.id);
      if (!known) {
        const groupRect = rectOf(group);
        known = {
          node: group,
          result: {
            nodeId: group.id,
            nodeName: group.name,
            nodeType: group.type,
            path: meaningfulPath(entry.ancestors.slice(0, entry.ancestors.indexOf(group))),
            width: Math.round(groupRect?.width ?? 0),
            height: Math.round(groupRect?.height ?? 0),
            screens: [],
          },
        };
        groups.set(group.id, known);
      }
      const origin = rectOf(group);
      known.result.screens.push({
        nodeId: entry.node.id,
        x: Math.round(rect.x - (origin?.x ?? 0)),
        y: Math.round(rect.y - (origin?.y ?? 0)),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    }
  }

  for (const [index, { node, result }] of [...groups.values()].entries()) {
    if (!exportImages) break;
    const exported = await exportPng(node, 1, GROUP_MAX_EDGE, options.maxAssetBytes);
    if ("error" in exported) { result.error = exported.error; continue; }
    const slot = `group-${index + 1}`;
    payloads.push({ slot, kind: "screenshot", mimeType: "image/png", name: `${safeName(node.name)}.png`, data: exported.data });
    result.slot = slot;
    result.scale = exported.scale;
    result.renderOffset = renderOffsetOf(node);
  }

  // 기본 주석은 노드에 직접 붙어 있어 짝을 추측할 필요가 없다. 붙은 노드에서 위로 올라가 화면·묶음을 찾는다.
  const annotations: AnnotationResult[] = [];
  if (exportImages) {
    const screenById = new Map(found.map((entry) => [entry.node.id, entry]));
    for (const id of annotatedIds) {
      const resolved = await figma.getNodeByIdAsync(id);
      if (!resolved || resolved.type === "PAGE" || resolved.type === "DOCUMENT") continue;
      const node = resolved as SceneNode;
      const list = annotationsOf(node);
      if (list.length === 0) continue;
      let screen: FoundScreen | undefined;
      let groupNode: SceneNode | undefined;
      for (let current: BaseNode | null = node; current && current.type !== "PAGE" && current.type !== "DOCUMENT"; current = current.parent) {
        screen = screenById.get(current.id);
        if (screen) break;
        if (!groupNode && groups.has(current.id)) groupNode = groups.get(current.id)!.node;
      }
      const container = screen?.node ?? groupNode;
      const own = rectOf(node);
      const origin = container ? rectOf(container) : undefined;
      const rect = own ? { x: Math.round(own.x - (origin?.x ?? 0)), y: Math.round(own.y - (origin?.y ?? 0)), width: Math.round(own.width), height: Math.round(own.height) } : undefined;
      for (const annotation of list) {
        annotations.push({
          nodeId: node.id,
          nodeName: node.name,
          nodeType: node.type,
          label: annotation.label || undefined,
          labelMarkdown: annotation.labelMarkdown || undefined,
          categoryId: annotation.categoryId || undefined,
          properties: annotation.properties?.length ? annotation.properties.map((property) => property.type) : undefined,
          screenNodeId: screen?.node.id,
          groupNodeId: screen ? groupOf(screen)?.id : groupNode?.id,
          rect,
        });
      }
    }
  }

  return { devices, ignoredDevices, screens, groups: [...groups.values()].map(({ result }) => result), annotations, payloads };
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
  if (job.options.expectedPageId && page.id !== job.options.expectedPageId) {
    throw new Error(`화면 크기 후보를 찾은 페이지와 지금 열린 페이지(${page.name})가 다릅니다. Trace Studio에서 후보를 다시 찾아 주세요.`);
  }
  if (job.options.scanOnly) {
    // 확인 화면용 스캔. 노드를 세고 후보를 계산할 뿐 JSON 직렬화와 이미지 내보내기는 하지 않아 빠르다.
    const scanned: SceneNode[] = [];
    let nodeCount = 0;
    for (const node of page.children) nodeCount += countSceneNodes(node, SCAN_CEILING, scanned);
    const captured = await captureScreens(page.children, scanned, job.options, false);
    return {
      result: {
        scope: "current_page",
        nodeCount,
        partial: false,
        meta: pluginMeta(),
        page: { id: page.id, name: page.name, nodes: [], devices: captured.devices, ignoredDevices: captured.ignoredDevices.length ? captured.ignoredDevices : undefined, screens: captured.screens, groups: captured.groups },
        artifacts: [],
      },
      payloads: [],
    };
  }
  const payloads: ArtifactPayload[] = [];
  const pageNodes: PageNodeResult[] = [];
  const annotatedIds = new Set<string>();
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
      collectAnnotatedIds(document, annotatedIds);
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
  const captured = await captureScreens(page.children, scanned, job.options, true, annotatedIds);
  const categories = captured.annotations.length ? await annotationCategories() : [];
  payloads.push(...captured.payloads);
  payloads.push(...await sourceAssets(scanned, job.options));
  const partial = pageNodes.some((node) => node.partial || Boolean(node.error));
  return {
    result: {
      scope: "current_page",
      nodeCount,
      partial,
      omittedNodes: omittedNodes || undefined,
      meta: pluginMeta(),
      page: { id: page.id, name: page.name, nodes: pageNodes, devices: captured.devices, ignoredDevices: captured.ignoredDevices.length ? captured.ignoredDevices : undefined, screens: captured.screens, groups: captured.groups, annotations: captured.annotations.length ? captured.annotations : undefined, annotationCategories: categories.length ? categories : undefined },
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
