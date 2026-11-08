# V8 Ignition Bytecode for Zed

[English](README.md) | [简体中文](README.zh-CN.md)

Syntax highlighting for V8 Ignition bytecode disassembly in Zed, adapted from
[v8-bytecode-highlight](https://github.com/j4k0xb/v8-bytecode-highlight).

- Recognizes `.ign` files and V8 bytecode headers.
- Highlights addresses, offsets, hex bytes, opcodes, registers, and constant pools.
- Supports V8 string representations and bracket matching.
- Highlights embedded source code using Zed's JavaScript grammar.

## Preview

Bytecode instructions, metadata, and constant pool entries:

![V8 bytecode instructions and constant pool entries highlighted in Zed](img/bytecode-highlighting.png)

Embedded JavaScript source:

![JavaScript source embedded in a V8 bytecode dump highlighted in Zed](img/embedded-javascript-highlighting.png)

## Development install

The pull request to the official Zed extension repository has not been merged yet.
Use the development installation below for now.

Requires Node.js and Git.

```sh
npm ci
npm run generate
npm run prepare:dev
```

In Zed, open **Extensions → Install Dev Extension** and select
`.build/dev-extension/` inside this project.
After changing the grammar or language queries, rerun these two preparation commands
and rebuild the development extension in Zed.

## Usage

Open an existing `.ign` file in Zed; the language is detected automatically. If it is
not detected, select **V8 Ignition Bytecode** in the language selector.
You can try `examples/features.ign` included in this project.

## Build and test

```sh
npm run build
npm test
```

### Reuse an existing WASI SDK

Set `WASI_SDK_PATH` to the SDK root directory, containing `bin/clang.exe` on Windows
or `bin/clang` on macOS/Linux. `npm run build` uses this SDK before checking its local
cache. Without the variable, it reuses the cached SDK or downloads one as needed.

PowerShell (current terminal session):

```powershell
$env:WASI_SDK_PATH = 'D:\Tools\wasi-sdk'
npm run build
```

macOS/Linux (current terminal session):

```sh
export WASI_SDK_PATH=/opt/wasi-sdk
npm run build
```

Zed versions that support `WASI_SDK_PATH` can also reuse this SDK when installing or
rebuilding a development extension. Fully quit Zed, then run `zed .` from the terminal
where you set the variable so it inherits the setting. You can also configure a user
or system environment variable and restart both the terminal and Zed. A running Zed
process does not automatically read environment changes.

An invalid SDK path causes the project build to fail; Zed logs a warning and falls
back to its own SDK cache or download.

## License

GPL-3.0-only. See [NOTICE.md](NOTICE.md) for attribution and third-party license details.
