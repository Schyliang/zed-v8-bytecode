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
  ['metadata', 'foo\0bar\n', null, null],
  ['NUL-only metadata', '\0\n', null, null],
  ['adjacent NULs', 'foo\0\0bar\n', null, null],
  ['Unicode metadata', '😀\0💡\n', null, null],
  ['unquoted string', '0: 0x123 <String[3]: #a\0b>\n', 'string_value', 'a\0b'],
  ['Unicode unquoted string', '0: 0x123 <String[5]: #😀\0💡>\n', 'string_value', '😀\0💡'],
  ['NUL-only string', '0: 0x123 <String[1]: #\0>\n', 'string_value', '\0'],
  ['double-quoted string', '0: 0x123 <String[3]: "a\0b">\n', 'string_value', '"a\0b"'],
  ['Unicode quoted string', '0: 0x123 <String[5]: "😀\0💡">\n', 'string_value', '"😀\0💡"'],
  ['single-quoted string', "0: 0x123 <String[3]: c'a\0b'>\n", 'string_value', "'a\0b'"],
  ['escaped NUL', '"a\\\0b"\n', 'quoted_string', '"a\\\0b"'],
  ['comment', '// a\0b\n', 'comment', '// a\0b'],
  ['Unicode comment', '// 😀\0💡\n', 'comment', '// 😀\0💡'],
  ['instruction operand', '0x123 @ 0 : 0b Ldar a0\0\n', null, null],
  ['property', ' - note: a\0b\n', null, null],
  ['embedded source', ' - source code: const x = "a\0b";\n - script: 0x123 <Script>\n', 'javascript_source', null],
];
const nulFixture = nulCases.map(([, text]) => text).join('');
const malformedOpcodes = [
  '0x123 @ 0 : 01 2 Star0\n',
  '0x123 @ 0 : 01 0x2\n',
  '0x123 @ 0 : 01 -2\n',
  '0x123 @ 0 : 01 2.5\n',
];
const stringCases = [
  ['comparison', '0: 0x1000 <String[3]: #a>b>\n', ['a>b']],
  ['greater-than only', '0: 0x1000 <String[1]: #>>\n', ['>']],
  ['trailing greater-than', '0: 0x1000 <String[2]: #a>>\n', ['a>']],
  ['repeated greater-than', '0: 0x1000 <String[2]: #>>>\n', ['>>']],
  ['empty string', '0: 0x1000 <String[0]: #>\n', [null]],
  ['adjacent tags', '0: <String[2]: #a>> <String[1]: #>>\n', ['a>', '>']],
  ['nested tags', '0: <Map <String[3]: #a>b> <String[1]: #>>>\n', ['a>b', '>']],
  ['nested empty string', '0: <Map <String[0]: #>>\n', [null]],
  ['tag lookalike in value', '0: <String[15]: #<String[1]: #x>>\n', ['<String[1]: #x>']],
  ['NUL and greater-than', '0: <String[4]: #a\0>b>\n', ['a\0>b']],
  ['Unicode and greater-than', '0: <String[5]: u#😀>💡>\n', ['😀>💡']],
  ['escaped NUL', '0: <String[4]: #a\\x00>b>\n', ['a\\x00>b']],
  ['escaped newline', '0: <String[3]: #a\\n>>\n', ['a\\n>']],
  ['escaped backslash', '0: <String[3]: #\\\\>x>\n', ['\\\\>x']],
  ['escaped wide string', '0: <String[3]: u#\\x4e2d\\x6587>>\n', ['\\x4e2d\\x6587>']],
  ['nested escaped wide string', '0: <Map <String[2]: u#\\x4e2d\\x6587>>\n', ['\\x4e2d\\x6587']],
  ['escaped supplementary Unicode', '0: <String[5]: u#\\xd83d\\xde00>\\xd83d\\xdca1>\n', ['\\xd83d\\xde00>\\xd83d\\xdca1']],
  ['escaped byte and hex text', `0: <String[40]: #${'\\xabadcd'.repeat(8)}> <String[1]: #x>\n`, ['\\xabadcd'.repeat(8), 'x']],
  ['quoted and unquoted tags', '0: <String[3]: #a>b> <String[1]: "x"> <String[1]: #>>\n', ['a>b', '"x"', '>']],
  ['wide quoted string', '0: <String[2]: uc"中文">\n', ['"中文"']],
  ['e-prefixed quoted string', '0: <String[4]: e"demo">\n', ['"demo"']],
  ['greater-than-prefixed quoted string', '0: <String[4]: >"demo">\n', ['"demo"']],
  ['full-length string', `0: <String[1024]: #${'>'.repeat(1024)}>\n`, ['>'.repeat(1024)]],
  ['truncated string', '0: <String[1025]: #...<truncated>>> <String[1]: #x>\n', ['...<truncated>>', 'x']],
];
const followingInstruction = '0x124 @ 1 : 02 Add a0\n';
const stringFixture = stringCases.map(([, text]) => text + followingInstruction).join('')
  + '0: <String[1]: #>>\n';
const stringFiles = [];
for (const [name, text] of [
  ['lf', stringFixture], ['crlf', stringFixture.replaceAll('\n', '\r\n')], ['eof', stringFixture.trimEnd()],
]) {
  const file = path.join(nativeCache, `strings-${name}.ign`);
  await writeFile(file, text);
  stringFiles.push(file);
}
const opcodeFixture = path.join(nativeCache, 'opcode-regressions.ign');
await writeFile(opcodeFixture, malformedOpcodes.join('') + followingInstruction);
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
const native = spawnSync(cli, ['parse', '--wasm', '--quiet', '--stat', '--config-path', config,
  ...['test.ign', 'test2.ign', 'test3.ign'].map(name => path.join(root, 'examples', 'upstream', name)),
  path.join(root, 'examples', 'features.ign'),
  ...nulFiles,
  opcodeFixture,
  ...stringFiles,
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
  tree.delete();
}

const features = await readFile(path.join(root, 'examples', 'features.ign'), 'utf8');
for (const text of [features, features.replaceAll('\n', '\r\n'), features.trimEnd()]) {
  const tree = parse(text, 'features (LF / CRLF / final line)');
  tree.delete();
}

// Keep semantic expectations in small fixtures so examples can grow freely.
const highlightTree = parse('0 S> 0x123 @ 0 : 01 Ldar r1\n1 E> 0x124 @ 1 : 02 Add a0, [-3.5]\n', 'operand and position highlights');
const highlightCaptures = queries.highlights.captures(highlightTree.rootNode);
for (const [name, text] of [['keyword', 'S>'], ['keyword', 'E>'], ['constant', 'r1'], ['constant', 'a0'], ['number', '-3.5']]) {
  assert(highlightCaptures.some(c => c.name === name && c.node.text === text), `${text}: missing ${name} highlight`);
}
assert(queries.brackets.matches(highlightTree.rootNode).some(({ captures }) =>
  captures.some(c => c.name === 'open' && c.node.text === '[')
  && captures.some(c => c.name === 'close' && c.node.text === ']')),
  'operand brackets must form a matching pair');
highlightTree.delete();

const sourceBlocks = [' const first = 1;\n', ' const second = 2;\n'];
const sourceFixture = sourceBlocks.map((text, index) => ` - source code:${text} - script: 0x${index + 1} <Script>\n`).join('');
for (const text of [sourceFixture, sourceFixture.replaceAll('\n', '\r\n'), sourceFixture.trimEnd()]) {
  const tree = parse(text, 'separate JavaScript injections');
  assert.deepEqual(queries.injections.captures(tree.rootNode)
    .filter(c => c.name === 'injection.content').map(c => c.node.text.replaceAll('\r\n', '\n')),
    sourceBlocks, 'each source block must be injected separately without its script footer');
  tree.delete();
}

for (const [name, text, type, value] of nulCases) {
  for (const input of [text, text.replaceAll('\n', '\r\n'), text.trimEnd()]) {
    const tree = parse(input, `NUL in ${name}`);
    if (type) {
      assert(nodes(tree.rootNode, type).some(node => value === null ? node.text.includes('\0') : node.text === value),
        `${name}: NUL must remain in the expected token`);
    } else {
      // Preserve metadata and operand text, including NUL and Unicode, while
      // allowing tokens to split or combine without prescribing their type.
      for (const match of input.matchAll(/\S/gu)) {
        const token = tree.rootNode.descendantForIndex(match.index, match.index + match[0].length);
        assert(token && token.childCount === 0 && token.text.includes(match[0]),
          `${name}: ${JSON.stringify(match[0])} must remain in a token`);
      }
    }
    assert.equal(nodes(tree.rootNode, 'javascript_source').length, type === 'javascript_source' ? 1 : 0,
      `${name}: only embedded source may produce a JavaScript injection`);
    tree.delete();
  }
}

for (const text of malformedOpcodes) {
  const tree = parse(text + followingInstruction, 'numeric opcode recovery');
  assert.deepEqual(nodes(tree.rootNode, 'opcode').map(node => node.text), ['Add'],
    'numeric values must not become opcodes or consume the following instruction');
  tree.delete();
}

for (const [name, text, values] of stringCases) {
  for (const input of [text + followingInstruction, (text + followingInstruction).replaceAll('\n', '\r\n'), text.trimEnd()]) {
    const tree = parse(input, `string boundary: ${name}`);
    const tags = nodes(tree.rootNode, 'string_tag');
    assert.deepEqual(tags.map(tag => nodes(tag, 'string_value')[0]?.text ?? null), values,
      `${name}: preserve the full value without the tag's closing delimiter`);
    const captures = queries.highlights.captures(tree.rootNode);
    for (const value of nodes(tree.rootNode, 'string_value')) {
      assert(captures.some(c => c.name === 'string' && c.node.id === value.id), `${name}: complete string missing highlight`);
    }
    tree.delete();
  }
}

// Count lexer work rather than elapsed time to detect quadratic scanning.
// Allow subquadratic growth without binding the test to exact event counts.
// Recheck this proxy if a Tree-sitter upgrade changes lexer logging.
const metadataSizes = [100, 400];
const lexicalSteps = [];
for (const count of metadataSizes) {
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
const inputGrowth = metadataSizes[1] / metadataSizes[0];
// For four times the input, linear work grows 4x and quadratic work 16x.
// The midpoint exponent leaves room for runtime overhead while rejecting 16x.
assert(lexicalSteps[0] > 0 && lexicalSteps[1] < lexicalSteps[0] * inputGrowth ** 1.5,
  `metadata lexer work must stay below quadratic growth: ${lexicalSteps.join(' -> ')}`);
console.log(`Metadata lexer work: ${lexicalSteps.join(' -> ')} steps.`);

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

// The external scanner retains the declared length and encoding between tokens.
// Editing either must invalidate the value just as a fresh parse would.
for (const [before, oldText, newText] of [
  ['0: <String[3]: #a>b> <String[1]: #x>\n', '3', '2'],
  ['0: <String[3]: #a>b> <String[1]: #x>\n', 'a>b', 'a>>'],
  ['0: <String[3]: #a>b> <String[1]: #x>\n', 'a>b', 'ab'],
  ['0: <String[3]: #a>b> <String[1]: #x>\n', 'a>b', 'a>>b'],
  ['0: <String[3]: #a>b> <String[1]: #x>\n', '#a>b', '"a>b"'],
  ['0: <String[3]: "a>b"> <String[1]: #x>\n', '"a>b"', '#a>b'],
  ['0: <String[3]: #\\xabad> <String[1]: #x>\n', '#', 'u#'],
  ['0: <String[3]: u#\\xabad> <String[1]: #x>\n', 'u#', '#'],
  ['0: <String[5]: u#😀>💡> <String[1]: #x>\n', '😀', '中'],
  ['0: <String[1]: #>> <String[1]: #x>\n', '1', '0'],
  ['0: <String[1025]: #...<truncated>>> <String[1]: #x>\n', '1025', '1024'],
]) {
  for (const input of [before, before.replaceAll('\n', '\r\n')]) {
    const text = input + followingInstruction;
    const index = text.indexOf(oldText);
    const oldTree = parser.parse(text);
    oldTree.edit({
      startIndex: index, oldEndIndex: index + oldText.length, newEndIndex: index + newText.length,
      startPosition: { row: 0, column: index },
      oldEndPosition: { row: 0, column: index + oldText.length },
      newEndPosition: { row: 0, column: index + newText.length },
    });
    const edited = text.slice(0, index) + newText + text.slice(index + oldText.length);
    const incremental = parser.parse(edited, oldTree);
    const full = parser.parse(edited);
    assert.equal(incremental.rootNode.toString(), full.rootNode.toString(), 'incremental string edit must match a full parse');
    for (const type of ['string_tag', 'string_value', 'instruction', 'opcode', 'ERROR']) {
      const spans = tree => nodes(tree.rootNode, type).map(node => [node.text, node.startIndex, node.endIndex, node.startPosition, node.endPosition]);
      assert.deepEqual(spans(incremental), spans(full), `${type}: edited ranges must match a full parse`);
    }
    assert.deepEqual(nodes(incremental.rootNode, 'opcode').map(node => node.text), ['Add'], 'string edits must preserve the following instruction');
    oldTree.delete(); incremental.delete(); full.delete();
  }
}
console.log('Incremental string length, encoding, delimiter, and Unicode edits match full parses.');
for (const query of Object.values(queries)) query.delete();
parser.delete();
console.log('Parser, highlighting, JavaScript injection, and bracket checks passed.');
