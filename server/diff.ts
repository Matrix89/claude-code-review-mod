import hljs from 'highlight.js'
import type { DiffFile, Hunk } from './types'

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/
const MAX_HIGHLIGHT = 2 * 1024 * 1024

export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  let file: DiffFile | undefined
  let hunk: Hunk | undefined
  let oldLeft = 0, newLeft = 0, oldNo = 0, newNo = 0

  for (const line of text.split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      const ch = line[0]
      if (ch === '\\') continue
      const f = file as DiffFile
      if (ch === '+') {
        hunk.lines.push({ t: 'add', new: newNo++, text: line.slice(1) })
        newLeft--; f.additions++
      } else if (ch === '-') {
        hunk.lines.push({ t: 'del', old: oldNo++, text: line.slice(1) })
        oldLeft--; f.deletions++
      } else {
        hunk.lines.push({ t: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) })
        oldLeft--; newLeft--
      }
      continue
    }

    if (line.startsWith('diff --git ')) {
      file = startFile(line.slice(11))
      files.push(file)
      hunk = undefined
      oldLeft = newLeft = 0
    } else if (file && line.startsWith('@@')) {
      const m = HUNK_RE.exec(line)
      if (!m) continue
      oldNo = +m[1]; oldLeft = m[2] === undefined ? 1 : +m[2]
      newNo = +m[3]; newLeft = m[4] === undefined ? 1 : +m[4]
      hunk = { header: m[5] ?? '', oldStart: oldNo, oldLines: oldLeft, newStart: newNo, newLines: newLeft, lines: [] }
      file.hunks.push(hunk)
    } else if (file) {
      if (line.startsWith('rename from ')) { file.oldPath = line.slice(12); file.status = 'renamed' }
      else if (line.startsWith('rename to ')) file.path = line.slice(10)
      else if (line.startsWith('new file mode')) file.status = 'added'
      else if (line.startsWith('deleted file mode')) file.status = 'deleted'
      else if (line.startsWith('Binary files ') || line === 'GIT binary patch') file.binary = true
    }
  }
  return files
}

// `rest` is "a/<path> b/<path>". Unrenamed files have equal halves, so check that split first;
// this keeps paths containing " b/" intact. Renames are corrected by the rename lines.
function startFile(rest: string): DiffFile {
  const n = (rest.length - 5) / 2
  const at = Number.isInteger(n) && rest.slice(n + 2, n + 5) === ' b/' ? n + 2 : rest.indexOf(' b/')
  return { path: rest.slice(at + 3), status: 'modified', binary: false, additions: 0, deletions: 0, hunks: [] }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ESC[c]!)
}
const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

const LANG_BY_EXT = new Map(Object.entries({
  rs: 'rust', ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', go: 'go', java: 'java', kt: 'kotlin', kts: 'kotlin',
  c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', sh: 'bash', bash: 'bash', zsh: 'bash',
  json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', md: 'markdown',
  html: 'xml', htm: 'xml', xml: 'xml', css: 'css', scss: 'scss', sql: 'sql', lua: 'lua',
}))
const LANG_BY_NAME = new Map([['dockerfile', 'dockerfile'], ['makefile', 'makefile'], ['gnumakefile', 'makefile']])

export function langFor(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1)
  const byName = LANG_BY_NAME.get(base.toLowerCase())
  if (byName) return byName
  const dot = base.lastIndexOf('.')
  return dot > 0 ? LANG_BY_EXT.get(base.slice(dot + 1).toLowerCase()) : undefined
}

export function highlightLines(content: string, path: string): string[] {
  if (content === '') return []
  const src = content.includes('\r') ? content.replaceAll('\r\n', '\n') : content
  const body = src.endsWith('\n') ? src.slice(0, -1) : src
  const lines = body.split('\n')
  const lang = langFor(path)
  if (!lang || content.length > MAX_HIGHLIGHT || !hljs.getLanguage(lang)) return lines.map(escapeHtml)
  const html = hljs.highlight(body, { language: lang, ignoreIllegals: true }).value
  const out = splitBalanced(html)
  return lines.map((l, i) => (l === '' ? '' : out[i] ?? escapeHtml(l)))
}

// Splits hljs HTML on newlines. Spans open at a newline are closed at its end and reopened on the next line.
function splitBalanced(html: string): string[] {
  const out: string[] = []
  const open: string[] = []
  let buf: string[] = []
  let i = 0
  while (i < html.length) {
    const nl = html.indexOf('\n', i)
    const lt = html.indexOf('<', i)
    const stop = nl === -1 ? lt : lt === -1 ? nl : Math.min(nl, lt)
    if (stop === -1) { buf.push(html.slice(i)); break }
    buf.push(html.slice(i, stop))
    if (html[stop] === '\n') {
      out.push(buf.join('') + '</span>'.repeat(open.length))
      buf = [...open]
      i = stop + 1
    } else {
      const end = html.indexOf('>', stop) + 1
      const tag = html.slice(stop, end)
      if (tag === '</span>') open.pop()
      else open.push(tag)
      buf.push(tag)
      i = end
    }
  }
  out.push(buf.join(''))
  return out
}
