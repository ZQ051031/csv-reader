// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly what the reference
// returns for {text, header}: {columns, rows, errors}. Written from scratch for
// speed: indexOf/slice fast paths for plain fields, charCode scanning only where
// the broken-row rules need it. No dependencies, no regex in hot paths.
//
// Semantics (mirrors the reference exactly):
// - U+FEFF at the very start is dropped.
// - A record ends at LF or CRLF; a line with no characters is no record.
// - Outside quotes a CR not followed by LF is dropped (stray_cr).
// - A field opening with a quote runs to the next non-doubled quote; "" inside is
//   one quote; CRLF/lone CR inside quotes read as LF; text after the closing quote
//   up to the next comma/line break is appended as-is (quote_junk, when the field
//   ends); a quote that never closes is literal and the text after it is re-read
//   as unquoted (unterminated_quote). A quote inside an unquoted field is literal.
// - Fields stay strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows are padded
//   with "" (short_row, fields: count) or cut (long_row, extra: cut fields) to
//   the first record's width.
// - Errors are {code, line, row} in the order met; line is the 1-based line the
//   record starts on (counting every LF/CRLF/lone CR inside quotes), row is the
//   record's index in rows (null for the header).

/** Field ended at a comma (0), at a line break (1), or at the end of the text (2). */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // Shared scratch for field readers.
  const parts = []; // string pieces of the field being built
  let fe = END; // how the last field ended
  let added = 0; // characters kept by the last slow unquoted read, beyond its init

  function finishParts() {
    if (parts.length === 1) return parts[0];
    if (parts.length === 0) return '';
    return parts.join('');
  }

  // Appends text[s:e) to parts, turning every CRLF and lone CR into LF and
  // counting the lines. Used for chunks inside quoted fields.
  function pushChunk(s, e) {
    let i = s;
    while (i < e) {
      const c = text.charCodeAt(i);
      if (c === 10 || c === 13) break;
      i++;
    }
    if (i === e) {
      if (e > s) parts.push(text.slice(s, e));
      return;
    }
    if (i > s) parts.push(text.slice(s, i));
    while (i < e) {
      const c = text.charCodeAt(i);
      if (c === 10) {
        parts.push('\n');
        line++;
        i++;
      } else if (c === 13) {
        parts.push('\n');
        line++;
        i += i + 1 < e && text.charCodeAt(i + 1) === 10 ? 2 : 1;
      } else {
        const rs = i;
        while (i < e) {
          const d = text.charCodeAt(i);
          if (d === 10 || d === 13) break;
          i++;
        }
        parts.push(text.slice(rs, i));
      }
    }
  }

  // Slow unquoted read from pos, starting from init ('' normally, '"' for an
  // unterminated quote's re-read, the quoted content for quote junk). Sets fe
  // and added (characters kept beyond init). Used only when a stray CR or junk
  // forces a character scan.
  function readUnquotedSlow(init) {
    parts.length = 0;
    added = 0;
    if (init !== '') parts.push(init);
    let seg = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        if (pos > seg) {
          parts.push(text.slice(seg, pos));
          added += pos - seg;
        }
        pos++;
        fe = COMMA;
        return finishParts();
      }
      if (c === 10) {
        if (pos > seg) {
          parts.push(text.slice(seg, pos));
          added += pos - seg;
        }
        pos++;
        line++;
        fe = LINE_BREAK;
        return finishParts();
      }
      if (c === 13) {
        if (pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
          if (pos > seg) {
            parts.push(text.slice(seg, pos));
            added += pos - seg;
          }
          pos += 2;
          line++;
          fe = LINE_BREAK;
          return finishParts();
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        if (pos > seg) {
          parts.push(text.slice(seg, pos));
          added += pos - seg;
        }
        pos++;
        seg = pos;
        continue;
      }
      pos++;
    }
    if (pos > seg) {
      parts.push(text.slice(seg, pos));
      added += pos - seg;
    }
    fe = END;
    return finishParts();
  }

  // Unquoted read from pos: one charCodeAt scan to the next delimiter, then a
  // single slice. Falls back to the slow reader only on a stray CR.
  function readUnquoted() {
    let i = pos;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44 || c === 10 || c === 13) break;
      i++;
    }
    if (i >= n) {
      const v = text.slice(pos, n);
      pos = n;
      fe = END;
      return v;
    }
    const c = text.charCodeAt(i);
    if (c === 44) {
      const v = text.slice(pos, i);
      pos = i + 1;
      fe = COMMA;
      return v;
    }
    if (c === 10) {
      const v = text.slice(pos, i);
      pos = i + 1;
      line++;
      fe = LINE_BREAK;
      return v;
    }
    if (i + 1 < n && text.charCodeAt(i + 1) === 10) {
      const v = text.slice(pos, i);
      pos = i + 2;
      line++;
      fe = LINE_BREAK;
      return v;
    }
    return readUnquotedSlow('');
  }

  // Quoted field whose opening quote is at pos. Sets fe.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    parts.length = 0;
    pos++; // skip the opening quote
    let cur = pos;
    while (true) {
      const q = text.indexOf('"', cur);
      if (q === -1) {
        // The quote never closes: it is literal, and the text after it is
        // re-read as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquotedSlow('"');
      }
      pushChunk(cur, q);
      if (q + 1 < n && text.charCodeAt(q + 1) === 34) {
        parts.push('"');
        cur = q + 2;
        continue;
      }
      pos = q + 1;
      break;
    }
    if (pos >= n) {
      fe = END;
      return finishParts();
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos++;
      fe = COMMA;
      return finishParts();
    }
    if (c === 10) {
      pos++;
      line++;
      fe = LINE_BREAK;
      return finishParts();
    }
    if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line++;
      fe = LINE_BREAK;
      return finishParts();
    }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break.
    const quotedValue = finishParts();
    const value = readUnquotedSlow(quotedValue);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return value;
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos++;
        line++;
      } else if (c === 13 && pos + 1 < n && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line++;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let quoted = false;
    let field;
    do {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        field = readQuoted();
      } else {
        quoted = false;
        field = readUnquoted();
      }
      fields.push(field);
    } while (fe === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
