using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UI;

public static partial class MCPTestBridge
{
    [Serializable]
    class TunerCanvasViewArgs
    {
        public string session;
        public string canvas;
        public string scene;
    }

    [Serializable]
    class TunerCanvasViewCommand
    {
        public int id;
        public TunerCanvasViewArgs args;
    }

    class TunerOverlay
    {
        public Canvas Canvas;
        public string Path;
        public string Scene;
    }

    static int _tunerVisGen;
    static bool _tunerVisHooked;
    static bool _tunerIsoOn;
    static string _tunerIsoKey;
    static int _tunerOverlayGen = -1;
    static bool _tunerOverlaysValid;
    static readonly List<TunerOverlay> _tunerOverlays = new List<TunerOverlay>();
    static readonly List<Canvas> _tunerOverlayTmp = new List<Canvas>();
    static readonly List<RectTransform> _tunerUiPickTmp = new List<RectTransform>();
    static readonly Vector3[] _tunerCvCorners = new Vector3[4];
    static MethodInfo _tunerVisStateInstance;
    static PropertyInfo _tunerVisActive;
    static bool _tunerVisReflected;

    static void InitTunerVisibility()
    {
        if (_tunerVisHooked) return;
        _tunerVisHooked = true;
        SceneVisibilityManager.visibilityChanged += OnTunerVisibilityChanged;
        AssemblyReloadEvents.beforeAssemblyReload += ExitTunerIsolation;
        EditorApplication.quitting += ExitTunerIsolation;
    }

    static void ReflectTunerVisibility()
    {
        if (_tunerVisReflected) return;
        _tunerVisReflected = true;
        try
        {
            var state = typeof(SceneVisibilityManager).Assembly.GetType("UnityEditor.SceneVisibilityState");
            _tunerVisStateInstance = state != null ? state.GetMethod("GetInstance", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null) : null;
            _tunerVisActive = typeof(SceneVisibilityManager).GetProperty("enableSceneVisibility", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        }
        catch (Exception e)
        {
            Debug.LogWarning("[Tuner] scene visibility: " + e.Message);
        }
    }

    static void OnTunerVisibilityChanged()
    {
        _tunerVisGen++;
        _tunerChangeGen++;
        foreach (var t in _tuners.Values) t.Dirty = true;
        SignalEditorTick();
    }

    static void ForgetTunerIsolationUndo()
    {
        ReflectTunerVisibility();
        if (_tunerVisStateInstance == null) return;
        try
        {
            var o = _tunerVisStateInstance.Invoke(null, null) as UnityEngine.Object;
            if (o != null) Undo.ClearUndo(o);
        }
        catch { }
    }

    static bool SetTunerSceneVisibility(bool on)
    {
        ReflectTunerVisibility();
        if (_tunerVisActive == null) return on;
        try
        {
            var svm = SceneVisibilityManager.instance;
            bool was = (bool)_tunerVisActive.GetValue(svm);
            if (was != on) _tunerVisActive.SetValue(svm, on);
            return was;
        }
        catch { return on; }
    }

    static bool TunerVisHidden(GameObject go)
    {
        if (!_tunerIsoOn || ReferenceEquals(go, null) || !go) return false;
        return SceneVisibilityManager.instance.IsHidden(go);
    }

    static bool TunerIsOverlay(Canvas c)
    {
        return c.renderMode == RenderMode.ScreenSpaceOverlay || (c.renderMode == RenderMode.ScreenSpaceCamera && c.worldCamera == null);
    }

    static List<TunerOverlay> TunerOverlays(TunerSession s)
    {
        var roots = TunerSceneRoots(s);
        int sig = _tunerHierarchyGen * 31 + _tunerStructureGen;
        foreach (var go in roots) sig = sig * 31 + go.GetHashCode();
        if (_tunerOverlayGen == sig && _tunerOverlaysValid) return _tunerOverlays;
        _tunerOverlayGen = sig;
        _tunerOverlaysValid = true;
        _tunerOverlays.Clear();
        foreach (var go in roots)
        {
            go.GetComponentsInChildren(false, _tunerOverlayTmp);
            foreach (var c in _tunerOverlayTmp)
            {
                if (c == null || !c.enabled || TunerRootCanvasOf(c.transform) != c || !TunerIsOverlay(c)) continue;
                _tunerOverlays.Add(new TunerOverlay { Canvas = c, Path = TunerObjectPath(c.gameObject), Scene = TunerSceneKey(c.gameObject.scene) });
            }
            _tunerOverlayTmp.Clear();
        }
        return _tunerOverlays;
    }

    static TunerOverlay TunerCanvasViewOf(TunerSession s)
    {
        if (string.IsNullOrEmpty(s.CanvasView)) return null;
        foreach (var o in TunerOverlays(s))
            if (o.Canvas != null && o.Path == s.CanvasView && (string.IsNullOrEmpty(s.CanvasViewScene) || o.Scene == s.CanvasViewScene)) return o;
        return null;
    }

    static TunerSession TunerIsolationOwner()
    {
        TunerSession owner = null;
        foreach (var s in _tuners.Values)
            if (!s.Ended && s.Scene && s.Prefabs == null && (owner == null || (owner.Hidden && !s.Hidden))) owner = s;
        return owner;
    }

    static void PumpTunerIsolation()
    {
        var owner = _tuners.Count == 0 || _editorRevealed ? null : TunerIsolationOwner();
        if (owner == null)
        {
            if (_tunerIsoOn) ExitTunerIsolation();
            return;
        }
        var svm = SceneVisibilityManager.instance;
        var overlays = TunerOverlays(owner);
        var focus = TunerCanvasViewOf(owner);
        var roots = TunerSceneRoots(owner);
        var key = new StringBuilder(256);
        key.Append(focus != null ? focus.Canvas.GetHashCode() : 0).Append('|');
        foreach (var o in overlays) if (o.Canvas != null) key.Append(o.Canvas.GetHashCode()).Append(',');
        key.Append('|');
        foreach (var go in roots) key.Append(go.GetHashCode()).Append(',');
        var k = key.ToString();
        if (_tunerIsoOn && k == _tunerIsoKey && svm.IsCurrentStageIsolated()) return;
        _tunerIsoKey = k;
        _tunerIsoOn = true;
        if (focus != null) svm.Isolate(focus.Canvas.gameObject, true);
        else
        {
            svm.Isolate(roots.ToArray(), true);
            var hide = new List<GameObject>();
            foreach (var o in overlays) if (o.Canvas != null) hide.Add(o.Canvas.gameObject);
            if (hide.Count > 0) svm.Hide(hide.ToArray(), true);
        }
        ForgetTunerIsolationUndo();
        OnTunerVisibilityChanged();
        owner.StatePending = true;
        owner.Dirty = true;
        SaturaDebug.Log("[Tuner] " + owner.Name + " isolation: " + (focus != null ? "only the canvas " + focus.Path : "the scene without " + overlays.Count.ToString(Inv) + " overlay canvases"));
    }

    static void ExitTunerIsolation()
    {
        if (!_tunerIsoOn) return;
        _tunerIsoOn = false;
        _tunerIsoKey = null;
        try
        {
            SceneVisibilityManager.instance.ExitIsolation();
            ForgetTunerIsolationUndo();
            OnTunerVisibilityChanged();
            SaturaDebug.Log("[Tuner] isolation off");
        }
        catch (Exception e)
        {
            Debug.LogWarning("[Tuner] could not leave isolation: " + e.Message);
        }
    }

    static void AppendTunerCanvasView(StringBuilder sb, TunerSession s)
    {
        if (!s.Scene || s.Prefabs != null) return;
        var focus = TunerCanvasViewOf(s);
        sb.Append(",\"canvasView\":").Append(JStr(focus != null ? focus.Path : ""))
          .Append(",\"canvasViewScene\":").Append(JStr(focus != null ? focus.Scene : ""))
          .Append(",\"overlays\":[");
        bool first = true;
        foreach (var o in TunerOverlays(s))
        {
            if (o.Canvas == null) continue;
            if (!first) sb.Append(',');
            first = false;
            var rt = o.Canvas.transform as RectTransform;
            var b = new Bounds(o.Canvas.transform.position, Vector3.zero);
            if (rt != null)
            {
                rt.GetWorldCorners(_tunerCvCorners);
                b = new Bounds(_tunerCvCorners[0], Vector3.zero);
                for (int i = 1; i < 4; i++) b.Encapsulate(_tunerCvCorners[i]);
            }
            sb.Append("{\"name\":").Append(JStr(o.Canvas.name))
              .Append(",\"path\":").Append(JStr(o.Path))
              .Append(",\"scene\":").Append(JStr(o.Scene))
              .Append(",\"center\":[").Append(TunerCvF(b.center.x)).Append(',').Append(TunerCvF(b.center.y)).Append(',').Append(TunerCvF(b.center.z))
              .Append("],\"size\":[").Append(TunerCvF(b.size.x)).Append(',').Append(TunerCvF(b.size.y)).Append(',').Append(TunerCvF(b.size.z)).Append("]}");
        }
        sb.Append(']');
    }

    static string TunerCvF(float v)
    {
        return v.ToString("0.###", Inv);
    }

    static bool HandleTunerCanvasView(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/canvasView") return false;
        TunerCanvasViewCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerCanvasViewCommand>(line); }
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
        if (!s.Scene || s.Prefabs != null)
        {
            TunerResult(from, id, "only the scene Tuner has a canvas view", null);
            return true;
        }
        string err = null;
        var want = a.canvas ?? "";
        s.CanvasView = want;
        s.CanvasViewScene = a.scene ?? "";
        if (want.Length > 0 && TunerCanvasViewOf(s) == null)
        {
            var names = new StringBuilder();
            foreach (var o in TunerOverlays(s))
            {
                if (names.Length > 0) names.Append(", ");
                names.Append(o.Path);
            }
            err = "no Screen Space - Overlay canvas at '" + want + "'" + (names.Length > 0 ? ". The overlay canvases are " + names : ". The scene has no overlay canvases");
            s.CanvasView = "";
            s.CanvasViewScene = "";
        }
        SaturaDebug.Log("[Tuner] " + s.Name + " canvas view: " + (s.CanvasView.Length > 0 ? s.CanvasView : "Scene"));
        PumpTunerIsolation();
        s.StatePending = true;
        s.Dirty = true;
        SignalEditorTick();
        TunerResult(from, id, err, "\"state\":" + DescribeTunerState(s));
        return true;
    }

    static Material _tunerFrameMat;

    static void DrawTunerCanvasFrame(TunerSession s, Matrix4x4 view, Matrix4x4 proj)
    {
        if (!s.Scene || !_tunerIsoOn) return;
        var focus = TunerCanvasViewOf(s);
        var rt = focus != null ? focus.Canvas.transform as RectTransform : null;
        if (rt == null) return;
        if (_tunerFrameMat == null)
        {
            var sh = Shader.Find("Hidden/Internal-Colored");
            if (sh == null) return;
            _tunerFrameMat = new Material(sh) { hideFlags = HideFlags.HideAndDontSave };
            _tunerFrameMat.SetInt("_ZTest", (int)UnityEngine.Rendering.CompareFunction.Always);
            _tunerFrameMat.SetInt("_ZWrite", 0);
            _tunerFrameMat.SetInt("_SrcBlend", (int)UnityEngine.Rendering.BlendMode.SrcAlpha);
            _tunerFrameMat.SetInt("_DstBlend", (int)UnityEngine.Rendering.BlendMode.OneMinusSrcAlpha);
            _tunerFrameMat.SetInt("_Cull", (int)UnityEngine.Rendering.CullMode.Off);
        }
        rt.GetWorldCorners(_tunerCvCorners);
        var prev = RenderTexture.active;
        RenderTexture.active = s.Target;
        GL.PushMatrix();
        GL.LoadProjectionMatrix(proj);
        GL.modelview = view;
        _tunerFrameMat.SetPass(0);
        GL.Begin(GL.LINES);
        GL.Color(TunerCanvasRectColor);
        for (int k = 0; k < 4; k++)
        {
            GL.Vertex(_tunerCvCorners[k]);
            GL.Vertex(_tunerCvCorners[(k + 1) % 4]);
        }
        GL.End();
        GL.PopMatrix();
        RenderTexture.active = prev;
    }

    static void PickTunerUi(TunerSession s, Matrix4x4 view, Matrix4x4 proj, int w, int h, float px, float py, Vector3 camPos, List<TunerPickHit> hits)
    {
        if (!s.Scene || s.Prefabs != null) return;
        var vp = proj * view;
        var inv = vp.inverse;
        float nx = px / w * 2f - 1f, ny = py / h * 2f - 1f;
        var a = inv.MultiplyPoint(new Vector3(nx, ny, -1f));
        var b = inv.MultiplyPoint(new Vector3(nx, ny, 1f));
        var ray = new Ray(a, (b - a).normalized);
        var focus = TunerCanvasViewOf(s);
        var roots = new List<Canvas>();
        if (focus != null) roots.Add(focus.Canvas);
        else
            foreach (var go in TunerSceneRoots(s))
            {
                go.GetComponentsInChildren(false, _tunerOverlayTmp);
                foreach (var c in _tunerOverlayTmp)
                    if (c != null && c.enabled && TunerRootCanvasOf(c.transform) == c && !TunerIsOverlay(c) && !roots.Contains(c)) roots.Add(c);
                _tunerOverlayTmp.Clear();
            }
        var found = new List<KeyValuePair<long, TunerPickHit>>();
        var dist = new Dictionary<Canvas, float>();
        foreach (var root in roots)
        {
            if (root == null || TunerVisHidden(root.gameObject)) continue;
            root.GetComponentsInChildren(false, _tunerUiPickTmp);
            int order = 0;
            foreach (var rt in _tunerUiPickTmp)
            {
                order++;
                if (rt == null || TunerVisHidden(rt.gameObject)) continue;
                Vector3 hit;
                float d;
                if (!TunerRayRect(rt, ray, out hit, out d) || TunerUiClipped(rt, ray)) continue;
                if (!dist.ContainsKey(root)) dist[root] = d;
                var g = rt.GetComponent<Graphic>();
                var near = rt.GetComponentInParent<Canvas>();
                var sorter = near != null && near.overrideSorting ? near : root;
                long sortKey = ((long)SortingLayer.GetLayerValueFromID(sorter.sortingLayerID) << 40) + ((long)sorter.sortingOrder << 20);
                found.Add(new KeyValuePair<long, TunerPickHit>(sortKey + order, new TunerPickHit
                {
                    Go = rt.gameObject,
                    Source = g != null ? (Component)g : rt,
                    Kind = g == null ? "rect" : g is Text || g is TMPro.TMP_Text ? "text" : "ui",
                    UiRoot = root
                }));
            }
            _tunerUiPickTmp.Clear();
        }
        if (found.Count == 0) return;
        found.Sort((x, y) =>
        {
            float dx = dist[x.Value.UiRoot], dy = dist[y.Value.UiRoot];
            if (x.Value.UiRoot != y.Value.UiRoot && Mathf.Abs(dx - dy) > 1e-4f) return dx.CompareTo(dy);
            return y.Key.CompareTo(x.Key);
        });
        int at = -1;
        for (int i = hits.Count - 1; i >= 0; i--)
            if (hits[i].Go != null && hits[i].Go.transform is RectTransform)
            {
                at = i;
                hits.RemoveAt(i);
            }
        if (focus != null)
        {
            hits.Clear();
            at = 0;
        }
        var ui = new List<TunerPickHit>();
        foreach (var kv in found) ui.Add(kv.Value);
        if (at < 0 || at > hits.Count) hits.AddRange(ui);
        else hits.InsertRange(at, ui);
        if (hits.Count > TUNER_PICK_MAX) hits.RemoveRange(TUNER_PICK_MAX, hits.Count - TUNER_PICK_MAX);
    }

    static bool TunerRayRect(RectTransform rt, Ray ray, out Vector3 hit, out float dist)
    {
        hit = Vector3.zero;
        dist = 0f;
        var plane = new Plane(rt.rotation * Vector3.back, rt.position);
        if (!plane.Raycast(ray, out dist)) return false;
        hit = ray.GetPoint(dist);
        var local = rt.InverseTransformPoint(hit);
        return rt.rect.Contains(new Vector2(local.x, local.y));
    }

    static bool TunerUiClipped(RectTransform rt, Ray ray)
    {
        for (var p = rt.parent; p != null; p = p.parent)
        {
            var prt = p as RectTransform;
            if (prt == null) break;
            var m2 = p.GetComponent<RectMask2D>();
            var mk = p.GetComponent<Mask>();
            if ((m2 == null || !m2.isActiveAndEnabled) && (mk == null || !mk.isActiveAndEnabled)) continue;
            Vector3 hit;
            float d;
            if (!TunerRayRect(prt, ray, out hit, out d)) return true;
        }
        return false;
    }
}
