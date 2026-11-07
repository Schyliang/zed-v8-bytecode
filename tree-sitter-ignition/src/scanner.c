// SPDX-License-Identifier: GPL-3.0-only
#include "tree_sitter/parser.h"

enum TokenType { JAVASCRIPT_SOURCE, END_OF_FILE };

void *tree_sitter_ignition_external_scanner_create(void) { return NULL; }
void tree_sitter_ignition_external_scanner_destroy(void *payload) { (void)payload; }
unsigned tree_sitter_ignition_external_scanner_serialize(void *payload, char *buffer) {
  (void)payload; (void)buffer; return 0;
}
void tree_sitter_ignition_external_scanner_deserialize(void *payload, const char *buffer, unsigned length) {
  (void)payload; (void)buffer; (void)length;
}

static bool is_hex(int32_t c) {
  return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
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
  (void)payload;
  // Tree-sitter enables every external token during error recovery. Scanning
  // source there would repeatedly consume the rest of a disassembly after
  // failed instruction candidates, making metadata-heavy files quadratic.
  if (valid_symbols[JAVASCRIPT_SOURCE] && valid_symbols[END_OF_FILE]) return false;
  if (valid_symbols[END_OF_FILE] && lexer->eof(lexer)) {
    lexer->result_symbol = END_OF_FILE;
    return true;
  }
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
