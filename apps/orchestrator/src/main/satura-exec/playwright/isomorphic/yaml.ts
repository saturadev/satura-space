export function yamlEscapeKeyIfNeeded(str: string): string {
  if (!yamlStringNeedsQuotes(str))
    return str;
  return `'` + str.replace(/'/g, `''`) + `'`;
}

export function yamlEscapeValueIfNeeded(str: string): string {
  if (!yamlStringNeedsQuotes(str))
    return str;
  return '"' + str.replace(/[\\"\x00-\x1f\x7f-\x9f]/g, c => {
    switch (c) {
      case '\\':
        return '\\\\';
      case '"':
        return '\\"';
      case '\b':
        return '\\b';
      case '\f':
        return '\\f';
      case '\n':
        return '\\n';
      case '\r':
        return '\\r';
      case '\t':
        return '\\t';
      default:
        const code = c.charCodeAt(0);
        return '\\x' + code.toString(16).padStart(2, '0');
    }
  }) + '"';
}

function yamlStringNeedsQuotes(str: string): boolean {
  if (str.length === 0)
    return true;

  if (/^\s|\s$/.test(str))
    return true;

  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(str))
    return true;

  if (/^-/.test(str))
    return true;

  if (/[\n:](\s|$)/.test(str))
    return true;

  if (/\s#/.test(str))
    return true;

  if (/[\n\r]/.test(str))
    return true;

  if (/^[&*\],?!>|@"'#%]/.test(str))
    return true;

  if (/[{}`]/.test(str))
    return true;

  if (/^\[/.test(str))
    return true;

  if (!isNaN(Number(str)) || ['y', 'n', 'yes', 'no', 'true', 'false', 'on', 'off', 'null'].includes(str.toLowerCase()))
    return true;

  return false;
}
