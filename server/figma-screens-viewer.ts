/**
 * 번들을 푼 폴더에서 더블클릭으로 여는 화면 뷰어. 서버·네트워크 없이 file://로 열려야 하므로
 * screens.json 내용을 페이지에 박아 넣고, 이미지는 번들 안 상대 경로로 읽는다.
 * 폴더의 PNG를 하나씩 여는 대신 "어느 기능 묶음의 어느 화면이고, 주석이 어디를 가리키는가"를 한 화면에서 본다.
 */
export function buildScreensViewer(index: unknown, title: string): string {
  // </script>가 데이터에 섞여 들어가 스크립트를 닫지 않게 한다.
  const data = JSON.stringify(index).replace(/</g, "\\u003c");
  const safeTitle = title.replace(/[<>&"]/g, "");
  return `<!doctype html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle} · 화면 뷰어</title>
<style>
:root { --bg: #f4f4f6; --panel: #fff; --ink: #171a22; --muted: #6b7080; --line: #e1e2e8; --accent: #6b4fd8; --accent-soft: #ece8fb; --warn: #b4540a; --box: rgba(107, 79, 216, .18); --box-line: #6b4fd8; }
@media (prefers-color-scheme: dark) { :root { --bg: #15161b; --panel: #1f2027; --ink: #eceef4; --muted: #9a9fb0; --line: #2e3039; --accent: #a18cf5; --accent-soft: #2c2743; --warn: #f0a560; --box: rgba(161, 140, 245, .22); --box-line: #a18cf5; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Apple SD Gothic Neo", "Noto Sans KR", sans-serif; }
header { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px 16px; align-items: center; padding: 12px 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
header h1 { margin: 0; font-size: 16px; }
header .stats { color: var(--muted); font-size: 12px; }
.controls { display: flex; flex-wrap: wrap; gap: 8px; margin-left: auto; }
.controls input, .controls select { font: inherit; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); }
.controls label { display: flex; gap: 6px; align-items: center; font-size: 13px; color: var(--muted); cursor: pointer; }
.tabs { display: flex; gap: 4px; }
.tabs button { font: inherit; padding: 6px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); cursor: pointer; }
.tabs button[aria-pressed="true"] { background: var(--accent); border-color: var(--accent); color: #fff; }
main { padding: 16px; }
.group-block { margin-bottom: 28px; }
.group-block h2 { margin: 0 0 4px; font-size: 14px; }
.group-block .path { margin: 0 0 10px; color: var(--muted); font-size: 12px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; }
.card { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); color: inherit; font: inherit; text-align: left; cursor: pointer; }
.card:hover, .card:focus-visible { border-color: var(--accent); outline: none; }
.card .thumb { height: 220px; display: flex; align-items: flex-start; justify-content: center; overflow: hidden; background: var(--bg); border-radius: 6px; }
.card img { max-width: 100%; }
.card b { font-size: 13px; overflow-wrap: anywhere; }
.card small { color: var(--muted); font-size: 11px; }
.badge { align-self: flex-start; padding: 1px 7px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); font-size: 11px; font-weight: 600; }
.empty { color: var(--muted); padding: 40px 0; text-align: center; }
dialog { width: min(1200px, 96vw); max-height: 94vh; padding: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--panel); color: var(--ink); }
dialog::backdrop { background: rgba(0, 0, 0, .55); }
.detail { display: grid; grid-template-columns: minmax(0, 1fr) 340px; max-height: 94vh; }
@media (max-width: 760px) { .detail { grid-template-columns: 1fr; } }
.stage { overflow: auto; padding: 16px; background: var(--bg); }
.frame { position: relative; display: inline-block; }
.frame img { display: block; max-width: 100%; height: auto; }
.mark { position: absolute; border: 2px solid var(--box-line); background: var(--box); border-radius: 3px; cursor: pointer; }
.mark span { position: absolute; top: -10px; left: -10px; min-width: 20px; height: 20px; padding: 0 5px; border-radius: 10px; background: var(--box-line); color: #fff; font-size: 11px; font-weight: 700; line-height: 20px; text-align: center; }
.mark.active { border-width: 3px; background: rgba(255, 170, 0, .25); border-color: var(--warn); }
.side { overflow: auto; padding: 16px; border-left: 1px solid var(--line); }
.side h3 { margin: 0 0 4px; font-size: 15px; overflow-wrap: anywhere; }
.side dl { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin: 8px 0 14px; font-size: 12px; }
.side dt { color: var(--muted); }
.side dd { margin: 0; overflow-wrap: anywhere; }
.note { margin: 0 0 8px; padding: 8px 10px; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.note.active { border-color: var(--warn); }
.note .cat { font-size: 11px; font-weight: 700; color: var(--accent); }
.note p { margin: 2px 0 0; white-space: pre-wrap; font-size: 13px; }
.note small { color: var(--muted); font-size: 11px; }
.close { float: right; font: inherit; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); padding: 4px 10px; cursor: pointer; }
.warn { color: var(--warn); font-size: 12px; }
a { color: var(--accent); }
</style>
</head>
<body>
<header>
  <h1>${safeTitle}</h1>
  <span class="stats" id="stats"></span>
  <div class="tabs" role="group" aria-label="보기">
    <button type="button" data-view="screens" aria-pressed="true">화면</button>
    <button type="button" data-view="groups" aria-pressed="false">기능 묶음</button>
  </div>
  <div class="controls">
    <input id="q" type="search" placeholder="화면·경로·주석 검색" aria-label="검색">
    <select id="device" aria-label="기기"></select>
    <label><input id="noted" type="checkbox"> 주석 있는 화면만</label>
  </div>
</header>
<main id="main"></main>
<dialog id="dialog"><div class="detail"><div class="stage" id="stage"></div><aside class="side" id="side"></aside></div></dialog>
<script id="data" type="application/json">${data}</script>
<script>
const index = JSON.parse(document.getElementById("data").textContent);
const screens = index.screens || [];
const groups = index.groups || [];
const annotations = index.annotations || [];
const groupById = new Map(groups.map((g) => [g.nodeId, g]));
const notesByScreen = new Map();
const notesByGroup = new Map();
const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
for (const a of annotations) {
  if (a.screenNodeId) push(notesByScreen, a.screenNodeId, a);
  else if (a.groupNodeId) push(notesByGroup, a.groupNodeId, a);
}
let view = "screens";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const text = (a) => a.label || a.labelMarkdown || "";

$("stats").textContent = "화면 " + screens.length + " · 기능 묶음 " + groups.length + " · 주석 " + annotations.length;
const devices = [...new Set(screens.map((s) => s.device))].sort();
$("device").innerHTML = '<option value="">모든 기기</option>' + devices.map((d) => '<option value="' + esc(d) + '">' + esc(d) + " (" + screens.filter((s) => s.device === d).length + ")</option>").join("");

function matches(s) {
  const q = $("q").value.trim().toLowerCase();
  if ($("device").value && s.device !== $("device").value) return false;
  if ($("noted").checked && !(notesByScreen.get(s.nodeId) || []).length) return false;
  if (!q) return true;
  const hay = [s.name, s.device, (s.path || []).join(" "), ...(notesByScreen.get(s.nodeId) || []).map(text)].join(" ").toLowerCase();
  return hay.includes(q);
}

function card(s) {
  const img = s.images && s.images.viewport;
  const n = (notesByScreen.get(s.nodeId) || []).length;
  return '<button class="card" type="button" data-screen="' + esc(s.nodeId) + '">' +
    '<div class="thumb">' + (img ? '<img loading="lazy" alt="" src="' + esc(img.path) + '">' : '<span class="warn">이미지 없음</span>') + "</div>" +
    "<b>" + esc(s.name) + "</b><small>" + esc(s.device) + " · " + s.size.width + " × " + s.size.height + "</small>" +
    (n ? '<span class="badge">주석 ' + n + "</span>" : "") + "</button>";
}

function render() {
  const main = $("main");
  if (view === "screens") {
    const shown = screens.filter(matches);
    const byGroup = new Map();
    for (const s of shown) push(byGroup, s.groupNodeId || "", s);
    main.innerHTML = shown.length ? [...byGroup].map(([gid, list]) => {
      const g = groupById.get(gid);
      return '<section class="group-block"><h2>' + esc(g ? g.name : "묶음 없음") + " · " + list.length + "개</h2>" +
        '<p class="path">' + esc(((g && g.path) || list[0].path || []).join(" › ")) + "</p>" +
        '<div class="grid">' + list.map(card).join("") + "</div></section>";
    }).join("") : '<p class="empty">조건에 맞는 화면이 없습니다.</p>';
  } else {
    const q = $("q").value.trim().toLowerCase();
    const shown = groups.filter((g) => !q || [g.name, (g.path || []).join(" ")].join(" ").toLowerCase().includes(q));
    main.innerHTML = shown.length ? '<div class="grid">' + shown.map((g) =>
      '<button class="card" type="button" data-group="' + esc(g.nodeId) + '"><div class="thumb">' +
      (g.image ? '<img loading="lazy" alt="" src="' + esc(g.image.path) + '">' : '<span class="warn">이미지 없음</span>') +
      "</div><b>" + esc(g.name) + "</b><small>화면 " + g.screens.length + "개 · " + g.size.width + " × " + g.size.height + "</small></button>").join("") + "</div>"
      : '<p class="empty">조건에 맞는 기능 묶음이 없습니다.</p>';
  }
}

// 이미지가 창 폭에 맞춰 줄어들므로, 픽셀 좌표(imageRect)를 표시 크기 비율로 바꿔 박스를 얹는다.
function overlay(imgEl, marks) {
  const frame = imgEl.parentElement;
  const place = () => {
    frame.querySelectorAll(".mark").forEach((m) => m.remove());
    const k = imgEl.clientWidth / imgEl.naturalWidth;
    marks.forEach((mark, i) => {
      if (!mark.rect) return;
      const m = document.createElement("div");
      m.className = "mark";
      m.dataset.i = String(i);
      m.style.cssText = "left:" + mark.rect.x * k + "px;top:" + mark.rect.y * k + "px;width:" + Math.max(6, mark.rect.width * k) + "px;height:" + Math.max(6, mark.rect.height * k) + "px";
      const tag = document.createElement("span");
      tag.textContent = String(i + 1);
      m.appendChild(tag);
      m.title = mark.title || "";
      m.onclick = mark.onclick;
      frame.appendChild(m);
    });
  };
  // 대화상자가 열리기 전에는 표시 폭이 0이다. 폭이 잡히거나 바뀔 때마다 다시 놓는다.
  if (window.__marks) window.__marks.disconnect();
  window.__marks = new ResizeObserver(() => { if (imgEl.clientWidth && imgEl.naturalWidth) place(); });
  window.__marks.observe(imgEl);
  imgEl.onload = () => { if (imgEl.clientWidth) place(); };
}

function activate(i) {
  document.querySelectorAll(".mark, .note").forEach((el) => el.classList.toggle("active", el.dataset.i === String(i)));
  const target = document.querySelector('.note[data-i="' + i + '"]');
  if (target) target.scrollIntoView({ block: "nearest" });
}

function show() { if (!$("dialog").open) $("dialog").showModal(); }

function openScreen(id) {
  const s = screens.find((x) => x.nodeId === id);
  if (!s) return;
  const img = s.images && s.images.viewport;
  const notes = notesByScreen.get(id) || [];
  const g = groupById.get(s.groupNodeId);
  $("stage").innerHTML = img ? '<div class="frame"><img alt="' + esc(s.name) + '" src="' + esc(img.path) + '"></div>' : '<p class="warn">' + esc(s.error || "이미지 없음") + "</p>";
  $("side").innerHTML = '<button class="close" type="button" data-close>닫기</button><h3>' + esc(s.name) + "</h3>" +
    "<dl><dt>기기</dt><dd>" + esc(s.device) + "</dd><dt>크기</dt><dd>" + s.size.width + " × " + s.size.height + (img ? " (이미지 " + img.scale + "배)" : "") + "</dd>" +
    "<dt>노드</dt><dd>" + esc(s.nodeId) + "</dd><dt>경로</dt><dd>" + esc((s.path || []).join(" › ") || "-") + "</dd>" +
    (g ? '<dt>기능 묶음</dt><dd><a href="#" data-open-group="' + esc(g.nodeId) + '">' + esc(g.name) + "</a></dd>" : "") +
    (img ? '<dt>이미지</dt><dd><a href="' + esc(img.path) + '" target="_blank">원본 열기</a></dd>' : "") + "</dl>" +
    "<b>주석 " + notes.length + "건</b>" + (notes.length ? "" : '<p class="note"><small>이 화면에 붙은 Figma 주석이 없습니다.</small></p>') +
    notes.map((a, i) => '<div class="note" data-i="' + i + '" data-activate="' + i + '"><span class="cat">' + (i + 1) + ". " + esc(a.category || "카테고리 없음") + "</span><p>" + esc(text(a)) + "</p><small>" + esc(a.nodeName) + " · " + esc(a.nodeType) + "</small></div>").join("");
  show();
  if (img) overlay($("stage").querySelector("img"), notes.map((a, i) => ({ rect: a.imageRect, title: text(a), onclick: () => activate(i) })));
}

function openGroup(id) {
  const g = groupById.get(id);
  if (!g) return;
  const notes = notesByGroup.get(id) || [];
  $("stage").innerHTML = g.image ? '<div class="frame"><img alt="' + esc(g.name) + '" src="' + esc(g.image.path) + '"></div>' : '<p class="warn">' + esc(g.error || "이미지 없음") + "</p>";
  $("side").innerHTML = '<button class="close" type="button" data-close>닫기</button><h3>' + esc(g.name) + "</h3>" +
    "<dl><dt>크기</dt><dd>" + g.size.width + " × " + g.size.height + (g.image ? " (이미지 " + (+g.image.scale).toFixed(2) + "배)" : "") + "</dd><dt>경로</dt><dd>" + esc((g.path || []).join(" › ") || "-") + "</dd></dl>" +
    "<b>화면 " + g.screens.length + "개</b>" +
    g.screens.map((r, i) => { const s = screens.find((x) => x.nodeId === r.nodeId); return '<div class="note" data-i="' + i + '" data-open-screen="' + esc(r.nodeId) + '"><span class="cat">' + (i + 1) + ". " + esc(s ? s.device : "") + "</span><p>" + esc(s ? s.name : r.nodeId) + "</p><small>눌러서 화면 열기</small></div>"; }).join("") +
    (notes.length ? "<b>묶음 주석 " + notes.length + "건</b>" + notes.map((a) => '<div class="note"><span class="cat">' + esc(a.category || "카테고리 없음") + "</span><p>" + esc(text(a)) + "</p></div>").join("") : "");
  show();
  if (g.image) overlay($("stage").querySelector("img"), g.screens.map((r) => ({ rect: r.imageRect, title: "화면 열기", onclick: () => openScreen(r.nodeId) })));
}

document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-screen],[data-group],[data-open-screen],[data-open-group],[data-activate],[data-close]");
  if (!el) return;
  if (el.dataset.close !== undefined) return $("dialog").close();
  e.preventDefault();
  if (el.dataset.screen) openScreen(el.dataset.screen);
  else if (el.dataset.group) openGroup(el.dataset.group);
  else if (el.dataset.openScreen) openScreen(el.dataset.openScreen);
  else if (el.dataset.openGroup) openGroup(el.dataset.openGroup);
  else if (el.dataset.activate) activate(el.dataset.activate);
});
document.querySelectorAll(".tabs button").forEach((b) => b.onclick = () => {
  view = b.dataset.view;
  document.querySelectorAll(".tabs button").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
  $("device").disabled = $("noted").disabled = view !== "screens";
  render();
});
["q", "device", "noted"].forEach((id) => $(id).addEventListener("input", render));
render();
</script>
</body>
</html>
`;
}
