using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;
using System.Threading.Tasks;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.CSharp;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.Emit;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.Text;
using UnityCompilation = UnityEditor.Compilation.CompilationPipeline;
using AssembliesType = UnityEditor.Compilation.AssembliesType;

namespace HotReloadPrototype.Editor {
    internal static class ExecService {
        internal const string Pending = "\u0000pending";
        const int InlineWaitMs = 200;
        const string LastSourceKey = "SaturaSpace_ExecLastSource";

        static readonly ConcurrentDictionary<string, MetadataReference> referenceCache =
            new ConcurrentDictionary<string, MetadataReference>(StringComparer.OrdinalIgnoreCase);

        sealed class Compiled {
            public byte[] pe;
            public byte[] pdb;
            public string error;
        }

        static readonly Dictionary<string, Task<Compiled>> jobs = new Dictionary<string, Task<Compiled>>(StringComparer.Ordinal);
        static string[] defines;
        static Task<Compiled> warmup;
        static volatile CSharpCompilation keepAlive;

        const string WarmSource = @"using UnityEngine;
using UnityEditor;
using System;
using System.Linq;
using System.Collections.Generic;
static class _MCPExecWarmup
{
    public static void Run()
    {
        var _l = new List<GameObject>(UnityEngine.Object.FindObjectsByType<GameObject>(FindObjectsSortMode.None));
        Debug.Log(_l.Where(g => g != null).Select(g => g.name).FirstOrDefault() + EditorApplication.timeSinceStartup);
    }
}";

        [UnityEditor.InitializeOnLoadMethod]
        static void ScheduleWarmup() {
            try { if (UnityEditor.AssetDatabase.IsAssetImportWorkerProcess()) return; }
            catch { return; }
            if (string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MC_INSTANCE_ID"))) return;
            if (UnityEngine.Application.isBatchMode && Array.IndexOf(Environment.GetCommandLineArgs(), "-quit") >= 0) return;
            var d = Defines();
            string last = UnityEditor.SessionState.GetString(LastSourceKey, "");
            string source = string.IsNullOrEmpty(last) ? WarmSource : last;
            warmup = OnThread("Satura exec warmup", () => Compile(source, "_MCPExecWarmup.cs", "_MCPExecWarmup", d));
        }

        internal static string Step(string sourcePath, string typeName) {
            Task<Compiled> job;
            if (!jobs.TryGetValue(typeName, out job)) {
                string source;
                try { source = File.ReadAllText(sourcePath); }
                catch (Exception e) { return "exec source unreadable: " + e.Message; }
                var d = Defines();
                var warm = warmup;
                if (source.Length < 64 * 1024) UnityEditor.SessionState.SetString(LastSourceKey, source);
                string file = Path.GetFileName(sourcePath);
                job = OnThread("Satura exec compile", () => {
                    try { warm?.Wait(); } catch { }
                    return Compile(source, file, typeName, d);
                });
                jobs[typeName] = job;
                ((IAsyncResult)job).AsyncWaitHandle.WaitOne(InlineWaitMs);
            }
            if (!job.IsCompleted) return Pending;
            jobs.Remove(typeName);
            Compiled c;
            try { c = job.Result; }
            catch (Exception e) { return "exec compile failed: " + (e.InnerException ?? e).Message; }
            return c.error ?? Invoke(c, typeName);
        }

        static Task<Compiled> OnThread(string name, Func<Compiled> work) {
            var done = new TaskCompletionSource<Compiled>();
            var thread = new System.Threading.Thread(() => {
                try { done.TrySetResult(work()); }
                catch (Exception e) { done.TrySetException(e); }
            }) { IsBackground = true, Name = name };
            thread.Start();
            return done.Task;
        }

        static string[] Defines() {
            if (defines == null) defines = EditorDefines();
            return defines;
        }

        static Compiled Compile(string source, string file, string typeName, string[] symbols) {
            var result = new Compiled();
            try {
                var parseOptions = new CSharpParseOptions(LanguageVersion.CSharp9, preprocessorSymbols: symbols);
                var tree = CSharpSyntaxTree.ParseText(SourceText.From(source, Encoding.UTF8), parseOptions, path: file);
                var options = new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    allowUnsafe: true,
                    optimizationLevel: OptimizationLevel.Debug,
                    platform: Platform.AnyCpu,
                    assemblyIdentityComparer: DesktopAssemblyIdentityComparer.Default);
                var compilation = CSharpCompilation.Create(typeName, new[] { tree }, DomainReferences(), options);
                using (var peStream = new MemoryStream())
                using (var pdbStream = new MemoryStream()) {
                    EmitResult emit = compilation.Emit(peStream, pdbStream,
                        options: new EmitOptions(debugInformationFormat: DebugInformationFormat.PortablePdb));
                    keepAlive = compilation;
                    if (!emit.Success) result.error = FormatErrors(emit.Diagnostics, source);
                    else {
                        result.pe = peStream.ToArray();
                        result.pdb = pdbStream.ToArray();
                    }
                }
            } catch (Exception e) {
                result.error = "exec compile failed: " + e.Message;
            }
            return result;
        }

        static string Invoke(Compiled c, string typeName) {
            Assembly assembly;
            try { assembly = Assembly.Load(c.pe, c.pdb); }
            catch (Exception e) { return "exec assembly load failed: " + e.Message; }

            var type = assembly.GetType(typeName);
            if (type == null) return "exec entry type '" + typeName + "' not found in the compiled snippet";
            var entry = type.GetMethod("Run", BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static);
            if (entry == null) return "exec entry method Run() not found on '" + typeName + "'";
            try { entry.Invoke(null, null); }
            catch (Exception e) {
                var inner = e is TargetInvocationException tie && tie.InnerException != null ? tie.InnerException : e;
                return "exec invocation failed outside the snippet's own try/catch: " + inner;
            }
            return null;
        }

        static string[] EditorDefines() {
            try {
                var assemblies = UnityCompilation.GetAssemblies(AssembliesType.Editor);
                var target = assemblies.FirstOrDefault(a => a.name == "Assembly-CSharp-Editor")
                    ?? assemblies.FirstOrDefault();
                return ResponseFileDefines.With(target?.defines);
            } catch { return ResponseFileDefines.With(null); }
        }

        static List<MetadataReference> DomainReferences() {
            var refs = new List<MetadataReference>();
            var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
                if (assembly.IsDynamic) continue;
                string location;
                try { location = assembly.Location; } catch { continue; }
                if (string.IsNullOrEmpty(location) || !File.Exists(location)) continue;
                string name;
                try { name = assembly.GetName().Name; } catch { continue; }
                if (!seen.Add(name)) continue;
                try { refs.Add(referenceCache.GetOrAdd(location, p => MetadataReference.CreateFromFile(p))); }
                catch { }
            }
            return refs;
        }

        static string FormatErrors(IEnumerable<Diagnostic> diagnostics, string source) {
            var lines = source.Replace("\r\n", "\n").Split('\n');
            var sb = new StringBuilder();
            sb.AppendLine("exec snippet failed to compile — the code did NOT run:");
            foreach (var d in diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).Take(20)) {
                sb.AppendLine(d.ToString());
                int line = d.Location.GetLineSpan().StartLinePosition.Line;
                if (line >= 0 && line < lines.Length) sb.AppendLine("    > " + lines[line].Trim());
            }
            if (diagnostics.Any(d => d.Id == "CS0127")) sb.AppendLine("The snippet is a method body that returns nothing: write Print(value) instead of return value. unity.exec returns what Print() printed.");
            var missing = diagnostics.Where(d => d.Id == "CS0246").Select(d => System.Text.RegularExpressions.Regex.Match(d.GetMessage(), "'([A-Za-z_][A-Za-z0-9_]*)'")).Where(m => m.Success).Select(m => m.Groups[1].Value).Distinct().Take(4).ToList();
            if (missing.Count > 0) {
                var homes = NamespacesOf(missing);
                var found = missing.Where(n => homes.ContainsKey(n)).ToList();
                if (found.Count > 0) {
                    var spaces = found.SelectMany(n => homes[n].Take(1)).Distinct().ToList();
                    sb.AppendLine(string.Join("; ", found.Select(n => n + " is in " + string.Join(" or ", homes[n].Take(3))))
                        + ". Pass { usings: [" + string.Join(", ", spaces.Select(x => "'" + x + "'")) + "] } to unity.exec, or write the full name.");
                }
            }
            return sb.ToString().TrimEnd();
        }

        static Dictionary<string, List<string>> NamespacesOf(List<string> names) {
            var want = new HashSet<string>(names);
            var homes = new Dictionary<string, List<string>>();
            foreach (var assembly in AppDomain.CurrentDomain.GetAssemblies()) {
                if (assembly.IsDynamic) continue;
                Type[] types;
                try { types = assembly.GetExportedTypes(); } catch { continue; }
                foreach (var t in types) {
                    if (t.IsNested || string.IsNullOrEmpty(t.Namespace)) continue;
                    var name = t.Name;
                    int tick = name.IndexOf('`');
                    if (tick > 0) name = name.Substring(0, tick);
                    if (!want.Contains(name)) continue;
                    List<string> list;
                    if (!homes.TryGetValue(name, out list)) homes[name] = list = new List<string>();
                    if (!list.Contains(t.Namespace)) list.Add(t.Namespace);
                }
            }
            foreach (var list in homes.Values) list.Sort((a, b) => Rank(a).CompareTo(Rank(b)));
            return homes;
        }

        static int Rank(string ns) {
            if (ns.StartsWith("UnityEngine", StringComparison.Ordinal)) return ns.Count(c => c == '.');
            if (ns.StartsWith("UnityEditor", StringComparison.Ordinal)) return 10 + ns.Count(c => c == '.');
            return 20;
        }
    }
}
