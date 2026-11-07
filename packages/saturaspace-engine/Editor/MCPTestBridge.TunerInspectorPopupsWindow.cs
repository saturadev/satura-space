using System;
using System.Collections;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.IMGUI.Controls;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    sealed class TunerPopupWindow
    {
        public TiSession Session;
        public TiSection Section;
        public PopupWindowContent Content;
        public EditorWindow Proxy;
        public VisualElement Element;
        public IMGUIContainer Container;
        public Vector2 Size;
        public TunerPopup Popup;
        public bool Closed;
        public bool TreesQuiet;
        public TunerPopupWindow Parent;
        public float MaxH;
    }

    const float TUNER_POPUP_WINDOW_TOP = TI_MAX_HEIGHT - 6000;
    static readonly List<TunerPopupWindow> s_TunerPopupWindows = new List<TunerPopupWindow>();
    static readonly PropertyInfo s_TunerPopupContentWindow = typeof(PopupWindowContent).GetProperty("editorWindow", TunerPopupAny);
    static int s_TunerPopupWindowSeq;
    static readonly FieldInfo s_TunerPopupWindowParent = typeof(EditorWindow).GetField("m_Parent", BindingFlags.Instance | BindingFlags.NonPublic);

    static Vector2 TunerPopupWindowSize(PopupWindowContent content)
    {
        Vector2 size;
        try { size = content.GetWindowSize(); }
        catch { size = new Vector2(200f, 200f); }
        if (float.IsNaN(size.x) || size.x < 16f) size.x = 16f;
        if (float.IsNaN(size.y) || size.y < 16f) size.y = 16f;
        return new Vector2(Mathf.Min(size.x, 2000f), Mathf.Min(size.y, 4000f));
    }

    static Vector2 TunerPopupFitSize(TunerPopupWindow host, Vector2 size)
    {
        if (host.MaxH > 0f && host.Container != null && size.y > host.MaxH) size.y = host.MaxH;
        return size;
    }

    static string TunerPopupFit(TiSession s, string key, float maxH)
    {
        foreach (var w in s_TunerPopupWindows)
        {
            if (w.Session != s || w.Closed || w.Section == null || w.Section.Key != key) continue;
            w.MaxH = maxH >= 64f ? maxH : 0f;
            if (w.Container == null) return null;
            var next = TunerPopupFitSize(w, TunerPopupWindowSize(w.Content));
            if (next == w.Size) return null;
            SaturaDebug.Log("[tunerPopup] window " + w.Section.Title + " fits " + next.x + "x" + next.y + " (it wants " + TunerPopupWindowSize(w.Content).y + " high)");
            w.Size = next;
            w.Element.style.width = next.x;
            w.Element.style.height = next.y;
            w.Container.style.width = next.x;
            w.Container.style.height = next.y;
            return null;
        }
        return "no popup window '" + key + "'";
    }

    static bool TunerPopupHostWindow(Rect activatorRect, PopupWindowContent content)
    {
        if (content == null) return false;
        if (s_TiDispatch != null) return TunerPopupHostWindowIn(activatorRect, content, false);
        return TunerPopupUitkSection(out var session, out var sec) && TunerPopupInDispatch(session, sec, () => TunerPopupHostWindowIn(activatorRect, content, true));
    }

    static bool TunerPopupUitkSection(out TiSession session, out TiSection section)
    {
        session = null;
        section = null;
        var root = s_TunerUitkDispatchRoot;
        if (root == null) return false;
        foreach (var s in s_TiSessions.Values)
            foreach (var sec in s.Sections)
            {
                if (!sec.Uitk || sec.Body == null) continue;
                for (var e = root; e != null; e = e.hierarchy.parent)
                {
                    if (e != sec.Body) continue;
                    session = s;
                    section = sec;
                    return true;
                }
            }
        return false;
    }

    static bool TunerPopupInDispatch(TiSession session, TiSection sec, Func<bool> body)
    {
        var prevSession = s_TiDispatch;
        var prevSection = s_TiDispatchSection;
        var prevContainer = s_TiDispatchContainer;
        s_TiDispatch = session;
        s_TiDispatchSection = sec;
        s_TiDispatchContainer = null;
        try { return body(); }
        finally
        {
            s_TiDispatch = prevSession;
            s_TiDispatchSection = prevSection;
            s_TiDispatchContainer = prevContainer;
        }
    }

    static bool TunerPopupUitkCatch(Func<bool> inTuner, Func<bool> inDevTab)
    {
        if (s_TiDispatch != null || s_TunerUitkDispatchRoot == null) return false;
        if (TunerPopupUitkSection(out var session, out var sec)) return TunerPopupInDispatch(session, sec, inTuner);
        return inDevTab();
    }

    static bool TunerPopupBlockWindow(string type, string content, string title, Rect? anchor, EditorWindow window)
    {
        var root = s_TunerUitkDispatchRoot;
        if (root == null || root.panel == null) return false;
        var owner = root.panel.Pick(s_TunerUitkLastPointer);
        if (owner == null || TunerUitkRootOf(owner, out _) != root) owner = root;
        var data = new StringBuilder(160);
        data.Append("{\"type\":").Append(TunerUitkStr(type));
        if (!string.IsNullOrEmpty(content)) data.Append(",\"content\":").Append(TunerUitkStr(content));
        if (!string.IsNullOrEmpty(title)) data.Append(",\"title\":").Append(TunerUitkStr(title));
        data.Append('}');
        var rect = anchor ?? new Rect(s_TunerUitkLastPointer, Vector2.one);
        TunerUitkSetPopup(owner, "window", rect, data.ToString(), (action, raw) =>
        {
            if (action != "change" && window != null) Object.DestroyImmediate(window);
            return null;
        });
        SaturaDebug.Log("[tunerPopup] window " + (string.IsNullOrEmpty(content) ? type : content) + " kept out of Unity: no Tuner window host here");
        return true;
    }

    static bool TunerPopupHostNested(Rect activatorRect, PopupWindowContent content)
    {
        if (content == null) return false;
        var s = s_TiDispatch;
        var sec = s_TiDispatchSection;
        TunerPopupWindow parent = null;
        if (s != null && sec != null)
            foreach (var w in s_TunerPopupWindows)
                if (!w.Closed && w.Section == sec) parent = w;
        if (parent == null) return TunerPopupHostWindow(activatorRect, content);
        return TunerPopupHostWindowIn(activatorRect, content, false, parent);
    }

    static bool TunerPopupFitUitk(TiSession s)
    {
        bool changed = false;
        foreach (var w in s_TunerPopupWindows)
        {
            if (w.Session != s || w.Closed || w.Container != null || w.Section == null || w.Section.Body == null || w.Element == null) continue;
            var size = w.Section.Body.layout.size;
            if (float.IsNaN(size.x) || float.IsNaN(size.y) || size.x < 16f || size.y < 16f) continue;
            size = new Vector2(Mathf.Min(Mathf.Ceil(size.x), 2000f), Mathf.Min(Mathf.Ceil(size.y), 4000f));
            if (size == w.Size) continue;
            w.Size = size;
            w.Element.style.width = size.x;
            w.Element.style.height = size.y;
            changed = true;
        }
        return changed;
    }

    static void TunerPopupCloseNested()
    {
        foreach (var w in s_TunerPopupWindows.ToArray())
            if (w.Parent != null) TunerPopupCloseWindow(w);
    }

    static bool TunerPopupNestedOpen()
    {
        foreach (var w in s_TunerPopupWindows)
            if (w.Parent != null && !w.Closed) return true;
        return false;
    }

    static bool TunerPopupHostWindowIn(Rect activatorRect, PopupWindowContent content, bool panelRect, TunerPopupWindow parent = null)
    {
        var s = s_TiDispatch;
        if (s == null || s.Panel == null) return false;
        var toggled = false;
        foreach (var w in s_TunerPopupWindows.ToArray())
        {
            if (w.Session != s) continue;
            if (parent != null && (w == parent || w.Parent == null)) continue;
            if (parent == null && w.Content != null && w.Content.GetType() == content.GetType()) toggled = true;
            TunerPopupCloseWindow(w);
        }
        if (toggled) return true;
        var host = new TunerPopupWindow { Session = s, Content = content, Parent = parent };
        try
        {
            host.Proxy = ScriptableObject.CreateInstance<UnityEditor.PopupWindow>();
            host.Proxy.hideFlags = HideFlags.HideAndDontSave;
            s_TunerPopupContentWindow?.GetSetMethod(true)?.Invoke(content, new object[] { host.Proxy });
        }
        catch (Exception e)
        {
            Debug.LogWarning("[tunerPopup] popup window stand-in failed: " + e.Message);
        }
        try { content.OnOpen(); }
        catch (Exception e) { Debug.LogException(e); }
        host.Size = TunerPopupWindowSize(content);
        var key = "popup" + (++s_TunerPopupWindowSeq).ToString(TunerPopupInv);
        var el = new VisualElement { name = "SaturaTunerPopupWindow" };
        el.style.position = Position.Absolute;
        el.style.left = parent != null && parent.Element != null ? parent.Element.resolvedStyle.left + parent.Size.x + 40f : 0f;
        el.style.top = TUNER_POPUP_WINDOW_TOP;
        el.style.width = host.Size.x;
        el.style.height = host.Size.y;
        el.style.flexShrink = 0;
        var sec = new TiSection { Key = key, Kind = "popupWindow", Title = content.GetType().Name, TypeName = content.GetType().FullName, OwnsEditor = false, Expandable = false, Element = el };
        VisualElement ui = null;
        try { ui = content.CreateGUI(); }
        catch (Exception e) { Debug.LogException(e); }
        if (ui != null)
        {
            var body = new VisualElement();
            body.style.position = Position.Absolute;
            body.style.left = 0;
            body.style.top = 0;
            body.Add(ui);
            var head = new IMGUIContainer(() => { });
            head.style.position = Position.Absolute;
            head.style.width = 0;
            head.style.height = 0;
            el.Add(head);
            el.Add(body);
            sec.Header = head;
            sec.Body = body;
            sec.Uitk = true;
        }
        else
        {
            var c = new IMGUIContainer(() => TunerPopupWindowGUI(host));
            c.name = key + "Content";
            c.style.width = host.Size.x;
            c.style.height = host.Size.y;
            el.Add(c);
            sec.Header = c;
            host.Container = c;
        }
        s.Panel.visualTree.Add(el);
        s.Sections.Add(sec);
        host.Section = sec;
        host.Element = el;
        var data = new StringBuilder(160);
        data.Append("{\"type\":\"PopupWindow\",\"content\":").Append(TunerUitkStr(content.GetType().FullName));
        data.Append(",\"section\":").Append(TunerUitkStr(key));
        data.Append(",\"w\":").Append(TunerPopupFloat(host.Size.x)).Append(",\"h\":").Append(TunerPopupFloat(host.Size.y));
        if (parent != null)
        {
            data.Append(",\"parent\":").Append(TunerUitkStr(parent.Section.Key));
            data.Append(",\"row\":{\"x\":").Append(TunerPopupFloat(activatorRect.x)).Append(",\"y\":").Append(TunerPopupFloat(activatorRect.y))
                .Append(",\"w\":").Append(TunerPopupFloat(activatorRect.width)).Append(",\"h\":").Append(TunerPopupFloat(activatorRect.height)).Append('}');
        }
        data.Append('}');
        host.Popup = TunerInspectorAddPopup("window", activatorRect, false, data.ToString(), host, (p, action, raw) =>
        {
            if (action == "commit") TunerPopupCloseWindow(host);
            return null;
        }, p => TunerPopupCloseWindow(host));
        if (host.Popup == null)
        {
            TunerPopupCloseWindow(host);
            return false;
        }
        if (panelRect) host.Popup.Anchor = activatorRect;
        s_TunerPopupWindows.Add(host);
        SaturaDebug.Log("[tunerPopup] window " + content.GetType().Name + " hosted as section " + key + " " + host.Size.x + "x" + host.Size.y);
        TiMarkDirty(s);
        return true;
    }

    static void TunerPopupWindowGUI(TunerPopupWindow host)
    {
        if (host.Closed || host.Content == null) return;
        if (!host.TreesQuiet)
        {
            host.TreesQuiet = true;
            TunerPopupQuietTrees(host.Content);
        }
        var tint = GUI.color;
        TiResetGUIState();
        GUI.color = tint;
        host.Content.OnGUI(new Rect(0f, 0f, host.Size.x, host.Size.y));
        if (host.Closed || Event.current == null || Event.current.type != EventType.Repaint) return;
        var next = TunerPopupFitSize(host, TunerPopupWindowSize(host.Content));
        if (next == host.Size) return;
        host.Size = next;
        host.Element.style.width = next.x;
        host.Element.style.height = next.y;
        if (host.Container != null)
        {
            host.Container.style.width = next.x;
            host.Container.style.height = next.y;
        }
        TiMarkDirty(host.Session);
    }

    static void TunerPopupQuietTrees(object content)
    {
        const BindingFlags all = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        for (var t = content.GetType(); t != null && t != typeof(PopupWindowContent); t = t.BaseType)
        {
            foreach (var f in t.GetFields(all | BindingFlags.DeclaredOnly))
            {
                if (f.FieldType.IsValueType) continue;
                object v;
                try { v = f.GetValue(content); }
                catch { continue; }
                if (v == null) continue;
                for (var vt = v.GetType(); vt != null; vt = vt.BaseType)
                {
                    if (vt.Namespace != "UnityEditor.IMGUI.Controls" || !vt.Name.StartsWith("TreeView", StringComparison.Ordinal)) continue;
                    var hover = vt.GetProperty("enableItemHovering", all);
                    try { hover?.SetValue(v, false); }
                    catch (Exception e) { Debug.LogWarning("[tunerPopup] could not turn off tree hovering: " + e.Message); }
                    break;
                }
            }
        }
    }

    static void TunerPopupCloseWindow(TunerPopupWindow host)
    {
        if (host == null || host.Closed) return;
        host.Closed = true;
        s_TunerPopupWindows.Remove(host);
        foreach (var child in s_TunerPopupWindows.ToArray())
            if (child.Parent == host) TunerPopupCloseWindow(child);
        try { host.Content?.OnClose(); }
        catch (Exception e)
        {
            if (!TiIsExitGui(e)) Debug.LogException(e);
        }
        var s = host.Session;
        if (s != null)
        {
            s.Sections.Remove(host.Section);
            if (host.Popup != null) s.Popups.Remove(host.Popup);
            if (s.MouseSection == host.Section)
            {
                s.MouseSection = null;
                s.MouseContainer = null;
                s.Hot = 0;
            }
            if (s.FocusSection == host.Section)
            {
                s.FocusSection = null;
                s.FocusContainer = null;
                s.Kb = 0;
            }
            TiMarkDirty(s);
        }
        if (host.Section != null && host.Section.Uitk && host.Section.Body != null)
        {
            try { TunerUitkForget(host.Section.Body); } catch { }
        }
        try { host.Element?.RemoveFromHierarchy(); } catch { }
        if (host.Proxy != null)
        {
            var proxy = host.Proxy;
            host.Proxy = null;
            try { Object.DestroyImmediate(proxy); } catch { }
        }
        SaturaDebug.Log("[tunerPopup] window " + (host.Content != null ? host.Content.GetType().Name : "?") + " closed");
    }

    static bool TunerPopupWindowClosePrefix(EditorWindow __instance)
    {
        if (__instance == null) return true;
        var list = s_TunerPopupWindows;
        if (list != null)
            foreach (var w in list)
            {
                if (!ReferenceEquals(w.Proxy, __instance)) continue;
                TunerPopupCloseWindow(w);
                return false;
            }
        var parent = s_TunerPopupWindowParent;
        if (parent == null || parent.GetValue(__instance) != null) return true;
        Object.DestroyImmediate(__instance, true);
        return false;
    }

    static void TunerPopupMaskChangedPostfix()
    {
        var list = s_TunerPopupWindows;
        if (list == null || list.Count == 0) return;
        var host = list.LastOrDefault(w => w != null && !w.Closed && w.Content != null && w.Content.GetType().Name == "MaskFieldDropDown");
        var popup = host?.Popup;
        if (popup == null) return;
        EditorApplication.delayCall += () =>
        {
            try { TunerInspectorSendCommand(popup, "MaskMenuChanged"); }
            catch (Exception e) { Debug.LogWarning("[tunerPopup] mask update failed: " + e.Message); }
        };
    }

    static bool TunerPopupAddComponent(Rect rect, GameObject go)
    {
        if (!TunerInspectorDispatching || go == null) return false;
        var getSubmenus = typeof(Unsupported).GetMethod("GetSubmenus", TunerPopupAny, null, new[] { typeof(string) }, null);
        var getCommands = typeof(Unsupported).GetMethod("GetSubmenusCommands", TunerPopupAny, null, new[] { typeof(string) }, null);
        var execute = typeof(EditorApplication).GetMethod("ExecuteMenuItemOnGameObjects", TunerPopupAny, null, new[] { typeof(string), typeof(GameObject[]) }, null);
        var classIcon = typeof(AssetPreview).GetMethod("GetMiniTypeThumbnailFromClassID", TunerPopupAny, null, new[] { typeof(int) }, null);
        if (getSubmenus == null || getCommands == null) return false;
        var paths = getSubmenus.Invoke(null, new object[] { "Component" }) as string[] ?? new string[0];
        var commands = getCommands.Invoke(null, new object[] { "Component" }) as string[] ?? new string[0];
        var entries = new List<KeyValuePair<string, string>>();
        for (int i = 0; i < paths.Length; i++)
        {
            var cmd = i < commands.Length ? commands[i] : "";
            if (cmd == "ADD" || string.IsNullOrEmpty(paths[i])) continue;
            entries.Add(new KeyValuePair<string, string>(paths[i], cmd));
        }
        entries.Sort((a, b) =>
        {
            var la = a.Key.IndexOf("legacy", StringComparison.OrdinalIgnoreCase) >= 0;
            var lb = b.Key.IndexOf("legacy", StringComparison.OrdinalIgnoreCase) >= 0;
            if (la != lb) return la ? 1 : -1;
            return string.CompareOrdinal(a.Key, b.Key);
        });
        var root = new AdvancedDropdownItem("Component");
        var groups = new Dictionary<string, AdvancedDropdownItem>();
        var leaves = new Dictionary<AdvancedDropdownItem, string>();
        var scriptIcon = EditorGUIUtility.IconContent("cs Script Icon").image as Texture2D;
        foreach (var e in entries)
        {
            var parts = e.Key.Split('/');
            var start = parts.Length > 1 && parts[0] == "Component" ? 1 : 0;
            var parent = root;
            var prefix = "";
            for (int j = start; j < parts.Length - 1; j++)
            {
                prefix += "/" + parts[j];
                if (!groups.TryGetValue(prefix, out var g))
                {
                    g = new AdvancedDropdownItem(parts[j]);
                    groups[prefix] = g;
                    parent.AddChild(g);
                }
                parent = g;
            }
            var leaf = new AdvancedDropdownItem(parts[parts.Length - 1]);
            if (e.Value.StartsWith("SCRIPT", StringComparison.Ordinal)) leaf.icon = scriptIcon;
            else if (classIcon != null && int.TryParse(e.Value, out var classId))
            {
                try { leaf.icon = classIcon.Invoke(null, new object[] { classId }) as Texture2D; }
                catch { }
            }
            parent.AddChild(leaf);
            leaves[leaf] = e.Key;
        }
        var tree = new TunerPopupTree();
        var data = TunerPopupDropdownJson(root, new Vector2(Mathf.Max(230f, rect.width), 320f), tree, null);
        data = "{\"addComponent\":" + TunerUitkStr(TiObjectPath(go)) + "," + data.Substring(1);
        var dispatch = s_TiDispatch;
        var targets = dispatch != null && dispatch.Gos.Count > 1 && dispatch.Gos.Contains(go) ? dispatch.Gos.ToArray() : new[] { go };
        TunerInspectorAddPopup("dropdown", rect, false, data, go, (p, action, raw) =>
        {
            if (action != "commit") return null;
            if (!int.TryParse((raw ?? "").Trim(), System.Globalization.NumberStyles.Integer, TunerPopupInv, out var id) || id < 0 || id >= tree.Items.Count)
                return "an Add Component answer needs an item id";
            var item = tree.Items[id];
            if (!leaves.TryGetValue(item, out var menuPath)) return "pick a component, not a group";
            var before = go.GetComponents<Component>().Length;
            try
            {
                if (execute != null) execute.Invoke(null, new object[] { menuPath, targets });
                else EditorApplication.ExecuteMenuItem(menuPath);
            }
            catch (TargetInvocationException e)
            {
                var inner = e.InnerException ?? e;
                if (!TiIsExitGui(inner)) return inner.Message;
            }
            var after = go.GetComponents<Component>().Length;
            Debug.Log("[tunerPopup] add component '" + menuPath + "' on '" + go.name + "' (" + before + " -> " + after + " components)");
            foreach (var session in s_TiSessions.Values)
                if (session.Go == go) session.NeedsRebuild = true;
            TiMarkAllDirty();
            return null;
        }, null);
        return true;
    }

    static bool TunerPopupGenericMenuPrefix(object __instance, Rect position, VisualElement targetElement)
    {
        var anchorEl = targetElement;
        if (anchorEl == null || TunerUitkRootOf(anchorEl, out _) == null)
        {
            var root = s_TunerUitkDispatchRoot;
            if (root == null) return true;
            anchorEl = root.panel?.Pick(s_TunerUitkLastPointer) ?? root;
            if (TunerUitkRootOf(anchorEl, out _) == null) anchorEl = root;
        }
        var menu = __instance as GenericDropdownMenu;
        if (menu == null) return true;
        var itemsProp = typeof(GenericDropdownMenu).GetProperty("items", TunerPopupAny);
        var list = itemsProp?.GetValue(menu) as IList;
        var byElement = new Dictionary<VisualElement, object>();
        if (list != null)
            foreach (var it in list)
            {
                var el = it?.GetType().GetField("element", TunerPopupAny)?.GetValue(it) as VisualElement;
                if (el != null) byElement[el] = it;
            }
        var items = new List<TunerUitkMenuItem>();
        foreach (var child in menu.contentContainer.Children())
        {
            if (child.ClassListContains(GenericDropdownMenu.separatorUssClassName))
            {
                items.Add(new TunerUitkMenuItem { Path = "", Separator = true, Disabled = true });
                continue;
            }
            if (!byElement.TryGetValue(child, out var mi)) continue;
            var t = mi.GetType();
            var name = t.GetField("name", TunerPopupAny)?.GetValue(mi) as string ?? "";
            var action = t.GetField("action", TunerPopupAny)?.GetValue(mi) as Action;
            var actionData = t.GetField("actionUserData", TunerPopupAny)?.GetValue(mi) as Action<object>;
            var userData = child.userData;
            items.Add(new TunerUitkMenuItem
            {
                Path = name,
                Checked = (TunerUitkPseudoStates(child) & 8) != 0,
                Disabled = !child.enabledSelf || action == null && actionData == null,
                Run = action ?? (actionData != null ? (Action)(() => actionData(userData)) : null)
            });
        }
        TunerUitkOpenMenu(anchorEl, position, items, TunerUitkBoundPath(anchorEl));
        return false;
    }

    static List<TiMenuEntry> TunerPopupContextMenuEntries(Object[] context)
    {
        var list = new List<TiMenuEntry>();
        var target = context != null && context.Length == 1 ? context[0] : null;
        if (target == null) return list;
        var seen = new HashSet<string>();
        var validators = new Dictionary<string, MethodInfo>();
        var items = new List<KeyValuePair<ContextMenu, MethodInfo>>();
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        for (var t = target.GetType(); t != null && t != typeof(MonoBehaviour) && t != typeof(ScriptableObject) && t != typeof(Object); t = t.BaseType)
            foreach (var m in t.GetMethods(flags))
            {
                if (m.GetParameters().Length != 0) continue;
                foreach (ContextMenu a in m.GetCustomAttributes(typeof(ContextMenu), false))
                {
                    if (string.IsNullOrEmpty(a.menuItem)) continue;
                    if (a.validate)
                    {
                        if (!validators.ContainsKey(a.menuItem)) validators[a.menuItem] = m;
                        continue;
                    }
                    if (seen.Add(a.menuItem)) items.Add(new KeyValuePair<ContextMenu, MethodInfo>(a, m));
                }
            }
        foreach (var kv in items.OrderBy(x => x.Key.priority))
        {
            var method = kv.Value;
            var enabled = true;
            if (validators.TryGetValue(kv.Key.menuItem, out var check))
            {
                try { enabled = check.ReturnType == typeof(bool) && (bool)check.Invoke(target, null); }
                catch { enabled = false; }
            }
            list.Add(new TiMenuEntry
            {
                Text = kv.Key.menuItem,
                Enabled = enabled,
                Priority = kv.Key.priority,
                Action = () =>
                {
                    method.Invoke(target, null);
                    EditorUtility.SetDirty(target);
                }
            });
        }
        return list;
    }
}
