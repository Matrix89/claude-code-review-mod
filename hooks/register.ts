import type { Register } from 'claude-code'

interface Ready { host: string; port: number; token: string }
interface Turn { id: string; text: string; step: number; sentAt: number; chain: Promise<unknown> }

// POSTs the reply so far (cumulative), in order, to the review server
function post($: { process: { run: (argv: readonly string[]) => Promise<unknown> } }, ready: Promise<Ready>, t: Turn, done: boolean) {
  const body = JSON.stringify({ id: t.id, text: t.text, done })
  t.chain = t.chain.then(async () => {
    const { host, port, token } = await ready
    await $.process.run(['curl', '-sS', '-X', 'POST', '-H', `x-token: ${token}`, '-d', body, `http://${host}:${port}/api/stream`]).catch(() => undefined)
  })
  return t.chain
}

// a wildcard bind (PR_REVIEW_HOST=0.0.0.0) is reached through loopback; an IPv6 address needs brackets in a URL
function connectHost(bound = '127.0.0.1') {
  if (bound === '0.0.0.0') return '127.0.0.1'
  if (bound === '::') return '[::1]'
  return bound.includes(':') ? `[${bound}]` : bound
}

export const register: Register = on => {
  let cwd = ''
  let resolveReady: (r: Ready) => void = () => {}
  const ready = new Promise<Ready>(res => (resolveReady = res))

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    cwd = e.cwd

    await $.tool.register({
      name: 'review_pr',
      description:
        'Start the browser PR review UI for a GitHub pull request and open it for the user. ' +
        'Use when the user wants to review a PR. Questions the user asks in the page arrive here as prompts; just answer them in chat, the reply streams into the page.',
      inputSchema: {
        type: 'object',
        properties: {
          pr: { type: 'string', description: 'PR number, owner/repo#123, or a github.com pull request URL' },
          cwd: { type: 'string', description: 'Absolute path of a local checkout of the repo, reused for the PR worktree (default: the session directory)' },
        },
        required: ['pr'],
      },
      isDeferred: false,
    })
    await $.tool.register({
      name: 'answer',
      description: 'Optional: post text into a PR-review chat thread (id like "q3"). Normally unnecessary, replies to review questions stream to the page automatically.',
      inputSchema: {
        type: 'object',
        properties: { id: { type: 'string' }, text: { type: 'string' } },
        required: ['id', 'text'],
      },
      isDeferred: false,
    })

    void (async () => {
      let buf = ''
      // a fresh install has no node_modules: fetch the two locked dependencies once
      const dir = `${$.plugin.root}/server`
      if (!(await $.fs.exists(`${dir}/node_modules`))) {
        await $.process.run(['bun', 'install', '--frozen-lockfile'], { cwd: dir, timeoutMs: 180_000 }).catch(() => undefined)
      }
      const server = $.process.spawn({ argv: ['bun', `${dir}/index.ts`] })
      for await (const piece of server) {
        if (!('text' in piece) || piece.stream !== 'stdout') continue
        buf += piece.text
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          let msg: { type: string; prompt?: string; host?: string; port?: number; token?: string }
          try { msg = JSON.parse(line) } catch { continue }
          if (msg.type === 'ready') resolveReady({ host: connectHost(msg.host), port: msg.port!, token: msg.token! })
          else if (msg.type === 'ask' && msg.prompt) void $.prompt.submit({ text: msg.prompt })
        }
      }
    })()
    return started
  })

  on('tool.call', { tool: 'mcp__pr-review__review_pr' }, async ($, e) => {
    const { host, port, token } = await ready
    const { pr = '', cwd: dir } = e as unknown as { pr?: string; cwd?: string }
    const url = `http://${host}:${port}/?t=${token}&pr=${encodeURIComponent(pr)}&cwd=${encodeURIComponent(dir || cwd)}`
    await $.process.run(['xdg-open', url]).catch(() => undefined)
    return { result: `Opened the review page for ${pr}. Questions from the reviewer will arrive as prompts; answer them in chat and the reply streams into the page. Page: ${url.replace(/t=[^&]+/, 't=…')}` }
  })

  on('tool.call', { tool: 'mcp__pr-review__answer' }, async ($, e) => {
    const { host, port, token } = await ready
    const { id, text } = e as unknown as { id: string; text: string }
    const r = await $.process.run([
      'curl', '-sS', '-X', 'POST', '-H', `x-token: ${token}`, '-d', JSON.stringify({ id, text }),
      `http://${host}:${port}/api/answer`,
    ])
    return r.exitCode === 0 && !r.stdout.includes('"error"')
      ? { result: 'Posted.' }
      : { deny: `Could not post the answer: ${r.stdout || r.stderr}` }
  })

  // Replies to review questions stream into the page: the text of the turn that answers a question is posted as it arrives.
  const turns = new Map<string, Turn>()
  on('turn.start', async ($, e, next) => {
    const m = e.agentId === undefined ? /^(?:The [\w-]+ plugin sent a message:\s*)?PR review (?:question|follow-up) (q\d+)/.exec(e.text) : null
    if (m) turns.set(e.turnId, { id: m[1], text: '', step: -1, sentAt: 0, chain: Promise.resolve() })
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    const t = e.agentId === undefined ? turns.get(e.turnId) : undefined
    for await (const chunk of next(e)) {
      if (t && chunk.kind === 'text') {
        if (e.index !== t.step) { if (t.text) t.text += '\n\n'; t.step = e.index }
        t.text += chunk.text
        const now = Date.now()
        if (now - t.sentAt > 90) { t.sentAt = now; void post($, ready, t, false) }
      }
      yield chunk
    }
  })

  on('turn.complete', async ($, e, next) => {
    const t = turns.get(e.turnId)
    const done = await next(e)
    if (t) {
      turns.delete(e.turnId)
      if (e.reason === 'aborted' && t.text) t.text += '\n\n*(interrupted)*'
      await post($, ready, t, true)
    }
    return done
  })
}
