'use strict';

const { Plugin, ItemView, PluginSettingTab, Setting, Notice, Platform, TFile, TFolder, normalizePath, moment, setIcon, requestUrl } = require('obsidian');

const VIEW_TYPE = 'speedlog';
const MB = 1024 * 1024;

// Servers. Cloudflare picks its nearest edge; the rest are LibreSpeed's public list (librespeed.org/backend-servers),
// embedded so the plugin never fetches the list. Only the selected server is contacted.
const CLOUDFLARE = { id: 'cloudflare', name: 'Cloudflare', base: 'https://speed.cloudflare.com' };
const LIBRESPEED = [
  { id: 'ls-51', name: "Amsterdam, Netherlands (Clouvider)", base: "https://ams.speedtest.clouvider.net/backend", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-104', name: "Argalasti, Magnesia, Greece (Cosmote)", base: "https://argalasti.skoultsos.eu", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-53', name: "Atlanta, United States (Clouvider)", base: "https://atl.speedtest.clouvider.net/backend", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-106', name: "Belgrade, Serbia (SOX)", base: "https://speedtest1.sox.rs/librespeed", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-50', name: "Frankfurt, Germany (Clouvider)", base: "https://fra.speedtest.clouvider.net/backend", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-105', name: "Frankfurt, Germany (FS IT-Systeme GmbH)", base: "https://speed.fs-it.systems", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-100', name: "Grand Rapids, Michigan (RackGenius)", base: "https://mispeed.rackgenius.com", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-101', name: "Helsinki, Finland (Hetzner)", base: "https://www.librespeed.fi", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-49', name: "London, England (Clouvider)", base: "https://lon.speedtest.clouvider.net/backend", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-54', name: "Los Angeles, United States (1) (Clouvider)", base: "https://la.speedtest.clouvider.net/backend", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-52', name: "New York, United States (2) (Clouvider)", base: "https://nyc.speedtest.clouvider.net/backend", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-103', name: "Novi Sad, Vojvodina, Serbia (E-CAPS.net)", base: "https://speed1.e-caps.net", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-74', name: "Poznan, Poland (INEA)", base: "https://speedtest.kamilszczepanski.com", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-79', name: "Prague, Czech Republic (CESNET)", base: "https://speedtest.cesnet.cz", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-85', name: "Prague, Czech Republic (Turris)", base: "https://librespeed.turris.cz", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
  { id: 'ls-35', name: "Roma, Italy (GARR)", base: "https://st-be-rm2.infra.garr.it", dl: "garbage.php", ul: "empty.php", ping: "empty.php" },
  { id: 'ls-82', name: "Tokyo, Japan (A573)", base: "https://librespeed.a573.net", dl: "backend/garbage.php", ul: "backend/empty.php", ping: "backend/empty.php" },
];
const AUTO = { id: 'librespeed-auto', name: 'LibreSpeed · nearest' };
const serverOf = (id) => (id === AUTO.id ? AUTO : LIBRESPEED.find((x) => x.id === id) || CLOUDFLARE);

// Ping the LibreSpeed servers in small batches (requestUrl queues, so a big burst measures queue position, not
// distance), then re-ping the three quickest twice and keep the best time each.
async function pickNearest(report) {
  if (report) report({ phase: 'pick', text: 'Finding the nearest LibreSpeed server', progress: 0.02 });
  const probe = async (srv, timeoutMs) => {
    const t0 = now();
    const timeout = new Promise((resolve) => window.setTimeout(() => resolve(null), timeoutMs));
    let status = 'timeout';
    const req = requestUrl({ url: urls(srv).ping(), method: 'GET', throw: false }).then((r) => { status = r.status; return r.status === 200 ? now() - t0 : null; }).catch((e) => { status = e && e.message ? e.message : 'error'; return null; });
    return { srv, ms: await Promise.race([req, timeout]), status };
  };
  // First pass opens the connections (DNS + TLS dominate); the second pass is the real measurement. Keep the best.
  const first = [];
  for (let i = 0; i < LIBRESPEED.length; i += 5) {
    const batch = LIBRESPEED.slice(i, i + 5);
    const a = await Promise.all(batch.map((x) => probe(x, 1500)));
    const b = await Promise.all(batch.map((x) => probe(x, 1500)));
    for (let k = 0; k < batch.length; k++) first.push(a[k].ms === null ? b[k] : b[k].ms === null ? a[k] : (a[k].ms <= b[k].ms ? a[k] : b[k]));
  }
  console.debug('Speedlog ping table:\n' + first.map((r) => `  ${r.ms === null ? `--- (${r.status})` : `${Math.round(r.ms)} ms`.padStart(12)}  ${r.srv.name}`).join('\n'));
  const ok = first.filter((r) => r.ms !== null).sort((a, b) => a.ms - b.ms).slice(0, 3);
  if (!ok.length) throw new Error('no LibreSpeed server answered');
  for (const r of ok) { for (let k = 0; k < 2; k++) { const again = await probe(r.srv, 1500); if (again.ms !== null) r.ms = Math.min(r.ms, again.ms); } }
  ok.sort((a, b) => a.ms - b.ms);
  console.debug('Speedlog nearest:', ok.map((r) => `${r.srv.name} ${Math.round(r.ms)} ms`).join(' · '));
  return ok.map((r) => Object.assign({}, r.srv, { pickedMs: Math.round(r.ms) }));
}
const hostOf = (srv) => { try { return new URL(srv.base).host; } catch (e) { return srv.base; } };
const urls = (srv) => srv.id === 'cloudflare'
  ? { down: (bytes) => `${srv.base}/__down?bytes=${bytes}`, up: () => `${srv.base}/__up`, ping: () => `${srv.base}/__down?bytes=0`, trace: () => `${srv.base}/cdn-cgi/trace` }
  : { down: (bytes) => `${srv.base}/${srv.dl}?ckSize=${Math.max(1, Math.round(bytes / MB))}&r=${Math.random()}`, up: () => `${srv.base}/${srv.ul}?r=${Math.random()}`, ping: () => `${srv.base}/${srv.ping}?r=${Math.random()}`, trace: null };

const DEFAULT_SETTINGS = {
  folder: 'Speed tests',
  filenameFormat: 'YYYY-MM-DD HHmmss',
  profile: 'accurate',
  server: 'librespeed-auto',
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

// Fallback when fetch fails at the network level (CORS change, reset connection): Obsidian's requestUrl takes a
// different path and is not subject to CORS. No streaming progress, but the timing is still a real transfer.
async function fallbackDownload(srv, bytes) {
  const t0 = now();
  const res = await requestUrl({ url: urls(srv).down(bytes), method: 'GET', throw: false });
  if (res.status !== 200) throw statusError(res.status, res.headers);
  const ms = now() - t0;
  const received = res.arrayBuffer ? res.arrayBuffer.byteLength : bytes;
  return { bytes: received, ms, mbps: (received * 8) / (ms / 1000) / 1e6, colo: '', fallback: true };
}

async function fallbackUpload(srv, bytes) {
  const t0 = now();
  const res = await requestUrl({ url: urls(srv).up(), method: 'POST', body: new ArrayBuffer(bytes), contentType: 'application/octet-stream', throw: false });
  if (res.status < 200 || res.status >= 300) throw statusError(res.status, res.headers);
  const ms = now() - t0;
  return { bytes, ms, mbps: (bytes * 8) / (ms / 1000) / 1e6, fallback: true };
}

function statusError(status, headers) {
  const err = new Error(status === 429 ? 'Cloudflare asked us to slow down (429)' : `probe failed (${status})`);
  err.status = status;
  const ra = headers && (headers['retry-after'] || headers['Retry-After']);
  err.retryAfterMs = ra && /^\d+$/.test(String(ra)) ? Number(ra) * 1000 : 0;
  return err;
}

const abortError = () => { const e = new Error('aborted'); e.name = 'AbortError'; return e; };
// A sleep that ends early when the signal aborts, so Cancel bites during retry waits too
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) return reject(abortError());
  const t = window.setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { window.clearTimeout(t); reject(abortError()); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});
const isNetworkError = (e) => e && (e.name === 'TypeError' || /failed to fetch|network|load failed/i.test(String(e.message || e)));

async function timedDownload(srv, bytes, signal, onProgress) {
  if (signal && signal.aborted) throw abortError();
  if (srv.noFetch) { const r = await fallbackDownload(srv, bytes); if (signal && signal.aborted) throw abortError(); if (onProgress) onProgress(r.bytes, r.ms); return r; }
  const t0 = now();
  let res;
  try { res = await fetch(urls(srv).down(bytes), { cache: 'no-store', signal }); }
  catch (e) { if (isNetworkError(e) && !(signal && signal.aborted)) { srv.noFetch = true; const r = await fallbackDownload(srv, bytes); if (signal && signal.aborted) throw abortError(); if (onProgress) onProgress(r.bytes, r.ms); return r; } throw e; }
  if (!res.ok) throw statusError(res.status, null);
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

async function timedUpload(srv, bytes, signal) {
  if (signal && signal.aborted) throw abortError();
  if (srv.noFetch) { const r = await fallbackUpload(srv, bytes); if (signal && signal.aborted) throw abortError(); return r; }
  const body = new Uint8Array(bytes);
  const t0 = now();
  let res;
  try { res = await fetch(urls(srv).up(), { method: 'POST', body, cache: 'no-store', signal }); }
  catch (e) { if (isNetworkError(e) && !(signal && signal.aborted)) { srv.noFetch = true; const r = await fallbackUpload(srv, bytes); if (signal && signal.aborted) throw abortError(); return r; } throw e; }
  if (!res.ok) throw statusError(res.status, null);
  await res.text();
  const ms = now() - t0;
  return { bytes, ms, mbps: (bytes * 8) / (ms / 1000) / 1e6 };
}

async function serverMeta(srv) {
  // Cloudflare's trace endpoint is plain text with the edge location; requestUrl is not subject to CORS.
  if (!urls(srv).trace) return '';
  try {
    const res = await requestUrl({ url: urls(srv).trace(), method: 'GET' });
    if (res.status !== 200) return '';
    const m = {};
    for (const line of String(res.text).split('\n')) { const i = line.indexOf('='); if (i > 0) m[line.slice(0, i)] = line.slice(i + 1).trim(); }
    const parts = [m.colo, m.loc].filter(Boolean);
    return parts.length ? parts.join(' · ') : '';
  } catch (e) { return ''; }
}

// One retry for a transient network error; the second failure carries the phase so the notice says where it died.
async function withRetry(phase, fn, signal) {
  try { return await fn(); } catch (e1) {
    if (isAbort(e1) || (signal && signal.aborted)) throw abortError();
    if (e1 && e1.status === 413) { const err = new Error(`${phase}: ${e1.message}`); err.status = 413; throw err; } // deterministic; the caller shrinks the chunk
    const wait = e1 && e1.status === 429 ? Math.max(3000, e1.retryAfterMs || 0) : 600;
    await sleep(wait, signal);
    try { return await fn(); } catch (e2) { const err = new Error(`${phase}: ${e2 && e2.message ? e2.message : e2}`); err.phase = phase; err.status = e2 && e2.status; throw err; }
  }
}

async function latencyProbe(srv, signal) {
  if (signal && signal.aborted) throw abortError();
  const t0 = now();
  if (srv.noFetch) { await requestUrl({ url: urls(srv).ping(), method: 'GET', throw: false }); return now() - t0; }
  try { const res = await fetch(urls(srv).ping(), { cache: 'no-store', signal }); await res.text(); }
  catch (e) { if (isNetworkError(e) && !(signal && signal.aborted)) { srv.noFetch = true; await requestUrl({ url: urls(srv).ping(), method: 'GET', throw: false }); } else throw e; }
  return now() - t0;
}

const PROFILES = {
  light: { label: 'Light', pings: 10, streams: 1, downMb: 5, downRounds: 1, upMb: 2, upRounds: 1, loaded: false },
  balanced: { label: 'Balanced', pings: 20, streams: 1, downMb: 10, downRounds: 4, upMb: 5, upRounds: 3, loaded: false },
  accurate: { label: 'Accurate', pings: 30, streams: 4, downMb: 10, downRounds: 4, upMb: 5, upRounds: 2, loaded: true },
};
const profileOf = (name) => PROFILES[name] || PROFILES.balanced;
const dataPerRun = (name) => { const p = profileOf(name); return { down: 1 + p.streams * p.downMb * p.downRounds, up: p.streams * p.upMb * p.upRounds }; };

// Several streams at once. The sustained rate is sampled every 200 ms while every stream is still active, so
// per-stream ramp-up and the tail where only one stream is left do not drag the figure down.
async function parallelRound(srv, kind, streams, bytes, signal, onProgress, pingDuring) {
  const counters = new Array(streams).fill(0);
  let active = streams;
  const t0 = now();
  const loadedPings = [];
  const samples = []; // { t, total, active }
  const total = () => counters.reduce((a, b) => a + b, 0);
  const sampler = window.setInterval(() => { samples.push({ t: now(), total: total(), active }); if (onProgress) onProgress(total(), now() - t0); }, 200);
  let stopPings = false;
  const pinger = pingDuring ? (async () => { while (!stopPings) { try { loadedPings.push(await latencyProbe(srv, signal)); } catch (e) { break; } try { await sleep(250, signal); } catch (e) { break; } } })() : null;
  const tasks = counters.map((_, i) => (kind === 'down'
    ? timedDownload(srv, bytes, signal, (got) => { counters[i] = got; })
    : timedUpload(srv, bytes, signal).then((r) => { counters[i] = bytes; return r; })
  ).then((r) => { active--; return r; }));
  let results;
  try { results = await Promise.all(tasks); } finally { window.clearInterval(sampler); stopPings = true; }
  const ms = now() - t0;
  let mbps;
  if (streams === 1) {
    mbps = results[0].mbps;
  } else if (kind === 'down') {
    const rates = [];
    for (let i = 1; i < samples.length; i++) { const a = samples[i - 1], b = samples[i]; if (b.active < streams || b.t - a.t <= 0) continue; rates.push(((b.total - a.total) * 8) / ((b.t - a.t) / 1000) / 1e6); }
    if (rates.length >= 3 && rates.some((x) => x > 0)) mbps = throughput(rates.filter((x) => x > 0));
    else {
      // No streaming progress (requestUrl path). If the round's wall time is close to the slowest stream, the streams
      // ran concurrently and the link's rate while all were active is the sum of their own rates; otherwise
      // (serialised, or one straggler) fall back to total bytes over wall time.
      const times = results.map((r) => r.ms);
      const slowest = Math.max(...times), fastest = Math.min(...times);
      const concurrent = ms <= slowest * 1.25;
      // Summing per-stream rates assumes each stream ran the whole round; only true when they finished together
      const balanced = slowest <= fastest * 1.5;
      mbps = concurrent && balanced ? results.map((r) => r.mbps).reduce((a, b) => a + b, 0) : (total() * 8) / (ms / 1000) / 1e6;
    }
  } else {
    // uploads report no progress either: total bytes over wall time
    mbps = (total() * 8) / (ms / 1000) / 1e6;
  }
  return { mbps, bytes: total(), ms, colo: results[0].colo || '', loadedPings, streamMs: results.map((r) => r.ms) };
}

function throughput(samples) {
  // Top half of the samples, like the browser speed tests do: ramp-up probes drag the mean down.
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => b - a);
  return median(s.slice(0, Math.max(1, Math.ceil(s.length / 2))));
}

const abortReason = (controller, tail) => new Error(controller.stalled ? `stalled: no data for 20 s ${tail}` : controller.capped ? `time cap reached ${tail}` : 'cancelled');
const isAbort = (e) => e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));

async function runSpeedTest(opts, report) {
  const p = profileOf(opts.profile);
  const runStart = now();
  const timeline = [];
  // step(text) opens a timeline row and a live-log line now; the returned closer stamps its duration and detail.
  // log(text, detail) is an instant event (opened and closed at once).
  const step = (text) => {
    const t = now(); const row = { at: t - runStart, text, detail: '', took: 0 }; timeline.push(row);
    const line = { at: t - runStart, text: `${text}…` }; report({ log: line });
    return (detail) => { row.took = now() - t; row.detail = detail || ''; line.text = detail ? `${text} · ${detail}` : text; line.took = row.took; report({ logUpdate: line }); };
  };
  const log = (text, detail) => step(text)(detail);
  const closeTimeline = () => timeline;
  const chosen = serverOf(opts.server);
  let candidates;
  if (chosen.id === AUTO.id) {
    const done = step('Pinging LibreSpeed servers');
    candidates = (await pickNearest(report)).slice(0, 3);
    done(`${LIBRESPEED.length} servers, two passes · nearest ${candidates.map((c) => `${c.name} ${c.pickedMs} ms`).join(', ')}`);
  } else { candidates = [Object.assign({}, chosen)]; log('Server', chosen.name); }
  let srv = candidates[0];
  let candidateIndex = 0;
  const controller = opts.controller || new AbortController();
  const signal = controller.signal;
  const deadline = now() + opts.timeCapSeconds * 1000;
  const timeLeft = () => deadline - now();
  const capTimer = window.setTimeout(() => { controller.capped = true; controller.abort(); }, opts.timeCapSeconds * 1000);
  // Stall watchdog: nothing reported for 20 s means a dead link or a request that never returns.
  let lastActivity = now();
  const rawReport = report;
  report = (x) => { lastActivity = now(); rawReport(x); };
  const watchdog = window.setInterval(() => { if (now() - lastActivity > 20000) { controller.stalled = true; controller.abort(); } }, 2000);
  try {
    for (;;) {
      try { return await runPhases(); }
      catch (e) {
        // In auto mode an HTTP refusal (403, 5xx) from one volunteer server means try the next nearest
        if (candidateIndex < candidates.length - 1 && e && e.status && e.status !== 429 && e.status !== 413 && !signal.aborted) {
          const prev = srv.name; candidateIndex++; srv = candidates[candidateIndex];
          log('Server refused', `${prev} answered ${e.status}; trying ${srv.name}`);
          report({ phase: 'download', text: `${prev} refused (${e.status}) · trying ${srv.name}`, progress: 0.2 });
          continue;
        }
        if (e && e.status && srv) e.message = `${srv.name}: ${e.message}`;
        throw e;
      }
    }
  } finally { window.clearTimeout(capTimer); window.clearInterval(watchdog); }

  async function runPhases() {
  const t0 = now();
  const result = { latency: 0, jitter: 0, loadedLatency: null, download: 0, upload: 0, colo: '', downloadSamples: [], uploadSamples: [], capped: false, profile: opts.profile, streams: p.streams, server: srv };

  report({ phase: 'latency', text: 'Measuring latency', progress: 0.05 });
  const latencyDone = step('Latency probes');
  const pings = [];
  for (let i = 0; i < p.pings && timeLeft() > 0; i++) { try { pings.push(await latencyProbe(srv, signal)); } catch (e) { if (isAbort(e) || signal.aborted) throw abortReason(controller, 'during latency probes'); if (pings.length < 3) throw new Error('latency: ' + (e && e.message ? e.message : e)); break; } report({ phase: 'latency', text: `Measuring latency · ${i + 1} of ${p.pings}`, progress: 0.05 + (i / p.pings) * 0.15 }); }
  pings.shift();
  result.latency = median(pings);
  const diffs = pings.slice(1).map((v, i) => Math.abs(v - pings[i]));
  result.jitter = diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
  latencyDone(`${pings.length + 1} probes, first discarded · median ${Math.round(result.latency)} ms, jitter ±${round(result.jitter)} ms, best ${Math.round(Math.min(...pings))}, worst ${Math.round(Math.max(...pings))}`);

  report({ phase: 'download', text: 'Testing download', progress: 0.2, latency: result.latency });
  let warm;
  const warmDone = step('Warm-up');
  try { warm = await withRetry('download', () => timedDownload(srv, MB, signal), signal); }
  catch (e) { if (isAbort(e) || signal.aborted) throw abortReason(controller, 'before any download completed'); throw e; }
  result.server = srv;
  result.colo = warm.colo || (await serverMeta(srv));
  warmDone(`1 MB in ${round(warm.ms / 1000, 2)} s (${round(warm.mbps)} Mbps)${srv.noFetch ? ' · non-streaming transfer (no live progress)' : ''}${result.colo ? ` · edge ${result.colo}` : ''}`);
  let size = p.downMb * MB;
  let rateLimited = 0;
  const loaded = [];
  for (let i = 0; i < p.downRounds; i++) {
    if (timeLeft() <= 0) { result.capped = true; break; }
    let r;
    const roundDone = step(`Download ${i + 1}/${p.downRounds}`);
    try {
      r = await withRetry('download', () => parallelRound(srv, 'down', p.streams, size, signal, (bytes, ms) => { if (ms > 200) report({ phase: 'download', text: `Testing download · ${i + 1} of ${p.downRounds}${p.streams > 1 ? ` · ${p.streams} streams` : ''}`, progress: 0.2 + ((i + bytes / (size * p.streams)) / p.downRounds) * 0.4, latency: result.latency, download: throughput([...result.downloadSamples, (bytes * 8) / (ms / 1000) / 1e6]) }); }, p.loaded), signal);
    } catch (e) {
      roundDone(isAbort(e) || signal.aborted ? 'aborted' : `failed (${e && e.status ? e.status : e && e.message})`);
      if (isAbort(e) || signal.aborted) { if (controller.capped && result.downloadSamples.length) { result.capped = true; break; } throw abortReason(controller, 'before any download completed'); }
      // Rate-limited: halve the chunk once; a second rate-limited round in a row means Cloudflare wants us gone
      if (e && e.status === 429) {
        if (signal.aborted) throw abortReason(controller, 'before any download completed');
        rateLimited++;
        if (rateLimited >= 2 || size <= MB) throw e;
        size = Math.max(MB, Math.floor(size / 2)); result.degraded = true;
        log('Rate-limited', `429 from ${srv.name}; retrying with ${Math.round(size / MB)} MB chunks`);
        report({ phase: 'download', text: `Rate-limited · one more try with ${Math.round(size / MB)} MB chunks`, progress: 0.3, latency: result.latency });
        i--; continue;
      }
      throw e;
    }
    rateLimited = 0;
    result.downloadSamples.push(r.mbps);
    loaded.push(...r.loadedPings);
    roundDone(`${p.streams} × ${Math.round(size / MB)} MB in ${round(r.ms / 1000, 2)} s wall · ${round(r.mbps)} Mbps${r.streamMs ? ` · streams ${r.streamMs.map((x) => round(x / 1000, 1)).join('/')} s` : ''}${r.loadedPings.length ? ` · ${r.loadedPings.length} loaded pings` : ''}`);
  }
  result.download = throughput(result.downloadSamples);
  if (p.loaded && loaded.length) result.loadedLatency = median(loaded);
  log('Download result', `${round(result.download)} Mbps (median of the fastest half of ${result.downloadSamples.length})${result.loadedLatency !== null ? ` · ${Math.round(result.loadedLatency)} ms under load` : ''}`);

  report({ phase: 'upload', text: 'Testing upload', progress: 0.6, latency: result.latency, download: result.download });
  // Upload rounds are time-budgeted: servers behind a small request-body limit answer 413, the chunk halves and the
  // extra rounds keep the sample count up. Never fewer rounds than the profile asks for, never more than 16.
  // Size upload chunks for this uplink: a 1 MB probe, then chunks that make a round take about two seconds,
  // never larger than the profile's chunk and never smaller than 256 KB.
  let upSize = p.upMb * MB;
  const probeDone = step('Upload probe');
  try {
    const pr = await withRetry('upload', () => timedUpload(srv, MB, signal), signal);
    // The probe includes the handshake, so it under-reads; aim for a 3 s round on that basis and never below 512 KB
    const perStreamBytes = (pr.mbps * 1e6 / 8) * 3 / p.streams;
    const cap = srv.id === 'cloudflare' ? p.upMb * MB : Math.min(p.upMb * MB, 2 * MB); // volunteer servers sit behind small body limits
    upSize = Math.max(512 * 1024, Math.min(cap, Math.floor(perStreamBytes / (256 * 1024)) * 256 * 1024));
    probeDone(`1 MB in ${round(pr.ms / 1000, 2)} s (${round(pr.mbps)} Mbps) · chunks ${upSize >= MB ? round(upSize / MB, 1) + ' MB' : Math.round(upSize / 1024) + ' KB'}`);
  } catch (e) {
    probeDone(isAbort(e) || signal.aborted ? 'aborted' : `failed (${e && e.status ? e.status : e && e.message}) · using ${p.upMb} MB chunks`);
    if (isAbort(e) || signal.aborted) { if (controller.capped || controller.stalled) result.capped = true; else throw abortReason(controller, 'during upload'); }
    else if (!(e && e.status === 413)) throw e; else upSize = 512 * 1024;
  }
  const upBudget = p.upRounds * 2000;
  const upStart = now();
  let upTooLarge = 0;
  for (let i = 0; !signal.aborted && i < 16 && (i < 1 || now() - upStart < upBudget); i++) {
    if (timeLeft() <= 0) { result.capped = true; break; }
    report({ phase: 'upload', text: `Testing upload · round ${i + 1}${p.streams > 1 ? ` · ${p.streams} streams` : ''}`, progress: 0.6 + Math.min(0.35, ((now() - upStart) / upBudget) * 0.35), latency: result.latency, download: result.download, upload: throughput(result.uploadSamples) });
    let r;
    const upDone = step(`Upload ${i + 1}`);
    try { r = await withRetry('upload', () => parallelRound(srv, 'up', p.streams, upSize, signal, null, false), signal); }
    catch (e) {
      upDone(isAbort(e) || signal.aborted ? 'aborted' : `failed (${e && e.status ? e.status : e && e.message})`);
      if (isAbort(e) || signal.aborted) { if (controller.capped || controller.stalled) { result.capped = true; break; } throw abortReason(controller, 'during upload'); }
      if (e && e.status === 413 && upSize > 256 * 1024 && upTooLarge++ < 6) { upSize = Math.max(256 * 1024, Math.floor(upSize / 2)); log('Upload too large', `413 from ${srv.name}; retrying with ${upSize >= MB ? Math.round(upSize / MB) + ' MB' : Math.round(upSize / 1024) + ' KB'} chunks`); i--; continue; }
      throw e;
    }
    result.uploadSamples.push(r.mbps);
    result.bytesUp = (result.bytesUp || 0) + r.bytes;
    upDone(`${p.streams} × ${upSize >= MB ? Math.round(upSize / MB) + ' MB' : Math.round(upSize / 1024) + ' KB'} in ${round(r.ms / 1000, 2)} s · ${round(r.mbps)} Mbps`);
  }
  result.upload = result.uploadSamples.length ? throughput(result.uploadSamples) : null;
  log('Upload result', result.upload !== null ? `${round(result.upload)} Mbps (median of the fastest half of ${result.uploadSamples.length})` : 'not measured (time cap)');
  result.durationMs = now() - t0;
  result.fallback = !!srv.noFetch;
  result.timeline = closeTimeline();
  result.bytesDown = MB + result.downloadSamples.length * size * p.streams; // approximate when degraded
  result.bytesUp = result.bytesUp || 0;
  report({ phase: 'done', text: 'Done', progress: 1, latency: result.latency, download: result.download, upload: result.upload });
  return result;
  }
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

  onunload() { if (this.running && this.running.cancel) this.running.cancel(); }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    // keys from earlier builds
    let dirty = false;
    for (const k of Object.keys(this.settings)) if (!(k in DEFAULT_SETTINGS)) { delete this.settings[k]; dirty = true; }
    if (dirty) await this.saveSettings();
  }
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
    const controller = new AbortController();
    const state = { progress: 0, text: 'Starting', phase: 'start', label: useLabel, log: [], startedAt: now(), cancel: () => { controller.abort(); } };
    this.lastLog = state.log;
    this.running = state;
    this.lastError = null;
    this.notifyViews();
    try {
      const result = await runSpeedTest({ profile: this.settings.profile, server: this.settings.server, timeCapSeconds: this.settings.timeCapSeconds, controller }, (p) => { if (p.log) { state.log.push(p.log); return this.notifyViews(); } if (p.logUpdate) return this.notifyViews(); for (const k of Object.keys(p)) state[k] = p[k]; this.notifyViews(); });
      state.log.push({ at: now() - state.startedAt, text: 'Writing run note' });
      const file = await this.writeRunNote(result, useLabel, trigger);
      await this.waitForCache(file);
      state.log.push({ at: now() - state.startedAt, text: `Saved ${file.basename}` });
      if (useLabel && !this.settings.labels.includes(useLabel)) this.settings.labels = [useLabel, ...this.settings.labels].slice(0, 12);
      this.settings.lastLabel = useLabel;
      if (trigger !== 'manual') this.settings.lastAutoRunDay = moment().format('YYYY-MM-DD');
      await this.saveSettings();
      if (this.settings.keepSummary) { await this.writeSummary(); state.log.push({ at: now() - state.startedAt, text: 'Summary updated' }); }
      new Notice(`Speedlog: ${round(result.download)} Mbps down · ${result.upload !== null ? `${round(result.upload)} Mbps up · ` : ''}${Math.round(result.latency)} ms`);
      return file;
    } catch (e) {
      const cancelled = /cancelled/.test(String(e && e.message));
      const reason = e && e.status === 429 ? 'Cloudflare is rate-limiting this connection (429). Wait a few minutes or use the Light profile.'
        : cancelled ? 'Cancelled.'
        : `${e && e.message ? e.message : e}`;
      if (!cancelled) console.error('Speedlog', e);
      this.lastError = { when: moment(), reason, label: useLabel };
      if (!cancelled) {
        try { await this.writeFailedNote(reason, useLabel, trigger); } catch (e2) { console.error('Speedlog', e2); }
        new Notice(`Speedlog: test failed. ${reason}`, 8000);
      }
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
    const delta = (v, m) => (m ? `${v >= m ? '▲' : '▼'} ${Math.abs(Math.round(((v - m) / m) * 100))}% vs median` : `first ${profileOf(r.profile).label} run for this label`);
    const platform = `${Platform.isMobile ? 'mobile' : 'desktop'} · ${Platform.isMacOS ? 'macos' : Platform.isWin ? 'windows' : Platform.isLinux ? 'linux' : Platform.isIosApp ? 'ios' : Platform.isAndroidApp ? 'android' : 'unknown'}`;
    const server = r.server.id === 'cloudflare' ? (r.colo ? `Cloudflare · ${r.colo}` : 'Cloudflare') : r.server.name;
    const fm = [
      '---',
      `download_mbps: ${round(r.download)}`,
      ...(r.upload !== null ? [`upload_mbps: ${round(r.upload)}`] : []),
      `latency_ms: ${Math.round(r.latency)}`,
      `jitter_ms: ${round(r.jitter)}`,
      ...(r.loadedLatency !== null ? [`loaded_latency_ms: ${Math.round(r.loadedLatency)}`] : []),
      `profile: ${r.profile}`,
      `label: ${yamlString(label || '')}`,
      `server: ${yamlString(server)}`,
      `server_host: ${yamlString(hostOf(r.server))}`,
      ...(r.server.pickedMs ? [`server_picked: auto`] : []),
      `platform: ${yamlString(platform)}`,
      `trigger: ${trigger}`,
      `duration_s: ${round(r.durationMs / 1000)}`,
      ...phaseSeconds(r.timeline),
      `date: ${when.format('YYYY-MM-DDTHH:mm:ssZ')}`,
      'tags: [speedlog]',
      '---',
    ];
    const rows = history.slice(0, 10).map((h) => `| ${h.when.format('ddd D MMM, HH:mm')} | ${round(h.download)} | ${round(h.upload)} | ${Math.round(h.latency)} |`);
    const body = [
      '',
      `> [!info] Speed test · ${when.format('ddd D MMM, HH:mm')}${label ? ` · ${label}` : ''}`,
      `> **${round(r.download)} Mbps** down · ${delta(r.download, medDown)}`,
      r.upload !== null ? `> **${round(r.upload)} Mbps** up · ${delta(r.upload, medUp)}` : '> Upload not measured (time cap reached first)',
      `> **${Math.round(r.latency)} ms** latency · ±${round(r.jitter)} ms jitter${r.loadedLatency !== null ? ` · ${Math.round(r.loadedLatency)} ms under load` : ''}`,
      `> ${server} · ${profileOf(r.profile).label} profile${r.streams > 1 ? `, ${r.streams} streams` : ''} · ${round(r.bytesDown / MB, 0)} MB down, ${round(r.bytesUp / MB, 0)} MB up in ${round(r.durationMs / 1000)} s${r.capped ? ' (time cap reached)' : ''}${r.fallback ? ' · non-streaming transfer' : ''}${r.degraded ? ' · rate-limited, smaller chunks' : ''}`,
      '',
      '## Timeline', '', '| At | Step | Took | Detail |', '|---|---|---|---|',
      ...(r.timeline || []).map((t) => `| ${round(t.at / 1000, 1)} s | ${t.text} | ${t.took >= 5 ? `${round(t.took / 1000, 2)} s` : '—'} | ${t.detail.replace(/\|/g, '\\|')} |`),
      '',
      ...(rows.length ? [`## Previous runs${label ? ` · ${label}` : ''}`, '', '| When | Down | Up | Latency |', '|---|---|---|---|', ...rows, ''] : []),
      this.settings.keepSummary ? `[[${folder}/Summary|Summary]]` : '',
      '',
    ];
    const file = await this.app.vault.create(path, fm.concat(body).join('\n'));
    return file;
  }

  async writeFailedNote(reason, label, trigger) {
    const folder = await this.ensureFolder();
    const when = moment();
    const name = when.format(this.settings.filenameFormat || 'YYYY-MM-DD HHmmss').replace(/[\\/:*?"<>|]/g, '-');
    let path = normalizePath(`${folder}/${name}.md`);
    let n = 2;
    while (this.app.vault.getAbstractFileByPath(path)) { path = normalizePath(`${folder}/${name} ${n++}.md`); }
    const text = [
      '---', 'status: failed', `error: ${yamlString(reason)}`, `profile: ${this.settings.profile}`, `server: ${yamlString(serverOf(this.settings.server).name)}`, `label: ${yamlString(label || '')}`, `trigger: ${trigger}`, `date: ${when.format('YYYY-MM-DDTHH:mm:ssZ')}`, 'tags: [speedlog]', '---', '',
      `> [!failure] Speed test failed · ${when.format('ddd D MMM, HH:mm')}${label ? ` · ${label}` : ''}`,
      `> ${reason}`,
      '', this.settings.keepSummary ? `[[${folder}/Summary|Summary]]` : '', '',
    ].join('\n');
    const file = await this.app.vault.create(path, text);
    await this.waitForCache(file);
    if (this.settings.keepSummary) await this.writeSummary();
    return file;
  }

  readRuns(includeFailed = false) {
    const folder = normalizePath(this.settings.folder || 'Speed tests');
    const root = this.app.vault.getAbstractFileByPath(folder);
    if (!(root instanceof TFolder)) return [];
    const runs = [];
    for (const f of root.children) {
      if (!(f instanceof TFile) || f.extension !== 'md') continue;
      const cache = this.app.metadataCache.getFileCache(f);
      const fm = cache && cache.frontmatter;
      if (!fm) continue;
      if (fm.status === 'failed') { if (includeFailed) runs.push({ file: f, failed: true, error: String(fm.error || ''), label: String(fm.label || ''), profile: String(fm.profile || ''), when: fm.date ? moment(fm.date) : moment(f.stat.ctime) }); continue; }
      if (typeof fm.download_mbps !== 'number') continue;
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
    const failed = this.readRuns(true).filter((r) => r.failed && moment().diff(r.when, 'days') < 30);
    if (failed.length) {
      lines.push('## Failed runs · last 30 days', '', '| When | Label | Reason | Note |', '|---|---|---|---|');
      for (const r of failed) lines.push(`| ${r.when.format('ddd D MMM, HH:mm')} | ${r.label} | ${r.error.replace(/\|/g, '\\|')} | [[${r.file.path.replace(/\.md$/, '')}\\|open]] |`);
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

// Seconds spent in each phase, summed from the timeline, as front matter keys
function phaseSeconds(timeline) {
  const sum = { pick: 0, latency: 0, download: 0, upload: 0 };
  for (const t of timeline || []) {
    const k = /^(Pinging|Picked)/.test(t.text) ? 'pick' : /^Latency/.test(t.text) ? 'latency' : /^(Warm-up|Download|Rate-limited|Server refused)/.test(t.text) ? 'download' : /^Upload/.test(t.text) ? 'upload' : null;
    if (k) sum[k] += t.took;
  }
  return Object.entries(sum).filter(([k, v]) => v > 0 || k !== 'pick').map(([k, v]) => `${k}_s: ${round(v / 1000)}`);
}

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

    const failed = !running && p.lastError && (!last || p.lastError.when.valueOf() > last.when.valueOf()) ? p.lastError : null;
    const card = root.createDiv({ cls: 'speedlog-card' });
    if (failed) card.addClass('is-failed');
    const head = card.createDiv({ cls: 'speedlog-card-head' });
    head.createSpan({ cls: 'speedlog-kicker', text: running ? 'Running' : failed ? 'Failed' : 'Last run' });
    head.createSpan({ cls: 'speedlog-muted', text: running ? running.text : failed ? `${failed.when.fromNow()}${failed.label ? ` · ${failed.label}` : ''}` : last ? `${last.when.fromNow()}${last.label ? ` · ${last.label}` : ''}` : 'No runs yet' });
    if (failed) card.createDiv({ cls: 'speedlog-error', text: failed.reason });
    const nums = card.createDiv({ cls: 'speedlog-nums' });
    const show = (v, unit, d = 1) => (v === undefined || v === null || Number.isNaN(v) ? '—' : `${round(v, d)}`) + (unit ? ` ${unit}` : '');
    const src = running ? { download: running.download, upload: running.upload, latency: running.latency, jitter: undefined } : failed ? null : last;
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
    const logLines = running ? running.log : p.lastLog;
    if (logLines && logLines.length) {
      const details = card.createEl('details', { cls: 'speedlog-log' });
      details.open = !!running;
      details.createEl('summary', { text: running ? 'What is happening' : `Last run · ${logLines.length} steps` });
      const list = details.createDiv({ cls: 'speedlog-log-list' });
      for (const l of logLines) { const row = list.createDiv({ cls: 'speedlog-log-row' }); row.createSpan({ cls: 'speedlog-log-at', text: `${round(l.at / 1000, 1)} s` }); row.createSpan({ cls: 'speedlog-log-text', text: l.text + (l.took ? ` (${round(l.took / 1000, 2)} s)` : '') }); }
      if (running) list.scrollTop = list.scrollHeight;
    }

    const form = root.createDiv({ cls: 'speedlog-form' });
    const input = form.createEl('input', { type: 'text', cls: 'speedlog-label', attr: { placeholder: 'Label this run, e.g. home wifi', 'aria-label': 'Label for this run' } });
    input.value = p.settings.lastLabel || '';
    const btn = form.createEl('button', { cls: running ? 'speedlog-run mod-warning' : 'mod-cta speedlog-run', attr: { 'aria-label': running ? 'Cancel speed test' : 'Run speed test' } });
    setIcon(btn.createSpan({ cls: 'speedlog-run-icon' }), running ? 'square' : 'play');
    btn.createSpan({ text: running ? 'Cancel' : 'Run test' });
    const go = () => { if (p.running) { p.running.cancel(); } else { p.runAndLog('manual', input.value); } };
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

    const all = p.readRuns(true);
    if (all.length) {
      const sec = root.createDiv({ cls: 'speedlog-section' });
      sec.createDiv({ cls: 'speedlog-section-head' }).createSpan({ cls: 'speedlog-kicker', text: 'Recent runs' });
      const list = sec.createDiv({ cls: 'speedlog-list' });
      const worst = Math.min(...runs.slice(0, 8).map((r) => r.download));
      for (const r of all.slice(0, 8)) {
        const row = list.createEl('a', { cls: 'speedlog-row', href: '#', attr: { 'aria-label': `Open run ${r.when.format('LLL')}` } });
        row.createSpan({ cls: 'speedlog-row-when', text: r.when.calendar(null, { sameDay: '[Today] HH:mm', lastDay: '[Yesterday] HH:mm', lastWeek: 'ddd HH:mm', sameElse: 'D MMM HH:mm' }) });
        row.createSpan({ cls: 'speedlog-row-label speedlog-muted', text: r.label || '' });
        if (r.failed) { row.createSpan({ cls: 'speedlog-row-num speedlog-row-failed', text: 'Failed' }); row.createSpan({ cls: 'speedlog-row-num' }); row.createSpan({ cls: 'speedlog-row-num' }); this.registerDomEvent(row, 'click', (e) => { e.preventDefault(); this.app.workspace.getLeaf(false).openFile(r.file); }); continue; }
        const d = row.createSpan({ cls: 'speedlog-row-num', text: round(r.download).toString() });
        if (runs.length > 2 && r.download === worst) d.addClass('is-worst');
        row.createSpan({ cls: 'speedlog-row-num speedlog-muted', text: round(r.upload).toString() });
        row.createSpan({ cls: 'speedlog-row-num speedlog-muted', text: Math.round(r.latency).toString() });
        this.registerDomEvent(row, 'click', (e) => { e.preventDefault(); this.app.workspace.getLeaf(false).openFile(r.file); });
      }
    }

    const foot = root.createDiv({ cls: 'speedlog-foot speedlog-muted' });
    const dpr = dataPerRun(p.settings.profile);
    foot.setText(`${runs.length ? `${runs.length} ${runs.length === 1 ? 'run' : 'runs'} · since ${runs[runs.length - 1].when.format('D MMM')} · ` : ''}${serverOf(p.settings.server).name} · ${profileOf(p.settings.profile).label}: about ${dpr.down} MB down, ${dpr.up} MB up per run`);
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
    new Setting(containerEl).setName('Profile').setDesc('Light for hotspots and metered plans. Balanced is a single stream. Accurate runs four streams at once, the way browser speed tests do, and also measures latency under load.')
      .addDropdown((d) => d.addOptions(opts).setValue(s.profile in PROFILES ? s.profile : 'balanced').onChange(async (v) => { s.profile = v; await save(); this.plugin.notifyViews(); }));
    const servers = { cloudflare: 'Cloudflare · nearest edge', [AUTO.id]: 'LibreSpeed · nearest (picked each run)' };
    for (const x of LIBRESPEED) servers[x.id] = `${x.name} · LibreSpeed`;
    new Setting(containerEl).setName('Server').setDesc('Cloudflare picks the edge nearest you and is the best-maintained. The LibreSpeed servers are run by volunteers; pick one near you when the default is rate-limiting you or you want a second opinion. Only the selected server is ever contacted.')
      .addDropdown((d) => d.addOptions(servers).setValue(servers[s.server] ? s.server : 'cloudflare').onChange(async (v) => { s.server = v; await save(); this.plugin.notifyViews(); }));
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
    new Setting(containerEl).setName('Filename format').setDesc('Moment.js format for run notes, for example YYYY-MM-DD HHmmss.')
      .addText((t) => t.setValue(s.filenameFormat).setPlaceholder(moment().format('YYYY-MM-DD HHmmss')).onChange(async (v) => { s.filenameFormat = v.trim() || 'YYYY-MM-DD HHmmss'; await save(); }));
    new Setting(containerEl).setName('Keep Summary.md updated').setDesc('Median, best and worst per label, and the last 7 days, rewritten after every run.')
      .addToggle((t) => t.setValue(s.keepSummary).onChange(async (v) => { s.keepSummary = v; await save(); }));
    new Setting(containerEl).setName('Status bar').setDesc('Show the last result in the status bar; click it to run again.')
      .addToggle((t) => t.setValue(s.showStatusBar).onChange(async (v) => { s.showStatusBar = v; await save(); this.plugin.refreshStatus(); }));
  }
}

module.exports = SpeedlogPlugin;
