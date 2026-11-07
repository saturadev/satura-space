import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { IStandaloneThemeService } from 'monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js'
import { registerColor, transparent } from 'monaco-editor/esm/vs/platform/theme/common/colorUtils.js'
import { mergeCurrentHeaderBackground, mergeIncomingHeaderBackground } from 'monaco-editor/esm/vs/platform/theme/common/colors/editorColors.js'

export const diff = registerColor(
  'mergeEditor.change.background',
  '#9bb95533',
  'The background color for changes.'
)

export const diffWord = registerColor(
  'mergeEditor.change.word.background',
  { dark: '#9ccc2c33', light: '#9ccc2c66', hcDark: '#9ccc2c33', hcLight: '#9ccc2c66', },
  'The background color for word changes.'
)

export const diffBase = registerColor(
  'mergeEditor.changeBase.background',
  { dark: '#4B1818FF', light: '#FFCCCCFF', hcDark: '#4B1818FF', hcLight: '#FFCCCCFF', },
  'The background color for changes in base.'
)

export const diffWordBase = registerColor(
  'mergeEditor.changeBase.word.background',
  { dark: '#6F1313FF', light: '#FFA3A3FF', hcDark: '#6F1313FF', hcLight: '#FFA3A3FF', },
  'The background color for word changes in base.'
)

export const conflictBorderUnhandledUnfocused = registerColor(
  'mergeEditor.conflict.unhandledUnfocused.border',
  { dark: '#ffa6007a', light: '#ffa600FF', hcDark: '#ffa6007a', hcLight: '#ffa6007a', },
  'The border color of unhandled unfocused conflicts.'
)

export const conflictBorderUnhandledFocused = registerColor(
  'mergeEditor.conflict.unhandledFocused.border',
  '#ffa600',
  'The border color of unhandled focused conflicts.'
)

export const conflictBorderHandledUnfocused = registerColor(
  'mergeEditor.conflict.handledUnfocused.border',
  '#86868649',
  'The border color of handled unfocused conflicts.'
)

export const conflictBorderHandledFocused = registerColor(
  'mergeEditor.conflict.handledFocused.border',
  '#c1c1c1cc',
  'The border color of handled focused conflicts.'
)

export const handledConflictMinimapOverViewRulerColor = registerColor(
  'mergeEditor.conflict.handled.minimapOverViewRuler',
  '#adaca8ee',
  'The foreground color for changes in input 1.'
)

export const unhandledConflictMinimapOverViewRulerColor = registerColor(
  'mergeEditor.conflict.unhandled.minimapOverViewRuler',
  '#fcba03FF',
  'The foreground color for changes in input 1.'
)

export const conflictingLinesBackground = registerColor(
  'mergeEditor.conflictingLines.background',
  '#ffea0047',
  'The background of the "Conflicting Lines" text.'
)

const contentTransparency = 0.4
export const conflictInput1Background = registerColor(
  'mergeEditor.conflict.input1.background',
  transparent(mergeCurrentHeaderBackground, contentTransparency),
  'The background color of decorations in input 1.'
)

export const conflictInput2Background = registerColor(
  'mergeEditor.conflict.input2.background',
  transparent(mergeIncomingHeaderBackground, contentTransparency),
  'The background color of decorations in input 2.'
)

StandaloneServices.get(IStandaloneThemeService).setColorMapOverride(null)
