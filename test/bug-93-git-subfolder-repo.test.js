// bug-93: /git fails with "not a git repository" (exit 128) when the
// session workspace (rec.absCwd) is a wrapper folder and the actual git
// repo is in an immediate subfolder (e.g. `~/…/myco-foster-chen-eca6ed8d/
// OptixAgentCore` where `OptixAgentCore` is the repo and the parent is
// just a wrapper). handleGit spawned `git` with `cwd: rec.absCwd` directly
// — no fallback to nested-repo detection.
//
// What this test pins:
//   1. slashcmds.js exports `_resolveGitCwd(absCwd)` — a helper that
//      returns the git work-tree root for absCwd, walking one level deep
//      into non-dot children (cap 50, mirror bug-89's
//      NESTED_REPO_MAX_CHILDREN) if absCwd itself isn't a repo. Falls
//      back to absCwd when no child matches, so /git still surfaces
//      git's native "not a git repository" error for genuinely non-repo
//      sessions.
//   2. handleGit is async, awaits _resolveGitCwd, and spawns git with
//      `cwd: gitCwd` (the resolved root), NOT `cwd: rec.absCwd`. When
//      gitCwd !== rec.absCwd, a one-line note tells the user which
//      subfolder git ran in.
//   3. _resolveGitCwd uses `git rev-parse --show-toplevel` (NOT
//      `remote get-url origin`) so local-only repos without a remote
//      still resolve — detectHost's host-regex gate would reject them.
//   4. Behavior ref-impl against the real filesystem (mirrors bug-89's
//      style): absCwd-is-repo → absCwd; wrapper + git child → child;
//      wrapper + no git child → absCwd fallback; dot-dirs skipped;
//      wrapper-IS-repo prefers direct cwd over nested child.
//
// Style mirrors test/bug-89-nested-repo-detect.test.js (mkdtemp +
// execFileSync('git', …) for real repo fixtures, t() chain, sub-second
// standalone) and test/bug-91-numeric-mention-suppression.test.js
// (static reads of source via sliceFn).

const assert = require('assert');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let passed = 0, failed = 0;
function t(name, fn) {
  const run = async () => {
    try { await fn(); console.log('  ✓ ' + name); passed++; }
    catch (err) { console.log('  ✗ ' + name + ' — ' + (err && err.stack ? err.stack : err)); failed++; }
  };
  t._chain = (t._chain || Promise.resolve()).then(run);
}

const SLASH = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'src', 'slashcmds.js'), 'utf8');

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

async function makeGitRepo(root) {
  await fsp.mkdir(root, { recursive: true });
  execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main'], { stdio: 'pipe' });
  return root;
}

// slashcmds.js requires ./sessions which reads MYCO_STATE_DIR at load
// time. Point it at a tmp dir so the require doesn't fail / pollute.
const STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug93-state-'));
process.env.MYCO_STATE_DIR = STATE_DIR;

console.log('── bug-93: /git resolves nested git repo when absCwd is a wrapper ──');

// ──────────────────────────────────────────────────────────────────────
// 1. Static: _resolveGitCwd is defined + shaped right; handleGit wires it.
// ──────────────────────────────────────────────────────────────────────

t('slashcmds.js: _resolveGitCwd is a top-level function', () => {
  assert.ok(/function\s+_resolveGitCwd\s*\(/.test(SLASH),
    '_resolveGitCwd must be a top-level function in slashcmds.js so /git can resolve the actual git work-tree root when absCwd is a wrapper folder');
});

t('slashcmds.js: _resolveGitCwd is exported on module.exports', () => {
  const slash = require('../server/src/slashcmds');
  assert.strictEqual(typeof slash._resolveGitCwd, 'function',
    '_resolveGitCwd must be exported on module.exports so the test (and future callers) can invoke it directly');
});

t('slashcmds.js: _resolveGitCwd uses `git rev-parse --show-toplevel` (not remote get-url)', () => {
  const body = sliceFn(SLASH, '_resolveGitCwd');
  assert.ok(/rev-parse/.test(body) && /show-toplevel/.test(body),
    '_resolveGitCwd must probe via `git rev-parse --show-toplevel` so local-only repos (no remote) still resolve — detectHost\'s `remote get-url origin` would reject them');
  // Must NOT gate on host regex (would exclude non-github/gitee repos).
  assert.ok(!/github\.com|gitee\.com/.test(body),
    '_resolveGitCwd must not gate on github/gitee host regex — /git is a generic passthrough, any git repo qualifies');
});

t('slashcmds.js: _resolveGitCwd caps the child walk (mirror bug-89 NESTED_REPO_MAX_CHILDREN=50)', () => {
  const body = sliceFn(SLASH, '_resolveGitCwd');
  assert.ok(/NESTED_REPO_MAX_CHILDREN|50/.test(body),
    '_resolveGitCwd must cap the child walk at 50 (mirror bug-89\'s NESTED_REPO_MAX_CHILDREN) so a wrapper with thousands of entries doesn\'t stall /git');
});

t('slashcmds.js: _resolveGitCwd skips dot-directories during the child walk', () => {
  const body = sliceFn(SLASH, '_resolveGitCwd');
  assert.ok(/startsWith\(['"]\.['"]\)/.test(body),
    '_resolveGitCwd must skip dot-directories (.git, .cache, .vscode) via startsWith(\'.\') — mirror bug-89');
});

t('slashcmds.js: _resolveGitCwd falls back to absCwd when no child is a repo', () => {
  const body = sliceFn(SLASH, '_resolveGitCwd');
  // When neither absCwd nor any child is a repo, resolve(absCwd) so /git
  // surfaces git's native "not a git repository" error rather than a
  // bespoke message that hides the underlying failure. The helper returns
  // a Promise, so the fallback is `resolve(absCwd)`.
  assert.ok(/resolve\(absCwd\)/.test(body),
    '_resolveGitCwd must fall back to resolve(absCwd) when no child matches — so /git still surfaces git\'s native error for genuinely non-repo sessions');
});

t('slashcmds.js: handleGit is async', () => {
  assert.ok(/async\s+function\s+handleGit\b/.test(SLASH),
    'handleGit must be declared `async function handleGit` so it can await _resolveGitCwd before spawning git — the COMMANDS dispatch already awaits handlers (slashcmds.js:252)');
});

t('slashcmds.js: handleGit awaits _resolveGitCwd before spawning', () => {
  const body = sliceFn(SLASH, 'handleGit');
  assert.ok(/await\s+_resolveGitCwd\b/.test(body),
    'handleGit must `await _resolveGitCwd(rec.absCwd)` before the execFile call — pre-bug-93 it bound cwd directly to rec.absCwd with no resolution');
});

t('slashcmds.js: handleGit spawns git with cwd bound to the resolved root, not rec.absCwd', () => {
  const body = sliceFn(SLASH, 'handleGit');
  assert.ok(/cwd:\s*gitCwd\b/.test(body),
    'handleGit must spawn git with `cwd: gitCwd` (the resolved root), not rec.absCwd — pre-bug-93 it bound rec.absCwd directly, which is why a wrapper-folder session got exit 128');
  // And it must NOT bind cwd: rec.absCwd literally anymore.
  assert.ok(!/cwd:\s*rec\.absCwd/.test(body),
    'handleGit must no longer spawn with `cwd: rec.absCwd` — that literal binding is the bug-93 root cause');
});

t('slashcmds.js: handleGit emits a subfolder note when resolved cwd differs from absCwd', () => {
  const body = sliceFn(SLASH, 'handleGit');
  assert.ok(/gitCwd\s*!==\s*rec\.absCwd/.test(body),
    'handleGit must emit a subfolder note when gitCwd !== rec.absCwd — so the user understands why git ran in a subfolder instead of the session workspace root');
});

// ──────────────────────────────────────────────────────────────────────
// 2. Behavior: _resolveGitCwd against the real filesystem.
//    Mirrors bug-89's mkdtemp + execFileSync('git', …) fixture style.
// ──────────────────────────────────────────────────────────────────────

t('behavior: absCwd that IS a git repo resolves to itself', async () => {
  const wrap = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug93-a-'));
  await makeGitRepo(wrap);
  const slash = require('../server/src/slashcmds');
  const resolved = await slash._resolveGitCwd(wrap);
  assert.strictEqual(resolved, wrap,
    'when absCwd is itself a git repo, _resolveGitCwd must return absCwd unchanged (no surprise fallback)');
});

t('behavior: wrapper folder with nested git repo resolves to child (the bug-93 fix)', async () => {
  const wrap = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug93-b-'));
  await makeGitRepo(path.join(wrap, 'OptixAgentCore'));
  const slash = require('../server/src/slashcmds');
  const resolved = await slash._resolveGitCwd(wrap);
  assert.strictEqual(resolved, path.join(wrap, 'OptixAgentCore'),
    'when absCwd is a wrapper and an immediate child is a git repo, _resolveGitCwd must return the child path — this is the bug-93 fix');
});

t('behavior: wrapper with no git child falls back to absCwd (so /git surfaces native error)', async () => {
  const wrap = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug93-c-'));
  await fsp.mkdir(path.join(wrap, 'not-a-repo'));
  await fsp.mkdir(path.join(wrap, '.cache'));
  const slash = require('../server/src/slashcmds');
  const resolved = await slash._resolveGitCwd(wrap);
  assert.strictEqual(resolved, wrap,
    'when no child is a git repo, _resolveGitCwd must fall back to absCwd so /git surfaces git\'s native "not a git repository" error rather than a bespoke message');
});

t('behavior: dot-directories are skipped during the child walk', async () => {
  const wrap = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug93-d-'));
  // .cache looks like a dir but should be skipped; real repo is in `real`.
  await makeGitRepo(path.join(wrap, '.cache'));
  await makeGitRepo(path.join(wrap, 'real'));
  const slash = require('../server/src/slashcmds');
  const resolved = await slash._resolveGitCwd(wrap);
  assert.strictEqual(resolved, path.join(wrap, 'real'),
    'dot-directories must be skipped — _resolveGitCwd should walk into `real`, not `.cache`');
});

t('behavior: wrapper that IS a repo AND has a nested child repo prefers direct cwd', async () => {
  const wrap = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug93-e-'));
  await makeGitRepo(wrap);
  await makeGitRepo(path.join(wrap, 'inner'));
  const slash = require('../server/src/slashcmds');
  const resolved = await slash._resolveGitCwd(wrap);
  assert.strictEqual(resolved, wrap,
    'when absCwd is itself a git repo, _resolveGitCwd must NOT fall through to a nested child — direct cwd wins (mirror bug-89)');
});

t('behavior: empty / non-existent absCwd returns absCwd (no throw)', async () => {
  const slash = require('../server/src/slashcmds');
  const resolved = await slash._resolveGitCwd('');
  assert.strictEqual(resolved, '',
    'empty absCwd must return empty string (fallback) — no throw');
});

t._chain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
