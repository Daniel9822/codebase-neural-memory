# Security Policy

## Privacy defaults

Codebase Neural Memory is local-first. It does not intentionally transmit repository contents or memory data to an external service. MCP uses local stdio transport in this release.

The indexer excludes common dependency/build directories, `.env` files, private-key and certificate extensions, symlinks, and source files larger than 1 MB by default. These defaults are safeguards, not a guarantee that every sensitive file or secret can be recognized.

## Reporting a vulnerability

Please do not publish credentials, private repository contents, or exploit details in a public issue. For a private project repository, contact the maintainers through GitHub's private vulnerability reporting feature when enabled.
