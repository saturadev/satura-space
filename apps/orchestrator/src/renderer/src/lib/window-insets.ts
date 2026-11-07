export const TRAFFIC_LIGHT_INSET = 80
export const WINDOW_CONTROLS_INSET = 132
export const TITLE_BAR_HEIGHT = 38

let chromeOverride: 'mac' | 'win' | null | undefined

export function setWindowChrome(chrome: 'mac' | 'win' | null): void {
  chromeOverride = chrome
}

export function windowChromeOverride(): 'mac' | 'win' | null | undefined {
  return chromeOverride
}
