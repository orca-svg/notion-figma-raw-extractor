import type { ReactNode } from "react";
import type { ExtractionEvent } from "../types";

const GROUP_NAMES: Record<string, string> = {
  connection: "연결",
  discovery: "도구",
  search: "검색",
  target: "대상",
  schema: "스키마",
  view: "뷰",
  sql: "SQL",
  page: "본문",
  comments: "댓글",
  summary: "완료",
  context: "컨텍스트",
  metadata: "구조",
  screenshot: "시각",
  variables: "변수",
  "code-connect": "코드 연결",
  motion: "모션",
  libraries: "라이브러리",
  assets: "자산",
  figjam: "FigJam",
};

function formatBytes(bytes?: number) {
  if (typeof bytes !== "number") return undefined;
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

type Props = {
  events: ExtractionEvent[];
  selectedId?: string;
  onSelect: (event: ExtractionEvent) => void;
  running: boolean;
  provider?: "notion" | "figma" | "slack";
  /** 마지막 단계 아래에 붙는 마무리 영역. 추출이 끝난 뒤 내보내기를 여기서 알아채게 한다. */
  footer?: ReactNode;
};

export function ExtractionTimeline({ events, selectedId, onSelect, running, provider = "notion", footer }: Props) {
  return (
    <section className="trace" aria-labelledby="trace-title" aria-live="polite">
      <div className="trace-heading">
        <div>
          <p className="eyebrow">실행 기록</p>
          <h2 id="trace-title">MCP Tool 호출 순서</h2>
        </div>
        <span className={`run-state ${running ? "active" : ""}`}><i />{running ? "실행 중" : events.length ? "실행 종료" : "대기"}</span>
      </div>
      {events.length === 0 ? (
        <div className="empty-trace">
          <span className="empty-signal" aria-hidden="true" />
          <p>{provider === "figma" ? "Figma 연결과 추출 범위를 정한 뒤 실행하세요." : provider === "slack" ? "Slack Export ZIP을 올리거나 MCP 대상을 정한 뒤 실행하세요." : "계정과 대상을 정한 뒤 실행하세요."}</p>
          <small>각 Tool의 입력, 원시 응답, 걸린 시간이 이 레이어를 따라 쌓입니다.</small>
        </div>
      ) : (
        <ol className="timeline">
          {events.map((event, position) => (
            <li key={event.id} className={`timeline-item ${event.state}`}>
              <button type="button" className={`event-card ${selectedId === event.id ? "selected" : ""}`} onClick={() => onSelect(event)}>
                {/* 중단 이벤트는 맨 뒤로 정렬하려고 order에 MAX_SAFE_INTEGER를 넣는다. 그대로 찍으면
                    9007199254740991이 단계 번호로 보인다. 화면 번호는 표시 순서로 매긴다. */}
                <span className="event-index">{String(position + 1).padStart(2, "0")}</span>
                <span className="event-copy">
                  <span className="event-meta"><b>{GROUP_NAMES[event.group] ?? event.group}</b>{event.tool ? <><code>{event.tool}</code>{event.origin === "codex" ? <em>Codex 중계</em> : null}</> : <em>내부 처리</em>}</span>
                  <strong>{event.label}</strong>
                  {event.message ? <small>{event.message}</small> : null}
                </span>
                <span className="event-result">
                  <span className={`state-label ${event.state}`}>{event.state === "running" ? "진행" : event.state === "success" ? "완료" : event.state === "warning" ? "확인" : event.state === "error" ? "오류" : "건너뜀"}</span>
                  {typeof event.elapsedMs === "number" ? <time>{event.elapsedMs}ms</time> : null}
                  {formatBytes(event.responseBytes) ? <small>{formatBytes(event.responseBytes)}</small> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {events.length > 0 && !running ? footer : null}
    </section>
  );
}
