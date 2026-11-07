# UI verification — 2026-11-07

English | [中文](README.zh.md)

Node 24.19.0, official DSH 0.2.1-rc.2 and local Microsoft Edge. No model API key or production profile was used. Raw logs and the temporary browser test remain outside the repository under the operator's `Temp/opencode/kylin-ui-browser` directory; the aggregate check log is `Temp/opencode/kylin-ui-final-check.log`.

## Results

- `pnpm run check`: both compiler faces, 36 test files / 494 tests, build and bundle verification passed (11 patch rows / 17 entry points). This working tree includes pre-existing experience changes; this is not an isolated UI-only or repair-only result.
- The staged candidate was separately exported without the unrelated experience changes and passed `pnpm run check`: both compiler faces, 24 test files / 426 tests, build, 11 patch rows and 17 entry points. It reused the linked harness dependencies, not a fresh install. Its raw log is `Temp/opencode/kylin-ui-staged-check.log`; the browser check above used the full working-tree build, not this exported candidate.
- Real `launchWebScaffold` browser test: 1 passed, no plugin activation warnings or page errors. Verified sidebar branding, default-collapsed memory card, section expansion, full injected text, profile listing, real search, item details, dark appearance, 390px panel bounds and Escape dismissal.
- The store preference and durable recall event were deliberately synthetic. The check does not measure extraction quality, actual model use, retrieval accuracy or performance at scale.
- The first aggregate command failed because its nested `pnpm` executable was absent from PATH. Temporary Corepack shims fixed command resolution; no product code or assertions were disabled.

## Screenshots

- [Desktop search and memory card](desktop.png)
- [Expanded card and full injected text](recall-card.png)
- [Dark appearance](dark.png)
- [390px layout](mobile.png)

## Remaining limits

The panel is a read-only overlay, not a shell right-side tab. There are no edit/erase actions or live background subscriptions. Browser title/favicon and the original hero slogan remain unchanged. Natural-language refusal, extraction quality, SDK resource accumulation and untested large-store latency remain separate unresolved issues.
