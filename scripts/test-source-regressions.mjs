// SPDX-License-Identifier: GPL-3.0-only
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Parser, Language, Query } from 'web-tree-sitter';

await Parser.init();
const language = await Language.load(fileURLToPath(new URL('../.build/ignition-web.wasm', import.meta.url)));
const parser = new Parser();
parser.setLanguage(language);
const injections = new Query(language, await readFile(new URL('../languages/ignition/injections.scm', import.meta.url), 'utf8'));
const instruction = '0x124 @ 1 : 02 Add a0\n';
const sourceText = ' const value = 1;\n';
const sourceHeader = ' - source code:';
const scriptFooter = ' - script: 0x456 <Script>';
const nodes = (tree, type) => tree.rootNode.descendantsOfType(type);
const injected = tree => injections.captures(tree.rootNode).map(capture => capture.node.text.replaceAll('\r\n', '\n'));
const variants = text => [text, text.replaceAll('\n', '\r\n'), text.trimEnd()];

function checked(text) {
  const tree = parser.parse(text);
  assert(tree && !tree.rootNode.hasError, tree?.rootNode.toString());
  return tree;
}

// JSObjectPrintBody writes no value when raw_properties_or_hash is a Smi,
// otherwise it writes an address and Brief's object tag. Do not depend on a
// particular storage implementation or address formatting on the host OS.
const propertiesFooters = [
  ' - properties: ',
  ' - properties: 0x123 <FixedArray[0]>',
  ' - properties: 000001ABCDEF <FixedArray[0]>',
  ' - properties: 0x123 <PropertyArray[3]>',
  ' - properties: 0x123 <NameDictionary[101]>',
  ' - properties: 0x123 <Other heap object (SWISS_NAME_DICTIONARY_TYPE)>',
];
for (const footer of [...propertiesFooters, scriptFooter, ' - script: 000001ABCDEF <Script>']) {
  const body = sourceHeader + sourceText + footer + '\n';
  for (const input of variants(body + instruction)) {
    const tree = checked(input);
    assert.deepEqual(injected(tree), [sourceText]);
    assert.deepEqual(nodes(tree, 'opcode').map(node => node.text), ['Add']);
    assert.equal(nodes(tree, 'property')[0].startIndex, input.indexOf(footer) + 1);
    tree.delete();
  }
  for (const input of [body, body.replaceAll('\n', '\r\n'), body.slice(0, -1)]) {
    const tree = checked(input);
    assert.deepEqual(injected(tree), [sourceText], 'footer must also end an injection at EOF');
    tree.delete();
  }
}

const mixed = propertiesFooters.map((footer, index) =>
  `${sourceHeader} const value${index} = ${index};\n${footer}\n - All own properties (excluding elements): {}\n${instruction}`,
).join('') + `${sourceHeader} const last = 1;\n${scriptFooter}\n${instruction}`;
for (const input of variants(mixed)) {
  const tree = checked(input);
  assert.equal(injected(tree).length, propertiesFooters.length + 1);
  assert.equal(nodes(tree, 'instruction').length, propertiesFooters.length + 1);
  assert(injected(tree).every(text => !text.includes('properties:') && !text.includes('script:')));
  tree.delete();
}

// Near matches in a template literal are source text. This also verifies that
// a failed same-line probe leaves the next line's genuine footer discoverable.
const nearFooters = [
  ' - properties: missing storage',
  ' - properties: 0x123',
  ' - properties: <FixedArray[0]>',
  ' - properties: 0x123 <>',
  ' - properties: 0x123 <FixedArray[0]',
  ' - properties: 0x123 <FixedArray[0]> trailing text',
  ' - properties: 0x123 <FixedArray[0]>>',
  ' - properties: 0x123 <Fixed<Array[0]>>',
  ' - properties : 0x123 <FixedArray[0]>',
  ' - property: 0x123 <FixedArray[0]>',
  '  - properties: 0x123 <FixedArray[0]>',
  ' - script: 0x123 <not-a-script>',
  ' - script: 0x123 <Script> trailing text',
];
for (const nearFooter of nearFooters) {
  for (const source of [` const text = \`\n${nearFooter}\n\`;\n`, ` const text = 1;\n${nearFooter}\n`]) {
    for (const input of variants(sourceHeader + source + scriptFooter + '\n' + instruction)) {
      const tree = checked(input);
      assert.deepEqual(injected(tree), [source]);
      assert.deepEqual(nodes(tree, 'opcode').map(node => node.text), ['Add']);
      tree.delete();
    }
  }
}

function point(text, index) {
  const prefix = text.slice(0, index);
  const newline = prefix.lastIndexOf('\n');
  return { row: prefix.split('\n').length - 1, column: index - newline - 1 };
}

for (const [oldText, newText] of [
  ['value = 1', 'value = 42'],
  ['value = 1', 'value = "😀"'],
  ['0x123', '000001ABCDEF'],
  ['FixedArray[0]', 'PropertyArray[3]'],
  ['0x123 <FixedArray[0]>', ''],
  ['properties:', 'property:'],
  ['<FixedArray[0]>', '<FixedArray[0]> trailing'],
]) {
  for (const before of variants(sourceHeader + sourceText + propertiesFooters[1] + '\n' + instruction)) {
    const index = before.indexOf(oldText);
    assert(index >= 0);
    const after = before.slice(0, index) + newText + before.slice(index + oldText.length);
    for (const [input, output, oldLength, newLength] of [
      [before, after, oldText.length, newText.length],
      [after, before, newText.length, oldText.length],
    ]) {
      const oldTree = checked(input);
      oldTree.edit({
        startIndex: index, oldEndIndex: index + oldLength, newEndIndex: index + newLength,
        startPosition: point(input, index), oldEndPosition: point(input, index + oldLength),
        newEndPosition: point(output, index + newLength),
      });
      const incremental = parser.parse(output, oldTree);
      const full = checked(output);
      assert(incremental && !incremental.rootNode.hasError);
      assert.equal(incremental.rootNode.toString(), full.rootNode.toString());
      for (const type of ['source_code', 'javascript_source', 'property', 'instruction', 'opcode', 'ERROR']) {
        const spans = tree => nodes(tree, type).map(node => [node.text, node.startIndex, node.endIndex, node.startPosition, node.endPosition]);
        assert.deepEqual(spans(incremental), spans(full), `${type}: incremental source/footer edits must match a full parse`);
      }
      assert.deepEqual(injected(incremental), injected(full));
      oldTree.delete(); incremental.delete(); full.delete();
    }
  }
}

// Exercise the actual V8 printer rather than relying only on modeled dump
// snippets. The filter prints a function after all DebugPrint output, so an
// unclosed source injection would hide its bytecode instructions.
const debugSource = `
function plain() { return 1; }
function fast() { return 2; }
fast.extra = 1;
function dictionary() { return 3; }
for (let i = 0; i < 100; i++) dictionary['property' + i] = i;
function hashed() { return 4; }
const hashes = new Map([[hashed, 1]]);
%DebugPrint(plain);
%DebugPrint(fast);
%DebugPrint(dictionary);
%DebugPrint(hashed);
function afterDump() { return hashes.size; }
afterDump();
`;
const real = spawnSync(process.execPath, [
  '--allow-natives-syntax', '--print-bytecode', '--print-bytecode-filter=afterDump', '--eval', debugSource,
], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
if (real.error) throw real.error;
assert.equal(real.status, 0, `Node V8 diagnostic fixture failed: ${real.stderr}`);
const realDump = real.stdout + real.stderr;
const realSources = [...realDump.matchAll(/^ - source code:([^\r\n]*)\r?\n - properties: ([^\r\n]*)/gm)];
assert.equal(realSources.length, 4, 'each JSFunction dump must contain its real properties footer');
const realInstructions = realDump.match(/^\s*(?:\d+\s+(?:[SE]>\s+)?)?(?:0x)?[0-9a-fA-F]+\s+@\s*\d+\s*:\s*(?:[0-9a-fA-F]{2}\s+)+[A-Za-z][^\r\n]*/gm) || [];
assert(realInstructions.length > 0, 'the real fixture must print following bytecode');
const realTree = checked(realDump);
assert.deepEqual(injected(realTree), realSources.map(match => match[1] + '\n'));
assert.deepEqual(nodes(realTree, 'instruction').map(node => node.text.trim()), realInstructions.map(text => text.trim()));
realTree.delete();

injections.delete(); parser.delete();
console.log(`Source footer, strict near-match, incremental range, and real V8 JSFunction regressions passed (${realInstructions.length} real instructions).`);
