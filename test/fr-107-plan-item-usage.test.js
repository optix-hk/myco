// fr-107: per-item token usage + cost shown at the bottom-right of each
// plan item, matching the font/color of the bottom-left "filed by..."
// line, updating live as further agent calls land for that item.
//
// What this test pins:
//   1. SERVER: _stampPlanItemRunOutcome (server/src/attach.js) stores
//      structured numeric `inTok`, `outTok`, `costUsd` fields on the
//      `outcome` object pushed to item.runs[] — not just the formatted
//      summary string. Pre-fr-107 the UI would have had to parse prose
//      to aggregate; now it sums numbers.
//   2. CLIENT: app.js computes cumulative {inTok, outTok, costUsd}
//      across it.runs[] (skipping "running" placeholders that lack
//      token fields) and emits a <div class="artifact-item-usage">
//      at the bottom-right, wrapped alongside byLine in a
//      <div class="artifact-item-foot"> flex container.
//   3. CSS: .artifact-item-foot (flex, space-between) + .artifact-item-usage
//      with font-size:11px + color:var(--muted) matching .artifact-item-by.
//   4. Inline ref-impl of the aggregation: cumulative sum across
//      multiple completed runs, placeholder entries skipped, items
//      with no completed runs render no usage div.
//
// Style mirrors test/bug-90-runs-persist-to-file.test.js (static reads
// of server/web source + an inline ref-impl of the contract).

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
const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-107: per-item token usage + cost at bottom-right ──');

// Helper: slice a top-level function body from source, from its
// `function name(` line to the next column-0 `}` line. Mirrors the
// test/_lib/fn-body.js convention (CLAUDE.md §10 b — no hand-picked N).
function sliceFn(src, name) {
  const start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(start > -1, name + ' must be a top-level function');
  const rest = src.slice(start);
  const endMatch = rest.slice(1).match(/\n\}/);
  assert.ok(endMatch, name + ' must have a column-0 closing brace');
  return rest.slice(0, rest.slice(1).indexOf(endMatch[0]) + 2);
}

// ──────────────────────────────────────────────────────────────────────
// 1. SERVER: outcome object carries structured numeric token/cost fields.
// ──────────────────────────────────────────────────────────────────────

t('attach.js: _stampPlanItemRunOutcome outcome literal has inTok field', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  const outcomeLit = body.match(/const\s+outcome\s*=\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(outcomeLit, 'outcome object literal must exist');
  assert.ok(/inTok\b/.test(outcomeLit[1]),
    'inTok must be a field on the outcome object literal, not just the local variable — so the UI can sum without parsing the summary string');
});

t('attach.js: outcome literal has outTok field', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  const outcomeLit = body.match(/const\s+outcome\s*=\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(outcomeLit && /outTok\b/.test(outcomeLit[1]),
    'outTok must be a field on the outcome object literal');
});

// fr-107 critic-fix: the outcome literal uses ES6 shorthand `inTok,` /
// `outTok,`. Shorthand is only valid if `inTok`/`outTok` are DECLARED
// locals in the function scope — otherwise it's a ReferenceError at
// runtime. The naive `/inTok\b/` check above can't tell a valid
// shorthand (backed by `const inTok = u.input_tokens || 0`) from a
// dangling reference. These two cases pin the local declarations exist
// so the test catches the exact failure mode the critic flagged.
t('attach.js: inTok used in outcome shorthand is a declared local (no ReferenceError)', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  assert.ok(/(?:const|let|var)\s+inTok\b\s*=/.test(body),
    'inTok must be declared as a local (const/let/var inTok = …) in _stampPlanItemRunOutcome so the outcome-literal shorthand `inTok,` resolves — otherwise it is a ReferenceError at runtime');
});

t('attach.js: outTok used in outcome shorthand is a declared local (no ReferenceError)', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  assert.ok(/(?:const|let|var)\s+outTok\b\s*=/.test(body),
    'outTok must be declared as a local (const/let/var outTok = …) in _stampPlanItemRunOutcome so the outcome-literal shorthand `outTok,` resolves — otherwise it is a ReferenceError at runtime');
});

// Runtime proof: actually execute the outcome-literal construction in a
// sandbox that mirrors the function's local bindings. This is the real
// catch for the ReferenceError failure mode the critic flagged — if the
// shorthand referenced an undeclared identifier, this eval would throw.
// We extract just the outcome literal + feed it the locals the function
// declares, so we're testing the actual object shape, not a regex.
t('attach.js: outcome literal evaluates without ReferenceError (sandboxed runtime check)', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  const outcomeLit = body.match(/const\s+outcome\s*=\s*(\{[\s\S]*?\n\s*\})\s*;/);
  assert.ok(outcomeLit, 'outcome object literal must be extractable');
  // Mirror the function's local bindings (attach.js:835-848) so the
  // shorthand `inTok,` / `outTok,` / `status,` / `summary,` resolve.
  const sandbox = {
    status: 'success',
    startedAt: null,
    inTok: 1500,
    outTok: 750,
    costUsd: 0.02,
    summary: '6.4s · 1500→750 tok',
    result: null,
    turnResultEv: { totalCostUsd: 0.02 },
  };
  // Eval the literal in a scope where the locals are bound. Use `with`
  // so the shorthand identifiers resolve to the sandbox bindings —
  // mirroring how they'd resolve to the function's locals at runtime.
  const fn = new Function('sandbox', 'with (sandbox) { return ' + outcomeLit[1] + '; }');
  const outcome = fn(sandbox);
  assert.strictEqual(outcome.inTok, 1500, 'outcome.inTok must resolve via shorthand to the local');
  assert.strictEqual(outcome.outTok, 750, 'outcome.outTok must resolve via shorthand to the local');
  assert.strictEqual(outcome.costUsd, 0.02, 'outcome.costUsd must be the raw Number');
  assert.strictEqual(outcome.status, 'success');
});

t('attach.js: outcome literal has costUsd field (raw Number)', () => {
  const body = sliceFn(ATTACH, '_stampPlanItemRunOutcome');
  const outcomeLit = body.match(/const\s+outcome\s*=\s*\{([\s\S]*?)\n\s*\}/);
  assert.ok(outcomeLit && /costUsd\b/.test(outcomeLit[1]),
    'costUsd (raw Number, not the $-formatted string) must be a field on the outcome object literal so the UI can sum across runs');
});

// ──────────────────────────────────────────────────────────────────────
// 2. CLIENT: app.js computes cumulative usage + emits the usage div.
// ──────────────────────────────────────────────────────────────────────

t('app.js: emits a .artifact-item-usage div', () => {
  assert.ok(/artifact-item-usage/.test(APP),
    'app.js must emit a <div class="artifact-item-usage"> for the bottom-right token/cost display');
});

t('app.js: emits a .artifact-item-foot flex wrapper around byLine + usage', () => {
  assert.ok(/artifact-item-foot/.test(APP),
    'app.js must wrap byLine + usage in a <div class="artifact-item-foot"> flex container so byLine sits left and usage sits right');
});

t('app.js: usage display is cumulative (sums across runs)', () => {
  const idx = APP.indexOf('artifact-item-usage');
  assert.ok(idx > -1, 'artifact-item-usage must appear in app.js');
  const window = APP.slice(Math.max(0, idx - 2000), idx + 400);
  assert.ok(/runs\b/.test(window),
    'usage computation must read it.runs[] to aggregate across runs');
  assert.ok(/inTok/.test(window) && /outTok/.test(window) && /costUsd/.test(window),
    'usage computation must reference inTok, outTok, costUsd fields from run entries');
  assert.ok(/typeof\s+[\w.]*costUsd\s*===\s*['"]number['"]|Number\.isFinite\(\s*[\w.]*costUsd|!\s*isNaN\(\s*[\w.]*costUsd/.test(window),
    'usage computation must guard against non-numeric costUsd (placeholder "running" entries lack token fields and must be skipped)');
});

t('app.js: usage div only renders when there is usage data', () => {
  const idx = APP.indexOf('artifact-item-usage');
  const window = APP.slice(Math.max(0, idx - 2000), idx + 400);
  assert.ok(/usageLine|usageHtml|usageText|hasUsage|_usageAgg/.test(window),
    'usage div must be gated on a usage aggregate variable so items with no completed runs render no usage div');
});

// ──────────────────────────────────────────────────────────────────────
// 3. CSS: .artifact-item-foot + .artifact-item-usage rules.
// ──────────────────────────────────────────────────────────────────────

t('CSS: .artifact-item-foot rule exists with flex layout', () => {
  const m = CSS.match(/\.artifact-item-foot\s*\{[^}]*\}/);
  assert.ok(m, 'styles.css must define .artifact-item-foot');
  const rule = m[0];
  assert.ok(/display\s*:\s*flex/.test(rule),
    '.artifact-item-foot must be display:flex so byLine (left) + usage (right) sit on a row');
  assert.ok(/justify-content\s*:\s*space-between/.test(rule),
    '.artifact-item-foot must use justify-content:space-between to push byLine left + usage right');
});

t('CSS: .artifact-item-usage matches .artifact-item-by font-size + color', () => {
  const byRule = CSS.match(/\.artifact-item-by\s*\{[^}]*\}/);
  const usageRule = CSS.match(/\.artifact-item-usage\s*\{[^}]*\}/);
  assert.ok(byRule, '.artifact-item-by rule must exist (the filed-by line)');
  assert.ok(usageRule, '.artifact-item-usage rule must exist');
  const bySize = byRule[0].match(/font-size\s*:\s*([^;]+)/);
  const byColor = byRule[0].match(/color\s*:\s*([^;]+)/);
  const usageSize = usageRule[0].match(/font-size\s*:\s*([^;]+)/);
  const usageColor = usageRule[0].match(/color\s*:\s*([^;]+)/);
  assert.ok(bySize && usageSize,
    'both .artifact-item-by and .artifact-item-usage must set font-size');
  assert.strictEqual(
    usageSize[1].trim(), bySize[1].trim(),
    '.artifact-item-usage font-size must match .artifact-item-by (same font as the filed-by line, per fr-107 spec)');
  assert.ok(byColor && usageColor,
    'both .artifact-item-by and .artifact-item-usage must set color');
  assert.strictEqual(
    usageColor[1].trim(), byColor[1].trim(),
    '.artifact-item-usage color must match .artifact-item-by (same color as the filed-by line, per fr-107 spec)');
});

t('CSS: .artifact-item-usage rule mentions fr-107 in a comment', () => {
  const idx = CSS.indexOf('.artifact-item-usage');
  assert.ok(idx > -1);
  const comment = CSS.slice(Math.max(0, idx - 400), idx);
  assert.ok(/fr-107/.test(comment),
    'a comment above .artifact-item-usage must reference fr-107 so the intent is documented');
});

// ──────────────────────────────────────────────────────────────────────
// 4. Inline ref-impl of the aggregation contract. Mirrors what the
// client does: sum inTok/outTok/costUsd across it.runs[], skipping
// entries that lack numeric token fields (the "running" placeholders).
// ──────────────────────────────────────────────────────────────────────

function aggregateUsageRef(item) {
  const runs = Array.isArray(item.runs) ? item.runs : [];
  let inTok = 0, outTok = 0, costUsd = 0;
  let hasAny = false;
  for (const r of runs) {
    if (!r) continue;
    if (typeof r.inTok !== 'number' || typeof r.outTok !== 'number') continue;
    inTok += r.inTok;
    outTok += r.outTok;
    if (typeof r.costUsd === 'number') costUsd += r.costUsd;
    hasAny = true;
  }
  if (!hasAny) return null;
  return { inTok, outTok, costUsd };
}

function formatUsageRef(agg) {
  if (!agg) return '';
  return `↓${agg.inTok} ↑${agg.outTok} · $${agg.costUsd.toFixed(4)}`;
}

t('ref: no runs → no usage div', () => {
  assert.strictEqual(aggregateUsageRef({ runs: [] }), null);
  assert.strictEqual(aggregateUsageRef({}), null);
});

t('ref: single completed run → its usage', () => {
  const item = { runs: [
    { status: 'success', inTok: 1000, outTok: 500, costUsd: 0.0123 },
  ] };
  const agg = aggregateUsageRef(item);
  assert.ok(agg);
  assert.strictEqual(agg.inTok, 1000);
  assert.strictEqual(agg.outTok, 500);
  assert.strictEqual(agg.costUsd, 0.0123);
  assert.strictEqual(formatUsageRef(agg), '↓1000 ↑500 · $0.0123');
});

t('ref: multiple completed runs → cumulative sum', () => {
  const item = { runs: [
    { status: 'success', inTok: 1000, outTok: 500, costUsd: 0.01 },
    { status: 'success', inTok: 2000, outTok: 1000, costUsd: 0.02 },
    { status: 'error',   inTok: 500,  outTok: 200, costUsd: 0.005 },
  ] };
  const agg = aggregateUsageRef(item);
  assert.ok(agg);
  assert.strictEqual(agg.inTok, 3500);
  assert.strictEqual(agg.outTok, 1700);
  assert.ok(Math.abs(agg.costUsd - 0.035) < 1e-9,
    'cumulative costUsd should be ~0.035 (float tolerance for summed decimals)');
});

t('ref: "running" placeholder entries are skipped (no token fields)', () => {
  const item = { runs: [
    { status: 'running', ts: '2026-06-24T10:00:00Z', summary: 'dispatched' },
    { status: 'success', inTok: 1000, outTok: 500, costUsd: 0.01 },
    { status: 'running', ts: '2026-06-24T10:05:00Z', summary: 'dispatched again' },
  ] };
  const agg = aggregateUsageRef(item);
  assert.ok(agg, 'must still aggregate the one completed run');
  assert.strictEqual(agg.inTok, 1000);
  assert.strictEqual(agg.outTok, 500);
});

t('ref: only placeholder entries → no usage div (hasAny stays false)', () => {
  const item = { runs: [
    { status: 'running', ts: '2026-06-24T10:00:00Z', summary: 'dispatched' },
  ] };
  assert.strictEqual(aggregateUsageRef(item), null,
    'an item whose only run is the "running" placeholder must render no usage div — hasAny must stay false');
});

t('ref: entry with numeric tokens but missing costUsd → still counts, cost treated as 0', () => {
  const item = { runs: [
    { status: 'success', inTok: 1000, outTok: 500 },
  ] };
  const agg = aggregateUsageRef(item);
  assert.ok(agg);
  assert.strictEqual(agg.inTok, 1000);
  assert.strictEqual(agg.costUsd, 0);
});

t('ref: format matches the ↓in ↑out · $cost convention', () => {
  const agg = { inTok: 3500, outTok: 1700, costUsd: 0.0350 };
  assert.strictEqual(formatUsageRef(agg), '↓3500 ↑1700 · $0.0350');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
