# Security policy

FreshQ is a read-only client: it issues GraphQL `query` operations only and never stores or transmits
credentials anywhere except to `api.github.com` (directly, or through your own `gh` CLI).

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting
(<https://github.com/zuhairhalawa/FreshQ/security/advisories/new>) instead of opening a public issue.
Include the FreshQ version (`freshq --version`), your OS and Node version, and steps to reproduce.

## Design notes relevant to security

- Subprocesses are launched with `execFile` (no shell); user input is only ever an argument, never a command.
- Tokens are never printed, logged or written to disk. Error text is passed through a redaction filter.
- Discussion titles are untrusted input; control characters and ANSI/OSC escape sequences are stripped
  before terminal output to prevent terminal injection.
- Zero runtime dependencies.
