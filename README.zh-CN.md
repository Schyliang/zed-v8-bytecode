# Zed 的 V8 Ignition 字节码高亮

[English](README.md) | [简体中文](README.zh-CN.md)

为 Zed 提供 V8 Ignition 字节码反汇编的语法高亮，参考
[v8-bytecode-highlight 0.3.0](https://github.com/j4k0xb/v8-bytecode-highlight)。

- 自动识别 `.ign` 文件，以及以 V8 字节码或 SharedFunctionInfo 标头开头的文件。
- 高亮源码位置、`S>` / `E>`、地址、偏移、十六进制字节、操作码和寄存器。
- 支持 `Wide` / `ExtraWide` 指令、常量池、对象标签和 V8 的多种字符串表示。
- 将 ` - source code:` 与 ` - script:` 之间的源码交给 Zed 的 JavaScript 高亮。
- 提供括号匹配和注释配置。

## 本地开发安装

需要 Node.js、Git 和 [`rtk`](https://github.com/rtk-ai/rtk)。

```powershell
rtk npm install
rtk npm run generate
rtk npm run prepare:dev
```

打开 Zed 的 Extensions 页面，选择 **Install Dev Extension**，选中本项目中的
`.build/dev-extension/` 目录。
打开 `examples/features.ign`，状态栏应显示 **V8 Ignition Bytecode**。
高亮颜色由当前 Zed 主题决定。

`prepare:dev` 会在 `.build/grammar-repository/` 创建仅用于构建的本地 Git
快照，并生成包含本机 `file://` 地址的 `.build/dev-extension/extension.toml`。
根目录 `extension.toml` 保留为发布清单。脚本只操作构建目录，
不会创建或提交项目 Git 仓库，也不会访问远程 Git 仓库。
移动项目目录或修改语法后，重新运行 `generate` 和 `prepare:dev`，
再在 Zed 中重新构建开发扩展。

Zed 安装时会获取 WASI SDK 并将 C 语法编译为 WebAssembly。首次下载较大，
需要能够访问 GitHub。可通过 Zed 进程的 `WASI_SDK_PATH` 指定已有 SDK。

## 命令行构建和验证

```powershell
rtk npm run build
rtk npm test
rtk npm run prepare:dev
```

`build` 生成解析器，并使用 WASI SDK 34.0 编译 `grammars/ignition.wasm`。
已有 SDK 时可设置 `WASI_SDK_PATH`。下载支持 `HTTPS_PROXY`；
Windows SDK 压缩包约 590 MiB，保存在 `.build/`。

测试使用原生 Tree-sitter 运行时验证 Zed 兼容 WASM，再用浏览器兼容的同源
语法检查高亮和注入查询。覆盖三个上游示例、指令识别、字符串表示、
JavaScript 源码边界、括号、CRLF、文件末尾和源码的增量编辑。
另有 NUL 内容保留检查，以及通过 lexer 工作量验证元数据扫描线性增长的回归测试。

`.build/` 包含可重建的缓存，包括 SDK 和开发用语法快照，已被 Git 忽略。
清理后，命令行验证需重新运行 `build`；在 Zed 中重新构建开发扩展前，
需重新运行 `prepare:dev`。

## 发布

根目录 `extension.toml` 会提交到 Git，用于发布。语法地址指向本项目公开仓库，
并指定固定提交及 `path = "tree-sitter-ignition"`。后续更新时：

1. 将语法修改提交并推送到公开仓库。
2. 将根清单中语法的 `rev` 更新为该提交，增加扩展版本，并同步
   `extension.template.toml` 中的开发安装版本。提交并推送更新后的清单。
3. 按照 [Zed 发布指南](https://zed.dev/docs/extensions/publishing-guide)，向
   [zed-industries/extensions](https://github.com/zed-industries/extensions) 提交 PR。

`prepare:dev` 只在 `.build/` 中写入本地配置，不会覆盖发布清单。
提交更新前需在 Zed 中验证发布版本的语法。

发布清单须使用公开语法地址，避免包含本机 `file://` 路径。
构建缓存属于开发产物，应保留在发布仓库之外。

## 许可

GPL-3.0-only。原项目及示例的归属说明见 [NOTICE.md](NOTICE.md)。
