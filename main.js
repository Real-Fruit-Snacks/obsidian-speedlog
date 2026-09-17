'use strict';

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, Platform, TFile, TFolder, normalizePath, moment, setIcon, requestUrl } = require('obsidian');

const VIEW_TYPE = 'speedlog';
const HOST = 'https://speed.cloudflare.com';
const MB = 1024 * 1024;

const DEFAULT_SETTINGS = {
  folder: 'Speed tests',
  filenameFormat: 'YYYY-MM-DD HHmmss',
  profile: 'balanced',
  timeCapSeconds: 20,
  runOnStartup: false,
  intervalMinutes: 0,
  allowMobileData: false,
  keepSummary: true,
  showStatusBar: true,
  labels: ['home wifi'],
  lastLabel: 'home wifi',
  lastAutoRunDay: '',
};

// ---------- measurement ----------

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const round = (x, d = 1) => Math.round(x * Math.pow(10, d)) / Math.pow(10, d);

async function timedDownload(bytes, signal, onProgress) {
  const t0 = now();
  const res = await fetch(`${HOST}/__down?bytes=${bytes}`, { cache: 'no-store', signal });
  if (!res.ok) throw new Error(`Download probe failed (${res.status})`);
  const colo = res.headers.get('cf-meta-colo') || '';
  let received = 0;
  if (res.body && res.body.getReader) {
    const reader = res.body.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; received += value.byteLength; if (onProgress) onProgress(received, now() - t0); }
  } else {
    const buf = await res.arrayBuffer(); received = buf.byteLength;
  }
  const ms = now() - t0;
  return { bytes: received, ms, mbps: (received * 8) / (ms / 1000) / 1e6, colo };
}

async function timedUpload(bytes, signal) {
  const body = new Uint8Array(bytes);
  const t0 = now();
  const res = await fetch(`${HOST}/__up`, { method: 'POST', body, cache: 'no-store', signal });
  if (!res.ok) throw new Error(`Upload probe failed (${res.status})`);
  await res.text();
  const ms = now() - t0;
  return { bytes, ms, mbps: (bytes * 8) / (ms / 1000) / 1e6 };
}

async function serverMeta() {
  // Same host; the trace endpoint is plain text with the edge location. requestUrl is not subject to CORS.
  try {
    const res = await requestUrl({ url: `${HOST}/cdn-cgi/trace`, method: 'GET' });
    if (res.status !== 200) return '';
    const m = {};
    for (const line of String(res.text).split('\n')) { const i = line.indexOf('='); if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).trim(); }
    const parts = [m.colo, m.loc].filter(Boolean);
    return parts.length ? parts.join(' · ') : '';
  } catch (e) { return ''; }
}

async function latencyProbe(signal) {
  const t0 = now();
  const res = await fetch(`${HOST}/__down?bytes=0`, { cache: 'no-store', signal });
  await res.text();
  return now() - t0;
}

const PROFILES = {
  light: { label: 'Light', pings: 10, streams: 1, downMb: 5, downRounds: 1, upMb: 2, upRounds: 1, loaded: false },
  balanced: { label: 'Balanced', pings: 20, streams: 1, downMb: 10, downRounds: 4, upMb: 5, upRounds: 3, loaded: false },
  accurate: { label: 'Accurate', pings: 30, streams: 4, downMb: 25, downRounds: 2, upMb: 10, upRounds: 2, loaded: true },
};
const profileOf = (name) => PROFILES[name] || PROFILES.balanced;
const dataPerRun = (name) => { const p = profileOf(name); return { down: 1 + p.streams * p.downMb * p.downRounds, up: p.streams * p.upMb * p.upRounds }; };

// Several streams at once, measured as aggregate bytes over the wall-clock window (what browser speed tests report).
async function parallelRound(kind, streams, bytes, signal, onProgress, pingDuring) {
  const counters = new Array(streams).fill(0);
  const t0 = now();
  const loadedPings = [];
  let pinger = null;
  if (pingDuring) {
    pinger = (async () => { while (true) { try { loadedPings.push(await latencyProbe(signal)); } catch (e) { break; } if (pinger.stop) break; await new Promise((r) => window.setTimeout(r, 250)); } })();
  }
  const tasks = counters.map((_, i) => kind === 'down'
    ? timedDownload(bytes, signal, (got) => { counters[i] = got; if (onProgress) onProgress(counters.reduce((a, b) => a + b, 0), now() - t0); })
    : timedUpload(bytes, signal).then((r) => { counters[i] = bytes; if (onProgress) onProgress(counters.reduce((a, b) => a + b, 0), now() - t0); return r; }));
  const results = await Promise.all(tasks);
  const ms = now() - t0;
  if (pinger) { pinger.stop = true; }
  const total = counters.reduce((a, b) => a + b, 0);
  // With one stream the per-transfer figure is exact; with several, aggregate over the window.
  const mbps = streams === 1 ? results[0].mbps : (total * 8) / (ms / 1000) / 1e6;
  return { mbps, bytes: total, ms, colo: results[0].colo || '', loadedPings };
}

function throughput(samples) {
  // Top half of the samples, like the browser speed tests do: ramp-up probes drag the mean down.
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => b - a);
  return median(s.slice(0, Math.max(1, Math.ceil(s.length / 2))));
}

async function runSpeedTest(opts, report) {
  const p = profileOf(opts.profile);
  const controller = new AbortController();
  const signal = controller.signal;
  const deadline = now() + opts.timeCapSeconds * 1000;
  const timeLeft = () => deadline - now();
  const t0 = now();
  const result = { latency: 0, jitter: 0, loadedLatency: null, download: 0, upload: 0, colo: '', downloadSamples: [], uploadSamples: [], capped: false, profile: opts.profile, streams: p.streams };

  report({ phase: 'latency', text: 'Measuring latency', progress: 0.05 });
  const pings = [];
  for (let i = 0; i < p.pings && timeLeft() > 0; i++) { pings.push(await latencyProbe(signal)); report({ phase: 'latency', text: `Measuring latency · ${i + 1} of ${p.pings}`, progress: 0.05 + (i / p.pings) * 0.15 }); }
  pings.shift();
  result.latency = median(pings);
  const diffs = pings.slice(1).map((v, i) => Math.abs(v - pings[i]));
  result.jitter = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;

  report({ phase: 'download', text: 'Testing download', progress: 0.2, latency: result.latency });
  const warm = await timedDownload(MB, signal);
  result.colo = warm.colo || (await serverMeta());
  const size = p.downMb * MB;
  const loaded = [];
  for (let i = 0; i < p.downRounds; i++) {
    if (timeLeft() <= 0) { result.capped = true; break; }
    const r = await parallelRound('down', p.streams, size, signal, (bytes, ms) => { if (ms > 200) report({ phase: 'download', text: `Testing download · ${i + 1} of ${p.downRounds}${p.streams > 1 ? ` · ${p.streams} streams` : ''}`, progress: 0.2 + ((i + bytes / (size * p.streams)) / p.downRounds) * 0.4, latency: result.latency, download: throughput([...result.downloadSamples, (bytes * 8) / (ms / 1000) / 1e6]) }); }, p.loaded);
    result.downloadSamples.push(r.mbps);
    loaded.push(...r.loadedPings);
  }
  result.download = throughput(result.downloadSamples);
  if (p.loaded && loaded.length) result.loadedLatency = median(loaded);

  report({ phase: 'upload', text: 'Testing upload', progress: 0.6, latency: result.latency, download: result.download });
  const upSize = p.upMb * MB;
  for (let i = 0; i < p.upRounds; i++) {
    if (timeLeft() <= 0) { result.capped = true; break; }
    report({ phase: 'upload', text: `Testing upload · ${i + 1} of ${p.upRounds}${p.streams > 1 ? ` · ${p.streams} streams` : ''}`, progress: 0.6 + (i / p.upRounds) * 0.35, latency: result.latency, download: result.download, upload: throughput(result.uploadSamples) });
    const r = await parallelRound('up', p.streams, upSize, signal, null, false);
    result.uploadSamples.push(r.mbps);
  }
  result.upload = throughput(result.uploadSamples);
  result.durationMs = now() - t0;
  result.bytesDown = MB + result.downloadSamples.length * size * p.streams;
  result.bytesUp = result.uploadSamples.length * upSize * p.streams;
  report({ phase: 'done', text: 'Done', progress: 1, latency: result.latency, download: result.download, upload: result.upload });
  return result;
}

// ---------- plugin ----------

class SpeedlogPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.running = null;
    this.registerView(VIEW_TYPE, (leaf) => new SpeedlogView(leaf, this));
    this.addRibbonIcon('gauge', 'Open Speedlog', () => this.openPanel());
    this.addCommand({ id: 'run', name: 'Run speed test', callback: () => this.runAndLog('manual') });
    this.addCommand({ id: 'open-panel', name: 'Open panel', callback: () => this.openPanel() });
    this.addCommand({ id: 'open-summary', name: 'Open summary note', callback: () => this.openSummary() });
    this.addSettingTab(new SpeedlogSettingTab(this.app, this));
    this.statusEl = this.addStatusBarItem();
    this.statusEl.addClass('speedlog-status');
    this.registerDomEvent(this.statusEl, 'click', () => this.runAndLog('manual'));
    this.refreshStatus();
    this.app.workspace.onLayoutReady(() => {
      this.refreshStatus();
      if (this.settings.runOnStartup && this.scheduledRunsAllowed()) {
        const today = moment().format('YYYY-MM-DD');
        if (this.settings.lastAutoRunDay !== today) {
          this.registerInterval(window.setTimeout(() => this.runAndLog('startup'), 30 * 1000));
        }
      }
      this.applyInterval();
    });
  }

  onunload() { if (this.running) this.running.cancel = true; }

  async loadSettings() { this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData()); }
  async saveSettings() { await this.saveData(this.settings); }

  scheduledRunsAllowed() { return !(Platform.isMobile && !this.settings.allowMobileData); }

  applyInterval() {
    if (this.intervalId) { window.clearInterval(this.intervalId); this.intervalId = null; }
    const mins = Number(this.settings.intervalMinutes) || 0;
    if (mins > 0) {
      this.intervalId = window.setInterval(() => { if (this.scheduledRunsAllowed()) this.runAndLog('interval'); }, mins * 60 * 1000);
      this.registerInterval(this.intervalId);
    }
  }

  // ----- run + log -----

  async runAndLog(trigger, label) {
    if (this.running) { new Notice('Speedlog: a test is already running.'); return null; }
    const useLabel = (label || this.settings.lastLabel || '').trim();
    const state = { cancel: false, progress: 0, text: 'Starting', phase: 'start' };
    this.running = state;
    this.notifyViews();
    try {
      const result = await runSpeedTest({ profile: this.settings.profile, timeCapSeconds: this.settings.timeCapSeconds }, (p) => { for (const k of Object.keys(p)) state[k] = p[k]; this.notifyViews(); });
      const file = await this.writeRunNote(result, useLabel, trigger);
      await this.waitForCache(file);
      if (useLabel && !this.settings.labels.includes(useLabel)) this.settings.labels = [useLabel, ...this.settings.labels].slice(0, 12);
      this.settings.lastLabel = useLabel;
      if (trigger !== 'manual') this.settings.lastAutoRunDay = moment().format('YYYY-MM-DD');
      await this.saveSettings();
      if (this.settings.keepSummary) await this.writeSummary();
      new Notice(`Speedlog: ${round(result.download)} Mbps down · ${round(result.upload)} Mbps up · ${Math.round(result.latency)} ms`);
      return file;
    } catch (e) {
      console.error('Speedlog', e);
      new Notice(`Speedlog: test failed — ${e && e.message ? e.message : e}`);
      return null;
    } finally {
      this.running = null;
      this.refreshStatus();
      this.notifyViews();
    }
  }

  waitForCache(file) {
    return new Promise((resolve) => {
      const done = () => { const c = this.app.metadataCache.getFileCache(file); return !!(c && c.frontmatter); };
      if (done()) return resolve();
      let tries = 0;
      const tick = () => { if (done() || ++tries > 40) return resolve(); window.setTimeout(tick, 100); };
      window.setTimeout(tick, 100);
    });
  }

  async ensureFolder() {
    const path = normalizePath(this.settings.folder || 'Speed tests');
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (!existing) await this.app.vault.createFolder(path);
    return path;
  }

  async writeRunNote(r, label, trigger) {
    const folder = await this.ensureFolder();
    const when = moment();
    let name = when.format(this.settings.filenameFormat || 'YYYY-MM-DD HHmmss').replace(/[\\/:*?"<>|]/g, '-');
    let path = normalizePath(`${folder}/${name}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) { path = normalizePath(`${folder}/${name} ${n++}.md`); }
    const history = this.readRuns().filter((h) => (!label || h.label === label) && (h.profile || 'balanced') === (r.profile || 'balanced'));
    const medDown = median(history.map((h) => h.download));
    const medUp = median(history.map((h) => h.upload));
    const delta = (v, m) => (m ? `${v >= m ? '▲' : '▼'} ${Math.abs(Math.round(((v - m) / m) * 100))}% vs median` : 'first run for this label');
    const platform = `${Platform.isMobile ? 'mobile' : 'desktop'} · ${Platform.isMacOS ? 'macos' : Platform.isWin ? 'windows' : Platform.isLinux ? 'linux' : Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'unknown'}`;
    const server = r.colo ? `Cloudflare · ${r.colo}` : 'Cloudflare';
    const fm = [
      '---',
      `download_mbps: ${round(r.download)}`,
      `upload_mbps: ${round(r.upload)}`,
      `latency_ms: ${Math.round(r.latency)}`,
      `jitter_ms: ${round(r.jitter)}`,
      ...(r.loadedLatency !== null ? [`loaded_latency_ms: ${Math.round(r.loadedLatency)}`] : []),
      `profile: ${r.profile}`,
      `label: ${yamlString(label || '')}`,
      `server: ${yamlString(server)}`,
      `platform: ${yamlString(platform)}`,
      `trigger: ${trigger}`,
      `duration_s: ${round(r.durationMs / 1000)}`,
      `date: ${when.format('YYYY-MM-DDTHH:mm:ssZ')}`,
      'tags: [speedlog]',
      '---',
    ];
    const rows = history.slice(0, 10).map((h) => `| ${h.when.format('ddd D MMM, HH:mm')} | ${round(h.download)} | ${round(h.upload)} | ${Math.round(h.latency)} |`);
    const body = [
      '',
      `> [!info] Speed test · ${when.format('ddd D MMM, HH:mm')}${label ? ` · ${label}` : ''}`,
      `> **${round(r.download)} Mbps** down · ${delta(r.download, medDown)}`,
      `> **${round(r.upload)} Mbps** up · ${delta(r.upload, medUp)}`,
      `> **${Math.round(r.latency)} ms** latency · ±${round(r.jitter)} ms jitter${r.loadedLatency !== null ? ` · ${Math.round(r.loadedLatency)} ms under load` : ''}`,
      `> ${server} · ${profileOf(r.profile).label} profile${r.streams > 1 ? `, ${r.streams} streams` : ''} · ${round(r.bytesDown / MB, 0)} MB down, ${round(r.bytesUp / MB, 0)} MB up in ${round(r.durationMs / 1000)} s${r.capped ? ' (time cap reached)' : ''}`,
      '',
      ...(rows.length ? [`## Previous runs${label ? ` · ${label}` : ''}`, '', '| When | Down | Up | Latency |', '|---|---|---|---|', ...rows, ''] : []),
      this.settings.keepSummary ? `[[${folder}/Summary|Summary]]` : '',
      '',
    ];
    const file = await this.app.vault.create(path, fm.concat(body).join('\n'));
    return file;
  }

  readRuns() {
    const folder = normalizePath(this.settings.folder || 'Speed tests');
    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!(root instanceof TFolder)) return [];
    const runs = [];
    for (const f of root.children) {
      if (!(f instanceof TFile) || f.extension !== 'md') continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = cache && cache.frontmatter;
      if (!fm || typeof fm.download_mbps !== 'number') continue;
      runs.push({ file: f, download: Number(fm.download_mbps) || 0, upload: Number(fm.upload_mbps) || 0, latency: Number(fm.latency_ms) || 0, jitter: Number(fm.jitter_ms) || 0, label: String(fm.label || ''), profile: String(fm.profile || 'balanced'), when: fm.date ? moment(fm.date) : moment(f.stat.ctime) });
    }
    runs.sort((a, b) => b.when.valueOf() - a.when.valueOf());
    return runs;
  }

  async writeSummary() {
    const folder = await this.ensureFolder();
    const runs = this.readRuns();
    const byLabel = new Map();
    for (const r of runs) { const k = r.label || '(no label)'; if (!byLabel.has(k)) byLabel.set(k, []); byLabel.get(k).push(r); }
    const stat = (xs, f) => { const v = xs.map(f); return { med: median(v), best: Math.max(...v), worst: Math.min(...v) }; };
    const lines = ['---', 'tags: [speedlog, summary]', `runs: ${runs.length}`, `updated: ${moment().format('YYYY-MM-DDTHH:mm:ssZ')}`, '---', '', '# Speed tests — summary', '', `${runs.length} ${runs.length === 1 ? 'run' : 'runs'}${runs.length ? ` · since ${runs[runs.length - 1].when.format('D MMM YYYY')}` : ''} · rewritten after every test.`, ''];
    if (byLabel.size) {
      lines.push('## By label', '', '| Label | Runs | Down median | Down best / worst | Up median | Latency median | Last run |', '|---|---|---|---|---|---|---|');
      for (const [k, xs] of byLabel) {
        const d = stat(xs, (x) => x.download), u = stat(xs, (x) => x.upload), l = stat(xs, (x) => x.latency);
        lines.push(`| ${k} | ${xs.length} | ${round(d.med)} | ${round(d.best)} / ${round(d.worst)} | ${round(u.med)} | ${Math.round(l.med)} ms | [[${xs[0].file.path.replace(/\.md$/, '')}\\|${xs[0].when.format('D MMM, HH:mm')}]] |`);
      }
      lines.push('');
    }
    const week = runs.filter((r) => moment().diff(r.when, 'days') < 7);
    if (week.length) {
      lines.push('## Last 7 days', '', '| When | Label | Down | Up | Latency | Note |', '|---|---|---|---|---|---|');
      for (const r of week) lines.push(`| ${r.when.format('ddd D MMM, HH:mm')} | ${r.label} | ${round(r.download)} | ${round(r.upload)} | ${Math.round(r.latency)} | [[${r.file.path.replace(/\.md$/, '')}\\|open]] |`);
      lines.push('');
    }
    const path = normalizePath(`${folder}/Summary.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    const text = lines.join('\n');
    if (existing instanceof TFile) await this.app.vault.modify(existing, text); else await this.app.vault.create(path, text);
  }

  async openSummary() {
    if (this.settings.keepSummary) await this.writeSummary();
    const path = normalizePath(`${this.settings.folder || 'Speed tests'}/Summary.md`);
    const f = this.app.vault.getAbstractFileByPath(path);
    if (f instanceof TFile) await this.app.workspace.getLeaf(false).openFile(f); else new Notice('Speedlog: no summary yet. Run a test first.');
  }

  // ----- UI plumbing -----

  refreshStatus() {
    if (!this.statusEl) return;
    this.statusEl.empty();
    if (!this.settings.showStatusBar) { this.statusEl.hide(); return; }
    this.statusEl.show();
    const last = this.readRuns()[0];
    this.statusEl.setText(last ? `↓ ${round(last.download)} ↑ ${round(last.upload)} · ${Math.round(last.latency)} ms` : 'Speedlog');
    this.statusEl.setAttribute('aria-label', last ? `Last speed test ${last.when.fromNow()} · click to run again` : 'Run a speed test');
  }

  notifyViews() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) { const v = leaf.view; if (v instanceof SpeedlogView) v.render(); } }

  async openPanel() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (existing) { this.app.workspace.revealLeaf(existing); return; }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }
}

function yamlString(s) { return JSON.stringify(String(s)); }

// ---------- panel ----------

class SpeedlogView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; }
  getViewType() { return VIEW_TYPE; }
  getDisplayText() { return 'Speedlog'; }
  getIcon() { return 'gauge'; }

  async onOpen() {
    this.contentEl.addClass('speedlog-view');
    this.registerEvent(this.app.metadataCache.on('resolved', () => this.render()));
    this.render();
  }

  render() {
    const root = this.contentEl;
    root.empty();
    const p = this.plugin;
    const runs = p.readRuns();
    const last = runs[0];
    const running = p.running;

    const card = root.createDiv({ cls: 'speedlog-card' });
    const head = card.createDiv({ cls: 'speedlog-card-head' });
    head.createSpan({ cls: 'speedlog-kicker', text: running ? 'Running' : 'Last run' });
    head.createSpan({ cls: 'speedlog-muted', text: running ? running.text : last ? `${last.when.fromNow()}${last.label ? ` · ${last.label}` : ''}` : 'No runs yet' });
    const nums = card.createDiv({ cls: 'speedlog-nums' });
    const show = (v, unit, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? '—' : `${round(v, d)}`) + (unit ? ` ${unit}` : '');
    const src = running ? { download: running.download, upload: running.upload, latency: running.latency, jitter: undefined } : last;
    for (const [key, label, unit, d] of [['download', 'down', 'Mbps', 1], ['upload', 'up', 'Mbps', 1], ['latency', 'latency', 'ms', 0]]) {
      const n = nums.createDiv({ cls: 'speedlog-num' });
      n.createDiv({ cls: 'speedlog-num-value', text: src ? show(src[key], '', d) : '—' });
      n.createDiv({ cls: 'speedlog-num-label', text: `${label} · ${unit}` });
    }
    if (running) {
      const bar = card.createDiv({ cls: 'speedlog-bar' });
      const fill = bar.createDiv({ cls: 'speedlog-bar-fill' });
      fill.setCssProps({ '--speedlog-progress': Math.round((running.progress || 0) * 100) + '%' });
    }

    const form = root.createDiv({ cls: 'speedlog-form' });
    const input = form.createEl('input', { type: 'text', cls: 'speedlog-label', attr: { placeholder: 'Label this run, e.g. home wifi', 'aria-label': 'Label for this run' } });
    input.value = p.settings.lastLabel || '';
    const btn = form.createEl('button', { cls: 'mod-cta speedlog-run', attr: { 'aria-label': 'Run speed test' } });
    setIcon(btn.createSpan({ cls: 'speedlog-run-icon' }), 'play');
    btn.createSpan({ text: running ? 'Running…' : 'Run test' });
    btn.disabled = !!running;
    const go = () => { if (!p.running) p.runAndLog('manual', input.value); };
    this.registerDomEvent(btn, 'click', go);
    this.registerDomEvent(input, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const chips = root.createDiv({ cls: 'speedlog-chips' });
    for (const l of p.settings.labels) {
      const c = chips.createEl('button', { cls: 'speedlog-chip', text: l, attr: { 'aria-label': `Use label ${l}` } });
      if (l === input.value) c.addClass('is-active');
      this.registerDomEvent(c, 'click', () => { input.value = l; for (const x of Array.from(chips.children)) x.toggleClass('is-active', x === c); });
    }

    if (runs.length > 1) {
      const sec = root.createDiv({ cls: 'speedlog-section' });
      const sh = sec.createDiv({ cls: 'speedlog-section-head' });
      sh.createSpan({ cls: 'speedlog-kicker', text: `Last ${Math.min(runs.length, 30)} runs` });
      const link = sh.createEl('a', { text: 'Open summary', href: '#' });
      this.registerDomEvent(link, 'click', (e) => { e.preventDefault(); p.openSummary(); });
      this.sparkline(sec, runs.slice(0, 30).reverse());
    }

    if (runs.length) {
      const sec = root.createDiv({ cls: 'speedlog-section' });
      sec.createDiv({ cls: 'speedlog-section-head' }).createSpan({ cls: 'speedlog-kicker', text: 'Recent runs' });
      const list = sec.createDiv({ cls: 'speedlog-list' });
      const worst = Math.min(...runs.slice(0, 8).map((r) => r.download));
      for (const r of runs.slice(0, 8)) {
        const row = list.createEl('a', { cls: 'speedlog-row', href: '#', attr: { 'aria-label': `Open run ${r.when.format('LLL')}` } });
        row.createSpan({ cls: 'speedlog-row-when', text: r.when.calendar(null, { sameDay: '[Today] HH:mm', lastDay: '[Yesterday] HH:mm', lastWeek: 'ddd HH:mm', sameElse: 'D MMM HH:mm' }) });
        row.createSpan({ cls: 'speedlog-row-label speedlog-muted', text: r.label || '' });
        const d = row.createSpan({ cls: 'speedlog-row-num', text: round(r.download).toString() });
        if (runs.length > 2 && r.download === worst) d.addClass('is-worst');
        row.createSpan({ cls: 'speedlog-row-num speedlog-muted', text: round(r.upload).toString() });
        row.createSpan({ cls: 'speedlog-row-num speedlog-muted', text: Math.round(r.latency).toString() });
        this.registerDomEvent(row, 'click', (e) => { e.preventDefault(); this.app.workspace.getLeaf(false).openFile(r.file); });
      }
    }

    const foot = root.createDiv({ cls: 'speedlog-foot speedlog-muted' });
    const dpr = dataPerRun(p.settings.profile);
    foot.setText(`${runs.length ? `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} · since ${runs[runs.length - 1].when.format('D MMM')} · ` : ''}${profileOf(p.settings.profile).label}: about ${dpr.down} MB down, ${dpr.up} MB up per run`);
  }

  sparkline(parent, runs) {
    const w = 360, h = 64, pad = 4;
    const svg = parent.createSvg('svg', { cls: 'speedlog-spark', attr: { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'Download and upload speed over recent runs' } });
    const pts = (key) => {
      const vals = runs.map((r) => r[key]);
      const lo = Math.min(...vals), hi = Math.max(...vals);
      const span = Math.max(hi - lo, hi * 0.15, 1); // at least 15% of the peak, so a flat series draws flat, not jittery
      const base = Math.max(0, hi - span);
      return runs.map((r, i) => `${pad + (i / Math.max(1, runs.length - 1)) * (w - 2 * pad)},${h - pad - ((r[key] - base) / span) * (h - 2 * pad)}`).join(' ');
    };
    svg.createSvg('line', { attr: { x1: 0, y1: h - pad, x2: w, y2: h - pad, class: 'speedlog-spark-axis' } });
    svg.createSvg('polyline', { attr: { points: pts('upload'), class: 'speedlog-spark-up' } });
    svg.createSvg('polyline', { attr: { points: pts('download'), class: 'speedlog-spark-down' } });
    const lastPt = pts('download').split(' ').pop().split(',');
    svg.createSvg('circle', { attr: { cx: lastPt[0], cy: lastPt[1], r: 3.5, class: 'speedlog-spark-dot' } });
  }
}

// ---------- settings ----------

class SpeedlogSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    const s = this.plugin.settings;
    const save = () => this.plugin.saveSettings();

    new Setting(containerEl).setName('Test').setHeading();
    const opts = {};
    for (const [k, p] of Object.entries(PROFILES)) { const d = dataPerRun(k); opts[k] = `${p.label} · ${p.streams === 1 ? 'one stream' : `${p.streams} streams`} · about ${d.down} MB down, ${d.up} MB up`; }
    new Setting(containerEl).setName('Profile').setDesc('Light for hotspots and metered plans. Balanced is a single stream. Accurate runs four streams at once, the way browser speed tests do, and also measures latency under load. The only host contacted is speed.cloudflare.com.')
      .addDropdown((d) => d.addOptions(opts).setValue(s.profile in PROFILES ? s.profile : 'balanced').onChange(async (v) => { s.profile = v; await save(); this.plugin.notifyViews(); }));
    new Setting(containerEl).setName('Time cap').setDesc('A run stops after this many seconds and reports what it has. Accurate on a slow link may need 60 or more.')
      .addSlider((sl) => sl.setLimits(5, 120, 5).setValue(s.timeCapSeconds).setDynamicTooltip().onChange(async (v) => { s.timeCapSeconds = v; await save(); }));

    new Setting(containerEl).setName('When to run').setHeading();
    new Setting(containerEl).setName('Run on startup').setDesc('One test 30 seconds after the vault opens, at most once per day.')
      .addToggle((t) => t.setValue(s.runOnStartup).onChange(async (v) => { s.runOnStartup = v; await save(); }));
    new Setting(containerEl).setName('Repeat every').setDesc('Off by default. Uses data on every interval; mind metered connections.')
      .addDropdown((d) => d.addOptions({ 0: 'Never', 30: '30 minutes', 60: '1 hour', 180: '3 hours', 360: '6 hours', 1440: '24 hours' }).setValue(String(s.intervalMinutes)).onChange(async (v) => { s.intervalMinutes = Number(v); await save(); this.plugin.applyInterval(); }));
    new Setting(containerEl).setName('Allow scheduled runs on mobile').setDesc('When off, startup and interval runs are skipped on phones and tablets. Manual runs always work.')
      .addToggle((t) => t.setValue(s.allowMobileData).onChange(async (v) => { s.allowMobileData = v; await save(); }));

    new Setting(containerEl).setName('Notes').setHeading();
    new Setting(containerEl).setName('Folder').setDesc('One note per run, plus the summary note, kept here.')
      .addText((t) => t.setValue(s.folder).setPlaceholder('Speed tests').onChange(async (v) => { s.folder = v.trim() || 'Speed tests'; await save(); }));
    new Setting(containerEl).setName('Filename format').setDesc(`Moment.js format. Now: ${moment().format(s.filenameFormat || 'YYYY-MM-DD HHmmss')}`)
      .addText((t) => t.setValue(s.filenameFormat).setPlaceholder('YYYY-MM-DD HHmmss').onChange(async (v) => { s.filenameFormat = v.trim() || 'YYYY-MM-DD HHmmss'; await save(); }));
    new Setting(containerEl).setName('Keep Summary.md updated').setDesc('Median, best and worst per label, and the last 7 days, rewritten after every run.')
      .addToggle((t) => t.setValue(s.keepSummary).onChange(async (v) => { s.keepSummary = v; await save(); }));
    new Setting(containerEl).setName('Status bar').setDesc('Show the last result in the status bar; click it to run again.')
      .addToggle((t) => t.setValue(s.showStatusBar).onChange(async (v) => { s.showStatusBar = v; await save(); this.plugin.refreshStatus(); }));
  }
}

module.exports = SpeedlogPlugin;
