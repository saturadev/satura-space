using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

public static partial class MCPTestBridge
{
    [Serializable]
    class TunerRectArgs
    {
        public string session;
        public string op;
        public string id;
        public float[] anchorMin;
        public float[] anchorMax;
        public float[] anchoredPosition;
        public float[] sizeDelta;
        public float[] pivot;
        public float[] localRotation;
        public float localPositionZ;
        public bool hasZ;
        public bool final;
        public string label;
        public string[] ids;
        public TunerRectItem[] items;
    }

    [Serializable]
    class TunerRectItem
    {
        public string id;
        public float[] anchorMin;
        public float[] anchorMax;
        public float[] anchoredPosition;
        public float[] sizeDelta;
        public float[] pivot;
        public float[] localRotation;
        public float localPositionZ;
        public bool hasZ;
    }

    [Serializable]
    class TunerRectCommand
    {
        public int id;
        public TunerRectArgs args;
    }

    class TunerRectDrag
    {
        public int Group;
        public string Id;
        public double At;
    }

    const double TUNER_RECT_DRAG_IDLE = 10.0;
    static readonly Dictionary<string, TunerRectDrag> s_TunerRectDrags = new Dictionary<string, TunerRectDrag>();

    static bool HandleTunerRect(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/rect" && cmd != "tuner/undo") return false;
        TunerRectCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerRectCommand>(line); }
        catch (Exception e)
        {
            TunerResult(from, id, "bad arguments: " + e.Message, null);
            return true;
        }
        var a = parsed != null ? parsed.args : null;
        var s = a != null ? FindTuner(a.session) : null;
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + (a != null ? a.session : "") + "'", null);
            return true;
        }
        if (cmd == "tuner/undo")
        {
            s_TunerRectDrags.Remove(s.Name);
            if (a.op == "redo") Undo.PerformRedo();
            else Undo.PerformUndo();
            s.Dirty = true;
            s.StatePending = true;
            SignalEditorTick();
            TunerResult(from, id, null, null);
            return true;
        }
        if (a.op == "getMany" || a.op == "setMany")
        {
            HandleTunerRects(id, s, a, from);
            return true;
        }
        GameObject go;
        RectTransform rt;
        TunerRectTarget(s, a.id, out go, out rt);
        Bounds lb;
        if (rt == null && go != null && TunerRendererRect(go, out lb))
        {
            if (a.op == "get")
            {
                TunerResult(from, id, null, "\"rect\":" + TunerRendererRectJson(a.id, go.transform, lb));
                return true;
            }
            if (a.op != "set")
            {
                TunerResult(from, id, "unknown rect op: " + a.op, null);
                return true;
            }
            string rerr = TunerRendererRectApply(s, a, go, lb, null);
            TunerRendererRect(go, out lb);
            TunerResult(from, id, rerr, rerr == null ? "\"rect\":" + TunerRendererRectJson(a.id, go.transform, lb) : null);
            return true;
        }
        if (rt == null)
        {
            TunerResult(from, id, go == null ? "no object '" + a.id + "' in session " + s.Name : go.name + " has no RectTransform", null);
            return true;
        }
        if (a.op == "get")
        {
            TunerResult(from, id, null, "\"rect\":" + TunerRectJson(a.id, rt));
            return true;
        }
        if (a.op != "set")
        {
            TunerResult(from, id, "unknown rect op: " + a.op, null);
            return true;
        }
        string err = TunerRectApply(s, a, go, rt, null);
        TunerResult(from, id, err, err == null ? "\"rect\":" + TunerRectJson(a.id, rt) : null);
        return true;
    }

    static void TunerRectTarget(TunerSession s, string objId, out GameObject go, out RectTransform rt)
    {
        int index = TunerIndex(s, objId);
        var entry = index < 0 ? FindTunerEntry(s, objId) : null;
        go = index >= 0 ? s.Objects[index] : entry != null && !entry.Asset ? entry.Go : null;
        rt = go != null ? go.transform as RectTransform : null;
    }

    static string TunerAnyRectJson(TunerSession s, string objId)
    {
        GameObject go;
        RectTransform rt;
        TunerRectTarget(s, objId, out go, out rt);
        if (rt != null) return TunerRectJson(objId, rt);
        Bounds lb;
        return go != null && TunerRendererRect(go, out lb) ? TunerRendererRectJson(objId, go.transform, lb) : null;
    }

    static TunerRectDrag TunerRectGroup(TunerSession s, string key, string label)
    {
        double now = EditorApplication.timeSinceStartup;
        TunerRectDrag drag;
        if (!s_TunerRectDrags.TryGetValue(s.Name, out drag) || drag.Id != key || now - drag.At > TUNER_RECT_DRAG_IDLE)
        {
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName(label);
            drag = new TunerRectDrag { Group = Undo.GetCurrentGroup(), Id = key };
            s_TunerRectDrags[s.Name] = drag;
        }
        drag.At = now;
        return drag;
    }

    static void EndTunerRectGroup(TunerSession s, TunerRectDrag drag)
    {
        s_TunerRectDrags.Remove(s.Name);
        Undo.CollapseUndoOperations(drag.Group);
        Undo.IncrementCurrentGroup();
        FlushTunerTracks(s);
    }

    static void HandleTunerRects(int id, TunerSession s, TunerRectArgs a, ControlClient from)
    {
        var sb = new StringBuilder(1024);
        sb.Append("\"rects\":[");
        int n = 0;
        if (a.op == "getMany")
        {
            if (a.ids != null)
                foreach (var objId in a.ids)
                {
                    var json = string.IsNullOrEmpty(objId) ? null : TunerAnyRectJson(s, objId);
                    if (json == null) continue;
                    if (n++ > 0) sb.Append(',');
                    sb.Append(json);
                }
            TunerResult(from, id, null, sb.Append(']').ToString());
            return;
        }
        if (a.items == null || a.items.Length == 0)
        {
            TunerResult(from, id, "no rect items", null);
            return;
        }
        var key = new StringBuilder("many");
        foreach (var it in a.items) key.Append(':').Append(it != null ? it.id : "");
        string label = string.IsNullOrEmpty(a.label) ? "Tuner rect " + a.items.Length + " objects" : a.label;
        var drag = TunerRectGroup(s, key.ToString(), label);
        string error = null;
        var done = new List<string>();
        foreach (var it in a.items)
        {
            if (it == null || string.IsNullOrEmpty(it.id)) continue;
            var one = new TunerRectArgs
            {
                session = a.session, op = "set", id = it.id, anchorMin = it.anchorMin, anchorMax = it.anchorMax, anchoredPosition = it.anchoredPosition,
                sizeDelta = it.sizeDelta, pivot = it.pivot, localRotation = it.localRotation, localPositionZ = it.localPositionZ, hasZ = it.hasZ, label = label
            };
            GameObject go;
            RectTransform rt;
            TunerRectTarget(s, it.id, out go, out rt);
            Bounds lb;
            string err;
            if (rt != null) err = TunerRectApply(s, one, go, rt, drag);
            else if (go != null && TunerRendererRect(go, out lb)) err = TunerRendererRectApply(s, one, go, lb, drag);
            else err = go == null ? "no object '" + it.id + "' in session " + s.Name : go.name + " has no rect";
            if (err != null)
            {
                if (error == null) error = err;
                continue;
            }
            var json = TunerAnyRectJson(s, it.id);
            if (json != null)
            {
                if (n++ > 0) sb.Append(',');
                sb.Append(json);
            }
            done.Add(TunerRectSummary(go));
        }
        if (a.final)
        {
            EndTunerRectGroup(s, drag);
            if (done.Count > 0)
                Debug.Log("[Tuner] rect " + done.Count + " objects: " + string.Join("; ", done) + (EditorApplication.isPlaying ? "" : " (Edit Mode, with Undo)"));
        }
        s.Dirty = true;
        s.StatePending = true;
        TunerResult(from, id, n == 0 ? error ?? "no rect edited" : null, n == 0 ? null : sb.Append(']').ToString());
    }

    static string TunerRectSummary(GameObject go)
    {
        var t = go.transform;
        var rt = t as RectTransform;
        if (rt != null)
            return go.name + " pos " + TunerRectTuple(rt.anchoredPosition) + " size " + TunerRectTuple(rt.sizeDelta) + " rot " + rt.localEulerAngles.z.ToString("0.##", Inv);
        var sr = go.GetComponent<SpriteRenderer>();
        bool sized = sr != null && sr.drawMode != SpriteDrawMode.Simple;
        return go.name + " pos " + TunerRectTuple(t.localPosition) + " scale " + TunerRectTuple(t.localScale) + (sized ? " size " + TunerRectTuple(sr.size) : "")
            + " rot " + t.localEulerAngles.z.ToString("0.##", Inv);
    }

    static string TunerRectApply(TunerSession s, TunerRectArgs a, GameObject go, RectTransform rt, TunerRectDrag group)
    {
        int i = TunerIndex(s, a.id);
        string key = TunerKeyOf(go, rt);
        if (i >= 0)
        {
            if (!TunerInActive(s, i)) return "object '" + a.id + "' is not part of state " + s.States[s.Active].Name;
            var spec = s.Specs[i];
            bool tunable = TunerSpecAll(spec) ? !TunerFilterExcludes(spec.exclude, key) : TunerSpecFor(spec, go, rt) != null;
            if (!tunable) return "the RectTransform of " + TunerSpecPath(spec) + " is not tunable";
        }
        TouchTunerMember(s, a.id);
        if (s.TracksStale) TunerTrackAll(s);
        var track = EnsureTunerTrack(s, a.id, key);
        bool playing = EditorApplication.isPlaying;
        var drag = group ?? TunerRectGroup(s, a.id, string.IsNullOrEmpty(a.label) ? "Tuner rect " + go.name : a.label);
        Undo.RecordObject(rt, string.IsNullOrEmpty(a.label) ? "Tuner rect " + go.name : a.label);
        Vector2 v;
        if (TunerRectVec2(a.anchorMin, out v))
        {
            TunerRectBeforeSet(s, track, playing, "m_AnchorMin");
            rt.anchorMin = v;
        }
        if (TunerRectVec2(a.anchorMax, out v))
        {
            TunerRectBeforeSet(s, track, playing, "m_AnchorMax");
            rt.anchorMax = v;
        }
        if (TunerRectVec2(a.pivot, out v))
        {
            TunerRectBeforeSet(s, track, playing, "m_Pivot");
            rt.pivot = v;
        }
        if (TunerRectVec2(a.sizeDelta, out v))
        {
            TunerRectBeforeSet(s, track, playing, "m_SizeDelta");
            rt.sizeDelta = v;
        }
        if (TunerRectVec2(a.anchoredPosition, out v))
        {
            TunerRectBeforeSet(s, track, playing, "m_AnchoredPosition");
            rt.anchoredPosition = v;
        }
        Quaternion q;
        if (ToQuat(a.localRotation, out q))
        {
            TunerRectBeforeSet(s, track, playing, "m_LocalRotation");
            rt.localRotation = q;
        }
        if (a.hasZ && !float.IsNaN(a.localPositionZ) && !float.IsInfinity(a.localPositionZ))
        {
            TunerRectBeforeSet(s, track, playing, "m_LocalPosition.z");
            var lp = rt.localPosition;
            lp.z = a.localPositionZ;
            rt.localPosition = lp;
        }
        MarkTunerSceneDirty(rt);
        if (track != null && track.Dirty) DiffTunerTrack(s, track);
        if (a.final && group == null)
        {
            EndTunerRectGroup(s, drag);
            Debug.Log("[Tuner] rect " + go.name + " anchors " + TunerRectTuple(rt.anchorMin) + "-" + TunerRectTuple(rt.anchorMax)
                + " pivot " + TunerRectTuple(rt.pivot) + " pos " + TunerRectTuple(rt.anchoredPosition) + " size " + TunerRectTuple(rt.sizeDelta)
                + " rot " + rt.localEulerAngles.z.ToString("0.##", Inv) + (playing ? "" : " (Edit Mode, with Undo)"));
        }
        s.Dirty = true;
        s.StatePending = true;
        return null;
    }

    static void TunerRectBeforeSet(TunerSession s, TunerTrack track, bool playing, string field)
    {
        if (track == null) return;
        if (playing) RebaseTunerTrack(s, track, field);
        MarkTunerTrack(track, field);
    }

    static bool TunerRectVec2(float[] v, out Vector2 r)
    {
        r = default;
        if (v == null || v.Length != 2) return false;
        if (float.IsNaN(v[0]) || float.IsNaN(v[1]) || float.IsInfinity(v[0]) || float.IsInfinity(v[1])) return false;
        r = new Vector2(v[0], v[1]);
        return true;
    }

    static string TunerRectTuple(Vector2 v)
    {
        return "(" + v.x.ToString("0.###", Inv) + ", " + v.y.ToString("0.###", Inv) + ")";
    }

    static StringBuilder TunerRectNum(StringBuilder sb, float v)
    {
        if (float.IsNaN(v) || float.IsInfinity(v)) v = 0f;
        return sb.Append(v.ToString("R", Inv));
    }

    static void TunerRectArr(StringBuilder sb, string key, params float[] v)
    {
        if (sb[sb.Length - 1] != '{') sb.Append(',');
        sb.Append('"').Append(key).Append("\":[");
        for (int i = 0; i < v.Length; i++)
        {
            if (i > 0) sb.Append(',');
            TunerRectNum(sb, v[i]);
        }
        sb.Append(']');
    }

    static void TunerRectFrame(StringBuilder sb, Transform t)
    {
        var o = t.position;
        var x = t.TransformVector(Vector3.right);
        var y = t.TransformVector(Vector3.up);
        var z = t.TransformVector(Vector3.forward);
        TunerRectArr(sb, "origin", o.x, o.y, o.z);
        TunerRectArr(sb, "ux", x.x, x.y, x.z);
        TunerRectArr(sb, "uy", y.x, y.y, y.z);
        TunerRectArr(sb, "uz", z.x, z.y, z.z);
    }

    static string TunerRectJson(string id, RectTransform rt)
    {
        var sb = new StringBuilder(640);
        sb.Append("{\"id\":").Append(JStr(id));
        TunerRectArr(sb, "anchorMin", rt.anchorMin.x, rt.anchorMin.y);
        TunerRectArr(sb, "anchorMax", rt.anchorMax.x, rt.anchorMax.y);
        TunerRectArr(sb, "anchoredPosition", rt.anchoredPosition.x, rt.anchoredPosition.y);
        TunerRectArr(sb, "sizeDelta", rt.sizeDelta.x, rt.sizeDelta.y);
        TunerRectArr(sb, "pivot", rt.pivot.x, rt.pivot.y);
        var r = rt.rect;
        TunerRectArr(sb, "rect", r.x, r.y, r.width, r.height);
        var q = rt.localRotation;
        TunerRectArr(sb, "localRotation", q.x, q.y, q.z, q.w);
        TunerRectNum(sb.Append(",\"localPositionZ\":"), rt.localPosition.z);
        var sc = rt.localScale;
        TunerRectArr(sb, "localScale", sc.x, sc.y, sc.z);
        sb.Append(",\"frame\":{");
        TunerRectFrame(sb, rt);
        sb.Append('}');
        var p = rt.parent as RectTransform;
        if (p != null)
        {
            sb.Append(",\"parent\":{");
            var pr = p.rect;
            sb.Append("\"rect\":[");
            TunerRectNum(sb, pr.x).Append(',');
            TunerRectNum(sb, pr.y).Append(',');
            TunerRectNum(sb, pr.width).Append(',');
            TunerRectNum(sb, pr.height).Append(']');
            TunerRectFrame(sb, p);
            sb.Append('}');
        }
        else sb.Append(",\"parent\":null");
        sb.Append('}');
        return sb.ToString();
    }

    static readonly List<Renderer> _tunerRectRends = new List<Renderer>();

    static bool TunerRectRendererUsable(Renderer r)
    {
        return r != null && r.enabled && r.gameObject.activeInHierarchy && !(r is ParticleSystemRenderer) && !TunerIsTilemap(r);
    }

    static bool TunerRendererRect(GameObject go, out Bounds lb)
    {
        lb = default;
        var own = go.GetComponent<Renderer>();
        if (TunerRectRendererUsable(own))
        {
            lb = own.localBounds;
            return lb.size.x > 1e-6f && lb.size.y > 1e-6f;
        }
        if (own != null) return false;
        go.GetComponentsInChildren(false, _tunerRectRends);
        var t = go.transform;
        bool any = false;
        foreach (var r in _tunerRectRends)
        {
            if (!TunerRectRendererUsable(r)) continue;
            var wb = r.bounds;
            var c = wb.center;
            var e = wb.extents;
            for (int i = 0; i < 8; i++)
            {
                var p = t.InverseTransformPoint(new Vector3(c.x + ((i & 1) == 0 ? -e.x : e.x), c.y + ((i & 2) == 0 ? -e.y : e.y), c.z + ((i & 4) == 0 ? -e.z : e.z)));
                if (!any)
                {
                    lb = new Bounds(p, Vector3.zero);
                    any = true;
                }
                else lb.Encapsulate(p);
            }
        }
        _tunerRectRends.Clear();
        return any && lb.size.x > 1e-6f && lb.size.y > 1e-6f;
    }

    static void TunerRectFrameOf(StringBuilder sb, Vector3 o, Vector3 x, Vector3 y, Vector3 z)
    {
        TunerRectArr(sb, "origin", o.x, o.y, o.z);
        TunerRectArr(sb, "ux", x.x, x.y, x.z);
        TunerRectArr(sb, "uy", y.x, y.y, y.z);
        TunerRectArr(sb, "uz", z.x, z.y, z.z);
    }

    static string TunerRendererRectJson(string id, Transform t, Bounds lb)
    {
        var sc = t.localScale;
        float ax = Mathf.Abs(sc.x), ay = Mathf.Abs(sc.y);
        float sx = sc.x < 0f ? -1f : 1f, sy = sc.y < 0f ? -1f : 1f;
        float w = lb.size.x * ax, h = lb.size.y * ay;
        var sb = new StringBuilder(640);
        sb.Append("{\"id\":").Append(JStr(id)).Append(",\"renderer\":true");
        TunerRectArr(sb, "anchorMin", 0f, 0f);
        TunerRectArr(sb, "anchorMax", 0f, 0f);
        var lp = t.localPosition;
        TunerRectArr(sb, "anchoredPosition", lp.x, lp.y);
        TunerRectArr(sb, "sizeDelta", w, h);
        TunerRectArr(sb, "pivot", -lb.min.x / lb.size.x, -lb.min.y / lb.size.y);
        TunerRectArr(sb, "rect", lb.min.x * ax, lb.min.y * ay, w, h);
        var q = t.localRotation;
        TunerRectArr(sb, "localRotation", q.x, q.y, q.z, q.w);
        TunerRectNum(sb.Append(",\"localPositionZ\":"), lp.z);
        TunerRectArr(sb, "localScale", sx, sy, sc.z);
        var p = t.parent;
        sb.Append(",\"frame\":{");
        var right = t.TransformVector(Vector3.right);
        var up = t.TransformVector(Vector3.up);
        TunerRectFrameOf(sb, t.position, ax > 1e-12f ? right / ax : right, ay > 1e-12f ? up / ay : up, t.TransformVector(Vector3.forward));
        sb.Append("},\"parent\":{\"rect\":[0,0,0,0]");
        if (p != null) TunerRectFrame(sb, p);
        else TunerRectFrameOf(sb, Vector3.zero, Vector3.right, Vector3.up, Vector3.forward);
        sb.Append("}}");
        return sb.ToString();
    }

    static string TunerRendererRectApply(TunerSession s, TunerRectArgs a, GameObject go, Bounds lb, TunerRectDrag group)
    {
        var t = go.transform;
        var sr = go.GetComponent<SpriteRenderer>();
        bool sized = sr != null && TunerRectRendererUsable(sr) && sr.drawMode != SpriteDrawMode.Simple;
        int i = TunerIndex(s, a.id);
        string key = TunerKeyOf(go, t);
        if (i >= 0)
        {
            if (!TunerInActive(s, i)) return "object '" + a.id + "' is not part of state " + s.States[s.Active].Name;
            var spec = s.Specs[i];
            bool tunable = TunerSpecAll(spec) ? !TunerFilterExcludes(spec.exclude, key) : TunerSpecFor(spec, go, t) != null;
            if (!tunable) return "the Transform of " + TunerSpecPath(spec) + " is not tunable";
        }
        TouchTunerMember(s, a.id);
        if (s.TracksStale) TunerTrackAll(s);
        var track = EnsureTunerTrack(s, a.id, key);
        var srTrack = sized ? EnsureTunerTrack(s, a.id, TunerKeyOf(go, sr)) : null;
        bool playing = EditorApplication.isPlaying;
        string label = string.IsNullOrEmpty(a.label) ? "Tuner rect " + go.name : a.label;
        var drag = group ?? TunerRectGroup(s, a.id, label);
        Undo.RecordObject(t, label);
        if (sized) Undo.RecordObject(sr, label);
        var sc = t.localScale;
        Vector2 v;
        if (TunerRectVec2(a.sizeDelta, out v))
        {
            if (sized)
            {
                TunerRectBeforeSet(s, srTrack, playing, "m_Size");
                float ax = Mathf.Abs(sc.x), ay = Mathf.Abs(sc.y);
                sr.size = new Vector2(ax > 1e-12f ? Mathf.Abs(v.x) / ax : sr.size.x, ay > 1e-12f ? Mathf.Abs(v.y) / ay : sr.size.y);
            }
            else
            {
                TunerRectBeforeSet(s, track, playing, "m_LocalScale");
                float nx = (sc.x < 0f ? -1f : 1f) * v.x / lb.size.x;
                float ny = (sc.y < 0f ? -1f : 1f) * v.y / lb.size.y;
                if (Mathf.Abs(nx) < 1e-6f) nx = nx < 0f ? -1e-6f : 1e-6f;
                if (Mathf.Abs(ny) < 1e-6f) ny = ny < 0f ? -1e-6f : 1e-6f;
                t.localScale = new Vector3(nx, ny, sc.z);
            }
        }
        var lp = t.localPosition;
        bool moved = false;
        if (TunerRectVec2(a.anchoredPosition, out v))
        {
            lp.x = v.x;
            lp.y = v.y;
            moved = true;
        }
        if (a.hasZ && !float.IsNaN(a.localPositionZ) && !float.IsInfinity(a.localPositionZ))
        {
            lp.z = a.localPositionZ;
            moved = true;
        }
        if (moved)
        {
            TunerRectBeforeSet(s, track, playing, "m_LocalPosition");
            t.localPosition = lp;
        }
        Quaternion q;
        if (ToQuat(a.localRotation, out q))
        {
            TunerRectBeforeSet(s, track, playing, "m_LocalRotation");
            t.localRotation = q;
        }
        MarkTunerSceneDirty(t);
        if (sized) MarkTunerSceneDirty(sr);
        if (track != null && track.Dirty) DiffTunerTrack(s, track);
        if (srTrack != null && srTrack.Dirty) DiffTunerTrack(s, srTrack);
        if (a.final && group == null)
        {
            EndTunerRectGroup(s, drag);
            Debug.Log("[Tuner] rect " + go.name + " pos " + TunerRectTuple(t.localPosition) + " scale " + TunerRectTuple(t.localScale)
                + (sized ? " size " + TunerRectTuple(sr.size) : "") + " rot " + t.localEulerAngles.z.ToString("0.##", Inv) + (playing ? "" : " (Edit Mode, with Undo)"));
        }
        s.Dirty = true;
        s.StatePending = true;
        return null;
    }
}
