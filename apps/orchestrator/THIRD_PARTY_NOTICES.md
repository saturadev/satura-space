# Third-party notices

## Visual Studio Code

The Git view's repository layer, history graph, status decorations are ported
from [microsoft/vscode](https://github.com/microsoft/vscode) (`extensions/git/src/*` and
`src/vs/workbench/contrib/scm/*`):

- `src/main/git/scm/*`
- `src/renderer/src/lib/git/*`
- `src/renderer/src/components/git/git-scm.css`

The editor's inline merge conflict actions and highlighting are ported from the same repository
(`extensions/merge-conflict/src/*`):

- `src/renderer/src/lib/editor/merge-conflict/*`

The Git view's three-way merge editor is ported from the same repository
(`src/vs/workbench/contrib/mergeEditor/*`, with `LineRange` and `TextLength` from
`src/vs/editor/common/core/*` and a few helpers from `src/vs/base/common/*`):

- `src/renderer/src/lib/git/merge/*`
- `src/renderer/src/components/git/merge/*`

The in-app file picker's path box logic (tilde expansion, typed-path navigation, autocomplete,
filters, extension postfix and save/open validation) is adapted from the same repository at tag
`1.95.0` (`src/vs/workbench/services/dialogs/browser/simpleFileDialog.ts`, with `isValidBasename`
from `src/vs/base/common/extpath.ts`):

- `src/shared/file-picker.ts`
- `src/renderer/src/components/ui/FilePicker.tsx`

The editor's TypeScript and TSX highlighting uses the TextMate grammars from the same repository
(`extensions/typescript-basics/syntaxes/*`, converted from microsoft/TypeScript-TmLanguage, MIT) and
the Dark+ token colours from `extensions/theme-defaults/themes/dark_vs.json` and `dark_plus.json`,
run by the `vscode-textmate` and `vscode-oniguruma` packages (MIT):

- `src/renderer/src/lib/editor/textmate/*`

```
MIT License

Copyright (c) 2015 - present Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Floating UI

Hover card positioning (offset, flip, shift, arrow and auto-update) is copied from
[floating-ui/floating-ui](https://github.com/floating-ui/floating-ui) at tag `@floating-ui/dom@1.7.4`
(`packages/core/src`, `packages/dom/src` and `packages/utils/src`), with comments removed and without
the `autoPlacement`, `hide`, `inline` and `size` middleware. It lives in `src/renderer/src/lib/floating-ui/`.

```
MIT License

Copyright (c) 2021 Floating UI contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Orca

The terminal daemon, the pty providers and a few terminal helpers are adapted from
[stablyai/orca](https://github.com/stablyai/orca):

- `src/main/daemon/*`
- `src/main/providers/local-pty-utils.ts`, `process-cwd.ts`, `pty-default-cwd.ts`, `types.ts`
- `src/main/kimi-usage/fetch-remaining.ts`
- `src/shared/terminal-unicode-provider.ts`, `src/shared/process-output-field-scanner.ts`
- `src/renderer/src/lib/tab-tree.ts`, `src/renderer/src/lib/terminal/osc52-clipboard.ts`
- `src/renderer/src/components/workspace/WindowControls.tsx`

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Playwright

`satura_exec` drives app windows with code copied from
[microsoft/playwright](https://github.com/microsoft/playwright) at tag `v1.61.1`, with comments
removed. It lives in `src/main/satura-exec/playwright/`:

- `injected/*` from `packages/injected/src/*`: selector engines, role and text matching, element
  states, hit-target checks, retargeting and aria snapshots. `injectedScript.ts` is trimmed to
  selectors, actions, `ariaSnapshot()` and the `aria-ref` engine (no highlights, recorder, expect
  matchers or selector generation), takes its builtins as an option, and strict-mode errors list
  element previews only. `ariaSnapshot.ts` leaves out the expect matchers, and `ariaNodeElement`
  is exported.
- `isomorphic/*` from `packages/isomorphic/*`: the CSS tokenizer and parser, selector parser, string
  escaping, `getBy*` selector builders and `rtti`. `ariaRole.ts` holds the `AriaRole` type from
  `ariaSnapshot.ts`. `ariaSnapshot.ts` keeps the aria node types and `findNewNode`, without the
  template parser, and `yaml.ts` comes from `packages/injected/src/yaml.ts`.
- `server/input.ts`, `usKeyboardLayout.ts`, `macEditingCommands.ts`, `crInput.ts`, `crDragDrop.ts`
  and `crProtocolHelper.ts` from `packages/playwright-core/src/server/*`: keyboard and mouse state,
  the US layout, macOS editing commands, CDP input dispatch and drag interception. Import paths
  point at local adapters, and `crProtocolHelper.ts` keeps only the input helpers.
- `server/dom.ts` and `server/frames.ts` from `packages/playwright-core/src/server/dom.ts` and
  `frames.ts`: the retrying click, hover, fill, type, press and drag flows, scrolling into view,
  clickable points, and waiting for selectors. Only the main frame is supported, and the parts for
  files, select, check, tap, tracing and locator handlers are left out.
- `client/locator.ts` from `packages/playwright-core/src/client/locator.ts`: the `Locator`
  selector builders, with actions sent to the app instead of a Playwright connection.
- `server/types.ts` copies the input and action option types.

`server/cdp.ts`, `server/js.ts`, `server/page.ts`, `server/progress.ts`, `server/injectedTypes.ts`
and `client/frame.ts` are written for this app and connect the copied code to Electron's
`webContents.debugger`.

```
Playwright
Copyright (c) Microsoft Corporation

This software contains code derived from the Puppeteer project (https://github.com/puppeteer/puppeteer),
available under the Apache 2.0 license (https://github.com/puppeteer/puppeteer/blob/master/LICENSE).
```

```
                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Portions Copyright (c) Microsoft Corporation.
   Portions Copyright 2017 Google Inc.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
```

## QR Code generator library

The pairing QR encoder in `src/renderer/src/lib/qr.ts` is a byte-mode port of
[Project Nayuki's QR Code generator](https://www.nayuki.io/page/qr-code-generator-library) (TypeScript).

Copyright (c) Project Nayuki. MIT License.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions: The above copyright notice and this
permission notice shall be included in all copies or substantial portions of the Software.

The Software is provided "as is", without warranty of any kind, express or implied, including but
not limited to the warranties of merchantability, fitness for a particular purpose and
noninfringement. In no event shall the authors or copyright holders be liable for any claim,
damages or other liability, whether in an action of contract, tort or otherwise, arising from, out
of or in connection with the Software or the use or other dealings in the Software.

## Material product sounds

The chime alert sounds (`src/renderer/src/assets/sounds/chime-*.wav`) are "Material product sounds"
by Google, licensed under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/legalcode). They
were taken from [MaxHalford/chime](https://github.com/MaxHalford/chime) (`chime/themes/material`).

## Noto Sans Symbols, Noto Sans Symbols 2 and Noto Sans Math

The phone terminal's symbol fallback font (`src/renderer/src/assets/fonts/satura-term-symbols-*.woff2`,
family `Satura Term Symbols`) is a subset of [Noto Sans Symbols](https://github.com/notofonts/symbols),
Noto Sans Symbols 2 and [Noto Sans Math](https://github.com/notofonts/math).

Copyright 2022 The Noto Project Authors (https://github.com/notofonts/symbols).
Copyright 2022 The Noto Project Authors (https://github.com/notofonts/math).

```
This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```

## Harmony and the .NET libraries in the Unity engine

`packages/saturaspace-engine/HotReload/Editor/Libs/SaturaSpace.Vendor.*.dll` are renamed builds of
the binaries in `tools/engine-vendor/upstream` (see `tools/engine-vendor/README.md`), all under the
MIT License below:

- [Lib.Harmony](https://github.com/pardeike/Harmony) 2.4.2: Copyright (c) 2017 Andreas Pardeike.
  It bundles [MonoMod](https://github.com/MonoMod/MonoMod) (Copyright (c) 2015 0x0ade and the
  MonoMod contributors), [Mono.Cecil](https://github.com/jbevain/cecil) (Copyright (c) 2008 - 2015
  Jb Evain, Copyright (c) 2008 - 2011 Novell, Inc.) and [Iced](https://github.com/icedland/iced)
  (Copyright (c) 2018-present iced project and contributors).
- [Microsoft.CodeAnalysis and Microsoft.CodeAnalysis.CSharp](https://github.com/dotnet/roslyn)
  4.8.0, [System.Collections.Immutable, System.Reflection.Metadata and
  System.Runtime.CompilerServices.Unsafe](https://github.com/dotnet/runtime): Copyright (c) .NET
  Foundation and Contributors.

```
The MIT License (MIT)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
associated documentation files (the "Software"), to deal in the Software without restriction,
including without limitation the rights to use, copy, modify, merge, publish, distribute,
sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or
substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT
OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## Inter and JetBrains Mono

The interface font (`src/renderer/src/assets/fonts/inter-*.woff2`) is
[Inter](https://github.com/rsms/inter), and the code and terminal font
(`src/renderer/src/assets/fonts/jetbrains-mono-*.woff2`) is
[JetBrains Mono](https://github.com/JetBrains/JetBrainsMono).

Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter).
Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono).

Both are licensed under the SIL Open Font License, Version 1.1, the same license as the Noto fonts
above; its full text is in that section and at https://openfontlicense.org.

## meshoptimizer

The landing-page demo recorder (`src/landing-demos/record/vendor/meshopt_encoder.mjs`) is the
encoder build of [meshoptimizer](https://github.com/zeux/meshoptimizer) 1.1.

Copyright (c) 2016-2026 Arseny Kapoulkine. Licensed under the MIT License; the full text is in
`src/landing-demos/record/vendor/meshopt_LICENSE.md`.
