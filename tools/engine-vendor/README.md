# Engine vendor libraries

The hot reload and exec code in `packages/saturaspace-engine` runs on Harmony and Roslyn. A Unity
project can bring its own copies of those (a mod loader's `0Harmony.dll`, an analyzer package's
`Microsoft.CodeAnalysis`, another `System.Collections.Immutable`), and two assemblies with one name
can't coexist in the editor. So the engine never ships them under their own names.

`upstream/` holds the original binaries. `vendor.mjs` rewrites them with Mono.Cecil
(`tools/ilfixup vendor`) into `packages/saturaspace-engine/HotReload/Editor/Libs/`:

| upstream | shipped as |
|---|---|
| `0Harmony.dll` (Lib.Harmony 2.4.2, metadata-repaired) | `SaturaSpace.Vendor.Harmony.dll` |
| `Microsoft.CodeAnalysis.dll` 4.8.0 | `SaturaSpace.Vendor.Microsoft.CodeAnalysis.dll` |
| `Microsoft.CodeAnalysis.CSharp.dll` 4.8.0 | `SaturaSpace.Vendor.Microsoft.CodeAnalysis.CSharp.dll` |
| `System.Collections.Immutable.dll` 7.0 | `SaturaSpace.Vendor.System.Collections.Immutable.dll` |
| `System.Reflection.Metadata.dll` 7.0 | `SaturaSpace.Vendor.System.Reflection.Metadata.dll` |
| `System.Runtime.CompilerServices.Unsafe.dll` 6.0 | `SaturaSpace.Vendor.System.Runtime.CompilerServices.Unsafe.dll` |

The rewrite renames each assembly, drops its strong name, prefixes every namespace with
`SaturaSpace.Vendor.` (except internal compiler attribute polyfills under
`System.Runtime.CompilerServices`, `System.Diagnostics.CodeAnalysis` and friends, and the
`FxResources.*` resource anchors), moves `.resources` named after a renamed type, rewrites
`InternalsVisibleTo` between the set, and fails if any public type or reference keeps an original
name. It also lets `SaturaSpace.HotReload.Editor` see Harmony's internals, for its bundled Cecil.

The app ships these renamed DLLs next to the engine source.

Code that reaches these libraries by name uses the new names: `MCPTestBridge.Harmony.cs`, the
Detourer, and `GeneratorRebind`, which rewrites a project's Roslyn source generators onto the
vendored Roslyn before hot reload runs them. MCP exec snippets patch through
`HotReloadPrototype.Editor.ExecHarmony` instead of `HarmonyLib`.

## Updating a library

Replace the file in `upstream/`, then run `node tools/engine-vendor/vendor.mjs` and commit the
regenerated `Libs/*.dll`. The `.dll.meta` files stay as they are.

Harmony: every official fat build ships invalid metadata. ILRepack leaves orphaned `TypeRef` rows
whose `ResolutionScope` points at deleted `AssemblyRef` rows
([pardeike/Harmony#636](https://github.com/pardeike/Harmony/issues/636),
[#728](https://github.com/pardeike/Harmony/issues/728)), and Unity Burst dies on it with
`BadImageFormatException: Read out of bounds`. Repair a new `0Harmony.dll` before it goes into
`upstream/`, and verify the vendored output too:

```sh
cd tools/harmony-metadata-repair
dotnet run -c Release -- patch <new-0Harmony.dll>
dotnet run -c Release -- verify ../../packages/saturaspace-engine/HotReload/Editor/Libs/SaturaSpace.Vendor.Harmony.dll
```

`verify` must report 0 failures.
