export function removeInheritedNoColor(env: Record<string, string>): void {
  // A terminal emulator must not inherit parent-process flags used to keep build
  // logs plain. Login-shell startup files can still opt out of color explicitly.
  delete env.NO_COLOR
  if (env.FORCE_COLOR === '0') delete env.FORCE_COLOR
  if (env.CLICOLOR === '0') delete env.CLICOLOR
}
