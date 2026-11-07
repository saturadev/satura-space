import type { CSSProperties } from 'react'

export const TMP_SECTION_HEADER = 'TMP SectionHeader'

export function isTmpSectionHeader(styleName: string): boolean {
  return styleName === TMP_SECTION_HEADER
}

export function isTmpIcon(textureName: string | undefined): boolean {
  return !!textureName && /^btn_Align/i.test(textureName)
}

export function tmpIconMask(url: string, w: number, h: number): CSSProperties {
  const mask = `url(${url})`
  return {
    width: w,
    height: h,
    flexShrink: 0,
    backgroundColor: 'currentColor',
    WebkitMaskImage: mask,
    maskImage: mask,
    WebkitMaskSize: '100% 100%',
    maskSize: '100% 100%',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat'
  }
}

export function tmpSectionHeaderBox(overflow: [number, number, number, number] | undefined, w: number, h: number): CSSProperties {
  const o = overflow ?? [0, 0, 0, 0]
  return { position: 'absolute', left: -o[0] || 0, top: -o[2] || 0, width: w + o[0] + o[1], height: h + o[2] + o[3] }
}
