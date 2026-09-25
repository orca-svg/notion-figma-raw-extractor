import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ChildProcess } from "node:child_process";

export type Provider = "notion" | "figma" | "slack";
export type TraceOrigin = "mcp" | "internal" | "codex" | "plugin" | "rest";

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

export interface McpAdapter {
  listTools(): Promise<ToolDescriptor[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}

export type NotionExtractionInput = {
  target: string;
  expectedEmail?: string;
  searchQuery?: string;
  maxRows: number;
  includeArchived: boolean;
  includeComments: boolean;
  includeTranscript: boolean;
  /** 대상 문서와 무관한 워크스페이스 멤버·팀스페이스 조회. 개인정보가 트레이스에 남으므로 기본 off. */
  includeWorkspace: boolean;
  mode?: "live" | "demo";
};

/** Kept as an alias for the existing Notion pipeline and its tests. */
export type ExtractionInput = NotionExtractionInput;

export type NotionTargetKind = "page" | "database";

export type NotionTarget = {
  kind: NotionTargetKind;
  pageId: string;
  viewId?: string;
  sourceUrl: string;
};

/** 추출은 Figma 개발 플러그인만 쓴다. 번들 manifest에 출처를 남기려고 필드는 유지한다. */
export type FigmaTransport = "plugin";
export type FigmaFileType = "design" | "figjam";
export type FigmaTargetMode = "link";
export type FigmaExtractionScope = "node" | "current_page";

export type FigmaExtractionInput = {
  target: string;
  targetMode: FigmaTargetMode;
  scope: FigmaExtractionScope;
  transport: FigmaTransport;
  question?: string;
  /** 현재 페이지 추출에서 운영자가 확인 화면에서 고른 화면 크기. */
  screenDevices?: FigmaPluginDevice[];
  /** screenDevices를 찾은 페이지. */
  screenPageId?: string;
};

export type FigmaTarget = {
  fileKey: string;
  nodeId: string;
  fileType: FigmaFileType;
  sourceUrl: string;
};

export type StepState = "running" | "success" | "warning" | "error" | "skipped";

export type ExtractionEvent = {
  type: "step" | "complete" | "fatal";
  id: string;
  order: number;
  group: string;
  label: string;
  state: StepState;
  tool?: string;
  startedAt: string;
  elapsedMs?: number;
  request?: unknown;
  response?: unknown;
  extracted?: unknown;
  message?: string;
  provider?: Provider;
  runId?: string;
  origin?: TraceOrigin;
  responseBytes?: number;
  artifacts?: ArtifactRef[];
};

export type EmitEvent = (event: ExtractionEvent) => void | Promise<void>;

export type ParsedToolResult = {
  isError: boolean;
  text: string;
  payload: unknown;
  raw: CallToolResult;
};

export type ArtifactRef = {
  id: string;
  path: string;
  mimeType: string;
  bytes: number;
  kind: "screenshot" | "asset" | "binary";
};

export type EvidenceRef = {
  kind: "node" | "version" | "artifact" | "tool";
  nodeId?: string;
  versionId?: string;
  artifactId?: string;
  tool?: string;
  detail?: string;
};

export type FigmaQuestionAnswer = {
  answer: string;
  evidence: EvidenceRef[];
  uncertainties: string[];
  model: string;
  promptVersion: string;
  generatedAt: string;
};

export type SemanticHint = {
  nodeId: string;
  role: string;
  confidence: "low" | "medium" | "high";
  evidence: string[];
  provenance: Array<{ source: "node_type" | "layer_name" | "text" | "annotation" | "hierarchy" | "component" | "variable" | "prototype"; value: string }>;
};

export type FigmaVersionSnapshot = {
  id: string;
  createdAt: string;
  label?: string;
  description?: string;
  user?: { id?: string; name?: string; handle?: string; imgUrl?: string };
  node?: unknown;
  current?: boolean;
  missing?: boolean;
};

export type FigmaNodeChange = {
  versionId: string;
  createdAt: string;
  actor?: FigmaVersionSnapshot["user"];
  attribution: "coarse_version_attribution";
  nodeId: string;
  path: string;
  category: "created" | "deleted" | "moved" | "name" | "text" | "geometry" | "layout" | "visual" | "component" | "variables" | "interaction" | "other";
  before?: unknown;
  after?: unknown;
};

export type DesignContextPackage = {
  schemaVersion: 1;
  target: FigmaTarget;
  editorType: FigmaFileType;
  currentSnapshot: unknown;
  semanticHints: SemanticHint[];
  history: {
    snapshots: FigmaVersionSnapshot[];
    changes: FigmaNodeChange[];
    byActor: Array<{ actorKey: string; actor?: FigmaVersionSnapshot["user"]; changes: FigmaNodeChange[] }>;
    unavailableReason?: string;
  };
  artifacts: ArtifactRef[];
  provenance: Array<{ source: "plugin" | "figma_rest" | "codex"; detail: string }>;
  partial: boolean;
  omittedNodes?: number;
  answer?: FigmaQuestionAnswer;
};

export type FigmaRestMetadataPackage = {
  file: unknown;
  comments: unknown;
  versions: unknown;
  fetchedAt: string;
};

export type FigmaPageNodeIndex = {
  nodeId: string;
  name: string;
  type: string;
  jsonPath?: string;
  /** 예산을 넘어 서브트리로 나뉜 조각들. 각 파일은 단독으로 파싱되며 __part 참조로 이어진다. */
  parts?: Array<{ path: string; nodeId: string; name: string; type: string; nodeCount: number; parentNodeId?: string; bytes: number }>;
  screenshotPath?: string;
  /** PNG를 만들었지만 번들에 넣지 못한 경우의 사유. 채워지면 page.json은 partial로 표시된다. */
  screenshotOmitted?: string;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  error?: string;
};

export type FigmaPagePackage = {
  schemaVersion: 1;
  fileKey: string;
  editorType: FigmaFileType;
  pageId: string;
  pageName: string;
  extractedAt: string;
  nodes: FigmaPageNodeIndex[];
  partial: boolean;
  /** 에셋 회계. 번들만 보고도 무엇이 빠졌는지 알 수 있어야 한다. */
  assets?: { stored: number; deduplicated: number; omitted: { cap: number; oversized: number; failed: number; storeRejected: number } };
  /** 화면·기능 묶음 이미지 요약. 상세는 indexPath의 screens.json에 있다. */
  screens?: { total: number; byDevice: Record<string, number>; groups: number; failed: number; annotations: number; indexPath: string };
  provenance: Array<{ source: "plugin" | "figma_rest"; detail: string }>;
};

export type StoredArtifact = ArtifactRef & {
  data: Uint8Array;
};

/** Notion과 Figma 실행이 공유하는 부분. provider별 필드는 각 RunRecord가 덧붙인다. */
export type RunRecord<TInput> = {
  id: string;
  sessionId: string;
  startedAt: string;
  completedAt?: string;
  expiresAt: number;
  input: TInput;
  tools: ToolDescriptor[];
  events: ExtractionEvent[];
  artifacts: Map<string, StoredArtifact>;
  artifactBytes: number;
};

export type FigmaRunRecord = RunRecord<FigmaExtractionInput> & {
  detectedFileType?: FigmaFileType;
  contextPackage?: DesignContextPackage;
  restMetadata?: FigmaRestMetadataPackage;
  pagePackage?: FigmaPagePackage;
  bundleFiles: Map<string, Uint8Array>;
};

export type NotionRunRecord = RunRecord<NotionExtractionInput>;

export type FigmaPluginMeta = {
  pluginVersion: string;
  editorType: "figma" | "figjam";
  fileKey?: string;
  fileName?: string;
  pageId?: string;
  pageName?: string;
  user?: { id?: string | null; name?: string; photoUrl?: string | null };
};

export type FigmaPluginJobOptions = {
  maxNodes: number;
  maxJsonBytes: number;
  maxDimension: number;
  maxAssets: number;
  maxAssetBytes: number;
  /** 이미지 없이 화면 크기 후보만 계산한다. 추출 전 확인 화면용. */
  scanOnly?: boolean;
  /** 운영자가 확인 화면에서 고른 화면 크기. 주어지면 플러그인이 스스로 학습하지 않는다. */
  devices?: FigmaPluginDevice[];
  /** 확인 화면의 후보를 찾은 페이지. 플러그인이 지금 열린 페이지와 다르면 추출을 거부한다. */
  expectedPageId?: string;
};

export type FigmaPluginJob = {
  id: string;
  type: "extract_node";
  target: FigmaTarget;
  options: FigmaPluginJobOptions;
} | {
  id: string;
  type: "extract_page";
  fileKey: string;
  fileType: FigmaFileType;
  options: FigmaPluginJobOptions;
};

export type FigmaPluginPageNodeResult = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  jsonSlot?: string;
  parts?: Array<{ slot: string; nodeId: string; nodeName: string; nodeType: string; nodeCount: number; parentNodeId?: string; bytes: number }>;
  screenshotSlot?: string;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  error?: string;
};

/** 플러그인이 이 파일에서 "화면"으로 본 기기 크기. 이름 붙은 프레임에서 배우고, 없으면 모바일 기본 범위다. */
export type FigmaPluginDevice = {
  device: string;
  width?: number;
  height?: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight?: number;
  source: "name" | "repeat" | "default";
  examples: string[];
  screens: number;
  selected?: boolean;
};

export type FigmaPluginScreen = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  device: string;
  width: number;
  height: number;
  path: string[];
  groupNodeId?: string;
  slot?: string;
  scale?: number;
  /** 프레임 원점이 이미지 안에서 놓인 위치(Figma 단위). 그림자·넘친 내용이 있으면 0이 아니다. */
  renderOffset?: { x: number; y: number };
  error?: string;
};

/** Figma 기본 주석. 노드에 직접 붙어 있으므로 화면·기능 묶음은 조상에서 정해진다. */
export type FigmaPluginAnnotation = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  label?: string;
  labelMarkdown?: string;
  categoryId?: string;
  properties?: string[];
  screenNodeId?: string;
  groupNodeId?: string;
  /** 화면 원점(없으면 묶음 원점, 둘 다 없으면 페이지) 기준 Figma 단위. */
  rect?: { x: number; y: number; width: number; height: number };
};

export type FigmaPluginAnnotationCategory = { id: string; label: string; color: string; isPreset: boolean };

export type FigmaPluginIgnoredDevice = { device: string; width?: number; height?: number; examples: string[]; reason: string };

export type FigmaPluginGroup = {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  path: string[];
  width: number;
  height: number;
  slot?: string;
  scale?: number;
  renderOffset?: { x: number; y: number };
  /** 묶음 원점 기준 Figma 단위. 이미지 픽셀은 (값 + renderOffset) × scale이다. */
  screens: Array<{ nodeId: string; x: number; y: number; width: number; height: number }>;
  error?: string;
};

/** 추출 전 확인 화면에 보여 줄 화면 크기 후보. 플러그인이 이미지 없이 계산한다. */
export type FigmaScreenProposal = {
  fileKey: string;
  fileName?: string;
  pageId: string;
  pageName: string;
  nodeCount: number;
  devices: FigmaPluginDevice[];
  ignoredDevices: FigmaPluginIgnoredDevice[];
  screens: number;
  groups: number;
};

export type FigmaPluginExtractionResult = {
  scope: FigmaExtractionScope;
  snapshot?: unknown;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  meta: FigmaPluginMeta & { nodeId?: string; nodeName?: string; nodeType?: string };
  page?: { id: string; name: string; nodes: FigmaPluginPageNodeResult[]; devices?: FigmaPluginDevice[]; ignoredDevices?: FigmaPluginIgnoredDevice[]; screens?: FigmaPluginScreen[]; groups?: FigmaPluginGroup[]; annotations?: FigmaPluginAnnotation[]; annotationCategories?: FigmaPluginAnnotationCategory[] };
  /** 담지 못한 에셋의 사유별 개수. 침묵하면 무엇을 잃었는지 알 길이 없다. */
  omittedAssets?: { cap: number; oversized: number; failed: number; duplicate: number };
  artifacts: Array<{ slot: string; kind: ArtifactRef["kind"] | "json"; mimeType: string; name: string; bytes: number; usages?: Array<{ nodeId: string; nodeName: string }> }>;
};

export type SlackImportRecord = {
  id: string;
  filename: string;
  uploadedAt: string;
  expiresAt: number;
  data: Uint8Array;
};

/**
 * 토큰이 곧 자격증명이라 중간 서버가 필요 없다. Figma 개인 액세스 토큰과 같은 구조로,
 * 파일이나 브라우저에 쓰지 않고 서버 세션 메모리에만 둔다.
 */
export type SlackWebSession = {
  token?: string;
  tokenType?: "user" | "bot";
  teamId?: string;
  teamName?: string;
  userId?: string;
  userName?: string;
  workspaceUrl?: string;
};

export type SlackExtractionMode = "export" | "mcp" | "web";

export type SlackExtractionInput = {
  mode: SlackExtractionMode;
  importId?: string;
  target?: string;
  oldest?: string;
  latest?: string;
  includeFiles: boolean;
};

export type SlackUser = {
  id: string;
  name?: string;
  realName?: string;
  displayName?: string;
  email?: string;
  deleted?: boolean;
  raw: unknown;
};

export type SlackFileRef = {
  id: string;
  name?: string;
  title?: string;
  mimeType?: string;
  url?: string;
  permalink?: string;
  conversationId?: string;
  messageTs?: string;
  artifactPath?: string;
  raw: unknown;
};

export type SlackConversation = {
  id: string;
  name: string;
  kind: "public_channel" | "private_channel" | "dm" | "mpim" | "unknown";
  members: string[];
  raw: unknown;
};

export type SlackNormalizedMessage = {
  conversationId: string;
  ts: string;
  userId?: string;
  author?: string;
  text: string;
  subtype?: string;
  threadTs?: string;
  parentTs?: string;
  edited?: unknown;
  reactions?: unknown;
  files: string[];
  raw: unknown;
};

/**
 * 어디까지 읽었는지를 결과에 남긴다. Slack은 cursor로 페이지를 잇는데, 끝까지 따라가지 못하고
 * 멈춘 것과 원래 그만큼인 것을 구분할 수 없으면 잘린 줄 모르고 잘린 데이터를 넘기게 된다.
 */
export type SlackExtractionCoverage = {
  historyPages: number;
  historyTruncated: boolean;
  threadRoots: number;
  threadsRead: number;
  threadsTruncated: boolean;
  users: { authorIds: number; resolved: number; source: "users_list" | "users_info" | "message_profile" | "none" };
  files: { candidates: number; stored: number; skipped: number };
};

export type SlackNormalizedExport = {
  schemaVersion: 1;
  source: "slack_export" | "slack_mcp" | "slack_web";
  importedAt: string;
  users: SlackUser[];
  conversations: SlackConversation[];
  messages: SlackNormalizedMessage[];
  files: SlackFileRef[];
  coverage?: SlackExtractionCoverage;
  provenance: Record<string, unknown>;
};

export type SlackRunRecord = RunRecord<SlackExtractionInput> & {
  normalized?: SlackNormalizedExport;
};

export type FigmaRestOAuthSession = {
  /** oauth는 broker 경유 인증, pat는 사용자가 붙여넣은 개인 액세스 토큰. */
  kind?: "oauth" | "pat";
  redeemSecret?: string;
  accessToken?: string;
  expiresAt?: number;
  refreshGrant?: string;
  userId?: string;
};

/** 노드 질문에 쓰는 로컬 Codex CLI의 기기 로그인 진행 상태. */
export type CodexAuthFlow = {
  state: "waiting" | "complete" | "error";
  authUrl?: string;
  userCode?: string;
  message?: string;
  startedAt: number;
};

export type CodexCliSession = {
  flow?: CodexAuthFlow;
  process?: ChildProcess;
};

export type CodexCliStatus = {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  authFlow?: CodexAuthFlow;
  message?: string;
};
