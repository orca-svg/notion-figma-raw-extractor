import { useMemo, useState } from "react";
import type { SlackExtractionOptions, SlackImportResult } from "../types";

type Props = {
  options: SlackExtractionOptions;
  connected: boolean;
  running: boolean;
  onChange: (options: SlackExtractionOptions) => void;
  onUpload: (file: File) => Promise<SlackImportResult>;
  onRun: () => void;
};

export function SlackTargetPanel({ options, connected, running, onChange, onUpload, onRun }: Props) {
  // Slack의 oldest/latest는 Unix 초다. 사용자에게는 날짜와 시각으로 보이고,
  // 서버로 나갈 때만 초로 바꾼다. 화면에 초 단위 숫자를 드러내지 않는다.
  const pad = (value: number) => String(value).padStart(2, "0");
  const toLocalInput = (epoch?: string) => {
    const seconds = Number(epoch);
    if (!epoch || !Number.isFinite(seconds)) return "";
    const at = new Date(seconds * 1000);
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}`;
  };
  const toEpoch = (value: string) => {
    if (!value) return "";
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : "";
  };
  // 아직 오지 않은 시각은 고를 수 없게 한다.
  const latestSelectable = useMemo(() => toLocalInput(String(Math.floor(Date.now() / 1000))), []);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string>();
  const patch = (next: Partial<SlackExtractionOptions>) => onChange({ ...options, ...next });
  const handleFile = async (file?: File) => {
    if (!file) return;
    setUploading(true);
    setUploadError(undefined);
    try {
      const result = await onUpload(file);
      patch({ mode: "export", importId: result.importId });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  };
  const canRun = options.mode === "export" ? Boolean(options.importId) : connected && Boolean(options.target?.trim());
  return (
    <section className="panel target-panel slack-target" aria-labelledby="slack-target-title">
      <div className="panel-heading">
        <span className="section-mark">B</span>
        <div><p className="eyebrow">Slack source</p><h2 id="slack-target-title">가져올 대화</h2></div>
      </div>
      <div className="segmented-control" role="group" aria-label="Slack 추출 방식">
        <button type="button" className={options.mode === "web" ? "active" : ""} aria-pressed={options.mode === "web"} onClick={() => patch({ mode: "web" })}>채널 하나</button>
        <button type="button" className={options.mode === "export" ? "active" : ""} aria-pressed={options.mode === "export"} onClick={() => patch({ mode: "export" })}>공식 Export ZIP</button>
        <button type="button" disabled aria-disabled="true" title="이번 파일럿에서는 사용하지 않습니다">Slack MCP</button>
      </div>
      <p className="demo-note">Slack MCP는 조직이 mcp.slack.com 을 승인해야 해서 이번 파일럿에서는 열어 두지 않았습니다.</p>
      {options.mode === "export" ? (
        <>
          <label className="field">
            <span>Slack JSON Export ZIP</span>
            <input type="file" accept=".zip,application/zip" disabled={running || uploading} onChange={(event) => void handleFile(event.target.files?.[0])} />
            <small>원본 ZIP을 압축 해제하거나 내부 파일명을 바꾸지 말고 선택하세요. 최대 250MB입니다.</small>
          </label>
          {options.importId ? <div className="selection-well"><strong>ZIP 보안 검사 완료</strong><p>추출을 시작하면 원본 ZIP은 정규화 후 메모리에서 삭제됩니다.</p></div> : null}
          {uploadError ? <p className="run-blocker-note" role="alert">{uploadError}</p> : null}
          <p className="demo-note">일반 Slack JSON Export에는 실제 첨부 파일이 아니라 인증이 필요한 파일 링크만 들어갈 수 있습니다.</p>
        </>
      ) : (
        <>
          <label className="field">
            <span>채널 ID 또는 대화 URL</span>
            <textarea rows={3} value={options.target ?? ""} onChange={(event) => patch({ target: event.target.value })} placeholder="C0123456789 또는 https://workspace.slack.com/archives/…" />
          </label>
          {/* datetime-local은 캘린더 아이콘까지 들어가 2열에서는 서로 겹친다. 한 줄에 하나씩 둔다. */}
          <label className="field">
            <span>이때부터 (선택)</span>
            <input type="datetime-local" max={latestSelectable} value={toLocalInput(options.oldest)} onChange={(event) => patch({ oldest: toEpoch(event.target.value) })} />
          </label>
          <label className="field">
            <span>이때까지 (선택)</span>
            <input type="datetime-local" max={latestSelectable} value={toLocalInput(options.latest)} onChange={(event) => patch({ latest: toEpoch(event.target.value) })} />
          </label>
          <p className="demo-note">기간을 좁히고 싶을 때만 고르세요. 비워두면 채널 전체를 읽습니다.</p>
          <label className="toggle-row">
            <input type="checkbox" checked={options.includeFiles} onChange={(event) => patch({ includeFiles: event.target.checked })} />
            <span className="toggle-track" aria-hidden="true"><span /></span>
            <span>{options.mode === "web" ? "첨부 파일까지 내려받기" : "접근 가능한 파일 metadata 확인"}</span>
          </label>
          {options.mode === "web" && options.includeFiles
            ? <p className="demo-note">첨부 원본을 받으려면 토큰에 files:read 권한이 있어야 합니다. 없으면 링크와 metadata만 남습니다.</p>
            : null}
          {!connected ? (
            <p className="run-blocker-note">
              {options.mode === "web"
                ? <><strong>Slack 토큰이 필요합니다.</strong> 위 연결 단계에서 xoxp- 또는 xoxb- 토큰을 붙여넣어 주세요.</>
                : <><strong>Slack MCP OAuth가 필요합니다.</strong> 위 연결 단계에서 인증한 사용자가 볼 수 있는 대화만 조회합니다.</>}
            </p>
          ) : null}
          {options.mode === "web"
            ? <p className="demo-note">메시지와 스레드 답글을 끝까지 읽고 작성자 이름까지 채웁니다. 메시지가 많으면 몇 분 걸릴 수 있습니다.</p>
            : null}
        </>
      )}
      <button className="primary-button full" type="button" disabled={!canRun || running || uploading} onClick={onRun}>
        {running ? "Slack 추출 중" : uploading ? "ZIP 검사 중" : options.mode === "export" ? "Export 대화 정규화" : options.mode === "web" ? "채널 추출" : "Slack MCP로 읽기"}
      </button>
    </section>
  );
}
