# Contributing to Speedlog

Thanks for taking the time. Bug reports, feature ideas and pull requests are all welcome.

## Reporting a bug

Open an [issue](https://github.com/Real-Fruit-Snacks/obsidian-speedlog/issues/new/choose) using the bug template. Please include:

- Obsidian version and platform (Windows / macOS / Linux / iOS / Android)
- Speedlog version (Settings → Community plugins)
- Steps to reproduce, and what you expected instead
- Anything from the developer console (Ctrl/Cmd+Shift+I on desktop) that mentions Speedlog

## Suggesting a feature

Open an issue with the feature template. Describe the problem you're trying to solve rather than only the solution.

## Working on the code

There is no build step. The plugin is a single `main.js` plus `styles.css` and `manifest.json`.

1. Fork and clone the repo into `<your vault>/.obsidian/plugins/speedlog/`.
2. Enable the plugin in Obsidian.
3. Edit `main.js` or `styles.css`, then reload the plugin.

Guidelines:

- Use only the public Obsidian API. No private `app` internals.
- Register everything with `this.register*` so it's cleaned up on unload.
- Keep it working on mobile (`isDesktopOnly` is `false`). No Node or Electron APIs.
- The only network host is `speed.cloudflare.com`; don't add others.
- Build DOM with `createEl`, style through `styles.css`, use `window.setTimeout`, keep UI strings in sentence case.
- Run [Dev Lab](https://github.com/Real-Fruit-Snacks/obsidian-plugin-lab)'s pre-flight review before opening a PR; it should show 0 linter errors.
- Don't commit `data.json`.

## Pull requests

- One change per PR; keep them small enough to review.
- Describe what changed and why, and note anything you tested on mobile.
- Don't bump `manifest.json` or `versions.json` — that happens at release time.

## Releasing (maintainers)

1. Update `CHANGELOG.md` and `docs/changelog.html`.
2. Bump `version` in `manifest.json` and add the entry to `versions.json`.
3. Commit, then tag with the bare version number and push the tag. The release workflow attaches the three plugin files with build provenance.
