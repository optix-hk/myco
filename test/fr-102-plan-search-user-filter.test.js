// fr-102: @<username> structured user-filter token in the plan-search
// query. Typing `@<login>` filters items to those filed by that user
// (it.addedBy, case-insensitive); any remaining text after the
// @<username> token continues to behave as a normal keyword filter.
// The @<username> is rendered in blue in the "no items match" summary
// line (per @foster-chen's request: "render ampersand and username
// blue").
//
// What this test pins:
//   1. _parsePlanSearchQuery: extracts { user, keyword } from a raw
//      search string. First @<login> wins; remainder is the keyword.
//   2. _filterPlanItems: honors the @user filter against it.addedBy
//      (case-insensitive), ANDs with the keyword substring, and with
//      the existing openOnly / types filters.
//   3. The "no items match" summary line in renderArtifact emits the
//      @username wrapped in <span class="plan-search-user-token"> so
//      the CSS rule colors it blue. The keyword remainder (if any)
//      gets the existing `search "…"` chip.
//   4. CSS rule for .plan-search-user-token exists in styles.css.
//
// Style mirrors test/fr-56-plan-filter-search.test.js (static reads of
// app.js / styles.css + an inline ref impl of the filter semantics).

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); console.log('  ✓ ' + name); passed++; }
  catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
}

const APP = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'app.js'), 'utf8');
const CSS = fs.readFileSync(
  path.join(__dirname, '..', 'web', 'public', 'styles.css'), 'utf8');

console.log('── fr-102: @user filter in plan-search ──');

// ──────────────────────────────────────────────────────────────────────
// 1. _parsePlanSearchQuery is defined + behaves per spec.
// ──────────────────────────────────────────────────────────────────────

t('app.js: _parsePlanSearchQuery is defined', () => {
  assert.ok(/function\s+_parsePlanSearchQuery\s*\(/.test(APP),
    '_parsePlanSearchQuery must be a top-level function in app.js');
});

t('app.js: _parsePlanSearchQuery uses /@[a-z0-9_-]+/i regex', () => {
  // Pin the username pattern so a future loosening (e.g. allowing spaces
  // inside @user) doesn't silently change the token boundary.
  assert.ok(/PLAN_SEARCH_USER_TOKEN_RE\s*=\s*\/@\(\[a-z0-9_-\]\+\)\/i/.test(APP),
    'PLAN_SEARCH_USER_TOKEN_RE must be /@([a-z0-9_-]+)/i — GitHub-style login chars only');
});

// Inline ref impl mirroring _parsePlanSearchQuery.
function parseRef(raw) {
  const s = String(raw || '').trim();
  if (!s) return { user: null, keyword: '' };
  const m = s.match(/@([a-z0-9_-]+)/i);
  if (!m) return { user: null, keyword: s.toLowerCase() };
  const user = m[1].toLowerCase();
  const remainder = s.replace(/@([a-z0-9_-]+)/i, ' ').replace(/\s+/g, ' ').trim();
  return { user, keyword: remainder.toLowerCase() };
}

t('ref: @user alone → user set, keyword empty', () => {
  assert.deepStrictEqual(parseRef('@foster-chen'), { user: 'foster-chen', keyword: '' });
});

t('ref: @user + keyword → both set, @user token stripped from keyword', () => {
  assert.deepStrictEqual(parseRef('@foster-chen dark mode'),
    { user: 'foster-chen', keyword: 'dark mode' });
});

t('ref: keyword + @user (mid-query) → both set, token order irrelevant', () => {
  assert.deepStrictEqual(parseRef('dark mode @foster-chen'),
    { user: 'foster-chen', keyword: 'dark mode' });
});

t('ref: no @user token → user null, keyword is the lowercased query', () => {
  assert.deepStrictEqual(parseRef('dark mode'), { user: null, keyword: 'dark mode' });
});

t('ref: empty / whitespace → user null, keyword empty', () => {
  assert.deepStrictEqual(parseRef(''), { user: null, keyword: '' });
  assert.deepStrictEqual(parseRef('   '), { user: null, keyword: '' });
});

t('ref: @user is case-insensitive (lowercased)', () => {
  assert.deepStrictEqual(parseRef('@Foster-Chen'),
    { user: 'foster-chen', keyword: '' });
});

t('ref: only the FIRST @user token is extracted; subsequent @x stays in keyword', () => {
  // Per A1: first match wins. Second @token is literal keyword text.
  const r = parseRef('@alice @bob');
  assert.strictEqual(r.user, 'alice');
  assert.strictEqual(r.keyword, '@bob');
});

// ──────────────────────────────────────────────────────────────────────
// 2. _filterPlanItems honors @user against it.addedBy.
// ──────────────────────────────────────────────────────────────────────

function filterRef(items, opts) {
  const { openOnly, types, search } = (opts || {});
  const typeSet = Array.isArray(types) ? new Set(types) : null;
  const { user, keyword: q } = parseRef(search);
  return (items || []).filter((it) => {
    if (!it) return false;
    if (openOnly && it.done) return false;
    if (typeSet && it.layer && !typeSet.has(it.layer)) return false;
    if (user) {
      if (String(it.addedBy || '').toLowerCase() !== user) return false;
    }
    if (q) {
      const hay = ((it.id || '') + ' ' + (it.text || '') + ' ' + (it.body || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

const SAMPLE = [
  { id: 'bug-1',  layer: 'Bug',     text: 'WS reconnect storm on slow networks', done: false, addedBy: 'alice' },
  { id: 'bug-2',  layer: 'Bug',     text: 'Spinner stuck after deploy',         done: true,  addedBy: 'bob'   },
  { id: 'fr-1',   layer: 'Feature', text: 'Add fuzz search to the plan view',   done: false, addedBy: 'alice' },
  { id: 'fr-2',   layer: 'Feature', text: 'Run-queue auto-advance on cancel',   done: true,  addedBy: 'carol' },
  { id: 'td-1',   layer: 'Todo',    text: 'Refresh architecture.md',            done: false, addedBy: 'bob'   },
  { id: 'td-2',   layer: 'Todo',    text: 'Move docker files to docker/',       done: true,  addedBy: 'alice' },
];

t('filter: @user alone narrows to that user\'s filings', () => {
  const got = filterRef(SAMPLE, { search: '@alice' });
  assert.strictEqual(got.length, 3);
  assert.ok(got.every((it) => it.addedBy === 'alice'));
});

t('filter: @user case-insensitive on the username', () => {
  const got = filterRef(SAMPLE, { search: '@BOB' });
  assert.strictEqual(got.length, 2);
  assert.ok(got.every((it) => it.addedBy === 'bob'));
});

t('filter: @user + keyword ANDs both conditions', () => {
  const got = filterRef(SAMPLE, { search: '@alice docker' });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].id, 'td-2');
});

t('filter: @user + openOnly + types all intersect', () => {
  // alice's open bugs → bug-1 only (bug-2 is bob's).
  const got = filterRef(SAMPLE, {
    openOnly: true, types: ['Bug'], search: '@alice',
  });
  assert.strictEqual(got.length, 1);
  assert.strictEqual(got[0].id, 'bug-1');
});

t('filter: @user with no matches returns empty', () => {
  assert.strictEqual(filterRef(SAMPLE, { search: '@nobody' }).length, 0);
});

t('filter: items without addedBy do not match any @user', () => {
  const items = [
    { id: 'orphan', text: 'no addedBy', done: false, layer: 'Bug' },
    { id: 'bug-x',  text: 'alice filed', done: false, layer: 'Bug', addedBy: 'alice' },
  ];
  assert.strictEqual(filterRef(items, { search: '@alice' }).length, 1);
  // No user filter → orphan survives keyword search (forward-compat).
  assert.strictEqual(filterRef(items, { search: 'no addedBy' }).length, 1);
});

// ──────────────────────────────────────────────────────────────────────
// 3. "No items match" summary emits the blue @username span.
// ──────────────────────────────────────────────────────────────────────

t('app.js: renderArtifact summary emits plan-search-user-token span for @user', () => {
  // Locate the summary `why` block and confirm it calls
  // _parsePlanSearchQuery + wraps the @username in the span class.
  // We don't run the real renderArtifact (browser-only); we pin the
  // shape by grepping the source.
  const start = APP.search(/No items match\$\{whyText\}/);
  assert.ok(start > -1, 'the "No items match" summary template must still exist');
  // Pull a window around the summary so we see the why-building block.
  const window = APP.slice(Math.max(0, start - 1200), start + 200);
  assert.ok(/_parsePlanSearchQuery\(/.test(window),
    'summary must call _parsePlanSearchQuery to split @user from keyword');
  assert.ok(/plan-search-user-token/.test(window),
    'summary must wrap the @username in <span class="plan-search-user-token">');
  // The @username must be escaped (escHtml) — defensive against a
  // username containing HTML-breaking chars.
  assert.ok(/escHtml\(\s*['"]@['"]\s*\+\s*user/.test(window),
    'summary must escHtml the @+username before injecting into the span');
});

t('app.js: summary still emits the search chip for the keyword remainder', () => {
  const start = APP.search(/No items match\$\{whyText\}/);
  const window = APP.slice(Math.max(0, start - 1200), start + 200);
  assert.ok(/keyword/.test(window) && /search "\$\{escHtml\(keyword\)\}"/.test(window),
    'summary must keep the existing search "…" chip for the keyword remainder');
});

// ──────────────────────────────────────────────────────────────────────
// 4. CSS rule for .plan-search-user-token exists + is blue.
// ──────────────────────────────────────────────────────────────────────

t('CSS: .plan-search-user-token rule exists and is blue', () => {
  const m = CSS.match(/\.plan-search-user-token\s*\{[^}]*\}/);
  assert.ok(m, 'styles.css must define a .plan-search-user-token rule');
  const rule = m[0];
  // Accept any reasonable blue — #2563eb (tailwind blue-600), #1e40af,
  // #0066cc, rgb(37, 99, 235), etc. The point is: it's visibly blue,
  // not green/red/grey. Match common blue hexes + rgb.
  assert.ok(/#2563eb|#1e40af|#1d4ed8|#0066cc|#0000ff|rgb\(\s*3?[0-9]\s*,\s*[0-9]{1,3}\s*,\s*(2[0-4][0-9]|25[0-5])\s*\)/i.test(rule),
    `.plan-search-user-token must set a blue color (got: ${rule})`);
});

t('CSS: .plan-search-user-token rule mentions fr-102 in a comment', () => {
  // Pin the intent so a future refactor doesn't silently drop the
  // rationale. The comment lives just above the rule.
  const idx = CSS.indexOf('.plan-search-user-token');
  assert.ok(idx > -1);
  const comment = CSS.slice(Math.max(0, idx - 400), idx);
  assert.ok(/fr-102/.test(comment),
    'a comment above the rule must reference fr-102 so the intent is documented');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
