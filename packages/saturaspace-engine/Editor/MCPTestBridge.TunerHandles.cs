using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditor.EditorTools;
using UnityEngine;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    [Serializable]
    class TunerHandlesArgs
    {
        public string session;
        public string op;
        public string type;
        public float x;
        public float y;
        public float w;
        public float h;
        public int button;
        public int clicks;
        public bool shift;
        public bool ctrl;
        public bool alt;
        public bool cmd;
    }

    [Serializable]
    class TunerHandlesCommand
    {
        public int id;
        public TunerHandlesArgs args;
    }

    static EditorTool s_TunerTool;
    static Object[] s_TunerToolTargets;
    static object _tunerHandleGuiState;
    static bool _tunerHandleGuiKnown;
    static int _tunerHandleHot;
    static int _tunerHandleNearest;
    static float _tunerHandleNearestDist = 5f;
    static int _tunerHandleGen;
    static float _tunerHandlePpp;
    static Vector2 _tunerHandleMouse;
    static bool _tunerHandleMouseIn;
    static EventModifiers _tunerHandleMods;
    static bool _tunerHandleInPass;
    static FieldInfo _tunerNearestField;
    static FieldInfo _tunerNearestDistField;
    static Action _tunerBeginHandles;
    static Action _tunerEndHandles;
    static Action<float, float> _tunerLayoutFromContainer;
    static PropertyInfo _tunerPppProp;
    static bool _tunerHandleReflKnown;
    static FieldInfo _tunerToolTargetsField;
    static FieldInfo _tunerToolTargetField;
    static MethodInfo _tunerCreateWithInit;
    static readonly HashSet<string> _tunerHandleThrew = new HashSet<string>();
    static readonly List<Editor> _tunerSceneEditors = new List<Editor>();
    static readonly Dictionary<Type, Action<Editor>> _tunerSceneGuiCalls = new Dictionary<Type, Action<Editor>>();
    static bool _tunerToolShown;
    static PropertyInfo _tunerRefTargetIndex;

    [InitializeOnLoadMethod]
    static void InitTunerHandles()
    {
        if (Inert) return;
        AssemblyReloadEvents.beforeAssemblyReload += () => DeactivateTunerTool();
    }

    static void EnsureTunerHandleReflection()
    {
        if (_tunerHandleReflKnown) return;
        _tunerHandleReflKnown = true;
        const BindingFlags sf = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;
        const BindingFlags inf = BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public;
        _tunerNearestField = typeof(HandleUtility).GetField("s_NearestControl", sf);
        _tunerNearestDistField = typeof(HandleUtility).GetField("s_NearestDistance", sf);
        var begin = typeof(HandleUtility).GetMethod("BeginHandles", sf, null, Type.EmptyTypes, null);
        var end = typeof(HandleUtility).GetMethod("EndHandles", sf, null, Type.EmptyTypes, null);
        if (begin != null) _tunerBeginHandles = (Action)Delegate.CreateDelegate(typeof(Action), begin);
        if (end != null) _tunerEndHandles = (Action)Delegate.CreateDelegate(typeof(Action), end);
        var layoutFrom = typeof(GUILayoutUtility).GetMethod("LayoutFromContainer", sf, null, new[] { typeof(float), typeof(float) }, null);
        if (layoutFrom != null) _tunerLayoutFromContainer = (Action<float, float>)Delegate.CreateDelegate(typeof(Action<float, float>), layoutFrom);
        else Debug.LogWarning("[Tuner] GUILayoutUtility.LayoutFromContainer was not found, so GUILayout areas drawn in OnSceneGUI may be placed wrong");
        _tunerPppProp = typeof(GUIUtility).GetProperty("pixelsPerPoint", sf);
        _tunerToolTargetsField = typeof(EditorTool).GetField("m_Targets", inf);
        _tunerToolTargetField = typeof(EditorTool).GetField("m_Target", inf);
        _tunerCreateWithInit = typeof(ScriptableObject).GetMethod("CreateInstance", sf, null, new[] { typeof(Type), typeof(Action<ScriptableObject>) }, null);
        if (_tunerNearestField == null || _tunerBeginHandles == null || _tunerEndHandles == null || _tunerToolTargetsField == null)
            Debug.LogWarning("[Tuner] scene handles are limited: Unity's HandleUtility or EditorTool internals were not found");
    }

    static bool EnsureTunerHandleGui()
    {
        if (_tunerHandleGuiKnown) return _tunerHandleGuiState != null;
        _tunerHandleGuiKnown = true;
        if (!EnsureTunerGuiState()) return false;
        try { _tunerHandleGuiState = Activator.CreateInstance(_tunerGuiState.GetType(), true); }
        catch (Exception e) { Debug.LogWarning("[Tuner] scene handles are off: " + e.Message); }
        return _tunerHandleGuiState != null;
    }

    static bool TunerToolMatches(Type type, Object target)
    {
        var tool = s_TunerTool;
        if (tool == null || tool.GetType() != type || s_TunerToolTargets == null) return false;
        foreach (var t in s_TunerToolTargets)
            if (t == target) return true;
        return false;
    }

    static EditorTool CreateTunerTool(Type type, Object[] targets)
    {
        EnsureTunerHandleReflection();
        Action<ScriptableObject> init = so =>
        {
            if (_tunerToolTargetsField != null) _tunerToolTargetsField.SetValue(so, targets);
            if (_tunerToolTargetField != null) _tunerToolTargetField.SetValue(so, targets.Length > 0 ? targets[0] : null);
        };
        ScriptableObject made = null;
        if (_tunerCreateWithInit != null) made = _tunerCreateWithInit.Invoke(null, new object[] { type, init }) as ScriptableObject;
        if (made == null)
        {
            made = ScriptableObject.CreateInstance(type);
            if (made != null) init(made);
        }
        var tool = made as EditorTool;
        if (tool == null)
        {
            if (made != null) Object.DestroyImmediate(made);
            return null;
        }
        tool.hideFlags = HideFlags.HideAndDontSave;
        return tool;
    }

    static void ToggleTunerTool(Type type, Object[] targets)
    {
        bool same = targets.Length > 0 && TunerToolMatches(type, targets[0]);
        DeactivateTunerTool();
        if (same) return;
        var tool = CreateTunerTool(type, targets);
        if (tool == null) return;
        s_TunerTool = tool;
        s_TunerToolTargets = targets;
        try { tool.OnActivated(); }
        catch (Exception e) { NoteTunerHandleThrew(tool, e); }
        _tunerHandleGen++;
        SaturaDebug.Log("[Tuner] scene tool on: " + type.Name + " for " + TunerToolTargetNames(targets));
        SignalEditorTick();
    }

    static string TunerToolTargetNames(Object[] targets)
    {
        var names = new List<string>();
        foreach (var t in targets) names.Add(t != null ? t.name + ":" + t.GetType().Name : "null");
        return string.Join(", ", names.ToArray());
    }

    static void DeactivateTunerTool()
    {
        var tool = s_TunerTool;
        if (tool == null) return;
        s_TunerTool = null;
        s_TunerToolTargets = null;
        _tunerHandleHot = 0;
        _tunerHandleNearest = 0;
        _tunerHandleGen++;
        try { tool.OnWillBeDeactivated(); }
        catch (Exception e) { NoteTunerHandleThrew(tool, e); }
        try { Object.DestroyImmediate(tool); }
        catch { }
        SaturaDebug.Log("[Tuner] scene tool off: " + tool.GetType().Name);
    }

    static void NoteTunerHandleThrew(object owner, Exception e)
    {
        var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
        if (TiIsExitGui(inner)) return;
        if (_tunerHandleThrew.Add(owner.GetType().FullName + ":" + inner.GetType().Name)) Debug.LogException(inner);
    }

    static bool TunerToolAlive()
    {
        var tool = s_TunerTool;
        if (tool == null) return false;
        var targets = s_TunerToolTargets;
        bool alive = targets != null && targets.Length > 0;
        if (alive)
            foreach (var t in targets)
                if (t == null)
                {
                    alive = false;
                    break;
                }
        if (alive && !TunerToolInspected(targets[0])) alive = false;
        if (!alive) DeactivateTunerTool();
        return alive;
    }

    static bool TunerToolInspected(Object target)
    {
        foreach (var ts in s_TiSessions.Values)
            foreach (var sec in ts.Sections)
            {
                if (sec.Target == target) return true;
                var ed = sec.Editor;
                if (ed == null) continue;
                var targets = ed.targets;
                for (int i = 0; i < targets.Length; i++)
                    if (targets[i] == target) return true;
            }
        return false;
    }

    static bool TunerHandlesWanted(TunerSession s, TunerViewState v, double now)
    {
        TunerShownObjects(s, v, now);
        var set = v.ShownSet;
        _tunerToolShown = false;
        if (TunerToolAlive())
            foreach (var t in s_TunerToolTargets)
            {
                var c = t as Component;
                var go = c != null ? c.gameObject : t as GameObject;
                if (go != null && set.Contains(go))
                {
                    _tunerToolShown = true;
                    break;
                }
            }
        CollectTunerSceneEditors(set);
        return _tunerToolShown || _tunerSceneEditors.Count > 0;
    }

    static void CollectTunerSceneEditors(HashSet<GameObject> shown)
    {
        _tunerSceneEditors.Clear();
        foreach (var ts in s_TiSessions.Values)
            foreach (var sec in ts.Sections)
            {
                var ed = sec.Editor;
                if (ed == null || ed.target == null || TunerSceneGuiOf(ed.GetType()) == null) continue;
                var c = ed.target as Component;
                var go = c != null ? c.gameObject : ed.target as GameObject;
                if (go == null || !shown.Contains(go) || !go.activeInHierarchy || _tunerSceneEditors.Contains(ed)) continue;
                _tunerSceneEditors.Add(ed);
            }
    }

    static Action<Editor> TunerSceneGuiOf(Type t)
    {
        Action<Editor> call;
        if (_tunerSceneGuiCalls.TryGetValue(t, out call)) return call;
        MethodInfo m = null;
        var asm = t.Assembly.GetName().Name;
        if (!asm.StartsWith("UnityEditor", StringComparison.Ordinal) && !asm.StartsWith("SaturaSpace", StringComparison.Ordinal))
            for (var cur = t; cur != null && cur != typeof(Editor) && m == null; cur = cur.BaseType)
                m = cur.GetMethod("OnSceneGUI", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly, null, Type.EmptyTypes, null);
        if (m != null)
        {
            var mi = m;
            call = ed => mi.Invoke(ed, null);
        }
        _tunerSceneGuiCalls[t] = call;
        return call;
    }

    static ulong MixTunerHandles(ulong h)
    {
        h = TunerMix(h, (uint)_tunerHandleGen);
        return TunerMix(h, s_TunerTool != null ? 1u : 0u);
    }

    static float TunerHandlePpp(TunerSession s)
    {
        if (s != null && s.Ppp > 0f) return s.Ppp;
        if (_tunerHandlePpp <= 0f) _tunerHandlePpp = Mathf.Max(1f, EditorGUIUtility.pixelsPerPoint);
        return _tunerHandlePpp;
    }

    static void SetupTunerGizmoCamera(TunerSession s)
    {
        int w = s.Width, h = s.Height;
        Matrix4x4 view, proj;
        TunerViewMatrices(s, w, h, out view, out proj);
        var cam = _tunerGizmoCam;
        var fwd = s.CamRot * Vector3.forward;
        cam.transform.SetPositionAndRotation(s.Ortho > 0f ? s.CamPos - fwd * Mathf.Max(1f, s.Ortho) : s.CamPos, s.CamRot);
        cam.orthographic = s.Ortho > 0f;
        if (s.Ortho > 0f) cam.orthographicSize = s.Ortho;
        cam.fieldOfView = s.Fov;
        cam.nearClipPlane = s.Near;
        cam.farClipPlane = s.Far;
        cam.targetTexture = s.Target;
        cam.aspect = (float)w / h;
        cam.worldToCameraMatrix = view;
        cam.projectionMatrix = proj;
        cam.scene = _tunerGizmoScene;
    }

    static void RunTunerToolGui()
    {
        foreach (var ed in _tunerSceneEditors)
        {
            if (ed == null || ed.target == null) continue;
            var call = TunerSceneGuiOf(ed.GetType());
            if (call == null) continue;
            if (_tunerRefTargetIndex == null)
                _tunerRefTargetIndex = typeof(Editor).GetProperty("referenceTargetIndex", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
            int n = Math.Max(1, ed.targets.Length);
            for (int i = 0; i < n; i++)
            {
                ResetTunerGizmoState();
                try
                {
                    if (_tunerRefTargetIndex != null && n > 1) _tunerRefTargetIndex.SetValue(ed, i, null);
                    EditorGUI.BeginChangeCheck();
                    call(ed);
                    if (EditorGUI.EndChangeCheck()) ed.serializedObject.Update();
                }
                catch (Exception e) { NoteTunerHandleThrew(ed, e); }
                finally { ResetTunerGizmoState(); }
            }
        }
        var tool = s_TunerTool;
        if (tool == null || !_tunerToolShown) return;
        ResetTunerGizmoState();
        try { tool.OnToolGUI(null); }
        catch (Exception e) { NoteTunerHandleThrew(tool, e); }
        finally { ResetTunerGizmoState(); }
    }

    static void DrawTunerHandlesRepaint(TunerSession s)
    {
        if (_tunerHandleInPass || (!_tunerToolShown && _tunerSceneEditors.Count == 0) || !EnsureTunerHandleGui()) return;
        EnsureTunerHandleReflection();
        _tunerEndContainer.Invoke(null, null);
        _tunerBeginContainer.Invoke(null, new[] { _tunerHandleGuiState });
        var e = new Event { type = EventType.Repaint, mousePosition = _tunerHandleMouseIn ? _tunerHandleMouse : new Vector2(-100000f, -100000f), modifiers = _tunerHandleMods };
        RunTunerHandlePass(s, e, true);
    }

    static void RestartTunerHandleContainer()
    {
        _tunerEndContainer.Invoke(null, null);
        _tunerBeginContainer.Invoke(null, new[] { _tunerHandleGuiState });
    }

    static bool RunTunerHandlePass(TunerSession s, Event e, bool layoutFirst)
    {
        int prevHot = GUIUtility.hotControl;
        var prevEvent = Event.current;
        float prevPpp = _tunerPppProp != null ? (float)_tunerPppProp.GetValue(null, null) : 1f;
        bool used = false;
        _tunerHandleInPass = true;
        try
        {
            if (_tunerPppProp != null) _tunerPppProp.SetValue(null, TunerHandlePpp(s), null);
            GUIUtility.hotControl = _tunerHandleHot;
            if (layoutFirst)
            {
                var layout = new Event { type = EventType.Layout, mousePosition = e.mousePosition, modifiers = e.modifiers };
                Event.current = layout;
                RestartTunerHandleContainer();
                _tunerBeginHandles();
                Handles.SetCamera(_tunerGizmoCam);
                RunTunerToolGui();
                if (_tunerLayoutFromContainer != null)
                {
                    float ppp = TunerHandlePpp(s);
                    _tunerLayoutFromContainer(s.Width / ppp, s.Height / ppp);
                }
                _tunerEndHandles();
                _tunerHandleNearest = (int)_tunerNearestField.GetValue(null);
                _tunerHandleNearestDist = _tunerNearestDistField != null ? (float)_tunerNearestDistField.GetValue(null) : 0f;
            }
            else
            {
                _tunerNearestField.SetValue(null, _tunerHandleNearest);
                if (_tunerNearestDistField != null) _tunerNearestDistField.SetValue(null, _tunerHandleNearestDist);
            }
            Event.current = e;
            if (layoutFirst) RestartTunerHandleContainer();
            _tunerBeginHandles();
            if (e.type != EventType.Layout)
            {
                _tunerNearestField.SetValue(null, _tunerHandleNearest);
                if (_tunerNearestDistField != null) _tunerNearestDistField.SetValue(null, _tunerHandleNearestDist);
            }
            Handles.SetCamera(_tunerGizmoCam);
            RunTunerToolGui();
            _tunerEndHandles();
            used = e.type == EventType.Used;
            _tunerHandleHot = GUIUtility.hotControl;
        }
        catch (Exception ex)
        {
            if (s_TunerTool != null) NoteTunerHandleThrew(s_TunerTool, ex);
        }
        finally
        {
            GUIUtility.hotControl = prevHot;
            Event.current = prevEvent;
            if (_tunerPppProp != null) _tunerPppProp.SetValue(null, prevPpp, null);
            _tunerHandleInPass = false;
        }
        return used;
    }

    static bool HandleTunerHandles(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/handles") return false;
        TunerHandlesCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerHandlesCommand>(line); }
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
        string err = null;
        bool used = false;
        if (a.op == "tool") DeactivateTunerTool();
        else if (a.op == "event") err = TunerHandleEvent(s, a, out used);
        else if (a.op == "state") TunerHandlesWanted(s, TunerViewOf(s, true), EditorApplication.timeSinceStartup);
        else err = "unknown handles op: " + a.op;
        TunerResult(from, id, err, err == null ? TunerHandlesJson(used) : null);
        return true;
    }

    static string TunerHandlesJson(bool used)
    {
        bool tool = s_TunerTool != null;
        return "\"handles\":{\"tool\":" + (tool ? "true" : "false")
            + ",\"editors\":" + (_tunerSceneEditors.Count > 0 ? "true" : "false")
            + ",\"name\":" + JStr(tool ? s_TunerTool.GetType().Name : "")
            + ",\"near\":" + (_tunerHandleNearest != 0 ? "true" : "false")
            + ",\"hot\":" + (_tunerHandleHot != 0 ? "true" : "false")
            + ",\"used\":" + (used ? "true" : "false") + "}";
    }

    static string TunerHandleEvent(TunerSession s, TunerHandlesArgs a, out bool used)
    {
        used = false;
        var v = TunerViewOf(s, true);
        double now = EditorApplication.timeSinceStartup;
        if (a.w >= 1f && s.Width > 0) s.Ppp = _tunerHandlePpp = s.Width / a.w;
        var mods = EventModifiers.None;
        if (a.shift) mods |= EventModifiers.Shift;
        if (a.ctrl) mods |= EventModifiers.Control;
        if (a.alt) mods |= EventModifiers.Alt;
        if (a.cmd) mods |= EventModifiers.Command;
        var pos = new Vector2(a.x, a.y);
        var delta = _tunerHandleMouseIn ? pos - _tunerHandleMouse : Vector2.zero;
        int prevNearest = _tunerHandleNearest, prevHot = _tunerHandleHot;
        var prevMods = _tunerHandleMods;
        _tunerHandleMods = mods;
        if (a.type == "leave")
        {
            _tunerHandleMouseIn = false;
            _tunerHandleNearest = 0;
            if (prevNearest != 0)
            {
                _tunerHandleGen++;
                s.Dirty = true;
            }
            return null;
        }
        _tunerHandleMouse = pos;
        _tunerHandleMouseIn = true;
        if (!TunerHandlesWanted(s, v, now) || !EnsureTunerGizmoRig() || !EnsureTunerHandleGui() || s.Width < 2 || s.Height < 2)
        {
            if (_tunerHandleHot == 0 && _tunerHandleNearest != 0)
            {
                _tunerHandleNearest = 0;
                _tunerHandleGen++;
                s.Dirty = true;
            }
            return null;
        }
        EnsureTunerHandleReflection();
        if (_tunerNearestField == null || _tunerBeginHandles == null || _tunerEndHandles == null) return "Unity's handle internals were not found";
        EventType type;
        switch (a.type)
        {
            case "down": type = EventType.MouseDown; break;
            case "drag": type = EventType.MouseDrag; break;
            case "up": type = EventType.MouseUp; break;
            default: type = EventType.MouseMove; break;
        }
        if (type == EventType.MouseMove && _tunerHandleHot != 0) type = EventType.MouseDrag;
        var e = new Event
        {
            type = type,
            mousePosition = pos,
            delta = delta,
            button = a.button,
            clickCount = Math.Max(1, a.clicks),
            modifiers = mods
        };
        if (type == EventType.MouseDown) Undo.IncrementCurrentGroup();
        var prevTarget = _tunerGizmoCam.targetTexture;
        bool began = false;
        try
        {
            SetupTunerGizmoCamera(s);
            _tunerBeginContainer.Invoke(null, new[] { _tunerHandleGuiState });
            began = true;
            used = RunTunerHandlePass(s, e, type != EventType.MouseDrag && type != EventType.MouseUp);
        }
        finally
        {
            if (began)
            {
                try { _tunerEndContainer.Invoke(null, null); }
                catch { }
            }
            _tunerGizmoCam.targetTexture = prevTarget;
        }
        if (type == EventType.MouseUp)
        {
            _tunerHandleHot = 0;
            Undo.IncrementCurrentGroup();
        }
        if (used || prevNearest != _tunerHandleNearest || prevHot != _tunerHandleHot || prevMods != mods || (type == EventType.MouseMove && (_tunerToolShown || _tunerHandleNearest != 0)))
        {
            _tunerHandleGen++;
            s.Dirty = true;
            NoteTunerActivity();
            SignalEditorTick();
        }
        return null;
    }
}
