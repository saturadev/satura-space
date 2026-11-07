using UnityEngine;
using UnityEditor;
using System;
using System.Globalization;
using System.IO;
using System.Reflection;
using SaturaSpace;

public static partial class MCPTestBridge
{
    const string SS_CMD_EXEC_ARMED_AT = "SaturaSpace_Cmd_ExecArmedAt";
    const string SS_EXEC_REFRESH_OWED = "SaturaSpace_Exec_RefreshOwed";
    static bool _execSnippetPending;
    public static Action<string[]> ExecSavingAssets;

    public static void NotifyExecDone(string nonce, string status)
    {
        BroadcastOpDone("exec", status, nonce);
    }

    static string ExecSourcePath(string nonce)
    {
        return Path.Combine(SspaceRoot, "exec", "_MCPExec_" + nonce + ".cs");
    }

    static ExecResultData ReadExecResult(string path, string nonce)
    {
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return null;
        try
        {
            var txt = File.ReadAllText(path);
            if (string.IsNullOrEmpty(txt)) return null;
            var r = JsonUtility.FromJson<ExecResultData>(txt);
            if (r == null || string.IsNullOrEmpty(r.status)) return null;
            if (!string.IsNullOrEmpty(nonce) && r.nonce != nonce) return null;
            return r;
        }
        catch { return null; }
    }

    static void WriteExecErrorFile(string path, string nonce, string error)
    {
        var result = new ExecResultData
        {
            status = "error",
            output = "",
            error = error,
            nonce = nonce,
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };
        SspaceFolder.EnsureFor(path);
        try { File.WriteAllText(path, JsonUtility.ToJson(result, true)); }
        catch (IOException) { }
    }

    static void BeginExec(int id, string target, int gen, string nonce, string resultsArg, double timeout, bool skipRefresh)
    {
        string results = string.IsNullOrEmpty(resultsArg) ? ExecResultsPath : resultsArg;
        BeginPending(id, "exec", target, nonce, gen, timeout, PHASE_NONE, results);
        SsSetDouble(SS_CMD_EXEC_ARMED_AT, EditorApplication.timeSinceStartup);
        if (EditorApplication.isPlaying && !skipRefresh) SessionState.SetBool(SS_EXEC_REFRESH_OWED, true);
        if (EditorApplication.isPlaying || (skipRefresh && !SessionState.GetBool(SS_EXEC_REFRESH_OWED, false)))
        {
            if (!EditorApplication.isCompiling && !EditorApplication.isUpdating)
                SsSetDouble(SS_CMD_EXEC_ARMED_AT, -1);
        }
        else
        {
            SessionState.EraseBool(SS_EXEC_REFRESH_OWED);
            SaturaDebug.Log("[MCPTestBridge] Exec: refreshing assets before in-memory run...");
            SanitizeApiUpdaterGraph();
            uint deps = AssetDatabase.GlobalArtifactDependencyVersion;
            AssetDatabase.Refresh();
            if (AssetDatabase.GlobalArtifactDependencyVersion == deps && !EditorApplication.isCompiling && !EditorApplication.isUpdating)
                SsSetDouble(SS_CMD_EXEC_ARMED_AT, -1);
        }
    }

    static Converge CheckExecConverge(string nonce, out string err)
    {
        err = null;
        string results = SessionState.GetString(SS_CMD_PENDING_RESULTS, ExecResultsPath);

        if (ReadExecResult(results, nonce) != null)
            return Converge.Reached;

        if (EditorApplication.isCompiling || EditorApplication.isUpdating)
        {
            SessionState.SetInt(SS_CMD_PENDING_PHASE, PHASE_COMPILING);
            return Converge.NotYet;
        }

        if (SessionState.GetInt(SS_CMD_PENDING_PHASE, PHASE_NONE) != PHASE_COMPILING
            && !EditorApplication.isPlaying)
        {
            double armedAt = SsGetDouble(SS_CMD_EXEC_ARMED_AT, -1);
            double now = EditorApplication.timeSinceStartup;
            if (armedAt >= 0 && now >= armedAt && now - armedAt < REFRESH_START_GRACE)
                return Converge.NotYet;
        }

        bool ran = RunPendingExec(nonce, results);
        _execSnippetPending = !ran;
        return ran ? Converge.Reached : Converge.NotYet;
    }

    const string EXEC_PENDING = "\u0000pending";

    [Serializable]
    class DirectExecOp
    {
        public string op = "";
        public string name = "";
        public string[] types;
        public string[] values;
        public long unixMs;
        public int run;
        public string filter = "";
    }

    static object[] DirectArgs(DirectExecOp op)
    {
        int n = op.types == null ? 0 : op.types.Length;
        var args = new object[n];
        for (int i = 0; i < n; i++)
        {
            string v = op.values != null && i < op.values.Length ? op.values[i] : null;
            switch (op.types[i])
            {
                case "i": args[i] = int.Parse(v, CultureInfo.InvariantCulture); break;
                case "l": args[i] = long.Parse(v, CultureInfo.InvariantCulture); break;
                case "d": args[i] = double.Parse(v, NumberStyles.Float, CultureInfo.InvariantCulture); break;
                case "b": args[i] = v == "true"; break;
                case "n": args[i] = null; break;
                default: args[i] = v; break;
            }
        }
        return args;
    }

    static void RunDirectExec(string path, string nonce, string results)
    {
        var r = new ExecResultData { status = "completed", output = "", error = "", nonce = nonce };
        var cleanBefore = EditorApplication.isPlaying ? null : CleanScenePaths();
        try
        {
            var op = JsonUtility.FromJson<DirectExecOp>(File.ReadAllText(path));
            var args = DirectArgs(op);
            string output;
            switch (op.op)
            {
                case "call": output = SaturaHandles.Call(op.name, args); break;
                case "startAt": output = SaturaHandles.StartAt(op.unixMs, op.name, args); break;
                case "result": output = SaturaHandles.Result(op.run); break;
                case "stop": output = SaturaHandles.Stop(op.run); break;
                case "list": output = SaturaHandles.List(op.filter ?? ""); break;
                default: throw new ArgumentException("unknown exec op '" + op.op + "'");
            }
            r.output = (output ?? "null") + "\n";
            if (cleanBefore != null)
            {
                var dirtied = new System.Collections.Generic.List<string>();
                for (int i = 0; i < UnityEditor.SceneManagement.EditorSceneManager.sceneCount; i++)
                {
                    var sc = UnityEditor.SceneManagement.EditorSceneManager.GetSceneAt(i);
                    if (sc.isDirty && cleanBefore.Contains(sc.path)) dirtied.Add(sc.path);
                }
                if (dirtied.Count > 0) r.output += "__MCP_SCENE_DIRTY__:" + string.Join(", ", dirtied) + "\n";
            }
        }
        catch (Exception e)
        {
            r.status = "error";
            r.error = e.ToString();
        }
        r.timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        SspaceFolder.EnsureFor(results);
        try { File.WriteAllText(results, JsonUtility.ToJson(r, true)); }
        catch (IOException) { }
        NotifyExecDone(nonce, r.status);
    }

    static System.Collections.Generic.HashSet<string> CleanScenePaths()
    {
        var clean = new System.Collections.Generic.HashSet<string>();
        for (int i = 0; i < UnityEditor.SceneManagement.EditorSceneManager.sceneCount; i++)
        {
            var sc = UnityEditor.SceneManagement.EditorSceneManager.GetSceneAt(i);
            if (sc.isLoaded && !sc.isDirty && !string.IsNullOrEmpty(sc.path)) clean.Add(sc.path);
        }
        return clean;
    }

    static bool RunPendingExec(string nonce, string results)
    {
        string directPath = Path.ChangeExtension(ExecSourcePath(nonce), ".json");
        if (File.Exists(directPath))
        {
            RunDirectExec(directPath, nonce, results);
            return true;
        }
        string sourcePath = ExecSourcePath(nonce);
        if (!File.Exists(sourcePath))
        {
            WriteExecErrorFile(results, nonce, "exec source file missing: " + sourcePath);
            return true;
        }

        string error = InvokeExecService(sourcePath, "_MCPExec_" + nonce);
        if (error == EXEC_PENDING) return false;

        string warning = null;
        if (EditorUtility.scriptCompilationFailed)
        {
            var diagnostics = SafeReadCompileErrorsFromDisk();
            warning = "WARNING: project scripts have compile errors — this exec ran against the LAST "
                + "successfully compiled assemblies; recent .cs edits are NOT reflected."
                + (string.IsNullOrEmpty(diagnostics) ? "" : "\n\nCompiler errors:\n" + diagnostics);
        }
        if (error != null)
        {
            if (warning != null) error = warning + "\n\n" + error;
            WriteExecErrorFile(results, nonce, error);
            Debug.Log("[MCPTestBridge] Exec " + nonce + " failed; the error went to its result.");
            return true;
        }
        if (warning != null) PrependExecWarning(results, nonce, warning);
        return true;
    }

    static void PrependExecWarning(string results, string nonce, string warning)
    {
        var r = ReadExecResult(results, nonce);
        if (r == null) return;
        r.output = warning + "\n\n" + (r.output ?? "");
        SspaceFolder.EnsureFor(results);
        try { File.WriteAllText(results, JsonUtility.ToJson(r, true)); }
        catch (IOException) { }
    }

    static string InvokeExecService(string sourcePath, string typeName)
    {
        var entry = FindExecServiceRun();
        if (entry == null)
            return "in-memory exec runner unavailable: HotReloadPrototype.Editor.ExecService not found "
                + "(engine package incomplete?)";
        try { return (string)entry.Invoke(null, new object[] { sourcePath, typeName }); }
        catch (Exception e) { return "exec runner failed: " + (e.InnerException ?? e); }
    }

    static MethodInfo _execServiceEntry;

    static MethodInfo FindExecServiceRun()
    {
        if (_execServiceEntry != null) return _execServiceEntry;
        _execServiceEntry = LookupExecServiceRun();
        return _execServiceEntry;
    }

    static MethodInfo LookupExecServiceRun()
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type t;
            try { t = asm.GetType("HotReloadPrototype.Editor.ExecService"); }
            catch { continue; }
            if (t != null)
                return t.GetMethod("Step",
                    BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static,
                    null, new[] { typeof(string), typeof(string) }, null);
        }
        return null;
    }
}
