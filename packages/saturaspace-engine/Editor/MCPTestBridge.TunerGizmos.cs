using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    const string TUNER_GIZMO_CAMERA_NAME = "_SaturaTunerGizmoCamera";
    const string TUNER_GIZMO_HOOK_NAME = "_SaturaTunerGizmoHook";
    const double TUNER_GIZMO_INFO_INTERVAL = 2.0;
    const GizmoType TUNER_GIZMO_ALL = GizmoType.NonSelected | GizmoType.Selected | GizmoType.Active | GizmoType.InSelectionHierarchy
        | GizmoType.NotInSelectionHierarchy | GizmoType.Pickable;

    static readonly Color TunerColliderColor = new Color(145f / 255f, 244f / 255f, 139f / 255f, 192f / 255f);
    static readonly Color TunerColliderDisabledColor = new Color(145f / 255f, 244f / 255f, 139f / 255f, 96f / 255f);
    static readonly Color TunerAudioColor = new Color(0.50f, 0.70f, 1.00f, 0.5f);
    static readonly Color TunerCanvasRectColor = new Color(1f, 1f, 1f, 0.55f);
    static readonly Color TunerAudioDisabledColor = new Color(0.30f, 0.40f, 0.60f, 0.5f);
    static readonly Color TunerLightGizmoColor = new Color(254f / 255f, 253f / 255f, 136f / 255f, 128f / 255f);
    static readonly Color TunerLightGizmoDisabledColor = new Color(135f / 255f, 116f / 255f, 50f / 255f, 128f / 255f);
    static readonly Vector3[] TunerSunRays =
    {
        new Vector3(1, 0, 0), new Vector3(-1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, -1, 0),
        new Vector3(1, 1, 0).normalized, new Vector3(1, -1, 0).normalized, new Vector3(-1, 1, 0).normalized, new Vector3(-1, -1, 0).normalized
    };

    class TunerDrawGizmoMethod
    {
        public MethodInfo Method;
        public GizmoType Options;
        public string Note;
        public Action<Component, GizmoType> Call;
        public bool CallTried;
    }

    class TunerScriptGizmos
    {
        public MethodInfo Draw;
        public MethodInfo DrawSelected;
        public string DrawNote;
        public string SelectedNote;
        public Action<MonoBehaviour> DrawCall;
        public Action<MonoBehaviour> SelectedCall;
        public bool CallsTried;
    }

    class TunerGizmoInfoCache
    {
        public bool Gizmo = true;
        public bool Icon = true;
        public double At;
    }

    static Scene _tunerGizmoScene;
    static Camera _tunerGizmoCam;
    static GameObject _tunerGizmoHook;
    static TunerSession _tunerGizmoFor;
    static bool _tunerGizmoInHook;
    static bool _tunerGizmoWarned;
    static bool _tunerIconPatchTried;
    static int _tunerIconsSkipped;
    static Action<Camera> _tunerDoDrawGizmos;
    static bool _tunerDoDrawGizmosKnown;
    static object _tunerGuiState;
    static MethodInfo _tunerBeginContainer;
    static MethodInfo _tunerEndContainer;
    static bool _tunerGuiKnown;
    static MethodInfo _tunerConeHandle;
    static MethodInfo _tunerRectHandles;
    static bool _tunerLightHandlesKnown;
    static MethodInfo _tunerShapeToolGui;
    static MethodInfo _tunerForceFieldHandle;
    static bool _tunerParticleGuiKnown;
    static Dictionary<Type, List<TunerDrawGizmoMethod>> _tunerDrawGizmoByType;
    static readonly Dictionary<Type, List<TunerDrawGizmoMethod>> _tunerDrawGizmoFor = new Dictionary<Type, List<TunerDrawGizmoMethod>>();
    static readonly Dictionary<Type, TunerScriptGizmos> _tunerScriptGizmos = new Dictionary<Type, TunerScriptGizmos>();
    static readonly Dictionary<Type, TunerGizmoInfoCache> _tunerGizmoInfo = new Dictionary<Type, TunerGizmoInfoCache>();
    static readonly Dictionary<(Type, string), PropertyInfo> _tunerGizmoProps = new Dictionary<(Type, string), PropertyInfo>();
    static readonly Dictionary<(Type, string), bool> _tunerIsA = new Dictionary<(Type, string), bool>();
    static readonly Dictionary<Type, bool> _tunerGizmoRelevant = new Dictionary<Type, bool>();
    static readonly HashSet<string> _tunerGizmoThrew = new HashSet<string>();
    static readonly List<Component> _tunerGizmoComps = new List<Component>();
    static readonly List<Vector2> _tunerGizmoPath = new List<Vector2>();
    static readonly object[] _tunerGizmoArgs2 = new object[2];

    [InitializeOnLoadMethod]
    static void InitTunerGizmos()
    {
        if (Inert) return;
        AssemblyReloadEvents.beforeAssemblyReload += ReleaseTunerGizmoRig;
        EditorApplication.quitting += ReleaseTunerGizmoRig;
        SweepStaleTunerGizmoRigs();
    }

    static void SweepStaleTunerGizmoRigs()
    {
        try
        {
            var scenes = new List<Scene>();
            foreach (var cam in Resources.FindObjectsOfTypeAll<Camera>())
            {
                if (cam == null || (cam.name != TUNER_GIZMO_CAMERA_NAME && cam.name != TUNER_GIZMO_HOOK_NAME)) continue;
                var sc = cam.gameObject.scene;
                UnityEngine.Object.DestroyImmediate(cam.gameObject);
                if (sc.IsValid() && EditorSceneManager.IsPreviewScene(sc) && !scenes.Contains(sc)) scenes.Add(sc);
            }
            foreach (var sc in scenes) EditorSceneManager.ClosePreviewScene(sc);
        }
        catch { }
    }

    static void ReleaseTunerGizmoRig()
    {
        if (_tunerGizmoCam != null) UnityEngine.Object.DestroyImmediate(_tunerGizmoCam.gameObject);
        if (_tunerGizmoHook != null) UnityEngine.Object.DestroyImmediate(_tunerGizmoHook);
        _tunerGizmoCam = null;
        _tunerGizmoHook = null;
        if (_tunerGizmoScene.IsValid())
        {
            try { EditorSceneManager.ClosePreviewScene(_tunerGizmoScene); }
            catch { }
        }
        _tunerGizmoScene = default;
    }

    static GameObject NewTunerGizmoObject(string name)
    {
        var go = EditorUtility.CreateGameObjectWithHideFlags(name, HideFlags.DontSave | HideFlags.NotEditable, typeof(Camera));
        go.GetComponent<Camera>().enabled = false;
        SceneManager.MoveGameObjectToScene(go, _tunerGizmoScene);
        return go;
    }

    static bool EnsureTunerGizmoRig()
    {
        if (!_tunerDoDrawGizmosKnown)
        {
            _tunerDoDrawGizmosKnown = true;
            var m = typeof(Handles).GetMethod("Internal_DoDrawGizmos", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public, null, new[] { typeof(Camera) }, null);
            if (m != null) _tunerDoDrawGizmos = (Action<Camera>)Delegate.CreateDelegate(typeof(Action<Camera>), m);
            else Debug.LogWarning("[Tuner] Handles.Internal_DoDrawGizmos was not found, the Tuner draws no gizmos");
        }
        if (_tunerDoDrawGizmos == null) return false;
        if (_tunerGizmoCam != null && _tunerGizmoHook != null && _tunerGizmoScene.IsValid()) return true;
        ReleaseTunerGizmoRig();
        _tunerGizmoScene = EditorSceneManager.NewPreviewScene();
        var cgo = NewTunerGizmoObject(TUNER_GIZMO_CAMERA_NAME);
        _tunerGizmoCam = cgo.GetComponent<Camera>();
        _tunerGizmoCam.clearFlags = CameraClearFlags.Nothing;
        _tunerGizmoCam.cameraType = CameraType.SceneView;
        _tunerGizmoCam.scene = _tunerGizmoScene;
        _tunerGizmoHook = NewTunerGizmoObject(TUNER_GIZMO_HOOK_NAME);
        _tunerGizmoHookMisses = 0;
        SetTunerGizmosDirty();
        return true;
    }

    static Func<int> _tunerSetGizmosDirty;
    static bool _tunerSetGizmosDirtyKnown;
    static bool _tunerGizmoHookRan;
    static int _tunerGizmoHookMisses;

    static void SetTunerGizmosDirty()
    {
        if (!_tunerSetGizmosDirtyKnown)
        {
            _tunerSetGizmosDirtyKnown = true;
            var t = typeof(Editor).Assembly.GetType("UnityEditor.AnnotationUtility");
            var m = t != null ? t.GetMethod("SetGizmosDirty", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public, null, Type.EmptyTypes, null) : null;
            if (m != null && m.ReturnType == typeof(int)) _tunerSetGizmosDirty = (Func<int>)Delegate.CreateDelegate(typeof(Func<int>), m);
            else Debug.LogWarning("[Tuner] AnnotationUtility.SetGizmosDirty was not found, gizmos may stay hidden until Unity rebuilds its gizmo list");
        }
        if (_tunerSetGizmosDirty == null) return;
        try { _tunerSetGizmosDirty(); }
        catch { }
    }

    static bool EnsureTunerGuiState()
    {
        if (_tunerGuiKnown) return _tunerGuiState != null;
        _tunerGuiKnown = true;
        try
        {
            var t = typeof(GUIUtility).Assembly.GetType("UnityEngine.ObjectGUIState");
            const BindingFlags f = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
            _tunerBeginContainer = t != null ? typeof(GUIUtility).GetMethod("BeginContainer", f, null, new[] { t }, null) : null;
            _tunerEndContainer = typeof(GUIUtility).GetMethod("EndContainer", f, null, Type.EmptyTypes, null);
            if (t != null && _tunerBeginContainer != null && _tunerEndContainer != null) _tunerGuiState = Activator.CreateInstance(t, true);
        }
        catch (Exception e) { Debug.LogWarning("[Tuner] gizmos that draw with Handles are skipped: " + e.Message); }
        return _tunerGuiState != null;
    }

    static void DrawTunerGizmos(TunerSession s, double now)
    {
        long start = System.Diagnostics.Stopwatch.GetTimestamp();
        DrawTunerGizmosInner(s, now);
        var st = TunerViewOf(s, true).Stats;
        NoteTunerStat(ref st.Gizmos, ref st.GizmosMax, System.Diagnostics.Stopwatch.GetTimestamp() - start);
    }

    static bool _tunerGizmoBodyOn;

    static void DrawTunerGizmosInner(TunerSession s, double now)
    {
        var v = TunerViewOf(s, true);
        bool handles = TunerHandlesWanted(s, v, now);
        if (v.GizmosOff)
        {
            v.GizmoSigLogged = 0;
            LogTunerViewChange(s, ref v.GizmoReport, "gizmos: off");
            if (!handles) return;
        }
        var shown = TunerShownObjects(s, v, now);
        if ((shown.Count == 0 && !handles && !TunerHasUi(s)) || !EnsureTunerGizmoRig()) return;
        _tunerGizmoBodyOn = !v.GizmosOff;
        v.GizmoNoteGos.Clear();
        v.GizmoNotes.Clear();
        v.GizmoSig = TUNER_HASH_SEED;
        EnsureTunerIconPatch();
        var cam = _tunerGizmoCam;
        var fwd = s.CamRot * Vector3.forward;
        SetupTunerGizmoCamera(s);
        _tunerGizmoHook.transform.position = s.CamPos - fwd * (TUNER_ORTHO_DEPTH * 2f + 10f);
        _tunerIconsSkipped = 0;
        var prev = RenderTexture.active;
        _tunerGizmoFor = s;
        _tunerGizmoHookRan = false;
        try
        {
            RenderTexture.active = s.Target;
            _tunerDoDrawGizmos(cam);
        }
        catch (Exception e)
        {
            if (!_tunerGizmoWarned)
            {
                _tunerGizmoWarned = true;
                Debug.LogWarning("[Tuner] the gizmo pass failed: " + e.Message);
            }
        }
        finally
        {
            _tunerGizmoFor = null;
            cam.targetTexture = null;
            RenderTexture.active = prev;
        }
        if (!_tunerGizmoHookRan && _tunerGizmoHookMisses < 3)
        {
            _tunerGizmoHookMisses++;
            SaturaDebug.Log("[Tuner] " + s.Name + " gizmo hook was skipped by Unity's gizmo pass, rebuilding Unity's gizmo list");
            SetTunerGizmosDirty();
            s.Dirty = true;
            SignalEditorTick();
            return;
        }
        if (_tunerGizmoHookRan) _tunerGizmoHookMisses = 0;
        if (v.GizmosOff) return;
        v.GizmoSig = TunerMix(v.GizmoSig, (uint)_tunerIconsSkipped);
        if (v.GizmoReport != null && v.GizmoSig == v.GizmoSigLogged) return;
        v.GizmoSigLogged = v.GizmoSig;
        BuildTunerGizmoLog(v);
        if (_tunerIconsSkipped > 0) v.GizmoLog.Append(v.GizmoLog.Length == 0 ? "" : "; ").Append("icons skipped ").Append(_tunerIconsSkipped.ToString(Inv));
        LogTunerViewChange(s, ref v.GizmoReport, v.GizmoLog.Length == 0 ? "gizmos: none" : "gizmos: " + v.GizmoLog);
    }

    static void BuildTunerGizmoLog(TunerViewState v)
    {
        var sb = v.GizmoLog;
        sb.Length = 0;
        GameObject cur = null;
        for (int i = 0; i < v.GizmoNotes.Count; i++)
        {
            var go = v.GizmoNoteGos[i];
            if (i == 0 || !ReferenceEquals(go, cur))
            {
                if (i > 0) sb.Append("]; ");
                cur = go;
                sb.Append(go != null ? go.name : "?").Append('[');
            }
            else sb.Append(',');
            sb.Append(v.GizmoNotes[i]);
        }
        if (v.GizmoNotes.Count > 0) sb.Append(']');
        v.GizmoNoteGos.Clear();
        v.GizmoNotes.Clear();
    }

    static void EnsureTunerIconPatch()
    {
        if (_tunerIconPatchTried) return;
        _tunerIconPatchTried = true;
        try
        {
            var asm = FindHarmony();
            if (asm == null) throw new TypeLoadException("Harmony is not loaded");
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-icons");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var prefix = methodType.GetConstructor(new[] { typeof(MethodInfo) })
                .Invoke(new object[] { typeof(MCPTestBridge).GetMethod(nameof(TunerIconPrefix), BindingFlags.Static | BindingFlags.NonPublic) });
            int patched = 0;
            var failed = new List<string>();
            foreach (var m in typeof(Gizmos).GetMethods(BindingFlags.Static | BindingFlags.Public))
            {
                if (m.Name != "DrawIcon") continue;
                var args = new object[patch.GetParameters().Length];
                args[0] = m;
                args[1] = prefix;
                try
                {
                    patch.Invoke(harmony, args);
                    patched++;
                }
                catch (Exception e)
                {
                    var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
                    failed.Add(m.GetParameters().Length + " args: " + inner.Message);
                }
            }
            if (patched == 0) throw new MissingMethodException("Gizmos.DrawIcon " + string.Join("; ", failed));
            SaturaDebug.Log("[Tuner] Gizmos.DrawIcon is skipped inside the Tuner (" + patched + " overloads patched" + (failed.Count > 0 ? ", failed " + string.Join("; ", failed) : "") + ")");
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[Tuner] could not patch Gizmos.DrawIcon, so icons drawn in OnDrawGizmos may show in the Tuner: " + inner.Message);
        }
    }

    static bool TunerIconPrefix()
    {
        if (!_tunerGizmoInHook) return true;
        _tunerIconsSkipped++;
        return false;
    }

    [DrawGizmo(TUNER_GIZMO_ALL)]
    static void TunerGizmoHook(Camera c, GizmoType type)
    {
        var s = _tunerGizmoFor;
        if (s == null || _tunerGizmoInHook || c == null || _tunerGizmoHook == null || c.gameObject != _tunerGizmoHook) return;
        _tunerGizmoInHook = true;
        _tunerGizmoHookRan = true;
        bool gui = EnsureTunerGuiState();
        var prevEvent = Event.current;
        float prevPpp = 0f;
        var prevMatrix = GUI.matrix;
        int prevSkinMode = -1;
        try
        {
            if (gui)
            {
                EnsureTunerHandleReflection();
                if (_tunerPppProp != null)
                {
                    prevPpp = (float)_tunerPppProp.GetValue(null, null);
                    _tunerPppProp.SetValue(null, TunerHandlePpp(s), null);
                }
                _tunerBeginContainer.Invoke(null, new[] { _tunerGuiState });
                GUI.matrix = Matrix4x4.identity;
                prevSkinMode = SetTunerEditorSkin();
                Event.current = new Event { type = EventType.Repaint };
                Handles.SetCamera(_tunerGizmoCam);
            }
            if (_tunerGizmoBodyOn) DrawTunerGizmoBody(s);
            if (gui) DrawTunerHandlesRepaint(s);
        }
        catch (Exception e) { Debug.LogException(e); }
        finally
        {
            if (gui)
            {
                Event.current = prevEvent;
                GUI.matrix = prevMatrix;
                if (prevSkinMode >= 0) _tunerSetSkin(prevSkinMode);
                try { _tunerEndContainer.Invoke(null, null); }
                catch { }
                if (prevPpp > 0f) _tunerPppProp.SetValue(null, prevPpp, null);
            }
            _tunerGizmoInHook = false;
        }
    }

    static FieldInfo _tunerSkinModeField;
    static Action<int> _tunerSetSkin;
    static bool _tunerSkinKnown;

    static int SetTunerEditorSkin()
    {
        if (!_tunerSkinKnown)
        {
            _tunerSkinKnown = true;
            const BindingFlags f = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
            _tunerSkinModeField = typeof(GUIUtility).GetField("s_SkinMode", f);
            var m = typeof(GUIUtility).GetMethod("SetSkin", f, null, new[] { typeof(int) }, null);
            if (m != null) _tunerSetSkin = (Action<int>)Delegate.CreateDelegate(typeof(Action<int>), m);
            if (_tunerSkinModeField == null || _tunerSetSkin == null) Debug.LogWarning("[Tuner] GUIUtility skin internals were not found, gizmo labels may use the game's GUI skin in Play Mode");
        }
        if (_tunerSkinModeField == null || _tunerSetSkin == null || !TunerInGui()) return -1;
        int prev = (int)_tunerSkinModeField.GetValue(null);
        _tunerSetSkin(1);
        return prev;
    }

    static PropertyInfo _tunerGuiDepth;
    static FieldInfo _tunerStylesCache;
    static FieldInfo _tunerStylesFirst;
    static bool _tunerGuiDepthKnown;

    static void KnowTunerGui()
    {
        if (_tunerGuiDepthKnown) return;
        _tunerGuiDepthKnown = true;
        const BindingFlags f = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        _tunerGuiDepth = typeof(GUIUtility).GetProperty("guiDepth", f);
        _tunerStylesCache = typeof(EditorStyles).GetField("s_CachedStyles", f);
        _tunerStylesFirst = typeof(EditorStyles).GetField("m_ColorPickerBox", BindingFlags.Instance | BindingFlags.NonPublic);
    }

    static bool TunerInGui()
    {
        KnowTunerGui();
        if (_tunerGuiDepth == null) return false;
        try { return (int)_tunerGuiDepth.GetValue(null, null) > 0; }
        catch { return false; }
    }

    static void HealTunerEditorStyles()
    {
        KnowTunerGui();
        if (_tunerStylesCache == null || _tunerStylesFirst == null) return;
        try
        {
            var cache = _tunerStylesCache.GetValue(null) as Array;
            if (cache == null) return;
            for (int i = 0; i < cache.Length; i++)
            {
                var styles = cache.GetValue(i);
                if (styles == null || _tunerStylesFirst.GetValue(styles) != null) continue;
                cache.SetValue(null, i);
                SaturaDebug.Log("[Tuner] Unity's editor style cache " + i + " was built outside OnGUI and had no styles, so it will be rebuilt");
            }
        }
        catch (Exception e) { Debug.LogWarning("[Tuner] could not check Unity's editor style cache: " + e.Message); }
    }

    static void DrawTunerGizmoBody(TunerSession s)
    {
        var v = TunerViewOf(s, false);
        if (v == null) return;
        double now = EditorApplication.timeSinceStartup;
        var sel = ResolveTunerSelection(s, v, now);
        ResolveTunerMarked(s, v, now);
        var picked = v.SelectedSet;
        var shown = v.Shown;
        _tunerSynced2D = false;
        var anno = TunerAnnotations(now);
        float fadePx = anno.Fade ? anno.FadeSize * TUNER_FADE_PX_PER_UNIT : 0f;
        int faded = 0;
        string fadeNames = "";
        for (int i = 0; i < shown.Count; i++)
        {
            if (v.ShownComps[i].Length == 0) continue;
            var go = shown[i];
            if (go == null) continue;
            bool selected = go == sel || picked.Contains(go);
            bool inHierarchy = selected || v.SelectedTree.Contains(go);
            if (!inHierarchy && !v.ShownScript[i]) continue;
            if (!go.activeInHierarchy) continue;
            if (fadePx > 0f && !inHierarchy && TunerDrawsUnselected(v.ShownComps[i]) && TunerGizmoScreenPx(s, go) < fadePx)
            {
                if (faded < 4) fadeNames += (faded > 0 ? "," : "") + go.name;
                faded++;
                continue;
            }
            GizmoType state = selected ? GizmoType.Selected | (go == sel ? GizmoType.Active : 0) | GizmoType.InSelectionHierarchy
                : inHierarchy ? GizmoType.InSelectionHierarchy | GizmoType.NonSelected
                : GizmoType.NonSelected | GizmoType.NotInSelectionHierarchy;
            v.GizmoCur = go;
            foreach (var c in v.ShownComps[i])
            {
                if (c == null) continue;
                DrawTunerBuiltinGizmo(v, c, selected, inHierarchy, now);
                var mb = c as MonoBehaviour;
                if (mb != null) DrawTunerScriptGizmos(v, mb, inHierarchy, now);
                DrawTunerAttributeGizmos(v, c, state);
            }
        }
        v.GizmoCur = null;
        if (faded > 0)
        {
            v.GizmoCur = null;
            TunerGizmoNote(v, "faded " + faded.ToString(Inv) + " (" + fadeNames + ")");
        }
        if (TunerGizmoInfoOf(typeof(Canvas), now).Gizmo) DrawTunerCanvasRects(s, v);
        v.GizmoCur = sel;
        DrawTunerGizmoExtras(s, v, sel, now);
        v.GizmoCur = null;
        ResetTunerGizmoState();
    }

    const float TUNER_FADE_PX_PER_UNIT = 4f;

    static bool TunerDrawsUnselected(Component[] comps)
    {
        foreach (var c in comps)
        {
            if (c == null) continue;
            var t = c.GetType();
            if (c is MonoBehaviour && TunerScriptGizmosOf(t).Draw != null) return true;
            foreach (var dg in TunerDrawGizmoMethodsFor(t))
                if ((dg.Options & GizmoType.NonSelected) != 0) return true;
        }
        return false;
    }

    static float TunerGizmoScreenPx(TunerSession s, GameObject go)
    {
        Bounds b;
        var r = go.GetComponent<Renderer>();
        if (r != null && r.enabled) b = r.bounds;
        else
        {
            var col = go.GetComponent<Collider>();
            if (col != null && col.enabled) b = col.bounds;
            else
            {
                var col2 = go.GetComponent<Collider2D>();
                if (col2 != null && col2.enabled) b = col2.bounds;
                else if (!TunerBounds(go, out b)) return float.MaxValue;
            }
        }
        float diameter = b.size.magnitude;
        if (diameter <= 0f) return float.MaxValue;
        float h = Mathf.Max(1, s.Height);
        if (s.Ortho > 0f) return diameter * h / (2f * s.Ortho);
        float d = Vector3.Dot(b.center - s.CamPos, s.CamRot * Vector3.forward);
        if (d <= 1e-3f) return float.MaxValue;
        return diameter * h * 0.5f / (Mathf.Tan(s.Fov * 0.5f * Mathf.Deg2Rad) * d);
    }

    static void DrawTunerCanvasRects(TunerSession s, TunerViewState v)
    {
        TunerUiState ui;
        if (!_tunerUi.TryGetValue(s, out ui)) return;
        foreach (var root in ui.Roots)
        {
            if (root.Rect == null || root.Canvas == null || !root.Canvas.isActiveAndEnabled || TunerVisHidden(root.Canvas.gameObject)) continue;
            root.Rect.GetWorldCorners(_tunerUiCorners);
            ResetTunerGizmoState();
            Gizmos.color = TunerCanvasRectColor;
            for (int k = 0; k < 4; k++) Gizmos.DrawLine(_tunerUiCorners[k], _tunerUiCorners[(k + 1) % 4]);
            v.GizmoCur = root.Canvas.gameObject;
            TunerGizmoNote(v, "canvas:rect");
        }
        v.GizmoCur = null;
    }

    static void ResetTunerGizmoState()
    {
        Gizmos.matrix = Matrix4x4.identity;
        Gizmos.color = Color.white;
        Handles.matrix = Matrix4x4.identity;
        Handles.color = Color.white;
        Handles.zTest = UnityEngine.Rendering.CompareFunction.Always;
    }

    static void TunerGizmoNote(TunerViewState v, string what)
    {
        var go = v.GizmoCur;
        v.GizmoNoteGos.Add(go);
        v.GizmoNotes.Add(what);
        v.GizmoSig = TunerMix(TunerMix(v.GizmoSig, go != null ? (uint)go.GetHashCode() : 0u), (uint)what.GetHashCode());
    }

    static TunerGizmoInfoCache TunerGizmoInfoOf(Type t, double now)
    {
        TunerGizmoInfoCache c;
        if (_tunerGizmoInfo.TryGetValue(t, out c) && now - c.At < TUNER_GIZMO_INFO_INTERVAL) return c;
        if (c == null)
        {
            c = new TunerGizmoInfoCache();
            _tunerGizmoInfo[t] = c;
        }
        c.At = now;
        c.Gizmo = true;
        c.Icon = true;
        try
        {
            GizmoInfo info;
            if (GizmoUtility.TryGetGizmoInfo(t, out info))
            {
                c.Gizmo = !info.hasGizmo || info.gizmoEnabled;
                c.Icon = !info.hasIcon || info.iconEnabled;
            }
        }
        catch { }
        return c;
    }

    static bool TunerHasScriptGizmos(Component[] comps)
    {
        foreach (var c in comps)
        {
            var mb = c as MonoBehaviour;
            if (mb == null) continue;
            var sg = TunerScriptGizmosOf(mb.GetType());
            if (sg.Draw != null || sg.DrawSelected != null || TunerDrawGizmoMethodsFor(mb.GetType()).Count > 0) return true;
        }
        return false;
    }

    static TunerScriptGizmos TunerScriptGizmosOf(Type t)
    {
        TunerScriptGizmos sg;
        if (_tunerScriptGizmos.TryGetValue(t, out sg)) return sg;
        sg = new TunerScriptGizmos
        {
            Draw = TunerFindMessage(t, "OnDrawGizmos"),
            DrawSelected = TunerFindMessage(t, "OnDrawGizmosSelected"),
            DrawNote = t.Name + ".OnDrawGizmos",
            SelectedNote = t.Name + ".OnDrawGizmosSelected"
        };
        _tunerScriptGizmos[t] = sg;
        return sg;
    }

    static MethodInfo TunerFindMessage(Type t, string name)
    {
        for (var cur = t; cur != null && cur != typeof(MonoBehaviour); cur = cur.BaseType)
        {
            var m = cur.GetMethod(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly, null, Type.EmptyTypes, null);
            if (m != null) return m;
        }
        return null;
    }

    static void InvokeTunerGizmo(MethodInfo m, object target, object[] args)
    {
        ResetTunerGizmoState();
        try { m.Invoke(target, args); }
        catch (TargetInvocationException e)
        {
            var key = m.DeclaringType.FullName + "." + m.Name;
            if (_tunerGizmoThrew.Add(key)) Debug.LogException(e.InnerException ?? e);
        }
        catch (Exception e)
        {
            var key = m.DeclaringType.FullName + "." + m.Name;
            if (_tunerGizmoThrew.Add(key)) Debug.LogException(e);
        }
    }

    static void DrawTunerScriptGizmos(TunerViewState v, MonoBehaviour mb, bool inHierarchy, double now)
    {
        var t = mb.GetType();
        var info = TunerGizmoInfoOf(t, now);
        var sg = TunerScriptGizmosOf(t);
        if (sg.Draw == null && (sg.DrawSelected == null || !inHierarchy)) return;
        if (!info.Gizmo) return;
        if (!sg.CallsTried)
        {
            sg.CallsTried = true;
            sg.DrawCall = TunerScriptGizmoCall(sg.Draw);
            sg.SelectedCall = TunerScriptGizmoCall(sg.DrawSelected);
        }
        if (sg.Draw != null)
        {
            CallTunerScriptGizmo(sg.Draw, ref sg.DrawCall, mb);
            TunerGizmoNote(v, sg.DrawNote);
        }
        if (sg.DrawSelected != null && inHierarchy)
        {
            CallTunerScriptGizmo(sg.DrawSelected, ref sg.SelectedCall, mb);
            TunerGizmoNote(v, sg.SelectedNote);
        }
    }

    static List<TunerDrawGizmoMethod> TunerDrawGizmoMethodsFor(Type t)
    {
        List<TunerDrawGizmoMethod> list;
        if (_tunerDrawGizmoFor.TryGetValue(t, out list)) return list;
        if (_tunerDrawGizmoByType == null)
        {
            _tunerDrawGizmoByType = new Dictionary<Type, List<TunerDrawGizmoMethod>>();
            foreach (var m in TypeCache.GetMethodsWithAttribute<DrawGizmo>())
            {
                if (!m.IsStatic || m.DeclaringType == typeof(MCPTestBridge)) continue;
                var ps = m.GetParameters();
                if (ps.Length != 2 || ps[1].ParameterType != typeof(GizmoType)) continue;
                foreach (DrawGizmo attr in m.GetCustomAttributes(typeof(DrawGizmo), false))
                {
                    var drawn = attr.drawnType ?? ps[0].ParameterType;
                    if (drawn == null || !typeof(Component).IsAssignableFrom(drawn) || !ps[0].ParameterType.IsAssignableFrom(drawn)) continue;
                    List<TunerDrawGizmoMethod> bucket;
                    if (!_tunerDrawGizmoByType.TryGetValue(drawn, out bucket)) _tunerDrawGizmoByType[drawn] = bucket = new List<TunerDrawGizmoMethod>();
                    bucket.Add(new TunerDrawGizmoMethod { Method = m, Options = attr.drawOptions });
                }
            }
        }
        list = new List<TunerDrawGizmoMethod>();
        for (var cur = t; cur != null && cur != typeof(Component); cur = cur.BaseType)
        {
            List<TunerDrawGizmoMethod> bucket;
            if (_tunerDrawGizmoByType.TryGetValue(cur, out bucket)) list.AddRange(bucket);
        }
        _tunerDrawGizmoFor[t] = list;
        return list;
    }

    static void DrawTunerAttributeGizmos(TunerViewState v, Component c, GizmoType state)
    {
        var list = TunerDrawGizmoMethodsFor(c.GetType());
        if (list.Count == 0) return;
        if (!TunerGizmoInfoOf(c.GetType(), EditorApplication.timeSinceStartup).Gizmo) return;
        foreach (var dg in list)
        {
            if ((dg.Options & state) == 0) continue;
            if (!dg.CallTried)
            {
                dg.CallTried = true;
                dg.Call = TunerDrawGizmoCall(dg.Method);
                dg.Note = dg.Method.DeclaringType.Name + "." + dg.Method.Name;
            }
            if (dg.Call != null)
            {
                ResetTunerGizmoState();
                try { dg.Call(c, state); }
                catch (MethodAccessException)
                {
                    dg.Call = null;
                    InvokeTunerAttributeGizmo(dg, c, state);
                }
                catch (Exception e) { NoteTunerGizmoThrew(dg.Method, e); }
            }
            else InvokeTunerAttributeGizmo(dg, c, state);
            TunerGizmoNote(v, dg.Note);
        }
    }

    static void InvokeTunerAttributeGizmo(TunerDrawGizmoMethod dg, Component c, GizmoType state)
    {
        _tunerGizmoArgs2[0] = c;
        _tunerGizmoArgs2[1] = state;
        InvokeTunerGizmo(dg.Method, null, _tunerGizmoArgs2);
        _tunerGizmoArgs2[0] = null;
    }

    static void CallTunerScriptGizmo(MethodInfo m, ref Action<MonoBehaviour> call, MonoBehaviour mb)
    {
        if (call == null)
        {
            InvokeTunerGizmo(m, mb, null);
            return;
        }
        ResetTunerGizmoState();
        try { call(mb); }
        catch (MethodAccessException)
        {
            call = null;
            InvokeTunerGizmo(m, mb, null);
        }
        catch (Exception e) { NoteTunerGizmoThrew(m, e); }
    }

    static void NoteTunerGizmoThrew(MethodInfo m, Exception e)
    {
        if (_tunerGizmoThrew.Add(m.DeclaringType.FullName + "." + m.Name)) Debug.LogException(e);
    }

    static Action<Component, GizmoType> TunerDrawGizmoCall(MethodInfo m)
    {
        try
        {
            var ps = m.GetParameters();
            if (!m.IsStatic || ps.Length != 2 || ps[1].ParameterType != typeof(GizmoType)) return null;
            var c = Expression.Parameter(typeof(Component));
            var g = Expression.Parameter(typeof(GizmoType));
            return Expression.Lambda<Action<Component, GizmoType>>(Expression.Call(m, Expression.Convert(c, ps[0].ParameterType), g), c, g).Compile();
        }
        catch { return null; }
    }

    static Action<MonoBehaviour> TunerScriptGizmoCall(MethodInfo m)
    {
        if (m == null || m.IsStatic || m.DeclaringType.IsGenericTypeDefinition) return null;
        try
        {
            var p = Expression.Parameter(typeof(MonoBehaviour));
            return Expression.Lambda<Action<MonoBehaviour>>(Expression.Call(Expression.Convert(p, m.DeclaringType), m), p).Compile();
        }
        catch { return null; }
    }

    static T TunerGizmoProp<T>(Component c, string name, T fallback)
    {
        var t = c.GetType();
        var key = (t, name);
        PropertyInfo p;
        if (!_tunerGizmoProps.TryGetValue(key, out p))
        {
            p = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public);
            _tunerGizmoProps[key] = p;
        }
        if (p == null) return fallback;
        try
        {
            var o = p.GetValue(c, null);
            return o is T ? (T)o : fallback;
        }
        catch { return fallback; }
    }

    static void NoteTunerGizmoDirty(TunerViewState v, Component c)
    {
        int count = EditorUtility.GetDirtyCount(c);
        int seen;
        if (v.GizmoDirty.TryGetValue(c, out seen) && seen == count) return;
        if (v.GizmoDirty.ContainsKey(c)) v.GizmoDirtyGen++;
        v.GizmoDirty[c] = count;
    }

    static bool TunerGizmoScripted(Type t)
    {
        if (TunerDrawGizmoMethodsFor(t).Count > 0) return true;
        if (!typeof(MonoBehaviour).IsAssignableFrom(t)) return false;
        var sg = TunerScriptGizmosOf(t);
        return sg.Draw != null || sg.DrawSelected != null;
    }

    static bool TunerGizmoRelevant(Type t)
    {
        bool r;
        if (_tunerGizmoRelevant.TryGetValue(t, out r)) return r;
        r = typeof(Light).IsAssignableFrom(t) || typeof(Camera).IsAssignableFrom(t) || typeof(ParticleSystem).IsAssignableFrom(t)
            || typeof(ParticleSystemForceField).IsAssignableFrom(t) || TunerIsA(t, "UnityEngine.Collider") || TunerIsA(t, "UnityEngine.Collider2D")
            || TunerIsA(t, "UnityEngine.AudioSource") || TunerDrawGizmoMethodsFor(t).Count > 0;
        if (!r && typeof(MonoBehaviour).IsAssignableFrom(t))
        {
            var sg = TunerScriptGizmosOf(t);
            r = sg.Draw != null || sg.DrawSelected != null;
        }
        _tunerGizmoRelevant[t] = r;
        return r;
    }

    static bool TunerIsA(Type t, string fullName)
    {
        bool hit;
        if (_tunerIsA.TryGetValue((t, fullName), out hit)) return hit;
        for (var cur = t; cur != null && cur != typeof(Component) && !hit; cur = cur.BaseType)
            hit = cur.FullName == fullName;
        _tunerIsA[(t, fullName)] = hit;
        return hit;
    }

    static void DrawTunerBuiltinGizmo(TunerViewState v, Component c, bool selected, bool inHierarchy, double now)
    {
        var t = c.GetType();
        var light = c as Light;
        var info = TunerGizmoInfoOf(t, now);
        if (!info.Gizmo || !inHierarchy) return;
        if (TunerIsA(t, "UnityEngine.Collider"))
        {
            if (DrawTunerCollider(c)) TunerGizmoNote(v, "collider:" + t.Name);
            return;
        }
        if (TunerIsA(t, "UnityEngine.Collider2D"))
        {
            if (DrawTunerCollider2D(c)) TunerGizmoNote(v, "collider:" + t.Name);
            return;
        }
        if (TunerIsA(t, "UnityEngine.AudioSource"))
        {
            ResetTunerGizmoState();
            bool on = TunerGizmoProp(c, "enabled", true);
            Gizmos.color = on ? TunerAudioColor : TunerAudioDisabledColor;
            var p = c.transform.position;
            Gizmos.DrawWireSphere(p, TunerGizmoProp(c, "minDistance", 1f));
            Gizmos.DrawWireSphere(p, TunerGizmoProp(c, "maxDistance", 500f));
            TunerGizmoNote(v, "audio:range");
            return;
        }
        if (!selected) return;
        if (TunerIsA(t, "UnityEngine.Rendering.Universal.Light2D"))
        {
            if (DrawTunerLight2DShape(c)) TunerGizmoNote(v, "light2d:shape");
            return;
        }
        var ps = c as ParticleSystem;
        if (ps != null)
        {
            if (DrawTunerParticleShape(ps)) TunerGizmoNote(v, "particles:shape:" + ps.shape.shapeType + (ps.shape.enabled ? "" : "(module off)"));
            return;
        }
        var ff = c as ParticleSystemForceField;
        if (ff != null)
        {
            if (DrawTunerForceField(ff)) TunerGizmoNote(v, "forcefield:" + ff.shape);
            return;
        }
        if (light != null)
        {
            DrawTunerLightShape(light);
            TunerGizmoNote(v, "light:" + light.type);
            return;
        }
        var cam = c as Camera;
        if (cam != null && cam != _tunerGizmoCam)
        {
            ResetTunerGizmoState();
            try
            {
                CameraEditorUtils.DrawFrustumGizmo(cam);
                TunerGizmoNote(v, "camera:frustum");
            }
            catch (Exception e)
            {
                if (_tunerGizmoThrew.Add("frustum")) Debug.LogWarning("[Tuner] could not draw a camera frustum: " + e.Message);
            }
        }
    }

    static MethodInfo _tunerLight2DFalloff;

    static bool DrawTunerLight2DShape(Component c)
    {
        ResetTunerGizmoState();
        var tr = c.transform;
        var kind = TunerGizmoProp<object>(c, "lightType", null);
        var name = kind != null ? kind.ToString() : "";
        Gizmos.color = Color.white;
        if (name == "Freeform")
        {
            if (_tunerLight2DFalloff == null) _tunerLight2DFalloff = c.GetType().GetMethod("GetFalloffShape", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
            bool any = false;
            if (_tunerLight2DFalloff != null)
            {
                List<Vector2> falloff = null;
                try { falloff = _tunerLight2DFalloff.Invoke(c, null) as List<Vector2>; }
                catch { }
                if (falloff != null && falloff.Count > 1)
                {
                    for (int i = 0; i < falloff.Count; i++) Gizmos.DrawLine(tr.TransformPoint(falloff[i]), tr.TransformPoint(falloff[(i + 1) % falloff.Count]));
                    any = true;
                }
            }
            var path = TunerGizmoProp<Vector3[]>(c, "shapePath", null);
            if (path != null && path.Length > 1)
            {
                for (int i = 0; i < path.Length; i++) Gizmos.DrawLine(tr.TransformPoint(path[i]), tr.TransformPoint(path[(i + 1) % path.Length]));
                any = true;
            }
            return any;
        }
        if (name == "Sprite")
        {
            var sprite = TunerGizmoProp<Sprite>(c, "lightCookieSprite", null);
            if (sprite == null) return false;
            var min = sprite.bounds.min;
            var max = sprite.bounds.max;
            var p0 = tr.TransformPoint(new Vector3(min.x, min.y));
            var p1 = tr.TransformPoint(new Vector3(max.x, min.y));
            var p2 = tr.TransformPoint(new Vector3(max.x, max.y));
            var p3 = tr.TransformPoint(new Vector3(min.x, max.y));
            Gizmos.DrawLine(p0, p1);
            Gizmos.DrawLine(p1, p2);
            Gizmos.DrawLine(p2, p3);
            Gizmos.DrawLine(p3, p0);
            return true;
        }
        return false;
    }

    static bool DrawTunerCollider(Component c)
    {
        ResetTunerGizmoState();
        var tr = c.transform;
        Gizmos.color = TunerGizmoProp(c, "enabled", true) ? TunerColliderColor : TunerColliderDisabledColor;
        var scale = tr.lossyScale;
        switch (c.GetType().FullName)
        {
            case "UnityEngine.BoxCollider":
                Gizmos.matrix = tr.localToWorldMatrix;
                Gizmos.DrawWireCube(TunerGizmoProp(c, "center", Vector3.zero), TunerGizmoProp(c, "size", Vector3.one));
                return true;
            case "UnityEngine.SphereCollider":
            {
                var r = TunerGizmoProp(c, "radius", 0.5f) * Mathf.Max(Mathf.Abs(scale.x), Mathf.Abs(scale.y), Mathf.Abs(scale.z));
                Gizmos.matrix = Matrix4x4.TRS(tr.TransformPoint(TunerGizmoProp(c, "center", Vector3.zero)), tr.rotation, Vector3.one);
                Gizmos.DrawWireSphere(Vector3.zero, r);
                return true;
            }
            case "UnityEngine.CapsuleCollider":
                DrawTunerCapsule(tr, TunerGizmoProp(c, "center", Vector3.zero), TunerGizmoProp(c, "radius", 0.5f), TunerGizmoProp(c, "height", 2f), TunerGizmoProp(c, "direction", 1));
                return true;
            case "UnityEngine.CharacterController":
                DrawTunerCapsule(tr, TunerGizmoProp(c, "center", Vector3.zero), TunerGizmoProp(c, "radius", 0.5f), TunerGizmoProp(c, "height", 2f), 1);
                return true;
            case "UnityEngine.MeshCollider":
            {
                var mesh = TunerGizmoProp<Mesh>(c, "sharedMesh", null);
                if (mesh == null) return false;
                Gizmos.matrix = tr.localToWorldMatrix;
                Gizmos.DrawWireMesh(mesh);
                return true;
            }
            case "UnityEngine.WheelCollider":
            {
                var r = TunerGizmoProp(c, "radius", 0.5f) * Mathf.Abs(scale.y);
                Gizmos.matrix = Matrix4x4.TRS(tr.TransformPoint(TunerGizmoProp(c, "center", Vector3.zero)), tr.rotation * Quaternion.Euler(0f, 90f, 0f), Vector3.one);
                TunerGizmoCircle(Vector3.zero, Vector3.right, Vector3.up, r);
                return true;
            }
        }
        return false;
    }

    static void TunerGizmoArc(Vector3 center, Vector3 u, Vector3 w, float r, float from, float to)
    {
        const int steps = 24;
        var prev = center + (u * Mathf.Cos(from) + w * Mathf.Sin(from)) * r;
        for (int i = 1; i <= steps; i++)
        {
            float a = Mathf.Lerp(from, to, (float)i / steps);
            var p = center + (u * Mathf.Cos(a) + w * Mathf.Sin(a)) * r;
            Gizmos.DrawLine(prev, p);
            prev = p;
        }
    }

    static void TunerGizmoCircle(Vector3 center, Vector3 u, Vector3 w, float r)
    {
        TunerGizmoArc(center, u, w, r, 0f, Mathf.PI * 2f);
    }

    static void DrawTunerCapsule(Transform tr, Vector3 center, float radius, float height, int direction)
    {
        var s = tr.lossyScale;
        var abs = new Vector3(Mathf.Abs(s.x), Mathf.Abs(s.y), Mathf.Abs(s.z));
        float axis = direction == 0 ? abs.x : direction == 2 ? abs.z : abs.y;
        float side = direction == 0 ? Mathf.Max(abs.y, abs.z) : direction == 2 ? Mathf.Max(abs.x, abs.y) : Mathf.Max(abs.x, abs.z);
        float r = radius * side;
        float half = Mathf.Max(height * axis * 0.5f - r, 0f);
        var align = direction == 0 ? Quaternion.Euler(0f, 0f, 90f) : direction == 2 ? Quaternion.Euler(90f, 0f, 0f) : Quaternion.identity;
        Gizmos.matrix = Matrix4x4.TRS(tr.TransformPoint(center), tr.rotation * align, Vector3.one);
        var top = Vector3.up * half;
        var bottom = -top;
        TunerGizmoCircle(top, Vector3.right, Vector3.forward, r);
        TunerGizmoCircle(bottom, Vector3.right, Vector3.forward, r);
        foreach (var d in new[] { Vector3.right, Vector3.left, Vector3.forward, Vector3.back })
            Gizmos.DrawLine(top + d * r, bottom + d * r);
        TunerGizmoArc(top, Vector3.right, Vector3.up, r, 0f, Mathf.PI);
        TunerGizmoArc(top, Vector3.forward, Vector3.up, r, 0f, Mathf.PI);
        TunerGizmoArc(bottom, Vector3.right, Vector3.up, r, Mathf.PI, Mathf.PI * 2f);
        TunerGizmoArc(bottom, Vector3.forward, Vector3.up, r, Mathf.PI, Mathf.PI * 2f);
    }

    static void TunerGizmoPolyline(List<Vector2> pts, Vector2 offset, bool closed)
    {
        for (int i = 1; i < pts.Count; i++) Gizmos.DrawLine(pts[i - 1] + offset, pts[i] + offset);
        if (closed && pts.Count > 2) Gizmos.DrawLine(pts[pts.Count - 1] + offset, pts[0] + offset);
    }

    static void DrawTunerCapsule2D(Vector2 a, Vector2 b, float r)
    {
        var d = b - a;
        if (d.sqrMagnitude < 1e-12f)
        {
            TunerGizmoCircle(a, Vector3.right, Vector3.up, r);
            return;
        }
        Vector3 dir = d.normalized;
        var n = new Vector3(-dir.y, dir.x, 0f);
        Vector3 p = a, q = b;
        Gizmos.DrawLine(p + n * r, q + n * r);
        Gizmos.DrawLine(p - n * r, q - n * r);
        TunerGizmoArc(q, dir, n, r, -Mathf.PI * 0.5f, Mathf.PI * 0.5f);
        TunerGizmoArc(p, -dir, n, r, -Mathf.PI * 0.5f, Mathf.PI * 0.5f);
    }

    static bool _tunerShapesKnown;
    static MethodInfo _tunerGetShapes;
    static MethodInfo _tunerShapeData;
    static MethodInfo _tunerSync2D;
    static PropertyInfo _tunerShapeL2W;
    static PropertyInfo _tunerShapeType;
    static PropertyInfo _tunerShapeRadius;
    static PropertyInfo _tunerShapeStart;
    static PropertyInfo _tunerShapeCount;
    static object _tunerShapeGroup;
    static System.Collections.IList _tunerShapeList;
    static readonly List<Vector2> _tunerShapeVerts = new List<Vector2>();
    static readonly object[] _tunerShapeArgs1 = new object[1];
    static readonly object[] _tunerShapeArgs2 = new object[2];
    static bool _tunerSynced2D;

    static bool EnsureTunerShapes(Type colliderType)
    {
        if (_tunerShapesKnown) return _tunerGetShapes != null;
        _tunerShapesKnown = true;
        try
        {
            var asm = colliderType.Assembly;
            var groupT = asm.GetType("UnityEngine.PhysicsShapeGroup2D");
            var shapeT = asm.GetType("UnityEngine.PhysicsShape2D");
            var collT = asm.GetType("UnityEngine.Collider2D");
            if (groupT == null || shapeT == null || collT == null) return false;
            var listT = typeof(List<>).MakeGenericType(shapeT);
            _tunerShapeData = groupT.GetMethod("GetShapeData", new[] { listT, typeof(List<Vector2>) });
            _tunerShapeL2W = groupT.GetProperty("localToWorldMatrix");
            _tunerShapeType = shapeT.GetProperty("shapeType");
            _tunerShapeRadius = shapeT.GetProperty("radius");
            _tunerShapeStart = shapeT.GetProperty("vertexStartIndex");
            _tunerShapeCount = shapeT.GetProperty("vertexCount");
            _tunerSync2D = asm.GetType("UnityEngine.Physics2D")?.GetMethod("SyncTransforms", BindingFlags.Static | BindingFlags.Public, null, Type.EmptyTypes, null);
            var get = collT.GetMethod("GetShapes", new[] { groupT });
            if (_tunerShapeData == null || _tunerShapeL2W == null || _tunerShapeType == null || _tunerShapeRadius == null || _tunerShapeStart == null
                || _tunerShapeCount == null || get == null) return false;
            _tunerShapeGroup = Activator.CreateInstance(groupT, 4, 32);
            _tunerShapeList = (System.Collections.IList)Activator.CreateInstance(listT);
            _tunerGetShapes = get;
        }
        catch (Exception e) { Debug.LogWarning("[Tuner] 2D collider gizmos fall back to the collider properties: " + e.Message); }
        return _tunerGetShapes != null;
    }

    static bool TunerUsedByComposite(Component c)
    {
        var op = TunerGizmoProp<object>(c, "compositeOperation", null);
        if (op != null) return Convert.ToInt32(op) != 0;
        return TunerGizmoProp(c, "usedByComposite", false);
    }

    static int DrawTunerCollider2DShapes(Component c)
    {
        if (!EnsureTunerShapes(c.GetType())) return -1;
        if (!EditorApplication.isPlaying && _tunerSync2D != null && !_tunerSynced2D)
        {
            _tunerSynced2D = true;
            try { _tunerSync2D.Invoke(null, null); }
            catch { }
        }
        int n;
        try
        {
            _tunerShapeArgs1[0] = _tunerShapeGroup;
            n = (int)_tunerGetShapes.Invoke(c, _tunerShapeArgs1);
            if (n <= 0) return 0;
            _tunerShapeList.Clear();
            _tunerShapeVerts.Clear();
            _tunerShapeArgs2[0] = _tunerShapeList;
            _tunerShapeArgs2[1] = _tunerShapeVerts;
            _tunerShapeData.Invoke(_tunerShapeGroup, _tunerShapeArgs2);
            Gizmos.matrix = (Matrix4x4)_tunerShapeL2W.GetValue(_tunerShapeGroup, null);
        }
        catch { return -1; }
        var v = _tunerShapeVerts;
        foreach (var sh in _tunerShapeList)
        {
            int type = Convert.ToInt32(_tunerShapeType.GetValue(sh, null));
            float r = (float)_tunerShapeRadius.GetValue(sh, null);
            int start = (int)_tunerShapeStart.GetValue(sh, null);
            int count = (int)_tunerShapeCount.GetValue(sh, null);
            if (start < 0 || count <= 0 || start + count > v.Count) continue;
            switch (type)
            {
                case 0:
                    TunerGizmoCircle(v[start], Vector3.right, Vector3.up, r);
                    break;
                case 1:
                    if (count >= 2) DrawTunerCapsule2D(v[start], v[start + 1], r);
                    break;
                case 2:
                    for (int i = 0; i < count; i++) Gizmos.DrawLine(v[start + i], v[start + (i + 1) % count]);
                    break;
                default:
                    for (int i = 1; i < count; i++) Gizmos.DrawLine(v[start + i - 1], v[start + i]);
                    break;
            }
        }
        return n;
    }

    static bool DrawTunerCollider2D(Component c)
    {
        ResetTunerGizmoState();
        var tr = c.transform;
        bool on = TunerGizmoProp(c, "enabled", true);
        Gizmos.color = on ? TunerColliderColor : TunerColliderDisabledColor;
        if (on)
        {
            int drawn = DrawTunerCollider2DShapes(c);
            if (drawn > 0) return true;
            if (drawn == 0 && TunerUsedByComposite(c)) return false;
            ResetTunerGizmoState();
            Gizmos.color = TunerColliderColor;
        }
        Gizmos.matrix = tr.localToWorldMatrix;
        var offset = TunerGizmoProp(c, "offset", Vector2.zero);
        var pts = _tunerGizmoPath;
        pts.Clear();
        switch (c.GetType().FullName)
        {
            case "UnityEngine.BoxCollider2D":
            {
                var half = TunerGizmoProp(c, "size", Vector2.one) * 0.5f;
                pts.Add(new Vector2(-half.x, -half.y));
                pts.Add(new Vector2(-half.x, half.y));
                pts.Add(new Vector2(half.x, half.y));
                pts.Add(new Vector2(half.x, -half.y));
                TunerGizmoPolyline(pts, offset, true);
                return true;
            }
            case "UnityEngine.CircleCollider2D":
            {
                var s = tr.lossyScale;
                float k = Mathf.Max(Mathf.Abs(s.x), Mathf.Abs(s.y));
                float r = TunerGizmoProp(c, "radius", 0.5f) * k;
                Gizmos.matrix = Matrix4x4.TRS(tr.TransformPoint(offset), tr.rotation, Vector3.one);
                TunerGizmoCircle(Vector3.zero, Vector3.right, Vector3.up, r);
                return true;
            }
            case "UnityEngine.CapsuleCollider2D":
            {
                var ls = tr.lossyScale;
                var size = Vector2.Scale(TunerGizmoProp(c, "size", Vector2.one), new Vector2(Mathf.Abs(ls.x), Mathf.Abs(ls.y)));
                bool horizontal = Convert.ToInt32(TunerGizmoProp<object>(c, "direction", 0)) == 1;
                float r = (horizontal ? size.y : size.x) * 0.5f;
                float half = Mathf.Max((horizontal ? size.x : size.y) * 0.5f - r, 0f);
                Gizmos.matrix = Matrix4x4.TRS(tr.TransformPoint(offset), tr.rotation, Vector3.one);
                DrawTunerCapsule2D(horizontal ? new Vector2(-half, 0f) : new Vector2(0f, -half), horizontal ? new Vector2(half, 0f) : new Vector2(0f, half), r);
                return true;
            }
            case "UnityEngine.EdgeCollider2D":
            {
                var arr = TunerGizmoProp<Vector2[]>(c, "points", null);
                if (arr == null) return false;
                pts.AddRange(arr);
                TunerGizmoPolyline(pts, offset, false);
                return true;
            }
            default:
            {
                int paths = TunerGizmoProp(c, "pathCount", 0);
                if (paths <= 0) return false;
                var get = c.GetType().GetMethod("GetPath", new[] { typeof(int), typeof(List<Vector2>) });
                if (get == null) return false;
                bool composite = c.GetType().FullName == "UnityEngine.CompositeCollider2D";
                for (int i = 0; i < paths; i++)
                {
                    pts.Clear();
                    get.Invoke(c, new object[] { i, pts });
                    TunerGizmoPolyline(pts, composite ? Vector2.zero : offset, true);
                }
                return true;
            }
        }
    }

    static void EnsureTunerParticleGui()
    {
        if (_tunerParticleGuiKnown) return;
        _tunerParticleGuiKnown = true;
        const BindingFlags f = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        var asm = typeof(Editor).Assembly;
        _tunerShapeToolGui = asm.GetType("UnityEditor.ShapeModuleUI")?.GetMethod("OnShapeToolGUI", f, null, new[] { typeof(bool), typeof(IEnumerable<UnityEngine.Object>) }, null);
        _tunerForceFieldHandle = asm.GetType("UnityEditor.ParticleSystemForceFieldInspector")?.GetMethod("DrawHandle", f, null, new[] { typeof(ParticleSystemForceField) }, null);
        if (_tunerShapeToolGui == null) Debug.LogWarning("[Tuner] ShapeModuleUI.OnShapeToolGUI is missing, so particle shapes stay hidden in the Tuner");
        if (_tunerForceFieldHandle == null) Debug.LogWarning("[Tuner] ParticleSystemForceFieldInspector.DrawHandle is missing, so force field shapes stay hidden in the Tuner");
    }

    static bool DrawTunerParticleShape(ParticleSystem ps)
    {
        EnsureTunerParticleGui();
        if (_tunerShapeToolGui == null) return false;
        ResetTunerGizmoState();
        try
        {
            _tunerShapeToolGui.Invoke(null, new object[] { false, new UnityEngine.Object[] { ps } });
            return true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            if (_tunerGizmoThrew.Add("shape:" + inner.GetType().Name)) Debug.LogWarning("[Tuner] could not draw a particle shape: " + inner.Message);
            return false;
        }
        finally { ResetTunerGizmoState(); }
    }

    static bool DrawTunerForceField(ParticleSystemForceField ff)
    {
        EnsureTunerParticleGui();
        if (_tunerForceFieldHandle == null) return false;
        ResetTunerGizmoState();
        try
        {
            _tunerForceFieldHandle.Invoke(null, new object[] { ff });
            return true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            if (_tunerGizmoThrew.Add("forcefield:" + inner.GetType().Name)) Debug.LogWarning("[Tuner] could not draw a force field shape: " + inner.Message);
            return false;
        }
        finally { ResetTunerGizmoState(); }
    }

    static ulong MixTunerParticleGizmos(GameObject go, ulong h)
    {
        if (go == null) return h;
        var ps = go.GetComponent<ParticleSystem>();
        if (ps != null)
        {
            var sh = ps.shape;
            var main = ps.main;
            h = TunerMix(h, (uint)sh.shapeType);
            h = TunerMix(h, sh.enabled ? 1u : 0u);
            h = TunerMix(h, sh.radius);
            h = TunerMix(h, sh.radiusThickness);
            h = TunerMix(h, sh.angle);
            h = TunerMix(h, sh.arc);
            h = TunerMix(h, sh.length);
            h = TunerMix(h, sh.donutRadius);
            h = TunerMix(h, sh.position);
            h = TunerMix(h, sh.rotation);
            h = TunerMix(h, sh.scale);
            h = TunerMix(h, sh.mesh);
            h = TunerMix(h, sh.sprite);
            h = TunerMix(h, sh.texture);
            h = TunerMix(h, main.startSpeedMultiplier);
            h = TunerMix(h, (uint)main.scalingMode);
        }
        var ff = go.GetComponent<ParticleSystemForceField>();
        if (ff != null)
        {
            h = TunerMix(h, (uint)ff.shape);
            h = TunerMix(h, ff.startRange);
            h = TunerMix(h, ff.endRange);
            h = TunerMix(h, ff.length);
            h = TunerMix(h, ff.gravityFocus);
        }
        return h;
    }

    static void DrawTunerLightShape(Light t)
    {
        ResetTunerGizmoState();
        if (!_tunerLightHandlesKnown)
        {
            _tunerLightHandlesKnown = true;
            const BindingFlags f = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
            _tunerConeHandle = typeof(Handles).GetMethod("ConeHandle", f, null,
                new[] { typeof(Quaternion), typeof(Vector3), typeof(Vector2), typeof(float), typeof(float), typeof(bool) }, null);
            _tunerRectHandles = typeof(Handles).GetMethod("DoRectHandles", f, null,
                new[] { typeof(Quaternion), typeof(Vector3), typeof(Vector2), typeof(bool) }, null);
        }
        Handles.color = t.enabled ? TunerLightGizmoColor : TunerLightGizmoDisabledColor;
        var tr = t.transform;
        switch (t.type)
        {
            case LightType.Directional:
            {
                var pos = tr.position;
                float size = HandleUtility.GetHandleSize(pos);
                float radius = size * 0.2f;
                using (new Handles.DrawingScope(Matrix4x4.TRS(pos, tr.rotation, Vector3.one)))
                {
                    Handles.DrawWireDisc(Vector3.zero, Vector3.forward, radius);
                    foreach (var dir in TunerSunRays)
                    {
                        var p = dir * radius;
                        Handles.DrawLine(p, p + new Vector3(0f, 0f, size));
                    }
                }
                break;
            }
            case LightType.Point:
                Handles.RadiusHandle(Quaternion.identity, tr.position, t.range);
                break;
            case LightType.Spot:
            {
                var center = tr.position;
                var arrival = center + tr.forward * t.range;
                float disc = t.range * Mathf.Tan(Mathf.Deg2Rad * t.spotAngle / 2f);
                Handles.DrawLine(center, arrival + tr.up * disc);
                Handles.DrawLine(center, arrival - tr.up * disc);
                Handles.DrawLine(center, arrival + tr.right * disc);
                Handles.DrawLine(center, arrival - tr.right * disc);
                Handles.DrawWireDisc(arrival, tr.forward, disc);
                if (_tunerConeHandle != null)
                {
                    var c = Handles.color;
                    c.a = Mathf.Clamp01(c.a * 2f);
                    Handles.color = QualitySettings.activeColorSpace == ColorSpace.Linear ? c.linear : c;
                    _tunerConeHandle.Invoke(null, new object[] { tr.rotation, tr.position, new Vector2(t.spotAngle, t.range), 1f, 1f, true });
                }
                break;
            }
            case LightType.Rectangle:
                if (_tunerRectHandles != null) _tunerRectHandles.Invoke(null, new object[] { tr.rotation, tr.position, t.areaSize, false });
                Handles.DrawLine(tr.position, tr.position + tr.forward);
                break;
            case LightType.Disc:
                using (new Handles.DrawingScope(Matrix4x4.TRS(tr.position, tr.rotation, Vector3.one)))
                    Handles.DrawWireDisc(Vector3.zero, Vector3.forward, t.areaSize.x);
                break;
        }
        ResetTunerGizmoState();
    }

    static ulong MixTunerBuiltinGizmos(TunerViewState v, Component[] comps, ulong h, bool dirtyCheck, bool inHierarchy)
    {
        foreach (var c in comps)
        {
            if (c == null) continue;
            if (c is MonoBehaviour)
            {
                if (dirtyCheck) NoteTunerGizmoDirty(v, c);
                continue;
            }
            if (!inHierarchy) continue;
            var light = c as Light;
            if (light != null)
            {
                h = TunerMix(h, (uint)light.type);
                h = TunerMix(h, light.range);
                h = TunerMix(h, light.spotAngle);
                h = TunerMix(h, (Vector3)(Vector4)light.color);
                h = TunerMix(h, light.enabled ? 1u : 0u);
                continue;
            }
            var cam = c as Camera;
            if (cam != null)
            {
                h = TunerMix(h, cam.fieldOfView);
                h = TunerMix(h, cam.nearClipPlane);
                h = TunerMix(h, cam.farClipPlane);
                h = TunerMix(h, cam.orthographic ? cam.orthographicSize : -1f);
                continue;
            }
            var t = c.GetType();
            if (TunerIsA(t, "UnityEngine.Collider") || TunerIsA(t, "UnityEngine.Collider2D"))
            {
                var b = TunerGizmoProp(c, "bounds", default(Bounds));
                h = TunerMix(h, b.center);
                h = TunerMix(h, b.size);
                h = TunerMix(h, TunerGizmoProp(c, "enabled", true) ? 1u : 0u);
            }
            else if (TunerIsA(t, "UnityEngine.AudioSource"))
            {
                h = TunerMix(h, TunerGizmoProp(c, "minDistance", 1f));
                h = TunerMix(h, TunerGizmoProp(c, "maxDistance", 500f));
            }
        }
        return h;
    }
}
