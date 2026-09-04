import { startTransition, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import {
  connectPat,
  cancelCodexAuth,
  disconnect,
  disconnectFigmaRemote,
  disconnectFigmaRest,
  disconnectFigmaPlugin,
  getFigmaStatus,
  getStatus,
  startFigmaOAuth,
  connectFigmaRestPat,
  startPluginPairing,
  startCodexFigmaOAuth,
  startCodexLogin,
  startOAuth,
  streamExtraction,
  streamFigmaExtraction,
  streamFigmaQuestion,
  disconnectSlack,
  getSlackStatus,
  startSlackOAuth,
  streamSlackExtraction,
  streamSlackWebExtraction,
  connectSlackToken,
  disconnectSlackToken,
  streamSlackImport,
  uploadSlackExport,
} from "./api";
import figmaAppIcon from "./assets/figma-app-icon.svg";
import notionAppIcon from "./assets/notion-app-icon.svg";
import slackAppIcon from "./assets/slack-app-icon.svg";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { DataInspector } from "./components/DataInspector";
import { ExportActions } from "./components/ExportActions";
import { ExtractionTimeline } from "./components/ExtractionTimeline";
import { FigmaConnectionPanel } from "./components/FigmaConnectionPanel";
import { FigmaAnswerCard } from "./components/FigmaAnswerCard";
import { FigmaHistoryCard } from "./components/FigmaHistoryCard";
import { FigmaTargetPanel } from "./components/FigmaTargetPanel";
import { FigmaToolsGuide } from "./components/FigmaToolsGuide";
import { ReadPathStrip } from "./components/ReadPathStrip";
import { TargetPanel } from "./components/TargetPanel";
import { ToolsGuide } from "./components/ToolsGuide";
import { SlackConnectionPanel } from "./components/SlackConnectionPanel";
import { SlackTargetPanel } from "./components/SlackTargetPanel";
import { SlackToolsGuide } from "./components/SlackToolsGuide";
import type {
  AppView,
  ConnectionStatus,
  ExtractionEvent,
  ExtractionOptions,
  FigmaConnectionStatus,
  FigmaExtractionOptions,
  FigmaQuestionAnswer,
  FigmaTransport,
  Provider,
  SlackConnectionStatus,
  SlackExtractionOptions,
} from "./types";

const DEMO_TARGET = "11111111-1111-4111-8111-111111111111";
const INITIAL_NOTION_OPTIONS: ExtractionOptions = {
  target: "",
  expectedEmail: "",
  searchQuery: "오류",
  maxRows: 10,
  includeArchived: true,
  includeComments: true,
  includeTranscript: false,
  includeWorkspace: false,
  mode: "live",
};
const INITIAL_FIGMA_OPTIONS: FigmaExtractionOptions = {
  target: "",
  targetMode: "link",
  scope: "node",
  transport: "desktop",
  includeVariables: true,
  includeCodeConnect: true,
  includeMotion: true,
  includeLibraries: false,
  includeAssets: false,
  clientFrameworks: "unknown",
  clientLanguages: "unknown",
  codeConnectLabel: "",
  question: "",
  mode: "live",
};
const FIGMA_SESSION_KEY = "mcp-trace-studio:figma-options";
const INITIAL_SLACK_OPTIONS: SlackExtractionOptions = { mode: "web", includeFiles: false, target: "", oldest: "", latest: "" };

function initialFigmaOptions(): FigmaExtractionOptions {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(FIGMA_SESSION_KEY) ?? "null") as Partial<FigmaExtractionOptions> | null;
    const transport: FigmaTransport = saved?.transport === "remote" || saved?.transport === "codex" || saved?.transport === "plugin" ? saved.transport : "desktop";
    return {
      ...INITIAL_FIGMA_OPTIONS,
      ...saved,
      transport,
      // 페이지 추출은 Plugin 경로 전용이다. 다른 transport로 복원하면서 scope를 그대로 두면
      // 링크 입력란이 숨겨진 채 실행 버튼도 잠기는 막다른 상태가 된다.
      scope: transport === "plugin" && saved?.scope === "current_page" ? "current_page" : "node",
      targetMode: transport === "desktop" && saved?.targetMode === "selection" ? "selection" : "link",
      target: typeof saved?.target === "string" ? saved.target : "",
      mode: "live",
    };
  } catch {
    return INITIAL_FIGMA_OPTIONS;
  }
}

type Route = { provider: Provider; view: AppView };

function normalizeInitialPath(): string {
  if (window.location.pathname === "/") {
    window.history.replaceState({}, "", `/notion${window.location.search}`);
    return "/notion";
  }
  if (window.location.pathname === "/tools") {
    window.history.replaceState({}, "", `/notion/tools${window.location.search}`);
    return "/notion/tools";
  }
  return window.location.pathname;
}

function routeFromPath(path = window.location.pathname): Route {
  const parts = path.split("/").filter(Boolean);
  const provider: Provider = parts[0] === "figma" ? "figma" : parts[0] === "slack" ? "slack" : "notion";
  return { provider, view: parts[1] === "tools" ? "tools" : "trace" };
}

function pathFor(route: Route) {
  return `/${route.provider}${route.view === "tools" ? "/tools" : ""}`;
}

function upsertEvent(events: ExtractionEvent[], next: ExtractionEvent): ExtractionEvent[] {
  const index = events.findIndex((event) => event.id === next.id);
  if (index === -1) return [...events, next].sort((a, b) => a.order - b.order);
  const copy = [...events];
  copy[index] = next;
  return copy;
}

function latestComplete(events: ExtractionEvent[]) {
  for (let index = events.length - 1; index >= 0; index -= 1) if (events[index].type === "complete") return events[index];
  return undefined;
}

function latestFigmaAnswer(events: ExtractionEvent[]): FigmaQuestionAnswer | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.group !== "answer" || event.state !== "success" || !event.response || typeof event.response !== "object") continue;
    const response = event.response as Partial<FigmaQuestionAnswer>;
    if (typeof response.answer === "string" && Array.isArray(response.evidence) && Array.isArray(response.uncertainties)) return response as FigmaQuestionAnswer;
  }
  return undefined;
}

function FigmaStage({ options, status }: { options: FigmaExtractionOptions; status: FigmaConnectionStatus }) {
  const type = options.targetMode === "selection" ? "현재 선택 · 자동 감지" : /\/board\//.test(options.target) ? "FigJam" : /\/design\//.test(options.target) ? "Figma Design" : "노드 링크 대기";
  return (
    <section className="provider-stage figma-stage" aria-label="Figma 추출 대상 스테이지">
      <div className="provider-stage-inner">
        <div className="app-icon-showcase figma-app-showcase"><img src={figmaAppIcon} alt="Figma 앱 아이콘" /></div>
        <div className="canvas-preview" aria-hidden="true">
          <div className="preview-frame">
            <span className="preview-node one" />
            <span className="preview-node two" />
            <span className="preview-node three" />
            <div className="preview-caption">
              <b>{type}</b>
              <small>{status.connected ? `${options.transport} · ${status.tools?.length ?? 0} tools` : `${options.transport} 연결 대기`}</small>
            </div>
          </div>
          <div className="trace-layer layer-one">context</div><div className="trace-layer layer-two">variables</div><div className="trace-layer layer-three">raw</div>
        </div>
      </div>
    </section>
  );
}

function NotionStage() {
  return (
    <section className="provider-stage notion-stage">
      <div className="provider-stage-inner">
        <div className="app-icon-showcase notion-app-showcase"><img src={notionAppIcon} alt="Notion 앱 아이콘" /></div>
        <p>계정과 대상을 정하면 검색부터 행 본문과 댓글까지 MCP 호출이 순서대로 쌓입니다. 실패와 생략도 숨기지 않습니다.</p>
      </div>
    </section>
  );
}

function SlackStage({ mode }: { mode: SlackExtractionOptions["mode"] }) {
  return (
    <section className="provider-stage slack-stage">
      <div className="provider-stage-inner">
        <div className="app-icon-showcase slack-app-showcase"><img src={slackAppIcon} alt="Slack 앱 아이콘" /></div>
        <p>{mode === "export" ? "관리자가 전달한 Slack JSON Export ZIP을 사용자·대화·스레드·파일 참조로 정규화합니다." : "Slack MCP OAuth 사용자가 접근할 수 있는 채널과 스레드의 최신 정보를 읽습니다."}</p>
      </div>
    </section>
  );
}

export default function App() {
  const [route, setRoute] = useState<Route>(() => routeFromPath(normalizeInitialPath()));
  const reducedMotion = useReducedMotion();
  const [notionStatus, setNotionStatus] = useState<ConnectionStatus>({ connected: false });
  const [slackStatus, setSlackStatus] = useState<SlackConnectionStatus>({ connected: false });
  const [figmaStatuses, setFigmaStatuses] = useState<Record<FigmaTransport, FigmaConnectionStatus>>({
    desktop: { connected: false, transport: "desktop" },
    remote: { connected: false, transport: "remote", beta: true },
    codex: { connected: false, transport: "codex", beta: true },
    plugin: { connected: false, transport: "plugin", beta: true, plugin: { connected: false }, restOAuth: { connected: false } },
  });
  const [statusLoading, setStatusLoading] = useState(true);
  const [expectedEmail, setExpectedEmail] = useState("");
  const [notionOptions, setNotionOptions] = useState(INITIAL_NOTION_OPTIONS);
  const [figmaOptions, setFigmaOptions] = useState(initialFigmaOptions);
  const [slackOptions, setSlackOptions] = useState<SlackExtractionOptions>(INITIAL_SLACK_OPTIONS);
  const [notionEvents, setNotionEvents] = useState<ExtractionEvent[]>([]);
  const [figmaEvents, setFigmaEvents] = useState<ExtractionEvent[]>([]);
  const [slackEvents, setSlackEvents] = useState<ExtractionEvent[]>([]);
  const [notionSelectedId, setNotionSelectedId] = useState<string>();
  const [figmaSelectedId, setFigmaSelectedId] = useState<string>();
  const [slackSelectedId, setSlackSelectedId] = useState<string>();
  const [notionRunning, setNotionRunning] = useState(false);
  const [figmaRunning, setFigmaRunning] = useState(false);
  const [slackRunning, setSlackRunning] = useState(false);
  const [notionError, setNotionError] = useState<string>();
  const [figmaError, setFigmaError] = useState<string>();
  const [slackError, setSlackError] = useState<string>();
  const notionController = useRef<AbortController | undefined>(undefined);
  const figmaController = useRef<AbortController | undefined>(undefined);
  const slackController = useRef<AbortController | undefined>(undefined);

  const refreshNotion = useCallback(async () => {
    try {
      const next = await getStatus();
      setNotionStatus(next);
      if (next.expectedEmail) setExpectedEmail(next.expectedEmail);
    } catch (error) {
      setNotionStatus({ connected: false, message: error instanceof Error ? error.message : String(error) });
    }
  }, []);

  const refreshFigma = useCallback(async (transport: FigmaTransport) => {
    const next = await getFigmaStatus(transport);
    setFigmaStatuses((current) => ({ ...current, [transport]: next }));
  }, []);

  const refreshSlack = useCallback(async () => {
    try { setSlackStatus(await getSlackStatus()); }
    catch (error) { setSlackStatus({ connected: false, message: error instanceof Error ? error.message : String(error) }); }
  }, []);

  useEffect(() => {
    setStatusLoading(true);
    void Promise.all([refreshNotion(), refreshSlack(), refreshFigma("desktop"), refreshFigma("remote"), refreshFigma("codex"), refreshFigma("plugin")]).finally(() => setStatusLoading(false));
    const params = new URLSearchParams(window.location.search);
    if (params.get("restAuth") === "error") setFigmaError(params.get("reason") || "Figma 메타데이터 연결에 실패했습니다.");
    if (window.location.pathname.startsWith("/slack") && params.get("auth") === "error") setSlackError(params.get("reason") || "Slack OAuth 연결에 실패했습니다.");
    if (params.has("auth") || params.has("restAuth")) window.history.replaceState({}, "", window.location.pathname);
  }, [refreshFigma, refreshNotion, refreshSlack]);

  useEffect(() => {
    window.sessionStorage.setItem(FIGMA_SESSION_KEY, JSON.stringify({ ...figmaOptions, mode: "live" }));
  }, [figmaOptions]);

  useEffect(() => {
    if (figmaStatuses.codex.authFlow?.state !== "waiting") return;
    const timer = window.setInterval(() => void refreshFigma("codex"), 2_000);
    return () => window.clearInterval(timer);
  }, [figmaStatuses.codex.authFlow?.state, refreshFigma]);

  useEffect(() => {
    if (figmaOptions.transport !== "plugin") return;
    const timer = window.setInterval(() => void refreshFigma("plugin"), 2_000);
    return () => window.clearInterval(timer);
  }, [figmaOptions.transport, refreshFigma]);

  useEffect(() => {
    const onPopState = () => startTransition(() => setRoute(routeFromPath()));
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const notionSelected = useMemo(() => notionEvents.find((event) => event.id === notionSelectedId) ?? notionEvents.at(-1), [notionEvents, notionSelectedId]);
  const figmaSelected = useMemo(() => figmaEvents.find((event) => event.id === figmaSelectedId) ?? figmaEvents.at(-1), [figmaEvents, figmaSelectedId]);
  const slackSelected = useMemo(() => slackEvents.find((event) => event.id === slackSelectedId) ?? slackEvents.at(-1), [slackEvents, slackSelectedId]);
  const notionComplete = latestComplete(notionEvents);
  const figmaComplete = latestComplete(figmaEvents);
  const slackComplete = latestComplete(slackEvents);
  const figmaAnswer = latestFigmaAnswer(figmaEvents);

  const navigate = (next: Route) => (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    const path = pathFor(next);
    if (window.location.pathname !== path) window.history.pushState({}, "", path);
    startTransition(() => setRoute(next));
    window.scrollTo({ top: 0, behavior: reducedMotion ? "auto" : "smooth" });
  };

  const runNotion = async (mode: "live" | "demo") => {
    notionController.current?.abort();
    const controller = new AbortController();
    notionController.current = controller;
    setNotionEvents([]); setNotionSelectedId(undefined); setNotionError(undefined); setNotionRunning(true);
    try {
      await streamExtraction({ ...notionOptions, target: mode === "demo" ? DEMO_TARGET : notionOptions.target, expectedEmail: mode === "demo" ? "demo@notion.local" : expectedEmail, mode }, (event) => {
        setNotionEvents((current) => upsertEvent(current, event));
        setNotionSelectedId((current) => current ?? event.id);
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setNotionError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setNotionRunning(false);
    }
  };

  const runFigma = async (mode: "live" | "demo") => {
    figmaController.current?.abort();
    const controller = new AbortController();
    figmaController.current = controller;
    setFigmaEvents([]); setFigmaSelectedId(undefined); setFigmaError(undefined); setFigmaRunning(true);
    try {
      await streamFigmaExtraction({ ...figmaOptions, mode }, (event) => {
        setFigmaEvents((current) => upsertEvent(current, event));
        setFigmaSelectedId((current) => current ?? event.id);
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setFigmaError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) {
        setFigmaRunning(false);
        if (figmaOptions.transport === "codex") void refreshFigma("codex");
      }
    }
  };

  const askFigma = async (questionOverride?: string) => {
    figmaController.current?.abort();
    const controller = new AbortController();
    figmaController.current = controller;
    setFigmaEvents([]); setFigmaSelectedId(undefined); setFigmaError(undefined); setFigmaRunning(true);
    try {
      const question = questionOverride?.trim() || figmaOptions.question?.trim() || "";
      if (questionOverride) setFigmaOptions((current) => ({ ...current, question }));
      await streamFigmaQuestion({ ...figmaOptions, mode: "live", question }, (event) => {
        setFigmaEvents((current) => upsertEvent(current, event));
        setFigmaSelectedId((current) => current ?? event.id);
      }, controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) setFigmaError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) {
        setFigmaRunning(false);
        void refreshFigma(figmaOptions.transport);
      }
    }
  };

  const runSlack = async () => {
    slackController.current?.abort();
    const controller = new AbortController();
    slackController.current = controller;
    setSlackEvents([]); setSlackSelectedId(undefined); setSlackError(undefined); setSlackRunning(true);
    try {
      const stream = slackOptions.mode === "export"
        ? streamSlackImport(slackOptions.importId ?? "", (event) => {
            setSlackEvents((current) => upsertEvent(current, event));
            setSlackSelectedId((current) => current ?? event.id);
          }, controller.signal)
        : slackOptions.mode === "web"
          ? streamSlackWebExtraction(slackOptions, (event) => {
              setSlackEvents((current) => upsertEvent(current, event));
              setSlackSelectedId((current) => current ?? event.id);
            }, controller.signal)
          : streamSlackExtraction(slackOptions, (event) => {
              setSlackEvents((current) => upsertEvent(current, event));
              setSlackSelectedId((current) => current ?? event.id);
            }, controller.signal);
      await stream;
      if (slackOptions.mode === "export") setSlackOptions((current) => ({ ...current, importId: undefined }));
    } catch (error) {
      if (!controller.signal.aborted) setSlackError(error instanceof Error ? error.message : String(error));
    } finally {
      if (!controller.signal.aborted) setSlackRunning(false);
    }
  };

  const changeFigmaTransport = (transport: FigmaTransport) => {
    setFigmaOptions((current) => ({
      ...current,
      transport,
      scope: transport === "plugin" ? current.scope : "node",
      targetMode: transport !== "desktop" && current.targetMode === "selection" ? "link" : current.targetMode,
      includeLibraries: transport === "remote" || transport === "codex" ? current.includeLibraries : false,
      includeAssets: transport !== "desktop" ? current.includeAssets : false,
    }));
  };

  const activeFigmaStatus = figmaStatuses[figmaOptions.transport];
  const slackReady = slackOptions.mode === "export"
    ? true
    : slackOptions.mode === "web" ? slackStatus.web?.connected === true : slackStatus.connected;
  const activeConnected = route.provider === "notion" ? notionStatus.connected : route.provider === "slack" ? slackReady : activeFigmaStatus.connected;
  const connectionCopy = statusLoading
    ? "연결 확인 중"
    : route.provider === "slack"
      ? slackOptions.mode === "export"
        ? "로컬 ZIP 모드"
        : slackOptions.mode === "web"
          ? slackStatus.web?.connected ? `Slack 토큰 연결됨 (${slackStatus.web.teamName ?? slackStatus.web.teamId ?? "워크스페이스"})` : "Slack 토큰 연결 안 됨"
          : slackStatus.connected ? "Slack MCP 연결됨" : "Slack 연결 안 됨"
      : activeConnected
        ? route.provider === "notion" ? `${notionStatus.identity?.workspace?.name ?? "Notion"} 연결됨` : `${figmaOptions.transport === "desktop" ? "Desktop" : figmaOptions.transport === "remote" ? "Remote" : figmaOptions.transport === "plugin" ? "Plugin" : "Codex"} 준비됨`
        : "연결 안 됨";
  const motionProps = reducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 }, transition: { duration: 0.16 } }
    : { initial: { opacity: 0, x: route.provider === "figma" ? 18 : -18, filter: "blur(6px)" }, animate: { opacity: 1, x: 0, filter: "blur(0px)" }, exit: { opacity: 0, x: route.provider === "figma" ? -18 : 18, filter: "blur(5px)" }, transition: { type: "spring" as const, bounce: 0, duration: 0.38 } };

  return (
    <div className={`app-shell provider-${route.provider}`}>
      <header className="site-header">
        <a className="brand-lockup" href="/notion" onClick={navigate({ provider: "notion", view: "trace" })} aria-label="MCP Trace Studio 홈">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span><span><b>MCP Trace Studio</b><small>raw tool inspector</small></span>
        </a>
        <nav className="provider-shuttle" aria-label="추출 출처">
          <span className={`shuttle-indicator ${route.provider}`} aria-hidden="true" />
          {(["notion", "figma", "slack"] as const).map((provider) => <a key={provider} href={pathFor({ provider, view: route.view })} onClick={navigate({ provider, view: route.view })} aria-current={route.provider === provider ? "page" : undefined}>{provider === "notion" ? "Notion" : provider === "figma" ? "Figma" : "Slack"}</a>)}
        </nav>
        <div className="header-actions">
          <nav className="site-nav" aria-label="주요 메뉴">
            <a className={route.view === "trace" ? "active" : ""} href={pathFor({ provider: route.provider, view: "trace" })} onClick={navigate({ provider: route.provider, view: "trace" })} aria-current={route.view === "trace" ? "page" : undefined}>추출 검사</a>
            <a className={route.view === "tools" ? "active" : ""} href={pathFor({ provider: route.provider, view: "tools" })} onClick={navigate({ provider: route.provider, view: "tools" })} aria-current={route.view === "tools" ? "page" : undefined}>Tool 지도</a>
          </nav>
          <div className="header-state"><span className={`status-dot ${activeConnected ? "success" : "idle"}`} />{connectionCopy}</div>
        </div>
      </header>

      <AnimatePresence initial={false} mode="popLayout">
        <motion.div className="route-surface" key={`${route.provider}-${route.view}`} {...motionProps}>
          {route.view === "tools" ? (
            route.provider === "notion" ? <ToolsGuide status={notionStatus} /> : route.provider === "figma" ? <FigmaToolsGuide statuses={figmaStatuses} transport={figmaOptions.transport} onTransportChange={changeFigmaTransport} /> : <SlackToolsGuide status={slackStatus} />
          ) : route.provider === "notion" ? (
            <>
              <NotionStage />
              <ReadPathStrip />
              {notionComplete ? <section className={`completion-bar ${notionComplete.state}`}><div><span>마지막 실행</span><strong>{notionComplete.message}</strong></div><button type="button" onClick={() => setNotionSelectedId(notionComplete.id)}>결과 열기</button></section> : null}
              {notionError ? <div className="page-error" role="alert">{notionError}</div> : null}
              <main className="workspace">
                <aside className="setup-column"><ConnectionPanel status={notionStatus} expectedEmail={expectedEmail} onExpectedEmailChange={setExpectedEmail} onOAuth={async () => window.location.assign(await startOAuth(expectedEmail))} onPat={async (token) => setNotionStatus(await connectPat(expectedEmail, token))} onDisconnect={async () => { await disconnect(); setNotionStatus({ connected: false }); setNotionEvents([]); }} busy={notionRunning || statusLoading} /><TargetPanel options={notionOptions} onChange={setNotionOptions} onRun={(mode) => void runNotion(mode)} running={notionRunning} connected={notionStatus.connected} /></aside>
                <ExtractionTimeline events={notionEvents} selectedId={notionSelected?.id} onSelect={(event) => setNotionSelectedId(event.id)} running={notionRunning} provider="notion" footer={<ExportActions provider="notion" runId={notionComplete?.runId} />} />
                <DataInspector event={notionSelected} />
              </main>
            </>
          ) : route.provider === "figma" ? (
            <>
              <FigmaStage options={figmaOptions} status={activeFigmaStatus} />
              {figmaComplete ? <section className={`completion-bar figma-completion ${figmaComplete.state}`}><div><span>마지막 실행</span><strong>{figmaComplete.message}</strong></div><button type="button" onClick={() => setFigmaSelectedId(figmaComplete.id)}>결과 열기</button></section> : null}
              <FigmaAnswerCard answer={figmaAnswer} />
              <FigmaHistoryCard events={figmaEvents} />
              {figmaError ? <div className="page-error" role="alert">{figmaError}</div> : null}
              <main className="workspace figma-workspace">
                <aside className="setup-column"><FigmaConnectionPanel statuses={figmaStatuses} transport={figmaOptions.transport} onTransportChange={changeFigmaTransport} onRefresh={refreshFigma} onOAuth={async () => window.location.assign(await startFigmaOAuth())} onDisconnect={async () => { await disconnectFigmaRemote(); await refreshFigma("remote"); setFigmaEvents([]); }} onCodexLogin={startCodexLogin} onCodexFigmaOAuth={startCodexFigmaOAuth} onCodexCancel={cancelCodexAuth} onPluginPair={startPluginPairing} onPluginDisconnect={disconnectFigmaPlugin} onRestPat={connectFigmaRestPat} onRestDisconnect={disconnectFigmaRest} busy={figmaRunning || statusLoading} /><FigmaTargetPanel options={figmaOptions} onChange={setFigmaOptions} onRun={(mode) => void runFigma(mode)} onAsk={(question) => void askFigma(question)} running={figmaRunning} connected={activeFigmaStatus.connected} metadataConnected={figmaStatuses.plugin.restOAuth?.connected === true} /></aside>
                <ExtractionTimeline events={figmaEvents} selectedId={figmaSelected?.id} onSelect={(event) => setFigmaSelectedId(event.id)} running={figmaRunning} provider="figma" footer={<ExportActions provider="figma" runId={figmaComplete?.runId} />} />
                <DataInspector event={figmaSelected} />
              </main>
            </>
          ) : (
            <>
              <SlackStage mode={slackOptions.mode} />
              {slackComplete ? <section className={`completion-bar ${slackComplete.state}`}><div><span>마지막 실행</span><strong>{slackComplete.message}</strong></div><button type="button" onClick={() => setSlackSelectedId(slackComplete.id)}>결과 열기</button></section> : null}
              {slackError ? <div className="page-error" role="alert">{slackError}</div> : null}
              <main className="workspace">
                <aside className="setup-column">
                  <SlackConnectionPanel
                    status={slackStatus}
                    busy={slackRunning || statusLoading}
                    onOAuth={async () => window.location.assign(await startSlackOAuth())}
                    onDisconnect={async () => { await disconnectSlack(); setSlackStatus({ connected: false }); setSlackEvents([]); }}
                    onRefresh={refreshSlack}
                    onConnectToken={async (token) => {
                      const web = await connectSlackToken(token);
                      setSlackStatus((current) => ({ ...current, web }));
                      // 토큰을 붙였다면 그 경로로 뽑겠다는 뜻이다.
                      setSlackOptions((current) => (current.mode === "export" ? current : { ...current, mode: "web" }));
                    }}
                    onDisconnectToken={async () => {
                      await disconnectSlackToken();
                      setSlackStatus((current) => ({ ...current, web: { connected: false } }));
                    }}
                  />
                  <SlackTargetPanel options={slackOptions} connected={slackReady} running={slackRunning} onChange={setSlackOptions} onUpload={uploadSlackExport} onRun={() => void runSlack()} />
                </aside>
                <ExtractionTimeline events={slackEvents} selectedId={slackSelected?.id} onSelect={(event) => setSlackSelectedId(event.id)} running={slackRunning} provider="slack" footer={<ExportActions provider="slack" runId={slackComplete?.runId} />} />
                <DataInspector event={slackSelected} />
              </main>
            </>
          )}
        </motion.div>
      </AnimatePresence>

      <footer><p>인증 정보와 원시 응답은 영구 저장하지 않습니다. 실제 추출은 읽기 전용입니다.</p><div>{route.provider === "notion" ? <><a href="https://developers.notion.com/guides/mcp/build-mcp-client" target="_blank" rel="noreferrer">Notion MCP 연결</a><a href="https://developers.notion.com/guides/mcp/mcp-supported-tools" target="_blank" rel="noreferrer">지원 Tool</a></> : route.provider === "figma" ? <><a href="https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/" target="_blank" rel="noreferrer">Figma Tool</a><a href="https://developers.figma.com/docs/figma-mcp-server/local-server-installation/" target="_blank" rel="noreferrer">Desktop 설정</a></> : <><a href="https://docs.slack.dev/ai/slack-mcp-server" target="_blank" rel="noreferrer">Slack MCP</a><a href="https://slack.com/help/articles/201658943-Export-your-workspace-data" target="_blank" rel="noreferrer">Export 안내</a></>}</div></footer>
    </div>
  );
}
