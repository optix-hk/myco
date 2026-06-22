// bug-89: /feature (and /bug, /setpat, /listpat) reject sessions whose
// cwd is a plain wrapper folder containing a git repo at an immediate
// subdirectory (e.g. `cwd/myco`). detectHost previously ran
// `git -C <absCwd> remote get-url origin` only against the wrapper,
// got a non-zero exit (no .git at absCwd), and returned null — which
// surfaced as "could not detect a github.com or gitee.com remote for
// this session's cwd".
//
// The fix: when the direct lookup returns null, walk immediate non-dot
// children of absCwd and return the first child whose origin matches a
// known host. This test pins the four shapes that matter:
//   1. wrapper + github child  → resolves to child's remote.
//   2. wrapper + gitee child   → resolves (provider-agnostic).
//   3. wrapper + no git child  → null (no false positives, dot-dirs skipped).
//   4. wrapper IS a git repo with a recognized remote AND has a nested
//      github child → prefers the direct cwd's remote (no surprise
//      fallback when the cwd is already a valid repo).
//
// Style mirrors test/gitee-host-dispatch.test.js (freshStateDir,
// mkdtemp, execFileSync('git', …), t() chain, sub-second standalone).

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

function freshStateDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-bug89-'));
  process.env.MYCO_STATE_DIR = d;
  delete require.cache[require.resolve('../server/src/git-tokens')];
  delete require.cache[require.resolve('../server/src/git-hosts')];
  return d;
}

async function makeRepoWithRemote(remoteUrl, root) {
  await fsp.mkdir(root, { recursive: true });
  const run = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('remote', 'add', 'origin', remoteUrl);
  return root;
}

t('bug-89 detectHost: wrapper folder with nested github repo resolves to child', async () => {
  freshStateDir();
  const wrapper = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug89-wrap1-'));
  await makeRepoWithRemote('git@github.com:kkrazy/myco.git', path.join(wrapper, 'myco'));
  const gh = require('../server/src/git-hosts');
  const host = await gh.detectHost(wrapper);
  assert.deepStrictEqual(host, { provider: 'github', owner: 'kkrazy', repo: 'myco' });
});

t('bug-89 detectHost: wrapper folder with nested gitee repo resolves (provider-agnostic)', async () => {
  freshStateDir();
  const wrapper = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug89-wrap2-'));
  await makeRepoWithRemote('https://gitee.com/some/cool.git', path.join(wrapper, 'cool'));
  const gh = require('../server/src/git-hosts');
  const host = await gh.detectHost(wrapper);
  assert.deepStrictEqual(host, { provider: 'gitee', owner: 'some', repo: 'cool' });
});

t('bug-89 detectHost: wrapper with no git child returns null (dot-dirs skipped, no false positives)', async () => {
  freshStateDir();
  const wrapper = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug89-wrap3-'));
  await fsp.mkdir(path.join(wrapper, 'not-a-repo'));
  await fsp.mkdir(path.join(wrapper, '.cache'));
  const gh = require('../server/src/git-hosts');
  assert.strictEqual(await gh.detectHost(wrapper), null);
});

t('bug-89 detectHost: wrapper that IS a git repo prefers direct cwd remote over nested child', async () => {
  freshStateDir();
  const wrapper = await fsp.mkdtemp(path.join(os.tmpdir(), 'myco-bug89-wrap4-'));
  // Direct cwd is a github repo.
  await makeRepoWithRemote('git@github.com:outer/repo.git', wrapper);
  // A nested child also has a github remote — must NOT win over the direct cwd.
  await makeRepoWithRemote('git@github.com:inner/other.git', path.join(wrapper, 'inner'));
  const gh = require('../server/src/git-hosts');
  const host = await gh.detectHost(wrapper);
  assert.deepStrictEqual(host, { provider: 'github', owner: 'outer', repo: 'repo' });
});

t._chain.then(() => {
  console.log(`\n  ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
});
