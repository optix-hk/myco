// bug-90: Browser refresh reverts plan items with successful runs to
// their initial state. Root cause: `_stampPlanItemStatus` and
// `_stampPlanItemRunOutcome` (server/src/attach.js) mutated the
// in-memory `rec.artifacts.plan.items[].runs[]` + run-summary
// `comments[]` and called `sessionsMod.saveStore()` (persists to
// /data/sessions.json) but NEVER mirrored the change to
// `_myco_/plan.json`. On browser refresh, `_sendAttachSnapshot` reads
// the FILE first — which lacked the runs[] — so the client rendered a
// runs-less state, making the item look like it had never been run.
//
// What this test pins:
//   1. `persistArtifact` is a PUBLIC export of server/src/artifacts.js
//      (not just under __test) so attach.js can call it without
//      reaching into a test-only namespace.
//   2. `_stampPlanItemStatus` (attach.js) calls `persistArtifact` on
//      the plan artifact — not just `sessionsMod.saveStore()`.
//   3. `_stampPlanItemRunOutcome` (attach.js) does the same.
//   4. An inline ref-impl of the persistence contract: mutating
//      in-memory then "reloading from file" preserves runs[] + the
//      run-summary comment. Pre-fix the file would be missing both.
//
// Style mirrors test/bug-89-nested-repo-detect.test.js (static reads
// of server source + an inline ref-impl of the contract).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const ATTACH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'attach.js'), 'utf8');
const ARTIFACTS = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'artifacts.js'), 'utf8');

console.log('── bug-90: runs[] persist to _myco_/plan.json ──');

// ──────────────────────────────────────────────────────────────────────
// Helper: slice a top-level function body from a source string, from
// its `function name(` line to the next column-0 `}` line. Mirrors
// the test/_lib/fn-body.js convention (avoids hand-picked N-byte
// windows — see CLAUDE.md §10 b).
// ──────────────────────────────────────────────────────────────────────
function sliceFn(src, name) {
  const start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(start > -1, name + ' must be a top-level function');
  const rest = src.slice(start);
  // Match the closing brace at column 0 (start of line, no indent).
  const endMatch = rest.slice(1).match(/\n\}/);
  assert.ok(endMatch, name + ' must have a column-0 closing brace');
  return rest.slice(0, rest.slice(1).indexOf(endMatch[0]) + 2);
}

// ──────────────────────────────────────────────────────────────────────
// 1. persistArtifact must be a PUBLIC export of artifacts.js.
// ──────────────────────────────────────────────────────────────────────

t('artifacts.js: persistArtifact is defined as a top-level function', () => {
  assert.ok(/function\s+persistArtifact\s*\(/.test(ARTIFACTS),
    'persistArtifact must be a top-level function in artifacts.js');
});

t('artifacts.js: persistArtifact is in module.exports (public, not just __test)', () => {
  // Pin the public export so attach.js can call it without reaching
  // into the __test namespace. The export line should appear in the
  // top-level module.exports block, not just under __test.
  const exportBlockMatch = ARTIFACTS.match(/module\.exports\s*=\s*\{([\s\S]*?)\n\};/);
  assert.ok(exportBlockMatch, 'module.exports block must exist');
  const exportBlock = exportBlockMatch[1];
  // The top-level block must list persistArtifact as a bare export
  // (not nested under __test:).
  assert.ok(/^\s*persistArtifact\s*,?\s*$/m.test(exportBlock),
    'persistArtifact must be a bare top-level export in module.exports (attach.js needs to call it — not a __test-only helper)');
});

// ──────────────────────────────────────────────────────────────────────
// 2. _stampPlanItemStatus calls persistArtifact (not just saveStore).
// ──────────────────────────────────────────────────────────────────────

t('attach.js: _stampPlanItemStatus calls persistArtifact on the plan artifact', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemStatus');
  assert.ok(/persistArtifact\s*\(/.test(body),
    '_stampPlanItemStatus must call persistArtifact to mirror runs[] to _myco_/plan.json — saveStore() alone only persists to /data/sessions.json, which the file-first attach snapshot does not read');
});

t('attach.js: _stampPlanItemStatus passes the plan artifact to persistArtifact', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemStatus');
  // Must pass (rec, "plan", <planArtifact>) — not just (rec, "plan").
  assert.ok(/persistArtifact\s*\(\s*rec\s*,\s*['"]plan['"]\s*,\s*[A-Za-z_]/.test(body),
    '_stampPlanItemStatus must call persistArtifact(rec, "plan", planArtifact) so the mutated artifact (with the new runs[] entry) is the one written to the file');
});

// ──────────────────────────────────────────────────────────────────────
// 3. _stampPlanItemRunOutcome calls persistArtifact (not just saveStore).
// Same fix — it also pushes run-summary comments that suffer the same
// loss on refresh.
// ──────────────────────────────────────────────────────────────────────

t('attach.js: _stampPlanItemRunOutcome calls persistArtifact on the plan artifact', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  assert.ok(/persistArtifact\s*\(/.test(body),
    '_stampPlanItemRunOutcome must call persistArtifact to mirror runs[] + run-summary comments to _myco_/plan.json — saveStore() alone loses them on browser refresh');
});

t('attach.js: _stampPlanItemRunOutcome passes the plan artifact to persistArtifact', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  assert.ok(/persistArtifact\s*\(\s*rec\s*,\s*['"]plan['"]\s*,\s*[A-Za-z_]/.test(body),
    '_stampPlanItemRunOutcome must call persistArtifact(rec, "plan", planArtifact) so the mutated artifact (with the outcome + run-summary comment) is written to the file');
});

// ──────────────────────────────────────────────────────────────────────
// 4. Inline ref-impl of the persistence contract. Pre-fix, the
// "file" never received runs[]; post-fix, persistArtifact mirrors
// them. We simulate the flow with a fake "file" object + the same
// write-through semantics persistArtifact uses.
// ──────────────────────────────────────────────────────────────────────

// Fake persistence surface mirroring persistArtifact's contract:
//   in-memory store  ←  file  (read on attach — file wins)
//   file             ←  in-memory (write on persistArtifact)
// Pre-fix: _stamp* wrote to in-memory + saveStore (sessions.json)
// but NEVER to the file. On refresh, the file (lacking runs[])
// overwrote the in-memory state → runs[] lost.
function makeFakeStore() {
  const fileState = { plan: { items: [] } };   // _myco_/plan.json
  const memState = { plan: { items: [] } };    // rec.artifacts.plan
  return {
    fileState,
    memState,
    // Read what the attach snapshot would see (file-first).
    readForAttach() { return JSON.parse(JSON.stringify(fileState.plan)); },
    // persistArtifact contract: write in-memory AND file AND saveStore.
    persistArtifact(type, artifact) {
      memState[type] = artifact;
      fileState[type] = JSON.parse(JSON.stringify(artifact));
    },
    // Pre-fix _stamp* behavior: only saveStore (in-memory + sessions.json).
    // The file is NOT touched.
    buggySaveStore() { /* sessions.json write — no file mirror */ },
  };
}

// Mirror _stampPlanItemStatus's mutation: append to item.runs[].
function stampStatus(store, itemId, status, summary) {
  const item = store.memState.plan.items.find((it) => it.id === itemId);
  if (!item) return;
  if (!Array.isArray(item.runs)) item.runs = [];
  item.runs.push({ status, ts: new Date().toISOString(), summary: summary || null });
  if (item.runs.length > 10) item.runs = item.runs.slice(-10);
  // POST-FIX: persistArtifact mirrors to file.
  store.persistArtifact('plan', store.memState.plan);
}

// Mirror _stampPlanItemRunOutcome's mutation: replace running entry
// with outcome + push a run-summary comment.
function stampOutcome(store, itemId, outcome, summaryText) {
  const item = store.memState.plan.items.find((it) => it.id === itemId);
  if (!item) return;
  if (!Array.isArray(item.runs)) item.runs = [];
  const last = item.runs[item.runs.length - 1];
  if (last && last.status === 'running') {
    item.runs[item.runs.length - 1] = outcome;
  } else {
    item.runs.push(outcome);
  }
  if (!Array.isArray(item.comments)) item.comments = [];
  item.comments.push({
    id: 'c1', user: 'claude', text: summaryText,
    ts: outcome.ts, meta: { kind: 'run-summary' },
  });
  // POST-FIX: persistArtifact mirrors to file.
  store.persistArtifact('plan', store.memState.plan);
}

t('ref: runs[] stamped by _stampPlanItemStatus survive a file-first reload', () => {
  const store = makeFakeStore();
  store.memState.plan.items.push({ id: 'bug-90', text: 'refresh loses runs', done: false, runs: [] });
  // Initial persist so the file has the item.
  store.persistArtifact('plan', store.memState.plan);

  // Stamp a "running" status (mirrors _stampPlanItemStatus).
  stampStatus(store, 'bug-90', 'running', 'dispatched');

  // Simulate browser refresh: attach reads file-first.
  const afterRefresh = store.readForAttach();
  const item = afterRefresh.items.find((it) => it.id === 'bug-90');
  assert.ok(item, 'item must survive refresh');
  assert.ok(Array.isArray(item.runs) && item.runs.length === 1,
    'runs[] stamped by _stampPlanItemStatus must survive a file-first reload — pre-fix the file never received the entry and refresh wiped it');
  assert.strictEqual(item.runs[0].status, 'running');
});

t('ref: run outcome + run-summary comment survive a file-first reload', () => {
  const store = makeFakeStore();
  store.memState.plan.items.push({ id: 'fr-102', text: '@user filter', done: false, runs: [], comments: [] });
  store.persistArtifact('plan', store.memState.plan);

  // Stamp running, then stamp the outcome.
  stampStatus(store, 'fr-102', 'running', 'dispatched');
  stampOutcome(store, 'fr-102',
    { status: 'success', ts: new Date().toISOString(), summary: '6.4s · 1k→2k tok', result: 'Shipped @user filter.' },
    '✓ Shipped @user filter. · 6.4s · $0.01 · 1k↓/2k↑');

  const afterRefresh = store.readForAttach();
  const item = afterRefresh.items.find((it) => it.id === 'fr-102');
  assert.ok(item, 'item must survive refresh');
  assert.strictEqual(item.runs.length, 1, 'outcome should have replaced the running placeholder');
  assert.strictEqual(item.runs[0].status, 'success',
    'run outcome must survive refresh — pre-fix refresh reverted the item to its pre-run state');
  assert.ok(Array.isArray(item.comments) && item.comments.length === 1,
    'run-summary comment must survive refresh — pre-fix it was lost alongside the run');
  assert.strictEqual(item.comments[0].meta.kind, 'run-summary');
});

t('ref: PRE-FIX simulation (no persistArtifact call) loses runs[] on reload', () => {
  // This is the regression sentinel: it documents the bug-90 failure
  // mode by simulating the pre-fix behavior (saveStore only, no file
  // mirror) and asserting the loss happens. Keeps the test honest —
  // if someone removed the persistArtifact calls from _stamp*, the
  // post-fix tests above would fail AND this test would still pass,
  // confirming the model is correct.
  const store = makeFakeStore();
  store.memState.plan.items.push({ id: 'bug-90', text: 'refresh loses runs', done: false, runs: [] });
  store.persistArtifact('plan', store.memState.plan);

  // Pre-fix _stampPlanItemStatus: only saveStore (no file write).
  const item = store.memState.plan.items.find((it) => it.id === 'bug-90');
  item.runs.push({ status: 'running', ts: new Date().toISOString(), summary: 'dispatched' });
  store.buggySaveStore();

  const afterRefresh = store.readForAttach();
  const reloaded = afterRefresh.items.find((it) => it.id === 'bug-90');
  assert.strictEqual(reloaded.runs.length, 0,
    'pre-fix simulation: file never received the runs[] entry, so refresh reverts it to empty — this is the bug-90 failure mode');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
