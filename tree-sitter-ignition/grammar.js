// SPDX-License-Identifier: GPL-3.0-only
// A disassembly is a log, so unknown metadata stays readable and parseable.
module.exports = grammar({
  name: 'ignition',
  extras: $ => [/[ \t\r]/],
  externals: $ => [$.javascript_source, $._end_of_file, $._string_length, $._unquoted_string],
  conflicts: $ => [
    [$.instruction, $._value],
    [$.bracketed_value, $._punctuation],
    [$.parenthesized_value, $._punctuation],
    [$.object_tag, $._punctuation],
  ],
  rules: {
    source_file: $ => repeat(choice(
      $.source_code,
      $.instruction,
      $.property,
      $.metadata_line,
      $._newline,
    )),

    instruction: $ => prec.dynamic(5, seq(
      optional(seq(
        alias($.atom, $.source_position),
        optional($.position_marker),
      )),
      alias($.atom, $.address),
      '@',
      alias($.atom, $.bytecode_offset),
      ':',
      $.hex_dump,
      $.opcode,
      repeat($._value),
      $._line_end,
    )),
    position_marker: _ => /[SE]>/,
    // Include the space after each byte: an opcode such as Add must not be
    // consumed as a final hexadecimal byte (Ad).
    hex_dump: _ => token(prec(2, /(?:[a-fA-F0-9]{2}[ \t]+)+/)),
    opcode: _ => token(/[A-Za-z][A-Za-z0-9_.]*/),

    source_code: $ => seq('- source code:', optional($.javascript_source)),
    property: $ => prec.dynamic(3, seq(
      '-',
      $.property_name,
      optional(seq(':', repeat($._value))),
      $._line_end,
    )),
    property_name: _ => token(/[A-Za-z_][A-Za-z0-9_ () ]*/),

    metadata_line: $ => prec.dynamic(-1, seq(
      repeat1($._value),
      $._line_end,
    )),
    _value: $ => choice(
      $.string_tag,
      $.object_tag,
      $.bracketed_value,
      $.parenthesized_value,
      $.quoted_string,
      $.comment,
      $.atom,
      $._punctuation,
      $.other,
    ),
    bracketed_value: $ => seq('[', repeat($._value), ']'),
    parenthesized_value: $ => seq('(', repeat($._value), ')'),

    string_tag: $ => seq(
      '<',
      alias('String', $.string_type),
      '[', alias($._string_length, $.string_length), ']', ':',
      optional('u'),
      choice(
        seq('#', optional(alias($._unquoted_string, $.string_value))),
        seq(optional(choice('c', 'e', '>')), alias($.quoted_string, $.string_value)),
      ),
      '>',
    ),
    object_tag: $ => seq(
      '<', alias($.atom, $.object_type), repeat($._value), '>',
    ),
    // Keep NUL separate from chunks so the lexer does not merge it into a
    // negated character class that excludes NUL.
    quoted_string: _ => token(choice(
      seq('"', repeat(choice(
        '\0', /[^"\\\r\n]+/,
        // Preserve a distinct NUL transition after a backslash as well.
        seq('\\', choice(prec(1, '\0'), /[^\r\n]/)),
      )), '"'),
      seq("'", repeat(choice(
        '\0', /[^'\\\r\n]+/,
        seq('\\', choice(prec(1, '\0'), /[^\r\n]/)),
      )), "'"),
    )),
    comment: _ => token(seq('//', repeat(choice('\0', /[^\r\n]+/)))),
    atom: _ => token(choice(
      /[A-Za-z_$][A-Za-z0-9_.$]*/,
      /-?(?:0x[0-9a-fA-F]+|[0-9][0-9a-fA-F]*(?:\.[0-9]+)?)/,
    )),
    _punctuation: _ => choice('@', ':', ',', '#', '-', '=', '*', '/', ';', '{', '}', '<', '>', '[', ']', '(', ')'),
    other: _ => token(prec(-10, repeat1(choice(
      '\0', /[^\sA-Za-z0-9_$@:,#=\-*/;{}<>\[\]()"']+/,
    )))),
    _newline: _ => '\n',
    _line_end: $ => choice($._newline, $._end_of_file),
  },
});
