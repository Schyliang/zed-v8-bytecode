# V8 Ignition Bytecode for Zed

[English](README.md) | [简体中文](README.zh-CN.md)

Syntax highlighting for V8 Ignition bytecode disassembly in Zed, adapted from
[v8-bytecode-highlight 0.3.0](https://github.com/j4k0xb/v8-bytecode-highlight).

- Detects `.ign` files and files beginning with V8 bytecode or SharedFunctionInfo headers.
- Highlights source positions, `S>` / `E>` markers, addresses, offsets, hexadecimal bytes, opcodes, and registers.
- Supports `Wide` / `ExtraWide` instructions, constant pools, object tags, and V8 string representations.
- Uses Zed's JavaScript grammar for source between ` - source code:` and ` - script:`.
- Provides bracket matching and comment configuration.

## Local development

Requires Node.js, Git, and [`rtk`](https://github.com/rtk-ai/rtk).

```powershell
rtk npm install
rtk npm run generate
rtk npm run prepare:dev
```

In Zed's Extensions page, choose **Install Dev Extension** and select
`.build/dev-extension/` inside this project. Open `examples/features.ign`; the status bar should display
**V8 Ignition Bytecode**. Highlight colors depend on your Zed theme.

`prepare:dev` creates a local grammar Git snapshot in `.build/grammar-repository/`
and generates `.build/dev-extension/extension.toml` with a local `file://` URL.
The root `extension.toml` remains the release manifest. It operates on the build
snapshot only and does not create or commit a project repository or access remote
Git repositories. After moving the project or changing the grammar, rerun
`generate` and `prepare:dev`, then rebuild the development extension in Zed.

Zed downloads the WASI SDK and compiles the C grammar to WebAssembly during
installation. The first download is large and requires access to GitHub. Set
`WASI_SDK_PATH` in Zed's environment to reuse an existing SDK.

## Build and test

```powershell
rtk npm run build
rtk npm test
rtk npm run prepare:dev
```

`build` generates the parser and compiles `grammars/ignition.wasm` using WASI SDK
34.0. Set `WASI_SDK_PATH` to reuse an installed SDK. Downloads support
`HTTPS_PROXY`; the Windows SDK archive is about 590 MiB and is cached in `.build/`.

Tests load the Zed-compatible WASM in the native Tree-sitter runtime, then use a
browser-compatible build of the same grammar to check highlighting and injection
queries. Coverage includes the three upstream fixtures, instruction recognition,
string representations, JavaScript source boundaries, brackets, CRLF, file endings,
incremental source edits, and NUL preservation. A lexer-work regression checks that
metadata scanning grows linearly without relying on wall-clock timing.

`.build/` contains rebuildable caches, including the SDK and the development grammar
snapshot. It is excluded from Git. After removing it, rerun `build` for command-line
validation and `prepare:dev` before rebuilding the development extension in Zed.

## Publishing

The root `extension.toml` is committed for publishing. It uses this public
repository for the grammar, a fixed grammar commit, and
`path = "tree-sitter-ignition"`. For updates:

1. Commit and push any grammar changes to the public repository.
2. Update the root manifest's grammar `rev` to that commit and increment the
   extension version. Keep the version in `extension.template.toml` in sync for
   development installs. Commit and push the updated manifest.
3. Submit a pull request to [zed-industries/extensions](https://github.com/zed-industries/extensions)
   following the [Zed publishing guide](https://zed.dev/docs/extensions/publishing-guide).

`prepare:dev` writes local configuration only inside `.build/`; it does not
overwrite the published manifest. Validate the release grammar in Zed before
submitting an update.

The published manifest must use a public HTTPS grammar URL. Build caches are
development artifacts and should stay out of the release repository.

## License

GPL-3.0-only. See [NOTICE.md](NOTICE.md) for upstream and fixture attribution.
