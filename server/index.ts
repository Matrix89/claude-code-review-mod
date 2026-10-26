// PR review server: `bun index.ts`. Speaks JSON lines on stdout to the Claude mod
// ({type:'ready'|'ask'|'log'}); the browser talks to it over HTTP.
import { join, isAbsolute } from 'node:path'
import { homedir } from 'node:os'
import { mkdirSync } from 'node:fs'
import { parseDiff, highlightLines, escapeHtml } from './diff'
import * as gh from './gh'
import { LspManager } from './lsp'
import { generateManifest } from 'material-icon-theme'
import type { DiffFile, PrMeta, ReviewComment, LspKind } from './types'

const WEB = join(import.meta.dir, '..', 'web')
const CACHE = join(homedir(), '.cache', 'pr-review')
const NOTES = join(CACHE, 'notes')
mkdirSync(NOTES, { recursive: true })

const token = crypto.randomUUID().replaceAll('-', '')
const out = (o: object) => console.log(JSON.stringify(o))

interface Msg { role: 'user' | 'claude'; text: string; done: boolean }
// One chat thread, anchored to a line; Claude's replies stream into the last message
interface Ask { id: string; path?: string; line?: number; startLine?: number; side?: string; code?: string; messages: Msg[]; at: number }
interface Review {
  key: string; repo: string; n: number
  status: 'loading' | 'ready' | 'error'; stage: string; error?: string
  meta?: PrMeta; worktree?: string; localRepo?: string; viewer?: string; viewed: Set<string>
  files: DiffFile[]; comments: ReviewComment[]; asks: Ask[]
  lsp?: LspManager
  sourceOk: Set<string> // absolute paths a language server pointed at (outside the worktree): the only ones /source may read
  hl: Map<string, Promise<string[]>>
  subs: Set<(ev: string, data: unknown) => void>
}
const CHUNK = 100
// File-type icons: the Material Icon Theme (MIT), served from node_modules; the manifest is trimmed to icon names
const ICON_DIR = join(import.meta.dir, 'node_modules', 'material-icon-theme', 'icons')
const lower = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.toLowerCase(), v]))
const iconManifest = (() => {
  const m = generateManifest()
  return JSON.stringify({
    file: m.file, folder: m.folder, folderExpanded: m.folderExpanded,
    fileNames: lower(m.fileNames ?? {}), fileExtensions: lower(m.fileExtensions ?? {}),
    folderNames: lower(m.folderNames ?? {}), folderNamesExpanded: lower(m.folderNamesExpanded ?? {}),
  })
})()

const reviews = new Map<string, Review>()
let askSeq = 0

const notesPath = (r: Review) => join(NOTES, `${r.repo.replace('/', '__')}__${r.n}.md`)

async function load(r: Review, cwd: string) {
  const step = (s: string) => { r.stage = s }
  try {
    step('Fetching PR metadata')
    r.meta = await gh.fetchMeta(r.repo, r.n)
    step('Preparing a worktree at the PR head (first run can take a while)')
    const wt = await gh.prepareWorktree(r.repo, r.n, r.meta.headSha, r.meta.baseSha, cwd)
    r.worktree = wt.worktree; r.localRepo = wt.localRepo
    step('Computing the diff')
    const [diff, comments, viewer, viewed] = await Promise.all([
      gh.getDiff(wt.localRepo, r.meta.baseSha, r.meta.headSha),
      gh.listComments(r.repo, r.n).catch(() => []),
      gh.viewer().catch(() => ''),
      gh.viewedFiles(r.repo, r.n).catch(() => [] as string[]),
    ])
    r.files = parseDiff(diff); r.comments = comments; r.viewer = viewer; r.viewed = new Set(viewed)
    r.status = 'ready'; r.stage = 'ready'
    const seen = new Set<string>()
    for (const f of r.files) {
      const ext = f.path.split('.').pop() ?? ''
      if (f.status === 'deleted' || seen.has(ext) || !/^(rs|tsx?|jsx?|py|go|c|cc|cpp|h|hpp)$/.test(ext)) continue
      seen.add(ext); (r.lsp ??= new LspManager(r.worktree!)).warm(f.path)
    }
  } catch (e) {
    r.status = 'error'; r.error = String((e as Error).message ?? e)
  }
}

async function open(pr: string, cwd: string) {
  const { repo, number } = await gh.parsePrRef(pr, cwd)
  const key = `${repo}#${number}`
  let r = reviews.get(key)
  if (!r || r.status === 'error') {
    r = { key, repo, n: number, status: 'loading', stage: 'Resolving', files: [], comments: [], asks: [], viewed: new Set(), sourceOk: new Set(), hl: new Map(), subs: new Set() }
    reviews.set(key, r)
    void load(r, cwd)
  }
  return key
}

const notify = (r: Review, ev: string, data: unknown) => r.subs.forEach(f => f(ev, data))

// ---- diff rendering -------------------------------------------------------

function highlighted(r: Review, ref: 'head' | 'base', path: string) {
  const id = `${ref}:${path}`
  let p = r.hl.get(id)
  if (!p) {
    p = (async () => {
      let text = ''
      try {
        text = ref === 'head'
          ? await Bun.file(join(r.worktree!, path)).text()
          : await gh.run(['git', 'show', `${r.meta!.baseSha}:${path}`], r.localRepo)
      } catch { /* missing side */ }
      return highlightLines(text, path)
    })()
    r.hl.set(id, p)
  }
  return p
}

const row = (cls: string, o: number | '', n: number | '', html: string) =>
  `<div class="r ${cls}" data-o="${o}" data-n="${n}"><code>${html || ' '}</code></div>`

const gap = (fi: number, from: number, to: number, delta: number) =>
  to < from ? '' :
  `<div class="gap" data-f="${fi}" data-from="${from}" data-to="${to}" data-delta="${delta}">` +
  `<button data-act="up">↑ 20</button><button data-act="all">Expand ${to - from + 1} lines</button><button data-act="down">↓ 20</button></div>`

// Highlighted lines of a file for the source peek: worktree files by relative path, or a path a language server returned
// (a crate, node_modules, the std library). Nothing else, so the endpoint cannot read arbitrary files.
async function sourceLines(r: Review, path: string): Promise<string[] | null> {
  if (isAbsolute(path)) {
    if (!r.sourceOk.has(path)) return null
    const id = `abs:${path}`
    let p = r.hl.get(id)
    if (!p) { p = Bun.file(path).text().then(t => highlightLines(t, path), () => []); r.hl.set(id, p) }
    return p
  }
  if (path.split(/[\\/]/).includes('..')) return null
  return highlighted(r, 'head', path)
}

async function renderFile(r: Review, fi: number) {
  const f = r.files[fi]
  if (f.binary) return '<div class="note">Binary file not shown</div>'
  const head = f.status === 'deleted' ? [] : await highlighted(r, 'head', f.path)
  const needBase = f.status === 'deleted' || f.hunks.some(h => h.lines.some(l => l.t === 'del'))
  const base = needBase ? await highlighted(r, 'base', f.oldPath ?? f.path) : []
  const parts: string[] = []
  let prevEnd = 0
  for (const h of f.hunks) {
    parts.push(gap(fi, prevEnd + 1, h.newStart - 1, h.oldStart - h.newStart))
    parts.push(`<div class="hh">@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@ ${escapeHtml(h.header)}</div>`)
    for (const l of h.lines) {
      if (l.t === 'del') parts.push(row('del', l.old!, '', base[l.old! - 1] ?? escapeHtml(l.text)))
      else parts.push(row(l.t, l.t === 'add' ? '' : l.old!, l.new!, head[l.new! - 1] ?? escapeHtml(l.text)))
    }
    prevEnd = h.newStart + h.newLines - 1
  }
  const last = f.hunks.at(-1)
  if (last && f.status !== 'deleted') {
    parts.push(gap(fi, prevEnd + 1, head.length, last.oldStart + last.oldLines - (last.newStart + last.newLines)))
  }
  // chunks the browser can skip painting while scrolling (content-visibility), so a 4k-line file costs the same as a small one
  const els = parts.filter(Boolean), out: string[] = []
  for (let i = 0; i < els.length; i += CHUNK) out.push(`<div class="ch">${els.slice(i, i + CHUNK).join('')}</div>`)
  return out.join('')
}

async function renderLines(r: Review, fi: number, from: number, to: number, delta: number) {
  const head = await highlighted(r, 'head', r.files[fi].path)
  const parts: string[] = []
  for (let n = from; n <= Math.min(to, head.length); n++) parts.push(row('ctx', n + delta, n, head[n - 1]))
  return parts.join('')
}

// ---- http -----------------------------------------------------------------

const json = (o: unknown, status = 200) => Response.json(o, { status })
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }

const server = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/icons.json') return new Response(iconManifest, { headers: { 'content-type': 'application/json', 'cache-control': 'max-age=3600' } })
    if (p.startsWith('/icons/') && /^\/icons\/[\w.-]+\.svg$/.test(p)) {
      const f = Bun.file(join(ICON_DIR, p.slice(7)))
      return (await f.exists()) ? new Response(f, { headers: { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' } }) : new Response('not found', { status: 404 })
    }
    if (!p.startsWith('/api/')) {
      const name = p === '/' ? 'index.html' : p.slice(1)
      if (name.includes('..')) return new Response('no', { status: 400 })
      const f = Bun.file(join(WEB, name))
      return (await f.exists())
        ? new Response(f, { headers: { 'content-type': MIME[name.slice(name.lastIndexOf('.'))] ?? 'text/plain', 'cache-control': 'no-store' } })
        : new Response('not found', { status: 404 })
    }
    if ((req.headers.get('x-token') ?? url.searchParams.get('t')) !== token) return json({ error: 'bad token' }, 401)
    try {
      return await api(req, url)
    } catch (e) {
      return json({ error: String((e as Error).message ?? e) }, 500)
    }
  },
})

async function api(req: Request, url: URL): Promise<Response> {
  const p = url.pathname
  if (p === '/api/open' && req.method === 'POST') {
    const b = await req.json()
    return json({ key: await open(b.pr, b.cwd ?? process.cwd()) })
  }
  if ((p === '/api/stream' || p === '/api/answer') && req.method === 'POST') {
    // from the mod: the reply to a thread so far (cumulative), `done` once the turn ended
    const b = await req.json()
    for (const r of reviews.values()) {
      const a = r.asks.find(x => x.id === b.id)
      if (!a) continue
      const last = a.messages.at(-1)
      if (!last || last.role !== 'claude') a.messages.push({ role: 'claude', text: '', done: false })
      const m = a.messages.at(-1)!
      if (p === '/api/answer' || String(b.text ?? '').length >= m.text.length) m.text = String(b.text ?? m.text)
      if (b.done || p === '/api/answer') m.done = true
      notify(r, 'ask', a)
      return json({ ok: true })
    }
    return json({ error: `no question ${b.id}` }, 404)
  }
  const m = p.match(/^\/api\/r\/([^/]+)\/(.*)$/)
  if (!m) return json({ error: 'not found' }, 404)
  const r = reviews.get(decodeURIComponent(m[1]))
  if (!r) return json({ error: 'unknown review' }, 404)
  const [verb, ...rest] = m[2].split('/')
  const q = url.searchParams

  if (verb === 'state') {
    if (r.status !== 'ready') return json({ status: r.status, stage: r.stage, error: r.error })
    const notes = await Bun.file(notesPath(r)).text().catch(() => '')
    return json({
      status: 'ready', meta: r.meta, viewer: r.viewer, comments: r.comments, asks: r.asks, notes, viewed: [...r.viewed],
      reviewUrl: gh.reviewUrl(r.repo, r.n), worktree: r.worktree,
      files: r.files.map(f => ({ path: f.path, oldPath: f.oldPath, status: f.status, binary: f.binary, additions: f.additions, deletions: f.deletions })),
    })
  }
  if (verb === 'viewed' && req.method === 'POST') {
    const b = await req.json()
    await gh.setViewed(r.repo, r.n, b.path, !!b.viewed)
    b.viewed ? r.viewed.add(b.path) : r.viewed.delete(b.path)
    return json({ ok: true })
  }
  if (verb === 'file') return json({ html: await renderFile(r, +rest[0]) })
  if (verb === 'lines') return json({ html: await renderLines(r, +q.get('f')!, +q.get('from')!, +q.get('to')!, +q.get('delta')!) })
  if (verb === 'source') {
    const path = q.get('path')!
    const lines = await sourceLines(r, path)
    if (!lines) return json({ error: 'path not allowed' }, 403)
    const from = Math.max(1, +q.get('from')!), to = Math.min(lines.length, +q.get('to')!)
    return json({ lines: lines.slice(from - 1, to).map((html, i) => ({ n: from + i, html })) })
  }
  if (verb === 'lsp-status') return json(r.lsp?.status() ?? [])
  if (verb === 'lsp') {
    const path = q.get('path')!
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) return json({ error: 'path not allowed' }, 403)
    r.lsp ??= new LspManager(r.worktree!)
    const res = await r.lsp.query(q.get('kind') as LspKind, path, +q.get('line')!, +q.get('col')!)
    for (const l of res.locations ?? []) if (l.origin === 'external') r.sourceOk.add(l.path)
    return json(res)
  }
  if (verb === 'notes' && req.method === 'PUT') {
    await Bun.write(notesPath(r), await req.text())
    return json({ ok: true })
  }
  if (verb === 'comment' && req.method === 'POST') {
    const c = await gh.addPendingComment(r.repo, r.n, await req.json())
    r.comments.push(c)
    return json(c)
  }
  if (verb === 'comment' && req.method === 'DELETE') {
    const id = decodeURIComponent(rest[0])
    await gh.deletePendingComment(id)
    r.comments = r.comments.filter(c => c.id !== id)
    return json({ ok: true })
  }
  if (verb === 'ask' && req.method === 'POST') {
    const b = await req.json()
    let a = b.thread ? r.asks.find(x => x.id === b.thread) : undefined
    const followUp = !!a
    if (!a) {
      a = { id: `q${++askSeq}`, path: b.path, line: b.line, startLine: b.startLine, side: b.side, code: b.code, messages: [], at: Date.now() }
      r.asks.push(a)
    }
    a.messages.push({ role: 'user', text: b.text, done: true }, { role: 'claude', text: '', done: false })
    const where = a.path ? `\nAbout ${a.path}${a.line ? `:${a.startLine ? a.startLine + '-' : ''}${a.line}` : ''}${a.code ? `:\n\`\`\`\n${a.code}\n\`\`\`` : ''}` : ''
    const how = `Your reply streams live into a chat box beside that line in the reviewer's browser, so answer directly in chat: concise markdown, no preamble, and no need to call any tool to deliver it.`
    out({
      type: 'ask', id: a.id,
      prompt: followUp
        ? `PR review follow-up ${a.id} on ${r.repo}#${r.n}.\n\n${b.text}\n\n${how}`
        : `PR review question ${a.id} on ${r.repo}#${r.n} ("${r.meta!.title}").\n` +
          `The PR head is checked out read-only at ${r.worktree} (base ${r.meta!.baseRef}, head ${r.meta!.headSha.slice(0, 8)}).${where}\n\nQuestion: ${b.text}\n\n${how}`,
    })
    notify(r, 'ask', a)
    return json(a)
  }
  if (verb === 'events') {
    let send: (ev: string, data: unknown) => void
    const stream = new ReadableStream({
      start(c) {
        const enc = new TextEncoder()
        send = (ev, data) => c.enqueue(enc.encode(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`))
        r.subs.add(send)
        c.enqueue(enc.encode(': hi\n\n'))
      },
      cancel() { r.subs.delete(send) },
    })
    return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store' } })
  }
  return json({ error: 'not found' }, 404)
}

out({ type: 'ready', port: server.port, token })
process.on('SIGTERM', () => { for (const r of reviews.values()) r.lsp?.dispose(); process.exit(0) })
