// SPDX-License-Identifier: GPL-3.0-only
#include "tree_sitter/parser.h"
#include <stdint.h>
#include <stdlib.h>

enum TokenType {
  JAVASCRIPT_SOURCE, END_OF_FILE, STRING_LENGTH, UNQUOTED_STRING, EMPTY_STRING,
  INSTRUCTION_ADDRESS, INSTRUCTION_POSITION, PROPERTY_START, SOURCE_START,
  OBJECT_OPEN, OBJECT_CLOSE, NEWLINE, STRING_CLOSE,
  IMPLICIT_OBJECT_CLOSE, BRACKET_CLOSE, PAREN_CLOSE,
};
typedef struct {
  uint32_t object_depth;
  uint32_t value_chars;
  bool pending_value;
  bool pending_close;
} Scanner;

// This threshold identifies V8's short-print marker, not a limit on full
// strings from custom builds. Failed scans may only discard bounded lookahead.
enum { V8_SHORT_PRINT_LIMIT = 1024, RECOVERY_LOOKAHEAD = 64 };

void *tree_sitter_ignition_external_scanner_create(void) { return calloc(1, sizeof(Scanner)); }
void tree_sitter_ignition_external_scanner_destroy(void *payload) { free(payload); }
unsigned tree_sitter_ignition_external_scanner_serialize(void *payload, char *buffer) {
  Scanner *s = payload;
  if (!s || (!s->object_depth && !s->pending_value && !s->pending_close)) return 0;
  for (unsigned i = 0; i < 4; i++) {
    buffer[i] = (char)(s->object_depth >> (8 * i));
    buffer[4 + i] = (char)(s->value_chars >> (8 * i));
  }
  buffer[8] = s->pending_value;
  buffer[9] = s->pending_close;
  return 10;
}
void tree_sitter_ignition_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  Scanner *s = payload;
  if (!s) return;
  s->object_depth = 0; s->value_chars = 0; s->pending_value = false;
  s->pending_close = false;
  if (length == 10) {
    for (unsigned i = 0; i < 4; i++) {
      s->object_depth |= (uint32_t)(unsigned char)buffer[i] << (8 * i);
      s->value_chars |= (uint32_t)(unsigned char)buffer[4 + i] << (8 * i);
    }
    s->pending_value = buffer[8];
    s->pending_close = buffer[9];
  }
}

static bool is_hex(int32_t c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
static bool is_alpha(int32_t c) { return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z'); }
static bool inline_space(int32_t c) { return c == ' ' || c == '\t' || c == '\r'; }
static void skip_inline_space(TSLexer *lexer, bool skip) {
  while (inline_space(lexer->lookahead)) lexer->advance(lexer, skip);
}
static bool at_line_end(TSLexer *lexer) { return lexer->eof(lexer) || lexer->lookahead == '\n' || lexer->lookahead == '\r'; }
static bool literal(TSLexer *lexer, const char *text) {
  for (unsigned i = 0; text[i]; i++) {
    if (lexer->lookahead != text[i]) return false;
    lexer->advance(lexer, false);
  }
  return true;
}
static bool scan_hex_number(TSLexer *lexer) {
  if (!is_hex(lexer->lookahead)) return false;
  if (lexer->lookahead == '0') {
    lexer->advance(lexer, false);
    if (lexer->lookahead == 'x') {
      lexer->advance(lexer, false);
      if (!is_hex(lexer->lookahead)) return false;
    }
  }
  while (is_hex(lexer->lookahead)) lexer->advance(lexer, false);
  return true;
}

static bool scan_instruction_start(TSLexer *lexer, const bool *valid_symbols) {
  skip_inline_space(lexer, true);
  if (!scan_hex_number(lexer)) return false;
  lexer->mark_end(lexer);
  if (!inline_space(lexer->lookahead)) return false;
  skip_inline_space(lexer, false);
  bool has_position = lexer->lookahead != '@';
  if (has_position) {
    if (lexer->lookahead == 'S' || lexer->lookahead == 'E') {
      lexer->advance(lexer, false);
      if (lexer->lookahead != '>') return false;
      lexer->advance(lexer, false);
      skip_inline_space(lexer, false);
    }
    if (!scan_hex_number(lexer)) return false;
    skip_inline_space(lexer, false);
  }
  if (lexer->lookahead != '@') return false;
  lexer->advance(lexer, false);
  skip_inline_space(lexer, false);
  if (lexer->lookahead < '0' || lexer->lookahead > '9') return false;
  do { lexer->advance(lexer, false); } while (lexer->lookahead >= '0' && lexer->lookahead <= '9');
  skip_inline_space(lexer, false);
  if (lexer->lookahead != ':') return false;
  lexer->advance(lexer, false);
  skip_inline_space(lexer, false);
  unsigned bytes = 0;
  bool opcode_started = false;
  while (is_hex(lexer->lookahead)) {
    int32_t first = lexer->lookahead;
    lexer->advance(lexer, false);
    if (!is_hex(lexer->lookahead)) {
      if (!bytes || !is_alpha(first)) return false;
      opcode_started = true;
      break;
    }
    lexer->advance(lexer, false);
    if (!inline_space(lexer->lookahead)) {
      if (!bytes || !is_alpha(first)) return false;
      opcode_started = true;
      break;
    }
    bytes++;
    skip_inline_space(lexer, false);
  }
  if (!bytes) return false;
  // The opcode may start with hex letters (Add), which the loop has peeked.
  if (!opcode_started && !is_alpha(lexer->lookahead)) return false;
  enum TokenType token = has_position ? INSTRUCTION_POSITION : INSTRUCTION_ADDRESS;
  if (!valid_symbols[token]) return false;
  lexer->result_symbol = token;
  return true;
}

static bool scan_property_start(TSLexer *lexer, const bool *valid_symbols) {
  skip_inline_space(lexer, true);
  if (lexer->lookahead != '-') return false;
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  if (!inline_space(lexer->lookahead)) return false;
  skip_inline_space(lexer, false);
  if (!is_alpha(lexer->lookahead) && lexer->lookahead != '_') return false;
  const char *source = "source code";
  unsigned matched = 0;
  while (is_alpha(lexer->lookahead) || (lexer->lookahead >= '0' && lexer->lookahead <= '9') ||
      lexer->lookahead == '_' || lexer->lookahead == ' ' || lexer->lookahead == '(' ||
      lexer->lookahead == ')' || lexer->lookahead == '[' || lexer->lookahead == ']' ||
      lexer->lookahead == '-') {
    if (matched < 11 && lexer->lookahead == source[matched]) matched++;
    else matched = 100;
    lexer->advance(lexer, false);
  }
  bool source_header = matched == 11 && lexer->lookahead == ':';
  if (source_header && valid_symbols[SOURCE_START]) {
    lexer->result_symbol = SOURCE_START;
    return true;
  }
  if (lexer->lookahead == '/') {
    lexer->advance(lexer, false);
    if (lexer->lookahead != '/') return false;
  } else if (lexer->lookahead != ':' && !at_line_end(lexer)) return false;
  if (!valid_symbols[PROPERTY_START]) return false;
  lexer->result_symbol = PROPERTY_START;
  return true;
}

static bool complete_string_header(TSLexer *lexer) {
  if (!literal(lexer, "String")) return false;
  skip_inline_space(lexer, false);
  if (lexer->lookahead != '[') return false;
  lexer->advance(lexer, false);
  skip_inline_space(lexer, false);
  uint32_t length = 0;
  if (lexer->lookahead < '0' || lexer->lookahead > '9') return false;
  do {
    uint32_t digit = lexer->lookahead - '0';
    if (length > (UINT32_MAX - digit) / 10) return false;
    length = length * 10 + digit;
    lexer->advance(lexer, false);
  } while (lexer->lookahead >= '0' && lexer->lookahead <= '9');
  skip_inline_space(lexer, false);
  if (lexer->lookahead != ']') return false;
  lexer->advance(lexer, false);
  skip_inline_space(lexer, false);
  if (lexer->lookahead != ':') return false;
  lexer->advance(lexer, false);
  skip_inline_space(lexer, false);
  if (lexer->lookahead == 'u') {
    lexer->advance(lexer, false);
    skip_inline_space(lexer, false);
  }
  if (lexer->lookahead == '#') return true;
  if (lexer->lookahead == 'c' || lexer->lookahead == 'e' || lexer->lookahead == '>') {
    lexer->advance(lexer, false);
  }
  return lexer->lookahead == '\'' || lexer->lookahead == '"';
}

static bool scan_object_open(Scanner *s, TSLexer *lexer) {
  skip_inline_space(lexer, true);
  if (lexer->lookahead != '<') return false;
  lexer->advance(lexer, false);
  lexer->mark_end(lexer);
  skip_inline_space(lexer, false);
  if (!is_alpha(lexer->lookahead) && lexer->lookahead != '_' && lexer->lookahead != '$') return false;
  if (complete_string_header(lexer)) return false;
  s->object_depth++;
  lexer->result_symbol = OBJECT_OPEN;
  return true;
}

// Return a content span rather than leaving a failed length token pending.
// V8's u# \x%02x is not an unambiguous escape format: 3/4 hex digits can also
// be a shorter escape followed by printable hex text. Prefer complete wide
// escapes while reserving consecutive closing '>' characters for outer tags.
static uint32_t string_value_boundary(Scanner *s, TSLexer *lexer, uint32_t length, bool two_byte) {
  if (!length) return 0;
  uint32_t chars = 0, fallback = UINT32_MAX, selected = UINT32_MAX;
  uint64_t min_units = 0, max_units = 0;
  if (length > V8_SHORT_PRINT_LIMIT && lexer->lookahead == '.') {
    const char *marker = "...<truncated>>";
    unsigned i = 0;
    while (marker[i] && lexer->lookahead == marker[i]) {
      if (lexer->lookahead == '>' && fallback == UINT32_MAX) fallback = chars;
      lexer->advance(lexer, false);
      i++; chars++; min_units++; max_units++;
    }
    if (!marker[i] && lexer->lookahead == '>') {
      uint32_t marker_chars = chars;
      lexer->advance(lexer, false);
      chars++; min_units++; max_units++;
      if (at_line_end(lexer) || lexer->lookahead == '>' || lexer->lookahead == ']' ||
          lexer->lookahead == ')' || lexer->lookahead == ',') return marker_chars;
      if (inline_space(lexer->lookahead)) {
        do { lexer->advance(lexer, false); chars++; min_units++; max_units++; }
        while (inline_space(lexer->lookahead) && !at_line_end(lexer));
        if (at_line_end(lexer) || lexer->lookahead == '<' || lexer->lookahead == '>' ||
            lexer->lookahead == ']' || lexer->lookahead == ')') return marker_chars;
      }
    }
  }
  while (!at_line_end(lexer) && min_units <= length) {
    if (lexer->lookahead == '>') {
      uint32_t run_start = chars, run = 0;
      if (fallback == UINT32_MAX) fallback = chars;
      uint64_t base_min = min_units, base_max = max_units;
      uint64_t run_limit = length - base_min + 1 + (uint64_t)s->object_depth;
      do {
        lexer->advance(lexer, false);
        chars++; run++; min_units++; max_units++;
      } while (lexer->lookahead == '>' && run < run_limit);
      uint64_t lo = length > base_max ? length - base_max : 0;
      if (!base_min && !lo) lo = 1;
      if (base_min <= length) {
        uint64_t hi = length - base_min;
        if (hi >= run) hi = run - 1;
        uint32_t available = run > s->object_depth ? run - s->object_depth - 1 : 0;
        if (hi > available) hi = available;
        if (lo <= hi) selected = run_start + (uint32_t)hi;
        else if (lo < run) selected = run_start + (uint32_t)lo;
      }
      if (selected != UINT32_MAX) {
        if (run > 1 || at_line_end(lexer) || min_units > length ||
            lexer->lookahead == '<' || lexer->lookahead == ']' ||
            lexer->lookahead == ')' || lexer->lookahead == ',') return selected;
        if (inline_space(lexer->lookahead)) {
          do { lexer->advance(lexer, false); chars++; min_units++; max_units++; }
          while (inline_space(lexer->lookahead) && !at_line_end(lexer));
          if (at_line_end(lexer) || lexer->lookahead == '<' || lexer->lookahead == '>' ||
              lexer->lookahead == ']' || lexer->lookahead == ')') return selected;
        }
      }
      continue;
    }
    int32_t c = lexer->lookahead;
    lexer->advance(lexer, false);
    chars++;
    if (c == '\\') {
      if (lexer->lookahead == 'n' || lexer->lookahead == 'r' || lexer->lookahead == '\\') {
        lexer->advance(lexer, false); chars++;
        min_units++; max_units++;
      } else if (lexer->lookahead == 'x' || lexer->lookahead == 'u') {
        bool unicode = lexer->lookahead == 'u';
        lexer->advance(lexer, false); chars++;
        unsigned digits = 0;
        bool leading_zero = lexer->lookahead == '0';
        unsigned digits_limit = unicode || (two_byte && !leading_zero) ? 4 : 2;
        while (digits < digits_limit && is_hex(lexer->lookahead)) {
          lexer->advance(lexer, false); chars++; digits++;
        }
        if (unicode ? digits == 4 : digits >= 2) {
          min_units++;
          max_units += unicode || !two_byte ? 1 : digits - 1;
        } else {
          min_units += 2 + digits; max_units += 2 + digits;
        }
      } else { min_units++; max_units++; }
    } else {
      unsigned units = c > 0xffff ? 2 : 1;
      min_units += units; max_units += units;
    }
  }
  if (selected != UINT32_MAX) return selected;
  // Keep short malformed tags recoverable at their first closing delimiter.
  // A long failed pre-read must be consumed instead of repeatedly replayed
  // from subsequent tags on the same line. It stays within the physical line.
  if (fallback != UINT32_MAX && chars - fallback <= RECOVERY_LOOKAHEAD) return fallback;
  return chars;
}

static bool scan_string_length(Scanner *s, TSLexer *lexer) {
  skip_inline_space(lexer, true);
  if (lexer->lookahead < '0' || lexer->lookahead > '9') return false;
  uint32_t length = 0;
  do {
    uint32_t digit = (uint32_t)(lexer->lookahead - '0');
    if (length > (UINT32_MAX - digit) / 10) return false;
    length = length * 10 + digit;
    lexer->advance(lexer, false);
  } while (lexer->lookahead >= '0' && lexer->lookahead <= '9');
  lexer->mark_end(lexer);
  s->pending_value = false; s->value_chars = 0;
  s->pending_close = true;
  skip_inline_space(lexer, false);
  if (lexer->lookahead == ']') {
    lexer->advance(lexer, false);
    skip_inline_space(lexer, false);
    if (lexer->lookahead == ':') {
      lexer->advance(lexer, false);
      skip_inline_space(lexer, false);
      bool two_byte = lexer->lookahead == 'u';
      if (two_byte) { lexer->advance(lexer, false); skip_inline_space(lexer, false); }
      if (lexer->lookahead == '#') {
        lexer->advance(lexer, false);
        s->pending_value = true;
        s->value_chars = string_value_boundary(s, lexer, length, two_byte);
      }
    }
  }
  lexer->result_symbol = STRING_LENGTH;
  return true;
}

static bool scan_unquoted_string(Scanner *s, TSLexer *lexer, const bool *valid_symbols) {
  if (!s->pending_value) return false;
  bool empty = s->value_chars == 0;
  enum TokenType token = empty ? EMPTY_STRING : UNQUOTED_STRING;
  if (!valid_symbols[token]) return false;
  for (uint32_t i = 0; i < s->value_chars; i++) {
    if (at_line_end(lexer)) return false;
    lexer->advance(lexer, false);
  }
  lexer->mark_end(lexer);
  s->pending_value = false; s->value_chars = 0;
  lexer->result_symbol = token;
  return true;
}

static bool script_footer(TSLexer *lexer) {
  if (!literal(lexer, " - script: ")) return false;
  if (!scan_hex_number(lexer)) return false;
  if (!literal(lexer, " <Script>")) return false;
  if (lexer->lookahead == '\r') lexer->advance(lexer, false);
  return lexer->lookahead == '\n' || lexer->eof(lexer);
}

static bool scan_javascript_source(TSLexer *lexer) {
  bool consumed = false;
  lexer->result_symbol = JAVASCRIPT_SOURCE;
  while (!lexer->eof(lexer)) {
    lexer->mark_end(lexer);
    if (lexer->get_column(lexer) == 0 && script_footer(lexer)) return consumed;
    if (lexer->eof(lexer)) break;
    lexer->advance(lexer, false);
    consumed = true;
  }
  lexer->mark_end(lexer);
  return consumed;
}

bool tree_sitter_ignition_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  Scanner *s = payload;
  // Recovery enables all external tokens; do not consume source or dispatch
  // new candidates there, which can repeatedly scan the rest of a document.
  if (!s || (valid_symbols[JAVASCRIPT_SOURCE] && valid_symbols[END_OF_FILE])) return false;
  if (valid_symbols[JAVASCRIPT_SOURCE]) return scan_javascript_source(lexer);
  if (valid_symbols[STRING_LENGTH]) return scan_string_length(s, lexer);
  if (valid_symbols[UNQUOTED_STRING] || valid_symbols[EMPTY_STRING]) return scan_unquoted_string(s, lexer, valid_symbols);
  skip_inline_space(lexer, true);
  // A real group ending takes priority over implicitly ending an outer object.
  // A still-open inner object requires its ending token before this is valid.
  if ((valid_symbols[BRACKET_CLOSE] && lexer->lookahead == ']') ||
      (valid_symbols[PAREN_CLOSE] && lexer->lookahead == ')')) {
    enum TokenType token = lexer->lookahead == ']' ? BRACKET_CLOSE : PAREN_CLOSE;
    lexer->advance(lexer, false); lexer->mark_end(lexer);
    lexer->result_symbol = token;
    return true;
  }
  if (valid_symbols[IMPLICIT_OBJECT_CLOSE] && s->object_depth &&
      (lexer->lookahead == ']' || lexer->lookahead == ')' || at_line_end(lexer))) {
    lexer->mark_end(lexer);
    s->object_depth--;
    lexer->result_symbol = IMPLICIT_OBJECT_CLOSE;
    return true;
  }
  if (valid_symbols[NEWLINE] && lexer->lookahead == '\n') {
    lexer->advance(lexer, false); lexer->mark_end(lexer);
    s->object_depth = 0; s->pending_value = false; s->value_chars = 0; s->pending_close = false;
    lexer->result_symbol = NEWLINE;
    return true;
  }
  if (valid_symbols[END_OF_FILE] && lexer->eof(lexer)) {
    s->object_depth = 0; s->pending_value = false; s->value_chars = 0; s->pending_close = false;
    lexer->result_symbol = END_OF_FILE;
    return true;
  }
  if (valid_symbols[STRING_CLOSE] && s->pending_close && lexer->lookahead == '>') {
    lexer->advance(lexer, false); lexer->mark_end(lexer);
    s->pending_close = false;
    lexer->result_symbol = STRING_CLOSE;
    return true;
  }
  if (valid_symbols[OBJECT_CLOSE] && lexer->lookahead == '>') {
    lexer->advance(lexer, false); lexer->mark_end(lexer);
    if (s->object_depth) s->object_depth--;
    lexer->result_symbol = OBJECT_CLOSE;
    return true;
  }
  if (valid_symbols[OBJECT_OPEN] && lexer->lookahead == '<') return scan_object_open(s, lexer);
  if ((valid_symbols[INSTRUCTION_ADDRESS] || valid_symbols[INSTRUCTION_POSITION]) && is_hex(lexer->lookahead)) {
    return scan_instruction_start(lexer, valid_symbols);
  }
  if (valid_symbols[PROPERTY_START] || valid_symbols[SOURCE_START]) return scan_property_start(lexer, valid_symbols);
  return false;
}
