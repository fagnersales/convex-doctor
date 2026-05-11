import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { CallGraph, FunctionInfo } from "./types.ts";

/**
 * Render a self-contained HTML page visualising the call graph.
 * The page embeds the full vis-network UMD bundle so it works offline.
 *
 * @param graph     Built call graph (nodes, edges, dead list).
 * @param functions Original function records — used to enrich tooltips
 *                  with return-shape kind and validator status.
 * @param meta      Header info (project root, convex dir, generated date).
 */
export function reportHtml(
  graph: CallGraph,
  functions: FunctionInfo[],
  meta: { convexDir: string; projectRoot: string; generatedAt: string },
): string {
  const visBundle = loadVisNetworkBundle();
  const fnMeta = new Map<string, FunctionInfo>();
  for (const fn of functions) fnMeta.set(`${fn.filePath}:${fn.exportName}`, fn);

  const payload = {
    meta,
    nodes: graph.nodes.map((n) => ({
      ...n,
      dead: n.incoming === 0 && !n.ignored,
      ignored: n.ignored === true,
      hasReturns: fnMeta.get(`${n.filePath}:${n.exportName}`)?.returnsValidator != null,
    })),
    externals: graph.externals,
    edges: graph.edges,
    stats: {
      nodes: graph.nodes.length,
      edges: graph.edges.length,
      externals: graph.externals.length,
      dead: graph.dead.length,
      ignored: graph.nodes.filter((n) => n.ignored).length,
      scannedFiles: graph.scannedFiles,
    },
  };

  const payloadJson = JSON.stringify(payload).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>check-convex-validators — call graph</title>
<style>${CSS}</style>
</head>
<body>
<header>
  <div class="title">
    <h1>Convex call graph</h1>
    <div class="subtitle">${escapeHtml(meta.projectRoot)} · ${escapeHtml(meta.generatedAt)}</div>
  </div>
  <div class="stats" id="stats"></div>
</header>
<aside id="sidebar">
  <input id="search" placeholder="Filter by name…" />
  <div class="legend">
    <span class="dot k-query"></span>query
    <span class="dot k-mutation"></span>mutation
    <span class="dot k-action"></span>action
    <span class="dot k-internalQuery"></span>internalQuery
    <span class="dot k-internalMutation"></span>internalMutation
    <span class="dot k-internalAction"></span>internalAction
    <span class="dot k-external"></span>external
    <span class="dot k-dead"></span>dead (no callers)
  </div>
  <div class="toggle">
    <label><input type="checkbox" id="show-external" checked /> show external callers</label>
    <label><input type="checkbox" id="only-dead" /> only show dead</label>
  </div>
  <h2>Dead functions <span id="dead-count"></span> <button id="copy-dead" class="copy-btn" title="Copy list to clipboard">copy</button></h2>
  <ul id="dead-list"></ul>
  <h2>Selection</h2>
  <div id="detail" class="detail">Click a node…</div>
</aside>
<main>
  <div id="net"></div>
  <div id="diag">…</div>
</main>
<script>${visBundle}</script>
<script>
const DATA = ${payloadJson};
${CLIENT_JS}
</script>
</body>
</html>
`;
}

function loadVisNetworkBundle(): string {
  // Resolve relative to this package — works whether installed in the
  // user's node_modules or used directly via `bunx`.
  const require = createRequire(import.meta.url);
  const path = require.resolve("vis-network/standalone/umd/vis-network.min.js");
  return readFileSync(path, "utf8");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CSS = `
:root {
  color-scheme: dark;
  --bg: #0e0f13;
  --panel: #151820;
  --border: #262a36;
  --text: #d8dde6;
  --muted: #8a93a3;
  --accent: #6aa7ff;
  --dead: #ff5c7a;
  --query: #6aa7ff;
  --mutation: #f0b86b;
  --action: #c084fc;
  --iquery: #5fb2d1;
  --imutation: #d4a25f;
  --iaction: #a070d8;
  --external: #6a7280;
}
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body {
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  background: var(--bg); color: var(--text);
  display: grid; grid-template-columns: 320px 1fr;
  grid-template-rows: auto minmax(0, 1fr);
  grid-template-areas: "header header" "side main";
  overflow: hidden;
}
header {
  grid-area: header;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  display: flex; justify-content: space-between; align-items: center; gap: 16px;
  background: var(--panel);
}
header h1 { margin: 0; font-size: 16px; font-weight: 600; }
.subtitle { color: var(--muted); font-size: 11px; margin-top: 2px; }
.stats { display: flex; gap: 16px; font-size: 12px; }
.stats .pill { background: #1d2230; padding: 6px 12px; border-radius: 6px; }
.stats .pill strong { color: var(--accent); font-weight: 600; }
.stats .pill.dead strong { color: var(--dead); }
aside {
  grid-area: side; padding: 14px;
  border-right: 1px solid var(--border);
  background: var(--panel); overflow-y: auto;
}
aside h2 {
  margin: 16px 0 8px; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.08em; color: var(--muted);
}
#search {
  width: 100%; padding: 8px 10px;
  background: #0e1118; border: 1px solid var(--border);
  border-radius: 6px; color: var(--text); font: inherit;
}
#search:focus { outline: 1px solid var(--accent); }
.legend { font-size: 11px; color: var(--muted); margin: 10px 0 6px;
  display: flex; flex-wrap: wrap; gap: 6px 10px; align-items: center; }
.legend .dot {
  display: inline-block; width: 10px; height: 10px; border-radius: 50%;
  margin-right: 3px; vertical-align: middle;
}
.dot.k-query { background: var(--query); }
.dot.k-mutation { background: var(--mutation); }
.dot.k-action { background: var(--action); }
.dot.k-internalQuery { background: var(--iquery); }
.dot.k-internalMutation { background: var(--imutation); }
.dot.k-internalAction { background: var(--iaction); }
.dot.k-external { background: var(--external); }
.dot.k-dead { background: transparent; border: 2px solid var(--dead); }
.toggle { margin: 8px 0 0; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.copy-btn { background: #1d2230; color: var(--muted); border: 1px solid var(--border);
  border-radius: 4px; padding: 1px 6px; font: inherit; font-size: 10px; cursor: pointer;
  margin-left: 4px; text-transform: none; letter-spacing: 0; }
.copy-btn:hover { color: var(--text); border-color: var(--accent); }
.copy-btn.done { color: #5fd07a; border-color: #5fd07a; }
#dead-list { list-style: none; padding: 0; margin: 0; max-height: 200px; overflow-y: auto; }
#dead-list li { padding: 4px 6px; cursor: pointer; border-radius: 4px;
  font-family: ui-monospace, "SF Mono", monospace; font-size: 11px; color: var(--dead); }
#dead-list li:hover { background: #1d2230; }
.detail { background: #0e1118; border: 1px solid var(--border);
  border-radius: 6px; padding: 10px; font-size: 12px; min-height: 60px;
  font-family: ui-monospace, "SF Mono", monospace; }
.detail .label { color: var(--muted); font-family: system-ui; }
.detail a { color: var(--accent); text-decoration: none; }
main { grid-area: main; position: relative; min-height: 0; min-width: 0; }
#net { position: absolute; inset: 0; }
#diag { position: absolute; top: 8px; right: 8px; background: rgba(0,0,0,0.7);
        color: var(--muted); padding: 4px 8px; font-size: 11px; border-radius: 4px;
        font-family: ui-monospace, monospace; }
`;

const CLIENT_JS = `
const KIND_COLOR = {
  query: '#6aa7ff', mutation: '#f0b86b', action: '#c084fc',
  internalQuery: '#5fb2d1', internalMutation: '#d4a25f', internalAction: '#a070d8',
  external: '#6a7280',
};
const DEAD_COLOR = '#ff5c7a';

function renderStats() {
  const s = DATA.stats;
  document.getElementById('stats').innerHTML =
    \`<div class="pill"><strong>\${s.nodes}</strong> functions</div>\` +
    \`<div class="pill"><strong>\${s.edges}</strong> edges</div>\` +
    \`<div class="pill"><strong>\${s.externals}</strong> external callers</div>\` +
    \`<div class="pill dead"><strong>\${s.dead}</strong> dead</div>\` +
    (s.ignored ? \`<div class="pill"><strong>\${s.ignored}</strong> ignored</div>\` : '') +
    \`<div class="pill"><strong>\${s.scannedFiles}</strong> files scanned</div>\`;
}

function renderDead() {
  const dead = DATA.nodes.filter(n => n.dead);
  document.getElementById('dead-count').textContent = '(' + dead.length + ')';
  const ul = document.getElementById('dead-list');
  ul.innerHTML = '';
  for (const n of dead) {
    const li = document.createElement('li');
    li.textContent = n.id;
    li.title = n.filePath + ':' + n.line;
    li.onclick = () => focusNode(n.id);
    ul.appendChild(li);
  }
}

function nodeForVis(n) {
  const color = n.dead
    ? DEAD_COLOR
    : n.ignored
      ? '#4a505d'
      : (KIND_COLOR[n.kind] || '#888');
  const tag = n.dead ? '\\nDEAD' : (n.ignored ? '\\nignored' : '');
  return {
    id: n.id,
    label: n.exportName,
    title: \`\${n.id}\\n\${n.kind}\\n\${n.filePath}:\${n.line}\\nin: \${n.incoming}  out: \${n.outgoing}\${tag}\`,
    color: {
      background: n.dead ? '#2a1419' : '#1a1f2a',
      border: color,
      highlight: { background: '#2c3447', border: color },
    },
    borderWidth: n.dead ? 3 : 1.5,
    font: { color: n.ignored ? '#6a7280' : '#d8dde6', size: 13 },
    shape: 'dot',
    size: 10 + Math.min(20, (n.incoming + n.outgoing) * 1.2),
    _kind: n.kind,
    _meta: n,
  };
}
function extNodeForVis(e) {
  return {
    id: e.id,
    label: '⌂ ' + e.id.replace('external:', ''),
    title: e.id + '\\nout: ' + e.outgoing,
    color: { background: '#191c24', border: KIND_COLOR.external,
             highlight: { background: '#2c3447', border: KIND_COLOR.external } },
    borderWidth: 1, shape: 'box',
    font: { color: '#8a93a3', size: 11 },
    _kind: 'external',
    _meta: e,
  };
}

let network, nodesDS, edgesDS;
function build() {
  const showExternal = document.getElementById('show-external').checked;
  const onlyDead = document.getElementById('only-dead').checked;

  let nodes = DATA.nodes.filter(n => !onlyDead || n.dead).map(nodeForVis);
  let nodeIds = new Set(nodes.map(n => n.id));
  if (showExternal && !onlyDead) {
    for (const e of DATA.externals) {
      nodes.push(extNodeForVis(e));
      nodeIds.add(e.id);
    }
  }
  const edges = DATA.edges
    .filter(e => nodeIds.has(e.from) && nodeIds.has(e.to))
    .map((e, i) => ({
      id: 'e' + i, from: e.from, to: e.to,
      arrows: 'to',
      color: { color: '#3a4358', highlight: '#6aa7ff' },
      smooth: { type: 'continuous' },
      title: e.via + '\\n' + e.filePath + ':' + e.line,
      _meta: e,
    }));

  nodesDS = new vis.DataSet(nodes);
  edgesDS = new vis.DataSet(edges);
  const container = document.getElementById('net');
  const big = nodes.length > 400;
  network = new vis.Network(container, { nodes: nodesDS, edges: edgesDS }, {
    // improvedLayout uses a hierarchical pre-pass that is O(n^2)+ and stalls
    // large graphs; disable for anything but small fixtures.
    layout: { improvedLayout: !big },
    physics: {
      solver: 'forceAtlas2Based',
      forceAtlas2Based: {
        gravitationalConstant: big ? -180 : -60,
        centralGravity: 0.002,
        springLength: big ? 220 : 120,
        springConstant: 0.04,
        damping: 0.5,
        avoidOverlap: 1,
      },
      stabilization: { iterations: big ? 200 : 200, updateInterval: 20 },
    },
    interaction: { hover: true, tooltipDelay: 100, navigationButtons: false },
    nodes: {
      borderWidthSelected: 3,
      font: { color: '#d8dde6', size: 13, strokeWidth: 3, strokeColor: '#0e0f13' },
    },
    edges: { width: 0.6, selectionWidth: 2 },
  });
  const diag = document.getElementById('diag');
  const r = container.getBoundingClientRect();
  diag.textContent = \`vis=\${typeof vis} \${nodes.length}n/\${edges.length}e · stabilizing… (\${Math.round(r.width)}x\${Math.round(r.height)})\`;
  network.on('stabilizationProgress', p => {
    diag.textContent = \`stabilizing \${p.iterations}/\${p.total}…\`;
  });
  network.once('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } });
    network.fit({ animation: false });
    diag.textContent = \`\${nodes.length} nodes · idle\`;
  });
  network.on('selectNode', evt => {
    const id = evt.nodes[0];
    showDetail(id);
    focusNeighbors(id);
  });
  network.on('deselectNode', () => {
    document.getElementById('detail').textContent = 'Click a node…';
    clearFocus();
  });
  network.on('doubleClick', evt => {
    if (evt.nodes.length > 0) isolateNeighbors(evt.nodes[0]);
    else restoreAll();
  });
}

let isolatedId = null;
function isolateNeighbors(id) {
  if (!nodesDS || !edgesDS) return;
  isolatedId = id;
  const keep = new Set([id]);
  const keepEdges = new Set();
  edgesDS.forEach(e => {
    if (e.from === id || e.to === id) {
      keep.add(e.from); keep.add(e.to); keepEdges.add(e.id);
    }
  });
  // Hide non-neighbors AND drop them from physics so the subgraph relaxes
  // on its own springs instead of inheriting the cramped global layout.
  const nodeUpdates = [];
  nodesDS.forEach(n => {
    const visible = keep.has(n.id);
    nodeUpdates.push({ id: n.id, hidden: !visible, physics: visible });
  });
  const edgeUpdates = [];
  edgesDS.forEach(e => {
    const visible = keepEdges.has(e.id);
    edgeUpdates.push({ id: e.id, hidden: !visible, physics: visible });
  });
  nodesDS.update(nodeUpdates);
  edgesDS.update(edgeUpdates);

  network.setOptions({ physics: { enabled: true } });
  network.once('stabilizationIterationsDone', () => {
    network.setOptions({ physics: { enabled: false } });
    network.fit({ nodes: [...keep], animation: { duration: 350 } });
    document.getElementById('diag').textContent =
      \`isolated · \${keep.size} nodes · dbl-click background to exit\`;
  });
  network.stabilize(120);
}
function restoreAll() {
  if (!nodesDS || !edgesDS || isolatedId === null) return;
  isolatedId = null;
  const nodeUpdates = [];
  nodesDS.forEach(n => nodeUpdates.push({ id: n.id, hidden: false, physics: true }));
  const edgeUpdates = [];
  edgesDS.forEach(e => edgeUpdates.push({ id: e.id, hidden: false, physics: true }));
  nodesDS.update(nodeUpdates);
  edgesDS.update(edgeUpdates);
  network.setOptions({ physics: { enabled: false } });
  network.fit({ animation: { duration: 350 } });
  document.getElementById('diag').textContent = \`\${nodesDS.length} nodes · idle\`;
}

// Shared style objects — avoid allocating per-call to keep GC pressure low.
const EDGE_DIM   = Object.freeze({ color: '#3a4358', opacity: 0.05 });
const EDGE_HOT   = Object.freeze({ color: '#6aa7ff', highlight: '#6aa7ff', opacity: 1 });
const EDGE_RESET = Object.freeze({ color: '#3a4358', highlight: '#6aa7ff', opacity: 1 });

let focusedId = null;
function focusNeighbors(id) {
  if (!nodesDS || !edgesDS || focusedId === id) return;
  focusedId = id;
  const keep = new Set([id]);
  const keepEdges = new Set();
  edgesDS.forEach(e => {
    if (e.from === id || e.to === id) {
      keep.add(e.from); keep.add(e.to); keepEdges.add(e.id);
    }
  });

  // Batch all updates into one .update(array) call — avoids N redraw cycles.
  const nodeUpdates = [];
  nodesDS.forEach(n => {
    const keepIt = keep.has(n.id);
    nodeUpdates.push({
      id: n.id,
      opacity: keepIt ? 1 : 0.12,
      font: keepIt
        ? { color: n._meta && n._meta.ignored ? '#6a7280' : '#d8dde6', size: 13 }
        : { color: '#2a3041', size: 13 },
    });
  });
  const edgeUpdates = [];
  edgesDS.forEach(e => {
    edgeUpdates.push({ id: e.id, color: keepEdges.has(e.id) ? EDGE_HOT : EDGE_DIM });
  });
  nodesDS.update(nodeUpdates);
  edgesDS.update(edgeUpdates);
}
function clearFocus() {
  if (!nodesDS || !edgesDS || focusedId === null) return;
  focusedId = null;
  const nodeUpdates = [];
  nodesDS.forEach(n => nodeUpdates.push({
    id: n.id,
    opacity: 1,
    font: { color: n._meta && n._meta.ignored ? '#6a7280' : '#d8dde6', size: 13 },
  }));
  const edgeUpdates = [];
  edgesDS.forEach(e => edgeUpdates.push({ id: e.id, color: EDGE_RESET }));
  nodesDS.update(nodeUpdates);
  edgesDS.update(edgeUpdates);
}

function showDetail(id) {
  const n = DATA.nodes.find(x => x.id === id) ||
            DATA.externals.find(x => x.id === id);
  if (!n) return;
  const isExt = id.startsWith('external:');
  const incoming = DATA.edges.filter(e => e.to === id);
  const outgoing = DATA.edges.filter(e => e.from === id);
  const linkify = (e, dir) =>
    \`<div><span class="label">\${dir} via \${e.via}:</span> \${dir === 'in' ? e.from : e.to} <span class="label">@ \${e.filePath}:\${e.line}</span></div>\`;
  const html =
    \`<div><strong>\${n.id}</strong></div>\` +
    (isExt ? '' : \`<div class="label">\${n.kind}\${n.dead ? ' · <span style="color:var(--dead)">DEAD</span>' : ''}</div>\`) +
    (isExt ? '' : \`<div class="label">\${n.filePath}:\${n.line}</div>\`) +
    \`<div class="label" style="margin-top:8px">incoming (\${incoming.length})</div>\` +
    incoming.map(e => linkify(e, 'in')).join('') +
    \`<div class="label" style="margin-top:8px">outgoing (\${outgoing.length})</div>\` +
    outgoing.map(e => linkify(e, 'out')).join('');
  document.getElementById('detail').innerHTML = html;
}

function focusNode(id) {
  if (!network) return;
  network.selectNodes([id]);
  network.focus(id, { scale: 1.2, animation: { duration: 400 } });
  showDetail(id);
}

function applyFilter() {
  if (!nodesDS) return;
  const q = document.getElementById('search').value.trim().toLowerCase();
  nodesDS.forEach(n => {
    const hide = q.length > 0 && !n.id.toLowerCase().includes(q) &&
                                 !n.label.toLowerCase().includes(q);
    nodesDS.update({ id: n.id, hidden: hide });
  });
}

renderStats();
renderDead();
build();
document.getElementById('copy-dead').addEventListener('click', evt => {
  const btn = evt.currentTarget;
  const text = DATA.nodes.filter(n => n.dead).map(n => n.id).join('\\n');
  navigator.clipboard.writeText(text).then(() => {
    btn.classList.add('done');
    const orig = btn.textContent;
    btn.textContent = 'copied';
    setTimeout(() => { btn.classList.remove('done'); btn.textContent = orig; }, 1200);
  });
});
document.getElementById('search').addEventListener('input', applyFilter);
document.getElementById('show-external').addEventListener('change', () => { isolatedId = null; network.destroy(); build(); });
document.getElementById('only-dead').addEventListener('change', () => { isolatedId = null; network.destroy(); build(); });
document.addEventListener('keydown', evt => {
  if (evt.key === 'Escape' && isolatedId !== null) restoreAll();
});
`;
