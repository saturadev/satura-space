using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace SaturaSpace
{

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = false)]
public sealed class SaturaHandleAttribute : Attribute
{
    public string Description { get; }

    public SaturaHandleAttribute(string description = "")
    {
        Description = description ?? "";
    }
}

public static partial class SaturaHandles
{
    const int MaxRuns = 64;
    const int MaxLogs = 100;
    const int MaxStepsPerTick = 10000;

    public static int PlayerIndex { get; set; }

    public static long NowMs => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

    static List<Handle> _handles;
    static List<Handle> _staged = new List<Handle>();
    static List<string> _ignored;
    static readonly Dictionary<int, HandleRun> Runs = new Dictionary<int, HandleRun>();
    static int _nextRun;
    static List<string> _capture;
    static HandleRun _stepping;
    static bool _logHooked;

    sealed class Handle
    {
        public MethodInfo Method;
        public string Description;
        public string Group;
        public SaturaStaging Target;
        public bool Scenario;
        public bool Loop;
        public string Name => Method.Name;
        public string Path => Group + "/" + Method.Name;
        public string TypeName => Method.DeclaringType.Name + "." + Method.Name;
        public string FullName => Target != null ? Path : Method.DeclaringType.FullName.Replace('+', '.') + "." + Method.Name;
        public bool IsCoroutine => typeof(IEnumerator).IsAssignableFrom(Method.ReturnType);
    }

    public static string List(string filter = "")
    {
        var all = All();
        filter = (filter ?? "").Trim();
        var group = filter.TrimEnd('/');
        var shown = all;
        bool subtree = false;
        if (group.Length > 0)
        {
            var inGroup = all.Where(h => string.Equals(h.Group, group, StringComparison.OrdinalIgnoreCase)
                                      || h.Group.StartsWith(group + "/", StringComparison.OrdinalIgnoreCase)).ToList();
            subtree = inGroup.Count > 0;
            shown = subtree
                ? inGroup
                : all.Where(h => h.Path.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                              || h.FullName.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0
                              || h.Description.IndexOf(filter, StringComparison.OrdinalIgnoreCase) >= 0).ToList();
        }
        var sb = new StringBuilder();
        if (all.Count == 0)
            sb.Append("No handles yet. Add [SaturaHandle(\"what it does\")] to a public static method in runtime code.\n");
        else if (shown.Count == 0)
            sb.Append("No group or handle matches '").Append(filter).Append("'. ").Append(all.Count).Append(" handles in total.\n");
        else
            sb.Append(shown.Count).Append(shown.Count == 1 ? " handle" : " handles").Append(subtree ? " in " + group : "")
              .Append(". Call one by its path with SaturaHandles.Call(path, args...); a bare name works when it is unique.\n");
        var open = new List<string>();
        foreach (var h in shown.OrderBy(x => x.Group, StringComparer.OrdinalIgnoreCase).ThenBy(x => x.Scenario ? 0 : 1).ThenBy(x => x.Name, StringComparer.Ordinal))
        {
            var parts = h.Group.Split('/');
            int same = 0;
            while (same < open.Count && same < parts.Length && open[same] == parts[same]) same++;
            open.RemoveRange(same, open.Count - same);
            for (int i = same; i < parts.Length; i++)
            {
                sb.Append(' ', 2 * i).Append(parts[i]).Append('/');
                if (i == parts.Length - 1 && h.Target != null) sb.Append("   staging: ").Append(SaturaStaging.PathOf(h.Target.transform));
                sb.Append('\n');
                open.Add(parts[i]);
            }
            var pad = 2 * parts.Length;
            sb.Append(' ', pad).Append(Signature(h)).Append('\n');
            if (h.Description.Length > 0)
                sb.Append(' ', pad + 4).Append(h.Description).Append('\n');
        }
        foreach (var line in _ignored)
            sb.Append("ignored: ").Append(line).Append('\n');
        var scenes = StagingScenesNow();
        if (scenes.Length > 0)
        {
            var active = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path;
            sb.Append("Staging scenes: ").Append(string.Join(", ", scenes.Select(x => x == active ? x + " (open)" : x)))
              .Append(". This list covers the open scene only. Open another staging scene to run its scenarios.\n");
        }
        return sb.ToString().TrimEnd();
    }

    static string[] StagingScenesNow()
    {
        var src = StagingSceneSource;
        if (src == null) return Array.Empty<string>();
        try { return src() ?? Array.Empty<string>(); }
        catch { return Array.Empty<string>(); }
    }

    public static string Call(string name, params object[] args)
    {
        if (!Resolve(name, args, out var handle, out var error))
            return ErrorJson(name, error, null);
        if (handle.Scenario) return StartScenario(handle, args);
        var logs = new List<string>();
        object result;
        var outer = _capture;
        HookLogs();
        _capture = logs;
        try
        {
            result = Invoke(handle, args);
        }
        catch (ArgError e)
        {
            return ErrorJson(handle.Path, e.Message, logs);
        }
        catch (Exception e)
        {
            return ErrorJson(handle.Path, Describe(e), logs);
        }
        finally
        {
            _capture = outer;
        }
        if (result is IEnumerator routine)
        {
            var run = NewRun(handle, null);
            run.Logs.AddRange(logs);
            run.Begin(routine);
            return run.ToJson();
        }
        var sb = new StringBuilder();
        sb.Append("{\"handle\":");
        SaturaJson.Write(sb, handle.Path);
        sb.Append(",\"status\":\"done\",\"value\":");
        SaturaJson.Write(sb, result);
        AppendLogs(sb, logs);
        sb.Append('}');
        return sb.ToString();
    }

    public static string Start(string name, params object[] args) => StartAt(0, name, args);

    public static string StartAt(long unixMs, string name, params object[] args)
    {
        if (!Resolve(name, args, out var handle, out var error))
            return ErrorJson(name, error, null);
        if (handle.Scenario) return StartScenario(handle, args);
        var run = NewRun(handle, args);
        run.StartAtMs = unixMs;
        run.Status = "scheduled";
        EnsureTicking();
        if (unixMs <= 0) run.Tick();
        return run.ToJson();
    }

    public static string Result(int run = 0)
    {
        if (run == 0 && Runs.Count > 0) run = Runs.Keys.Max();
        if (!Runs.TryGetValue(run, out var r))
            return ErrorJson("", run == 0 ? "No handle run has started since the last domain reload." : "No run " + run + ". Runs are lost on a recompile or domain reload.", null);
        return r.ToJson();
    }

    public static string Stop(int run = 0)
    {
        if (run == 0 && Runs.Count > 0) run = Runs.Keys.Max();
        if (!Runs.TryGetValue(run, out var r))
            return ErrorJson("", "No run " + run + ".", null);
        if (r.Status == "running" || r.Status == "scheduled")
            r.Stop();
        return r.ToJson();
    }

    static HandleRun NewRun(Handle handle, object[] args)
    {
        var run = new HandleRun { Id = ++_nextRun, Handle = handle, Args = args };
        Runs[run.Id] = run;
        while (Runs.Count > MaxRuns)
        {
            var oldest = Runs.Values.Where(r => r.Status != "running" && r.Status != "scheduled").Select(r => r.Id).DefaultIfEmpty(0).Min();
            if (oldest == 0) break;
            Runs.Remove(oldest);
        }
        HookLogs();
        return run;
    }

    static List<Handle> Discover()
    {
        if (_handles != null) return _handles;
        var found = new List<Handle>();
        var staged = new List<Handle>();
        _ignored = new List<string>();
        foreach (var m in Candidates())
        {
            var attr = m.GetCustomAttribute<SaturaHandleAttribute>();
            if (attr == null) continue;
            var where = m.DeclaringType.FullName.Replace('+', '.') + "." + m.Name;
            if (m.ContainsGenericParameters) { _ignored.Add(where + " is generic"); continue; }
            if (!m.IsStatic)
            {
                if (typeof(SaturaStaging).IsAssignableFrom(m.DeclaringType)) staged.Add(new Handle { Method = m, Description = attr.Description });
                else _ignored.Add(where + " is not static (instance handles work on SaturaStaging scripts only)");
                continue;
            }
            if (!m.IsPublic) { _ignored.Add(where + " is not public"); continue; }
            found.Add(new Handle { Method = m, Description = attr.Description, Group = GroupOf(m.DeclaringType) });
        }
        foreach (var m in ScenarioCandidates())
        {
            var attr = m.GetCustomAttribute<SaturaScenarioAttribute>();
            if (attr == null) continue;
            var where = m.DeclaringType.FullName.Replace('+', '.') + "." + m.Name;
            if (m.IsStatic || !typeof(SaturaStaging).IsAssignableFrom(m.DeclaringType)) { _ignored.Add(where + ": [SaturaScenario] goes on an instance method of a SaturaStaging script"); continue; }
            if (!typeof(IEnumerator).IsAssignableFrom(m.ReturnType)) { _ignored.Add(where + ": a scenario returns IEnumerator"); continue; }
            if (m.ContainsGenericParameters || m.GetParameters().Any(p => !p.HasDefaultValue)) { _ignored.Add(where + ": a scenario takes no arguments"); continue; }
            staged.Add(new Handle { Method = m, Description = attr.Description, Scenario = true, Loop = attr.Loop });
        }
        found.Sort((a, b) => string.CompareOrdinal(a.Path, b.Path));
        _handles = found;
        _staged = staged;
        return found;
    }

    static string GroupOf(Type t)
    {
        var parts = new List<string>();
        for (; t != null; t = t.DeclaringType) parts.Add(t.Name);
        parts.Reverse();
        return string.Join("/", parts);
    }

    static List<Handle> All()
    {
        var all = new List<Handle>(Discover());
        if (_staged.Count == 0) return all;
        var live = SaturaStaging.LiveAll();
        var names = new HashSet<string>(live.GroupBy(s => s.name).Where(g => g.Count() > 1).Select(g => g.Key));
        foreach (var s in live)
        {
            var group = names.Contains(s.name) ? SaturaStaging.PathOf(s.transform) : s.name;
            var type = s.GetType();
            foreach (var h in _staged)
                if (h.Method.DeclaringType.IsAssignableFrom(type))
                    all.Add(new Handle { Method = h.Method, Description = h.Description, Group = group, Target = s, Scenario = h.Scenario, Loop = h.Loop });
        }
        return all;
    }

    static IEnumerable<MethodInfo> Candidates()
    {
#if UNITY_EDITOR
        return UnityEditor.TypeCache.GetMethodsWithAttribute<SaturaHandleAttribute>();
#else
        return Scan(typeof(SaturaHandleAttribute));
#endif
    }

    static IEnumerable<MethodInfo> ScenarioCandidates()
    {
#if UNITY_EDITOR
        return UnityEditor.TypeCache.GetMethodsWithAttribute<SaturaScenarioAttribute>();
#else
        return Scan(typeof(SaturaScenarioAttribute));
#endif
    }

#if !UNITY_EDITOR
    static IEnumerable<MethodInfo> Scan(Type attr)
    {
        var list = new List<MethodInfo>();
        const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance | BindingFlags.DeclaredOnly;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            var an = asm.GetName().Name;
            if (an.StartsWith("System", StringComparison.Ordinal) || an.StartsWith("Unity", StringComparison.Ordinal)
                || an.StartsWith("mscorlib", StringComparison.Ordinal) || an.StartsWith("Mono.", StringComparison.Ordinal))
                continue;
            Type[] types;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException e) { types = e.Types; }
            catch { continue; }
            foreach (var t in types)
            {
                if (t == null) continue;
                foreach (var m in t.GetMethods(flags))
                    if (m.IsDefined(attr, false)) list.Add(m);
            }
        }
        return list;
    }
#endif

    static bool Resolve(string name, object[] args, out Handle handle, out string error)
    {
        handle = null;
        error = null;
        var all = All();
        if (string.IsNullOrWhiteSpace(name))
        {
            error = "A handle name is required.";
            return false;
        }
        name = name.Trim();
        var matches = all.Where(h => h.Path == name).ToList();
        if (matches.Count == 0) matches = all.Where(h => h.Name == name || h.TypeName == name || h.FullName == name).ToList();
        if (matches.Count == 0)
            matches = all.Where(h => string.Equals(h.Path, name, StringComparison.OrdinalIgnoreCase)
                                  || string.Equals(h.Name, name, StringComparison.OrdinalIgnoreCase)
                                  || string.Equals(h.TypeName, name, StringComparison.OrdinalIgnoreCase)
                                  || string.Equals(h.FullName, name, StringComparison.OrdinalIgnoreCase)).ToList();
        if (matches.Count == 0)
        {
            var close = all.Select(h => h.Path).Distinct()
                .OrderBy(n => Math.Min(Distance(n.ToLowerInvariant(), name.ToLowerInvariant()), Distance(n.Substring(n.LastIndexOf('/') + 1).ToLowerInvariant(), name.ToLowerInvariant()))).Take(3).ToList();
            error = "No handle named '" + name + "'." + (close.Count > 0 ? " Closest: " + string.Join(", ", close) + "." : " The project has no handles.")
                + " SaturaHandles.List() shows them all.";
            var open = UnityEngine.SceneManagement.SceneManager.GetActiveScene().path;
            var others = StagingScenesNow().Where(x => x != open).ToArray();
            if (others.Length > 0 && name.IndexOf('/') > 0)
                error += " Staging prefabs of other scenes are not loaded. Open that staging scene first: " + string.Join(", ", others) + ".";
            return false;
        }
        int n = args?.Length ?? 0;
        if (matches.Count > 1)
        {
            var fit = matches.Where(h => Accepts(h, n)).ToList();
            if (fit.Count == 1) matches = fit;
        }
        if (matches.Count > 1)
        {
            error = "'" + name + "' matches " + matches.Count + " handles: " + string.Join(", ", matches.Select(h => h.Path))
                + ". Call one by its path.";
            return false;
        }
        handle = matches[0];
        if (!Accepts(handle, n))
        {
            error = handle.Path + " takes " + Signature(handle) + ", got " + n + (n == 1 ? " argument." : " arguments.");
            handle = null;
            return false;
        }
        return true;
    }

    static bool Accepts(Handle h, int n)
    {
        var ps = h.Method.GetParameters();
        int required = ps.Count(p => !p.HasDefaultValue && !p.IsDefined(typeof(ParamArrayAttribute)));
        bool variadic = ps.Length > 0 && ps[ps.Length - 1].IsDefined(typeof(ParamArrayAttribute));
        return n >= required && (variadic || n <= ps.Length);
    }

    static object Invoke(Handle h, object[] args)
    {
        var ps = h.Method.GetParameters();
        var call = new object[ps.Length];
        args = args ?? Array.Empty<object>();
        for (int i = 0; i < ps.Length; i++)
        {
            var p = ps[i];
            if (i == ps.Length - 1 && p.IsDefined(typeof(ParamArrayAttribute)))
            {
                var et = p.ParameterType.GetElementType();
                var rest = Math.Max(0, args.Length - i);
                var arr = Array.CreateInstance(et, rest);
                for (int k = 0; k < rest; k++) arr.SetValue(Convert(args[i + k], et, p.Name), k);
                call[i] = arr;
            }
            else if (i < args.Length) call[i] = Convert(args[i], p.ParameterType, p.Name);
            else call[i] = p.DefaultValue;
        }
        try
        {
            return h.Method.Invoke(h.Target, call);
        }
        catch (TargetInvocationException e) when (e.InnerException != null)
        {
            System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(e.InnerException).Throw();
            throw;
        }
    }

    static object Convert(object v, Type t, string param)
    {
        if (v == null) return t.IsValueType ? Activator.CreateInstance(t) : null;
        if (t.IsInstanceOfType(v)) return v;
        try
        {
            if (t.IsEnum)
                return v is string es ? Enum.Parse(t, es, true) : Enum.ToObject(t, System.Convert.ToInt64(v, CultureInfo.InvariantCulture));
            if (t == typeof(string)) return System.Convert.ToString(v, CultureInfo.InvariantCulture);
            if (v is string s)
            {
                var parts = s.Split(new[] { ',', ' ' }, StringSplitOptions.RemoveEmptyEntries)
                    .Select(x => float.Parse(x, CultureInfo.InvariantCulture)).ToArray();
                if (t == typeof(Vector2) && parts.Length == 2) return new Vector2(parts[0], parts[1]);
                if (t == typeof(Vector3) && parts.Length == 3) return new Vector3(parts[0], parts[1], parts[2]);
                if (t == typeof(Vector4) && parts.Length == 4) return new Vector4(parts[0], parts[1], parts[2], parts[3]);
                if (t == typeof(Color) && (parts.Length == 3 || parts.Length == 4)) return new Color(parts[0], parts[1], parts[2], parts.Length == 4 ? parts[3] : 1f);
                if (t == typeof(Quaternion) && parts.Length == 3) return Quaternion.Euler(parts[0], parts[1], parts[2]);
            }
            if (typeof(UnityEngine.Object).IsAssignableFrom(t) && v is string path)
            {
                var go = GameObject.Find(path);
                if (go == null) throw new ArgError("argument '" + param + "': no GameObject at '" + path + "'");
                if (t == typeof(GameObject)) return go;
                if (t == typeof(Transform)) return go.transform;
                var c = go.GetComponent(t);
                if (c == null) throw new ArgError("argument '" + param + "': '" + path + "' has no " + t.Name);
                return c;
            }
            if (v is IConvertible && typeof(IConvertible).IsAssignableFrom(t))
                return System.Convert.ChangeType(v, t, CultureInfo.InvariantCulture);
        }
        catch (Exception e) when (!(e is ArgError))
        {
            throw new ArgError("argument '" + param + "': can't turn " + Describe(v) + " into " + t.Name + " (" + e.Message + ")");
        }
        throw new ArgError("argument '" + param + "': can't turn " + Describe(v) + " into " + t.Name);
    }

    sealed class ArgError : ArgumentException
    {
        public ArgError(string message) : base(message) { }
    }

    static string Describe(object v) => v is string ? "\"" + v + "\"" : v + " (" + v.GetType().Name + ")";

    static readonly System.Text.RegularExpressions.Regex FrameNoise =
        new System.Text.RegularExpressions.Regex(@" \[0x[0-9a-f]+\]| in <[0-9a-f]+>:0");

    static string Describe(Exception e)
    {
        if (e is TargetInvocationException t && t.InnerException != null) e = t.InnerException;
        var root = System.IO.Path.GetDirectoryName(Application.dataPath)?.Replace('\\', '/') + "/";
        var frames = (e.StackTrace ?? "").Split('\n')
            .Select(l => l.Trim())
            .Where(l => l.StartsWith("at ") && !l.StartsWith("at (wrapper") && !l.Contains("System.Reflection.")
                && !l.Contains("SaturaSpace.SaturaHandles") && !l.Contains("SaturaSpace.SaturaStaging.Check") && !l.Contains("SaturaSpace.SaturaStaging.Metric"))
            .Select(l => FrameNoise.Replace(l, "").Replace('\\', '/').Replace(root, ""))
            .Take(12)
            .ToList();
        var head = e is SaturaCheckException ? "check failed: " + e.Message : e.GetType().Name + ": " + e.Message;
        return head + (frames.Count > 0 ? "\n  " + string.Join("\n  ", frames) : "");
    }

    static string Signature(Handle h, bool qualified = false)
    {
        var sb = new StringBuilder(qualified ? h.TypeName : h.Name).Append('(');
        var ps = h.Method.GetParameters();
        for (int i = 0; i < ps.Length; i++)
        {
            if (i > 0) sb.Append(", ");
            if (ps[i].IsDefined(typeof(ParamArrayAttribute))) sb.Append("params ");
            sb.Append(TypeLabel(ps[i].ParameterType)).Append(' ').Append(ps[i].Name);
            if (ps[i].HasDefaultValue)
                sb.Append(" = ").Append(ps[i].DefaultValue == null ? "null" : SaturaJson.ToJson(ps[i].DefaultValue));
        }
        sb.Append(')');
        if (h.Scenario) sb.Append(h.Loop ? " -> looped scenario" : " -> scenario");
        else if (h.IsCoroutine) sb.Append(" -> coroutine");
        else if (h.Method.ReturnType != typeof(void)) sb.Append(" -> ").Append(TypeLabel(h.Method.ReturnType));
        return sb.ToString();
    }

    static string TypeLabel(Type t)
    {
        if (t == typeof(int)) return "int";
        if (t == typeof(float)) return "float";
        if (t == typeof(double)) return "double";
        if (t == typeof(bool)) return "bool";
        if (t == typeof(string)) return "string";
        if (t == typeof(long)) return "long";
        if (t == typeof(object)) return "object";
        if (t.IsArray) return TypeLabel(t.GetElementType()) + "[]";
        if (t.IsGenericType)
        {
            var n = t.Name;
            var tick = n.IndexOf('`');
            return (tick > 0 ? n.Substring(0, tick) : n) + "<" + string.Join(", ", t.GetGenericArguments().Select(TypeLabel)) + ">";
        }
        return t.Name;
    }

    static int Distance(string a, string b)
    {
        if (b.Contains(a) || a.Contains(b)) return Math.Abs(a.Length - b.Length);
        var d = new int[a.Length + 1, b.Length + 1];
        for (int i = 0; i <= a.Length; i++) d[i, 0] = i;
        for (int j = 0; j <= b.Length; j++) d[0, j] = j;
        for (int i = 1; i <= a.Length; i++)
            for (int j = 1; j <= b.Length; j++)
                d[i, j] = Math.Min(Math.Min(d[i - 1, j] + 1, d[i, j - 1] + 1), d[i - 1, j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
        return d[a.Length, b.Length];
    }

    static string ErrorJson(string handle, string error, List<string> logs, bool needsPlay = false)
    {
        var sb = new StringBuilder("{\"handle\":");
        SaturaJson.Write(sb, handle ?? "");
        sb.Append(",\"status\":\"error\",\"error\":");
        SaturaJson.Write(sb, error);
        if (needsPlay) sb.Append(",\"needsPlay\":true");
        AppendLogs(sb, logs);
        sb.Append('}');
        return sb.ToString();
    }

    static void AppendLogs(StringBuilder sb, List<string> logs)
    {
        if (logs == null || logs.Count == 0) return;
        sb.Append(",\"logs\":");
        SaturaJson.Write(sb, logs);
    }

    static void HookLogs()
    {
        if (_logHooked) return;
        _logHooked = true;
        Application.logMessageReceived += OnLog;
        SaturaLog.LineLogged += OnTagged;
    }

    static void OnLog(string message, string stack, LogType type)
    {
        if (type == LogType.Log && message != null && (message.StartsWith("[Tuner] ", StringComparison.Ordinal) || message.StartsWith("[Staging] ", StringComparison.Ordinal))) return;
        var prefix = type == LogType.Log ? "" : type == LogType.Warning ? "warning: " : "error: ";
        var line = prefix + message;
        if (type == LogType.Exception || type == LogType.Error || type == LogType.Assert)
        {
            var nl = string.IsNullOrEmpty(stack) ? -1 : stack.IndexOf('\n');
            var first = nl > 0 ? stack.Substring(0, nl).Trim() : (stack ?? "").Trim();
            if (first.Length > 0) line += "\n  at " + first;
        }
        Collect(line);
    }

    static void OnTagged(string tag, string message)
    {
        if (string.IsNullOrEmpty(tag) || tag[0] == '_') return;
        Collect("[" + tag + "] " + message);
    }

    static void Collect(string line)
    {
        if (_capture != null && _capture.Count < MaxLogs) _capture.Add(line);
        if (_stepping != null)
        {
            _stepping.AddLog(line);
            return;
        }
        foreach (var r in Runs.Values)
            if (r.Status == "running") r.AddLog(line);
    }
}
}
