using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;

public static partial class MCPTestBridge
{
    const string TI_TEXT_COMMAND = "SaturaTunerInspectorText";

    static int s_TiTextId;
    static string s_TiTextValue;
    static bool s_TiTextHit;
    static bool s_TiInGui;
    static bool s_TiLoggedMouse;

    static bool TiSend(TiSession s, TiSection sec, IMGUIContainer c, int index, Event e, Vector2? mouseWorld)
    {
        if (c == null || s_TiHandleEvent == null) return false;
        var prevEvent = Event.current;
        int prevKb = GUIUtility.keyboardControl;
        int prevHot = GUIUtility.hotControl;
        bool prevEditing = EditorGUIUtility.editingTextField;
        var prevSession = s_TiDispatch;
        var prevSection = s_TiDispatchSection;
        var prevContainer = s_TiDispatchContainer;
        int prevIndex = s_TiDispatchIndex;
        bool prevMouseActive = s_TiMouseActive;
        var prevMouse = s_TiMouseWorld;
        bool prevInGui = s_TiInGui;
        var prevType = s_TiDispatchType;
        var prevDelta = s_TiDispatchDelta;
        s_TiDispatch = s;
        s_TiDispatchSection = sec;
        s_TiDispatchContainer = c;
        s_TiDispatchIndex = index;
        s_TiMouseActive = mouseWorld.HasValue;
        s_TiMouseWorld = mouseWorld ?? TiMouseAway;
        s_TiInGui = true;
        bool used = false;
        try
        {
            if (GUIUtility.keyboardControl != s.Kb) GUIUtility.keyboardControl = s.Kb;
            if (GUIUtility.hotControl != s.Hot) GUIUtility.hotControl = s.Hot;
            if (EditorGUIUtility.editingTextField != s.EditingText) EditorGUIUtility.editingTextField = s.EditingText;
            Event.current = e;
            s_TiDispatchType = e.type;
            s_TiDispatchDelta = e.isMouse || e.isScrollWheel ? e.delta : Vector2.zero;
            used = s_TiHandleEvent(c, e, true);
        }
        catch (Exception ex)
        {
            if (!TiIsExitGui(ex))
            {
                var inner = ex.InnerException ?? ex;
                var key = "send:" + (sec != null ? sec.Key : "?") + ":" + inner.GetType().Name + ":" + inner.Message;
                if (s.LoggedErrors.Add(key)) Debug.LogException(inner);
            }
        }
        finally
        {
            s.Kb = GUIUtility.keyboardControl;
            s.Hot = GUIUtility.hotControl;
            s.EditingText = EditorGUIUtility.editingTextField;
            if (GUIUtility.keyboardControl != prevKb) GUIUtility.keyboardControl = prevKb;
            if (GUIUtility.hotControl != prevHot) GUIUtility.hotControl = prevHot;
            if (EditorGUIUtility.editingTextField != prevEditing) EditorGUIUtility.editingTextField = prevEditing;
            Event.current = prevEvent;
            s_TiDispatch = prevSession;
            s_TiDispatchSection = prevSection;
            s_TiDispatchContainer = prevContainer;
            s_TiDispatchIndex = prevIndex;
            s_TiMouseActive = prevMouseActive;
            s_TiMouseWorld = prevMouse;
            s_TiInGui = prevInGui;
            s_TiDispatchType = prevType;
            s_TiDispatchDelta = prevDelta;
        }
        return used || e.type == EventType.Used;
    }

    static EventType s_TiDispatchType;
    static Vector2 s_TiDispatchDelta;

    static void TiRestoreMouseDelta()
    {
        if (s_TiDispatchDelta == Vector2.zero) return;
        var e = Event.current;
        if (e == null || e.rawType != s_TiDispatchType) return;
        e.delta = GUI.matrix.inverse.MultiplyVector(s_TiDispatchDelta);
    }

    static bool TiIsExitGui(Exception ex)
    {
        for (var e = ex; e != null; e = e.InnerException)
            if (e is ExitGUIException) return true;
        return false;
    }

    static void TiShiftMouse(IMGUIContainer inst, Event evt, ref Matrix4x4 parentTransform, ref Rect clippingRect)
    {
        var s = s_TiDispatch;
        if (s == null || !s_TiMouseActive || evt == null || s_TiAbsoluteMouse == null) return;
        if (inst == null || inst.panel != s.Panel) return;
        var t = evt.rawType;
        if (t == EventType.Layout || t == EventType.Used || t == EventType.Ignore) return;
        if (t == EventType.KeyDown || t == EventType.KeyUp || t == EventType.ExecuteCommand || t == EventType.ValidateCommand) return;
        var abs = s_TiAbsoluteMouse();
        var delta = abs - s_TiMouseWorld;
        parentTransform = Matrix4x4.Translate(new Vector3(delta.x, delta.y, 0f)) * parentTransform;
        clippingRect.position += delta;
        if (!s_TiLoggedMouse && t != EventType.Repaint)
        {
            s_TiLoggedMouse = true;
            SaturaDebug.Log("[tunerInspector] mouse " + t + " at " + s_TiMouseWorld + " via clip shift " + delta);
        }
    }

    static void TiTextField(object editor, int id, Rect position, string text, GUIStyle style, string allowedletters, bool multiline, bool password, ref string result, ref bool changed)
    {
        var e = Event.current;
        if (s_TiTextId != 0 && id == s_TiTextId)
        {
            if (e == null || e.type == EventType.Layout) return;
            result = s_TiTextValue;
            changed = true;
            GUI.changed = true;
            s_TiTextHit = true;
            return;
        }
        var s = s_TiDispatch;
        if (!s_TiRecording || s == null || id == 0 || e == null || e.type != EventType.Repaint) return;
        if (id != GUIUtility.keyboardControl) return;
        try
        {
            s.Focus = new TiFocusRec
            {
                Section = s_TiDispatchSection,
                Container = s_TiDispatchContainer,
                C = s_TiDispatchIndex,
                Control = id,
                R = s_TiUnclipRect(position),
                Text = EditorGUI.showMixedValue ? "" : text,
                Style = TiStyleId(s, style),
                Numeric = allowedletters != null,
                Multiline = multiline,
                Password = password,
                Delayed = editor != null && s_TiDelayedEditorType != null && s_TiDelayedEditorType.IsInstanceOfType(editor)
            };
        }
        catch
        {
        }
    }

    static void TiEditorRepainted(Editor ed)
    {
        if (ed == null || s_TiSessions.Count == 0) return;
        foreach (var s in s_TiSessions.Values)
            foreach (var sec in s.Sections)
                if (sec.Editor == ed)
                {
                    s.PaintAll = true;
                    TiMarkDirty(s);
                    break;
                }
    }

    static void TiRefreshContainers(TiSession s)
    {
        foreach (var sec in s.Sections)
        {
            sec.Containers.Clear();
            if (sec.Uitk)
            {
                if (sec.Header != null) sec.Containers.Add(sec.Header);
                if (sec.UitkImgui != null)
                    foreach (var island in sec.UitkImgui)
                        if (island != null) sec.Containers.Add(island);
                continue;
            }
            sec.Element.Query<IMGUIContainer>().ForEach(c =>
            {
                if (TiDisplayed(c, sec.Element)) sec.Containers.Add(c);
            });
        }
    }

    static bool TiContainerAt(TiSession s, Vector2 p, out TiSection section, out IMGUIContainer container, out int index)
    {
        for (int si = s.Sections.Count - 1; si >= 0; si--)
        {
            var sec = s.Sections[si];
            for (int i = sec.Containers.Count - 1; i >= 0; i--)
            {
                var c = sec.Containers[i];
                if (c.worldBound.Contains(p))
                {
                    section = sec;
                    container = c;
                    index = i;
                    return true;
                }
            }
        }
        section = null;
        container = null;
        index = -1;
        return false;
    }

    static EventModifiers TiModifiers(TunerInspectorInputArgs a)
    {
        var m = EventModifiers.None;
        if (a.shift) m |= EventModifiers.Shift;
        if (a.ctrl) m |= EventModifiers.Control;
        if (a.alt) m |= EventModifiers.Alt;
        if (a.cmd) m |= EventModifiers.Command;
        return m;
    }

    static string TiApplyInput(TiSession s, TunerInspectorInputArgs a)
    {
        if (a == null || string.IsNullOrEmpty(a.op)) return "an input op is required";
        TiEnsureBuilt(s);
        TiLayout(s);
        TiRefreshContainers(s);
        var dirtyBefore = TiAssetDirtyCounts(s);
        string err = null;
        switch (a.op)
        {
            case "mouse":
                err = TiMouse(s, a);
                break;
            case "wheel":
                err = TiWheel(s, a);
                break;
            case "key":
                err = TiKey(s, a);
                break;
            case "text":
                err = TiText(s, a);
                break;
            case "textCancel":
                s.Kb = 0;
                s.EditingText = false;
                s.FocusEditing = false;
                s.Focus = null;
                break;
            case "popup":
                err = TiAnswerPopup(s, a.id, a.action, a.value);
                break;
            case "undo":
                s.Kb = 0;
                Undo.PerformUndo();
                break;
            case "redo":
                s.Kb = 0;
                Undo.PerformRedo();
                break;
            case "uitk":
                err = TiUitkInput(s, a);
                break;
            case "psCurves":
                err = TiPscInput(s, a);
                break;
            case "popupFit":
                err = TunerPopupFit(s, a.section, a.y);
                break;
            case "hover":
                s.Hover = new Vector2(a.x, a.y);
                s.HoverMods = TiModifiers(a);
                break;
            case "leave":
                s.Hover = null;
                break;
            default:
                err = "unknown input: " + a.op;
                break;
        }
        TiSaveDirtyAssets(s, dirtyBefore);
        if (a.op != "hover" && a.op != "leave") s.PaintAll = true;
        TiMarkDirty(s);
        return err;
    }

    static string TiUitkInput(TiSession s, TunerInspectorInputArgs a)
    {
        foreach (var sec in s.Sections)
        {
            if (sec.Key != a.section) continue;
            if (!sec.Uitk || sec.Body == null) return "that section is not a UI Toolkit inspector";
            Undo.IncrementCurrentGroup();
            return TunerUitkInput(sec.Body, a.value ?? "");
        }
        return "no section '" + a.section + "'";
    }

    static string TiMouse(TiSession s, TunerInspectorInputArgs a)
    {
        var p = new Vector2(a.x, a.y);
        EventType type;
        switch (a.type)
        {
            case "down": type = EventType.MouseDown; break;
            case "up": type = EventType.MouseUp; break;
            case "drag": type = EventType.MouseDrag; break;
            case "move": type = EventType.MouseMove; break;
            default: return "unknown mouse event: " + a.type;
        }
        TiSection sec;
        IMGUIContainer c;
        int index;
        if (type != EventType.MouseDown && s.MouseContainer != null && s.MouseSection != null && (s.Hot != 0 || type == EventType.MouseUp))
        {
            sec = s.MouseSection;
            c = s.MouseContainer;
            index = Math.Max(0, sec.Containers.IndexOf(c));
        }
        else TiContainerAt(s, p, out sec, out c, out index);
        if (type == EventType.MouseDown)
        {
            if (sec == null || sec.Kind != "popupWindow") TiCancelPopups(s);
            Undo.IncrementCurrentGroup();
        }
        if (c == null)
        {
            if (type == EventType.MouseDown)
            {
                s.Kb = 0;
                s.EditingText = false;
            }
            if (type == EventType.MouseUp)
            {
                s.Hot = 0;
                s.MouseContainer = null;
                s.MouseSection = null;
            }
            return null;
        }
        var mods = TiModifiers(a);
        s.HoverMods = mods;
        var local = p - c.worldBound.position;
        int popupsBefore = s.Popups.Count;
        var e = new Event
        {
            type = type,
            mousePosition = local,
            button = Mathf.Clamp(a.button, 0, 2),
            clickCount = Math.Max(1, a.clicks),
            modifiers = mods,
            delta = new Vector2(a.dx, a.dy)
        };
        bool used = TiSend(s, sec, c, index, e, p);
        if (type == EventType.MouseDown) s.FocusEditing = s.EditingText && s.Kb != 0;
        if (type == EventType.MouseDown)
        {
            s.MouseContainer = c;
            s.MouseSection = sec;
            s.FocusContainer = c;
            s.FocusSection = sec;
            if (a.button == 1 && s.Popups.Count == popupsBefore)
            {
                var cc = new Event { type = EventType.ContextClick, mousePosition = local, button = 1, modifiers = mods };
                used |= TiSend(s, sec, c, index, cc, p);
            }
            if (!used && a.button == 0 && s.Hot == 0)
            {
                s.Kb = 0;
            }
        }
        else if (type == EventType.MouseUp)
        {
            if (s.Hot == 0)
            {
                s.MouseContainer = null;
                s.MouseSection = null;
            }
        }
        s.EditingText = false;
        return null;
    }

    static string TiWheel(TiSession s, TunerInspectorInputArgs a)
    {
        var p = new Vector2(a.x, a.y);
        TiSection sec;
        IMGUIContainer c;
        int index;
        if (!TiContainerAt(s, p, out sec, out c, out index)) return null;
        var e = new Event
        {
            type = EventType.ScrollWheel,
            mousePosition = p - c.worldBound.position,
            delta = new Vector2(a.dx, a.dy),
            modifiers = TiModifiers(a)
        };
        TiSend(s, sec, c, index, e, p);
        s.EditingText = false;
        return null;
    }

    static string TiKey(TiSession s, TunerInspectorInputArgs a)
    {
        KeyCode code = KeyCode.None;
        if (!string.IsNullOrEmpty(a.key) && !Enum.TryParse(a.key, true, out code)) code = KeyCode.None;
        char ch = string.IsNullOrEmpty(a.character) ? '\0' : a.character[0];
        var e = new Event
        {
            type = a.type == "up" ? EventType.KeyUp : EventType.KeyDown,
            keyCode = code,
            character = ch,
            modifiers = TiModifiers(a)
        };
        var c = s.FocusContainer;
        var sec = s.FocusSection;
        if (c == null || sec == null || !sec.Containers.Contains(c)) return null;
        int before = s.Kb;
        TiSend(s, sec, c, sec.Containers.IndexOf(c), e, null);
        if (code == KeyCode.Tab && e.type == EventType.KeyDown && before != 0)
        {
            if (s.Kb == 0 || s.Kb == before) TiTabAcross(s, sec, c, a.shift);
            s.FocusEditing = s.Kb != 0;
        }
        s.EditingText = false;
        return null;
    }

    const string TI_FOCUS_COMMAND = "SaturaTunerInspectorFocus";
    static Action s_TiFocusFirst;
    static Action s_TiFocusLast;
    static Func<bool> s_TiHasFocusable;
    static bool s_TiFocusLooked;

    static bool TiFocusEdge(TiSession s, TiSection sec, IMGUIContainer c, bool last)
    {
        if (!s_TiFocusLooked)
        {
            s_TiFocusLooked = true;
            var first = typeof(GUIUtility).GetMethod("SetKeyboardControlToFirstControlId", TiStatic);
            var lastM = typeof(GUIUtility).GetMethod("SetKeyboardControlToLastControlId", TiStatic);
            var has = typeof(GUIUtility).GetMethod("HasFocusableControls", TiStatic);
            if (first != null) s_TiFocusFirst = (Action)Delegate.CreateDelegate(typeof(Action), first);
            if (lastM != null) s_TiFocusLast = (Action)Delegate.CreateDelegate(typeof(Action), lastM);
            if (has != null) s_TiHasFocusable = (Func<bool>)Delegate.CreateDelegate(typeof(Func<bool>), has);
        }
        var focus = last ? s_TiFocusLast : s_TiFocusFirst;
        var orig = c.onGUIHandler;
        if (focus == null || orig == null) return false;
        bool got = false;
        c.onGUIHandler = () =>
        {
            orig();
            var e = Event.current;
            if (e == null || e.commandName != TI_FOCUS_COMMAND || e.rawType == EventType.Layout) return;
            if (s_TiHasFocusable != null && !s_TiHasFocusable()) return;
            focus();
            got = true;
        };
        try { TiSend(s, sec, c, sec.Containers.IndexOf(c), new Event { type = EventType.ExecuteCommand, commandName = TI_FOCUS_COMMAND }, null); }
        finally { c.onGUIHandler = orig; }
        return got;
    }

    static void TiTabAcross(TiSession s, TiSection fromSection, IMGUIContainer from, bool shift)
    {
        var order = new List<KeyValuePair<TiSection, IMGUIContainer>>();
        foreach (var sec in s.Sections)
            foreach (var c in sec.Containers)
                order.Add(new KeyValuePair<TiSection, IMGUIContainer>(sec, c));
        int at = order.FindIndex(kv => kv.Value == from);
        if (at < 0) return;
        for (int step = 1; step < order.Count; step++)
        {
            int i = shift ? at - step : at + step;
            if (i < 0 || i >= order.Count) break;
            var sec = order[i].Key;
            var c = order[i].Value;
            s.Kb = 0;
            if (!TiFocusEdge(s, sec, c, shift)) continue;
            if (s.Kb != 0)
            {
                s.FocusContainer = c;
                s.FocusSection = sec;
                return;
            }
        }
        s.Kb = 0;
    }

    static string TiText(TiSession s, TunerInspectorInputArgs a)
    {
        if (!s_TiPatched) return "text entry needs the Harmony patch, which failed: " + s_TiPatchError;
        if (a.control == 0) return "a control id is required";
        TiSection sec = null;
        IMGUIContainer c = null;
        if (s.Focus != null && s.Focus.Control == a.control && s.Focus.Section != null && s.Focus.Section.Containers.Contains(s.Focus.Container))
        {
            sec = s.Focus.Section;
            c = s.Focus.Container;
        }
        else if (s.FocusSection != null && s.FocusContainer != null && s.FocusSection.Containers.Contains(s.FocusContainer))
        {
            sec = s.FocusSection;
            c = s.FocusContainer;
        }
        if (c == null) return "that field is no longer on screen";
        int index = sec.Containers.IndexOf(c);
        try { s_TiEndEditing?.Invoke(null, null); }
        catch { }
        s.Kb = a.control;
        s.EditingText = false;
        s_TiTextId = a.control;
        s_TiTextValue = a.value ?? "";
        s_TiTextHit = false;
        if (a.commit == "live")
        {
            if (s.LiveControl != a.control)
            {
                Undo.IncrementCurrentGroup();
                s.LiveControl = a.control;
            }
        }
        else
        {
            if (s.LiveControl != a.control) Undo.IncrementCurrentGroup();
            s.LiveControl = 0;
        }
        int modSeq = _tunerAnimModSeq;
        Rect? focusRect = s.Focus != null && s.Focus.Control == a.control ? s.Focus.R : (Rect?)null;
        try
        {
            TiSend(s, sec, c, index, new Event { type = EventType.ExecuteCommand, commandName = TI_TEXT_COMMAND }, null);
        }
        finally
        {
            s_TiTextId = 0;
        }
        bool hit = s_TiTextHit;
        if (hit && a.commit != "live" && modSeq == _tunerAnimModSeq && focusRect.HasValue) TiRecordSameValue(sec, index, focusRect.Value);
        s.FocusEditing = false;
        switch (a.commit)
        {
            case "live":
                s.Kb = a.control;
                s.FocusEditing = true;
                break;
            case "tab":
            case "shiftTab":
                s.Kb = a.control;
                var tab = new Event { type = EventType.KeyDown, keyCode = KeyCode.Tab, character = '\t', modifiers = a.commit == "shiftTab" ? EventModifiers.Shift : EventModifiers.None };
                TiSend(s, sec, c, index, tab, null);
                if (s.Kb == a.control || s.Kb == 0) TiTabAcross(s, sec, c, a.commit == "shiftTab");
                else
                {
                    s.FocusContainer = c;
                    s.FocusSection = sec;
                }
                s.FocusEditing = s.Kb != 0;
                break;
            default:
                s.Kb = 0;
                break;
        }
        s.EditingText = false;
        return hit ? null : "that field was not drawn in this pass; capture again and retry";
    }

    static void TiRecordSameValue(TiSection sec, int index, Rect r)
    {
        TiPropRec best = null;
        var center = r.center;
        foreach (var p in sec.Props)
            if (p.C == index && p.R.Contains(center) && (best == null || p.R.width * p.R.height < best.R.width * best.R.height)) best = p;
        if (best == null) return;
        var path = best.Path;
        if (path.IndexOf('/') >= 0) return;
        if (sec.Target is Transform && (path.StartsWith("m_LocalPosition", StringComparison.Ordinal) || path.StartsWith("m_LocalRotation", StringComparison.Ordinal) || path.StartsWith("m_LocalScale", StringComparison.Ordinal)))
        {
            int dot = path.IndexOf('.');
            if (dot > 0) path = path.Substring(0, dot);
        }
        try { TunerAnimRecordSame(sec.Target, path); }
        catch (Exception e) { Debug.LogWarning("[Tuner] animator: could not key " + path + ": " + e.Message); }
    }
}
