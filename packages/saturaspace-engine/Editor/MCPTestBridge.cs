using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using System;
using System.IO;
using UnityEditor.Compilation;
using SaturaSpace;

[InitializeOnLoad]
public static partial class MCPTestBridge
{
    internal static readonly bool Inert = DetectImportWorker() || !SaturaLaunch.Managed;

    static bool DetectImportWorker()
    {
        try { return AssetDatabase.IsAssetImportWorkerProcess(); }
        catch { return false; }
    }

    static readonly string ProjectRoot = ResolveProjectRoot();

    static string ResolveProjectRoot()
    {
        return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
    }

    static readonly string SspaceRoot = EnsureSspaceRoot();

    internal static string SspaceRootDir => SspaceRoot;

    static string EnsureSspaceRoot()
    {
        var dir = Path.Combine(ProjectRoot, SspaceFolder.DirName);
        return Inert ? dir : SspaceFolder.Ensure(dir);
    }
    static readonly string SceneResultsPath = Path.Combine(SspaceRoot, ".mcp_scene_results.json");
    static readonly string StopPlayResultsPath = Path.Combine(SspaceRoot, ".mcp_stopplay_results.json");
    static readonly string ExecResultsPath = Path.Combine(SspaceRoot, ".mcp_exec_results.json");
    static readonly string StatusPath = Path.Combine(SspaceRoot, ".mcp_status.json");
    static readonly string FlushLogsResultsPath = Path.Combine(SspaceRoot, ".mcp_flush_logs_results.json");
    static readonly string QuitTriggerPath = Path.Combine(SspaceRoot, ".mcp_quit_trigger.json");

    static double _lastCheck;
    static double _lastStatusWrite;
    static bool _lastStatusIsPlaying;
    static bool _lastStatusIsPaused;
    static bool _lastStatusIsCompiling;
    static ulong _lastStatusSceneSig;
    static bool _hasWrittenStatus;
    const double CHECK_INTERVAL = 0.5;
    const double CMD_CHECK_INTERVAL = 0.1;
    static double _lastCmdCheck;
    const double QUIT_POLL_INTERVAL = 0.25;
    static double _lastQuitPoll;
    const string IDLE_TIME_PREF = "ApplicationIdleTime";
    const int EDITMODE_IDLE_MS = 100;
    const int DEFAULT_IDLE_MS = 4;
    const int MAX_USER_IDLE_MS = 33;
    const double STATUS_HEARTBEAT_INTERVAL = 2.0;
    static bool _stoppingPlay;
    static double _lastActivity;
    static double _idleQuitSeconds;
    static double _closeStrayWindowsUntil;

    const string SS_PENDING_SCENE = "MCPTestBridge_PendingScenePath";
    const string SS_PENDING_PLAY  = "MCPTestBridge_PendingPlayMode";
    const string SS_PENDING_STOP  = "MCPTestBridge_PendingStopPlay";

    static readonly System.Collections.Concurrent.ConcurrentQueue<Action> _deferredActions =
        new System.Collections.Concurrent.ConcurrentQueue<Action>();

    public static void RunDeferred(Action action)
    {
        if (action == null) return;
        _deferredActions.Enqueue(action);
        SignalEditorTick();
    }

    static int _delayCallStarvedTicks;

    static void PumpStarvedDelayCalls()
    {
        var pending = EditorApplication.delayCall;
        if (pending == null)
        {
            _delayCallStarvedTicks = 0;
            return;
        }
        _delayCallStarvedTicks++;
        if (_delayCallStarvedTicks < 3) return;
        _delayCallStarvedTicks = 0;
        EditorApplication.delayCall = null;
        foreach (var d in pending.GetInvocationList())
        {
            try { ((EditorApplication.CallbackFunction)d)(); }
            catch (Exception e) { Debug.LogException(e); }
        }
    }

    static void DrainDeferredActions()
    {
        int count = _deferredActions.Count;
        for (int i = 0; i < count; i++)
        {
            Action deferred;
            if (!_deferredActions.TryDequeue(out deferred)) break;
            try { deferred(); }
            catch (Exception e) { Debug.LogError("[MCPTestBridge] RunDeferred action threw: " + e); }
        }
    }

    static MCPTestBridge()
    {
        if (Inert) return;
        SaturaHandles.PlayerIndex = ResolvePlayerIndex();
        EditorApplication.update += OnUpdate;
        EditorApplication.playModeStateChanged += OnPlayModeChanged;
        WriteStatus();
        _idleQuitSeconds = ParseIdleQuit();
        _lastActivity = EditorApplication.timeSinceStartup;
        if (Application.isBatchMode)
            _closeStrayWindowsUntil = EditorApplication.timeSinceStartup + 15.0;

        if (OrchestratorManaged)
        {
            HealLeakedEditorIdle();
            EditorApplication.quitting += RestoreEditorIdle;
        }

        SuppressClonePresent();
        SaturaPrefGuard.Init();
        Debug.Log("[MCPTestBridge] Initialized. Watching for triggers."
            + (_idleQuitSeconds > 0 ? $" Headless idle self-quit in {_idleQuitSeconds:F0}s." : ""));
    }

    static double ParseIdleQuit()
    {
        if (!Application.isBatchMode) return 0;
        var args = Environment.GetCommandLineArgs();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "-mcpIdleQuit" && double.TryParse(args[i + 1], out var s) && s > 0)
                return s;
        return 0;
    }

    static readonly bool IsVirtualProjectClone =
        Array.IndexOf(Environment.GetCommandLineArgs(), "--virtual-project-clone") >= 0;

    static bool ManagesEditorIdle => Application.isBatchMode || IsVirtualProjectClone;

    const string OPEN_GAMEVIEW_ON_PLAY_PREF = "OpenGameViewOnEnteringPlayMode";
    static bool _gameViewPrefSaved;
    static bool _gameViewPrefPrior;

    static void SuppressClonePresent()
    {
        if (Application.platform != RuntimePlatform.WindowsEditor) return;
        if (!IsVirtualProjectClone) return;
        try
        {
            if (!_gameViewPrefSaved)
            {
                _gameViewPrefPrior = EditorPrefs.GetBool(OPEN_GAMEVIEW_ON_PLAY_PREF, true);
                _gameViewPrefSaved = true;
                EditorApplication.quitting += RestoreGameViewPref;
            }
            EditorPrefs.SetBool(OPEN_GAMEVIEW_ON_PLAY_PREF, false);
            RunOnNextUpdate(CloseClonePlayModeViews);
        }
        catch { }
    }

    static void RestoreGameViewPref()
    {
        if (!_gameViewPrefSaved) return;
        try { EditorPrefs.SetBool(OPEN_GAMEVIEW_ON_PLAY_PREF, _gameViewPrefPrior); }
        catch { }
    }

    static void CloseClonePlayModeViews()
    {
        if (Application.platform != RuntimePlatform.WindowsEditor) return;
        if (!IsVirtualProjectClone) return;
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null) continue;
            var n = w.GetType().Name;
            if (n != "GameView" && n != "SimulatorWindow") continue;
            try { w.Close(); }
            catch { }
        }
    }

    static void HealLeakedEditorIdle()
    {
        try
        {
            int cur = EditorPrefs.GetInt(IDLE_TIME_PREF, DEFAULT_IDLE_MS);
            if (cur <= MAX_USER_IDLE_MS) return;
            EditorPrefs.SetInt(IDLE_TIME_PREF, DEFAULT_IDLE_MS);
            RefreshInteractionMode();
            Debug.Log($"[MCPTestBridge] editor idle was {cur} ms, outside Unity's 0-{MAX_USER_IDLE_MS} ms range, so an older Satura Space left it behind; reset to {DEFAULT_IDLE_MS} ms");
        }
        catch (Exception e) { Debug.LogWarning("[MCPTestBridge] couldn't check the editor idle setting: " + e.Message); }
    }

    const string SS_USER_IDLE = "MCPTestBridge_UserIdleMs";
    static int _userIdleMs = SessionState.GetInt(SS_USER_IDLE, -1);
    static System.Reflection.MethodInfo _updateInteractionMode;
    static bool _updateInteractionModeResolved;

    static void SyncEditorIdle(bool fast)
    {
        if (!OrchestratorManaged || fast == (_userIdleMs >= 0)) return;
        if (fast)
        {
            _userIdleMs = EditorPrefs.GetInt(IDLE_TIME_PREF, DEFAULT_IDLE_MS);
            SessionState.SetInt(SS_USER_IDLE, _userIdleMs);
            if (_userIdleMs <= DEFAULT_IDLE_MS) return;
            EditorPrefs.SetInt(IDLE_TIME_PREF, DEFAULT_IDLE_MS);
            SaturaDebug.Log($"[MCPTestBridge] editor idle {_userIdleMs} ms -> {DEFAULT_IDLE_MS} ms while the editor runs hidden");
        }
        else
        {
            int user = _userIdleMs;
            _userIdleMs = -1;
            SessionState.EraseInt(SS_USER_IDLE);
            if (user <= DEFAULT_IDLE_MS || EditorPrefs.GetInt(IDLE_TIME_PREF, DEFAULT_IDLE_MS) != DEFAULT_IDLE_MS) return;
            EditorPrefs.SetInt(IDLE_TIME_PREF, user);
        }
        RefreshInteractionMode();
    }

    static void RestoreEditorIdle() => SyncEditorIdle(false);

    static void RefreshInteractionMode()
    {
        if (!_updateInteractionModeResolved)
        {
            _updateInteractionModeResolved = true;
            _updateInteractionMode = typeof(EditorApplication).GetMethod("UpdateInteractionModeSettings",
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Public, null, Type.EmptyTypes, null);
            if (_updateInteractionMode == null) Debug.LogWarning("[MCPTestBridge] EditorApplication.UpdateInteractionModeSettings not found, the editor idle change waits for a restart");
        }
        try { _updateInteractionMode?.Invoke(null, null); }
        catch (Exception e) { Debug.LogWarning("[MCPTestBridge] couldn't apply the editor idle change: " + e.Message); }
    }

    static void CloseStrayEditorWindows()
    {
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null) continue;
            var ns = w.GetType().Namespace;
            if (ns != null && ns.StartsWith("UnityEditor")) continue;
            try { w.Close(); }
            catch { }
        }
    }

    static void OnPlayModeChanged(PlayModeStateChange state)
    {
        if (state == PlayModeStateChange.ExitingEditMode)
        {
            SuppressClonePresent();
            ClearTagLogsBeforePlay();
        }

        if (state == PlayModeStateChange.EnteredPlayMode)
            RunOnNextUpdate(CloseClonePlayModeViews);

        if (state == PlayModeStateChange.EnteredEditMode)
        {
            if (SessionState.GetBool(SS_PENDING_STOP, false))
            {
                SessionState.EraseBool(SS_PENDING_STOP);
                WriteStopPlayResult("completed", "");
                _stoppingPlay = false;
                Debug.Log("[MCPTestBridge] Play Mode stopped.");
            }

            if (!string.IsNullOrEmpty(SessionState.GetString(SS_PENDING_SCENE, "")))
                RunOnNextUpdate(ResumePendingScene);
        }
        else if (state == PlayModeStateChange.EnteredPlayMode)
        {
            string pendingScene = SessionState.GetString(SS_PENDING_SCENE, "");
            if (string.IsNullOrEmpty(pendingScene)) return;

            bool pendingPlay = SessionState.GetBool(SS_PENDING_PLAY, false);
            if (!pendingPlay) return;

            ErasePendingScene();
            SessionState.EraseInt(SS_SCENE_RESUME_TRIES);

            RunOnNextUpdate(() =>
            {
                WriteSceneResult("completed", pendingScene, true, "");
                _sceneOpening = false;
            });
        }
    }

    static void OnUpdate()
    {
        long tpStart = TpNow();
        try { OnUpdateInner(); }
        finally { TpAdd(TP_BRIDGE, tpStart); }
    }

    static void OnUpdateInner()
    {
        StampMainThreadPump();
        TunerWoke();

        long tp = TpNow();
        bool revealed = RevealActive();
        _editorRevealed = revealed;
        SaturaFrameRate.EditorTick(EditorApplication.isPlaying && !EditorApplication.isPaused && !revealed
            && _tuners.Count == 0 && s_TiSessions.Count == 0);
        TpAdd(TP_BR_REVEAL, tp);
        tp = TpNow();
        var stream = LocalStreamServer.Instance;
        if (stream != null)
        {
            stream.CaptureSuspended = revealed;
            stream.EditorPump();
        }

        var rawInput = RawInputStream.Instance;
        if (rawInput != null) rawInput.SetInputSuspended(revealed);
        SyncCursorLockEmulation(!revealed);
        SyncEditorIdle(ManagesEditorIdle || (EditorApplication.isPlaying && !revealed) || TunerWantsFastIdle(revealed));
        TpAdd(TP_BR_STREAM, tp);

        tp = TpNow();
        DrainControl();
        PollInputScheme();

        DrainDeferredActions();

        PumpStarvedDelayCalls();
        TpAdd(TP_BR_CONTROL, tp);

        tp = TpNow();
        PumpDefuseOrphanMaximize();

        PumpRevealLayout();
        TpAdd(TP_BR_REVEAL, tp);

        tp = TpNow();
        bool isPlaying = EditorApplication.isPlaying;
        bool isPaused = EditorApplication.isPaused;
        bool isCompiling = EditorApplication.isCompiling;
        ulong sceneSig = SceneStatusSig();
        bool stateChanged = !_hasWrittenStatus
            || isPlaying != _lastStatusIsPlaying
            || isPaused != _lastStatusIsPaused
            || isCompiling != _lastStatusIsCompiling
            || sceneSig != _lastStatusSceneSig;
        if (stateChanged
            || EditorApplication.timeSinceStartup - _lastStatusWrite > STATUS_HEARTBEAT_INTERVAL)
        {
            _lastStatusWrite = EditorApplication.timeSinceStartup;
            _lastStatusIsPlaying = isPlaying;
            _lastStatusIsPaused = isPaused;
            _lastStatusIsCompiling = isCompiling;
            _lastStatusSceneSig = sceneSig;
            _hasWrittenStatus = true;
            WriteStatus();
            if (stateChanged) BroadcastStatusEvent();
        }
        TpAdd(TP_BR_STATUS, tp);
        tp = TpNow();

        if (ManagesEditorIdle && !isPlaying && !isCompiling && !revealed && !_execSnippetPending)
            System.Threading.Thread.Sleep(EDITMODE_IDLE_MS);

        if (EditorApplication.timeSinceStartup - _lastQuitPoll >= QUIT_POLL_INTERVAL)
        {
            _lastQuitPoll = EditorApplication.timeSinceStartup;
            if (File.Exists(QuitTriggerPath))
            {
                try { File.Delete(QuitTriggerPath); } catch (IOException) { }
                Debug.Log("[MCPTestBridge] Quit trigger received. Exiting.");
                KeepUnsavedScenesOnQuit();
                RestoreLayoutOnQuit();
                RestoreEditorIdle();
                EditorApplication.Exit(0);
                return;
            }
        }

        if (_closeStrayWindowsUntil > 0)
        {
            if (EditorApplication.timeSinceStartup < _closeStrayWindowsUntil) CloseStrayEditorWindows();
            else _closeStrayWindowsUntil = 0;
        }

        if (!EditorApplication.isPlaying && SessionState.GetBool(SS_PENDING_STOP, false))
        {
            SessionState.EraseBool(SS_PENDING_STOP);
            WriteStopPlayResult("completed", "");
            _stoppingPlay = false;
            Debug.Log("[MCPTestBridge] Play Mode stopped (caught in OnUpdate).");
        }

        TpAdd(TP_BR_REST, tp);
        tp = TpNow();
        PumpWorldState();
        TpAdd(TP_BR_WORLD, tp);

        if (EditorApplication.isCompiling)
            _lastActivity = EditorApplication.timeSinceStartup;

        if (_execSnippetPending || EditorApplication.timeSinceStartup - _lastCmdCheck >= CMD_CHECK_INTERVAL)
        {
            _lastCmdCheck = EditorApplication.timeSinceStartup;
            tp = TpNow();
            PumpCommandLog();
            TpAdd(TP_BR_CMDLOG, tp);
        }

        if (EditorApplication.timeSinceStartup - _lastCheck < CHECK_INTERVAL)
            return;
        _lastCheck = EditorApplication.timeSinceStartup;

        ReloadCloneStaleScenes();

        PumpMppmCloneLinks();

        if (_idleQuitSeconds > 0 && HasPendingWork())
            _lastActivity = EditorApplication.timeSinceStartup;

        if (_idleQuitSeconds > 0 && !EditorApplication.isPlaying
            && EditorApplication.timeSinceStartup - _lastActivity > _idleQuitSeconds)
        {
            Debug.Log($"[MCPTestBridge] Idle {_idleQuitSeconds:F0}s, no MCP commands — exiting headless editor.");
            EditorApplication.Exit(0);
        }
    }

    static void ClearTagLogsBeforePlay()
    {
        CloseEditorConsole();
        try { SaturaLog.Clear(); }
        catch (Exception e) { Debug.LogWarning($"[MCPTestBridge] Failed to clear tag logs: {e.Message}"); }
    }

    static void HandleFlushLogs()
    {
        try
        {
            SaturaLog.Flush();
            var result = new FlushLogsResultData
            {
                status = "completed",
                timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
            };
            SspaceFolder.EnsureFor(FlushLogsResultsPath);
            File.WriteAllText(FlushLogsResultsPath, JsonUtility.ToJson(result));
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[MCPTestBridge] Failed to flush logs: {e.Message}");
        }
    }

    static void HandleReload()
    {
        Debug.Log("[MCPTestBridge] Reload trigger received — refreshing asset database and reloading shared script assemblies (no recompile).");
        SafeEmit(true);
        if (IsCloneInstance())
        {
            StampCloneReloadSigPending();
            SanitizeApiUpdaterGraph();
            try { AssetDatabase.Refresh(ImportAssetOptions.ForceUpdate); }
            catch (Exception e) { Debug.LogWarning("[MCPTestBridge] clone asset-database refresh failed: " + e.Message); }
        }
        EditorUtility.RequestScriptReload();
    }

    static SceneStatusData[] CollectScenes()
    {
        try
        {
            var activeScene = EditorSceneManager.GetActiveScene();
            var list = new System.Collections.Generic.List<SceneStatusData>();
            for (int i = 0; i < EditorSceneManager.sceneCount; i++)
            {
                var s = EditorSceneManager.GetSceneAt(i);
                if (!s.IsValid()) continue;
                list.Add(new SceneStatusData
                {
                    name = s.name ?? "",
                    path = s.path ?? "",
                    loaded = s.isLoaded,
                    dirty = s.isDirty,
                    active = s == activeScene,
                    rootCount = s.isLoaded ? s.rootCount : 0
                });
            }
            return list.ToArray();
        }
        catch
        {
            return new SceneStatusData[0];
        }
    }

    static ulong SceneStatusSig()
    {
        try
        {
            ulong h = 14695981039346656037UL;
            var active = EditorSceneManager.GetActiveScene();
            int n = EditorSceneManager.sceneCount;
            for (int i = 0; i < n; i++)
            {
                var s = EditorSceneManager.GetSceneAt(i);
                var path = s.path;
                for (int k = 0; k < path.Length; k++) h = (h ^ path[k]) * 1099511628211UL;
                uint flags = (s.isDirty ? 1u : 0u) | (s.isLoaded ? 2u : 0u) | (s == active ? 4u : 0u);
                h = (h ^ (ulong)(flags | ((uint)s.GetHashCode() << 3))) * 1099511628211UL;
            }
            return (h ^ (ulong)n) * 1099511628211UL;
        }
        catch { return 0; }
    }

    static void WriteStatus()
    {
        var scenes = CollectScenes();
        var active = Array.Find(scenes, s => s.active);
        var stream = LocalStreamServer.Instance;
        var streaming = stream != null && stream.Streaming;
        var data = new StatusData
        {
            isStreaming = streaming,
            streamActualFps = streaming ? stream.MeasuredFps : 0,
            actualFps = EditorApplication.isPlaying ? SaturaFrameRate.MeasuredFps : 0,
            streamRes = streaming ? stream.StreamWidth + "x" + stream.StreamHeight : "",
            fpsCap = SaturaFrameRate.Cap,
            targetFrameRate = Application.targetFrameRate,
            vSyncCount = QualitySettings.vSyncCount,
            fpsSource = EditorApplication.isPlaying ? SaturaFrameRate.Source : "",
            isPlaying = EditorApplication.isPlaying,
            isPaused = EditorApplication.isPaused,
            isCompiling = EditorApplication.isCompiling,
            isBatchMode = Application.isBatchMode,
            pid = System.Diagnostics.Process.GetCurrentProcess().Id,
            controlPort = ControlServerPort,
            activeScene = active != null ? active.path : "",
            activeSceneName = active != null ? active.name : "",
            scenesDirty = Array.Exists(scenes, s => s.dirty),
            scenes = scenes,
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };
        try { AtomicWriteAllText(StatusPath, JsonUtility.ToJson(data)); }
        catch (IOException) { }
    }
}

namespace SaturaSpace
{
    public static class SspaceFolder
    {
        public const string DirName = ".sspace";
        public const string IgnoreAll = "*\n";
        const long RecheckMs = 3000;

        static readonly object _recheckLock = new object();
        static readonly System.Collections.Generic.Dictionary<string, long> _lastRecheck =
            new System.Collections.Generic.Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        static readonly System.Diagnostics.Stopwatch _clock = System.Diagnostics.Stopwatch.StartNew();

        public static string Ensure(string sspaceDir)
        {
            try { Directory.CreateDirectory(sspaceDir); }
            catch { }
            EnsureGitignore(sspaceDir);
            return sspaceDir;
        }

        public static void EnsureFor(string path)
        {
            var dir = Owner(path);
            if (dir == null) return;
            try
            {
                if (File.Exists(Path.Combine(dir, ".gitignore")) && !RecheckDue(dir)) return;
            }
            catch { return; }
            EnsureGitignore(dir);
        }

        public static bool IgnoresEverything(string content)
        {
            if (content == null) return false;
            bool all = false;
            foreach (var raw in content.Split('\n'))
            {
                var line = raw.EndsWith("\r", StringComparison.Ordinal) ? raw.Substring(0, raw.Length - 1) : raw;
                line = line.Trim();
                if (line.Length == 0 || line[0] == '#') continue;
                if (line[0] == '!') return false;
                if (line == "*") all = true;
            }
            return all;
        }

        static void EnsureGitignore(string sspaceDir)
        {
            try
            {
                var gi = Path.Combine(sspaceDir, ".gitignore");
                if (!Directory.Exists(sspaceDir) || Directory.Exists(gi)) return;
                if (File.Exists(gi) && IgnoresEverything(File.ReadAllText(gi))) return;
                File.WriteAllText(gi, IgnoreAll, new System.Text.UTF8Encoding(false));
            }
            catch { }
        }

        static string Owner(string path)
        {
            if (string.IsNullOrEmpty(path)) return null;
            try
            {
                var dir = Path.GetFullPath(path);
                while (!string.IsNullOrEmpty(dir))
                {
                    if (string.Equals(Path.GetFileName(dir), DirName, StringComparison.OrdinalIgnoreCase)) return dir;
                    dir = Path.GetDirectoryName(dir);
                }
            }
            catch { }
            return null;
        }

        static bool RecheckDue(string dir)
        {
            long now = _clock.ElapsedMilliseconds;
            lock (_recheckLock)
            {
                long last;
                if (_lastRecheck.TryGetValue(dir, out last) && now - last < RecheckMs) return false;
                _lastRecheck[dir] = now;
                return true;
            }
        }
    }
}
