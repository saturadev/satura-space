using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const int TUNER_MAX_ENTRIES = 512;

    static string CleanTunerAssetPath(string path)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var p = path.Trim().Replace('\\', '/');
        if (!p.StartsWith("Assets/", StringComparison.Ordinal) && !p.StartsWith("Packages/", StringComparison.Ordinal)) return null;
        foreach (var part in p.Split('/'))
            if (part == "..") return null;
        return p;
    }

    static TunerEntry AddTunerAssetEntry(TunerSession s, string path, string label, bool opened)
    {
        var p = CleanTunerAssetPath(path);
        if (p == null) return null;
        foreach (var e in s.Entries)
            if (e.Asset && e.Path == p) return e;
        if (s.Entries.Count >= TUNER_MAX_ENTRIES) return null;
        int n = 0;
        foreach (var e in s.Entries) if (e.Asset) n++;
        var entry = new TunerEntry { Id = "a" + n.ToString(Inv), Asset = true, Opened = opened, Path = p, Label = label };
        s.Entries.Add(entry);
        s.TracksStale = true;
        return entry;
    }

    static TunerEntry AddTunerOpenedEntry(TunerSession s, string path, string scene, string id = null, bool ghost = false)
    {
        var p = (path ?? "").Trim().Trim('/');
        if (p.Length == 0) return null;
        foreach (var e in s.Entries)
            if (!e.Asset && e.Path == p && (e.Scene ?? "") == (scene ?? "")) return e;
        if (s.Entries.Count >= TUNER_MAX_ENTRIES) return null;
        var entry = new TunerEntry { Id = NextTunerOpenedId(s, id), Opened = true, Ghost = ghost, Path = p, Scene = string.IsNullOrEmpty(scene) ? null : scene };
        s.Entries.Add(entry);
        s.MemberPaths.Remove(entry.Id);
        s.TracksStale = true;
        s.CacheDirty = true;
        return entry;
    }

    static bool TunerOpenedIdFree(TunerSession s, string id)
    {
        foreach (var e in s.Entries)
            if (e.Id == id) return false;
        return !s.MemberPaths.ContainsKey(id);
    }

    static string NextTunerOpenedId(TunerSession s, string want)
    {
        int n;
        if (!string.IsNullOrEmpty(want) && want.Length > 1 && want[0] == 'u'
            && int.TryParse(want.Substring(1), System.Globalization.NumberStyles.None, Inv, out n) && TunerOpenedIdFree(s, want))
            return want;
        n = 0;
        while (!TunerOpenedIdFree(s, "u" + n.ToString(Inv))) n++;
        return "u" + n.ToString(Inv);
    }

    static void TunerClose(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        TunerEntry found = null;
        foreach (var e in s.Entries)
            if (!e.Asset && e.Opened && e.Id == a.id) found = e;
        if (found == null)
        {
            TunerResult(from, id, "no opened object '" + a.id + "' in session " + s.Name, null);
            return;
        }
        s.Entries.Remove(found);
        s.MemberPaths[found.Id] = found.Path;
        var drop = new List<string>();
        foreach (var kv in s.Tracks)
            if (kv.Value.Entry == found.Id) drop.Add(kv.Key);
        foreach (var k in drop) s.Tracks.Remove(k);
        if (s.WatchEntry == found.Id) s.WatchEntry = null;
        s.CacheDirty = true;
        s.Dirty = true;
        s.StatePending = true;
        Debug.Log("[Tuner] close " + (found.Ghost ? "ghost " : "object ") + found.Path + " (" + found.Id + ") in " + s.Name);
        TunerResult(from, id, null, "\"state\":" + DescribeTunerState(s));
    }

    static void ResolveTunerEntries(TunerSession s)
    {
        List<UnityEngine.SceneManagement.Scene> scenes = null;
        foreach (var e in s.Entries)
        {
            if (e.Asset)
            {
                if (e.Main == null)
                {
                    try { e.Main = AssetDatabase.LoadMainAssetAtPath(e.Path); }
                    catch { e.Main = null; }
                    if (e.Main != null) s.TracksStale = true;
                }
                continue;
            }
            if (e.Go != null) continue;
            if (scenes == null) scenes = TunerScenes();
            e.Go = FindTunerObject(scenes, new TunerObjectArgs { path = e.Path, scene = e.Scene });
            if (e.Go != null) s.TracksStale = true;
        }
    }

    static int CountTunerEntries(TunerSession s)
    {
        int n = 0;
        foreach (var e in s.Entries)
            if (e.Asset ? e.Main != null : e.Go != null) n++;
        return n;
    }

    static string TunerObjectPath(GameObject go)
    {
        return TunerIndexedPath(go.transform);
    }

    static void TunerOpen(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        string entryId;
        bool created = false;
        if (a.kind == "asset")
        {
            var p = CleanTunerAssetPath(a.path);
            if (p == null || AssetDatabase.LoadMainAssetAtPath(p) == null)
            {
                TunerResult(from, id, "no asset at " + a.path, null);
                return;
            }
            var e = AddTunerAssetEntry(s, p, null, true);
            if (e == null)
            {
                TunerResult(from, id, "the Tuner holds " + TUNER_MAX_ENTRIES + " extra entries at most", null);
                return;
            }
            entryId = e.Id;
        }
        else
        {
            var go = FindTunerObject(TunerScenes(), new TunerObjectArgs { path = a.path, scene = a.scene });
            if (go == null)
            {
                TunerResult(from, id, "no object '" + a.path + "' in the loaded scenes", null);
                return;
            }
            entryId = null;
            foreach (var i in TunerActiveObjects(s))
                if (s.Objects[i] == go) entryId = "o" + i.ToString(Inv);
            if (entryId == null)
            {
                foreach (var e in s.Entries)
                    if (!e.Asset && e.Go == go) entryId = e.Id;
            }
            TunerEntry member;
            if (entryId == null && s.MemberByGo.TryGetValue(go, out member))
            {
                entryId = member.Id;
                TouchTunerMember(s, entryId);
            }
            if (entryId == null)
            {
                var e = AddTunerOpenedEntry(s, TunerObjectPath(go), TunerSceneKey(go.scene), null, a.ghost);
                if (e == null)
                {
                    TunerResult(from, id, "the Tuner holds " + TUNER_MAX_ENTRIES + " extra entries at most", null);
                    return;
                }
                e.Go = go;
                entryId = e.Id;
                created = true;
            }
        }
        ResolveTunerEntries(s);
        TunerTrackAll(s);
        s.StatePending = true;
        s.CacheDirty = true;
        s.Dirty = true;
        Debug.Log("[Tuner] open " + (a.kind == "asset" ? "asset " : "object ") + a.path + " as " + entryId + (created && a.ghost ? " (ghost)" : "") + " in " + s.Name);
        TunerResult(from, id, null, "\"entry\":" + JStr(entryId) + ",\"created\":" + (created ? "true" : "false") + ",\"state\":" + DescribeTunerState(s));
    }

    static void TunerButton(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        string output;
        string error;
        Undo.IncrementCurrentGroup();
        Undo.SetCurrentGroupName("Tuner " + (string.IsNullOrEmpty(a.label) ? a.method : a.label));
        try { error = RunTunerButton(a, out output); }
        catch (Exception e)
        {
            error = e.GetType().Name + ": " + e.Message;
            output = null;
        }
        Undo.IncrementCurrentGroup();
        foreach (var t in s.Tracks.Values) MarkTunerTrack(t, null);
        s.Dirty = true;
        s.StatePending = true;
        Debug.Log("[Tuner] button " + a.label + " -> " + (error ?? (output ?? "done")));
        TunerResult(from, id, error, output != null ? "\"output\":" + JStr(output) : null);
    }

    static string RunTunerButton(TunerArgs a, out string output)
    {
        output = null;
        if (string.IsNullOrEmpty(a.method)) return "the button has no method";
        var label = string.IsNullOrEmpty(a.label) ? a.method : a.label;
        if (!string.IsNullOrEmpty(a.asset)) return InvokeTunerMethod(a.asset, null, a.method, false, out output);
        if (!string.IsNullOrEmpty(a.path))
        {
            var go = FindTunerStepObject(a.path, a.scene);
            if (go == null) return "no object " + a.path;
            var comp = FindTunerComponent(go, a.component, 0);
            if (comp == null) return "no " + a.component + " on " + a.path;
            var mi = FindTunerMethod(comp.GetType(), a.method, false);
            if (mi == null) return "no parameterless method '" + a.method + "' on " + comp.GetType().Name;
            if (!EditorApplication.isPlaying) Undo.RecordObject(comp, label);
            object result;
            try { result = mi.Invoke(mi.IsStatic ? null : comp, null); }
            catch (TargetInvocationException e)
            {
                var inner = e.InnerException ?? e;
                Debug.LogException(inner);
                return inner.GetType().Name + ": " + inner.Message;
            }
            MarkTunerSceneDirty(comp);
            output = TunerMethodOutput(mi, result);
            return null;
        }
        if (string.IsNullOrEmpty(a.type)) return "the button needs a type, an object or an asset";
        return InvokeTunerMethod(null, a.type, a.method, false, out output);
    }

    static string TunerMethodOutput(MethodInfo mi, object result)
    {
        if (mi.ReturnType == typeof(void) || result == null) return null;
        var s = result.ToString();
        return s.Length > 2000 ? s.Substring(0, 2000) + "…" : s;
    }

    static void AppendTunerInspect(StringBuilder sb, string path, string scene, TunerComponentArgs[] components, string[] exclude = null, int[] at = null)
    {
        sb.Append(",\"inspect\":{\"kind\":\"object\",\"path\":").Append(JStr(path));
        if (!string.IsNullOrEmpty(scene)) sb.Append(",\"scene\":").Append(JStr(scene));
        if (components != null)
        {
            sb.Append(",\"components\":[");
            bool first = true;
            foreach (var c in components)
            {
                if (c == null || string.IsNullOrEmpty(c.type)) continue;
                if (!first) sb.Append(',');
                first = false;
                sb.Append("{\"type\":").Append(JStr(c.type));
                if (c.index > 0) sb.Append(",\"index\":").Append(c.index.ToString(Inv));
                AppendTunerFilter(sb, c.hasFields || (c.fields != null && c.fields.Length > 0), c.fields, c.exclude);
                sb.Append('}');
            }
            sb.Append(']');
        }
        else AppendTunerFilter(sb, false, null, exclude);
        if (at != null)
        {
            sb.Append(",\"at\":[");
            for (int k = 0; k < at.Length; k++)
            {
                if (k > 0) sb.Append(',');
                sb.Append(at[k].ToString(Inv));
            }
            sb.Append(']');
        }
        sb.Append('}');
    }

    static string DescribeTunerEntry(TunerSession s, string id)
    {
        int i = TunerIndex(s, id);
        if (i >= 0) return DescribeTunerObject(s, i);
        var e = FindTunerEntry(s, id);
        if (e == null) return "null";
        var sb = new StringBuilder(1024);
        sb.Append("{\"id\":").Append(JStr(e.Id))
          .Append(",\"kind\":").Append(e.Asset ? "\"asset\"" : e.Member ? "\"member\"" : "\"opened\"")
          .Append(",\"opened\":").Append(e.Opened ? "true" : "false")
          .Append(e.Ghost ? ",\"ghost\":true" : "")
          .Append(",\"path\":").Append(JStr(e.Path));
        if (e.Asset)
        {
            var name = e.Main != null ? e.Main.name : System.IO.Path.GetFileNameWithoutExtension(e.Path);
            sb.Append(",\"scene\":\"\",\"label\":").Append(JStr(string.IsNullOrEmpty(e.Label) ? name : e.Label))
              .Append(",\"type\":").Append(JStr(e.Main != null ? e.Main.GetType().Name : ""))
              .Append(",\"ancestors\":[],\"active\":true");
            AppendTunerVec(sb, "position", Vector3.zero);
            AppendTunerQuat(sb, "rotation", Quaternion.identity);
            AppendTunerVec(sb, "localPosition", Vector3.zero);
            AppendTunerQuat(sb, "localRotation", Quaternion.identity);
            AppendTunerVec(sb, "localScale", Vector3.one);
            sb.Append(",\"bounds\":null,\"components\":[");
            if (e.Main != null)
            {
                var ago = e.Main as GameObject;
                if (ago != null) AppendTunerAllComponents(sb, ago);
                else AppendTunerComponentKey(sb, TunerShortType(e.Main.GetType()), e.Main);
            }
            sb.Append(']');
            if (e.Main == null) sb.Append(",\"error\":").Append(JStr("no asset at " + e.Path));
            sb.Append(",\"inspect\":{\"kind\":\"asset\",\"path\":").Append(JStr(e.Path));
            if (e.Filter != null) AppendTunerFilter(sb, e.Filter.hasFields, e.Filter.fields, e.Filter.exclude);
            sb.Append("}}");
            return sb.ToString();
        }
        var go = e.Go;
        if (go == null)
        {
            var slash = e.Path.LastIndexOf('/');
            sb.Append(",\"scene\":").Append(JStr(e.Scene ?? ""))
              .Append(",\"label\":").Append(JStr(slash >= 0 ? e.Path.Substring(slash + 1) : e.Path))
              .Append(",\"ancestors\":[],\"active\":false");
            AppendTunerVec(sb, "position", Vector3.zero);
            AppendTunerQuat(sb, "rotation", Quaternion.identity);
            AppendTunerVec(sb, "localPosition", Vector3.zero);
            AppendTunerQuat(sb, "localRotation", Quaternion.identity);
            AppendTunerVec(sb, "localScale", Vector3.one);
            sb.Append(",\"bounds\":null,\"components\":[],\"error\":").Append(JStr("not found in the loaded scenes: " + e.Path)).Append('}');
            return sb.ToString();
        }
        var t = go.transform;
        sb.Append(",\"scene\":").Append(JStr(TunerSceneKey(go.scene) ?? ""))
          .Append(",\"label\":").Append(JStr(go.name))
          .Append(",\"ancestors\":[");
        var chain = new List<string>();
        for (var p = t.parent; p != null; p = p.parent) chain.Add(p.name);
        for (int k = chain.Count - 1; k >= 0; k--)
        {
            if (k < chain.Count - 1) sb.Append(',');
            sb.Append(JStr(chain[k]));
        }
        sb.Append("],\"active\":").Append(go.activeInHierarchy ? "true" : "false");
        AppendTunerVec(sb, "position", t.position);
        AppendTunerQuat(sb, "rotation", t.rotation);
        AppendTunerVec(sb, "localPosition", t.localPosition);
        AppendTunerQuat(sb, "localRotation", t.localRotation);
        AppendTunerVec(sb, "localScale", t.localScale);
        Bounds mb;
        if (e.Member && TunerBounds(go, out mb))
        {
            sb.Append(",\"bounds\":{\"center\":");
            AppendTunerArray(sb, mb.center.x, mb.center.y, mb.center.z);
            sb.Append(",\"size\":");
            AppendTunerArray(sb, mb.size.x, mb.size.y, mb.size.z);
            sb.Append('}');
        }
        else sb.Append(",\"bounds\":null");
        sb.Append(",\"components\":[");
        AppendTunerAllComponents(sb, go);
        sb.Append(']');
        AppendTunerAt(sb, t);
        AppendTunerInspect(sb, e.Path, TunerSceneKey(go.scene), null, null, TunerAmbiguousAt(t));
        sb.Append('}');
        return sb.ToString();
    }
}
