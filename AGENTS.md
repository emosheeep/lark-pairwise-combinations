# Repository guidance

## Scope

This repository contains a generic Feishu Base sidebar plugin that generates missing unordered
member pairs. Keep table and field mappings configurable; do not couple behavior to a single Base.

## Development

- Use TypeScript for application and test code.
- Use Bun for dependency management and scripts.
- Run `bun run check` before committing.
- Format with oxfmt and lint with oxlint; do not add parallel formatter or linter stacks.
- Preserve idempotency: repeated runs only add missing pairs and never rewrite existing records.
- Keep Base writes in batches of at most 200 records.

## Changes

- Add or update tests when pair-generation semantics change.
- Do not commit generated `dist/` output to `main`; deployment output belongs on `gh-pages`.
- Keep user-facing copy concise and in Simplified Chinese.
