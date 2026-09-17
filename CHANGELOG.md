# Changelog

All notable changes to Speedlog are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/).

## [1.0.0] - 2026-09-17

### Added
- Speed test against Cloudflare's public endpoints: latency and jitter, download and upload, with a time cap. Light, Balanced and Accurate profiles; Accurate uses four parallel streams and measures latency under load.
- One note per run with numeric front matter, a results callout with median comparison per label, and the previous runs.
- `Summary.md` with per-label medians, best and worst, and the last 7 days, rewritten after every run.
- Sidebar panel with the last result, label chips, live progress, a sparkline and recent runs.
- Status bar item; commands to run a test, open the panel and open the summary.
- Optional startup and interval runs, off by default and skipped on mobile unless allowed.

[1.0.0]: https://github.com/Real-Fruit-Snacks/obsidian-speedlog/releases/tag/1.0.0
