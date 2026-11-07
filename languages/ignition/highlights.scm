(source_position) @number
(position_marker) @keyword
(address) @number
(bytecode_offset) @number
(hex_dump) @number
(opcode) @type
(property_name) @property
(object_type) @type
(string_type) @type
(string_length) @number
(string_value) @string

; Metadata, constant pools, and operand lists use the same tolerant atoms.
((atom) @number
  (#match? @number "^-?(0x[0-9a-fA-F]+|[0-9]+(\\.[0-9]+)?|[0-9][0-9A-Fa-f]{7,})$"))
((atom) @constant
  (#match? @constant "^[ar][0-9]+$"))
(quoted_string) @string
(comment) @comment

["[" "]" "(" ")" "<" ">"] @punctuation.bracket
["@" ":" "," "#"] @punctuation.delimiter
