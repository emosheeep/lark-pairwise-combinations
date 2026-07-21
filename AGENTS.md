# Repository guidance

## Scope

This repository contains a generic Feishu Base sidebar plugin that generates missing unordered
value pairs. Keep table and field mappings configurable; do not couple behavior to people or a single Base.

## Development

- Use TypeScript for application and test code.
- Use Bun for dependency management and scripts.
- Build UI with React and shadcn/ui: https://ui.shadcn.com/llms.txt
- Run `bun run check` before committing.
- Format with oxfmt and lint with oxlint; do not add parallel formatter or linter stacks.
- Preserve idempotency: repeated runs only add missing pairs and never rewrite existing records.
- Keep Base writes in batches of at most 200 records.

## Changes

- Add or update tests when pair-generation semantics change.
- Keep generated `dist/` output committed and synchronized with source changes; Pages deploys it from `main`.
- Keep user-facing copy concise and in Simplified Chinese.
