import type { FigmaExtractionOptions, FigmaScreenDevice, FigmaScreenProposal } from "../types";

type Props = {
  options: FigmaExtractionOptions;
  onChange: (options: FigmaExtractionOptions) => void;
  onRun: () => void;
  onAsk: (questionOverride?: string) => void;
  running: boolean;
  connected: boolean;
  metadataConnected: boolean;
  /** 플러그인에 지금 열려 있는 페이지. 후보를 찾은 뒤 페이지를 바꾸면 후보가 맞지 않는다. */
  openPageId?: string;
  proposal?: FigmaScreenProposal;
  scanning: boolean;
  scanError?: string;
  selectedDevices: string[];
  onScan: () => void;
  onToggleDevice: (key: string) => void;
};

export function deviceKey(device: FigmaScreenDevice): string {
  return `${device.source}:${device.device}:${device.minWidth}-${device.maxWidth}:${device.minHeight}-${device.maxHeight ?? ""}`;
}

const SOURCE_LABEL: Record<FigmaScreenDevice["source"], { label: string; hint: string }> = {
  name: { label: "이름", hint: "이름에 기기 단어(Mobile·Desktop 등)가 붙은 프레임" },
  repeat: { label: "반복", hint: "이름은 없지만 화면 밖에서 3번 이상 반복된 프레임 크기" },
  default: { label: "추정", hint: "근거가 없어 쓴 모바일 기본 범위" },
};

const DEVICE_LABEL: Record<string, string> = { mobile: "모바일", fold: "폴드", tablet: "태블릿", desktop: "데스크톱" };

/** 크기는 어디서나 "폭 × 높이"로 쓴다. 길이가 열린 쪽은 "이상"으로 표시한다. */
function formatSize(width: string | number | undefined, height: string | number | undefined): string {
  return `${width ?? "?"} × ${height ?? "?"}`;
}

function sizeLabel(device: FigmaScreenDevice): string {
  if (device.width !== undefined && device.height !== undefined) return formatSize(device.width, device.height);
  const width = device.width ?? (device.minWidth === device.maxWidth ? device.minWidth : `${device.minWidth}~${device.maxWidth}`);
  return `${formatSize(width, device.minHeight)} 이상`;
}

const AUTO_NAME = /^(Frame|Group|Rectangle|Vector|Ellipse)\s+\d+$/;

/** 반복 크기는 기기 이름이 없으니 Figma가 자동으로 붙인 이름을 건너뛴 대표 프레임 이름을 쓴다. */
function representative(device: FigmaScreenDevice): string | undefined {
  return device.examples.find((name) => !AUTO_NAME.test(name.trim()));
}

/** 운영자가 크기 숫자가 아니라 "무슨 화면인지"로 고르게, 기기 이름이나 대표 프레임 이름을 앞세운다. */
function deviceTitle(device: FigmaScreenDevice): string {
  const kind = DEVICE_LABEL[device.device];
  if (device.source === "repeat") {
    const name = representative(device);
    return name ? `${name} 등 반복 프레임` : "이름 없이 반복된 프레임";
  }
  if (device.source === "default") return `${kind ?? "모바일"} 화면 (기본 범위)`;
  return `${kind ?? device.device} 화면`;
}

function detectedType(target: string) {
  if (/figma\.com\/design\//i.test(target)) return "Figma Design";
  if (/figma\.com\/board\//i.test(target)) return "FigJam";
  if (/figma\.com\/(?:slides|make)\//i.test(target)) return "지원하지 않는 유형";
  return "링크 입력 대기";
}

export function FigmaTargetPanel({ options, onChange, onRun, onAsk, running, connected, metadataConnected, openPageId, proposal, scanning, scanError, selectedDevices, onScan, onToggleDevice }: Props) {
  const patch = (next: Partial<FigmaExtractionOptions>) => onChange({ ...options, ...next });
  const ready = connected && metadataConnected;
  const stale = Boolean(proposal && openPageId && proposal.pageId !== openPageId);
  const chosen = proposal?.devices.filter((device) => selectedDevices.includes(deviceKey(device))) ?? [];
  const chosenScreens = chosen.reduce((sum, device) => sum + device.screens, 0);
  const canRun = ready && (options.scope === "current_page" ? Boolean(proposal) && !stale && chosen.length > 0 : Boolean(options.target));
  const canAsk = ready && Boolean(options.target) && Boolean(options.question?.trim());
  const canInterpret = ready && Boolean(options.target);
  const devices = [...(proposal?.devices ?? [])].sort((a, b) => (a.source === b.source ? b.screens - a.screens : a.source === "name" ? -1 : b.source === "name" ? 1 : 0));

  return (
    <section className="panel target-panel figma-target" aria-labelledby="figma-target-title">
      <div className="panel-heading">
        <span className="section-mark">B</span>
        <div><p className="eyebrow">Canvas target</p><h2 id="figma-target-title">읽을 범위</h2></div>
      </div>

      <div className="target-mode-row">
        <div className="segmented-control compact" role="group" aria-label="Figma 추출 범위">
          <button type="button" className={options.scope === "node" ? "active" : ""} aria-pressed={options.scope === "node"} onClick={() => patch({ scope: "node" })}>노드 추출</button>
          <button type="button" className={options.scope === "current_page" ? "active" : ""} aria-pressed={options.scope === "current_page"} onClick={() => patch({ scope: "current_page" })}>현재 페이지 추출</button>
        </div>
        <span className={`detected-chip ${options.scope === "node" && detectedType(options.target).includes("지원하지") ? "error" : ""}`}>{options.scope === "current_page" ? "열린 페이지 전체" : detectedType(options.target)}</span>
      </div>

      {options.scope === "current_page" ? (
        <div className="screen-review" aria-labelledby="screen-review-title">
          <div className="screen-review-head">
            <div>
              <strong id="screen-review-title">화면으로 볼 프레임 크기</strong>
              <p>추출 전에 어떤 크기의 프레임을 "화면"으로 찍을지 고릅니다. 위젯·팝업처럼 화면이 아닌 크기는 끄세요.</p>
            </div>
            <button className="secondary-button" type="button" onClick={onScan} disabled={!ready || scanning || running}>
              {scanning ? "후보 찾는 중" : proposal ? "후보 다시 찾기" : "화면 크기 후보 찾기"}
            </button>
          </div>

          {scanError ? <p className="inline-error" role="alert">{scanError}</p> : null}

          {proposal ? (
            <>
              <p className="screen-review-meta">
                <b>{proposal.pageName.trim()}</b> 페이지 · 노드 {proposal.nodeCount.toLocaleString()}개 · 기능 묶음 {proposal.groups}개
              </p>
              {stale ? <p className="run-blocker-note" role="status"><strong>Figma에서 다른 페이지를 열었습니다.</strong> 후보는 이전 페이지 기준이므로 다시 찾아 주세요.</p> : null}
              {devices.length === 0 ? <p className="screen-review-empty">화면으로 볼 크기를 찾지 못했습니다.</p> : (
                <ul className="screen-size-list">
                  {devices.map((device) => {
                    const key = deviceKey(device);
                    const checked = selectedDevices.includes(key);
                    return (
                      <li key={key} className={checked ? "on" : "off"}>
                        <label>
                          <input type="checkbox" checked={checked} onChange={() => onToggleDevice(key)} disabled={running} />
                          <span className={`source-badge ${device.source}`} title={SOURCE_LABEL[device.source].hint}>{SOURCE_LABEL[device.source].label}</span>
                          <span className="screen-size-main">
                            <span className="screen-size-title"><strong>{deviceTitle(device)}</strong><span className="screen-size-dim">{sizeLabel(device)}</span></span>
                            <small>{device.examples.length ? `예: ${device.examples.join(" · ")}` : SOURCE_LABEL[device.source].hint}</small>
                          </span>
                          <span className="screen-size-count">{device.screens}개</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              )}
              <p className="screen-review-total" role="status">
                {chosen.length > 0 ? <>선택한 {chosen.length}개 크기로 화면 약 <b>{chosenScreens}개</b>를 찍습니다.</> : "선택한 크기가 없습니다. 하나 이상 켜 주세요."}
              </p>
              {proposal.ignoredDevices.length > 0 ? (
                <details className="screen-review-ignored">
                  <summary>화면이 아니라고 본 크기 {proposal.ignoredDevices.length}개</summary>
                  <ul>
                    {proposal.ignoredDevices.map((device, index) => (
                      <li key={`${device.device}-${index}`}><b>{device.examples[0] ?? DEVICE_LABEL[device.device] ?? device.device}</b>{device.width ? <span className="screen-size-dim">{formatSize(device.width, device.height)}</span> : null} — {device.reason}</li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </>
          ) : (
            <p className="screen-review-empty">{ready ? "후보를 찾으면 크기별 개수와 예시 이름이 나옵니다. 이미지를 찍지 않아 빠릅니다." : "플러그인과 메타데이터를 연결하면 후보를 찾을 수 있습니다."}</p>
          )}
        </div>
      ) : (
        <>
          <label className="field">
            <span>프레임 또는 레이어 링크</span>
            <textarea value={options.target} onChange={(event) => patch({ target: event.target.value })} rows={3} spellCheck={false} placeholder="https://www.figma.com/design/…?node-id=1-2" />
            <small>file key와 node-id를 읽습니다. 파일 전체 링크는 실행하지 않습니다.</small>
          </label>
          <label className="field question-field">
            <span>이 노드에 대해 질문</span>
            <textarea value={options.question ?? ""} onChange={(event) => patch({ question: event.target.value })} rows={4} maxLength={4000} placeholder="예: 이 화면의 핵심 사용자 행동과 최근 변경 의도를 근거와 함께 설명해 줘" />
            <small>질문할 때마다 최신 노드와 이미지를 다시 추출합니다. 답은 로컬 Codex CLI가 만듭니다.</small>
          </label>
          {connected && !options.target ? (
            <p className="run-blocker-note" role="status"><strong>연결은 완료됐습니다.</strong> Figma에서 추출할 프레임이나 레이어를 선택해 링크를 복사한 뒤 위 입력란에 붙여넣으세요.</p>
          ) : null}
        </>
      )}

      {connected && !metadataConnected ? <p className="run-blocker-note" role="status"><strong>파일 메타데이터 연결이 필요합니다.</strong> 파일 생성자·댓글·버전 작성자를 빠짐없이 포함하기 위해 위 연결 단계에서 Figma 개인 액세스 토큰을 붙여넣으세요.</p> : null}

      <button className="primary-button figma-primary full" type="button" onClick={onRun} disabled={!canRun || running}>
        {running
          ? "추출 실행 중"
          : !connected
            ? "Figma 플러그인을 먼저 연결하세요"
            : !metadataConnected
              ? "파일 메타데이터 토큰을 연결하세요"
              : options.scope === "current_page"
                ? proposal ? `선택한 크기로 현재 페이지 ZIP 추출` : "먼저 화면 크기 후보를 찾으세요"
                : "Plugin으로 최신 노드 추출"}
      </button>
      {options.scope === "node" ? (
        <div className="question-actions">
          <button className="question-button" type="button" onClick={() => onAsk()} disabled={!canAsk || running}>{running ? "최신 근거 수집 중" : "최신 정보로 질문"}</button>
          <button className="meaning-button" type="button" onClick={() => onAsk("이 노드가 제품에서 담당하는 역할, 핵심 사용자 행동, 정보 구조와 의도를 근거와 불확실성을 구분해 해석해 줘.")} disabled={!canInterpret || running}>제품 의미 해석</button>
        </div>
      ) : null}
    </section>
  );
}
