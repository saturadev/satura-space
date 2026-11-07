using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public static partial class MCPTestBridge
{
    const string TUNER_VIEW_SHADER = "Hidden/Satura/TunerSceneView";
    const string TUNER_VIEW_SHADER_PATH = "Packages/com.saturaspace.engine/Editor/Shaders/SaturaTunerSceneView.shader";
    const string TUNER_VIEW_RT_NAME = "_SaturaTunerSceneView";
    const double TUNER_VIEW_LIST_INTERVAL = 2.0;
    const int TUNER_DIRTY_STRIDE = 8;
    const double TUNER_GIZMO_REFRESH = 0.2;

    static readonly int TunerClipId = Shader.PropertyToID("_SaturaTunerClip");
    static readonly int TunerMaskColorId = Shader.PropertyToID("_SaturaTunerMaskColor");
    static readonly int TunerPickIdId = Shader.PropertyToID("_SaturaTunerPickId");
    static readonly int TunerMaskTexId = Shader.PropertyToID("_SaturaTunerMaskTex");
    static readonly int TunerBlurDirId = Shader.PropertyToID("_SaturaTunerBlurDir");
    static readonly int TunerParentColorId = Shader.PropertyToID("_SaturaTunerParentColor");
    static readonly int TunerChildColorId = Shader.PropertyToID("_SaturaTunerChildColor");
    static readonly int TunerOutlineGainId = Shader.PropertyToID("_SaturaTunerOutlineGain");

    [Serializable]
    class TunerViewArgs
    {
        public string session;
        public string id;
        public string path;
        public string scene;
        public string[] ids;
        public string[] ghosts;
        public string[] focus;
        public float[] cams;
        public bool focusOn;
        public bool focusTree;
        public bool context;
        public float x = -1f;
        public float x1 = -1f;
        public float y1 = -1f;
        public float y = -1f;
        public float[] position;
        public float[] rotation;
        public float fov;
        public float ortho;
        public float near;
        public float far;
        public int width;
        public int height;
        public bool reset;
        public float[] clear;
        public float[] grid;
        public bool effects;
        public bool skybox;
        public bool fog;
        public bool post;
        public bool particles;
        public bool refresh;
        public bool lighting = true;
        public float[] outline;
        public float[] outlineChild;
        public bool gizmos = true;
        public bool showGrid = true;
    }

    [Serializable]
    class TunerViewCommand
    {
        public int id;
        public TunerViewArgs args;
    }

    class TunerTheme
    {
        public Color Clear;
        public Color Grid;
        public Color Outline;
        public Color OutlineChild;
    }

    static readonly Color TunerGridDefault = new Color(0.75f, 0.78f, 0.85f, 0.32f);
    static readonly Dictionary<TunerSession, TunerTheme> _tunerThemes = new Dictionary<TunerSession, TunerTheme>();
    static readonly int TunerGridColorId = Shader.PropertyToID("_Color");

    class TunerFrameStats
    {
        public int Frames;
        public double Since = -1;
        public double Render;
        public double RenderMax;
        public double Outline;
        public double OutlineMax;
        public double Gizmos;
        public double GizmosMax;
        public int Ticks;
        public int Samples;
        public int Rebuilds;
        public int HierarchyGen = -1;
        public double Anim;
        public double AnimMax;

        public void Reset(double now)
        {
            Frames = Ticks = Samples = Rebuilds = 0;
            HierarchyGen = _tunerHierarchyGen;
            Since = now;
            Render = RenderMax = Outline = OutlineMax = Gizmos = GizmosMax = Anim = AnimMax = 0;
        }
    }

    class TunerViewState
    {
        public readonly TunerFrameStats Stats = new TunerFrameStats();
        public string SelId;
        public string SelPath;
        public string SelScene;
        public GameObject SelGo;
        public double SelResolvedAt = -1;
        public string[] SelIds = new string[0];
        public string[] GhostIds = new string[0];
        public string[] FocusIds = new string[0];
        public bool FocusOn;
        public bool FocusTree;
        public bool Context;
        public string ContextReport;
        public readonly HashSet<GameObject> FocusSet = new HashSet<GameObject>();
        public double FocusAt = -1;
        public int FocusGen = -1;
        public readonly List<GameObject> Marked = new List<GameObject>();
        public readonly HashSet<GameObject> MarkedSet = new HashSet<GameObject>();
        public readonly HashSet<GameObject> SelectedSet = new HashSet<GameObject>();
        public readonly HashSet<GameObject> SelectedTree = new HashSet<GameObject>();
        public readonly HashSet<GameObject> MarkedTree = new HashSet<GameObject>();
        public readonly List<TunerDraw> MarkedDraws = new List<TunerDraw>();
        public readonly List<int> MarkedRoles = new List<int>();
        public int MarkedTreeGen;
        public int MarkedSig;
        public int MarkedDrawsTree = -1;
        public int MarkedDrawsGen = -1;
        public int MarkedDrawsCount = -1;
        public int MarkedGhosts;
        public double MarkedAt = -1;
        public int MarkedGen = -1;
        public RenderTexture Mask;
        public RenderTexture BlurA;
        public RenderTexture BlurB;
        public RenderTexture Pick;
        public Texture2D PickRead;
        public RenderTexture PickArea;
        public Texture2D PickAreaRead;
        public readonly List<GameObject> Shown = new List<GameObject>();
        public readonly HashSet<GameObject> ShownSet = new HashSet<GameObject>();
        public int ShownGen = -1;
        public ulong ShownSig;
        public readonly List<Canvas> ShownCanvases = new List<Canvas>();
        public int ShownChangeGen;
        public double ShownAt = -1;
        public bool HasScriptGizmos;
        public string OutlineReport;
        public string WireReport;
        public string GizmoReport;
        public string Projection;
        public bool GizmosOff;
        public bool GridOff;
        public bool SkyboxOff;
        public bool FogOff;
        public bool PostOff;
        public bool ParticlesOff;
        public bool AlwaysRefresh;
        public bool LightingOff;
        public readonly StringBuilder GizmoLog = new StringBuilder(256);
        public readonly List<Component[]> ShownComps = new List<Component[]>();
        public readonly List<bool> ShownScript = new List<bool>();
        public int ShownStructGen = -1;
        public int ShownTreeGen = -1;
        public int ShownVisGen = -1;
        public Dictionary<GameObject, TunerShownComps> ShownCache = new Dictionary<GameObject, TunerShownComps>();
        public Dictionary<GameObject, TunerShownComps> ShownNext = new Dictionary<GameObject, TunerShownComps>();
        public readonly Dictionary<Component, int> GizmoDirty = new Dictionary<Component, int>();
        public int GizmoDirtyGen;
        public int GizmoDirtyPhase;
        public readonly List<GameObject> GizmoNoteGos = new List<GameObject>();
        public readonly List<string> GizmoNotes = new List<string>();
        public GameObject GizmoCur;
        public ulong GizmoSig;
        public ulong GizmoSigLogged;
    }

    static readonly Dictionary<TunerSession, TunerViewState> _tunerViews = new Dictionary<TunerSession, TunerViewState>();
    static readonly List<Transform> _tunerViewTrTmp = new List<Transform>();
    static Material _tunerViewMat;
    static bool _tunerViewShaderWarned;

    static TunerViewState TunerViewOf(TunerSession s, bool create)
    {
        TunerViewState v;
        if (_tunerViews.TryGetValue(s, out v) || !create) return v;
        v = new TunerViewState();
        _tunerViews[s] = v;
        return v;
    }

    static Material TunerViewMaterial()
    {
        if (_tunerViewMat != null) return _tunerViewMat;
        var sh = AssetDatabase.LoadAssetAtPath<Shader>(TUNER_VIEW_SHADER_PATH);
        if (sh == null) sh = Shader.Find(TUNER_VIEW_SHADER);
        if (sh == null || !sh.isSupported)
        {
            if (!_tunerViewShaderWarned)
            {
                _tunerViewShaderWarned = true;
                Debug.LogWarning("[Tuner] the scene view shader " + TUNER_VIEW_SHADER + (sh == null ? " was not found at " + TUNER_VIEW_SHADER_PATH : " is not supported on this GPU"));
            }
            return null;
        }
        _tunerViewMat = new Material(sh) { name = TUNER_VIEW_RT_NAME, hideFlags = HideFlags.HideAndDontSave };
        return _tunerViewMat;
    }

    static bool HandleTunerView(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/sceneSelection" && cmd != "tuner/pick" && cmd != "tuner/pickRect" && cmd != "tuner/clearView" && cmd != "tuner/theme" && cmd != "tuner/sceneStats" && cmd != "tuner/sceneSettings") return false;
        TunerViewCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerViewCommand>(line); }
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
        if (cmd == "tuner/sceneSelection") TunerSceneSelection(id, s, a, from);
        else if (cmd == "tuner/theme") TunerThemeCommand(id, s, a, from);
        else if (cmd == "tuner/sceneStats") TunerSceneStats(id, s, a, from);
        else if (cmd == "tuner/sceneSettings") TunerSceneSettings(id, s, a, from);
        else if (cmd == "tuner/pickRect") TunerPickRect(id, s, a, from);
        else if (cmd == "tuner/clearView") TunerClearView(id, s, a, from);
        else TunerPick(id, s, a, from);
        return true;
    }

    static void TunerSceneSelection(int id, TunerSession s, TunerViewArgs a, ControlClient from)
    {
        var v = TunerViewOf(s, true);
        v.SelId = string.IsNullOrEmpty(a.id) ? null : a.id;
        v.SelPath = string.IsNullOrEmpty(a.path) ? null : a.path.Trim().TrimStart('/');
        v.SelScene = string.IsNullOrEmpty(a.scene) ? null : a.scene;
        v.SelGo = null;
        v.SelResolvedAt = -1;
        v.SelIds = CleanTunerIds(a.ids);
        v.GhostIds = CleanTunerIds(a.ghosts);
        v.FocusOn = a.focusOn;
        v.FocusTree = a.focusTree;
        v.Context = a.context;
        v.FocusIds = a.focusOn ? CleanTunerFocusIds(a.focus) : new string[0];
        v.FocusAt = -1;
        v.MarkedAt = -1;
        var go = ResolveTunerSelection(s, v, EditorApplication.timeSinceStartup);
        var marked = ResolveTunerMarked(s, v, EditorApplication.timeSinceStartup);
        s.Dirty = true;
        SignalEditorTick();
        TunerResult(from, id, null, "\"selection\":" + (go == null ? "null" : "{\"path\":" + JStr(TunerGameObjectPath(go)) + ",\"scene\":" + JStr(TunerSceneKey(go.scene) ?? "") + "}")
            + ",\"marked\":" + marked.Count.ToString(Inv));
    }

    static string[] CleanTunerFocusIds(string[] ids)
    {
        if (ids == null || ids.Length == 0) return new string[0];
        var seen = new HashSet<string>();
        var list = new List<string>(ids.Length);
        foreach (var x in ids)
            if (!string.IsNullOrEmpty(x) && x.Length <= 32 && seen.Add(x)) list.Add(x);
        return list.ToArray();
    }

    static HashSet<GameObject> ResolveTunerFocus(TunerSession s, TunerViewState v, double now)
    {
        if (v.FocusAt >= 0 && v.FocusGen == _tunerHierarchyGen && now - v.FocusAt < TUNER_RESOLVE_INTERVAL) return v.FocusSet;
        v.FocusAt = now;
        v.FocusGen = _tunerHierarchyGen;
        v.FocusSet.Clear();
        foreach (var x in v.FocusIds)
        {
            var go = TunerEntryObject(s, x);
            if (go == null || EditorUtility.IsPersistent(go)) continue;
            if (!v.FocusTree)
            {
                v.FocusSet.Add(go);
                continue;
            }
            go.GetComponentsInChildren(true, _tunerViewTrTmp);
            foreach (var t in _tunerViewTrTmp) v.FocusSet.Add(t.gameObject);
        }
        _tunerViewTrTmp.Clear();
        return v.FocusSet;
    }

    static string[] CleanTunerIds(string[] ids)
    {
        if (ids == null || ids.Length == 0) return new string[0];
        var list = new List<string>(ids.Length);
        foreach (var x in ids)
            if (!string.IsNullOrEmpty(x) && x.Length <= 32 && !list.Contains(x)) list.Add(x);
        return list.ToArray();
    }

    static readonly HashSet<GameObject> _tunerMarkedTreeTmp = new HashSet<GameObject>();

    static List<GameObject> ResolveTunerMarked(TunerSession s, TunerViewState v, double now)
    {
        if (v == null) return null;
        if (v.MarkedAt >= 0 && v.MarkedGen == _tunerHierarchyGen && now - v.MarkedAt < TUNER_RESOLVE_INTERVAL) return v.Marked;
        v.MarkedAt = now;
        v.MarkedGen = _tunerHierarchyGen;
        v.Marked.Clear();
        v.MarkedSet.Clear();
        v.SelectedSet.Clear();
        v.MarkedGhosts = 0;
        var sel = ResolveTunerSelection(s, v, now);
        if (sel != null && v.MarkedSet.Add(sel))
        {
            v.Marked.Add(sel);
            v.SelectedSet.Add(sel);
        }
        foreach (var x in v.SelIds)
        {
            var go = TunerEntryObject(s, x);
            if (go == null || EditorUtility.IsPersistent(go) || !v.MarkedSet.Add(go)) continue;
            v.Marked.Add(go);
            v.SelectedSet.Add(go);
        }
        foreach (var x in v.GhostIds)
        {
            var go = TunerEntryObject(s, x);
            if (go == null || EditorUtility.IsPersistent(go) || !v.MarkedSet.Add(go)) continue;
            v.Marked.Add(go);
            v.MarkedGhosts++;
        }
        v.SelectedTree.Clear();
        foreach (var go in v.SelectedSet)
        {
            if (go == null) continue;
            go.GetComponentsInChildren(true, _tunerViewTrTmp);
            foreach (var t in _tunerViewTrTmp) v.SelectedTree.Add(t.gameObject);
        }
        _tunerMarkedTreeTmp.Clear();
        int sig = v.Marked.Count;
        foreach (var go in v.Marked)
        {
            if (go == null) continue;
            sig = unchecked(sig * 31 + go.GetHashCode());
            go.GetComponentsInChildren(true, _tunerViewTrTmp);
            foreach (var t in _tunerViewTrTmp) _tunerMarkedTreeTmp.Add(t.gameObject);
        }
        _tunerViewTrTmp.Clear();
        if (sig != v.MarkedSig || !v.MarkedTree.SetEquals(_tunerMarkedTreeTmp))
        {
            v.MarkedSig = sig;
            v.MarkedTree.Clear();
            v.MarkedTree.UnionWith(_tunerMarkedTreeTmp);
            v.MarkedTreeGen++;
        }
        _tunerMarkedTreeTmp.Clear();
        return v.Marked;
    }

    static bool SetTunerViewFlag(ref bool flag, bool value)
    {
        if (flag == value) return false;
        flag = value;
        return true;
    }

    static void TunerSceneSettings(int id, TunerSession s, TunerViewArgs a, ControlClient from)
    {
        var v = TunerViewOf(s, true);
        bool changed = false;
        if (SetTunerViewFlag(ref v.GizmosOff, !a.gizmos))
        {
            changed = true;
            SaturaDebug.Log("[Tuner] " + s.Name + " scene settings: gizmos " + OnOff(a.gizmos));
        }
        if (SetTunerViewFlag(ref v.GridOff, !a.showGrid))
        {
            changed = true;
            SaturaDebug.Log("[Tuner] " + s.Name + " scene settings: grid " + OnOff(a.showGrid));
        }
        if (SetTunerViewFlag(ref v.LightingOff, !a.lighting))
        {
            changed = true;
            SaturaDebug.Log("[Tuner] " + s.Name + " scene settings: lighting " + OnOff(a.lighting));
        }
        if (a.effects)
        {
            bool fx = SetTunerViewFlag(ref v.SkyboxOff, !a.skybox);
            fx |= SetTunerViewFlag(ref v.FogOff, !a.fog);
            fx |= SetTunerViewFlag(ref v.PostOff, !a.post);
            fx |= SetTunerViewFlag(ref v.ParticlesOff, !a.particles);
            fx |= SetTunerViewFlag(ref v.AlwaysRefresh, a.refresh);
            if (fx)
            {
                changed = true;
                SaturaDebug.Log("[Tuner] " + s.Name + " scene effects: skybox " + OnOff(a.skybox) + ", fog " + OnOff(a.fog) + ", post processing " + OnOff(a.post)
                    + ", particle systems " + OnOff(a.particles) + ", always refresh " + OnOff(a.refresh));
            }
        }
        if (changed)
        {
            s.Dirty = true;
            SignalEditorTick();
        }
        TunerResult(from, id, null, null);
    }

    static void NoteTunerProjection(TunerSession s)
    {
        var v = TunerViewOf(s, true);
        var kind = s.Ortho > 0f ? "orthographic" : "perspective";
        if (kind == v.Projection) return;
        v.Projection = kind;
        SaturaDebug.Log("[Tuner] " + s.Name + " camera " + kind + (s.Ortho > 0f ? " size " + s.Ortho.ToString("0.###", Inv) : " fov " + s.Fov.ToString("0.#", Inv)));
    }

    static bool TunerThemeColor(float[] v, Color fallback, out Color c)
    {
        c = fallback;
        if (v == null || (v.Length != 3 && v.Length != 4)) return false;
        for (int i = 0; i < v.Length; i++)
            if (float.IsNaN(v[i]) || v[i] < 0f || v[i] > 1f) return false;
        c = new Color(v[0], v[1], v[2], v.Length == 4 ? v[3] : 1f);
        return true;
    }

    static string TunerHex(Color c)
    {
        return "#" + ColorUtility.ToHtmlStringRGB(c).ToLowerInvariant();
    }

    static void TunerThemeCommand(int id, TunerSession s, TunerViewArgs a, ControlClient from)
    {
        TunerTheme t;
        if (!_tunerThemes.TryGetValue(s, out t))
        {
            t = new TunerTheme { Clear = TunerClear, Grid = TunerGridDefault, Outline = TunerOutlineParentDefault, OutlineChild = TunerOutlineChildDefault };
            _tunerThemes[s] = t;
        }
        TunerThemeColor(a.clear, t.Clear, out t.Clear);
        TunerThemeColor(a.grid, t.Grid, out t.Grid);
        TunerThemeColor(a.outline, t.Outline, out t.Outline);
        TunerThemeColor(a.outlineChild, t.OutlineChild, out t.OutlineChild);
        t.Clear.a = 1f;
        t.Outline.a = 1f;
        t.OutlineChild.a = 1f;
        SaturaDebug.Log("[Tuner] " + s.Name + " theme clear " + TunerHex(t.Clear) + " grid " + TunerHex(t.Grid) + " outline " + TunerHex(t.Outline)
            + " children " + TunerHex(t.OutlineChild));
        s.Dirty = true;
        SignalEditorTick();
        TunerResult(from, id, null, null);
    }

    static void ApplyTunerGridColor(TunerSession s)
    {
        if (s.GridMat == null) return;
        TunerTheme t;
        s.GridMat.SetColor(TunerGridColorId, _tunerThemes.TryGetValue(s, out t) ? t.Grid : TunerGridDefault);
    }

    static double TunerMs(long ticks)
    {
        return ticks * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
    }

    static void NoteTunerStat(ref double sum, ref double max, long ticks)
    {
        double ms = TunerMs(ticks);
        sum += ms;
        if (ms > max) max = ms;
    }

    static void NoteTunerFrame(TunerSession s, long start)
    {
        var v = TunerViewOf(s, true);
        var st = v.Stats;
        if (st.Since < 0) st.Since = EditorApplication.timeSinceStartup;
        st.Frames++;
        NoteTunerStat(ref st.Render, ref st.RenderMax, System.Diagnostics.Stopwatch.GetTimestamp() - start);
    }

    static void TunerSceneStats(int id, TunerSession s, TunerViewArgs a, ControlClient from)
    {
        var v = TunerViewOf(s, true);
        var st = v.Stats;
        double now = EditorApplication.timeSinceStartup;
        double secs = st.Since < 0 ? 0 : now - st.Since;
        int n = Math.Max(1, st.Frames);
        var line = st.Frames + " frames in " + secs.ToString("0.0", Inv) + " s, render " + (st.Render / n).ToString("0.00", Inv) + " ms (max "
            + st.RenderMax.ToString("0.00", Inv) + "), outline " + (st.Outline / n).ToString("0.00", Inv) + " ms (max " + st.OutlineMax.ToString("0.00", Inv)
            + "), gizmos " + (st.Gizmos / n).ToString("0.00", Inv) + " ms (max " + st.GizmosMax.ToString("0.00", Inv) + "), " + v.Shown.Count + " objects, "
            + s.Draws.Count + " draws, " + st.Ticks + " ticks, animation " + (st.Ticks > 0 ? st.Anim / st.Ticks : 0).ToString("0.00", Inv) + " ms/tick (max "
            + st.AnimMax.ToString("0.00", Inv) + "), " + st.Samples + " pose samples, " + st.Rebuilds + " cache rebuilds, "
            + (st.HierarchyGen < 0 ? 0 : _tunerHierarchyGen - st.HierarchyGen) + " hierarchy changes";
        var uiLine = new StringBuilder();
        var uiJson = new StringBuilder();
        TunerUiStatsLine(s, uiLine, uiJson, a.reset);
        if (SaturaDebug.On) Debug.Log("[Tuner] " + s.Name + " frame cost: " + line + uiLine + TpLine());
        var sb = new StringBuilder(256);
        sb.Append("\"stats\":{\"frames\":").Append(st.Frames.ToString(Inv))
          .Append(",\"seconds\":").Append(Num(secs))
          .Append(",\"renderMs\":").Append(Num(st.Render / n))
          .Append(",\"renderMaxMs\":").Append(Num(st.RenderMax))
          .Append(",\"outlineMs\":").Append(Num(st.Outline / n))
          .Append(",\"outlineMaxMs\":").Append(Num(st.OutlineMax))
          .Append(",\"gizmoMs\":").Append(Num(st.Gizmos / n))
          .Append(",\"gizmoMaxMs\":").Append(Num(st.GizmosMax))
          .Append(",\"objects\":").Append(v.Shown.Count.ToString(Inv))
          .Append(",\"draws\":").Append(s.Draws.Count.ToString(Inv))
          .Append(",\"ticks\":").Append(st.Ticks.ToString(Inv))
          .Append(",\"animMs\":").Append(Num(st.Ticks > 0 ? st.Anim / st.Ticks : 0))
          .Append(",\"animMaxMs\":").Append(Num(st.AnimMax))
          .Append(",\"samples\":").Append(st.Samples.ToString(Inv))
          .Append(",\"rebuilds\":").Append(st.Rebuilds.ToString(Inv))
          .Append(",\"tickBoost\":").Append(TunerTickBoosted ? "true" : "false")
          .Append(",\"tickUps\":").Append(TunerTickUps.ToString(Inv))
          .Append(",\"hierarchyChanges\":").Append((st.HierarchyGen < 0 ? 0 : _tunerHierarchyGen - st.HierarchyGen).ToString(Inv)).Append(uiJson);
        TpAppendJson(sb);
        sb.Append('}');
        if (a.reset)
        {
            st.Reset(now);
            TpReset();
        }
        TunerResult(from, id, null, sb.ToString());
    }

    static GameObject ResolveTunerSelection(TunerSession s, TunerViewState v, double now)
    {
        if (v == null) return null;
        if (v.SelGo != null) return v.SelGo;
        if (v.SelId == null && v.SelPath == null) return null;
        if (v.SelResolvedAt >= 0 && now - v.SelResolvedAt < TUNER_RESOLVE_INTERVAL) return null;
        v.SelResolvedAt = now;
        if (v.SelId != null)
        {
            int i = TunerIndex(s, v.SelId);
            var e = i >= 0 ? null : FindTunerEntry(s, v.SelId);
            v.SelGo = i >= 0 ? s.Objects[i] : e != null && !e.Asset ? e.Go : null;
        }
        else v.SelGo = FindTunerObject(TunerScenes(), new TunerObjectArgs { path = v.SelPath, scene = v.SelScene });
        return v.SelGo;
    }

    static string TunerGameObjectPath(GameObject go)
    {
        return TunerIndexedPath(go.transform);
    }

    static List<GameObject> TunerShownObjects(TunerSession s, TunerViewState v, double now)
    {
        if (v.ShownGen == _tunerHierarchyGen && v.ShownStructGen == _tunerStructureGen && v.ShownTreeGen == s.WalkGen && v.ShownVisGen == _tunerVisGen)
        {
            if (now - v.ShownAt < TUNER_VIEW_LIST_INTERVAL) return v.Shown;
            v.ShownAt = now;
            if (v.ShownChangeGen == _tunerChangeGen && TunerShownSignature(v) == v.ShownSig) return v.Shown;
        }
        v.ShownChangeGen = _tunerChangeGen;
        v.ShownGen = _tunerHierarchyGen;
        v.ShownStructGen = _tunerStructureGen;
        v.ShownTreeGen = s.WalkGen;
        v.ShownVisGen = _tunerVisGen;
        if (v.GizmoDirty.Count > 4096) v.GizmoDirty.Clear();
        v.ShownAt = now;
        v.Shown.Clear();
        v.ShownComps.Clear();
        v.ShownScript.Clear();
        v.ShownSet.Clear();
        v.ShownCanvases.Clear();
        v.HasScriptGizmos = false;
        foreach (var oi in TunerActiveObjects(s))
        {
            var root = oi < s.Objects.Length ? s.Objects[oi] : null;
            if (root == null) continue;
            root.GetComponentsInChildren(true, _tunerViewTrTmp);
            foreach (var t in _tunerViewTrTmp)
            {
                if (t == null || TunerVisHidden(t.gameObject) || !v.ShownSet.Add(t.gameObject)) continue;
                AddTunerShown(v, t.gameObject);
            }
        }
        foreach (var root in TunerSceneRoots(s))
        {
            root.GetComponentsInChildren(true, _tunerViewTrTmp);
            foreach (var t in _tunerViewTrTmp)
            {
                if (t == null) continue;
                if (t is RectTransform)
                {
                    var cv = TunerRootCanvasOf(t);
                    if (cv != null && !v.ShownCanvases.Contains(cv)) v.ShownCanvases.Add(cv);
                    if (cv != null && cv.renderMode != RenderMode.WorldSpace) continue;
                }
                if (TunerVisHidden(t.gameObject) || !v.ShownSet.Add(t.gameObject)) continue;
                AddTunerShown(v, t.gameObject);
            }
        }
        _tunerViewTrTmp.Clear();
        var swap = v.ShownCache;
        v.ShownCache = v.ShownNext;
        v.ShownNext = swap;
        v.ShownNext.Clear();
        v.ShownSig = TunerShownSignature(v);
        return v.Shown;
    }

    static ulong TunerShownSignature(TunerViewState v)
    {
        ulong h = TunerMix(14695981039346656037UL, (uint)v.Shown.Count);
        foreach (var cv in v.ShownCanvases) h = TunerMix(h, cv != null ? (uint)cv.renderMode : 99u);
        foreach (var go in v.Shown)
        {
            if (go == null)
            {
                h = TunerMix(h, 0u);
                continue;
            }
            h = TunerMix(h, (uint)go.GetComponentCount());
        }
        return h;
    }

    class TunerShownComps
    {
        public int Count;
        public Component[] Comps;
        public bool Script;
    }

    static void AddTunerShown(TunerViewState v, GameObject go)
    {
        int count = go.GetComponentCount();
        TunerShownComps hit;
        if (v.ShownCache.TryGetValue(go, out hit) && hit.Count == count)
        {
            v.ShownNext[go] = hit;
            v.Shown.Add(go);
            v.ShownComps.Add(hit.Comps);
            v.ShownScript.Add(hit.Script);
            if (!v.HasScriptGizmos && TunerHasScriptGizmos(hit.Comps)) v.HasScriptGizmos = true;
            return;
        }
        go.GetComponents(_tunerGizmoComps);
        int n = 0;
        foreach (var c in _tunerGizmoComps)
            if (c != null && TunerGizmoRelevant(c.GetType())) n++;
        var comps = n == 0 ? Array.Empty<Component>() : new Component[n];
        n = 0;
        foreach (var c in _tunerGizmoComps)
            if (c != null && TunerGizmoRelevant(c.GetType())) comps[n++] = c;
        _tunerGizmoComps.Clear();
        bool script = false;
        foreach (var c in comps)
            if (TunerGizmoScripted(c.GetType())) script = true;
        v.Shown.Add(go);
        v.ShownComps.Add(comps);
        v.ShownScript.Add(script);
        v.ShownNext[go] = new TunerShownComps { Count = count, Comps = comps, Script = script };
        if (!v.HasScriptGizmos && TunerHasScriptGizmos(comps)) v.HasScriptGizmos = true;
    }

    static string TunerTargetOf(TunerSession s, GameObject go, bool exact)
    {
        TunerEntry member;
        if (s.MemberByGo.TryGetValue(go, out member)) return member.Id;
        foreach (var oi in TunerActiveObjects(s))
        {
            var root = oi < s.Objects.Length ? s.Objects[oi] : null;
            if (root == null) continue;
            if (root == go) return "o" + oi.ToString(Inv);
        }
        if (exact) return null;
        for (var p = go.transform.parent; p != null; p = p.parent)
        {
            var hit = TunerTargetOf(s, p.gameObject, true);
            if (hit != null) return hit;
        }
        return null;
    }

    static ulong MixTunerView(TunerSession s, ulong h, double now)
    {
        var v = TunerViewOf(s, false);
        if (v == null) return h;
        var sel = ResolveTunerSelection(s, v, now);
        h = TunerMix(h, sel);
        var marked = ResolveTunerMarked(s, v, now);
        h = TunerMix(h, (uint)marked.Count);
        foreach (var m in marked) h = TunerMix(h, m);
        h = TunerMix(h, v.GizmosOff ? 1u : 0u);
        h = MixTunerHandles(h);
        if (!TunerGraphics || v.GizmosOff) return h;
        h = MixTunerParticleGizmos(sel, h);
        var shown = TunerShownObjects(s, v, now);
        int phase = v.GizmoDirtyPhase = (v.GizmoDirtyPhase + 1) % TUNER_DIRTY_STRIDE;
        for (int i = 0; i < shown.Count; i++)
        {
            var comps = v.ShownComps[i];
            if (comps.Length == 0) continue;
            bool script = v.ShownScript[i];
            var go = shown[i];
            bool inHierarchy = ReferenceEquals(go, sel) || (v.SelectedTree.Count > 0 && v.SelectedTree.Contains(go));
            if (!inHierarchy && !script) continue;
            if (go == null) continue;
            if (!go.activeInHierarchy) continue;
            h = TunerMix(h, go.transform.localToWorldMatrix);
            h = MixTunerBuiltinGizmos(v, comps, h, i % TUNER_DIRTY_STRIDE == phase, inHierarchy);
        }
        h = TunerMix(h, (uint)v.GizmoDirtyGen);
        if (v.HasScriptGizmos && EditorApplication.isPlaying && !EditorApplication.isPaused)
            h = TunerMix(h, (uint)Math.Floor(now / TUNER_GIZMO_REFRESH));
        return h;
    }

    static RenderTexture EnsureTunerViewTexture(ref RenderTexture rt, int w, int h, RenderTextureFormat format, int depth)
    {
        if (rt != null && rt.width == w && rt.height == h && rt.IsCreated()) return rt;
        ReleaseTunerTexture(ref rt);
        rt = new RenderTexture(w, h, depth, format, RenderTextureReadWrite.Linear)
        {
            name = TUNER_VIEW_RT_NAME,
            hideFlags = HideFlags.HideAndDontSave,
            filterMode = FilterMode.Point,
            wrapMode = TextureWrapMode.Clamp
        };
        if (!rt.Create())
        {
            UnityEngine.Object.DestroyImmediate(rt);
            rt = null;
        }
        return rt;
    }

    static void DestroyTunerView(TunerSession s)
    {
        DisposeTunerUi(s);
        if (s.Ended) _tunerThemes.Remove(s);
        TunerViewState v;
        if (!_tunerViews.TryGetValue(s, out v)) return;
        _tunerViews.Remove(s);
        _tunerRest.Remove(v);
        ReleaseTunerTexture(ref v.Mask);
        ReleaseTunerTexture(ref v.BlurA);
        ReleaseTunerTexture(ref v.BlurB);
        ReleaseTunerTexture(ref v.Pick);
        ReleaseTunerTexture(ref v.PickArea);
        if (v.PickRead != null) UnityEngine.Object.DestroyImmediate(v.PickRead);
        v.PickRead = null;
        if (v.PickAreaRead != null) UnityEngine.Object.DestroyImmediate(v.PickAreaRead);
        v.PickAreaRead = null;
        v.Shown.Clear();
        v.ShownComps.Clear();
        v.ShownScript.Clear();
        v.ShownSet.Clear();
        v.ShownCanvases.Clear();
        v.ShownCache.Clear();
        v.ShownNext.Clear();
    }

    static void TunerViewMatrices(TunerSession s, int w, int h, out Matrix4x4 view, out Matrix4x4 proj)
    {
        view = Matrix4x4.Scale(new Vector3(1f, 1f, -1f)) * Matrix4x4.Inverse(Matrix4x4.TRS(s.CamPos, s.CamRot, Vector3.one));
        float aspect = (float)w / h;
        proj = TunerProjection(s.Fov, s.Ortho, aspect, s.Near, s.Far, s.OrthoClip);
    }

    static Matrix4x4 TunerProjection(float fov, float ortho, float aspect, float near, float far, bool orthoClip)
    {
        if (ortho <= 0f) return Matrix4x4.Perspective(fov, aspect, near, far);
        return orthoClip
            ? Matrix4x4.Ortho(-ortho * aspect, ortho * aspect, -ortho, ortho, near, far)
            : Matrix4x4.Ortho(-ortho * aspect, ortho * aspect, -ortho, ortho, -TUNER_ORTHO_DEPTH, TUNER_ORTHO_DEPTH);
    }

    static void LogTunerViewChange(TunerSession s, ref string last, string next)
    {
        if (next == last) return;
        last = next;
        if (next != null && SaturaDebug.On) Debug.LogFormat(LogType.Log, LogOption.NoStacktrace, null, "{0}", "[Tuner] " + s.Name + " " + next);
    }

    static string TunerMarkedNames(TunerSession s, TunerViewState v)
    {
        var sb = new StringBuilder();
        foreach (var go in v.Marked)
        {
            if (go == null) continue;
            if (sb.Length > 0) sb.Append(", ");
            sb.Append(TunerGameObjectPath(go));
        }
        return sb.ToString();
    }
}
