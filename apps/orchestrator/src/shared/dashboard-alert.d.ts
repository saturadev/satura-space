export interface AlertConfig<T = any> {
  every: number
  fetch?: { url: string; method?: string; headers?: Record<string, string>; body?: string; as?: 'json' | 'text' }
  handle?: { name: string; args?: unknown[]; player?: string }
  git?: { log?: number; status?: boolean }
  logs?: { source?: 'unity' | 'app'; grep?: string; tail?: number }
  when: (data: T) => string | null | undefined | false
  cooldown?: number
  to?: 'agent' | 'new'
}

export function alert<T = any>(config: AlertConfig<T>): AlertConfig<T>
