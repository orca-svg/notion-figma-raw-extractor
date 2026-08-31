import type { FigmaExtractionOptions } from "../types";

type Props = {
  options: FigmaExtractionOptions;
  onChange: (options: FigmaExtractionOptions) => void;
  onRun: (mode: "live" | "demo") => void;
  onAsk: (questionOverride?: string) => void;
  running: boolean;
  connected: boolean;
  metadataConnected: boolean;
};

function Toggle({ checked, disabled, onChange, children }: { checked: boolean; disabled?: boolean; onChange: (value: boolean) => void; children: React.ReactNode }) {
  return (
    <label className={`toggle-row ${disabled ? "disabled" : ""}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
      <span className="toggle-track" aria-hidden="true"><span /></span><span>{children}</span>
    </label>
  );
}

function detectedType(target: string) {
  if (/figma\.com\/design\//i.test(target)) return "Figma Design";
  if (/figma\.com\/board\//i.test(target)) return "FigJam";
  if (/figma\.com\/(?:slides|make)\//i.test(target)) return "지원하지 않는 유형";
  return "링크 입력 대기";
}

export function FigmaTargetPanel({ options, onChange, onRun, onAsk, running, connected, metadataConnected }: Props) {
  const patch = (next: Partial<FigmaExtractionOptions>) => onChange({ ...options, ...next });
  const pluginReady = options.transport !== "plugin" || metadataConnected;
  const canRun = connected && pluginReady && (options.scope === "current_page" ? options.transport === "plugin" : options.targetMode === "selection" ? options.transport === "desktop" : Boolean(options.target));
  const canAsk = connected && pluginReady && Boolean(options.target) && Boolean(options.question?.trim()) && (options.transport === "codex" || options.transport === "plugin");
  const canInterpret = connected && pluginReady && Boolean(options.target) && (options.transport === "codex" || options.transport === "plugin");
  return (
    <section className="panel target-panel figma-target" aria-labelledby="figma-target-title">
      <div className="panel-heading">
        <span className="section-mark">B</span>
        <div><p className="eyebrow">Canvas target</p><h2 id="figma-target-title">읽을 노드</h2></div>
      </div>

      <div className="target-mode-row">
        <div className="segmented-control compact" role="group" aria-label="Figma 추출 범위">
          <button type="button" className={options.scope === "node" ? "active" : ""} aria-pressed={options.scope === "node"} onClick={() => patch({ scope: "node" })}>노드 추출</button>
          <button type="button" disabled={options.transport !== "plugin"} className={options.scope === "current_page" ? "active" : ""} aria-pressed={options.scope === "current_page"} onClick={() => patch({ scope: "current_page", targetMode: "link" })}>현재 페이지 추출</button>
        </div>
        <span className="detected-chip">{options.scope === "current_page" ? "열린 페이지 전체" : "선택한 노드"}</span>
      </div>

      {options.scope === "node" ? <div className="target-mode-row">
        <div className="segmented-control compact" role="group" aria-label="Figma 대상 지정 방식">
          <button type="button" className={options.targetMode === "link" ? "active" : ""} aria-pressed={options.targetMode === "link"} onClick={() => patch({ targetMode: "link" })}>노드 링크</button>
          <button type="button" disabled={options.transport !== "desktop"} className={options.targetMode === "selection" ? "active" : ""} aria-pressed={options.targetMode === "selection"} onClick={() => patch({ targetMode: "selection" })}>현재 선택</button>
        </div>
        <span className={`detected-chip ${detectedType(options.target).includes("지원하지") ? "error" : ""}`}>{options.targetMode === "selection" ? "자동 감지" : detectedType(options.target)}</span>
      </div> : null}

      {options.scope === "current_page" ? (
        <div className="selection-well"><span className="selection-crosshair" aria-hidden="true" /><strong>Figma에서 현재 열어 둔 페이지 전체를 사용합니다.</strong><p>최상위 프레임별 JSON과 PNG, 원본 이미지·SVG, 파일 댓글·작성자·버전 metadata를 하나의 ZIP으로 구성합니다.</p></div>
      ) : options.targetMode === "link" ? (
        <label className="field">
          <span>프레임 또는 레이어 링크</span>
          <textarea value={options.target} onChange={(event) => patch({ target: event.target.value })} rows={3} spellCheck={false} placeholder="https://www.figma.com/design/…?node-id=1-2" />
          <small>file key와 node-id를 읽습니다. 파일 전체 링크는 실행하지 않습니다.</small>
        </label>
      ) : (
        <div className="selection-well"><span className="selection-crosshair" aria-hidden="true" /><strong>Figma의 현재 선택을 사용합니다.</strong><p>실행 시 Design을 먼저 확인하고 파일 유형 오류일 때 FigJam으로 전환합니다.</p></div>
      )}

      {options.scope === "node" && (options.transport === "codex" || options.transport === "plugin") ? (
        <label className="field question-field">
          <span>이 노드에 대해 질문</span>
          <textarea value={options.question ?? ""} onChange={(event) => patch({ question: event.target.value })} rows={4} maxLength={4000} placeholder="예: 이 화면의 핵심 사용자 행동과 최근 변경 의도를 근거와 함께 설명해 줘" />
          <small>질문할 때마다 최신 노드와 이미지를 다시 추출합니다. 이전 질문의 대화 문맥은 이어지지 않습니다.</small>
        </label>
      ) : null}

      {options.scope === "node" ? <details className="advanced-options">
        <summary>고급 Tool 옵션</summary>
        <div className="two-fields">
          <label className="field compact"><span>Frameworks</span><input value={options.clientFrameworks} onChange={(event) => patch({ clientFrameworks: event.target.value })} placeholder="unknown" /></label>
          <label className="field compact"><span>Languages</span><input value={options.clientLanguages} onChange={(event) => patch({ clientLanguages: event.target.value })} placeholder="unknown" /></label>
        </div>
        <label className="field compact"><span>Code Connect label</span><input value={options.codeConnectLabel ?? ""} onChange={(event) => patch({ codeConnectLabel: event.target.value })} placeholder="예: React, SwiftUI" /></label>
        <div className="toggle-list">
          <Toggle checked={options.includeVariables} onChange={(value) => patch({ includeVariables: value })}>변수와 스타일</Toggle>
          <Toggle checked={options.includeCodeConnect} onChange={(value) => patch({ includeCodeConnect: value })}>Code Connect</Toggle>
          <Toggle checked={options.includeMotion} onChange={(value) => patch({ includeMotion: value })}>하위 모션</Toggle>
          <Toggle checked={options.includeLibraries} disabled={options.transport === "desktop" || options.transport === "plugin"} onChange={(value) => patch({ includeLibraries: value })}>Remote/Codex 라이브러리</Toggle>
          <Toggle checked={options.includeAssets} disabled={options.transport === "desktop"} onChange={(value) => patch({ includeAssets: value })}>Remote/Codex 다운로드 · Plugin export</Toggle>
        </div>
      </details> : null}

      {options.scope === "node" && connected && options.targetMode === "link" && !options.target ? (
        <p className="run-blocker-note" role="status"><strong>연결은 완료됐습니다.</strong> Figma에서 추출할 프레임이나 레이어를 선택해 링크를 복사한 뒤 위 입력란에 붙여넣으세요.</p>
      ) : null}

      {options.transport === "plugin" && !metadataConnected ? <p className="run-blocker-note" role="status"><strong>메타데이터 OAuth가 필요합니다.</strong> 파일 생성자·댓글·버전 작성자를 빠짐없이 포함하기 위해 위 연결 단계에서 OAuth를 완료하세요.</p> : null}

      <button className="primary-button figma-primary full" type="button" onClick={() => onRun("live")} disabled={!canRun || running}>
        {running ? "추출 실행 중" : connected && pluginReady ? options.scope === "current_page" ? "현재 페이지 전체를 ZIP으로 추출" : options.transport === "codex" ? "Codex를 통해 읽기" : options.transport === "plugin" ? "Plugin으로 최신 노드 추출" : "실제 Figma MCP로 읽기" : options.transport === "plugin" && !metadataConnected ? "메타데이터 OAuth를 연결하세요" : `${options.transport === "desktop" ? "Desktop" : options.transport === "remote" ? "Remote" : options.transport === "plugin" ? "Plugin" : "Codex"} 연결을 확인하세요`}
      </button>
      {options.scope === "node" && (options.transport === "codex" || options.transport === "plugin") ? <div className="question-actions"><button className="question-button" type="button" onClick={() => onAsk()} disabled={!canAsk || running}>{running ? "최신 근거 수집 중" : "최신 정보로 질문"}</button><button className="meaning-button" type="button" onClick={() => onAsk("이 노드가 제품에서 담당하는 역할, 핵심 사용자 행동, 정보 구조와 의도를 근거와 불확실성을 구분해 해석해 줘.")} disabled={!canInterpret || running}>제품 의미 해석</button></div> : null}
      <button className="demo-button figma-demo full" type="button" onClick={() => onRun("demo")} disabled={running}>Design 예제로 전체 여정 보기</button>
      <p className="demo-note">예제는 합성 Design 응답이며 FigJam 예제는 제공하지 않습니다.</p>
    </section>
  );
}
