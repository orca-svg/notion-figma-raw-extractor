/**
 * 기획서의 번호 배지(01, 02, E1 …)를 "화면 위 표시"와 "설명 칸"으로 나누고, 같은 번호끼리 짝을 잇는다.
 *
 * 설명 칸이 화면의 어느 쪽에 놓이는지는 파일마다 다르다. 그래서 위치 규칙으로 짝을 정하지 않는다.
 * 같은 번호의 설명 칸을 모두 후보로 두고, 근거가 뚜렷할 때만 확정한다.
 *   0. 소속: 설명 칸은 자기가 맡은 영역 안의 같은 번호 표시만 설명한다. 영역 안에 같은 번호 설명이 없으면
 *      그 표시는 설명 없음(unlinked)이고, 다른 영역의 같은 번호 설명은 참고 후보로만 남긴다.
 *      설명 열이 보드 안에 하나뿐이면 그 보드 전체를 맡는다. 보드 밖에 따로 선 열이 여럿이면, 이 파일 안의 확실한 예
 *      (보드 안 설명 열이 표시들의 어느 쪽에 붙었는지)에서 방향을 배워 그 방향의 띠를 맡긴다. 오른쪽이라고 배웠으면
 *      "이전 열과 이 열 사이, 이 열의 왼쪽" 영역이다. 가장 가까운 영역과 다를 수 있다. 배울 예가 없으면 가장 가까운
 *      영역을 맡기되, 두 번째보다 두 배 이상 가까울 때만 정한다.
 *   1. 트리 근접도: 표시와의 공통 조상이 가장 깊은 설명 칸이 하나뿐이다.
 *   2. 같은 글: 가장 가까운 후보들의 설명이 글자까지 같다(기기별 사본 등).
 *   3. 내용 겹침: 설명 문장이 그 화면의 Figma 주석이나 표시 영역 안 글자와 더 많이 겹친다.
 *   4. 상대 거리: 가장 가까운 후보가 다음 후보보다 3배 이상 가깝다.
 * 어느 것도 가르지 못하면 후보를 모두 남기고 "확인 필요"로 둔다. 뒤 단계가 내용으로 푼다.
 *
 * 경로 이름 겹침(nameOverlap)은 참고값으로만 남긴다. "03 현재가 > 031 공통정의"와 "03 현재가 > 032 종목 상세"처럼
 * 이웃 보드가 같은 단어를 공유하면, 바로 옆의 자기 설명 열(이름이 일반적)을 제치고 남의 보드 설명을 고르게 된다.
 *
 * 배지는 모양이 아니라 쓰임새로 고른다. 같은 컴포넌트가 글 옆(설명 칸)과 화면 위(표시)에 함께 쓰이고
 * 번호가 01·E1 꼴이면 명세 배지로 본다. 종목 태그·알림 숫자처럼 생김새만 비슷한 UI는 이 조건을 넘지 못한다.
 */

export type Box = { x: number; y: number; width: number; height: number };

/** 화면 색인에서 필요한 것만. 이미지가 있으면 화면 좌표를 이미지 픽셀로 옮길 수 있다. */
export type SpecScreenRef = {
  nodeId: string;
  image?: { scale: number; offset: { x: number; y: number } };
};

export type SpecAnnotationRef = { screenNodeId?: string; text: string };

export type SpecKind = "description" | "event";
/** 설명 열이 자기가 설명하는 표시들의 어느 쪽에 놓이는가. */
export type SpecSide = "right" | "left" | "below" | "above";
export type SpecEvidence = "only" | "scope" | "structure" | "same-text" | "content" | "distance";

export type SpecCandidate = {
  legendNodeId: string;
  /** exact는 번호가 같고, base는 01A → 01처럼 꼬리 글자를 뗀 번호가 같다. */
  labelMatch: "exact" | "base";
  commonAncestorId?: string;
  /** 공통 조상의 깊이. 클수록 트리에서 가깝다. 공통 조상이 없으면 -1. */
  commonDepth: number;
  /** 그 설명 칸이 먼저 설명하는 영역들. 따로 선 설명 열이면 이 파일에서 배운 방향의 띠 안 영역이다. 비어 있으면 범위를 정하지 못했다. */
  scopeNodeIds: string[];
  /** 표시가 그 범위 안에 있는가. */
  inScope: boolean;
  contentOverlap: number;
  nameOverlap: number;
  distance: number;
};

export type SpecMark = {
  nodeId: string;
  label: string;
  kind: SpecKind;
  path: string[];
  screenNodeId?: string;
  /** 화면 원점 기준 Figma 단위. 영역 사각형이 있으면 그 영역, 없으면 배지 자리. */
  rect?: Box;
  imageRect?: Box;
  regionNodeId?: string;
  status: "linked" | "ambiguous" | "unlinked";
  legendNodeId?: string;
  evidence?: SpecEvidence;
  candidates: SpecCandidate[];
};

export type SpecLegend = {
  nodeId: string;
  entryNodeId: string;
  label: string;
  kind: SpecKind;
  title: string;
  markdown: string;
  path: string[];
};

export type SpecMarksIndex = {
  schemaVersion: 1;
  note: string[];
  badgeComponents: Array<{ componentId: string; name: string; legends: number; marks: number }>;
  /** 이 파일에서 배운 설명 방향과, 배울 때 쓴 확실한 예(보드 안에 설명 열이 하나뿐인 경우)의 수. */
  layout: { side?: SpecSide; examples: number };
  legends: SpecLegend[];
  marks: SpecMark[];
  summary: { legends: number; marks: number; linked: number; ambiguous: number; unlinked: number; onScreen: number; withRegion: number };
};

type RawNode = {
  id?: unknown;
  name?: unknown;
  type?: unknown;
  __part?: unknown;
  children?: RawNode[];
  absoluteBoundingBox?: Box | null;
  componentId?: unknown;
  characters?: unknown;
  lineTypes?: unknown;
  lineIndentations?: unknown;
  strokes?: Array<{ visible?: boolean }>;
  fills?: Array<{ visible?: boolean; opacity?: number; color?: { a?: number } }>;
};

type RawPart = {
  document?: RawNode;
  components?: Record<string, { name?: string; componentSetId?: string }>;
  componentSets?: Record<string, { name?: string }>;
  parentNodeId?: string;
};

type Slim = {
  id: string;
  parent?: string;
  name: string;
  type: string;
  box?: Box;
  componentId?: string;
  children: string[];
  text?: string;
  lineTypes?: string[];
  lineIndentations?: number[];
  /** 테두리만 있는 사각형. 표시가 가리키는 영역 후보다. */
  outline?: boolean;
};

const LABEL = /^[A-Z]{0,2}\d{1,3}[A-Z]?$/;
const BADGE_MAX = 64;
const EDGE = 32;
const GENERIC = new Set([
  "frame", "group", "rectangle", "content", "page", "log", "description", "events", "event", "links", "text", "blocks", "block",
  "buffer", "changelog", "badge", "dark", "outline", "line", "instance", "vector", "component", "auto", "layout", "container",
  "wrapper", "body", "section", "version", "arrow", "ellipse", "icon",
]);

function tokens(value: string): Set<string> {
  const out = new Set<string>();
  for (const match of value.toLowerCase().matchAll(/[\p{L}\p{N}]{2,}/gu)) {
    const token = match[0];
    if (/^\d+$/.test(token) || GENERIC.has(token)) continue;
    out.add(token);
  }
  return out;
}

function overlap(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const token of a) if (b.has(token)) count += 1;
  return count;
}

function center(box: Box): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

function kindOf(label: string, componentName: string): SpecKind {
  return /event/i.test(componentName) || /^E\d/.test(label) ? "event" : "description";
}

/** Figma 목록 서식(줄마다 글머리표 종류와 들여쓰기 단계)을 마크다운 중첩 목록으로 되살린다. */
export function textToMarkdown(text: string, lineTypes?: string[], lineIndentations?: number[]): string {
  return text.split("\n").map((line, index) => {
    const type = lineTypes?.[index] ?? "NONE";
    const depth = Math.max(0, (lineIndentations?.[index] ?? 0) - 1);
    if (!line.trim() || type === "NONE") return line;
    return `${"  ".repeat(depth)}${type === "ORDERED" ? "1." : "-"} ${line}`;
  }).join("\n");
}

export class SpecMarkCollector {
  private readonly nodes = new Map<string, Slim>();
  private readonly components = new Map<string, { name: string; setId?: string }>();
  private readonly componentSets = new Map<string, string>();
  private readonly ancestorCache = new Map<string, string[]>();

  /** 노드 JSON 조각 하나를 읽는다. 큰 트리는 조각으로 나뉘어 있어도 parentNodeId로 다시 이어진다. */
  addPart(part: unknown): void {
    const doc = (part ?? {}) as RawPart;
    for (const [id, component] of Object.entries(doc.components ?? {})) {
      this.components.set(id, { name: component.name ?? "", setId: component.componentSetId });
    }
    for (const [id, set] of Object.entries(doc.componentSets ?? {})) this.componentSets.set(id, set.name ?? "");
    if (doc.document) this.walk(doc.document, doc.parentNodeId);
  }

  private walk(root: RawNode, rootParent?: string): void {
    const stack: Array<{ node: RawNode; parent?: string }> = [{ node: root, parent: rootParent }];
    while (stack.length > 0) {
      const { node, parent } = stack.pop()!;
      const id = String(node.id ?? "");
      // 떼어낸 자리의 스텁은 자리만 표시한다. 진짜 노드는 다른 조각에서 온다.
      if (!id || node.__part !== undefined) continue;
      const children = node.children ?? [];
      const fills = node.fills ?? [];
      const visibleFill = fills.some((fill) => fill.visible !== false && (fill.opacity ?? 1) > 0.1 && (fill.color?.a ?? 1) > 0.1);
      this.nodes.set(id, {
        id,
        parent,
        name: String(node.name ?? ""),
        type: String(node.type ?? ""),
        box: node.absoluteBoundingBox ?? undefined,
        componentId: typeof node.componentId === "string" ? node.componentId : undefined,
        children: children.map((child) => String(child.id ?? "")),
        text: typeof node.characters === "string" ? node.characters : undefined,
        lineTypes: Array.isArray(node.lineTypes) ? node.lineTypes.map(String) : undefined,
        lineIndentations: Array.isArray(node.lineIndentations) ? node.lineIndentations.map(Number) : undefined,
        outline: node.type === "RECTANGLE" && (node.strokes ?? []).some((stroke) => stroke.visible !== false) && !visibleFill,
      });
      // 거꾸로 쌓아야 문서 순서로 꺼낸다. 설명 칸과 표시가 Figma 레이어 순서대로 나온다.
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], parent: id });
    }
  }

  private ancestors(id: string): string[] {
    const cached = this.ancestorCache.get(id);
    if (cached) return cached;
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let current = this.nodes.get(id)?.parent;
    while (current && !seen.has(current)) {
      out.push(current);
      seen.add(current);
      current = this.nodes.get(current)?.parent;
    }
    this.ancestorCache.set(id, out);
    return out;
  }

  private texts(id: string, skip?: string): Slim[] {
    const out: Slim[] = [];
    const stack = [id];
    while (stack.length > 0) {
      const current = this.nodes.get(stack.pop()!);
      if (!current || current.id === skip) continue;
      if (current.type === "TEXT" && current.text) out.push(current);
      for (let index = current.children.length - 1; index >= 0; index -= 1) stack.push(current.children[index]);
    }
    return out;
  }

  /** skip(배지)을 뺀 하위 노드가 글자·프레임·그룹뿐인가. 설명 칸과 화면 조각을 가른다. */
  private textOnly(id: string, skip: string): boolean {
    const stack = [...(this.nodes.get(id)?.children ?? [])];
    while (stack.length > 0) {
      const current = this.nodes.get(stack.pop()!);
      if (!current || current.id === skip) continue;
      if (current.type !== "TEXT" && current.type !== "FRAME" && current.type !== "GROUP") return false;
      stack.push(...current.children);
    }
    return true;
  }

  private badgeLabel(node: Slim): string | undefined {
    const text = this.texts(node.id)[0]?.text?.trim();
    return text && LABEL.test(text) ? text : undefined;
  }

  private family(node: Slim): string | undefined {
    if (!node.componentId) return undefined;
    return this.components.get(node.componentId)?.setId ?? node.componentId;
  }

  private familyName(family: string): string {
    return this.componentSets.get(family) ?? this.components.get(family)?.name ?? family;
  }

  private path(id: string): string[] {
    return this.ancestors(id).map((ancestor) => this.nodes.get(ancestor)?.name ?? "").reverse();
  }

  /** 표시 배지 곁의 테두리 사각형. 배지 중심이 사각형의 세로 범위 안에 있고, 가로로는 한쪽 가장자리에 붙어 있어야 한다. */
  private region(badge: Slim): Slim | undefined {
    const at = center(badge.box!);
    const candidates: Slim[] = [];
    for (const ancestor of this.ancestors(badge.id).slice(0, 3)) {
      for (const childId of this.nodes.get(ancestor)?.children ?? []) {
        const child = this.nodes.get(childId);
        const box = child?.outline ? child.box : undefined;
        if (!box) continue;
        const inside = at.y >= box.y - 4 && at.y <= box.y + box.height + 4;
        const onEdge = Math.abs(at.x - box.x) <= EDGE || Math.abs(at.x - box.x - box.width) <= EDGE;
        if (inside && onEdge) candidates.push(child!);
      }
    }
    return candidates.sort((a, b) => Math.abs(at.y - a.box!.y) - Math.abs(at.y - b.box!.y))[0];
  }

  build(input: { screens: SpecScreenRef[]; annotations?: SpecAnnotationRef[] }): SpecMarksIndex {
    type Badge = { node: Slim; label: string; family: string };
    const badges: Badge[] = [];
    for (const node of this.nodes.values()) {
      if (node.type !== "INSTANCE" || !node.box || node.box.width > BADGE_MAX || node.box.height > BADGE_MAX) continue;
      const family = this.family(node);
      const label = family ? this.badgeLabel(node) : undefined;
      if (family && label) badges.push({ node, label, family });
    }
    const familyOf = new Map(badges.map((badge) => [badge.node.id, badge.family]));

    // 설명 칸: 배지와 글이 한 줄(작은 컨테이너)에 함께 있고, 그 줄에 같은 종류 배지는 하나뿐이며,
    // 배지를 뺀 나머지가 글자와 그 글자를 담은 프레임뿐이다. 화면 프레임 안에 바로 놓인 표시는
    // 곁에 아이콘·벡터·인스턴스가 있어 여기서 걸러진다(상태 표시줄 "9:41"을 설명으로 읽지 않게).
    const legendText = new Map<string, Slim[]>();
    for (const badge of badges) {
      const entry = badge.node.parent ? this.nodes.get(badge.node.parent) : undefined;
      if (!entry || entry.children.length > 6) continue;
      const siblings = entry.children.filter((id) => familyOf.get(id) === badge.family);
      if (siblings.length !== 1 || !this.textOnly(entry.id, badge.node.id)) continue;
      // "□ 호가"처럼 짧은 설명도 있다. UI를 거르는 건 글자 수가 아니라 위의 두 조건과 아래의 번호 맞춤이다.
      const body = this.texts(entry.id, badge.node.id);
      if (body.map((text) => text.text ?? "").join("").replace(/\s/g, "").length >= 2) legendText.set(badge.node.id, body);
    }

    // 명세 배지 종류: 설명 칸 2개 이상, 화면 위 표시 1개 이상이고, 번호가 양쪽에서 서로 맞아야 한다.
    // 설명 칸 번호의 절반 이상이 표시에 나오고, 표시의 절반 이상이 같은 번호의 설명 칸을 가진다.
    // 순위 숫자처럼 글 옆에 가끔 붙는 UI 숫자는 번호가 서로 맞지 않아 빠진다.
    const stats = new Map<string, { legends: Set<string>; marks: string[]; legendCount: number }>();
    for (const badge of badges) {
      const stat = stats.get(badge.family) ?? { legends: new Set(), marks: [], legendCount: 0 };
      if (legendText.has(badge.node.id)) { stat.legends.add(badge.label); stat.legendCount += 1; } else stat.marks.push(badge.label);
      stats.set(badge.family, stat);
    }
    const base = (label: string) => label.replace(/[A-Z]$/, "");
    const specFamilies = new Set([...stats].filter(([, stat]) => {
      if (stat.legendCount < 2 || stat.marks.length < 1) return false;
      const markLabels = new Set(stat.marks.flatMap((label) => [label, base(label)]));
      const legendsShown = [...stat.legends].filter((label) => markLabels.has(label)).length;
      const marksExplained = stat.marks.filter((label) => stat.legends.has(label) || stat.legends.has(base(label))).length;
      return legendsShown * 2 >= stat.legends.size && marksExplained * 2 >= stat.marks.length;
    }).map(([family]) => family));

    const legends: SpecLegend[] = [];
    const legendByLabel = new Map<string, SpecLegend[]>();
    for (const badge of badges) {
      const body = legendText.get(badge.node.id);
      if (!body || !specFamilies.has(badge.family)) continue;
      const markdown = body.map((text) => textToMarkdown(text.text ?? "", text.lineTypes, text.lineIndentations)).join("\n\n");
      const legend: SpecLegend = {
        nodeId: badge.node.id,
        entryNodeId: badge.node.parent!,
        label: badge.label,
        kind: kindOf(badge.label, this.components.get(badge.node.componentId!)?.name ?? ""),
        title: markdown.split("\n").find((line) => line.trim())?.trim() ?? "",
        markdown,
        path: this.path(badge.node.id),
      };
      legends.push(legend);
      legendByLabel.set(legend.label, [...(legendByLabel.get(legend.label) ?? []), legend]);
    }

    const screenBoxes = input.screens.flatMap((screen) => {
      const box = this.nodes.get(screen.nodeId)?.box;
      return box ? [{ screen, box }] : [];
    });
    const notesByScreen = new Map<string, Set<string>>();
    for (const note of input.annotations ?? []) {
      if (!note.screenNodeId) continue;
      const set = notesByScreen.get(note.screenNodeId) ?? new Set<string>();
      for (const token of tokens(note.text)) set.add(token);
      notesByScreen.set(note.screenNodeId, set);
    }
    const legendTokens = new Map(legends.map((legend) => [legend.nodeId, tokens(legend.markdown)]));

    // 소속 범위: 조상마다 그 안에 있는 표시 번호를 모은 뒤, 설명 칸에서 위로 올라가며 같은 번호 표시가 처음 나오는 조상을 찾는다.
    const markBadges = badges.filter((badge) => !legendText.has(badge.node.id) && specFamilies.has(badge.family));
    const labelsUnder = new Map<string, Set<string>>();
    for (const badge of markBadges) {
      for (const ancestor of this.ancestors(badge.node.id)) {
        const set = labelsUnder.get(ancestor) ?? new Set<string>();
        set.add(badge.label);
        set.add(base(badge.label));
        labelsUnder.set(ancestor, set);
      }
    }
    const countUnder = (ids: string[]) => {
      const counts = new Map<string, number>();
      for (const id of ids) for (const ancestor of this.ancestors(id)) counts.set(ancestor, (counts.get(ancestor) ?? 0) + 1);
      return counts;
    };
    const legendsUnder = countUnder(legends.map((legend) => legend.nodeId));
    const marksUnder = countUnder(markBadges.map((badge) => badge.node.id));
    // 설명 열은 설명 칸이 표시보다 많은 자식, 영역은 표시가 설명 칸보다 많은 자식이다. 열 안에 배지가 하나 섞여도 열로 본다.
    const isColumn = (id: string) => (legendsUnder.get(id) ?? 0) > (marksUnder.get(id) ?? 0);
    const isArea = (id: string) => (marksUnder.get(id) ?? 0) > (legendsUnder.get(id) ?? 0);
    const gap = (a?: Box, b?: Box) => {
      if (!a || !b) return Infinity;
      const dx = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width), 0);
      const dy = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height), 0);
      return Math.hypot(dx, dy);
    };
    // 표시들이 차지한 범위. 설명 열이 표시들의 어느 쪽에 붙어 있는지 볼 때 쓴다.
    const markSpan = new Map<string, Box>();
    for (const badge of markBadges) {
      const b = badge.node.box!;
      for (const ancestor of this.ancestors(badge.node.id)) {
        const s = markSpan.get(ancestor);
        const x = s ? Math.min(s.x, b.x) : b.x;
        const y = s ? Math.min(s.y, b.y) : b.y;
        markSpan.set(ancestor, s
          ? { x, y, width: Math.max(s.x + s.width, b.x + b.width) - x, height: Math.max(s.y + s.height, b.y + b.height) - y }
          : { ...b });
      }
    }
    const sideOf = (column?: Box, span?: Box): SpecSide | undefined => {
      if (!column || !span) return undefined;
      if (column.x >= span.x + span.width - 16) return "right";
      if (column.x + column.width <= span.x + 16) return "left";
      if (column.y >= span.y + span.height - 16) return "below";
      if (column.y + column.height <= span.y + 16) return "above";
      return undefined;
    };

    // 설명 칸마다 같은 번호 표시가 처음 나오는 조상(컨테이너)과, 그 아래에서 설명 칸을 품은 갈래를 찾는다.
    type Placement = { container: string; branch: string; columns: string[] };
    const placement = new Map<string, Placement>();
    for (const legend of legends) {
      const chain = [legend.nodeId, ...this.ancestors(legend.nodeId)];
      for (let index = 1; index < chain.length; index += 1) {
        const container = chain[index];
        if (!labelsUnder.get(container)?.has(legend.label)) continue;
        placement.set(legend.nodeId, { container, branch: chain[index - 1], columns: (this.nodes.get(container)?.children ?? []).filter(isColumn) });
        break;
      }
    }

    // 설명 방향은 파일마다 다르다. 그래서 이 파일 안의 확실한 예에서 배운다. 컨테이너 안에 설명 열이 하나뿐이면
    // 그 열은 컨테이너 전체를 설명하므로, 그 열이 표시들의 어느 쪽에 붙어 있는지가 이 파일의 방향이다.
    const votes = new Map<SpecSide, number>();
    const examples = new Set<string>();
    for (const found of placement.values()) {
      if (found.columns.length !== 1 || found.columns[0] !== found.branch || examples.has(found.branch)) continue;
      examples.add(found.branch);
      const side = sideOf(this.nodes.get(found.branch)?.box, markSpan.get(found.container));
      if (side) votes.set(side, (votes.get(side) ?? 0) + 1);
    }
    const tally = [...votes].sort((a, b) => b[1] - a[1]);
    const learnedSide = tally.length > 0 && (tally.length === 1 || tally[0][1] > tally[1][1]) ? tally[0][0] : undefined;

    /** 배운 방향으로 따로 선 열의 몫을 정한다. 오른쪽이면 이전 열과 이 열 사이 띠 안의 영역이다(가장 가까운 영역이 아닐 수 있다). */
    const strip = (column: string, others: string[], areas: string[], side: SpecSide): string[] => {
      const k = this.nodes.get(column)?.box;
      if (!k) return [];
      const boxes = others.map((id) => this.nodes.get(id)?.box).filter((b): b is Box => Boolean(b));
      const at = (id: string) => center(this.nodes.get(id)?.box ?? k);
      if (side === "right") {
        const from = Math.max(-Infinity, ...boxes.filter((b) => b.x + b.width <= k.x).map((b) => b.x + b.width));
        return areas.filter((id) => at(id).x > from && at(id).x < k.x);
      }
      if (side === "left") {
        const to = Math.min(Infinity, ...boxes.filter((b) => b.x >= k.x + k.width).map((b) => b.x));
        return areas.filter((id) => at(id).x > k.x + k.width && at(id).x < to);
      }
      if (side === "below") {
        const from = Math.max(-Infinity, ...boxes.filter((b) => b.y + b.height <= k.y).map((b) => b.y + b.height));
        return areas.filter((id) => at(id).y > from && at(id).y < k.y);
      }
      const to = Math.min(Infinity, ...boxes.filter((b) => b.y >= k.y + k.height).map((b) => b.y));
      return areas.filter((id) => at(id).y > k.y + k.height && at(id).y < to);
    };

    const scopeFor = (legend: SpecLegend): string[] => {
      const found = placement.get(legend.nodeId);
      if (!found) return [];
      const { container, branch, columns } = found;
      if (columns.length < 2 || !columns.includes(branch)) return [container];
      const children = this.nodes.get(container)?.children ?? [];
      // 자기 설명 열을 품은 영역은 그 열이 설명한다. 따로 선 열의 몫에서 뺀다.
      const areas = children.filter((id) => isArea(id) && !legendsUnder.get(id));
      if (learnedSide) {
        const owned = strip(branch, columns.filter((id) => id !== branch), areas, learnedSide);
        if (owned.length > 0) return owned;
      }
      // 방향을 배우지 못했으면 가장 가까운 영역으로 본다. 두 배 이상 가까울 때만 정한다.
      const ranked = children
        .filter(isArea)
        .map((child) => ({ child, distance: gap(this.nodes.get(branch)?.box, this.nodes.get(child)?.box) }))
        .sort((a, b) => a.distance - b.distance);
      if (ranked.length > 0 && (ranked.length === 1 || ranked[0].distance * 2 <= ranked[1].distance)) return [ranked[0].child];
      return [container];
    };
    const scopeOf = new Map(legends.map((legend) => [legend.nodeId, scopeFor(legend)]));
    const legendCenter = (legend: SpecLegend) => center(this.nodes.get(legend.entryNodeId)?.box ?? this.nodes.get(legend.nodeId)!.box!);

    const marks: SpecMark[] = [];
    for (const badge of markBadges) {
      const region = this.region(badge.node);
      const target = region?.box ?? badge.node.box!;
      const point = center(target);
      const tolerance = region ? 0 : EDGE;
      const hit = screenBoxes
        .filter(({ box }) => point.x >= box.x - tolerance && point.x <= box.x + box.width + tolerance && point.y >= box.y && point.y <= box.y + box.height)
        .sort((a, b) => a.box.width * a.box.height - b.box.width * b.box.height)[0];
      const rect = hit ? { x: Math.round(target.x - hit.box.x), y: Math.round(target.y - hit.box.y), width: Math.round(target.width), height: Math.round(target.height) } : undefined;
      const image = hit?.screen.image;
      const imageRect = rect && image
        ? { x: Math.round(rect.x * image.scale + image.offset.x), y: Math.round(rect.y * image.scale + image.offset.y), width: Math.round(rect.width * image.scale), height: Math.round(rect.height * image.scale) }
        : undefined;

      // 내용 근거: 그 화면의 주석과, 표시 영역 안에 놓인 글자.
      const content = new Set(hit ? notesByScreen.get(hit.screen.nodeId) ?? [] : []);
      if (hit && region?.box) {
        const area = region.box;
        for (const text of this.texts(hit.screen.nodeId)) {
          const at = text.box ? center(text.box) : undefined;
          if (at && at.x >= area.x && at.x <= area.x + area.width && at.y >= area.y && at.y <= area.y + area.height) {
            for (const token of tokens(text.text ?? "")) content.add(token);
          }
        }
      }

      const markAncestors = this.ancestors(badge.node.id);
      const markAncestorSet = new Set(markAncestors);
      const exact = legendByLabel.get(badge.label) ?? [];
      const pool = exact.length > 0 ? exact.map((legend) => ({ legend, labelMatch: "exact" as const })) : (legendByLabel.get(base(badge.label)) ?? []).map((legend) => ({ legend, labelMatch: "base" as const }));
      const candidates: Array<SpecCandidate & { legend: SpecLegend }> = pool.map(({ legend, labelMatch }) => {
        const legendAncestors = new Set(this.ancestors(legend.nodeId));
        const commonIndex = markAncestors.findIndex((ancestor) => legendAncestors.has(ancestor));
        const commonAncestorId = commonIndex >= 0 ? markAncestors[commonIndex] : undefined;
        const commonDepth = commonAncestorId ? this.ancestors(commonAncestorId).length : -1;
        // 이름 근거는 공통 조상 아래로 갈라진 경로에서만 본다. 위쪽은 양쪽이 같으니 가르지 못한다.
        const below = (ids: string[]) => ids.slice(0, commonIndex >= 0 ? ids.indexOf(commonAncestorId!) : ids.length).map((id) => this.nodes.get(id)?.name ?? "").join(" ");
        const legendBelow = below(this.ancestors(legend.nodeId));
        const markBelow = below(markAncestors) + (hit ? ` ${this.path(hit.screen.nodeId).join(" ")} ${this.nodes.get(hit.screen.nodeId)?.name ?? ""}` : "");
        const from = legendCenter(legend);
        const to = center(badge.node.box!);
        const scopeNodeIds = scopeOf.get(legend.nodeId) ?? [];
        return {
          legend,
          legendNodeId: legend.nodeId,
          labelMatch,
          commonAncestorId,
          commonDepth,
          scopeNodeIds,
          inScope: scopeNodeIds.length === 0 || scopeNodeIds.some((id) => markAncestorSet.has(id)),
          contentOverlap: overlap(legendTokens.get(legend.nodeId)!, content),
          nameOverlap: overlap(tokens(legendBelow), tokens(markBelow)),
          distance: Math.round(Math.hypot(from.x - to.x, from.y - to.y)),
        };
      }).sort((a, b) => Number(b.inScope) - Number(a.inScope) || b.commonDepth - a.commonDepth || b.contentOverlap - a.contentOverlap || a.distance - b.distance);

      let status: SpecMark["status"] = "unlinked";
      let chosen: (typeof candidates)[number] | undefined;
      let evidence: SpecEvidence | undefined;
      const unique = <T>(list: T[], score: (item: T) => number, min: number) => {
        const best = Math.max(...list.map(score));
        const top = list.filter((item) => score(item) === best);
        return best >= min && top.length === 1 ? top[0] : undefined;
      };
      // 같은 번호 설명이 다른 영역에만 있으면, 이 표시의 영역에는 설명이 없는 것이다. 내용이 우연히 겹쳐도 잇지 않는다.
      // 다른 영역의 같은 번호 설명은 candidates에 inScope=false로 참고만 남긴다.
      const inside = candidates.filter((candidate) => candidate.inScope);
      if (inside.length === 0) chosen = undefined;
      else if (candidates.length === 1) { chosen = candidates[0]; evidence = "only"; }
      else if (inside.length === 1) { chosen = inside[0]; evidence = "scope"; }
      else if (inside.length > 1) {
        const tied = inside.filter((candidate) => candidate.commonDepth === inside[0].commonDepth);
        const byDistance = [...tied].sort((a, b) => a.distance - b.distance);
        if (tied.length === 1) { chosen = tied[0]; evidence = "structure"; }
        else if (new Set(tied.map((candidate) => candidate.legend.markdown)).size === 1) { chosen = byDistance[0]; evidence = "same-text"; }
        else if ((chosen = unique(tied, (candidate) => candidate.contentOverlap, 2))) evidence = "content";
        else if (byDistance[1].distance >= byDistance[0].distance * 3) { chosen = byDistance[0]; evidence = "distance"; }
      }
      if (inside.length > 0) status = chosen ? "linked" : "ambiguous";

      marks.push({
        nodeId: badge.node.id,
        label: badge.label,
        kind: kindOf(badge.label, this.components.get(badge.node.componentId!)?.name ?? ""),
        path: this.path(badge.node.id),
        screenNodeId: hit?.screen.nodeId,
        rect,
        imageRect,
        regionNodeId: region?.id,
        status,
        legendNodeId: chosen?.legendNodeId,
        evidence,
        candidates: candidates.map(({ legend: _legend, ...candidate }) => candidate),
      });
    }

    const badgeComponents = [...specFamilies].map((family) => ({
      componentId: family,
      name: this.familyName(family),
      legends: stats.get(family)!.legendCount,
      marks: stats.get(family)!.marks.length,
    }));
    return {
      schemaVersion: 1,
      note: [
        "번호 배지(01, 02, E1 …)를 화면 위 표시(marks)와 설명 칸(legends)으로 나누고 같은 번호끼리 이었습니다. 배지는 모양이 아니라 쓰임새로 골랐습니다. 같은 컴포넌트가 설명 칸과 화면 위 표시에 함께 쓰인 것만 명세 배지로 봅니다(badgeComponents).",
        "설명 칸은 자기가 맡은 영역(scopeNodeIds)의 표시만 설명합니다. 보드 안의 설명 열 하나는 그 보드 전체를 맡고, 따로 선 설명 열이 여럿이면 이 파일의 확실한 예에서 배운 방향(layout.side)의 띠를 맡습니다. 예를 들어 right면 이전 열과 그 열 사이, 그 열의 왼쪽 영역입니다(가장 가까운 영역과 다를 수 있음). 같은 번호의 설명 칸을 모두 candidates에 두고, 영역 안(inScope=true) 후보 가운데 근거가 뚜렷할 때만 status=linked로 확정했습니다. evidence는 확정 근거입니다. only=후보가 하나, scope=영역 안 후보가 하나, structure=공통 조상이 가장 깊은 후보가 하나, same-text=가장 가까운 후보들의 설명이 같음, content=설명 문장이 그 화면의 주석·표시 영역 글자와 더 많이 겹침, distance=가장 가까운 후보가 다음 후보보다 3배 이상 가까움. nameOverlap은 참고값이며 확정에 쓰지 않았습니다(이웃 보드가 같은 단어를 공유하면 남의 보드 설명을 고르게 됨).",
        "status=ambiguous는 영역 안 후보가 여럿인데 근거로 가르지 못한 경우입니다. 설명 문장과 표시 영역(imageRect로 화면 이미지를 잘라 봄)을 비교해 고르면 됩니다. unlinked는 표시가 속한 영역에 같은 번호의 설명 칸이 없는 경우입니다. 다른 영역의 같은 번호 설명은 candidates에 inScope=false로 참고만 남기며, 그것으로 확정하지 않습니다.",
        "rect는 화면 원점 기준 Figma 단위이고 imageRect는 그 화면 이미지 픽셀입니다(원점 보정 반영). 영역 사각형(regionNodeId)을 찾으면 그 영역을, 못 찾으면 배지 자리를 가리킵니다. labelMatch=base는 01A처럼 꼬리 글자가 붙은 번호를 01의 설명 칸에 이은 후보입니다.",
        "legends의 markdown은 Figma 목록 서식(글머리표 종류·들여쓰기 단계)을 중첩 목록으로 되살린 설명 원문입니다.",
      ],
      badgeComponents,
      layout: { side: learnedSide, examples: examples.size },
      legends,
      marks,
      summary: {
        legends: legends.length,
        marks: marks.length,
        linked: marks.filter((mark) => mark.status === "linked").length,
        ambiguous: marks.filter((mark) => mark.status === "ambiguous").length,
        unlinked: marks.filter((mark) => mark.status === "unlinked").length,
        onScreen: marks.filter((mark) => mark.screenNodeId).length,
        withRegion: marks.filter((mark) => mark.regionNodeId).length,
      },
    };
  }
}
