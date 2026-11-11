// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';
import { request, verifyArchive, installSdk } from './build.mjs';
import { prepareDev } from './prepare-dev.mjs';
import { sdkChecksums } from './wasi-sdk-checksums.mjs';

// This certificate/key is public test data for an isolated localhost server.
const key = "-----BEGIN PRIVATE KEY-----\r\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDZ/cKIHgrEztEd\r\nCcP6aM91jKOUax1c1A+gIy0AXh1/vTNI1iiTTmJrGPW1PsE3hk11GI8PLxaNs+No\r\nsUK819r9yRPmSHLfR9hFWOdwDqESTWHGrsOhN0Hb/24sGyjI1orG5AF+yaUCm0Ni\r\n5EGoCE5kWYNBiNuKrQIPSBU6yZdCPMAr+oRdbsxpo9n0Q11fKJmTW463FOumTYPC\r\n6Ltccax+evsNMdhnU7asTGgqMJskkOqReygAn1agh9/k/xSu1HfDm1NZIJKMCwv7\r\nBfMGAH5eTK7dGBEOzu4vX6e6TDFG05a6kPliW6xERsdyGu9PAsaM6+vu7Z8UaKMQ\r\nqqJ4VRIJAgMBAAECggEAAUMxUPkxkUW5KGlx0RDlBxaAxp+FlkL98ZMg+j23sh4+\r\nCySYX0M6AGPiEM7NLvcWmqbBHCXaHaLgBO9zEwwB++wuv6u5Cv0Yx5miwrKgl3rk\r\nv2vFyZJItDXRi5MlsSusg2EQxCbC6QkaqQ3O3O9qLgKzTXO1zi+l0Y5WkLy+cd1m\r\nKlMHEAzPahx3tlX3ReA6sFywaG4EuphdKRqRYhqISvqhaucCGgKd7ZuPd+bnxBin\r\noBZOULsDUUpDFaSJoMFb7zMk/KEuGatLy7qAJEaFm11EwO4UZbWOiNmnETkP9FFm\r\nvEmvUrkedBcEhMLFTfgwKqQIRSiyc/OKcNJVLiPXfQKBgQD4lF3ogd1S9PYvLTch\r\ng9DlGp9zOUC5W/T8pFEZ7OCa5MQVuVkb9aC8F41q6VqR7agnGu/7XdrIZyw8YtFp\r\nICEImN0NCkSQzy+FPQ6RF9doRCsAb74U+Rs080li1mSU2pHP6w+16+dOeEnyWxyf\r\n8hUF3aukSolwV8/vCrj5uvwv5QKBgQDgf6N/TvTza+wTHiNlelm36taigqI2IDIL\r\ncO1vAPDhoxLuaS02YNMXkTZ01KqwNyGbm0gprV8unTH5B5wi8hg+IETxti3Eh2g/\r\nQ5V3u3bD0w6//5c1l4mJ8uFpXNHOjN1Gu8vam+TI5hNr/HWu4FtMURgSxMFA0Fzz\r\nC5gE5HPPVQKBgBaMluw1g5c343EqH9spcvSlcptoMSffYJzeZwD8DO/gGq2Bz8SK\r\nhpcpZ8mv+2hLb7qEZgqeW+9b9JZRvH9Vy8lU3JCHQusD8GKcxEqDKCYsMN5sRIjw\r\ng/hMrXaKzjr2jM2YnCc7jBMBNGwIudMEicWrcxuHK2qGfLVJergkryXFAoGBAJCF\r\n2u1EGTDz0yBjkIntgACEb/RigKazh0QSSOfjBS9c2f0dPHv7TSmo1BPWLKQQedRA\r\n3O3nrJTHobodigh9Ldog0AGDNGeGfDft/DT+O/DI2IAFvIRFr8dc0nwPwwljabf1\r\ngcCUB27Fns8v0VrpGB1DP2olu/tLp+rXFeBgaaWZAoGAERgIqw50EBJjELySXwN2\r\nLbiwWMUtO05uypGSTVoG0tVFjkt3ytXaX3QDn2CYQHh/JxOu80rSu1RdYh3u2maP\r\nazuEUQgoSVj3pWAyUWzWFc069Wyvfp4hfPE6HUgHvoOF1Biwe30wXpUKRuLvYtBI\r\ng7oU0wnZaGqUim7KFElRVsQ=\r\n-----END PRIVATE KEY-----\n";
const cert = "-----BEGIN CERTIFICATE-----\r\nMIIDHzCCAgegAwIBAgIUZ4xLnakajRcfujCYfYqId6HU3S0wDQYJKoZIhvcNAQEL\r\nBQAwFDESMBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEwOTAxMDc0MloXDTM2MTEw\r\nNjAxMDc0MlowFDESMBAGA1UEAwwJbG9jYWxob3N0MIIBIjANBgkqhkiG9w0BAQEF\r\nAAOCAQ8AMIIBCgKCAQEA2f3CiB4KxM7RHQnD+mjPdYyjlGsdXNQPoCMtAF4df70z\r\nSNYok05iaxj1tT7BN4ZNdRiPDy8WjbPjaLFCvNfa/ckT5khy30fYRVjncA6hEk1h\r\nxq7DoTdB2/9uLBsoyNaKxuQBfsmlAptDYuRBqAhOZFmDQYjbiq0CD0gVOsmXQjzA\r\nK/qEXW7MaaPZ9ENdXyiZk1uOtxTrpk2Dwui7XHGsfnr7DTHYZ1O2rExoKjCbJJDq\r\nkXsoAJ9WoIff5P8UrtR3w5tTWSCSjAsL+wXzBgB+Xkyu3RgRDs7uL1+nukwxRtOW\r\nupD5YlusREbHchrvTwLGjOvr7u2fFGijEKqieFUSCQIDAQABo2kwZzAdBgNVHQ4E\r\nFgQU6zDSDJE0BWh8DeLTFBS5GOUIpJcwHwYDVR0jBBgwFoAU6zDSDJE0BWh8DeLT\r\nFBS5GOUIpJcwDwYDVR0TAQH/BAUwAwEB/zAUBgNVHREEDTALgglsb2NhbGhvc3Qw\r\nDQYJKoZIhvcNAQELBQADggEBABQCpyZd41PAHARYiy2WHGhnAtI1KyTyvmt7pO7y\r\n0RrhCEYzIuYhLfM/SdmKvG6J5nfAttyyNCMI0tqjGo1QqP1HI7bIrjKexfPwOf3C\r\nqpOjoh3FT6IyPdUJDFIgkOG65Wpf6eXdukYn48ewFPAl8XrjeVwlUpnoLHZU9sTk\r\nA9DjVSjUsTcS/UIgIVXgWaB3ILOOFp1c/JVU2gleaiq/JOSQczE7lKErsFN88gyL\r\nZlt4CURcSet264CyW/oO1m7be6lBvL9Hh5YygL9Yhtsx1oeyyI3dFKXrI2RC1WA+\r\n6rjX8BpU1Lyg7neJPbxWk81YKhitt08J/JlpyMfgGVRwYC0=\r\n-----END CERTIFICATE-----\n";

async function collect(response) {
  const chunks = [];
  await pipeline(response, new Writable({ write(chunk, _encoding, done) { chunks.push(chunk); done(); } }));
  return Buffer.concat(chunks);
}

function cli(executable, args, cwd) {
  const result = spawnSync(executable, args, { cwd, encoding: 'utf8' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable}: ${result.stderr}`);
  return result.stdout.trim();
}

const temporary = await mkdtemp(path.join(tmpdir(), 'ignition-build-tests-'));
const sockets = new Set();
const track = socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); };
const seenTargetHeaders = [];
const connectRequests = [];
let proxyMode = 'forward';
let archiveBody = Buffer.from('download fixture');
let concurrentDownloads = 0;
let slowClosed;
const server = https.createServer({ key, cert }, (req, res) => {
  seenTargetHeaders.push(req.headers);
  if (req.url === '/redirect') { res.writeHead(302, { Location: '/ok' }); res.end(); }
  else if (req.url === '/missing-location') { res.writeHead(302); res.end(); }
  else if (req.url === '/downgrade') { res.writeHead(302, { Location: 'http://localhost/ok' }); res.end(); }
  else if (req.url === '/foreign-host') { res.writeHead(302, { Location: 'https://example.invalid/ok' }); res.end(); }
  else if (req.url === '/loop') { res.writeHead(302, { Location: '/loop' }); res.end(); }
  else if (req.url === '/slow') {
    slowClosed = new Promise(resolve => req.socket.once('close', resolve));
    res.writeHead(200); res.write('partial');
  }
  else if (req.url === '/archive') res.end(archiveBody);
  else if (req.url === '/archive-concurrent') {
    concurrentDownloads++;
    setTimeout(() => res.end(archiveBody), 150);
  }
  else res.end('complete');
});
server.on('connection', track);
const proxy = http.createServer();
proxy.on('connection', track);
proxy.on('connect', (req, client, head) => {
  connectRequests.push({ authority: req.url, authorization: req.headers['proxy-authorization'] });
  if (proxyMode === 'reject') { client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n'); return; }
  if (proxyMode === 'disconnect') { client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); client.destroy(); return; }
  if (proxyMode === 'stall') return;
  const destination = new URL(`https://${req.url}`);
  const upstream = net.connect(Number(destination.port), '127.0.0.1', () => {
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  track(upstream);
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
  client.on('close', () => upstream.destroy());
  upstream.on('close', () => client.destroy());
});

try {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const base = `https://localhost:${server.address().port}`;
  const options = { ca: cert, allowedHosts: ['localhost'], proxy: '', timeoutMs: 1000 };
  assert.equal((await collect(await request(`${base}/redirect`, options))).toString(), 'complete');
  await assert.rejects(request(`${base}/missing-location`, options), /no Location/);
  await assert.rejects(request(`${base}/downgrade`, options), /must use HTTPS/);
  await assert.rejects(request(`${base}/foreign-host`, options), /host is not allowed/);
  await assert.rejects(request(`${base}/loop`, options), /Too many.*redirects/);
  await assert.rejects(request('https://user:secret@localhost/', options), /must not contain credentials/);
  await assert.rejects(collect(await request(`${base}/slow`, { ...options, timeoutMs: 50 })), /SDK download timed out/);
  await slowClosed;
  const proxied = { ...options, proxy: `http://user:secret@127.0.0.1:${proxy.address().port}` };
  assert.equal((await collect(await request(`${base}/redirect`, proxied))).toString(), 'complete');
  assert(connectRequests.length >= 2);
  for (const connect of connectRequests) {
    assert.equal(connect.authority, `localhost:${server.address().port}`, 'CONNECT must honor a non-default HTTPS port');
    assert.equal(connect.authorization, `Basic ${Buffer.from('user:secret').toString('base64')}`);
  }
  assert(seenTargetHeaders.every(headers => !headers['proxy-authorization']), 'proxy credentials must not reach the target');
  proxyMode = 'reject';
  await assert.rejects(request(`${base}/ok`, proxied), /Proxy returned HTTP 502/);
  proxyMode = 'disconnect';
  await assert.rejects(request(`${base}/ok`, proxied));
  proxyMode = 'stall';
  await assert.rejects(request(`${base}/ok`, { ...proxied, connectTimeoutMs: 50 }), /Proxy connection timed out/);
  proxyMode = 'forward';
  await assert.rejects(request(`${base}/ok`, { ...options, proxy: 'ftp://localhost' }), /HTTP or HTTPS proxy/);

  const name = 'wasi-sdk-34.0-x86_64-windows';
  const executable = 'clang.exe';
  const source = path.join(temporary, 'archive-source');
  const sdkSource = path.join(source, name);
  const required = ['bin/clang.exe', 'share/wasi-sysroot/include/wasm32-wasip1/stdio.h', 'share/wasi-sysroot/lib/wasm32-wasip1/libc.so'];
  for (const file of required) {
    await mkdir(path.dirname(path.join(sdkSource, file)), { recursive: true });
    await writeFile(path.join(sdkSource, file), 'fixture');
  }
  const fixtureArchive = path.join(temporary, 'fixture.tar.gz');
  cli('tar', ['-czf', '../fixture.tar.gz', name], source);
  archiveBody = await readFile(fixtureArchive);
  const digest = createHash('sha256').update(archiveBody).digest('hex');
  await verifyArchive(fixtureArchive, digest);
  await assert.rejects(verifyArchive(fixtureArchive, '0'.repeat(64)), { code: 'ERR_SDK_CHECKSUM' });

  // Independent Node processes must share one installation, including its download.
  const worker = path.join(temporary, 'sdk-install-worker.mjs');
  await writeFile(worker, `
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { installSdk } from ${JSON.stringify(new URL('./build.mjs', import.meta.url).href)};
process.once('message', async install => {
  try {
    const compiler = await installSdk(install);
    const identity = info => [info.dev, info.ino, info.birthtimeMs];
    const before = identity(await stat(compiler));
    await delay(200);
    assert.deepEqual(identity(await stat(compiler)), before, 'a completed SDK must not be replaced by another installer');
    process.send({ compiler, content: await readFile(compiler, 'utf8'), identity: before });
  } catch (error) {
    process.send({ error: error.message, code: error.code });
    process.exitCode = 1;
  } finally { process.disconnect(); }
});
process.send('ready');
`);
  async function concurrentInstalls(install, expectedError) {
    const runs = Array.from({ length: 2 }, () => {
      const child = spawn(process.execPath, [worker], { cwd: temporary, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      let output = '', errors = '', result;
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { errors += chunk; });
      const ready = new Promise((resolve, reject) => {
        child.once('error', reject);
        child.on('message', message => {
          if (message === 'ready') resolve();
          else result = message;
        });
        child.once('exit', code => reject(new Error(`SDK worker exited before starting: ${code}; ${errors}`)));
      });
      const watchdog = setTimeout(() => child.kill(), 15000);
      const done = new Promise(resolve => {
        child.once('close', (code, signal) => {
          clearTimeout(watchdog);
          resolve({ code, signal, result, output, errors });
        });
      });
      return { child, ready, done };
    });
    try {
      await Promise.all(runs.map(run => run.ready));
      for (const run of runs) run.child.send(install);
      const completed = await Promise.all(runs.map(run => run.done));
      for (const run of completed) {
        assert.equal(run.signal, null, `SDK worker did not finish: ${run.errors}`);
        assert.equal(run.code, expectedError ? 1 : 0, run.result?.error || run.errors);
        if (expectedError) assert.equal(run.result?.code, expectedError);
        else {
          assert.equal(run.result?.compiler, path.join(install.cache, name, 'bin', executable));
          assert.equal(run.result.content, 'fixture');
        }
      }
      if (!expectedError) {
        assert.deepEqual(completed[0].result.identity, completed[1].result.identity,
          'both installers must use the same completed compiler file');
      }
    } finally {
      for (const run of runs) {
        if (run.child.exitCode === null && run.child.signalCode === null) run.child.kill();
      }
      await Promise.all(runs.map(run => run.done));
    }
  }
  const concurrentInstall = { name, digest, executable, url: `${base}/archive-concurrent`, requestOptions: options };
  for (const mode of ['cached archive', 'download', 'incomplete SDK']) {
    const concurrentCache = path.join(temporary, `concurrent-${mode.replaceAll(' ', '-')}`);
    await mkdir(concurrentCache, { recursive: true });
    if (mode !== 'download') await writeFile(path.join(concurrentCache, `${name}.tar.gz`), archiveBody);
    if (mode === 'incomplete SDK') {
      await mkdir(path.join(concurrentCache, name, 'bin'), { recursive: true });
      await writeFile(path.join(concurrentCache, name, 'bin', executable), 'old incomplete SDK');
    }
    const downloadsBefore = concurrentDownloads;
    await concurrentInstalls({ ...concurrentInstall, cache: concurrentCache });
    assert.equal(concurrentDownloads - downloadsBefore, mode === 'download' ? 1 : 0, 'concurrent installers must publish one download');
    for (const file of required) assert.equal(await readFile(path.join(concurrentCache, name, file), 'utf8'), 'fixture');
    assert.equal((await readFile(path.join(concurrentCache, name, '.verified-sha256'), 'utf8')).trim(), digest);
    assert.deepEqual((await readdir(concurrentCache)).sort(), [name, `${name}.tar.gz`].sort(), 'successful installers must release locks and temporary files');
    // A complete SDK remains readable even if an interrupted installer left a lock.
    const leftoverLock = path.join(concurrentCache, `${name}.install-lock`);
    await writeFile(leftoverLock, 'unknown owner\n');
    await concurrentInstalls({ ...concurrentInstall, cache: concurrentCache, url: 'https://example.invalid/offline' });
    assert.equal(await readFile(leftoverLock, 'utf8'), 'unknown owner\n', 'read-only reuse must not remove an unowned lock');
    await rm(leftoverLock);
  }
  const concurrentFailure = path.join(temporary, 'concurrent-invalid-digest');
  await concurrentInstalls({ ...concurrentInstall, cache: concurrentFailure, digest: '0'.repeat(64) }, 'ERR_SDK_CHECKSUM');
  assert.deepEqual(await readdir(concurrentFailure), [], 'failed installers must preserve integrity errors and release their resources');
  await concurrentInstalls({ ...concurrentInstall, cache: concurrentFailure });
  assert.equal((await readFile(path.join(concurrentFailure, name, '.verified-sha256'), 'utf8')).trim(), digest);

  const interruptedCache = path.join(temporary, 'interrupted-installer');
  await mkdir(interruptedCache);
  await writeFile(path.join(interruptedCache, `${name}.tar.gz`), archiveBody);
  const stoppedOwner = spawnSync(process.execPath, ['-e', ''], { cwd: temporary });
  assert.equal(stoppedOwner.status, 0);
  const interruptedLock = path.join(interruptedCache, `${name}.install-lock`);
  await writeFile(interruptedLock, `${stoppedOwner.pid}\n`);
  await assert.rejects(installSdk({ ...concurrentInstall, cache: interruptedCache }), error =>
    error.code === 'ERR_SDK_LOCK_INTERRUPTED' && error.message.includes(interruptedLock));
  assert.equal(await readFile(interruptedLock, 'utf8'), `${stoppedOwner.pid}\n`, 'an interrupted lock must remain available for diagnosis');
  await rm(interruptedLock);
  await installSdk({ ...concurrentInstall, cache: interruptedCache, url: 'https://example.invalid/offline' });
  assert.deepEqual((await readdir(interruptedCache)).sort(), [name, `${name}.tar.gz`].sort());
  // Unexpected filesystem errors are not treated as a successful competing install.
  const blockedCache = path.join(temporary, 'invalid-lock-file');
  const blockedLock = path.join(blockedCache, `${name}.install-lock`);
  await mkdir(blockedLock, { recursive: true });
  await assert.rejects(installSdk({ ...concurrentInstall, cache: blockedCache }), { code: 'EISDIR' });

  const cache = path.join(temporary, 'sdk-cache');
  const sdk = path.join(cache, name);
  // An interrupted old extraction has clang but lacks the sysroot and marker.
  await mkdir(path.join(sdk, 'bin'), { recursive: true });
  await writeFile(path.join(sdk, 'bin', executable), 'old incomplete compiler');
  await writeFile(path.join(cache, `${name}.tar.gz`), 'corrupt cached download');
  const install = { cache, name, digest, executable, url: `${base}/archive`, requestOptions: options };
  const rejectedCache = path.join(temporary, 'rejected-sdk');
  await assert.rejects(installSdk({ ...install, cache: rejectedCache, digest: '0'.repeat(64) }), { code: 'ERR_SDK_CHECKSUM' });
  assert.deepEqual(await readdir(rejectedCache), [], 'failed integrity must leave no extracted SDK, final archive, or partial download');
  const clang = await installSdk(install);
  assert.equal(await readFile(clang, 'utf8'), 'fixture');
  assert.equal((await readFile(path.join(sdk, '.verified-sha256'), 'utf8')).trim(), digest);
  // A verified complete cache works without any available download URL.
  assert.equal(await installSdk({ ...install, url: 'https://example.invalid/unavailable' }), clang);
  // Missing sysroot files must invalidate the marker and trigger fresh extraction.
  await rm(path.join(sdk, required[1]));
  await installSdk({ ...install, url: 'https://example.invalid/unavailable' });
  assert.equal(await readFile(path.join(sdk, required[1]), 'utf8'), 'fixture');
  assert((await readdir(cache)).every(file => !file.endsWith('.partial') && !file.startsWith('.sdk-extract-')));
  // A valid-digest archive missing the sysroot must not replace a usable previous cache.
  await rm(path.join(sdkSource, required[1]));
  cli('tar', ['-czf', '../fixture.tar.gz', name], source);
  const incomplete = await readFile(fixtureArchive);
  const incompleteDigest = createHash('sha256').update(incomplete).digest('hex');
  await writeFile(path.join(cache, `${name}.tar.gz`), incomplete);
  await assert.rejects(installSdk({ ...install, digest: incompleteDigest }), /missing compiler or sysroot/);
  assert.equal(await readFile(path.join(sdk, required[1]), 'utf8'), 'fixture');
  assert.equal((await readFile(path.join(sdk, '.verified-sha256'), 'utf8')).trim(), digest);

  const project = path.join(temporary, 'project,$&,$$');
  const files = {
    'tree-sitter-ignition/src/parser.c': 'parser',
    'tree-sitter-ignition/src/deleted.c': 'remove from snapshot',
    'tree-sitter-ignition/grammar.js': 'grammar',
    'languages/ignition/highlights.scm': 'highlights',
    'languages/ignition/deleted.scm': 'remove from extension',
    'licenses/example.txt': 'license text', LICENSE: 'license', 'NOTICE.md': 'notice',
    'extension.template.toml': 'repository = "{{GRAMMAR_REPOSITORY}}"\nrevision = "{{GRAMMAR_REVISION}}"\n',
  };
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(project, file)), { recursive: true });
    await writeFile(path.join(project, file), text);
  }
  await prepareDev(project);
  await rm(path.join(project, 'tree-sitter-ignition/src/deleted.c'));
  await rm(path.join(project, 'languages/ignition/deleted.scm'));
  await prepareDev(project);
  const snapshot = path.join(project, '.build/grammar-repository');
  const extension = path.join(project, '.build/dev-extension');
  await assert.rejects(readFile(path.join(snapshot, 'src/deleted.c')), { code: 'ENOENT' });
  await assert.rejects(readFile(path.join(extension, 'languages/ignition/deleted.scm')), { code: 'ENOENT' });
  assert(!cli('git', ['ls-tree', '-r', '--name-only', 'main'], snapshot).includes('deleted.c'));
  const manifest = await readFile(path.join(extension, 'extension.toml'), 'utf8');
  assert(manifest.includes(pathToFileURL(snapshot).href));
  assert(!manifest.includes('{{GRAMMAR_REPOSITORY}}'));

  // Exported Git locations must never redirect a snapshot into another repository.
  const external = path.join(temporary, 'external-repository');
  for (const [file, text] of Object.entries({
    'src/original.c': 'original source', 'grammar.js': 'original grammar',
    LICENSE: 'original license', 'NOTICE.md': 'original notice', 'licenses/original.txt': 'original license',
  })) {
    await mkdir(path.dirname(path.join(external, file)), { recursive: true });
    await writeFile(path.join(external, file), text);
  }
  cli('git', ['init', '--quiet', '--initial-branch=main'], external);
  cli('git', ['add', '.'], external);
  const externalTree = cli('git', ['write-tree'], external);
  const externalRevision = cli('git', ['-c', 'user.name=Build Test', '-c', 'user.email=build-test@localhost',
    'commit-tree', externalTree, '-m', 'external repository fixture'], external);
  cli('git', ['update-ref', 'refs/heads/main', externalRevision], external);
  await writeFile(path.join(external, 'src/original.c'), 'uncommitted external edit');
  await writeFile(path.join(external, 'untracked.txt'), 'untracked external file');
  const externalGit = path.join(external, '.git');
  const configBefore = await readFile(path.join(externalGit, 'config'));
  const indexBefore = await readFile(path.join(externalGit, 'index'));
  const statusBefore = cli('git', ['status', '--porcelain'], external);
  const alternateIndex = path.join(temporary, 'external-index');
  await writeFile(alternateIndex, indexBefore);
  const globalConfig = path.join(temporary, 'snapshot-gitconfig');
  await writeFile(globalConfig, '[init]\n defaultBranch = snapshot-default\n');
  for (const variables of [
    { GIT_DIR: externalGit },
    { GIT_DIR: externalGit, GIT_WORK_TREE: external },
    { GIT_DIR: externalGit, GIT_WORK_TREE: external, GIT_COMMON_DIR: externalGit,
      GIT_INDEX_FILE: alternateIndex, GIT_OBJECT_DIRECTORY: path.join(externalGit, 'objects'),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(externalGit, 'objects'), GIT_NAMESPACE: 'external',
      GIT_SHALLOW_FILE: path.join(temporary, 'external-shallow') },
  ]) {
    variables.GIT_CONFIG_GLOBAL = globalConfig;
    const previous = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
    try {
      Object.assign(process.env, variables);
      await prepareDev(project);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.deepEqual(await readFile(path.join(externalGit, 'config')), configBefore, 'snapshot must preserve external Git configuration');
    assert.deepEqual(await readFile(path.join(externalGit, 'index')), indexBefore, 'snapshot must preserve the external staging index');
    assert.deepEqual(await readFile(alternateIndex), indexBefore, 'snapshot must preserve an exported alternate index');
    assert.equal(cli('git', ['rev-parse', 'main'], external), externalRevision, 'snapshot must preserve the external branch');
    assert.equal(cli('git', ['status', '--porcelain'], external), statusBefore, 'snapshot must preserve external worktree changes');
    assert.equal(await readFile(path.join(external, 'src/original.c'), 'utf8'), 'uncommitted external edit');
    assert.equal(await readFile(path.join(snapshot, 'src/parser.c'), 'utf8'), 'parser');
    assert.equal(await realpath(cli('git', ['rev-parse', '--absolute-git-dir'], snapshot)), await realpath(path.join(snapshot, '.git')), 'snapshot must have its own Git repository');
    assert.equal(cli('git', ['symbolic-ref', 'HEAD'], snapshot), 'refs/heads/snapshot-default', 'ordinary user Git configuration must remain available');
    const snapshotRevision = cli('git', ['rev-parse', 'main'], snapshot);
    assert.notEqual(spawnSync('git', ['cat-file', '-e', snapshotRevision], { cwd: external }).status, 0,
      'snapshot objects must not be written to the exported object directory');
    assert((await readFile(path.join(extension, 'extension.toml'), 'utf8')).includes(snapshotRevision));
  }

  assert.equal(Object.keys(sdkChecksums).length, 6);
  assert(Object.values(sdkChecksums).every(hash => /^[a-f0-9]{64}$/.test(hash)));
  console.log('Build regressions passed: HTTPS/CONNECT, verified SDK recovery and concurrent installs, and isolated development snapshots.');
} finally {
  for (const socket of sockets) socket.destroy();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => proxy.close(resolve))]);
  await rm(temporary, { recursive: true, force: true });
}
