using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using System.Text;
using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;

public static partial class MCPTestBridge
{
    internal sealed class TunerUitkCaptureResult
    {
        public string Json;
        public IReadOnlyList<IMGUIContainer> Imgui;
    }

    internal sealed class TunerUitkPopup
    {
        public string Id;
        public string Kind;
        public Rect Anchor;
        public string Data;
        public VisualElement Owner;
        public Func<string, string, string> Answer;
    }

    sealed class TunerUitkState
    {
        public readonly Dictionary<int, VisualElement> Nodes = new Dictionary<int, VisualElement>();
        public readonly List<IMGUIContainer> Imgui = new List<IMGUIContainer>();
        public TunerUitkPopup Popup;
        public string Open;
        public WeakReference<VisualElement> Root;
    }

    sealed class TunerUitkFieldInfo
    {
        public PropertyInfo Value;
        public PropertyInfo Label;
        public MethodInfo StringToValue;
    }

    sealed class TunerUitkWalk
    {
        public TunerUitkState State;
        public HashSet<string> Known;
        public readonly List<KeyValuePair<string, TunerUitkTexRef>> NewTextures = new List<KeyValuePair<string, TunerUitkTexRef>>();
        public readonly HashSet<string> Seen = new HashSet<string>();
    }

    struct TunerUitkTexRef
    {
        public Texture Texture;
        public Rect Uv;
    }

    const int TUNER_UITK_MAX_TEX = 256;
    const int TUNER_UITK_OWN_BG = 1;
    const int TUNER_UITK_OWN_COL = 2;
    const int TUNER_UITK_OWN_BORDER = 4;
    const int TUNER_UITK_OWN_IMG = 8;
    const int TUNER_UITK_OWN_TINT = 16;
    const int TUNER_UITK_OWN_PIC = 32;
    static readonly CultureInfo TunerUitkInv = CultureInfo.InvariantCulture;
    static readonly ConditionalWeakTable<VisualElement, TunerUitkState> s_TunerUitkStates = new ConditionalWeakTable<VisualElement, TunerUitkState>();
    static readonly ConditionalWeakTable<VisualElement, StrongBox<int>> s_TunerUitkIds = new ConditionalWeakTable<VisualElement, StrongBox<int>>();
    static readonly List<WeakReference<VisualElement>> s_TunerUitkRoots = new List<WeakReference<VisualElement>>();
    static readonly Dictionary<Type, TunerUitkFieldInfo> s_TunerUitkFields = new Dictionary<Type, TunerUitkFieldInfo>();
    static readonly Dictionary<Type, MethodInfo[]> s_TunerUitkPanelCalls = new Dictionary<Type, MethodInfo[]>();
    static int s_TunerUitkNextId;
    static int s_TunerUitkNextPopup;

    static bool s_TunerUitkReady;
    static string s_TunerUitkError;
    static PropertyInfo s_TunerUitkPseudo;
    static MethodInfo s_TunerUitkShouldClip;
    static FieldInfo s_TunerUitkMenuFunctor;
    static PropertyInfo s_TunerUitkMenuManager;
    static FieldInfo s_TunerUitkImageInline;
    static FieldInfo s_TunerUitkInlineAccess;
    static PropertyInfo s_TunerUitkInlineRule;
    static object s_TunerUitkExtractor;
    static MethodInfo s_TunerUitkFindRules;
    static FieldInfo s_TunerUitkRecords;
    static FieldInfo s_TunerUitkRecSheet;
    static FieldInfo s_TunerUitkRecSelector;
    static PropertyInfo s_TunerUitkSelectorRule;
    static PropertyInfo s_TunerUitkRuleProps;
    static PropertyInfo s_TunerUitkPropName;
    static FieldInfo s_TunerUitkPropVar;
    static readonly Dictionary<StyleSheet, bool> s_TunerUitkCustomSheets = new Dictionary<StyleSheet, bool>();

    internal static TunerUitkCaptureResult TunerUitkCapture(VisualElement root, ICollection<string> knownTextures, bool tick = true)
    {
        if (root == null) throw new ArgumentNullException(nameof(root));
        if (root.panel == null) throw new InvalidOperationException("the UI Toolkit root is not attached to a panel");
        TunerUitkInit();
        var st = TunerUitkStateFor(root);
        TunerUitkPreparePanel(root.panel);
        if (tick) TunerUitkTick(root.panel);
        var walk = new TunerUitkWalk { State = st, Known = knownTextures as HashSet<string> ?? new HashSet<string>(knownTextures) };
        st.Nodes.Clear();
        st.Imgui.Clear();
        var origin = root.worldBound;
        var sb = new StringBuilder(32768);
        sb.Append("\"w\":").Append(TunerUitkNum(origin.width));
        sb.Append(",\"h\":").Append(TunerUitkNum(origin.height));
        sb.Append(",\"skin\":").Append(EditorGUIUtility.isProSkin ? "\"dark\"" : "\"light\"");
        sb.Append(",\"root\":");
        var rootScope = false;
        for (var e = root.hierarchy.parent; e != null && !rootScope; e = e.hierarchy.parent) rootScope = TunerUitkHasCustomSheet(e);
        var rootParent = root.hierarchy.parent;
        if (!TunerUitkAppendNode(sb, root, origin.position, walk, true, 0, rootParent != null ? rootParent.resolvedStyle.color : Color.clear, rootScope)) sb.Append("null");
        if (st.Popup != null && st.Popup.Owner != null && st.Popup.Owner.panel == null) st.Popup = null;
        if (st.Popup != null)
        {
            var p = st.Popup;
            sb.Append(",\"popup\":{\"id\":").Append(TunerUitkStr(p.Id));
            sb.Append(",\"kind\":").Append(TunerUitkStr(p.Kind));
            sb.Append(",\"anchor\":");
            TunerUitkRect(sb, new Rect(p.Anchor.position - origin.position, p.Anchor.size));
            sb.Append(",\"data\":").Append(string.IsNullOrEmpty(p.Data) ? "{}" : p.Data).Append('}');
        }
        if (st.Imgui.Count > 0) sb.Append(",\"imgui\":").Append(st.Imgui.Count.ToString(TunerUitkInv));
        if (st.Open != null)
        {
            sb.Append(",\"open\":").Append(st.Open);
            st.Open = null;
        }
        var body = sb.ToString();
        var result = new TunerUitkCaptureResult { Imgui = st.Imgui };
        var outSb = new StringBuilder(body.Length + 64);
        outSb.Append('{').Append(body);
        if (walk.NewTextures.Count > 0)
        {
            outSb.Append(",\"tex\":{");
            var first = true;
            foreach (var kv in walk.NewTextures)
            {
                var png = TunerUitkExportTexture(kv.Value.Texture, kv.Value.Uv, out var tw, out var th);
                if (png == null) continue;
                if (!first) outSb.Append(',');
                first = false;
                outSb.Append(TunerUitkStr(kv.Key)).Append(":{\"w\":").Append(tw.ToString(TunerUitkInv))
                    .Append(",\"h\":").Append(th.ToString(TunerUitkInv))
                    .Append(",\"png\":\"").Append(Convert.ToBase64String(png)).Append("\"}");
                walk.Known.Add(kv.Key);
            }
            outSb.Append('}');
        }
        outSb.Append('}');
        result.Json = outSb.ToString();
        return result;
    }

    internal static void TunerUitkForget(VisualElement root)
    {
        if (root == null) return;
        s_TunerUitkStates.Remove(root);
        s_TunerUitkRoots.RemoveAll(w => !w.TryGetTarget(out var r) || r == root);
    }

    static TunerUitkState TunerUitkStateFor(VisualElement root)
    {
        if (s_TunerUitkStates.TryGetValue(root, out var st)) return st;
        st = new TunerUitkState { Root = new WeakReference<VisualElement>(root) };
        s_TunerUitkStates.Add(root, st);
        s_TunerUitkRoots.RemoveAll(w => !w.TryGetTarget(out var r) || r.panel == null);
        s_TunerUitkRoots.Add(new WeakReference<VisualElement>(root));
        return st;
    }

    static VisualElement TunerUitkRootOf(VisualElement ve, out TunerUitkState state)
    {
        state = null;
        for (var e = ve; e != null; e = e.hierarchy.parent)
            if (s_TunerUitkStates.TryGetValue(e, out state)) return e;
        return null;
    }

    static int TunerUitkIdOf(VisualElement ve)
    {
        if (!s_TunerUitkIds.TryGetValue(ve, out var box))
        {
            box = new StrongBox<int>(++s_TunerUitkNextId);
            s_TunerUitkIds.Add(ve, box);
        }
        return box.Value;
    }

    static bool TunerUitkAppendNode(StringBuilder sb, VisualElement ve, Vector2 parentPos, TunerUitkWalk walk, bool isRoot, int parentOwn, Color parentCol, bool scope)
    {
        var rs = ve.resolvedStyle;
        if (rs.display == DisplayStyle.None) return false;
        var wb = ve.worldBound;
        if (float.IsNaN(wb.x) || float.IsNaN(wb.y) || float.IsNaN(wb.width) || float.IsNaN(wb.height)) return false;
        var id = TunerUitkIdOf(ve);
        walk.State.Nodes[id] = ve;
        var type = ve.GetType();
        sb.Append("{\"i\":").Append(id.ToString(TunerUitkInv));
        sb.Append(",\"t\":").Append(TunerUitkStr(TunerUitkTypeName(type)));
        sb.Append(",\"x\":").Append(TunerUitkNum(isRoot ? 0f : wb.x - parentPos.x));
        sb.Append(",\"y\":").Append(TunerUitkNum(isRoot ? 0f : wb.y - parentPos.y));
        sb.Append(",\"w\":").Append(TunerUitkNum(wb.width));
        sb.Append(",\"h\":").Append(TunerUitkNum(wb.height));
        if (!string.IsNullOrEmpty(ve.name)) sb.Append(",\"n\":").Append(TunerUitkStr(ve.name));
        var classes = ve.GetClasses().ToList();
        if (classes.Count > 0) sb.Append(",\"c\":").Append(TunerUitkStr(string.Join(" ", classes)));
        var ps = TunerUitkPseudoStates(ve) & ~0x80;
        if (ps != 0) sb.Append(",\"ps\":").Append(ps.ToString(TunerUitkInv));
        if (!ve.enabledInHierarchy) sb.Append(",\"d\":1");
        if (rs.visibility == Visibility.Hidden) sb.Append(",\"hid\":1");
        if (rs.opacity < 0.999f) sb.Append(",\"op\":").Append(TunerUitkNum(rs.opacity));
        if (TunerUitkClips(ve)) sb.Append(",\"clip\":1");
        if (ve.focusController != null && ve.focusController.focusedElement == ve) sb.Append(",\"foc\":1");
        if (!string.IsNullOrEmpty(ve.tooltip)) sb.Append(",\"tip\":").Append(TunerUitkStr(ve.tooltip));
        scope = scope || TunerUitkHasCustomSheet(ve);
        var own = TunerUitkOwnership(ve, rs, parentOwn, parentCol, scope);
        if (own != 0) sb.Append(",\"own\":").Append(own.ToString(TunerUitkInv));
        TunerUitkAppendBox(sb, rs);
        TunerUitkAppendBackground(sb, ve, rs, walk, own);
        if (ve is TextElement te) TunerUitkAppendText(sb, ve, te, rs);
        if (ve is IBindable bindable && !string.IsNullOrEmpty(bindable.bindingPath)) sb.Append(",\"bp\":").Append(TunerUitkStr(bindable.bindingPath));
        TunerUitkAppendField(sb, ve, type);
        TunerUitkAppendSpecial(sb, ve, walk);
        if (ve is IMGUIContainer imgui)
        {
            sb.Append(",\"im\":").Append(walk.State.Imgui.Count.ToString(TunerUitkInv));
            walk.State.Imgui.Add(imgui);
            sb.Append('}');
            return true;
        }
        var count = ve.hierarchy.childCount;
        if (count > 0)
        {
            var mark = sb.Length;
            sb.Append(",\"ch\":[");
            var any = false;
            for (int i = 0; i < count; i++)
            {
                var child = ve.hierarchy[i];
                var before = sb.Length;
                if (any) sb.Append(',');
                if (TunerUitkAppendNode(sb, child, wb.position, walk, false, own, rs.color, scope)) any = true;
                else sb.Length = before;
            }
            if (any) sb.Append(']');
            else sb.Length = mark;
        }
        sb.Append('}');
        return true;
    }

    static void TunerUitkAppendBox(StringBuilder sb, IResolvedStyle rs)
    {
        var bg = rs.backgroundColor;
        if (bg.a > 0.002f) sb.Append(",\"bg\":").Append(TunerUitkColor(bg));
        float bt = rs.borderTopWidth, br = rs.borderRightWidth, bb = rs.borderBottomWidth, bl = rs.borderLeftWidth;
        if (bt > 0f || br > 0f || bb > 0f || bl > 0f)
        {
            sb.Append(",\"bw\":[").Append(TunerUitkNum(bt)).Append(',').Append(TunerUitkNum(br)).Append(',')
                .Append(TunerUitkNum(bb)).Append(',').Append(TunerUitkNum(bl)).Append(']');
            Color ct = rs.borderTopColor, cr = rs.borderRightColor, cb = rs.borderBottomColor, cl = rs.borderLeftColor;
            if (ct == cr && ct == cb && ct == cl) sb.Append(",\"bc\":").Append(TunerUitkColor(ct));
            else
                sb.Append(",\"bc\":[").Append(TunerUitkColor(ct)).Append(',').Append(TunerUitkColor(cr)).Append(',')
                    .Append(TunerUitkColor(cb)).Append(',').Append(TunerUitkColor(cl)).Append(']');
        }
        float r0 = rs.borderTopLeftRadius, r1 = rs.borderTopRightRadius, r2 = rs.borderBottomRightRadius, r3 = rs.borderBottomLeftRadius;
        if (r0 > 0f || r1 > 0f || r2 > 0f || r3 > 0f)
        {
            if (r0 == r1 && r0 == r2 && r0 == r3) sb.Append(",\"rad\":").Append(TunerUitkNum(r0));
            else
                sb.Append(",\"rad\":[").Append(TunerUitkNum(r0)).Append(',').Append(TunerUitkNum(r1)).Append(',')
                    .Append(TunerUitkNum(r2)).Append(',').Append(TunerUitkNum(r3)).Append(']');
        }
    }

    static void TunerUitkAppendBackground(StringBuilder sb, VisualElement ve, IResolvedStyle rs, TunerUitkWalk walk, int own)
    {
        var bgi = rs.backgroundImage;
        var tex = TunerUitkPickTexture(bgi.texture, bgi.renderTexture, bgi.sprite, out var uv);
        if (ve is Image pic && (own & TUNER_UITK_OWN_PIC) != 0) TunerUitkAppendImage(sb, pic, walk);
        if (tex == null || (own & TUNER_UITK_OWN_IMG) == 0)
        {
            if (bgi.vectorImage != null && (own & TUNER_UITK_OWN_IMG) != 0) sb.Append(",\"vec\":1");
            return;
        }
        TunerUitkTexHeader(sb, "img", tex, uv, walk);
        var tint = rs.unityBackgroundImageTintColor;
        if (tint != Color.white) sb.Append(",\"tint\":").Append(TunerUitkColor(tint));
        int sl = rs.unitySliceLeft, st = rs.unitySliceTop, sr = rs.unitySliceRight, sbm = rs.unitySliceBottom;
        if (sl > 0 || st > 0 || sr > 0 || sbm > 0)
        {
            sb.Append(",\"slice\":[").Append(st.ToString(TunerUitkInv)).Append(',').Append(sr.ToString(TunerUitkInv)).Append(',')
                .Append(sbm.ToString(TunerUitkInv)).Append(',').Append(sl.ToString(TunerUitkInv)).Append(']');
            var scale = rs.unitySliceScale;
            if (Mathf.Abs(scale - 1f) > 0.001f && scale > 0f) sb.Append(",\"sscale\":").Append(TunerUitkNum(scale));
        }
        sb.Append(",\"size\":").Append(TunerUitkStr(TunerUitkBackgroundSize(rs.backgroundSize)));
        sb.Append(",\"pos\":").Append(TunerUitkStr(TunerUitkBackgroundPosition(rs.backgroundPositionX) + " " + TunerUitkBackgroundPosition(rs.backgroundPositionY)));
        sb.Append(",\"rep\":").Append(TunerUitkStr(TunerUitkRepeat(rs.backgroundRepeat.x) + " " + TunerUitkRepeat(rs.backgroundRepeat.y)));
        sb.Append('}');
    }

    static Texture TunerUitkPickTexture(Texture texture, RenderTexture renderTexture, Sprite sprite, out Rect uv)
    {
        uv = new Rect(0f, 0f, 1f, 1f);
        if (texture != null) return texture;
        if (renderTexture != null) return renderTexture;
        if (sprite == null || sprite.texture == null) return null;
        var tex = sprite.texture;
        var r = sprite.textureRect;
        uv = new Rect(r.x / tex.width, r.y / tex.height, r.width / tex.width, r.height / tex.height);
        return tex;
    }

    static void TunerUitkTexHeader(StringBuilder sb, string key, Texture tex, Rect uv, TunerUitkWalk walk)
    {
        var id = TunerUitkTextureKey(tex, uv);
        if (!walk.Known.Contains(id) && walk.Seen.Add(id))
            walk.NewTextures.Add(new KeyValuePair<string, TunerUitkTexRef>(id, new TunerUitkTexRef { Texture = tex, Uv = uv }));
        sb.Append(",\"").Append(key).Append("\":{\"id\":").Append(TunerUitkStr(id));
        sb.Append(",\"w\":").Append(TunerUitkNum(tex.width * uv.width));
        sb.Append(",\"h\":").Append(TunerUitkNum(tex.height * uv.height));
    }

    static void TunerUitkAppendImage(StringBuilder sb, Image image, TunerUitkWalk walk)
    {
        var tex = TunerUitkPickTexture(image.image, null, image.sprite, out var uv);
        if (tex == null)
        {
            if (image.vectorImage != null) sb.Append(",\"vec\":1");
            return;
        }
        var sub = image.uv;
        if (image.sprite == null && (sub.x != 0f || sub.y != 0f || sub.width != 1f || sub.height != 1f)) uv = sub;
        TunerUitkTexHeader(sb, "pic", tex, uv, walk);
        if (image.tintColor != Color.white) sb.Append(",\"tint\":").Append(TunerUitkColor(image.tintColor));
        var size = image.scaleMode == ScaleMode.StretchToFill ? "100% 100%" : image.scaleMode == ScaleMode.ScaleAndCrop ? "cover" : "contain";
        sb.Append(",\"size\":").Append(TunerUitkStr(size)).Append(",\"pos\":\"center center\",\"rep\":\"no-repeat no-repeat\"}");
    }

    static int TunerUitkOwnership(VisualElement ve, IResolvedStyle rs, int parentOwn, Color parentCol, bool scope)
    {
        var own = 0;
        var st = ve.style;
        if (st.backgroundColor.keyword != StyleKeyword.Null) own |= TUNER_UITK_OWN_BG;
        if (st.color.keyword != StyleKeyword.Null) own |= TUNER_UITK_OWN_COL;
        if (st.borderTopColor.keyword != StyleKeyword.Null || st.borderRightColor.keyword != StyleKeyword.Null
            || st.borderBottomColor.keyword != StyleKeyword.Null || st.borderLeftColor.keyword != StyleKeyword.Null) own |= TUNER_UITK_OWN_BORDER;
        if (st.backgroundImage.keyword != StyleKeyword.Null) own |= TUNER_UITK_OWN_IMG;
        if (st.unityBackgroundImageTintColor.keyword != StyleKeyword.Null) own |= TUNER_UITK_OWN_TINT;
        if (ve is Image && s_TunerUitkImageInline != null && s_TunerUitkImageInline.GetValue(ve) is bool inline && inline) own |= TUNER_UITK_OWN_PIC;
        own |= TunerUitkInlineRuleOwnership(ve);
        if (scope) own |= TunerUitkSheetOwnership(ve);
        if ((own & TUNER_UITK_OWN_COL) == 0 && (parentOwn & TUNER_UITK_OWN_COL) != 0 && rs.color == parentCol) own |= TUNER_UITK_OWN_COL;
        return own;
    }

    static int TunerUitkPropertyBit(string name)
    {
        switch (name)
        {
            case "background-color": return TUNER_UITK_OWN_BG;
            case "color": return TUNER_UITK_OWN_COL;
            case "border-color":
            case "border-top-color":
            case "border-right-color":
            case "border-bottom-color":
            case "border-left-color": return TUNER_UITK_OWN_BORDER;
            case "background-image": return TUNER_UITK_OWN_IMG;
            case "-unity-background-image-tint-color": return TUNER_UITK_OWN_TINT;
            case "--unity-image": return TUNER_UITK_OWN_PIC;
        }
        return 0;
    }

    static int TunerUitkRuleBits(object rule, bool custom, ref int cleared)
    {
        if (rule == null || s_TunerUitkRuleProps == null) return 0;
        var bits = 0;
        if (!(s_TunerUitkRuleProps.GetValue(rule) is Array props)) return 0;
        foreach (var prop in props)
        {
            if (prop == null) continue;
            var bit = TunerUitkPropertyBit(s_TunerUitkPropName.GetValue(prop) as string);
            if (bit == 0) continue;
            var themed = s_TunerUitkPropVar != null && s_TunerUitkPropVar.GetValue(prop) is bool v && v;
            if (custom && !themed)
            {
                bits |= bit;
                cleared &= ~bit;
            }
            else
            {
                bits &= ~bit;
                cleared |= bit;
            }
        }
        return bits;
    }

    static int TunerUitkInlineRuleOwnership(VisualElement ve)
    {
        if (s_TunerUitkInlineAccess == null || ve.visualTreeAssetSource == null) return 0;
        try
        {
            var access = s_TunerUitkInlineAccess.GetValue(ve);
            if (access == null) return 0;
            var inlineRule = s_TunerUitkInlineRule.GetValue(access);
            if (inlineRule == null) return 0;
            var rule = inlineRule.GetType().GetField("rule")?.GetValue(inlineRule);
            var cleared = 0;
            return TunerUitkRuleBits(rule, true, ref cleared);
        }
        catch
        {
            return 0;
        }
    }

    static int TunerUitkSheetOwnership(VisualElement ve)
    {
        if (s_TunerUitkExtractor == null) return 0;
        try
        {
            s_TunerUitkFindRules.Invoke(s_TunerUitkExtractor, new object[] { ve });
            if (!(s_TunerUitkRecords.GetValue(s_TunerUitkExtractor) is System.Collections.IList records)) return 0;
            var bits = 0;
            foreach (var rec in records)
            {
                var sheet = s_TunerUitkRecSheet.GetValue(rec) as StyleSheet;
                var selector = s_TunerUitkRecSelector.GetValue(rec);
                var rule = selector != null ? s_TunerUitkSelectorRule.GetValue(selector) : null;
                var cleared = 0;
                var set = TunerUitkRuleBits(rule, TunerUitkIsCustomSheet(sheet), ref cleared);
                bits = (bits & ~cleared) | set;
            }
            return bits;
        }
        catch (Exception e)
        {
            Debug.LogWarning("[tunerUitk] style provenance failed, custom USS colours fall back to the theme: " + e.Message);
            s_TunerUitkExtractor = null;
            return 0;
        }
    }

    static bool TunerUitkHasCustomSheet(VisualElement ve)
    {
        var sheets = ve.styleSheets;
        for (int i = 0; i < sheets.count; i++)
            if (TunerUitkIsCustomSheet(sheets[i])) return true;
        return false;
    }

    static bool TunerUitkIsCustomSheet(StyleSheet sheet)
    {
        if (sheet == null) return false;
        if (s_TunerUitkCustomSheets.TryGetValue(sheet, out var custom)) return custom;
        var path = AssetDatabase.GetAssetPath(sheet) ?? "";
        custom = path.StartsWith("Assets/", StringComparison.Ordinal) || path.StartsWith("Packages/", StringComparison.Ordinal);
        s_TunerUitkCustomSheets[sheet] = custom;
        return custom;
    }

    static string TunerUitkBackgroundSize(BackgroundSize s)
    {
        switch (s.sizeType)
        {
            case BackgroundSizeType.Cover: return "cover";
            case BackgroundSizeType.Contain: return "contain";
        }
        return TunerUitkLength(s.x) + " " + TunerUitkLength(s.y);
    }

    static string TunerUitkLength(Length l)
    {
        if (l.IsAuto() || l.IsNone()) return "auto";
        return l.unit == LengthUnit.Percent ? TunerUitkNum(l.value) + "%" : TunerUitkNum(l.value) + "px";
    }

    static string TunerUitkBackgroundPosition(BackgroundPosition p)
    {
        var off = TunerUitkLength(p.offset);
        if (off == "auto") off = "0px";
        switch (p.keyword)
        {
            case BackgroundPositionKeyword.Center: return "center";
            case BackgroundPositionKeyword.Top: return "top " + off;
            case BackgroundPositionKeyword.Bottom: return "bottom " + off;
            case BackgroundPositionKeyword.Left: return "left " + off;
            case BackgroundPositionKeyword.Right: return "right " + off;
        }
        return "center";
    }

    static string TunerUitkRepeat(Repeat r)
    {
        switch (r)
        {
            case Repeat.Repeat: return "repeat";
            case Repeat.Space: return "space";
            case Repeat.Round: return "round";
        }
        return "no-repeat";
    }

    static void TunerUitkAppendText(StringBuilder sb, VisualElement ve, TextElement te, IResolvedStyle rs)
    {
        var text = te.text;
        if (string.IsNullOrEmpty(text)) return;
        var owner = TunerUitkTextOwner(ve);
        if (owner != null && TunerUitkIsPassword(owner)) text = new string(TunerUitkMaskChar(owner), text.Length);
        sb.Append(",\"tx\":").Append(TunerUitkStr(text));
        sb.Append(",\"col\":").Append(TunerUitkColor(rs.color));
        sb.Append(",\"fs\":").Append(TunerUitkNum(rs.fontSize));
        var fst = rs.unityFontStyleAndWeight;
        if (fst != FontStyle.Normal) sb.Append(",\"fst\":").Append(((int)fst).ToString(TunerUitkInv));
        sb.Append(",\"ta\":").Append(((int)rs.unityTextAlign).ToString(TunerUitkInv));
        if (rs.whiteSpace != WhiteSpace.Normal) sb.Append(",\"ws\":").Append(((int)rs.whiteSpace).ToString(TunerUitkInv));
        if (rs.textOverflow == TextOverflow.Ellipsis) sb.Append(",\"ell\":1");
        if (Mathf.Abs(rs.letterSpacing) > 0.01f) sb.Append(",\"ls\":").Append(TunerUitkNum(rs.letterSpacing));
        float pt = rs.paddingTop, pr = rs.paddingRight, pb = rs.paddingBottom, pl = rs.paddingLeft;
        if (pt != 0f || pr != 0f || pb != 0f || pl != 0f)
            sb.Append(",\"pad\":[").Append(TunerUitkNum(pt)).Append(',').Append(TunerUitkNum(pr)).Append(',')
                .Append(TunerUitkNum(pb)).Append(',').Append(TunerUitkNum(pl)).Append(']');
        if (te.enableRichText && text.IndexOf('<') >= 0) sb.Append(",\"rich\":1");
    }

    static VisualElement TunerUitkTextOwner(VisualElement ve)
    {
        for (var e = ve.hierarchy.parent; e != null; e = e.hierarchy.parent)
        {
            if (TunerUitkGenericBase(e.GetType(), typeof(TextInputBaseField<>)) != null) return e;
            if (e is BaseField<string> || e.ClassListContains("unity-base-field")) return null;
        }
        return null;
    }

    static bool TunerUitkIsPassword(VisualElement field)
    {
        var p = field.GetType().GetProperty("isPasswordField", BindingFlags.Instance | BindingFlags.Public);
        return p != null && p.GetValue(field) is bool b && b;
    }

    static char TunerUitkMaskChar(VisualElement field)
    {
        var p = field.GetType().GetProperty("maskChar", BindingFlags.Instance | BindingFlags.Public);
        return p != null && p.GetValue(field) is char c ? c : '*';
    }

    static void TunerUitkAppendField(StringBuilder sb, VisualElement ve, Type type)
    {
        var info = TunerUitkFieldInfoFor(type);
        if (info == null)
        {
            if (ve is Foldout fold) sb.Append(",\"v\":").Append(fold.value ? "true" : "false");
            return;
        }
        if (info.Label != null && info.Label.GetValue(ve) is string label && label.Length > 0) sb.Append(",\"lb\":").Append(TunerUitkStr(label));
        if (info.Value != null)
        {
            object v;
            try { v = info.Value.GetValue(ve); }
            catch { v = null; }
            var json = TunerUitkValueJson(v);
            if (json != null) sb.Append(",\"v\":").Append(json);
        }
        if (info.StringToValue != null)
        {
            var input = ve.Q(className: "unity-text-input") ?? ve.Q(className: "unity-base-text-field__input");
            if (input != null) sb.Append(",\"inp\":").Append(TunerUitkIdOf(input).ToString(TunerUitkInv));
            var ml = type.GetProperty("multiline", BindingFlags.Instance | BindingFlags.Public);
            if (ml != null && ml.GetValue(ve) is bool m && m) sb.Append(",\"ml\":1");
            var ro = type.GetProperty("isReadOnly", BindingFlags.Instance | BindingFlags.Public);
            if (ro != null && ro.GetValue(ve) is bool r && r) sb.Append(",\"ro\":1");
            if (TunerUitkIsPassword(ve)) sb.Append(",\"pw\":1");
            var text = type.GetProperty("text", BindingFlags.Instance | BindingFlags.Public);
            if (text != null && text.GetValue(ve) is string s) sb.Append(",\"txt\":").Append(TunerUitkStr(TunerUitkIsPassword(ve) ? "" : s));
        }
    }

    static void TunerUitkAppendSpecial(StringBuilder sb, VisualElement ve, TunerUitkWalk walk)
    {
        if (ve is ScrollView sv)
        {
            var vs = sv.verticalScroller;
            var hs = sv.horizontalScroller;
            var maxY = vs != null ? Mathf.Max(0f, vs.highValue) : 0f;
            var maxX = hs != null ? Mathf.Max(0f, hs.highValue) : 0f;
            sb.Append(",\"sc\":[").Append(TunerUitkNum(sv.scrollOffset.x)).Append(',').Append(TunerUitkNum(sv.scrollOffset.y)).Append(',')
                .Append(TunerUitkNum(maxX)).Append(',').Append(TunerUitkNum(maxY)).Append(']');
        }
        else if (ve.ClassListContains("unity-curve-field__input") && ve.hierarchy.parent is CurveField cf) TunerUitkAppendCurve(sb, cf);
        else if (ve is BaseListView lv)
        {
            var n = lv.itemsSource != null ? lv.itemsSource.Count : 0;
            sb.Append(",\"items\":").Append(n.ToString(TunerUitkInv));
        }
    }

    static void TunerUitkAppendCurve(StringBuilder sb, CurveField cf)
    {
        var curve = cf.value;
        if (curve == null || curve.length == 0) return;
        var ranges = cf.ranges;
        float t0, t1, v0, v1;
        if (ranges.width > 0f && ranges.height > 0f)
        {
            t0 = ranges.xMin; t1 = ranges.xMax; v0 = ranges.yMin; v1 = ranges.yMax;
        }
        else
        {
            t0 = curve.keys[0].time;
            t1 = curve.keys[curve.length - 1].time;
            v0 = float.MaxValue; v1 = float.MinValue;
            for (int i = 0; i <= 64; i++)
            {
                var v = curve.Evaluate(Mathf.Lerp(t0, t1, i / 64f));
                v0 = Mathf.Min(v0, v); v1 = Mathf.Max(v1, v);
            }
        }
        if (Mathf.Approximately(t0, t1)) t1 = t0 + 1f;
        if (Mathf.Approximately(v0, v1)) { v0 -= 0.5f; v1 += 0.5f; }
        var col = cf.resolvedStyle.color;
        var custom = typeof(CurveField).GetField("m_CurveColor", BindingFlags.Instance | BindingFlags.NonPublic);
        if (custom != null && custom.GetValue(cf) is Color cc && cc.a > 0f) col = cc;
        sb.Append(",\"cv\":{\"col\":").Append(TunerUitkColor(col)).Append(",\"p\":[");
        for (int i = 0; i <= 64; i++)
        {
            var t = Mathf.Lerp(t0, t1, i / 64f);
            var y = 1f - Mathf.Clamp01((curve.Evaluate(t) - v0) / (v1 - v0));
            if (i > 0) sb.Append(',');
            sb.Append(TunerUitkNum(i / 64f)).Append(',').Append(TunerUitkNum(y));
        }
        sb.Append("]}");
    }

    static TunerUitkFieldInfo TunerUitkFieldInfoFor(Type type)
    {
        if (s_TunerUitkFields.TryGetValue(type, out var info)) return info;
        var baseField = TunerUitkGenericBase(type, typeof(BaseField<>));
        if (baseField != null)
        {
            info = new TunerUitkFieldInfo
            {
                Value = baseField.GetProperty("value", BindingFlags.Instance | BindingFlags.Public),
                Label = baseField.GetProperty("label", BindingFlags.Instance | BindingFlags.Public)
            };
            if (TunerUitkGenericBase(type, typeof(TextInputBaseField<>)) != null)
                info.StringToValue = type.GetMethod("StringToValue", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public, null, new[] { typeof(string) }, null);
        }
        s_TunerUitkFields[type] = info;
        return info;
    }

    static Type TunerUitkGenericBase(Type type, Type generic)
    {
        for (var t = type; t != null && t != typeof(object); t = t.BaseType)
            if (t.IsGenericType && t.GetGenericTypeDefinition() == generic) return t;
        return null;
    }

    static string TunerUitkValueJson(object v)
    {
        switch (v)
        {
            case null: return null;
            case bool b: return b ? "true" : "false";
            case string s: return TunerUitkStr(s);
            case int i: return i.ToString(TunerUitkInv);
            case uint ui: return ui.ToString(TunerUitkInv);
            case long l: return TunerUitkStr(l.ToString(TunerUitkInv));
            case ulong ul: return TunerUitkStr(ul.ToString(TunerUitkInv));
            case float f: return float.IsNaN(f) || float.IsInfinity(f) ? TunerUitkStr(f.ToString(TunerUitkInv)) : f.ToString("R", TunerUitkInv);
            case double d: return double.IsNaN(d) || double.IsInfinity(d) ? TunerUitkStr(d.ToString(TunerUitkInv)) : d.ToString("R", TunerUitkInv);
            case Enum e: return TunerUitkStr(e.ToString());
            case Color c: return TunerUitkColor(c);
            case Vector2 v2: return "[" + TunerUitkNum(v2.x) + "," + TunerUitkNum(v2.y) + "]";
            case Vector3 v3: return "[" + TunerUitkNum(v3.x) + "," + TunerUitkNum(v3.y) + "," + TunerUitkNum(v3.z) + "]";
            case Vector4 v4: return "[" + TunerUitkNum(v4.x) + "," + TunerUitkNum(v4.y) + "," + TunerUitkNum(v4.z) + "," + TunerUitkNum(v4.w) + "]";
            case Vector2Int vi2: return "[" + vi2.x + "," + vi2.y + "]";
            case Vector3Int vi3: return "[" + vi3.x + "," + vi3.y + "," + vi3.z + "]";
            case Rect r: return "[" + TunerUitkNum(r.x) + "," + TunerUitkNum(r.y) + "," + TunerUitkNum(r.width) + "," + TunerUitkNum(r.height) + "]";
            case RectInt ri: return "[" + ri.x + "," + ri.y + "," + ri.width + "," + ri.height + "]";
            case Bounds bd: return "[" + TunerUitkNum(bd.center.x) + "," + TunerUitkNum(bd.center.y) + "," + TunerUitkNum(bd.center.z) + "," + TunerUitkNum(bd.extents.x) + "," + TunerUitkNum(bd.extents.y) + "," + TunerUitkNum(bd.extents.z) + "]";
            case BoundsInt bi: return "[" + bi.position.x + "," + bi.position.y + "," + bi.position.z + "," + bi.size.x + "," + bi.size.y + "," + bi.size.z + "]";
            case UnityEngine.Object o: return o != null ? TunerUitkStr(o.name) : null;
        }
        return null;
    }

    static void TunerUitkInit()
    {
        if (s_TunerUitkReady) return;
        if (s_TunerUitkError != null) throw new InvalidOperationException("UI Toolkit capture is unavailable in this Unity version: " + s_TunerUitkError);
        try
        {
            const BindingFlags inst = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            s_TunerUitkPseudo = typeof(VisualElement).GetProperty("pseudoStates", inst) ?? throw new MissingMemberException("VisualElement.pseudoStates");
            s_TunerUitkShouldClip = typeof(VisualElement).GetMethod("ShouldClip", inst, null, Type.EmptyTypes, null);
            var panelType = TunerUitkType("UnityEngine.UIElements.BaseVisualElementPanel");
            s_TunerUitkMenuFunctor = panelType.GetField("CreateMenuFunctor", inst);
            s_TunerUitkMenuManager = panelType.GetProperty("contextualMenuManager", inst);
            TunerUitkInitProvenance();
            s_TunerUitkReady = true;
        }
        catch (Exception e)
        {
            s_TunerUitkError = e.GetType().Name + ": " + e.Message;
            Debug.LogWarning("[tunerUitk] reflection failed: " + s_TunerUitkError);
            throw new InvalidOperationException("UI Toolkit capture is unavailable in this Unity version: " + s_TunerUitkError);
        }
    }

    static void TunerUitkInitProvenance()
    {
        const BindingFlags inst = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        try
        {
            s_TunerUitkImageInline = typeof(Image).GetField("m_ImageIsInline", inst);
            s_TunerUitkInlineAccess = typeof(VisualElement).GetField("inlineStyleAccess", inst);
            s_TunerUitkInlineRule = s_TunerUitkInlineAccess?.FieldType.GetProperty("inlineRule", inst);
            var ruleType = TunerUitkType("UnityEngine.UIElements.StyleRule");
            var propType = TunerUitkType("UnityEngine.UIElements.StyleProperty");
            s_TunerUitkRuleProps = ruleType.GetProperty("properties", inst);
            s_TunerUitkPropName = propType.GetProperty("name", inst);
            s_TunerUitkPropVar = propType.GetField("requireVariableResolve", inst);
            var extractorType = TunerUitkType("UnityEngine.UIElements.MatchedRulesExtractor");
            var recordType = TunerUitkType("UnityEngine.UIElements.StyleSheets.SelectorMatchRecord");
            s_TunerUitkRecSheet = recordType.GetField("sheet", inst);
            s_TunerUitkRecSelector = recordType.GetField("complexSelector", inst);
            s_TunerUitkSelectorRule = TunerUitkType("UnityEngine.UIElements.StyleComplexSelector").GetProperty("rule", inst);
            s_TunerUitkFindRules = extractorType.GetMethod("FindMatchingRules", inst, null, new[] { typeof(VisualElement) }, null);
            s_TunerUitkRecords = extractorType.GetField("matchRecords", inst);
            var ctor = extractorType.GetConstructor(inst, null, new[] { typeof(Func<StyleSheet, string>) }, null);
            if (s_TunerUitkFindRules != null && s_TunerUitkRecords != null && ctor != null && s_TunerUitkRuleProps != null && s_TunerUitkPropName != null)
                s_TunerUitkExtractor = ctor.Invoke(new object[] { (Func<StyleSheet, string>)(sh => sh != null ? AssetDatabase.GetAssetPath(sh) : "") });
        }
        catch (Exception e)
        {
            s_TunerUitkExtractor = null;
            Debug.LogWarning("[tunerUitk] custom USS detection is off: " + e.Message);
        }
    }

    static Type TunerUitkType(string fullName)
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            var t = asm.GetType(fullName, false);
            if (t != null) return t;
        }
        throw new TypeLoadException(fullName);
    }

    static int TunerUitkPseudoStates(VisualElement ve)
    {
        try { return Convert.ToInt32(s_TunerUitkPseudo.GetValue(ve)); }
        catch { return 0; }
    }

    static bool TunerUitkClips(VisualElement ve)
    {
        if (s_TunerUitkShouldClip == null) return false;
        try { return (bool)s_TunerUitkShouldClip.Invoke(ve, null); }
        catch { return false; }
    }

    internal static void TunerUitkTick(IPanel panel)
    {
        var calls = TunerUitkPanelCalls(panel.GetType());
        for (int round = 0; round < 2; round++)
        {
            try
            {
                var scheduler = calls[0] != null ? calls[0].Invoke(panel, null) : null;
                if (scheduler != null) scheduler.GetType().GetMethod("UpdateScheduledEvents", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null)?.Invoke(scheduler, null);
            }
            catch (TargetInvocationException e)
            {
                Debug.LogException(e.InnerException ?? e);
            }
            for (int i = 1; i < 5; i++)
            {
                if (calls[i] == null) continue;
                try { calls[i].Invoke(panel, null); }
                catch (TargetInvocationException e) { Debug.LogException(e.InnerException ?? e); }
            }
            TunerUitkLayout(panel, calls[5]);
        }
    }

    static void TunerUitkLayout(IPanel panel, MethodInfo validate)
    {
        if (validate == null) return;
        var prev = Event.current;
        Event.current = new Event { type = EventType.Layout };
        try { validate.Invoke(panel, null); }
        catch (TargetInvocationException e) { Debug.LogException(e.InnerException ?? e); }
        finally { Event.current = prev; }
    }

    static MethodInfo[] TunerUitkPanelCalls(Type panelType)
    {
        if (s_TunerUitkPanelCalls.TryGetValue(panelType, out var calls)) return calls;
        const BindingFlags inst = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
        MethodInfo Find(string name)
        {
            for (var t = panelType; t != null; t = t.BaseType)
            {
                var m = t.GetMethod(name, inst | BindingFlags.DeclaredOnly, null, Type.EmptyTypes, null);
                if (m != null) return m;
            }
            return null;
        }
        MethodInfo Getter(params string[] names)
        {
            foreach (var n in names)
            {
                for (var t = panelType; t != null; t = t.BaseType)
                {
                    var p = t.GetProperty(n, inst | BindingFlags.DeclaredOnly);
                    if (p != null && p.PropertyType.Name == "TimerEventScheduler") return p.GetGetMethod(true);
                }
            }
            return null;
        }
        calls = new[]
        {
            Getter("timerEventScheduler", "scheduler"),
            Find("ValidateFocus"),
            Find("UpdateDataBinding"),
            Find("UpdateAnimations"),
            Find("UpdateBindings"),
            Find("ValidateLayout")
        };
        s_TunerUitkPanelCalls[panelType] = calls;
        return calls;
    }

    static string TunerUitkTextureKey(Texture tex, Rect uv)
    {
        var key = "t" + tex.GetHashCode().ToString(TunerUitkInv) + "_" + tex.updateCount.ToString(TunerUitkInv);
        if (uv.x != 0f || uv.y != 0f || uv.width != 1f || uv.height != 1f)
            key += "_" + Mathf.RoundToInt(uv.x * 10000f) + "_" + Mathf.RoundToInt(uv.y * 10000f) + "_" + Mathf.RoundToInt(uv.width * 10000f) + "_" + Mathf.RoundToInt(uv.height * 10000f);
        return key;
    }

    static byte[] TunerUitkExportTexture(Texture tex, Rect uv, out int w, out int h)
    {
        w = Mathf.Max(1, Mathf.RoundToInt(tex.width * uv.width));
        h = Mathf.Max(1, Mathf.RoundToInt(tex.height * uv.height));
        var scale = Mathf.Min(1f, TUNER_UITK_MAX_TEX / (float)Mathf.Max(w, h));
        w = Mathf.Max(1, Mathf.RoundToInt(w * scale));
        h = Mathf.Max(1, Mathf.RoundToInt(h * scale));
        if (tex is Texture2D t2 && t2.isReadable && uv == new Rect(0f, 0f, 1f, 1f) && scale >= 1f)
        {
            try { return t2.EncodeToPNG(); }
            catch { }
        }
        var prev = RenderTexture.active;
        var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        Texture2D copy = null;
        try
        {
            Graphics.Blit(tex, rt, new Vector2(uv.width, uv.height), new Vector2(uv.x, uv.y));
            RenderTexture.active = rt;
            copy = new Texture2D(w, h, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
            copy.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            copy.Apply();
            return copy.EncodeToPNG();
        }
        catch (Exception e)
        {
            Debug.LogWarning("[tunerUitk] could not export texture '" + tex.name + "': " + e.Message);
            return null;
        }
        finally
        {
            RenderTexture.active = prev;
            RenderTexture.ReleaseTemporary(rt);
            if (copy != null) UnityEngine.Object.DestroyImmediate(copy);
        }
    }

    static string TunerUitkTypeName(Type t)
    {
        var n = t.Name;
        var tick = n.IndexOf('`');
        return tick >= 0 ? n.Substring(0, tick) : n;
    }

    static string TunerUitkNum(float f)
    {
        if (float.IsNaN(f) || float.IsInfinity(f)) return "0";
        return f.ToString("0.##", TunerUitkInv);
    }

    static string TunerUitkColor(Color c)
    {
        var c32 = (Color32)c;
        return "\"#" + c32.r.ToString("x2") + c32.g.ToString("x2") + c32.b.ToString("x2") + c32.a.ToString("x2") + "\"";
    }

    static void TunerUitkRect(StringBuilder sb, Rect r)
    {
        sb.Append("{\"x\":").Append(TunerUitkNum(r.x)).Append(",\"y\":").Append(TunerUitkNum(r.y))
            .Append(",\"w\":").Append(TunerUitkNum(r.width)).Append(",\"h\":").Append(TunerUitkNum(r.height)).Append('}');
    }

    static string TunerUitkStr(string s)
    {
        if (s == null) return "null";
        var sb = new StringBuilder(s.Length + 2);
        sb.Append('"');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20 || ch == (char)0x2028 || ch == (char)0x2029) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
        return sb.ToString();
    }
}
