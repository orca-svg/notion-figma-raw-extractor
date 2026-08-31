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

export type FigmaTransport = "desktop" | "remote" | "codex" | "plugin";

export type CodexAuthFlow = {
  kind: "codex" | "figma";
  state: "waiting" | "complete" | "error";
  authUrl?: string;
  userCode?: string;
  message?: string;
  startedAt: number;
};

export type FigmaConnectionStatus = {
  connected: boolean;
  transport: FigmaTransport;
  beta?: boolean;
  tools?: ToolDescriptor[];
  identity?: unknown;
  message?: string;
  codex?: { installed: boolean; version?: string; authenticated: boolean };
  figmaMcp?: { configured: boolean; enabled: boolean; authenticated: boolean; authStatus?: string; url?: string };
  authFlow?: CodexAuthFlow;
  plugin?: {
    connected: boolean;
    lastSeenAt?: string;
    meta?: { pluginVersion: string; editorType: "figma" | "figjam"; fileKey?: string; fileName?: string; pageName?: string; user?: { id?: string | null; name?: string } };
  };
  restOAuth?: { connected: boolean; userId?: string; message?: string; authKind?: "oauth" | "pat" };
};

export type FigmaExtractionOptions = {
  target: string;
  targetMode: "link" | "selection";
  scope: "node" | "current_page";
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

export type SlackConnectionStatus = {
  connected: boolean;
  tools?: ToolDescriptor[];
  message?: string;
};

export type SlackExtractionOptions = {
  mode: "export" | "mcp";
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
