# FreshQ

**Find GitHub Discussions that were posted minutes ago and still have no answer.**

<p align="center">
  <img src="docs/assets/freshq-discussions-demo.gif" width="880" alt="Animated terminal demo: the freshq command is typed with --since 2h, --unanswered, --zero-comments and --limit 4. It prints four newest-first GitHub Discussions, each with its repository, category, an unanswered label, 0 comments, its age (from just now to 4 minutes) and a link. The command exits with code 0.">
</p>

*Live capture, 2026-10-27 14:52 UTC, against the public GitHub API (read-only; exit code 0). Discussions and ages change by the minute, so a run today will show different results. Discussion titles are written by third parties and are shown unedited.*

<details>
<summary>Text transcript of the demo</summary>

```console
$ freshq --since 2h --unanswered --zero-comments --limit 4
FreshQ · unanswered Q&A, zero-comment discussions created in the last 2h · newest first

1. Zitat zu Folge #313: DEUTSCHLAND WIRD BEIGE
   crorry-dev/GemischtesHack #75 · Q&A · unanswered · 0 comments · just now
   https://github.com/crorry-dev/GemischtesHack/discussions/75

2. How to translate date names to another language?
   GetPublii/Publii #2737 · Help · unanswered · 0 comments · 1m ago
   https://github.com/GetPublii/Publii/discussions/2737

3. Why reder video on laptop amd not work full vga
   jub0t/Concat #564 · Q&A · unanswered · 0 comments · 4m ago
   https://github.com/jub0t/Concat/discussions/564

4. Trying to use Modem73 within linbpq64 (BPQ32) - are others?
   RFnexus/modem73 #96 · Q&A · unanswered · 0 comments · 4m ago
   https://github.com/RFnexus/modem73/discussions/96

4 discussions shown (limit 4; raise it with --limit).
```

Captured 2026-10-27 14:52 UTC with FreshQ 0.1.1 (exit code 0), run from a local build of this repository (`node dist/bin.js`, which is the `freshq` binary) with `--no-color`. Ages such as "just now" and "4m ago" are relative to that capture time. The animation only types and reveals this output; it does not query GitHub itself.

</details>

FreshQ is a small, read-only command-line tool. It searches *all public* GitHub Discussions (or just the repositories and organizations you care about) for questions that were **created** in the last hour, two hours, day or week, and shows the ones nobody has answered yet - newest first, with direct links.

```console
$ freshq --since 2h --unanswered --zero-comments --limit 3
FreshQ · unanswered Q&A, zero-comment discussions created in the last 2h · newest first

1. Where should I store API keys and passwords?
   trustant/trustant #134 · Back-end · unanswered · 0 comments · just now
   https://github.com/orgs/trustant/discussions/134

2. Can different users of the final application have different permissions?
   trustant/trustant #133 · Back-end · unanswered · 0 comments · 1m ago
   https://github.com/orgs/trustant/discussions/133

3. GitHub Actions workflow ends in startup_failure before job creation
   community/community #211346 · Actions · unanswered · 0 comments · 2m ago
   https://github.com/orgs/community/discussions/211346

3 discussions shown (limit 3; raise it with --limit).
```

*(Real output from FreshQ 0.1.0, captured 2026-10-26 21:01 UTC. Nothing here is mocked.)*

## Why

The first helpful answer to a question matters most, and it is usually posted within the first hour. But GitHub gives you no good way to ask "what was asked in the last two hours, across the projects I know about, that nobody has replied to?" The web UI is per-repository, and the raw API has traps that make a naive script quietly return the wrong thing (see [What makes FreshQ accurate](#what-makes-freshq-accurate)).

FreshQ is for maintainers triaging their own discussions, and for people who like helping out in projects they know.

## Install

Requires **Node.js 20+** and a GitHub login - either the [GitHub CLI](https://cli.github.com/) (`gh auth login`) or a `GH_TOKEN` / `GITHUB_TOKEN` environment variable.

```sh
npm install -g @zuhairhalawa/freshq
freshq --help
```

Or run without installing: `npx @zuhairhalawa/freshq --since 1h --unanswered`.

FreshQ has **zero runtime dependencies**.

## Quick start

```sh
# Questions from the last 2 hours with no accepted answer and no comments at all
freshq --since 2h --unanswered --zero-comments

# Everything posted in the last 24h in one repository
freshq --since 24h --repo vercel/next.js

# Q&A-style discussions (answered or not) from the last hour, as JSON
freshq --since 1h --answerable --json

# Unanswered questions mentioning "type error" across an organization, last 7 days
freshq --since 7d --org microsoft --search "type error" --unanswered
```

## Options

| Option | Meaning |
| --- | --- |
| `--since <dur>` | Only discussions **created** within this window: `30m`, `1h`, `2h`, `24h`, `7d`, `2w` (units `m h d w`, max 30 days). Default `24h`. |
| `--unanswered` | Discussions in a Q&A-style category that have **no accepted answer yet**. |
| `--answerable` | Only categories that *support* accepted answers (answered or not). |
| `--zero-comments` | Only discussions with no comments at all. Works in every category. |
| `--repo <owner/name>` | Limit to a repository. Repeatable (OR). |
| `--org <login>` | Limit to an organization or user. Repeatable (OR; combines with `--repo` as OR too). |
| `-s, --search <text>` | Free-text term. Repeatable (AND). Text containing spaces is an exact phrase. |
| `--in <title\|body\|comments>` | Restrict `--search` to one part of the discussion. |
| `--limit <n>` | Maximum results, newest first. Default 30, max 1000. |
| `--json` | Machine-readable JSON on stdout (nothing else is written to stdout). |
| `--no-color` | Disable colors (also honors `NO_COLOR`; colors are off when piped). |
| `--verbose` | Print request count and remaining API quota to stderr. |
| `--max-requests <n>` | Safety cap on API requests per run. Default 60. |

### What "unanswered" means

GitHub only has an *accepted answer* concept in categories configured as Q&A-style ("answerable"). In Ideas, General, Show-and-tell and similar categories, a discussion can never be "answered", so GitHub itself does not count it as unanswered. FreshQ follows GitHub exactly:

- `--unanswered` = answerable category **and** no accepted answer. It never lists "Ideas" or "Announcements" posts as unanswered.
- `--zero-comments` = nobody has commented, in *any* category. Combine with `--unanswered` for the strictest "nobody has even looked" filter.
- In human output, discussions in non-Q&A categories are labelled `no accepted-answer feature` instead of being mislabelled.

### JSON output

```console
$ freshq --since 1h --answerable --json --limit 1     # "author" field omitted here for privacy
{
  "tool": "freshq",
  "version": "0.1.0",
  "generatedAt": "2026-10-26T21:01:50.753Z",
  "query": { "since": "1h", "sinceAt": "2026-10-26T20:01:50.753Z", "answer": "answerable",
             "zeroComments": false, "repos": [], "orgs": [], "search": [], "in": null, "limit": 1 },
  "complete": true,
  "coveredFrom": "2026-10-26T20:01:50.753Z",
  "count": 1,
  "items": [
    {
      "id": "D_kwDOUnSN2M4Aqe3c",
      "number": 134,
      "title": "Where should I store API keys and passwords?",
      "url": "https://github.com/orgs/trustant/discussions/134",
      "repository": "trustant/trustant",
      "isPrivate": false,
      "createdAt": "2026-10-26T21:01:28Z",
      "updatedAt": "2026-10-26T21:01:28Z",
      "comments": 0,
      "category": "Back-end",
      "isAnswerable": true,
      "isAnswered": false,
      "answerChosenAt": null,
      "ageSeconds": 22
    }
  ],
  "warnings": [],
  "requests": 2,
  "rateLimit": { "cost": 1, "remaining": 4765, "limit": 5000, "resetAt": "2026-10-26T21:18:09Z" }
}
```

(The real output also includes each item's `author` login.) `complete: false` means the run stopped before covering the whole window; `coveredFrom` then tells you how far back the results are guaranteed.

### Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Success (an empty result is still success) |
| 1 | Unexpected internal error |
| 2 | Usage error (bad flag or value) |
| 3 | Authentication, permission or missing-credentials problem |
| 4 | Rate limited |
| 5 | Network error or GitHub outage |
| 6 | GitHub returned a response FreshQ does not understand |

Errors go to stderr, so `freshq --json | jq ...` pipelines stay clean.

## What makes FreshQ accurate

These are behaviours of GitHub's discussion search that I measured against the live API while building this (see `scripts/integration.mjs`), and that a quick script would get wrong:

1. **`sort:` is ignored.** Adding `sort:created-desc` to a discussion search changes nothing; the order is arbitrary. FreshQ sorts by `createdAt` itself.
2. **Only 1000 results are reachable per query**, even when GitHub reports thousands (one measurement: 3,903 discussions were created in a 24-hour window). Combined with (1), a plain paginated query returns an *arbitrary* 1000, not the newest. FreshQ slices the time window (`created:A..B`) into pieces that each fit under the cap and reads them from newest to oldest, so the results are the true newest matches.
3. **Created, not updated.** Filtering is on `createdAt`. An old thread that got a new comment never shows up as "fresh". Every returned row is also re-checked client-side against your filters.
4. **There is no "is answerable" qualifier**; unknown qualifiers (`answered:false`, `category:`, `is:answerable`) are silently ignored or match nothing instead of erroring. FreshQ uses only qualifiers verified to work (`created:`, `is:answered`, `is:unanswered`, `comments:0`, `repo:`, `org:`, `in:`), and builds `--answerable` as the union of the two answered/unanswered queries.
5. **`isAnswered` is `null`, not `false`,** for categories without answers. FreshQ models that explicitly.

The test suite checks the slicing logic against a brute-force oracle, and the live integration script compares FreshQ's results with an independently computed ground truth on real data (including a window of 1500+ discussions, where the top 1000 matched exactly).

## Compared with the alternatives

My brief search of GitHub (October 2026, not exhaustive) for tools in this space mostly turned up comment widgets built *on* Discussions (giscus, gitalk) rather than tools for *finding* new questions. You can answer one-off questions in the web UI or with raw `gh api graphql`, but doing it correctly (points 1-5 above) is exactly the part FreshQ packages.

## Security and privacy

- **Read-only.** The only GraphQL operation FreshQ contains is a single `query`; there are no mutations - no comments, votes, stars, or reactions. A unit test asserts this.
- **No token handling of its own by default.** FreshQ shells out to *your* authenticated `gh` (via `execFile`, no shell, so search text can never become a command). It never reads, prints, logs or stores your token. If `gh` is not installed it falls back to `GH_TOKEN` / `GITHUB_TOKEN`, held in memory only and sent solely to `api.github.com`.
- **Error output is scrubbed** of token-shaped strings.
- **Untrusted titles are sanitized.** Discussion titles are written by strangers; control characters and ANSI/OSC escape sequences are stripped before printing, so a malicious title cannot rewrite your terminal.
- **No telemetry, no accounts, no files written, no network access except GitHub.**
- Search terms are quoted, so they cannot inject extra search qualifiers.

A token with no special scopes is enough for public discussions. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Limitations

- **Index delay.** Results come from GitHub's search index, which lags behind new posts. In my testing, posts typically appeared within about a minute, but that is not a guarantee. An empty result means "nothing found in the index", and FreshQ never invents rows.
- **The index is live and can change.** Searching the same window twice a few minutes apart is not guaranteed to give identical results. During testing, about ten discussions from one repository disappeared from search results (while still being retrievable by ID). FreshQ reports what the index returns at that moment.
- **Public discussions.** In testing, global search returned only public repositories. Access to private repositories was not tested, so treat it as unsupported.
- **Rate limits.** Each API request costs 1 point of your 5000/hour GraphQL budget (search also has secondary limits). A typical run uses 1-3 requests; the heaviest realistic run I measured (`--since 24h --limit 1000`, ~3,900 discussions in the window) used 13. `--verbose` shows what was used. Transient GitHub 5xx errors are retried twice.
- **Large windows.** Very large, unfiltered windows with big limits are capped by `--max-requests` (default 60); FreshQ then reports `complete: false` and exactly how far back it got, instead of silently dropping data.
- **Comment counts** are the API's `comments.totalCount`.
- Maximum `--since` is 30 days.

## Troubleshooting

| You see | Do this |
| --- | --- |
| `GitHub rejected the credentials` (exit 3) | Run `gh auth status`, then `gh auth login`. If you set `GH_TOKEN`, make sure it is valid and unexpired. |
| `No GitHub credentials available` (exit 3) | Install the GitHub CLI and `gh auth login`, or export `GH_TOKEN`. |
| `denied access` / `SAML` (exit 3) | Authorize the token for the organization (Settings → Tokens → Configure SSO). |
| `rate limit reached` (exit 4) | Wait for the reset time shown, narrow the search (`--repo`, `--since`, `--limit`). |
| Empty results | Widen `--since`, drop `--zero-comments`, or check spelling of `--repo`. Very new posts may not be indexed yet. |
| `Incomplete` warning | Raise `--max-requests`, or narrow the window/filters. |

## Development

```sh
npm install
npm test                  # unit tests (no network)
npm run build
npm run test:integration  # live, read-only checks against the real GitHub API (needs gh auth)
npm run verify:package    # npm pack -> install into a temp project -> run the installed binary
```

Source layout: `src/query.ts` (verified search qualifiers), `src/client.ts` (time-slicing, pagination, parsing), `src/transport.ts` (gh / HTTPS), `src/format.ts` (output), `src/cli.ts` (orchestration and exit codes).

## License

[MIT](LICENSE) © zuhairhalawa
