import reactIndex from '@react-types/index.d.ts?raw'
import reactGlobal from '@react-types/global.d.ts?raw'
import reactJsxRuntime from '@react-types/jsx-runtime.d.ts?raw'
import csstype from '@csstype/index.d.ts?raw'
import kit from '@shared/report-kit.d.ts?raw'
import dashboardKit from '@shared/dashboard-kit.d.ts?raw'
import dashboardAlert from '@shared/dashboard-alert.d.ts?raw'

export const TYPES_ROOT = '/__satura_report_types__'

export const LIB_ROOT = `${TYPES_ROOT}/ts-lib`

const libFiles = import.meta.glob('@ts-lib/lib.{es,dom,decorators}*.d.ts', { query: '?raw', import: 'default', eager: true })

export const TYPE_FILES: Record<string, string> = {
  [`${TYPES_ROOT}/react/index.d.ts`]: reactIndex,
  [`${TYPES_ROOT}/react/global.d.ts`]: reactGlobal,
  [`${TYPES_ROOT}/react/jsx-runtime.d.ts`]: reactJsxRuntime,
  [`${TYPES_ROOT}/csstype/index.d.ts`]: csstype,
  [`${TYPES_ROOT}/satura-report/index.d.ts`]: kit,
  [`${TYPES_ROOT}/satura-dashboard/index.d.ts`]: dashboardKit,
  [`${TYPES_ROOT}/satura-dashboard-alert/index.d.ts`]: dashboardAlert,
  ...Object.fromEntries(Object.entries(libFiles).map(([path, text]) => [`${LIB_ROOT}/${path.slice(path.lastIndexOf('/') + 1)}`, text]))
}

export const MODULES: Record<string, string> = {
  react: `${TYPES_ROOT}/react/index.d.ts`,
  'react/jsx-runtime': `${TYPES_ROOT}/react/jsx-runtime.d.ts`,
  csstype: `${TYPES_ROOT}/csstype/index.d.ts`,
  '@satura/report': `${TYPES_ROOT}/satura-report/index.d.ts`,
  '@satura/dashboard': `${TYPES_ROOT}/satura-dashboard/index.d.ts`,
  '@satura/dashboard/alert': `${TYPES_ROOT}/satura-dashboard-alert/index.d.ts`
}
