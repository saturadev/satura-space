using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    static string CommandLogPath => Path.Combine(SspaceRoot, "commands.json");
    static string CommandAckPath => Path.Combine(SspaceRoot, "command_acks.json");
    const string SS_ACKED_CURSOR = "SaturaSpace_Cmd_AckedCursor";

    const string SS_CMD_PENDING_ID        = "SaturaSpace_Cmd_PendingId";
    const string SS_CMD_PENDING_KIND      = "SaturaSpace_Cmd_PendingKind";
    const string SS_CMD_PENDING_TARGET    = "SaturaSpace_Cmd_PendingTarget";
    const string SS_CMD_PENDING_ARG       = "SaturaSpace_Cmd_PendingArg";
    const string SS_CMD_PENDING_GEN       = "SaturaSpace_Cmd_PendingGen";
    const string SS_CMD_PENDING_DEADLINE  = "SaturaSpace_Cmd_PendingDeadline";
    const string SS_CMD_PENDING_REACHEDAT = "SaturaSpace_Cmd_PendingReachedAt";
    const string SS_CMD_PENDING_PHASE     = "SaturaSpace_Cmd_PendingPhase";
    const string SS_CMD_PENDING_RESULTS   = "SaturaSpace_Cmd_PendingResults";

    const int PHASE_NONE             = 0;
    const int PHASE_COMPILING        = 1;
    const int PHASE_RELOAD_REQUESTED = 2;
    const int PHASE_RELOAD_DONE      = 3;

    const double TEARING_TIMEOUT = 60.0;
    const double REFRESH_TIMEOUT = 120.0;
    const double RELOAD_TIMEOUT  = 8.0;
    const double EXEC_TIMEOUT    = 300.0;
    const double TEARING_SETTLE  = 0.1;
    const double REFRESH_START_GRACE = 0.5;
    const double CLOCK_RESET_EPSILON = 5.0;

    static bool _pumpingCommands;

    enum Converge { NotYet, Reached, Errored }

    [Serializable]
    class CmdArgs
    {
        public string scene = "";
        public bool enabled = false;
        public bool force = false;
        public int gen = 0;
        public string[] files;
        public string nonce = "";
        public string results = "";
        public double timeoutSeconds = 0;
        public string path = "";
        public float[] cameraPos;
        public float[] lookAt;
        public float[] poses;
        public string gridPath = "";
        public string[] frame;
        public float[] view;
        public string[] isolate;
        public string[] hide;
        public bool skipRefresh = false;
    }

    [Serializable]
    class UnityCommandDto
    {
        public int id;
        public long ts;
        public string target = "";
        public string kind = "";
        public CmdArgs args;
    }

    [Serializable]
    class CommandLogDto
    {
        public int schema = 1;
        public UnityCommandDto[] commands;
    }

    [Serializable]
    class CommandAckDto
    {
        public int id;
        public string target;
        public string status;
        public string error;
        public int resultVersion;
    }

    [Serializable]
    class CommandAckFileDto
    {
        public int schema = 1;
        public int ackedCursor;
        public CommandAckDto[] acks;
    }

    [InitializeOnLoadMethod]
    static void InitCommandLogPlayModeHook()
    {
        if (Inert) return;
        EditorApplication.playModeStateChanged -= OnCommandLogPlayModeChanged;
        EditorApplication.playModeStateChanged += OnCommandLogPlayModeChanged;
    }

    [InitializeOnLoadMethod]
    static void OnDomainReloadRearm()
    {
        if (Inert) return;
        if (SessionState.GetInt(SS_CMD_PENDING_ID, 0) <= 0) return;

        string kind = SessionState.GetString(SS_CMD_PENDING_KIND, "");
        if (kind == "reload" && SessionState.GetInt(SS_CMD_PENDING_PHASE, PHASE_NONE) == PHASE_RELOAD_REQUESTED)
        {
            SessionState.SetInt(SS_CMD_PENDING_PHASE, PHASE_RELOAD_DONE);
            try
            {
                TryLoadFreshAssets();
                CommitCloneReloadSig();
            }
            catch (Exception e) { Debug.LogWarning("[World] clone asset sync after reload failed: " + e.Message); }
        }

        double now = EditorApplication.timeSinceStartup;
        if (now < CLOCK_RESET_EPSILON)
        {
            SsSetDouble(SS_CMD_PENDING_DEADLINE, now + TimeoutFor(kind));
            SessionState.EraseString(SS_CMD_PENDING_REACHEDAT);
        }
    }

    static void OnCommandLogPlayModeChanged(PlayModeStateChange state)
    {
        if (state != PlayModeStateChange.EnteredPlayMode && state != PlayModeStateChange.EnteredEditMode) return;
        if (SessionState.GetInt(SS_CMD_PENDING_ID, 0) <= 0) return;
        try { FinalizePending(); }
        catch (Exception e) { Debug.LogWarning("[World] play-mode finalize failed: " + e.Message); }
    }

    static double TimeoutFor(string kind)
    {
        switch (kind)
        {
            case "recompile": return REFRESH_TIMEOUT;
            case "reload":    return RELOAD_TIMEOUT;
            case "exec":      return EXEC_TIMEOUT;
            default:          return TEARING_TIMEOUT;
        }
    }

    static bool KindNeedsSettle(string kind) => kind == "play" || kind == "stop" || kind == "loadScene";

    static bool HasPendingWork()
    {
        if (SessionState.GetInt(SS_CMD_PENDING_ID, 0) > 0) return true;
        var log = ReadCommandLog();
        if (log == null || log.commands == null || log.commands.Length == 0) return false;
        int cursor = Math.Max(ReadAckFile()?.ackedCursor ?? 0, SessionState.GetInt(SS_ACKED_CURSOR, 0));
        foreach (var c in log.commands)
            if (c != null && c.id > cursor) return true;
        return false;
    }

    static string _cmdLogPath;
    static byte[] _cmdLogBytes = new byte[4096];
    static byte[] _cmdLogScratch = new byte[4096];
    static int _cmdLogLen = -2;
    static bool _cmdLogIdle;
    static int _cmdLogIdleCursor;

    static int ReadCommandLogBytes(string path, ref byte[] buf)
    {
        try
        {
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1))
            {
                long size = fs.Length;
                if (size > int.MaxValue / 2) return -3;
                if (buf.Length < size) buf = new byte[Math.Max((int)size, buf.Length * 2)];
                int len = 0;
                while (len < size)
                {
                    int r = fs.Read(buf, len, (int)size - len);
                    if (r <= 0) break;
                    len += r;
                }
                return len;
            }
        }
        catch (FileNotFoundException) { return -1; }
        catch (DirectoryNotFoundException) { return -1; }
        catch { return -3; }
    }

    static bool CommandLogUnchanged()
    {
        var path = _cmdLogPath ?? (_cmdLogPath = CommandLogPath);
        int len = ReadCommandLogBytes(path, ref _cmdLogScratch);
        bool same = len >= -1 && len == _cmdLogLen;
        for (int i = 0; same && i < len; i++) same = _cmdLogScratch[i] == _cmdLogBytes[i];
        if (same) return true;
        var t = _cmdLogBytes;
        _cmdLogBytes = _cmdLogScratch;
        _cmdLogScratch = t;
        _cmdLogLen = len < -1 ? -2 : len;
        return false;
    }

    static void PumpCommandLog()
    {
        if (_pumpingCommands) return;
        if (!FinalizePending()) return;
        if (EditorApplication.isCompiling) return;

        int sessionCursor = SessionState.GetInt(SS_ACKED_CURSOR, 0);
        if (CommandLogUnchanged() && _cmdLogIdle && sessionCursor == _cmdLogIdleCursor) return;
        _cmdLogIdle = false;

        var log = ReadCommandLog();
        if (log == null || log.commands == null || log.commands.Length == 0)
        {
            MarkCommandLogIdle(sessionCursor);
            return;
        }

        int diskCursor = ReadAckFile()?.ackedCursor ?? 0;
        int cursor = Math.Max(diskCursor, sessionCursor);

        UnityCommandDto next = null;
        foreach (var c in log.commands)
            if (c != null && c.id > cursor && (next == null || c.id < next.id)) next = c;
        if (next == null)
        {
            MarkCommandLogIdle(sessionCursor);
            return;
        }

        _lastActivity = EditorApplication.timeSinceStartup;

        _pumpingCommands = true;
        try { ApplyPending(next); }
        finally { _pumpingCommands = false; }

        if (next.kind == "exec" && SessionState.GetInt(SS_CMD_PENDING_ID, 0) == next.id
            && SsGetDouble(SS_CMD_EXEC_ARMED_AT, 0) < 0)
            FinalizePending();
    }

    static void MarkCommandLogIdle(int sessionCursor)
    {
        _cmdLogIdle = _cmdLogLen >= -1;
        _cmdLogIdleCursor = sessionCursor;
    }

    static void ApplyPending(UnityCommandDto cmd)
    {
        string myId = ResolveInstanceId();
        if (cmd.target != "*" && cmd.target != myId)
        {
            Debug.LogWarning("[World] command #" + cmd.id + " target='" + cmd.target + "' != this instance '"
                + myId + "' — acking 'skipped' (advancing cursor).");
            PersistAck(cmd.id, cmd.target, "skipped", null, CurWorldVersion());
            return;
        }

        var a = cmd.args ?? new CmdArgs();
        switch (cmd.kind)
        {
            case "loadScene":
            {
                if (string.IsNullOrEmpty(a.scene)) { AckError(cmd, "loadScene requires args.scene"); return; }
                if (!EditorApplication.isPlaying && ActiveScenePath() == a.scene && !a.force)
                {
                    AdvanceIntentGen("loadScene", a.gen);
                    SafeEmit(true);
                    AckSkipped(cmd);
                    return;
                }
                BeginPending(cmd.id, "loadScene", cmd.target, a.scene, a.gen, TEARING_TIMEOUT, PHASE_NONE, "");
                HandleOpenScene(NewSceneTrigger(a.scene, false));
                return;
            }
            case "play":
            {
                if (EditorApplication.isPlaying)
                {
                    AdvanceIntentGen("play", a.gen);
                    SafeEmit(true);
                    AckSkipped(cmd);
                    return;
                }
                if (EditorUtility.scriptCompilationFailed)
                {
                    AckError(cmd, "play refused — script compile errors block Play Mode:\n"
                        + (RecompileError() ?? "script compilation failed"));
                    return;
                }
                string scene = ActiveScenePath();
                if (string.IsNullOrEmpty(scene)) { AckError(cmd, "play: no active scene to enter"); return; }
                EditorApplication.isPaused = false;
                BeginPending(cmd.id, "play", cmd.target, scene, a.gen, TEARING_TIMEOUT, PHASE_NONE, "");
                HandleOpenScene(NewSceneTrigger(scene, true));
                return;
            }
            case "stop":
            {
                if (!EditorApplication.isPlaying)
                {
                    AdvanceIntentGen("stop", a.gen);
                    SafeEmit(true);
                    AckSkipped(cmd);
                    return;
                }
                BeginPending(cmd.id, "stop", cmd.target, "", a.gen, TEARING_TIMEOUT, PHASE_NONE, "");
                HandleStopPlay();
                return;
            }
            case "pause":
            {
                if (EditorApplication.isPaused == a.enabled)
                {
                    AdvanceIntentGen("pause", a.gen);
                    SafeEmit(true);
                    AckSkipped(cmd);
                    return;
                }
                EditorApplication.isPaused = a.enabled;
                AdvanceIntentGen("pause", a.gen);
                AckAppliedAfterEffect(cmd);
                return;
            }
            case "step":
            {
                if (!EditorApplication.isPlaying)
                {
                    AckSkipped(cmd);
                    return;
                }
                EditorApplication.Step();
                AckAppliedAfterEffect(cmd);
                return;
            }
            case "recompile":
            {
                if (a.gen <= 0) { AckError(cmd, "recompile requires args.gen > 0"); return; }
                BeginPending(cmd.id, "recompile", cmd.target, "", a.gen, REFRESH_TIMEOUT, PHASE_NONE, "");
                HandleRefresh();
                return;
            }
            case "reload":
            {
                if (a.gen <= 0) { AckError(cmd, "reload requires args.gen > 0"); return; }
                if (IsCloneInstance() && !CloneNeedsReload())
                {
                    AdvanceIntentGen("reload", a.gen);
                    SafeEmit(true);
                    AckSkipped(cmd);
                    return;
                }
                if (IsCloneInstance() && CloneAssembliesUnchanged() && !CloneFreshBatchHasRemovals())
                {
                    SaturaDebug.Log("[MCPTestBridge] clone asset sync (light) — assemblies unchanged, skipping domain reload.");
                    SyncCloneAssetsLight();
                    AdvanceIntentGen("reload", a.gen);
                    SafeEmit(true);
                    PersistAck(cmd.id, cmd.target, "applied", null, CurWorldVersion());
                    ReloadCloneStaleScenes();
                    return;
                }
                BeginPending(cmd.id, "reload", cmd.target, "", a.gen, RELOAD_TIMEOUT, PHASE_RELOAD_REQUESTED, "");
                HandleReload();
                return;
            }
            case "exec":
            {
                if (string.IsNullOrEmpty(a.nonce)) { AckError(cmd, "exec requires args.nonce"); return; }
                double timeout = a.timeoutSeconds > 0 ? a.timeoutSeconds : EXEC_TIMEOUT;
                BeginExec(cmd.id, cmd.target, a.gen, a.nonce, a.results, timeout, a.skipRefresh);
                return;
            }
            case "setHotReload":
            {
                if (!HotReloadPackageAvailable()) { AckError(cmd, "hot-reload package not installed"); return; }
                if (_cachedHotReload == a.enabled) { AckSkipped(cmd); return; }
                HandleHotReload("{\"enabled\":" + (a.enabled ? "true" : "false") + "}");
                _cachedHotReload = SafeReadHotReloadFromReflection();
                if (_cachedHotReload == a.enabled) AckAppliedAfterEffect(cmd);
                else AckError(cmd, "failed to set hot reload to " + a.enabled);
                return;
            }
            case "hotReloadPatch":
            {
                if (a.files == null || a.files.Length == 0) { AckSkipped(cmd); return; }
                ApplyHotReloadPatch(a.files);
                PersistAck(cmd.id, cmd.target, "applied", null, CurWorldVersion());
                return;
            }
            case "flushLogs":
            {
                HandleFlushLogs();
                PersistAck(cmd.id, cmd.target, "applied", null, CurWorldVersion());
                return;
            }
            case "screenshot":
            {
                bool grid = a.poses != null && a.poses.Length > 0;
                string shotPath = grid && !string.IsNullOrEmpty(a.gridPath) ? a.gridPath : a.path;
                if (string.IsNullOrEmpty(shotPath)) { AckError(cmd, "screenshot requires args.path"); return; }
                HandleScreenshotCommand(cmd, shotPath, a.cameraPos, a.lookAt, grid ? a.poses : null, a);
                return;
            }
            case "quit":
                AdvanceAckCursor(cmd.id);
                PersistAck(cmd.id, cmd.target, "applied", null, CurWorldVersion());
                Debug.Log("[World] quit command — exiting editor.");
                RestoreEditorIdle();
                EditorApplication.Exit(0);
                return;
            default:
                AckError(cmd, "unknown command kind: " + cmd.kind);
                return;
        }
    }

    static void BeginPending(int id, string kind, string target, string arg, int gen,
                             double timeout, int phase, string resultsPath)
    {
        AdvanceAckCursor(id);
        SessionState.SetInt(SS_CMD_PENDING_ID, id);
        SessionState.SetString(SS_CMD_PENDING_KIND, kind);
        SessionState.SetString(SS_CMD_PENDING_TARGET, target ?? "");
        SessionState.SetString(SS_CMD_PENDING_ARG, arg ?? "");
        SessionState.SetInt(SS_CMD_PENDING_GEN, gen);
        SsSetDouble(SS_CMD_PENDING_DEADLINE, EditorApplication.timeSinceStartup + timeout);
        SessionState.EraseString(SS_CMD_PENDING_REACHEDAT);
        SessionState.SetInt(SS_CMD_PENDING_PHASE, phase);
        SessionState.SetString(SS_CMD_PENDING_RESULTS, resultsPath ?? "");
    }

    static void AdvanceIntentGen(string kind, int gen)
    {
        if (gen <= 0) return;
        string key;
        if (kind == "loadScene") key = SS_SCENE_GEN;
        else if (kind == "recompile" || kind == "reload") key = SS_REFRESH_GEN;
        else if (kind == "pause") key = SS_PAUSE_GEN;
        else key = SS_PLAY_GEN;
        SessionState.SetInt(key, Math.Max(SessionState.GetInt(key, 0), gen));
    }

    static bool FinalizePending()
    {
        int id = SessionState.GetInt(SS_CMD_PENDING_ID, 0);
        if (id <= 0) return true;

        string kind = SessionState.GetString(SS_CMD_PENDING_KIND, "");
        string target = SessionState.GetString(SS_CMD_PENDING_TARGET, "");
        string arg = SessionState.GetString(SS_CMD_PENDING_ARG, "");
        double deadline = SsGetDouble(SS_CMD_PENDING_DEADLINE, 0);
        double now = EditorApplication.timeSinceStartup;

        Converge c = CheckConverge(kind, arg, out string err);

        if (c == Converge.Errored)
        {
            if (kind == "play" || kind == "loadScene")
            {
                ErasePendingScene();
                SessionState.EraseInt(SS_SCENE_RESUME_TRIES);
            }
            FinalizeCommand(id, target, "error", err);
            return true;
        }

        if (c == Converge.Reached)
        {
            if (KindNeedsSettle(kind))
            {
                double reachedAt = SsGetDouble(SS_CMD_PENDING_REACHEDAT, -1);
                if (reachedAt < 0)
                {
                    SsSetDouble(SS_CMD_PENDING_REACHEDAT, now);
                    return false;
                }
                bool clockReset = now < reachedAt;
                if (!clockReset && now - reachedAt < TEARING_SETTLE) return false;
            }
            AdvanceIntentGen(kind, SessionState.GetInt(SS_CMD_PENDING_GEN, 0));
            string recompileErr = kind == "recompile" ? RecompileError() : null;
            FinalizeCommand(id, target, recompileErr == null ? "applied" : "error", recompileErr);
            return true;
        }

        SessionState.EraseString(SS_CMD_PENDING_REACHEDAT);
        if (now < deadline) return false;
        OnPendingTimeout(kind, arg);
        FinalizeCommand(id, target, "error", kind + " did not reach the expected state within timeout");
        return true;
    }

    static Converge CheckConverge(string kind, string arg, out string err)
    {
        err = null;
        switch (kind)
        {
            case "play":
                if (EditorApplication.isPlaying) return Converge.Reached;
                if (!EditorApplication.isPlayingOrWillChangePlaymode && !_sceneOpening)
                {
                    string playErr = ReadSceneResultError();
                    if (!string.IsNullOrEmpty(playErr)) { err = playErr; return Converge.Errored; }
                }
                return Converge.NotYet;
            case "stop":      return !EditorApplication.isPlaying ? Converge.Reached : Converge.NotYet;
            case "loadScene":
                if (ActiveScenePath() == arg) return Converge.Reached;
                if (!EditorApplication.isPlaying && !_sceneOpening)
                {
                    string sceneErr = ReadSceneResultError();
                    if (!string.IsNullOrEmpty(sceneErr)) { err = sceneErr; return Converge.Errored; }
                }
                return Converge.NotYet;

            case "recompile":
                if (EditorApplication.isCompiling)
                {
                    SessionState.SetInt(SS_CMD_PENDING_PHASE, PHASE_COMPILING);
                    return Converge.NotYet;
                }
                if (SessionState.GetInt(SS_CMD_PENDING_PHASE, PHASE_NONE) == PHASE_COMPILING)
                    return Converge.Reached;
                if (EditorApplication.isUpdating) return Converge.NotYet;
                double refreshStarted = SsGetDouble(SS_CMD_PENDING_DEADLINE, 0) - REFRESH_TIMEOUT;
                double refreshNow = EditorApplication.timeSinceStartup;
                if (refreshNow >= refreshStarted && refreshNow - refreshStarted < REFRESH_START_GRACE) return Converge.NotYet;
                return Converge.Reached;

            case "reload":
                return SessionState.GetInt(SS_CMD_PENDING_PHASE, PHASE_NONE) == PHASE_RELOAD_DONE
                    ? Converge.Reached : Converge.NotYet;

            case "exec":
                return CheckExecConverge(arg, out err);

            default:
                return Converge.Reached;
        }
    }

    static string RecompileError()
    {
        if (!EditorUtility.scriptCompilationFailed) return null;
        string err = _cachedCompileError;
        if (string.IsNullOrEmpty(err)) err = "script compilation failed";
        return err.Length > 4000 ? err.Substring(0, 4000) : err;
    }

    static void OnPendingTimeout(string kind, string arg)
    {
        if (kind == "play" || kind == "loadScene")
        {
            ErasePendingScene();
            SessionState.EraseInt(SS_SCENE_RESUME_TRIES);
            _sceneOpening = false;
            return;
        }
        if (kind != "exec") return;
        string results = SessionState.GetString(SS_CMD_PENDING_RESULTS, ExecResultsPath);
        WriteExecErrorFile(results, arg, "exec timed out");
    }

    static void FinalizeCommand(int id, string target, string status, string error)
    {
        _execSnippetPending = false;
        SafeEmit(true);
        PersistAck(id, target, status, error, CurWorldVersion());

        SessionState.EraseInt(SS_CMD_PENDING_ID);
        SessionState.EraseString(SS_CMD_PENDING_KIND);
        SessionState.EraseString(SS_CMD_PENDING_TARGET);
        SessionState.EraseString(SS_CMD_PENDING_ARG);
        SessionState.EraseInt(SS_CMD_PENDING_GEN);
        SessionState.EraseString(SS_CMD_PENDING_DEADLINE);
        SessionState.EraseString(SS_CMD_PENDING_REACHEDAT);
        SessionState.EraseInt(SS_CMD_PENDING_PHASE);
        SessionState.EraseString(SS_CMD_PENDING_RESULTS);
        SessionState.EraseString(SS_CMD_EXEC_ARMED_AT);
    }

    static void AckAppliedAfterEffect(UnityCommandDto cmd)
    {
        SafeEmit(true);
        PersistAck(cmd.id, cmd.target, "applied", null, CurWorldVersion());
    }

    static void AckSkipped(UnityCommandDto cmd)
    {
        PersistAck(cmd.id, cmd.target, "skipped", null, CurWorldVersion());
    }

    static void AckError(UnityCommandDto cmd, string message)
    {
        Debug.LogWarning("[World] command " + cmd.kind + "#" + cmd.id + " error: " + message);
        PersistAck(cmd.id, cmd.target, "error", message, CurWorldVersion());
    }

    static string ReadAllTextShared(string path)
    {
        for (int attempt = 0; ; attempt++)
        {
            try
            {
                using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read,
                                               FileShare.ReadWrite | FileShare.Delete))
                using (var sr = new StreamReader(fs))
                    return sr.ReadToEnd();
            }
            catch (FileNotFoundException) { return null; }
            catch (DirectoryNotFoundException) { return null; }
            catch (IOException) when (attempt < 4)
            {
                System.Threading.Thread.Sleep(10);
            }
        }
    }

    static CommandLogDto ReadCommandLog()
    {
        if (!File.Exists(CommandLogPath)) return null;
        try
        {
            var txt = ReadAllTextShared(CommandLogPath);
            if (string.IsNullOrEmpty(txt)) return null;
            var dto = JsonUtility.FromJson<CommandLogDto>(txt);
            if (dto == null) return null;
            if (dto.commands == null) dto.commands = new UnityCommandDto[0];
            return dto;
        }
        catch (Exception e)
        {
            Debug.LogWarning("[World] commands.json read failed: " + e.Message);
            return null;
        }
    }

    static CommandAckFileDto ReadAckFile()
    {
        if (!File.Exists(CommandAckPath)) return null;
        try
        {
            var txt = ReadAllTextShared(CommandAckPath);
            if (string.IsNullOrEmpty(txt)) return null;
            var dto = JsonUtility.FromJson<CommandAckFileDto>(txt);
            if (dto == null) return null;
            if (dto.acks == null) dto.acks = new CommandAckDto[0];
            _ackMemo = dto;
            return dto;
        }
        catch (Exception e)
        {
            Debug.LogWarning("[World] command_acks.json read failed: " + e.Message);
            return null;
        }
    }

    static CommandAckFileDto _ackMemo;

    static CommandAckFileDto ReadAckForUpdate()
    {
        bool exists = File.Exists(CommandAckPath);
        var dto = exists ? ReadAckFile() : null;
        if (dto != null) return dto;
        if (exists && _ackMemo != null)
        {
            Debug.LogWarning("[World] command_acks.json unreadable, keeping the " + _ackMemo.acks.Length + " ack(s) this editor wrote last");
            return _ackMemo;
        }
        if (exists) Debug.LogWarning("[World] command_acks.json unreadable and no earlier copy in memory, rewriting it from the cursor");
        return new CommandAckFileDto { schema = 1, ackedCursor = SessionState.GetInt(SS_ACKED_CURSOR, 0), acks = new CommandAckDto[0] };
    }

    static void WriteAckFile(int schema, int cursor, List<CommandAckDto> list)
    {
        AtomicWriteAllText(CommandAckPath, BuildAckFileJson(schema, cursor, list));
        _ackMemo = new CommandAckFileDto { schema = schema, ackedCursor = cursor, acks = list.ToArray() };
        SessionState.SetInt(SS_ACKED_CURSOR, cursor);
    }

    static void PersistAck(int id, string target, string status, string error, int resultVersion)
    {
        var dto = ReadAckForUpdate();
        int newCursor = Math.Max(dto.ackedCursor, id);

        var list = new List<CommandAckDto>();
        foreach (var existing in dto.acks)
        {
            if (existing == null || existing.id == id) continue;
            list.Add(existing);
        }
        list.Add(new CommandAckDto
        {
            id = id,
            target = target ?? "",
            status = status,
            error = status == "error" ? (error ?? "") : null,
            resultVersion = resultVersion
        });

        try { WriteAckFile(dto.schema <= 0 ? 1 : dto.schema, newCursor, list); }
        catch (Exception e) { Debug.LogWarning("[World] command_acks.json write failed: " + e.Message); }
    }

    static void AdvanceAckCursor(int id)
    {
        var dto = ReadAckForUpdate();
        int newCursor = Math.Max(dto.ackedCursor, id);

        var list = new List<CommandAckDto>();
        foreach (var existing in dto.acks)
            if (existing != null) list.Add(existing);

        try { WriteAckFile(dto.schema <= 0 ? 1 : dto.schema, newCursor, list); }
        catch (Exception e) { Debug.LogWarning("[World] command_acks.json cursor-advance failed: " + e.Message); }
    }

    static string BuildAckFileJson(int schema, int ackedCursor, List<CommandAckDto> acks)
    {
        var sb = new StringBuilder(256);
        sb.Append('{');
        sb.Append("\"schema\":").Append(schema).Append(',');
        sb.Append("\"ackedCursor\":").Append(ackedCursor).Append(',');
        sb.Append("\"acks\":[");
        for (int i = 0; i < acks.Count; i++)
        {
            var ack = acks[i];
            if (i > 0) sb.Append(',');
            sb.Append('{');
            sb.Append("\"id\":").Append(ack.id).Append(',');
            sb.Append("\"target\":").Append(JStr(ack.target ?? "")).Append(',');
            sb.Append("\"status\":").Append(JStr(ack.status ?? "")).Append(',');
            sb.Append("\"error\":").Append(ack.error == null ? "null" : JStr(ack.error)).Append(',');
            sb.Append("\"resultVersion\":").Append(ack.resultVersion);
            sb.Append('}');
        }
        sb.Append("]}");
        return sb.ToString();
    }

    static SceneTriggerData NewSceneTrigger(string scene, bool play)
    {
        return new SceneTriggerData { scenePath = scene, enterPlayMode = play };
    }

    static string ActiveScenePath()
    {
        return UnityEngine.SceneManagement.SceneManager.GetActiveScene().path ?? "";
    }

    static string ReadSceneResultError()
    {
        try
        {
            if (File.Exists(SceneResultsPath))
            {
                var r = JsonUtility.FromJson<SceneResultData>(File.ReadAllText(SceneResultsPath));
                if (r != null && !string.IsNullOrEmpty(r.error)) return r.error;
            }
        }
        catch { }
        return null;
    }

    static void SsSetDouble(string key, double value)
    {
        SessionState.SetString(key, value.ToString("R", CultureInfo.InvariantCulture));
    }

    static double SsGetDouble(string key, double fallback)
    {
        return double.TryParse(SessionState.GetString(key, ""), NumberStyles.Float, CultureInfo.InvariantCulture, out var v)
            ? v : fallback;
    }
}
