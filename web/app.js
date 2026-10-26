'use strict'
const $ = s => document.querySelector(s)
const qs = new URLSearchParams(location.search)
const token = qs.get('t') || sessionStorage.getItem('token') || ''
sessionStorage.setItem('token', token)
history.scrollRestoration = 'manual'
let key = qs.get('key')
let S = null // review state
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'x-token': token, ...(opts.headers || {}) } })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || res.statusText)
  return data
}
const rapi = (p, o) => api(`/api/r/${encodeURIComponent(key)}/${p}`, o)
const post = (p, body, method = 'POST') => rapi(p, { method, body: JSON.stringify(body) })
// a language-server query about the symbol `w` ({ path, line, a })
const lsp = (kind, w) => rapi(`lsp?kind=${kind}&path=${encodeURIComponent(w.path)}&line=${w.line}&col=${w.a + 1}`)

let toastTimer
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2500)
}

// ---- markdown --------------------------------------------------------------
const EXT_LANG = { rs: 'rust', ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby', sh: 'bash', lua: 'lua', cs: 'csharp' }
const LANG_ALIAS = { rs: 'rust', ts: 'typescript', js: 'javascript', py: 'python', sh: 'bash', shell: 'bash', 'c++': 'cpp', golang: 'go', rust_analyzer: 'rust' }
let mdDefault = '' // fence language for unlabeled code blocks in the markdown being rendered

function highlightCode(text, lang) {
  lang = LANG_ALIAS[lang] || lang || mdDefault
  if (lang && window.hljs?.getLanguage(lang)) {
    try { return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value } catch {}
  }
  return esc(text)
}

marked.use({
  gfm: true,
  renderer: {
    html: tok => esc(tok.text),                  // raw HTML in docs is shown, never run
    image: tok => esc(tok.text || ''),
    link(tok) {
      const text = this.parser.parseInline(tok.tokens)
      return /^(https?:|#)/.test(tok.href) ? `<a href="${esc(tok.href)}" target="_blank" rel="noreferrer noopener">${text}</a>` : text
    },
    code(tok) {
      const lang = (tok.lang || '').split(/[\s,{]/)[0]
      if (lang === 'suggestion') return `<div class="sugg"><b>Suggested change</b><pre><code>${esc(tok.text)}</code></pre></div>`
      return `<pre><code class="hljs">${highlightCode(tok.text, lang)}</code></pre>`
    },
  },
})

// `lang`: the file's language, for fences with no label (what rust-analyzer, gopls etc. send is mostly labeled already)
function md(src, { lang = '', plain = false } = {}) {
  if (plain) return `<pre class="plain">${esc(src)}</pre>`
  mdDefault = lang
  try { return `<div class="md">${marked.parse(String(src))}</div>` } finally { mdDefault = '' }
}

// ---- boot ------------------------------------------------------------------
async function boot() {
  const msg = $('#bootmsg')
  try {
    if (!key) {
      msg.textContent = 'Resolving PR…'
      key = (await api('/api/open', { method: 'POST', body: JSON.stringify({ pr: qs.get('pr'), cwd: qs.get('cwd') }) })).key
      history.replaceState(null, '', `/?t=${token}&key=${encodeURIComponent(key)}`)
    }
    for (;;) {
      const st = await rapi('state')
      if (st.status === 'ready') { S = st; break }
      if (st.status === 'error') throw new Error(st.error)
      msg.textContent = st.stage
      await new Promise(r => setTimeout(r, 600))
    }
    document.title = `#${S.meta.number} ${S.meta.title}`
    ICONS = await fetch('/icons.json').then(r => r.json()).catch(() => null)
    $('#boot').remove(); $('#app').hidden = false
    init()
  } catch (e) {
    msg.textContent = 'Failed: ' + e.message
    $('.spin').style.display = 'none'
  }
}

let viewed = new Set()
let comments = []
let composer = null // { el, row, fi }
let anchor = null // last clicked gutter row

function init() {
  const m = S.meta
  comments = S.comments
  viewed = new Set(S.viewed || [])   // GitHub's per-file "Viewed" state is the source of truth
  $('#pr').innerHTML = `<h1>${esc(m.title)} <span class="dim">#${m.number}</span></h1>
    <div class="dim">${esc(m.repo)} · ${esc(m.author)} · <code>${esc(m.headRef)}</code> → <code>${esc(m.baseRef)}</code> ·
    <span class="st"><span class="a">+${m.additions}</span> <span class="d">−${m.deletions}</span></span> · ${S.files.length} files ·
    <a href="${esc(m.url)}" target="_blank" rel="noreferrer">GitHub</a> ·
    <a href="${esc(S.reviewUrl)}" target="_blank" rel="noreferrer">Submit review on GitHub</a></div>
    ${m.body ? `<details><summary>Description</summary><div class="body">${esc(m.body)}</div></details>` : ''}`

  renderTree()
  updateCounts()
  renderDiff()
  initNotes()
  initPanel()
  try { jumps = JSON.parse(localStorage.getItem('jumps:' + key) || '[]').slice(0, MAX_JUMPS) } catch {}
  renderPending()
  renderAsks()
  renderJumps()
  pollLsp()
  const es = new EventSource(`/api/r/${encodeURIComponent(key)}/events?t=${token}`)
  es.addEventListener('ask', e => {
    const a = JSON.parse(e.data)
    const i = S.asks.findIndex(x => x.id === a.id)
    if (i >= 0) S.asks[i] = a; else S.asks.push(a)
    placeChat(a); updateChat(a); renderAsks()
  })
}

// ---- file tree -------------------------------------------------------------
function setFolder(td, closed) {
  const h = td.querySelector(':scope > .tdh')
  td.classList.toggle('closed', closed)
  h.querySelector('.car').textContent = closed ? '▸' : '▾'
  h.querySelector('.fi').src = iconSrc(folderIcon(h.dataset.name, !closed))
}

function renderTree() {
  const root = { dirs: new Map(), files: [] }
  S.files.forEach((f, i) => {
    const parts = f.path.split('/'), name = parts.pop()
    let n = root
    for (const p of parts) {
      if (!n.dirs.has(p)) n.dirs.set(p, { dirs: new Map(), files: [] })
      n = n.dirs.get(p)
    }
    n.files.push({ f, i, name })
  })
  const sum = n => {
    let a = 0, d = 0
    for (const { f } of n.files) { a += f.additions; d += f.deletions }
    for (const c of n.dirs.values()) { const s = sum(c); a += s[0]; d += s[1] }
    return [a, d]
  }
  const stat = (a, d) => `<span class="st"><span class="a">+${a}</span> <span class="d">−${d}</span></span>`
  const fileRow = ({ f, i, name }) =>
    `<div class="ti ${f.status}${viewed.has(f.path) ? ' viewed' : ''}" data-i="${i}" title="${esc(f.path)}">
      ${img(fileIcon(f.path))}<span class="p">${esc(name)}</span><span class="cc"></span>${stat(f.additions, f.deletions)}</div>`
  const byName = (x, y) => x.name.localeCompare(y.name)
  const render = n => {
    let html = ''
    for (const [name, child] of [...n.dirs].sort((x, y) => x[0].localeCompare(y[0]))) {
      // a folder whose only item is one sub-folder folds into it ("firmware/crates"); a file in it stops the fold
      let label = name, c = child
      while (c.files.length === 0 && c.dirs.size === 1) { const [k, v] = [...c.dirs][0]; label += '/' + k; c = v }
      html += `<div class="td"><div class="tdh" data-name="${esc(label)}"><span class="car">▾</span>${img(folderIcon(label, true))}<span class="p">${esc(label)}/</span>${stat(...sum(c))}</div><div class="tdc">${render(c)}</div></div>`
    }
    for (const f of n.files.sort(byName)) html += fileRow(f)
    return html
  }
  $('#files').innerHTML = render(root)
  $('#files').onclick = e => {
    const h = e.target.closest('.tdh')
    if (h) {
      const td = h.parentElement
      const closing = !td.classList.contains('closed')
      setFolder(td, closing)
      if (closing) td.querySelectorAll('.td').forEach(d => setFolder(d, true))   // collapsing a branch closes everything inside it too
      return
    }
    const t = e.target.closest('.ti'); if (!t) return
    const sec = $('#f' + t.dataset.i)
    sec.classList.remove('folded')
    navigate(() => sec.scrollIntoView())
  }
  $('#filter').oninput = e => {
    const q = e.target.value.toLowerCase()
    document.querySelectorAll('.ti').forEach(t => (t.hidden = !S.files[t.dataset.i].path.toLowerCase().includes(q)))
    const dirs = [...document.querySelectorAll('.td')].reverse()
    for (const td of dirs) {
      td.hidden = !td.querySelector('.ti:not([hidden])')
      if (q) { td.classList.remove('closed'); const h = td.querySelector('.tdh'); h.querySelector('.car').textContent = '▾'; h.querySelector('.fi').src = iconSrc(folderIcon(h.dataset.name, true)) }
    }
  }
}

// ---- file-type icons (Material Icon Theme, served by the review server) --------------------
let ICONS = null
const iconSrc = name => `/icons/${name}.svg`
function fileIcon(path) {
  const base = path.split('/').pop().toLowerCase()
  if (!ICONS) return 'file'
  if (ICONS.fileNames[base]) return ICONS.fileNames[base]
  const parts = base.split('.')
  for (let i = 1; i < parts.length; i++) { const ext = parts.slice(i).join('.'); if (ICONS.fileExtensions[ext]) return ICONS.fileExtensions[ext] }
  return ICONS.file
}
function folderIcon(name, open) {
  const n = name.split('/').pop().toLowerCase()
  if (!ICONS) return 'folder'
  return (open ? ICONS.folderNamesExpanded[n] : ICONS.folderNames[n]) || (open ? ICONS.folderExpanded : ICONS.folder)
}
// popover section headers: icon + title, sticky while their section scrolls
const SEC_ICON = {
  def: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="2.3"/><path d="M8 1.2v3M8 11.8v3M1.2 8h3M11.8 8h3"/></svg>',
  decl: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"><path d="M8 2 14 5 8 8 2 5Z"/><path d="M2 8l6 3 6-3M2 11l6 3 6-3"/></svg>',
  ref: '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M6.6 9.4 9.4 6.6M5.2 11.2a2.6 2.6 0 0 1 0-3.7l1.3-1.3M10.8 4.8a2.6 2.6 0 0 1 0 3.7L9.5 9.8"/></svg>',
}
const sec = (kind, html) => `<div class="sec">${SEC_ICON[kind]}<span>${html}</span></div>`
const img = name => `<img class="fi" src="${iconSrc(name)}" width="16" height="16" alt="" draggable="false">`

// GitHub-style comment count per file in the tree (all review comments, pending ones included)
const COMMENT_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor"><path d="M1 2.75C1 1.784 1.784 1 2.75 1h10.5c.966 0 1.75.784 1.75 1.75v7.5A1.75 1.75 0 0 1 13.25 12H9.06l-2.573 2.573A1.458 1.458 0 0 1 4 13.543V12H2.75A1.75 1.75 0 0 1 1 10.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h2a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h4.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>'
function updateCounts() {
  const n = new Map()
  for (const c of comments) n.set(c.path, (n.get(c.path) || 0) + 1)
  document.querySelectorAll('.ti').forEach(t => {
    const k = n.get(S.files[t.dataset.i].path) || 0
    const cc = t.querySelector('.cc')
    cc.innerHTML = k ? `${COMMENT_ICON}<span>${k}</span>` : ''
    cc.title = k ? `${k} comment${k === 1 ? '' : 's'}` : ''
  })
}

// ---- diff ------------------------------------------------------------------
const BIG = 2500
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|poetry\.lock|.*\.min\.(js|css)|.*\.snap)$/

function renderDiff() {
  const host = $('#diff')
  host.innerHTML = S.files.map((f, i) => {
    const size = f.additions + f.deletions
    const est = Math.max(60, size * 19 + 80)
    return `<section class="file${viewed.has(f.path) ? ' folded' : ''}" id="f${i}" data-i="${i}">
      <header><button class="fold" title="Collapse">▾</button>${img(fileIcon(f.path))}<span class="name">${esc(f.oldPath ? f.oldPath + ' → ' : '')}${esc(f.path)}</span>
      <span class="st"><span class="a">+${f.additions}</span> <span class="d">−${f.deletions}</span></span>
      <label><input type="checkbox" class="vw"${viewed.has(f.path) ? ' checked' : ''}> Viewed</label></header>
      <div class="body" style="contain-intrinsic-size:auto ${est}px;min-height:${Math.min(est, 400)}px"><div class="note">Loading…</div></div></section>`
  }).join('')

  host.addEventListener('click', onDiffClick)
  host.addEventListener('change', async e => {
    if (!e.target.classList.contains('vw')) return
    const box = e.target, sec = box.closest('.file'), p = S.files[sec.dataset.i].path
    const apply = on => {
      box.checked = on
      sec.classList.toggle('folded', on)
      on ? viewed.add(p) : viewed.delete(p)
      document.querySelector(`.ti[data-i="${sec.dataset.i}"]`).classList.toggle('viewed', on)
    }
    const on = box.checked
    apply(on)   // optimistic; GitHub is told in the background
    try { await post('viewed', { path: p, viewed: on }) } catch (err) { apply(!on); toast('GitHub refused: ' + err.message) }
  })

  // load bodies in order, a few at a time
  let next = 0, done = 0
  const total = S.files.length
  const progress = () => ($('#progress').textContent = done < total ? `Rendering ${done}/${total}…` : `${total} files`)
  progress()
  const worker = async () => {
    while (next < total) {
      const i = next++
      const f = S.files[i], body = $(`#f${i} .body`)
      if (f.additions + f.deletions > BIG || GENERATED.test(f.path)) {
        body.innerHTML = `<div class="note">Large or generated file (${f.additions + f.deletions} changed lines). <button data-load="${i}">Load it</button></div>`
        body.style.minHeight = ''
      } else await loadFile(i)
      done++; progress()
    }
  }
  for (let k = 0; k < 3; k++) worker()

  const io = new IntersectionObserver(es => {
    for (const e of es) if (e.isIntersecting) {
      document.querySelectorAll('.ti.active').forEach(t => t.classList.remove('active'))
      const t = document.querySelector(`.ti[data-i="${e.target.dataset.i}"]`)
      t?.classList.add('active'); t?.scrollIntoView({ block: 'nearest' })
    }
  }, { root: $('#main'), rootMargin: '0px 0px -85% 0px' })
  document.querySelectorAll('.file').forEach(f => io.observe(f))
}

async function loadFile(i) {
  const body = $(`#f${i} .body`)
  try {
    const { html } = await rapi('file/' + i)
    body.innerHTML = html || '<div class="note">No textual changes</div>'
    body.style.minHeight = ''
    for (const c of comments) if (c.path === S.files[i].path) placeComment(c)
    for (const a of S.asks) if (a.path === S.files[i].path) placeChat(a)
  } catch (e) {
    body.innerHTML = `<div class="note">Failed: ${esc(e.message)}</div>`
  }
}

async function expandGap(gap, act) {
  const f = +gap.dataset.f, from = +gap.dataset.from, to = +gap.dataset.to, delta = +gap.dataset.delta
  let a = from, b = to, keep = null
  if (act === 'up') { b = Math.min(to, from + 19); keep = [b + 1, to] }
  if (act === 'down') { a = Math.max(from, to - 19); keep = [from, a - 1] }
  const { html } = await rapi(`lines?f=${f}&from=${a}&to=${b}&delta=${delta}`)
  const tpl = document.createElement('template'); tpl.innerHTML = html
  if (keep && keep[0] <= keep[1]) {
    gap.dataset.from = keep[0]; gap.dataset.to = keep[1]
    gap.querySelector('[data-act=all]').textContent = `Expand ${keep[1] - keep[0] + 1} lines`
    act === 'up' ? gap.before(tpl.content) : gap.after(tpl.content)
  } else { gap.replaceWith(tpl.content) }
  const path = S.files[f].path
  for (const c of comments) if (c.path === path) placeComment(c)
  for (const a of S.asks) if (a.path === path) placeChat(a)
}

function onDiffClick(e) {
  const t = e.target
  if (t.dataset.load) return loadFile(+t.dataset.load)
  if (t.classList.contains('fold')) return t.closest('.file').classList.toggle('folded')
  if (t.closest('.gap') && t.dataset.act) return expandGap(t.closest('.gap'), t.dataset.act)
  const row = t.closest('.r')
  if (!row || t.closest('.thread, .composer')) return
  const code = row.querySelector('code')
  const x = e.clientX - row.getBoundingClientRect().left
  if (x < code.offsetLeft) return e.shiftKey ? openComposer(row, anchor) : openComposer(row)
}
// drag across the line numbers to comment on a range
let dragFrom = null
const inGutter = (row, e) => e.clientX - row.getBoundingClientRect().left < row.querySelector('code').offsetLeft
$('#diff').addEventListener('mousedown', e => {
  const row = e.target.closest('.r')
  dragFrom = row && !e.target.closest('.thread, .composer') && inGutter(row, e) && e.button === 0 ? row : null
  if (dragFrom) { e.preventDefault(); dragRow = null; preview(dragFrom); document.body.classList.add('dragging') }
})
let dragRow = null, dragRaf = 0, dragY = 0
const preview = row => {
  if (row === dragRow) return
  dragRow = row
  document.querySelectorAll('.r.drag').forEach(r => r.classList.remove('drag'))
  if (row) rangeRows(row, dragFrom).forEach(r => r.classList.add('drag'))
}
addEventListener('mousemove', e => {
  if (!dragFrom) return
  dragY = e.clientY
  cancelAnimationFrame(dragRaf)
  dragRaf = requestAnimationFrame(() => {
    const main = $('#main'), box = main.getBoundingClientRect()
    if (dragY < box.top + 40) main.scrollBy(0, -20)
    else if (dragY > box.bottom - 40) main.scrollBy(0, 20)
    const el = document.elementFromPoint(e.clientX, Math.min(Math.max(dragY, box.top + 1), box.bottom - 1))
    const row = el?.closest('.r')
    if (row) preview(row)
    if (dragFrom && (dragY < box.top + 40 || dragY > box.bottom - 40)) dragRaf = requestAnimationFrame(() => dispatchEvent(new MouseEvent('mousemove', { clientX: e.clientX, clientY: dragY })))
  })
})
addEventListener('mouseup', e => {
  document.querySelectorAll('.r.drag').forEach(r => r.classList.remove('drag')); dragRow = null; document.body.classList.remove('dragging')
  const from = dragFrom; dragFrom = null
  const row = from && document.elementFromPoint(e.clientX, e.clientY)?.closest('.r')
  if (row && row !== from && inGutter(row, e)) { anchor = from; openComposer(row, from); suppressClick = true }
})
let suppressClick = false
addEventListener('click', e => { if (suppressClick) { e.stopPropagation(); suppressClick = false } }, true)
addEventListener('keydown', e => { if (e.key === 'Escape') closeComposer() })

// ---- history: back/forward (mouse buttons, Alt+←/→) walk through jumps ----------
function flashRow(row) {
  row.classList.add('flash'); setTimeout(() => row.classList.remove('flash'), 1500)
}

// Highlights columns [c0, c1) of a line via the CSS Custom Highlight API (no DOM changes); falls back to flashing the row.
function rangeIn(code, c0, c1) {
  const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  const range = new Range()
  let pos = 0, t, started = false
  while ((t = w.nextNode())) {
    if (!started && c0 < pos + t.length) { range.setStart(t, c0 - pos); started = true }
    if (started && c1 <= pos + t.length) { range.setEnd(t, c1 - pos); return range }
    pos += t.length
  }
  return null
}

// Highlights every usage the language server found for the hovered symbol, in all rendered files
function markUsages(locs) {
  if (!window.Highlight || !CSS.highlights) return
  const byPath = new Map()
  for (const l of locs) (byPath.get(l.path) ?? byPath.set(l.path, []).get(l.path)).push(l)
  const ranges = []
  for (const sec of document.querySelectorAll('.file')) {
    const ls = byPath.get(S.files[sec.dataset.i].path)
    if (!ls) continue
    const rows = new Map()
    for (const r of sec.querySelectorAll('.r[data-n]')) if (r.dataset.n) rows.set(+r.dataset.n, r)
    for (const l of ls) {
      const row = rows.get(l.line)
      const range = row && rangeIn(row.querySelector('code'), l.col - 1, (l.endLine === l.line ? l.endCol : l.col + 1) - 1)
      if (range) ranges.push(range)
    }
  }
  if (ranges.length) CSS.highlights.set('usage', new Highlight(...ranges)); else CSS.highlights.delete('usage')
}
const clearUsages = () => window.CSS?.highlights?.delete('usage')

let markTimer
function clearMark() { clearTimeout(markTimer); window.CSS?.highlights?.delete('sym') }
function markSymbol(m) {
  if (!m) return
  const sec = fileSection(m.path)
  const row = sec?.querySelector(`.r[data-n="${m.line}"]`)
  if (!row) return
  const code = row.querySelector('code')
  if (!window.Highlight || !CSS.highlights) return flashRow(row)
  const range = rangeIn(code, m.c0, m.c1)
  if (!range) return flashRow(row)
  clearMark()
  CSS.highlights.set('sym', new Highlight(range))
  markTimer = setTimeout(clearMark, 1200)
}
addEventListener('mousedown', clearMark)
addEventListener('keydown', clearMark)

// `from`: the symbol we leave (marked again on Back); `to`: the symbol we land on
function navigate(go, row, from, to) {
  const main = $('#main')
  history.replaceState({ y: main.scrollTop, mark: from }, '', location.href)   // where we were, so Back returns here
  go()
  history.pushState({ y: main.scrollTop, mark: to }, '', location.href)
  if (row) flashRow(row)
  markSymbol(to)
}
addEventListener('popstate', e => {
  const st = e.state
  if (!st || !S) return
  $('#main').scrollTop = st.y
  markSymbol(st.mark)
})

// ---- comments --------------------------------------------------------------
const fileOf = el => S.files[el.closest('.file').dataset.i]
const fileSection = path => [...document.querySelectorAll('.file')].find(s => S.files[s.dataset.i].path === path)

function rowFor(c) {
  const sec = fileSection(c.path)
  if (!sec || c.line == null) return null
  const sel = c.side === 'LEFT' ? `.r[data-o="${c.line}"]:not(.add)` : `.r[data-n="${c.line}"]`
  return sec.querySelector(sel)
}

const spans = new WeakMap() // thread element -> rows its comment covers

function spanRows(c, end) {
  const start = c.startLine && c.startLine !== c.line ? rowFor({ ...c, line: c.startLine }) : end
  if (!start || !end) return end ? [end] : []
  const skip = c.side === 'LEFT' ? 'add' : 'del'
  const rows = []
  for (let r = start; r; r = nextEl(r)) {
    if (r.classList.contains('r') && !r.classList.contains(skip)) rows.push(r)
    if (r === end) return rows
  }
  return [end]
}

function placeComment(c) {
  if (document.querySelector(`[data-cid="${CSS.escape(c.id)}"]`)) return
  const row = rowFor(c)
  const sec = fileSection(c.path)
  if (!sec) return
  let host = c.replyTo && document.querySelector(`[data-cid="${CSS.escape(c.replyTo)}"]`)?.closest('.thread')
  if (!host) {
    host = document.createElement('div'); host.className = 'thread'
    if (row) { let at = row; while (at.nextElementSibling?.classList.contains('thread')) at = at.nextElementSibling; at.after(host) }
    else sec.querySelector('.body').prepend(host)
  }
  const el = document.createElement('div'); el.className = 'c'; el.dataset.cid = c.id
  el.innerHTML = `<div class="meta"><b>${esc(c.author)}</b>${c.isPending ? '<span class="tag">Pending</span>' : ''}${c.isOutdated ? '<span class="tag">Outdated</span>' : ''}${c.isResolved ? '<span class="tag">Resolved</span>' : ''}${!row ? `<span>L${c.line ?? '?'} (outside the diff)</span>` : ''}
    ${c.isPending ? `<span style="flex:1"></span><button data-del="${esc(c.id)}">Delete</button>` : ''}</div>${md(c.body)}`
  host.appendChild(el)
  if (row) {
    const rows = spanRows(c, row)
    rows.forEach(r => r.classList.add('cspan'))
    spans.set(host, [...(spans.get(host) || []), ...rows])
    if (rows.length > 1) el.querySelector('.meta').insertAdjacentHTML('beforeend', `<span>lines ${c.startLine}–${c.line}</span>`)
  }
}

const hot = (e, on) => {
  const th = e.target.closest?.('.thread, .chat')
  if (th) spans.get(th)?.forEach(r => r.classList.toggle('hot', on))
}
document.addEventListener('mouseover', e => hot(e, true))
document.addEventListener('mouseout', e => hot(e, false))

function closeComposer() {
  composer?.el.remove(); composer = null
  document.querySelectorAll('.r.sel').forEach(r => r.classList.remove('sel'))
}

// next element in document order inside a file body, stepping across the `.ch` chunk wrappers
function nextEl(el) {
  let n = el.nextElementSibling
  while (!n && el.parentElement?.classList.contains('ch')) { el = el.parentElement; n = el.nextElementSibling }
  while (n?.classList.contains('ch')) n = n.firstElementChild ?? n.nextElementSibling
  return n
}

function rangeRows(row, from) {
  const side = row.classList.contains('del') ? 'LEFT' : 'RIGHT'
  if (!from || from === row || from.closest('.file') !== row.closest('.file')) return [row]
  let a = from, b = row
  if (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING) [a, b] = [b, a]
  const skip = side === 'LEFT' ? 'add' : 'del'
  const rows = []
  for (let r = a; r; r = nextEl(r)) { if (r.classList.contains('r') && !r.classList.contains(skip)) rows.push(r); if (r === b) break }
  return rows.length ? rows : [row]
}

function openComposer(row, from) {
  // `from`: the row the range starts at (shift-click anchor or drag start); the side follows the end row
  const side = row.classList.contains('del') ? 'LEFT' : 'RIGHT'
  const rows = rangeRows(row, from)
  if (rows.length === 1) anchor = row
  closeComposer()
  rows.forEach(r => r.classList.add('sel'))
  const last = rows.at(-1), first = rows[0]
  const num = r => +(side === 'LEFT' ? r.dataset.o : r.dataset.n)
  const line = num(last)
  const startLine = rows.length > 1 && num(first) !== line ? num(first) : undefined
  const f = fileOf(row)
  const el = document.createElement('div'); el.className = 'composer'
  const canSuggest = side === 'RIGHT'
  el.innerHTML = `<div class="dim" style="margin-bottom:4px">${esc(f.path)}:${startLine ? startLine + '-' : ''}${line}${side === 'LEFT' ? ' (old)' : ''}</div>
    <textarea placeholder="Leave a comment" autofocus></textarea>
    <div class="btns"><button class="primary" data-a="add">Add to review</button>${canSuggest ? '<button data-a="sugg">± Suggest change</button>' : ''}
    <button data-a="ask">Ask Claude</button><span class="sp"></span><button data-a="cancel">Cancel</button></div>`
  let at = last; while (at.nextElementSibling?.classList.contains('thread')) at = at.nextElementSibling
  at.after(el)
  composer = { el, row: last }
  const ta = el.querySelector('textarea')
  ta.focus()
  const code = rows.map(r => r.querySelector('code').textContent).join('\n')
  if (rows.length > 1) toast(`${rows.length} lines selected`)
  const send = async kind => {
    const body = ta.value.trim()
    if (kind === 'sugg') { ta.value += (ta.value ? '\n\n' : '') + '```suggestion\n' + code + '\n```\n'; ta.focus(); return }
    if (kind === 'cancel') return closeComposer()
    if (!body) return ta.focus()
    el.querySelectorAll('button').forEach(b => (b.disabled = true))
    try {
      if (kind === 'ask') {
        const a = await post('ask', { text: body, path: f.path, line, startLine, side, code: code.split('\n').slice(0, 60).join('\n') })
        if (!S.asks.some(x => x.id === a.id)) S.asks.push(a)
        placeChat(a, true); updateChat(a); renderAsks()
      } else {
        const c = await post('comment', { path: f.path, line, startLine, side, body })
        comments.push(c); placeComment(c); renderPending(); updateCounts(); toast('Added to pending review')
      }
      closeComposer()
    } catch (err) {
      toast('Failed: ' + err.message)
      el.querySelectorAll('button').forEach(b => (b.disabled = false))
    }
  }
  el.onclick = e => e.target.dataset.a && send(e.target.dataset.a)
  ta.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send('add') }
}

document.addEventListener('click', async e => {
  const id = e.target.dataset?.del
  if (!id) return
  try {
    await rapi('comment/' + encodeURIComponent(id), { method: 'DELETE' })
    comments = comments.filter(c => c.id !== id)
    const el = document.querySelector(`[data-cid="${CSS.escape(id)}"]`), th = el?.closest('.thread')
    el?.remove()
    if (th && !th.children.length) { spans.get(th)?.forEach(r => r.classList.remove('cspan', 'hot')); th.remove() }
    renderPending(); updateCounts()
  } catch (err) { toast('Delete failed: ' + err.message) }
})

// ---- side panel ------------------------------------------------------------
function initNotes() {
  const box = $('#notesbox'), st = $('#notesstate'), lk = 'notes:' + key
  let local = ''
  try { local = localStorage.getItem(lk) || '' } catch {}
  box.value = S.notes || local
  let timer
  box.oninput = () => {
    st.textContent = 'editing…'
    try { localStorage.setItem(lk, box.value) } catch {}
    clearTimeout(timer)
    timer = setTimeout(async () => {
      try { await rapi('notes', { method: 'PUT', body: box.value }); st.textContent = 'saved' } catch { st.textContent = 'not saved' }
    }, 500)
  }
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name))
  document.querySelectorAll('.tabbody').forEach(b => (b.hidden = b.id !== 'tab-' + name))
}
function initPanel() {
  document.querySelector('.tabs').onclick = e => e.target.dataset.tab && showTab(e.target.dataset.tab)
}

function renderAsks() {
  const live = S.asks.filter(a => !a.messages.at(-1)?.done).length
  $('#askbadge').textContent = live || ''
  $('#tab-claude').innerHTML = S.asks.length
    ? S.asks.map(a => {
        const last = a.messages.at(-1), first = a.messages[0]
        return `<div class="ask"><div class="q loc" data-chat="${a.id}"><b>${a.id}</b> <span class="dim">${esc(a.path || '')}${a.line ? ':' + a.line : ''}</span><br>${esc(first.text)}</div>
          <div class="dim">${last.role === 'claude' ? (last.done ? esc(last.text.replace(/```[\s\S]*?```/g, ' [code] ').replace(/[`*_#>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 140)) : 'Claude is replying…') : ''}</div></div>`
      }).reverse().join('')
    : '<p class="dim">Click a line number, then “Ask Claude”: the conversation opens right under the line.</p>'
}
$('#tab-claude').addEventListener('click', e => {
  const id = e.target.closest('[data-chat]')?.dataset.chat
  if (!id) return
  const a = S.asks.find(x => x.id === id)
  const el = chats.get(id)
  if (el) el.scrollIntoView({ block: 'center' })
  else if (a) { const f = fileSection(a.path); f?.classList.remove('folded'); f?.scrollIntoView() }
})

// ---- streaming markdown + inline chat ------------------------------------------
// Completes what a half-streamed message leaves open (fence, backtick, bold, link) so it renders cleanly at every step.
function repairMd(src) {
  let s = src
  if ((s.match(/^ {0,3}```/gm) || []).length % 2) return s + '\n```'
  s = s.replace(/\[([^\]\n]*)\]\([^)\n]*$/, '$1').replace(/\[([^\]\n]*)$/, '$1')
  const bare = s.replace(/```[\s\S]*?```/g, '')
  if ((bare.match(/`/g) || []).length % 2) s += '`'
  if ((bare.replace(/`[^`]*`/g, '').match(/\*\*/g) || []).length % 2) s += '**'
  return s
}

// Re-renders at most once per frame; the caret sits inside the last block
function streamInto(el, text, streaming) {
  el._text = text; el._live = streaming
  if (el._raf) return
  el._raf = requestAnimationFrame(() => {
    el._raf = 0
    el.innerHTML = md(el._text ? repairMd(el._text) : '', { lang: el._lang })
    if (el._live) {
      const last = el.querySelector('.md')?.lastElementChild
      const caret = document.createElement('span'); caret.className = 'caret'
      ;(last?.querySelector?.('code') || last || el).append(caret)
      if (!el._text) el.insertAdjacentHTML('afterbegin', '<span class="dim">Claude is thinking…</span>')
    }
    const box = el.closest('.cmsgs')
    if (box && box._stick) box.scrollTop = box.scrollHeight
  })
}

const chats = new Map() // thread id -> element

function updateChat(a) {
  const el = chats.get(a.id)
  if (!el) return
  const box = el.querySelector('.cmsgs')
  box._stick = box.scrollHeight - box.scrollTop - box.clientHeight < 60
  const lang = EXT_LANG[(a.path || '').split('.').pop()]
  a.messages.forEach((m, i) => {
    let row = box.children[i]
    if (!row) {
      row = document.createElement('div'); row.className = 'cmsg ' + m.role
      row.innerHTML = `<div class="who">${m.role === 'user' ? 'You' : 'Claude'}</div><div class="txt"></div>`
      box.append(row)
    }
    const txt = row.querySelector('.txt')
    if (m.role === 'user') { if (!txt.firstChild) txt.textContent = m.text }
    else { txt._lang = lang; streamInto(txt, m.text, !m.done) }
  })
  const busy = !a.messages.at(-1)?.done
  el.classList.toggle('busy', busy)
  el.querySelector('[data-c=send]').disabled = busy
  if (box._stick) box.scrollTop = box.scrollHeight
}

function buildChat(a) {
  const el = document.createElement('div'); el.className = 'chat'; el.dataset.chat = a.id
  const range = a.startLine && a.startLine !== a.line ? `${a.startLine}-${a.line}` : a.line
  el.innerHTML = `<div class="chead"><span><b>Ask Claude</b> <span class="dim">${esc(a.path)}:${range}</span></span><button data-c="fold" title="Collapse">▾</button></div>
    <div class="cmsgs"></div>
    <div class="cin"><textarea rows="1" placeholder="Follow up…  (Enter to send, Shift+Enter for a new line)"></textarea><button class="primary" data-c="send">Send</button></div>`
  const ta = el.querySelector('textarea')
  const send = async () => {
    const text = ta.value.trim()
    if (!text || el.classList.contains('busy')) return
    ta.value = ''; ta.style.height = ''
    try {
      const upd = await post('ask', { thread: a.id, text })
      const i = S.asks.findIndex(x => x.id === upd.id); if (i >= 0) S.asks[i] = upd
      a = upd; updateChat(upd); renderAsks()
    } catch (err) { toast('Failed: ' + err.message); ta.value = text }
  }
  el.onclick = e => {
    const c = e.target.dataset.c
    if (c === 'send') send()
    if (c === 'fold') { el.classList.toggle('folded'); e.target.textContent = el.classList.contains('folded') ? '▸' : '▾' }
  }
  ta.onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }
  ta.oninput = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px' }
  return el
}

function placeChat(a, focus) {
  if (chats.has(a.id) || !a.path) return false
  const c = { path: a.path, line: a.line, startLine: a.startLine, side: a.side || 'RIGHT' }
  const row = rowFor(c)
  if (!row) return false
  const el = buildChat(a)
  let at = row
  while (at.nextElementSibling?.matches('.thread, .composer, .chat')) at = at.nextElementSibling
  at.after(el)
  chats.set(a.id, el)
  const rows = spanRows(c, row)
  rows.forEach(r => r.classList.add('cspan'))
  spans.set(el, rows)
  updateChat(a)
  if (focus) el.querySelector('textarea').focus()
  return true
}

function renderPending() {
  const p = comments.filter(c => c.isPending)
  $('#pendbadge').textContent = p.length || ''
  $('#tab-pending').innerHTML = (p.length ? p.map(c => `<div class="ask"><div class="q loc" data-jump="${esc(c.id)}">${esc(c.path)}:${c.line ?? '?'}</div><div>${md(c.body)}</div></div>`).join('')
    : '<p class="dim">No pending comments.</p>') + `<p><a href="${esc(S.reviewUrl)}" target="_blank" rel="noreferrer">Submit the review on GitHub →</a></p>`
}
$('#tab-pending').addEventListener('click', e => {
  const id = e.target.dataset.jump
  if (id) document.querySelector(`[data-cid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center' })
})

// ---- language server -------------------------------------------------------
function colAt(code, x, y) {
  let node, off
  if (document.caretPositionFromPoint) { const p = document.caretPositionFromPoint(x, y); node = p?.offsetNode; off = p?.offset }
  else { const r = document.caretRangeFromPoint(x, y); node = r?.startContainer; off = r?.startOffset }
  if (!node || !code.contains(node)) return null
  const w = document.createTreeWalker(code, NodeFilter.SHOW_TEXT)
  let col = 0, t
  while ((t = w.nextNode())) { if (t === node) return col + off; col += t.length }
  return null
}

function wordAt(row, x, y) {
  if (row.classList.contains('del') || !row.dataset.n) return null
  const code = row.querySelector('code'), col = colAt(code, x, y)
  if (col == null) return null
  const text = code.textContent
  let a = col, b = col
  while (a > 0 && /[\w$]/.test(text[a - 1])) a--
  while (b < text.length && /[\w$]/.test(text[b])) b++
  const word = text.slice(a, b)
  if (!word || /^\d/.test(word)) return null
  return { word, a, path: fileOf(row).path, line: +row.dataset.n }
}

function locList(locs, kind = '') {
  const inDiff = new Set(S.files.map(f => f.path))
  const by = new Map()
  for (const l of locs) (by.get(l.path) ?? by.set(l.path, []).get(l.path)).push(l)
  return [...by].map(([p, ls]) => {
    const o = ls[0].origin || 'project'
    const badge = o !== 'project' ? `<span class="ext" title="${esc(p)}">${esc(ls[0].pkg || (o === 'external' ? 'external' : 'dependency'))}</span>`
      : !inDiff.has(p) ? '<span class="ext dim">not in this diff</span>' : ''
    const head = o === 'external' ? esc(p.split('/').slice(-3).join('/')) : esc(p)
    return `<div class="lochead">${head} <span class="dim">(${ls.length})</span> ${badge}</div>` +
      ls.map(l => `<a class="loc" data-k="${kind}" data-o="${l.origin || 'project'}" data-pv="${esc(l.preview)}" data-p="${esc(l.path)}" data-l="${l.line}" data-c="${l.col}" data-ec="${l.endLine === l.line ? l.endCol : ''}" title="${esc(l.path)}:${l.line}"><span class="dim">${l.line}</span>  ${esc(l.preview)}</a>`).join('')
  }).join('')
}

// A few lines of source around a location, inline under it (toggles); used for code the diff does not contain
const peekCache = new Map()
async function peekLoc(el, before = 4, after = 4, toggle = true) {
  const next = el.nextElementSibling
  if (next?.classList.contains('peek')) { if (toggle) next.remove(); return }
  const p = el.dataset.p, l = +el.dataset.l, id = `${p}:${l}:${before}:${after}`
  let html = peekCache.get(id)
  if (!html) {
    const { lines } = await rapi(`source?path=${encodeURIComponent(p)}&from=${Math.max(1, l - before)}&to=${l + after}`).catch(() => ({ lines: [] }))
    if (!lines.length) return
    html = `<div class="peek">${lines.map(x => `<div class="${x.n === l ? 'flash' : ''}"><span class="dim">${String(x.n).padStart(4)} </span>${x.html}</div>`).join('')}</div>`
    peekCache.set(id, html)
  }
  if (el.isConnected && !el.nextElementSibling?.classList.contains('peek')) el.insertAdjacentHTML('afterend', html)
}

// Scrolls to a line of the diff (marking the symbol there); false if that line is not rendered
function goTo(p, l, c0, c1, from) {
  const sec = fileSection(p)
  const target = sec?.querySelector(`.r[data-n="${l}"]`)
  if (!target) return false
  hidePop()
  sec.classList.remove('folded')
  navigate(() => target.scrollIntoView({ block: 'center' }), target, from, { path: p, line: l, c0, c1 })
  return true
}

async function jumpLoc(e) {
  const el = e.target.closest('.loc'); if (!el) return
  const p = el.dataset.p, l = +el.dataset.l
  const c0 = +el.dataset.c - 1, c1 = el.dataset.ec ? +el.dataset.ec - 1 : c0 + (curSym?.word.length ?? 1)
  const from = curSym && { path: curSym.path, line: curSym.line, c0: curSym.a, c1: curSym.a + curSym.word.length }
  if (goTo(p, l, c0, c1, from)) {
    if (el.dataset.k) pushJump({ kind: el.dataset.k, word: curSym?.word || '', from, to: { path: p, line: l, c0, c1, preview: el.dataset.pv || '' } })
    return
  }
  peekLoc(el, el.dataset.o === 'project' ? 4 : 6, el.dataset.o === 'project' ? 4 : 14)
}

// ---- the last 5 jumps to a definition --------------------------------------------
const MAX_JUMPS = 5
let jumps = []
function pushJump(j) {
  const same = x => x.to.path === j.to.path && x.to.line === j.to.line && x.from?.path === j.from?.path && x.from?.line === j.from?.line
  jumps = [j, ...jumps.filter(x => !same(x))].slice(0, MAX_JUMPS)
  try { localStorage.setItem('jumps:' + key, JSON.stringify(jumps)) } catch {}
  renderJumps()
}
function renderJumps() {
  $('#jumpbadge').textContent = jumps.length || ''
  const at = p => `${esc(p.path.split('/').pop())}:${p.line}`
  $('#tab-jumps').innerHTML = jumps.length
    ? jumps.map((j, i) => `<div class="jump" data-j="${i}">
        <div class="jh"><span class="tag ${j.kind || 'def'}">${esc(j.kind || 'def')}</span> <b>${esc(j.word || 'symbol')}</b>
          ${j.from ? `<button class="jback" data-back="${i}" title="Return to ${esc(j.from.path)}:${j.from.line}">↩ back to ${at(j.from)}</button>` : ''}</div>
        <div class="jgo" data-go="${i}" title="${esc(j.to.path)}:${j.to.line}"><div class="jp">${esc(j.to.preview)}</div><div class="dim jf">→ ${esc(j.to.path)}:${j.to.line}</div></div></div>`).join('')
    : '<p class="dim">Jumps to a definition or reference are listed here (newest first). Use “back” to return to where you were.</p>'
}
$('#tab-jumps').addEventListener('click', e => {
  const back = e.target.closest('[data-back]'), go = e.target.closest('[data-go]')
  const j = jumps[+(back || go)?.dataset[back ? 'back' : 'go']]
  if (!j) return
  const t = back ? j.from : j.to
  if (!goTo(t.path, t.line, t.c0, t.c1, null)) toast('That line is outside the diff')
})

// ---- hover popover ---------------------------------------------------------
const pop = document.createElement('div')
pop.id = 'pop'; pop.hidden = true
document.body.appendChild(pop)
const popCache = new Map()
const noLsp = new Set() // extensions whose server is missing
let popKey = '', popSeq = 0, curSym = null

function hidePop() { hoverKey = ''; pop.hidden = true; popKey = ''; popSeq++; clearUsages() }

function placePop(x, y) {
  pop.style.left = '0px'; pop.style.top = '0px'
  const w = pop.offsetWidth, h = pop.offsetHeight
  const left = Math.min(Math.max(8, x - 20), innerWidth - w - 8)
  const top = y + 18 + h > innerHeight ? Math.max(8, y - h - 12) : y + 18
  pop.style.left = left + 'px'; pop.style.top = top + 'px'
}

function progressHtml(st) {
  if (!st.length) return '<p class="dim">Starting the language server…</p>'
  return st.map(s => `<div class="lsprog"><b>${esc(s.server)}</b> <span class="dim">${esc(s.state === 'dead' ? 'stopped' : s.detail)}</span>
    <div class="bar${s.percent == null ? ' ind' : ''}"><i style="width:${s.percent ?? 100}%"></i></div></div>`).join('')
}
function showProgress(w, st, x, y) {
  pop.innerHTML = `<div class="ph"><b>${esc(w.word)}</b><span class="dim">language server loading…</span></div><div class="pb">${progressHtml(st)}</div>`
  pop.hidden = false
  placePop(x, y)
  pop.onclick = null
}
// Shows live indexing progress in the popover until every server is ready; false if the hover moved on meanwhile
// keep in step with SERVERS in server/lsp.ts: an extension missing here waits out the empty-status polls on every click
const SERVER_OF = { rs: 'rust-analyzer', ts: 'typescript-language-server', tsx: 'typescript-language-server', js: 'typescript-language-server', jsx: 'typescript-language-server',
  mjs: 'typescript-language-server', cjs: 'typescript-language-server', py: 'pyright|pylsp', go: 'gopls', c: 'clangd', h: 'clangd', cc: 'clangd', cpp: 'clangd', hpp: 'clangd',
  java: 'jdtls', lua: 'lua-language-server', php: 'intelephense|phpactor' }
async function lspReady(w, seq, x, y) {
  const re = new RegExp(SERVER_OF[w.path.split('.').pop()] || '^$')
  for (let empty = 0; ; ) {
    const st = (await rapi('lsp-status').catch(() => [])).filter(s => re.test(s.server))
    if (seq !== popSeq) return false
    if (st.every(s => s.state === 'ready' || s.state === 'dead') && (st.length || ++empty > 3)) return true
    showProgress(w, st, x, y)
    await new Promise(r => setTimeout(r, 600))
    if (seq !== popSeq) return false
  }
}

async function showPop(w, x, y, force = false, quiet = false) {
  const key = `${w.path}:${w.line}:${w.a}`
  if (key === popKey && !pop.hidden && !force) return
  if (key !== popKey) { pop.hidden = true; clearUsages() }   // don't leave the previous symbol's popover and highlights up while this one loads
  popKey = key
  curSym = w
  const seq = ++popSeq
  const ext = w.path.split('.').pop()
  if (noLsp.has(ext)) return force && !quiet ? toast('No language server for .' + ext) : hidePop()
  const unsupported = (...rs) => {
    const bad = rs.find(r => r?.status === 'unsupported')
    if (bad) { noLsp.add(ext); if (force && !quiet) toast(bad.message || 'No language server for .' + ext); else hidePop() }
    return !!bad
  }
  let placed = false
  const retryLater = () => setTimeout(() => { if (seq === popSeq) { popKey = ''; showPop(w, x, y, force, quiet) } }, 1200)

  // docs and the definition come back in milliseconds; references can take seconds on a widely used symbol,
  // so the popover opens on the first two and the reference list fills in when it arrives
  // what the symbol "is": its own line is not interesting, and a declaration that equals a definition is shown once
  const here = l => l.path === w.path && l.line === w.line
  const sections = ({ def, decl }) => {
    const defs = (def.locations || []).filter(l => !here(l))
    const decls = (decl?.locations || []).filter(l => !here(l) && !defs.some(d => d.path === l.path && d.line === l.line))
    return { defs, decls }
  }
  const paint = ({ hover, def, decl, refs }) => {
    const locs = refs?.locations || []
    const { defs, decls } = sections({ def, decl })
    let body
    if (hover.status === 'error' && (!refs || refs.status === 'error')) body = `<p class="dim">${esc(hover.message || 'language server error')}</p>`
    else {
      body = (hover.hover ? md(hover.hover, { lang: EXT_LANG[ext], plain: hover.hoverFormat === 'plaintext' }) : '') +
        (defs.length ? `<section class="sb">${sec('def', 'Defined in')}${locList(defs.slice(0, 3), 'def')}</section>` : '') +
        (decls.length ? `<section class="sb">${sec('decl', 'Declared in <span class="dim">(trait / interface)</span>')}${locList(decls.slice(0, 3), 'decl')}</section>` : '')
    if (!refs) body += `<section class="sb">${sec('ref', 'References <span class="dim">searching the workspace…</span>')}<div class="bar ind"><i></i></div></section>`
      else if (refs.status === 'indexing') body += `<section class="sb">${sec('ref', 'References <span class="dim">language server is still indexing…</span>')}</section>`
      else if (locs.length) body += `<section class="sb">${sec('ref', `${locs.length} reference${locs.length === 1 ? '' : 's'}`)}${locList(locs, 'ref')}</section>`
    }
    const keep = placed ? pop.scrollTop : 0   // a repaint of this hover keeps the scroll; a new symbol starts at the top
    pop.innerHTML = `<div class="ph"><b>${esc(w.word)}</b>${locs.length ? `<span class="dim">${locs.length} ref${locs.length === 1 ? '' : 's'}</span>` : ''}</div><div class="pb">${body}</div>`
    pop.hidden = false
    pop.style.setProperty('--phh', pop.querySelector('.ph').offsetHeight + 'px')   // sticky section headers sit right under the popover header
    // anchor to this symbol on its first paint (also when another popover was open); after that only re-fit if it grew off-screen
    if (!placed || pop.getBoundingClientRect().bottom > innerHeight - 8) placePop(x, y)
    placed = true
    pop.scrollTop = keep
    pop.onclick = jumpLoc
    // show the definition's source right in the popover: for code outside the diff it is the only way to see it, and inside the project it saves a jump
    for (const kind of ['def', 'decl']) pop.querySelectorAll(`.loc[data-k=${kind}]`).forEach((el, i) => {
      if (i >= 2) return
      const outside = el.dataset.o !== 'project'
      peekLoc(el, outside ? 6 : 3, outside ? 14 : 12, false).then(() => { if (pop.getBoundingClientRect().bottom > innerHeight - 8) placePop(x, y) })
    })
    if (refs) markUsages(locs)
  }
  const empty = ({ hover, def, decl, refs }) => !hover.hover && !def.locations?.length && !decl?.locations?.length && !refs?.locations?.length

  let data = popCache.get(key)
  if (data) return paint(data)

  if (!(await lspReady(w, seq, x, y))) return
  const q = k => lsp(k, w)
  const refsP = q('references').catch(err => ({ status: 'error', message: err.message }))
  const declP = q('declaration').catch(() => null)   // not every server has it; the popover just omits the section
  let hover, def
  try { [hover, def] = await Promise.all([q('hover'), q('definition')]) } catch { return }
  if (seq !== popSeq || unsupported(hover, def)) return
  if (hover.status === 'indexing') {
    showProgress(w, await rapi('lsp-status').catch(() => []), x, y)
    return retryLater()
  }
  data = { hover, def, decl: null, refs: null }
  paint(data)
  declP.then(decl => { if (seq !== popSeq || !decl || decl.status !== 'ok') return; data.decl = decl; paint(data) })

  const refs = await refsP
  if (seq !== popSeq || unsupported(refs)) return
  data.refs = refs
  if (refs.status === 'indexing') { paint(data); return retryLater() }
  if (empty(data) && refs.status !== 'error') return force && !quiet ? toast('No information for ' + w.word) : hidePop()
  paint(data)
  if (refs.status === 'ok') popCache.set(key, data)
}

// Hovering an identifier highlights its usages in the file, no popover: the language server's documentHighlight (scope-aware,
// a couple of milliseconds), or plain word matching while it is indexing or missing. The click popover highlights across files.
let hoverKey = '', hoverTimer = 0, hoverSeq = 0
const hoverCache = new Map()
const escRe = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function textUsages(w) {
  const sec = fileSection(w.path)
  if (!sec) return []
  const re = new RegExp(`(?<![\\w$])${escRe(w.word)}(?![\\w$])`, 'g')
  const locs = []
  for (const r of sec.querySelectorAll('.r[data-n]')) {
    if (!r.dataset.n) continue
    const t = r.querySelector('code').textContent
    if (!t.includes(w.word)) continue
    re.lastIndex = 0
    for (let m; (m = re.exec(t)); ) locs.push({ path: w.path, line: +r.dataset.n, col: m.index + 1, endLine: +r.dataset.n, endCol: m.index + 1 + w.word.length })
    if (locs.length > 800) break
  }
  return locs
}

function clearHover() { clearTimeout(hoverTimer); hoverKey = ''; hoverSeq++; if (pop.hidden) clearUsages() }

async function hoverAt(row, x, y) {
  const w = wordAt(row, x, y)
  if (!w) return clearHover()
  const key = `${w.path}:${w.line}:${w.a}`
  if (key === hoverKey) return
  hoverKey = key
  const seq = ++hoverSeq
  const ext = w.path.split('.').pop()
  let locs = hoverCache.get(key)
  if (!locs) {
    if (lspOk && !noLsp.has(ext)) {
      const r = await lsp('highlight', w).catch(() => null)
      if (seq !== hoverSeq) return
      if (r?.status === 'unsupported') noLsp.add(ext)
      if (r?.status === 'ok' && r.locations?.length) { locs = r.locations; hoverCache.set(key, locs) }
    }
    locs ??= textUsages(w)
  }
  if (seq === hoverSeq && pop.hidden) markUsages(locs)
}

$('#diff').addEventListener('mousemove', e => {
  if (dragFrom || e.buttons || !pop.hidden) return   // an open popover owns the highlights
  clearTimeout(hoverTimer)
  const row = e.target.closest('.r')
  if (!row || e.target.closest('.thread, .composer, .chat') || inGutter(row, e)) return clearHover()
  const x = e.clientX, y = e.clientY
  hoverTimer = setTimeout(() => hoverAt(row, x, y), 80)
})
$('#diff').addEventListener('mouseleave', clearHover)

// The popover opens when an identifier is clicked and stays until you click elsewhere, press Esc, or scroll the diff.
// (Clicks that end a text selection, hit the gutter, or land in comments and chats don't count.)
document.addEventListener('click', e => {
  if (pop.contains(e.target)) return
  const row = e.target.closest?.('#diff .r')
  const eligible = row && !e.target.closest('.thread, .composer, .chat') && !inGutter(row, e) && !getSelection().toString()
  const w = eligible && wordAt(row, e.clientX, e.clientY)
  if (w) showPop(w, e.clientX, e.clientY, true, true)
  else hidePop()
})
// popover is position:fixed, so it can't follow a scrolling diff
$('#main').addEventListener('scroll', () => { if (!pop.hidden) hidePop() }, { passive: true })
addEventListener('keydown', e => { if (e.key === 'Escape') hidePop() })

boot()

// ---- language server status --------------------------------------------------
let lspTimer, lspOk = false
async function pollLsp() {
  clearTimeout(lspTimer)
  let st = []
  try { st = await rapi('lsp-status') } catch {}
  lspOk = st.length > 0 && st.every(x => x.state === 'ready')
  const busy = st.some(x => x.state !== 'ready' && x.state !== 'dead')
  const el = $('#lspstat')
  el.hidden = !st.length
  el.innerHTML = st.map(x => `<div class="${x.state}"><b>${esc(x.server)}</b> ${x.state === 'ready' ? 'ready' : x.state === 'dead' ? 'stopped' : esc(x.detail)}</div>`).join('')
  lspTimer = setTimeout(pollLsp, busy ? 1200 : 8000)
}
