# Satura Space Engine

The runtime that powers Satura Space inside your Unity project, and the API game code uses for it:
`[SaturaHandle]` for the methods agents call, `SaturaLog` for tagged log files and `SaturaStaging`
for staging prefabs.

**This package is managed for you.** The Satura Space app embeds it and keeps it in step
with the app version. It's hidden from git through `.git/info/exclude`, its assemblies compile
only in the editor, so they never reach a player build, and it does nothing in an editor that
Satura Space didn't launch. Deleting it is safe — the app restores it the next time it opens
the project.

Game code that uses it goes inside `#if UNITY_EDITOR && SATURA_SPACE`, so the project still compiles
in plain Unity without it. The app defines `SATURA_SPACE` in its own `Assets/csc.rsp`.

The scripting define `SATURA_REMOTE_GAMEPAD` also compiles `SaturaSpace.Sdk.RemoteGamepad`, an
Editor-only virtual gamepad that the Satura Remote phone app can drive.

Licensed under Apache-2.0. Source: https://github.com/saturadev/satura-space
