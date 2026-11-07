using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEditor.UIElements;
using UnityEditorInternal;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;
#if UNITY_6000_5_OR_NEWER
using TiObjId = UnityEngine.EntityId;
#else
using TiObjId = System.Int32;
#endif

public static partial class MCPTestBridge
{
    const int TI_MIN_WIDTH = 200;
    const int TI_MAX_WIDTH = 2000;
    const int TI_MAX_HEIGHT = 60000;
    const double TI_EDIT_POLL = 0.25;
    const double TI_LIVE_MIN = 0.1;
    const double TI_DIRTY_DELAY = 0.03;
    const double TI_LIVE_MOVING_MIN = 0.5;
    const double TI_LIVE_MOVING_SHARE = 25.0;
    const double TI_DRAG_PAINT_GAP = 0.1;
    const BindingFlags TiStatic = BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
    const BindingFlags TiInstance = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
    static readonly CultureInfo TiInv = CultureInfo.InvariantCulture;

    [Serializable]
    class TunerInspectorComponentArgs
    {
        public string type;
        public int index;
        public bool hasFields;
        public string[] fields;
        public string[] exclude;
    }

    [Serializable]
    class TunerInspectorExtraTarget
    {
        public string path;
        public string scene;
        public int[] at;
    }

    [Serializable]
    class TunerInspectorTargetArgs
    {
        public string kind;
        public string path;
        public string scene;
        public bool restrict;
        public TunerInspectorComponentArgs[] components;
        public string[] exclude;
        public bool hasFields;
        public string[] fields;
        public int[] at;
        public TunerInspectorExtraTarget[] targets;
    }

    [Serializable]
    class TunerInspectorInputArgs
    {
        public string op;
        public string type;
        public float x;
        public float y;
        public float dx;
        public float dy;
        public int button;
        public int clicks;
        public bool shift;
        public bool ctrl;
        public bool alt;
        public bool cmd;
        public string key;
        public string character;
        public int control;
        public string value;
        public string commit;
        public int id;
        public string action;
        public string section;
    }

    [Serializable]
    class TunerInspectorArgs
    {
        public string session;
        public TunerInspectorTargetArgs target;
        public int width;
        public bool force;
        public TunerInspectorInputArgs input;
        public string section;
        public string name;
        public string value;
    }

    [Serializable]
    class TunerInspectorCommand
    {
        public int id;
        public TunerInspectorArgs args;
    }

    public class TunerInspectorPanelOwner : ScriptableObject
    {
    }

    class TiSection
    {
        public string Key;
        public string Kind;
        public string Title;
        public string TypeName;
        public Object Target;
        public Editor Editor;
        public bool OwnsEditor = true;
        public VisualElement Element;
        public IMGUIContainer Header;
        public VisualElement Body;
        public string[] Fields;
        public SerializedObject FieldsObject;
        public TiFieldNode FieldTree;
        public bool Uitk;
        public bool LargeHeader;
        public bool ImportedLabel;
        public bool Expandable = true;
        public readonly List<IMGUIContainer> Containers = new List<IMGUIContainer>();
        public readonly List<TiDrawRec> Draws = new List<TiDrawRec>();
        public readonly List<TiPropRec> Props = new List<TiPropRec>();
        public readonly List<TiCursorRec> Cursors = new List<TiCursorRec>();
        public readonly List<Rect> Clips = new List<Rect>();
        public readonly List<TiScrollRec> Scrolls = new List<TiScrollRec>();
        public Rect Bounds;
        public string UitkJson;
        public IReadOnlyList<IMGUIContainer> UitkImgui;
        public string PscJson;
        public Rect PscRect;
        public int PscC;
        public bool Painted;
        public bool ConstantRepaint;
        public int FieldsShown = -1;
        public int FieldsTotal = -1;
        public ulong LiveSig;
    }

    class TiSession
    {
        public string Id;
        public bool ViewOnly;
        public List<Object> ViewAssets;
        public ControlClient Client;
        public TunerInspectorTargetArgs Spec;
        public string SpecKey;
        public int Width = 360;
        public TunerInspectorPanelOwner Owner;
        public IPanel Panel;
        public VisualElement Root;
        public readonly List<TiSection> Sections = new List<TiSection>();
        public GameObject Go;
        public readonly List<GameObject> Gos = new List<GameObject>();
        public Object Asset;
        public string Error;
        public string Signature;
        public int Height;
        public bool Dirty = true;
        public bool PaintAll = true;
        public bool RepaintAgain;
        public readonly HashSet<TiObjId> ChangedIds = new HashSet<TiObjId>();
        public bool NeedsRebuild = true;
        public bool Reset = true;
        public bool Constant;
        public double NextPoll;
        public double DirtyAt;
        public double LastMs;
        public double PaintedAt = -1;
        public double DeadSince = -1;
        public long LastDirtyCount = -1;
        public int Seq;
        public int Kb;
        public int Hot;
        public bool EditingText;
        public bool FocusEditing;
        public int LiveControl;
        public IMGUIContainer MouseContainer;
        public TiSection MouseSection;
        public IMGUIContainer FocusContainer;
        public TiSection FocusSection;
        public TiFocusRec Focus;
        public Vector2? Hover;
        public EventModifiers HoverMods;
        public readonly Dictionary<string, int> StyleIds = new Dictionary<string, int>();
        public readonly Dictionary<GUIStyle, (int id, int sig)> PassStyles = new Dictionary<GUIStyle, (int id, int sig)>();
        public readonly List<string> NewStyles = new List<string>();
        public readonly Dictionary<string, int> TexIds = new Dictionary<string, int>();
        public readonly List<string> NewTextures = new List<string>();
        public readonly Dictionary<string, ulong> SentHash = new Dictionary<string, ulong>();
        public ulong SentExtras;
        public readonly List<TunerPopup> Popups = new List<TunerPopup>();
        public int NextPopupId = 1;
        public readonly HashSet<string> LoggedErrors = new HashSet<string>();
        public readonly HashSet<string> UitkTextures = new HashSet<string>();
        public ActiveEditorTracker Tracker;
        public Editor[] TrackerEditors;
        public readonly List<string> Opens = new List<string>();
        public readonly List<string> Pings = new List<string>();
        public readonly Dictionary<Object, SerializedObject> LiveObjects = new Dictionary<Object, SerializedObject>();
        public ulong LiveSig;
        public bool LivePartial;
    }

    static readonly Dictionary<string, TiSession> s_TiSessions = new Dictionary<string, TiSession>();
    static readonly List<TiSession> s_TiTickList = new List<TiSession>();
    static bool s_TiHooked;

    static void HandleTunerInspectorCommand(int id, string cmd, string line, ControlClient from)
    {
        TunerInspectorCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerInspectorCommand>(line); }
        catch (Exception e)
        {
            TiResult(from, id, "bad arguments: " + e.Message, null);
            return;
        }
        var a = parsed != null ? parsed.args : null;
        if (a == null || string.IsNullOrEmpty(a.session))
        {
            TiResult(from, id, "a session id is required", null);
            return;
        }
        try
        {
            switch (cmd)
            {
                case "tunerInspector/open":
                {
                    var err = TiPrepare(a, from, true);
                    if (err != null) { TiResult(from, id, err, null); break; }
                    TiReply(from, id, s_TiSessions[a.session], true);
                    break;
                }
                case "tunerInspector/capture":
                {
                    var err = TiPrepare(a, from, false);
                    if (err != null) { TiResult(from, id, err, null); break; }
                    TiReply(from, id, s_TiSessions[a.session], a.force);
                    break;
                }
                case "tunerInspector/input":
                {
                    var err = TiPrepare(a, from, false);
                    if (err != null) { TiResult(from, id, err, null); break; }
                    var s = s_TiSessions[a.session];
                    s.ViewOnly = false;
                    err = TiApplyInput(s, a.input);
                    if (err != null) { TiResult(from, id, err, null); break; }
                    TiReply(from, id, s, false);
                    break;
                }
                case "tunerInspector/values":
                {
                    TiSession s;
                    if (!s_TiSessions.TryGetValue(a.session, out s)) { TiResult(from, id, "the inspector session is not open", null); break; }
                    TiResult(from, id, null, "\"values\":" + TiValuesJson(s));
                    break;
                }
                case "tunerInspector/field":
                {
                    TiSession s;
                    if (!s_TiSessions.TryGetValue(a.session, out s)) { TiResult(from, id, "the inspector session is not open", null); break; }
                    TiResult(from, id, null, TiLookupField(s, a.section, a.name) ?? "\"field\":null");
                    break;
                }
                case "tunerInspector/setField":
                {
                    TiSession s;
                    if (!s_TiSessions.TryGetValue(a.session, out s)) { TiResult(from, id, "the inspector session is not open", null); break; }
                    s.ViewOnly = false;
                    var err = TiSetFieldValue(s, a.section, a.name, a.value);
                    if (err != null) { TiResult(from, id, err, null); break; }
                    TiResult(from, id, null, TiLookupField(s, a.section, a.name) ?? "\"field\":null");
                    break;
                }
                case "tunerInspector/undoGroup":
                {
                    var r = TiUndoGroup(a.name, a.value);
                    if (r == null) { TiResult(from, id, "unknown undo group step " + a.name, null); break; }
                    TiResult(from, id, null, r);
                    break;
                }
                case "tunerInspector/close":
                    TiDispose(a.session);
                    TiResult(from, id, null, null);
                    break;
                default:
                    TiResult(from, id, "unknown command: " + cmd, null);
                    break;
            }
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogException(inner);
            TiResult(from, id, inner.GetType().Name + ": " + inner.Message, null);
        }
    }

    static void TiResult(ControlClient to, int id, string error, string payload)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"type\":\"result\",\"id\":").Append(id.ToString(TiInv))
          .Append(",\"status\":").Append(error == null ? "\"completed\"" : "\"error\"");
        if (error != null) TiStr(sb.Append(",\"error\":"), error);
        if (!string.IsNullOrEmpty(payload)) sb.Append(',').Append(payload);
        sb.Append('}');
        TiEmit(to, sb.ToString());
    }

    static bool TiEmit(ControlClient to, string json)
    {
        if (to == null) return false;
        bool ok = CtrlSendLine(to, json, out int sent);
        TpSent(json, sent);
        return ok;
    }

    static void TiReply(ControlClient from, int id, TiSession s, bool force)
    {
        var json = TiCaptureJson(s, force, false);
        TiResult(from, id, null, "\"capture\":" + json);
    }

    static string TiSpecKey(TunerInspectorTargetArgs t)
    {
        if (t == null) return "";
        var sb = new StringBuilder();
        sb.Append(t.kind).Append('|').Append(t.path).Append('|').Append(t.scene).Append('|').Append(t.restrict ? "r" : "a");
        if (t.at != null && t.at.Length > 0) sb.Append("|@").Append(string.Join(".", t.at));
        if (t.targets != null)
            foreach (var x in t.targets)
            {
                if (x == null || string.IsNullOrEmpty(x.path)) continue;
                sb.Append("|+").Append(x.path).Append('|').Append(x.scene);
                if (x.at != null && x.at.Length > 0) sb.Append("|@").Append(string.Join(".", x.at));
            }
        if (t.restrict && t.components != null)
            foreach (var c in t.components)
            {
                if (c == null) continue;
                sb.Append('|').Append(c.type).Append('#').Append(c.index);
                if (c.hasFields && c.fields != null) sb.Append(':').Append(string.Join(",", c.fields));
            }
        sb.Append(TunerFilterSpecKey(t));
        return sb.ToString();
    }

    static string TiPrepare(TunerInspectorArgs a, ControlClient from, bool open)
    {
        if (!TiInitReflection()) return "inspector capture is unavailable in this Unity version: " + s_TiReflectError;
        if (EditorApplication.isCompiling) return "Unity is compiling";
        TiSession s;
        s_TiSessions.TryGetValue(a.session, out s);
        if (s == null)
        {
            if (a.target == null || string.IsNullOrEmpty(a.target.path)) return "unknown inspector session";
            s = new TiSession { Id = a.session };
            s_TiSessions[a.session] = s;
            TiEnsureHooks();
        }
        if (from != null) s.Client = from;
        if (a.target != null && !string.IsNullOrEmpty(a.target.path))
        {
            var key = TiSpecKey(a.target);
            if (key != s.SpecKey)
            {
                s.Spec = a.target;
                s.SpecKey = key;
                s.ViewOnly = true;
                s.NeedsRebuild = true;
                s.Reset = true;
            }
        }
        if (s.Spec == null) return "the inspector session has no target";
        if (a.width > 0)
        {
            int w = Mathf.Clamp(a.width, TI_MIN_WIDTH, TI_MAX_WIDTH);
            if (w != s.Width)
            {
                s.Width = w;
                s.Dirty = true;
            }
        }
        if (open) s.Reset = true;
        EnsureTunerInspectorPatches();
        TiTmpEnsure();
        return null;
    }

    static void TiEnsureHooks()
    {
        if (s_TiHooked) return;
        s_TiHooked = true;
        EditorApplication.update += TunerInspectorTick;
        AssemblyReloadEvents.beforeAssemblyReload += TiDisposeAll;
        EditorApplication.quitting += TiDisposeAll;
        Undo.undoRedoPerformed += TiMarkAllDirty;
        ObjectChangeEvents.changesPublished += TiOnChanges;
        EditorApplication.hierarchyChanged += TiOnHierarchyChanged;
        EditorApplication.playModeStateChanged += TiOnPlayMode;
        EditorApplication.projectChanged += TiMarkAllDirty;
    }

    static void TiMarkAllDirty()
    {
        foreach (var s in s_TiSessions.Values)
        {
            s.PaintAll = true;
            TiMarkDirty(s);
        }
    }

    static void TiMarkDirty(TiSession s)
    {
        if (s_TiRecording) s.RepaintAgain = true;
        if (s.Dirty) return;
        s.Dirty = true;
        s.DirtyAt = EditorApplication.timeSinceStartup;
    }

    static void TiOnChanges(ref ObjectChangeEventStream stream)
    {
        if (s_TiSessions.Count == 0) return;
        bool structural = false;
        bool noise = false;
        for (int i = 0; i < stream.length; i++)
        {
            switch (stream.GetEventType(i))
            {
                case ObjectChangeKind.ChangeGameObjectOrComponentProperties:
                {
                    stream.GetChangeGameObjectOrComponentPropertiesEvent(i, out var e);
#if UNITY_6000_5_OR_NEWER
                    TiNoteChanged(e.entityId);
#else
                    var target = TunerChangeTarget(e);
                    if (target != null) TiNoteChanged(target.GetInstanceID());
#endif
                    noise = true;
                    break;
                }
                case ObjectChangeKind.ChangeAssetObjectProperties:
                {
                    stream.GetChangeAssetObjectPropertiesEvent(i, out var e);
#if UNITY_6000_5_OR_NEWER
                    TiNoteChanged(e.entityId);
#else
                    var target = TunerChangeTarget(e);
                    if (target != null) TiNoteChanged(target.GetInstanceID());
#endif
                    break;
                }
                case ObjectChangeKind.ChangeScene:
                case ObjectChangeKind.ChangeChildrenOrder:
                case ObjectChangeKind.ChangeRootOrder:
                    break;
                default:
                    structural = true;
                    break;
            }
        }
        if (noise) TiDirtyNoisePreview(true);
        foreach (var s in s_TiSessions.Values)
        {
            if (structural) s.PaintAll = true;
            TiMarkDirty(s);
        }

    }

    static FieldInfo s_TiNoiseDirty;
    static bool s_TiNoiseLooked;

    static void TiDirtyNoisePreview(bool again)
    {
        if (!s_TiNoiseLooked)
        {
            s_TiNoiseLooked = true;
            var t = typeof(Editor).Assembly.GetType("UnityEditor.NoiseModuleUI", false);
            if (t != null) s_TiNoiseDirty = t.GetField("s_PreviewTextureDirty", BindingFlags.Static | BindingFlags.NonPublic);
            if (s_TiNoiseDirty == null) Debug.LogWarning("[tunerInspector] NoiseModuleUI.s_PreviewTextureDirty not found; the Noise preview will not refresh on Tuner edits");
        }
        if (s_TiNoiseDirty == null) return;
        s_TiNoiseDirty.SetValue(null, true);
        if (!again) return;
        EditorApplication.delayCall += () =>
        {
            if (s_TiSessions.Count == 0) return;
            TiDirtyNoisePreview(false);
            foreach (var s in s_TiSessions.Values) TiMarkDirty(s);
        };
    }

    static void TiNoteChanged(TiObjId id)
    {
        foreach (var s in s_TiSessions.Values)
            if (s.ChangedIds.Count < 64) s.ChangedIds.Add(id);
            else s.PaintAll = true;
    }

    static TiObjId TiIdOf(Object o)
    {
#if UNITY_6000_5_OR_NEWER
        return o.GetEntityId();
#else
        return o.GetInstanceID();
#endif
    }

    static bool TiSceneMoving(double now)
    {
        foreach (var t in _tuners.Values)
            if (!t.Hidden && (t.Dragging || (t.CamMovedAt >= 0 && now - t.CamMovedAt < TUNER_CAMERA_FAST_HOLD))) return true;
        return false;
    }

    static bool TiAnyDragging()
    {
        if (_tunerHandleHot != 0) return true;
        foreach (var t in _tuners.Values)
            if (t.Dragging) return true;
        return false;
    }

    static bool TiPartialPaint(TiSession s)
    {
        bool partial = !s.PaintAll && !s.Reset && s.ChangedIds.Count > 0 && s.Focus == null && s.Hot == 0 && !s.FocusEditing
            && (s.LivePartial || (s.Hover == null && !EditorApplication.isPlaying && TiAnyDragging()));
        s.LivePartial = false;
        if (partial) _tpTiPartial++;
        return partial;
    }

    static bool TiSectionChanged(TiSession s, TiSection sec)
    {
        if (sec.Target != null && s.ChangedIds.Contains(TiIdOf(sec.Target))) return true;
        var targets = sec.Editor != null && s.Gos.Count > 1 ? sec.Editor.targets : null;
        if (targets != null)
            foreach (var t in targets)
                if (t != null && s.ChangedIds.Contains(TiIdOf(t))) return true;
        return false;
    }

    static void TiOnHierarchyChanged()
    {
        foreach (var s in s_TiSessions.Values)
        {
            s.PaintAll = true;
            TiMarkDirty(s);
            if (s.Tracker == null && s.Spec != null && s.Spec.kind != "asset" && s.Signature != TiComponentSignature(s)) s.NeedsRebuild = true;
        }
    }

    static void TiOnPlayMode(PlayModeStateChange change)
    {
        foreach (var s in s_TiSessions.Values)
        {
            s.NeedsRebuild = true;
            s.Kb = 0;
            s.Hot = 0;
            TiCancelPopups(s);
            TiMarkDirty(s);
        }
    }

    static void TiDisposeAll()
    {
        foreach (var id in s_TiSessions.Keys.ToList()) TiDispose(id);
        TiReleaseShared();
    }

    static void TiDispose(string id)
    {
        TiSession s;
        if (!s_TiSessions.TryGetValue(id, out s)) return;
        s_TiSessions.Remove(id);
        TiCancelPopups(s);
        TiClearSections(s);
        TiDestroyTracker(s);
        try { s.Root?.RemoveFromHierarchy(); } catch { }
        try { s.Panel?.Dispose(); } catch { }
        if (s.Owner != null) Object.DestroyImmediate(s.Owner);
        s.Owner = null;
        s.Panel = null;
        s.Root = null;
        if (s_TiSessions.Count == 0) TiReleaseShared();
    }

    static void TiClearSections(TiSession s)
    {
        foreach (var sec in s.Sections)
        {
            if (sec.Uitk && sec.Body != null)
            {
                try { TunerUitkForget(sec.Body); } catch { }
            }
            try { sec.Element?.RemoveFromHierarchy(); } catch { }
            if (sec.OwnsEditor && sec.Editor != null)
            {
                try { Object.DestroyImmediate(sec.Editor); } catch { }
            }
            sec.FieldsObject?.Dispose();
        }
        s.Sections.Clear();
        foreach (var so in s.LiveObjects.Values) so?.Dispose();
        s.LiveObjects.Clear();
        s.LiveSig = 0;
        s.MouseContainer = null;
        s.MouseSection = null;
        s.FocusContainer = null;
        s.FocusSection = null;
        s.Focus = null;
    }

    static void TunerInspectorTick()
    {
        if (s_TiSessions.Count == 0) return;
        if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
        long tpStart = TpNow();
        try { TunerInspectorTickInner(); }
        finally { TpAdd(TP_INSPECTOR, tpStart); }
    }

    static void TunerInspectorTickInner()
    {
        var now = EditorApplication.timeSinceStartup;
        var list = s_TiTickList;
        list.Clear();
        list.AddRange(s_TiSessions.Values);
        foreach (var s in list)
        {
            if (s.Client == null || !CtrlClientAlive(s.Client))
            {
                if (s.DeadSince < 0) s.DeadSince = now;
                else if (now - s.DeadSince > 120.0) TiDispose(s.Id);
                continue;
            }
            s.DeadSince = -1;
            bool due = s.Dirty && now - s.DirtyAt >= TI_DIRTY_DELAY;
            if (!due && now >= s.NextPoll)
            {
                bool live = EditorApplication.isPlaying || s.Constant;
                double interval = live ? Math.Max(TI_LIVE_MIN, s.LastMs / 1000.0 * 8.0) : TI_EDIT_POLL;
                if (live && TiSceneMoving(now)) interval = Math.Max(TI_LIVE_MOVING_MIN, s.LastMs / 1000.0 * TI_LIVE_MOVING_SHARE);
                s.NextPoll = now + interval;
                if (live)
                {
                    if (s.Constant || s.FocusEditing || s.Hot != 0 || s.NeedsRebuild || TiTargetsGone(s)) due = true;
                    else
                    {
                        due = TiLiveChanged(s);
                    }
                }
                else
                {
                    long dc = TiDirtyCount(s);
                    if (dc != s.LastDirtyCount)
                    {
                        s.LastDirtyCount = dc;
                        if (!s.Dirty) s.PaintAll = true;
                        due = true;
                    }
                    else if (s.NeedsRebuild || TiTargetsGone(s)) due = true;
                }
            }
            if (!due) continue;
            if (s.Hot == 0 && !s.FocusEditing && s.PaintedAt >= 0 && now - s.PaintedAt < TI_DRAG_PAINT_GAP && TiAnyDragging())
            {
                s.Dirty = true;
                continue;
            }
            try
            {
                s.PaintedAt = now;
                var json = TiCaptureJson(s, false, true, true);
                if (json == null) continue;
                long tpEmit = TpNow();
                TiEmit(s.Client, json);
                TpAdd(TP_TI_EMIT, tpEmit);
            }
            catch (Exception e)
            {
                var msg = e.GetType().Name + ": " + e.Message;
                if (s.LoggedErrors.Add("tick:" + msg)) Debug.LogException(e);
                s.Dirty = false;
            }
        }
        list.Clear();
    }

    static long TiDirtyCount(TiSession s)
    {
        long sum = 0;
        foreach (var sec in s.Sections)
        {
            if (sec.Target != null) sum += EditorUtility.GetDirtyCount(sec.Target);
            var targets = sec.Editor != null && s.Gos.Count > 1 ? sec.Editor.targets : null;
            if (targets != null)
                for (int i = 1; i < targets.Length; i++)
                    if (targets[i] != null) sum += EditorUtility.GetDirtyCount(targets[i]);
        }
        if (s.Go != null) sum += EditorUtility.GetDirtyCount(s.Go);
        for (int i = 1; i < s.Gos.Count; i++)
            if (s.Gos[i] != null) sum += EditorUtility.GetDirtyCount(s.Gos[i]);
        return sum;
    }

    static bool TiLiveChanged(TiSession s)
    {
        bool any = false;
        foreach (var sec in s.Sections)
        {
            ulong h = 1469598103934665603UL;
            var targets = sec.Editor != null ? sec.Editor.targets : null;
            if (targets == null || targets.Length == 0) h = TiLiveMix(s, h, sec.Target);
            else
                foreach (var t in targets) h = TiLiveMix(s, h, t);
            if (h == sec.LiveSig) continue;
            sec.LiveSig = h;
            any = true;
            if (sec.Target != null) s.ChangedIds.Add(TiIdOf(sec.Target));
            if (targets != null)
                foreach (var t in targets)
                    if (t != null) s.ChangedIds.Add(TiIdOf(t));
        }
        ulong g = TiLiveMix(s, 1469598103934665603UL, s.Go);
        if (g != s.LiveSig)
        {
            s.LiveSig = g;
            s.PaintAll = true;
            any = true;
        }
        if (any) s.LivePartial = true;
        return any;
    }

    static ulong TiLiveMix(TiSession s, ulong h, Object target)
    {
        if (target == null) return (h ^ 0x9e37UL) * 1099511628211UL;
        SerializedObject so;
        if (!s.LiveObjects.TryGetValue(target, out so) || so == null || so.targetObject == null)
        {
            so?.Dispose();
            so = new SerializedObject(target);
            s.LiveObjects[target] = so;
        }
        so.Update();
        var it = so.GetIterator();
        bool enter = true;
        while (it.NextVisible(enter))
        {
            enter = false;
            h = (h ^ it.contentHash) * 1099511628211UL;
        }
        return h;
    }

    static bool TiTargetsGone(TiSession s)
    {
        if (s.Spec == null) return false;
        if (s.Spec.kind == "asset") return s.Asset == null && s.Error == null;
        if (s.Go == null) return true;
        foreach (var g in s.Gos)
            if (g == null) return true;
        foreach (var sec in s.Sections)
            if (sec.Kind == "component" && sec.Target == null) return true;
        return false;
    }

    static string TiComponentSignature(TiSession s)
    {
        var go = s.Go;
        if (go == null) return "";
        var sb = new StringBuilder();
        if (s.Sections.Exists(x => x.Kind == "removedComponent")) sb.Append(_tunerPrefabUpdateGen).Append('|');
        foreach (var g in s.Gos.Count > 1 ? s.Gos : new List<GameObject> { go })
        {
            if (g == null) { sb.Append("gone|"); continue; }
            foreach (var c in g.GetComponents<Component>())
            {
                if (c == null) { sb.Append("null;"); continue; }
                sb.Append(c.GetType().FullName).Append(':').Append(c.GetHashCode()).Append(';');
            }
            sb.Append('|');
        }
        return sb.ToString();
    }

    static readonly HashSet<string> TiLeafNames = new HashSet<string> { "scalar", "maxColor", "maxGradient", "maxCurve", "value" };

    static GUIContent TiFieldLabel(SerializedObject so, SerializedProperty p)
    {
        var path = p.propertyPath;
        var dot = path.LastIndexOf('.');
        if (dot <= 0 || !TiLeafNames.Contains(p.name)) return new GUIContent(p.displayName, p.tooltip);
        var parent = so.FindProperty(path.Substring(0, dot));
        return parent == null ? new GUIContent(p.displayName, p.tooltip) : new GUIContent(parent.displayName, parent.tooltip);
    }

    static GameObject TiFindObject(string path, string scene)
    {
        if (string.IsNullOrEmpty(path)) return null;
        var exact = path.TrimStart('/');
        var hit = TiFindObjectAt(exact, scene);
        var clean = exact.Trim();
        return hit != null || clean == exact ? hit : TiFindObjectAt(clean, scene);
    }

    static GameObject TiFindObjectAt(string clean, string scene)
    {
        if (clean.Length == 0) return null;
        var scenes = new List<Scene>();
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (sc.IsValid() && sc.isLoaded) scenes.Add(sc);
        }
        var stage = PrefabStageUtility.GetCurrentPrefabStage();
        if (stage != null && stage.scene.IsValid()) scenes.Add(stage.scene);
        AddTunerPrefabScenes(scenes);
        if (EditorApplication.isPlaying)
        {
            var dd = TiDontDestroyScene();
            if (dd.IsValid()) scenes.Add(dd);
        }
        foreach (var sc in scenes)
        {
            if (!string.IsNullOrEmpty(scene) && sc.name != scene && sc.path != scene) continue;
            foreach (var root in sc.GetRootGameObjects())
            {
                if (SaturaEngineObjects.Contains(root)) continue;
                var hit = MatchTunerPath(root.transform, clean);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    static Scene TiDontDestroyScene()
    {
        GameObject probe = null;
        try
        {
            probe = new GameObject("_SaturaTunerInspectorProbe") { hideFlags = HideFlags.HideAndDontSave };
            Object.DontDestroyOnLoad(probe);
            return probe.scene;
        }
        catch
        {
            return default;
        }
        finally
        {
            if (probe != null) Object.DestroyImmediate(probe);
        }
    }

    static string TiObjectPath(GameObject go)
    {
        return TunerIndexedPath(go.transform);
    }

    static string TiComponentKey(Component c, GameObject go)
    {
        var type = c.GetType();
        int index = 0;
        foreach (var other in go.GetComponents(type))
        {
            if (other == c) break;
            if (other != null && other.GetType() == type) index++;
        }
        return index > 0 ? type.Name + "#" + index.ToString(TiInv) : type.Name;
    }

    static Component TiResolveComponent(GameObject go, TunerInspectorComponentArgs spec)
    {
        if (go == null || spec == null || string.IsNullOrEmpty(spec.type)) return null;
        int seen = 0;
        foreach (var c in go.GetComponents<Component>())
        {
            if (c == null) continue;
            var t = c.GetType();
            if (t.Name != spec.type && t.FullName != spec.type) continue;
            if (seen == spec.index) return c;
            seen++;
        }
        return null;
    }

    static bool TiEnsureBuilt(TiSession s)
    {
        if (!s.NeedsRebuild && !TiTargetsGone(s))
        {
            if (s.Tracker != null && TiTrackerChanged(s))
            {
                TiCancelPopups(s);
                TiClearSections(s);
                s.Root.Clear();
                TiSectionsFromEditors(s, s.Tracker.activeEditors);
                s.Signature = TiComponentSignature(s);
                s.Dirty = true;
            }
            return true;
        }
        TiBuild(s);
        return true;
    }

    static void TiEnsurePanel(TiSession s)
    {
        if (s.Panel != null && s.Owner != null && s.Root != null) return;
        s.Owner = ScriptableObject.CreateInstance<TunerInspectorPanelOwner>();
        s.Owner.hideFlags = HideFlags.HideAndDontSave;
        s.Owner.name = "SaturaTunerInspector " + s.Id;
        var panel = (IPanel)s_TiFindOrCreatePanel.Invoke(null, new object[] { s.Owner });
        TiSetMember(panel, "UpdateScalingFromEditorWindow", false);
        TiSetMember(panel, "pixelsPerPoint", 1f);
        s_TiAddStyleSheets.Invoke(null, new object[] { panel.visualTree });
        panel.visualTree.style.position = Position.Absolute;
        panel.visualTree.style.left = 0;
        panel.visualTree.style.top = 0;
        panel.visualTree.disablePlayModeTint = true;
        var root = new VisualElement();
        root.name = "SaturaTunerInspectorRoot";
        root.AddToClassList("unity-inspector-main-container");
        root.style.flexShrink = 0;
        root.style.flexDirection = FlexDirection.Column;
        panel.visualTree.Add(root);
        s.Panel = panel;
        s.Root = root;
    }

    static void TiBuild(TiSession s)
    {
        TiEnsurePanel(s);
        TiCancelPopups(s);
        TiClearSections(s);
        TiDestroyTracker(s);
        s.Root.Clear();
        s.NeedsRebuild = false;
        s.Error = null;
        s.Go = null;
        s.Gos.Clear();
        s.Asset = null;
        s.Kb = 0;
        s.Hot = 0;
        s.Dirty = true;
        s.ViewAssets = null;
        var spec = s.Spec;
        if (spec.kind == "asset")
        {
            var asset = AssetDatabase.LoadMainAssetAtPath(spec.path);
            if (asset == null)
            {
                s.Error = "No asset at '" + spec.path + "'";
                s.Signature = "";
                return;
            }
            s.Asset = asset;
            s.Go = asset as GameObject;
            if (!TiBuildTracked(s, new List<Object> { asset }))
            {
                if (s.Go != null) TiBuildGameObject(s, s.Go, null);
                else TiBuildAsset(s, asset);
            }
            s.Signature = TiComponentSignature(s);
            return;
        }
        var target = TunerFindAt(spec.path, spec.scene, spec.at);
        if (target == null) target = TiFindObject(spec.path, spec.scene);
        if (target == null)
        {
            s.Error = "No GameObject at '" + spec.path + "'" + (string.IsNullOrEmpty(spec.scene) ? "" : " in scene '" + spec.scene + "'");
            s.Signature = "";
            return;
        }
        s.Go = target;
        s.Gos.Add(target);
        if (spec.targets != null)
            foreach (var x in spec.targets)
            {
                if (x == null || string.IsNullOrEmpty(x.path)) continue;
                var other = TunerFindAt(x.path, x.scene, x.at) ?? TiFindObject(x.path, x.scene);
                if (other == null)
                {
                    s.Error = "No GameObject at '" + x.path + "'" + (string.IsNullOrEmpty(x.scene) ? "" : " in scene '" + x.scene + "'");
                    s.Signature = "";
                    s.Go = null;
                    s.Gos.Clear();
                    return;
                }
                if (!s.Gos.Contains(other)) s.Gos.Add(other);
            }
        if (s.Gos.Count > 1)
        {
            if (!TiBuildTracked(s, s.Gos.Cast<Object>().ToList())) TiBuildGameObject(s, target, spec.restrict ? spec.components : null);
        }
        else if (spec.restrict || !TiBuildTracked(s, new List<Object> { target })) TiBuildGameObject(s, target, spec.restrict ? spec.components : null);
        s.Signature = TiComponentSignature(s);
    }

    static void TiBuildGameObject(TiSession s, GameObject go, TunerInspectorComponentArgs[] only)
    {
        var goEditor = Editor.CreateEditor(go);
        if (goEditor != null)
        {
            goEditor.hideFlags = HideFlags.HideAndDontSave;
            var header = new TiSection { Key = "GameObject", Kind = "gameObject", Title = go.name, TypeName = typeof(GameObject).FullName, Target = go, Editor = goEditor, LargeHeader = true, Expandable = false };
            TiAddSection(s, header, false);
        }
        if (only != null)
        {
            var renderers = new List<Renderer>();
            foreach (var spec in only)
            {
                var c = TiResolveComponent(go, spec);
                if (c == null)
                {
                    TiAddMessage(s, (spec != null ? spec.type : "?") + (spec != null && spec.index > 0 ? "#" + spec.index : ""), "This object has no " + (spec != null ? spec.type : "such") + " component.");
                    continue;
                }
                TiAddComponent(s, go, c, spec.hasFields ? spec.fields : null);
                if (c is Renderer r && !spec.hasFields) renderers.Add(r);
            }
            TiAddMaterialSections(s, renderers);
        }
        else
        {
            var removed = TiRemovedFor(go);
            foreach (var c in go.GetComponents<Component>())
            {
                if (c == null) continue;
                TiRemovedBefore(s, removed, c);
                if ((c.hideFlags & HideFlags.HideInInspector) != 0) continue;
                if (c is ParticleSystemRenderer) continue;
                TiAddComponent(s, go, c, null);
            }
            TiRemovedRest(s, removed);
            if (!EditorUtility.IsPersistent(go) || PrefabUtility.IsPartOfPrefabAsset(go))
                TiAddAddComponent(s, go);
        }
    }

    static void TiAddComponent(TiSession s, GameObject go, Component c, string[] fields)
    {
        var sec = new TiSection
        {
            Key = TiComponentKey(c, go),
            Kind = "component",
            Title = ObjectNames.GetInspectorTitle(c),
            TypeName = c.GetType().FullName,
            Target = c,
            Fields = fields
        };
        if (fields == null)
        {
            var editor = Editor.CreateEditor(c);
            if (editor == null) return;
            editor.hideFlags = HideFlags.HideAndDontSave;
            sec.Editor = editor;
        }
        else
        {
            sec.FieldsObject = new SerializedObject(c);
            var editor = Editor.CreateEditor(c);
            if (editor != null)
            {
                editor.hideFlags = HideFlags.HideAndDontSave;
                sec.Editor = editor;
            }
        }
        TiAddSection(s, sec, true);
    }

    static void TiBuildAsset(TiSession s, Object asset)
    {
        var editor = Editor.CreateEditor(asset);
        if (editor == null)
        {
            TiAddMessage(s, "asset", "Unity has no inspector for this asset.");
            return;
        }
        editor.hideFlags = HideFlags.HideAndDontSave;
        var sec = new TiSection
        {
            Key = "asset",
            Kind = "asset",
            Title = ObjectNames.GetInspectorTitle(asset),
            TypeName = asset.GetType().FullName,
            Target = asset,
            Editor = editor,
            LargeHeader = true,
            Expandable = false
        };
        TiAddSection(s, sec, true);
    }

    class TiRemovedQueue
    {
        public GameObject Go;
        public HashSet<Component> Removed;
        public List<Component> Order;
        public int Next;
    }

    static TiRemovedQueue TiRemovedFor(GameObject go)
    {
        if (go == null || EditorApplication.isPlaying || !PrefabUtility.IsPartOfNonAssetPrefabInstance(go) || PrefabUtility.IsAddedGameObjectOverride(go)) return null;
        var root = PrefabUtility.GetOutermostPrefabInstanceRoot(go);
        if (root == null) return null;
        HashSet<Component> removed = null;
        foreach (var rc in PrefabUtility.GetRemovedComponents(root))
        {
            if (rc.containingInstanceGameObject != go || rc.assetComponent == null) continue;
            if ((rc.assetComponent.hideFlags & HideFlags.HideInInspector) != 0) continue;
            if (rc.assetComponent is ParticleSystemRenderer) continue;
            (removed ?? (removed = new HashSet<Component>())).Add(rc.assetComponent);
        }
        if (removed == null) return null;
        var source = PrefabUtility.GetCorrespondingObjectFromSource(go);
        var order = source != null ? new List<Component>(source.GetComponents<Component>()) : new List<Component>(removed);
        foreach (var r in removed) if (!order.Contains(r)) order.Add(r);
        return new TiRemovedQueue { Go = go, Removed = removed, Order = order };
    }

    static void TiRemovedBefore(TiSession s, TiRemovedQueue q, Component c)
    {
        if (q == null || c == null) return;
        var src = PrefabUtility.GetCorrespondingObjectFromSource(c);
        int at = src != null ? q.Order.IndexOf(src) : -1;
        for (; q.Next < at; q.Next++)
            if (q.Removed.Contains(q.Order[q.Next])) TiAddRemovedComponent(s, q.Go, q.Order[q.Next]);
        if (at >= q.Next) q.Next = at + 1;
    }

    static void TiRemovedRest(TiSession s, TiRemovedQueue q)
    {
        if (q == null) return;
        for (; q.Next < q.Order.Count; q.Next++)
            if (q.Removed.Contains(q.Order[q.Next])) TiAddRemovedComponent(s, q.Go, q.Order[q.Next]);
    }

    static MethodInfo s_TiRemovedTitlebar;

    static void TiAddRemovedComponent(TiSession s, GameObject go, Component source)
    {
        var title = ObjectNames.GetInspectorTitle(source) + " (Removed)";
        var sec = new TiSection { Key = TiComponentKey(source, source.gameObject) + " (Removed)", Kind = "removedComponent", Title = title, TypeName = source.GetType().FullName, Target = go, Expandable = false };
        bool withBody = false;
        if (!TunerFilterSection(s, sec, ref withBody)) return;
        var el = new VisualElement();
        el.name = sec.Key;
        el.style.flexShrink = 0;
        var c = new IMGUIContainer(() => TiRemovedComponentGUI(go, source));
        c.style.paddingBottom = 2f;
        el.Add(c);
        sec.Element = el;
        sec.Header = c;
        s.Root.Add(el);
        s.Sections.Add(sec);
    }

    static void TiRemovedComponentGUI(GameObject go, Component source)
    {
        if (go == null || source == null) return;
        var tint = GUI.color;
        TiResetGUIState();
        GUI.color = tint;
        var r = GUILayoutUtility.GetRect(GUIContent.none, (GUIStyle)"IN Title");
        if (s_TiRemovedTitlebar == null)
            s_TiRemovedTitlebar = typeof(EditorGUI).GetMethod("RemovedComponentTitlebar", TiStatic, null, new[] { typeof(Rect), typeof(GameObject), typeof(Component) }, null);
        if (s_TiRemovedTitlebar != null) s_TiRemovedTitlebar.Invoke(null, new object[] { r, go, source });
        else GUI.Label(r, ObjectNames.GetInspectorTitle(source) + " (Removed)", (GUIStyle)"IN TitleText");
    }

    static void TiAddMessage(TiSession s, string key, string text, MessageType type = MessageType.Warning)
    {
        var sec = new TiSection { Key = key, Kind = "message", Title = text };
        var el = new VisualElement();
        el.style.flexShrink = 0;
        var c = new IMGUIContainer(() => TiMessageGUI(text, type));
        el.Add(c);
        sec.Element = el;
        sec.Header = c;
        s.Root.Add(el);
        s.Sections.Add(sec);
    }

    static void TiMessageGUI(string text, MessageType type)
    {
        var tint = GUI.color;
        TiResetGUIState();
        GUI.color = tint;
        EditorGUILayout.BeginVertical(EditorStyles.inspectorDefaultMargins);
        EditorGUILayout.HelpBox(text, type);
        EditorGUILayout.EndVertical();
    }

    static void TiAddSection(TiSession s, TiSection sec, bool withBody)
    {
        if (!TunerFilterSection(s, sec, ref withBody)) return;
        TiCountFields(sec, withBody);
        var el = new VisualElement();
        el.name = sec.Key;
        el.style.flexShrink = 0;
        el.style.flexDirection = FlexDirection.Column;
        sec.Element = el;
        var header = new IMGUIContainer(() => TiHeaderGUI(s, sec));
        header.name = sec.Key + "Header";
        el.Add(header);
        sec.Header = header;
        if (withBody)
        {
            VisualElement body = null;
            if (sec.Fields != null)
            {
                var fieldsC = new IMGUIContainer(() => TiFieldsGUI(sec));
                fieldsC.name = sec.Key + "Fields";
                fieldsC.style.overflow = Overflow.Visible;
                body = new VisualElement();
                body.Add(fieldsC);
            }
            else if (sec.Editor != null)
            {
                body = TiCreateInspectorElement(sec);
            }
            if (body != null)
            {
                body.style.paddingBottom = 2;
                body.style.flexShrink = 0;
                el.Add(body);
                sec.Body = body;
            }
        }
        s.Root.Add(el);
        s.Sections.Add(sec);
        if (sec.Body is InspectorElement ie)
        {
            try { ie.Bind(sec.Editor.serializedObject); } catch { }
        }
        TiApplyExpanded(sec);
    }

    static VisualElement TiCreateInspectorElement(TiSection sec)
    {
        var editor = sec.Editor;
        bool uitkDrawers = editor.GetType().Name == "GenericInspector" && TiNeedsUitkDrawers(editor);
        InspectorElement element = null;
        if (s_TiInspectorElementCtor != null && s_TiFrameworkImgui != null && !uitkDrawers)
        {
            try { element = (InspectorElement)s_TiInspectorElementCtor.Invoke(new object[] { editor, s_TiFrameworkImgui }); }
            catch { element = null; }
        }
        if (element == null) element = new InspectorElement(editor);
        element.focusable = false;
        sec.Uitk = element.ClassListContains(InspectorElement.uIECustomVariantUssClassName)
            || element.ClassListContains(InspectorElement.uIEDefaultVariantUssClassName)
            || element.Q<IMGUIContainer>() == null;
        return element;
    }

    static bool TiNeedsUitkDrawers(Editor editor)
    {
        try
        {
            var so = editor.serializedObject;
            var it = so.GetIterator();
            bool enter = true;
            int guard = 0;
            while (it.NextVisible(enter) && guard++ < 4000)
            {
                enter = true;
                var drawer = TiDrawerFor(it);
                if (drawer != null && TiIsUitkOnlyDrawer(drawer)) return true;
            }
        }
        catch
        {
        }
        return false;
    }

    static readonly Dictionary<Type, bool> s_TiUitkDrawerCache = new Dictionary<Type, bool>();

    static bool TiIsUitkOnlyDrawer(Type drawer)
    {
        bool r;
        if (s_TiUitkDrawerCache.TryGetValue(drawer, out r)) return r;
        var ui = drawer.GetMethod("CreatePropertyGUI", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(SerializedProperty) }, null);
        var gui = drawer.GetMethod("OnGUI", BindingFlags.Instance | BindingFlags.Public, null, new[] { typeof(Rect), typeof(SerializedProperty), typeof(GUIContent) }, null);
        bool customUi = ui != null && ui.DeclaringType != typeof(PropertyDrawer);
        bool customGui = gui != null && gui.DeclaringType != typeof(PropertyDrawer);
        r = customUi && !customGui;
        s_TiUitkDrawerCache[drawer] = r;
        return r;
    }

    static Type TiDrawerFor(SerializedProperty p)
    {
        if (s_TiGetHandler == null) return null;
        var handler = s_TiGetHandler.Invoke(null, new object[] { p });
        if (handler == null) return null;
        var drawerProp = handler.GetType().GetProperty("propertyDrawer", TiInstance);
        var drawer = drawerProp != null ? drawerProp.GetValue(handler) as PropertyDrawer : null;
        return drawer != null ? drawer.GetType() : null;
    }

    static void TiAddAddComponent(TiSession s, GameObject go)
    {
        var sec = new TiSection { Key = "AddComponent", Kind = "addComponent", Title = "Add Component", Target = go, Expandable = false };
        var el = new VisualElement();
        el.name = "AddComponent";
        el.style.flexShrink = 0;
        var c = new IMGUIContainer(() => TiAddComponentGUI(s, sec));
        c.name = "AddComponentButton";
        el.Add(c);
        sec.Element = el;
        sec.Header = c;
        s.Root.Add(el);
        s.Sections.Add(sec);
    }

    static void TiApplyExpanded(TiSection sec)
    {
        if (sec.Body == null) return;
        bool vis = sec.LargeHeader || !sec.Expandable || InternalEditorUtility.GetIsInspectorExpanded(sec.Target);
        var want = vis ? DisplayStyle.Flex : DisplayStyle.None;
        if (sec.Body.style.display != want) sec.Body.style.display = want;
    }

    static bool TiExpanded(TiSection sec)
    {
        if (sec.LargeHeader || !sec.Expandable) return true;
        return sec.Target != null && InternalEditorUtility.GetIsInspectorExpanded(sec.Target);
    }

    static void TiHeaderGUI(TiSession s, TiSection sec)
    {
        var editor = sec.Editor;
        var target = sec.Target;
        if (target == null) return;
        var tint = GUI.color;
        TiResetGUIState();
        GUI.color = tint;
        if (sec.LargeHeader)
        {
            if (editor == null) return;
            if (sec.ImportedLabel) TiImportedLabel();
            using (new EditorGUI.DisabledScope(!TiEditorOpenForEdit(editor)))
                editor.DrawHeader();
            return;
        }
        if (editor == null)
        {
            var r = GUILayoutUtility.GetRect(GUIContent.none, (GUIStyle)"IN Title");
            EditorGUI.InspectorTitlebar(r, new[] { target });
            return;
        }
        sec.Expandable = TiCanExpand(editor);
        bool was = InternalEditorUtility.GetIsInspectorExpanded(target);
        bool now;
        using (new EditorGUI.DisabledScope(!TiEditorEnabled(editor)))
            now = EditorGUILayout.InspectorTitlebar(was, editor);
        if (now != was)
        {
            InternalEditorUtility.SetIsInspectorExpanded(target, now);
            TiApplyExpanded(sec);
            TiMarkDirty(s);
        }
    }

    static Action s_TiResetGui;
    static Func<Editor, bool> s_TiEditorEnabled;
    static Func<Editor, bool> s_TiEditorOpenForEdit;
    static bool s_TiGuiLooked;

    static void TiLookGui()
    {
        if (s_TiGuiLooked) return;
        s_TiGuiLooked = true;
        var reset = typeof(EditorGUIUtility).GetMethod("ResetGUIState", TiStatic, null, Type.EmptyTypes, null);
        if (reset != null) s_TiResetGui = (Action)Delegate.CreateDelegate(typeof(Action), reset);
        var enabled = typeof(Editor).GetMethod("IsEnabled", TiInstance, null, Type.EmptyTypes, null);
        if (enabled != null) s_TiEditorEnabled = (Func<Editor, bool>)Delegate.CreateDelegate(typeof(Func<Editor, bool>), enabled);
        var openForEdit = typeof(Editor).GetMethod("IsOpenForEdit", TiInstance, null, Type.EmptyTypes, null);
        if (openForEdit != null && openForEdit.ReturnType == typeof(bool))
            s_TiEditorOpenForEdit = (Func<Editor, bool>)Delegate.CreateDelegate(typeof(Func<Editor, bool>), openForEdit);
    }

    static void TiResetGUIState()
    {
        TiLookGui();
        if (s_TiResetGui != null)
        {
            s_TiResetGui();
            return;
        }
        GUI.skin = null;
        GUI.backgroundColor = Color.white;
        GUI.contentColor = Color.white;
        GUI.enabled = true;
        GUI.changed = false;
        EditorGUI.indentLevel = 0;
        EditorGUIUtility.fieldWidth = 0f;
        EditorGUIUtility.labelWidth = 0f;
        EditorGUIUtility.hierarchyMode = false;
        EditorGUIUtility.wideMode = false;
    }

    static bool TiEditorEnabled(Editor editor)
    {
        TiLookGui();
        if (editor == null) return false;
        if (s_TiEditorEnabled == null) return true;
        try { return s_TiEditorEnabled(editor); }
        catch { return true; }
    }

    static bool TiEditorOpenForEdit(Editor editor)
    {
        TiLookGui();
        if (editor == null) return false;
        if (s_TiEditorOpenForEdit == null) return true;
        try { return s_TiEditorOpenForEdit(editor); }
        catch { return true; }
    }

    static bool TiCanExpand(Editor editor)
    {
        if (s_TiCanExpand == null) return true;
        try { return (bool)s_TiCanExpand.Invoke(editor, null); }
        catch { return true; }
    }

    static void TiFieldsGUI(TiSection sec)
    {
        var so = sec.FieldsObject;
        if (so == null || so.targetObject == null) return;
        var tint = GUI.color;
        TiResetGUIState();
        GUI.color = tint;
        so.UpdateIfRequiredOrScript();
        bool hierarchy = EditorGUIUtility.hierarchyMode;
        bool wide = EditorGUIUtility.wideMode;
        EditorGUIUtility.hierarchyMode = true;
        EditorGUIUtility.wideMode = EditorGUIUtility.currentViewWidth > 330f;
        try
        {
            EditorGUILayout.BeginVertical(EditorStyles.inspectorDefaultMargins);
            if (sec.FieldTree == null) sec.FieldTree = TiFieldTree(so, sec.Fields);
            int indent = EditorGUI.indentLevel;
            try { TiFieldNodeGUI(so, sec.FieldTree, 0); }
            finally { EditorGUI.indentLevel = indent; }
            EditorGUILayout.EndVertical();
        }
        finally
        {
            EditorGUIUtility.hierarchyMode = hierarchy;
            EditorGUIUtility.wideMode = wide;
        }
        so.ApplyModifiedProperties();
    }

    static void TiAddComponentGUI(TiSession s, TiSection sec)
    {
        var tint = GUI.color;
        TiResetGUIState();
        GUI.color = tint;
        EditorGUI.indentLevel = 0;
        var go = sec.Target as GameObject;
        if (go == null) return;
        var style = (GUIStyle)"AC Button";
        var content = EditorGUIUtility.TrTextContent("Add Component");
        EditorGUILayout.BeginHorizontal(GUIStyle.none, GUILayout.Height(45f));
        GUILayout.FlexibleSpace();
        Rect rect = GUILayoutUtility.GetRect(content, style);
        rect.y += 9f;
        if (EditorGUI.DropdownButton(rect, content, FocusType.Passive, style))
        {
            if (!TunerPopupAddComponent(rect, go))
            {
                var data = new StringBuilder();
                data.Append("{\"type\":\"addComponent\",\"path\":");
                TiStr(data, TiObjectPath(go));
                data.Append('}');
                TunerInspectorAddPopup("dropdown", rect, false, data.ToString(), go, null, null);
            }
        }
        GUILayout.FlexibleSpace();
        EditorGUILayout.EndHorizontal();
    }
}
