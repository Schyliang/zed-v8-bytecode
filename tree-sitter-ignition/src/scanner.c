// SPDX-License-Identifier: GPL-3.0-only
#include "tree_sitter/parser.h"
#include <stdint.h>
#include <stdlib.h>

enum TokenType { JAVASCRIPT_SOURCE, END_OF_FILE, STRING_LENGTH, UNQUOTED_STRING };
typedef struct { uint32_t string_length; bool two_byte; } Scanner;

void *tree_sitter_ignition_external_scanner_create(void) { return calloc(1, sizeof(Scanner)); }
void tree_sitter_ignition_external_scanner_destroy(void *payload) { free(payload); }
unsigned tree_sitter_ignition_external_scanner_serialize(void *payload, char *buffer) {
  if (!payload) return 0;
  uint32_t n = ((Scanner *)payload)->string_length;
  if (!n) return 0;
  for (unsigned i = 0; i < 4; i++) buffer[i] = (char)(n >> (i * 8));
  buffer[4] = ((Scanner *)payload)->two_byte;
  return 5;
}
void tree_sitter_ignition_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  if (!payload) return;
  uint32_t n = 0;
  if (length == 5) for (unsigned i = 0; i < 4; i++) n |= (uint32_t)(unsigned char)buffer[i] << (i * 8);
  ((Scanner *)payload)->string_length = n;
  ((Scanner *)payload)->two_byte = length == 5 && buffer[4];
}

static bool is_hex(int32_t c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
static bool inline_space(int32_t c) { return c == ' ' || c == '\t' || c == '\r'; }
static void skip_inline_space(TSLexer *lexer, bool skip) {
  while (inline_space(lexer->lookahead)) lexer->advance(lexer, skip);
}

static bool scan_string_length(Scanner *scanner, TSLexer *lexer) {
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
  // Peek beyond the length token so only an unquoted value retains state.
  scanner->string_length = 0;
  scanner->two_byte = false;
  skip_inline_space(lexer, false);
  if (lexer->lookahead == ']') {
    lexer->advance(lexer, false);
    skip_inline_space(lexer, false);
    if (lexer->lookahead == ':') {
      lexer->advance(lexer, false);
      skip_inline_space(lexer, false);
      if (lexer->lookahead == 'u') {
        scanner->two_byte = true;
        lexer->advance(lexer, false);
        skip_inline_space(lexer, false);
      }
      if (lexer->lookahead == '#') scanner->string_length = length;
    }
  }
  lexer->result_symbol = STRING_LENGTH;
  return true;
}

static bool scan_unquoted_string(Scanner *scanner, TSLexer *lexer) {
  uint32_t length = scanner->string_length;
  if (length == 0) return false;
  uint64_t min_units = 0, max_units = 0;
  bool found_end = false;
  // V8 abbreviates strings longer than 1024 UTF16 units with this marker.
  if (length > 1024 && lexer->lookahead == '.') {
    const char *marker = "...<truncated>>";
    unsigned i = 0;
    while (marker[i] && lexer->lookahead == marker[i]) {
      lexer->advance(lexer, false);
      i++; min_units++; max_units++;
    }
    if (!marker[i] && lexer->lookahead == '>') {
      lexer->mark_end(lexer);
      scanner->string_length = 0;
      lexer->result_symbol = UNQUOTED_STRING;
      return true;
    }
  }
  while (!lexer->eof(lexer) && lexer->lookahead != '\n' && lexer->lookahead != '\r') {
    // A printable '>' is part of the value until its declared length is met.
    // Wide \x escapes have variable width; keep the last feasible boundary.
    if (lexer->lookahead == '>' && min_units > 0 &&
        min_units <= length && length <= max_units) {
      lexer->mark_end(lexer);
      found_end = true;
    }
    int32_t c = lexer->lookahead;
    lexer->advance(lexer, false);
    if (c == '\\') {
      if (lexer->lookahead == 'n' || lexer->lookahead == 'r' ||
          lexer->lookahead == '\\') {
        lexer->advance(lexer, false);
        min_units++; max_units++;
      } else if (lexer->lookahead == 'x' || lexer->lookahead == 'u') {
        bool unicode = lexer->lookahead == 'u';
        lexer->advance(lexer, false);
        unsigned digits = 0;
        bool leading_zero = lexer->lookahead == '0';
        unsigned limit = unicode || (scanner->two_byte && !leading_zero) ? 4 : 2;
        while (digits < limit && is_hex(lexer->lookahead)) {
          lexer->advance(lexer, false);
          digits++;
        }
        if (unicode ? digits == 4 : digits >= 2) {
          min_units++;
          max_units += unicode || !scanner->two_byte ? 1 : digits - 1;
        } else {
          min_units += 2 + digits;
          max_units += 2 + digits;
        }
      } else {
        min_units++; max_units++;
      }
    } else {
      unsigned units = c > 0xffff ? 2 : 1;
      min_units += units; max_units += units;
    }
    if (min_units > length) break;
  }
  scanner->string_length = 0;
  lexer->result_symbol = UNQUOTED_STRING;
  return found_end;
}

static bool script_footer(TSLexer *lexer) {
  const char *prefix = " - script: 0x";
  for (unsigned i = 0; prefix[i]; i++) {
    if (lexer->lookahead != prefix[i]) return false;
    lexer->advance(lexer, false);
  }
  if (!is_hex(lexer->lookahead)) return false;
  do { lexer->advance(lexer, false); } while (is_hex(lexer->lookahead));
  const char *suffix = " <Script>";
  for (unsigned i = 0; suffix[i]; i++) {
    if (lexer->lookahead != suffix[i]) return false;
    lexer->advance(lexer, false);
  }
  if (lexer->lookahead == '\r') lexer->advance(lexer, false);
  return lexer->lookahead == '\n' || lexer->eof(lexer);
}

// The source is opaque to this grammar and injected into Zed's JavaScript
// grammar. Stop before V8's Script footer; all other lines belong to the source.
bool tree_sitter_ignition_external_scanner_scan(void *payload, TSLexer *lexer, const bool *valid_symbols) {
  // Tree-sitter enables every external token during error recovery. Scanning
  // source there would repeatedly consume the rest of a disassembly after
  // failed instruction candidates, making metadata-heavy files quadratic.
  if (valid_symbols[JAVASCRIPT_SOURCE] && valid_symbols[END_OF_FILE]) return false;
  if (valid_symbols[END_OF_FILE] && lexer->eof(lexer)) {
    lexer->result_symbol = END_OF_FILE;
    return true;
  }
  if (valid_symbols[STRING_LENGTH]) return payload && scan_string_length((Scanner *)payload, lexer);
  if (valid_symbols[UNQUOTED_STRING]) return payload && scan_unquoted_string((Scanner *)payload, lexer);
  if (!valid_symbols[JAVASCRIPT_SOURCE]) return false;

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
