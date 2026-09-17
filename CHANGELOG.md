# Changelog

All notable changes to Speedlog are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-09-17

### Fixed
- The Cancel button painted red text on a red background (1.02:1) — it now uses the on-accent colour.
- Timeline timestamps in the live log used `--text-faint`, which fell below 4.5:1 in both schemes; they use `--text-muted` now.
- The slowest-run figure used `--color-orange`, unreadable on a light background at 2.74:1; it uses `--text-error`.
- Label chips and the summary link were under the 24px minimum click target.
- Keyboard focus was invisible on the recent-run rows, the panel's links and the log's disclosure toggle; they paint a focus ring now. Obsidian styles buttons and inputs on focus but not those.

Found by [Dev Lab](https://github.com/Real-Fruit-Snacks/obsidian-plugin-lab)'s accessibility audit.

## [1.0.0] - 2026-09-17

### Added
- Speed test against the nearest LibreSpeed public server (picked by ping each run), a chosen one, or Cloudflare. Accurate (default), Balanced and Light profiles; Accurate uses four parallel streams and measures latency under load. Adaptive chunk sizes for rate limits and request-body limits; time cap, cancel, stall watchdog.
- One note per run with numeric front matter (including phase timings), a results callout with per-label median comparison, a Timeline of every step, and the previous runs on that label. Failed runs get a note with the reason.
- `Summary.md` with per-label medians, best and worst, failed runs, and the last 7 days, rewritten after every run.
- Sidebar panel with the last result, label chips, live progress and a step-by-step log, a sparkline and recent runs.
- Status bar item; commands to run a test, open the panel and open the summary.
- Optional startup and interval runs, off by default and skipped on mobile unless allowed.

[1.0.1]: https://github.com/Real-Fruit-Snacks/obsidian-speedlog/releases/tag/1.0.1
[1.0.0]: https://github.com/Real-Fruit-Snacks/obsidian-speedlog/releases/tag/1.0.0
