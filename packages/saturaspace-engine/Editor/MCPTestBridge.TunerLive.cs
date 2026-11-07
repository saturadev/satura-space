using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const double TUNER_LIVE_IDLE_INTERVAL = 0.5;
    const float TUNER_RAY_EPSILON = 1e-4f;
    const int TUNER_WATCH_MAX = 64;
    const double TUNER_WATCH_INTERVAL = 0.1;
    static readonly Vector3 TunerShadowLight = new Vector3(-0.35f, -1f, -0.25f).normalized;

    static void TunerWatch(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        int i = string.IsNullOrEmpty(a.id) ? -1 : TunerIndex(s, a.id);
        var other = i < 0 && !string.IsNullOrEmpty(a.id) && a.id[0] != 'a' ? a.id : null;
        if (i != s.Watch || other != s.WatchEntry)
        {
            s.Watch = i;
            s.WatchEntry = other;
            s.LiveObject = null;
            s.ShadowKey = 0;
            s.ShadowState = -1;
            ClearTunerSerialized(s);
        }
        s.NextLive = 0;
        TunerResult(from, id, null, null);
    }

    static void ClearTunerSerialized(TunerSession s)
    {
        foreach (var so in s.Serialized.Values)
        {
            try { so.Dispose(); }
            catch { }
        }
        s.Serialized.Clear();
    }

    static bool TunerObjectBounds(TunerSession s, int oi, out Bounds bounds)
    {
        bounds = default;
        bool any = false;
        var idx = s.ObjRends != null && oi < s.ObjRends.Length ? s.ObjRends[oi] : null;
        if (idx == null) return false;
        for (int pass = 0; pass < 2 && !any; pass++)
            for (int k = 0; k < idx.Length; k++)
            {
                var e = s.Rends[idx[k]];
                if (!TunerRendAlive(e) || !TunerRendVisible(e)) continue;
                if (e.Kind != TunerKind.Graphic && (e.R == null || TunerFxRenderer(e.R) != (pass == 1))) continue;
                TunerRendBounds(e, ref bounds, ref any);
            }
        var go = s.Objects[oi];
        if (go != null && go.activeInHierarchy) TunerRectBounds(go.transform as RectTransform, ref bounds, ref any);
        return any;
    }

    static ulong TunerPoseHash(TunerSession s)
    {
        if (s.PoseNow == null || s.PoseNow.Length != s.Specs.Length)
        {
            s.PoseNow = new ulong[s.Specs.Length];
            s.PoseSent = new ulong[s.Specs.Length];
        }
        ulong all = 14695981039346656037UL;
        foreach (var oi in TunerActiveObjects(s))
        {
            var h = TunerObjectPoseHash(s, oi);
            s.PoseNow[oi] = h;
            all = TunerMix(TunerMix(all, (uint)h), (uint)(h >> 32));
        }
        return all;
    }

    static ulong TunerObjectPoseHash(TunerSession s, int oi)
    {
        ulong h = TunerMix(14695981039346656037UL, (uint)oi);
        var go = s.Objects[oi];
        if (go == null) return h;
        var t = go.transform;
        h = TunerMix(h, go.activeInHierarchy ? 1u : 0u);
        h = TunerMix(h, t.position);
        var q = t.rotation;
        h = TunerMix(h, q.x);
        h = TunerMix(h, q.y);
        h = TunerMix(h, q.z);
        h = TunerMix(h, q.w);
        h = TunerMix(h, t.localPosition);
        h = TunerMix(h, t.localScale);
        Bounds b;
        if (TunerObjectBounds(s, oi, out b))
        {
            h = TunerMix(h, b.center);
            h = TunerMix(h, b.size);
        }
        else h = TunerMix(h, 7u);
        return h;
    }

    static void StwPoses(TunerSession s)
    {
        StwRaw(",\"poses\":[");
        bool first = true;
        foreach (var oi in TunerActiveObjects(s))
        {
            var go = s.Objects[oi];
            if (s.PoseNow != null && oi < s.PoseNow.Length)
            {
                if (s.PoseSent[oi] == s.PoseNow[oi]) continue;
                s.PoseSent[oi] = s.PoseNow[oi];
            }
            if (go == null) continue;
            var t = go.transform;
            if (!first) StwChar(',');
            first = false;
            StwRaw("{\"id\":\"o");
            StwLong(oi);
            StwRaw("\",\"active\":");
            StwRaw(go.activeInHierarchy ? "true" : "false");
            StwRaw(",\"position\":");
            StwVec(t.position);
            StwRaw(",\"rotation\":");
            StwQuat(t.rotation);
            StwRaw(",\"localPosition\":");
            StwVec(t.localPosition);
            StwRaw(",\"localRotation\":");
            StwQuat(t.localRotation);
            StwRaw(",\"localScale\":");
            StwVec(t.localScale);
            Bounds b;
            if (TunerObjectBounds(s, oi, out b))
            {
                StwRaw(",\"bounds\":{\"center\":");
                StwVec(b.center);
                StwRaw(",\"size\":");
                StwVec(b.size);
                StwChar('}');
            }
            else StwRaw(",\"bounds\":null");
            StwChar('}');
        }
        StwChar(']');
    }

    static void PumpTunerLive(TunerSession s, double now, bool playing)
    {
        bool sampled = s.LiveSampleGen != _tunerAnimSampleGen;
        if (now < s.NextLive && !sampled) return;
        s.LiveSampleGen = _tunerAnimSampleGen;
        bool running = (playing && !EditorApplication.isPaused) || TunerAnimPlaying(s);
        double step = running ? TUNER_FRAME_INTERVAL : TUNER_LIVE_IDLE_INTERVAL;
        s.NextLive = now - s.NextLive > step ? now + step : s.NextLive + step;
        ulong poseHash = TunerPoseHash(s);
        bool poses = poseHash != s.LivePoseHash;
        string obj = null;
        int w = s.Watch;
        bool watched = w >= 0 && w < s.Objects.Length && s.Objects[w] != null && TunerInActive(s, w);
        if (watched)
        {
            var d = DescribeTunerObject(s, w);
            if (d != s.LiveObject) obj = d;
        }
        else if (s.WatchEntry != null)
        {
            var we = FindTunerEntry(s, s.WatchEntry);
            if (we != null && !we.Asset && we.Go != null)
            {
                var d = DescribeTunerEntry(s, s.WatchEntry);
                if (d != s.LiveObject) obj = d;
            }
        }
        bool shadow = UpdateTunerShadow(s, watched ? w : -1, now);
        string objs = null;
        if (now >= s.NextLiveObjects)
        {
            s.NextLiveObjects = now + TUNER_WATCH_INTERVAL;
            objs = TunerWatchedObjects(s);
            if (objs == s.LiveObjects) objs = null;
        }
        if (!poses && obj == null && !shadow && objs == null) return;
        s.LivePoseHash = poseHash;
        if (obj != null) s.LiveObject = obj;
        if (objs != null) s.LiveObjects = objs;
        StwReset();
        StwRaw("{\"type\":\"event\",\"event\":\"tuner/live\",\"session\":");
        StwRaw(s.NameJson);
        if (poses) StwPoses(s);
        if (obj != null)
        {
            StwRaw(",\"object\":");
            StwRaw(obj);
        }
        if (objs != null)
        {
            StwRaw(",\"objects\":");
            StwRaw(objs);
        }
        if (shadow)
        {
            if (s.ShadowState == 1)
            {
                StwRaw(",\"shadow\":{\"id\":\"o");
                StwLong(w);
                StwRaw("\",\"point\":");
                StwVec(s.ShadowPoint);
                StwRaw(",\"normal\":");
                StwVec(s.ShadowNormal);
                StwRaw(",\"surface\":\"");
                StwRaw(s.ShadowKind);
                StwRaw("\"}");
            }
            else StwRaw(",\"shadow\":null");
        }
        StwChar('}');
        StwSend(s.Client);
    }

    static bool UpdateTunerShadow(TunerSession s, int w, double now)
    {
        Bounds ignored;
        bool want = w >= 0 && s.Ortho <= 0f && s.Objects[w].activeInHierarchy && !TunerObjectBounds(s, w, out ignored);
        if (!want)
        {
            if (s.ShadowState == 0) return false;
            s.ShadowState = 0;
            s.ShadowKey = 0;
            return true;
        }
        var p = s.Objects[w].transform.position;
        ulong key = TunerMix(TunerMix(TunerGeometryHash(s, now), p), (uint)w);
        if (key == s.ShadowKey && s.ShadowState == 1) return false;
        s.ShadowKey = key;
        Vector3 point, normal;
        string kind;
        if (!RayTuner(s, p, TunerShadowLight, now, out point, out normal, out kind))
        {
            float t = Mathf.Abs(TunerShadowLight.y) > 1e-6f ? -p.y / TunerShadowLight.y : 0f;
            point = p + TunerShadowLight * t;
            point.y = 0f;
            normal = Vector3.up;
            kind = "ground";
        }
        bool same = s.ShadowState == 1 && s.ShadowKind == kind && (s.ShadowPoint - point).sqrMagnitude < 1e-10f
            && (s.ShadowNormal - normal).sqrMagnitude < 1e-10f;
        s.ShadowPoint = point;
        s.ShadowNormal = normal;
        s.ShadowKind = kind;
        s.ShadowState = 1;
        return !same;
    }

    static bool RayTuner(TunerSession s, Vector3 origin, Vector3 dir, double now, out Vector3 point, out Vector3 normal, out string kind)
    {
        point = default;
        normal = Vector3.up;
        kind = null;
        float best = float.MaxValue;
        var ray = new Ray(origin, dir);
        TunerGeometryHash(s, now);
        foreach (var e in s.Rends)
        {
            if (!e.Active || (e.Mesh == null && e.BakeR == null)) continue;
            var wb = e.R.bounds;
            float tb;
            if (!wb.IntersectRay(ray, out tb) || tb >= best) continue;
            if (e.Mesh == null)
            {
                TunerBoundsHit(wb, origin, dir, tb, ref best, ref point, ref normal, ref kind);
                continue;
            }
            Mesh mesh;
            Matrix4x4 l2w;
            if (e.Skin != null)
            {
                if (!e.Mesh.isReadable)
                {
                    TunerBoundsHit(wb, origin, dir, tb, ref best, ref point, ref normal, ref kind);
                    continue;
                }
                mesh = BakeTunerSkin(s, e, now);
                l2w = TunerBakedMatrix(e);
            }
            else
            {
                mesh = e.Mesh;
                l2w = e.T.localToWorldMatrix;
            }
            if (!mesh.isReadable)
            {
                TunerBoundsHit(wb, origin, dir, tb, ref best, ref point, ref normal, ref kind);
                continue;
            }
            LoadTunerTriangles(e, mesh, e.Skin != null);
            var w2l = l2w.inverse;
            var lo = w2l.MultiplyPoint3x4(origin);
            var ld = w2l.MultiplyVector(dir);
            var verts = e.Verts;
            var tris = e.Tris;
            int hitTri = -1;
            float hitT = best;
            for (int k = 0; k + 2 < tris.Count; k += 3)
            {
                float t;
                if (TunerRayTriangle(lo, ld, verts[tris[k]], verts[tris[k + 1]], verts[tris[k + 2]], out t) && t < hitT)
                {
                    hitT = t;
                    hitTri = k;
                }
            }
            if (hitTri < 0) continue;
            best = hitT;
            point = origin + dir * hitT;
            var a = verts[tris[hitTri]];
            var ln = Vector3.Cross(verts[tris[hitTri + 1]] - a, verts[tris[hitTri + 2]] - a);
            normal = w2l.transpose.MultiplyVector(ln).normalized;
            if (Vector3.Dot(normal, dir) > 0f) normal = -normal;
            kind = "mesh";
        }
        return kind != null;
    }

    static void TunerBoundsHit(Bounds b, Vector3 origin, Vector3 dir, float t, ref float best, ref Vector3 point, ref Vector3 normal, ref string kind)
    {
        if (t <= TUNER_RAY_EPSILON || t >= best) return;
        best = t;
        point = origin + dir * t;
        var rel = point - b.center;
        var ext = b.extents;
        float dx = Mathf.Abs(Mathf.Abs(rel.x) - ext.x), dy = Mathf.Abs(Mathf.Abs(rel.y) - ext.y), dz = Mathf.Abs(Mathf.Abs(rel.z) - ext.z);
        if (dy <= dx && dy <= dz) normal = new Vector3(0f, Mathf.Sign(rel.y), 0f);
        else if (dx <= dz) normal = new Vector3(Mathf.Sign(rel.x), 0f, 0f);
        else normal = new Vector3(0f, 0f, Mathf.Sign(rel.z));
        kind = "bounds";
    }

    static void LoadTunerTriangles(TunerRend e, Mesh mesh, bool skinned)
    {
        if (e.Verts == null) e.Verts = new List<Vector3>();
        if (e.Tris == null) e.Tris = new List<int>();
        if (skinned || !ReferenceEquals(e.TrisFor, mesh)) mesh.GetVertices(e.Verts);
        if (ReferenceEquals(e.TrisFor, mesh) && e.Tris.Count > 0) return;
        e.Tris.Clear();
        for (int sub = 0; sub < mesh.subMeshCount; sub++)
        {
            if (mesh.GetTopology(sub) != MeshTopology.Triangles) continue;
            mesh.GetTriangles(_tunerIdxTmp, sub);
            e.Tris.AddRange(_tunerIdxTmp);
        }
        _tunerIdxTmp.Clear();
        e.TrisFor = mesh;
    }

    static bool TunerRayTriangle(Vector3 o, Vector3 d, Vector3 a, Vector3 b, Vector3 c, out float t)
    {
        t = 0f;
        var e1 = b - a;
        var e2 = c - a;
        var p = Vector3.Cross(d, e2);
        float det = Vector3.Dot(e1, p);
        if (det > -1e-12f && det < 1e-12f) return false;
        float inv = 1f / det;
        var s = o - a;
        float u = Vector3.Dot(s, p) * inv;
        if (u < 0f || u > 1f) return false;
        var q = Vector3.Cross(s, e1);
        float v = Vector3.Dot(d, q) * inv;
        if (v < 0f || u + v > 1f) return false;
        t = Vector3.Dot(e2, q) * inv;
        return t > TUNER_RAY_EPSILON;
    }

    static string TunerWatchedObjects(TunerSession s)
    {
        if (s.WatchIds == null || s.WatchIds.Length == 0) return "[]";
        var sb = new System.Text.StringBuilder(1024);
        sb.Append('[');
        int n = 0;
        foreach (var wid in s.WatchIds)
        {
            if (n >= TUNER_WATCH_MAX) break;
            if (string.IsNullOrEmpty(wid) || wid[0] == 'o' || wid[0] == 'a') continue;
            var we = FindTunerEntry(s, wid);
            if (we == null || we.Asset || we.Go == null) continue;
            if (n > 0) sb.Append(',');
            sb.Append(DescribeTunerEntry(s, wid));
            n++;
        }
        sb.Append(']');
        return sb.ToString();
    }

    const int TUNER_ICONS_MAX = 512;

    static bool TunerIconOn(Type t)
    {
        return TunerGizmoInfoOf(t, EditorApplication.timeSinceStartup).Icon;
    }

    static string TunerIconKind(GameObject go)
    {
        var l = go.GetComponent<Light>();
        if (l != null && l.enabled && TunerIconOn(typeof(Light))) return l.type == LightType.Directional ? "light-dir" : l.type == LightType.Spot ? "light-spot" : l.type == LightType.Point ? "light-point" : "light-area";
        var c = go.GetComponent<Camera>();
        if (c != null && c.enabled && TunerIconOn(typeof(Camera))) return "camera";
        var a = go.GetComponent<AudioSource>();
        if (a != null && a.enabled && TunerIconOn(typeof(AudioSource))) return "audio";
        var p = go.GetComponent<ReflectionProbe>();
        if (p != null && p.enabled && TunerIconOn(typeof(ReflectionProbe))) return "probe";
        if (go.GetComponent<ParticleSystem>() != null && TunerIconOn(typeof(ParticleSystem)) && (go.transform.parent == null || go.transform.parent.GetComponentInParent<ParticleSystem>(true) == null)) return "particles";
        return null;
    }

    const double TUNER_ICONS_REFRESH = 5.0;
    static readonly HashSet<GameObject> _tunerIconSeen = new HashSet<GameObject>();
    static readonly List<KeyValuePair<int, TunerEntry>> _tunerIconFound = new List<KeyValuePair<int, TunerEntry>>();
    static readonly Type[] TunerIconTypes = { typeof(Light), typeof(Camera), typeof(AudioSource), typeof(ReflectionProbe), typeof(ParticleSystem) };

    static void NoteTunerIcon(TunerSession s, Component c)
    {
        if (c == null) return;
        var go = c.gameObject;
        TunerEntry m;
        if (!_tunerIconSeen.Add(go) || !s.MemberByGo.TryGetValue(go, out m) || m.Gen != s.WalkGen || m.Env) return;
        if ((go.hideFlags & HideFlags.HideInHierarchy) != 0) return;
        _tunerIconFound.Add(new KeyValuePair<int, TunerEntry>(m.Idx, m));
    }

    static void CollectTunerIcons(TunerSession s)
    {
        s.IconList.Clear();
        _tunerIconSeen.Clear();
        _tunerIconFound.Clear();
        if (s.Scene)
        {
            foreach (var type in TunerIconTypes)
                foreach (var o in UnityEngine.Object.FindObjectsByType(type, FindObjectsInactive.Include, FindObjectsSortMode.None))
                    NoteTunerIcon(s, o as Component);
        }
        else
        {
            var roots = new List<GameObject>();
            foreach (var oi in TunerActiveObjects(s))
                if (oi < s.Objects.Length && s.Objects[oi] != null && s.Specs[oi].children) roots.Add(s.Objects[oi]);
            roots.AddRange(TunerSceneRoots(s));
            foreach (var type in TunerIconTypes)
                foreach (var root in roots)
                    foreach (var c in root.GetComponentsInChildren(type, true)) NoteTunerIcon(s, c);
        }
        _tunerIconSeen.Clear();
        _tunerIconFound.Sort((a, b) => a.Key.CompareTo(b.Key));
        foreach (var kv in _tunerIconFound)
        {
            if (s.IconList.Count >= TUNER_ICONS_MAX) break;
            var kind = TunerIconKind(kv.Value.Go);
            if (kind != null) s.IconList.Add(new KeyValuePair<TunerEntry, string>(kv.Value, kind));
        }
        _tunerIconFound.Clear();
    }

    static bool TunerIconListStale(TunerSession s, double now)
    {
        return s.IconsGen != _tunerHierarchyGen || s.IconsWalk != s.WalkGen || now - s.IconsListAt > TUNER_ICONS_REFRESH;
    }

    static bool RefreshTunerIconList(TunerSession s, double now)
    {
        if (!TunerIconListStale(s, now)) return false;
        s.IconsGen = _tunerHierarchyGen;
        s.IconsWalk = s.WalkGen;
        s.IconsListAt = now;
        long iconsAt = TpNow();
        CollectTunerIcons(s);
        TpAdd(TP_ICONS, iconsAt);
        return true;
    }

    static string TunerFrameIcons(TunerSession s, double now)
    {
        var v = TunerViewOf(s, false);
        RefreshTunerIconList(s, now);
        bool on = v == null || !v.GizmosOff;
        ulong h = 1469598103934665603UL;
        if (on)
        {
            foreach (var kv in s.IconList)
            {
                var go = kv.Key.Go;
                if (go == null || !go.activeInHierarchy || TunerVisHidden(go)) continue;
                var p = go.transform.position;
                h = TunerMixString(h, kv.Key.Id);
                h = TunerMixString(h, kv.Value);
                h = TunerMix(h, (uint)BitConverter.SingleToInt32Bits(p.x));
                h = TunerMix(h, (uint)BitConverter.SingleToInt32Bits(p.y));
                h = TunerMix(h, (uint)BitConverter.SingleToInt32Bits(p.z));
            }
        }
        if (h == s.IconsSig && now - s.IconsSentAt < 2.0) return null;
        s.IconsSig = h;
        s.IconsSentAt = now;
        var sb = new System.Text.StringBuilder(256);
        sb.Append('[');
        int n = 0;
        if (on)
        {
            foreach (var kv in s.IconList)
            {
                var m = kv.Key;
                var go = m.Go;
                if (go == null || !go.activeInHierarchy || TunerVisHidden(go)) continue;
                var p = go.transform.position;
                if (n++ > 0) sb.Append(',');
                sb.Append("[").Append(JStr(m.Id)).Append(',').Append(JStr(kv.Value)).Append(',')
                    .Append(p.x.ToString("R", Inv)).Append(',').Append(p.y.ToString("R", Inv)).Append(',').Append(p.z.ToString("R", Inv)).Append(']');
            }
        }
        sb.Append(']');
        return sb.ToString();
    }

    static string TunerFramePoses(TunerSession s)
    {
        var sb = new System.Text.StringBuilder(512);
        sb.Append('[');
        int n = 0;
        if (s.FramePoseSent == null || s.FramePoseSent.Length != s.Objects.Length) s.FramePoseSent = new ulong[s.Objects.Length];
        foreach (var oi in TunerActiveObjects(s))
        {
            if (oi < 0 || oi >= s.Objects.Length) continue;
            var go = s.Objects[oi];
            if (go == null) continue;
            var h = TunerObjectPoseHash(s, oi);
            if (h == s.FramePoseSent[oi] && oi != s.Watch) continue;
            s.FramePoseSent[oi] = h;
            Bounds b;
            bool hasBounds = TunerObjectBounds(s, oi, out b);
            AppendTunerFramePose(sb, ref n, "o" + oi.ToString(Inv), go, hasBounds, b);
        }
        if (s.WatchEntry != null) AppendTunerEntryFramePose(s, sb, ref n, s.WatchEntry);
        if (s.WatchIds != null)
        {
            int k = 0;
            foreach (var wid in s.WatchIds)
            {
                if (k++ >= TUNER_WATCH_MAX) break;
                if (string.IsNullOrEmpty(wid) || wid[0] == 'o' || wid[0] == 'a' || wid == s.WatchEntry) continue;
                AppendTunerEntryFramePose(s, sb, ref n, wid);
            }
        }
        sb.Append(']');
        return n == 0 ? null : sb.ToString();
    }

    static void AppendTunerEntryFramePose(TunerSession s, System.Text.StringBuilder sb, ref int n, string id)
    {
        var e = FindTunerEntry(s, id);
        if (e == null || e.Asset || e.Go == null) return;
        Bounds b = default;
        bool hasBounds = e.Member && TunerBounds(e.Go, out b);
        AppendTunerFramePose(sb, ref n, e.Id, e.Go, hasBounds, b);
    }

    static void AppendTunerFramePose(System.Text.StringBuilder sb, ref int n, string id, GameObject go, bool hasBounds, Bounds b)
    {
        var t = go.transform;
        if (n++ > 0) sb.Append(',');
        sb.Append("{\"id\":").Append(JStr(id)).Append(",\"active\":").Append(go.activeInHierarchy ? "true" : "false");
        AppendTunerVec(sb, "position", t.position);
        AppendTunerQuat(sb, "rotation", t.rotation);
        AppendTunerVec(sb, "localPosition", t.localPosition);
        AppendTunerQuat(sb, "localRotation", t.localRotation);
        AppendTunerVec(sb, "localScale", t.localScale);
        if (hasBounds)
        {
            sb.Append(",\"bounds\":{\"center\":");
            AppendTunerArray(sb, b.center.x, b.center.y, b.center.z);
            sb.Append(",\"size\":");
            AppendTunerArray(sb, b.size.x, b.size.y, b.size.z);
            sb.Append('}');
        }
        else sb.Append(",\"bounds\":null");
        sb.Append('}');
    }
}
