import { describe, expect, test } from 'bun:test'
import { escapeHtml, highlightLines, langFor, parseDiff } from './diff'

const countOf = (s: string, sub: string) => s.split(sub).length - 1

describe('parseDiff', () => {
  test('rename with hunk context', () => {
    const [f] = parseDiff([
      'diff --git a/src/a.ts b/src/b.ts',
      'similarity index 90%',
      'rename from src/a.ts',
      'rename to src/b.ts',
      'index 1..2 100644',
      '--- a/src/a.ts',
      '+++ b/src/b.ts',
      '@@ -1,2 +1,2 @@ export function f',
      ' keep',
      '-x',
      '+y',
    ].join('\n'))!
    expect(f.status).toBe('renamed')
    expect(f.oldPath).toBe('src/a.ts')
    expect(f.path).toBe('src/b.ts')
    expect(f.additions).toBe(1)
    expect(f.deletions).toBe(1)
    const h = f.hunks[0]!
    expect(h.header).toBe('export function f')
    expect(h.lines).toEqual([
      { t: 'ctx', old: 1, new: 1, text: 'keep' },
      { t: 'del', old: 2, text: 'x' },
      { t: 'add', new: 2, text: 'y' },
    ])
  })

  test('binary, added, deleted and multi-file with omitted hunk counts', () => {
    const files = parseDiff([
      'diff --git a/img.png b/img.png',
      'index 1..2 100644',
      'Binary files a/img.png and b/img.png differ',
      'diff --git a/new.txt b/new.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new.txt',
      '@@ -0,0 +1 @@',
      '+hello',
      'diff --git a/old.txt b/old.txt',
      'deleted file mode 100644',
      '--- a/old.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '--- gone',
    ].join('\n'))
    expect(files.map(f => [f.path, f.status, f.binary])).toEqual([
      ['img.png', 'modified', true],
      ['new.txt', 'added', false],
      ['old.txt', 'deleted', false],
    ])
    expect(files[0]!.hunks).toEqual([])
    expect(files[1]!.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 1 })
    expect(files[1]!.additions).toBe(1)
    // "--- gone" inside a hunk is a deleted line, not a header
    expect(files[2]!.hunks[0]!.lines).toEqual([{ t: 'del', old: 1, text: '-- gone' }])
    expect(files[2]!.deletions).toBe(1)
  })

  test('no-newline marker is ignored', () => {
    const [f] = parseDiff([
      'diff --git a/a.txt b/a.txt',
      'index 1..2 100644',
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1 +1 @@',
      '-old',
      '\\ No newline at end of file',
      '+new',
      '\\ No newline at end of file',
    ].join('\n'))!
    expect(f.hunks[0]!.lines.map(l => [l.t, l.text])).toEqual([['del', 'old'], ['add', 'new']])
    expect(f.additions).toBe(1)
    expect(f.deletions).toBe(1)
  })
})

describe('highlightLines', () => {
  test('multi-line rust comment keeps spans balanced per line', () => {
    const lines = highlightLines('/* a\n b */ fn x(){}', 'lib.rs')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('hljs-comment')
    for (const l of lines) expect(countOf(l, '<span')).toBe(countOf(l, '</span>'))
    expect(lines[1]).toContain('hljs-comment')
  })

  test('trailing newline yields no extra line, empty lines stay empty', () => {
    expect(highlightLines('a\nb\n', 'notes.txt')).toEqual(['a', 'b'])
    expect(highlightLines('a\r\n\r\nb\r\n', 'x.unknown')).toEqual(['a', '', 'b'])
    expect(highlightLines('/* x\n\n y */', 'a.c')[1]).toBe('')
  })

  test('escapes HTML in unknown languages', () => {
    expect(highlightLines('<b>&', 'x.zzz')).toEqual(['&lt;b&gt;&amp;'])
  })
})

describe('helpers', () => {
  test('escapeHtml', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })

  test('langFor', () => {
    expect(langFor('src/main.rs')).toBe('rust')
    expect(langFor('ui/App.tsx')).toBe('typescript')
    expect(langFor('docker/Dockerfile')).toBe('dockerfile')
    expect(langFor('Makefile')).toBe('makefile')
    expect(langFor('config.toml')).toBe('ini')
    expect(langFor('README')).toBeUndefined()
  })
})
