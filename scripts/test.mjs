// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Parser, Language, Query } from 'web-tree-sitter';

const root = fileURLToPath(new URL('../', import.meta.url));
const nativeCache = path.join(root, '.build', 'native-validation');
await mkdir(nativeCache, { recursive: true });
await cp(path.join(root, 'grammars', 'ignition.wasm'), path.join(nativeCache, 'ignition.wasm'));
const nulCases = [
  ['metadata', 'foo\0bar\n', 'other', '\0'],
  ['NUL-only metadata', '\0\n', 'other', '\0'],
  ['adjacent NULs', 'foo\0\0bar\n', 'other', '\0\0'],
  ['Unicode metadata', '😀\0💡\n', 'other', '😀\0💡'],
  ['unquoted string', '0: 0x123 <String[3]: #a\0b>\n', 'string_value', 'a\0b'],
  ['Unicode unquoted string', '0: 0x123 <String[5]: #😀\0💡>\n', 'string_value', '😀\0💡'],
  ['NUL-only string', '0: 0x123 <String[1]: #\0>\n', 'string_value', '\0'],
  ['double-quoted string', '0: 0x123 <String[3]: "a\0b">\n', 'string_value', '"a\0b"'],
  ['Unicode quoted string', '0: 0x123 <String[5]: "😀\0💡">\n', 'string_value', '"😀\0💡"'],
  ['single-quoted string', "0: 0x123 <String[3]: c'a\0b'>\n", 'string_value', "'a\0b'"],
  ['escaped NUL', '"a\\\0b"\n', 'quoted_string', '"a\\\0b"'],
  ['comment', '// a\0b\n', 'comment', '// a\0b'],
  ['Unicode comment', '// 😀\0💡\n', 'comment', '// 😀\0💡'],
  ['instruction operand', '0x123 @ 0 : 0b Ldar a0\0\n', 'other', '\0'],
  ['property', ' - note: a\0b\n', 'other', '\0'],
  ['embedded source', ' - source code: const x = "a\0b";\n - script: 0x123 <Script>\n', 'javascript_source', null],
];
const nulFixture = nulCases.map(([, text]) => text).join('');
const nulFiles = [];
for (const [name, text] of [
  ['lf', nulFixture], ['crlf', nulFixture.replaceAll('\n', '\r\n')], ['eof', nulFixture.trimEnd()],
]) {
  const file = path.join(nativeCache, `nul-${name}.ign`);
  await writeFile(file, text);
  nulFiles.push(file);
}
const config = path.join(root, '.build', 'tree-sitter-config.json');
await writeFile(config, JSON.stringify({ 'parser-directories': [root] }));
const cli = path.join(root, 'node_modules', 'tree-sitter-cli', process.platform === 'win32' ? 'tree-sitter.exe' : 'tree-sitter');
const native = spawnSync('rtk', [cli, 'parse', '--wasm', '--quiet', '--stat', '--config-path', config,
  ...['test.ign', 'test2.ign', 'test3.ign'].map(name => path.join(root, 'examples', 'upstream', name)),
  path.join(root, 'examples', 'features.ign'),
  ...nulFiles,
], { cwd: path.join(root, 'tree-sitter-ignition'), stdio: 'inherit',
  env: { ...process.env, TREE_SITTER_LIBDIR: nativeCache } });
if (native.error) throw native.error;
assert.equal(native.status, 0, 'Zed-compatible WASM must pass the native Tree-sitter runtime');
await Parser.init();
const language = await Language.load(path.join(root, '.build', 'ignition-web.wasm'));
const parser = new Parser();
parser.setLanguage(language);
const queries = {};
for (const name of ['highlights', 'injections', 'brackets']) {
  queries[name] = new Query(language, await readFile(path.join(root, 'languages', 'ignition', `${name}.scm`), 'utf8'));
}

function nodes(node, type) {
  return node.descendantsOfType(type);
}

function parse(text, name) {
  const tree = parser.parse(text);
  assert(tree, `${name}: no parse tree`);
  const errors = tree.rootNode.descendantsOfType('ERROR');
  assert(!tree.rootNode.hasError, `${name}: parse errors: ${errors.slice(0, 5).map(e => `${e.startPosition.row + 1}: ${e.text.slice(0, 120)}`).join('; ')}`);
  const expectedInstructions = text.match(/^\s*(?:\d+\s+(?:[SE]>\s+)?)?(?:0x)?[a-fA-F\d]+\s+@\s*\d+\s*:\s*(?:[a-fA-F\d]{2}\s+)+[A-Za-z][\w.]*/gm) || [];
  const instructions = nodes(tree.rootNode, 'instruction');
  assert.equal(instructions.length, expectedInstructions.length, `${name}: every bytecode instruction must be recognized`);
  // Query compilation and execution exercise the same WASM parser and query
  // syntax used by Zed. Presence checks avoid depending on a particular theme.
  const captures = queries.highlights.captures(tree.rootNode);
  if (instructions.length) {
    for (const instruction of instructions) {
      const opcode = nodes(instruction, 'opcode')[0];
      assert(opcode && /^[A-Za-z][\w.]*$/.test(opcode.text), `${name}: opcode split into hex bytes`);
      assert(captures.some(c => c.name === 'type' && c.node.id === opcode.id), `${name}: opcode missing highlight`);
    }
  }
  console.log(`${name}: ${instructions.length} instructions, ${captures.length} highlight captures, no parse errors`);
  return tree;
}

for (const filename of ['test.ign', 'test2.ign', 'test3.ign']) {
  const tree = parse(await readFile(path.join(root, 'examples', 'upstream', filename), 'utf8'), filename);
  if (filename === 'test2.ign') {
    const sources = nodes(tree.rootNode, 'javascript_source');
    assert.equal(sources.length, 2, 'two source blocks must be kept separate');
    assert(sources.every(node => !node.text.includes(' - script:')), 'JavaScript injection must stop before the script footer');
    assert.equal(queries.injections.captures(tree.rootNode).length, 2);
  }
  tree.delete();
}

const features = await readFile(path.join(root, 'examples', 'features.ign'), 'utf8');
for (const text of [features, features.replaceAll('\n', '\r\n'), features.trimEnd()]) {
  const tree = parse(text, 'features (LF / CRLF / final line)');
  assert.equal(nodes(tree.rootNode, 'string_tag').length, 7, 'all V8 string representations');
  assert.equal(nodes(tree.rootNode, 'position_marker').length, 2);
  const captures = queries.highlights.captures(tree.rootNode);
  assert(captures.some(c => c.name === 'constant' && c.node.text === 'r1'));
  assert(captures.some(c => c.name === 'constant' && c.node.text === 'a0'));
  assert(captures.some(c => c.name === 'number' && c.node.text === '-3.5'));
  assert(queries.brackets.captures(tree.rootNode).length > 0);
  tree.delete();
}

for (const [name, text, type, value] of nulCases) {
  for (const input of [text, text.replaceAll('\n', '\r\n'), text.trimEnd()]) {
    const tree = parse(input, `NUL in ${name}`);
    assert(nodes(tree.rootNode, type).some(node => value === null ? node.text.includes('\0') : node.text === value),
      `${name}: NUL must remain in the expected token`);
    assert.equal(nodes(tree.rootNode, 'javascript_source').length, name === 'embedded source' ? 1 : 0,
      `${name}: only embedded source may produce a JavaScript injection`);
    tree.delete();
  }
}

// Count lexer work rather than elapsed time to detect quadratic scanning
// without making this regression depend on machine speed or system load.
const lexicalSteps = [];
for (const count of [100, 200]) {
  let steps = 0;
  parser.setLogger((_message, isLex) => { if (isLex) steps++; });
  let tree;
  try {
    tree = parser.parse('Parameter count 1\n'.repeat(count));
  } finally {
    parser.setLogger(null);
  }
  assert(tree && !tree.rootNode.hasError, 'ambiguous metadata must remain parseable');
  tree.delete();
  lexicalSteps.push(steps);
}
assert(lexicalSteps[0] > 0 && lexicalSteps[1] <= lexicalSteps[0] * 2.5,
  `doubling metadata must take approximately linear lexer work: ${lexicalSteps.join(' -> ')}`);
console.log(`Metadata lexer work scales linearly: ${lexicalSteps.join(' -> ')} steps.`);

for (const [name, text] of [
  ['empty file', ''],
  ['unterminated source block', ' - source code: const x = 1;\n// still JavaScript'],
  ['unmatched dump delimiters', '0: 0x123 <FixedArray[3]>\n<unknown diagnostic\n>\n'],
]) {
  const tree = parse(text, name);
  if (name === 'unterminated source block') {
    assert.equal(nodes(tree.rootNode, 'javascript_source').length, 1);
  }
  tree.delete();
}

const lookalikeFooter = ' - source code: const text = `\n - script: 0x123 <not-a-script>\n`;\n - script: 0x456 <Script>\n - length: 1\n';
const boundaryTree = parse(lookalikeFooter, 'source footer lookalike');
const source = nodes(boundaryTree.rootNode, 'javascript_source')[0];
assert(source.text.includes('<not-a-script>'));
assert(!source.text.includes('0x456'));
boundaryTree.delete();

const before = ' - source code: const x = 1;\n - script: 0x123 <Script>\n';
const editedTree = parser.parse(before);
const index = before.indexOf('1;');
editedTree.edit({
  startIndex: index, oldEndIndex: index + 1, newEndIndex: index + 2,
  startPosition: { row: 0, column: index },
  oldEndPosition: { row: 0, column: index + 1 },
  newEndPosition: { row: 0, column: index + 2 },
});
const after = before.slice(0, index) + '42' + before.slice(index + 1);
const reparsed = parser.parse(after, editedTree);
assert(!reparsed.rootNode.hasError);
assert(nodes(reparsed.rootNode, 'javascript_source')[0].text.includes('const x = 42;'));
assert(!nodes(reparsed.rootNode, 'javascript_source')[0].text.includes(' - script:'));
editedTree.delete();
reparsed.delete();
console.log('Incremental source edits preserve the JavaScript injection boundary.');
for (const query of Object.values(queries)) query.delete();
parser.delete();
console.log('Parser, highlighting, JavaScript injection, and bracket checks passed.');
