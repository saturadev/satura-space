import { defaultSchema } from 'rehype-sanitize'

const def = defaultSchema
const attrs = def.attributes ?? {}

export const markdownSanitizeSchema = {
  ...def,
  tagNames: [
    ...(def.tagNames ?? []),
    'details',
    'summary',
    'kbd',
    'sub',
    'sup',
    'ins',
    'span',
    'div'
  ],
  attributes: {
    ...attrs,
    '*': [...(attrs['*'] ?? []), 'id', 'className', 'align'],
    th: [...(attrs.th ?? []), 'align'],
    td: [...(attrs.td ?? []), 'align']
  }
}
