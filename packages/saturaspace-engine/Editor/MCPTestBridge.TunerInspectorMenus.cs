using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    class TunerPopup
    {
        public int Id;
        public string Kind;
        public Rect Anchor;
        public string Section;
        public string DataJson;
        public object Payload;
        public TiSession Session;
        public TiSection Sec;
        public IMGUIContainer Container;
        public Func<TunerPopup, string, string, string> Answer;
        public Action<TunerPopup> Dispose;
    }

    class TiMenuState
    {
        public string[] Options;
        public int[] Map;
        public string[] Paths;
        public Object[] Context;
        public EditorUtility.SelectMenuItemFunction Callback;
        public object UserData;
        public string[] CallbackOptions;
        public Action[] Actions;
    }

    class TiMenuEntry
    {
        public string Text;
        public bool Enabled = true;
        public bool Checked;
        public bool Separator;
        public int Map = -1;
        public string Path;
        public int Priority;
        public Action Action;
    }

    static bool TunerInspectorDispatching => s_TiDispatch != null;
    static bool s_TiInAnswer;
    static string s_TiPendingCommand;

    static void TiCommandCreated(string commandName)
    {
        if (s_TiInAnswer) s_TiPendingCommand = commandName;
    }

    static TunerPopup TunerInspectorAddPopup(string kind, Rect rect, bool screenSpace, string dataJson, object payload, Func<TunerPopup, string, string, string> answer, Action<TunerPopup> dispose)
    {
        var s = s_TiDispatch;
        if (s == null) return null;
        var p = new TunerPopup
        {
            Id = s.NextPopupId++,
            Kind = kind,
            Anchor = TiToPanelRect(rect, screenSpace),
            Section = s_TiDispatchSection != null ? s_TiDispatchSection.Key : null,
            DataJson = string.IsNullOrEmpty(dataJson) ? "{}" : dataJson,
            Payload = payload,
            Session = s,
            Sec = s_TiDispatchSection,
            Container = s_TiDispatchContainer,
            Answer = answer,
            Dispose = dispose
        };
        s.Popups.Add(p);
        SaturaDebug.Log("[tunerInspector] popup " + p.Id + " kind=" + kind + " anchor=" + p.Anchor + " section=" + p.Section);
        return p;
    }

    static bool TunerInspectorSendCommand(TunerPopup p, string commandName)
    {
        if (p == null || p.Session == null || p.Sec == null || p.Container == null) return false;
        var sec = p.Sec;
        int index = sec.Containers.IndexOf(p.Container);
        if (index < 0) index = 0;
        var used = TiSend(p.Session, sec, p.Container, index, new Event { type = EventType.ExecuteCommand, commandName = commandName }, null);
        TiMarkDirty(p.Session);
        return used;
    }

    static Rect TiToPanelRect(Rect r, bool screenSpace)
    {
        var c = s_TiDispatchContainer;
        var world = c != null ? c.worldBound.position : Vector2.zero;
        if (!s_TiInGui)
        {
            if (screenSpace || c == null) return new Rect(s_TiMouseWorld.x > -1000f ? s_TiMouseWorld : Vector2.zero, r.size);
            return new Rect(r.position + world, r.size);
        }
        try
        {
            Vector2 local;
            if (screenSpace)
            {
                var off = GUIUtility.GUIToScreenPoint(Vector2.zero) - s_TiUnclipVec(Vector2.zero);
                local = r.position - off;
            }
            else local = s_TiUnclipVec(r.position);
            return new Rect(local + world, r.size);
        }
        catch
        {
            return new Rect(world, r.size);
        }
    }

    static void TiCancelPopups(TiSession s)
    {
        if (s.Popups.Count == 0) return;
        var list = s.Popups.ToArray();
        s.Popups.Clear();
        foreach (var p in list)
        {
            try { p.Dispose?.Invoke(p); }
            catch (Exception e) { Debug.LogWarning("[tunerInspector] popup dispose failed: " + e.Message); }
        }
        TiClearPopupCallback();
    }

    static void TiClearPopupCallback()
    {
        try { s_TiPopupInstance?.SetValue(null, null); }
        catch { }
    }

    static void TiDetachPopupSource()
    {
        if (s_TiPopupInstance == null || s_TiPopupSourceView == null) return;
        try
        {
            var inst = s_TiPopupInstance.GetValue(null);
            if (inst != null) s_TiPopupSourceView.SetValue(inst, null);
        }
        catch
        {
        }
    }

    static string TiAnswerPopup(TiSession s, int id, string action, string value)
    {
        TunerPopup p = null;
        foreach (var x in s.Popups)
            if (x.Id == id)
            {
                p = x;
                break;
            }
        if (p == null) return "that popup is no longer open";
        if (action == "cancel")
        {
            s.Popups.Remove(p);
            try { p.Dispose?.Invoke(p); }
            catch (Exception e) { Debug.LogWarning("[tunerInspector] popup dispose failed: " + e.Message); }
            TiClearPopupCallback();
            return null;
        }
        if (p.Answer == null) return "The Tuner can't show '" + p.Kind + "' popups yet";
        var prevSession = s_TiDispatch;
        var prevSection = s_TiDispatchSection;
        var prevContainer = s_TiDispatchContainer;
        var prevMouse = s_TiMouseWorld;
        s_TiDispatch = s;
        s_TiDispatchSection = p.Sec;
        s_TiDispatchContainer = p.Container;
        s_TiMouseWorld = p.Anchor.position;
        string err;
        try
        {
            Undo.IncrementCurrentGroup();
            err = p.Answer(p, action, value);
        }
        finally
        {
            s_TiDispatch = prevSession;
            s_TiDispatchSection = prevSection;
            s_TiDispatchContainer = prevContainer;
            s_TiMouseWorld = prevMouse;
        }
        if (action == "commit" && s.Popups.Contains(p))
        {
            s.Popups.Remove(p);
            try { p.Dispose?.Invoke(p); }
            catch { }
        }
        TiMarkDirty(s);
        return err;
    }

    static bool TiCatchCustomMenu(Rect screenPos, string[] options, bool[] enabled, bool[] separator, int[] selected, EditorUtility.SelectMenuItemFunction callback, object userData)
    {
        if (s_TiDispatch == null) return false;
        TiDetachPopupSource();
        var entries = new List<TiMenuEntry>();
        TiAddCustomEntries(entries, options, enabled, separator, selected);
        var state = new TiMenuState { Callback = callback, UserData = userData, CallbackOptions = options };
        TiAddMenuPopup(screenPos, "custom", entries, state);
        return true;
    }

    static void TiAddCustomEntries(List<TiMenuEntry> entries, string[] options, bool[] enabled, bool[] separator, int[] selected)
    {
        if (options == null) return;
        var sel = new HashSet<int>();
        if (selected != null) foreach (var i in selected) sel.Add(i);
        for (int i = 0; i < options.Length; i++)
        {
            entries.Add(new TiMenuEntry
            {
                Text = options[i] ?? "",
                Enabled = enabled == null || i >= enabled.Length || enabled[i],
                Separator = separator != null && i < separator.Length && separator[i],
                Checked = sel.Contains(i),
                Map = i
            });
        }
    }

    static bool TiCatchObjectMenu(Rect screenPos, Object[] context, string[] options, bool[] enabled, bool[] separator, int[] selected, EditorUtility.SelectMenuItemFunction callback, object userData)
    {
        if (s_TiDispatch == null) return false;
        var entries = new List<TiMenuEntry>();
        TiAddCustomEntries(entries, options, enabled, separator, selected);
        var builtin = TiComponentEntries(context);
        if (entries.Count > 0 && builtin.Count > 0) entries.Add(new TiMenuEntry { Text = "", Separator = true });
        entries.AddRange(builtin);
        var native = TiNativeContextEntries(context);
        if (entries.Count > 0 && native.Count > 0) entries.Add(new TiMenuEntry { Text = "", Separator = true });
        entries.AddRange(native);
        var custom = TunerPopupContextMenuEntries(context);
        if (entries.Count > 0 && custom.Count > 0) entries.Add(new TiMenuEntry { Text = "", Separator = true });
        entries.AddRange(custom);
        var state = new TiMenuState { Callback = callback, UserData = userData, CallbackOptions = options, Context = context };
        TiAddMenuPopup(screenPos, "object", entries, state);
        return true;
    }

    static bool TiCatchPathMenu(Rect screenPos, string menuItemPath, Object context)
    {
        if (s_TiDispatch == null) return false;
        var ctx = context != null ? new[] { context } : null;
        var entries = TiMenuEntriesForPath(menuItemPath, ctx);
        var state = new TiMenuState { Context = ctx };
        TiAddMenuPopup(screenPos, "path", entries, state);
        return true;
    }

    static List<TiMenuEntry> TiComponentEntries(Object[] context)
    {
        var list = new List<TiMenuEntry>();
        var c = context != null && context.Length == 1 ? context[0] as Component : null;
        if (c == null || c is Transform) return list;
        var go = c.gameObject;
        bool editable = !EditorUtility.IsPersistent(go) || !PrefabUtility.IsPartOfImmutablePrefab(go);
        var all = go.GetComponents<Component>();
        int index = Array.IndexOf(all, c);
        list.Add(new TiMenuEntry
        {
            Text = "Reset",
            Enabled = editable,
            Action = () =>
            {
                Undo.RegisterCompleteObjectUndo(c, "Reset " + ObjectNames.GetInspectorTitle(c));
                Unsupported.SmartReset(c);
                EditorUtility.SetDirty(c);
            }
        });
        list.Add(new TiMenuEntry { Text = "", Separator = true });
        list.Add(new TiMenuEntry { Text = "Remove Component", Enabled = editable, Action = () => Undo.DestroyObjectImmediate(c) });
        list.Add(new TiMenuEntry { Text = "Move Up", Enabled = editable && index > 1, Action = () => UnityEditorInternal.ComponentUtility.MoveComponentUp(c) });
        list.Add(new TiMenuEntry { Text = "Move Down", Enabled = editable && index >= 0 && index < all.Length - 1, Action = () => UnityEditorInternal.ComponentUtility.MoveComponentDown(c) });
        list.Add(new TiMenuEntry { Text = "Copy Component", Action = () => UnityEditorInternal.ComponentUtility.CopyComponent(c) });
        list.Add(new TiMenuEntry { Text = "Paste Component As New", Enabled = editable, Action = () => UnityEditorInternal.ComponentUtility.PasteComponentAsNew(go) });
        list.Add(new TiMenuEntry { Text = "Paste Component Values", Enabled = editable, Action = () => UnityEditorInternal.ComponentUtility.PasteComponentValues(c) });
        var mb = c as MonoBehaviour;
        var script = mb != null ? MonoScript.FromMonoBehaviour(mb) : null;
        if (script != null)
        {
            list.Add(new TiMenuEntry { Text = "", Separator = true });
            list.Add(new TiMenuEntry { Text = "Edit Script", Action = () => AssetDatabase.OpenAsset(script) });
        }
        return list;
    }

    static List<TiMenuEntry> TiNativeContextEntries(Object[] context)
    {
        var all = new List<TiMenuEntry>();
        if (context == null || context.Length == 0 || context[0] == null) return all;
        var seen = new HashSet<string>();
        for (var t = context[0].GetType(); t != null && t != typeof(Object) && t != typeof(object); t = t.BaseType)
        {
            foreach (var e in TiMenuEntriesForPath("CONTEXT/" + t.Name, context))
            {
                if (!e.Separator && (!seen.Add(e.Text) || TiBuiltinLabel(e.Text))) continue;
                all.Add(e);
            }
        }
        all.Sort((a, b) => a.Priority.CompareTo(b.Priority));
        var outList = new List<TiMenuEntry>();
        TiMenuEntry last = null;
        foreach (var e in all)
        {
            if (e.Separator)
            {
                if (last != null && !last.Separator) outList.Add(e);
                last = e;
                continue;
            }
            if (last != null && !last.Separator && e.Priority - last.Priority > 10)
                outList.Add(new TiMenuEntry { Text = TiSubmenuOf(e.Text), Separator = true, Priority = e.Priority });
            outList.Add(e);
            last = e;
        }
        while (outList.Count > 0 && outList[outList.Count - 1].Separator) outList.RemoveAt(outList.Count - 1);
        return outList;
    }

    static bool TiBuiltinLabel(string text)
    {
        switch (text)
        {
            case "Reset":
            case "Remove Component":
            case "Move Up":
            case "Move Down":
            case "Copy Component":
            case "Paste Component As New":
            case "Paste Component Values":
            case "Edit Script":
                return true;
            default:
                return false;
        }
    }

    static string TiSubmenuOf(string text)
    {
        var i = text.LastIndexOf('/');
        return i >= 0 ? text.Substring(0, i + 1) : "";
    }

    static List<TiMenuEntry> TiMenuEntriesForPath(string root, Object[] context)
    {
        var list = new List<TiMenuEntry>();
        if (s_TiMenuGetItems == null || string.IsNullOrEmpty(root)) return list;
        var prefix = root.TrimEnd('/');
        Array items;
        try { items = s_TiMenuGetItems.Invoke(null, new object[] { prefix, true, false }) as Array; }
        catch { return list; }
        if (items == null) return list;
        PropertyInfo pathP = null, sepP = null, prioP = null;
        foreach (var it in items)
        {
            if (it == null) continue;
            if (pathP == null)
            {
                var t = it.GetType();
                pathP = t.GetProperty("path", TiInstance);
                sepP = t.GetProperty("isSeparator", TiInstance);
                prioP = t.GetProperty("priority", TiInstance);
            }
            var path = pathP != null ? pathP.GetValue(it) as string : null;
            if (string.IsNullOrEmpty(path)) continue;
            bool sep = sepP != null && (bool)sepP.GetValue(it);
            int prio = prioP != null ? (int)prioP.GetValue(it) : 0;
            var label = path.StartsWith(prefix + "/", StringComparison.Ordinal) ? path.Substring(prefix.Length + 1) : path;
            var e = new TiMenuEntry { Text = sep ? TiSubmenuOf(label) : label, Separator = sep, Priority = prio, Path = sep ? null : path };
            if (!sep)
            {
                try
                {
                    if (s_TiMenuEnabledWithContext != null && context != null) e.Enabled = (bool)s_TiMenuEnabledWithContext.Invoke(null, new object[] { path, context });
                    else e.Enabled = Menu.GetEnabled(path);
                }
                catch
                {
                    e.Enabled = true;
                }
                try { e.Checked = Menu.GetChecked(path); }
                catch { }
            }
            list.Add(e);
        }
        return list;
    }

    static void TiAddMenuPopup(Rect screenPos, string context, List<TiMenuEntry> entries, TiMenuState state)
    {
        state.Options = new string[entries.Count];
        state.Map = new int[entries.Count];
        state.Paths = new string[entries.Count];
        state.Actions = new Action[entries.Count];
        for (int i = 0; i < entries.Count; i++) state.Actions[i] = entries[i].Action;
        var sb = new StringBuilder(512);
        sb.Append("{\"context\":\"").Append(context).Append("\",\"options\":[");
        for (int i = 0; i < entries.Count; i++)
        {
            var e = entries[i];
            state.Options[i] = e.Text;
            state.Map[i] = e.Map;
            state.Paths[i] = e.Path;
            if (i > 0) sb.Append(',');
            TiStr(sb, e.Text);
        }
        sb.Append("],\"enabled\":[");
        for (int i = 0; i < entries.Count; i++) sb.Append(i > 0 ? "," : "").Append(entries[i].Enabled ? "true" : "false");
        sb.Append("],\"separator\":[");
        for (int i = 0; i < entries.Count; i++) sb.Append(i > 0 ? "," : "").Append(entries[i].Separator ? "true" : "false");
        sb.Append("],\"selected\":[");
        bool firstSel = true;
        for (int i = 0; i < entries.Count; i++)
        {
            if (!entries[i].Checked) continue;
            if (!firstSel) sb.Append(',');
            firstSel = false;
            sb.Append(i.ToString(TiInv));
        }
        sb.Append("]}");
        TunerInspectorAddPopup("menu", screenPos, true, sb.ToString(), state, TiAnswerMenu, null);
    }

    static string TiAnswerMenu(TunerPopup p, string action, string value)
    {
        if (action != "commit") return null;
        var st = p.Payload as TiMenuState;
        if (st == null) return "menu state is missing";
        int index;
        if (!int.TryParse((value ?? "").Trim().Trim('"'), NumberStyles.Integer, CultureInfo.InvariantCulture, out index)) return "a menu item index is required";
        if (index < 0 || index >= st.Options.Length) return "menu index out of range";
        var s = p.Session;
        s.Popups.Remove(p);
        var run = st.Actions != null ? st.Actions[index] : null;
        if (run != null)
        {
            try { run(); }
            catch (Exception e)
            {
                var inner = e.InnerException ?? e;
                if (!TiIsExitGui(inner)) Debug.LogException(inner);
            }
            SaturaDebug.Log("[tunerInspector] menu pick '" + st.Options[index] + "'");
            s.Kb = 0;
            TiMarkAllDirty();
            return null;
        }
        var path = st.Paths[index];
        if (path != null)
        {
            bool ok = false;
            try
            {
                if (st.Context != null && s_TiExecuteWithContext != null) ok = (bool)s_TiExecuteWithContext.Invoke(null, new object[] { path, st.Context });
                else ok = EditorApplication.ExecuteMenuItem(path);
            }
            catch (Exception e)
            {
                var inner = e.InnerException ?? e;
                if (!TiIsExitGui(inner)) Debug.LogException(inner);
                ok = true;
            }
            SaturaDebug.Log("[tunerInspector] menu pick '" + st.Options[index] + "' → " + path + (ok ? "" : " (not executed)"));
            s.Kb = 0;
            TiMarkAllDirty();
            return null;
        }
        int original = st.Map[index];
        if (original < 0) return "that menu item cannot be picked";
        s_TiPendingCommand = null;
        s_TiInAnswer = true;
        try { st.Callback?.Invoke(st.UserData, st.CallbackOptions, original); }
        catch (Exception e)
        {
            var inner = e.InnerException ?? e;
            if (!TiIsExitGui(inner) && !(s_TiPendingCommand != null && inner is NullReferenceException)) Debug.LogException(inner);
        }
        finally
        {
            s_TiInAnswer = false;
        }
        var command = s_TiPendingCommand;
        s_TiPendingCommand = null;
        if (command != null && p.Container != null && p.Sec != null)
        {
            int ci = Math.Max(0, p.Sec.Containers.IndexOf(p.Container));
            TiSend(s, p.Sec, p.Container, ci, new Event { type = EventType.ExecuteCommand, commandName = command }, null);
        }
        SaturaDebug.Log("[tunerInspector] menu pick " + index + " '" + st.Options[index] + "'");
        if (s_TiPopupInstance != null && s_TiPopupInstance.GetValue(null) != null && p.Container != null && p.Sec != null)
        {
            int ci = Math.Max(0, p.Sec.Containers.IndexOf(p.Container));
            TiSend(s, p.Sec, p.Container, ci, new Event { type = EventType.ExecuteCommand, commandName = "PopupMenuChanged" }, null);
        }
        s.Kb = 0;
        s.EditingText = false;
        return null;
    }

    static bool TiCatchPopupWindow(Rect activatorRect, PopupWindowContent content)
    {
        if (TunerPopupHostWindow(activatorRect, content)) return true;
        if (s_TiDispatch == null) return TunerPopupBlockWindow("PopupWindow", content != null ? content.GetType().FullName : null, null, activatorRect, null);
        var sb = new StringBuilder();
        sb.Append("{\"type\":\"PopupWindow\",\"content\":");
        TiStr(sb, content != null ? content.GetType().FullName : "");
        sb.Append('}');
        TunerInspectorAddPopup("window", activatorRect, false, sb.ToString(), content, null, null);
        return true;
    }

    static bool TiCatchWindow(EditorWindow w, Rect? screenRect)
    {
        if (w == null) return false;
        if (s_TiDispatch == null)
            return TunerPopupUitkCatch(() => TiCatchWindow(w, screenRect), () => TunerPopupCatchDropdownWindow(w, screenRect) || TunerPopupBlockWindow(w.GetType().FullName, null, w.titleContent != null ? w.titleContent.text : null, null, w));
        if (TunerPopupCatchDropdownWindow(w, screenRect)) return true;
        var sb = new StringBuilder();
        sb.Append("{\"type\":");
        TiStr(sb, w.GetType().FullName);
        TiStr(sb.Append(",\"title\":"), w.titleContent != null ? w.titleContent.text : "");
        sb.Append('}');
        var rect = screenRect ?? new Rect(0f, 0f, 1f, 1f);
        var p = TunerInspectorAddPopup("window", rect, true, sb.ToString(), w, null, x =>
        {
            var win = x.Payload as EditorWindow;
            if (win != null) Object.DestroyImmediate(win);
        });
        if (p != null && !screenRect.HasValue) p.Anchor = new Rect(s_TiMouseWorld.x > -1000f ? s_TiMouseWorld : Vector2.zero, new Vector2(1f, 1f));
        return true;
    }

    static void TiPopupsJson(StringBuilder sb, TiSession s)
    {
        if (s.Popups.Count == 0) return;
        sb.Append(",\"popups\":[");
        for (int i = 0; i < s.Popups.Count; i++)
        {
            var p = s.Popups[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"id\":").Append(p.Id.ToString(TiInv));
            TiStr(sb.Append(",\"kind\":"), p.Kind);
            TiRect(sb.Append(",\"anchor\":{"), p.Anchor).Append('}');
            if (p.Section != null) TiStr(sb.Append(",\"section\":"), p.Section);
            sb.Append(",\"data\":").Append(p.DataJson).Append('}');
        }
        sb.Append(']');
    }
}
