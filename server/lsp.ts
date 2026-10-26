import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { LspKind, LspLocation, LspResult } from './types'

type Range = { start: { line: number; character: number }; end: { line: number; character: number } }
type State = 'starting' | 'indexing' | 'ready' | 'dead'

const BUDGET_MS = 25_000
const MAX_ATTEMPTS = 20
const MAX_RESPAWNS = 3
const MAX_LOCATIONS = 200

const VENDORED = new Set(['node_modules', 'target', '.venv', 'venv', 'site-packages', 'vendor', '.git'])

/** Which package a file outside the project (or in a vendored dir) belongs to, from where package managers put things. */
export function describePackage(abs: string): string | undefined {
  const p = abs.split(sep).join('/')
  let m: RegExpMatchArray | null
  if ((m = p.match(/\/registry\/src\/[^/]+\/(.+)-(\d+\.\d+\.\d+[^/]*)\//))) return `crate ${m[1]} ${m[2]}`
  if ((m = p.match(/\/git\/checkouts\/([^/]+?)-[0-9a-f]{6,}\/[0-9a-f]+\//))) return `crate ${m[1]} (git)`
  if ((m = p.match(/\/lib\/rustlib\/src\/rust\/library\/([^/]+)\//))) return `Rust std (${m[1]})`
  if ((m = p.match(/\/node_modules\/((?:@[^/]+\/)?[^/]+)\//))) {
    let version = ''
    try { version = JSON.parse(readFileSync(p.slice(0, p.indexOf(m[0]) + m[0].length - 1) + '/package.json', 'utf8')).version ?? '' } catch {}
    return `npm ${m[1]}${version ? ' ' + version : ''}`
  }
  if (/\/node_modules\/typescript\/lib\//.test(p) || /\/typescript\/lib\/lib\.[\w.]+\.d\.ts$/.test(p)) return 'TypeScript lib'
  if ((m = p.match(/\/(?:site|dist)-packages\/([^/]+?)(?:-[\d.]+)?(?:\.py|\/)/))) return `python ${m[1]}`
  if (/\/typeshed\//.test(p)) return 'python typeshed'
  if ((m = p.match(/\/pkg\/mod\/(.+?)@(v[^/]+)\//))) return `go ${m[1]} ${m[2]}`
  if ((m = p.match(/\/go\/src\/([^/]+(?:\/[^/]+)?)\//)) && /\/go\/src\//.test(p)) return `go std (${m[1]})`
  if (/^\/usr\/(?:local\/)?include\//.test(p) || /\/c\+\+\/\d+\//.test(p)) return 'system header'
  return undefined
}
const RETRYABLE = [-32801, -32802]
const TIMEOUT = Symbol('timeout')

const SERVERS: Record<string, { bins: string[][]; exts: Record<string, string>; options?: object }> = {
  rust: {
    bins: [['rust-analyzer']],
    exts: { rs: 'rust' },
    options: {
      cargo: { buildScripts: { enable: false } },
      procMacro: { enable: false },
      checkOnSave: false,
      cachePriming: { enable: true },
    },
  },
  typescript: {
    bins: [['typescript-language-server', '--stdio']],
    exts: { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact', mjs: 'javascript', cjs: 'javascript' },
  },
  python: { bins: [['pyright-langserver', '--stdio'], ['pylsp']], exts: { py: 'python' } },
  go: { bins: [['gopls']], exts: { go: 'go' } },
  cpp: { bins: [['clangd']], exts: { c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp' } },
  java: { bins: [['jdtls']], exts: { java: 'java' } },
  lua: { bins: [['lua-language-server']], exts: { lua: 'lua' } },
  php: { bins: [['intelephense', '--stdio'], ['phpactor', 'language-server']], exts: { php: 'php' } },
}

const METHODS: Record<LspKind, string> = {
  hover: 'textDocument/hover',
  references: 'textDocument/references',
  definition: 'textDocument/definition',
  declaration: 'textDocument/declaration', // impl item -> the trait item it implements
  highlight: 'textDocument/documentHighlight', // same-file occurrences of the symbol, cheap
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function timeout<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  let t: ReturnType<typeof setTimeout> | undefined
  return Promise.race([p, new Promise<typeof TIMEOUT>((r) => (t = setTimeout(() => r(TIMEOUT), ms)))]).finally(() =>
    clearTimeout(t),
  )
}

function frame(msg: object): Buffer {
  const body = Buffer.from(JSON.stringify(msg), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

export class FrameParser {
  private buf: Buffer = Buffer.alloc(0)

  push(chunk: Uint8Array): any[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: any[] = []
    for (;;) {
      const sep = this.buf.indexOf('\r\n\r\n')
      if (sep < 0) break
      const len = /content-length:\s*(\d+)/i.exec(this.buf.subarray(0, sep).toString('ascii'))
      if (!len) {
        this.buf = this.buf.subarray(sep + 4)
        continue
      }
      const start = sep + 4
      const end = start + Number(len[1])
      if (this.buf.length < end) break
      const body = this.buf.subarray(start, end).toString('utf8')
      this.buf = this.buf.subarray(end)
      try {
        out.push(JSON.parse(body))
      } catch {}
    }
    return out
  }
}

class Client {
  private proc: Bun.Subprocess<'pipe', 'pipe', 'ignore'>
  private parser = new FrameParser()
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: any) => void }>()
  private initDone = false
  readonly rootUri: string
  readonly progress = new Map<string, { title: string; message?: string; percentage?: number }>()
  quiescent: boolean // rust-analyzer reports it via experimental/serverStatus, intelephense by ending its scan; others are always quiet
  private scanEndsWithProgress: boolean
  readonly opened = new Set<string>()
  dead = false
  ready: Promise<void>

  constructor(readonly root: string, cmd: string[], options?: object) {
    this.scanEndsWithProgress = cmd[0].includes('intelephense')
    this.quiescent = !/rust-analyzer|intelephense/.test(cmd[0])
    this.rootUri = pathToFileURL(root).href
    this.proc = Bun.spawn(cmd, { cwd: root, stdin: 'pipe', stdout: 'pipe', stderr: 'ignore' })
    this.pump()
    this.proc.exited.then(() => this.die())
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: this.rootUri,
      rootPath: root,
      workspaceFolders: [{ uri: this.rootUri, name: basename(root) }],
      initializationOptions: options,
      capabilities: {
        general: { positionEncodings: ['utf-16'] },
        window: { workDoneProgress: true },
        experimental: { serverStatusNotification: true },
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { didSave: false },
          hover: { contentFormat: ['markdown', 'plaintext'] },
          references: {},
          definition: { linkSupport: true },
        },
      },
    }).then(() => {
      this.initDone = true
      this.notify('initialized', {})
    })
    this.ready.catch(() => this.die())
  }

  get state(): State {
    return this.dead ? 'dead' : !this.initDone ? 'starting' : this.progress.size || !this.quiescent ? 'indexing' : 'ready'
  }

  /** Human-readable indexing progress, e.g. "Indexing 45% · 12/40 crates". */
  get detail(): string {
    if (!this.initDone) return 'starting'
    const parts = [...this.progress.values()].map((p) => [p.title, p.percentage != null ? `${p.percentage}%` : '', p.message].filter(Boolean).join(' '))
    return parts.length ? parts.join(' · ') : this.quiescent ? 'ready' : 'loading the workspace'
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('language server exited'))
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  die() {
    if (this.dead) return
    this.dead = true
    for (const p of this.pending.values()) p.reject(new Error('language server exited'))
    this.pending.clear()
    try {
      this.proc.kill()
    } catch {}
  }

  private send(msg: object) {
    if (this.dead) return
    try {
      this.proc.stdin.write(frame(msg))
      this.proc.stdin.flush()
    } catch {
      this.die()
    }
  }

  private async pump() {
    try {
      for await (const chunk of this.proc.stdout) for (const msg of this.parser.push(chunk)) this.onMessage(msg)
    } catch {}
    this.die()
  }

  private onMessage(m: any) {
    if (m.method !== undefined && m.id !== undefined) return this.reply(m)
    if (m.method !== undefined) {
      if (m.method === 'experimental/serverStatus') this.quiescent = !!m.params?.quiescent
      // intelephense brackets its workspace scan with these, or with $/progress when the client supports it
      if (m.method === 'indexingStarted') this.quiescent = false
      if (m.method === 'indexingEnded') this.quiescent = true
      if (m.method === '$/progress') {
        const token = String(m.params?.token)
        const v = m.params?.value
        if (v?.kind === 'begin') this.progress.set(token, { title: v.title ?? '', message: v.message, percentage: v.percentage })
        if (v?.kind === 'report') {
          const cur = this.progress.get(token)
          if (cur) this.progress.set(token, { ...cur, message: v.message ?? cur.message, percentage: v.percentage ?? cur.percentage })
        }
        if (v?.kind === 'end') {
          this.progress.delete(token)
          if (this.scanEndsWithProgress && !this.progress.size) this.quiescent = true
        }
      }
      return
    }
    const p = this.pending.get(m.id)
    if (!p) return
    this.pending.delete(m.id)
    if (m.error) p.reject(Object.assign(new Error(m.error.message), { code: m.error.code }))
    else p.resolve(m.result)
  }

  private reply(m: any) {
    const result =
      m.method === 'workspace/workspaceFolders'
        ? [{ uri: this.rootUri, name: basename(this.root) }]
        : m.method === 'workspace/configuration'
          ? (m.params?.items ?? []).map(() => null)
          : null
    this.send({ jsonrpc: '2.0', id: m.id, result })
  }
}

export class LspManager {
  private servers = new Map<string, { name: string; client: Client | null; restarts: number }>()
  private files = new Map<string, string[]>()

  constructor(private root: string) {}

  /** Cargo.toml files not under another one (workspace roots), so a repo with the crate in a subdirectory works. */
  private cargoManifests(): string[] {
    const found: string[] = []
    const walk = (dir: string, depth: number) => {
      if (existsSync(join(dir, 'Cargo.toml'))) return void found.push(join(dir, 'Cargo.toml'))
      if (depth === 0) return
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        if (d.isDirectory() && !['node_modules', 'target', '.git'].includes(d.name)) walk(join(dir, d.name), depth - 1)
      }
    }
    walk(this.root, 3)
    return found
  }

  async query(kind: LspKind, path: string, line: number, col: number): Promise<LspResult> {
    try {
      return await this.run(kind, path, line, col)
    } catch (e) {
      return { status: 'error', message: (e as Error)?.message ?? String(e) }
    }
  }

  status(): { server: string; state: State; detail: string; percent?: number }[] {
    return [...this.servers.values()].map((s) => ({
      server: s.name,
      state: s.client ? s.client.state : 'dead',
      detail: s.client?.detail ?? 'dead',
      percent: [...(s.client?.progress.values() ?? [])].find((p) => p.percentage != null)?.percentage,
    }))
  }

  /** Starts the server for this file's language ahead of the first real query. */
  warm(path: string) {
    void this.query('hover', path, 1, 1).catch(() => undefined)
  }

  dispose() {
    for (const s of this.servers.values()) s.client?.die()
    this.servers.clear()
  }

  private async run(kind: LspKind, path: string, line: number, col: number): Promise<LspResult> {
    const ext = extname(path).slice(1).toLowerCase()
    const key = Object.keys(SERVERS).find((k) => ext in SERVERS[k].exts)
    if (!key) return { status: 'unsupported', message: `no language server for .${ext}` }
    const spec = SERVERS[key]
    const cmd = spec.bins.find((c) => Bun.which(c[0]))
    if (!cmd) return { status: 'unsupported', message: `${spec.bins[0][0]} not installed` }

    const deadline = Date.now() + BUDGET_MS
    const left = () => Math.max(0, deadline - Date.now())
    const options = key === 'rust' ? { ...spec.options, linkedProjects: this.cargoManifests() } : spec.options
    const client = this.clientFor(key, cmd, options)
    if (!client) return { status: 'error', message: `${cmd[0]} crashed too many times` }

    if (client.dead) return { status: 'error', message: `${cmd[0]} exited — if it is a rustup shim, run: rustup component add rust-analyzer` }
    if (await timeout(client.ready, left()) === TIMEOUT) return { status: 'indexing' }

    const abs = join(this.root, path)
    const uri = pathToFileURL(abs).href
    if (!client.opened.has(uri)) {
      const text = readFileSync(abs, 'utf8')
      client.opened.add(uri)
      client.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: spec.exts[ext], version: 1, text },
      })
    }

    const position = { line: line - 1, character: col - 1 }
    const params =
      kind === 'references'
        ? { textDocument: { uri }, position, context: { includeDeclaration: true } }
        : { textDocument: { uri }, position }

    for (let attempt = 0; attempt < MAX_ATTEMPTS && left() > 0; attempt++) {
      if (attempt) await sleep(Math.min(500, left()))
      let raw: any
      try {
        raw = await timeout(client.request(METHODS[kind], params), left())
      } catch (e) {
        if (RETRYABLE.includes((e as any).code)) continue
        throw e
      }
      if (raw === TIMEOUT) break
      const empty = raw == null || (Array.isArray(raw) && raw.length === 0)
      if (empty && (client.progress.size || !client.quiescent)) continue
      if (kind === 'highlight') return { status: 'ok', locations: this.highlights(raw, path) }
      return kind === 'hover' ? this.hover(raw) : { status: 'ok', locations: this.locations(raw) }
    }
    return { status: 'indexing' }
  }

  private clientFor(key: string, cmd: string[], options?: object): Client | null {
    let s = this.servers.get(key)
    if (!s) {
      s = { name: cmd[0], client: null, restarts: 0 }
      this.servers.set(key, s)
    }
    if (s.client && !s.client.dead) return s.client
    if (s.client) {
      if (s.restarts >= MAX_RESPAWNS) return null
      s.restarts++
    }
    s.client = new Client(this.root, cmd, options)
    return s.client
  }

  private hover(raw: any): LspResult {
    const text = raw ? markdown(raw.contents) : ''
    const hoverFormat = raw?.contents?.kind === 'plaintext' ? 'plaintext' : 'markdown'
    return { status: 'ok', hover: text || undefined, hoverFormat }
  }

  private highlights(raw: any, path: string): LspLocation[] {
    return (Array.isArray(raw) ? raw : []).slice(0, MAX_LOCATIONS).map((h: any) => ({
      path,
      origin: 'project' as const,
      line: h.range.start.line + 1,
      col: h.range.start.character + 1,
      endLine: h.range.end.line + 1,
      endCol: h.range.end.character + 1,
      preview: '',
    }))
  }

  private locations(raw: any): LspLocation[] {
    const items: { uri: string; range: Range }[] = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((l: any) =>
      l.targetUri ? { uri: l.targetUri, range: l.targetSelectionRange ?? l.targetRange } : l,
    )
    return items
      .filter((i) => i.uri?.startsWith('file:'))
      .map((i) => {
        const abs = fileURLToPath(i.uri)
        const rel = relative(this.root, abs)
        const inside = !!rel && !isAbsolute(rel) && rel.split(sep)[0] !== '..'
        const path = inside ? rel : abs
        const origin: LspLocation['origin'] = !inside ? 'external' : rel.split(sep).some((s) => VENDORED.has(s)) ? 'dependency' : 'project'
        const line = i.range.start.line + 1
        return {
          path,
          origin,
          pkg: origin === 'project' ? undefined : describePackage(abs),
          line,
          col: i.range.start.character + 1,
          endLine: i.range.end.line + 1,
          endCol: i.range.end.character + 1,
          preview: (this.lines(abs)[line - 1] ?? '').trim(),
        }
      })
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
      .slice(0, MAX_LOCATIONS)
  }

  private lines(abs: string): string[] {
    let l = this.files.get(abs)
    if (!l) {
      try {
        l = readFileSync(abs, 'utf8').split('\n')
      } catch {
        l = []
      }
      this.files.set(abs, l)
    }
    return l
  }
}

function markdown(c: any): string {
  const md = (x: any): string =>
    typeof x === 'string' ? x : 'language' in x ? '```' + x.language + '\n' + x.value + '\n```' : (x.value ?? '')
  return (Array.isArray(c) ? c : [c]).map(md).filter(Boolean).join('\n\n')
}
