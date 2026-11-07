import { Fragment, useEffect, type ComponentType, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { visibleUsageProviders } from '@shared/types'
import type { UsageProvider } from '@shared/api'
import { useAppStore } from '../../store'
import { ClaudeUsageButton } from './ClaudeUsageButton'
import { CodexUsageButton } from './CodexUsageButton'
import { KimiUsageButton } from './KimiUsageButton'
import { ResourceManagerButton } from '../resource-manager/ResourceManagerButton'

const USAGE_BUTTONS: Record<UsageProvider, ComponentType> = {
  claude: ClaudeUsageButton,
  codex: CodexUsageButton,
  kimi: KimiUsageButton
}

function Separator() {
  return <span className="mx-1 h-4 w-px shrink-0 bg-white/[0.08]" aria-hidden="true" />
}

export function BottomBar({ trailing }: { trailing?: ReactNode }) {
  const providers = useAppStore(
    useShallow((s) => (s.settings ? visibleUsageProviders(s.settings.hiddenUsageProviders) : []))
  )
  useEffect(
    () =>
      window.api.usage.onChanged(({ usage }) =>
        useAppStore.setState({
          ...(usage.claude && { claudeUsageRemaining: usage.claude }),
          ...(usage.codex && { codexUsageRemaining: usage.codex }),
          ...(usage.kimi && { kimiUsageRemaining: usage.kimi })
        })
      ),
    []
  )

  return (
    <div className="flex h-7 shrink-0 items-center justify-between bg-window px-2 text-xs" data-status-bar>
      <div className="flex min-w-0 items-center">
        {providers.map((provider, i) => {
          const Button = USAGE_BUTTONS[provider]
          return (
            <Fragment key={provider}>
              {i > 0 && <Separator />}
              <Button />
            </Fragment>
          )
        })}
      </div>
      <div className="flex shrink-0 items-center">
        <ResourceManagerButton />
        {trailing && (
          <>
            <Separator />
            {trailing}
          </>
        )}
      </div>
    </div>
  )
}
