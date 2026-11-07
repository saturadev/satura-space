using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    class TunerFilterRule
    {
        public Editor Editor;
        public TiSection Section;
        public string[] Paths;
        public readonly List<SerializedObject> Objects = new List<SerializedObject>();
        public readonly Dictionary<string, bool> Exists = new Dictionary<string, bool>();
    }

    static readonly List<TunerFilterRule> s_TfRules = new List<TunerFilterRule>();
    static int s_TfLive;
    static bool s_TfParentLoop;
    static bool s_TfPatched;
    static string s_TfPatchError;
    static Func<object, bool> s_TfHasDrawer;
    static Func<SerializedProperty, bool> s_TfReorderable;

    static string TunerFilterKey(string entry)
    {
        if (string.IsNullOrEmpty(entry)) return "";
        var e = entry.Trim();
        int index = 0;
        int hash = e.LastIndexOf('#');
        if (hash > 0 && int.TryParse(e.Substring(hash + 1), System.Globalization.NumberStyles.None, Inv, out index)) e = e.Substring(0, hash);
        int dot = e.LastIndexOf('.');
        if (dot >= 0) e = e.Substring(dot + 1);
        return index > 0 ? e + "#" + index.ToString(Inv) : e;
    }

    static bool TunerFilterExcludes(string[] exclude, string key)
    {
        if (exclude == null || exclude.Length == 0 || string.IsNullOrEmpty(key)) return false;
        var k = TunerFilterKey(key);
        foreach (var e in exclude)
            if (TunerFilterKey(e) == k) return true;
        return false;
    }

    static void TunerFilterAssetEntry(TunerEntry entry, TunerAssetArgs asset)
    {
        if (entry == null || asset == null) return;
        bool fields = asset.hasFields || (asset.fields != null && asset.fields.Length > 0);
        bool exclude = asset.exclude != null && asset.exclude.Length > 0;
        entry.Filter = fields || exclude ? asset : null;
        if (entry.Filter != null) entry.Filter.hasFields = fields;
    }

    static void AppendTunerFilter(StringBuilder sb, bool hasFields, string[] fields, string[] exclude)
    {
        if (hasFields) AppendTunerStrings(sb, "fields", fields);
        else if (exclude != null && exclude.Length > 0) AppendTunerStrings(sb, "exclude", exclude);
    }

    static void AppendTunerStrings(StringBuilder sb, string name, string[] values)
    {
        sb.Append(",\"").Append(name).Append("\":[");
        if (values != null)
            for (int k = 0; k < values.Length; k++)
            {
                if (k > 0) sb.Append(',');
                sb.Append(JStr(values[k] ?? ""));
            }
        sb.Append(']');
    }

    static string TunerFilterSpecKey(TunerInspectorTargetArgs t)
    {
        var sb = new StringBuilder();
        if (t.kind == "asset")
        {
            if (t.hasFields) sb.Append("|f:").Append(string.Join(",", t.fields ?? new string[0]));
            else if (t.exclude != null && t.exclude.Length > 0) sb.Append("|x:").Append(string.Join(",", t.exclude));
            return sb.ToString();
        }
        if (!t.restrict)
        {
            if (t.exclude != null && t.exclude.Length > 0) sb.Append("|x:").Append(string.Join(",", t.exclude));
            return sb.ToString();
        }
        if (t.components == null) return "";
        foreach (var c in t.components)
            if (c != null && !c.hasFields && c.exclude != null && c.exclude.Length > 0)
                sb.Append("|").Append(c.type).Append('#').Append(c.index).Append(":x:").Append(string.Join(",", c.exclude));
        return sb.ToString();
    }

    static bool TunerFilterSection(TiSession s, TiSection sec, ref bool withBody)
    {
        var spec = s != null ? s.Spec : null;
        if (spec == null || sec == null) return true;
        if (spec.kind == "asset")
        {
            if (sec.Key != "asset" || sec.Kind != "asset") return true;
            if (spec.hasFields) TunerFilterOnly(sec, spec.fields, ref withBody);
            else TunerFilterExclude(sec, spec.exclude);
            return true;
        }
        if (sec.Kind != "component" && sec.Kind != "material") return true;
        if (!spec.restrict)
        {
            if (!TunerFilterExcludes(spec.exclude, sec.Key)) return true;
            if (sec.OwnsEditor && sec.Editor != null)
            {
                try { Object.DestroyImmediate(sec.Editor); } catch { }
            }
            sec.FieldsObject?.Dispose();
            return false;
        }
        var comp = sec.Target as Component;
        if (comp == null || spec.components == null) return true;
        bool listed = false;
        foreach (var c in spec.components)
        {
            if (c == null || TiResolveComponent(comp.gameObject, c) != comp) continue;
            listed = true;
            if (c.hasFields)
            {
                if (c.fields == null || c.fields.Length == 0) withBody = false;
                else if (s.Gos.Count > 1) TunerFilterOnly(sec, c.fields, ref withBody);
            }
            else TunerFilterExclude(sec, c.exclude);
            break;
        }
        return listed || s.Gos.Count <= 1;
    }

    static void TunerFilterOnly(TiSection sec, string[] fields, ref bool withBody)
    {
        if (fields == null || fields.Length == 0)
        {
            withBody = false;
            return;
        }
        if (sec.Target == null) return;
        sec.Fields = fields;
        sec.FieldTree = null;
        sec.FieldsObject?.Dispose();
        var many = sec.Editor != null ? sec.Editor.targets : null;
        sec.FieldsObject = many != null && many.Length > 1 ? new SerializedObject(many) : new SerializedObject(sec.Target);
        foreach (var f in fields)
        {
            if (string.IsNullOrEmpty(f) || !f.EndsWith("]", StringComparison.Ordinal)) continue;
            var p = sec.FieldsObject.FindProperty(f);
            if (p == null || !p.hasVisibleChildren) continue;
            p.isExpanded = true;
            var it = p.Copy();
            var end = p.GetEndProperty();
            if (!it.NextVisible(true)) continue;
            while (!SerializedProperty.EqualContents(it, end))
            {
                if (it.isArray && it.propertyType == SerializedPropertyType.Generic)
                {
                    it.isExpanded = true;
                    for (int k = 0; k < it.arraySize && k < 16; k++) it.GetArrayElementAtIndex(k).isExpanded = true;
                }
                if (!it.NextVisible(false)) break;
            }
        }
    }

    static void TunerFilterExclude(TiSection sec, string[] exclude)
    {
        if (exclude == null || exclude.Length == 0 || sec.Editor == null) return;
        SerializedObject so;
        try { so = sec.Editor.serializedObject; }
        catch { return; }
        if (so == null) return;
        s_TfRules.RemoveAll(r => r.Editor == null || r.Editor == sec.Editor || r.Section == sec);
        var rule = new TunerFilterRule { Editor = sec.Editor, Section = sec, Paths = exclude.Select(p => TunerFilterResolve(so, p)).Distinct().ToArray() };
        rule.Objects.Add(so);
        s_TfRules.Add(rule);
        s_TfLive = s_TfRules.Count;
        EnsureTunerFilterPatches();
    }

    static string TunerFilterResolve(SerializedObject so, string path)
    {
        var p = (path ?? "").Trim();
        if (p.Length == 0) return p;
        try
        {
            if (so.FindProperty(p) != null) return p;
            if (p.StartsWith("m_", StringComparison.Ordinal)) return p;
            var alt = "m_" + char.ToUpperInvariant(p[0]) + p.Substring(1);
            if (so.FindProperty(alt) != null) return alt;
        }
        catch
        {
        }
        return p;
    }

    static bool TunerFilterMatches(string[] paths, string path)
    {
        foreach (var x in paths)
        {
            if (x.Length == 0 || !path.StartsWith(x, StringComparison.Ordinal)) continue;
            if (path.Length == x.Length || path[x.Length] == '.') return true;
        }
        return false;
    }

    static TunerFilterRule TunerFilterRuleFor(SerializedObject so)
    {
        for (int i = s_TfRules.Count - 1; i >= 0; i--)
        {
            var r = s_TfRules[i];
            for (int k = 0; k < r.Objects.Count; k++)
                if (ReferenceEquals(r.Objects[k], so)) return r;
        }
        var sec = s_TiDispatchSection;
        if (sec == null || sec.Editor == null) return null;
        for (int i = s_TfRules.Count - 1; i >= 0; i--)
        {
            var r = s_TfRules[i];
            if (r.Section != sec) continue;
            Object target;
            try { target = so.targetObject; }
            catch { return null; }
            if (target == null || target != sec.Target || r.Objects.Count > 8) return null;
            r.Objects.Add(so);
            return r;
        }
        return null;
    }

    static bool TunerFilterHides(SerializedProperty p)
    {
        if (s_TfLive == 0 || p == null) return false;
        try
        {
            var rule = TunerFilterRuleFor(p.serializedObject);
            return rule != null && TunerFilterMatches(rule.Paths, p.propertyPath);
        }
        catch
        {
            return false;
        }
    }

    static bool TunerFilterLoops(object handler, SerializedProperty p, bool includeChildren)
    {
        if (!includeChildren || p == null) return false;
        try
        {
            if (s_TfHasDrawer != null && s_TfHasDrawer(handler)) return false;
            if (s_TfReorderable != null) return !s_TfReorderable(p);
            return !p.isArray || p.propertyType == SerializedPropertyType.String;
        }
        catch
        {
            return false;
        }
    }

    static bool TunerFilterHideUitk(TiSession s)
    {
        if (s_TfLive == 0 || s == null) return false;
        bool changed = false;
        foreach (var sec in s.Sections)
        {
            if (!sec.Uitk || sec.Body == null) continue;
            TunerFilterRule rule = null;
            foreach (var r in s_TfRules)
                if (r.Section == sec) rule = r;
            if (rule == null || rule.Objects.Count == 0) continue;
            changed |= TunerFilterHideIn(sec.Body, "", rule);
        }
        return changed;
    }

    static bool TunerFilterHideIn(VisualElement e, string ctx, TunerFilterRule rule)
    {
        var path = ctx;
        var bindable = e as IBindable;
        if (bindable != null && !string.IsNullOrEmpty(bindable.bindingPath))
        {
            var resolved = TunerFilterBinding(rule, ctx, bindable.bindingPath);
            if (resolved != null)
            {
                path = resolved;
                if (TunerFilterMatches(rule.Paths, resolved))
                {
                    var d = e.style.display;
                    if (d.keyword == StyleKeyword.Undefined && d.value == DisplayStyle.None) return false;
                    e.style.display = DisplayStyle.None;
                    return true;
                }
            }
        }
        bool changed = false;
        int n = e.hierarchy.childCount;
        for (int i = 0; i < n; i++) changed |= TunerFilterHideIn(e.hierarchy[i], path, rule);
        return changed;
    }

    static string TunerFilterBinding(TunerFilterRule rule, string ctx, string bindingPath)
    {
        if (ctx.Length > 0)
        {
            var rel = ctx + "." + bindingPath;
            if (TunerFilterExists(rule, rel)) return rel;
        }
        return TunerFilterExists(rule, bindingPath) ? bindingPath : null;
    }

    static bool TunerFilterExists(TunerFilterRule rule, string path)
    {
        bool found;
        if (rule.Exists.TryGetValue(path, out found)) return found;
        try { found = rule.Objects[0].FindProperty(path) != null; }
        catch { found = false; }
        rule.Exists[path] = found;
        return found;
    }

    static bool TiCountsAsOne(SerializedProperty p)
    {
        if (p.propertyType != SerializedPropertyType.Generic || p.isArray || !p.hasVisibleChildren) return true;
        if (p.type == "Matrix4x4f") return true;
        foreach (var n in TiLeafNames)
            if (p.FindPropertyRelative(n) != null) return true;
        return false;
    }

    static int TiCountLeaves(SerializedProperty start, string[] skip)
    {
        int n = 0;
        try
        {
            var it = start.Copy();
            var end = start.GetEndProperty();
            if (!it.NextVisible(true)) return 0;
            bool enter = false;
            int guard = 0;
            do
            {
                if (SerializedProperty.EqualContents(it, end)) break;
                enter = false;
                var path = it.propertyPath;
                if (path == "m_Script" || path == "m_Enabled") continue;
                if (skip != null && TunerFilterMatches(skip, path)) continue;
                if (!TiCountsAsOne(it))
                {
                    enter = true;
                    continue;
                }
                n++;
            }
            while (++guard < 100000 && it.NextVisible(enter));
        }
        catch
        {
        }
        return n;
    }

    static int TiCountObject(SerializedObject so, string[] skip)
    {
        int n = 0;
        try
        {
            var it = so.GetIterator();
            bool enter = true;
            int guard = 0;
            while (++guard < 100000 && it.NextVisible(enter))
            {
                enter = false;
                var path = it.propertyPath;
                if (path == "m_Script" || path == "m_Enabled") continue;
                if (skip != null && TunerFilterMatches(skip, path)) continue;
                if (!TiCountsAsOne(it))
                {
                    enter = true;
                    continue;
                }
                n++;
            }
        }
        catch
        {
        }
        return n;
    }

    static int TiCountTree(SerializedObject so, TiFieldNode node)
    {
        int n = 0;
        foreach (var k in node.Kids)
        {
            if (k.Missing) continue;
            var p = k.Path != null ? so.FindProperty(k.Path) : null;
            if (!k.Group)
            {
                if (p != null) n += TiCountsAsOne(p) ? 1 : TiCountLeaves(p, null);
                continue;
            }
            if (k.Children && p != null) n += TiCountLeaves(p, null);
            n += TiCountTree(so, k);
        }
        return n;
    }

    static void TiCountFields(TiSection sec, bool withBody)
    {
        sec.FieldsShown = sec.FieldsTotal = -1;
        if (sec.Kind != "component") return;
        if (sec.Fields != null)
        {
            var so = sec.FieldsObject;
            if (so == null) return;
            sec.FieldsTotal = TiCountObject(so, null);
            if (!withBody || sec.Fields.Length == 0)
            {
                sec.FieldsShown = 0;
                return;
            }
            if (sec.FieldTree == null) sec.FieldTree = TiFieldTree(so, sec.Fields);
            sec.FieldsShown = Math.Min(sec.FieldsTotal, TiCountTree(so, sec.FieldTree));
            return;
        }
        TunerFilterRule rule = null;
        foreach (var r in s_TfRules)
            if (r.Section == sec) rule = r;
        if (rule == null || rule.Objects.Count == 0) return;
        sec.FieldsTotal = TiCountObject(rule.Objects[0], null);
        sec.FieldsShown = TiCountObject(rule.Objects[0], rule.Paths);
    }

    static bool TiCountsAsComponent(Component c)
    {
        return c != null && (c.hideFlags & HideFlags.HideInInspector) == 0 && !(c is ParticleSystemRenderer);
    }

    static bool TiCountComponents(TiSession s, out int shown, out int total)
    {
        shown = total = 0;
        if (s.Go == null || s.Spec == null || s.Spec.kind == "asset") return false;
        foreach (var c in s.Go.GetComponents<Component>())
            if (TiCountsAsComponent(c)) total++;
        var seen = new HashSet<Object>();
        foreach (var sec in s.Sections)
            if (sec.Kind == "component" && sec.Target is Component c && c.gameObject == s.Go && TiCountsAsComponent(c)) seen.Add(c);
        shown = seen.Count;
        return true;
    }

    static void EnsureTunerFilterPatches()
    {
        if (s_TfPatched || s_TfPatchError != null) return;
        try
        {
            var handler = TiTypeOrNull("UnityEditor.PropertyHandler") ?? throw new TypeLoadException("UnityEditor.PropertyHandler");
            var onLayout = handler.GetMethod("OnGUILayout", TiInstance, null, new[] { typeof(SerializedProperty), typeof(GUIContent), typeof(bool), typeof(GUILayoutOption[]) }, null)
                ?? throw new MissingMethodException("PropertyHandler.OnGUILayout");
            var onGui = handler.GetMethod("OnGUI", TiInstance, null, new[] { typeof(Rect), typeof(SerializedProperty), typeof(GUIContent), typeof(bool), typeof(Rect) }, null)
                ?? throw new MissingMethodException("PropertyHandler.OnGUI");
            var height = handler.GetMethod("GetHeight", TiInstance, null, new[] { typeof(SerializedProperty), typeof(GUIContent), typeof(bool) }, null)
                ?? throw new MissingMethodException("PropertyHandler.GetHeight");
            var drawer = handler.GetProperty("hasPropertyDrawer", TiInstance);
            if (drawer != null)
            {
                var p = Expression.Parameter(typeof(object), "h");
                s_TfHasDrawer = Expression.Lambda<Func<object, bool>>(Expression.Property(Expression.Convert(p, handler), drawer), p).Compile();
            }
            var reorderable = handler.GetMethod("UseReorderabelListControl", TiStatic, null, new[] { typeof(SerializedProperty) }, null);
            if (reorderable != null && reorderable.ReturnType == typeof(bool))
                s_TfReorderable = (Func<SerializedProperty, bool>)Delegate.CreateDelegate(typeof(Func<SerializedProperty, bool>), reorderable);

            var asm = FindHarmony();
            if (asm == null) throw new TypeLoadException("Harmony is not loaded");
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-filter");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var ps = patch.GetParameters();
            var hmCtor = methodType.GetConstructor(new[] { typeof(MethodInfo) });
            var hooks = typeof(TunerFilterHooks);
            object Hm(string name) => hmCtor.Invoke(new object[] { hooks.GetMethod(name, TiStatic) ?? throw new MissingMethodException("TunerFilterHooks." + name) });
            void Apply(MethodBase target, string prefix, string finalizer)
            {
                var args = new object[ps.Length];
                args[0] = target;
                for (int i = 1; i < ps.Length; i++)
                {
                    if (ps[i].Name == "prefix") args[i] = Hm(prefix);
                    else if (ps[i].Name == "finalizer" && finalizer != null) args[i] = Hm(finalizer);
                    else args[i] = ps[i].HasDefaultValue ? ps[i].DefaultValue : null;
                }
                patch.Invoke(harmony, args);
            }
            if (!ps.Any(x => x.Name == "finalizer")) throw new MissingMethodException("Harmony.Patch(finalizer)");
            Apply(onLayout, nameof(TunerFilterHooks.LayoutPrefix), null);
            Apply(onGui, nameof(TunerFilterHooks.GuiPrefix), nameof(TunerFilterHooks.Restore));
            Apply(height, nameof(TunerFilterHooks.HeightPrefix), nameof(TunerFilterHooks.Restore));
            s_TfPatched = true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            s_TfPatchError = inner.GetType().Name + ": " + inner.Message;
            Debug.LogWarning("[tunerInspector] property filter patch failed, IMGUI inspectors show excluded properties: " + s_TfPatchError);
        }
    }

    public static class TunerFilterHooks
    {
        public static bool LayoutPrefix(SerializedProperty property, ref bool __result)
        {
            if (!TunerFilterHides(property)) return true;
            __result = false;
            return false;
        }

        public static bool GuiPrefix(object __instance, SerializedProperty property, bool includeChildren, ref bool __result, out bool __state)
        {
            __state = s_TfParentLoop;
            if (s_TfLive == 0) return true;
            if (TunerFilterHides(property))
            {
                __result = false;
                return false;
            }
            s_TfParentLoop = TunerFilterLoops(__instance, property, includeChildren);
            return true;
        }

        public static bool HeightPrefix(object __instance, SerializedProperty property, bool includeChildren, ref float __result, out bool __state)
        {
            __state = s_TfParentLoop;
            if (s_TfLive == 0) return true;
            if (TunerFilterHides(property))
            {
                __result = s_TfParentLoop ? -EditorGUIUtility.standardVerticalSpacing : 0f;
                return false;
            }
            s_TfParentLoop = TunerFilterLoops(__instance, property, includeChildren);
            return true;
        }

        public static void Restore(bool __state)
        {
            s_TfParentLoop = __state;
        }
    }
}
