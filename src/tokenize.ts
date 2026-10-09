import type { Aliases } from './aliases';
import { GeneralError } from './error_exit_code';

const delimiters = ';&|><';
const whitespace = ' ';

export type Token = {
  // Stores offset into source string for error reporting.
  offset: number;
  value: string;
  // Body of a here document, set on '<<' and '<<-' tokens once the delimiter line has been read.
  heredoc?: string;
  // Set on '<<' and '<<-' tokens whose delimiter word contained a quoted section. As in bash, that
  // makes the here document body literal, without it the body is expanded but not split.
  quotedDelimiter?: boolean;
  // Value offsets [start, end) of characters that came from a quoted section of the source,
  // single or double quoted. A '$' reference does not span a section boundary. Set for tokens
  // which contain quoted sections.
  quoted?: [number, number][];
  // Subset of 'quoted' for single-quoted sections: '$' references within them are not expanded.
  singleQuoted?: [number, number][];
  // Value offsets [start, end) of command substitutions '$(...)' and '`...`' in unquoted or
  // double-quoted sections. Set for tokens which contain command substitutions. The replacement
  // values used at run time are held in substitutionValues, in the same order.
  substitutions?: [number, number][];
  // Output of each command substitution, set by the shell before the token is expanded.
  substitutionValues?: string[];
};

/** A here document whose delimiter word has been read but whose body has not yet. */
interface IPendingHeredoc {
  token: Token;
  delimiter: string;
  stripTabs: boolean;
}

export function tokenize(source: string, throwErrors: boolean = true, aliases?: Aliases): Token[] {
  const tokenizer = new Tokenizer(source, throwErrors, aliases);
  tokenizer.run();
  return tokenizer.tokens;
}

/**
 * Whether the source ends inside a quoted section, so that further input is required.
 */
export function hasOpenQuote(source: string): boolean {
  const tokenizer = new Tokenizer(source, false);
  tokenizer.run();
  return tokenizer.openQuote !== '';
}

/**
 * Whether a token value is a here document operator, '<<' or '<<-'.
 */
export function isHeredocToken(value: string): boolean {
  return value === '<<' || value === '<<-';
}

/** Redirection operators. */
const redirectOperators: string[] = [
  '<',
  '<<',
  '<<-',
  '<<<',
  '<>',
  '<&',
  '>',
  '>>',
  '>|',
  '>&',
  '&>',
  '&>>'
];

/** The redirection operator of a token value, without any leading file descriptor digits. */
export function redirectOperator(value: string): string {
  return value.replace(/^\d+/, '');
}

/** Whether a token value is a redirection, optionally preceded by a file descriptor number. */
export function isRedirectToken(value: string): boolean {
  return redirectOperators.includes(redirectOperator(value));
}

/**
 * Split a redirection token value into its file descriptor and operator. The file descriptor
 * defaults to standard input for '<' operators and to standard output otherwise.
 */
export function splitRedirect(value: string): { fd: number; operator: string } {
  const digits: RegExpExecArray | null = /^(\d+)/.exec(value);
  const operator: string = redirectOperator(value);
  const fd: number = digits !== null ? parseInt(digits[1], 10) : operator.startsWith('<') ? 0 : 1;
  return { fd, operator };
}

/** Whether appending char to an in-progress token continues a redirection operator. */
function extendsRedirect(value: string, char: string): boolean {
  const digits: RegExpExecArray | null = /^\d+/.exec(value);
  const operator: string = (digits !== null ? value.slice(digits[0].length) : value) + char;
  if (digits !== null && operator.startsWith('&')) {
    // A file descriptor never precedes '&>' or '&>>'.
    return false;
  }
  return redirectOperators.some(op => op.startsWith(operator));
}

enum CharType {
  None,
  Delimiter,
  DoubleQuote,
  SingleQuote,
  Whitespace,
  Other
}

class Tokenizer {
  constructor(
    source: string,
    readonly throwErrors: boolean,
    readonly aliases?: Aliases
  ) {
    this._source = source;
    this._tokens = [];
  }

  run() {
    while (this._index <= this._source.length) {
      this._next();
    }

    if (this.throwErrors) {
      if (this._endQuote !== '') {
        throw new GeneralError('Tokenize error, expected end quote ' + this._endQuote);
      }
    }
  }

  get tokens(): Token[] {
    return this._tokens;
  }

  /** End quote if the source ended within a quoted section, otherwise an empty string. */
  get openQuote(): string {
    return this._endQuote;
  }

  private _addToken(): boolean {
    const offset = this._offset;
    const value = this._value;

    if (this.aliases !== undefined && offset !== this._aliasOffset) {
      const isCommand =
        this._tokens.length === 0 || ';&|'.includes(this._tokens.at(-1)!.value.at(-1)!);

      if (isCommand) {
        const alias = this.aliases.getRecursive(value);
        if (alias !== undefined) {
          // Replace token with its alias and set state to beginning of it to re-tokenize.
          const n = value.length;
          this._offset = -1;
          this._index = offset - 1;
          this._aliasOffset = offset; // Do not attempt to alias this token again.
          this._source = this._source.slice(0, offset) + alias + this._source.slice(offset + n);
          this._prevChar = '';
          this._prevCharType = CharType.None;
          this._value = '';
          this._endQuote = '';
          this._quoted = [];
          this._singleQuoted = [];
          this._substitutions = [];
          return false;
        }
      }
    }

    const token: Token = { offset, value };
    if (this._quoted.length > 0) {
      token.quoted = this._quoted;
    }
    if (this._singleQuoted.length > 0) {
      token.singleQuoted = this._singleQuoted;
    }
    if (this._substitutions.length > 0) {
      token.substitutions = this._substitutions;
    }
    this._quoted = [];
    this._singleQuoted = [];
    this._substitutions = [];
    this._tokens.push(token);

    // A token following a here document operator is its delimiter word.
    const previous: Token | undefined = this._tokens.at(-2);
    if (previous !== undefined && isHeredocToken(previous.value)) {
      if (token.quoted !== undefined) {
        previous.quotedDelimiter = true;
      }
      this._pendingHeredocs.push({
        token: previous,
        delimiter: value,
        stripTabs: previous.value.endsWith('-')
      });
    }

    this._endQuote = '';
    return true;
  }

  private _getCharType(char: string): CharType {
    if (whitespace.includes(char)) {
      return CharType.Whitespace;
    } else if (delimiters.includes(char)) {
      return CharType.Delimiter;
    } else if (char === "'") {
      return CharType.SingleQuote;
    } else if (char === '"') {
      return CharType.DoubleQuote;
    } else {
      return CharType.Other;
    }
  }

  private _endQuoteFromCharType(charType: CharType): string {
    if (charType === CharType.DoubleQuote) {
      return '"';
    } else if (charType === CharType.SingleQuote) {
      return "'";
    } else {
      return '';
    }
  }

  private _next() {
    const i = ++this._index;
    const char = i < this._source.length ? this._source[i] : ' ';
    let charType = this._getCharType(char);
    const endQuote = this._endQuoteFromCharType(charType);

    if (char === '\\' && this._endQuote !== "'" && this._source[i + 1] === '\n') {
      // Backslash-newline is a line continuation outside single quotes.
      this._index++; // Also skip the newline.
      return;
    }

    if (char === '\n' && this._endQuote === '') {
      this._newline();
      return;
    }

    if (this._endQuote !== "'" && !this._backslashEscaped(i)) {
      // Command substitution, which is a single word whatever it contains. '$((', arithmetic
      // expansion, is not supported and is left as literal text.
      if (char === '$' && this._source[i + 1] === '(' && this._source[i + 2] !== '(') {
        this._consumeCommandSubstitution(i, i + 1, false);
        return;
      }
      if (char === '`') {
        this._consumeCommandSubstitution(i, i, true);
        return;
      }
    }

    if (this._offset >= 0) {
      // In token.
      if (this._endQuote) {
        // In quoted section, continue until reach end quote.
        if (char !== this._endQuote) {
          this._value += char;
        } else {
          if (this._endQuote === "'") {
            this._singleQuoted.push([this._quoteStart, this._value.length]);
          }
          this._quoted.push([this._quoteStart, this._value.length]);
          this._endQuote = '';
          charType = CharType.Other;
        }
      } else if (endQuote) {
        if (isRedirectToken(this._value)) {
          // A redirection operator ends before a quoted word: '<<"EOF"' is the operator '<<'
          // followed by the quoted delimiter 'EOF'.
          if (!this._addToken()) {
            // Alias substitution modified the source, the quote will be handled again.
            return;
          }
          this._offset = i;
          this._endQuote = endQuote;
          this._value = '';
          this._quoteStart = 0; // The value is empty at the start of a token.
          charType = CharType.Other;
        } else {
          // Start quoted section within current token.
          this._endQuote = endQuote;
          this._quoteStart = this._value.length;
        }
      } else if (charType === CharType.Whitespace) {
        // Finish current token.
        if (this._addToken()) {
          this._offset = -1;
        }
      } else if (
        charType !== this._prevCharType ||
        (charType === CharType.Delimiter && char !== this._prevChar)
      ) {
        if (extendsRedirect(this._value, char)) {
          // Continue a redirection operator, e.g. the '>' after '2' or the '&' after '>'.
          this._value += char;
          charType = CharType.Delimiter;
        } else if (this._addToken()) {
          // Finish current token and start new one.
          this._offset = i;
          this._value = char;
        }
      } else {
        // Continue in current token.
        this._value += char;
      }
    } else {
      // Not in token.
      if (charType !== CharType.Whitespace) {
        // Start new token.
        this._offset = i;
        this._endQuote = this._endQuoteFromCharType(charType);
        this._value = this._endQuote === '' ? char : '';
        if (this._endQuote !== '') {
          this._quoteStart = 0; // The value is empty at the start of a token.
        }
      }
    }
    this._prevChar = char;
    this._prevCharType = charType;
  }

  /** Whether the character at index is preceded by an odd number of backslashes. */
  private _backslashEscaped(index: number): boolean {
    let backslashes: number = 0;
    for (let j = index - 1; j >= 0 && this._source[j] === '\\'; j--) {
      backslashes++;
    }
    return backslashes % 2 === 1;
  }

  /**
   * Consume a command substitution, appending its raw text to the current token and recording its
   * span. The substitution starts at start and openIndex is the offset of its '(' or '`'.
   */
  private _consumeCommandSubstitution(start: number, openIndex: number, backtick: boolean): void {
    const end: number = this._commandSubstitutionEnd(openIndex, backtick);
    const raw: string = this._source.slice(start, end < 0 ? this._source.length : end + 1);
    if (this._offset < 0) {
      this._offset = start;
      this._value = '';
    }
    const spanStart: number = this._value.length;
    this._value += raw;
    this._substitutions.push([spanStart, this._value.length]);
    if (end < 0) {
      // Unterminated: stop tokenizing so that more input can complete the substitution.
      this._index = this._source.length;
      this._endQuote = backtick ? '`' : ')';
    } else {
      this._index = end;
    }
    this._prevChar = raw.at(-1) ?? '';
    this._prevCharType = CharType.Other;
  }

  /**
   * Index of the closing ')' or '`' of a command substitution whose opening character is at
   * openIndex, or -1 if it is not present. Quoted sections and nested substitutions are skipped.
   */
  private _commandSubstitutionEnd(openIndex: number, backtick: boolean): number {
    const source: string = this._source;
    let depth: number = 1;
    let j: number = openIndex + 1;
    while (j < source.length) {
      const char: string = source[j];
      if (char === '\\') {
        j += 2;
      } else if (backtick) {
        if (char === '`') {
          return j;
        }
        j++;
      } else if (char === "'") {
        const end: number = source.indexOf("'", j + 1);
        if (end < 0) {
          return -1;
        }
        j = end + 1;
      } else if (char === '"') {
        j++;
        while (j < source.length && source[j] !== '"') {
          j += source[j] === '\\' ? 2 : 1;
        }
        if (j >= source.length) {
          return -1;
        }
        j++;
      } else if (char === '`') {
        const end: number = this._commandSubstitutionEnd(j, true);
        if (end < 0) {
          return -1;
        }
        j = end + 1;
      } else if (char === '$' && source[j + 1] === '(') {
        depth++;
        j += 2;
      } else if (char === '(') {
        depth++;
        j++;
      } else if (char === ')') {
        if (--depth === 0) {
          return j;
        }
        j++;
      } else {
        j++;
      }
    }
    return -1;
  }

  /** Handle a newline that is not within a quoted section. */
  private _newline(): void {
    if (this._offset >= 0 && !this._addToken()) {
      // Alias substitution modified the source, the newline will be handled again.
      return;
    }
    this._offset = -1;

    if (this._tokens.at(-1)?.value === '|') {
      // A newline after a pipe is ignored, as the command continues on the next line.
      return;
    }

    this._tokens.push({ offset: this._index, value: ';' });

    if (this._pendingHeredocs.length > 0) {
      this._readHeredocs();
    }
  }

  /** Read the bodies of pending here documents, which start after the command line. */
  private _readHeredocs(): void {
    while (this._pendingHeredocs.length > 0) {
      const { token, delimiter, stripTabs } = this._pendingHeredocs[0];
      const body: string | undefined = this._readHeredocBody(delimiter, stripTabs);
      if (body === undefined) {
        // The terminating delimiter line has not been read yet. Stop tokenizing as the
        // remainder of the source is here document content.
        this._index = this._source.length;
        return;
      } else {
        token.heredoc = body;
        this._pendingHeredocs.shift();
      }
    }
  }

  /**
   * Read a single here document body, starting on the line after the current position. Returns
   * undefined if the line containing only the delimiter is not present in the source.
   */
  private _readHeredocBody(delimiter: string, stripTabs: boolean): string | undefined {
    let body: string = '';
    let index: number = this._index + 1; // Skip the newline that ends the command line.

    while (index <= this._source.length) {
      const endOfLine: number = this._source.indexOf('\n', index);
      const lineEnd: number = endOfLine < 0 ? this._source.length : endOfLine;
      let line: string = this._source.slice(index, lineEnd);
      if (stripTabs) {
        line = line.replace(/^\t+/, '');
      }

      if (line === delimiter) {
        // Found the terminating delimiter line.
        this._index = lineEnd;
        return body;
      }

      if (endOfLine < 0) {
        // No terminating delimiter before the end of the source.
        return undefined;
      }

      body += `${line}\n`;
      index = endOfLine + 1;
    }

    return undefined;
  }

  private _source: string;
  private _tokens: Token[];

  // Tokenizer state.
  private _prevChar: string = '';
  private _prevCharType: CharType = CharType.None;
  private _index: number = -1; // Index into source string.
  private _offset: number = -1; // Offset of start of current token, -1 if not in token.
  private _aliasOffset: number = -1;
  private _value: string = ''; // Current token.
  private _quoted: [number, number][] = []; // Quoted sections of current token.
  private _singleQuoted: [number, number][] = []; // Single-quoted sections of current token.
  private _substitutions: [number, number][] = []; // Command substitutions of current token.
  private _quoteStart: number = 0; // Value offset of start of current quoted section.
  private _endQuote: string = ''; // End quote if in quoted section, otherwise emptry string.
  private _pendingHeredocs: IPendingHeredoc[] = [];
}
