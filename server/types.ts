// Shared contracts between server modules. Do not change without updating all users.

export interface DiffLine {
  t: 'ctx' | 'add' | 'del'
  old?: number // 1-based line in the base file (ctx, del)
  new?: number // 1-based line in the head file (ctx, add)
  text: string // raw line text without the leading +/-/space
}
export interface Hunk {
  header: string // text after the second @@ (function context), may be ''
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}
export interface DiffFile {
  path: string // head path (or base path when deleted)
  oldPath?: string // set when renamed
  status: 'added' | 'deleted' | 'modified' | 'renamed'
  binary: boolean
  additions: number
  deletions: number
  hunks: Hunk[]
}

export interface PrMeta {
  repo: string // owner/name
  number: number
  title: string
  body: string
  author: string
  url: string
  baseRef: string
  headRef: string
  baseSha: string
  headSha: string
  additions: number
  deletions: number
  changedFiles: number
}

export interface ReviewComment {
  id: string // GraphQL node id of the comment
  threadId?: string
  path: string
  line: number | null // line in `side`
  startLine?: number | null
  side: 'LEFT' | 'RIGHT'
  author: string
  body: string
  isPending: boolean // part of the viewer's pending (draft) review
  isOutdated: boolean
  isResolved: boolean
  createdAt: string
  replyTo?: string // id of the thread's first comment when this is a reply
}

export type LspKind = 'hover' | 'references' | 'definition' | 'declaration' | 'highlight'
export interface LspLocation {
  path: string // repo-relative path
  line: number // 1-based
  col: number // 1-based
  endLine: number
  endCol: number
  preview: string // the text of that source line, trimmed
  /** project: inside the worktree; dependency: inside it but vendored (node_modules, target, .venv...); external: outside it */
  origin: 'project' | 'dependency' | 'external'
  pkg?: string // e.g. "crate serde 1.0.200", "npm @types/node 22.1.0", "Rust std (core)"
}
export interface LspResult {
  status: 'ok' | 'indexing' | 'unsupported' | 'error'
  message?: string
  hover?: string
  hoverFormat?: 'markdown' | 'plaintext' // how `hover` is to be rendered
  locations?: LspLocation[]
}

export interface GraphDef { name: string; kind: string; line: number }
export interface GraphNode {
  path: string; lang: string; lines: number
  defs: GraphDef[] // top-level items, for the node's detail
  changed: boolean; additions: number; deletions: number
  external: number // imports that leave the repo (crates, npm packages, system headers)
}
export interface GraphEdge { from: string; to: string; names: string[]; line: number; lines: number[]; kind: 'use' | 'mod' | 'import' | 'include' }
export interface GraphData { nodes: GraphNode[]; edges: GraphEdge[]; stats: { files: number; ms: number; capped: boolean } }
