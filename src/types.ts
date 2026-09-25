export type StepState = "running" | "success" | "warning" | "error" | "skipped";
export type Provider = "notion" | "figma" | "slack";
export type AppView = "trace" | "tools";

export type ArtifactRef = {
  id: string;
  path: string;
  mimeType: string;
  bytes: number;
  kind: "screenshot" | "asset" | "binary";
};

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
  origin?: "mcp" | "internal" | "codex" | "plugin" | "rest";
  responseBytes?: number;
  artifacts?: ArtifactRef[];
};

export type Identity = {
  workspace?: { id?: string; name?: string };
  user?: { id?: string; name?: string; email?: string; type?: string };
  current_tool_access?: Record<string, { status?: string; upgrade_url?: string }>;
};

export type ConnectionStatus = {
  connected: boolean;
  authKind?: "oauth" | "pat";
  identity?: Identity;
  expectedEmail?: string;
  message?: string;
};

export type ExtractionOptions = {
  target: string;
  expectedEmail?: string;
  searchQuery?: string;
  maxRows: number;
  includeArchived: boolean;
  includeComments: boolean;
  includeTranscript: boolean;
  includeWorkspace: boolean;
  mode: "live" | "demo";
};

export type ToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
};

/** Figma 추출은 개발 플러그인만 쓴다. */
export type FigmaTransport = "plugin";

/** 노드 질문에 쓰는 로컬 Codex CLI의 기기 로그인 진행 상태. */
export type CodexAuthFlow = {
  state: "waiting" | "complete" | "error";
  authUrl?: string;
  userCode?: string;
  message?: string;
  startedAt: number;
};

export type CodexCliStatus = {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  authFlow?: CodexAuthFlow;
  message?: string;
};

export type FigmaConnectionStatus = {
  connected: boolean;
  transport?: FigmaTransport;
  message?: string;
  plugin?: {
    connected: boolean;
    lastSeenAt?: string;
    meta?: { pluginVersion: string; editorType: "figma" | "figjam"; fileKey?: string; fileName?: string; pageId?: string; pageName?: string; user?: { id?: string | null; name?: string } };
  };
  restOAuth?: { connected: boolean; userId?: string; message?: string; authKind?: "oauth" | "pat" };
};

/** 화면으로 볼 프레임 크기 하나. 플러그인이 파일에서 찾아 제안하고 운영자가 고른다. */
export type FigmaScreenDevice = {
  device: string;
  width?: number;
  height?: number;
  minWidth: number;
  maxWidth: number;
  minHeight: number;
  maxHeight?: number;
  /** name: 기기 이름이 붙은 프레임, repeat: 이름 없이 3번 이상 반복된 프레임 크기, default: 근거가 없어 쓴 모바일 기본 범위 */
  source: "name" | "repeat" | "default";
  examples: string[];
  screens: number;
};

export type FigmaScreenProposal = {
  fileKey: string;
  fileName?: string;
  pageId: string;
  pageName: string;
  nodeCount: number;
  devices: FigmaScreenDevice[];
  ignoredDevices: Array<{ device: string; width?: number; height?: number; examples: string[]; reason: string }>;
  screens: number;
  groups: number;
};

export type FigmaExtractionOptions = {
  target: string;
  scope: "node" | "current_page";
  question?: string;
  /** 현재 페이지 추출에서 확인 화면에서 고른 화면 크기. */
  screenDevices?: FigmaScreenDevice[];
  /** screenDevices를 찾은 페이지. 플러그인이 다른 페이지를 열고 있으면 추출을 거부한다. */
  screenPageId?: string;
};

export type SlackWebStatus = {
  connected: boolean;
  tokenType?: "user" | "bot";
  teamId?: string;
  teamName?: string;
  userId?: string;
  userName?: string;
};

export type SlackConnectionStatus = {
  connected: boolean;
  tools?: ToolDescriptor[];
  /** MCP OAuth와 별개로 붙이는 Web API 토큰 상태. */
  web?: SlackWebStatus;
  message?: string;
};

export type SlackExtractionOptions = {
  mode: "export" | "mcp" | "web";
  importId?: string;
  target?: string;
  oldest?: string;
  latest?: string;
  includeFiles: boolean;
};

export type SlackImportResult = {
  importId: string;
  filename: string;
  bytes: number;
  expiresAt: string;
};

export type FigmaRunPayload = {
  manifest: Record<string, unknown>;
  events: ExtractionEvent[];
};

export type FigmaQuestionAnswer = {
  answer: string;
  evidence: Array<{ kind: "node" | "version" | "artifact" | "tool"; nodeId?: string; versionId?: string; artifactId?: string; tool?: string; detail?: string }>;
  uncertainties: string[];
  model: string;
  promptVersion: string;
  generatedAt: string;
};

export type PluginPairing = { code: string; expiresAt: string };
