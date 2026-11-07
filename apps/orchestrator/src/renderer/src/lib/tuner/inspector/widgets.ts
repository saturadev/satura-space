import type { TiStyle } from '@shared/tuner-inspector'
import { isTmpSectionHeader } from './tmp-styles'

export type Widget =
  | 'label'
  | 'boldLabel'
  | 'miniLabel'
  | 'title'
  | 'field'
  | 'boldField'
  | 'popup'
  | 'button'
  | 'miniButton'
  | 'toggle'
  | 'foldout'
  | 'titlebarFoldout'
  | 'titlebar'
  | 'bigTitle'
  | 'iconButton'
  | 'paneOptions'
  | 'helpBox'
  | 'sliderTrack'
  | 'sliderThumb'
  | 'box'
  | 'listHeader'
  | 'listBackground'
  | 'listFooter'
  | 'listFooterButton'
  | 'listElement'
  | 'dragHandle'
  | 'progressBack'
  | 'progressBar'
  | 'moduleTitle'
  | 'objectPicker'
  | 'objectThumbMini'
  | 'objectThumb'
  | 'objectThumbSelect'
  | 'dropdownArrow'
  | 'linkButton'
  | 'colorField'
  | 'searchField'
  | 'toolbar'
  | 'plusButton'
  | 'tab'
  | 'command'
  | 'tmpSectionHeader'
  | 'none'
  | 'generic'

const TABLE: Record<string, Widget> = {
  label: 'label',
  controllabel: 'label',
  prefixlabel: 'label',
  wordwrappedlabel: 'label',
  rightlabel: 'label',
  centeredlabel: 'label',
  whitelabel: 'label',
  errorlabel: 'label',
  linklabel: 'label',
  shurikenlabel: 'label',
  selectablelabel: 'label',
  progressbartext: 'label',
  boldlabel: 'boldLabel',
  whiteboldlabel: 'boldLabel',
  whitelargelabel: 'boldLabel',
  headerlabel: 'boldLabel',
  minilabel: 'miniLabel',
  miniboldlabel: 'miniLabel',
  centeredgreyminilabel: 'miniLabel',
  wordwrappedminilabel: 'miniLabel',
  whiteminilabel: 'miniLabel',
  minilabelright: 'miniLabel',
  greyminilabel: 'miniLabel',
  intitletext: 'title',
  textfield: 'field',
  textarea: 'field',
  minitextfield: 'field',
  numberfield: 'field',
  shurikenvalue: 'field',
  objectfield: 'field',
  objectfieldminithumb: 'objectThumbMini',
  objectfieldthumb: 'objectThumb',
  objectfieldthumboverlay: 'miniLabel',
  objectfieldthumboverlay2: 'objectThumbSelect',
  shurikenobjectfield: 'field',
  textfielddropdowntext: 'field',
  boldtextfield: 'boldField',
  minipopup: 'popup',
  popup: 'popup',
  minipulldown: 'popup',
  dropdown: 'popup',
  dropdownbutton: 'popup',
  shurikenpopup: 'popup',
  shurikendropdown: 'popup',
  toolbarpopup: 'popup',
  toolbardropdown: 'popup',
  minitoolbarpopup: 'popup',
  toolbarpopupleft: 'popup',
  button: 'button',
  largebutton: 'button',
  acbutton: 'button',
  buttonleft: 'button',
  buttonmid: 'button',
  buttonright: 'button',
  minibutton: 'miniButton',
  minibuttonleft: 'miniButton',
  minibuttonmid: 'miniButton',
  minibuttonright: 'miniButton',
  toolbarbutton: 'miniButton',
  toolbarbuttonleft: 'miniButton',
  toolbarbuttonright: 'miniButton',
  toggle: 'toggle',
  shurikentoggle: 'toggle',
  oltoggle: 'toggle',
  togglemixed: 'toggle',
  menuitem: 'toggle',
  menuitemmixed: 'toggle',
  shurikencheckmark: 'toggle',
  shurikencheckmarkmixed: 'toggle',
  foldout: 'foldout',
  foldoutheader: 'foldout',
  foldoutpredrop: 'foldout',
  shurikenfoldout: 'foldout',
  infoldout: 'foldout',
  titlebarfoldout: 'titlebarFoldout',
  intitle: 'titlebar',
  inspectortitlebar: 'titlebar',
  inbigtitle: 'bigTitle',
  inbigtitlepost: 'bigTitle',
  inbigtitleinner: 'bigTitle',
  iconbutton: 'iconButton',
  paneoptions: 'paneOptions',
  helpbox: 'helpBox',
  horizontalslider: 'sliderTrack',
  verticalslider: 'sliderTrack',
  horizontalsliderthumb: 'sliderThumb',
  verticalsliderthumb: 'sliderThumb',
  horizontalsliderthumbextent: 'none',
  verticalsliderthumbextent: 'none',
  box: 'box',
  groupbox: 'box',
  olbox: 'box',
  framebox: 'box',
  shurikeneffectbg: 'box',
  shurikenmodulebg: 'box',
  rlheader: 'listHeader',
  rlemptyheader: 'listHeader',
  rlbackground: 'listBackground',
  rlfooter: 'listFooter',
  rlfooterbutton: 'listFooterButton',
  rlelement: 'listElement',
  rldraghandle: 'dragHandle',
  progressbarback: 'progressBack',
  progressbarbar: 'progressBar',
  shurikenmoduletitle: 'moduleTitle',
  shurikenemittertitle: 'moduleTitle',
  objectfieldbutton: 'objectPicker',
  staticdropdown: 'dropdownArrow',
  floatfieldlinkbutton: 'linkButton',
  colorfield: 'colorField',
  colorpickerbox: 'colorField',
  searchtextfield: 'searchField',
  toolbarsearchtextfield: 'searchField',
  toolbarseachtextfield: 'searchField',
  toolbar: 'toolbar',
  shurikenplus: 'plusButton',
  shurikenminus: 'plusButton',
  pretoolbar: 'toolbar',
  pretoolbar2: 'boldLabel',
  pretoolbarlabel: 'boldLabel',
  prebackground: 'box',
  prebutton: 'miniButton',
  predropdown: 'popup',
  preslider: 'sliderTrack',
  presliderthumb: 'sliderThumb',
  prelabel: 'label',
  preminilabel: 'miniLabel',
  preoverlaylabel: 'miniLabel',
  largelabel: 'title',
  tab: 'tab',
  tabfirst: 'tab',
  tabmiddle: 'tab',
  tablast: 'tab',
  tabonlyone: 'tab',
  command: 'command',
  commandleft: 'command',
  commandmid: 'command',
  commandright: 'command',
  editmodesinglebutton: 'command',
  appcommand: 'command',
  appcommandleft: 'command',
  appcommandmid: 'command',
  appcommandright: 'command'
}

export function styleHasBg(style: TiStyle): boolean {
  return Object.values(style.s).some((x) => x && (x.hb || x.bg !== undefined || x.bg2 !== undefined))
}

export function widgetFor(styleName: string, hasBackground: boolean, hasText: boolean): Widget {
  if (isTmpSectionHeader(styleName)) return 'tmpSectionHeader'
  const key = styleName.toLowerCase().replace(/[\s_-]+/g, '')
  const hit = TABLE[key]
  if (hit) return hit
  if (/label$/.test(key)) return key.includes('mini') ? 'miniLabel' : key.includes('bold') ? 'boldLabel' : 'label'
  if (/textfield|textarea|numberfield/.test(key)) return 'field'
  if (/popup|dropdown|pulldown/.test(key)) return 'popup'
  if (/button/.test(key)) return key.includes('mini') || key.includes('toolbar') ? 'miniButton' : 'button'
  if (/toggle|checkmark/.test(key)) return 'toggle'
  if (/foldout/.test(key)) return 'foldout'
  if (/box|background|bg$/.test(key)) return 'box'
  if (hasBackground) return 'generic'
  return hasText ? 'label' : 'none'
}

export type ChromeIcon =
  | 'help'
  | 'preset'
  | 'menu'
  | 'dropdown'
  | 'warning'
  | 'info'
  | 'error'
  | 'plus'
  | 'minus'
  | 'link'
  | 'unlink'
  | 'search'
  | 'close'
  | 'refresh'
  | 'settings'
  | 'picker'

export function chromeIconFor(textureName: string | undefined): ChromeIcon | null {
  if (!textureName) return null
  const n = textureName.replace(/^d_/, '').replace(/@\dx$/, '').toLowerCase()
  if (n === '_help' || n === 'help' || n.startsWith('_help')) return 'help'
  if (n.startsWith('preset.context') || n === 'preset') return 'preset'
  if (n === '_menu' || n === '_popup' || n === 'pane options') return 'menu'
  if (n === 'icon dropdown' || n === 'dropdown' || n.startsWith('dropdown')) return 'dropdown'
  if (n.startsWith('console.warnicon')) return 'warning'
  if (n.startsWith('console.infoicon')) return 'info'
  if (n.startsWith('console.erroricon')) return 'error'
  if (n.startsWith('toolbar plus') || n === 'ol plus' || n === 'iconToolbarPlus'.toLowerCase()) return 'plus'
  if (n.startsWith('toolbar minus') || n === 'ol minus' || n === 'iconToolbarMinus'.toLowerCase()) return 'minus'
  if (n === 'linked') return 'link'
  if (n === 'unlinked') return 'unlink'
  if (n.startsWith('search icon') || n === 'search') return 'search'
  if (n.startsWith('winbtn_win_close') || n === 'clear') return 'close'
  if (n === 'refresh') return 'refresh'
  if (n === 'settings' || n === 'settingsicon' || n === '_popup') return 'settings'
  if (n.startsWith('pick')) return 'picker'
  return null
}
