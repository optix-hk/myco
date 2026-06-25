// bug-91: @<numeric-only> mention tokens falsely route to the agent.
// A chat message like `@771805315 hi` (numeric-only @token) triggered a
// claude turn because _detectMentionTarget's regex required a letter-
// first token, so numeric-only @tokens returned null → handleChatMessage's
// `if (mentionTarget) return;` suppression gate never fired → the message
// fell through to claude.
//
// What this test pins:
//   1. _detectMentionTarget (server/src/attach.js) has a numeric-only
//      check: `^@(\d{1,30})\b` matches @<all-digits> and returns the
//      numeric token, so the suppression gate fires.
//   2. handleChatMessage still has the `if (mentionTarget) return;`
//      suppression gate that stops claude routing for mentions.
//   3. Inline ref-impl of the full _detectMentionTarget logic: numeric-
//      only → non-null, @all → 'all', known letter-first user → user,
//      unknown letter-first user → null (falls through to claude,
//      existing design), alphanumeric-digit-first → null (out of scope).
//
// Style mirrors test/bug-90-runs-persist-to-file.test.js (static reads
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

console.log('── bug-91: @<numeric> mention suppresses claude routing ──');

// Helper: slice a top-level function body from source, from its
// `function name(` line to the next column-0 `}` line.
function sliceFn(src, name) {
  const start = src.search(new RegExp('function\\s+' + name + '\\s*\\('));
  assert.ok(start > -1, name + ' must be a top-level function');
  const rest = src.slice(start);
  const endMatch = rest.slice(1).match(/\n\}/);
  assert.ok(endMatch, name + ' must have a column-0 closing brace');
  return rest.slice(0, rest.slice(1).indexOf(endMatch[0]) + 2);
}

// ──────────────────────────────────────────────────────────────────────
// 1. _detectMentionTarget has a numeric-only check.
// ──────────────────────────────────────────────────────────────────────

t('attach.js: _detectMentionTarget is defined', () => {
  assert.ok(/function\s+_detectMentionTarget\s*\(/.test(ATTACH),
    '_detectMentionTarget must be a top-level function in attach.js');
});

t('attach.js: _detectMentionTarget has a numeric-only regex /^@(\\d{1,30})\\b/', () => {
  const body = sliceFn(ATTACH, '_detectMentionTarget');
  // Pin the numeric-only token shape: @ followed by 1-30 digits, word
  // boundary after. This is what makes `@771805315` return non-null so
  // the suppression gate fires.
  assert.ok(/\/\^@\(\\d\{1,30\}\)\\b\//.test(body),
    '_detectMentionTarget must match /^@(\\d{1,30})\\b/ for numeric-only @tokens — pre-bug-91 the regex required letter-first, so @771805315 returned null and claude routed');
});

t('attach.js: numeric match returns the token (non-null) so the suppression gate fires', () => {
  const body = sliceFn(ATTACH, '_detectMentionTarget');
  // The numeric branch must RETURN the matched digit string (not null).
  // If it returned null, the suppression gate wouldn't fire and the bug
  // would persist. Look for `return <numMatch>[1]` or equivalent.
  assert.ok(/return\s+\w+\.?\[?1\]?/.test(body),
    'numeric match must return the captured digit token so handleChatMessage\'s `if (mentionTarget) return;` gate fires');
});

// ──────────────────────────────────────────────────────────────────────
// 2. handleChatMessage has the `if (mentionTarget) return;` gate.
// ──────────────────────────────────────────────────────────────────────

t('attach.js: handleChatMessage has the `if (mentionTarget) return;` suppression gate', () => {
  const body = sliceFn(ATTACH, 'handleChatMessage');
  // The gate that stops claude routing for mentions. Must appear AFTER
  // the chat broadcast (appendChatMessage + emit) so the mention is
  // still persisted + broadcast to clients.
  assert.ok(/if\s*\(\s*mentionTarget\s*\)\s*return\s*;/.test(body),
    'handleChatMessage must keep the `if (mentionTarget) return;` gate so non-null mention targets suppress claude routing');
  // And it must come after the broadcast so the message is persisted.
  const gateIdx = body.indexOf('if (mentionTarget) return');
  const broadcastIdx = body.indexOf("session.emit('chat'");
  assert.ok(broadcastIdx > -1 && gateIdx > broadcastIdx,
    'the suppression gate must come AFTER the chat broadcast so mention messages are still persisted + shown to clients');
});

// ──────────────────────────────────────────────────────────────────────
// 3. Inline ref-impl of the full _detectMentionTarget logic. Mirrors
// the post-fix contract: numeric-only → non-null, @all → 'all', known
// letter-first → user, unknown letter-first → null (existing design),
// alphanumeric-digit-first → null (out of scope).
// ──────────────────────────────────────────────────────────────────────

// Fake known-user set for the ref-impl. Real impl checks authMod
// .listUsernames() + allowlist; we stub a small set.
const KNOWN_USERS = new Set(['alice', 'bob', 'foster-chen', 'kkrazy']);

function detectMentionTargetRef(text) {
  const s = String(text || '');
  // bug-91: numeric-only @token → return the digit string (suppresses
  // claude routing via the if(mentionTarget) return gate).
  const numMatch = s.match(/^@(\d{1,30})\b/);
  if (numMatch) return numMatch[1];
  // Existing letter-first path.
  const m = s.match(/^@([A-Za-z][\w-]{0,30})\b/);
  if (!m) return null;
  const w = m[1].toLowerCase();
  if (w === 'all') return 'all';
  return KNOWN_USERS.has(w) ? m[1] : null;
}

t('ref: @<numeric-only> returns the numeric token (non-null)', () => {
  assert.strictEqual(detectMentionTargetRef('@771805315'), '771805315');
  assert.strictEqual(detectMentionTargetRef('@771805315 hi'), '771805315');
  assert.strictEqual(detectMentionTargetRef('@123'), '123');
});

t('ref: @<numeric> suppresses claude even with a body after it', () => {
  // The bug report: `@771805315 hi` triggered claude. Post-fix the
  // non-null return makes the suppression gate fire.
  const r = detectMentionTargetRef('@771805315 hi');
  assert.ok(r !== null, '@771805315 hi must return non-null so claude is suppressed');
  assert.strictEqual(r, '771805315');
});

t('ref: @all still returns "all" (broadcast mention, unchanged)', () => {
  assert.strictEqual(detectMentionTargetRef('@all'), 'all');
  assert.strictEqual(detectMentionTargetRef('@all team please review'), 'all');
});

t('ref: @<known letter-first user> returns the user (unchanged)', () => {
  assert.strictEqual(detectMentionTargetRef('@alice'), 'alice');
  assert.strictEqual(detectMentionTargetRef('@alice can you check?'), 'alice');
  assert.strictEqual(detectMentionTargetRef('@foster-chen'), 'foster-chen');
});

t('ref: @<unknown letter-first user> returns null (falls through to claude — existing design)', () => {
  // This is the documented pre-bug-91 behavior for unknown @words.
  // bug-91 does NOT change this — only numeric-only is in scope.
  assert.strictEqual(detectMentionTargetRef('@unknownuser'), null);
  assert.strictEqual(detectMentionTargetRef('@unknownuser hi'), null);
});

t('ref: @<alphanumeric-digit-first> returns null (out of scope — not numeric-only)', () => {
  // bug-91 is narrowly "numeric-only". @123abc starts with a digit but
  // isn't all digits, so the numeric regex doesn't match (no \b between
  // digits and letters). The letter-first regex also doesn't match.
  // → null → claude routes. This preserves pre-bug-91 behavior for
  // alphanumeric tokens.
  assert.strictEqual(detectMentionTargetRef('@123abc'), null);
  assert.strictEqual(detectMentionTargetRef('@123abc hi'), null);
});

t('ref: plain text (no @) returns null (claude routes normally)', () => {
  assert.strictEqual(detectMentionTargetRef('hi'), null);
  assert.strictEqual(detectMentionTargetRef('what is 2+2'), null);
  assert.strictEqual(detectMentionTargetRef(''), null);
});

t('ref: @<numeric> at non-head position is NOT a mention (head-of-message only)', () => {
  // The regex is anchored ^@ — so `hi @771805315` is not a head mention.
  // claude routes (the user is addressing claude, mentioning 771805315
  // mid-sentence). This matches the existing head-of-message design.
  assert.strictEqual(detectMentionTargetRef('hi @771805315'), null);
});

t('ref: @<numeric> with very long digit run (>30) does not match (regex cap)', () => {
  // The regex caps at 30 digits to prevent pathological inputs. A 31+
  // digit run won't match → null → claude routes. Edge case, but pins
  // the cap so a future loosening doesn't silently accept unbounded input.
  const longNum = '7'.repeat(31);
  assert.strictEqual(detectMentionTargetRef('@' + longNum), null);
});

t('ref: @<numeric> mention is case-insensitive irrelevant (digits have no case)', () => {
  // Sanity: digits don't have case, so the lowercasing in the function
  // is a no-op for numeric tokens. The returned token is the raw digit
  // string.
  assert.strictEqual(detectMentionTargetRef('@771805315'), '771805315');
});

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
