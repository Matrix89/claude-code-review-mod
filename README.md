# pr-review

A Claude mod for reviewing GitHub pull requests in the browser. Tell Claude "review PR 123" and it starts a local
server and opens the page.

- Syntax-highlighted unified diff with every row in the DOM (no virtual rendering), so Ctrl+F works; it stays smooth on
  PRs of 10k+ lines.
- Inline comments and `suggestion` blocks, added to your **pending** GitHub review; drag across line numbers for ranges.
- "Ask Claude" opens a streaming chat under the line, answered by the Claude session that opened the page.
- Language-server intelligence (rust-analyzer, typescript-language-server, pyright, gopls, clangd): click a symbol for
  docs, definition, trait declaration and references, hover to highlight usages, a Jumps tab to get back.
- File-type icons, per-file comment counts, and the "Viewed" checkbox synced with GitHub.
- An always-visible scratchpad for notes.

## Install

At the prompt of a terminal session:

```
/plugin install pr-review --marketplace Matrix89/claude-code-review-mod
```

From a shell:

```
claude plugin install pr-review --marketplace Matrix89/claude-code-review-mod
```

The repository is private: it installs only for people who can read it on GitHub and whose machine holds a git
credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).

## Needs

- [`bun`](https://bun.sh) and `git`
- [`gh`](https://cli.github.com), signed in (`gh auth login`) with access to the repositories you review
- Optional language servers on `PATH`; for Rust, `rustup component add rust-analyzer`

The first start runs `bun install` for the server's two dependencies. The PR head is checked out as a git worktree under
`~/.cache/pr-review` (your own checkout is reused when you pass its path as `cwd`).

The server listens on `127.0.0.1` only. To open the page from another machine (a dev VM, a box behind a jump host), set
`PR_REVIEW_HOST` in the environment Claude starts from, e.g. `PR_REVIEW_HOST=0.0.0.0`, or one interface address. Anyone
who can reach that address and holds the URL's token can read the PR and add comments to your pending review.
Set `PR_REVIEW_PORT` too to keep the same port across restarts, so an ssh tunnel to it stays valid.

## Use

Ask Claude to review a PR (`owner/repo#12`, a PR URL, or a number inside a checkout). Questions asked in the page
arrive in the session as prompts. Nothing is posted to GitHub until you submit the pending review there.
