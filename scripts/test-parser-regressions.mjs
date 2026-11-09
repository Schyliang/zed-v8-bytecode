// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Parser, Language, Query } from 'web-tree-sitter';

await Parser.init();
const language = await Language.load(fileURLToPath(new URL('../.build/ignition-web.wasm', import.meta.url)));
const parser = new Parser();
parser.setLanguage(language);
const highlights = new Query(language, await readFile(new URL('../languages/ignition/highlights.scm', import.meta.url), 'utf8'));
const brackets = new Query(language, await readFile(new URL('../languages/ignition/brackets.scm', import.meta.url), 'utf8'));
const instruction = '0x124 @ 1 : 02 Add a0\n';
const descendants = (tree, type) => tree.rootNode.descendantsOfType(type);
const texts = (tree, type) => descendants(tree, type).map(node => node.text);
const variants = text => [text, text.replaceAll('\n', '\r\n'), text.trimEnd()];

function checked(text) {
  const tree = parser.parse(text);
  assert(tree && !tree.rootNode.hasError, tree?.rootNode.toString());
  return tree;
}

for (const input of variants('0x123 @ 0 : 2d 06 00 00 GetNamedProperty a3, [0], [1], [2]\n')) {
  const tree = checked(input);
  assert.deepEqual(texts(tree, 'bracketed_value'), ['[0]', '[1]', '[2]']);
  assert.equal(brackets.matches(tree.rootNode).length, 3, 'each operand has exactly one bracket pair');
  tree.delete();
}
for (const input of variants('0: <Foo> <Bar> (a) (b)\n')) {
  const tree = checked(input);
  assert.deepEqual(texts(tree, 'object_type'), ['Foo', 'Bar']);
  assert.deepEqual(texts(tree, 'parenthesized_value'), ['(a)', '(b)']);
  const captures = highlights.captures(tree.rootNode);
  for (const type of ['Foo', 'Bar']) assert(captures.some(c => c.name === 'type' && c.node.text === type));
  assert.equal(brackets.matches(tree.rootNode).length, 4);
  tree.delete();
}
for (const input of variants('0: 0x1 <A c, 0x2 <B[3]>>\n')) {
  const tree = checked(input);
  assert.deepEqual(texts(tree, 'object_type'), ['A', 'B']);
  assert.equal(descendants(tree, 'object_tag').length, 2);
  tree.delete();
}

// Numeric comparisons and bare '<' are values, rather than object tags.
// Unfinished named tags end at their containing group without contributing a
// phantom outer object to the next wide string's closing-delimiter decision.
const depthWideValue = '\\x4e2d\\x6587>';
for (const [group, groupType, objectTypes, numbers] of [
  ['[1<2]', 'bracketed_value', [], ['1', '2']],
  ['[1 < 2]', 'bracketed_value', [], ['1', '2']],
  ['[1 < -2]', 'bracketed_value', [], ['1', '-2']],
  ['[1 < 0x2]', 'bracketed_value', [], ['1', '0x2']],
  ['[1 < 2.5]', 'bracketed_value', [], ['1', '2.5']],
  ['[1 < 2e-10]', 'bracketed_value', [], ['1', '2e-10']],
  ['[1 << 2]', 'bracketed_value', [], ['1', '2']],
  ['[1 <]', 'bracketed_value', [], ['1']],
  ['[1 < Foo]', 'bracketed_value', ['Foo'], ['1']],
  ['(1 < Foo)', 'parenthesized_value', ['Foo'], ['1']],
  ['[1 < Foo < Bar]', 'bracketed_value', ['Foo', 'Bar'], ['1']],
  ['(1 < Foo < Bar)', 'parenthesized_value', ['Foo', 'Bar'], ['1']],
  ['[1 < $Foo]', 'bracketed_value', ['$Foo'], ['1']],
  ['[1 < _Foo]', 'bracketed_value', ['_Foo'], ['1']],
]) {
  for (const outer of ['Map', 'Outer <Map']) {
    const closes = outer === 'Map' ? '>>>' : '>>>>';
    const line = '0: <' + outer + ' ' + group + ' <String[3]: u#\\x4e2d\\x6587' + closes + '\n';
    for (const input of variants(line)) {
      const tree = checked(input);
      const parentTypes = outer === 'Map' ? ['Map'] : ['Outer', 'Map'];
      assert.deepEqual(texts(tree, 'object_type'), [...parentTypes, ...objectTypes], group);
      assert.deepEqual(texts(tree, 'string_value'), [depthWideValue], group);
      assert.deepEqual(texts(tree, groupType), [group], group + ': group closes before the string');
      const captures = highlights.captures(tree.rootNode);
      for (const number of numbers) {
        assert(captures.some(c => c.name === 'number' && c.node.text === number), group + ': number highlight');
        assert(!captures.some(c => c.name === 'type' && c.node.text === number), group + ': number must not become a type');
      }
      for (const tag of descendants(tree, 'object_tag')) {
        const type = tag.descendantsOfType('object_type')[0]?.text;
        assert.equal(tag.children.filter(n => n.type === '>').length, parentTypes.includes(type) ? 1 : 0,
          group + ': implicit endings must not fabricate closing bracket captures');
      }
      assert.equal(brackets.matches(tree.rootNode).length, parentTypes.length + 2,
        group + ': only physical object, group, and string delimiters match');
      tree.delete();
    }
  }
}
for (const type of ['$Foo', '_Foo']) {
  const tree = checked('0: <' + type + '>\n');
  assert.deepEqual(texts(tree, 'object_type'), [type]);
  assert.equal(brackets.matches(tree.rootNode).length, 1);
  tree.delete();
}
for (const text of ['<\n', '<<\n', '< 2\n', '< -2\n', '< 0x2\n']) {
  for (const input of [...variants(text), ...variants(text + instruction)]) {
    const tree = checked(input);
    assert.deepEqual(texts(tree, 'object_type'), []);
    assert.deepEqual(texts(tree, 'opcode'), input.includes(instruction.trimEnd()) ? ['Add'] : []);
    tree.delete();
  }
}
for (const [line, types, pairs] of [
  ['<Foo\n', ['Foo'], 0],
  ['<Foo <Bar\n', ['Foo', 'Bar'], 0],
  ['<Map [1 < Foo]\n', ['Map', 'Foo'], 1],
  ['<Map (1 < Foo)\n', ['Map', 'Foo'], 1],
]) {
  for (const input of [...variants(line), ...variants(line + instruction)]) {
    const tree = checked(input);
    assert.deepEqual(texts(tree, 'object_type'), types);
    assert.equal(brackets.matches(tree.rootNode).length, pairs, 'unfinished tags have no synthetic bracket pair');
    assert.deepEqual(texts(tree, 'opcode'), input.includes(instruction.trimEnd()) ? ['Add'] : []);
    for (const tag of descendants(tree, 'object_tag')) {
      assert.equal(tag.children.filter(node => node.type === '>').length, 0);
    }
    tree.delete();
  }
}
for (const [group, bracketText, parenthesisText] of [
  ['[1 < Foo (2 < Bar)]', '[1 < Foo (2 < Bar)]', '(2 < Bar)'],
  ['(1 < Foo [2 < Bar])', '[2 < Bar]', '(1 < Foo [2 < Bar])'],
]) {
  for (const input of variants('0: <Map ' + group + ' <String[3]: u#\\x4e2d\\x6587>>>\n')) {
    const tree = checked(input);
    assert.deepEqual(texts(tree, 'object_type'), ['Map', 'Foo', 'Bar']);
    assert.deepEqual(texts(tree, 'bracketed_value'), [bracketText]);
    assert.deepEqual(texts(tree, 'parenthesized_value'), [parenthesisText]);
    assert.deepEqual(texts(tree, 'string_value'), [depthWideValue]);
    assert.equal(brackets.matches(tree.rootNode).length, 4, 'mixed groups close their unfinished tags independently');
    tree.delete();
  }
}
for (const [open, close, groupType] of [['[', ']', 'bracketed_value'], ['(', ')', 'parenthesized_value']]) {
  const count = 128;
  const group = open + '<Foo '.repeat(count) + close;
  for (const input of variants('0: <Map ' + group + ' <String[3]: u#\\x4e2d\\x6587>>>\n')) {
    const tree = checked(input);
    assert.equal(texts(tree, 'object_type').filter(type => type === 'Foo').length, count);
    assert.deepEqual(texts(tree, groupType), [group]);
    assert.deepEqual(texts(tree, 'string_value'), [depthWideValue]);
    assert.equal(brackets.matches(tree.rootNode).length, 3);
    tree.delete();
  }
}
for (const [open, close, type] of [['[', ']', 'bracketed_value'], ['(', ')', 'parenthesized_value']]) {
  const depth = 128;
  const tree = checked(open.repeat(depth) + close.repeat(depth) + '\n');
  assert.equal(descendants(tree, type).length, depth);
  assert.equal(brackets.matches(tree.rootNode).length, depth);
  tree.delete();
}

const wideValues = [
  ['0: <Map <String[2]: u#\\xabc>>\n', ['\\xabc'], ['Map']],
  ['0: <Outer <Map <String[2]: u#\\xabc>>>\n', ['\\xabc'], ['Outer', 'Map']],
  ['0: <String[3]: u#\\x4e2d\\x6587>>\n', ['\\x4e2d\\x6587>'], []],
  ['0: <Map <String[3]: u#\\x4e2d\\x6587>>>\n', ['\\x4e2d\\x6587>'], ['Map']],
  ['0: <String[3]: u#\\x1000\\xabc>\n', ['\\x1000\\xabc'], []],
  ['0: <String[2]: u#\\x1000\\xabc>\n', ['\\x1000\\xabc'], []],
  ['0: <String[3]: u#\\x4e2d>x>\n', ['\\x4e2d>x'], []],
  ['0: <String[40]: u#' + '\\xabadcd'.repeat(8) + '> <String[1]: #x>\n', ['\\xabadcd'.repeat(8), 'x'], []],
  ['0: <String[41]: u#\\x1000' + '\\xabadcd'.repeat(8) + '> <String[1]: #x>\n', ['\\x1000' + '\\xabadcd'.repeat(8), 'x'], []],
];
const markerPrefix = '...<truncated>>>';
const fullValue = markerPrefix + 'a'.repeat(1025 - markerPrefix.length);
wideValues.push(['0: <String[1025]: #' + fullValue + '>\n', [fullValue], []]);
for (const [input, values, types] of wideValues) {
  for (const variant of variants(input)) {
    const tree = checked(variant);
    assert.deepEqual(texts(tree, 'string_value'), values, input);
    assert.deepEqual(texts(tree, 'object_type'), types, input);
    // A tag contains exactly its own opening and closing delimiters.
    for (const tag of descendants(tree, 'object_tag')) {
      assert.equal(tag.children.filter(n => n.type === '<').length, 1);
      assert.equal(tag.children.filter(n => n.type === '>').length, 1);
    }
    tree.delete();
  }
}

// Custom V8 builds may print complete unquoted strings beyond 1024 units.
// A delimiter or tag-shaped substring in the value is still ordinary content
// when the declared length reaches a later closing delimiter.
const tagLookalike = '> <String[1]: #x> ';
const longValues = [
  ['2000 plain units', 'a'.repeat(2000), 2000, '#', ''],
  ['8192 plain units', 'a'.repeat(8192), 8192, '#', '<Map '],
  ['65536 plain units', 'a'.repeat(65536), 65536, '#', ''],
  ['early printable delimiter', 'a>' + 'b'.repeat(1023), 1025, '#', ''],
  ['many printable delimiters', ('a>>b>').repeat(600), 3000, '#', '<Map '],
  ['wide escapes', ('\\x4e2d\\x6587>').repeat(800), 2400, 'u#', '<Map '],
  ['wide escapes followed by hex text', '\\x1000' + '\\xabadcd'.repeat(600), 3001, 'u#', ''],
  ['Unicode and literal NUL', ('😀中\0>').repeat(500), 2500, 'u#', '<Map '],
  ['value begins with a tag lookalike', tagLookalike + 'a'.repeat(8192 - tagLookalike.length), 8192, '#', ''],
  ['repeated tag lookalikes', tagLookalike.repeat(160), tagLookalike.length * 160, '#', '<Map '],
  ['long marker-prefixed full value', markerPrefix + 'a'.repeat(8192 - markerPrefix.length), 8192, '#', ''],
];
for (const [label, value, length, encoding, outer] of longValues) {
  const ending = outer ? '>>' : '>';
  const tag = '<String[' + length + ']: ' + encoding + value + ending;
  const line = '0: ' + outer + tag + ' <String[1]: #x>\n';
  for (const input of [...variants(line), ...variants(line + instruction)]) {
    const tree = checked(input);
    const values = texts(tree, 'string_value');
    assert.equal(values.length, 2, label + ': preserve the actual adjacent tag');
    assert.equal(values[0].length, value.length, label + ': preserve the complete value');
    assert.equal(values[0], value, label);
    assert.equal(values[1], 'x', label);
    assert.equal(descendants(tree, 'string_tag').length, 2, label + ': value text must not become tags');
    assert.deepEqual(texts(tree, 'object_type'), outer ? ['Map'] : [], label);
    assert.deepEqual(texts(tree, 'opcode'), input.includes(instruction.trimEnd()) ? ['Add'] : [], label);
    tree.delete();
  }
}
// The ordinary truncated representation remains separate from its neighbor.
for (const input of variants('0: <String[1000000]: #...<truncated>>> <String[1]: #x>\n' + instruction)) {
  const tree = checked(input);
  assert.deepEqual(texts(tree, 'string_value'), ['...<truncated>>', 'x']);
  assert.deepEqual(texts(tree, 'opcode'), ['Add']);
  tree.delete();
}

for (const input of [
  '0: 0x123 <String>\n', '0: 0x123 <String[10]>\n',
  '- foo-bar: 1\n', '- foo[0]: 1\n', '- no debug info // comment\n',
  '-x + y\n', "don't\n", 'diagnostic "unfinished\n',
]) {
  for (const variant of variants(input)) checked(variant).delete();
}
for (const input of variants('/* first\0line\n * second */\n' + instruction)) {
  const tree = checked(input);
  assert.equal(descendants(tree, 'comment').length, 1);
  assert(texts(tree, 'comment')[0].includes('\0'));
  assert(highlights.captures(tree.rootNode).some(c => c.name === 'comment'));
  assert.deepEqual(texts(tree, 'opcode'), ['Add']);
  tree.delete();
}
for (const text of ['/* unfinished', '/* unfinished *', '/* unfinished\n' + instruction]) {
  const tree = checked(text);
  assert.deepEqual(texts(tree, 'comment'), [text]);
  assert.equal(descendants(tree, 'instruction').length, 0);
  tree.delete();
}
for (const text of ['/* *\0x */', '/* \0 */', '/* **\0']) {
  const tree = checked(text);
  assert.deepEqual(texts(tree, 'comment'), [text]);
  tree.delete();
}

for (const address of ['0x123', '000001F5D511DB19', 'ABCDEF012345']) {
  const text = '- source code: const x = 1;\n - script: ' + address + ' <Script>\n' + instruction;
  for (const input of variants(text)) {
    const tree = checked(input);
    assert.deepEqual(texts(tree, 'javascript_source').map(s => s.replaceAll('\r\n', '\n')), [' const x = 1;\n']);
    assert.deepEqual(texts(tree, 'opcode'), ['Add']);
    const captures = highlights.captures(tree.rootNode);
    assert(captures.some(c => c.name === 'property' && c.node.text === 'source code'));
    const header = descendants(tree, 'source_code')[0];
    assert(captures.some(c => c.name === 'punctuation.delimiter' && c.node.text === ':' && c.node.startIndex < header.endIndex));
    tree.delete();
  }
}
const numericTree = checked('- value: ABCDEF012345 (ABCDEF012345 @ 12) 1.5e-10 1e-10 -2E+3\n');
const numberCaptures = highlights.captures(numericTree.rootNode).filter(c => c.name === 'number').map(c => c.node.text);
for (const value of ['ABCDEF012345', '1.5e-10', '1e-10', '-2E+3']) assert(numberCaptures.includes(value), value);
assert.equal(numberCaptures.filter(s => s === 'ABCDEF012345').length, 2);
numericTree.delete();
const config = await readFile(new URL('../languages/ignition/config.toml', import.meta.url), 'utf8');
const firstLine = new RegExp(config.match(/first_line_pattern = '([^']+)'/)[1]);
for (const header of ['Start SharedFunctionInfo', 'Start BytecodeArray']) assert(firstLine.test(header));

for (const opcode of ['A', 'Ab', 'Add', 'Ldar']) {
  const tree = checked('0x1 @ 0 : 01 ' + opcode + '\n');
  assert.deepEqual(texts(tree, 'opcode'), [opcode]);
  tree.delete();
}
for (const opcode of ['_Bad', '.Bad', '2', '0x2', '-2', '2.5']) {
  const tree = checked('0x1 @ 0 : 01 ' + opcode + '\n' + instruction);
  assert.deepEqual(texts(tree, 'opcode'), ['Add']);
  tree.delete();
}

// Incomplete tags terminate at the physical line boundary, including tags
// without a value marker. Diagnostic recovery must preserve the next opcode.
for (const prefix of [
  '<String[3]: #', '<String[3]: #ab', '<String[3]: #abc',
  '<String[3]:', '<String[3]: u', '<String[3]: c', '<String[3]: abc',
  '<String[3]: uabc', '<String[3]: "abc', '<String[3]: uc"abc',
  "<String[3]: c'abc", '<String[3]: >"abc',
  '<String[4294967296]: #>', '<String[3]', '<String[',
]) {
  for (const outer of ['', '<A <B ']) {
    const text = '0: ' + outer + prefix + '\n' + instruction;
    // A missing quoted value may retain an error marker, but it cannot absorb
    // the following instruction while the user is still typing the quote.
    const tree = /["']/.test(prefix) ? parser.parse(text) : checked(text);
    assert.deepEqual(texts(tree, 'opcode'), ['Add'], prefix);
    for (const error of descendants(tree, 'ERROR')) {
      assert(error.endIndex <= text.indexOf('\n') + 1, prefix);
    }
    tree.delete();
  }
}

function loggedParse(text, previous) {
  const stats = { lex: 0, reusedInstructions: 0, externalMismatch: 0 };
  parser.setLogger((message, isLex) => {
    if (isLex) stats.lex++;
    else {
      if (message.startsWith('reuse_node') && message.includes('symbol:instruction')) stats.reusedInstructions++;
      if (message.startsWith('reusable_node_has_different_external_scanner_state')) stats.externalMismatch++;
    }
  });
  try { return { tree: parser.parse(text, previous), stats }; }
  finally { parser.setLogger(null); }
}
function position(text, index) {
  const prefix = text.slice(0, index);
  const row = prefix.split('\n').length - 1;
  return { row, column: index - prefix.lastIndexOf('\n') - 1 };
}
function edit(before, oldText, newText) {
  const index = before.indexOf(oldText);
  assert(index >= 0);
  const oldTree = parser.parse(before);
  oldTree.edit({
    startIndex: index, oldEndIndex: index + oldText.length, newEndIndex: index + newText.length,
    startPosition: position(before, index), oldEndPosition: position(before, index + oldText.length),
    newEndPosition: position(before.slice(0, index) + newText, index + newText.length),
  });
  const after = before.slice(0, index) + newText + before.slice(index + oldText.length);
  const incremental = loggedParse(after, oldTree);
  const full = parser.parse(after);
  assert.equal(incremental.tree.rootNode.toString(), full.rootNode.toString());
  for (const type of ['string_tag', 'string_value', 'object_tag', 'object_type', 'instruction', 'opcode', 'ERROR']) {
    const spans = tree => descendants(tree, type).map(n => [n.text, n.startIndex, n.endIndex, n.startPosition, n.endPosition]);
    assert.deepEqual(spans(incremental.tree), spans(full), type);
  }
  assert(!incremental.tree.rootNode.hasError);
  oldTree.delete(); incremental.tree.delete(); full.delete();
  return incremental.stats;
}
const trailingInstructions = instruction.repeat(1000);
for (const [before, oldText, newText] of [
  ['0: <Map [1 < 2] <String[3]: u#\\x4e2d\\x6587>>>\n', '2]', 'Foo]'],
  ['0: <Map [1 < Foo] <String[3]: u#\\x4e2d\\x6587>>>\n', 'Foo]', '2]'],
  ['0: <Map [1 < Foo] <String[3]: u#\\x4e2d\\x6587>>>\n', 'Foo]', 'Foo>]'],
  ['0: <Map [1 < Foo>] <String[3]: u#\\x4e2d\\x6587>>>\n', 'Foo>]', 'Foo]'],
  ['0: <Outer <Map (1 < Foo < Bar) <String[3]: u#\\x4e2d\\x6587>>>>\n', 'Bar)', 'Bar>>)'],
  ['0: <Outer <Map (1 < Foo < Bar>>) <String[3]: u#\\x4e2d\\x6587>>>>\n', 'Bar>>)', 'Bar)'],
]) {
  for (const input of [before, before.replaceAll('\n', '\r\n')]) {
    const stats = edit(input + trailingInstructions, oldText, newText);
    assert(stats.reusedInstructions >= 999, JSON.stringify(stats));
    assert(stats.externalMismatch < 20, JSON.stringify(stats));
  }
}
for (const [before, oldText, newText] of [
  ['0: <String[3]: #>\n', '#', '#abc'],
  ['0: <String[3]: #>\n', '3', '4'],
  ['0: <Map <String[2]: u#\\xabc>>\n', 'Map', 'Outer <Map'],
  ['0: <Map <String[3]: u#\\x4e2d\\x6587>>>\n', '3', '2'],
  ['0: <A <B\n', '<B', '<B>'],
]) {
  const stats = edit(before + trailingInstructions, oldText, newText);
  assert(stats.reusedInstructions >= 999, JSON.stringify(stats));
  assert(stats.externalMismatch < 20, JSON.stringify(stats));
}
const longDelimiterValue = 'a'.repeat(4096) + '>'.repeat(4096);
const longEscapedValue = '\\xabadcd'.repeat(1024);
const longUnicodeValue = '😀'.repeat(1500) + '中\0' + 'a'.repeat(500);
for (const [before, oldText, newText] of [
  ['0: <String[8192]: #' + longDelimiterValue + '>\n', '8192', '8191'],
  ['0: <String[5120]: #' + longEscapedValue + '> <String[1]: #x>\n', '#', 'u#'],
  ['0: <String[5120]: u#' + longEscapedValue + '> <String[1]: #x>\n', 'u#', '#'],
  ['0: <Map <String[' + longUnicodeValue.length + ']: u#' + longUnicodeValue + '>>\n', '中', '文'],
  ['0: <String[8192]: #' + tagLookalike + 'a'.repeat(8192 - tagLookalike.length) + '>\n', '#x> ', '#y> '],
]) {
  for (const input of [before, before.replaceAll('\n', '\r\n')]) {
    const stats = edit(input + trailingInstructions, oldText, newText);
    assert(stats.reusedInstructions >= 999, JSON.stringify(stats));
    assert(stats.externalMismatch < 20, JSON.stringify(stats));
  }
}
// A long failed probe consumes the inspected body instead of returning to a
// tiny early delimiter and rescanning that suffix for every malformed tag.
const malformedLine = '0: ' + '<String[1000000]: #a>x '.repeat(200) + 'TAIL_END\n';
const recovered = checked(malformedLine + trailingInstructions);
const recoveredValues = descendants(recovered, 'string_value');
assert.equal(recoveredValues.length, 1);
assert.equal(recoveredValues[0].text, malformedLine.slice(malformedLine.indexOf('#') + 1, -1));
assert.equal(recoveredValues[0].endPosition.row, 0, 'failed-probe recovery must stop before the next line');
assert.equal(recoveredValues[0].endIndex, malformedLine.length - 1);
assert.equal(descendants(recovered, 'instruction').length, 1000);
recovered.delete();
for (const replacement of ['TAIL_ENXD', 'TAIL_EN']) {
  for (const input of [malformedLine, malformedLine.replaceAll('\n', '\r\n')]) {
    const stats = edit(input + trailingInstructions, 'TAIL_END', replacement);
    assert(stats.reusedInstructions >= 999, JSON.stringify(stats));
    assert(stats.externalMismatch < 20, JSON.stringify(stats));
  }
}
const full = loggedParse('Parameter count 1\n' + trailingInstructions);
full.tree.delete();
const incremental = edit('Parameter count 1\n' + trailingInstructions, '1\n', '2\n');
assert(incremental.lex < full.stats.lex / 100, JSON.stringify({ full: full.stats, incremental }));
assert.equal(incremental.reusedInstructions, 1000);
console.log('Instruction header edits reuse all 1000 following instructions; lex steps:', incremental.lex);

// Check lexer work with malformed short and huge declared lengths, unfinished
// groups, and a repeated closing delimiter run. Timing with a logger is not a
// Zed performance estimate.
for (const [label, make] of [
  ['huge empty strings', n => '<String[1000000]: #> '.repeat(n) + '\n'],
  ['huge short strings', n => '<String[1000000]: #a> '.repeat(n) + '\n'],
  ['huge short fallback with literal suffix', n => '<String[1000000]: #a>x '.repeat(n) + 'z'.repeat(n * 2) + '\n'],
  ['huge wide fallback with literal suffix', n => '<String[1000000]: u#\\xabadcd>x '.repeat(n) + '\n'],
  ['4096 empty strings', n => '<String[4096]: #> '.repeat(n) + '\n'],
  ['1024 empty strings', n => '<String[1024]: #> '.repeat(n) + '\n'],
  ['unfinished brackets', n => '['.repeat(n) + '\n'],
  ['unfinished objects', n => '<Foo '.repeat(n) + '\n'],
  ['numeric comparisons', n => '<Map [1 < 2] <String[3]: u#\\x4e2d\\x6587>>> '.repeat(n) + '\n'],
  ['implicit object endings in brackets', n => '<Map [1 < Foo < Bar] <String[3]: u#\\x4e2d\\x6587>>> '.repeat(n) + '\n'],
  ['implicit object endings in parentheses', n => '<Map (1 < Foo < Bar) <String[3]: u#\\x4e2d\\x6587>>> '.repeat(n) + '\n'],
  ['long closing run', n => '<String[1]: #x' + '>'.repeat(n) + '\n'],
  ['unfinished block comments', n => '/* x '.repeat(n) + '\n'],
]) {
  const counts = [100, 400, 1600];
  const steps = counts.map(count => {
    const { tree, stats } = loggedParse(make(count));
    assert(tree && !tree.rootNode.hasError, label);
    tree.delete();
    return stats.lex;
  });
  for (let i = 1; i < steps.length; i++) {
    assert(steps[i] < steps[i - 1] * 8, label + ': ' + steps.join(' -> '));
  }
  console.log(label + ' lexer work: ' + steps.join(' -> '));
}

for (const [label, make, valueSize] of [
  ['complete long strings', n => '<String[' + n + ']: #' + 'a'.repeat(n) + '>\n', n => n],
  ['complete long wide strings', n => '<String[' + n + ']: u#' + '\\x4e2d'.repeat(n) + '>\n', n => n * 6],
  ['complete long strings with tag lookalikes', n => {
    const value = tagLookalike.repeat(n);
    return '<String[' + value.length + ']: #' + value + '>\n';
  }, n => tagLookalike.length * n],
]) {
  const counts = [2048, 8192, 32768];
  const steps = counts.map(count => {
    const { tree, stats } = loggedParse(make(count));
    assert(tree && !tree.rootNode.hasError, label);
    assert.deepEqual(texts(tree, 'string_value').map(value => value.length), [valueSize(count)], label);
    tree.delete();
    return stats.lex;
  });
  for (let i = 1; i < steps.length; i++) {
    assert(steps[i] < steps[i - 1] * 8, label + ': ' + steps.join(' -> '));
  }
  console.log(label + ' lexer work: ' + steps.join(' -> '));
}

brackets.delete(); highlights.delete(); parser.delete();
console.log('Parser structure, tolerant editing, number highlights, and incremental performance regressions passed.');
