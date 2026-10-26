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
  $('#graphbtn').onclick = toggleGraph
  addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('#graph').hidden) { e.preventDefault(); toggleGraph(false) }
    if (e.key === 'g' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName) && !document.activeElement?.isContentEditable) toggleGraph()
  })
  $('#gscope').onchange = () => draw()
  $('#gsearch').oninput = () => g && applySearch()
  $('#gfit').onclick = () => g && fit()
}

async function toggleGraph(open = $('#graph').hidden) {
  $('#graph').hidden = !open
  $('#graphbtn').classList.toggle('on', open)
  if (!open || gData) { if (open) draw(); return }
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
    const a = (i / list.length) * Math.PI * 2, r = 40 + Math.sqrt(list.length) * 14
    return [n.path, { ...n, group: groupOf(n.path), x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, r: 5 + Math.min(14, Math.sqrt(n.lines) / 3) }]
  }))
  const edges = gData.edges.filter(e => byPath.has(e.from) && byPath.has(e.to)).map(e => ({ ...e, a: byPath.get(e.from), b: byPath.get(e.to) }))
  const out = new Map(), inn = new Map()
  for (const e of edges) {
    ;(out.get(e.from) ?? out.set(e.from, []).get(e.from)).push(e)
    ;(inn.get(e.to) ?? inn.set(e.to, []).get(e.to)).push(e)
  }
  g = { nodes: [...byPath.values()], edges, byPath, out, inn, sel: null, raf: 0, alpha: 1 }
  const groups = [...new Set(g.nodes.map(n => n.group))]
  const svg = $('#gsvg')
  svg.replaceChildren()
  const defs = svgEl('defs')
  defs.innerHTML = `<marker id="garrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="context-stroke"/></marker>`
  const vp = svgEl('g', { id: 'gvp' })
  const eg = svgEl('g', { class: 'ge' }), ng = svgEl('g', { class: 'gn' })
  vp.append(eg, ng); svg.append(defs, vp)
  for (const e of edges) {
    e.el = svgEl('line', { 'marker-end': 'url(#garrow)', class: 'gedge ' + e.kind })
    const t = svgEl('title'); t.textContent = `${baseName(e.from)} → ${baseName(e.to)} (${e.kind}${e.names.length ? ': ' + e.names.join(', ') : ''})`
    e.el.append(t); eg.append(e.el)
  }
  for (const n of g.nodes) {
    n.el = svgEl('g', { class: 'gnode' + (n.changed ? ' changed' : '') })
    const c = svgEl('circle', { r: n.r, fill: `hsl(${hue(n.group)} 55% ${n.changed ? 55 : 70}%)` })
    const t = svgEl('text', { y: n.r + 11 }); t.textContent = baseName(n.path)
    const ti = svgEl('title'); ti.textContent = n.path + (n.changed ? `  +${n.additions} −${n.deletions}` : '')
    n.el.append(c, t, ti); ng.append(n.el)
    n.el.addEventListener('pointerdown', ev => dragNode(ev, n))
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
  settle()
}

// ---- layout -----------------------------------------------------------------------------
function step() {
  const { nodes, edges } = g, a = g.alpha
  const cent = new Map()
  for (const n of nodes) { const c = cent.get(n.group) ?? cent.set(n.group, { x: 0, y: 0, k: 0 }).get(n.group); c.x += n.x; c.y += n.y; c.k++ }
  for (let i = 0; i < nodes.length; i++) {
    const p = nodes[i]
    for (let j = i + 1; j < nodes.length; j++) {
      const q = nodes[j]
      let dx = p.x - q.x, dy = p.y - q.y, d2 = dx * dx + dy * dy
      if (d2 > 250_000) continue
      if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1 }
      const d = Math.sqrt(d2), f = (1800 / d2) * a, min = p.r + q.r + 14
      const push = d < min ? (min - d) * 0.05 : 0
      p.vx += (dx / d) * (f + push); p.vy += (dy / d) * (f + push)
      q.vx -= (dx / d) * (f + push); q.vy -= (dy / d) * (f + push)
    }
  }
  for (const e of edges) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1
    const f = (d - (60 + e.a.r + e.b.r)) * 0.012 * a
    e.a.vx += (dx / d) * f; e.a.vy += (dy / d) * f; e.b.vx -= (dx / d) * f; e.b.vy -= (dy / d) * f
  }
  for (const n of nodes) {
    const c = cent.get(n.group)
    n.vx += ((c.x / c.k) - n.x) * 0.01 * a - n.x * 0.002 * a
    n.vy += ((c.y / c.k) - n.y) * 0.01 * a - n.y * 0.002 * a
    if (n.fixed) { n.vx = n.vy = 0; continue }
    n.vx *= 0.82; n.vy *= 0.82
    n.x += n.vx; n.y += n.vy
  }
  g.alpha = Math.max(0.02, g.alpha * 0.985)
}

function place() {
  for (const e of g.edges) {
    const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 1
    e.el.setAttribute('x1', e.a.x + (dx / d) * e.a.r); e.el.setAttribute('y1', e.a.y + (dy / d) * e.a.r)
    e.el.setAttribute('x2', e.b.x - (dx / d) * (e.b.r + 2)); e.el.setAttribute('y2', e.b.y - (dy / d) * (e.b.r + 2))
  }
  for (const n of g.nodes) n.el.setAttribute('transform', `translate(${n.x.toFixed(1)} ${n.y.toFixed(1)})`)
}

function settle(ticks = 220) {
  cancelAnimationFrame(g.raf)
  const mine = g
  let left = ticks
  const loop = () => {
    if (g !== mine) return
    for (let i = 0; i < 3 && left > 0; i++, left--) step()
    place()
    if (left === ticks - 3) fit()
    if (left > 0) mine.raf = requestAnimationFrame(loop); else fit(true)
  }
  loop()
}

// ---- view ---------------------------------------------------------------------------------
function applyView() { $('#gvp').setAttribute('transform', `translate(${gView.x} ${gView.y}) scale(${gView.k})`) }
function fit(smooth) {
  const box = $('#gsvg').getBoundingClientRect(), ns = g.nodes
  if (!ns.length) return
  const x0 = Math.min(...ns.map(n => n.x - n.r)), x1 = Math.max(...ns.map(n => n.x + n.r + 30))
  const y0 = Math.min(...ns.map(n => n.y - n.r)), y1 = Math.max(...ns.map(n => n.y + n.r + 16))
  const k = Math.min(2, Math.min(box.width / (x1 - x0 || 1), box.height / (y1 - y0 || 1)) * 0.92)
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
    if (e.target.closest('.gnode')) return
    const sx = e.clientX, sy = e.clientY, ox = gView.x, oy = gView.y
    let moved = false
    svg.setPointerCapture(e.pointerId)
    const move = ev => { moved ||= Math.hypot(ev.clientX - sx, ev.clientY - sy) > 3; gView.x = ox + ev.clientX - sx; gView.y = oy + ev.clientY - sy; applyView() }
    const up = () => { svg.removeEventListener('pointermove', move); svg.removeEventListener('pointerup', up); if (!moved) select(null) }
    svg.addEventListener('pointermove', move); svg.addEventListener('pointerup', up)
  })
}

function dragNode(e, n) {
  e.stopPropagation()
  const sx = e.clientX, sy = e.clientY, ox = n.x, oy = n.y
  let moved = false
  const el = $('#gsvg')
  el.setPointerCapture(e.pointerId)
  const move = ev => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 4) return
    if (!moved) { moved = true; n.fixed = true; g.alpha = 0.3; settle(120) }
    n.x = ox + (ev.clientX - sx) / gView.k; n.y = oy + (ev.clientY - sy) / gView.k
  }
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up)
    n.fixed = false
    if (!moved) select(n)
  }
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up)
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
    toggleGraph(false)
    sec.classList.remove('folded')
    navigate(() => sec.scrollIntoView(), null, null, null)
  })
  box.onclick = e => {
    const a = e.target.closest('.gl'); if (!a) return
    const m = g.byPath.get(a.dataset.p)
    if (m) { select(m); const r = $('#gsvg').getBoundingClientRect(); gView.x = r.width / 2 - m.x * gView.k; gView.y = r.height / 2 - m.y * gView.k; applyView() }
  }
}

initGraphInput()
