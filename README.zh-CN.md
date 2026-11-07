# Zed 的 V8 Ignition 字节码高亮

[English](README.md) | [简体中文](README.zh-CN.md)

为 Zed 提供 V8 Ignition 字节码反汇编高亮，参考
[v8-bytecode-highlight](https://github.com/j4k0xb/v8-bytecode-highlight)。

- 自动识别 `.ign` 文件和 V8 字节码标头。
- 高亮地址、偏移、十六进制字节、操作码、寄存器和常量池。
- 支持 V8 字符串表示和括号匹配。
- 使用 Zed 的 JavaScript 语法高亮嵌入源码。

## 开发安装

需要 Node.js 和 Git。

```sh
npm ci
npm run generate
npm run prepare:dev
```

在 Zed 中打开 **Extensions → Install Dev Extension**，选择本项目中的
`.build/dev-extension/` 目录。打开 `examples/features.ign` 即可查看效果。
修改语法或语言查询后，重新运行上述两个准备命令，并在 Zed 中重新构建开发扩展。

## 构建和测试

```sh
npm run build
npm test
```

构建会自动下载 WASI SDK；设置 `WASI_SDK_PATH` 可复用已有 SDK。

## 许可

GPL-3.0-only。归属与第三方许可说明见 [NOTICE.md](NOTICE.md)。
