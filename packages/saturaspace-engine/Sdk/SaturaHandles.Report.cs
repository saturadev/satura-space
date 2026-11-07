using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using UnityEngine;

namespace SaturaSpace
{

public static partial class SaturaHandles
{
    const int MaxSeries = 8;
    const int MaxPoints = 240;
    const int MaxKeptIterations = 5;
    const int MaxChecks = 64;
    const int MaxSteps = 24;
    const int MaxMetrics = 16;
    const int MaxTracks = 4;
    const int MaxSnapshots = 12;
    const float TrackMinMove = 0.005f;
    const string MetricsKey = "satura.staging.metrics";

    public static event Action<int, int, string> SnapshotRequested;

    public static Func<string[]> StagingSceneSource { get; set; }

    static Dictionary<string, Dictionary<string, float>> _lastMetrics;

    sealed class ReportSeries
    {
        public string Name;
        public float BandMin = float.NaN;
        public float BandMax = float.NaN;
        public readonly List<float> T = new List<float>();
        public readonly List<float> V = new List<float>();
        public float MinDt;
        public int Count;
        public int Outside;
        public float Min = float.PositiveInfinity;
        public float Max = float.NegativeInfinity;
        public float MaxAt;
        public float Last;

        public bool HasBand => !float.IsNaN(BandMin) || !float.IsNaN(BandMax);

        public void Add(float t, float v)
        {
            if (float.IsNaN(v) || float.IsInfinity(v)) return;
            Count++;
            Last = v;
            if (v < Min) Min = v;
            if (v > Max)
            {
                Max = v;
                MaxAt = t;
            }
            if ((!float.IsNaN(BandMin) && v < BandMin) || (!float.IsNaN(BandMax) && v > BandMax)) Outside++;
            AddSample(T, V, ref MinDt, t, 1, v, 0, 0);
        }
    }

    sealed class ReportTrack
    {
        public string Name;
        public readonly List<float> T = new List<float>();
        public readonly List<float> P = new List<float>();
        public float MinDt;
        public float Length;
        public Vector3 LastAt;
        public bool Any;

        public void Add(float t, Vector3 p)
        {
            if (Any && (p - LastAt).sqrMagnitude < TrackMinMove * TrackMinMove) return;
            if (Any) Length += Vector3.Distance(LastAt, p);
            LastAt = p;
            Any = true;
            AddSample(T, P, ref MinDt, t, 3, p.x, p.y, p.z);
        }
    }

    sealed class ReportCheck
    {
        public float T;
        public string What;
        public bool Ok;
    }

    sealed class ReportStep
    {
        public float T;
        public string Name;
    }

    sealed class ReportMetric
    {
        public float T;
        public string Name;
        public float Value;
        public string Unit;
        public float Min;
        public float Max;
        public float Prev = float.NaN;

        public bool Ok => !(Value < Min) && !(Value > Max);
    }

    sealed class ReportSnapshot
    {
        public int Seq;
        public int Iteration;
        public float T;
        public string Name;
        public string Path;
    }

    sealed class ReportIteration
    {
        public int Index;
        public double T0;
        public float End = -1;
        public bool Stopped;
        public string Error;
        public float ErrorAt = -1;
        public readonly List<ReportSeries> Series = new List<ReportSeries>();
        public readonly List<ReportTrack> Tracks = new List<ReportTrack>();
        public readonly List<ReportCheck> Checks = new List<ReportCheck>();
        public readonly List<ReportStep> Steps = new List<ReportStep>();
        public readonly List<ReportMetric> Metrics = new List<ReportMetric>();
        public bool Ended => End >= 0;
        public float Now => (float)(Time.timeAsDouble - T0);
        public float Length => Ended ? End : Mathf.Max(0f, Now);
    }

    sealed class RunReport
    {
        public readonly List<ReportIteration> Iterations = new List<ReportIteration>();
        public readonly List<Transform> Tracked = new List<Transform>();
        public readonly List<string> TrackNames = new List<string>();
        public readonly List<string> SeriesNames = new List<string>();
        public readonly List<ReportSnapshot> Snapshots = new List<ReportSnapshot>();
        public Dictionary<string, float> RunPrev;
        public Dictionary<string, float> LastIteration;
        public ReportIteration Completed;
        public int Rev;
        public int SnapSeq;
        public int SampledFrame = -1;
        public bool Warned;

        public ReportIteration Current => Iterations.Count > 0 ? Iterations[Iterations.Count - 1] : null;

        public void Begin(int index)
        {
            Iterations.Add(new ReportIteration { Index = index, T0 = Time.timeAsDouble });
            while (Iterations.Count > MaxKeptIterations) Iterations.RemoveAt(0);
            SampledFrame = -1;
            Sample();
            Rev++;
        }

        public void End(string error, bool stopped, string key)
        {
            var it = Current;
            if (it == null || it.Ended) return;
            it.End = Mathf.Max(0f, it.Now);
            it.Stopped = stopped && error == null;
            if (error != null)
            {
                it.Error = error;
                it.ErrorAt = it.End;
            }
            if (!it.Stopped || Completed == null)
            {
                LastIteration = it.Metrics.ToDictionary(m => m.Name, m => m.Value);
                Completed = it;
            }
            SaveMetrics(key, it);
            Rev++;
        }

        public void DropPartial()
        {
            var it = Current;
            if (it == null || !it.Stopped || Iterations.Count < 2) return;
            Iterations.RemoveAt(Iterations.Count - 1);
            Rev++;
        }

        public void Sample()
        {
            var it = Current;
            if (it == null || it.Ended || Tracked.Count == 0 || Time.frameCount == SampledFrame) return;
            SampledFrame = Time.frameCount;
            float t = Mathf.Max(0f, it.Now);
            for (int i = 0; i < Tracked.Count; i++)
            {
                var tr = Tracked[i];
                if (tr == null) continue;
                while (it.Tracks.Count <= i) it.Tracks.Add(new ReportTrack { Name = TrackNames[it.Tracks.Count] });
                it.Tracks[i].Add(t, tr.position);
            }
            Rev++;
        }

        public ReportSeries Series(ReportIteration it, string name)
        {
            foreach (var s in it.Series)
                if (s.Name == name) return s;
            if (!SeriesNames.Contains(name))
            {
                if (SeriesNames.Count >= MaxSeries)
                {
                    if (!Warned) Debug.LogWarning("[Staging] a run records at most " + MaxSeries + " plots; '" + name + "' is skipped");
                    Warned = true;
                    return null;
                }
                SeriesNames.Add(name);
            }
            var made = new ReportSeries { Name = name };
            it.Series.Add(made);
            return made;
        }
    }

    static void AddSample(List<float> t, List<float> v, ref float minDt, float at, int stride, float a, float b, float c)
    {
        int n = t.Count;
        if (n > 0 && at <= t[n - 1])
        {
            SetSample(v, n - 1, stride, a, b, c);
            return;
        }
        if (n >= 2 && at - t[n - 2] < minDt)
        {
            t[n - 1] = at;
            SetSample(v, n - 1, stride, a, b, c);
            return;
        }
        t.Add(at);
        v.Add(a);
        if (stride > 1)
        {
            v.Add(b);
            v.Add(c);
        }
        if (t.Count <= MaxPoints) return;
        int count = t.Count, w = 0;
        for (int i = 0; i < count; i++)
        {
            if (i % 2 == 1 && i != count - 1) continue;
            t[w] = t[i];
            for (int k = 0; k < stride; k++) v[w * stride + k] = v[i * stride + k];
            w++;
        }
        t.RemoveRange(w, count - w);
        v.RemoveRange(w * stride, (count - w) * stride);
        minDt = (t[t.Count - 1] - t[0]) / Math.Max(1, t.Count - 1);
    }

    static void SetSample(List<float> v, int i, int stride, float a, float b, float c)
    {
        v[i * stride] = a;
        if (stride == 1) return;
        v[i * stride + 1] = b;
        v[i * stride + 2] = c;
    }

    static HandleRun ReportRun(SaturaStaging s)
    {
        var r = _stepping;
        if (r != null && r.Report != null && !r.Ended && (r.Handle.Target == s || s == null)) return r;
        if (s == null) return null;
        foreach (var x in Runs.Values)
            if (x.Report != null && !x.Ended && x.Handle.Target == s) return x;
        return null;
    }

    static ReportIteration Live(SaturaStaging s, out HandleRun run)
    {
        run = ReportRun(s);
        var it = run?.Report.Current;
        return it != null && !it.Ended ? it : null;
    }

    static string Label(string name, string fallback)
    {
        var n = string.IsNullOrWhiteSpace(name) ? fallback : name.Trim();
        return n.Length > 80 ? n.Substring(0, 80) : n;
    }

    internal static void RecordPlot(SaturaStaging s, string name, float value, float min, float max, bool band)
    {
        var it = Live(s, out var run);
        if (it == null) return;
        var series = run.Report.Series(it, Label(name, "value"));
        if (series == null) return;
        if (band)
        {
            series.BandMin = float.IsInfinity(min) ? float.NaN : min;
            series.BandMax = float.IsInfinity(max) ? float.NaN : max;
        }
        series.Add(Mathf.Max(0f, it.Now), value);
        run.Report.Rev++;
    }

    internal static void RecordMetric(SaturaStaging s, string name, float value, string unit, float min, float max)
    {
        var it = Live(s, out var run);
        if (it == null) return;
        var label = Label(name, "metric");
        var rep = run.Report;
        var m = it.Metrics.FirstOrDefault(x => x.Name == label);
        if (m == null)
        {
            if (it.Metrics.Count >= MaxMetrics) return;
            m = new ReportMetric { Name = label };
            it.Metrics.Add(m);
        }
        m.T = Mathf.Max(0f, it.Now);
        m.Value = value;
        m.Unit = (unit ?? "").Trim();
        m.Min = float.IsNaN(min) ? float.NegativeInfinity : min;
        m.Max = float.IsNaN(max) ? float.PositiveInfinity : max;
        float prev;
        if (rep.LastIteration != null && rep.LastIteration.TryGetValue(label, out prev)) m.Prev = prev;
        else if (rep.RunPrev != null && rep.RunPrev.TryGetValue(label, out prev)) m.Prev = prev;
        rep.Rev++;
    }

    internal static void RecordTrack(SaturaStaging s, Transform target)
    {
        if (target == null) return;
        var it = Live(s, out var run);
        if (it == null) return;
        var rep = run.Report;
        if (rep.Tracked.Contains(target)) return;
        if (rep.Tracked.Count >= MaxTracks)
        {
            Debug.LogWarning("[Staging] a run tracks at most " + MaxTracks + " objects; " + target.name + " is skipped");
            return;
        }
        var name = target.name;
        for (int i = 2; rep.TrackNames.Contains(name); i++) name = target.name + " " + i;
        rep.Tracked.Add(target);
        rep.TrackNames.Add(name);
        rep.SampledFrame = -1;
        rep.Sample();
    }

    internal static void RecordStep(SaturaStaging s, string name)
    {
        var it = Live(s, out var run);
        if (it == null || it.Steps.Count >= MaxSteps) return;
        it.Steps.Add(new ReportStep { T = Mathf.Max(0f, it.Now), Name = Label(name, "step") });
        run.Report.Rev++;
    }

    internal static void RecordCheck(SaturaStaging s, string what, bool ok)
    {
        var it = Live(s, out var run);
        if (it == null) return;
        run.Report.Sample();
        if (it.Checks.Count >= MaxChecks && ok) return;
        if (it.Checks.Count >= MaxChecks) it.Checks.RemoveAt(it.Checks.Count - 1);
        it.Checks.Add(new ReportCheck { T = Mathf.Max(0f, it.Now), What = what, Ok = ok });
        run.Report.Rev++;
    }

    internal static void RecordSnapshot(SaturaStaging s, string name)
    {
        var it = Live(s, out var run);
        if (it == null) return;
        var rep = run.Report;
        var shot = new ReportSnapshot { Seq = ++rep.SnapSeq, Iteration = it.Index, T = Mathf.Max(0f, it.Now), Name = Label(name, "snapshot") };
        rep.Snapshots.Add(shot);
        try { SnapshotRequested?.Invoke(run.Id, shot.Seq, shot.Name); }
        catch (Exception e) { Debug.LogException(e); }
        if (shot.Path == null)
        {
            rep.Snapshots.Remove(shot);
            return;
        }
        while (rep.Snapshots.Count > MaxSnapshots)
        {
            var old = rep.Snapshots[0];
            rep.Snapshots.RemoveAt(0);
            try { if (System.IO.File.Exists(old.Path)) System.IO.File.Delete(old.Path); }
            catch { }
        }
        rep.Rev++;
    }

    public static void SetSnapshot(int run, int seq, string path)
    {
        if (!Runs.TryGetValue(run, out var r) || r.Report == null) return;
        var shot = r.Report.Snapshots.FirstOrDefault(x => x.Seq == seq);
        if (shot != null) shot.Path = path;
    }

    public static string ScenarioReport(string path)
    {
        var last = Runs.Values.Where(r => r.Key == path && r.Report != null).OrderBy(r => r.Id).LastOrDefault();
        return last?.ReportJson();
    }

    public static string ScenarioReportOf(int run) => Runs.TryGetValue(run, out var r) && r.Report != null ? r.ReportJson() : null;

    public static string ScenarioState(int run) => Runs.TryGetValue(run, out var r) ? r.StateJson() : null;

    static Dictionary<string, Dictionary<string, float>> LastMetrics()
    {
        if (_lastMetrics != null) return _lastMetrics;
        _lastMetrics = new Dictionary<string, Dictionary<string, float>>();
#if UNITY_EDITOR
        foreach (var line in UnityEditor.SessionState.GetString(MetricsKey, "").Split('\n'))
        {
            var p = line.Split('\t');
            if (p.Length != 3 || !float.TryParse(p[2], NumberStyles.Float, CultureInfo.InvariantCulture, out var v)) continue;
            if (!_lastMetrics.TryGetValue(p[0], out var d)) _lastMetrics[p[0]] = d = new Dictionary<string, float>();
            d[p[1]] = v;
        }
#endif
        return _lastMetrics;
    }

    static Dictionary<string, float> PrevMetrics(string key) =>
        key != null && LastMetrics().TryGetValue(key, out var d) ? new Dictionary<string, float>(d) : null;

    static void SaveMetrics(string key, ReportIteration it)
    {
        if (key == null || it.Metrics.Count == 0) return;
        var all = LastMetrics();
        if (!all.TryGetValue(key, out var d)) all[key] = d = new Dictionary<string, float>();
        foreach (var m in it.Metrics) d[m.Name] = m.Value;
#if UNITY_EDITOR
        var sb = new StringBuilder();
        foreach (var k in all)
            foreach (var m in k.Value)
                sb.Append(k.Key.Replace('\t', ' ').Replace('\n', ' ')).Append('\t').Append(m.Key.Replace('\t', ' ').Replace('\n', ' ')).Append('\t')
                  .Append(m.Value.ToString("R", CultureInfo.InvariantCulture)).Append('\n');
        UnityEditor.SessionState.SetString(MetricsKey, sb.ToString());
#endif
    }

    static void Num(StringBuilder sb, double v, int digits = 3)
    {
        if (double.IsNaN(v) || double.IsInfinity(v)) sb.Append("null");
        else sb.Append(Math.Round(v, digits).ToString("0.#####", CultureInfo.InvariantCulture));
    }

    static void Nums(StringBuilder sb, List<float> list, int digits)
    {
        sb.Append('[');
        for (int i = 0; i < list.Count; i++)
        {
            if (i > 0) sb.Append(',');
            Num(sb, list[i], digits);
        }
        sb.Append(']');
    }

    static void Key(StringBuilder sb, string key, bool comma = true)
    {
        if (comma) sb.Append(',');
        sb.Append('"').Append(key).Append("\":");
    }

    static void WriteMetric(StringBuilder sb, ReportMetric m)
    {
        sb.Append("{\"name\":");
        SaturaJson.Write(sb, m.Name);
        Key(sb, "value");
        Num(sb, m.Value, 4);
        Key(sb, "unit");
        SaturaJson.Write(sb, m.Unit);
        Key(sb, "min");
        Num(sb, m.Min, 4);
        Key(sb, "max");
        Num(sb, m.Max, 4);
        Key(sb, "ok");
        sb.Append(m.Ok ? "true" : "false");
        Key(sb, "prev");
        Num(sb, m.Prev, 4);
        Key(sb, "t");
        Num(sb, m.T);
        sb.Append('}');
    }

    static void WriteList<T>(StringBuilder sb, string key, List<T> list, Action<T> write)
    {
        Key(sb, key);
        sb.Append('[');
        for (int i = 0; i < list.Count; i++)
        {
            if (i > 0) sb.Append(',');
            write(list[i]);
        }
        sb.Append(']');
    }

    static void WriteChecks(StringBuilder sb, ReportIteration it) =>
        WriteList(sb, "checks", it.Checks, c =>
        {
            sb.Append("{\"what\":");
            SaturaJson.Write(sb, c.What);
            Key(sb, "ok");
            sb.Append(c.Ok ? "true" : "false");
            Key(sb, "t");
            Num(sb, c.T);
            sb.Append('}');
        });

    static void WriteSteps(StringBuilder sb, ReportIteration it) =>
        WriteList(sb, "steps", it.Steps, st =>
        {
            sb.Append("{\"name\":");
            SaturaJson.Write(sb, st.Name);
            Key(sb, "t");
            Num(sb, st.T);
            sb.Append('}');
        });

    static void WriteBand(StringBuilder sb, ReportSeries s)
    {
        if (!s.HasBand) return;
        Key(sb, "band");
        sb.Append('[');
        Num(sb, s.BandMin, 4);
        sb.Append(',');
        Num(sb, s.BandMax, 4);
        sb.Append(']');
    }

    static void WriteSnapshots(StringBuilder sb, RunReport rep, ReportIteration only, bool always)
    {
        var list = rep.Snapshots.Where(x => x.Path != null && (only == null || x.Iteration == only.Index)).ToList();
        if (!always && list.Count == 0) return;
        WriteList(sb, "snapshots", list, x =>
        {
            sb.Append("{\"name\":");
            SaturaJson.Write(sb, x.Name);
            Key(sb, "iteration");
            sb.Append(x.Iteration);
            Key(sb, "t");
            Num(sb, x.T);
            Key(sb, "path");
            SaturaJson.Write(sb, x.Path);
            sb.Append('}');
        });
    }

    static void WriteSummary(StringBuilder sb, RunReport rep, bool loop)
    {
        var it = loop && rep.Current != null && !rep.Current.Ended && rep.Completed != null ? rep.Completed : rep.Current;
        if (it == null) return;
        if (loop)
        {
            Key(sb, "reportIteration");
            sb.Append(it.Index);
        }
        if (it.Metrics.Count > 0) WriteList(sb, "metrics", it.Metrics, m => WriteMetric(sb, m));
        if (it.Series.Count > 0)
            WriteList(sb, "series", it.Series, s =>
            {
                sb.Append("{\"name\":");
                SaturaJson.Write(sb, s.Name);
                Key(sb, "samples");
                sb.Append(s.Count);
                Key(sb, "min");
                Num(sb, s.Count > 0 ? s.Min : float.NaN, 4);
                Key(sb, "max");
                Num(sb, s.Count > 0 ? s.Max : float.NaN, 4);
                Key(sb, "maxAt");
                Num(sb, s.MaxAt);
                Key(sb, "last");
                Num(sb, s.Last, 4);
                WriteBand(sb, s);
                if (s.HasBand)
                {
                    Key(sb, "outside");
                    sb.Append(s.Outside);
                }
                sb.Append('}');
            });
        if (it.Steps.Count > 0) WriteSteps(sb, it);
        if (it.Checks.Count > 0) WriteChecks(sb, it);
        if (it.Tracks.Count > 0)
            WriteList(sb, "tracks", it.Tracks, tr =>
            {
                sb.Append("{\"name\":");
                SaturaJson.Write(sb, tr.Name);
                Key(sb, "points");
                sb.Append(tr.T.Count);
                Key(sb, "length");
                Num(sb, tr.Length);
                if (tr.P.Count >= 3)
                {
                    int n = tr.P.Count;
                    Key(sb, "from");
                    sb.Append('[');
                    Num(sb, tr.P[0]);
                    sb.Append(',');
                    Num(sb, tr.P[1]);
                    sb.Append(',');
                    Num(sb, tr.P[2]);
                    sb.Append("]");
                    Key(sb, "to");
                    sb.Append('[');
                    Num(sb, tr.P[n - 3]);
                    sb.Append(',');
                    Num(sb, tr.P[n - 2]);
                    sb.Append(',');
                    Num(sb, tr.P[n - 1]);
                    sb.Append(']');
                }
                sb.Append('}');
            });
        WriteSnapshots(sb, rep, loop ? it : null, false);
    }

    static string WriteReport(HandleRun run)
    {
        var rep = run.Report;
        var sb = new StringBuilder("{\"path\":");
        SaturaJson.Write(sb, run.Key ?? run.Handle.Path);
        Key(sb, "run");
        sb.Append(run.Id);
        Key(sb, "status");
        SaturaJson.Write(sb, run.Status);
        Key(sb, "loop");
        sb.Append(run.Handle.Loop ? "true" : "false");
        Key(sb, "rev");
        sb.Append(rep.Rev);
        WriteList(sb, "iterations", rep.Iterations, it =>
        {
            sb.Append("{\"index\":").Append(it.Index);
            Key(sb, "end");
            Num(sb, it.Length);
            Key(sb, "running");
            sb.Append(it.Ended ? "false" : "true");
            if (it.Stopped) sb.Append(",\"stopped\":true");
            if (it.Error != null)
            {
                Key(sb, "error");
                SaturaJson.Write(sb, it.Error);
                Key(sb, "errorAt");
                Num(sb, it.ErrorAt);
            }
            WriteList(sb, "series", it.Series, s =>
            {
                sb.Append("{\"name\":");
                SaturaJson.Write(sb, s.Name);
                WriteBand(sb, s);
                Key(sb, "t");
                Nums(sb, s.T, 3);
                Key(sb, "v");
                Nums(sb, s.V, 4);
                sb.Append('}');
            });
            WriteList(sb, "tracks", it.Tracks, tr =>
            {
                sb.Append("{\"name\":");
                SaturaJson.Write(sb, tr.Name);
                Key(sb, "t");
                Nums(sb, tr.T, 3);
                Key(sb, "p");
                Nums(sb, tr.P, 3);
                sb.Append('}');
            });
            WriteChecks(sb, it);
            WriteSteps(sb, it);
            WriteList(sb, "metrics", it.Metrics, m => WriteMetric(sb, m));
            sb.Append('}');
        });
        WriteSnapshots(sb, rep, null, true);
        sb.Append('}');
        return sb.ToString();
    }
}
}
