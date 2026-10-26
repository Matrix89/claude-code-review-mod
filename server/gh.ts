import { existsSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { PrMeta, ReviewComment } from './types'

const CACHE = join(homedir(), '.cache', 'pr-review')

export async function run(argv: string[], cwd?: string): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  if (code !== 0) throw new Error(err.trim() || `${argv[0]} exited with ${code}`)
  return out
}

// Strings go via -f (never interpreted), ints via -F.
async function gql(query: string, vars: Record<string, string | number | undefined> = {}): Promise<any> {
  const args = ['gh', 'api', 'graphql', '-f', `query=${query}`]
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) continue
    args.push(typeof v === 'number' ? '-F' : '-f', `${k}=${v}`)
  }
  const res = JSON.parse(await run(args))
  if (res.errors?.length) throw new Error(res.errors.map((e: any) => e.message).join('; '))
  return res.data
}

export async function parsePrRef(input: string, cwd: string): Promise<{ repo: string; number: number }> {
  const s = input.trim()
  const bare = s.match(/^#?(\d+)$/)
  if (bare) {
    let repo: string
    try {
      repo = (await run(['gh', 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], cwd)).trim()
    } catch (e) {
      throw new Error(`Cannot resolve repo from ${cwd} (${(e as Error).message}). Use owner/repo#${bare[1]} instead.`)
    }
    return { repo, number: Number(bare[1]) }
  }
  const short = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/)
  if (short) return { repo: short[1], number: Number(short[2]) }
  const url = s.match(/^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/)
  if (url) return { repo: url[1], number: Number(url[2]) }
  throw new Error(`Unrecognized PR reference "${input}". Use 123, #123, owner/repo#123 or a github.com pull URL.`)
}

export async function fetchMeta(repo: string, n: number): Promise<PrMeta> {
  const j = JSON.parse(
    await run([
      'gh', 'pr', 'view', String(n), '-R', repo, '--json',
      'title,body,author,url,baseRefName,headRefName,baseRefOid,headRefOid,additions,deletions,changedFiles',
    ]),
  )
  return {
    repo,
    number: n,
    title: j.title,
    body: j.body ?? '',
    author: j.author?.login ?? '',
    url: j.url,
    baseRef: j.baseRefName,
    headRef: j.headRefName,
    baseSha: j.baseRefOid,
    headSha: j.headRefOid,
    additions: j.additions,
    deletions: j.deletions,
    changedFiles: j.changedFiles,
  }
}

async function originRepo(cwd: string, repo: string): Promise<string | undefined> {
  try {
    const top = (await run(['git', 'rev-parse', '--show-toplevel'], cwd)).trim()
    const url = (await run(['git', 'remote', 'get-url', 'origin'], top)).trim().toLowerCase()
    const norm = url.replace(/\/$/, '').replace(/\.git$/, '')
    const want = repo.toLowerCase()
    return norm.endsWith(`/${want}`) || norm.endsWith(`:${want}`) ? top : undefined
  } catch {
    return undefined
  }
}

async function cacheRepo(repo: string): Promise<string> {
  const dir = join(CACHE, 'repos', repo.replace('/', '__'))
  if (!existsSync(dir)) {
    await mkdir(dirname(dir), { recursive: true })
    try {
      await run(['git', 'clone', '--filter=blob:none', '--no-checkout', `https://github.com/${repo}.git`, dir])
    } catch {
      await rm(dir, { recursive: true, force: true })
      await run(['gh', 'repo', 'clone', repo, dir, '--', '--filter=blob:none', '--no-checkout'])
    }
  }
  return dir
}

export async function prepareWorktree(
  repo: string,
  n: number,
  headSha: string,
  baseSha: string,
  cwd: string,
): Promise<{ worktree: string; localRepo: string }> {
  const localRepo = (await originRepo(cwd, repo)) ?? (await cacheRepo(repo))
  await run(['git', 'fetch', 'origin', `pull/${n}/head`], localRepo)
  await run(['git', 'fetch', 'origin', baseSha], localRepo).catch(() =>
    run(['git', 'cat-file', '-e', `${baseSha}^{commit}`], localRepo),
  )

  const worktree = join(CACHE, 'wt', `${repo.replace('/', '__')}__${n}`)
  if (existsSync(worktree)) {
    const head = (await run(['git', 'rev-parse', 'HEAD'], worktree)).trim()
    if (head !== headSha) await run(['git', 'checkout', '--detach', headSha], worktree)
  } else {
    await mkdir(dirname(worktree), { recursive: true })
    await run(['git', 'worktree', 'add', '--detach', worktree, headSha], localRepo)
  }
  return { worktree, localRepo }
}

let login: string | undefined
export async function viewer(): Promise<string> {
  return (login ??= (await run(['gh', 'api', 'user', '-q', '.login'])).trim())
}

const THREADS = `query($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){ pullRequest(number:$number){
    reviewThreads(first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{ id isResolved isOutdated path line startLine diffSide
        comments(first:100){ nodes{ id body createdAt author{login} pullRequestReview{state} } } } } } } }`

function mapComment(c: any, t: any, replyTo?: string): ReviewComment {
  return {
    id: c.id,
    threadId: t.id,
    path: t.path,
    line: t.line ?? null,
    startLine: t.startLine ?? null,
    side: t.diffSide,
    author: c.author?.login ?? 'ghost',
    body: c.body,
    isPending: c.pullRequestReview?.state === 'PENDING',
    isOutdated: t.isOutdated,
    isResolved: t.isResolved,
    createdAt: c.createdAt,
    replyTo,
  }
}

export async function listComments(repo: string, n: number): Promise<ReviewComment[]> {
  const [owner, name] = repo.split('/')
  const out: ReviewComment[] = []
  let cursor: string | undefined
  do {
    const rt = (await gql(THREADS, { owner, name, number: n, cursor })).repository.pullRequest.reviewThreads
    for (const t of rt.nodes) {
      const [first, ...rest] = t.comments.nodes
      out.push(mapComment(first, t))
      for (const c of rest) out.push(mapComment(c, t, first.id))
    }
    cursor = rt.pageInfo.hasNextPage ? rt.pageInfo.endCursor : undefined
  } while (cursor)
  return out
}

export async function getDiff(localRepo: string, baseSha: string, headSha: string, context = 3): Promise<string> {
  return run(['git', 'diff', '--no-color', '--no-ext-diff', '-M', `-U${context}`, `${baseSha}...${headSha}`], localRepo)
}

const pendingCache = new Map<string, { prId: string; reviewId?: string }>()

async function pendingReview(repo: string, n: number) {
  const key = `${repo}#${n}`
  let c = pendingCache.get(key)
  if (!c) {
    const [owner, name] = repo.split('/')
    const pr = (
      await gql(
        `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
          id reviews(states:[PENDING],first:10){nodes{id author{login}}}}}}`,
        { owner, name, number: n },
      )
    ).repository.pullRequest
    const me = await viewer()
    c = { prId: pr.id, reviewId: pr.reviews.nodes.find((r: any) => r.author?.login === me)?.id }
    pendingCache.set(key, c)
  }
  if (!c.reviewId) {
    c.reviewId = (
      await gql(
        `mutation($id:ID!){addPullRequestReview(input:{pullRequestId:$id}){pullRequestReview{id}}}`,
        { id: c.prId },
      )
    ).addPullRequestReview.pullRequestReview.id
  }
  return { key, reviewId: c.reviewId }
}

export async function addPendingComment(
  repo: string,
  n: number,
  c: { path: string; line: number; startLine?: number; side: 'LEFT' | 'RIGHT'; body: string },
): Promise<ReviewComment> {
  const { key, reviewId } = await pendingReview(repo, n)
  try {
    const t = (
      await gql(
        `mutation($rid:ID!,$path:String!,$line:Int!,$side:DiffSide!,$startLine:Int,$startSide:DiffSide,$body:String!){
          addPullRequestReviewThread(input:{pullRequestReviewId:$rid,path:$path,line:$line,side:$side,
            startLine:$startLine,startSide:$startSide,body:$body}){
            thread{ id path line startLine diffSide isOutdated isResolved comments(first:1){nodes{id body createdAt author{login}}} } } }`,
        {
          rid: reviewId,
          path: c.path,
          line: c.line,
          side: c.side,
          startLine: c.startLine,
          startSide: c.startLine === undefined ? undefined : c.side,
          body: c.body,
        },
      )
    ).addPullRequestReviewThread.thread
    const first = t.comments.nodes[0]
    return {
      id: first.id,
      threadId: t.id,
      path: t.path,
      line: t.line ?? null,
      startLine: t.startLine ?? null,
      side: t.diffSide,
      author: first.author?.login ?? (await viewer()),
      body: first.body,
      isPending: true,
      isOutdated: t.isOutdated,
      isResolved: t.isResolved,
      createdAt: first.createdAt,
    }
  } catch (e) {
    pendingCache.delete(key) // review may have been submitted or deleted; re-resolve next time
    throw e
  }
}

export async function deletePendingComment(commentId: string): Promise<void> {
  await gql(
    `mutation($id:ID!){deletePullRequestReviewComment(input:{id:$id}){pullRequestReview{id}}}`,
    { id: commentId },
  )
}

const prIds = new Map<string, string>()

async function prNodeId(repo: string, n: number): Promise<string> {
  const key = `${repo}#${n}`
  let id = prIds.get(key)
  if (!id) {
    const [owner, name] = repo.split('/')
    id = (await gql(`query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id}}}`, { owner, name, number: n })).repository.pullRequest.id as string
    prIds.set(key, id)
  }
  return id
}

/** Paths the viewer has marked "Viewed" on GitHub (a file changed since is DISMISSED and counts as not viewed). */
export async function viewedFiles(repo: string, n: number): Promise<string[]> {
  const [owner, name] = repo.split('/')
  const out: string[] = []
  let cursor: string | undefined
  do {
    const pr = (await gql(
      `query($owner:String!,$name:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$name){pullRequest(number:$number){
        id files(first:100,after:$cursor){ pageInfo{hasNextPage endCursor} nodes{ path viewerViewedState } } } } }`,
      { owner, name, number: n, cursor },
    )).repository.pullRequest
    prIds.set(`${repo}#${n}`, pr.id)
    for (const f of pr.files.nodes) if (f.viewerViewedState === 'VIEWED') out.push(f.path)
    cursor = pr.files.pageInfo.hasNextPage ? pr.files.pageInfo.endCursor : undefined
  } while (cursor)
  return out
}

export async function setViewed(repo: string, n: number, path: string, viewed: boolean): Promise<void> {
  const id = await prNodeId(repo, n)
  const op = viewed ? 'markFileAsViewed' : 'unmarkFileAsViewed'
  await gql(`mutation($id:ID!,$path:String!){${op}(input:{pullRequestId:$id,path:$path}){clientMutationId}}`, { id, path })
}

export function reviewUrl(repo: string, n: number): string {
  return `https://github.com/${repo}/pull/${n}/files`
}
