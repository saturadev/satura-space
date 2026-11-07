using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using Unity.CodeEditor;
using UnityEditor;
using UnityEngine;

namespace SaturaSpace
{
    [InitializeOnLoad]
    internal class SaturaScriptEditor : IExternalCodeEditor
    {
        const string DisplayName = "Satura Space";
        const string PrefKey = "kScriptsDefaultApp";
        const double ENSURE_INTERVAL = 5.0;

        static readonly string[] HandledExtensions =
        {
            ".cs", ".shader", ".compute", ".cginc", ".hlsl", ".glslinc", ".shadergraph",
            ".uss", ".uxml", ".asmdef", ".asmref", ".json", ".xml", ".txt", ".md",
            ".yaml", ".yml", ".log", ".cfg", ".ini", ".proto"
        };

        static readonly string ProjectRoot = Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
        static readonly string SspaceDir = Path.Combine(ProjectRoot, ".sspace");
        static readonly string OrchestratorFile = Path.Combine(SspaceDir, ".mcp_orchestrator.json");
        static readonly string RequestFile = Path.Combine(SspaceDir, ".open_editor_request.json");

        static double _nextEnsure;
        static long _seq;

        const int ASFW_ANY = -1;

        [DllImport("user32.dll")]
        static extern bool AllowSetForegroundWindow(int dwProcessId);

        [Serializable]
        class OrchestratorInfo
        {
            public int pid;
            public int controlPort;
            public string appPath;
        }

        [Serializable]
        class OpenRequest
        {
            public long seq;
            public long ts;
            public string file;
            public int line;
            public int column;
        }

        static SaturaScriptEditor()
        {
            if (!RegistrationAllowed()) return;
            CodeEditor.Register(new SaturaScriptEditor());
            EditorApplication.update += EnsureDefaultEditor;
            EditorApplication.delayCall += EnsureProjectFiles;
        }

        static readonly string[] GeneratorTypes =
        {
            "Microsoft.Unity.VisualStudio.Editor.SdkStyleProjectGeneration, Unity.VisualStudio.Editor",
            "Microsoft.Unity.VisualStudio.Editor.ProjectGeneration, Unity.VisualStudio.Editor",
            "Packages.Rider.Editor.ProjectGeneration.ProjectGeneration, Unity.Rider.Editor"
        };

        static object _generator;
        static bool _generatorResolved;

        static object Generator()
        {
            if (_generatorResolved) return _generator;
            _generatorResolved = true;
            foreach (var name in GeneratorTypes)
            {
                try
                {
                    var type = Type.GetType(name);
                    if (type == null) continue;
                    _generator = Activator.CreateInstance(type, true);
                    if (_generator != null) return _generator;
                }
                catch (Exception e)
                {
                    Debug.LogWarning("[SaturaScriptEditor] project generator " + name + " failed: " + e.Message);
                }
            }
            Debug.LogWarning("[SaturaScriptEditor] no project generator found. Install com.unity.ide.visualstudio for C# code intelligence");
            return null;
        }

        static void InvokeGenerator(string method, Type[] signature, object[] args)
        {
            var g = Generator();
            if (g == null) return;
            try
            {
                var m = g.GetType().GetMethod(method, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, signature, null);
                m?.Invoke(g, args);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[SaturaScriptEditor] " + method + " failed: " + (e.InnerException ?? e).Message);
            }
        }

        static void EnsureProjectFiles()
        {
            try
            {
                if (Directory.GetFiles(ProjectRoot, "*.sln").Length > 0) return;
            }
            catch
            {
                return;
            }
            InvokeGenerator("Sync", Type.EmptyTypes, null);
        }

        static bool RegistrationAllowed()
        {
            if (!SaturaLaunch.Managed) return false;
            try
            {
                if (AssetDatabase.IsAssetImportWorkerProcess()) return false;
            }
            catch
            {
                return false;
            }
            try
            {
                if (UnityEditor.MPE.ProcessService.level == UnityEditor.MPE.ProcessLevel.Secondary) return false;
            }
            catch
            {
            }
            return true;
        }

        static int OrchestratorPid()
        {
            try
            {
                if (!File.Exists(OrchestratorFile)) return 0;
                var info = JsonUtility.FromJson<OrchestratorInfo>(File.ReadAllText(OrchestratorFile));
                return info != null && info.pid > 0 ? info.pid : 0;
            }
            catch
            {
                return 0;
            }
        }

        static void LetOrchestratorTakeForeground()
        {
            if (Application.platform != RuntimePlatform.WindowsEditor) return;
            try
            {
                var pid = OrchestratorPid();
                AllowSetForegroundWindow(pid > 0 ? pid : ASFW_ANY);
            }
            catch
            {
            }
        }

        static string AppPath()
        {
            var env = Environment.GetEnvironmentVariable("SATURA_APP_PATH");
            if (!string.IsNullOrEmpty(env)) return env;
            try
            {
                if (!File.Exists(OrchestratorFile)) return null;
                var info = JsonUtility.FromJson<OrchestratorInfo>(File.ReadAllText(OrchestratorFile));
                return string.IsNullOrEmpty(info?.appPath) ? null : info.appPath;
            }
            catch
            {
                return null;
            }
        }

        static bool PathExists(string p)
        {
            return !string.IsNullOrEmpty(p) && (File.Exists(p) || Directory.Exists(p));
        }

        static bool SamePath(string a, string b)
        {
            if (string.IsNullOrEmpty(a) || string.IsNullOrEmpty(b)) return false;
            try
            {
                return string.Equals(
                    Path.GetFullPath(a).TrimEnd('/', '\\'),
                    Path.GetFullPath(b).TrimEnd('/', '\\'),
                    StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        static bool IsSaturaPath(string path)
        {
            if (string.IsNullOrEmpty(path)) return false;
            if (SamePath(path, AppPath())) return true;
            try
            {
                var name = Path.GetFileName(path.TrimEnd('/', '\\'));
                return !string.IsNullOrEmpty(name) &&
                       name.StartsWith("satura", StringComparison.OrdinalIgnoreCase);
            }
            catch
            {
                return false;
            }
        }

        static void EnsureDefaultEditor()
        {
            var now = EditorApplication.timeSinceStartup;
            if (now < _nextEnsure) return;
            _nextEnsure = now + ENSURE_INTERVAL;
            var app = AppPath();
            if (!PathExists(app)) return;
            var current = EditorPrefs.GetString(PrefKey);
            if (IsSaturaPath(current) && PathExists(current)) return;
            CodeEditor.SetExternalScriptEditor(app);
            Debug.Log("[SaturaScriptEditor] External script editor set to " + app);
        }

        public CodeEditor.Installation[] Installations
        {
            get
            {
                var app = AppPath();
                if (!PathExists(app)) return Array.Empty<CodeEditor.Installation>();
                return new[] { new CodeEditor.Installation { Name = DisplayName, Path = app } };
            }
        }

        public void Initialize(string editorInstallationPath)
        {
        }

        public void OnGUI()
        {
            EditorGUILayout.LabelField(
                "Scripts open in the Satura Space app.",
                EditorStyles.wordWrappedLabel);
        }

        public void SyncAll()
        {
            InvokeGenerator("Sync", Type.EmptyTypes, null);
        }

        public void SyncIfNeeded(string[] addedFiles, string[] deletedFiles, string[] movedFiles,
            string[] movedFromFiles, string[] importedFiles)
        {
            IEnumerable<string> affected = (addedFiles ?? Array.Empty<string>())
                .Union(deletedFiles ?? Array.Empty<string>())
                .Union(movedFiles ?? Array.Empty<string>())
                .Union(movedFromFiles ?? Array.Empty<string>())
                .ToArray();
            IEnumerable<string> reimported = importedFiles ?? Array.Empty<string>();
            InvokeGenerator("SyncIfNeeded", new[] { typeof(IEnumerable<string>), typeof(IEnumerable<string>) },
                new object[] { affected, reimported });
        }

        public bool TryGetInstallationForPath(string editorPath, out CodeEditor.Installation installation)
        {
            if (IsSaturaPath(editorPath))
            {
                installation = new CodeEditor.Installation { Name = DisplayName, Path = editorPath };
                return true;
            }
            installation = default;
            return false;
        }

        public bool OpenProject(string path, int line, int column)
        {
            if (!string.IsNullOrEmpty(path) && !HandlesExtension(path)) return false;
            WriteRequest(path ?? "", line, column);
            return true;
        }

        static bool HandlesExtension(string path)
        {
            string ext;
            try
            {
                ext = Path.GetExtension(path);
            }
            catch
            {
                return false;
            }
            if (string.IsNullOrEmpty(ext)) return false;
            foreach (var h in HandledExtensions)
            {
                if (string.Equals(ext, h, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        static void WriteRequest(string file, int line, int column)
        {
            LetOrchestratorTakeForeground();
            try
            {
                SspaceFolder.Ensure(SspaceDir);
                var req = new OpenRequest
                {
                    seq = ++_seq,
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    file = string.IsNullOrEmpty(file) ? "" : Path.GetFullPath(file),
                    line = line,
                    column = column
                };
                var tmp = RequestFile + ".tmp";
                File.WriteAllText(tmp, JsonUtility.ToJson(req));
                if (File.Exists(RequestFile)) File.Delete(RequestFile);
                File.Move(tmp, RequestFile);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[SaturaScriptEditor] open request failed: " + e.Message);
            }
        }
    }
}
