using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.Events;
using UnityEngine.Rendering;
using UnityEngine.UI;

public static partial class MCPTestBridge
{
    const string TUNER_UI_CLIP_KEYWORD = "UNITY_UI_CLIP_RECT";
    const int TUNER_UI_MAX_MATS = 8;
    const int TUNER_UI_QUIET_CHECKS = 30;
    const int TUNER_UI_QUIET_STRIDE = 3;
    static readonly int TunerUiAlphaTexId = Shader.PropertyToID("_AlphaTex");
    static readonly int TunerUiSampleAddId = Shader.PropertyToID("_TextureSampleAdd");
    static readonly int TunerUiClipRectId = Shader.PropertyToID("_ClipRect");
    static readonly int TunerUiSoftXId = Shader.PropertyToID("_UIMaskSoftnessX");
    static readonly int TunerUiSoftYId = Shader.PropertyToID("_UIMaskSoftnessY");
    static readonly int TunerUiZTestId = Shader.PropertyToID("unity_GUIZTestMode");
    static readonly int TunerScreenParamsId = Shader.PropertyToID("_ScreenParams");
    static readonly int TunerUiViewClipId = Shader.PropertyToID("_SaturaTunerUiClip");
    static readonly int TunerUiStencilCompId = Shader.PropertyToID("_StencilComp");
    static readonly int TunerUiOutlineWidthId = Shader.PropertyToID("_OutlineWidth");
    static readonly Vector4 TunerUiNoViewClip = new Vector4(1f, 1f, -1f, -1f);
    static readonly ShaderTagId TunerLightModeTag = new ShaderTagId("LightMode");
    static readonly Dictionary<TunerSession, TunerUiState> _tunerUi = new Dictionary<TunerSession, TunerUiState>();
    static readonly Dictionary<Shader, int[]> _tunerUiPasses = new Dictionary<Shader, int[]>();
    static readonly Dictionary<RectMask2D, TunerUiClip> _tunerUiClips = new Dictionary<RectMask2D, TunerUiClip>();
    static readonly Dictionary<Mask, Vector4> _tunerUiMaskRects = new Dictionary<Mask, Vector4>();
    static readonly Dictionary<Material, int> _tunerUiCrc = new Dictionary<Material, int>();
    static readonly List<RectMask2D> _tunerUiMaskList = new List<RectMask2D>();
    static readonly List<Canvas> _tunerCanvasTmp = new List<Canvas>();
    static readonly List<Canvas> _tunerUiRootTmp = new List<Canvas>();
    static readonly List<RectMask2D> _tunerUiClipperTmp = new List<RectMask2D>();
    static readonly List<bool> _tunerUiBlockedTmp = new List<bool>();
    static readonly List<Mask> _tunerUiMaskTmp = new List<Mask>();
    static readonly List<TunerUiItem> _tunerUiGone = new List<TunerUiItem>();
    static readonly List<Vector3> _tunerUiPos = new List<Vector3>();
    static readonly List<Vector3> _tunerUiNrm = new List<Vector3>();
    static readonly List<Vector4> _tunerUiTan = new List<Vector4>();
    static readonly List<Color> _tunerUiCol = new List<Color>();
    static readonly List<int> _tunerUiPassTmp = new List<int>();
    static readonly Vector3[] _tunerUiCorners = new Vector3[4];
    static Mesh _tunerUiScratch;

    struct TunerUiClip
    {
        public bool Valid;
        public Vector4 Rect;
        public Vector2 Soft;
    }

    class TunerUiClipMat
    {
        public Material Mat;
        public int Crc;
    }

    class TunerUiRoot
    {
        public Canvas Canvas;
        public Transform T;
        public RectTransform Rect;
        public bool Overlay;
        public bool CullRect;
        public bool Active;
        public Matrix4x4 ToWorld;
        public Matrix4x4 ToCanvas;
        public Rect Bounds;
        public int Graphics;
    }

    class TunerUiItem
    {
        public Graphic G;
        public TMP_Text Owner;
        public bool Text;
        public UnityAction OnDirty;
        public bool Dirty = true;
        public bool Seen;
        public Mesh Source;
        public int SourceCount = -1;
        public Bounds SourceBounds;
        public readonly List<Vector3> Pos = new List<Vector3>();
        public readonly List<Vector3> Nrm = new List<Vector3>();
        public readonly List<Vector4> Tan = new List<Vector4>();
        public readonly List<Color32> Col = new List<Color32>();
        public readonly List<Vector4>[] Uv = new List<Vector4>[4];
        public readonly List<List<int>> Sub = new List<List<int>>();
        public Mesh Baked;
        public bool Fresh = true;
        public Matrix4x4 Rel;
        public Color Tint;
        public bool Linear;
        public bool Clear;
        public uint Version;
        public TunerUiRoot Root;
        public RectMask2D[] Clippers;
        public bool[] Blocked;
        public Mask[] Masks;
        public Mask OwnMask;
        public readonly Material[] Mats = new Material[TUNER_UI_MAX_MATS];
        public int MatCount;
        public readonly Material[] Pops = new Material[TUNER_UI_MAX_MATS];
        public int PopCount;
        public Texture Tex;
        public Texture AlphaTex;
        public Vector4 SampleAdd;
        public bool Clipped;
        public Vector4 Clip;
        public Vector2 Soft;
        public Vector4 ViewClip;
        public bool StencilOnly;
        public TunerDraw Draw;
    }

    class TunerUiState
    {
        public readonly List<TunerUiRoot> Roots = new List<TunerUiRoot>();
        public readonly List<TunerDraw> Pops = new List<TunerDraw>();
        public readonly Dictionary<Graphic, TunerUiItem> Items = new Dictionary<Graphic, TunerUiItem>();
        public readonly Dictionary<TMP_Text, List<TunerUiItem>> ByText = new Dictionary<TMP_Text, List<TunerUiItem>>();
        public readonly Dictionary<Material, TunerUiClipMat> ClipMats = new Dictionary<Material, TunerUiClipMat>();
        public MaterialPropertyBlock Mpb;
        public string RootReport;
        public string DrawReport;
        public ulong DrawSig;
        public int Baked;
        public double PrepareMs;
        public double PrepareMax;
        public int Prepares;
        public int Skipped;
        public ulong LastHash;
        public int Unchanged;
        public int Stride;
        public bool Poke;
    }

    static TunerUiState TunerUiOf(TunerSession s)
    {
        TunerUiState u;
        if (_tunerUi.TryGetValue(s, out u)) return u;
        u = new TunerUiState();
        _tunerUi[s] = u;
        return u;
    }

    static bool TunerHasUi(TunerSession s)
    {
        TunerUiState u;
        return _tunerUi.TryGetValue(s, out u) && u.Roots.Count > 0;
    }

    static Canvas TunerRootCanvasOf(Transform t)
    {
        Canvas top = t != null ? t.GetComponentInParent<Canvas>(true) : null;
        if (top == null) return null;
        for (var p = top.transform.parent; p != null; p = p.parent)
        {
            var c = p.GetComponent<Canvas>();
            if (c != null) top = c;
        }
        return top;
    }

    static void AddTunerUiRoot(Canvas c, List<Canvas> roots)
    {
        if (c != null && !roots.Contains(c)) roots.Add(c);
    }

    static void TunerCanvases(int id, ControlClient from)
    {
        var sb = new StringBuilder("\"canvases\":[");
        bool first = true;
        foreach (var sc in TunerScenes())
        {
            var roots = TunerRootsOf(sc);
            if (roots == null) continue;
            foreach (var root in roots.Gos)
            {
                if (root == null || (root.hideFlags & HideFlags.HideInHierarchy) != 0 || SaturaEngineObjects.Contains(root)) continue;
                root.GetComponentsInChildren(true, _tunerCanvasTmp);
                foreach (var c in _tunerCanvasTmp)
                {
                    if (c == null || TunerRootCanvasOf(c.transform) != c || (c.gameObject.hideFlags & HideFlags.HideInHierarchy) != 0) continue;
                    var mode = c.renderMode == RenderMode.WorldSpace ? "world" : c.renderMode == RenderMode.ScreenSpaceCamera && c.worldCamera != null ? "camera" : "overlay";
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append("{\"name\":").Append(JStr(c.name))
                      .Append(",\"path\":").Append(JStr(TunerObjectPath(c.gameObject)))
                      .Append(",\"scene\":").Append(JStr(sc.name ?? ""))
                      .Append(",\"mode\":\"").Append(mode).Append("\"}");
                }
                _tunerCanvasTmp.Clear();
            }
        }
        sb.Append(']');
        TunerResult(from, id, null, sb.ToString());
    }

    static void CollectTunerCanvases(TunerSession s, Dictionary<Component, int> index)
    {
        var ui = TunerUiOf(s);
        var roots = _tunerUiRootTmp;
        roots.Clear();
        foreach (var oi in TunerActiveObjects(s))
        {
            var go = oi < s.Objects.Length ? s.Objects[oi] : null;
            if (go == null) continue;
            AddTunerUiRoot(TunerRootCanvasOf(go.transform), roots);
            go.GetComponentsInChildren(true, _tunerCanvasTmp);
            foreach (var c in _tunerCanvasTmp)
                if (c != null) AddTunerUiRoot(TunerRootCanvasOf(c.transform), roots);
            _tunerCanvasTmp.Clear();
        }
        foreach (var go in TunerSceneRoots(s))
        {
            go.GetComponentsInChildren(true, _tunerCanvasTmp);
            foreach (var c in _tunerCanvasTmp)
            {
                var top = c != null ? TunerRootCanvasOf(c.transform) : null;
                if (top != null && (top.renderMode == RenderMode.WorldSpace || s.Prefabs != null)) AddTunerUiRoot(top, roots);
            }
            _tunerCanvasTmp.Clear();
        }
        foreach (var item in ui.Items.Values) item.Seen = false;
        ui.Unchanged = 0;
        ui.Roots.Clear();
        ui.Pops.Clear();
        ui.ByText.Clear();
        int rank = 1;
        foreach (var c in roots)
        {
            var root = new TunerUiRoot
            {
                Canvas = c,
                T = c.transform,
                Rect = c.transform as RectTransform,
                Overlay = c.renderMode == RenderMode.ScreenSpaceOverlay || (c.renderMode == RenderMode.ScreenSpaceCamera && c.worldCamera == null),
                CullRect = c.renderMode != RenderMode.WorldSpace
            };
            ui.Roots.Add(root);
            WalkTunerCanvas(s, ui, root, root.T, index, ref rank);
        }
        roots.Clear();
        foreach (var kv in ui.Items)
            if (!kv.Value.Seen) _tunerUiGone.Add(kv.Value);
        foreach (var item in _tunerUiGone)
        {
            ui.Items.Remove(item.G);
            DisposeTunerUiItem(item);
        }
        _tunerUiGone.Clear();
        var stale = new List<Material>();
        foreach (var kv in ui.ClipMats)
            if (kv.Key == null)
            {
                stale.Add(kv.Key);
                if (kv.Value.Mat != null) UnityEngine.Object.DestroyImmediate(kv.Value.Mat);
            }
        foreach (var m in stale) ui.ClipMats.Remove(m);
        if (ui.Roots.Count > 0) HookTunerText();
        var sb = new StringBuilder();
        foreach (var r in ui.Roots)
            sb.Append(sb.Length == 0 ? "" : ", ").Append(r.Canvas.name).Append('(').Append(r.Canvas.renderMode).Append(", ")
              .Append(r.Graphics.ToString(Inv)).Append(" graphics)");
        LogTunerViewChange(s, ref ui.RootReport, ui.Roots.Count == 0 ? null : "ui canvases: " + sb);
    }

    static void WalkTunerCanvas(TunerSession s, TunerUiState ui, TunerUiRoot root, Transform t, Dictionary<Component, int> index, ref int rank)
    {
        var g = t.GetComponent<Graphic>();
        int at = -1;
        if (g != null && !index.ContainsKey(g) && t.TryGetComponent<CanvasRenderer>(out _))
        {
            at = AddTunerUiGraphic(s, ui, root, g, rank++);
            index[g] = at;
            root.Graphics++;
        }
        for (int i = 0; i < t.childCount; i++) WalkTunerCanvas(s, ui, root, t.GetChild(i), index, ref rank);
        if (at >= 0 && t.childCount > 0)
        {
            var e = s.Rends[at];
            e.PopRank = rank++;
            ui.Pops.Add(new TunerDraw { Rend = e, Pop = true, Transparent = true, Flat = true, VertexColor = true, Cutoff = -1f, ColorId = -1, TexId = -1, St = TunerNoSt, Color = Color.white });
        }
    }

    static int AddTunerUiGraphic(TunerSession s, TunerUiState ui, TunerUiRoot root, Graphic g, int rank)
    {
        TunerUiItem u;
        if (!ui.Items.TryGetValue(g, out u))
        {
            u = new TunerUiItem { G = g };
            var tmp = g as TMP_Text;
            var sub = g as TMP_SubMeshUI;
            u.Text = tmp != null || sub != null;
            if (!u.Text)
            {
                var item = u;
                u.OnDirty = () =>
                {
                    item.Dirty = true;
                    ui.Poke = true;
                };
                g.RegisterDirtyVerticesCallback(u.OnDirty);
            }
            ui.Items[g] = u;
        }
        u.Seen = true;
        u.Root = root;
        if (u.Text)
        {
            var sub = g as TMP_SubMeshUI;
            u.Owner = g as TMP_Text ?? (sub != null ? sub.textComponent : null);
            if (u.Owner != null)
            {
                List<TunerUiItem> list;
                if (!ui.ByText.TryGetValue(u.Owner, out list)) ui.ByText[u.Owner] = list = new List<TunerUiItem>();
                list.Add(u);
            }
        }
        FindTunerUiClippers(u, g.transform, root.T);
        var canvas = g.GetComponentInParent<Canvas>(true);
        var e = new TunerRend
        {
            Kind = TunerKind.Graphic,
            Go = g.gameObject,
            T = g.transform,
            G = g,
            Tmp = g as TMP_Text,
            TmpSub = g as TMP_SubMeshUI,
            Rect = g.rectTransform,
            Canvas = canvas,
            SortCanvas = TunerSortingCanvas(canvas),
            Overlay = root.Overlay,
            Rank = rank,
            Ui = u,
            Shown = u.Baked
        };
        s.Rends.Add(e);
        u.Draw = new TunerDraw
        {
            Rend = e,
            Transparent = true,
            Flat = true,
            VertexColor = true,
            Cutoff = -1f,
            ColorId = -1,
            TexId = -1,
            St = TunerNoSt,
            Color = Color.white
        };
        s.Draws.Add(u.Draw);
        return s.Rends.Count - 1;
    }

    static void FindTunerUiClippers(TunerUiItem u, Transform self, Transform top)
    {
        _tunerUiClipperTmp.Clear();
        _tunerUiBlockedTmp.Clear();
        _tunerUiMaskTmp.Clear();
        bool crossed = false;
        for (var p = self; p != null; p = p.parent)
        {
            if (p != self)
            {
                var rm = p.GetComponent<RectMask2D>();
                if (rm != null)
                {
                    _tunerUiClipperTmp.Add(rm);
                    _tunerUiBlockedTmp.Add(crossed);
                }
                var mk = p.GetComponent<Mask>();
                if (mk != null) _tunerUiMaskTmp.Add(mk);
            }
            var c = p.GetComponent<Canvas>();
            if (c != null && c.overrideSorting) crossed = true;
            if (p == top) break;
        }
        u.Clippers = _tunerUiClipperTmp.Count > 0 ? _tunerUiClipperTmp.ToArray() : null;
        u.Blocked = _tunerUiBlockedTmp.Count > 0 ? _tunerUiBlockedTmp.ToArray() : null;
        u.Masks = _tunerUiMaskTmp.Count > 0 ? _tunerUiMaskTmp.ToArray() : null;
        u.OwnMask = self.GetComponent<Mask>();
        _tunerUiClipperTmp.Clear();
        _tunerUiBlockedTmp.Clear();
        _tunerUiMaskTmp.Clear();
    }

    static void DisposeTunerUiItem(TunerUiItem u)
    {
        if (u.OnDirty != null && !ReferenceEquals(u.G, null))
        {
            try { u.G.UnregisterDirtyVerticesCallback(u.OnDirty); }
            catch { }
        }
        u.OnDirty = null;
        if (u.Baked != null) UnityEngine.Object.DestroyImmediate(u.Baked);
        u.Baked = null;
    }

    static void DisposeTunerUi(TunerSession s)
    {
        TunerUiState ui;
        if (!_tunerUi.TryGetValue(s, out ui)) return;
        _tunerUi.Remove(s);
        foreach (var u in ui.Items.Values) DisposeTunerUiItem(u);
        ui.Items.Clear();
        foreach (var v in ui.ClipMats.Values)
            if (v.Mat != null) UnityEngine.Object.DestroyImmediate(v.Mat);
        ui.ClipMats.Clear();
        ui.Roots.Clear();
        ui.Pops.Clear();
        ui.ByText.Clear();
    }

    static void MarkTunerTextDirty(TMP_Text t)
    {
        foreach (var ui in _tunerUi.Values)
        {
            List<TunerUiItem> list;
            if (!ui.ByText.TryGetValue(t, out list)) continue;
            foreach (var u in list) u.Dirty = true;
            ui.Poke = true;
        }
    }

    static bool TunerPopulateReady()
    {
        if (_tunerPopulateKnown) return _tunerPopulate != null;
        _tunerPopulateKnown = true;
        _tunerPopulate = typeof(Graphic).GetMethod("OnPopulateMesh", BindingFlags.Instance | BindingFlags.NonPublic, null,
            new[] { typeof(VertexHelper) }, null);
        if (_tunerPopulate == null) Debug.LogWarning("[Tuner] Graphic.OnPopulateMesh(VertexHelper) was not found, UI is not drawn");
        return _tunerPopulate != null;
    }

    static void ReadTunerUiMesh(TunerUiItem u, Mesh m)
    {
        if (m == null || m.vertexCount == 0)
        {
            u.Pos.Clear();
            u.Sub.Clear();
            return;
        }
        m.GetVertices(u.Pos);
        m.GetNormals(u.Nrm);
        m.GetTangents(u.Tan);
        m.GetColors(u.Col);
        for (int c = 0; c < 4; c++)
        {
            if (m.HasVertexAttribute(VertexAttribute.TexCoord0 + c))
            {
                if (u.Uv[c] == null) u.Uv[c] = new List<Vector4>();
                m.GetUVs(c, u.Uv[c]);
            }
            else if (u.Uv[c] != null) u.Uv[c].Clear();
        }
        int subs = m.subMeshCount;
        while (u.Sub.Count < subs) u.Sub.Add(new List<int>());
        while (u.Sub.Count > subs) u.Sub.RemoveAt(u.Sub.Count - 1);
        for (int k = 0; k < subs; k++) m.GetIndices(u.Sub[k], k);
    }

    static readonly Dictionary<Type, bool> _tunerUiNoGeometry = new Dictionary<Type, bool>();

    static bool TunerGraphicSkipsGeometry(Type t)
    {
        bool skip;
        if (_tunerUiNoGeometry.TryGetValue(t, out skip)) return skip;
        skip = false;
        try
        {
            var m = t.GetMethod("SetVerticesDirty", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
            if (m != null && m.DeclaringType != typeof(Graphic) && m.DeclaringType.Assembly != typeof(Graphic).Assembly)
            {
                var il = m.GetMethodBody()?.GetILAsByteArray();
                if (il != null && il.Length > 0 && il[il.Length - 1] == 0x2A)
                {
                    skip = true;
                    for (int i = 0; i < il.Length - 1; i++)
                        if (il[i] != 0x00) skip = false;
                }
            }
        }
        catch (Exception) { skip = false; }
        _tunerUiNoGeometry[t] = skip;
        if (skip) SaturaDebug.Log("[Tuner] " + t.FullName + " never builds UI geometry (its SetVerticesDirty does nothing), so it is not drawn, as in Unity");
        return skip;
    }

    static void PopulateTunerUi(TunerUiItem u, Graphic g)
    {
        if (!TunerPopulateReady() || TunerGraphicSkipsGeometry(g.GetType()))
        {
            u.Pos.Clear();
            u.Sub.Clear();
            return;
        }
        var vh = _tunerVh ?? (_tunerVh = new VertexHelper());
        vh.Clear();
        try
        {
            var rect = g.rectTransform.rect;
            if (rect.width >= 0f && rect.height >= 0f)
            {
                _tunerPopulateArgs[0] = vh;
                _tunerPopulate.Invoke(g, _tunerPopulateArgs);
            }
            g.GetComponents(typeof(IMeshModifier), _tunerModTmp);
            foreach (var c in _tunerModTmp) ((IMeshModifier)c).ModifyMesh(vh);
        }
        catch (Exception ex)
        {
            vh.Clear();
            if (!_tunerPopulateWarned)
            {
                _tunerPopulateWarned = true;
                var inner = ex is TargetInvocationException && ex.InnerException != null ? ex.InnerException : ex;
                Debug.LogWarning("[Tuner] could not build the UI mesh of " + g.name + ": " + inner.GetType().Name + ": " + inner.Message);
            }
        }
        finally
        {
            _tunerModTmp.Clear();
            _tunerPopulateArgs[0] = null;
        }
        if (_tunerUiScratch == null) _tunerUiScratch = new Mesh { name = "_SaturaTunerUiScratch", hideFlags = HideFlags.HideAndDontSave };
        vh.FillMesh(_tunerUiScratch);
        vh.Clear();
        ReadTunerUiMesh(u, _tunerUiScratch);
    }

    static bool RefreshTunerUiSource(TunerUiItem u, Graphic g)
    {
        if (!u.Text)
        {
            if (!u.Dirty) return false;
            u.Dirty = false;
            PopulateTunerUi(u, g);
            u.Fresh = true;
            return true;
        }
        var tmp = g as TMP_Text;
        var sub = g as TMP_SubMeshUI;
        var m = tmp != null ? tmp.mesh : sub != null ? sub.mesh : null;
        int n = m != null ? m.vertexCount : 0;
        var b = m != null ? m.bounds : default;
        if (!u.Dirty && ReferenceEquals(m, u.Source) && n == u.SourceCount && b == u.SourceBounds) return false;
        u.Dirty = false;
        u.Source = m;
        u.SourceCount = n;
        u.SourceBounds = b;
        ReadTunerUiMesh(u, m);
        u.Fresh = true;
        return true;
    }

    static void BakeTunerUi(TunerUiItem u, Matrix4x4 rel, Color tint, bool linear)
    {
        var mesh = u.Baked;
        if (mesh == null) u.Baked = mesh = new Mesh { name = "_SaturaTunerUi", hideFlags = HideFlags.HideAndDontSave };
        mesh.Clear();
        int n = u.Pos.Count;
        bool clear = true;
        if (n > 0)
        {
            var pos = _tunerUiPos;
            pos.Clear();
            for (int i = 0; i < n; i++) pos.Add(rel.MultiplyPoint3x4(u.Pos[i]));
            mesh.indexFormat = n > 65535 ? IndexFormat.UInt32 : IndexFormat.UInt16;
            mesh.SetVertices(pos);
            pos.Clear();
            if (u.Nrm.Count == n)
            {
                var nrm = _tunerUiNrm;
                nrm.Clear();
                for (int i = 0; i < n; i++) nrm.Add(rel.MultiplyVector(u.Nrm[i]).normalized);
                mesh.SetNormals(nrm);
                nrm.Clear();
            }
            if (u.Tan.Count == n)
            {
                var tan = _tunerUiTan;
                tan.Clear();
                for (int i = 0; i < n; i++)
                {
                    var t = u.Tan[i];
                    var v = rel.MultiplyVector(new Vector3(t.x, t.y, t.z)).normalized;
                    tan.Add(new Vector4(v.x, v.y, v.z, t.w));
                }
                mesh.SetTangents(tan);
                tan.Clear();
            }
            var col = _tunerUiCol;
            col.Clear();
            bool hasCol = u.Col.Count == n;
            for (int i = 0; i < n; i++)
            {
                var c = (hasCol ? (Color)u.Col[i] : Color.white) * tint;
                if (linear) c = c.linear;
                if (c.a > 0.001f) clear = false;
                col.Add(c);
            }
            mesh.SetColors(col);
            col.Clear();
            for (int ch = 0; ch < 4; ch++)
                if (u.Uv[ch] != null && u.Uv[ch].Count == n) mesh.SetUVs(ch, u.Uv[ch]);
            mesh.subMeshCount = Math.Max(1, u.Sub.Count);
            for (int k = 0; k < u.Sub.Count; k++) mesh.SetIndices(u.Sub[k], MeshTopology.Triangles, k, false);
            mesh.RecalculateBounds();
        }
        u.Rel = rel;
        u.Tint = tint;
        u.Linear = linear;
        u.Clear = clear;
        u.Fresh = false;
        u.Version++;
    }

    static TunerUiClip TunerUiClipOf(TunerUiRoot root, RectMask2D rm)
    {
        TunerUiClip c;
        if (_tunerUiClips.TryGetValue(rm, out c)) return c;
        MaskUtilities.GetRectMasksForClip(rm, _tunerUiMaskList);
        bool valid;
        var r = Clipping.FindCullAndClipWorldRect(_tunerUiMaskList, out valid);
        _tunerUiMaskList.Clear();
        if (valid && root.CullRect && !r.Overlaps(root.Bounds, true)) valid = false;
        var soft = rm.softness;
        c = new TunerUiClip { Valid = valid, Rect = new Vector4(r.xMin, r.yMin, r.xMax, r.yMax), Soft = new Vector2(soft.x, soft.y) };
        _tunerUiClips[rm] = c;
        return c;
    }

    static Vector4 TunerUiMaskRect(TunerUiRoot root, Mask mk)
    {
        Vector4 r;
        if (_tunerUiMaskRects.TryGetValue(mk, out r)) return r;
        mk.rectTransform.GetWorldCorners(_tunerUiCorners);
        float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
        for (int k = 0; k < 4; k++)
        {
            var p = root.ToCanvas.MultiplyPoint3x4(_tunerUiCorners[k]);
            x0 = Mathf.Min(x0, p.x);
            y0 = Mathf.Min(y0, p.y);
            x1 = Mathf.Max(x1, p.x);
            y1 = Mathf.Max(y1, p.y);
        }
        r = new Vector4(x0, y0, x1, y1);
        _tunerUiMaskRects[mk] = r;
        return r;
    }

    static int TunerMaterialCrc(Material m)
    {
        int crc;
        if (_tunerUiCrc.TryGetValue(m, out crc)) return crc;
        crc = m.ComputeCRC();
        _tunerUiCrc[m] = crc;
        return crc;
    }

    static ulong MixTunerMaterial(ulong h, Material m)
    {
        h = TunerMix(h, m);
        return m != null ? TunerMix(h, unchecked((uint)TunerMaterialCrc(m))) : h;
    }

    static ulong PrepareTunerUi(TunerSession s, ulong h, double now)
    {
        TunerUiState ui;
        if (!_tunerUi.TryGetValue(s, out ui) || ui.Roots.Count == 0) return h;
        if (ui.Unchanged >= TUNER_UI_QUIET_CHECKS && !ui.Poke && !s.Dirty && ++ui.Stride % TUNER_UI_QUIET_STRIDE != 0)
        {
            ui.Skipped++;
            return TunerMix(TunerMix(h, (uint)ui.LastHash), (uint)(ui.LastHash >> 32));
        }
        ui.Poke = false;
        var outer = h;
        h = TUNER_HASH_SEED;
        long start = System.Diagnostics.Stopwatch.GetTimestamp();
        bool linear = QualitySettings.activeColorSpace == ColorSpace.Linear;
        _tunerUiClips.Clear();
        _tunerUiMaskRects.Clear();
        _tunerUiCrc.Clear();
        foreach (var root in ui.Roots)
        {
            root.Active = root.Canvas != null && root.Canvas.isActiveAndEnabled;
            h = TunerMix(h, root.Active ? 1u : 0u);
            if (!root.Active) continue;
            root.ToWorld = root.T.localToWorldMatrix;
            root.ToCanvas = root.T.worldToLocalMatrix;
            root.Bounds = root.Rect != null ? root.Rect.rect : default;
            h = TunerMix(h, root.ToWorld);
        }
        ulong sig = 14695981039346656037UL;
        int baked = 0;
        foreach (var e in s.Rends)
        {
            if (e.Kind != TunerKind.Graphic) continue;
            var u = e.Ui;
            var g = e.G;
            if (g == null || u.Root.Canvas == null)
            {
                e.Active = false;
                s.CacheDirty = true;
                continue;
            }
            var cr = g.canvasRenderer;
            bool vis = u.Root.Active && g.isActiveAndEnabled && e.Canvas != null && e.Canvas.isActiveAndEnabled && cr != null;
            e.Active = false;
            if (!vis)
            {
                h = TunerMix(h, 0u);
                continue;
            }
            RefreshTunerUiSource(u, g);
            var tint = cr.GetColor();
            tint.a *= cr.GetInheritedAlpha();
            var rel = u.Root.ToCanvas * e.T.localToWorldMatrix;
            if (u.Fresh || rel != u.Rel || tint != u.Tint || linear != u.Linear)
            {
                BakeTunerUi(u, rel, tint, linear);
                baked++;
            }
            e.Shown = u.Baked;
            if (u.Baked == null || u.Pos.Count == 0 || (cr.cullTransparentMesh && u.Clear))
            {
                h = TunerMix(h, 2u);
                continue;
            }
            int mc = Math.Min(cr.materialCount, TUNER_UI_MAX_MATS);
            u.MatCount = 0;
            for (int i = 0; i < mc; i++) u.Mats[u.MatCount++] = cr.GetMaterial(i);
            if (u.MatCount == 0 || u.Mats[0] == null)
            {
                u.Mats[0] = g.materialForRendering;
                u.MatCount = 1;
            }
            int pc = Math.Min(cr.popMaterialCount, TUNER_UI_MAX_MATS);
            u.PopCount = 0;
            for (int i = 0; i < pc; i++) u.Pops[u.PopCount++] = cr.GetPopMaterial(i);
            u.Tex = u.Text ? null : g.mainTexture;
            var img = g as Image;
            var sp = img != null ? img.overrideSprite : null;
            u.AlphaTex = sp != null ? sp.associatedAlphaSplitTexture : null;
            var t2 = u.Tex as Texture2D;
            u.SampleAdd = t2 != null && t2.format == TextureFormat.Alpha8 ? TunerAlphaAdd : Vector4.zero;
            bool hidden = false;
            u.Clipped = false;
            u.Soft = Vector2.zero;
            var mg = g as MaskableGraphic;
            if (mg != null && mg.maskable && u.Clippers != null)
                for (int k = 0; k < u.Clippers.Length; k++)
                {
                    var rm = u.Clippers[k];
                    if (rm == null || !rm.isActiveAndEnabled) continue;
                    if (!u.Blocked[k])
                    {
                        var c = TunerUiClipOf(u.Root, rm);
                        if (!c.Valid) hidden = true;
                        else
                        {
                            u.Clipped = true;
                            u.Clip = c.Rect;
                            u.Soft = c.Soft;
                        }
                    }
                    break;
                }
            if (hidden)
            {
                h = TunerMix(h, 3u);
                continue;
            }
            var view = u.Clipped ? u.Clip : new Vector4(float.MinValue, float.MinValue, float.MaxValue, float.MaxValue);
            bool viewClip = u.Clipped;
            if (mg != null && mg.maskable && u.Masks != null)
                foreach (var mk in u.Masks)
                {
                    if (mk == null || !mk.isActiveAndEnabled || !mk.MaskEnabled()) continue;
                    var r = TunerUiMaskRect(u.Root, mk);
                    view = new Vector4(Mathf.Max(view.x, r.x), Mathf.Max(view.y, r.y), Mathf.Min(view.z, r.z), Mathf.Min(view.w, r.w));
                    viewClip = true;
                }
            u.ViewClip = viewClip ? view : TunerUiNoViewClip;
            u.StencilOnly = u.OwnMask != null && u.OwnMask.isActiveAndEnabled && !u.OwnMask.showMaskGraphic;
            e.Active = true;
            h = TunerMix(h, 1u);
            h = TunerMix(h, u.Version);
            for (int i = 0; i < u.MatCount; i++)
            {
                h = MixTunerMaterial(h, u.Mats[i]);
                sig = TunerMix(sig, u.Mats[i]);
            }
            for (int i = 0; i < u.PopCount; i++)
            {
                h = MixTunerMaterial(h, u.Pops[i]);
                sig = TunerMix(sig, u.Pops[i]);
            }
            h = TunerMix(h, u.Tex);
            h = TunerMix(h, u.AlphaTex);
            if (u.Clipped)
            {
                h = TunerMix(h, u.Clip.x);
                h = TunerMix(h, u.Clip.y);
                h = TunerMix(h, u.Clip.z);
                h = TunerMix(h, u.Clip.w);
                h = TunerMix(h, u.Soft.x);
                h = TunerMix(h, u.Soft.y);
            }
            sig = TunerMix(sig, u.Clipped ? 1u : 0u);
            sig = TunerMix(sig, u.StencilOnly ? 1u : 0u);
            TunerUiViewDraw(u);
        }
        ui.Baked += baked;
        if (sig != ui.DrawSig)
        {
            ui.DrawSig = sig;
            LogTunerViewChange(s, ref ui.DrawReport, "ui draw: " + DescribeTunerUi(s));
        }
        double ms = TunerMs(System.Diagnostics.Stopwatch.GetTimestamp() - start);
        ui.PrepareMs += ms;
        ui.Prepares++;
        if (ms > ui.PrepareMax) ui.PrepareMax = ms;
        if (h == ui.LastHash) ui.Unchanged++;
        else
        {
            ui.Unchanged = 0;
            ui.LastHash = h;
        }
        return TunerMix(TunerMix(outer, (uint)h), (uint)(h >> 32));
    }

    static void TunerUiViewDraw(TunerUiItem u)
    {
        var d = u.Draw;
        if (d == null) return;
        d.Matrix = u.Root.ToWorld;
        d.Color = Color.white;
        var m = u.MatCount > 0 ? u.Mats[0] : null;
        d.Sdf = u.Text && m != null && m.HasProperty(TunerGradientScaleId);
        d.Tex = u.Text ? (m != null && m.HasProperty(TunerMainTexId) ? m.GetTexture(TunerMainTexId) : null) : u.Tex;
        d.TexAdd = d.Sdf ? Vector4.zero : u.SampleAdd;
    }

    static string DescribeTunerUi(TunerSession s)
    {
        var shaders = new Dictionary<string, int>();
        var kws = new SortedSet<string>();
        int graphics = 0, stencil = 0, clipped = 0, pops = 0, hiddenMasks = 0;
        float outline = 0f;
        foreach (var e in s.Rends)
        {
            if (e.Kind != TunerKind.Graphic || !e.Active) continue;
            var u = e.Ui;
            graphics++;
            if (u.Clipped) clipped++;
            if (u.PopCount > 0) pops++;
            if (u.StencilOnly) hiddenMasks++;
            for (int i = 0; i < u.MatCount; i++)
            {
                var m = u.Mats[i];
                if (m == null) continue;
                int n;
                shaders.TryGetValue(m.shader.name, out n);
                shaders[m.shader.name] = n + 1;
                if (m.HasProperty(TunerUiStencilCompId) && Mathf.RoundToInt(m.GetFloat(TunerUiStencilCompId)) != (int)CompareFunction.Always) stencil++;
                if (m.HasProperty(TunerUiOutlineWidthId)) outline = Mathf.Max(outline, m.GetFloat(TunerUiOutlineWidthId));
                foreach (var k in m.shaderKeywords)
                    if (k == "OUTLINE_ON" || k == "UNDERLAY_ON" || k == "UNDERLAY_INNER" || k == "GLOW_ON" || k == "BEVEL_ON") kws.Add(k);
            }
        }
        var sb = new StringBuilder();
        sb.Append(graphics.ToString(Inv)).Append(" graphics, shaders ");
        bool first = true;
        foreach (var kv in shaders)
        {
            sb.Append(first ? "" : ", ").Append(kv.Key).Append(" x").Append(kv.Value.ToString(Inv));
            first = false;
        }
        sb.Append(", keywords [").Append(string.Join(" ", kws)).Append("], text outline ").Append(outline.ToString("0.###", Inv)).Append(", stencil-tested ").Append(stencil.ToString(Inv))
          .Append(", masks ").Append(pops.ToString(Inv)).Append(" (hidden graphic ").Append(hiddenMasks.ToString(Inv)).Append("), rect-clipped ")
          .Append(clipped.ToString(Inv));
        return sb.ToString();
    }

    static bool TunerUiReady(TunerDraw d)
    {
        var e = d.Rend;
        var u = e.Ui;
        if (!e.Active || u == null || u.Baked == null || u.Baked.vertexCount == 0) return false;
        return d.Pop ? u.PopCount > 0 : u.MatCount > 0;
    }

    static int[] TunerUiPasses(Shader sh)
    {
        int[] list;
        if (_tunerUiPasses.TryGetValue(sh, out list)) return list;
        _tunerUiPassTmp.Clear();
        for (int p = 0; p < sh.passCount; p++)
        {
            var lm = sh.FindPassTagValue(p, TunerLightModeTag).name;
            if (string.IsNullOrEmpty(lm) || lm == "Always" || lm == "ForwardBase" || lm == "Vertex" || lm == "SRPDefaultUnlit" || lm == "UniversalForward"
                || lm == "UniversalForwardOnly") _tunerUiPassTmp.Add(p);
        }
        if (_tunerUiPassTmp.Count == 0) _tunerUiPassTmp.Add(0);
        list = _tunerUiPassTmp.ToArray();
        _tunerUiPassTmp.Clear();
        _tunerUiPasses[sh] = list;
        return list;
    }

    static Material TunerUiClipVariant(TunerUiState ui, Material src)
    {
        TunerUiClipMat v;
        int crc = TunerMaterialCrc(src);
        if (!ui.ClipMats.TryGetValue(src, out v) || v.Mat == null)
        {
            v = new TunerUiClipMat { Mat = new Material(src) { name = src.name + " (Satura clip)", hideFlags = HideFlags.HideAndDontSave }, Crc = crc };
            v.Mat.EnableKeyword(TUNER_UI_CLIP_KEYWORD);
            ui.ClipMats[src] = v;
            return v.Mat;
        }
        if (v.Crc != crc || v.Mat.shader != src.shader)
        {
            if (v.Mat.shader != src.shader) v.Mat.shader = src.shader;
            v.Mat.CopyPropertiesFromMaterial(src);
            v.Mat.shaderKeywords = src.shaderKeywords;
            v.Mat.EnableKeyword(TUNER_UI_CLIP_KEYWORD);
            v.Crc = crc;
        }
        return v.Mat;
    }

    static void BeginTunerUi(TunerSession s, CommandBuffer cmd, int w, int h)
    {
        if (!TunerHasUi(s) && !s.RealText) return;
        cmd.SetGlobalVector(TunerScreenParamsId, new Vector4(w, h, 1f + 1f / w, 1f + 1f / h));
        cmd.SetGlobalFloat(TunerUiZTestId, (float)CompareFunction.LessEqual);
        cmd.SetGlobalVector(TunerCameraPosId, new Vector4(s.CamPos.x, s.CamPos.y, s.CamPos.z, 1f));
    }

    static void RecordTunerUi(TunerSession s, CommandBuffer cmd, TunerDraw d)
    {
        var ui = TunerUiOf(s);
        var e = d.Rend;
        var u = e.Ui;
        var mesh = u.Baked;
        int subs = Math.Max(1, mesh.subMeshCount);
        var mats = d.Pop ? u.Pops : u.Mats;
        int count = d.Pop ? u.PopCount : u.MatCount;
        var mpb = ui.Mpb ?? (ui.Mpb = new MaterialPropertyBlock());
        for (int i = 0; i < count; i++)
        {
            var m = mats[i];
            if (m == null || m.shader == null) continue;
            if (u.Clipped) m = TunerUiClipVariant(ui, m);
            mpb.Clear();
            if (u.Tex != null) mpb.SetTexture(TunerMainTexId, u.Tex);
            if (u.AlphaTex != null) mpb.SetTexture(TunerUiAlphaTexId, u.AlphaTex);
            mpb.SetVector(TunerUiSampleAddId, u.SampleAdd);
            if (u.Clipped)
            {
                mpb.SetVector(TunerUiClipRectId, u.Clip);
                mpb.SetFloat(TunerUiSoftXId, u.Soft.x);
                mpb.SetFloat(TunerUiSoftYId, u.Soft.y);
            }
            int sub = Math.Min(i, subs - 1);
            foreach (var p in TunerUiPasses(m.shader)) cmd.DrawMesh(mesh, u.Root.ToWorld, m, sub, p, mpb);
        }
    }

    static void TunerUiStatsLine(TunerSession s, StringBuilder line, StringBuilder json, bool reset)
    {
        TunerUiState ui;
        if (!_tunerUi.TryGetValue(s, out ui) || ui.Roots.Count == 0) return;
        int graphics = 0;
        foreach (var r in ui.Roots) graphics += r.Graphics;
        int n = Math.Max(1, ui.Prepares);
        line.Append(", ui ").Append(graphics.ToString(Inv)).Append(" graphics in ").Append(ui.Roots.Count.ToString(Inv)).Append(" canvases, prepare ")
            .Append((ui.PrepareMs / n).ToString("0.00", Inv)).Append(" ms (max ").Append(ui.PrepareMax.ToString("0.00", Inv)).Append(") over ")
            .Append(ui.Prepares.ToString(Inv)).Append(" checks (").Append(ui.Skipped.ToString(Inv)).Append(" quiet checks skipped), ")
            .Append(ui.Baked.ToString(Inv)).Append(" meshes baked");
        json.Append(",\"uiGraphics\":").Append(graphics.ToString(Inv))
            .Append(",\"uiCanvases\":").Append(ui.Roots.Count.ToString(Inv))
            .Append(",\"uiPrepareMs\":").Append(Num(ui.PrepareMs / n))
            .Append(",\"uiPrepareMaxMs\":").Append(Num(ui.PrepareMax))
            .Append(",\"uiBaked\":").Append(ui.Baked.ToString(Inv))
            .Append(",\"uiChecks\":").Append(ui.Prepares.ToString(Inv))
            .Append(",\"uiSkipped\":").Append(ui.Skipped.ToString(Inv));
        if (!reset) return;
        ui.PrepareMs = ui.PrepareMax = 0;
        ui.Prepares = 0;
        ui.Skipped = 0;
        ui.Baked = 0;
    }
}
