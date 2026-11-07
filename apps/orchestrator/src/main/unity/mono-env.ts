const INLINE_OPT = '--optimize=-inline'

export function withMonoInlineDisabled(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.SATURA_KEEP_MONO_INLINE === '1') return env
  const existing = env.MONO_ENV_OPTIONS?.trim()
  const monoEnvOptions =
    existing && !existing.includes(INLINE_OPT) ? `${existing} ${INLINE_OPT}` : existing || INLINE_OPT
  return { ...env, MONO_INLINELIMIT: '0', MONO_ENV_OPTIONS: monoEnvOptions }
}
