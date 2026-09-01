import { figmaRestJson } from "./figma-rest-client.js";
import type {
  DesignContextPackage,
  FigmaFileType,
  FigmaNodeChange,
  FigmaRestOAuthSession,
  FigmaTarget,
  FigmaVersionSnapshot,
  FigmaRestMetadataPackage,
  SemanticHint,
} from "./types.js";

export async function loadFigmaRestMetadata(
  session: FigmaRestOAuthSession,
  fileKey: string,
  signal?: AbortSignal,
): Promise<FigmaRestMetadataPackage> {
  const encoded = encodeURIComponent(fileKey);
  const [file, comments, versions] = await Promise.all([
    figmaRestJson<unknown>(session, `/files/${encoded}/meta`, signal),
    figmaRestJson<unknown>(session, `/files/${encoded}/comments?as_md=true`, signal),
    figmaRestJson<unknown>(session, `/files/${encoded}/versions`, signal),
  ]);
  return { file, comments, versions, fetchedAt: new Date().toISOString() };
}

type VersionApiValue = {
  id: string;
  created_at: string;
  label?: string;
  description?: string;
  user?: { id?: string; name?: string; handle?: string; img_url?: string };
};

type FileApiValue = {
  version?: string;
  lastModified?: string;
  document?: unknown;
};

type FlatNode = { id: string; parentId?: string; index: number; node: Record<string, unknown> };

const GROUPS: Array<{ category: FigmaNodeChange["category"]; keys: string[] }> = [
  { category: "text", keys: ["characters", "styleOverrideTable", "characterStyleOverrides"] },
  { category: "geometry", keys: ["absoluteBoundingBox", "absoluteRenderBounds", "size", "relativeTransform", "rotation"] },
  { category: "layout", keys: ["layoutMode", "layoutSizingHorizontal", "layoutSizingVertical", "primaryAxisAlignItems", "counterAxisAlignItems", "itemSpacing", "counterAxisSpacing", "paddingLeft", "paddingRight", "paddingTop", "paddingBottom", "constraints", "layoutPositioning"] },
  { category: "visual", keys: ["fills", "strokes", "effects", "opacity", "blendMode", "cornerRadius", "rectangleCornerRadii", "visible", "backgroundColor"] },
  { category: "component", keys: ["componentId", "componentProperties", "variantProperties", "overrides"] },
  { category: "variables", keys: ["boundVariables", "styles"] },
  { category: "interaction", keys: ["interactions", "transitionNodeID", "transitionDuration", "transitionEasing"] },
  { category: "other", keys: ["annotations", "description", "devStatus"] },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodeChildren(value: Record<string, unknown>): unknown[] {
  return Array.isArray(value.children) ? value.children : [];
}

export function findFigmaNode(value: unknown, nodeId: string): Record<string, unknown> | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = findFigmaNode(child, nodeId);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.id === nodeId) return value;
  for (const key of ["document", "nodes", "children"]) {
    if (!(key in value)) continue;
    const found = findFigmaNode(value[key], nodeId);
    if (found) return found;
  }
  return undefined;
}

function flatten(root: unknown): Map<string, FlatNode> {
  const nodes = new Map<string, FlatNode>();
  const visit = (value: unknown, parentId?: string) => {
    if (!isRecord(value)) return;
    const id = typeof value.id === "string" ? value.id : undefined;
    const children = nodeChildren(value);
    if (id) nodes.set(id, { id, parentId, index: 0, node: value });
    children.forEach((child, index) => {
      if (isRecord(child) && typeof child.id === "string") {
        const entry = { id: child.id, parentId: id, index, node: child };
        nodes.set(child.id, entry);
        visitChildren(child, child.id);
      }
    });
  };
  const visitChildren = (value: Record<string, unknown>, parentId: string) => {
    nodeChildren(value).forEach((child, index) => {
      if (!isRecord(child) || typeof child.id !== "string") return;
      nodes.set(child.id, { id: child.id, parentId, index, node: child });
      visitChildren(child, child.id);
    });
  };
  visit(root);
  return nodes;
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
}

function pick(node: Record<string, unknown>, keys: string[]) {
  const result: Record<string, unknown> = {};
  for (const key of keys) if (node[key] !== undefined) result[key] = node[key];
  return result;
}

function compact(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (!text || text.length <= 2_000) return value;
  return { truncated: true, characters: text.length, preview: text.slice(0, 1_800) };
}

function versionUser(value?: VersionApiValue["user"]): FigmaVersionSnapshot["user"] {
  return value ? { id: value.id, name: value.name, handle: value.handle, imgUrl: value.img_url } : undefined;
}

export function diffFigmaSnapshots(older: FigmaVersionSnapshot, newer: FigmaVersionSnapshot): FigmaNodeChange[] {
  const before = flatten(older.node);
  const after = flatten(newer.node);
  const changes: FigmaNodeChange[] = [];
  const add = (entry: Omit<FigmaNodeChange, "versionId" | "createdAt" | "actor" | "attribution">) => {
    if (changes.length >= 2_000) return;
    changes.push({
      ...entry,
      versionId: newer.id,
      createdAt: newer.createdAt,
      actor: newer.user,
      attribution: "coarse_version_attribution",
    });
  };
  for (const [id, current] of after) {
    const previous = before.get(id);
    if (!previous) {
      add({ nodeId: id, path: "node", category: "created", after: compact({ type: current.node.type, name: current.node.name }) });
      continue;
    }
    if (previous.parentId !== current.parentId || previous.index !== current.index) {
      add({ nodeId: id, path: "parent", category: "moved", before: { parentId: previous.parentId, index: previous.index }, after: { parentId: current.parentId, index: current.index } });
    }
    if (previous.node.name !== current.node.name) add({ nodeId: id, path: "name", category: "name", before: previous.node.name, after: current.node.name });
    for (const group of GROUPS) {
      const left = pick(previous.node, group.keys);
      const right = pick(current.node, group.keys);
      if (stable(left) !== stable(right)) add({ nodeId: id, path: group.keys.join("|"), category: group.category, before: compact(left), after: compact(right) });
    }
  }
  for (const [id, previous] of before) {
    if (!after.has(id)) add({ nodeId: id, path: "node", category: "deleted", before: compact({ type: previous.node.type, name: previous.node.name }) });
  }
  return changes;
}

function actorKey(user: FigmaVersionSnapshot["user"]): string {
  if (user?.id) return `id:${user.id}`;
  return `name:${(user?.name ?? user?.handle ?? "unknown").trim().toLowerCase()}`;
}

export function groupChangesByActor(changes: FigmaNodeChange[]): DesignContextPackage["history"]["byActor"] {
  const grouped = new Map<string, { actorKey: string; actor?: FigmaVersionSnapshot["user"]; changes: FigmaNodeChange[] }>();
  for (const change of changes) {
    const key = actorKey(change.actor);
    const entry = grouped.get(key) ?? { actorKey: key, actor: change.actor, changes: [] };
    entry.changes.push(change);
    grouped.set(key, entry);
  }
  return [...grouped.values()];
}

function hintFor(node: Record<string, unknown>, fileType: FigmaFileType, ancestors: string[]): SemanticHint | undefined {
  if (typeof node.id !== "string") return undefined;
  const type = String(node.type ?? "").toUpperCase();
  const name = String(node.name ?? "");
  const corpus = `${name} ${typeof node.characters === "string" ? node.characters.slice(0, 120) : ""}`.toLowerCase();
  let role: string | undefined;
  let confidence: SemanticHint["confidence"] = "medium";
  const evidence = [`type:${type}`, ...(name ? [`name:${name}`] : [])];
  const provenance: SemanticHint["provenance"] = [{ source: "node_type", value: type }];
  if (name) provenance.push({ source: "layer_name", value: name.slice(0, 160) });
  if (typeof node.characters === "string" && node.characters.trim()) provenance.push({ source: "text", value: node.characters.trim().slice(0, 160) });
  if (ancestors.length) provenance.push({ source: "hierarchy", value: ancestors.slice(-6).join(" / ") });
  if (fileType === "figjam") {
    if (type === "CONNECTOR") { role = "flow-connection"; confidence = "high"; }
    else if (type === "STICKY") { role = "note"; confidence = "high"; }
    else if (type === "SECTION") { role = "board-section"; confidence = "high"; }
    else if (type === "SHAPE_WITH_TEXT") role = "diagram-node";
  } else {
    if (/\b(button|btn|cta|action)\b/.test(corpus)) { role = "action-control"; confidence = "high"; }
    else if (/\b(input|field|search|query|form)\b/.test(corpus)) role = "input-control";
    else if (/\b(nav|menu|tab|breadcrumb|header|footer)\b/.test(corpus)) role = "navigation";
    else if (/\b(modal|dialog|sheet|drawer|popover)\b/.test(corpus)) role = "overlay";
    else if (/\b(status|badge|toast|error|success|warning)\b/.test(corpus)) role = "status-feedback";
    else if (/\b(image|photo|icon|logo|avatar|thumbnail)\b/.test(corpus)) role = "media";
    else if (/\b(card|list|item|article|news|feed|content)\b/.test(corpus)) role = "content-group";
    else if (type === "TEXT") role = "text-content";
    else if (["FRAME", "SECTION", "GROUP", "COMPONENT", "INSTANCE"].includes(type)) { role = "container"; confidence = "low"; }
  }
  if (!role) return undefined;
  if (node.componentProperties) { evidence.push("componentProperties"); provenance.push({ source: "component", value: "componentProperties" }); }
  if (node.annotations) { evidence.push("annotations"); provenance.push({ source: "annotation", value: JSON.stringify(node.annotations).slice(0, 160) }); }
  if (node.boundVariables) { evidence.push("boundVariables"); provenance.push({ source: "variable", value: JSON.stringify(node.boundVariables).slice(0, 160) }); }
  if (node.interactions || node.transitionNodeID) { evidence.push("interactions"); provenance.push({ source: "prototype", value: JSON.stringify(node.interactions ?? node.transitionNodeID).slice(0, 160) }); }
  return { nodeId: node.id, role, confidence, evidence, provenance };
}

export function buildSemanticHints(snapshot: unknown, fileType: FigmaFileType): SemanticHint[] {
  const result: SemanticHint[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown, ancestors: string[] = []) => {
    if (Array.isArray(value)) { value.forEach((child) => visit(child, ancestors)); return; }
    if (!isRecord(value)) return;
    const marker = typeof value.name === "string" && value.name ? value.name : typeof value.id === "string" ? value.id : undefined;
    if (typeof value.id === "string" && !seen.has(value.id)) {
      seen.add(value.id);
      const hint = hintFor(value, fileType, ancestors);
      if (hint) result.push(hint);
    }
    const nextAncestors = marker ? [...ancestors, marker] : ancestors;
    if (value.document) visit(value.document, nextAncestors);
    if (value.nodes) visit(value.nodes, nextAncestors);
    if (value.children) visit(value.children, nextAncestors);
  };
  visit(snapshot);
  return result.slice(0, 1_000);
}

export async function loadFigmaHistory(
  session: FigmaRestOAuthSession,
  target: FigmaTarget,
  signal?: AbortSignal,
): Promise<{ snapshots: FigmaVersionSnapshot[]; changes: FigmaNodeChange[]; byActor: DesignContextPackage["history"]["byActor"] }> {
  const [versionsResponse, currentResponse] = await Promise.all([
    figmaRestJson<{ versions?: VersionApiValue[] }>(session, `/files/${encodeURIComponent(target.fileKey)}/versions`, signal),
    figmaRestJson<FileApiValue>(session, `/files/${encodeURIComponent(target.fileKey)}?ids=${encodeURIComponent(target.nodeId)}`, signal),
  ]);
  const currentNode = findFigmaNode(currentResponse.document, target.nodeId);
  if (!currentNode) throw new Error("Figma REST 현재 버전에서 대상 노드를 찾지 못했습니다.");
  const versions = [...(versionsResponse.versions ?? [])].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const currentId = currentResponse.version ?? `current:${currentResponse.lastModified ?? new Date().toISOString()}`;
  const currentVersion = versions.find((version) => version.id === currentResponse.version);
  const historical = versions.filter((version) => version.id !== currentResponse.version).slice(-4);
  const selected = [...historical, ...(currentVersion ? [currentVersion] : [])].slice(-5);
  const fetched = await Promise.all(selected.map(async (version): Promise<FigmaVersionSnapshot> => {
    if (version.id === currentResponse.version) {
      return { id: version.id, createdAt: version.created_at, label: version.label, description: version.description, user: versionUser(version.user), node: currentNode, current: true };
    }
    const response = await figmaRestJson<FileApiValue>(session, `/files/${encodeURIComponent(target.fileKey)}?ids=${encodeURIComponent(target.nodeId)}&version=${encodeURIComponent(version.id)}`, signal);
    const node = findFigmaNode(response.document, target.nodeId);
    return { id: version.id, createdAt: version.created_at, label: version.label, description: version.description, user: versionUser(version.user), node, missing: !node };
  }));
  if (!currentVersion) {
    fetched.push({ id: currentId, createdAt: currentResponse.lastModified ?? new Date().toISOString(), node: currentNode, current: true });
  }
  const snapshots = fetched.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).slice(-5);
  const changes: FigmaNodeChange[] = [];
  for (let index = 1; index < snapshots.length; index += 1) changes.push(...diffFigmaSnapshots(snapshots[index - 1], snapshots[index]));
  return { snapshots, changes, byActor: groupChangesByActor(changes) };
}
