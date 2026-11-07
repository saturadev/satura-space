using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using UnityEngine;

namespace SaturaSpace
{

public static partial class SaturaHandles
{
    public static event Action<int> ScenarioStarted;
    public static event Action<int> ScenarioEnded;
    public static event Action<int> ScenarioIteration;
    public static event Action<GameObject, GameObject> StagingReplaced;

    static string StartScenario(Handle handle, object[] args)
    {
        if (!Application.isPlaying)
            return ErrorJson(handle.Path, "Scenarios run in Play Mode, in the staging scene. Start Play first, then run it again.", null, true);
        var key = handle.Path;
        foreach (var r in Runs.Values.ToArray())
            if (r.Key == key && !r.Ended) r.Stop();
        var target = handle.Target;
        var busy = RunningOn(target);
        if (busy != null)
            return ErrorJson(handle.Path, target.name + " is running " + busy + ". A staging prefab runs one scenario at a time: stop it first.", null);
        string note = null;
        bool reset = false;
        if (target.Used && !handle.Loop)
        {
            reset = true;
            var old = target.gameObject;
            var fresh = target.Fresh(out note);
            if (fresh == null)
                return ErrorJson(handle.Path, target.name + " could not be reset to a fresh copy for this run.", null);
            try { StagingReplaced?.Invoke(old, fresh.gameObject); }
            catch (Exception e) { Debug.LogException(e); }
            target = fresh;
            if (note != null) Debug.LogWarning("[Staging] " + note);
        }
        target.Used = true;
        var h = new Handle { Method = handle.Method, Description = handle.Description, Group = handle.Group, Target = target, Scenario = true, Loop = handle.Loop };
        var run = NewRun(h, args);
        run.Key = key;
        run.Note = note;
        run.Report = new RunReport { RunPrev = PrevMetrics(key) };
        if (reset) run.Logs.Add(target.name + " was replaced with a fresh copy for this run");
        try { ScenarioStarted?.Invoke(run.Id); }
        catch (Exception e) { Debug.LogException(e); }
        run.BeginScenario();
        return run.ToJson();
    }

    internal static string RunningOn(SaturaStaging staging)
    {
        if (staging == null) return null;
        foreach (var r in Runs.Values)
            if (!r.Ended && r.Handle.Scenario && r.Handle.Target == staging) return r.Handle.Name;
        return null;
    }

    public static string StopScenario(string path)
    {
        var running = Runs.Values.Where(r => r.Key == path && !r.Ended).ToList();
        if (running.Count == 0) return ErrorJson(path, "No run of " + path + " is going.", null);
        foreach (var r in running) r.Stop();
        return running[running.Count - 1].ToJson();
    }

    public static bool ScenarioRun(int run, out GameObject staging, out string path, out bool loop)
    {
        staging = null;
        path = null;
        loop = false;
        if (!Runs.TryGetValue(run, out var r) || !r.Handle.Scenario) return false;
        staging = r.Handle.Target != null ? r.Handle.Target.gameObject : null;
        path = r.Key;
        loop = r.Handle.Loop;
        return true;
    }

    public static void SetRunVideo(int run, string path)
    {
        if (Runs.TryGetValue(run, out var r)) r.Video = path;
    }

    public static string StagingJson()
    {
        var all = All();
        var sb = new StringBuilder("[");
        bool first = true;
        foreach (var g in all.Where(h => h.Target != null).GroupBy(h => h.Target))
        {
            var s = g.Key;
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"name\":");
            SaturaJson.Write(sb, s.name);
            sb.Append(",\"group\":");
            SaturaJson.Write(sb, g.First().Group);
            sb.Append(",\"path\":");
            SaturaJson.Write(sb, SaturaStaging.PathOf(s.transform));
            sb.Append(",\"scene\":");
            SaturaJson.Write(sb, s.gameObject.scene.path);
            sb.Append(",\"type\":");
            SaturaJson.Write(sb, s.GetType().Name);
            sb.Append(",\"running\":");
            SaturaJson.Write(sb, RunningOn(s) ?? "");
            sb.Append(",\"scenarios\":[");
            bool f2 = true;
            foreach (var h in g.Where(x => x.Scenario).OrderBy(x => x.Method.MetadataToken))
            {
                if (!f2) sb.Append(',');
                f2 = false;
                var last = Runs.Values.Where(r => r.Key == h.Path).OrderBy(r => r.Id).LastOrDefault();
                sb.Append("{\"name\":");
                SaturaJson.Write(sb, h.Name);
                sb.Append(",\"path\":");
                SaturaJson.Write(sb, h.Path);
                sb.Append(",\"loop\":").Append(h.Loop ? "true" : "false");
                sb.Append(",\"description\":");
                SaturaJson.Write(sb, h.Description);
                if (last != null) sb.Append(",\"run\":").Append(last.StateJson());
                sb.Append('}');
            }
            sb.Append("],\"handles\":[");
            bool f3 = true;
            foreach (var h in g.Where(x => !x.Scenario).OrderBy(x => x.Name, StringComparer.Ordinal))
            {
                if (!f3) sb.Append(',');
                f3 = false;
                SaturaJson.Write(sb, h.Path);
            }
            sb.Append("]}");
        }
        sb.Append(']');
        return sb.ToString();
    }
}
}
