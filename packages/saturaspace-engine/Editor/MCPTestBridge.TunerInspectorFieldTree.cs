using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    class TiFieldNode
    {
        public string Path;
        public string Field;
        public GUIContent Label;
        public bool Group;
        public bool Children;
        public bool Missing;
        public int Order;
        public int Request;
        public readonly List<TiFieldNode> Kids = new List<TiFieldNode>();
    }

    static readonly string[] TiPsModules =
    {
        "InitialModule", "EmissionModule", "ShapeModule", "VelocityModule", "ClampVelocityModule", "InheritVelocityModule",
        "LifetimeByEmitterSpeedModule", "ForceModule", "ColorModule", "ColorBySpeedModule", "SizeModule", "SizeBySpeedModule",
        "RotationModule", "RotationBySpeedModule", "ExternalForcesModule", "NoiseModule", "CollisionModule", "TriggerModule",
        "SubModule", "UVModule", "LightsModule", "TrailModule", "CustomDataModule"
    };

    static readonly string[] TiPsModuleTitles =
    {
        "Main", "Emission", "Shape", "Velocity over Lifetime", "Limit Velocity over Lifetime", "Inherit Velocity",
        "Lifetime by Emitter Speed", "Force over Lifetime", "Color over Lifetime", "Color by Speed", "Size over Lifetime", "Size by Speed",
        "Rotation over Lifetime", "Rotation by Speed", "External Forces", "Noise", "Collision", "Triggers",
        "Sub Emitters", "Texture Sheet Animation", "Lights", "Trails", "Custom Data"
    };

    static SerializedProperty TiFindField(SerializedObject so, string f)
    {
        var p = so.FindProperty(f);
        if (p == null && f.Length > 0 && !f.StartsWith("m_", StringComparison.Ordinal))
            p = so.FindProperty("m_" + char.ToUpperInvariant(f[0]) + f.Substring(1));
        return p;
    }

    static List<string> TiFieldChain(string path)
    {
        var chain = new List<string>();
        var parts = path.Split('.');
        var sb = new StringBuilder();
        for (int i = 0; i < parts.Length - 1; i++)
        {
            if (sb.Length > 0) sb.Append('.');
            sb.Append(parts[i]);
            if (parts[i] == "Array" && parts[i + 1].StartsWith("data[", StringComparison.Ordinal)) continue;
            chain.Add(sb.ToString());
        }
        return chain;
    }

    static Dictionary<string, int> TiFieldOrder(SerializedObject so)
    {
        var order = new Dictionary<string, int>();
        var it = so.GetIterator();
        bool enter = true;
        int n = 0;
        while (n < 20000 && it.Next(enter))
        {
            order[it.propertyPath] = n++;
            enter = !it.isArray && it.propertyType == SerializedPropertyType.Generic;
        }
        return order;
    }

    static int TiFieldRank(bool ps, string path, Dictionary<string, int> order)
    {
        if (ps && path.IndexOf('.') < 0)
        {
            int m = Array.IndexOf(TiPsModules, path);
            if (m >= 0) return m - TiPsModules.Length;
        }
        int r;
        if (order.TryGetValue(path, out r)) return r;
        if (path.EndsWith("]", StringComparison.Ordinal))
        {
            int open = path.LastIndexOf('[');
            if (open >= 0 && int.TryParse(path.Substring(open + 1, path.Length - open - 2), NumberStyles.Integer, CultureInfo.InvariantCulture, out r)) return r;
        }
        return int.MaxValue;
    }

    static GUIContent TiGroupLabel(bool ps, SerializedProperty p)
    {
        if (ps)
        {
            int m = Array.IndexOf(TiPsModules, p.propertyPath);
            if (m >= 0) return new GUIContent(TiPsModuleTitles[m]);
        }
        return new GUIContent(p.displayName, p.tooltip);
    }

    static TiFieldNode TiFieldTree(SerializedObject so, string[] fields)
    {
        var root = new TiFieldNode { Group = true };
        bool ps = so.targetObject is ParticleSystem;
        var order = TiFieldOrder(so);
        var groups = new Dictionary<string, TiFieldNode>();
        var leaves = new HashSet<string>();
        for (int i = 0; i < fields.Length; i++)
        {
            var f = fields[i] ?? "";
            var p = TiFindField(so, f);
            if (p == null)
            {
                root.Kids.Add(new TiFieldNode { Field = f, Missing = true, Request = i });
                continue;
            }
            var path = p.propertyPath;
            var anchor = path;
            int dot = path.LastIndexOf('.');
            if (dot > 0 && TiLeafNames.Contains(p.name) && so.FindProperty(path.Substring(0, dot)) != null) anchor = path.Substring(0, dot);
            var chain = TiFieldChain(anchor);
            bool children = f.EndsWith("]", StringComparison.Ordinal) && p.propertyType == SerializedPropertyType.Generic && p.hasVisibleChildren;
            if (children) chain.Add(anchor);
            if (ps && chain.Count == 0 && !anchor.StartsWith("m_", StringComparison.Ordinal) && Array.IndexOf(TiPsModules, anchor) < 0) chain.Add("InitialModule");
            var parent = root;
            foreach (var g in chain)
            {
                TiFieldNode node;
                if (!groups.TryGetValue(g, out node))
                {
                    var gp = so.FindProperty(g);
                    if (gp == null) continue;
                    gp.isExpanded = true;
                    node = new TiFieldNode { Path = g, Group = true, Label = TiGroupLabel(ps, gp), Order = TiFieldRank(ps, g, order), Request = i };
                    groups[g] = node;
                    parent.Kids.Add(node);
                }
                parent = node;
            }
            if (children)
            {
                parent.Children = true;
                continue;
            }
            if (!leaves.Add(path)) continue;
            parent.Kids.Add(new TiFieldNode { Path = path, Label = TiFieldLabel(so, p), Order = TiFieldRank(ps, path, order), Request = i });
        }
        TiFieldSort(root);
        return root;
    }

    static void TiFieldSort(TiFieldNode n)
    {
        n.Kids.Sort((a, b) =>
        {
            if (a.Group != b.Group) return a.Group ? 1 : -1;
            if (a.Group && a.Order != b.Order) return a.Order.CompareTo(b.Order);
            return a.Request.CompareTo(b.Request);
        });
        foreach (var k in n.Kids)
            if (k.Group) TiFieldSort(k);
    }

    static void TiFieldNodeGUI(SerializedObject so, TiFieldNode n, int depth)
    {
        foreach (var k in n.Kids)
        {
            EditorGUI.indentLevel = depth;
            if (k.Missing)
            {
                EditorGUILayout.HelpBox("No serialized field '" + k.Field + "'.", MessageType.Warning);
                continue;
            }
            var p = so.FindProperty(k.Path);
            if (p == null) continue;
            if (!k.Group)
            {
                EditorGUILayout.PropertyField(p, new GUIContent(k.Label), true);
                continue;
            }
            var tint = GUI.contentColor;
            bool open;
            GUI.contentColor = tint * new Color(1f, 1f, 1f, 0.6f);
            try { open = EditorGUILayout.Foldout(p.isExpanded, new GUIContent(k.Label), true); }
            finally { GUI.contentColor = tint; }
            if (open != p.isExpanded) p.isExpanded = open;
            if (!open) continue;
            if (!k.Children)
            {
                TiFieldNodeGUI(so, k, depth + 1);
                continue;
            }
            var it = p.Copy();
            var end = p.GetEndProperty();
            EditorGUI.indentLevel = depth + 1;
            if (it.NextVisible(true))
                while (!SerializedProperty.EqualContents(it, end))
                {
                    EditorGUILayout.PropertyField(it, true);
                    if (!it.NextVisible(false)) break;
                }
        }
    }

    class TiFieldHit
    {
        public TiSection Section;
        public string Path;
        public string Label;
        public string Value;
        public string Parents;
        public string Kind;
        public int Tier = int.MaxValue;
    }

    static string TiKeyName(string v)
    {
        var sb = new StringBuilder();
        var t = (v ?? "").ToLowerInvariant();
        if (t.StartsWith("m_", StringComparison.Ordinal)) t = t.Substring(2);
        foreach (var c in t)
            if (char.IsLetterOrDigit(c)) sb.Append(c);
        return sb.ToString();
    }

    static int TiFieldTier(string want, string label, string path, string chain)
    {
        if (path == want) return 0;
        if (label == want) return 1;
        var n = TiKeyName(want);
        if (n.Length == 0) return int.MaxValue;
        if (TiKeyName(label) == n || TiKeyName(path) == n) return 2;
        if (chain != null && TiKeyName(chain) == n) return 3;
        var leaf = path;
        var dot = leaf.LastIndexOf('.');
        if (dot >= 0) leaf = leaf.Substring(dot + 1);
        if (TiKeyName(leaf) == n) return 4;
        if (n.Length >= 3 && TiKeyName(label).EndsWith(n, StringComparison.Ordinal)) return 5;
        return int.MaxValue;
    }

    static void TiFieldConsider(ref TiFieldHit best, TiSection sec, string want, string label, string path, string chain, string parents, string kind, Func<string> value)
    {
        int tier = TiFieldTier(want, label, path, chain);
        if (tier == int.MaxValue || (best != null && best.Tier <= tier)) return;
        var v = value();
        if (v == null) return;
        best = new TiFieldHit { Section = sec, Path = path, Label = label, Value = v, Parents = parents, Kind = kind, Tier = tier };
    }

    static void TiFieldScan(ref TiFieldHit best, TiSection sec, SerializedObject so, string want, string prefix, string labelPrefix)
    {
        var it = so.GetIterator();
        if (!it.NextVisible(true)) return;
        var chain = new List<string>();
        var paths = new List<string>();
        int n = 0;
        do
        {
            if (++n > 4000) break;
            var path = it.propertyPath;
            if (path == "m_Script" || path == "m_ObjectHideFlags") continue;
            int depth = it.depth;
            while (chain.Count > depth) { chain.RemoveAt(chain.Count - 1); paths.RemoveAt(paths.Count - 1); }
            var label = it.displayName;
            bool param = prefix != null && path.EndsWith(".m_Value", StringComparison.Ordinal);
            if (prefix != null && !param && depth > 0 && path.EndsWith(".m_OverrideState", StringComparison.Ordinal)) { chain.Add(label); paths.Add(path); continue; }
            if (param && chain.Count > 0) label = chain[chain.Count - 1];
            var shown = labelPrefix != null ? labelPrefix + " " + label : label;
            var full = prefix != null ? prefix + "/" + path : path;
            var dotted = chain.Count > 0 && !param ? string.Join(".", chain) + "." + label : null;
            var parents = string.Join("|", paths);
            if (prefix != null) parents = parents.Length > 0 ? prefix + "/" + parents.Replace("|", "|" + prefix + "/") : "";
            if (prefix == null || param)
            {
                var p = it.Copy();
                TiFieldConsider(ref best, sec, want, shown, full, dotted, parents, TiTextureCurve(p) != null ? "Curve" : p.propertyType.ToString(), () => TiAnyValue(p));
            }
            chain.Add(label);
            paths.Add(path);
        }
        while (it.NextVisible(true));
    }

    static string TiLookupField(TiSession s, string section, string name)
    {
        var want = (name ?? "").Trim();
        if (want.Length == 0) return null;
        var wantSec = TiKeyName(section);
        TiFieldHit best = null;
        foreach (var sec in s.Sections)
        {
            if (sec.Kind != "component" || sec.Target == null || sec.Target is Transform) continue;
            var key = sec.Key ?? "";
            var hash = key.IndexOf('#');
            if (wantSec.Length > 0 && TiKeyName(hash >= 0 ? key.Substring(0, hash) : key) != wantSec && TiKeyName(key) != wantSec) continue;
            using (var so = new SerializedObject(sec.Target))
            {
                TiFieldScan(ref best, sec, so, want, null, null);
                var profile = so.FindProperty("sharedProfile");
                var list = profile != null && profile.propertyType == SerializedPropertyType.ObjectReference && profile.objectReferenceValue != null ? new SerializedObject(profile.objectReferenceValue) : null;
                if (list != null)
                {
                    using (list)
                    {
                        var comps = list.FindProperty("components");
                        for (int i = 0; comps != null && comps.isArray && i < comps.arraySize; i++)
                        {
                            var c = comps.GetArrayElementAtIndex(i).objectReferenceValue;
                            if (c == null) continue;
                            var owner = ObjectNames.NicifyVariableName(c.GetType().Name);
                            using (var cso = new SerializedObject(c))
                            {
                                var active = cso.FindProperty("active");
                                if (active != null)
                                {
                                    var a = active.Copy();
                                    TiFieldConsider(ref best, sec, want, owner, owner + "/active", null, "", "Boolean", () => a.boolValue ? "true" : "false");
                                }
                                TiFieldScan(ref best, sec, cso, want, owner, owner);
                            }
                        }
                    }
                }
            }
            if (best != null && best.Tier <= 1) break;
        }
        if (best == null) return null;
        var sb = new StringBuilder();
        TiStr(sb.Append("\"field\":{\"section\":"), best.Section.Key);
        TiStr(sb.Append(",\"path\":"), best.Path);
        TiStr(sb.Append(",\"label\":"), best.Label);
        TiStr(sb.Append(",\"value\":"), best.Value);
        TiStr(sb.Append(",\"parents\":"), best.Parents);
        TiStr(sb.Append(",\"kind\":"), best.Kind);
        sb.Append(",\"expanded\":").Append(TiExpanded(best.Section) ? "true" : "false").Append('}');
        return sb.ToString();
    }
}
