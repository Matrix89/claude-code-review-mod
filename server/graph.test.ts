import { test, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { buildGraph } from './graph'

function repo(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), 'graph-'))
  for (const [p, s] of Object.entries(files)) { mkdirSync(dirname(join(dir, p)), { recursive: true }); writeFileSync(join(dir, p), s) }
  Bun.spawnSync(['git', 'init', '-q'], { cwd: dir }); Bun.spawnSync(['git', 'add', '-A'], { cwd: dir })
  return dir
}
const has = (g: Awaited<ReturnType<typeof buildGraph>>, a: string, b: string) => g.edges.some(e => e.from === a && e.to === b)

test('rust: mod declarations, crate/super paths and workspace crates', async () => {
  const dir = repo({
    'a/Cargo.toml': '[package]\nname = "a-core"\n',
    'a/src/lib.rs': 'pub mod util;\nmod net;\npub struct Hub;\n',
    'a/src/util.rs': 'use crate::net::{Sock, tcp::Conn};\nuse super::Hub;\nfn helper() {}\n',
    'a/src/net/mod.rs': 'pub mod tcp;\npub struct Sock;\n',
    'a/src/net/tcp.rs': 'pub struct Conn;\n',
    'b/Cargo.toml': '[package]\nname = "b"\n',
    'b/src/main.rs': 'use a_core::util::helper;\nfn main() {}\n',
  })
  const g = await buildGraph(dir, new Map([['a/src/util.rs', { additions: 2, deletions: 1 }]]))
  expect(has(g, 'a/src/lib.rs', 'a/src/util.rs')).toBe(true)
  expect(has(g, 'a/src/util.rs', 'a/src/net/mod.rs')).toBe(true)
  expect(has(g, 'a/src/util.rs', 'a/src/net/tcp.rs')).toBe(true)
  expect(has(g, 'a/src/util.rs', 'a/src/lib.rs')).toBe(true)
  expect(has(g, 'b/src/main.rs', 'a/src/util.rs')).toBe(true)
  expect(g.nodes.find(n => n.path === 'a/src/util.rs')).toMatchObject({ changed: true, additions: 2 })
  expect(g.nodes.find(n => n.path === 'a/src/util.rs')!.defs.map(d => d.name)).toContain('helper')
})

test('typescript and python imports', async () => {
  const dir = repo({
    'web/app.ts': "import { x } from './lib/x'\nimport React from 'react'\nexport * from './y.js'\n",
    'web/lib/x.ts': 'export const x = 1\n',
    'web/y.ts': 'export const y = 1\n',
    'py/main.py': 'from pkg import mod\nfrom . import sibling\nimport os\n',
    'py/pkg/__init__.py': '',
    'py/pkg/mod.py': 'def f(): pass\n',
    'py/sibling.py': '',
  })
  const g = await buildGraph(dir, new Map())
  expect(has(g, 'web/app.ts', 'web/lib/x.ts')).toBe(true)
  expect(has(g, 'web/app.ts', 'web/y.ts')).toBe(true)
  expect(g.nodes.find(n => n.path === 'web/app.ts')!.external).toBe(1)
  expect(has(g, 'py/main.py', 'py/sibling.py')).toBe(true)
})
