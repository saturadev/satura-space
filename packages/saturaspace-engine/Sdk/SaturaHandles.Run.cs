using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace SaturaSpace
{

public static partial class SaturaHandles
{
    static readonly FieldInfo WaitSecondsField =
        typeof(WaitForSeconds).GetField("m_Seconds", BindingFlags.Instance | BindingFlags.NonPublic);

    static SaturaHandlesHost _host;
#if UNITY_EDITOR
    static bool _editorHooked;
#endif

    static void EnsureTicking()
    {
#if UNITY_EDITOR
        if (!_editorHooked)
        {
            _editorHooked = true;
            UnityEditor.EditorApplication.update += EditorTick;
        }
#endif
        if (Application.isPlaying && _host == null)
        {
            var go = new GameObject("[SaturaHandles]") { hideFlags = HideFlags.HideInHierarchy };
            UnityEngine.Object.DontDestroyOnLoad(go);
            _host = go.AddComponent<SaturaHandlesHost>();
        }
    }

#if UNITY_EDITOR
    static void EditorTick()
    {
        if (Application.isPlaying && _host != null) return;
        TickAll();
    }
#endif

    internal static void TickAll()
    {
        if (Runs.Count == 0) return;
        foreach (var r in Runs.Values.ToArray())
        {
            if (r.Status == "scheduled") r.Tick();
            else if (r.Status == "running") r.Step();
        }
    }

    internal static void HostGone(SaturaHandlesHost host)
    {
        if (_host != host) return;
        _host = null;
        foreach (var r in Runs.Values.ToArray())
            if (r.InPlayMode && (r.Status == "running" || r.Status == "scheduled"))
            {
                if (r.Handle.Loop) r.Stop(true);
                else r.Fail("Play Mode ended before the run finished", true);
            }
    }

    static double WallSeconds => System.Diagnostics.Stopwatch.GetTimestamp() / (double)System.Diagnostics.Stopwatch.Frequency;

    static double Clock(bool scaled) =>
        Application.isPlaying && scaled ? Time.timeAsDouble : Time.realtimeSinceStartupAsDouble;

    sealed class HandleRun
    {
        public int Id;
        public Handle Handle;
        public object[] Args;
        public long StartAtMs;
        public string Status = "running";
        public bool InPlayMode = Application.isPlaying;
        public readonly List<string> Logs = new List<string>();
        public string Video;
        public string Key;
        public int Iterations;
        public int Passed;
        public int Failed;
        public string LastError;
        public bool LastPassed;
        public string Note;
        public RunReport Report;
        int _resumeFrame = -1;

        object _value;
        bool _hasValue;
        string _error;
        long _lateMs = -1;
        double _startedAt = -1;
        double _endedAt = -1;
        int _startFrame;
        int _endFrame;
        int _lastFrame;
        readonly Stack<IEnumerator> _stack = new Stack<IEnumerator>();
        bool _waiting;
        bool _scaledWait;
        double _waitUntil;
        AsyncOperation _waitOp;

        public void AddLog(string line)
        {
            if (Logs.Count >= MaxLogs) Logs.RemoveAt(0);
            Logs.Add(line);
        }

        void MarkStarted()
        {
            Status = "running";
            InPlayMode = Application.isPlaying;
            _startedAt = WallSeconds;
            _startFrame = Time.frameCount;
            _lastFrame = _startFrame;
        }

        public void Begin(IEnumerator routine)
        {
            MarkStarted();
            _stack.Push(routine);
            EnsureTicking();
            Step();
        }

        public void BeginScenario()
        {
            MarkStarted();
            EnsureTicking();
            if (!NextIteration()) return;
            Step();
        }

        bool NextIteration()
        {
            object result;
            Report?.Begin(Iterations + 1);
            var outer = _stepping;
            _stepping = this;
            try
            {
                result = Invoke(Handle, Args);
            }
            catch (Exception e)
            {
                _stepping = outer;
                Fail(Describe(e));
                return false;
            }
            _stepping = outer;
            if (!(result is IEnumerator routine))
            {
                Fail(Handle.Path + " did not return an IEnumerator");
                return false;
            }
            _stack.Push(routine);
            return true;
        }

        void EndIteration(string error)
        {
            Report?.End(error, false, Key);
            Iterations++;
            LastPassed = error == null;
            if (error == null) Passed++;
            else
            {
                Failed++;
                LastError = error;
            }
            _stack.Clear();
            var line = "iteration " + Iterations + (error == null ? " passed" : " failed: " + error);
            if (Logs.Count >= MaxLogs) Logs.RemoveAt(0);
            Logs.Add(line);
            _resumeFrame = Time.frameCount + 1;
            ScenarioIteration?.Invoke(Id);
        }

        public void Tick()
        {
            if (Status != "scheduled") return;
            var now = NowMs;
            if (StartAtMs > 0 && now < StartAtMs) return;
            if (StartAtMs > 0) _lateMs = now - StartAtMs;
            MarkStarted();
            object result;
            try
            {
                result = Invoke(Handle, Args);
            }
            catch (ArgError e)
            {
                Fail(e.Message);
                return;
            }
            catch (Exception e)
            {
                Fail(Describe(e));
                return;
            }
            if (result is IEnumerator routine)
            {
                _stack.Push(routine);
                Step();
                return;
            }
            _value = result;
            _hasValue = true;
            Finish();
        }

        public void Step()
        {
            int guard = 0;
            if (Time.frameCount > _lastFrame) _lastFrame = Time.frameCount;
            Report?.Sample();
            if (_resumeFrame >= 0)
            {
                if (Time.frameCount < _resumeFrame || Status != "running") return;
                _resumeFrame = -1;
                if (!NextIteration()) return;
            }
            while (Status == "running")
            {
                if (_waitOp != null)
                {
                    if (!_waitOp.isDone) return;
                    _waitOp = null;
                }
                if (_waiting)
                {
                    if (Clock(_scaledWait) < _waitUntil) return;
                    _waiting = false;
                }
                if (_stack.Count == 0)
                {
                    if (Handle.Loop)
                    {
                        EndIteration(null);
                        return;
                    }
                    Finish();
                    return;
                }
                if (++guard > MaxStepsPerTick)
                {
                    Fail("more than " + MaxStepsPerTick + " steps in one frame. Does a loop forget to yield return null?");
                    return;
                }
                var top = _stack.Peek();
                bool more;
                var outer = _stepping;
                _stepping = this;
                try
                {
                    more = top.MoveNext();
                }
                catch (Exception e)
                {
                    _stepping = outer;
                    if (Handle.Loop)
                    {
                        EndIteration(Describe(e));
                        return;
                    }
                    Fail(Describe(e));
                    return;
                }
                _stepping = outer;
                if (!more)
                {
                    _stack.Pop();
                    continue;
                }
                var current = top.Current;
                if (current == null) return;
                if (current is WaitForSeconds ws)
                {
                    var s = WaitSecondsField?.GetValue(ws) is float f ? f : 0f;
                    _waiting = true;
                    _scaledWait = true;
                    _waitUntil = Clock(true) + s;
                    return;
                }
                if (current is IEnumerator nested)
                {
                    _stack.Push(nested);
                    continue;
                }
                if (current is AsyncOperation op)
                {
                    _waitOp = op;
                    return;
                }
                if (current is YieldInstruction) return;
                _value = current;
                _hasValue = true;
                return;
            }
        }

        void Finish()
        {
            Report?.End(null, false, Key);
            Status = "done";
            MarkEnded(false);
        }

        public void Fail(string error, bool playModeEnded = false)
        {
            Report?.End(error, false, Key);
            Status = "error";
            _error = error;
            _stack.Clear();
            MarkEnded(playModeEnded);
        }

        public void Stop(bool playModeEnded = false)
        {
            Report?.End(null, true, Key);
            if (Handle.Loop) Report?.DropPartial();
            Status = "stopped";
            _stack.Clear();
            MarkEnded(playModeEnded);
        }

        void MarkEnded(bool playModeEnded)
        {
            _endedAt = WallSeconds;
            _endFrame = playModeEnded || Time.frameCount < _startFrame ? Math.Max(_lastFrame, _startFrame) : Time.frameCount;
            if (Handle.Scenario)
            {
                try { ScenarioEnded?.Invoke(Id); }
                catch (Exception e) { Debug.LogException(e); }
            }
        }

        public string ResultWord => !Handle.Scenario ? null
            : Handle.Loop ? (Iterations == 0 ? (Status == "error" ? "fail" : null) : LastPassed ? "pass" : "fail")
            : Status == "done" ? "pass" : Status == "error" ? "fail" : null;

        public bool Ended => Status != "running" && Status != "scheduled";

        public string ToJson() => Json(true);

        public string StateJson() => Json(false);

        public string ReportJson() => WriteReport(this);

        string Json(bool full)
        {
            var sb = new StringBuilder("{\"handle\":");
            SaturaJson.Write(sb, Handle.Path);
            sb.Append(",\"run\":").Append(Id);
            sb.Append(",\"status\":\"").Append(Status).Append('"');
            if (Status == "scheduled" && StartAtMs > 0)
                sb.Append(",\"startsInMs\":").Append(Math.Max(0, StartAtMs - NowMs));
            if (_lateMs >= 0)
                sb.Append(",\"lateMs\":").Append(_lateMs);
            if (_hasValue)
            {
                sb.Append(",\"value\":");
                SaturaJson.Write(sb, _value);
            }
            if (_error != null)
            {
                sb.Append(",\"error\":");
                SaturaJson.Write(sb, _error);
            }
            if (Handle.Scenario)
            {
                sb.Append(",\"scenario\":true");
                var word = ResultWord;
                if (word != null) sb.Append(",\"result\":\"").Append(word).Append('"');
                if (Handle.Target != null)
                {
                    sb.Append(",\"staging\":");
                    SaturaJson.Write(sb, SaturaStaging.PathOf(Handle.Target.transform));
                }
                if (Handle.Loop)
                {
                    sb.Append(",\"loop\":true,\"iterations\":").Append(Iterations).Append(",\"passed\":").Append(Passed).Append(",\"failed\":").Append(Failed);
                    if (LastError != null)
                    {
                        sb.Append(",\"lastError\":");
                        SaturaJson.Write(sb, LastError);
                    }
                }
                if (Video != null)
                {
                    sb.Append(",\"video\":");
                    SaturaJson.Write(sb, Video);
                }
                if (Note != null)
                {
                    sb.Append(",\"note\":");
                    SaturaJson.Write(sb, Note);
                }
                if (Report != null)
                {
                    if (full) WriteSummary(sb, Report, Handle.Loop);
                    else sb.Append(",\"rev\":").Append(Report.Rev);
                }
            }
            if (_startedAt >= 0)
            {
                var end = _endedAt >= 0 ? _endedAt : WallSeconds;
                var endFrame = _endedAt >= 0 ? _endFrame : Math.Max(Time.frameCount, _lastFrame);
                sb.Append(",\"seconds\":").Append(Math.Max(0, end - _startedAt).ToString("F2", System.Globalization.CultureInfo.InvariantCulture));
                sb.Append(",\"frames\":").Append(Math.Max(0, endFrame - _startFrame));
            }
            if (full && Logs.Count > 0)
            {
                sb.Append(",\"logs\":");
                SaturaJson.Write(sb, Logs);
            }
            if (Status == "running" || Status == "scheduled")
                sb.Append(",\"next\":\"SaturaHandles.Result(").Append(Id).Append(")\"");
            sb.Append('}');
            return sb.ToString();
        }
    }
}

sealed class SaturaHandlesHost : MonoBehaviour
{
    void Update() => SaturaHandles.TickAll();

    void OnDestroy() => SaturaHandles.HostGone(this);
}
}
