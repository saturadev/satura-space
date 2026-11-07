using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEditor.SceneManagement;
using UnityEngine;
using SaturaSpace;

public static partial class MCPTestBridge
{
    static string WorldJsonPath => Path.Combine(SspaceRoot, "world.json");
    static string WorldFloorPath => Path.Combine(SspaceRoot, ".world_floor.json");

    const string SS_WORLD_VERSION = "SaturaSpace_World_Version";
    const string SS_REFRESH_GEN   = "SaturaSpace_World_RefreshGen";
    const string SS_SCENE_GEN     = "SaturaSpace_World_SceneGen";
    const string SS_PLAY_GEN      = "SaturaSpace_World_PlayGen";
    const string SS_PAUSE_GEN     = "SaturaSpace_World_PauseGen";

    const string DIGEST_SECTION = "";
    const string DIGEST_ITEM    = "";

    const double WORLD_PUMP_INTERVAL    = 0.2;
    const int PROGRESS_LABEL_MAX = 160;

    static string _lastWorldDigest;
    static string _lastWorldTail;
    static string _cachedWorldTail;
    static string[] _cachedScenes;
    static volatile bool _worldStructuralDirty = true;
    internal static volatile bool _worldGreetNeeded;
    static double _lastWorldPump;

    static string _cachedCompileError;
    static bool   _cachedHotReload;
    static List<string> _worldCycleErrors;

    [Serializable]
    class WorldFloorData
    {
        public int version;
        public int refreshGen;
    }

    struct WorldInstanceState
    {
        public string id;
        public string role;
        public int playerIndex;
        public string lifecycle;
        public string compile;
        public string compileError;
        public string scene;
        public int refreshGen;
        public int sceneGen;
        public int playGen;
        public int pauseGen;
        public int assetSeq;
        public bool paused;
        public bool hotReloadActive;
        public bool sceneDirty;
        public string dirtyScenes;
        public bool saving;
        public string progressLabel;
        public int progressPct;
        public bool noCamera;
        public bool connected;
        public bool alive;
        public bool reachable;
        public int fps;
        public int ping;
    }

    [InitializeOnLoadMethod]
    static void InitWorldState()
    {
        if (Inert) return;
        BaselineCloneAssetSeq();
        if (SessionState.GetInt(SS_WORLD_VERSION, -1) < 0)
        {
            int version = 0, refreshGen = 0;
            try
            {
                if (File.Exists(WorldFloorPath))
                {
                    var floor = JsonUtility.FromJson<WorldFloorData>(File.ReadAllText(WorldFloorPath));
                    if (floor != null) { version = Math.Max(0, floor.version); refreshGen = Math.Max(0, floor.refreshGen); }
                }
            }
            catch { }
            version    = Math.Max(version,    ParseWorldJsonVersion());
            refreshGen = Math.Max(refreshGen, ParseWorldJsonRefreshGen());
            SessionState.SetInt(SS_WORLD_VERSION, version);
            SessionState.SetInt(SS_REFRESH_GEN, refreshGen);
        }

        _cachedCompileError = SafeReadCompileErrorsFromDisk();
        _cachedHotReload = SafeReadHotReloadFromReflection();

        CompilationPipeline.compilationStarted -= OnWorldCompilationStarted;
        CompilationPipeline.compilationStarted += OnWorldCompilationStarted;
        CompilationPipeline.assemblyCompilationFinished -= OnWorldAssemblyFinished;
        CompilationPipeline.assemblyCompilationFinished += OnWorldAssemblyFinished;
        CompilationPipeline.compilationFinished -= OnWorldCompilationFinished;
        CompilationPipeline.compilationFinished += OnWorldCompilationFinished;

        EditorApplication.pauseStateChanged -= OnWorldPauseStateChanged;
        EditorApplication.pauseStateChanged += OnWorldPauseStateChanged;
        EditorSceneManager.sceneSaved -= OnWorldSceneSaved;
        EditorSceneManager.sceneSaved += OnWorldSceneSaved;
        PrefabStage.prefabSaved -= OnWorldPrefabSaved;
        PrefabStage.prefabSaved += OnWorldPrefabSaved;

        _worldStructuralDirty = true;
        _lastWorldDigest = null;
        _lastWorldTail = null;
    }

    static int _worldSaving;
    static bool _worldSaveClearQueued;

    internal static void MarkWorldSaving(string[] paths)
    {
        if (Inert || paths == null) return;
        int n = 0;
        foreach (var p in paths)
            if (p != null && (p.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) || p.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase))) n++;
        if (n == 0) return;
        _worldSaving += n;
        SafeEmit(false);
        if (_worldSaveClearQueued) return;
        _worldSaveClearQueued = true;
        EditorApplication.delayCall += ClearWorldSaving;
    }

    static void OnWorldSceneSaved(UnityEngine.SceneManagement.Scene scene) => WorldSaveDone();

    static void OnWorldPrefabSaved(GameObject root) => WorldSaveDone();

    static void WorldSaveDone()
    {
        if (_worldSaving <= 0) return;
        if (--_worldSaving == 0) SafeEmit(false);
    }

    static void ClearWorldSaving()
    {
        _worldSaveClearQueued = false;
        if (_worldSaving == 0) return;
        _worldSaving = 0;
        SafeEmit(false);
    }

    internal static void MarkWorldStructuralDirty()
    {
        _worldStructuralDirty = true;
    }

    static void OnWorldPauseStateChanged(PauseState state)
    {
        SafeEmit(false);
    }

    static void OnWorldCompilationStarted(object ctx)
    {
        _worldCycleErrors = new List<string>();
        if (SessionState.GetInt(SS_CMD_PENDING_ID, 0) > 0
            && SessionState.GetString(SS_CMD_PENDING_KIND, "") == "recompile")
            SessionState.SetInt(SS_CMD_PENDING_PHASE, PHASE_COMPILING);
    }

    static void OnWorldAssemblyFinished(string assembly, CompilerMessage[] messages)
    {
        if (_worldCycleErrors == null) _worldCycleErrors = new List<string>();
        foreach (var m in messages)
            if (m.type == CompilerMessageType.Error) _worldCycleErrors.Add(m.message);
    }

    static void OnWorldCompilationFinished(object ctx)
    {
        _cachedCompileError = (_worldCycleErrors != null && _worldCycleErrors.Count > 0)
            ? string.Join("\n", _worldCycleErrors)
            : null;
        _worldCycleErrors = null;
        _worldStructuralDirty = true;

        try { SafeEmit(true); }
        catch (Exception e) { Debug.LogWarning("[World] emit on compile finished failed: " + e.Message); }
    }

    static void PumpWorldState()
    {
        try
        {
            FinalizePending();

            double now = EditorApplication.timeSinceStartup;
            bool due = now - _lastWorldPump >= WORLD_PUMP_INTERVAL;
            if (due || _worldGreetNeeded || _worldStructuralDirty)
            {
                _lastWorldPump = now;
                EmitWorldState(false);
            }
        }
        catch (Exception e) { Debug.LogWarning("[World] pump failed: " + e.Message); }
    }

    static int CurWorldVersion() => SessionState.GetInt(SS_WORLD_VERSION, 0);

    static void SafeEmit(bool force)
    {
        try { EmitWorldState(force); }
        catch (Exception e) { Debug.LogWarning("[World] emit failed: " + e.Message); }
    }

    static void EmitWorldState(bool force)
    {
        if (_cachedScenes == null || _worldStructuralDirty)
        {
            _cachedScenes = GatherScenes();
            _cachedWorldTail = null;
        }
        if (_cachedWorldTail == null)
            _cachedWorldTail = DIGEST_SECTION + string.Join(DIGEST_ITEM, _cachedScenes);
        _worldStructuralDirty = false;

        var inst = GatherInstance();
        string instObj = BuildInstanceObject(inst);
        bool changed = force || instObj != _lastWorldDigest || !string.Equals(_cachedWorldTail, _lastWorldTail);
        if (changed)
        {
            _lastWorldDigest = instObj;
            _lastWorldTail = _cachedWorldTail;
            int baseVersion = SessionState.GetInt(SS_WORLD_VERSION, 0);
            int version = baseVersion + 1;
            SessionState.SetInt(SS_WORLD_VERSION, version);

            WriteFloor(version, inst.refreshGen);
            WriteWorldJson(version, inst.id, instObj, _cachedScenes);
            BroadcastWorldPatch(baseVersion, version, inst.id, instObj, _cachedScenes);
        }

        if (_worldGreetNeeded)
        {
            _worldGreetNeeded = false;
            int version = SessionState.GetInt(SS_WORLD_VERSION, 0);
            BroadcastWorldSnapshot(version, inst.id, instObj, _cachedScenes);
        }
    }

    static void SampleEditorProgress(out string label, out int pct)
    {
        label = "";
        pct = -1;
        try
        {
            if (!Progress.running) return;
            foreach (var item in Progress.EnumerateItems())
            {
                if (item == null || !item.running) continue;
                if (item.priority == (int)Progress.Priority.Idle) continue;
                string name = item.name ?? "";
                string desc = item.description ?? "";
                if (name.Length == 0 && desc.Length == 0) continue;
                label = desc.Length == 0 ? name : (name.Length == 0 ? desc : name + ": " + desc);
                break;
            }
            if (label.Length == 0) return;
            if (label.Length > PROGRESS_LABEL_MAX) label = label.Substring(0, PROGRESS_LABEL_MAX);
            float g = Progress.globalProgress;
            pct = g < 0f ? -1 : Mathf.Clamp(Mathf.RoundToInt(g * 20f) * 5, 0, 100);
        }
        catch
        {
            label = "";
            pct = -1;
        }
    }

    static WorldInstanceState GatherInstance()
    {
        bool isPlaying = EditorApplication.isPlaying;
        bool isCompiling = EditorApplication.isCompiling;

        string progressLabel;
        int progressPct;
        SampleEditorProgress(out progressLabel, out progressPct);
        if (progressLabel.Length == 0)
        {
            string hold = isPlaying ? LocalStreamServer.Instance?.HoldReason : null;
            if (!string.IsNullOrEmpty(hold)) progressLabel = hold;
            else if (EditorApplication.isUpdating) progressLabel = "Importing assets…";
        }

        string lifecycle;
        if (isPlaying) lifecycle = "playing";
        else if (_stoppingPlay || SessionState.GetBool(SS_PENDING_STOP, false)) lifecycle = "exiting-play";
        else if (SessionState.GetBool(SS_PENDING_PLAY, false)) lifecycle = "entering-play";
        else lifecycle = "editmode";

        bool reloading = SessionState.GetInt(SS_CMD_PENDING_ID, 0) > 0
                         && SessionState.GetString(SS_CMD_PENDING_KIND, "") == "reload";
        string compile = (isCompiling || reloading) ? "compiling" : (_cachedCompileError != null ? "error" : "idle");

        int clientCount;
        lock (_ctrlClientsLock) clientCount = _ctrlClients.Count;

        return new WorldInstanceState
        {
            id = ResolveInstanceId(),
            role = IsCloneInstance() ? "clone" : "primary",
            playerIndex = ResolvePlayerIndex(),
            lifecycle = lifecycle,
            compile = compile,
            compileError = compile == "error" ? _cachedCompileError : null,
            scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path ?? "",
            refreshGen = SessionState.GetInt(SS_REFRESH_GEN, 0),
            sceneGen = SessionState.GetInt(SS_SCENE_GEN, 0),
            playGen = SessionState.GetInt(SS_PLAY_GEN, 0),
            pauseGen = SessionState.GetInt(SS_PAUSE_GEN, 0),
            assetSeq = CurrentAssetSeq(),
            paused = EditorApplication.isPaused,
            hotReloadActive = _cachedHotReload,
            sceneDirty = AnyLoadedSceneDirty(),
            dirtyScenes = DirtySceneList(),
            saving = _worldSaving > 0,
            progressLabel = progressLabel,
            progressPct = progressPct,
            noCamera = isPlaying && LocalStreamServer.Instance != null && LocalStreamServer.Instance.NoCamera,
            connected = clientCount > 0,
            alive = true,
            reachable = true,
            fps = 0,
            ping = 0
        };
    }

    static string[] GatherScenes()
    {
        var set = new SortedSet<string>(StringComparer.Ordinal);
        try
        {
            foreach (var guid in AssetDatabase.FindAssets("t:Scene", new[] { "Assets" }))
            {
                var p = AssetDatabase.GUIDToAssetPath(guid);
                if (!string.IsNullOrEmpty(p) && p.EndsWith(".unity")) set.Add(p);
            }
        }
        catch (Exception e) { Debug.LogWarning("[World] scene enumeration failed: " + e.Message); }
        return set.ToArray();
    }

    static string ResolveInstanceId()
    {
        var env = Environment.GetEnvironmentVariable("MC_INSTANCE_ID");
        if (!string.IsNullOrEmpty(env)) return env;
        return Path.GetFileName(ProjectRoot);
    }

    static string DirtySceneList()
    {
        var sb = new StringBuilder();
        for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++)
        {
            var sc = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
            if (!sc.IsValid() || !sc.isLoaded || !sc.isDirty) continue;
            if (sb.Length > 0) sb.Append('\n');
            sb.Append(string.IsNullOrEmpty(sc.path) ? (string.IsNullOrEmpty(sc.name) ? "Untitled" : sc.name) : sc.path);
        }
        return sb.ToString();
    }

    static bool AnyLoadedSceneDirty()
    {
        for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++)
        {
            var sc = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i);
            if (sc.IsValid() && sc.isLoaded && sc.isDirty) return true;
        }
        return false;
    }

    static bool IsCloneInstance()
    {
        return Array.IndexOf(Environment.GetCommandLineArgs(), "--virtual-project-clone") >= 0;
    }

    static int ResolvePlayerIndex()
    {
        var env = Environment.GetEnvironmentVariable("MC_PLAYER_INDEX");
        if (int.TryParse(env, out var i) && i >= 0) return i;
        return 0;
    }

    static string SafeReadCompileErrorsFromDisk()
    {
        try
        {
            if (File.Exists(CompileErrorsPath))
            {
                var txt = File.ReadAllText(CompileErrorsPath).Trim();
                if (!string.IsNullOrEmpty(txt)) return txt;
            }
        }
        catch { }
        return null;
    }

    static bool SafeReadHotReloadFromReflection()
    {
        try
        {
            var prop = FindHotReloadEnabledProperty();
            if (prop == null) return false;
            return prop.GetValue(null) is bool b && b;
        }
        catch { return false; }
    }

    static bool HotReloadPackageAvailable()
    {
        try { return FindHotReloadEnabledProperty() != null; }
        catch { return false; }
    }

    static string BuildInstanceObject(WorldInstanceState s)
    {
        var sb = new StringBuilder(256);
        sb.Append('{');
        sb.Append("\"id\":").Append(JStr(s.id)).Append(',');
        sb.Append("\"role\":").Append(JStr(s.role)).Append(',');
        sb.Append("\"playerIndex\":").Append(s.playerIndex).Append(',');
        sb.Append("\"lifecycle\":").Append(JStr(s.lifecycle)).Append(',');
        sb.Append("\"compile\":").Append(JStr(s.compile)).Append(',');
        sb.Append("\"compileError\":").Append(s.compileError == null ? "null" : JStr(s.compileError)).Append(',');
        sb.Append("\"scene\":").Append(JStr(s.scene)).Append(',');
        sb.Append("\"refreshGen\":").Append(s.refreshGen).Append(',');
        sb.Append("\"sceneGen\":").Append(s.sceneGen).Append(',');
        sb.Append("\"playGen\":").Append(s.playGen).Append(',');
        sb.Append("\"pauseGen\":").Append(s.pauseGen).Append(',');
        sb.Append("\"assetSeq\":").Append(s.assetSeq).Append(',');
        sb.Append("\"paused\":").Append(s.paused ? "true" : "false").Append(',');
        sb.Append("\"hotReloadActive\":").Append(s.hotReloadActive ? "true" : "false").Append(',');
        sb.Append("\"sceneDirty\":").Append(s.sceneDirty ? "true" : "false").Append(',');
        sb.Append("\"dirtyScenes\":").Append(JStr(s.dirtyScenes ?? "")).Append(',');
        sb.Append("\"saving\":").Append(s.saving ? "true" : "false").Append(',');
        sb.Append("\"progressLabel\":").Append(JStr(s.progressLabel ?? "")).Append(',');
        sb.Append("\"progressPct\":").Append(s.progressPct).Append(',');
        sb.Append("\"noCamera\":").Append(s.noCamera ? "true" : "false").Append(',');
        sb.Append("\"connected\":").Append(s.connected ? "true" : "false").Append(',');
        sb.Append("\"alive\":").Append(s.alive ? "true" : "false").Append(',');
        sb.Append("\"reachable\":").Append(s.reachable ? "true" : "false").Append(',');
        sb.Append("\"fps\":").Append(s.fps).Append(',');
        sb.Append("\"ping\":").Append(s.ping);
        sb.Append('}');
        return sb.ToString();
    }

    static string BuildStringArray(string[] items)
    {
        var sb = new StringBuilder(64);
        sb.Append('[');
        for (int i = 0; i < items.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(JStr(items[i]));
        }
        sb.Append(']');
        return sb.ToString();
    }

    static string BuildWorldObject(int version, string instanceId, string instanceObj, string[] scenes)
    {
        var sb = new StringBuilder(512);
        sb.Append('{');
        sb.Append("\"version\":").Append(version).Append(',');
        sb.Append("\"project\":{")
          .Append("\"path\":").Append(JStr(ProjectRoot)).Append(',')
          .Append("\"isUnityProject\":true,")
          .Append("\"editorVersion\":").Append(JStr(Application.unityVersion))
          .Append("},");
        sb.Append("\"scenes\":").Append(BuildStringArray(scenes)).Append(',');
        sb.Append("\"instances\":{").Append(JStr(instanceId)).Append(':').Append(instanceObj).Append('}');
        sb.Append('}');
        return sb.ToString();
    }

    static void WriteWorldJson(int version, string instanceId, string instanceObj, string[] scenes)
    {
        string world = BuildWorldObject(version, instanceId, instanceObj, scenes);
        string file = "{\"schema\":1,\"world\":" + world + "}";
        try { AtomicWriteAllText(WorldJsonPath, file); }
        catch (Exception e) { Debug.LogWarning("[World] world.json write failed: " + e.Message); }
    }

    static void WriteFloor(int version, int refreshGen)
    {
        try { AtomicWriteAllText(WorldFloorPath, JsonUtility.ToJson(new WorldFloorData { version = version, refreshGen = refreshGen })); }
        catch { }
    }

    static int ParseWorldJsonVersion()
    {
        try
        {
            if (!File.Exists(WorldJsonPath)) return 0;
            var txt = File.ReadAllText(WorldJsonPath);
            const string key = "\"version\":";
            int i = txt.IndexOf(key, StringComparison.Ordinal);
            if (i < 0) return 0;
            i += key.Length;
            while (i < txt.Length && txt[i] == ' ') i++;
            int start = i;
            while (i < txt.Length && (char.IsDigit(txt[i]) || txt[i] == '-')) i++;
            if (i > start && int.TryParse(txt.Substring(start, i - start), out var v)) return Math.Max(0, v);
        }
        catch { }
        return 0;
    }

    static int ParseWorldJsonRefreshGen()
    {
        try
        {
            if (!File.Exists(WorldJsonPath)) return 0;
            var txt = File.ReadAllText(WorldJsonPath);
            const string key = "\"refreshGen\":";
            int best = 0, i = 0;
            while ((i = txt.IndexOf(key, i, StringComparison.Ordinal)) >= 0)
            {
                i += key.Length;
                while (i < txt.Length && txt[i] == ' ') i++;
                int start = i;
                while (i < txt.Length && (char.IsDigit(txt[i]) || txt[i] == '-')) i++;
                if (i > start && int.TryParse(txt.Substring(start, i - start), out var v)) best = Math.Max(best, v);
            }
            return Math.Max(0, best);
        }
        catch { }
        return 0;
    }

    static void BroadcastWorldSnapshot(int version, string instanceId, string instanceObj, string[] scenes)
    {
        if (_ctrlPort == 0) return;
        string world = BuildWorldObject(version, instanceId, instanceObj, scenes);
        CtrlBroadcast("{\"type\":\"event\",\"event\":\"world/snapshot\",\"world\":" + world + "}");
    }

    static void BroadcastWorldPatch(int baseVersion, int version, string instanceId, string instanceObj, string[] scenes)
    {
        if (_ctrlPort == 0) return;
        var sb = new StringBuilder(512);
        sb.Append("{\"type\":\"event\",\"event\":\"world/patch\",");
        sb.Append("\"baseVersion\":").Append(baseVersion).Append(',');
        sb.Append("\"version\":").Append(version).Append(',');
        sb.Append("\"patch\":{");
        sb.Append("\"scenes\":").Append(BuildStringArray(scenes)).Append(',');
        sb.Append("\"instances\":{").Append(JStr(instanceId)).Append(':').Append(instanceObj).Append('}');
        sb.Append("}}");
        CtrlBroadcast(sb.ToString());
    }

    static string JStr(string s)
    {
        return "\"" + JsonEscape(s) + "\"";
    }

    static string JsonEscape(string s)
    {
        if (string.IsNullOrEmpty(s)) return "";
        var sb = new StringBuilder(s.Length + 8);
        foreach (char c in s)
        {
            switch (c)
            {
                case '\\': sb.Append("\\\\"); break;
                case '"': sb.Append("\\\""); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                case '\b': sb.Append("\\b"); break;
                case '\f': sb.Append("\\f"); break;
                default:
                    if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                    else sb.Append(c);
                    break;
            }
        }
        return sb.ToString();
    }

    static void AtomicWriteAllText(string path, string content)
    {
        SspaceFolder.EnsureFor(path);
        var tmp = path + ".tmp." + System.Diagnostics.Process.GetCurrentProcess().Id;
        File.WriteAllText(tmp, content);

        const int maxAttempts = 10;
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                if (File.Exists(path))
                    File.Replace(tmp, path, null, true);
                else
                    File.Move(tmp, path);
                return;
            }
            catch (Exception) when (attempt < maxAttempts - 1)
            {
                System.Threading.Thread.Sleep(Math.Min(15 << attempt, 400));
            }
            catch (Exception e)
            {
                try { if (File.Exists(tmp)) File.Delete(tmp); } catch { }
                throw new IOException("atomic write failed for " + path + ": " + e.Message, e);
            }
        }
    }
}

public static partial class MCPTestBridge
{
    const string SS_CLONE_ASSET_SEQ = "SaturaSpace_Clone_AssetSeq";
    const string SS_CLONE_RELOAD_SIG = "SaturaSpace_Clone_ReloadSig";
    const string SS_CLONE_RELOAD_SIG_PENDING = "SaturaSpace_Clone_ReloadSigPending";
    const string SS_CLONE_SCENE_STALE = "SaturaSpace_Clone_SceneStale";

    static string CloneRealRoot() => Path.GetFullPath(Path.Combine(ProjectRoot, "..", "..", ".."));

    static string AssetBatchesPath => Path.Combine(
        IsCloneInstance() ? Path.Combine(CloneRealRoot(), ".sspace") : SspaceRoot,
        ".mcp_asset_batches.json");

    [Serializable]
    class AssetBatchEntry
    {
        public int seq;
        public string path;
        public bool removed;
    }

    [Serializable]
    class AssetBatchesDto
    {
        public int maxSeq;
        public AssetBatchEntry[] entries;
    }

    static int _primaryAssetSeq = -1;

    static int CurrentAssetSeq()
    {
        if (IsCloneInstance()) return SessionState.GetInt(SS_CLONE_ASSET_SEQ, 0);
        if (_primaryAssetSeq < 0)
        {
            var dto = ReadAssetBatches();
            _primaryAssetSeq = dto != null ? Math.Max(0, dto.maxSeq) : 0;
        }
        return _primaryAssetSeq;
    }

    internal static void RecordImportedAssets(string[] imported, string[] moved, string[] deleted)
    {
        if (Inert || IsCloneInstance()) return;
        var fresh = new List<string>();
        CollectSyncablePaths(imported, fresh);
        CollectSyncablePaths(moved, fresh);
        var gone = new List<string>();
        CollectSyncablePaths(deleted, gone);
        if (fresh.Count == 0 && gone.Count == 0) return;
        try
        {
            var dto = ReadAssetBatches() ?? new AssetBatchesDto { maxSeq = 0, entries = new AssetBatchEntry[0] };
            int seq = dto.maxSeq + 1;
            var list = new List<AssetBatchEntry>();
            if (dto.entries != null) list.AddRange(dto.entries);
            foreach (var p in fresh) list.Add(new AssetBatchEntry { seq = seq, path = p });
            foreach (var p in gone) list.Add(new AssetBatchEntry { seq = seq, path = p, removed = true });
            if (list.Count > 500) list.RemoveRange(0, list.Count - 500);
            AtomicWriteAllText(AssetBatchesPath,
                JsonUtility.ToJson(new AssetBatchesDto { maxSeq = seq, entries = list.ToArray() }));
            _primaryAssetSeq = seq;
            MarkWorldStructuralDirty();
        }
        catch (Exception e) { Debug.LogWarning("[World] asset batch record failed: " + e.Message); }
    }

    static void CollectSyncablePaths(string[] paths, List<string> into)
    {
        if (paths == null) return;
        foreach (var p in paths)
            if (p != null
                && p.StartsWith("Assets/", StringComparison.Ordinal)
                && !p.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
                into.Add(p);
    }

    static AssetBatchesDto ReadAssetBatches()
    {
        try
        {
            var f = AssetBatchesPath;
            if (!File.Exists(f)) return null;
            return JsonUtility.FromJson<AssetBatchesDto>(File.ReadAllText(f));
        }
        catch { return null; }
    }

    internal static void BaselineCloneAssetSeq()
    {
        if (!IsCloneInstance()) return;
        if (SessionState.GetInt(SS_CLONE_ASSET_SEQ, -1) >= 0) return;
        var dto = ReadAssetBatches();
        SessionState.SetInt(SS_CLONE_ASSET_SEQ, dto != null ? dto.maxSeq : 0);
        SessionState.SetString(SS_CLONE_RELOAD_SIG, CloneReloadSignature());
    }

    static string CloneAssemblySignature()
    {
        long ticks = 0;
        int count = 0;
        try
        {
            var dir = Path.Combine(CloneRealRoot(), "Library", "ScriptAssemblies");
            if (Directory.Exists(dir))
            {
                foreach (var f in Directory.GetFiles(dir, "*.dll"))
                {
                    count++;
                    long t = File.GetLastWriteTimeUtc(f).Ticks;
                    if (t > ticks) ticks = t;
                }
            }
        }
        catch { }
        return count + ":" + ticks;
    }

    static string CloneReloadSignature()
    {
        var dto = ReadAssetBatches();
        int seq = dto != null ? dto.maxSeq : 0;
        return seq + ":" + CloneAssemblySignature();
    }

    internal static bool CloneAssembliesUnchanged()
    {
        string last = SessionState.GetString(SS_CLONE_RELOAD_SIG, "");
        int i = last.IndexOf(':');
        if (i < 0) return false;
        return last.Substring(i + 1) == CloneAssemblySignature();
    }

    internal static bool CloneFreshBatchHasRemovals()
    {
        var dto = ReadAssetBatches();
        if (dto == null || dto.entries == null) return false;
        int seen = SessionState.GetInt(SS_CLONE_ASSET_SEQ, 0);
        foreach (var e in dto.entries)
            if (e != null && e.seq > seen && e.removed) return true;
        return false;
    }

    internal static void SyncCloneAssetsLight()
    {
        try { AssetDatabase.Refresh(); }
        catch (Exception e) { Debug.LogWarning("[MCPTestBridge] clone light asset refresh failed: " + e.Message); }
        TryLoadFreshAssets(true);
        SessionState.SetString(SS_CLONE_RELOAD_SIG, CloneReloadSignature());
    }

    internal static bool CloneNeedsReload()
    {
        string last = SessionState.GetString(SS_CLONE_RELOAD_SIG, "");
        return last == "" || last != CloneReloadSignature();
    }

    internal static void StampCloneReloadSigPending()
    {
        SessionState.SetString(SS_CLONE_RELOAD_SIG_PENDING, CloneReloadSignature());
    }

    internal static void CommitCloneReloadSig()
    {
        string pending = SessionState.GetString(SS_CLONE_RELOAD_SIG_PENDING, "");
        if (pending == "") return;
        SessionState.SetString(SS_CLONE_RELOAD_SIG, pending);
        SessionState.EraseString(SS_CLONE_RELOAD_SIG_PENDING);
    }

    internal static void TryLoadFreshAssets(bool forceImport = false)
    {
        if (!IsCloneInstance()) return;
        var dto = ReadAssetBatches();
        if (dto == null || dto.entries == null) return;
        int seen = SessionState.GetInt(SS_CLONE_ASSET_SEQ, 0);
        if (dto.maxSeq <= seen) return;
        var freshPaths = new List<string>();
        foreach (var e in dto.entries)
        {
            if (e == null || e.seq <= seen || string.IsNullOrEmpty(e.path)) continue;
            if (e.removed)
            {
                SaturaDebug.Log("[MCPTestBridge] clone asset sync " + e.path + ": removed");
                continue;
            }
            freshPaths.Add(e.path);
            try
            {
                if (forceImport)
                    AssetDatabase.ImportAsset(e.path, ImportAssetOptions.ForceUpdate);
                var obj = AssetDatabase.LoadMainAssetAtPath(e.path);
                string verdict = obj == null ? "NULL" : obj.GetType().Name;
                var sh = obj as Shader;
                if (sh != null)
                    verdict += Shader.Find(sh.name) != null ? " find-ok" : " find-null";
                SaturaDebug.Log("[MCPTestBridge] clone asset sync " + e.path + ": " + verdict);
            }
            catch (Exception ex)
            {
                Debug.LogWarning("[MCPTestBridge] clone asset sync load failed " + e.path + ": " + ex.Message);
            }
        }
        SessionState.SetInt(SS_CLONE_ASSET_SEQ, dto.maxSeq);
        MarkCloneStaleScenes(freshPaths.ToArray());
    }

    internal static void MarkCloneStaleScenes(string[] paths)
    {
        if (!IsCloneInstance() || paths == null) return;
        foreach (var p in paths)
        {
            if (p == null || !p.EndsWith(".unity", StringComparison.OrdinalIgnoreCase)) continue;
            if (!IsSceneLoaded(p)) continue;
            if (!SessionState.GetBool(SS_CLONE_SCENE_STALE, false))
                Debug.Log("[MCPTestBridge] clone open scene changed on disk: " + p + " — will reload from disk.");
            SessionState.SetBool(SS_CLONE_SCENE_STALE, true);
            return;
        }
    }

    internal static bool CloneOpenSceneStale()
    {
        return IsCloneInstance() && SessionState.GetBool(SS_CLONE_SCENE_STALE, false);
    }

    internal static void ClearCloneSceneStale()
    {
        if (IsCloneInstance()) SessionState.EraseBool(SS_CLONE_SCENE_STALE);
    }

    static bool _orchestratorManagedResolved;
    static bool _orchestratorManaged;

    internal static bool IsOrchestratorManaged
    {
        get
        {
            if (!_orchestratorManagedResolved)
            {
                _orchestratorManagedResolved = true;
                _orchestratorManaged =
                    !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MC_INSTANCE_ID"));
            }
            return _orchestratorManaged;
        }
    }

    static System.Reflection.MethodInfo _clearScenesChangedOnDisk;
    static bool _clearScenesChangedResolved;

    internal static void ClearExternalSceneChangePrompt()
    {
        if (!IsOrchestratorManaged) return;
        if (!_clearScenesChangedResolved)
        {
            _clearScenesChangedResolved = true;
            _clearScenesChangedOnDisk = typeof(EditorSceneManager).GetMethod(
                "ClearOpenScenesChangedOnDisk",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            if (_clearScenesChangedOnDisk == null)
                Debug.LogWarning("[MCPTestBridge] EditorSceneManager.ClearOpenScenesChangedOnDisk not found — "
                    + "the 'scene(s) modified externally' prompt cannot be suppressed.");
        }
        if (_clearScenesChangedOnDisk == null) return;
        try
        {
            _clearScenesChangedOnDisk.Invoke(null, null);
        }
        catch (Exception e)
        {
            _clearScenesChangedOnDisk = null;
            Debug.LogWarning("[MCPTestBridge] ClearOpenScenesChangedOnDisk failed: " + e.Message);
        }
    }

    internal static void ReloadCloneStaleScenes()
    {
        ClearExternalSceneChangePrompt();
        if (!CloneOpenSceneStale()) return;
        if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling) return;
        if (_sceneOpening) return;
        if (SessionState.GetInt(SS_CMD_PENDING_ID, 0) > 0) return;
        ClearCloneSceneStale();
        try
        {
            var setup = EditorSceneManager.GetSceneManagerSetup();
            if (setup == null || setup.Length == 0) return;
            Debug.Log("[MCPTestBridge] clone reloading open scenes from disk (scene file synced from primary).");
            EditorSceneManager.RestoreSceneManagerSetup(setup);
        }
        catch (Exception e)
        {
            Debug.LogWarning("[MCPTestBridge] clone stale-scene reload failed: " + e.Message);
        }
    }
}

sealed class SaturaSpaceWorldSaveWatcher : AssetModificationProcessor
{
    static string[] OnWillSaveAssets(string[] paths)
    {
        if (MCPTestBridge.Inert) return paths;
        try { MCPTestBridge.MarkWorldSaving(paths); }
        catch { }
        try { MCPTestBridge.ExecSavingAssets?.Invoke(paths); }
        catch { }
        return paths;
    }
}

sealed class SaturaSpaceWorldAssetWatcher : AssetPostprocessor
{
    static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
    {
        if (MCPTestBridge.Inert) return;
        MCPTestBridge.RecordImportedAssets(imported, moved, deleted);
        MCPTestBridge.MarkCloneStaleScenes(imported);
        MCPTestBridge.MarkCloneStaleScenes(moved);
        MCPTestBridge.ClearExternalSceneChangePrompt();
        if (Touches(imported) || Touches(deleted) || Touches(moved))
            MCPTestBridge.MarkWorldStructuralDirty();
    }

    static bool Touches(string[] paths)
    {
        if (paths == null) return false;
        foreach (var p in paths)
            if (p != null && (p.EndsWith(".unity") || p.EndsWith(".cs"))) return true;
        return false;
    }
}
