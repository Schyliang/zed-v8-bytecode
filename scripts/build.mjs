// SPDX-License-Identifier: GPL-3.0-only
import { spawnSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { pipeline } from 'node:stream/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const sdkVersion = '34.0';
const platform = { win32: 'windows', darwin: 'macos', linux: 'linux' }[process.platform];
const arch = { x64: 'x86_64', arm64: 'arm64' }[process.arch];

function run(executable, args, cwd = root) {
  const result = spawnSync('rtk', [executable, ...args], { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed (exit ${result.status})`);
}

async function exists(file) {
  try { await access(file); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

// Node's built-in HTTP client does not honor proxy variables automatically.
// Use CONNECT when a HTTPS_PROXY is supplied; redirects use the same policy.
async function request(url, redirects = 0) {
  if (redirects > 8) throw new Error('Too many SDK download redirects');
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const target = new URL(url);
  let agent;
  if (proxy) {
    const proxyUrl = new URL(proxy);
    if (!['http:', 'https:'].includes(proxyUrl.protocol)) {
      throw new Error('HTTPS_PROXY must be an HTTP or HTTPS proxy');
    }
    const transport = proxyUrl.protocol === 'https:' ? https : http;
    const socket = await new Promise((resolve, reject) => {
      const headers = { Host: `${target.hostname}:443` };
      if (proxyUrl.username || proxyUrl.password) {
        headers['Proxy-Authorization'] = 'Basic ' + Buffer.from(
          `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`,
        ).toString('base64');
      }
      const req = transport.request({
        hostname: proxyUrl.hostname,
        port: proxyUrl.port || (proxyUrl.protocol === 'https:' ? 443 : 80),
        method: 'CONNECT', path: `${target.hostname}:443`, headers,
      });
      req.setTimeout(30000, () => req.destroy(new Error('Proxy connection timed out')));
      req.on('error', reject);
      req.on('connect', (response, connection) => {
        if (response.statusCode !== 200) {
          connection.destroy();
          reject(new Error(`Proxy returned HTTP ${response.statusCode}`));
        } else resolve(connection);
      });
      req.end();
    });
    agent = new https.Agent({ socket, keepAlive: false });
  }
  const response = await new Promise((resolve, reject) => {
    const req = https.get(target, { agent }, resolve);
    req.setTimeout(60000, () => req.destroy(new Error('SDK download timed out')));
    req.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    return request(new URL(response.headers.location, target).href, redirects + 1);
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`SDK download returned HTTP ${response.statusCode}`);
  }
  return response;
}

async function compiler() {
  const executable = process.platform === 'win32' ? 'clang.exe' : 'clang';
  if (process.env.WASI_SDK_PATH) {
    const clang = path.resolve(process.env.WASI_SDK_PATH, 'bin', executable);
    if (!await exists(clang)) throw new Error(`WASI_SDK_PATH has no bin/${executable}`);
    return clang;
  }
  if (!platform || !arch) throw new Error('Set WASI_SDK_PATH for this platform');
  const name = `wasi-sdk-${sdkVersion}-${arch}-${platform}`;
  const cache = path.join(root, '.build');
  const sdk = path.join(cache, name);
  const clang = path.join(sdk, 'bin', executable);
  if (!await exists(clang)) {
    await mkdir(cache, { recursive: true });
    const archive = path.join(cache, `${name}.tar.gz`);
    if (!await exists(archive)) {
      const url = `https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${sdkVersion.split('.')[0]}/${name}.tar.gz`;
      console.log(`Downloading ${name} (Windows SDK is about 590 MiB)...`);
      const temporary = `${archive}.partial`;
      try {
        const response = await request(url);
        let received = 0;
        let reported = 0;
        response.on('data', chunk => {
          received += chunk.length;
          if (received - reported >= 64 * 1024 * 1024) {
            reported = received;
            console.log(`Downloaded ${Math.round(received / 1024 / 1024)} MiB`);
          }
        });
        await pipeline(response, createWriteStream(temporary));
        await rename(temporary, archive);
      } catch (error) {
        await rm(temporary, { force: true }).catch(cleanup => console.error(`Temporary download cleanup failed: ${cleanup.message}`));
        throw error;
      }
    }
    console.log('Extracting WASI SDK...');
    run('tar', ['-xzf', archive, '-C', cache]);
  }
  return clang;
}

try {
  run('npm', ['run', 'generate']);
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
  // Emscripten's browser loader expects its own libc rather than WASI libc.so.
  // This grammar has no libc calls, so a second build can omit that dependency.
  await mkdir(path.join(root, '.build'), { recursive: true });
  const webOutput = path.join(root, '.build', 'ignition-web.wasm');
  run(clang, [...common, '-nostdlib', '-Wl,--no-entry', '-o', `${webOutput}.partial`]);
  await rename(`${webOutput}.partial`, webOutput);
  console.log('Built grammars/ignition.wasm');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
