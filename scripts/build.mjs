// SPDX-License-Identifier: GPL-3.0-only
import { spawnSync } from 'node:child_process';
import { createReadStream, createWriteStream } from 'node:fs';
import { access, mkdir, mkdtemp, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { sdkChecksums } from './wasi-sdk-checksums.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdkVersion = '34.0';
const downloadHosts = ['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'];

function run(executable, args, cwd = root) {
  const result = spawnSync(executable, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (exit ${result.status})`);
}

async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Restrict every redirect hop, while allowing GitHub's release asset hosts.
export async function request(url, options = {}, redirects = 0) {
  if (redirects > 8) throw new Error('Too many SDK download redirects');
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('SDK download URL must use HTTPS');
  if (!(options.allowedHosts || downloadHosts).includes(target.hostname)) {
    throw new Error(`SDK download host is not allowed: ${target.hostname}`);
  }
  if (target.username || target.password) throw new Error('SDK download URL must not contain credentials');
  const proxy = options.proxy ?? (process.env.HTTPS_PROXY || process.env.https_proxy);
  let agent, socket, req, incoming, socketError;
  const cleanup = () => { agent?.destroy(); socket?.destroy(); };
  try {
    if (proxy) {
      const proxyUrl = new URL(proxy);
      if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
        throw new Error('HTTPS_PROXY must be an HTTP or HTTPS proxy');
      }
      const authority = `${target.hostname}:${target.port || 443}`;
      const headers = { Host: authority };
      if (proxyUrl.username || proxyUrl.password) {
        headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString('base64');
      }
      const transport = proxyUrl.protocol === 'https:' ? https : http;
      socket = await new Promise((resolve, reject) => {
        const connect = transport.request({
          hostname: proxyUrl.hostname,
          port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
          method: 'CONNECT', path: authority, headers, ca: options.ca,
        });
        connect.setTimeout(options.connectTimeoutMs ?? 30000,
          () => connect.destroy(new Error('Proxy connection timed out')));
        connect.on('error', reject);
        connect.on('connect', (response, connection, head) => {
          connect.setTimeout(0);
          // Guard the raw socket before handing it to TLS.
          connection.on('error', error => {
            socketError = error;
            incoming?.destroy(error);
            req?.destroy(error);
          });
          if (response.statusCode !== 200) {
            connection.destroy();
            reject(new Error(`Proxy returned HTTP ${response.statusCode}`));
          } else {
            if (head.length) connection.unshift(head);
            resolve(connection);
          }
        });
        connect.end();
      });
      if (socketError) throw socketError;
      if (socket.destroyed) throw new Error('Proxy connection closed before TLS handshake');
      agent = new https.Agent({ socket, keepAlive: false });
    }
    const response = await new Promise((resolve, reject) => {
      req = https.get(target, { agent, ca: options.ca }, value => {
        incoming = value;
        // A socket can fail before the caller attaches its pipeline handlers.
        // The stream retains .errored, which pipeline reports to the caller.
        incoming.on('error', () => {});
        incoming.once('close', cleanup);
        resolve(value);
      });
      req.setTimeout(options.timeoutMs ?? 60000, () => {
        const error = new Error('SDK download timed out');
        // The response-header promise may already have resolved.
        incoming?.destroy(error);
        req.destroy(error);
      });
      req.on('error', error => {
        incoming?.destroy(error);
        cleanup();
        reject(error);
      });
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location) throw new Error('SDK download redirect has no Location');
      return await request(new URL(location, target).href, options, redirects + 1);
    }
    if (response.statusCode !== 200) {
      response.destroy();
      throw new Error(`SDK download returned HTTP ${response.statusCode}`);
    }
    return response;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export async function verifyArchive(archive, expected) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(archive), hash);
  const actual = hash.digest('hex');
  if (actual !== expected) throw Object.assign(
    new Error(`WASI SDK SHA-256 mismatch: expected ${expected}, received ${actual}`),
    { code: 'ERR_SDK_CHECKSUM' },
  );
}

async function sdkFilesReady(sdk, executable) {
  const required = [
    path.join(sdk, 'bin', executable),
    path.join(sdk, 'share', 'wasi-sysroot', 'include', 'wasm32-wasip1', 'stdio.h'),
    path.join(sdk, 'share', 'wasi-sysroot', 'lib', 'wasm32-wasip1', 'libc.so'),
  ];
  for (const file of required) {
    try { const info = await stat(file); if (!info.isFile() || !info.size) return false; } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
      throw error;
    }
  }
  return true;
}

async function sdkVerified(sdk, executable, digest) {
  if (!await sdkFilesReady(sdk, executable)) return false;
  try {
    return (await readFile(path.join(sdk, '.verified-sha256'), 'utf8')).trim() === digest;
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'EISDIR'].includes(error.code)) return false;
    throw error;
  }
}

async function releaseSdkLock(owner, lock) {
  await owner.close().catch(error => console.error(`SDK lock close failed: ${error.message}`));
  await unlink(lock).catch(error => console.error(`SDK lock cleanup failed: ${error.message}`));
}

async function acquireSdkLock(lock) {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (true) {
    let owner;
    try { owner = await open(lock, 'wx'); } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    if (owner) {
      try { await owner.writeFile(`${process.pid}\n`); } catch (error) {
        await releaseSdkLock(owner, lock);
        throw error;
      }
      return owner;
    }
    let contents;
    try { contents = await readFile(lock, 'utf8'); } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (/^[1-9]\d*\n$/.test(contents)) {
      try { process.kill(Number(contents.trim()), 0); } catch (error) {
        if (error.code === 'ESRCH') {
          // The previous owner may have released the file just before exiting.
          let current;
          try { current = await readFile(lock, 'utf8'); } catch (readError) {
            if (readError.code === 'ENOENT') continue;
            throw readError;
          }
          if (current !== contents) continue;
          // Do not race other waiters by removing a lock we do not own.
          throw Object.assign(new Error(`Interrupted SDK installation; remove its lock before retrying: ${lock}`),
            { code: 'ERR_SDK_LOCK_INTERRUPTED' });
        }
        if (error.code !== 'EPERM') throw error;
      }
    }
    if (Date.now() >= deadline) {
      throw Object.assign(new Error(`Timed out waiting for SDK installation lock: ${lock}`),
        { code: 'ERR_SDK_LOCK_TIMEOUT' });
    }
    await delay(100);
  }
}

export async function installSdk({ cache, name, digest, url, executable, requestOptions }) {
  if (!/^wasi-sdk-\d+\.\d+-(?:arm64|x86_64)-(?:linux|macos|windows)$/.test(name)) {
    throw new Error('Invalid WASI SDK cache name');
  }
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid WASI SDK SHA-256');
  const sdk = path.join(cache, name);
  if (await sdkVerified(sdk, executable, digest)) return path.join(sdk, 'bin', executable);
  await mkdir(cache, { recursive: true });
  const lock = path.join(cache, `${name}.install-lock`);
  const owner = await acquireSdkLock(lock);
  try {
    // Another process may have completed installation while this one waited.
    if (await sdkVerified(sdk, executable, digest)) return path.join(sdk, 'bin', executable);
    const archive = path.join(cache, `${name}.tar.gz`);
    if (await exists(archive)) {
      try { await verifyArchive(archive, digest); } catch (error) {
        // Replace corrupt cached downloads rather than repeating the same failure.
        if (error.code !== 'ERR_SDK_CHECKSUM') throw error;
        console.error(error.message);
        await rm(archive, { force: true });
      }
    }
    if (!await exists(archive)) {
      const temporary = `${archive}.${randomUUID()}.partial`;
      console.log(`Downloading ${name}...`);
      try {
        const response = await request(url, requestOptions);
        let received = 0, reported = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received - reported >= 64 * 1024 * 1024) {
            reported = received;
            console.log(`Downloaded ${Math.round(received / 1024 / 1024)} MiB`);
          }
        });
        await pipeline(response, createWriteStream(temporary));
        await verifyArchive(temporary, digest);
        await rename(temporary, archive);
      } catch (error) {
        await rm(temporary, { force: true }).catch(cleanup => console.error(`Temporary download cleanup failed: ${cleanup.message}`));
        throw error;
      }
    }
    const staging = await mkdtemp(path.join(cache, '.sdk-extract-'));
    let preserveStaging = false;
    try {
      console.log('Extracting WASI SDK...');
      // Relative paths prevent GNU tar interpreting a Windows drive as a host.
      run('tar', ['-xzf', path.basename(archive), '-C', path.basename(staging)], cache);
      const extracted = path.join(staging, name);
      if (!await sdkFilesReady(extracted, executable)) throw new Error('Extracted WASI SDK is missing compiler or sysroot files');
      await writeFile(path.join(extracted, '.verified-sha256'), `${digest}\n`);
      const backup = path.join(staging, 'previous-sdk');
      const hadPrevious = await exists(sdk);
      if (hadPrevious) await rename(sdk, backup);
      try { await rename(extracted, sdk); } catch (error) {
        if (hadPrevious) await rename(backup, sdk).catch(restore => {
          preserveStaging = true;
          console.error(`SDK cache restore failed: ${restore.message}; previous cache remains in ${backup}`);
        });
        throw error;
      }
    } finally {
      if (!preserveStaging) await rm(staging, { recursive: true, force: true }).catch(cleanup => console.error(`SDK staging cleanup failed: ${cleanup.message}`));
    }
    return path.join(sdk, 'bin', executable);
  } finally {
    await releaseSdkLock(owner, lock);
  }
}

async function compiler() {
  const executable = process.platform === 'win32' ? 'clang.exe' : 'clang';
  if (process.env.WASI_SDK_PATH) {
    const clang = path.resolve(process.env.WASI_SDK_PATH, 'bin', executable);
    if (!await exists(clang)) throw new Error(`WASI_SDK_PATH has no bin/${executable}`);
    return clang;
  }
  const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
  const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch];
  if (!platform || !arch) throw new Error('Set WASI_SDK_PATH for this platform');
  const name = `wasi-sdk-${sdkVersion}-${arch}-${platform}`;
  const digest = sdkChecksums[name];
  if (!digest) throw new Error(`No trusted checksum for ${name}`);
  return installSdk({
    cache: path.join(root, '.build'), name, digest, executable,
    url: `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${sdkVersion.split('.')[0]}/${name}.tar.gz`,
  });
}

export async function build() {
  const cli = path.join(root, 'node_modules', 'tree-sitter-cli', process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter');
  run(cli, ['generate', '--abi', '14'], path.join(root, 'tree-sitter-ignition'));
  const clang = await compiler();
  await mkdir(path.join(root, 'grammars'), { recursive: true });
  const src = path.join(root, 'tree-sitter-ignition', 'src');
  const output = path.join(root, 'grammars', 'ignition.wasm');
  const common = [
    '-fPIC', '-shared', '-Os', '-Wl,--export=tree_sitter_ignition',
    '-Wl,--max-memory=4294967296',
    '-I', src, path.join(src, 'parser.c'), path.join(src, 'scanner.c'),
  ];
  // Match Zed's compilation flags for the actual extension artifact.
  run(clang, [...common, '-o', `${output}.partial`]);
  await rename(`${output}.partial`, output);
  // The browser loader supplies allocator functions from its own runtime.
  // Allow only those imports rather than linking against WASI libc.so.
  await mkdir(path.join(root, '.build'), { recursive: true });
  const allocatorImports = path.join(root, '.build', 'wasm-allocator-imports.txt');
  await writeFile(allocatorImports, 'calloc\nfree\n');
  const webOutput = path.join(root, '.build', 'ignition-web.wasm');
  run(clang, [...common, '-nostdlib', '-Wl,--no-entry', '-Xlinker', `--allow-undefined-file=${allocatorImports}`, '-o', `${webOutput}.partial`]);
  await rename(`${webOutput}.partial`, webOutput);
  console.log('Built grammars/ignition.wasm');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  build().catch(error => { console.error(error.message); process.exitCode = 1; });
}
