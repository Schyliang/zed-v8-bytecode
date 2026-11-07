# V8 Ignition Bytecode for Zed

[English](README.md) | [简体中文](README.zh-CN.md)

Syntax highlighting for V8 Ignition bytecode disassembly in Zed, adapted from
[v8-bytecode-highlight](https://github.com/j4k0xb/v8-bytecode-highlight).

- Recognizes `.ign` files and V8 bytecode headers.
- Highlights addresses, offsets, hex bytes, opcodes, registers, and constant pools.
- Supports V8 string representations and bracket matching.
- Highlights embedded source code using Zed's JavaScript grammar.

## Development install

Requires Node.js and Git.

```sh
npm ci
npm run generate
npm run prepare:dev
```

In Zed, open **Extensions → Install Dev Extension** and select
`.build/dev-extension/` inside this project. Open `examples/features.ign` to try it.
After changing the grammar or language queries, rerun these two preparation commands
and rebuild the development extension in Zed.

## Build and test

```sh
npm run build
npm test
```

The build downloads WASI SDK automatically. Set `WASI_SDK_PATH` to reuse an existing SDK.

## License

GPL-3.0-only. See [NOTICE.md](NOTICE.md) for attribution and third-party license details.
