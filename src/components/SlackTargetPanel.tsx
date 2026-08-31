import { useState } from "react";
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
    <section className="panel target-panel" aria-labelledby="slack-target-title">
      <div className="panel-heading">
        <span className="section-mark">S2</span>
        <div><p className="eyebrow">Slack source</p><h2 id="slack-target-title">가져올 대화</h2></div>
      </div>
      <div className="segmented-control" role="group" aria-label="Slack 추출 방식">
        <button type="button" className={options.mode === "export" ? "active" : ""} aria-pressed={options.mode === "export"} onClick={() => patch({ mode: "export" })}>공식 Export ZIP</button>
        <button type="button" className={options.mode === "mcp" ? "active" : ""} aria-pressed={options.mode === "mcp"} onClick={() => patch({ mode: "mcp" })}>Slack MCP</button>
      </div>
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
          <div className="two-fields">
            <label className="field compact"><span>시작 timestamp</span><input value={options.oldest ?? ""} onChange={(event) => patch({ oldest: event.target.value })} placeholder="선택 사항" /></label>
            <label className="field compact"><span>종료 timestamp</span><input value={options.latest ?? ""} onChange={(event) => patch({ latest: event.target.value })} placeholder="선택 사항" /></label>
          </div>
          <label className="toggle-row">
            <input type="checkbox" checked={options.includeFiles} onChange={(event) => patch({ includeFiles: event.target.checked })} />
            <span className="toggle-track" aria-hidden="true"><span /></span><span>접근 가능한 파일 metadata 확인</span>
          </label>
          {!connected ? <p className="run-blocker-note"><strong>Slack MCP OAuth가 필요합니다.</strong> 위 연결 단계에서 인증한 사용자가 볼 수 있는 대화만 조회합니다.</p> : null}
        </>
      )}
      <button className="primary-button full" type="button" disabled={!canRun || running || uploading} onClick={onRun}>
        {running ? "Slack 추출 중" : uploading ? "ZIP 검사 중" : options.mode === "export" ? "Export 대화 정규화" : "Slack MCP로 읽기"}
      </button>
    </section>
  );
}
