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

export type FigmaTransport = "desktop" | "remote" | "codex" | "plugin";
export type FigmaFileType = "design" | "figjam";
export type FigmaTargetMode = "link" | "selection";
export type FigmaExtractionScope = "node" | "current_page";

export type FigmaExtractionInput = {
  target: string;
  targetMode: FigmaTargetMode;
  scope: FigmaExtractionScope;
  transport: FigmaTransport;
  includeVariables: boolean;
  includeCodeConnect: boolean;
  includeMotion: boolean;
  includeLibraries: boolean;
  includeAssets: boolean;
  clientFrameworks: string;
  clientLanguages: string;
  codeConnectLabel?: string;
  question?: string;
  mode: "live" | "demo";
};

export type FigmaQuestionInput = Omit<FigmaExtractionInput, "mode" | "targetMode"> & {
  transport: "codex" | "plugin";
  targetMode: "link";
  question: string;
  mode: "live";
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
  screenshotPath?: string;
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
  screenshotSlot?: string;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  error?: string;
};

export type FigmaPluginExtractionResult = {
  scope: FigmaExtractionScope;
  snapshot?: unknown;
  nodeCount: number;
  partial: boolean;
  omittedNodes?: number;
  meta: FigmaPluginMeta & { nodeId?: string; nodeName?: string; nodeType?: string };
  page?: { id: string; name: string; nodes: FigmaPluginPageNodeResult[] };
  artifacts: Array<{ slot: string; kind: ArtifactRef["kind"] | "json"; mimeType: string; name: string; bytes: number }>;
};

export type SlackImportRecord = {
  id: string;
  filename: string;
  uploadedAt: string;
  expiresAt: number;
  data: Uint8Array;
};

export type SlackExtractionMode = "export" | "mcp";

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

export type SlackNormalizedExport = {
  schemaVersion: 1;
  source: "slack_export" | "slack_mcp";
  importedAt: string;
  users: SlackUser[];
  conversations: SlackConversation[];
  messages: SlackNormalizedMessage[];
  files: SlackFileRef[];
  provenance: Record<string, unknown>;
};

export type SlackRunRecord = RunRecord<SlackExtractionInput> & {
  normalized?: SlackNormalizedExport;
};

export type FigmaRestOAuthSession = {
  redeemSecret?: string;
  accessToken?: string;
  expiresAt?: number;
  refreshGrant?: string;
  userId?: string;
};

export type CodexAuthFlow = {
  kind: "codex" | "figma";
  state: "waiting" | "complete" | "error";
  authUrl?: string;
  userCode?: string;
  message?: string;
  startedAt: number;
};

export type CodexBridgeSession = {
  flow?: CodexAuthFlow;
  process?: ChildProcess;
  tools: ToolDescriptor[];
};

export type CodexBridgeStatus = {
  connected: boolean;
  transport: "codex";
  beta: true;
  tools?: ToolDescriptor[];
  codex: { installed: boolean; version?: string; authenticated: boolean };
  figmaMcp: { configured: boolean; enabled: boolean; authenticated: boolean; authStatus?: string; url?: string };
  authFlow?: CodexAuthFlow;
  message?: string;
};
