using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.UI;

public static partial class MCPTestBridge
{
    const int TUNER_PICK_MAX = 32;
    const int TUNER_PICK_ICON_SIZE = 32;

    struct TunerPickHit
    {
        public GameObject Go;
        public Component Source;
        public string Kind;
        public Canvas UiRoot;
    }

    static readonly List<TunerDraw> _tunerPickSorted = new List<TunerDraw>();
    static readonly HashSet<GameObject> _tunerPickIgnore = new HashSet<GameObject>();
    static readonly Dictionary<Type, string> _tunerPickIcons = new Dictionary<Type, string>();
    static CommandBuffer _tunerPickCmd;
    static MethodInfo _tunerSelectionBase;
    static bool _tunerSelectionBaseKnown;

    static void TunerViewMatricesFor(Vector3 pos, Quaternion rot, float fov, float ortho, int w, int h, float near, float far, bool orthoClip, out Matrix4x4 view, out Matrix4x4 proj)
    {
        view = Matrix4x4.Scale(new Vector3(1f, 1f, -1f)) * Matrix4x4.Inverse(Matrix4x4.TRS(pos, rot, Vector3.one));
        proj = TunerProjection(fov, ortho, (float)w / h, near, far, orthoClip);
    }

    static Vector4 TunerPickColor(int id)
    {
        return new Vector4((id & 255) / 255f, ((id >> 8) & 255) / 255f, ((id >> 16) & 255) / 255f, 1f);
    }

    static string TunerPickKind(TunerRend e)
    {
        switch (e.Kind)
        {
            case TunerKind.Sprite: return "sprite";
            case TunerKind.Tilemap: return "tilemap";
            case TunerKind.Graphic: return e.Tmp != null || e.TmpSub != null || e.G is Text ? "text" : "ui";
            default: return e.Skin != null ? "skinned" : e.R != null && e.R.GetComponent<TMPro.TMP_Text>() != null ? "text" : "mesh";
        }
    }

    static Component TunerPickSource(TunerRend e)
    {
        if (e.Kind == TunerKind.Graphic) return e.G;
        return e.R;
    }

    static void TunerPick(int id, TunerSession s, TunerViewArgs a, ControlClient from)
    {
        if (!TunerGraphics)
        {
            TunerResult(from, id, "the editor runs without graphics", null);
            return;
        }
        if (a.x < 0f || a.x > 1f || a.y < 0f || a.y > 1f)
        {
            TunerResult(from, id, "x and y must be between 0 and 1", null);
            return;
        }
        var mat = TunerViewMaterial();
        if (mat == null)
        {
            TunerResult(from, id, "the scene view shader is unavailable", null);
            return;
        }
        var v = TunerViewOf(s, true);
        double now = EditorApplication.timeSinceStartup;
        int w = a.width > 0 ? a.width : s.Width;
        int h = a.height > 0 ? a.height : s.Height;
        Vector3 pos;
        Quaternion rot;
        if (!ToVec3(a.position, out pos)) pos = s.CamPos;
        if (!ToQuat(a.rotation, out rot)) rot = s.CamRot;
        float fov = a.fov > 0.1f && a.fov < 179f ? a.fov : s.Fov;
        float ortho = a.position != null ? (a.ortho > 0f ? a.ortho : 0f) : s.Ortho;
        Matrix4x4 view, proj;
        float near = a.near > 0f && a.far > a.near ? a.near : s.Near;
        float far = a.near > 0f && a.far > a.near ? a.far : s.Far;
        bool orthoClip = a.position != null ? a.near > 0f && a.far > a.near : s.OrthoClip;
        TunerViewMatricesFor(pos, rot, fov, ortho, w, h, near, far, orthoClip, out view, out proj);
        float px = a.x * w, py = (1f - a.y) * h;
        var hits = new List<TunerPickHit>();
        PickTunerDraws(s, v, mat, view, proj, w, h, px, py, pos, rot, hits, now);
        PickTunerUi(s, view, proj, w, h, px, py, pos, hits);
        var sb = new StringBuilder(1024);
        var names = new StringBuilder(256);
        sb.Append("\"hits\":[");
        var iconTypes = new List<Type>();
        for (int i = 0; i < hits.Count; i++)
        {
            var hit = hits[i];
            if (i > 0)
            {
                sb.Append(',');
                names.Append(" > ");
            }
            names.Append(hit.Go.name);
            var path = TunerGameObjectPath(hit.Go);
            var baseGo = TunerSelectionBase(hit.Go);
            if (!s.Scene && baseGo != null) baseGo = TunerFilteredBase(s, hit.Go, baseGo);
            var iconType = hit.Source != null ? hit.Source.GetType() : typeof(GameObject);
            if (!iconTypes.Contains(iconType)) iconTypes.Add(iconType);
            sb.Append("{\"path\":").Append(JStr(path))
              .Append(",\"scene\":").Append(JStr(TunerSceneKey(hit.Go.scene) ?? ""))
              .Append(",\"name\":").Append(JStr(hit.Go.name))
              .Append(",\"target\":").Append(TunerJsonOrNull(TunerTargetOf(s, hit.Go, true)))
              .Append(",\"owner\":").Append(TunerJsonOrNull(TunerTargetOf(s, hit.Go, false)))
              .Append(",\"kind\":").Append(JStr(hit.Kind))
              .Append(",\"icon\":").Append(JStr(iconType.Name))
              .Append(",\"base\":");
            if (baseGo != null && baseGo != hit.Go)
                sb.Append("{\"path\":").Append(JStr(TunerGameObjectPath(baseGo)))
                  .Append(",\"scene\":").Append(JStr(TunerSceneKey(baseGo.scene) ?? ""))
                  .Append(",\"name\":").Append(JStr(baseGo.name))
                  .Append(",\"target\":").Append(TunerJsonOrNull(TunerTargetOf(s, baseGo, true)))
                  .Append(",\"owner\":").Append(TunerJsonOrNull(TunerTargetOf(s, baseGo, false)))
                  .Append('}');
            else sb.Append("null");
            sb.Append('}');
        }
        sb.Append("],\"icons\":{");
        bool first = true;
        foreach (var t in iconTypes)
        {
            var png = TunerIconPng(t, hits);
            if (png == null) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append(JStr(t.Name)).Append(':').Append(JStr(png));
        }
        sb.Append('}');
        SaturaDebug.Log("[Tuner] " + s.Name + " pick " + a.x.ToString("0.###", Inv) + "," + a.y.ToString("0.###", Inv) + ": "
            + (hits.Count == 0 ? "nothing" : names.ToString()));
        TunerResult(from, id, null, sb.ToString());
    }

    static string TunerJsonOrNull(string s)
    {
        return s == null ? "null" : JStr(s);
    }

    static GameObject TunerFilteredBase(TunerSession s, GameObject hit, GameObject baseGo)
    {
        var ownerId = TunerTargetOf(s, hit, false);
        var owner = ownerId != null ? TunerEntryObject(s, ownerId) : null;
        if (owner == null || owner == baseGo || !owner.transform.IsChildOf(baseGo.transform)) return baseGo;
        return owner;
    }

    static GameObject TunerSelectionBase(GameObject go)
    {
        if (!_tunerSelectionBaseKnown)
        {
            _tunerSelectionBaseKnown = true;
            _tunerSelectionBase = typeof(HandleUtility).GetMethod("FindSelectionBaseForPicking",
                BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public, null, new[] { typeof(GameObject) }, null);
        }
        if (_tunerSelectionBase == null) return null;
        try { return _tunerSelectionBase.Invoke(null, new object[] { go }) as GameObject; }
        catch { return null; }
    }

    static int TunerCenterId(TunerSession s, TunerViewState v, Material mat, Matrix4x4 view, Matrix4x4 pickProj, HashSet<GameObject> subject, bool all, double now)
    {
        var cmd = _tunerPickCmd ?? (_tunerPickCmd = new CommandBuffer { name = "SaturaTunerPick" });
        cmd.Clear();
        cmd.SetRenderTarget(v.Pick);
        cmd.ClearRenderTarget(true, true, Color.clear);
        cmd.SetViewProjectionMatrices(view, pickProj);
        for (int k = 0; k < s.Draws.Count; k++)
        {
            var d = s.Draws[k];
            if (!TunerDrawReady(d) || d.Rend.Go == null || d.Transparent) continue;
            bool mine = subject.Contains(d.Rend.Go);
            if (!mine && !all) continue;
            cmd.SetGlobalVector(TunerPickIdId, TunerPickColor(mine ? 1 : 2));
            cmd.SetGlobalFloat(TunerClipId, TunerCoverageClip(d));
            RecordTunerDraw(s, cmd, d, mat, TUNER_PASS_PICK_OPAQUE, now);
        }
        var prev = RenderTexture.active;
        Graphics.ExecuteCommandBuffer(cmd);
        RenderTexture.active = v.Pick;
        v.PickRead.ReadPixels(new Rect(0, 0, 1, 1), 0, 0, false);
        RenderTexture.active = prev;
        var c = v.PickRead.GetPixels32()[0];
        return c.a == 0 ? 0 : (c.r | (c.g << 8) | (c.b << 16));
    }

    static void TunerClearView(int id, TunerSession s, TunerViewArgs a, ControlClient from)
    {
        var v = TunerViewOf(s, true);
        var mat = TunerViewMaterial();
        var go = string.IsNullOrEmpty(a.id) ? null : TunerEntryObject(s, a.id);
        var cams = a.cams;
        if (mat == null || go == null || cams == null || cams.Length < 9)
        {
            TunerResult(from, id, null, "\"index\":-1");
            return;
        }
        double now = EditorApplication.timeSinceStartup;
        int w = a.width > 0 ? a.width : s.Width;
        int h = a.height > 0 ? a.height : s.Height;
        float fov = a.fov > 0.1f && a.fov < 179f ? a.fov : s.Fov;
        float px = (a.x >= 0f ? a.x : 0.5f) * w, py = (1f - (a.y >= 0f ? a.y : 0.5f)) * h;
        var subject = new HashSet<GameObject>();
        go.GetComponentsInChildren(true, _tunerViewTrTmp);
        foreach (var t in _tunerViewTrTmp) subject.Add(t.gameObject);
        _tunerViewTrTmp.Clear();
        int found = -1, tried = 0;
        if (EnsureTunerViewTexture(ref v.Pick, 1, 1, RenderTextureFormat.ARGB32, 24) != null)
        {
            if (v.PickRead == null) v.PickRead = new Texture2D(1, 1, TextureFormat.RGBA32, false, true) { hideFlags = HideFlags.HideAndDontSave };
            float cx = px / w * 2f - 1f, cy = py / h * 2f - 1f;
            var zoom = Matrix4x4.identity;
            zoom.m00 = w;
            zoom.m03 = -cx * w;
            zoom.m11 = h;
            zoom.m13 = -cy * h;
            for (int i = 0; i + 9 <= cams.Length; i += 9)
            {
                tried++;
                var pos = new Vector3(cams[i], cams[i + 1], cams[i + 2]);
                var rot = new Quaternion(cams[i + 3], cams[i + 4], cams[i + 5], cams[i + 6]);
                float near = cams[i + 7] > 0f ? cams[i + 7] : s.Near, far = cams[i + 8] > near ? cams[i + 8] : s.Far;
                Matrix4x4 view, proj;
                TunerViewMatricesFor(pos, rot, fov, 0f, w, h, near, far, false, out view, out proj);
                var pickProj = zoom * proj;
                UpdateTunerLods(s, now, pos, fov, 0f);
                if (TunerCenterId(s, v, mat, view, pickProj, subject, false, now) != 1 || TunerCenterId(s, v, mat, view, pickProj, subject, true, now) == 1)
                {
                    found = i / 9;
                    break;
                }
            }
        }
        UpdateTunerLods(s, now);
        TunerResult(from, id, null, "\"index\":" + found.ToString(Inv) + ",\"tried\":" + tried.ToString(Inv));
    }

    static void PickTunerDraws(TunerSession s, TunerViewState v, Material mat, Matrix4x4 view, Matrix4x4 proj, int w, int h, float px, float py,
        Vector3 camPos, Quaternion camRot, List<TunerPickHit> hits, double now)
    {
        var ignore = _tunerPickIgnore;
        try
        {
            if (EnsureTunerViewTexture(ref v.Pick, 1, 1, RenderTextureFormat.ARGB32, 24) == null) return;
            if (v.PickRead == null) v.PickRead = new Texture2D(1, 1, TextureFormat.RGBA32, false, true) { hideFlags = HideFlags.HideAndDontSave };
            float cx = px / w * 2f - 1f, cy = py / h * 2f - 1f;
            var zoom = Matrix4x4.identity;
            zoom.m00 = w;
            zoom.m03 = -cx * w;
            zoom.m11 = h;
            zoom.m13 = -cy * h;
            var pickProj = zoom * proj;
            var fwd = camRot * Vector3.forward;
            foreach (var e in s.Rends)
                if (e.Active) TunerSortKeys(e, camPos, fwd);
            var cmd = _tunerPickCmd ?? (_tunerPickCmd = new CommandBuffer { name = "SaturaTunerPick" });
            for (int iter = 0; iter < TUNER_PICK_MAX; iter++)
            {
                cmd.Clear();
                cmd.SetRenderTarget(v.Pick);
                cmd.ClearRenderTarget(true, true, Color.clear);
                cmd.SetViewProjectionMatrices(view, pickProj);
                var sorted = _tunerPickSorted;
                sorted.Clear();
                int drawn = 0;
                for (int k = 0; k < s.Draws.Count; k++)
                {
                    var d = s.Draws[k];
                    if (!TunerDrawReady(d) || d.Rend.Go == null || ignore.Contains(d.Rend.Go) || TunerVisHidden(d.Rend.Go) || TunerCulledFar(v, d.Rend.R)) continue;
                    d.Index = k;
                    if (d.Transparent)
                    {
                        sorted.Add(d);
                        continue;
                    }
                    cmd.SetGlobalVector(TunerPickIdId, TunerPickColor(k + 1));
                    cmd.SetGlobalFloat(TunerClipId, TunerCoverageClip(d));
                    RecordTunerDraw(s, cmd, d, mat, TUNER_PASS_PICK_OPAQUE, now);
                    drawn++;
                }
                sorted.Sort(TunerDrawOrder);
                foreach (var d in sorted)
                {
                    cmd.SetGlobalVector(TunerPickIdId, TunerPickColor(d.Index + 1));
                    cmd.SetGlobalFloat(TunerClipId, TunerCoverageClip(d));
                    RecordTunerDraw(s, cmd, d, mat, TUNER_PASS_PICK_TRANSPARENT, now);
                    drawn++;
                }
                sorted.Clear();
                if (drawn == 0) break;
                var prev = RenderTexture.active;
                Graphics.ExecuteCommandBuffer(cmd);
                RenderTexture.active = v.Pick;
                v.PickRead.ReadPixels(new Rect(0, 0, 1, 1), 0, 0, false);
                RenderTexture.active = prev;
                var c = v.PickRead.GetPixels32()[0];
                int idx = (c.r | (c.g << 8) | (c.b << 16)) - 1;
                if (c.a == 0 || idx < 0 || idx >= s.Draws.Count) break;
                var hitDraw = s.Draws[idx];
                var go = hitDraw.Rend.Go;
                if (go == null || !ignore.Add(go)) break;
                hits.Add(new TunerPickHit { Go = go, Source = TunerPickSource(hitDraw.Rend), Kind = TunerPickKind(hitDraw.Rend) });
            }
        }
        finally
        {
            ignore.Clear();
            _tunerPickSorted.Clear();
        }
    }

    static string TunerIconPng(Type t, List<TunerPickHit> hits)
    {
        string png;
        if (_tunerPickIcons.TryGetValue(t, out png)) return png;
        png = null;
        Component sample = null;
        foreach (var hit in hits)
            if (hit.Source != null && hit.Source.GetType() == t)
            {
                sample = hit.Source;
                break;
            }
        Texture tex = null;
        try { tex = EditorGUIUtility.ObjectContent(sample, t).image; }
        catch { }
        if (tex != null)
        {
            RenderTexture rt = null;
            Texture2D read = null;
            var prev = RenderTexture.active;
            try
            {
                rt = RenderTexture.GetTemporary(TUNER_PICK_ICON_SIZE, TUNER_PICK_ICON_SIZE, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
                RenderTexture.active = rt;
                GL.Clear(false, true, Color.clear);
                Graphics.Blit(tex, rt);
                RenderTexture.active = rt;
                read = new Texture2D(TUNER_PICK_ICON_SIZE, TUNER_PICK_ICON_SIZE, TextureFormat.RGBA32, false);
                read.ReadPixels(new Rect(0, 0, TUNER_PICK_ICON_SIZE, TUNER_PICK_ICON_SIZE), 0, 0, false);
                read.Apply(false);
                png = "data:image/png;base64," + Convert.ToBase64String(read.EncodeToPNG());
            }
            catch { png = null; }
            finally
            {
                RenderTexture.active = prev;
                if (rt != null) RenderTexture.ReleaseTemporary(rt);
                if (read != null) UnityEngine.Object.DestroyImmediate(read);
            }
        }
        _tunerPickIcons[t] = png;
        return png;
    }

    const int TUNER_PICK_AREA_MAX = 256;
    static readonly List<int> _tunerAreaHits = new List<int>();

    static void TunerPickRect(int id, TunerSession s, TunerViewArgs a, ControlClient from)
    {
        if (!TunerGraphics)
        {
            TunerResult(from, id, "the editor runs without graphics", null);
            return;
        }
        if (a.x < 0f || a.x > 1f || a.y < 0f || a.y > 1f || a.x1 < 0f || a.x1 > 1f || a.y1 < 0f || a.y1 > 1f)
        {
            TunerResult(from, id, "the rect must lie between 0 and 1", null);
            return;
        }
        var mat = TunerViewMaterial();
        if (mat == null)
        {
            TunerResult(from, id, "the scene view shader is unavailable", null);
            return;
        }
        var v = TunerViewOf(s, true);
        double now = EditorApplication.timeSinceStartup;
        int w = a.width > 0 ? a.width : s.Width;
        int h = a.height > 0 ? a.height : s.Height;
        Vector3 pos;
        Quaternion rot;
        if (!ToVec3(a.position, out pos)) pos = s.CamPos;
        if (!ToQuat(a.rotation, out rot)) rot = s.CamRot;
        float fov = a.fov > 0.1f && a.fov < 179f ? a.fov : s.Fov;
        float ortho = a.position != null ? (a.ortho > 0f ? a.ortho : 0f) : s.Ortho;
        Matrix4x4 view, proj;
        float near = a.near > 0f && a.far > a.near ? a.near : s.Near;
        float far = a.near > 0f && a.far > a.near ? a.far : s.Far;
        bool orthoClip = a.position != null ? a.near > 0f && a.far > a.near : s.OrthoClip;
        TunerViewMatricesFor(pos, rot, fov, ortho, w, h, near, far, orthoClip, out view, out proj);
        float x0 = Mathf.Min(a.x, a.x1), x1 = Mathf.Max(a.x, a.x1);
        float y0 = 1f - Mathf.Max(a.y, a.y1), y1 = 1f - Mathf.Min(a.y, a.y1);
        var ids = new List<string>();
        var gos = new List<GameObject>();
        if ((x1 - x0) * w >= 1f && (y1 - y0) * h >= 1f)
            PickTunerArea(s, v, mat, view, proj, w, h, x0, y0, x1, y1, pos, rot, gos, now);
        var names = new StringBuilder(256);
        foreach (var go in gos)
        {
            var pid = TunerPickAreaId(s, go);
            if (pid == null || ids.Contains(pid)) continue;
            ids.Add(pid);
            if (names.Length > 0) names.Append(", ");
            names.Append(TunerEntryPath(s, pid));
        }
        var sb = new StringBuilder(256);
        sb.Append("\"ids\":[");
        for (int i = 0; i < ids.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(JStr(ids[i]));
        }
        sb.Append(']');
        SaturaDebug.Log("[Tuner] " + s.Name + " rect pick " + x0.ToString("0.###", Inv) + "," + (1f - y1).ToString("0.###", Inv) + " to "
            + x1.ToString("0.###", Inv) + "," + (1f - y0).ToString("0.###", Inv) + ": " + (ids.Count == 0 ? "nothing" : names.ToString()));
        TunerResult(from, id, null, sb.ToString());
    }

    static string TunerExactId(TunerSession s, GameObject go)
    {
        var t = TunerTargetOf(s, go, true);
        if (t != null) return t;
        foreach (var e in s.Entries)
            if (!e.Asset && e.Go == go) return e.Id;
        return null;
    }

    static string TunerPickAreaId(TunerSession s, GameObject go)
    {
        var b = TunerSelectionBase(go);
        if (b != null && b != go)
        {
            var bid = TunerExactId(s, b);
            if (bid != null) return bid;
        }
        for (var t = go.transform; t != null; t = t.parent)
        {
            var hit = TunerExactId(s, t.gameObject);
            if (hit != null) return hit;
        }
        return null;
    }

    static void PickTunerArea(TunerSession s, TunerViewState v, Material mat, Matrix4x4 view, Matrix4x4 proj, int w, int h,
        float x0, float y0, float x1, float y1, Vector3 camPos, Quaternion camRot, List<GameObject> gos, double now)
    {
        float pw = (x1 - x0) * w, ph = (y1 - y0) * h;
        float scale = Mathf.Min(1f, TUNER_PICK_AREA_MAX / Mathf.Max(pw, ph));
        int tw = Mathf.Max(1, Mathf.RoundToInt(pw * scale)), th = Mathf.Max(1, Mathf.RoundToInt(ph * scale));
        if (v.PickArea != null && (v.PickArea.width != tw || v.PickArea.height != th)) ReleaseTunerTexture(ref v.PickArea);
        if (EnsureTunerViewTexture(ref v.PickArea, tw, th, RenderTextureFormat.ARGB32, 24) == null) return;
        if (v.PickAreaRead == null || v.PickAreaRead.width != tw || v.PickAreaRead.height != th)
        {
            if (v.PickAreaRead != null) UnityEngine.Object.DestroyImmediate(v.PickAreaRead);
            v.PickAreaRead = new Texture2D(tw, th, TextureFormat.RGBA32, false, true) { hideFlags = HideFlags.HideAndDontSave };
        }
        float ax = x0 * 2f - 1f, bx = x1 * 2f - 1f, ay = y0 * 2f - 1f, by = y1 * 2f - 1f;
        var zoom = Matrix4x4.identity;
        zoom.m00 = 2f / (bx - ax);
        zoom.m03 = -(ax + bx) / (bx - ax);
        zoom.m11 = 2f / (by - ay);
        zoom.m13 = -(ay + by) / (by - ay);
        var fwd = camRot * Vector3.forward;
        foreach (var e in s.Rends)
            if (e.Active) TunerSortKeys(e, camPos, fwd);
        var cmd = _tunerPickCmd ?? (_tunerPickCmd = new CommandBuffer { name = "SaturaTunerPick" });
        var sorted = _tunerPickSorted;
        try
        {
            cmd.Clear();
            cmd.SetRenderTarget(v.PickArea);
            cmd.ClearRenderTarget(true, true, Color.clear);
            cmd.SetViewProjectionMatrices(view, zoom * proj);
            sorted.Clear();
            int drawn = 0;
            for (int k = 0; k < s.Draws.Count; k++)
            {
                var d = s.Draws[k];
                if (!TunerDrawReady(d) || d.Rend.Go == null || TunerCulledFar(v, d.Rend.R)) continue;
                d.Index = k;
                if (d.Transparent)
                {
                    sorted.Add(d);
                    continue;
                }
                cmd.SetGlobalVector(TunerPickIdId, TunerPickColor(k + 1));
                cmd.SetGlobalFloat(TunerClipId, TunerCoverageClip(d));
                RecordTunerDraw(s, cmd, d, mat, TUNER_PASS_PICK_OPAQUE, now);
                drawn++;
            }
            sorted.Sort(TunerDrawOrder);
            foreach (var d in sorted)
            {
                cmd.SetGlobalVector(TunerPickIdId, TunerPickColor(d.Index + 1));
                cmd.SetGlobalFloat(TunerClipId, TunerCoverageClip(d));
                RecordTunerDraw(s, cmd, d, mat, TUNER_PASS_PICK_TRANSPARENT, now);
                drawn++;
            }
            if (drawn == 0) return;
            var prev = RenderTexture.active;
            Graphics.ExecuteCommandBuffer(cmd);
            RenderTexture.active = v.PickArea;
            v.PickAreaRead.ReadPixels(new Rect(0, 0, tw, th), 0, 0, false);
            RenderTexture.active = prev;
            var px = v.PickAreaRead.GetPixels32();
            var hits = _tunerAreaHits;
            hits.Clear();
            var seen = new HashSet<int>();
            foreach (var c in px)
            {
                if (c.a == 0) continue;
                int idx = (c.r | (c.g << 8) | (c.b << 16)) - 1;
                if (idx < 0 || idx >= s.Draws.Count || !seen.Add(idx)) continue;
                hits.Add(idx);
            }
            hits.Sort();
            foreach (var idx in hits)
            {
                var go = s.Draws[idx].Rend.Go;
                if (go != null && !gos.Contains(go)) gos.Add(go);
            }
            hits.Clear();
        }
        finally
        {
            sorted.Clear();
        }
    }
}
