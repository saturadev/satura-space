using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    const int TI_FLAG_ON = 1;
    const int TI_FLAG_HOVER = 2;
    const int TI_FLAG_ACTIVE = 4;
    const int TI_FLAG_FOCUS = 8;
    const int TI_FLAG_OFF = 16;
    const int TI_FLAG_TEXT = 32;
    const int TI_FLAG_CHROME = 64;
    const int TI_MAX_TEXTURE_SIDE = 1024;

    class TiDrawRec
    {
        public char K;
        public int C;
        public Rect R;
        public int Style;
        public string Text;
        public string Tip;
        public int Img = -1;
        public int Id;
        public int Flags;
        public Color Bg = Color.white;
        public Color Fg = Color.white;
        public int Clip = -1;
        public Vector2 Sel0;
        public Vector2 Sel1;
        public int Tex = -1;
        public Rect Uv;
        public bool HasUv;
        public int ScaleMode;
        public float Aspect;
        public Vector4 Bw;
        public Vector4 Br;
        public Vector4 Slice;
        public bool HasSlice;
        public float[] Pts;
        public float[] Pts2;
        public Color Fill;
        public Color Fill2;
        public float Width = 1f;
        public char Mode;
        public bool Dotted;
        public bool HasMx;
        public float M00, M01, M10, M11, Tx, Ty;
        public string Role;
    }

    class TiPropRec
    {
        public int C;
        public string Path;
        public string Kind;
        public string Label;
        public bool Named;
        public string Value;
        public Rect R;
    }

    class TiCursorRec
    {
        public int C;
        public Rect R;
        public string Cursor;
    }

    class TiFocusRec
    {
        public TiSection Section;
        public IMGUIContainer Container;
        public int C;
        public int Control;
        public Rect R;
        public string Text;
        public int Style;
        public bool Numeric;
        public bool Multiline;
        public bool Password;
        public bool Delayed;
    }

    class TiClipRec
    {
        public int C;
        public Rect R;
    }

    class TiScrollRec
    {
        public int C;
        public Rect R;
        public Vector2 View;
        public Vector2 Visible;
        public Vector2 Scroll;
    }

    class TiPendingTexture
    {
        public int Id;
        public Texture Tex;
        public Texture2D Copy;
    }

    static TiSession s_TiDispatch;
    static TiSection s_TiDispatchSection;
    static IMGUIContainer s_TiDispatchContainer;
    static int s_TiDispatchIndex;
    static bool s_TiRecording;
    static bool s_TiMouseActive;
    static Vector2 s_TiMouseWorld;
    static RenderTexture s_TiSink;
    static readonly List<TiPendingTexture> s_TiPendingTextures = new List<TiPendingTexture>();
    static readonly Dictionary<TiSection, List<TiClipRec>> s_TiClipRecs = new Dictionary<TiSection, List<TiClipRec>>();
    static readonly Vector2 TiMouseAway = new Vector2(-100000f, -100000f);
    static PropertyInfo s_TiPixelsPerPoint;
    static bool s_TiPixelsPerPointLooked;
    static bool s_TiLoggedSpace;

    static void TiCapture(TiSession s)
    {
        var sw = Stopwatch.StartNew();
        long tp = TpNow();
        s.RepaintAgain = false;
        TiLayout(s);
        TpAdd(TP_TI_LAYOUT, tp);
        tp = TpNow();
        foreach (var sec in s.Sections)
            if (!sec.Uitk) sec.UitkJson = null;
        if (s_TiSink == null)
            s_TiSink = new RenderTexture(8, 8, 0) { name = "_SaturaTunerInspectorSink", hideFlags = HideFlags.HideAndDontSave };
        var prevDraw = (Delegate)s_TiOnDrawField.GetValue(null);
        var prevActive = RenderTexture.active;
        bool anyUitk = false;
        foreach (var sec in s.Sections) anyUitk |= sec.Uitk && sec.Body != null;
        if (anyUitk)
        {
            TunerUitkTick(s.Panel);
            if (TunerFilterHideUitk(s)) TunerUitkTick(s.Panel);
            foreach (var sec in s.Sections)
            {
                if (!sec.Uitk || sec.Body == null || sec.Body.panel == null) continue;
                try
                {
                    var r = TunerUitkCapture(sec.Body, s.UitkTextures, false);
                    sec.UitkJson = r.Json;
                    sec.UitkImgui = r.Imgui;
                }
                catch (Exception e)
                {
                    if (s.LoggedErrors.Add("uitk:" + sec.Key + ":" + e.Message)) Debug.LogException(e);
                    sec.UitkJson = null;
                    sec.UitkImgui = null;
                }
            }
        }
        TpAdd(TP_TI_UITK, tp);
        tp = TpNow();
        bool partial = TiPartialPaint(s);
        foreach (var sec in s.Sections) sec.Painted = !partial || sec.Uitk || sec.ConstantRepaint || TiSectionChanged(s, sec);
        var painted = new List<Rect>();
        for (int pass = 0; pass < TI_PAINT_PASSES; pass++)
        {
            TiPaint(s, prevDraw, prevActive, painted);
            TiLayout(s);
            if (!TiMovedSincePaint(s, painted)) break;
        }
        TiFlushTextures(s);
        TiToSectionSpace(s);
        TpAdd(TP_TI_PAINT, tp);
        s.LastMs = sw.Elapsed.TotalMilliseconds;
    }

    const int TI_PAINT_PASSES = 3;

    static void TiPaint(TiSession s, Delegate prevDraw, RenderTexture prevActive, List<Rect> painted)
    {
        foreach (var sec in s.Sections)
        {
            if (!sec.Painted) continue;
            sec.Draws.Clear();
            sec.Props.Clear();
            sec.Cursors.Clear();
            sec.Clips.Clear();
            sec.Scrolls.Clear();
            sec.Containers.Clear();
            sec.PscJson = null;
        }
        s_TiClipRecs.Clear();
        s_TiMatPaths.Clear();
        s_TiListMarks.Clear();
        s.PassStyles.Clear();
        s.Focus = null;
        s.Constant = false;
        painted.Clear();
        s_TiRecording = true;
        s_TiOnDrawField.SetValue(null, s_TiDrawHook);
        RenderTexture.active = s_TiSink;
        try
        {
            using (new EditorGUIUtility.PropertyCallbackScope(TiRecordProperty))
            {
                foreach (var sec in s.Sections)
                {
                    if (!sec.Painted)
                    {
                        if (sec.ConstantRepaint) s.Constant = true;
                        foreach (var c in sec.Containers) painted.Add(c.worldBound);
                        continue;
                    }
                    sec.ConstantRepaint = false;
                    if (sec.Editor != null)
                    {
                        try { if (sec.Editor.RequiresConstantRepaint()) sec.ConstantRepaint = s.Constant = true; }
                        catch { }
                    }
                    if (sec.Uitk)
                    {
                        if (sec.Header != null) sec.Containers.Add(sec.Header);
                        if (sec.UitkImgui != null)
                            foreach (var c in sec.UitkImgui)
                                if (c != null) sec.Containers.Add(c);
                    }
                    else
                    {
                        sec.Element.Query<IMGUIContainer>().ForEach(c =>
                        {
                            if (TiDisplayed(c, sec.Element)) sec.Containers.Add(c);
                        });
                    }
                    for (int i = 0; i < sec.Containers.Count; i++)
                    {
                        var c = sec.Containers[i];
                        var mouse = s.Hover ?? TiMouseAway;
                        painted.Add(c.worldBound);
                        TiSend(s, sec, c, i, new Event { type = EventType.Repaint, mousePosition = mouse - c.worldBound.position, modifiers = s.HoverMods }, mouse);
                    }
                }
            }
        }
        finally
        {
            RenderTexture.active = prevActive;
            if (ReferenceEquals(s_TiOnDrawField.GetValue(null), s_TiDrawHook)) s_TiOnDrawField.SetValue(null, prevDraw);
            s_TiRecording = false;
        }
    }

    static bool TiMovedSincePaint(TiSession s, List<Rect> painted)
    {
        int k = 0;
        foreach (var sec in s.Sections)
        {
            if (!sec.Uitk)
            {
                int shown = 0;
                sec.Element.Query<IMGUIContainer>().ForEach(c =>
                {
                    if (TiDisplayed(c, sec.Element)) shown++;
                });
                if (shown != sec.Containers.Count) return true;
            }
            foreach (var c in sec.Containers)
            {
                if (k >= painted.Count) return true;
                var was = painted[k++];
                var now = c.worldBound;
                if (Mathf.Abs(was.y - now.y) > 0.5f || Mathf.Abs(was.height - now.height) > 0.5f || Mathf.Abs(was.width - now.width) > 0.5f || Mathf.Abs(was.x - now.x) > 0.5f) return true;
            }
        }
        return false;
    }

    static bool TiDisplayed(VisualElement c, VisualElement stop)
    {
        for (var e = c; e != null; e = e.hierarchy.parent)
        {
            if (e.resolvedStyle.display == DisplayStyle.None) return false;
            if (e == stop) break;
        }
        return c.layout.width > 0f;
    }

    static void TiLayout(TiSession s)
    {
        var tree = s.Panel.visualTree;
        tree.style.width = s.Width;
        tree.style.height = TI_MAX_HEIGHT;
        s.Root.style.width = s.Width;
        foreach (var sec in s.Sections) TiApplyExpanded(sec);
        var prev = Event.current;
        Event.current = new Event { type = EventType.Layout };
        try
        {
            TiInvokeMember(s.Panel, "ValidateLayout");
            if (TunerPopupFitUitk(s)) TiInvokeMember(s.Panel, "ValidateLayout");
            s.Height = Mathf.Clamp(Mathf.CeilToInt(s.Root.layout.height), 1, TI_MAX_HEIGHT);
        }
        finally
        {
            Event.current = prev;
        }
    }

    static void TiToSectionSpace(TiSession s)
    {
        foreach (var sec in s.Sections)
        {
            sec.Bounds = sec.Element.worldBound;
            if (!sec.Painted) continue;
            var origin = sec.Bounds.position;
            var offsets = new Vector2[sec.Containers.Count];
            for (int i = 0; i < sec.Containers.Count; i++) offsets[i] = sec.Uitk && i > 0 ? Vector2.zero : sec.Containers[i].worldBound.position - origin;
            if (!s_TiLoggedSpace && sec.Draws.Count > 0 && sec.Containers.Count > 0)
            {
                s_TiLoggedSpace = true;
                SaturaDebug.Log("[tunerInspector] first draw '" + TiStyleName(s, sec.Draws[0].Style) + "' at " + sec.Draws[0].R + " container worldBound=" + sec.Containers[sec.Draws[0].C].worldBound + " section=" + sec.Bounds);
            }
            foreach (var d in sec.Draws)
            {
                d.R.position += offsets[d.C];
                TunerRectShiftMatrix(d, offsets[d.C]);
            }
            foreach (var p in sec.Props) p.R.position += offsets[p.C];
            if (sec.PscJson != null && sec.PscC >= 0 && sec.PscC < offsets.Length) sec.PscRect.position += offsets[sec.PscC];
            foreach (var c in sec.Cursors) c.R.position += offsets[c.C];
            foreach (var sc in sec.Scrolls) sc.R.position += offsets[sc.C];
            List<TiClipRec> clips;
            if (s_TiClipRecs.TryGetValue(sec, out clips))
                foreach (var c in clips)
                {
                    var r = c.R;
                    r.position += offsets[c.C];
                    sec.Clips.Add(r);
                }
            if (s.Focus != null && s.Focus.Section == sec)
            {
                if (sec.Uitk && s.Focus.C > 0 && s.Focus.C < sec.Containers.Count) s.Focus.R.position += sec.Containers[s.Focus.C].worldBound.position - origin;
                else s.Focus.R.position += offsets[s.Focus.C];
            }
        }
    }

    static string TiStyleName(TiSession s, int id)
    {
        foreach (var kv in s.StyleIds)
            if (kv.Value == id)
            {
                var i = kv.Key.IndexOf("\"n\":", StringComparison.Ordinal);
                return i >= 0 ? kv.Key.Substring(i + 4, Math.Min(40, kv.Key.Length - i - 4)) : "?";
            }
        return "?";
    }

    static bool TiOnDraw(GUIStyle style, Rect rect, GUIContent content, int controlId, bool isHover, bool isActive, bool on, bool hasKeyboardFocus, bool hasTextInput, Vector2 cursorFirst, Vector2 cursorLast)
    {
        if (!s_TiRecording) return false;
        if (TiOffscreenTarget()) return false;
        var s = s_TiDispatch;
        var sec = s_TiDispatchSection;
        if (s == null || sec == null) return true;
        var d = new TiDrawRec { K = 's', C = s_TiDispatchIndex };
        var identity = new TunerRectIdentity(d);
        try
        {
            d.R = s_TiUnclipRect(rect);
            d.Style = TiStyleId(s, style);
            if (content != null)
            {
                d.Text = content.text;
                d.Tip = content.tooltip;
                if (content.image != null) d.Img = TiTextureId(s, content.image);
            }
            d.Id = controlId > 0 ? controlId : 0;
            if (on) d.Flags |= TI_FLAG_ON;
            if (isHover) d.Flags |= TI_FLAG_HOVER;
            if (isActive) d.Flags |= TI_FLAG_ACTIVE;
            if (hasKeyboardFocus) d.Flags |= TI_FLAG_FOCUS;
            if (!GUI.enabled) d.Flags |= TI_FLAG_OFF;
            if (hasTextInput)
            {
                d.Flags |= TI_FLAG_TEXT;
                d.Sel0 = s_TiUnclipVec(cursorFirst);
                d.Sel1 = s_TiUnclipVec(cursorLast);
            }
            var color = GUI.color;
            d.Bg = color * GUI.backgroundColor;
            d.Fg = color * GUI.contentColor;
            d.Clip = TiClip(sec, TunerRectBounds(d));
            d.Role = TunerRectRole(sec, d.Bg, style, false);
            sec.Draws.Add(d);
        }
        catch (Exception e)
        {
            if (s.LoggedErrors.Add("draw:" + e.Message)) Debug.LogWarning("[tunerInspector] draw record failed: " + e);
        }
        finally
        {
            identity.Dispose();
        }
        return true;
    }

    static bool TiOffscreenTarget()
    {
        var target = RenderTexture.active;
        return target != null && target != s_TiSink;
    }

    static bool TiRecordTexture(Rect position, Texture image, ScaleMode scaleMode, float aspect, Color color, Vector4 borderWidths, Vector4 borderRadii, Rect? uv, Vector4 slice, bool hasSlice)
    {
        if (!s_TiRecording) return s_TiDispatch != null;
        if (TiOffscreenTarget()) return false;
        var s = s_TiDispatch;
        var sec = s_TiDispatchSection;
        if (s == null || sec == null) return true;
        if (Event.current == null || Event.current.type != EventType.Repaint) return true;
        if (image == null) return true;
        var d = new TiDrawRec { C = s_TiDispatchIndex };
        var identity = new TunerRectIdentity(d);
        try
        {
            d.R = s_TiUnclipRect(position);
            d.Bg = color;
            d.Bw = borderWidths;
            d.Br = borderRadii;
            if (!GUI.enabled) d.Flags |= TI_FLAG_OFF;
            bool white = image == EditorGUIUtility.whiteTexture || image == Texture2D.whiteTexture;
            if (white && !uv.HasValue && !hasSlice)
            {
                d.K = 'r';
            }
            else
            {
                d.K = 't';
                d.Tex = TiTextureId(s, image);
                d.ScaleMode = (int)scaleMode;
                d.Aspect = aspect;
                if (uv.HasValue)
                {
                    d.Uv = uv.Value;
                    d.HasUv = !(Mathf.Approximately(d.Uv.x, 0f) && Mathf.Approximately(d.Uv.y, 0f) && Mathf.Approximately(d.Uv.width, 1f) && Mathf.Approximately(d.Uv.height, 1f));
                }
                d.Slice = slice;
                d.HasSlice = hasSlice && slice != Vector4.zero;
            }
            d.Clip = TiClip(sec, TunerRectBounds(d));
            if (d.K == 'r') d.Role = TunerRectRole(sec, color, null, true);
            sec.Draws.Add(d);
        }
        catch (Exception e)
        {
            if (s.LoggedErrors.Add("tex:" + e.Message)) Debug.LogWarning("[tunerInspector] texture record failed: " + e);
        }
        finally
        {
            identity.Dispose();
        }
        return true;
    }

    static void TiRecordProperty(Rect rect, SerializedProperty property)
    {
        if (!s_TiRecording || property == null) return;
        var sec = s_TiDispatchSection;
        if (sec == null || Event.current == null || Event.current.type != EventType.Repaint) return;
        try
        {
            var path = property.propertyPath;
            var owner = property.serializedObject.targetObject;
            if (sec.Uitk && s_TiDispatchIndex > 0 && owner != null && owner != sec.Target) path = ObjectNames.NicifyVariableName(owner.GetType().Name) + "/" + path;
            sec.Props.Add(new TiPropRec
            {
                C = s_TiDispatchIndex,
                Path = path,
                Kind = property.propertyType.ToString(),
                Label = property.displayName,
                Value = TiJsonValue(property) ?? TiPropValue(property),
                R = s_TiUnclipRect(rect)
            });
        }
        catch
        {
        }
    }

    const int TiValueMax = 160;

    static string TiPropValue(SerializedProperty p)
    {
        try
        {
            string v = null;
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer:
                    v = TiFlagsValue(p);
                    break;
                case SerializedPropertyType.ManagedReference:
                {
                    var full = p.managedReferenceFullTypename ?? "";
                    var cut = Math.Max(Math.Max(full.LastIndexOf(' '), full.LastIndexOf('.')), full.LastIndexOf('/'));
                    v = full.Length == 0 ? "None" : full.Substring(cut + 1);
                    break;
                }
                case SerializedPropertyType.ObjectReference:
                {
                    var o = p.objectReferenceValue;
                    if (o != null && string.IsNullOrEmpty(o.name)) v = "unnamed " + ObjectNames.NicifyVariableName(o.GetType().Name);
                    break;
                }
                case SerializedPropertyType.Vector4:
                case SerializedPropertyType.Quaternion:
                    v = TunerDisplayValue(p, true);
                    break;
                case SerializedPropertyType.Rect:
                {
                    var r = p.rectValue;
                    v = "x " + TunerRound(r.x, 1000) + ", y " + TunerRound(r.y, 1000) + ", width " + TunerRound(r.width, 1000) + ", height " + TunerRound(r.height, 1000);
                    break;
                }
                case SerializedPropertyType.RectInt:
                {
                    var r = p.rectIntValue;
                    v = "x " + r.x.ToString(TiInv) + ", y " + r.y.ToString(TiInv) + ", width " + r.width.ToString(TiInv) + ", height " + r.height.ToString(TiInv);
                    break;
                }
                case SerializedPropertyType.Bounds:
                {
                    var b = p.boundsValue;
                    v = "center " + TunerTuple(b.center.x, b.center.y, b.center.z) + ", size " + TunerTuple(b.size.x, b.size.y, b.size.z);
                    break;
                }
                case SerializedPropertyType.BoundsInt:
                {
                    var b = p.boundsIntValue;
                    v = "position " + TunerTuple(b.position.x, b.position.y, b.position.z) + ", size " + TunerTuple(b.size.x, b.size.y, b.size.z);
                    break;
                }
                case SerializedPropertyType.AnimationCurve:
                {
                    var c = p.animationCurveValue;
                    int n = c == null ? 0 : c.length;
                    v = "curve with " + n.ToString(TiInv) + (n == 1 ? " key" : " keys");
                    break;
                }
                case SerializedPropertyType.Gradient:
                {
                    var g = p.gradientValue;
                    v = g == null ? "gradient" : "gradient with " + g.colorKeys.Length.ToString(TiInv) + " colour and " + g.alphaKeys.Length.ToString(TiInv) + " alpha keys";
                    break;
                }
                case SerializedPropertyType.Generic:
                    v = TiEventValue(p) ?? TiMinMaxValue(p) ?? (p.isArray ? TiArrayValue(p) : p.isExpanded ? null : TiStructValue(p, 6));
                    break;
            }
            if (v != null && v.Length > TiValueMax) v = v.Substring(0, TiValueMax - 1) + "\u2026";
            return v;
        }
        catch
        {
            return null;
        }
    }

    static string TiFlagsValue(SerializedProperty p)
    {
        if (p.name != "m_Constraints") return null;
        var owner = p.serializedObject.targetObject;
        var kind = owner == null ? "" : owner.GetType().Name;
        var flags = kind == "Rigidbody" ? Type.GetType("UnityEngine.RigidbodyConstraints, UnityEngine.PhysicsModule")
            : kind == "Rigidbody2D" ? Type.GetType("UnityEngine.RigidbodyConstraints2D, UnityEngine.Physics2DModule") : null;
        if (flags == null || !flags.IsEnum) return null;
        long v = p.longValue;
        var names = new List<string>();
        foreach (var e in Enum.GetValues(flags))
        {
            long n = Convert.ToInt64(e, TiInv);
            if (n == 0 || (n & (n - 1)) != 0 || (v & n) == 0) continue;
            names.Add(ObjectNames.NicifyVariableName(Enum.GetName(flags, e)));
        }
        return names.Count > 0 ? string.Join(" | ", names) : "None";
    }

    static string TiLeafValue(SerializedProperty p)
    {
        if (p.propertyType == SerializedPropertyType.Generic)
            return TiMinMaxValue(p) ?? (p.isArray ? p.arraySize.ToString(TiInv) + (p.arraySize == 1 ? " element" : " elements") : p.depth < 3 ? TiStructValue(p, 2) ?? "{\u2026}" : "{\u2026}");
        if (p.propertyType == SerializedPropertyType.String) return TiShortString(p.stringValue);
        if (p.propertyType == SerializedPropertyType.Integer) return TiFlagsValue(p) ?? TiNativeEnum(p) ?? p.longValue.ToString(TiInv);
        return TiPropValue(p) ?? TunerDisplayValue(p, p.propertyType == SerializedPropertyType.Quaternion);
    }

    static string TiShortString(string v)
    {
        v = v ?? "";
        return JStr(v.Length > 80 ? v.Substring(0, 79) + "\u2026" : v);
    }

    static string TiArrayValue(SerializedProperty p)
    {
        int n = p.arraySize;
        var head = n.ToString(TiInv) + (n == 1 ? " element" : " elements");
        if (n == 0) return head;
        var parts = new List<string>();
        for (int i = 0; i < n && i < 4; i++)
        {
            var e = p.GetArrayElementAtIndex(i);
            parts.Add(e.propertyType == SerializedPropertyType.Generic && !e.isArray ? TiStructValue(e, 3) ?? "{\u2026}" : TiLeafValue(e));
        }
        return head + ": " + string.Join(", ", parts) + (n > 4 ? ", \u2026" : "");
    }

    const int TiValsMax = 40;

    static void TiValsJson(StringBuilder sb, TiSession s, TiSection sec)
    {
        var vals = TiVals(s, sec);
        if (vals != null && vals.Length > 0) sb.Append(",\"vals\":[").Append(vals).Append(']');
    }

    static string TiValuesJson(TiSession s)
    {
        var sb = new StringBuilder("{");
        bool first = true;
        foreach (var sec in s.Sections)
        {
            var vals = TiVals(s, sec);
            if (vals == null) continue;
            if (!first) sb.Append(',');
            first = false;
            TiStr(sb, sec.Key).Append(":[").Append(vals).Append(']');
        }
        return sb.Append('}').ToString();
    }

    static StringBuilder TiMaterialVals(TiSection sec)
    {
        var mat = sec.Target as Material;
        if (mat == null || mat.shader == null || UnityEditorInternal.InternalEditorUtility.GetIsInspectorExpanded(mat)) return null;
        var vals = new StringBuilder();
        try
        {
            var sh = mat.shader;
            int n = 0;
            for (int i = 0; i < sh.GetPropertyCount() && n < TiValsMax; i++)
            {
                var flags = sh.GetPropertyFlags(i);
                if ((flags & (UnityEngine.Rendering.ShaderPropertyFlags.HideInInspector | UnityEngine.Rendering.ShaderPropertyFlags.PerRendererData)) != 0) continue;
                var id = sh.GetPropertyNameId(i);
                string v;
                switch (sh.GetPropertyType(i))
                {
                    case UnityEngine.Rendering.ShaderPropertyType.Color:
                        v = TiJsonColor(mat.GetColor(id));
                        break;
                    case UnityEngine.Rendering.ShaderPropertyType.Vector:
                        var q = mat.GetVector(id);
                        v = TiJsonObj("x", q.x, "y", q.y, "z", q.z, "w", q.w);
                        break;
                    case UnityEngine.Rendering.ShaderPropertyType.Texture:
                        var t = mat.GetTexture(id);
                        v = t == null ? "null" : "\"" + t.name.Replace("\\", "\\\\").Replace("\"", "\\\"") + "\"";
                        break;
                    case UnityEngine.Rendering.ShaderPropertyType.Int:
                        v = mat.GetInteger(id).ToString(TiInv);
                        break;
                    default:
                        v = TiJsonNum(mat.GetFloat(id));
                        break;
                }
                if (n > 0) vals.Append(',');
                TiStr(TiStr(TiStr(vals.Append('['), sh.GetPropertyDescription(i)).Append(','), v).Append(','), sh.GetPropertyName(i));
                vals.Append(']');
                n++;
            }
        }
        catch
        {
        }
        return vals;
    }

    static List<string> TiValsOnly(SerializedObject so, TiSection sec)
    {
        if (sec.Fields == null) return null;
        var only = new List<string>();
        foreach (var f in sec.Fields)
        {
            var p = TiFindField(so, f ?? "");
            if (p != null) only.Add(p.propertyPath);
        }
        return only;
    }

    static bool TiValsKeeps(List<string> only, string path)
    {
        foreach (var x in only)
            if (x == path || x.StartsWith(path + ".", StringComparison.Ordinal)) return true;
        return false;
    }

    static StringBuilder TiVals(TiSession s, TiSection sec)
    {
        if (sec.Kind == "material") return TiMaterialVals(sec);
        if (sec.Kind != "component" || sec.Editor == null || !(sec.Target is Component) || sec.Target is Transform) return null;
        bool script = sec.Target is MonoBehaviour;
        bool expanded = TiExpanded(sec);
        HashSet<string> drawn = null;
        bool hidden = expanded && !script;
        if (expanded && !sec.Uitk)
        {
            drawn = new HashSet<string>();
            foreach (var p in sec.Props)
            {
                if (p.Path == null) continue;
                var dot = p.Path.IndexOf('.');
                drawn.Add(dot < 0 ? p.Path : p.Path.Substring(0, dot));
            }
        }
        var vals = new StringBuilder();
        try
        {
            var so = TiFreshObject(s, sec, expanded);
            if (so == null || so.targetObject == null) return null;
            var only = TiValsOnly(so, sec);
            string[] skip = null;
            foreach (var r in s_TfRules)
                if (r.Section == sec) skip = r.Paths;
            var it = so.GetIterator();
            if (!it.NextVisible(true)) return null;
            int n = 0;
            do
            {
                var path = it.propertyPath;
                if (path == "m_Script" || path == "m_Enabled" || path == "m_ObjectHideFlags" || (drawn != null && drawn.Contains(path))) continue;
                if (only != null && !TiValsKeeps(only, path)) continue;
                if (skip != null && TunerFilterMatches(skip, path)) continue;
                if (n >= TiValsMax) break;
                var v = TiAnyValue(it);
                if (v == null) continue;
                if (n > 0) vals.Append(',');
                TiStr(TiStr(TiStr(vals.Append('['), it.displayName).Append(','), v).Append(','), path);
                vals.Append(hidden ? ",\"h\"]" : "]");
                n++;
            }
            while (it.NextVisible(false));
        }
        catch
        {
        }
        return vals;
    }

    static SerializedObject TiFreshObject(TiSession s, TiSection sec, bool expanded)
    {
        var own = sec.Editor.serializedObject;
        if (s == null || own == null || own.targetObjects.Length > 1)
        {
            if (own != null && !expanded) own.Update();
            return own;
        }
        SerializedObject so;
        if (!s.LiveObjects.TryGetValue(sec.Target, out so) || so == null || so.targetObject == null)
        {
            so?.Dispose();
            so = new SerializedObject(sec.Target);
            s.LiveObjects[sec.Target] = so;
        }
        so.Update();
        return so;
    }

    static readonly Dictionary<string, PropertyInfo[]> s_TiEnumChains = new Dictionary<string, PropertyInfo[]>();
    static readonly Dictionary<string, string> s_TiEnumAlias = new Dictionary<string, string>
    {
        { "initialmodule", "main" },
        { "uvmodule", "texturesheetanimation" },
        { "velocitymodule", "velocityoverlifetime" },
        { "forcemodule", "forceoverlifetime" },
        { "clampvelocitymodule", "limitvelocityoverlifetime" },
        { "sizemodule", "sizeoverlifetime" },
        { "rotationmodule", "rotationoverlifetime" },
        { "colormodule", "coloroverlifetime" },
        { "submodule", "subemitters" },
        { "minmaxstate", "mode" },
        { "movewithtransform", "simulationspace" }
    };

    static string TiEnumNorm(string s)
    {
        if (s.StartsWith("m_", StringComparison.Ordinal)) s = s.Substring(2);
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s)
            if (char.IsLetterOrDigit(ch)) sb.Append(char.ToLowerInvariant(ch));
        var n = sb.ToString();
        string alias;
        return s_TiEnumAlias.TryGetValue(n, out alias) ? alias : n;
    }

    static bool TiEnumUsable(PropertyInfo pi)
    {
        return pi.CanRead && pi.GetIndexParameters().Length == 0 && !pi.IsDefined(typeof(ObsoleteAttribute), true);
    }

    static string TiNativeEnum(SerializedProperty p)
    {
        if (p.propertyType != SerializedPropertyType.Integer) return null;
        var owner = p.serializedObject.targetObject;
        if (owner == null || owner is MonoBehaviour || owner is ScriptableObject) return null;
        var path = p.propertyPath;
        if (path.IndexOf('[') >= 0) return null;
        long v = p.longValue;
        var key = owner.GetType().FullName + "|" + path;
        PropertyInfo[] chain;
        if (!s_TiEnumChains.TryGetValue(key, out chain))
        {
            try { chain = TiEnumChain(owner, path.Split('.'), v); }
            catch { chain = null; }
            s_TiEnumChains[key] = chain;
        }
        if (chain == null) return null;
        object obj = owner;
        try
        {
            foreach (var pi in chain)
            {
                obj = pi.GetValue(obj);
                if (obj == null) return null;
            }
            if (Convert.ToInt64(obj, TiInv) != v) return null;
        }
        catch
        {
            return null;
        }
        return TiEnumName(chain[chain.Length - 1].PropertyType, v);
    }

    static PropertyInfo[] TiEnumChain(Object owner, string[] segs, long v)
    {
        var lead = new List<PropertyInfo>();
        object obj = owner;
        Type t = owner.GetType();
        for (int i = 0; i < segs.Length - 1; i++)
        {
            var pi = TiEnumMember(t, segs[i]);
            if (pi == null) return null;
            obj = pi.GetValue(obj);
            if (obj == null) return null;
            lead.Add(pi);
            t = pi.PropertyType;
        }
        var hit = TiEnumLeaf(t, obj, segs[segs.Length - 1], segs.Length > 1 ? segs[segs.Length - 2] : "", v);
        if (hit != null)
        {
            lead.Add(hit);
            return lead.ToArray();
        }
        if (segs.Length != 1) return null;
        foreach (var mod in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            var mt = mod.PropertyType;
            if (!mt.IsValueType || mt.IsPrimitive || mt.IsEnum || !mt.Name.EndsWith("Module", StringComparison.Ordinal) || !TiEnumUsable(mod)) continue;
            object m;
            try { m = mod.GetValue(owner); }
            catch { continue; }
            hit = TiEnumLeaf(mt, m, segs[0], "", v);
            if (hit != null) return new[] { mod, hit };
        }
        return null;
    }

    static PropertyInfo TiEnumMember(Type t, string seg)
    {
        var n = TiEnumNorm(seg);
        foreach (var pi in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            if (TiEnumUsable(pi) && (TiEnumNorm(pi.Name) == n || pi.PropertyType.Name == seg)) return pi;
        return null;
    }

    static PropertyInfo TiEnumLeaf(Type t, object obj, string leaf, string parent, long v)
    {
        var n = TiEnumNorm(leaf);
        var n2 = parent.Length > 0 ? TiEnumNorm(parent) + n : "";
        PropertyInfo best = null;
        int bestScore = 0;
        foreach (var pi in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!pi.PropertyType.IsEnum || !TiEnumUsable(pi)) continue;
            var m = TiEnumNorm(pi.Name);
            int score = m == n ? 5 : m == n2 ? 4 : TiEnumPrefix(m, n) ? 3 : TiEnumPrefix(m, n2) ? 2 : TiEnumSuffix(m, n) ? 1 : 0;
            if (score == 0) continue;
            bool same;
            try { same = Convert.ToInt64(pi.GetValue(obj), TiInv) == v; }
            catch { same = false; }
            score = score * 2 + (same ? 1 : 0);
            if (score <= bestScore) continue;
            best = pi;
            bestScore = score;
        }
        return best;
    }

    static bool TiEnumPrefix(string a, string b)
    {
        return a.Length >= 4 && b.Length >= 4 && (a.StartsWith(b, StringComparison.Ordinal) || b.StartsWith(a, StringComparison.Ordinal));
    }

    static bool TiEnumSuffix(string a, string b)
    {
        return a.Length >= 4 && b.Length >= 4 && (a.EndsWith(b, StringComparison.Ordinal) || b.EndsWith(a, StringComparison.Ordinal));
    }

    static string TiEnumName(Type t, long v)
    {
        if (t.IsDefined(typeof(FlagsAttribute), false))
        {
            var names = new List<string>();
            foreach (var e in Enum.GetValues(t))
            {
                long n = Convert.ToInt64(e, TiInv);
                if (n == 0 || (n & (n - 1)) != 0 || (v & n) == 0) continue;
                names.Add(ObjectNames.NicifyVariableName(Enum.GetName(t, e)));
            }
            return names.Count > 0 ? string.Join(" | ", names) : "None";
        }
        foreach (var e in Enum.GetValues(t))
            if (Convert.ToInt64(e, TiInv) == v) return ObjectNames.NicifyVariableName(Enum.GetName(t, e));
        return null;
    }

    static string TiMinMaxValue(SerializedProperty p)
    {
        if (p.propertyType != SerializedPropertyType.Generic || p.isArray) return null;
        var state = p.FindPropertyRelative("minMaxState");
        if (state == null) return null;
        int st = state.intValue;
        var scalar = p.FindPropertyRelative("scalar");
        if (scalar != null)
        {
            var max = TunerRound(scalar.floatValue, 1000);
            var low = p.FindPropertyRelative("minScalar");
            var min = low == null ? "0" : TunerRound(low.floatValue, 1000);
            switch (st)
            {
                case 0: return max;
                case 1: return "curve \u00d7 " + max;
                case 2: return "random between two curves \u00d7 " + max;
                case 3: return "random between " + min + " and " + max;
            }
            return null;
        }
        var hi = p.FindPropertyRelative("maxColor");
        if (hi == null) return null;
        var lo = p.FindPropertyRelative("minColor");
        switch (st)
        {
            case 0: return TunerDisplayValue(hi, false);
            case 1: return "gradient";
            case 2: return lo == null ? null : "random between " + TunerDisplayValue(lo, false) + " and " + TunerDisplayValue(hi, false);
            case 3: return "random between two gradients";
            case 4: return "random colour";
        }
        return null;
    }

    static string TiAnyValue(SerializedProperty p)
    {
        try
        {
            var v = TiJsonValue(p) ?? TiPropValue(p) ?? TiNativeEnum(p);
            if (v != null) return v;
            if (p.propertyType == SerializedPropertyType.Generic) return TiStructValue(p, 6);
            if (p.propertyType == SerializedPropertyType.String) return TiShortString(p.stringValue);
            return TunerDisplayValue(p, p.propertyType == SerializedPropertyType.Quaternion);
        }
        catch
        {
            return null;
        }
    }

    static string TiEventValue(SerializedProperty p)
    {
        var calls = p.propertyPath.EndsWith("m_PersistentCalls.m_Calls", StringComparison.Ordinal) ? p : p.FindPropertyRelative("m_PersistentCalls.m_Calls");
        if (calls == null || !calls.isArray) return null;
        int n = calls.arraySize;
        if (n == 0) return "no listeners";
        var parts = new List<string>();
        for (int i = 0; i < n && i < 3; i++)
        {
            var call = calls.GetArrayElementAtIndex(i);
            var target = call.FindPropertyRelative("m_Target");
            var method = call.FindPropertyRelative("m_MethodName");
            var obj = target == null ? null : target.objectReferenceValue;
            var what = method == null || string.IsNullOrEmpty(method.stringValue) ? "No Function" : method.stringValue;
            parts.Add(obj == null ? what + " on None" : what + " on " + obj.name + " (" + obj.GetType().Name + ")");
        }
        return n.ToString(TiInv) + (n == 1 ? " listener: " : " listeners: ") + string.Join(", ", parts) + (n > 3 ? ", \u2026" : "");
    }

    static string TiStructValue(SerializedProperty p, int max)
    {
        var it = p.Copy();
        var end = p.GetEndProperty();
        if (!it.NextVisible(true) || SerializedProperty.EqualContents(it, end)) return null;
        var parts = new List<string>();
        bool more = false;
        do
        {
            if (parts.Count >= max)
            {
                more = true;
                break;
            }
            parts.Add(it.displayName + ": " + TiLeafValue(it));
        }
        while (it.NextVisible(false) && !SerializedProperty.EqualContents(it, end));
        return "{" + string.Join(", ", parts) + (more ? ", \u2026" : "") + "}";
    }

    static void TiRecordFlagToggle(Rect rect, string path, Type flags, int bit, string text)
    {
        if (!s_TiRecording || flags == null || !flags.IsEnum) return;
        var sec = s_TiDispatchSection;
        if (sec == null || Event.current == null || Event.current.type != EventType.Repaint) return;
        try
        {
            var name = Enum.GetName(flags, 1 << bit) ?? ("Bit" + bit);
            var label = ObjectNames.NicifyVariableName(name);
            text = (text ?? "").Trim();
            if (text.Length > 0 && !label.EndsWith(" " + text, StringComparison.Ordinal))
            {
                label += " " + text;
                name += text;
            }
            sec.Props.Add(new TiPropRec { C = s_TiDispatchIndex, Path = path + "." + name, Kind = "Boolean", Label = label, Named = true, R = s_TiUnclipRect(rect) });
        }
        catch
        {
        }
    }

    static bool TiRecordCursor(Rect position, MouseCursor mouse)
    {
        if (s_TiDispatch == null) return false;
        if (!s_TiRecording || Event.current == null || Event.current.type != EventType.Repaint) return true;
        var sec = s_TiDispatchSection;
        if (sec == null) return true;
        try
        {
            sec.Cursors.Add(new TiCursorRec { C = s_TiDispatchIndex, R = s_TiUnclipRect(position), Cursor = TiCssCursor(mouse) });
        }
        catch
        {
        }
        return true;
    }

    static string TiCssCursor(MouseCursor m)
    {
        switch (m)
        {
            case MouseCursor.Text: return "text";
            case MouseCursor.ResizeVertical: return "ns-resize";
            case MouseCursor.ResizeHorizontal: return "ew-resize";
            case MouseCursor.Link: return "pointer";
            case MouseCursor.SlideArrow: return "ew-resize";
            case MouseCursor.ResizeUpRight: return "nesw-resize";
            case MouseCursor.ResizeUpLeft: return "nwse-resize";
            case MouseCursor.MoveArrow: return "move";
            case MouseCursor.RotateArrow: return "crosshair";
            case MouseCursor.ScaleArrow: return "nwse-resize";
            case MouseCursor.ArrowPlus: return "copy";
            case MouseCursor.Pan: return "grab";
            case MouseCursor.Orbit: return "grab";
            case MouseCursor.Zoom: return "zoom-in";
            case MouseCursor.FPS: return "crosshair";
            case MouseCursor.SplitResizeUpDown: return "row-resize";
            case MouseCursor.SplitResizeLeftRight: return "col-resize";
            case MouseCursor.NotAllowed: return "not-allowed";
            default: return "default";
        }
    }

    static readonly Rect TiNoScroll = new Rect(0f, 0f, -1f, -1f);

    static Rect TiScrollViewBegin(Rect position)
    {
        var sec = s_TiDispatchSection;
        if (!s_TiRecording || sec == null || sec.Uitk || s_TiUnclipRect == null || Event.current == null || Event.current.type != EventType.Repaint || !GUI.matrix.isIdentity) return TiNoScroll;
        return s_TiUnclipRect(position);
    }

    static void TiScrollViewEnd(Rect r, Rect position, Rect viewRect, bool alwaysH, bool alwaysV, GUIStyle hBar, GUIStyle vBar, Vector2 scroll)
    {
        var sec = s_TiDispatchSection;
        if (r.width < 0f || sec == null || !s_TiRecording) return;
        float hBarH = hBar != null ? hBar.fixedHeight : 0f;
        float hBarTop = hBar != null ? hBar.margin.top : 0f;
        float vBarW = vBar != null ? vBar.fixedWidth : 0f;
        float vBarLeft = vBar != null ? vBar.margin.left : 0f;
        float visW = position.width, visH = position.height, clipW = position.width, clipH = position.height;
        bool needH = alwaysH;
        if (needH || viewRect.width > clipW)
        {
            visH = position.height - hBarH + hBarTop;
            clipH -= hBarH + hBarTop;
            needH = true;
        }
        if (alwaysV || viewRect.height > clipH)
        {
            visW = position.width - vBarW + vBarLeft;
            clipW -= vBarW + vBarLeft;
            if (!needH && viewRect.width > clipW) visH = position.height - hBarH + hBarTop;
        }
        var rec = new TiScrollRec { C = s_TiDispatchIndex, R = r, View = new Vector2(viewRect.width, viewRect.height), Visible = new Vector2(visW, visH), Scroll = scroll };
        for (int i = 0; i < sec.Scrolls.Count; i++)
        {
            var o = sec.Scrolls[i];
            if (o.C == rec.C && Mathf.Abs(o.R.x - r.x) < 0.01f && Mathf.Abs(o.R.y - r.y) < 0.01f && Mathf.Abs(o.R.width - r.width) < 0.01f && Mathf.Abs(o.R.height - r.height) < 0.01f)
            {
                sec.Scrolls[i] = rec;
                return;
            }
        }
        sec.Scrolls.Add(rec);
    }

    static int TiClip(TiSection sec, Rect r)
    {
        if (s_TiVisibleRect == null || s_TiDispatchContainer == null) return -1;
        var vis = s_TiUnclipRect(s_TiVisibleRect());
        var lay = s_TiDispatchContainer.layout;
        float x0 = Mathf.Max(vis.xMin, 0f);
        float y0 = Mathf.Max(vis.yMin, 0f);
        float x1 = Mathf.Min(vis.xMax, lay.width);
        float y1 = Mathf.Min(vis.yMax, TI_MAX_HEIGHT);
        if (r.xMin >= x0 - 0.5f && r.yMin >= y0 - 0.5f && r.xMax <= x1 + 0.5f && r.yMax <= y1 + 0.5f) return -1;
        if (x0 <= 0.5f && y0 <= 0.5f && x1 >= lay.width - 0.5f && y1 >= TI_MAX_HEIGHT - 0.5f) return -1;
        var clip = Rect.MinMaxRect(x0, y0, Mathf.Max(x0, x1), Mathf.Max(y0, y1));
        List<TiClipRec> list;
        if (!s_TiClipRecs.TryGetValue(sec, out list))
        {
            list = new List<TiClipRec>();
            s_TiClipRecs[sec] = list;
        }
        for (int i = 0; i < list.Count; i++)
        {
            var c = list[i];
            if (c.C == s_TiDispatchIndex && Mathf.Abs(c.R.x - clip.x) < 0.01f && Mathf.Abs(c.R.y - clip.y) < 0.01f
                && Mathf.Abs(c.R.width - clip.width) < 0.01f && Mathf.Abs(c.R.height - clip.height) < 0.01f) return i;
        }
        list.Add(new TiClipRec { C = s_TiDispatchIndex, R = clip });
        return list.Count - 1;
    }

    static int TiStyleId(TiSession s, GUIStyle style)
    {
        if (style == null) style = GUIStyle.none;
        int id;
        int sig = TiStyleSig(style);
        if (s.PassStyles.TryGetValue(style, out var seen) && seen.sig == sig) return seen.id;
        var json = TiStyleJson(s, style);
        if (!s.StyleIds.TryGetValue(json, out id))
        {
            id = s.StyleIds.Count + 1;
            s.StyleIds[json] = id;
            s.NewStyles.Add("{\"id\":" + id.ToString(TiInv) + "," + json.Substring(1));
        }
        s.PassStyles[style] = (id, sig);
        return id;
    }

    static int TiStyleSig(GUIStyle st)
    {
        unchecked
        {
            var n = st.normal;
            var bg = n.background;
            int h = (int)st.alignment;
            h = h * 31 + (int)st.fontStyle;
            h = h * 31 + st.fontSize;
            var font = TiResolvedFont(st);
            h = h * 31 + (font != null ? font.GetHashCode() : 0);
            h = h * 31 + (st.wordWrap ? 1 : 0) + (st.richText ? 2 : 0) + ((int)st.clipping << 2);
            h = h * 31 + (bg != null ? bg.GetHashCode() : 0);
            h = h * 31 + n.textColor.GetHashCode();
            h = h * 31 + st.contentOffset.GetHashCode();
            h = h * 31 + st.padding.left;
            return h;
        }
    }

    static Func<Font> s_TiDefaultFont;

    static Font TiResolvedFont(GUIStyle st)
    {
        if (st.font != null) return st.font;
        if (s_TiDefaultFont == null)
        {
            var m = typeof(GUIStyle).GetMethod("GetDefaultFont", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
            try { s_TiDefaultFont = m != null && m.ReturnType == typeof(Font) ? (Func<Font>)Delegate.CreateDelegate(typeof(Func<Font>), m) : () => null; }
            catch { s_TiDefaultFont = () => null; }
        }
        var f = s_TiDefaultFont();
        return f != null ? f : (GUI.skin != null ? GUI.skin.font : null);
    }

    static string TiStyleJson(TiSession s, GUIStyle st)
    {
        var sb = new StringBuilder(256);
        var alias = TiTmpStyleAlias(st);
        sb.Append("{\"n\":");
        TiStr(sb, alias ?? st.name ?? "");
        var resolved = TiResolvedFont(st);
        if (resolved != null) TiStr(sb.Append(",\"f\":"), resolved.name);
        int size = st.fontSize;
        if (size <= 0) size = resolved != null && resolved.fontSize > 0 ? resolved.fontSize : 12;
        sb.Append(",\"fs\":").Append(size.ToString(TiInv));
        if (st.fontStyle != FontStyle.Normal) sb.Append(",\"fst\":").Append(((int)st.fontStyle).ToString(TiInv));
        TiNum(sb.Append(",\"lh\":"), st.lineHeight);
        sb.Append(",\"al\":").Append(((int)st.alignment).ToString(TiInv));
        if (st.wordWrap) sb.Append(",\"ww\":true");
        if (st.richText) sb.Append(",\"rt\":true");
        if (st.clipping != TextClipping.Overflow) sb.Append(",\"cl\":").Append(((int)st.clipping).ToString(TiInv));
        var co = st.contentOffset;
        if (co != Vector2.zero)
        {
            TiNum(sb.Append(",\"co\":["), co.x);
            TiNum(sb.Append(','), co.y).Append(']');
        }
        if (st.imagePosition != ImagePosition.ImageLeft) sb.Append(",\"ip\":").Append(((int)st.imagePosition).ToString(TiInv));
        if (st.fixedWidth > 0f) TiNum(sb.Append(",\"fw\":"), st.fixedWidth);
        if (st.fixedHeight > 0f) TiNum(sb.Append(",\"fh\":"), st.fixedHeight);
        TiOffset(sb, "b", st.border);
        TiOffset(sb, "p", st.padding);
        TiOffset(sb, "o", st.overflow);
        bool defaultText;
        bool skin = alias != null ? defaultText = true : TiIsSkinStyle(st, out defaultText);
        if (skin)
        {
            sb.Append(",\"sk\":1");
            if (defaultText) sb.Append(",\"dtc\":1");
        }
        sb.Append(",\"s\":{");
        bool first = true;
        TiState(s, sb, "n", st.normal, skin, ref first);
        TiState(s, sb, "h", st.hover, skin, ref first);
        TiState(s, sb, "a", st.active, skin, ref first);
        TiState(s, sb, "f", st.focused, skin, ref first);
        TiState(s, sb, "on", st.onNormal, skin, ref first);
        TiState(s, sb, "onh", st.onHover, skin, ref first);
        TiState(s, sb, "ona", st.onActive, skin, ref first);
        TiState(s, sb, "onf", st.onFocused, skin, ref first);
        sb.Append("}}");
        return sb.ToString();
    }

    static readonly List<Texture2D> s_TiSkinTexScratch = new List<Texture2D>();

    static bool TiIsSkinStyle(GUIStyle st, out bool defaultText)
    {
        defaultText = false;
        var name = st.name;
        if (string.IsNullOrEmpty(name)) return false;
        GUIStyle skinStyle = null;
        try
        {
            var skin = GUI.skin;
            if (skin != null) skinStyle = skin.FindStyle(name);
            if (skinStyle == null)
            {
                var builtin = EditorGUIUtility.GetBuiltinSkin(EditorGUIUtility.isProSkin ? EditorSkin.Scene : EditorSkin.Inspector);
                if (builtin != null) skinStyle = builtin.FindStyle(name);
            }
        }
        catch
        {
            skinStyle = null;
        }
        if (skinStyle == null) return false;
        if (!ReferenceEquals(skinStyle, st))
        {
            s_TiSkinTexScratch.Clear();
            TiCollectBackgrounds(skinStyle, s_TiSkinTexScratch);
            var own = new List<Texture2D>();
            TiCollectBackgrounds(st, own);
            foreach (var t in own)
                if (t != null && !s_TiSkinTexScratch.Contains(t)) return false;
        }
        defaultText = TiSameColor(st.normal.textColor, skinStyle.normal.textColor);
        return true;
    }

    static void TiCollectBackgrounds(GUIStyle st, List<Texture2D> into)
    {
        foreach (var state in new[] { st.normal, st.hover, st.active, st.focused, st.onNormal, st.onHover, st.onActive, st.onFocused })
        {
            if (state == null) continue;
            if (state.background != null) into.Add(state.background);
            var scaled = state.scaledBackgrounds;
            if (scaled != null)
                foreach (var t in scaled)
                    if (t != null) into.Add(t);
        }
    }

    static bool TiSameColor(Color a, Color b)
    {
        return Mathf.Abs(a.r - b.r) < 0.004f && Mathf.Abs(a.g - b.g) < 0.004f && Mathf.Abs(a.b - b.b) < 0.004f && Mathf.Abs(a.a - b.a) < 0.004f;
    }

    static void TiOffset(StringBuilder sb, string key, RectOffset o)
    {
        if (o == null || (o.left == 0 && o.right == 0 && o.top == 0 && o.bottom == 0)) return;
        sb.Append(",\"").Append(key).Append("\":[").Append(o.left.ToString(TiInv)).Append(',').Append(o.right.ToString(TiInv))
          .Append(',').Append(o.top.ToString(TiInv)).Append(',').Append(o.bottom.ToString(TiInv)).Append(']');
    }

    static void TiState(TiSession s, StringBuilder sb, string key, GUIStyleState state, bool skin, ref bool first)
    {
        if (state == null) return;
        var bg = state.background;
        Texture2D bg2 = null;
        var scaled = state.scaledBackgrounds;
        if (scaled != null)
            foreach (var t in scaled)
                if (t != null && t != bg)
                {
                    bg2 = t;
                    break;
                }
        var tc = state.textColor;
        if (!first) sb.Append(',');
        first = false;
        sb.Append('"').Append(key).Append("\":{");
        if (skin)
        {
            if (bg != null || bg2 != null) sb.Append("\"hb\":1,");
        }
        else
        {
            if (bg != null) sb.Append("\"bg\":").Append(TiTextureId(s, bg).ToString(TiInv)).Append(',');
            if (bg2 != null) sb.Append("\"bg2\":").Append(TiTextureId(s, bg2).ToString(TiInv)).Append(',');
        }
        sb.Append("\"tc\":\"").Append(TiHex(tc)).Append("\"}");
    }

    static int TiTextureId(TiSession s, Texture tex)
    {
        if (tex == null) return -1;
        string key;
        Texture2D copy = null;
        if (tex is RenderTexture)
        {
            int w = Mathf.Max(1, tex.width), h = Mathf.Max(1, tex.height);
            if (w > TI_MAX_TEXTURE_SIDE || h > TI_MAX_TEXTURE_SIDE)
            {
                float k = (float)TI_MAX_TEXTURE_SIDE / Mathf.Max(w, h);
                w = Mathf.Max(1, Mathf.RoundToInt(w * k));
                h = Mathf.Max(1, Mathf.RoundToInt(h * k));
            }
            copy = TiReadPixels(tex, w, h);
            if (copy == null) return -1;
            var raw = copy.GetRawTextureData<byte>();
            ulong hash = 1469598103934665603UL;
            for (int i = 0; i < raw.Length; i += 3)
            {
                hash ^= raw[i];
                hash *= 1099511628211UL;
            }
            key = "rt:" + w.ToString(TiInv) + "x" + h.ToString(TiInv) + ":" + hash.ToString("x16");
        }
        else
            key = tex.GetHashCode().ToString(TiInv) + ":" + tex.updateCount.ToString(TiInv);
        int id;
        if (s.TexIds.TryGetValue(key, out id))
        {
            if (copy != null) Object.DestroyImmediate(copy);
            return id;
        }
        id = s.TexIds.Count + 1;
        s.TexIds[key] = id;
        s_TiPendingTextures.Add(new TiPendingTexture { Id = id, Tex = tex, Copy = copy });
        return id;
    }

    static void TiFlushTextures(TiSession s)
    {
        if (s_TiPendingTextures.Count == 0) return;
        var pending = s_TiPendingTextures.ToArray();
        s_TiPendingTextures.Clear();
        foreach (var p in pending)
        {
            try { s.NewTextures.Add(p.Copy != null ? TiCopyJson(p.Id, p.Copy) : TiTextureJson(p.Id, p.Tex)); }
            catch (Exception e)
            {
                if (s.LoggedErrors.Add("png:" + e.Message)) Debug.LogWarning("[tunerInspector] texture export failed for " + (p.Tex != null ? p.Tex.name : "null") + ": " + e.Message);
                s.NewTextures.Add("{\"id\":" + p.Id.ToString(TiInv) + ",\"w\":1,\"h\":1}");
            }
            finally
            {
                if (p.Copy != null) Object.DestroyImmediate(p.Copy);
            }
        }
    }

    static float TiTexturePixelsPerPoint(Texture tex)
    {
        if (!s_TiPixelsPerPointLooked)
        {
            s_TiPixelsPerPointLooked = true;
            s_TiPixelsPerPoint = typeof(Texture2D).GetProperty("pixelsPerPoint", TiInstance);
        }
        if (s_TiPixelsPerPoint == null || !(tex is Texture2D)) return 1f;
        try { return Convert.ToSingle(s_TiPixelsPerPoint.GetValue(tex), TiInv); }
        catch { return 1f; }
    }

    static MethodInfo s_TiCheckerGetter;
    static bool s_TiCheckerLooked;

    static bool TiIsGradientChecker(Texture tex)
    {
        if (!s_TiCheckerLooked)
        {
            s_TiCheckerLooked = true;
            s_TiCheckerGetter = typeof(EditorGUI).Assembly.GetType("UnityEditor.GradientEditor")?.GetMethod("GetBackgroundTexture", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
        }
        if (s_TiCheckerGetter == null) return false;
        try { return ReferenceEquals(s_TiCheckerGetter.Invoke(null, null), tex); }
        catch { return false; }
    }

    static string TiTextureJson(int id, Texture tex)
    {
        int w = Mathf.Max(1, tex.width);
        int h = Mathf.Max(1, tex.height);
        var sb = new StringBuilder(256);
        sb.Append("{\"id\":").Append(id.ToString(TiInv)).Append(",\"w\":").Append(w.ToString(TiInv)).Append(",\"h\":").Append(h.ToString(TiInv));
        var ppp = TiTexturePixelsPerPoint(tex);
        if (ppp > 1.01f) TiNum(sb.Append(",\"sc\":"), ppp);
        if (!string.IsNullOrEmpty(tex.name)) TiStr(sb.Append(",\"n\":"), tex.name);
        if (TiIsGradientChecker(tex)) sb.Append(",\"chk\":1");
        int ow = w, oh = h;
        if (ow > TI_MAX_TEXTURE_SIDE || oh > TI_MAX_TEXTURE_SIDE)
        {
            float k = (float)TI_MAX_TEXTURE_SIDE / Mathf.Max(ow, oh);
            ow = Mathf.Max(1, Mathf.RoundToInt(ow * k));
            oh = Mathf.Max(1, Mathf.RoundToInt(oh * k));
        }
        var pixels = TiReadPixels(tex, ow, oh);
        if (pixels == null)
        {
            sb.Append('}');
            return sb.ToString();
        }
        if (ow * oh <= 256)
        {
            bool solid = true;
            var c0 = pixels.GetPixel(0, 0);
            var p0 = pixels.GetPixels32();
            for (int i = 1; i < p0.Length && solid; i++)
                if (p0[i].r != p0[0].r || p0[i].g != p0[0].g || p0[i].b != p0[0].b || p0[i].a != p0[0].a) solid = false;
            if (solid)
            {
                sb.Append(",\"solid\":\"").Append(TiHex(c0)).Append("\"}");
                Object.DestroyImmediate(pixels);
                return sb.ToString();
            }
        }
        var png = pixels.EncodeToPNG();
        Object.DestroyImmediate(pixels);
        sb.Append(",\"png\":\"").Append(Convert.ToBase64String(png)).Append("\"}");
        return sb.ToString();
    }

    static string TiCopyJson(int id, Texture2D copy)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"id\":").Append(id.ToString(TiInv)).Append(",\"w\":").Append(copy.width.ToString(TiInv)).Append(",\"h\":").Append(copy.height.ToString(TiInv));
        sb.Append(",\"n\":\"preview\",\"png\":\"").Append(Convert.ToBase64String(copy.EncodeToPNG())).Append("\"}");
        return sb.ToString();
    }

    static Texture2D TiReadPixels(Texture tex, int w, int h)
    {
        bool linear = QualitySettings.activeColorSpace == ColorSpace.Linear;
        bool srgb = true;
        try { srgb = tex.isDataSRGB; }
        catch { }
        var rw = linear ? (srgb ? RenderTextureReadWrite.sRGB : RenderTextureReadWrite.Linear) : RenderTextureReadWrite.Default;
        var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, rw);
        var prev = RenderTexture.active;
        try
        {
            Graphics.Blit(tex, rt);
            RenderTexture.active = rt;
            var copy = new Texture2D(w, h, TextureFormat.RGBA32, false, linear && !srgb);
            copy.hideFlags = HideFlags.HideAndDontSave;
            copy.ReadPixels(new Rect(0, 0, w, h), 0, 0, false);
            copy.Apply(false, false);
            return copy;
        }
        finally
        {
            RenderTexture.active = prev;
            RenderTexture.ReleaseTemporary(rt);
        }
    }

    static string TiHex(Color c)
    {
        Color32 k = c;
        return k.r.ToString("x2") + k.g.ToString("x2") + k.b.ToString("x2") + k.a.ToString("x2");
    }

    static bool TiWhite(Color c)
    {
        return c.r >= 0.998f && c.g >= 0.998f && c.b >= 0.998f && c.a >= 0.998f;
    }

    static StringBuilder TiNum(StringBuilder sb, float v)
    {
        if (float.IsNaN(v) || float.IsInfinity(v)) v = 0f;
        return sb.Append(v.ToString("0.##", TiInv));
    }

    static StringBuilder TiStr(StringBuilder sb, string s)
    {
        sb.Append('"');
        if (s != null)
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
                        if (ch < 0x20 || ch == 0x2028 || ch == 0x2029) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                        else sb.Append(ch);
                        break;
                }
            }
        return sb.Append('"');
    }

    static StringBuilder TiRect(StringBuilder sb, Rect r)
    {
        TiNum(sb.Append("\"x\":"), r.x);
        TiNum(sb.Append(",\"y\":"), r.y);
        TiNum(sb.Append(",\"w\":"), r.width);
        TiNum(sb.Append(",\"h\":"), r.height);
        return sb;
    }

    static StringBuilder TiVec4(StringBuilder sb, Vector4 v)
    {
        TiNum(sb.Append('['), v.x);
        TiNum(sb.Append(','), v.y);
        TiNum(sb.Append(','), v.z);
        TiNum(sb.Append(','), v.w);
        return sb.Append(']');
    }

    static ulong TiHash(string s)
    {
        ulong h = 1469598103934665603UL;
        for (int i = 0; i < s.Length; i++)
        {
            h ^= s[i];
            h *= 1099511628211UL;
        }
        return h;
    }

    static string TiSectionBody(TiSession s, TiSection sec)
    {
        var sb = new StringBuilder(4096);
        if (sec.Title != null) TiStr(sb.Append(",\"title\":"), sec.Title);
        if (sec.TypeName != null) TiStr(sb.Append(",\"type\":"), sec.TypeName);
        if (sec.Editor != null) TiStr(sb.Append(",\"editor\":"), sec.Editor.GetType().FullName);
        if (sec.Kind == "component") sb.Append(",\"expanded\":").Append(TiExpanded(sec) ? "true" : "false");
        if (sec.FieldsTotal >= 0) sb.Append(",\"filter\":{\"shown\":").Append(sec.FieldsShown.ToString(TiInv)).Append(",\"total\":").Append(sec.FieldsTotal.ToString(TiInv)).Append('}');
        sb.Append(",\"draws\":[");
        for (int i = 0; i < sec.Draws.Count; i++)
        {
            if (i > 0) sb.Append(',');
            var d = sec.Draws[i];
            TiDrawJson(sb, d, sec.Uitk && d.C > 0 ? d.C - 1 : -1);
        }
        sb.Append("],\"props\":[");
        for (int i = 0; i < sec.Props.Count; i++)
        {
            var p = sec.Props[i];
            if (i > 0) sb.Append(',');
            TiStr(sb.Append("{\"p\":"), p.Path);
            TiStr(sb.Append(",\"k\":"), p.Kind);
            if (sec.Uitk && p.C > 0) sb.Append(",\"c\":").Append((p.C - 1).ToString(TiInv));
            if (!string.IsNullOrEmpty(p.Label)) TiStr(sb.Append(",\"l\":"), p.Label);
            if (p.Named) sb.Append(",\"n\":1");
            if (p.Value != null) TiStr(sb.Append(",\"v\":"), p.Value);
            TiRect(sb.Append(','), p.R).Append('}');
        }
        sb.Append(']');
        TiValsJson(sb, s, sec);
        if (sec.Cursors.Count > 0)
        {
            sb.Append(",\"cursors\":[");
            for (int i = 0; i < sec.Cursors.Count; i++)
            {
                var c = sec.Cursors[i];
                if (i > 0) sb.Append(',');
                TiRect(sb.Append('{'), c.R);
                if (sec.Uitk && c.C > 0) sb.Append(",\"im\":").Append((c.C - 1).ToString(TiInv));
                TiStr(sb.Append(",\"c\":"), c.Cursor).Append('}');
            }
            sb.Append(']');
        }
        if (sec.Clips.Count > 0)
        {
            sb.Append(",\"clips\":[");
            for (int i = 0; i < sec.Clips.Count; i++)
            {
                if (i > 0) sb.Append(',');
                TiRect(sb.Append('{'), sec.Clips[i]).Append('}');
            }
            sb.Append(']');
        }
        if (sec.Scrolls.Count > 0)
        {
            sb.Append(",\"scrolls\":[");
            for (int i = 0; i < sec.Scrolls.Count; i++)
            {
                var sc = sec.Scrolls[i];
                if (i > 0) sb.Append(',');
                TiRect(sb.Append('{'), sc.R);
                TiNum(sb.Append(",\"cw\":"), sc.View.x);
                TiNum(sb.Append(",\"ch\":"), sc.View.y);
                TiNum(sb.Append(",\"vw\":"), sc.Visible.x);
                TiNum(sb.Append(",\"vh\":"), sc.Visible.y);
                TiNum(sb.Append(",\"sx\":"), sc.Scroll.x);
                TiNum(sb.Append(",\"sy\":"), sc.Scroll.y).Append('}');
            }
            sb.Append(']');
        }
        if (sec.Uitk && sec.UitkJson != null) sb.Append(",\"uitk\":").Append(sec.UitkJson);
        if (sec.PscJson != null) TiRect(sb.Append(",\"psc\":{"), sec.PscRect).Append(',').Append(sec.PscJson).Append('}');
        return sb.ToString();
    }

    static void TiDrawJson(StringBuilder sb, TiDrawRec d, int island)
    {
        sb.Append("{\"k\":\"").Append(d.K).Append('"');
        if (island >= 0) sb.Append(",\"c\":").Append(island.ToString(TiInv));
        if (d.K == 's') sb.Append(",\"st\":").Append(d.Style.ToString(TiInv));
        else if (d.K == 't') sb.Append(",\"tex\":").Append(d.Tex.ToString(TiInv));
        TiRect(sb.Append(','), d.R);
        TunerRectDrawJson(sb, d);
        if (d.K == 'c' || d.K == 'v')
        {
            TiVectorJson(sb, d);
            if ((d.Flags & TI_FLAG_OFF) != 0) sb.Append(",\"off\":1");
            if (d.Clip >= 0) sb.Append(",\"clip\":").Append(d.Clip.ToString(TiInv));
            sb.Append('}');
            return;
        }
        if (d.K == 's')
        {
            if (!string.IsNullOrEmpty(d.Text)) TiStr(sb.Append(",\"t\":"), d.Text);
            if (d.Img >= 0) sb.Append(",\"img\":").Append(d.Img.ToString(TiInv));
            if (!string.IsNullOrEmpty(d.Tip)) TiStr(sb.Append(",\"tip\":"), d.Tip);
            if (d.Id > 0) sb.Append(",\"id\":").Append(d.Id.ToString(TiInv));
            if ((d.Flags & TI_FLAG_ON) != 0) sb.Append(",\"on\":1");
            if ((d.Flags & TI_FLAG_HOVER) != 0) sb.Append(",\"hv\":1");
            if ((d.Flags & TI_FLAG_ACTIVE) != 0) sb.Append(",\"ac\":1");
            if ((d.Flags & TI_FLAG_FOCUS) != 0) sb.Append(",\"fc\":1");
            if (!TiWhite(d.Bg)) sb.Append(",\"bg\":\"").Append(TiHex(d.Bg)).Append('"');
            if (!TiWhite(d.Fg)) sb.Append(",\"fg\":\"").Append(TiHex(d.Fg)).Append('"');
            if ((d.Flags & TI_FLAG_TEXT) != 0)
            {
                TiNum(sb.Append(",\"sel\":["), d.Sel0.x);
                TiNum(sb.Append(','), d.Sel1.x).Append(']');
            }
        }
        else if (d.K == 't')
        {
            if (d.HasUv)
            {
                TiNum(sb.Append(",\"uv\":["), d.Uv.x);
                TiNum(sb.Append(','), d.Uv.y);
                TiNum(sb.Append(','), d.Uv.width);
                TiNum(sb.Append(','), d.Uv.height).Append(']');
            }
            if (!TiWhite(d.Bg)) sb.Append(",\"col\":\"").Append(TiHex(d.Bg)).Append('"');
            if (d.ScaleMode != 0) sb.Append(",\"sm\":").Append(d.ScaleMode.ToString(TiInv));
            if (d.Aspect > 0f) TiNum(sb.Append(",\"asp\":"), d.Aspect);
            if (d.Bw != Vector4.zero) TiVec4(sb.Append(",\"bw\":"), d.Bw);
            if (d.Br != Vector4.zero) TiVec4(sb.Append(",\"br\":"), d.Br);
            if (d.HasSlice) TiVec4(sb.Append(",\"sl\":"), d.Slice);
        }
        else
        {
            sb.Append(",\"col\":\"").Append(TiHex(d.Bg)).Append('"');
            if (d.Bw != Vector4.zero) TiVec4(sb.Append(",\"bw\":"), d.Bw);
            if (d.Br != Vector4.zero) TiVec4(sb.Append(",\"br\":"), d.Br);
        }
        if ((d.Flags & TI_FLAG_OFF) != 0) sb.Append(",\"off\":1");
        if (d.Clip >= 0) sb.Append(",\"clip\":").Append(d.Clip.ToString(TiInv));
        sb.Append('}');
    }

    static readonly StringBuilder s_TiSecSb = new StringBuilder();
    static readonly StringBuilder s_TiKeysSb = new StringBuilder();
    static readonly StringBuilder s_TiExtrasSb = new StringBuilder();
    static readonly StringBuilder s_TiOutSb = new StringBuilder();
    static char[] s_TiHashBuf = new char[1024];

    static void TiReleaseJsonBuffers()
    {
        foreach (var b in new[] { s_TiSecSb, s_TiKeysSb, s_TiExtrasSb, s_TiOutSb })
        {
            b.Clear();
            b.Capacity = 16;
        }
        s_TiHashBuf = new char[1024];
    }

    static ulong TiHash(StringBuilder a, StringBuilder b)
    {
        return TiHashMore(TiHashMore(1469598103934665603UL, a), b);
    }

    static ulong TiHashMore(ulong h, StringBuilder sb)
    {
        int n = sb.Length;
        if (s_TiHashBuf.Length < n) s_TiHashBuf = new char[Math.Max(n, s_TiHashBuf.Length * 2)];
        sb.CopyTo(0, s_TiHashBuf, 0, n);
        for (int i = 0; i < n; i++)
        {
            h ^= s_TiHashBuf[i];
            h *= 1099511628211UL;
        }
        return h;
    }

    static string TiCaptureJson(TiSession s, bool force, bool onlyIfChanged, bool asEvent = false)
    {
        if (s.Reset)
        {
            s.StyleIds.Clear();
            s.TexIds.Clear();
            s.NewStyles.Clear();
            s.NewTextures.Clear();
            s.SentHash.Clear();
            s.SentExtras = 0;
            s.UitkTextures.Clear();
            force = true;
        }
        var view = TiViewGuardBegin(s);
        TiEnsureBuilt(s);
        TiCapture(s);
        TiViewGuardEnd(s, view);
        long tpJson = TpNow();
        try { return TiCaptureJsonBody(s, force, onlyIfChanged, asEvent); }
        finally { TpAdd(TP_TI_JSON, tpJson); }
    }

    static string TiCaptureJsonBody(TiSession s, bool force, bool onlyIfChanged, bool asEvent)
    {
        s.Dirty = false;
        s.PaintAll = false;
        s.ChangedIds.Clear();
        s.LastDirtyCount = TiDirtyCount(s);
        if (s.RepaintAgain)
        {
            s.RepaintAgain = false;
            s.PaintAll = true;
            TiMarkDirty(s);
        }
        bool changed = force || s.NewStyles.Count > 0 || s.NewTextures.Count > 0;
        var sections = s_TiSecSb.Clear();
        var keys = s_TiKeysSb.Clear();
        for (int i = 0; i < s.Sections.Count; i++)
        {
            var sec = s.Sections[i];
            ulong prev;
            string body = null;
            ulong hash;
            bool same;
            if (!force && !sec.Painted && s.SentHash.TryGetValue(sec.Key, out prev))
            {
                hash = prev;
                same = true;
            }
            else
            {
                body = TiSectionBody(s, sec);
                hash = TiHash(body);
                same = !force && s.SentHash.TryGetValue(sec.Key, out prev) && prev == hash;
            }
            if (!same)
            {
                changed = true;
                s.SentHash[sec.Key] = hash;
            }
            if (i > 0) sections.Append(',');
            sections.Append("{\"key\":");
            TiStr(sections, sec.Key);
            sections.Append(",\"kind\":\"").Append(sec.Kind).Append('"');
            sections.Append(",\"ui\":\"").Append(sec.Uitk ? "uitk" : "imgui").Append('"');
            TiRect(sections.Append(','), sec.Bounds);
            sections.Append(",\"hash\":\"").Append(hash.ToString("x16")).Append('"');
            if (same) sections.Append(",\"same\":true");
            else sections.Append(body);
            sections.Append('}');
            keys.Append(sec.Key).Append('|');
            TiRect(keys, sec.Bounds).Append(';');
        }
        var extras = s_TiExtrasSb.Clear();
        extras.Append(",\"target\":");
        TiTargetJson(extras, s);
        if (s.Focus != null && s.Focus.Section != null)
        {
            var f = s.Focus;
            extras.Append(",\"focus\":{\"section\":");
            TiStr(extras, f.Section.Key);
            extras.Append(",\"control\":").Append(f.Control.ToString(TiInv)).Append(',');
            TiRect(extras, f.R);
            TiStr(extras.Append(",\"text\":"), f.Text ?? "");
            extras.Append(",\"style\":").Append(f.Style.ToString(TiInv));
            if (f.Numeric) extras.Append(",\"numeric\":true");
            if (f.Multiline) extras.Append(",\"multiline\":true");
            if (f.Password) extras.Append(",\"password\":true");
            if (f.Delayed) extras.Append(",\"delayed\":true");
            if (s.FocusEditing) extras.Append(",\"editing\":true");
            extras.Append('}');
        }
        TiPopupsJson(extras, s);
        TiOpensJson(extras, s);
        TiPingsJson(extras, s);
        if (s.Hot != 0) extras.Append(",\"hot\":true");
        extras.Append(",\"height\":").Append(s.Height.ToString(TiInv));
        extras.Append(",\"width\":").Append(s.Width.ToString(TiInv));
        var extrasHash = TiHash(extras, keys);
        if (extrasHash != s.SentExtras)
        {
            changed = true;
            s.SentExtras = extrasHash;
        }
        if (onlyIfChanged && !changed) return null;
        s.Seq++;
        var sb = s_TiOutSb.Clear();
        if (asEvent)
        {
            sb.Append("{\"type\":\"event\",\"event\":\"tunerInspector/capture\",\"session\":");
            TiStr(sb, s.Id);
            sb.Append(",\"capture\":");
        }
        sb.Append("{\"session\":");
        TiStr(sb, s.Id);
        sb.Append(",\"seq\":").Append(s.Seq.ToString(TiInv));
        if (s.Reset)
        {
            sb.Append(",\"reset\":true");
            TiStr(sb.Append(",\"fontDir\":"), TiFontDir());
        }
        TiNum(sb.Append(",\"ms\":"), (float)s.LastMs);
        sb.Append(extras);
        if (s.NewStyles.Count > 0)
        {
            sb.Append(",\"styles\":[");
            for (int i = 0; i < s.NewStyles.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(s.NewStyles[i]);
            }
            sb.Append(']');
            s.NewStyles.Clear();
        }
        if (s.NewTextures.Count > 0)
        {
            sb.Append(",\"textures\":[");
            for (int i = 0; i < s.NewTextures.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(s.NewTextures[i]);
            }
            sb.Append(']');
            s.NewTextures.Clear();
        }
        sb.Append(",\"sections\":[").Append(sections).Append("]}");
        if (asEvent) sb.Append('}');
        s.Reset = false;
        s.Opens.Clear();
        s.Pings.Clear();
        var json = sb.ToString();
        sb.Clear();
        sections.Clear();
        return json;
    }

    static void TiTargetJson(StringBuilder sb, TiSession s)
    {
        var spec = s.Spec;
        sb.Append("{\"kind\":\"").Append(spec.kind == "asset" ? "asset" : "object").Append('"');
        TiStr(sb.Append(",\"path\":"), spec.path);
        if (!string.IsNullOrEmpty(spec.scene)) TiStr(sb.Append(",\"scene\":"), spec.scene);
        var named = spec.kind == "asset" ? s.Asset : s.Go;
        if (named != null) TiStr(sb.Append(",\"name\":"), named.name);
        sb.Append(",\"found\":").Append(named != null ? "true" : "false");
        int shown, total;
        if (TiCountComponents(s, out shown, out total)) sb.Append(",\"components\":{\"shown\":").Append(shown.ToString(TiInv)).Append(",\"total\":").Append(total.ToString(TiInv)).Append('}');
        sb.Append(",\"playing\":").Append(EditorApplication.isPlaying ? "true" : "false");
        if (s.Error != null) TiStr(sb.Append(",\"error\":"), s.Error);
        sb.Append('}');
    }

    static string TiFontDir()
    {
        try { return System.IO.Path.Combine(EditorApplication.applicationContentsPath, "Resources", "Fonts").Replace('\\', '/'); }
        catch { return ""; }
    }
}
