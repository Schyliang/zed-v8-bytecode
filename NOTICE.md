# Attribution

This extension adapts the syntax highlighting behavior of
[j4k0xb/v8-bytecode-highlight](https://github.com/j4k0xb/v8-bytecode-highlight),
version 0.3.0.

The original project includes the GNU General Public License version 3.
This adaptation retains that license; see `LICENSE`.
The three files in `examples/upstream/` are unchanged copies of the original
project's `playground/` fixtures. The Tree-sitter grammar, scanner, Zed queries,
and build scripts were written for this adaptation.

## Tree-sitter

The headers in `tree-sitter-ignition/src/tree_sitter/` are supplied by
[Tree-sitter](https://github.com/tree-sitter/tree-sitter), version 0.25.10,
through its parser generator. They retain Tree-sitter's MIT license and
copyright notice; see [licenses/tree-sitter.txt](licenses/tree-sitter.txt).
The extension's grammar and other adaptation code remain GPL-3.0-only.
