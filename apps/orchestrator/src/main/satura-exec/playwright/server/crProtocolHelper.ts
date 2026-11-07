import type { CRSession, Protocol } from './cdp';
import type * as types from './types';

export function getExceptionMessage(exceptionDetails: Protocol.Runtime.ExceptionDetails): string {
  if (exceptionDetails.exception)
    return exceptionDetails.exception.description || String(exceptionDetails.exception.value);
  let message = exceptionDetails.text;
  if (exceptionDetails.stackTrace) {
    for (const callframe of exceptionDetails.stackTrace.callFrames) {
      const location = callframe.url + ':' + callframe.lineNumber + ':' + callframe.columnNumber;
      const functionName = callframe.functionName || '<anonymous>';
      message += `\n    at ${functionName} (${location})`;
    }
  }
  return message;
}

export async function releaseObject(client: CRSession, objectId: string) {
  await client.send('Runtime.releaseObject', { objectId }).catch(error => { });
}

export function toModifiersMask(modifiers: Set<types.KeyboardModifier>): number {
  let mask = 0;
  if (modifiers.has('Alt'))
    mask |= 1;
  if (modifiers.has('Control'))
    mask |= 2;
  if (modifiers.has('Meta'))
    mask |= 4;
  if (modifiers.has('Shift'))
    mask |= 8;
  return mask;
}

export function toButtonsMask(buttons: Set<types.MouseButton>): number {
  let mask = 0;
  if (buttons.has('left'))
    mask |= 1;
  if (buttons.has('right'))
    mask |= 2;
  if (buttons.has('middle'))
    mask |= 4;
  return mask;
}
