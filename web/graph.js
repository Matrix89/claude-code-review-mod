'use strict'
// Dependency graph overlay: files as nodes, resolved imports as edges (from the server's tree-sitter pass).
// Force layout and SVG are hand-rolled; ≤ MAX_NODES nodes are drawn at a time.
const MAX_NODES = 600
const SVGNS = 'http://www.w3.org/2000/svg'
const svgEl = (tag, attrs = {}) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); return e }

let gData = null, gLoading = null
let g = null // the drawn graph: { nodes, edges, byPath, out, inn, sel, raf }
let gView = { x: 0, y: 0, k: 1 }

const groupOf = p => p.includes('/src/') ? p.slice(0, p.indexOf('/src/')) : p.split('/').slice(0, Math.min(2, p.split('/').length - 1)).join('/') || '.'
const hue = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h % 360 }
const baseName = p => p.slice(p.lastIndexOf('/') + 1)

function initGraph() {
  $('#graphbtn').onclick = () => toggleGraph()
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#graph').hidden) { e.preventDefault(); toggleGraph(false) }
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) toggleGraph()
  })
  $('#gscope').onchange = () => draw()
  $('#gsearch').oninput = () => g && applySearch()
  $('#gfit').onclick = () => g && fit()
}

// The overlay is a history entry: Back from the source it led to returns here, Esc/the button go back out
function setGraphShown(open) {
  $('#graph').hidden = !open
  $('#graphbtn').classList.toggle('on', open)
}
async function toggleGraph(open = $('#graph').hidden, fromHistory = false) {
  if (open === !$('#graph').hidden) return
  if (!open && !fromHistory && history.state?.graph) return history.back()
  if (open && !fromHistory) {
    history.replaceState({ ...history.state, y: $('#main').scrollTop }, '', location.href)
    history.pushState({ graph: true }, '', location.href)
  }
  setGraphShown(open)
  if (!open || g) return   // keep the layout and view when coming back
  if (gData) { draw(); return }
  $('#gstat').textContent = 'Parsing the repository with tree-sitter…'
  gLoading ??= rapi('graph').then(d => { gData = d }).catch(e => { gLoading = null; $('#gstat').textContent = 'Failed: ' + e.message })
  await gLoading
  if (gData && !$('#graph').hidden) draw()
}

// Which nodes to show: the changed files, plus everything within `hops` imports of them (either direction)
function pick(hops) {
  const adj = new Map()
  for (const e of gData.edges) {
    ;(adj.get(e.from) ?? adj.set(e.from, []).get(e.from)).push(e.to)
    ;(adj.get(e.to) ?? adj.set(e.to, []).get(e.to)).push(e.from)
  }
  const seen = new Set(gData.nodes.filter(n => n.changed).map(n => n.path))
  let frontier = [...seen]
  for (let h = 0; h < hops && frontier.length; h++) {
    const next = []
    for (const p of frontier) for (const q of adj.get(p) ?? []) if (!seen.has(q)) { seen.add(q); next.push(q) }
    frontier = next
  }
  return seen
}

function draw() {
  if (!gData) return
  cancelAnimationFrame(g?.raf)
  const scope = $('#gscope').value
  let keep = scope === 'all' ? new Set(gData.nodes.map(n => n.path)) : pick(+scope)
  if (!keep.size) keep = new Set(gData.nodes.map(n => n.path))
  let list = gData.nodes.filter(n => keep.has(n.path))
  const capped = list.length > MAX_NODES
  if (capped) list = list.sort((a, b) => b.changed - a.changed || b.lines - a.lines).slice(0, MAX_NODES)
  const byPath = new Map(list.map((n, i) => {
    const a = (i / list.length) * Math.PI * 2, r = 80 + Math.sqrt(list.length) * 40
    return [n.path, { ...n, group: groupOf(n.path), x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, r: 5 + Math.min(14, Math.sqrt(n.lines) / 3) }]
  }))
  const edges = gData.edges.filter(e => byPath.has(e.from) && byPath.has(e.to)).map(e => ({ ...e, a: byPath.get(e.from), b: byPath.get(e.to) }))
  const out = new Map(), inn = new Map()
  for (const e of edges) {
    ;(out.get(e.from) ?? out.set(e.from, []).get(e.from)).push(e)
    ;(inn.get(e.to) ?? inn.set(e.to, []).get(e.to)).push(e)
  }
  g = { nodes: [...byPath.values()], edges, byPath, out, inn, sel: null, raf: 0, alpha: 1, boxes: [] }
  buildBoxes()
  const groups = [...new Set(g.nodes.map(n => n.group))]
  const svg = $('#gsvg')
  svg.replaceChildren()
  const defs = svgEl('defs')
  defs.innerHTML = `<marker id="garrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker>`
  const vp = svgEl('g', { id: 'gvp' })
  const eg = svgEl('g', { class: 'ge' }), ng = svgEl('g', { class: 'gn' })
  const bg = svgEl('g', { class: 'gb' })
  for (const b of g.boxes) {
    b.rect = svgEl('rect', { rx: 10, class: 'gbox', style: `--h:${hue(b.top)}` })
    b.label = svgEl('text', { class: 'gboxl', style: `--h:${hue(b.top)}` }); b.label.textContent = b.label0 + '/'
    bg.append(b.rect, b.label)
  }
  vp.append(bg, eg, ng); svg.append(defs, vp)
  for (const e of edges) {
    e.el = svgEl('line', { 'marker-end': 'url(#garrow)', class: 'gedge ' + e.kind })
    e.hit = svgEl('line', { class: 'gehit' })   // a fat invisible line, so a 1px edge is easy to hover
    e.hit.addEventListener('mouseenter', ev => edgeTip(e, ev))
    e.hit.addEventListener('mousemove', moveTip)
    e.hit.addEventListener('mouseleave', hideTip)
    e.hit.__e = e
    eg.append(e.el, e.hit)
  }
  for (const n of g.nodes) {
    n.el = svgEl('g', { class: 'gnode' + (n.changed ? ' changed' : '') })
    const c = svgEl('circle', { r: n.r, fill: `hsl(${hue(n.group)} 55% ${n.changed ? 55 : 70}%)` })
    const t = svgEl('text', { y: n.r + 11 }); t.textContent = baseName(n.path)
    const ti = svgEl('title'); ti.textContent = n.path + (n.changed ? `  +${n.additions} −${n.deletions}` : '')
    n.el.append(c, t, ti); ng.append(n.el)
    n.el.__n = n
    n.el.addEventListener('mouseenter', () => { if (!g.sel) focus(n) })
    n.el.addEventListener('mouseleave', () => { if (!g.sel) focus(null) })
  }
  $('#glegend').innerHTML = groups.slice(0, 10).map(s => `<span><i style="background:hsl(${hue(s)} 55% 60%)"></i>${esc(s)}</span>`).join('') + (groups.length > 10 ? `<span class="dim">+${groups.length - 10} more</span>` : '')
  const nc = g.nodes.filter(n => n.changed).length
  $('#gstat').textContent = `${g.nodes.length} files (${nc} changed) · ${edges.length} imports · parsed ${gData.stats.files} files in ${gData.stats.ms} ms` +
    (capped ? ` · showing the ${MAX_NODES} biggest` : '') + (gData.stats.capped ? ' · repository truncated' : '')
  $('#gdetail').hidden = true
  gView = { x: 0, y: 0, k: 1 }
  applySearch()
  settle(260, true)
}

// Folder hulls: every folder holding a distinct set of the drawn files; a chain of folders with the same files is one hull
function buildBoxes() {
  const dirs = new Map()
  for (const n of g.nodes) {
    const parts = n.path.split('/').slice(0, -1)
    n.dir = parts.join('/'); n.boxes = []
    for (let i = 1; i <= parts.length; i++) {
      const d = parts.slice(0, i).join('/')
      ;(dirs.get(d) ?? dirs.set(d, []).get(d)).push(n)
    }
  }
  const kept = []
  for (const [d, nodes] of [...dirs].sort((a, b) => a[0].length - b[0].length)) {
    const parts = d.split('/')
    let parent = ''   // nearest ancestor that already has a hull
    for (let i = parts.length - 1; i >= 1; i--) { const a = parts.slice(0, i).join('/'); if (kept.some(k => k.dir === a)) { parent = a; break } }
    const pk = kept.find(k => k.dir === parent)
    if (pk && pk.nodes.length === nodes.length) { pk.dir = d; pk.label0 = d.slice(pk.base.length + 1) ; continue }   // same files: extend the hull's name
    kept.push({ dir: d, base: parent, nodes, label0: parent ? d.slice(parent.length + 1) : d, top: parts[0] })
  }
  // a hull spanning everything adds nothing
  g.boxes = kept.filter(b => b.nodes.length < g.nodes.length)
  // depth of nesting below each hull
  const depth = b => 1 + Math.max(-1, ...g.boxes.filter(c => c !== b && c.dir.startsWith(b.dir + '/')).map(depth))
  for (const b of g.boxes) b.height = Math.max(0, depth(b))
  for (const n of g.nodes) n.boxes = g.boxes.filter(b => b.nodes.includes(n))
}

// ---- layout -----------------------------------------------------------------------------
function step() {
  const { nodes, edges } = g, a = g.alpha
  for (const b of g.boxes) { b.cx = b.cy = 0; for (const n of b.nodes) { b.cx += n.x; b.cy += n.y } b.cx /= b.nodes.length; b.cy /= b.nodes.length }
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const q = nodes[j]
      let dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy
      if (d2 > 640_000) continue
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
      const d = Math.sqrt(d2), f = (7000 / d2) * a * (p.dir === q.dir ? 1 : 1.8), min = p.r + q.r + (p.dir === q.dir ? 40 : 70)
      const push = d < min ? (min - d) * 0.05 : 0
      p.vx += (dx / d) * (f + push); p.vy += (dy / d) * (f + push)
      q.vx -= (dx / d) * (f + push); q.vy -= (dy / d) * (f + push)
    }
  }
  for (const e of edges) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1
    const f = (d - (120 + e.a.r + e.b.r)) * 0.01 * a
    e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f; e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f
  }
  for (const n of nodes) {
    n.vx -= n.x * 0.002 * a; n.vy -= n.y * 0.002 * a
    for (const b of n.boxes) { n.vx += (b.cx - n.x) * 0.012 * a; n.vy += (b.cy - n.y) * 0.012 * a }
    n.vx *= 0.82; n.vy *= 0.82
    n.x += n.vx; n.y += n.vy
  }
  separate()
  g.alpha = Math.max(0.02, g.alpha * 0.985)
}

// Each hull's padded bounding box (the label strip is on top)
function boxRects() {
  for (const b of g.boxes) {
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9
    for (const n of b.nodes) { x0 = Math.min(x0, n.x - n.r); x1 = Math.max(x1, n.x + n.r); y0 = Math.min(y0, n.y - n.r); y1 = Math.max(y1, n.y + n.r + 12) }
    const pad = 20 + 16 * b.height
    b.x0 = x0 - pad; b.x1 = x1 + pad; b.y0 = y0 - pad - 14; b.y1 = y1 + pad
  }
}

// Hulls that are not nested must not overlap, and a file must not sit inside a hull it is not part of
function separate() {
  boxRects()
  const bs = g.boxes
  const move = (nodes, dx, dy) => { for (const n of nodes) { n.x += dx; n.y += dy } }
  for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
    const a = bs[i], b = bs[j]
    if (a.dir.startsWith(b.dir + '/') || b.dir.startsWith(a.dir + '/')) continue
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0)
    if (ox <= 0 || oy <= 0) continue
    const gap = 6
    if (ox < oy) { const d = ((ox + gap) / 2) * (a.x0 + a.x1 < b.x0 + b.x1 ? -1 : 1) * 0.6; move(a.nodes, d, 0); move(b.nodes, -d, 0) }
    else { const d = ((oy + gap) / 2) * (a.y0 + a.y1 < b.y0 + b.y1 ? -1 : 1) * 0.6; move(a.nodes, 0, d); move(b.nodes, 0, -d) }
  }
  for (const b of bs) for (const n of g.nodes) {
    if (n.boxes.includes(b) || n.x + n.r < b.x0 || n.x - n.r > b.x1 || n.y + n.r < b.y0 || n.y - n.r > b.y1) continue
    // push the stranger out through the nearest side
    const l = n.x - b.x0, rr = b.x1 - n.x, t = n.y - b.y0, bt = b.y1 - n.y, m = Math.min(l, rr, t, bt)
    if (m === l) n.x = b.x0 - n.r - 4; else if (m === rr) n.x = b.x1 + n.r + 4; else if (m === t) n.y = b.y0 - n.r - 4; else n.y = b.y1 + n.r + 4
  }
}

function place() {
  for (const e of g.edges) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1
    const x1 = e.a.x + (dx / d) * e.a.r, y1 = e.a.y + (dy / d) * e.a.r, x2 = e.b.x - (dx / d) * (e.b.r + 2), y2 = e.b.y - (dy / d) * (e.b.r + 2)
    for (const l of [e.el, e.hit]) { l.setAttribute('x1', x1); l.setAttribute('y1', y1); l.setAttribute('x2', x2); l.setAttribute('y2', y2) }
  }
  boxRects()
  for (const b of g.boxes) {
    b.rect.setAttribute('x', b.x0); b.rect.setAttribute('y', b.y0)
    b.rect.setAttribute('width', b.x1 - b.x0); b.rect.setAttribute('height', b.y1 - b.y0)
    b.label.setAttribute('x', b.x0 + 8); b.label.setAttribute('y', b.y0 + 17)
  }
  for (const n of g.nodes) n.el.setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`)
}

function settle(ticks = 260, refit = false) {
  cancelAnimationFrame(g.raf)
  const mine = g
  let left = ticks
  const loop = () => {
    if (g !== mine) return
    for (let i = 0; i < 3 && left > 0; i++, left--) step()
    place()
    if (refit && left === ticks - 3) fit()
    if (left > 0) mine.raf = requestAnimationFrame(loop); else if (refit) fit()
  }
  loop()
}

// ---- view ---------------------------------------------------------------------------------
function applyView() { $('#gsvg').classList.toggle('zoomed', gView.k >= 0.9); $('#gvp').setAttribute('transform', `translate(${gView.x} ${gView.y}) scale(${gView.k})`) }
function fit() {
  const box = $('#gsvg').getBoundingClientRect(), ns = g.nodes
  if (!ns.length) return
  const m = 24 + 16 * Math.max(0, ...g.boxes.map(b => b.height))
  const x0 = Math.min(...ns.map(n => n.x - n.r)) - m, x1 = Math.max(...ns.map(n => n.x + n.r + 30)) + m
  const y0 = Math.min(...ns.map(n => n.y - n.r)) - m - 14, y1 = Math.max(...ns.map(n => n.y + n.r + 16)) + m
  const k = Math.min(1.6, Math.min(box.width / (x1 - x0 || 1), box.height / (y1 - y0 || 1)) * 0.92)
  gView = { k, x: box.width / 2 - ((x0 + x1) / 2) * k, y: box.height / 2 - ((y0 + y1) / 2) * k }
  applyView()
}

function initGraphInput() {
  const svg = $('#gsvg')
  svg.addEventListener('wheel', e => {
    e.preventDefault()
    const r = svg.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top
    const k = Math.min(6, Math.max(0.1, gView.k * Math.exp(-e.deltaY * 0.0015)))
    gView.x = mx - ((mx - gView.x) / gView.k) * k; gView.y = my - ((my - gView.y) / gView.k) * k; gView.k = k
    applyView()
  }, { passive: false })
  svg.addEventListener('pointerdown', e => {
    const hit = e.target.closest('.gnode')?.__n, edge = e.target.closest('.gehit')?.__e
    const sx = e.clientX, sy = e.clientY, ox = gView.x, oy = gView.y
    let moved = false
    svg.setPointerCapture(e.pointerId)
    const move = ev => { moved ||= Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3; gView.x = ox + ev.clientX - sx; gView.y = oy + ev.clientY - sy; applyView() }
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); if (moved) return; if (edge) openEdge(edge); else select(hit ?? null) }
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up)
  })
}

// ---- edge tooltip: the import statement(s) behind an edge ---------------------------------------
const srcCache = new Map()
const srcLine = (path, n) => {
  const k = path + ':' + n
  if (!srcCache.has(k)) srcCache.set(k, rapi(`source?path=${encodeURIComponent(path)}&from=${n}&to=${n}`).then(r => r.lines?.[0]?.html ?? '').catch(() => ''))
  return srcCache.get(k)
}
let tipFor = null
async function edgeTip(e, ev) {
  tipFor = e
  e.el.classList.add('hot')
  const tip = $('#gtip')
  const lines = e.lines?.length ? e.lines : [e.line]
  const head = `<div class="gt1"><b>${esc(baseName(e.from))}</b> → <b>${esc(baseName(e.to))}</b> <span class="dim">${e.kind === 'mod' ? 'mod declaration' : e.kind}</span></div>` +
    (e.names.length ? `<div class="gtn">${e.names.map(n => `<code>${esc(n)}</code>`).join(' ')}</div>` : '')
  tip.innerHTML = head + lines.map(l => `<div class="gtl"><span class="dim">${esc(baseName(e.from))}:${l}</span><code>…</code></div>`).join('')
  tip.hidden = false
  moveTip(ev)
  const htmls = await Promise.all(lines.map(l => srcLine(e.from, l)))
  if (tipFor !== e) return
  tip.innerHTML = head + lines.map((l, i) => `<div class="gtl"><span class="dim">${esc(baseName(e.from))}:${l}</span><code>${htmls[i] || ''}</code></div>`).join('')
  moveTip(ev)
}
function moveTip(ev) {
  const tip = $('#gtip'), box = $('#graph').getBoundingClientRect()
  const x = Math.min(ev.clientX - box.left + 14, box.width - tip.offsetWidth - 8)
  const y = ev.clientY - box.top + 16
  tip.style.left = Math.max(8, x) + 'px'
  tip.style.top = (y + tip.offsetHeight > box.height ? ev.clientY - box.top - tip.offsetHeight - 10 : y) + 'px'
}
function hideTip() { tipFor?.el.classList.remove('hot'); tipFor = null; $('#gtip').hidden = true }

// Click an edge: scroll the diff to the import in the importing file
function openEdge(e) {
  const line = e.lines?.[0] ?? e.line
  hideTip()
  if (!fileSection(e.from)) return toast(`${e.from}:${line} is not part of this PR`)
  setGraphShown(false)
  if (!goTo(e.from, line, 0, 1e6, null, true)) {
    const sec = fileSection(e.from)
    sec.classList.remove('folded')
    navigate(() => sec.scrollIntoView(), null, null, null, true)
    toast(`${e.from}:${line} is outside the diff hunks`)
  }
}

// ---- highlight / search / detail --------------------------------------------------------------
function focus(n) {
  const near = new Set(n ? [n.path] : [])
  if (n) for (const e of [...(g.out.get(n.path) ?? []), ...(g.inn.get(n.path) ?? [])]) { near.add(e.from); near.add(e.to) }
  $('#gsvg').classList.toggle('focus', !!n)
  for (const m of g.nodes) m.el.classList.toggle('near', near.has(m.path))
  for (const e of g.edges) e.el.classList.toggle('near', !!n && (e.from === n.path || e.to === n.path))
}

function applySearch() {
  const q = $('#gsearch').value.trim().toLowerCase()
  for (const n of g.nodes) n.el.classList.toggle('hit', !!q && n.path.toLowerCase().includes(q))
  $('#gsvg').classList.toggle('searching', !!q)
}

function select(n) {
  g.sel = n
  focus(n)
  for (const m of g.nodes) m.el.classList.toggle('sel', m === n)
  const box = $('#gdetail')
  box.hidden = !n
  if (!n) return
  const link = (p, e) => `<a class="gl" data-p="${esc(p)}" title="${esc(e?.names.join(', ') ?? '')}">${esc(p)}</a>`
  const outs = g.out.get(n.path) ?? [], ins = g.inn.get(n.path) ?? []
  box.innerHTML = `<div class="gh"><b>${esc(n.path)}</b><button class="gx" title="Close">×</button></div>
    <div class="dim">${n.lines} lines · ${esc(n.lang)}${n.changed ? ` · <span class="st"><span class="a">+${n.additions}</span> <span class="d">−${n.deletions}</span></span>` : ' · not in this PR'}${n.external ? ` · ${n.external} external imports` : ''}</div>
    ${n.changed ? '<button class="primary gopen">Open in diff</button>' : ''}
    <details open><summary>Imports (${outs.length})</summary>${outs.map(e => link(e.to, e)).join('') || '<div class="dim">nothing inside the repository</div>'}</details>
    <details open><summary>Imported by (${ins.length})</summary>${ins.map(e => link(e.from, e)).join('') || '<div class="dim">nothing in the drawn files</div>'}</details>
    <details><summary>Definitions (${n.defs.length})</summary>${n.defs.map(d => `<div class="gd"><span class="dim">${esc(d.kind)}</span> ${esc(d.name)} <span class="dim">:${d.line}</span></div>`).join('')}</details>`
  box.querySelector('.gx').onclick = () => select(null)
  box.querySelector('.gopen')?.addEventListener('click', () => {
    const sec = fileSection(n.path)
    if (!sec) return
    setGraphShown(false)
    sec.classList.remove('folded')
    navigate(() => sec.scrollIntoView(), null, null, null, true)
  })
  box.onclick = e => {
    const a = e.target.closest('.gl'); if (!a) return
    const m = g.byPath.get(a.dataset.p)
    if (m) { select(m); const r = $('#gsvg').getBoundingClientRect(); gView.x = r.width / 2 - m.x * gView.k; gView.y = r.height / 2 - m.y * gView.k; applyView() }
  }
}

initGraphInput()
