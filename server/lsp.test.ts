import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FrameParser, LspManager } from './lsp'

const frame = (m: object) => {
  const b = Buffer.from(JSON.stringify(m), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${b.length}\r\n\r\n`, 'ascii'), b])
}
const msgs = [{ jsonrpc: '2.0', id: 1, result: 'héllo ✓' }, { jsonrpc: '2.0', method: 'x', params: { a: [1, 2] } }]
const all = Buffer.concat(msgs.map(frame))

describe('FrameParser', () => {
  test('parses a single chunk with multiple frames', () => {
    expect(new FrameParser().push(all)).toEqual(msgs)
  })

  test('reassembles frames split at every byte boundary', () => {
    for (let cut = 0; cut <= all.length; cut++) {
      const p = new FrameParser()
      const out = [...p.push(all.subarray(0, cut)), ...p.push(all.subarray(cut))]
      expect(out).toEqual(msgs)
    }
  })

  test('feeds one byte at a time, including multi-byte UTF-8', () => {
    const p = new FrameParser()
    const out: any[] = []
    for (const b of all) out.push(...p.push(Uint8Array.of(b)))
    expect(out).toEqual(msgs)
  })

  test('ignores extra headers and waits for a full body', () => {
    const body = Buffer.from('{"id":7}')
    const head = `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\nContent-Length: ${body.length}\r\n\r\n`
    const p = new FrameParser()
    expect(p.push(Buffer.from(head + body.subarray(0, 4)))).toEqual([])
    expect(p.push(body.subarray(4))).toEqual([{ id: 7 }])
  })
})

describe('LspManager unsupported', () => {
  const root = mkdtempSync(join(tmpdir(), 'lsp-unsupported-'))

  test('unknown extension is unsupported', async () => {
    const m = new LspManager(root)
    try {
      const r = await m.query('hover', 'a.zz', 1, 1)
      expect(r.status).toBe('unsupported')
    } finally {
      m.dispose()
    }
  })

  test.skipIf(!!Bun.which('lua-language-server'))('missing binary is unsupported', async () => {
    const m = new LspManager(root)
    try {
      const r = await m.query('definition', 'a.lua', 1, 1)
      expect(r).toEqual({ status: 'unsupported', message: 'lua-language-server not installed' })
      expect(m.status()).toEqual([])
    } finally {
      m.dispose()
    }
  })
})

const hasRustAnalyzer = (() => {
  try {
    return Bun.spawnSync(['rust-analyzer', '--version']).exitCode === 0
  } catch {
    return false
  }
})()

describe('rust-analyzer', () => {
  test.skipIf(!hasRustAnalyzer)(
    'references on a struct field',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'lsp-rs-'))
      const m = new LspManager(root)
      try {
        writeFileSync(join(root, 'Cargo.toml'), '[package]\nname = "lspfix"\nversion = "0.1.0"\nedition = "2021"\n')
        mkdirSync(join(root, 'src'))
        writeFileSync(join(root, 'src/lib.rs'), 'pub struct A { pub x: i32 } fn f(a:&A)->i32{ a.x }\n')
        const t0 = Date.now()
        let r = await m.query('references', 'src/lib.rs', 1, 20)
        while (r.status === 'indexing' && Date.now() - t0 < 30_000) r = await m.query('references', 'src/lib.rs', 1, 20)
        expect(r.status).toBe('ok')
        expect(r.locations!.length).toBeGreaterThanOrEqual(2)
      } finally {
        m.dispose()
        rmSync(root, { recursive: true, force: true })
      }
    },
    60_000,
  )
})
