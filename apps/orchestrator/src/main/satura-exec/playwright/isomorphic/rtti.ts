export { isString } from  './stringUtils';

export function isRegExp(obj: any): obj is RegExp {
  return obj instanceof RegExp || Object.prototype.toString.call(obj) === '[object RegExp]';
}

export function isRegexString(value: string): boolean {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

export function isObject(obj: any): obj is NonNullable<object> {
  return typeof obj === 'object' && obj !== null;
}

export function isError(obj: any): obj is Error {
  return obj instanceof Error || (obj && Object.getPrototypeOf(obj)?.name === 'Error');
}
