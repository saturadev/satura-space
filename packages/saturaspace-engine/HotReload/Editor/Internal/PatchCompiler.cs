using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Text.RegularExpressions;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.CSharp;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.CSharp.Syntax;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.Emit;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.Text;
using UnityEngine;
using UnityCompilation = UnityEditor.Compilation.CompilationPipeline;
using UnityAssembly = UnityEditor.Compilation.Assembly;
using AssembliesType = UnityEditor.Compilation.AssembliesType;

namespace HotReloadPrototype.Editor {
    internal sealed class PatchCompiler {
        public readonly string targetAssemblyName;
        public bool Ready { get; private set; }

        static readonly ConcurrentDictionary<string, MetadataReference> referenceCache =
            new ConcurrentDictionary<string, MetadataReference>(StringComparer.OrdinalIgnoreCase);

        CSharpParseOptions parseOptions;
        CSharpCompilationOptions compilationOptions;
        readonly List<MetadataReference> references = new List<MetadataReference>();
        readonly Dictionary<string, SyntaxTree> treesByPath = new Dictionary<string, SyntaxTree>();
        readonly List<string> orderedKeys = new List<string>();
        readonly List<ISourceGenerator> generators = new List<ISourceGenerator>();
        readonly object sync = new object();

        public PatchCompiler(string targetAssemblyName = "Assembly-CSharp") {
            this.targetAssemblyName = targetAssemblyName;
        }

        public string Initialize(Func<string, string> baselineTextFor = null) {
            UnityAssembly target = UnityCompilation
                .GetAssemblies(AssembliesType.Editor)
                .FirstOrDefault(a => a.name == targetAssemblyName);
            if (target == null) return $"assembly '{targetAssemblyName}' not found in the project";

            parseOptions = new CSharpParseOptions(LanguageVersion.CSharp9, preprocessorSymbols: ResponseFileDefines.With(target.defines));

            treesByPath.Clear();
            orderedKeys.Clear();
            var ordered = target.sourceFiles
                .Select(f => new { full = ToFullPath(f), key = HotReloadPaths.Norm(f) })
                .Where(x => File.Exists(x.full))
                .OrderBy(x => x.full, StringComparer.Ordinal);
            foreach (var x in ordered) {
                if (treesByPath.ContainsKey(x.key)) continue;
                treesByPath[x.key] = ParseFrom(x.full, baselineTextFor?.Invoke(x.key));
                orderedKeys.Add(x.key);
            }

            BuildReferences(target);
            LoadGenerators(target);

            compilationOptions = new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                allowUnsafe: true,
                optimizationLevel: OptimizationLevel.Debug,
                platform: Platform.AnyCpu,
                assemblyIdentityComparer: DesktopAssemblyIdentityComparer.Default);

            Ready = true;
            return null;
        }

        public void Prewarm() {
            if (!Ready) return;
            try {
                SyntaxTree[] trees;
                lock (sync) {
                    if (orderedKeys.Count == 0) return;
                    trees = OrderedTrees().ToArray();
                }
                var c = CSharpCompilation.Create("warmup", trees, references, compilationOptions);
                c = RunGenerators(c);
                using (var pe = new MemoryStream()) c.Emit(pe);
            } catch (Exception e) {
                Debug.LogWarning($"[HotReload] prewarm emit failed (non-fatal): {e.Message}");
            }
        }

        public sealed class Result {
            public bool ok;
            public byte[] peBytes;
            public byte[] pdbBytes;
            public readonly List<string> changedTypeMetadataNames = new List<string>();
            public readonly List<string> changedMethodKeys = new List<string>();
            public readonly List<string> changedStateMachineKeys = new List<string>();
            public readonly List<string> errors = new List<string>();
            public string note;
        }

        public Result CompilePatch(string changedFullPath) {
            var r = new Result();
            if (!Ready) { r.note = "compiler not initialized"; return r; }

            string rel = HotReloadPaths.Norm(HotReloadPaths.MakeProjectRelative(changedFullPath));
            SyntaxTree oldTree;
            lock (sync) {
                if (!treesByPath.TryGetValue(rel, out oldTree)) {
                    r.note = $"'{rel}' is not part of {targetAssemblyName} (skipped)";
                    return r;
                }
            }

            SyntaxTree newTree;
            try { newTree = Parse(changedFullPath); } catch (Exception e) { r.errors.Add(e.Message); return r; }

            SyntaxTree[] patchTrees;
            lock (sync) patchTrees = AllTreesWith(rel, newTree).ToArray();
            var patch = CSharpCompilation.Create(targetAssemblyName + ".patch", patchTrees, references, compilationOptions);

            CollectDeclaredTypeNames(patch, newTree, r.changedTypeMetadataNames);
            try {
                CollectChangedMethodKeys(oldTree, newTree, patch, r.changedMethodKeys, r.changedStateMachineKeys);
            } catch (Exception e) {
                Debug.LogWarning($"[HotReload] changed-method diff failed (non-fatal): {e.Message}");
            }

            patch = RunGenerators(patch);

            using (var pe = new MemoryStream())
            using (var pdb = new MemoryStream()) {
                EmitResult emit = patch.Emit(pe, pdb,
                    options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
                if (!emit.Success) {
                    foreach (var d in emit.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(20))
                        r.errors.Add(d.ToString());
                    return r;
                }
                r.peBytes = pe.ToArray();
                r.pdbBytes = pdb.ToArray();
                r.ok = true;
                lock (sync) treesByPath[rel] = newTree;
                return r;
            }
        }

        SyntaxTree Parse(string fullPath) {
            var text = SourceText.From(File.ReadAllText(fullPath), Encoding.UTF8);
            return CSharpSyntaxTree.ParseText(text, parseOptions, path: fullPath);
        }

        SyntaxTree ParseFrom(string fullPath, string baselineText) {
            if (baselineText == null) return Parse(fullPath);
            var text = SourceText.From(baselineText, Encoding.UTF8);
            return CSharpSyntaxTree.ParseText(text, parseOptions, path: fullPath);
        }

        IEnumerable<SyntaxTree> OrderedTrees() {
            foreach (var key in orderedKeys) yield return treesByPath[key];
        }

        IEnumerable<SyntaxTree> AllTreesWith(string changedRel, SyntaxTree replacement) {
            foreach (var key in orderedKeys)
                yield return key == changedRel ? replacement : treesByPath[key];
        }

        void CollectDeclaredTypeNames(Compilation comp, SyntaxTree tree, List<string> into) {
            var model = comp.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes().OfType<BaseTypeDeclarationSyntax>()) {
                var sym = model.GetDeclaredSymbol(node) as INamedTypeSymbol;
                if (sym == null) continue;
                var name = MetadataName(sym);
                if (!into.Contains(name)) into.Add(name);
            }
        }

        static string MetadataName(INamedTypeSymbol sym) {
            var name = sym.MetadataName;
            var outer = sym.ContainingType;
            while (outer != null) { name = outer.MetadataName + "+" + name; outer = outer.ContainingType; }
            var ns = sym.ContainingNamespace;
            return (ns == null || ns.IsGlobalNamespace) ? name : ns.ToDisplayString() + "." + name;
        }

        void CollectChangedMethodKeys(SyntaxTree oldTree, SyntaxTree newTree, Compilation newComp, List<string> into, List<string> stateMachines) {
            var oldComp = CSharpCompilation.Create("old.diff", new[] { oldTree }, references, compilationOptions);
            var oldBodies = CollectMethodBodies(oldComp, oldTree, null);
            var smKeys = new HashSet<string>();
            var newBodies = CollectMethodBodies(newComp, newTree, smKeys);
            foreach (var kv in newBodies) {
                if (!oldBodies.TryGetValue(kv.Key, out var oldBody) || oldBody != kv.Value) {
                    if (!into.Contains(kv.Key)) into.Add(kv.Key);
                    if (smKeys.Contains(kv.Key) && !stateMachines.Contains(kv.Key)) stateMachines.Add(kv.Key);
                }
            }
        }

        static Dictionary<string, string> CollectMethodBodies(Compilation comp, SyntaxTree tree, HashSet<string> stateMachineKeys) {
            var map = new Dictionary<string, string>();
            var model = comp.GetSemanticModel(tree);
            foreach (var node in tree.GetRoot().DescendantNodes()) {
                ISymbol sym = null;
                string body = null;
                bool stateMachine = false;
                if (node is BaseMethodDeclarationSyntax m) {
                    sym = model.GetDeclaredSymbol(m);
                    body = m.Body?.ToString() ?? m.ExpressionBody?.ToString();
                    stateMachine = m.Modifiers.Any(SyntaxKind.AsyncKeyword) || HasYield(m);
                } else if (node is AccessorDeclarationSyntax a) {
                    sym = model.GetDeclaredSymbol(a);
                    body = a.Body?.ToString() ?? a.ExpressionBody?.ToString();
                    stateMachine = HasYield(a);
                } else if (node is PropertyDeclarationSyntax p && p.ExpressionBody != null) {
                    sym = model.GetDeclaredSymbol(p)?.GetMethod;
                    body = p.ExpressionBody.ToString();
                } else if (node is IndexerDeclarationSyntax ix && ix.ExpressionBody != null) {
                    sym = model.GetDeclaredSymbol(ix)?.GetMethod;
                    body = ix.ExpressionBody.ToString();
                } else {
                    continue;
                }
                if (sym is IMethodSymbol ms && body != null) {
                    var key = MethodKey(ms);
                    map[key] = Normalize(body);
                    if (stateMachine) stateMachineKeys?.Add(key);
                }
            }
            return map;
        }

        static bool HasYield(SyntaxNode node) =>
            node.DescendantNodes().OfType<YieldStatementSyntax>().Any();

        static string MethodKey(IMethodSymbol ms) =>
            MetadataName(ms.ContainingType) + "|" + ms.MetadataName + "|" + ms.Parameters.Length;

        static string Normalize(string body) => Regex.Replace(body, "\\s+", " ").Trim();

        void BuildReferences(UnityAssembly target) {
            references.Clear();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            void Add(string path) {
                if (string.IsNullOrEmpty(path) || !File.Exists(path)) return;
                var key = Path.GetFileNameWithoutExtension(path);
                if (!seen.Add(key)) return;
                try {
                    references.Add(referenceCache.GetOrAdd(path, p => MetadataReference.CreateFromFile(p)));
                } catch { }
            }

            foreach (var dep in target.assemblyReferences) {
                if (dep.name == targetAssemblyName) continue;
                Add(ToFullPath(dep.outputPath));
            }
            foreach (var p in target.compiledAssemblyReferences) Add(p);

            foreach (var dir in SystemAssemblyDirectories()) {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
                foreach (var dll in Directory.GetFiles(dir, "*.dll")) Add(dll);
            }
        }

        static IEnumerable<string> SystemAssemblyDirectories() {
            try {
#pragma warning disable CS0618
                var level = UnityEditor.PlayerSettings.GetApiCompatibilityLevel(
                    UnityEditor.EditorUserBuildSettings.selectedBuildTargetGroup);
#pragma warning restore CS0618
                return UnityCompilation.GetSystemAssemblyDirectories(level);
            } catch (Exception e) {
                Debug.LogWarning($"[HotReload] system assembly directories unavailable (non-fatal): {e.Message}");
                return Array.Empty<string>();
            }
        }

        void LoadGenerators(UnityAssembly target) {
            generators.Clear();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

            void AddFrom(string dllPath) {
                if (string.IsNullOrEmpty(dllPath) || !File.Exists(dllPath)) return;
                if (!seen.Add(Path.GetFileNameWithoutExtension(dllPath))) return;
                try {
                    var asm = GeneratorRebind.Load(dllPath);
                    Type[] types;
                    try { types = asm.GetTypes(); }
                    catch (ReflectionTypeLoadException e) { types = e.Types.Where(t => t != null).ToArray(); }
                    foreach (var t in types) {
                        if (t == null || t.IsAbstract || !t.IsClass) continue;
                        try {
                            if (typeof(ISourceGenerator).IsAssignableFrom(t)) {
                                generators.Add((ISourceGenerator)Activator.CreateInstance(t));
                            } else if (typeof(IIncrementalGenerator).IsAssignableFrom(t)) {
                                var inst = Activator.CreateInstance(t);
                                var wrap = typeof(GeneratorExtensions).GetMethod("AsSourceGenerator");
                                if (wrap != null) generators.Add((ISourceGenerator)wrap.Invoke(null, new[] { inst }));
                            }
                        } catch { }
                    }
                } catch (Exception e) {
                    Debug.LogWarning($"[HotReload] generator {Path.GetFileName(dllPath)} unavailable (non-fatal): {e.Message}");
                }
            }

            try {
                var analyzerPaths = target.compilerOptions?.RoslynAnalyzerDllPaths;
                if (analyzerPaths != null) foreach (var p in analyzerPaths) AddFrom(p);
            } catch (Exception e) {
                Debug.LogWarning($"[HotReload] analyzer paths unavailable (non-fatal): {e.Message}");
            }

            foreach (var dir in BuiltinGeneratorDirectories()) {
                if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) continue;
                foreach (var dll in Directory.GetFiles(dir, "*.dll")) AddFrom(dll);
            }
            if (Environment.GetEnvironmentVariable("SATURA_DEBUG") == "1") Debug.Log($"[HotReload] {targetAssemblyName}: {generators.Count} source generators");
        }

        static IEnumerable<string> BuiltinGeneratorDirectories() {
            string contents;
            try { contents = UnityEditor.EditorApplication.applicationContentsPath; }
            catch { return Array.Empty<string>(); }
            if (string.IsNullOrEmpty(contents)) return Array.Empty<string>();
            return new[] {
                Path.Combine(contents, "Tools", "Unity.SourceGenerators"),
                Path.Combine(contents, "Tools", "Compilation", "Unity.SourceGenerators"),
            };
        }

        CSharpCompilation RunGenerators(CSharpCompilation comp) {
            if (generators.Count == 0) return comp;
            try {
                var driver = CSharpGeneratorDriver.Create(generators, parseOptions: parseOptions);
                driver.RunGeneratorsAndUpdateCompilation(comp, out var updated, out _);
                return (CSharpCompilation)updated;
            } catch (Exception e) {
                Debug.LogWarning($"[HotReload] source generators failed (non-fatal): {e.Message}");
                return comp;
            }
        }

        static string ToFullPath(string projectRelative) => HotReloadPaths.ToFull(projectRelative);
    }
}
