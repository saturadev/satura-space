using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading.Tasks;
using UnityEditor;
using UnityEngine;
using UnityCompilation = UnityEditor.Compilation.CompilationPipeline;
using AssembliesType = UnityEditor.Compilation.AssembliesType;
using AssemblyFlags = UnityEditor.Compilation.AssemblyFlags;

namespace HotReloadPrototype.Editor {
    [InitializeOnLoad]
    internal static class HotReloadController {
        public const string TargetAssembly = "Assembly-CSharp";
        const string EnabledPref = "HotReloadPrototype.Enabled";
        const string ScriptCompileDuringPlayPref = "ScriptCompilationDuringPlay";
        const string ExcludedAssemblyPrefix = "SaturaSpace";
        static readonly TimeSpan SettleDelay = TimeSpan.FromMilliseconds(150);

        static readonly bool IsVirtualProjectClone =
            Array.IndexOf(Environment.GetCommandLineArgs(), "--virtual-project-clone") >= 0;

        sealed class AssemblyTarget {
            public string name;
            public Assembly live;
            public PatchCompiler compiler;
            public volatile bool prewarmed;
            public string initError;
        }

        static readonly List<FileSystemWatcher> watchers = new List<FileSystemWatcher>();
        static readonly Dictionary<string, AssemblyTarget> targets =
            new Dictionary<string, AssemblyTarget>(StringComparer.OrdinalIgnoreCase);
        static Dictionary<string, string> assemblyByScriptKey;
        static Dictionary<string, string> scriptFullPathByKey;
        static HashSet<string> patchableAssemblies;
        static ConcurrentDictionary<string, string> baselineText;
        static volatile bool baselineReady;
        static bool sessionActive;

        static readonly object gate = new object();
        static readonly Dictionary<string, DateTime> pending = new Dictionary<string, DateTime>(StringComparer.OrdinalIgnoreCase);

        static readonly HashSet<string> RunOnceMessages = new HashSet<string>(StringComparer.Ordinal) {
            "Awake", "OnEnable", "Reset", "Start", "OnValidate",
        };

        static HotReloadController() {
            if (IsImportWorkerProcess() || !SaturaSpace.SaturaLaunch.Managed) return;
            EditorApplication.playModeStateChanged += OnPlayModeChanged;
            EditorApplication.update += Update;
        }

        static bool IsImportWorkerProcess() {
            try { return AssetDatabase.IsAssetImportWorkerProcess(); }
            catch { return false; }
        }

        public static bool Enabled {
            get => EditorPrefs.GetBool(EnabledPref, false);
            set {
                EditorPrefs.SetBool(EnabledPref, value);
                if (EditorApplication.isPlaying) {
                    if (value && !sessionActive) StartSession();
                    else if (!value && sessionActive) StopSession();
                }
            }
        }

        public static void PatchFiles(string[] fullPaths) {
            if (fullPaths == null || fullPaths.Length == 0) return;
            if (!sessionActive && Enabled && EditorApplication.isPlaying) StartSession();
            if (!sessionActive) {
                Debug.LogWarning("[HotReload] live patch requested but no active session — arm hot-reload and enter Play first.");
                return;
            }
            foreach (var path in fullPaths) {
                if (string.IsNullOrEmpty(path)) continue;
                try {
                    if (!TryDispatch(path, deferUntilPrewarmed: false)) Enqueue(path);
                } catch (Exception e) {
                    Debug.LogWarning($"[HotReload] error patching {Path.GetFileName(path)}: {e}");
                }
            }
        }

        static void OnPlayModeChanged(PlayModeStateChange state) {
            if (state == PlayModeStateChange.EnteredPlayMode) {
                if (Enabled) StartSession();
            } else if (state == PlayModeStateChange.ExitingPlayMode) {
                StopSession();
            }
        }

        static void StartSession() {
            if (sessionActive) return;

            if (EditorPrefs.GetInt(ScriptCompileDuringPlayPref, 0) != 1) {
                Debug.LogWarning("[HotReload] 'Script Changes While Playing' is not 'Recompile After Finished Playing', so Unity may recompile and drop patches mid-play. Set it in Preferences > General.");
            }

            if (UnityCompilation.codeOptimization == UnityEditor.Compilation.CodeOptimization.Release) {
                Debug.LogWarning("[HotReload] editor code optimization is Release — Mono inlines small methods and patched helpers may not reach existing callers. "
                    + "Switch to Debug (Edit > Preferences or the bottom-right debug icon), or launch the editor with MONO_INLINELIMIT=0.");
            }

            BuildScriptIndex();
            if (assemblyByScriptKey.Count == 0) {
                Debug.LogWarning("[HotReload] no user script assemblies found — nothing to patch. (Add a script under Assets/ first.)");
                assemblyByScriptKey = null;
                patchableAssemblies = null;
                return;
            }

            targets.Clear();
            if (patchableAssemblies.Contains(TargetAssembly)) GetOrCreateTarget(TargetAssembly);
            CaptureBaseline();

            lock (gate) pending.Clear();
            if (!IsVirtualProjectClone) StartWatchers();
            sessionActive = true;
            Debug.Log("[HotReload] session started — edit a method body and save while playing."
                + (IsVirtualProjectClone ? " (clone: patched on demand by the orchestrator)" : ""));
        }

        static void StopSession() {
            if (!sessionActive && watchers.Count == 0) return;
            StopWatchers();
            Detourer.UndoAll();
            targets.Clear();
            assemblyByScriptKey = null;
            scriptFullPathByKey = null;
            patchableAssemblies = null;
            baselineText = null;
            baselineReady = false;
            sessionActive = false;
            lock (gate) pending.Clear();
        }

        static void BuildScriptIndex() {
            assemblyByScriptKey = new Dictionary<string, string>(StringComparer.Ordinal);
            scriptFullPathByKey = new Dictionary<string, string>(StringComparer.Ordinal);
            patchableAssemblies = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var a in UnityCompilation.GetAssemblies(AssembliesType.Editor)) {
                if ((a.flags & AssemblyFlags.EditorAssembly) != 0) continue;
                if (a.name.StartsWith(ExcludedAssemblyPrefix, StringComparison.OrdinalIgnoreCase)) continue;
                patchableAssemblies.Add(a.name);
                foreach (var f in a.sourceFiles) {
                    var key = HotReloadPaths.Norm(f);
                    assemblyByScriptKey[key] = a.name;
                    scriptFullPathByKey[key] = HotReloadPaths.ToFull(f);
                }
            }
        }

        static void CaptureBaseline() {
            baselineText = new ConcurrentDictionary<string, string>(StringComparer.Ordinal);
            baselineReady = false;
            var files = scriptFullPathByKey.ToArray();
            var snap = baselineText;
            Task.Run(() => {
                foreach (var kv in files) {
                    try { snap[kv.Key] = File.ReadAllText(kv.Value); } catch { }
                }
                baselineReady = true;
            });
        }

        static string RouteToAssembly(string fullPath) {
            var rel = HotReloadPaths.MakeProjectRelative(fullPath);
            if (assemblyByScriptKey.TryGetValue(HotReloadPaths.Norm(rel), out var name)) return name;
            try {
                var fromPipeline = UnityCompilation.GetAssemblyNameFromScriptPath(rel.Replace('\\', '/'));
                if (string.IsNullOrEmpty(fromPipeline)) return null;
                if (fromPipeline.EndsWith(".dll", StringComparison.OrdinalIgnoreCase))
                    fromPipeline = fromPipeline.Substring(0, fromPipeline.Length - 4);
                return patchableAssemblies.Contains(fromPipeline) ? fromPipeline : null;
            } catch {
                return null;
            }
        }

        static AssemblyTarget GetOrCreateTarget(string assemblyName) {
            if (targets.TryGetValue(assemblyName, out var existing)) return existing;
            var t = new AssemblyTarget { name = assemblyName };
            targets[assemblyName] = t;
            t.live = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(a =>
                !a.IsDynamic && SafeName(a) == assemblyName && !string.IsNullOrEmpty(SafeLocation(a)));
            if (t.live == null) {
                t.initError = $"assembly '{assemblyName}' is not loaded";
                return t;
            }
            var c = new PatchCompiler(assemblyName);
            var snap = baselineText;
            var err = c.Initialize(snap == null ? (Func<string, string>)null : k => snap.TryGetValue(k, out var text) ? text : null);
            if (err != null) {
                t.initError = err;
                return t;
            }
            t.compiler = c;
            Task.Run(() => { try { c.Prewarm(); } finally { t.prewarmed = true; } });
            return t;
        }

        static bool TryDispatch(string fullPath, bool deferUntilPrewarmed) {
            var assemblyName = RouteToAssembly(fullPath);
            if (assemblyName == null) {
                LogSkipped(fullPath);
                return true;
            }
            if (!targets.ContainsKey(assemblyName) && !baselineReady) return false;
            var t = GetOrCreateTarget(assemblyName);
            if (t.initError != null) {
                Debug.LogWarning($"[HotReload] error patching {Path.GetFileName(fullPath)}: {t.initError}");
                return true;
            }
            if (deferUntilPrewarmed && !t.prewarmed) return false;
            ProcessSave(fullPath, t);
            return true;
        }

        static void LogSkipped(string fullPath) =>
            Debug.Log($"[HotReload] {Path.GetFileName(fullPath)} skipped — not part of any patchable assembly.");

        static void StartWatchers() {
            StopWatchers();
            AddWatcher(Application.dataPath);
            var packages = Path.Combine(HotReloadPaths.ProjectRoot, "Packages");
            if (Directory.Exists(packages)) AddWatcher(packages);
        }

        static void AddWatcher(string root) {
            var w = new FileSystemWatcher(root, "*.cs") {
                IncludeSubdirectories = true,
                NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size | NotifyFilters.FileName,
            };
            FileSystemEventHandler onChange = (s, e) => Enqueue(e.FullPath);
            w.Changed += onChange;
            w.Created += onChange;
            w.Renamed += (s, e) => Enqueue(e.FullPath);
            w.EnableRaisingEvents = true;
            watchers.Add(w);
        }

        static void StopWatchers() {
            foreach (var w in watchers) {
                try { w.EnableRaisingEvents = false; w.Dispose(); } catch { }
            }
            watchers.Clear();
        }

        static void Enqueue(string fullPath) {
            if (string.IsNullOrEmpty(fullPath) || !fullPath.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return;
            var rel = HotReloadPaths.Norm(HotReloadPaths.MakeProjectRelative(fullPath));
            foreach (var seg in rel.Split('/')) {
                if (seg.Length == 0) continue;
                if (seg[0] == '.' || seg[seg.Length - 1] == '~') return;
            }
            lock (gate) pending[fullPath] = DateTime.UtcNow;
        }

        static void Update() {
            if (!sessionActive) return;

            List<string> ready = null;
            lock (gate) {
                if (pending.Count == 0) return;
                var now = DateTime.UtcNow;
                foreach (var kv in pending) {
                    if (now - kv.Value >= SettleDelay) (ready ??= new List<string>()).Add(kv.Key);
                }
                if (ready != null) foreach (var p in ready) pending.Remove(p);
            }
            if (ready == null) return;

            foreach (var path in ready) {
                bool done;
                try {
                    done = TryDispatch(path, deferUntilPrewarmed: true);
                } catch (Exception e) {
                    Debug.LogWarning($"[HotReload] error patching {Path.GetFileName(path)}: {e}");
                    done = true;
                }
                if (!done) lock (gate) pending[path] = DateTime.UtcNow;
            }
        }

        static void ProcessSave(string fullPath, AssemblyTarget t) {
            var res = t.compiler.CompilePatch(fullPath);
            if (!res.ok) {
                if (res.errors.Count > 0)
                    Debug.LogError($"[HotReload] compile errors in {Path.GetFileName(fullPath)}:\n  " + string.Join("\n  ", res.errors));
                else if (res.note != null)
                    LogSkipped(fullPath);
                return;
            }

            Assembly patchAsm = Assembly.Load(res.peBytes, res.pdbBytes);

            var skipped = new List<string>();
            var pairs = MethodMatcher.Match(patchAsm, t.live, res.changedTypeMetadataNames, skipped);

            var changed = new HashSet<string>(res.changedMethodKeys);
            pairs.RemoveAll(p => !changed.Contains(MethodKey(p.live)));

            int applied = 0;
            int runOnce = 0;
            var failures = new List<string>();
            foreach (var p in pairs) {
                if (Detourer.Apply(p.live, p.patch, out var err)) {
                    applied++;
                    if (RunOnceMessages.Contains(p.live.Name)) runOnce++;
                } else {
                    failures.Add($"{p.patch.DeclaringType?.Name}.{p.patch.Name}: {err}");
                }
            }

            string note = runOnce > 0
                ? $" ({runOnce} run-once lifecycle method(s) patched — affects objects spawned after this patch.)"
                : "";
            if (applied > 0) {
                HotReloadDispatcher.Dispatch();
                Debug.Log($"[HotReload] {Path.GetFileName(fullPath)} → patched {applied} changed method(s).{note}");
            } else {
                Debug.Log($"[HotReload] {Path.GetFileName(fullPath)} compiled — no method-body changes to patch.");
            }
            if (res.changedStateMachineKeys.Count > 0) {
                Debug.LogWarning($"[HotReload] {Path.GetFileName(fullPath)}: {res.changedStateMachineKeys.Count} coroutine/async body change(s) — a RUNNING coroutine keeps its old state machine and will NOT pick this up; only coroutines started after the patch use the new body.");
            }
            foreach (var f in failures) Debug.LogWarning("[HotReload] detour failed — " + f);
        }

        static string SafeName(Assembly a) { try { return a.GetName().Name; } catch { return null; } }
        static string SafeLocation(Assembly a) { try { return a.Location; } catch { return null; } }

        static string MethodKey(MethodBase m) =>
            (m.DeclaringType?.FullName ?? "?") + "|" + m.Name + "|" + m.GetParameters().Length;
    }
}
