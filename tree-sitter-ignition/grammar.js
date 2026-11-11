// SPDX-License-Identifier: GPL-3.0-only
// A disassembly is a log, so unknown metadata stays readable and parseable.
const identifier = /[A-Za-z_$][A-Za-z0-9_.$]*/;
module.exports = grammar({
  name: 'ignition',
  extras: $ => [/[ \t\r]/],
  externals: $ => [
    $.javascript_source, $._end_of_file, $._string_length, $._unquoted_string,
    $._empty_string, $._instruction_address, $._instruction_position,
    $._property_start, $._source_start, $._object_open, $._object_close, $._newline,
    $._string_close, $._implicit_object_close, $._bracket_close, $._paren_close,
  ],
  rules: {
    source_file: $ => repeat(choice(
      $.source_code, $.instruction, $.property, $.metadata_line, $._newline,
    )),

    // The scanner distinguishes complete instruction prefixes from metadata
    // before choosing a token, so ordinary lines do not fork GLR stacks.
    instruction: $ => seq(
      choice(
        alias($._instruction_address, $.address),
        seq(alias($._instruction_position, $.source_position),
          optional($.position_marker), alias($.atom, $.address)),
      ),
      '@', alias($.atom, $.bytecode_offset), ':', $.hex_dump, $.opcode,
      repeat($._line_value), $._line_end,
    ),
    position_marker: _ => /[SE]>/,
    // Include the space after each byte so Add is not consumed as byte Ad.
    hex_dump: _ => token(prec(2, /(?:[a-fA-F0-9]{2}[ \t]+)+/)),
    opcode: _ => token(/[A-Za-z][A-Za-z0-9_.]*/),

    source_code: $ => seq(alias($._source_start, '-'),
      alias('source code', $.property_name), ':', optional($.javascript_source)),
    property: $ => seq(alias($._property_start, '-'), $.property_name,
      optional(choice(seq(':', repeat($._line_value)), $.comment)), $._line_end),
    property_name: _ => token(/[A-Za-z_][A-Za-z0-9_ ()\[\]-]*/),
    metadata_line: $ => seq(repeat1($._line_value), $._line_end),

    _line_value: $ => choice($._value, '>', ']', ')'),
    // Closing delimiters are not values within a group. Optional group endings
    // keep unfinished diagnostics parseable without consuming sibling groups.
    _value: $ => choice(
      $.string_tag, $.object_tag, $.bracketed_value, $.parenthesized_value,
      $.quoted_string, $.comment, $.atom, $._punctuation, $.other,
    ),
    bracketed_value: $ => prec.right(seq('[', repeat($._value), optional(alias($._bracket_close, ']')))),
    parenthesized_value: $ => prec.right(seq('(', repeat($._value), optional(alias($._paren_close, ')')))),
    object_tag: $ => prec.right(seq(alias($._object_open, '<'),
      $.object_type, repeat($._value),
      // The scanner must observe implicit endings to restore the outer depth.
      choice(alias($._object_close, '>'), $._implicit_object_close))),
    object_type: _ => token(identifier),

    string_tag: $ => prec.right(seq('<', alias('String', $.string_type),
      '[', alias($._string_length, $.string_length), ']', ':', optional('u'),
      choice(
        seq('#', choice(alias($._unquoted_string, $.string_value), $._empty_string)),
        seq(optional(choice('c', 'e', '>')), alias($.quoted_string, $.string_value)),
      ), optional(alias($._string_close, '>')),
    )),
    // Consume unfinished quotes through the physical line end. Retrying at
    // each escaped quote would repeatedly scan the same remaining suffix.
    quoted_string: _ => token(choice(
      seq('"', repeat(choice('\0', /[^"\\\r\n]+/,
        seq('\\', choice(prec(1, '\0'), /[^\r\n]/)))), optional(choice('"', '\\'))),
      seq("'", repeat(choice('\0', /[^'\\\r\n]+/,
        seq('\\', choice(prec(1, '\0'), /[^\r\n]/)))), optional(choice("'", '\\'))),
    )),
    comment: _ => token(choice(
      seq('//', repeat(choice('\0', /[^\r\n]+/))),
      // Keep an unfinished block comment as one token through EOF. Requiring
      // its closing marker would retry every later /* over the same suffix.
      seq('/*', repeat(choice('\0', /[^*\x00]+/,
        seq(/\*+/, choice(prec(1, '\0'), /[^*/\x00]/)))),
        optional(choice(/\*+\//, /\*+/))),
    )),
    atom: _ => token(choice(
      identifier,
      /-?(?:0x[0-9a-fA-F]+|[0-9]+(?:\.[0-9]+)?[eE][+-]?[0-9]+|[0-9][0-9a-fA-F]*(?:\.[0-9]+)?)/,
    )),
    _punctuation: _ => choice('@', ':', ',', '#', '-', '=', '*', '/', ';',
      '{', '}', '<'),
    other: _ => token(prec(-10, repeat1(choice(
      '\0', /[^\sA-Za-z0-9_$@:,#=\-*/;{}<>\[\]()"']+/,
    )))),
    _line_end: $ => choice($._newline, $._end_of_file),
  },
});
