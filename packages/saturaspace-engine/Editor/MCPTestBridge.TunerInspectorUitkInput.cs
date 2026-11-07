using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.SceneManagement;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;

public static partial class MCPTestBridge
{
    [Serializable]
    class TunerUitkInputArgs
    {
        public string op;
        public string type;
        public float x;
        public float y;
        public float dx;
        public float dy;
        public int button;
        public int clicks;
        public int buttons;
        public int mods;
        public int node = -1;
        public string key;
        public string code;
        public string id;
        public string action;
    }

    [Serializable]
    class TunerUitkColorValue
    {
        public float r;
        public float g;
        public float b;
        public float a = 1f;
    }

    [Serializable]
    class TunerUitkColorKey
    {
        public TunerUitkColorValue color;
        public float time;
    }

    [Serializable]
    class TunerUitkAlphaKey
    {
        public float alpha;
        public float time;
    }

    [Serializable]
    class TunerUitkGradientValue
    {
        public int mode;
        public int colorSpace;
        public TunerUitkColorKey[] colorKeys;
        public TunerUitkAlphaKey[] alphaKeys;
    }

    [Serializable]
    class TunerUitkObjectRef
    {
        public string id;
        public string guid;
        public long localId;
        public string path;
        public string scene;
        public string scenePath;
        public string component;
    }

    sealed class TunerUitkMenuItem
    {
        public string Path;
        public bool Checked;
        public bool Disabled;
        public bool Separator;
        public Action Run;
    }

#if UNITY_6000_3_OR_NEWER
    sealed class TunerUitkMenu : AbstractGenericMenu
    {
        readonly List<TunerUitkMenuItem> m_Items = new List<TunerUitkMenuItem>();

        public override void AddItem(string itemName, bool isChecked, Action action)
        {
            m_Items.Add(new TunerUitkMenuItem { Path = itemName, Checked = isChecked, Disabled = action == null, Run = action });
        }

        public override void AddItem(string itemName, bool isChecked, Action<object> action, object data)
        {
            m_Items.Add(new TunerUitkMenuItem { Path = itemName, Checked = isChecked, Disabled = action == null, Run = action == null ? null : (Action)(() => action(data)) });
        }

        public override void AddDisabledItem(string itemName, bool isChecked)
        {
            m_Items.Add(new TunerUitkMenuItem { Path = itemName, Checked = isChecked, Disabled = true });
        }

        public override void AddSeparator(string path)
        {
            m_Items.Add(new TunerUitkMenuItem { Path = path ?? "", Separator = true, Disabled = true });
        }

        public override void DropDown(Rect position, VisualElement targetElement, DropdownMenuSizeMode dropdownMenuSizeMode = DropdownMenuSizeMode.Auto)
        {
            TunerUitkOpenMenu(targetElement, position, m_Items, null);
        }
    }

    static readonly Func<AbstractGenericMenu> s_TunerUitkMenuFactory = () => new TunerUitkMenu();
#endif

    sealed class TunerUitkContextMenus : ContextualMenuManager
    {
        public override void DisplayMenuIfEventMatches(EventBase evt, IEventHandler eventHandler)
        {
            if (evt == null) return;
            var matches = evt is ContextClickEvent || evt is PointerDownEvent pd && pd.button == 1;
            if (!matches) return;
            DisplayMenu(evt, eventHandler);
            evt.StopPropagation();
        }

        protected override void DoDisplayMenu(DropdownMenu menu, EventBase triggerEvent)
        {
            var target = triggerEvent?.target as VisualElement;
            var items = new List<TunerUitkMenuItem>();
            foreach (var item in menu.MenuItems())
            {
                if (item is DropdownMenuSeparator sep)
                {
                    items.Add(new TunerUitkMenuItem { Path = sep.subMenuPath ?? "", Separator = true, Disabled = true });
                    continue;
                }
                if (!(item is DropdownMenuAction act)) continue;
                var status = act.status;
                if ((status & DropdownMenuAction.Status.Hidden) != 0 || status == DropdownMenuAction.Status.None) continue;
                items.Add(new TunerUitkMenuItem
                {
                    Path = act.name,
                    Checked = (status & DropdownMenuAction.Status.Checked) != 0,
                    Disabled = (status & DropdownMenuAction.Status.Disabled) != 0,
                    Run = act.Execute
                });
            }
            if (items.Count == 0) return;
            var pos = triggerEvent is IPointerEvent pe ? (Vector2)pe.position : triggerEvent is IMouseEvent me ? me.mousePosition : (target != null ? target.worldBound.center : Vector2.zero);
            TunerUitkOpenMenu(target, new Rect(pos, Vector2.zero), items, TunerUitkBoundPath(target));
        }
    }

    static readonly TunerUitkContextMenus s_TunerUitkContextMenus = new TunerUitkContextMenus();
    static VisualElement s_TunerUitkDispatchRoot;
    static Vector2 s_TunerUitkLastPointer;
    static readonly Vector2 TunerUitkPointerAway = new Vector2(-100000f, -100000f);
    static bool s_TunerUitkPatched;
    static string s_TunerUitkPatchError;

    internal static string TunerUitkInput(VisualElement root, string inputJson)
    {
        if (root == null) return "no UI Toolkit root";
        if (root.panel == null) return "the UI Toolkit root is not attached to a panel";
        TunerUitkInit();
        TunerUitkInputArgs a;
        try { a = JsonUtility.FromJson<TunerUitkInputArgs>(inputJson); }
        catch (Exception e) { return "bad input: " + e.Message; }
        if (a == null || string.IsNullOrEmpty(a.op)) return "an input op is required";
        var st = TunerUitkStateFor(root);
        TunerUitkPreparePanel(root.panel);
        var prevRoot = s_TunerUitkDispatchRoot;
        s_TunerUitkDispatchRoot = root;
        try
        {
            switch (a.op)
            {
                case "pointer": return TunerUitkPointer(root, st, a);
                case "wheel": return TunerUitkWheel(root, a);
                case "key": return TunerUitkKeyInput(root, a);
                case "set": return TunerUitkSet(st, a.node, TunerUitkJsonString(TunerUitkJsonRaw(inputJson, "value")));
                case "focus": return TunerUitkFocus(st, a.node);
                case "blur":
                    root.panel.focusController?.focusedElement?.Blur();
                    return null;
                case "popup": return TunerUitkAnswer(st, a, TunerUitkJsonRaw(inputJson, "value"));
            }
            return "unknown input op: " + a.op;
        }
        finally
        {
            s_TunerUitkDispatchRoot = prevRoot;
        }
    }

    static void TunerUitkPreparePanel(IPanel panel)
    {
#if UNITY_6000_3_OR_NEWER
        if (s_TunerUitkMenuFunctor != null && !ReferenceEquals(s_TunerUitkMenuFunctor.GetValue(panel), s_TunerUitkMenuFactory))
            s_TunerUitkMenuFunctor.SetValue(panel, s_TunerUitkMenuFactory);
#endif
        if (s_TunerUitkMenuManager != null && !(panel.contextualMenuManager is TunerUitkContextMenus))
        {
            var setter = s_TunerUitkMenuManager.GetSetMethod(true);
            if (setter != null) setter.Invoke(panel, new object[] { s_TunerUitkContextMenus });
        }
        TunerUitkEnsurePatches();
        TunerPopupEnsurePatches();
        EnsureTunerInspectorPatches();
    }

    static string TunerUitkPointer(VisualElement root, TunerUitkState st, TunerUitkInputArgs a)
    {
        var panel = root.panel;
        var pos = root.worldBound.position + new Vector2(a.x, a.y);
        EventType type;
        switch (a.type)
        {
            case "down": type = EventType.MouseDown; break;
            case "up": type = EventType.MouseUp; break;
            case "move": type = a.buttons != 0 || PointerCaptureHelper.GetCapturingElement(panel, PointerId.mousePointerId) != null ? EventType.MouseDrag : EventType.MouseMove; break;
            default: return "unknown pointer type: " + a.type;
        }
        if (type == EventType.MouseDown)
        {
            if (st.Popup != null) TunerUitkClosePopup(st, "cancel");
            if (PointerCaptureHelper.GetCapturingElement(panel, PointerId.mousePointerId) != null) PointerCaptureHelper.ReleasePointer(panel, PointerId.mousePointerId);
            Undo.IncrementCurrentGroup();
            if (a.clicks >= 2 && a.button == 0 && TunerUitkOpenObjectAt(st, panel.Pick(pos))) return null;
        }
        var e = new Event
        {
            type = type,
            mousePosition = pos,
            delta = pos - s_TunerUitkLastPointer,
            button = Mathf.Max(0, a.button),
            clickCount = Mathf.Max(1, a.clicks),
            modifiers = (EventModifiers)(a.mods & 0xff)
        };
        s_TunerUitkLastPointer = pos;
        EventBase evt;
        if (type == EventType.MouseDown) evt = PointerDownEvent.GetPooled(e);
        else if (type == EventType.MouseUp) evt = PointerUpEvent.GetPooled(e);
        else evt = PointerMoveEvent.GetPooled(e);
        using (evt) panel.visualTree.SendEvent(evt);
        if (type == EventType.MouseUp && a.button == 1)
        {
            var target = panel.Pick(pos);
            if (target != null && st.Popup == null)
            {
                using (var cc = ContextClickEvent.GetPooled(new Event { type = EventType.ContextClick, mousePosition = pos, button = 1, modifiers = e.modifiers }))
                    target.SendEvent(cc);
            }
        }
        if (type == EventType.MouseUp && PointerCaptureHelper.GetCapturingElement(panel, PointerId.mousePointerId) == null)
        {
            var away = new Event { type = EventType.MouseMove, mousePosition = TunerUitkPointerAway, modifiers = e.modifiers };
            using (var leave = PointerMoveEvent.GetPooled(away)) panel.visualTree.SendEvent(leave);
        }
        return null;
    }

    static string TunerUitkWheel(VisualElement root, TunerUitkInputArgs a)
    {
        var panel = root.panel;
        var pos = root.worldBound.position + new Vector2(a.x, a.y);
        var e = new Event { type = EventType.ScrollWheel, mousePosition = pos, delta = new Vector2(a.dx, a.dy), modifiers = (EventModifiers)(a.mods & 0xff) };
        using (var evt = WheelEvent.GetPooled(e)) panel.visualTree.SendEvent(evt);
        return null;
    }

    static string TunerUitkKeyInput(VisualElement root, TunerUitkInputArgs a)
    {
        var panel = root.panel;
        var code = TunerUitkKeyCode(a.key, a.code, out var ch);
        var mods = (EventModifiers)(a.mods & 0xff);
        if (a.type == "up")
        {
            using (var up = KeyUpEvent.GetPooled(ch, code, mods)) panel.visualTree.SendEvent(up);
            return null;
        }
        Undo.IncrementCurrentGroup();
        using (var down = KeyDownEvent.GetPooled(ch, code, mods)) panel.visualTree.SendEvent(down);
        return null;
    }

    static KeyCode TunerUitkKeyCode(string key, string code, out char ch)
    {
        ch = '\0';
        switch (key)
        {
            case "Enter": ch = '\n'; return KeyCode.Return;
            case "Escape": return KeyCode.Escape;
            case "Tab": ch = '\t'; return KeyCode.Tab;
            case "Backspace": return KeyCode.Backspace;
            case "Delete": return KeyCode.Delete;
            case "ArrowUp": return KeyCode.UpArrow;
            case "ArrowDown": return KeyCode.DownArrow;
            case "ArrowLeft": return KeyCode.LeftArrow;
            case "ArrowRight": return KeyCode.RightArrow;
            case "Home": return KeyCode.Home;
            case "End": return KeyCode.End;
            case "PageUp": return KeyCode.PageUp;
            case "PageDown": return KeyCode.PageDown;
            case " ": ch = ' '; return KeyCode.Space;
        }
        if (!string.IsNullOrEmpty(key) && key.Length == 1)
        {
            ch = key[0];
            var lower = char.ToLowerInvariant(ch);
            if (lower >= 'a' && lower <= 'z') return KeyCode.A + (lower - 'a');
            if (ch >= '0' && ch <= '9') return KeyCode.Alpha0 + (ch - '0');
        }
        return KeyCode.None;
    }

    static string TunerUitkFocus(TunerUitkState st, int node)
    {
        if (!st.Nodes.TryGetValue(node, out var el) || el.panel == null) return "that element is gone; capture again";
        el.Focus();
        return null;
    }

    static string TunerUitkSet(TunerUitkState st, int node, string text)
    {
        if (!st.Nodes.TryGetValue(node, out var el) || el.panel == null) return "that field is gone; capture again";
        VisualElement field = null;
        TunerUitkFieldInfo info = null;
        for (var e = el; e != null; e = e.hierarchy.parent)
        {
            var fi = TunerUitkFieldInfoFor(e.GetType());
            if (fi != null && fi.StringToValue != null)
            {
                field = e;
                info = fi;
                break;
            }
        }
        if (field == null) return "that element is not a text field";
        if (!field.enabledInHierarchy) return "that field is disabled";
        object value;
        try { value = info.StringToValue.Invoke(field, new object[] { text ?? "" }); }
        catch (TargetInvocationException e) { return "'" + text + "' is not a valid value: " + (e.InnerException ?? e).Message; }
        Undo.IncrementCurrentGroup();
        info.Value.SetValue(field, value);
        return null;
    }

    static string TunerUitkAnswer(TunerUitkState st, TunerUitkInputArgs a, string rawValue)
    {
        var p = st.Popup;
        if (p == null || p.Id != a.id) return "that popup is no longer open";
        var action = string.IsNullOrEmpty(a.action) ? "commit" : a.action;
        if (action != "change" && action != "commit" && action != "cancel") return "unknown popup action: " + action;
        string err;
        try { err = p.Answer(action, rawValue); }
        catch (TargetInvocationException e) { err = (e.InnerException ?? e).Message; }
        if (action != "change" && ReferenceEquals(st.Popup, p)) st.Popup = null;
        return err;
    }

    static void TunerUitkClosePopup(TunerUitkState st, string action)
    {
        var p = st.Popup;
        st.Popup = null;
        if (p == null) return;
        try { p.Answer(action, null); }
        catch (Exception e) { Debug.LogException(e); }
    }

    static TunerUitkPopup TunerUitkSetPopup(VisualElement owner, string kind, Rect anchor, string data, Func<string, string, string> answer)
    {
        var root = TunerUitkRootOf(owner, out var st);
        if (root == null) return null;
        if (st.Popup != null) TunerUitkClosePopup(st, "cancel");
        var p = new TunerUitkPopup
        {
            Id = "uitk:" + (++s_TunerUitkNextPopup).ToString(TunerUitkInv),
            Kind = kind,
            Anchor = anchor,
            Data = data,
            Owner = owner,
            Answer = answer
        };
        st.Popup = p;
        SaturaDebug.Log("[tunerUitk] popup " + p.Id + " " + kind + " for " + TunerUitkTypeName(owner.GetType()) + (string.IsNullOrEmpty(TunerUitkBoundPath(owner)) ? "" : " '" + TunerUitkBoundPath(owner) + "'"));
        return p;
    }

    static void TunerUitkOpenMenu(VisualElement target, Rect anchor, List<TunerUitkMenuItem> items, string property)
    {
        if (target == null) return;
        var sb = new StringBuilder(256);
        sb.Append("{\"options\":[");
        for (int i = 0; i < items.Count; i++) sb.Append(i > 0 ? "," : "").Append(TunerUitkStr(items[i].Path));
        sb.Append("],\"enabled\":[");
        for (int i = 0; i < items.Count; i++) sb.Append(i > 0 ? "," : "").Append(items[i].Disabled || items[i].Separator ? "false" : "true");
        sb.Append("],\"separator\":[");
        for (int i = 0; i < items.Count; i++) sb.Append(i > 0 ? "," : "").Append(items[i].Separator ? "true" : "false");
        sb.Append("],\"selected\":[");
        var firstSel = true;
        for (int i = 0; i < items.Count; i++)
        {
            if (!items[i].Checked) continue;
            sb.Append(firstSel ? "" : ",").Append(i.ToString(TunerUitkInv));
            firstSel = false;
        }
        sb.Append(']');
        if (!string.IsNullOrEmpty(property)) sb.Append(",\"property\":").Append(TunerUitkStr(property));
        sb.Append('}');
        var popup = TunerUitkSetPopup(target, "menu", anchor, sb.ToString(), (action, raw) =>
        {
            if (action != "commit") return null;
            if (!int.TryParse((raw ?? "").Trim(), System.Globalization.NumberStyles.Integer, TunerUitkInv, out var index)) return "a menu answer needs an item index";
            if (index < 0 || index >= items.Count) return "menu index out of range";
            var item = items[index];
            if (item.Separator || item.Disabled || item.Run == null) return "that menu item is disabled";
            Undo.IncrementCurrentGroup();
            item.Run();
            SaturaDebug.Log("[tunerUitk] menu pick " + index + " '" + item.Path + "'");
            return null;
        });
        if (popup == null) Debug.LogWarning("[tunerUitk] a menu opened outside any captured UI Toolkit section was dropped");
    }

    static string TunerUitkBoundPath(VisualElement ve)
    {
        for (var e = ve; e != null; e = e.hierarchy.parent)
            if (e is IBindable b && !string.IsNullOrEmpty(b.bindingPath)) return b.bindingPath;
        return null;
    }

    static Rect TunerUitkFieldAnchor(VisualElement field)
    {
        var input = field.Q(className: "unity-base-field__input");
        return (input ?? field).worldBound;
    }

    static bool TunerUitkColorPrefix(VisualElement __instance)
    {
        if (!(__instance is ColorField field) || TunerUitkRootOf(field, out _) == null) return true;
        var original = field.value;
        var touched = false;
        var data = "{\"value\":" + JsonUtility.ToJson(TunerUitkColorOut(original)) + ",\"hdr\":" + (field.hdr ? "true" : "false")
            + ",\"showAlpha\":" + (field.showAlpha ? "true" : "false") + TunerUitkPropertyJson(field) + "}";
        TunerUitkSetPopup(field, "color", TunerUitkFieldAnchor(field), data, (action, raw) =>
        {
            if (action == "cancel")
            {
                if (touched) field.value = original;
                return null;
            }
            if (string.IsNullOrEmpty(raw)) return "a color answer needs {r,g,b,a}";
            var c = JsonUtility.FromJson<TunerUitkColorValue>(raw);
            if (!touched) Undo.IncrementCurrentGroup();
            touched = true;
            field.value = new Color(c.r, c.g, c.b, field.showAlpha ? c.a : 1f);
            return null;
        });
        return false;
    }

    static bool TunerUitkEyeDropperPrefix(VisualElement __instance)
    {
        return !(__instance is ColorField) || TunerUitkRootOf(__instance, out _) == null;
    }

    static TunerUitkColorValue TunerUitkColorOut(Color c)
    {
        return new TunerUitkColorValue { r = c.r, g = c.g, b = c.b, a = c.a };
    }

    static bool TunerUitkCurvePrefix(VisualElement __instance)
    {
        if (!(__instance is CurveField field) || TunerUitkRootOf(field, out _) == null) return true;
        var original = field.value != null ? new AnimationCurve(field.value.keys) { preWrapMode = field.value.preWrapMode, postWrapMode = field.value.postWrapMode } : new AnimationCurve();
        var touched = false;
        var ranges = field.ranges;
        var data = "{\"value\":" + TunerPopupCurveJson(original)
            + (ranges.width > 0f && ranges.height > 0f ? ",\"ranges\":{\"x\":" + TunerUitkNum(ranges.x) + ",\"y\":" + TunerUitkNum(ranges.y) + ",\"w\":" + TunerUitkNum(ranges.width) + ",\"h\":" + TunerUitkNum(ranges.height) + "}" : "")
            + TunerUitkPropertyJson(field) + "}";
        TunerUitkSetPopup(field, "curve", TunerUitkFieldAnchor(field), data, (action, raw) =>
        {
            if (action == "cancel")
            {
                if (touched) field.value = original;
                return null;
            }
            if (string.IsNullOrEmpty(raw)) return "a curve answer needs {keys,preWrapMode,postWrapMode}";
            var parsed = TunerPopupParseCurve(raw);
            if (!touched) Undo.IncrementCurrentGroup();
            touched = true;
            field.value = parsed;
            return null;
        });
        return false;
    }

    static bool TunerUitkGradientPrefix(VisualElement __instance)
    {
        if (!(__instance is GradientField field) || TunerUitkRootOf(field, out _) == null) return true;
        var original = TunerUitkGradientCopy(field.value ?? new Gradient());
        var touched = false;
        var data = "{\"value\":" + JsonUtility.ToJson(TunerUitkGradientOut(original)) + ",\"hdr\":" + (field.hdr ? "true" : "false") + TunerUitkPropertyJson(field) + "}";
        TunerUitkSetPopup(field, "gradient", TunerUitkFieldAnchor(field), data, (action, raw) =>
        {
            if (action == "cancel")
            {
                if (touched) field.value = original;
                return null;
            }
            if (string.IsNullOrEmpty(raw)) return "a gradient answer needs {mode,colorKeys,alphaKeys}";
            var v = JsonUtility.FromJson<TunerUitkGradientValue>(raw);
            var g = new Gradient
            {
                mode = (GradientMode)v.mode,
                colorSpace = (ColorSpace)v.colorSpace
            };
            g.SetKeys(
                (v.colorKeys ?? new TunerUitkColorKey[0]).Select(k => new GradientColorKey(new Color(k.color.r, k.color.g, k.color.b, 1f), k.time)).ToArray(),
                (v.alphaKeys ?? new TunerUitkAlphaKey[0]).Select(k => new GradientAlphaKey(k.alpha, k.time)).ToArray());
            if (!touched) Undo.IncrementCurrentGroup();
            touched = true;
            field.value = g;
            return null;
        });
        return false;
    }

    static Gradient TunerUitkGradientCopy(Gradient g)
    {
        var copy = new Gradient { mode = g.mode, colorSpace = g.colorSpace };
        copy.SetKeys(g.colorKeys, g.alphaKeys);
        return copy;
    }

    static TunerUitkGradientValue TunerUitkGradientOut(Gradient g)
    {
        return new TunerUitkGradientValue
        {
            mode = (int)g.mode,
            colorSpace = (int)g.colorSpace,
            colorKeys = g.colorKeys.Select(k => new TunerUitkColorKey { color = TunerUitkColorOut(k.color), time = k.time }).ToArray(),
            alphaKeys = g.alphaKeys.Select(k => new TunerUitkAlphaKey { alpha = k.alpha, time = k.time }).ToArray()
        };
    }

    static bool TunerUitkObjectPrefix(VisualElement __instance)
    {
        if (!(__instance is ObjectField field) || TunerUitkRootOf(field, out _) == null) return true;
        var type = field.objectType ?? typeof(UnityEngine.Object);
        var cur = field.value;
        var sb = new StringBuilder(256);
        sb.Append("{\"type\":").Append(TunerUitkStr(type.FullName));
        sb.Append(",\"typeName\":").Append(TunerUitkStr(type.Name));
        sb.Append(",\"allowSceneObjects\":").Append(field.allowSceneObjects ? "true" : "false");
        sb.Append(",\"current\":").Append(TunerPopupObjectRefJson(cur));
        if (cur != null) sb.Append(",\"currentName\":").Append(TunerUitkStr(cur.name));
        sb.Append(TunerUitkPropertyJson(field)).Append('}');
        TunerUitkSetPopup(field, "object", TunerUitkFieldAnchor(field), sb.ToString(), (action, raw) =>
        {
            if (action == "cancel" || action == "change") return null;
            UnityEngine.Object picked = null;
            var trimmed = (raw ?? "null").Trim();
            if (trimmed != "null")
            {
                var r = TunerPopupParseObjectRef(trimmed);
                picked = TunerUitkResolveObject(r, type);
                if (picked == null) return "could not find that object";
                if (!field.allowSceneObjects && !EditorUtility.IsPersistent(picked)) return "this field only takes assets";
            }
            Undo.IncrementCurrentGroup();
            field.value = picked;
            return null;
        });
        return false;
    }

    static TunerUitkObjectRef TunerUitkObjectOut(UnityEngine.Object o)
    {
        var r = new TunerUitkObjectRef { id = o.GetHashCode().ToString(TunerUitkInv) };
        if (EditorUtility.IsPersistent(o))
        {
            r.path = AssetDatabase.GetAssetPath(o);
            if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out var guid, out long lid))
            {
                r.guid = guid;
                r.localId = lid;
            }
        }
        else
        {
            var go = o as GameObject ?? (o as Component)?.gameObject;
            if (go != null)
            {
                r.scenePath = TunerUitkHierarchyPath(go.transform);
                r.scene = go.scene.path;
                if (o is Component c) r.component = c.GetType().Name;
            }
        }
        return r;
    }

    static string TunerUitkHierarchyPath(Transform t)
    {
        var p = t.name;
        for (var x = t.parent; x != null; x = x.parent) p = x.name + "/" + p;
        return p;
    }

    static UnityEngine.Object TunerUitkResolveObject(TunerUitkObjectRef r, Type type)
    {
        if (r == null) return null;
        var path = !string.IsNullOrEmpty(r.path) ? r.path : !string.IsNullOrEmpty(r.guid) ? AssetDatabase.GUIDToAssetPath(r.guid) : null;
        if (!string.IsNullOrEmpty(path))
        {
            if (r.localId != 0)
                foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
                    if (o != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out _, out long lid) && lid == r.localId && type.IsInstanceOfType(o)) return o;
            if (typeof(Component).IsAssignableFrom(type))
            {
                var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                return go != null ? go.GetComponent(type) : null;
            }
            var main = AssetDatabase.LoadAssetAtPath(path, type);
            if (main != null) return main;
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
                if (o != null && type.IsInstanceOfType(o)) return o;
            return null;
        }
        if (!string.IsNullOrEmpty(r.scenePath))
        {
            var go = TunerUitkFindSceneObject(r.scenePath, r.scene);
            if (go == null) return null;
            if (type == typeof(GameObject) || type == typeof(UnityEngine.Object) && string.IsNullOrEmpty(r.component)) return go;
            if (!string.IsNullOrEmpty(r.component))
                foreach (var c in go.GetComponents<Component>())
                    if (c != null && (c.GetType().Name == r.component || c.GetType().FullName == r.component) && type.IsInstanceOfType(c)) return c;
            return typeof(Component).IsAssignableFrom(type) ? go.GetComponent(type) : null;
        }
        return null;
    }

    static GameObject TunerUitkFindSceneObject(string path, string scene)
    {
        path = path.TrimStart('/');
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var s = SceneManager.GetSceneAt(i);
            if (!s.isLoaded || !string.IsNullOrEmpty(scene) && s.path != scene) continue;
            foreach (var root in s.GetRootGameObjects())
            {
                var slash = path.IndexOf('/');
                var head = slash < 0 ? path : path.Substring(0, slash);
                if (root.name != head) continue;
                if (slash < 0) return root;
                var t = root.transform.Find(path.Substring(slash + 1));
                if (t != null) return t.gameObject;
            }
        }
        return null;
    }

    static bool TunerUitkOpenObjectAt(TunerUitkState st, VisualElement picked)
    {
        ObjectField field = null;
        for (var e = picked; e != null; e = e.hierarchy.parent)
        {
            if (e.ClassListContains("unity-object-field__selector")) return false;
            if (e is ObjectField of)
            {
                field = of;
                break;
            }
        }
        if (field == null || field.value == null) return false;
        var json = TunerUitkOpenOrPrefabJson(field.value);
        if (json == null) return false;
        st.Open = json;
        SaturaDebug.Log("[tunerUitk] open " + json);
        return true;
    }

    static string TunerUitkOpenJson(UnityEngine.Object o)
    {
        if (o == null) return null;
        var r = TunerUitkObjectOut(o);
        if (!string.IsNullOrEmpty(r.path)) return "{\"kind\":\"asset\",\"path\":" + TunerUitkStr(r.path) + "}";
        if (!string.IsNullOrEmpty(r.scenePath))
            return "{\"kind\":\"object\",\"path\":" + TunerUitkStr(r.scenePath) + (string.IsNullOrEmpty(r.scene) ? "" : ",\"scene\":" + TunerUitkStr(r.scene))
                + (string.IsNullOrEmpty(r.component) ? "" : ",\"components\":[{\"type\":" + TunerUitkStr(r.component) + "}]") + "}";
        return null;
    }

    static string TunerUitkOpenOrPrefabJson(UnityEngine.Object o)
    {
        var prefab = TiPrefabAssetPath(o);
        return prefab != null ? "{\"kind\":\"prefab\",\"path\":" + TunerUitkStr(prefab) + "}" : TiScriptOpenJson(o) ?? TunerUitkOpenJson(o);
    }

    static bool TunerUitkCatchOpen(UnityEngine.Object o)
    {
        return TunerUitkCatchOpenJson(TunerUitkOpenOrPrefabJson(o));
    }

    static bool TunerUitkCatchSelect(UnityEngine.Object o)
    {
        return TunerUitkCatchOpenJson(TunerUitkOpenJson(o));
    }

    static bool TunerUitkCatchOpenAsset(string path)
    {
        return TunerUitkCatchOpenJson(string.IsNullOrEmpty(path) ? null : "{\"kind\":\"prefab\",\"path\":" + TunerUitkStr(path) + "}");
    }

    static bool TunerUitkCatchOpenJson(string json)
    {
        var root = s_TunerUitkDispatchRoot;
        if (root == null || TunerUitkRootOf(root, out var st) == null) return false;
        if (json == null) return true;
        st.Open = json;
        SaturaDebug.Log("[tunerUitk] open " + json);
        return true;
    }

    static string TunerUitkPropertyJson(VisualElement field)
    {
        var p = TunerUitkBoundPath(field);
        return string.IsNullOrEmpty(p) ? "" : ",\"property\":" + TunerUitkStr(p);
    }

    static bool TunerUitkMenuContextPrefix(GenericMenu __instance)
    {
        if (s_TunerUitkDispatchRoot == null || Event.current != null || __instance == null) return true;
        __instance.DropDown(new Rect(s_TunerUitkLastPointer, Vector2.zero));
        return false;
    }

    static bool TunerUitkDisplayMenuPrefix(string[] options, bool[] enabled, bool[] separator, int[] selected, EditorUtility.SelectMenuItemFunction callback, object userData)
    {
        var root = s_TunerUitkDispatchRoot;
        if (root == null) return true;
        var items = new List<TunerUitkMenuItem>();
        var sel = selected != null ? new HashSet<int>(selected) : new HashSet<int>();
        var opts = options ?? new string[0];
        for (int i = 0; i < opts.Length; i++)
        {
            var index = i;
            var isSep = separator != null && i < separator.Length && separator[i];
            items.Add(new TunerUitkMenuItem
            {
                Path = opts[i],
                Separator = isSep,
                Checked = sel.Contains(i),
                Disabled = isSep || enabled != null && i < enabled.Length && !enabled[i],
                Run = () => callback?.Invoke(userData, opts, index)
            });
        }
        var focus = root.panel?.focusController?.focusedElement as VisualElement;
        var target = focus != null && TunerUitkRootOf(focus, out _) == root ? focus : root;
        TunerUitkOpenMenu(target, new Rect(s_TunerUitkLastPointer, Vector2.zero), items, TunerUitkBoundPath(target));
        return false;
    }

    static void TunerUitkEnsurePatches()
    {
        if (s_TunerUitkPatched || s_TunerUitkPatchError != null) return;
        var failures = new List<string>();
        try
        {
            var asm = FindHarmony();
            if (asm == null)
            {
                s_TunerUitkPatchError = "Harmony is not loaded";
                Debug.LogWarning("[tunerUitk] pickers stay unhooked: " + s_TunerUitkPatchError);
                return;
            }
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-uitk");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var ctor = methodType.GetConstructor(new[] { typeof(MethodInfo) });
            const BindingFlags any = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            void Apply(Type type, string method, string prefix, Type[] args = null)
            {
                try
                {
                    var target = args != null ? type.GetMethod(method, any, null, args, null) : type.GetMethods(any).FirstOrDefault(m => m.Name == method);
                    if (target == null) throw new MissingMethodException(type.Name + "." + method);
                    var call = new object[patch.GetParameters().Length];
                    call[0] = target;
                    call[1] = ctor.Invoke(new object[] { TunerPopupHook(prefix) });
                    patch.Invoke(harmony, call);
                }
                catch (Exception e)
                {
                    var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
                    failures.Add(type.Name + "." + method + ": " + inner.Message);
                }
            }
            Apply(typeof(ColorField), "ShowColorPicker", nameof(TunerUitkColorPrefix), Type.EmptyTypes);
            Apply(typeof(ColorField), "OnEyeDropperClicked", nameof(TunerUitkEyeDropperPrefix));
            Apply(typeof(CurveField), "ShowCurveEditor", nameof(TunerUitkCurvePrefix), Type.EmptyTypes);
            Apply(typeof(GradientField), "ShowGradientPicker", nameof(TunerUitkGradientPrefix), Type.EmptyTypes);
            Apply(typeof(ObjectField), "ShowObjectSelector", nameof(TunerUitkObjectPrefix), Type.EmptyTypes);
            Apply(typeof(EditorUtility), "Internal_DisplayCustomMenu", nameof(TunerUitkDisplayMenuPrefix));
            Apply(typeof(GenericMenu), "ShowAsContext", nameof(TunerUitkMenuContextPrefix), Type.EmptyTypes);
            s_TunerUitkPatched = true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            s_TunerUitkPatchError = inner.GetType().Name + ": " + inner.Message;
        }
        if (failures.Count > 0 || s_TunerUitkPatchError != null)
            Debug.LogWarning("[tunerUitk] some pickers stay unhooked: " + (s_TunerUitkPatchError ?? string.Join("; ", failures)));
    }

    static string TunerUitkJsonRaw(string json, string key)
    {
        if (string.IsNullOrEmpty(json)) return null;
        int depth = 0;
        for (int i = 0; i < json.Length; i++)
        {
            var c = json[i];
            if (c == '"')
            {
                var end = TunerUitkSkipString(json, i);
                if (depth == 1)
                {
                    var name = json.Substring(i + 1, end - i - 1);
                    var j = end + 1;
                    while (j < json.Length && char.IsWhiteSpace(json[j])) j++;
                    if (j < json.Length && json[j] == ':')
                    {
                        j++;
                        while (j < json.Length && char.IsWhiteSpace(json[j])) j++;
                        var valueEnd = TunerUitkSkipValue(json, j);
                        if (name == key) return json.Substring(j, valueEnd - j);
                        i = valueEnd - 1;
                        continue;
                    }
                }
                i = end;
            }
            else if (c == '{' || c == '[') depth++;
            else if (c == '}' || c == ']') depth--;
        }
        return null;
    }

    static int TunerUitkSkipString(string s, int start)
    {
        for (int i = start + 1; i < s.Length; i++)
        {
            if (s[i] == '\\') i++;
            else if (s[i] == '"') return i;
        }
        return s.Length - 1;
    }

    static int TunerUitkSkipValue(string s, int start)
    {
        if (start >= s.Length) return start;
        var c = s[start];
        if (c == '"') return TunerUitkSkipString(s, start) + 1;
        if (c == '{' || c == '[')
        {
            int depth = 0;
            for (int i = start; i < s.Length; i++)
            {
                if (s[i] == '"') i = TunerUitkSkipString(s, i);
                else if (s[i] == '{' || s[i] == '[') depth++;
                else if (s[i] == '}' || s[i] == ']')
                {
                    depth--;
                    if (depth == 0) return i + 1;
                }
            }
            return s.Length;
        }
        int k = start;
        while (k < s.Length && s[k] != ',' && s[k] != '}' && s[k] != ']') k++;
        return k;
    }

    static string TunerUitkJsonString(string raw)
    {
        if (raw == null) return null;
        raw = raw.Trim();
        if (raw == "null") return null;
        if (raw.Length < 2 || raw[0] != '"') return raw;
        var sb = new StringBuilder(raw.Length);
        for (int i = 1; i < raw.Length - 1; i++)
        {
            var c = raw[i];
            if (c != '\\' || i + 1 >= raw.Length - 1)
            {
                sb.Append(c);
                continue;
            }
            var n = raw[++i];
            switch (n)
            {
                case 'n': sb.Append('\n'); break;
                case 'r': sb.Append('\r'); break;
                case 't': sb.Append('\t'); break;
                case 'b': sb.Append('\b'); break;
                case 'f': sb.Append('\f'); break;
                case 'u':
                    if (i + 4 < raw.Length && int.TryParse(raw.Substring(i + 1, 4), System.Globalization.NumberStyles.HexNumber, TunerUitkInv, out var code))
                    {
                        sb.Append((char)code);
                        i += 4;
                    }
                    break;
                default: sb.Append(n); break;
            }
        }
        return sb.ToString();
    }
}
