// Code dependency graph from tree-sitter: files are nodes, resolved imports (`use`/`mod`, `import`, `#include`) are edges.
// Rust, TypeScript/JavaScript, Python and C/C++ are understood; everything else is ignored.
import Parser from 'web-tree-sitter'
type Node = Parser.SyntaxNode
type Language = Parser.Language
import { join, dirname, posix } from 'node:path'
import type { GraphData, GraphDef, GraphNode } from './types'

type Lang = 'rust' | 'ts' | 'tsx' | 'js' | 'python' | 'c' | 'cpp'
const EXT: Record<string, Lang> = {
  rs: 'rust', ts: 'ts', mts: 'ts', cts: 'ts', tsx: 'tsx', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js', py: 'python',
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
}
const WASM: Record<Lang, string> = {
  rust: 'rust', ts: 'typescript', tsx: 'tsx', js: 'javascript', python: 'python', c: 'c', cpp: 'cpp',
}
const SKIP = /(^|\/)(node_modules|target|vendor|third_party|dist|build|output|dl|\.venv|__pycache__)\//
const MAX_FILES = 6000, MAX_BYTES = 400_000

// What counts as a definition, per tree-sitter node type; the name comes from the `name` field
const DEFS: Record<string, string> = {
  function_item: 'fn', struct_item: 'struct', enum_item: 'enum', trait_item: 'trait', type_item: 'type', const_item: 'const', static_item: 'static', mod_item: 'mod', macro_definition: 'macro',
  function_declaration: 'fn', class_declaration: 'class', interface_declaration: 'interface', type_alias_declaration: 'type', enum_declaration: 'enum',
  function_definition: 'fn', class_definition: 'class', struct_specifier: 'struct', class_specifier: 'class',
}

let ready: Promise<Map<Lang, Language>> | undefined
function languages() {
  return ready ??= (async () => {
    await Parser.init()
    const dir = join(import.meta.dir, 'node_modules', 'tree-sitter-wasms', 'out')
    const m = new Map<Lang, Language>()
    for (const l of Object.keys(WASM) as Lang[]) m.set(l, await Parser.Language.load(join(dir, `tree-sitter-${WASM[l]}.wasm`)))
    return m
  })()
}

interface Imp { spec: string; line: number; names: string[]; kind: 'use' | 'mod' | 'import' | 'include' }
interface Parsed { defs: GraphDef[]; imports: Imp[]; lines: number }

const text = (n: Node | null) => n?.text ?? ''

// `a::b::{c, d::e as f, self}` -> [a::b::c, a::b::d::e, a::b]
function expandUse(s: string): string[] {
  s = s.replace(/\s+/g, '')
  const brace = s.indexOf('{')
  if (brace < 0) return [s.replace(/as\w+$/, '').replace(/::\*$/, '')]
  const prefix = s.slice(0, brace), close = s.lastIndexOf('}')
  const parts: string[] = []
  let depth = 0, cur = ''
  for (const ch of s.slice(brace + 1, close)) {
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' } else { cur += ch; if (ch === '{') depth++; if (ch === '}') depth-- }
  }
  if (cur) parts.push(cur)
  return parts.flatMap(p => p === 'self' ? [prefix.replace(/::$/, '')] : expandUse(prefix + p))
}

function extract(lang: Lang, root: Node): Parsed {
  const defs: GraphDef[] = [], imports: Imp[] = []
  const walk = (n: Node, depth: number) => {
    const t = n.type
    if (DEFS[t] && depth <= 2) {
      const name = text(n.childForFieldName('name')) || (t === 'function_definition' ? text(n.childForFieldName('declarator')?.childForFieldName('declarator') ?? null) : '')
      if (name && !/[\s(]/.test(name)) defs.push({ name, kind: DEFS[t], line: n.startPosition.row + 1 })
    }
    switch (t) {
      case 'use_declaration':
        for (const p of expandUse(text(n.childForFieldName('argument')))) imports.push({ spec: p, line: n.startPosition.row + 1, names: [/^(super|self|crate)$/.test(p.split('::').pop()!) ? '*' : p.split('::').pop()!], kind: 'use' })
        return
      case 'mod_item':
        if (!n.childForFieldName('body')) imports.push({ spec: text(n.childForFieldName('name')), line: n.startPosition.row + 1, names: [], kind: 'mod' })
        break
      case 'import_statement':
      case 'export_statement': {
        if (lang === 'python') {
          const names = n.namedChildren.filter(c => c.type === 'dotted_name' || c.type === 'aliased_import').map(c => text(c.type === 'aliased_import' ? c.childForFieldName('name') : c))
          for (const s of names) imports.push({ spec: s, line: n.startPosition.row + 1, names: [s.split('.').pop()!], kind: 'import' })
          return
        }
        const src = n.childForFieldName('source')
        if (src) {
          const names = n.descendantsOfType('import_specifier').concat(n.descendantsOfType('export_specifier')).map(c => text(c.childForFieldName('name')))
          imports.push({ spec: text(src).slice(1, -1), line: n.startPosition.row + 1, names, kind: 'import' })
        }
        return
      }
      case 'import_from_statement': {
        const m = text(n.childForFieldName('module_name'))
        const names = n.namedChildren.slice(1).map(c => text(c.type === 'aliased_import' ? c.childForFieldName('name') : c))
        imports.push({ spec: m, line: n.startPosition.row + 1, names, kind: 'import' })
        return
      }
      case 'call_expression': {
        const fn = text(n.childForFieldName('function'))
        const arg = n.childForFieldName('arguments')?.namedChildren[0]
        if ((fn === 'require' || fn === 'import') && arg?.type === 'string') imports.push({ spec: text(arg).slice(1, -1), line: n.startPosition.row + 1, names: [], kind: 'import' })
        break
      }
      case 'preproc_include': {
        const p = n.childForFieldName('path')
        if (p?.type === 'string_literal') imports.push({ spec: text(p).slice(1, -1), line: n.startPosition.row + 1, names: [], kind: 'include' })
        return
      }
    }
    for (const c of n.namedChildren) walk(c, depth + 1)
  }
  walk(root, 0)
  return { defs, imports, lines: root.endPosition.row + 1 }
}

// ---- resolving imports to files ------------------------------------------------------

class Resolver {
  private files: Set<string>
  private crates = new Map<string, { name: string; dir: string; root?: string }>() // by Cargo.toml dir
  private rustMods = new Map<string, string>() // `crateDir::a::b` -> file
  private modOf = new Map<string, string>() // file -> `crateDir::a::b`
  constructor(files: string[], cargo: Map<string, string>, private py: Set<string>) {
    this.files = new Set(files)
    for (const [dir, name] of cargo) {
      const root = ['src/lib.rs', 'src/main.rs'].map(p => posix.join(dir, p)).find(p => this.files.has(p))
      this.crates.set(dir, { name: name.replaceAll('-', '_'), dir, root })
    }
  }
  /** Follows `mod x;` declarations from each crate root to learn which file is which module path */
  indexRust(parsed: Map<string, Parsed>) {
    const visit = (file: string, mod: string, crate: string) => {
      this.rustMods.set(mod, file); this.modOf.set(file, mod)
      const base = /(^|\/)(mod|lib|main)\.rs$/.test(file) ? dirname(file) : file.replace(/\.rs$/, '')
      for (const i of parsed.get(file)?.imports ?? []) {
        if (i.kind !== 'mod') continue
        const child = [posix.join(base, `${i.spec}.rs`), posix.join(base, i.spec, 'mod.rs')].find(p => this.files.has(p))
        if (child && !this.modOf.has(child)) visit(child, `${mod}::${i.spec}`, crate)
      }
    }
    for (const c of this.crates.values()) if (c.root) visit(c.root, c.dir, c.dir)
  }
  private crateOf(file: string) {
    let best: { dir: string; name: string } | undefined
    for (const c of this.crates.values()) if ((c.dir === '' || file.startsWith(c.dir + '/')) && (!best || c.dir.length > best.dir.length)) best = c
    return best
  }
  resolve(lang: Lang, from: string, i: Imp): string | undefined {
    if (lang === 'rust') return this.rust(from, i)
    if (lang === 'python') return this.python(from, i)
    if (lang === 'c' || lang === 'cpp') {
      if (i.kind !== 'include') return
      return [posix.join(dirname(from), i.spec), i.spec, posix.join('include', i.spec)].map(posix.normalize).find(p => this.files.has(p))
    }
    return this.js(from, i.spec)
  }
  private rust(from: string, i: Imp) {
    const crate = this.crateOf(from); if (!crate) return
    const here = this.modOf.get(from)
    if (i.kind === 'mod') return this.rustMods.get(`${here ?? crate.dir}::${i.spec}`)
    let segs = i.spec.split('::')
    let base: string[]
    if (segs[0] === 'crate') { base = [crate.dir]; segs = segs.slice(1) }
    else if (segs[0] === 'self' && here) { base = here.split('::'); segs = segs.slice(1) }
    else if (segs[0] === 'super' && here) {
      base = here.split('::'); while (segs[0] === 'super') { base.pop(); segs = segs.slice(1) }
    } else {
      const other = [...this.crates.values()].find(c => c.name === segs[0])
      if (!other) return
      base = [other.dir]; segs = segs.slice(1)
    }
    // the longest prefix that is a module; the rest are items inside it
    for (let n = segs.length; n >= 0; n--) {
      const f = this.rustMods.get([...base, ...segs.slice(0, n)].join('::'))
      if (f) return f
    }
  }
  private js(from: string, spec: string) {
    if (!spec.startsWith('.')) return
    const p = posix.normalize(posix.join(dirname(from), spec))
    const stem = p.replace(/\.(m|c)?js$/, '')
    const cands = [p, ...['ts', 'tsx', 'js', 'jsx', 'mjs', 'mts'].flatMap(e => [`${p}.${e}`, `${stem}.${e}`, `${p}/index.${e}`])]
    return cands.find(c => this.files.has(c))
  }
  private python(from: string, i: Imp) {
    const m = i.spec.match(/^(\.*)(.*)$/)!, dots = m[1].length
    const rel = m[2].replaceAll('.', '/')
    const bases = dots ? [posix.join(dirname(from), ...Array(dots - 1).fill('..'))] : ['', dirname(from), 'src']
    for (const b of bases) {
      const p = posix.normalize(posix.join(b, rel))
      for (const name of i.names) {
        const sub = [`${p}/${name}.py`, `${p}/${name}/__init__.py`].find(c => this.py.has(c)); if (sub) return sub
      }
      const f = [`${p}.py`, `${p}/__init__.py`].find(c => this.py.has(c)); if (f) return f
    }
  }
}

// ---- building the graph -------------------------------------------------------------

export async function buildGraph(worktree: string, changed: Map<string, { additions: number; deletions: number }>): Promise<GraphData> {
  const t0 = performance.now()
  const langs = await languages()
  const ls = (await Bun.$`git ls-files -z`.cwd(worktree).quiet().text()).split('\0').filter(Boolean)
  const all = ls.filter(p => EXT[p.split('.').pop()!.toLowerCase()] && !SKIP.test(p)).slice(0, MAX_FILES)
  const cargo = new Map<string, string>()
  await Promise.all(ls.filter(p => p.endsWith('Cargo.toml')).map(async p => {
    const name = (await Bun.file(join(worktree, p)).text()).match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1]
    if (name && /\[package\]/.test(await Bun.file(join(worktree, p)).text())) cargo.set(dirname(p) === '.' ? '' : dirname(p), name)
  }))

  const parsed = new Map<string, Parsed>()
  const parser = new Parser()
  for (const p of all) {
    const lang = EXT[p.split('.').pop()!.toLowerCase()]
    const f = Bun.file(join(worktree, p))
    if (f.size > MAX_BYTES) continue
    parser.setLanguage(langs.get(lang)!)
    const tree = parser.parse(await f.text())
    if (!tree) continue
    parsed.set(p, extract(lang, tree.rootNode))
    tree.delete()
  }
  parser.delete()

  const res = new Resolver([...parsed.keys()], cargo, new Set([...parsed.keys()].filter(p => p.endsWith('.py'))))
  res.indexRust(parsed)

  const edges = new Map<string, { from: string; to: string; names: Set<string>; line: number; kinds: Set<string> }>()
  const external = new Map<string, number>()
  for (const [from, pf] of parsed) {
    const lang = EXT[from.split('.').pop()!.toLowerCase()]
    for (const i of pf.imports) {
      const to = res.resolve(lang, from, i)
      if (!to) { if (i.kind !== 'mod') external.set(from, (external.get(from) ?? 0) + 1); continue }
      if (to === from) continue
      const k = `${from}\0${to}`
      const e = edges.get(k) ?? { from, to, names: new Set(), line: i.line, kinds: new Set() }
      i.names.forEach(n => n && e.names.add(n)); e.kinds.add(i.kind)
      edges.set(k, e)
    }
  }

  const degree = new Map<string, number>()
  for (const e of edges.values()) { degree.set(e.from, (degree.get(e.from) ?? 0) + 1); degree.set(e.to, (degree.get(e.to) ?? 0) + 1) }
  const nodes: GraphNode[] = []
  for (const [path, pf] of parsed) {
    const c = changed.get(path)
    if (!c && !degree.has(path)) continue // isolated and untouched
    nodes.push({
      path, lang: EXT[path.split('.').pop()!.toLowerCase()], lines: pf.lines, defs: pf.defs.slice(0, 60),
      changed: !!c, additions: c?.additions ?? 0, deletions: c?.deletions ?? 0, external: external.get(path) ?? 0,
    })
  }
  return {
    nodes,
    edges: [...edges.values()].map(e => ({ from: e.from, to: e.to, names: [...e.names].slice(0, 12), line: e.line, kind: [...e.kinds][0] as GraphData['edges'][0]['kind'] })),
    stats: { files: parsed.size, ms: Math.round(performance.now() - t0), capped: all.length >= MAX_FILES },
  }
}
