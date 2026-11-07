using System;
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
    const BindingFlags TunerPopupAny = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
    static readonly MethodInfo s_TunerPopupBuildRoot = typeof(AdvancedDropdown).GetMethod("BuildRoot", TunerPopupAny);
    static readonly MethodInfo s_TunerPopupItemSelected = typeof(AdvancedDropdown).GetMethod("ItemSelected", TunerPopupAny);
    static readonly PropertyInfo s_TunerPopupMinSize = typeof(AdvancedDropdown).GetProperty("minimumSize", TunerPopupAny);
    static readonly PropertyInfo s_TunerPopupDisplayName = typeof(AdvancedDropdownItem).GetProperty("displayName", TunerPopupAny);
    static readonly PropertyInfo s_TunerPopupTooltip = typeof(AdvancedDropdownItem).GetProperty("tooltip", TunerPopupAny);
    static readonly MethodInfo s_TunerPopupIsSeparator = typeof(AdvancedDropdownItem).GetMethod("IsSeparator", TunerPopupAny);
    static readonly MethodInfo s_TunerPopupIsHelpBox = typeof(AdvancedDropdownItem).GetMethod("IsHelpBox", TunerPopupAny);
    static readonly PropertyInfo s_TunerPopupChildren = typeof(AdvancedDropdownItem).GetProperty("childList", TunerPopupAny) ?? typeof(AdvancedDropdownItem).GetProperty("children", TunerPopupAny);

    static IEnumerable<AdvancedDropdownItem> TunerPopupChildrenOf(AdvancedDropdownItem item)
    {
        if (item == null || s_TunerPopupChildren == null) return new AdvancedDropdownItem[0];
        return s_TunerPopupChildren.GetValue(item) as IEnumerable<AdvancedDropdownItem> ?? new AdvancedDropdownItem[0];
    }

    sealed class TunerPopupTree
    {
        public readonly List<AdvancedDropdownItem> Items = new List<AdvancedDropdownItem>();
        public readonly Dictionary<string, string> Tex = new Dictionary<string, string>();
    }

    static bool TunerPopupItemFlag(MethodInfo m, AdvancedDropdownItem item)
    {
        try { return m != null && (bool)m.Invoke(item, null); }
        catch { return false; }
    }

    static string TunerPopupItemString(PropertyInfo p, AdvancedDropdownItem item)
    {
        try { return p?.GetValue(item) as string; }
        catch { return null; }
    }

    static void TunerPopupAppendIcon(StringBuilder sb, Texture icon, Dictionary<string, string> tex)
    {
        if (icon == null) return;
        var key = TunerUitkTextureKey(icon, new Rect(0f, 0f, 1f, 1f));
        sb.Append(",\"icon\":").Append(TunerUitkStr(key));
        if (tex.ContainsKey(key)) return;
        var png = TunerPopupIconPng(icon, out var w, out var h);
        if (png != null) tex[key] = "{\"w\":" + w.ToString(TunerPopupInv) + ",\"h\":" + h.ToString(TunerPopupInv) + ",\"png\":\"" + Convert.ToBase64String(png) + "\"}";
    }

    static void TunerPopupAppendItems(StringBuilder sb, IEnumerable<AdvancedDropdownItem> children, TunerPopupTree tree, int depth)
    {
        sb.Append('[');
        var first = true;
        foreach (var item in children)
        {
            if (item == null) continue;
            if (!first) sb.Append(',');
            first = false;
            var id = tree.Items.Count;
            tree.Items.Add(item);
            sb.Append("{\"id\":").Append(id.ToString(TunerPopupInv));
            if (TunerPopupItemFlag(s_TunerPopupIsSeparator, item))
            {
                sb.Append(",\"name\":\"\",\"sep\":1}");
                continue;
            }
            var name = TunerPopupItemString(s_TunerPopupDisplayName, item);
            sb.Append(",\"name\":").Append(TunerUitkStr(string.IsNullOrEmpty(name) ? item.name ?? "" : name));
            if (TunerPopupItemFlag(s_TunerPopupIsHelpBox, item)) sb.Append(",\"help\":1");
            if (!item.enabled) sb.Append(",\"off\":1");
            var tip = TunerPopupItemString(s_TunerPopupTooltip, item);
            if (!string.IsNullOrEmpty(tip)) sb.Append(",\"tip\":").Append(TunerUitkStr(tip));
            TunerPopupAppendIcon(sb, item.icon, tree.Tex);
            var any = false;
            var kids = TunerPopupChildrenOf(item);
            foreach (var _ in kids)
            {
                any = true;
                break;
            }
            if (any && depth < 64)
            {
                sb.Append(",\"ch\":");
                TunerPopupAppendItems(sb, kids, tree, depth + 1);
            }
            sb.Append('}');
        }
        sb.Append(']');
    }

    static string TunerPopupDropdownJson(AdvancedDropdownItem root, Vector2 size, TunerPopupTree tree, string property)
    {
        var sb = new StringBuilder(1024);
        sb.Append("{\"title\":").Append(TunerUitkStr(root != null ? (TunerPopupItemString(s_TunerPopupDisplayName, root) ?? root.name ?? "") : ""));
        sb.Append(",\"items\":");
        TunerPopupAppendItems(sb, TunerPopupChildrenOf(root), tree, 0);
        if (size.x > 0f) sb.Append(",\"width\":").Append(Mathf.RoundToInt(size.x).ToString(TunerPopupInv));
        if (size.y > 0f) sb.Append(",\"height\":").Append(Mathf.RoundToInt(size.y).ToString(TunerPopupInv));
        if (tree.Tex.Count > 0)
        {
            sb.Append(",\"tex\":{");
            var first = true;
            foreach (var kv in tree.Tex)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(TunerUitkStr(kv.Key)).Append(':').Append(kv.Value);
            }
            sb.Append('}');
        }
        if (!string.IsNullOrEmpty(property)) sb.Append(",\"property\":").Append(TunerUitkStr(property));
        sb.Append('}');
        return sb.ToString();
    }

    static Func<string, string, string> TunerPopupDropdownAnswer(AdvancedDropdown dropdown, TunerPopupTree tree)
    {
        return (action, raw) =>
        {
            if (action != "commit") return null;
            if (!int.TryParse((raw ?? "").Trim(), System.Globalization.NumberStyles.Integer, TunerPopupInv, out var id)) return "a dropdown answer needs an item id";
            if (id < 0 || id >= tree.Items.Count) return "dropdown item out of range";
            var item = tree.Items[id];
            if (!item.enabled || TunerPopupItemFlag(s_TunerPopupIsSeparator, item) || TunerPopupItemFlag(s_TunerPopupIsHelpBox, item)) return "that item cannot be picked";
            Undo.IncrementCurrentGroup();
            s_TunerPopupItemSelected.Invoke(dropdown, new object[] { item });
            SaturaDebug.Log("[tunerPopup] dropdown pick " + id + " '" + item.name + "'");
            return null;
        };
    }

    static AdvancedDropdownItem TunerPopupDropdownRoot(AdvancedDropdown dropdown, out Vector2 min)
    {
        min = Vector2.zero;
        try { min = s_TunerPopupMinSize != null ? (Vector2)s_TunerPopupMinSize.GetValue(dropdown) : Vector2.zero; }
        catch { }
        try { return s_TunerPopupBuildRoot.Invoke(dropdown, null) as AdvancedDropdownItem; }
        catch (TargetInvocationException e)
        {
            Debug.LogException(e.InnerException ?? e);
            return null;
        }
    }

    static readonly Type s_TunerPopupDropdownWindow = typeof(AdvancedDropdown).Assembly.GetType("UnityEditor.IMGUI.Controls.AdvancedDropdownWindow");
    static readonly PropertyInfo s_TunerPopupWindowSource = s_TunerPopupDropdownWindow?.GetProperty("dataSource", TunerPopupAny);
    static readonly PropertyInfo s_TunerPopupWindowSearchable = s_TunerPopupDropdownWindow?.GetProperty("searchable", TunerPopupAny);
    static readonly FieldInfo s_TunerPopupWindowChanged = s_TunerPopupDropdownWindow?.GetField("selectionChanged", BindingFlags.Instance | BindingFlags.NonPublic);
    static readonly FieldInfo s_TunerPopupWindowCanceled = s_TunerPopupDropdownWindow?.GetField("selectionCanceled", BindingFlags.Instance | BindingFlags.NonPublic);
    static readonly FieldInfo s_TunerPopupWindowClosed = s_TunerPopupDropdownWindow?.GetField("windowClosed", BindingFlags.Instance | BindingFlags.NonPublic);

    static AdvancedDropdownItem TunerPopupWindowTree(EditorWindow w)
    {
        var source = s_TunerPopupWindowSource?.GetValue(w);
        if (source == null) return null;
        var t = source.GetType();
        var main = t.GetProperty("mainTree", TunerPopupAny);
        var tree = main?.GetValue(source) as AdvancedDropdownItem;
        if (tree != null) return tree;
        t.GetMethod("ReloadData", TunerPopupAny, null, Type.EmptyTypes, null)?.Invoke(source, null);
        return main?.GetValue(source) as AdvancedDropdownItem;
    }

    static bool TunerPopupCatchDropdownWindow(EditorWindow w, Rect? screenRect)
    {
        if (w == null || s_TunerPopupDropdownWindow == null || !s_TunerPopupDropdownWindow.IsInstanceOfType(w) || s_TunerPopupWindowChanged == null) return false;
        AdvancedDropdownItem root;
        try { root = TunerPopupWindowTree(w); }
        catch (Exception e)
        {
            Debug.LogException(e is TargetInvocationException && e.InnerException != null ? e.InnerException : e);
            root = null;
        }
        if (root == null) return false;
        var searchable = true;
        try { searchable = s_TunerPopupWindowSearchable == null || (bool)s_TunerPopupWindowSearchable.GetValue(w); }
        catch { }
        var map = new TunerPopupTree();
        var width = Mathf.Max(screenRect?.width ?? 0f, w.minSize.x);
        var json = TunerPopupDropdownJson(root, new Vector2(width, w.minSize.y), map, null);
        if (!searchable) json = json.Substring(0, json.Length - 1) + ",\"search\":false}";
        var type = w.GetType().FullName;
        Func<string, string> pick = raw =>
        {
            if (!int.TryParse((raw ?? "").Trim(), System.Globalization.NumberStyles.Integer, TunerPopupInv, out var id)) return "a dropdown answer needs an item id";
            if (id < 0 || id >= map.Items.Count) return "dropdown item out of range";
            var item = map.Items[id];
            if (!item.enabled || TunerPopupItemFlag(s_TunerPopupIsSeparator, item) || TunerPopupItemFlag(s_TunerPopupIsHelpBox, item) || TunerPopupChildrenOf(item).Any()) return "that item cannot be picked";
            if (w == null) return "that dropdown is no longer open";
            s_TunerPopupWindowCanceled?.SetValue(w, null);
            (s_TunerPopupWindowChanged.GetValue(w) as Action<AdvancedDropdownItem>)?.Invoke(item);
            if (w != null && s_TunerPopupWindowClosed?.GetValue(w) is Delegate closed) closed.DynamicInvoke(w);
            SaturaDebug.Log("[tunerPopup] " + type + " pick " + id + " '" + item.name + "'");
            return null;
        };
        Action close = () =>
        {
            if (w != null) Object.DestroyImmediate(w);
        };
        if (s_TiDispatch != null)
        {
            var rect = screenRect ?? new Rect(0f, 0f, 1f, 1f);
            var p = TunerInspectorAddPopup("dropdown", rect, screenRect.HasValue, json, w, (x, action, raw) => action == "commit" ? pick(raw) : null, x => close());
            if (p != null && !screenRect.HasValue) p.Anchor = new Rect(s_TiMouseWorld.x > -1000f ? s_TiMouseWorld : Vector2.zero, new Vector2(1f, 1f));
            SaturaDebug.Log("[tunerPopup] " + type + " shown as a Tuner dropdown (" + map.Items.Count + " items)");
            return p != null;
        }
        var uroot = s_TunerUitkDispatchRoot;
        if (uroot == null || uroot.panel == null) return false;
        var owner = uroot.panel.Pick(s_TunerUitkLastPointer);
        if (owner == null || TunerUitkRootOf(owner, out _) != uroot) owner = uroot;
        var popup = TunerUitkSetPopup(owner, "dropdown", new Rect(s_TunerUitkLastPointer, new Vector2(width, 1f)), json, (action, raw) =>
        {
            if (action == "change") return null;
            string err = null;
            if (action == "commit") err = pick(raw);
            close();
            return err;
        });
        return popup != null;
    }

    static bool TunerPopupDropdownPrefix(AdvancedDropdown __instance, Rect rect)
    {
        if (s_TunerPopupBuildRoot == null || s_TunerPopupItemSelected == null) return true;
        if (TunerInspectorDispatching)
        {
            var built = TunerPopupDropdownRoot(__instance, out var minSize);
            if (built == null) return false;
            var tree0 = new TunerPopupTree();
            var json = TunerPopupDropdownJson(built, new Vector2(Mathf.Max(minSize.x, rect.width), minSize.y), tree0, null);
            var answer = TunerPopupDropdownAnswer(__instance, tree0);
            TunerInspectorAddPopup("dropdown", rect, false, json, __instance, (p, action, raw) => answer(action, raw), null);
            return false;
        }
        var root = s_TunerUitkDispatchRoot;
        if (root == null || root.panel == null) return true;
        var owner = root.panel.Pick(s_TunerUitkLastPointer) ?? root.panel.focusController?.focusedElement as VisualElement;
        if (owner == null || TunerUitkRootOf(owner, out _) != root) owner = root;
        var tree = TunerPopupDropdownRoot(__instance, out var min);
        if (tree == null) return false;
        var map = new TunerPopupTree();
        var data = TunerPopupDropdownJson(tree, new Vector2(Mathf.Max(min.x, rect.width), min.y), map, TunerUitkBoundPath(owner));
        var popup = TunerUitkSetPopup(owner, "dropdown", rect, data, TunerPopupDropdownAnswer(__instance, map));
        if (popup == null) Debug.LogWarning("[tunerPopup] a dropdown opened outside any captured section was dropped");
        return false;
    }
}
