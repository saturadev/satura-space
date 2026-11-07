using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.UI;

public static partial class MCPTestBridge
{
    const double TUNER_FPS = 30.0;
    const double TUNER_FRAME_INTERVAL = 1.0 / TUNER_FPS;
    const double TUNER_DRAG_FRAME_INTERVAL = 1.0 / 60.0;
    const double TUNER_FRAME_SLACK = 0.004;
    const double TUNER_REBUILD_INTERVAL = 0.25;
    const int TUNER_MSAA = 4;
    const float TUNER_NEAR = 0.03f;
    const float TUNER_FAR = 2000f;
    const float TUNER_ORTHO_DEPTH = 10000f;
    const string TUNER_SHADER = "Hidden/Satura/TunerUnlit";
    const string TUNER_SHADER_PATH = "Packages/com.saturaspace.engine/Editor/Shaders/SaturaTunerUnlit.shader";

    static readonly int TunerTexId = Shader.PropertyToID("_SaturaTunerTex");
    static readonly int TunerTexStId = Shader.PropertyToID("_SaturaTunerTexST");
    static readonly int TunerColorId = Shader.PropertyToID("_SaturaTunerColor");
    static readonly int TunerCutoffId = Shader.PropertyToID("_SaturaTunerCutoff");
    static readonly int TunerViewPosId = Shader.PropertyToID("_SaturaTunerViewPos");
    static readonly int TunerVertexColorId = Shader.PropertyToID("_SaturaTunerVC");
    static readonly int TunerSdfId = Shader.PropertyToID("_SaturaTunerSdf");
    static readonly int TunerFlatId = Shader.PropertyToID("_SaturaTunerFlat");
    static readonly int TunerTexAddId = Shader.PropertyToID("_SaturaTunerTexAdd");
    static readonly int TunerGradientScaleId = Shader.PropertyToID("_GradientScale");
    static readonly int TunerBaseMapId = Shader.PropertyToID("_BaseMap");
    static readonly int TunerMainTexId = Shader.PropertyToID("_MainTex");
    static readonly int TunerBaseColorId = Shader.PropertyToID("_BaseColor");
    static readonly int TunerLegacyColorId = Shader.PropertyToID("_Color");
    static readonly int TunerAlphaCutoffId = Shader.PropertyToID("_Cutoff");
    static readonly int TunerCameraPosId = Shader.PropertyToID("_WorldSpaceCameraPos");

    enum TunerKind
    {
        Mesh,
        Sprite,
        Tilemap,
        Graphic
    }

    class TunerRend
    {
        public TunerKind Kind;
        public Renderer R;
        public Bounds Bounds;
        public double BoundsAt = -2;
        public GameObject Go;
        public Transform T;
        public MeshFilter Filter;
        public SkinnedMeshRenderer Skin;
        public Renderer BakeR;
        public ParticleSystem Ps;
        public Transform[] Bones;
        public Material[] Mats;
        public Mesh Mesh;
        public Mesh Baked;
        public double BakedAt = -1;
        public ulong SkinHash;
        public ulong SkinDrawn;
        public int Shapes;
        public bool Active;
        public bool LodHidden;
        public bool UseBake;
        public List<Vector3> Verts;
        public List<int> Tris;
        public Mesh TrisFor;
        public SpriteRenderer SpriteR;
        public Component Tiles;
        public List<Texture> TileTex;
        public double BuiltAt;
        public Graphic G;
        public TMP_Text Tmp;
        public TMP_SubMeshUI TmpSub;
        public RectTransform Rect;
        public Canvas Canvas;
        public Canvas SortCanvas;
        public Mesh Own;
        public Mesh Shown;
        public ulong Key;
        public TunerUiItem Ui;
        public int PopRank;
        public readonly List<TunerSortLevel> Levels = new List<TunerSortLevel>(2);
        public bool Overlay;
        public int Rank;
        public Component[] Drivers;
        public int FirstDraw;
        public int DrawCount;
        public bool Reusable;
        public bool HasMpb;
    }

    struct TunerSortLevel
    {
        public UnityEngine.Object Obj;
        public int Layer;
        public int Order;
        public float Depth;
    }

    class TunerDraw
    {
        public TunerRend Rend;
        public int Sub;
        public Material Mat;
        public int ColorId;
        public int TexId;
        public float Cutoff;
        public bool Transparent;
        public Color Color;
        public Texture Tex;
        public Vector4 St;
        public bool VertexColor;
        public bool Sdf;
        public bool Flat;
        public Vector4 TexAdd;
        public Matrix4x4 Matrix;
        public int Index;
        public bool Pop;
        public bool Real;
        public int Crc;
    }

    struct TunerShaderInfo
    {
        public int Color;
        public int Tex;
        public bool Cutoff;
    }

    [StructLayout(LayoutKind.Explicit)]
    struct TunerBits
    {
        [FieldOffset(0)] public float F;
        [FieldOffset(0)] public uint U;
    }

    struct TunerFrameInfo
    {
        public int Seq;
        public int W;
        public int H;
        public Vector3 Pos;
        public Quaternion Rot;
        public float Fov;
        public float Ortho;
        public int Ack;
        public double AckRecvMs;
        public string Poses;
        public string Icons;
        public int CamSeq;
        public double CamRecvMs;
        public double StartMs;
        public double EndMs;
        public double GapMs;
    }

    static readonly Dictionary<Shader, TunerShaderInfo> _tunerShaders = new Dictionary<Shader, TunerShaderInfo>();
    static readonly List<Renderer> _tunerRendTmp = new List<Renderer>();
    static readonly Dictionary<Component, int> _tunerRendIndex = new Dictionary<Component, int>(new TunerRefEq<Component>());
    static readonly List<TunerDraw> _tunerSorted = new List<TunerDraw>();
    static readonly Comparison<TunerDraw> TunerDrawOrder = CompareTunerDraws;
    static readonly List<Material> _tunerMatTmp = new List<Material>();
    static readonly Dictionary<Material, int> _tunerDrawCrc = new Dictionary<Material, int>();
    static readonly List<int> _tunerIdxTmp = new List<int>();
    static Shader _tunerUnlitShader;
    static bool _tunerShaderWarned;
    static int _tunerHierarchyGen;
    static Timer _tunerWake;
    static double _tunerWakeAt = -1;
    static readonly object _tunerWakeLock = new object();

    static ulong TunerMix(ulong h, uint v)
    {
        unchecked { return (h ^ v) * 1099511628211UL; }
    }

    static ulong TunerMix(ulong h, float f)
    {
        var b = new TunerBits { F = f };
        return TunerMix(h, b.U);
    }

    static ulong TunerMix(ulong h, Vector3 v)
    {
        return TunerMix(TunerMix(TunerMix(h, v.x), v.y), v.z);
    }

    static ulong TunerMix(ulong h, Matrix4x4 m)
    {
        var b = new TunerBits();
        unchecked
        {
            b.F = m.m00; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m10; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m20; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m30; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m01; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m11; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m21; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m31; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m02; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m12; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m22; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m32; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m03; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m13; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m23; h = (h ^ b.U) * 1099511628211UL;
            b.F = m.m33; h = (h ^ b.U) * 1099511628211UL;
        }
        return h;
    }

    static ulong TunerMix(ulong h, UnityEngine.Object o)
    {
        return TunerMix(h, ReferenceEquals(o, null) ? 0u : unchecked((uint)o.GetHashCode()));
    }

    static void WakeTunerAt(double at, double now)
    {
        if (_signalTick == null) return;
        lock (_tunerWakeLock)
        {
            if (_tunerWakeAt > 0 && _tunerWakeAt <= at) return;
            _tunerWakeAt = at;
            if (_tunerWake == null)
                _tunerWake = new Timer(_ =>
                {
                    lock (_tunerWakeLock) _tunerWakeAt = -1;
                    WakeTunerNow();
                }, null, Timeout.Infinite, Timeout.Infinite);
            _tunerWake.Change(Math.Max(1, (int)Math.Ceiling((at - now) * 1000.0)), Timeout.Infinite);
        }
    }

    static void StopTunerWake()
    {
        lock (_tunerWakeLock)
        {
            _tunerWake?.Dispose();
            _tunerWake = null;
            _tunerWakeAt = -1;
        }
    }

    static Shader TunerUnlitShader()
    {
        if (_tunerUnlitShader != null) return _tunerUnlitShader;
        var sh = AssetDatabase.LoadAssetAtPath<Shader>(TUNER_SHADER_PATH);
        if (sh == null) sh = Shader.Find(TUNER_SHADER);
        if (sh == null || !sh.isSupported)
        {
            if (!_tunerShaderWarned)
            {
                _tunerShaderWarned = true;
                Debug.LogWarning("[Tuner] the unlit tuner shader " + TUNER_SHADER + (sh == null ? " was not found at " + TUNER_SHADER_PATH : " is not supported on this GPU"));
            }
            return null;
        }
        _tunerUnlitShader = sh;
        return sh;
    }

    static TunerShaderInfo TunerShaderInfoOf(Shader sh)
    {
        TunerShaderInfo info;
        if (sh == null) return new TunerShaderInfo { Color = -1, Tex = -1 };
        if (_tunerShaders.TryGetValue(sh, out info)) return info;
        info.Color = -1;
        info.Tex = -1;
        int n = sh.GetPropertyCount();
        for (int i = 0; i < n; i++)
        {
            var flags = sh.GetPropertyFlags(i);
            var type = sh.GetPropertyType(i);
            if ((flags & ShaderPropertyFlags.MainColor) != 0 && type == ShaderPropertyType.Color && info.Color < 0) info.Color = sh.GetPropertyNameId(i);
            if ((flags & ShaderPropertyFlags.MainTexture) != 0 && type == ShaderPropertyType.Texture && info.Tex < 0) info.Tex = sh.GetPropertyNameId(i);
        }
        if (info.Color < 0) info.Color = TunerShaderProp(sh, ShaderPropertyType.Color, TunerBaseColorId, TunerLegacyColorId);
        if (info.Tex < 0) info.Tex = TunerShaderProp(sh, ShaderPropertyType.Texture, TunerBaseMapId, TunerMainTexId);
        info.Cutoff = sh.FindPropertyIndex("_Cutoff") >= 0;
        _tunerShaders[sh] = info;
        return info;
    }

    static int TunerShaderProp(Shader sh, ShaderPropertyType type, int first, int second)
    {
        int n = sh.GetPropertyCount();
        int found = -1;
        for (int i = 0; i < n; i++)
        {
            if (sh.GetPropertyType(i) != type) continue;
            int id = sh.GetPropertyNameId(i);
            if (id == first) return id;
            if (id == second) found = id;
        }
        return found;
    }

    static void ClearTunerCache(TunerSession s)
    {
        s.DrawsGen++;
        foreach (var e in s.Rends)
        {
            if (e.Baked != null) UnityEngine.Object.DestroyImmediate(e.Baked);
            if (e.Own != null) UnityEngine.Object.DestroyImmediate(e.Own);
        }
        s.Rends.Clear();
        s.HasText = false;
        s.RealText = false;
        s.Draws.Clear();
        s.LiveRends.Clear();
        s.LiveDrivers.Clear();
        s.LiveDriverSet.Clear();
        s.ObjRends = null;
    }

    static void RebuildTunerCache(TunerSession s, double now)
    {
        s.DrawsGen++;
        var view = TunerViewOf(s, false);
        if (view != null) view.Stats.Rebuilds++;
        var oldRends = _tunerOldRends;
        oldRends.Clear();
        _tunerOldDraws.Clear();
        _tunerOldDraws.AddRange(s.Draws);
        _tunerCrcNow.Clear();
        var others = new List<TunerRend>();
        foreach (var e in s.Rends)
        {
            if (e.Reusable && e.R != null) oldRends[e.R] = e;
            else others.Add(e);
        }
        s.Rends.Clear();
        s.Rends.AddRange(others);
        ClearTunerCache(s);
        s.TileGeoGen++;
        s.RendsGen++;
        s.CacheDirty = false;
        s.HierarchyGen = _tunerHierarchyGen;
        s.LastRebuild = now;
        s.GeomAt = -1;
        s.ShadowKey = 0;
        var index = _tunerRendIndex;
        index.Clear();
        s.ObjRends = new int[s.Specs.Length][];
        CollectTunerCanvases(s, index);
        foreach (var oi in TunerActiveObjects(s))
        {
            var go = s.Objects[oi];
            if (go == null) continue;
            go.GetComponentsInChildren(true, _tunerRendTmp);
            _tunerIdxTmp.Clear();
            foreach (var r in _tunerRendTmp)
            {
                if (r == null) continue;
                int at;
                if (!index.TryGetValue(r, out at))
                {
                    at = AddTunerRend(s, r, now);
                    index[r] = at;
                }
                if (at >= 0) _tunerIdxTmp.Add(at);
            }
            CollectTunerGraphics(s, go, index, _tunerIdxTmp);
            s.ObjRends[oi] = _tunerIdxTmp.ToArray();
        }
        long rootsAt = TpNow();
        foreach (var go in TunerSceneRoots(s))
        {
            bool canvas = go.GetComponentInChildren<Canvas>(true) != null;
            go.GetComponentsInChildren(true, _tunerRendTmp);
            foreach (var r in _tunerRendTmp)
                if (r != null && !index.ContainsKey(r) && (!canvas || !TunerOnFlatCanvas(r))) index[r] = AddTunerRend(s, r, now);
        }
        TpAdd(TP_ROOTS, rootsAt);
        foreach (var e in s.Entries)
        {
            if (e.Asset || e.Go == null) continue;
            e.Go.GetComponentsInChildren(true, _tunerRendTmp);
            foreach (var r in _tunerRendTmp)
                if (r != null && !index.ContainsKey(r) && !TunerOnFlatCanvas(r)) index[r] = AddTunerRend(s, r, now);
        }
        _tunerRendTmp.Clear();
        _tunerIdxTmp.Clear();
        index.Clear();
        foreach (var e in oldRends.Values)
        {
            if (e.Baked != null) UnityEngine.Object.DestroyImmediate(e.Baked);
            if (e.Own != null) UnityEngine.Object.DestroyImmediate(e.Own);
        }
        oldRends.Clear();
        _tunerOldDraws.Clear();
        _tunerCrcNow.Clear();
        ClearTunerTileGeo(s, true);
        LogTunerViewChange(s, ref s.TextReport, DescribeTunerRealText(s));
    }

    static string DescribeTunerRealText(TunerSession s)
    {
        if (!s.RealText) return null;
        var sb = new StringBuilder("text draw:");
        foreach (var d in s.Draws)
        {
            if (!d.Real || d.Mat == null) continue;
            sb.Append(' ').Append(TunerGameObjectPath(d.Rend.Go)).Append('(').Append(d.Mat.shader != null ? d.Mat.shader.name : "no shader").Append(" [");
            bool first = true;
            foreach (var k in d.Mat.shaderKeywords)
                if (k == "OUTLINE_ON" || k == "UNDERLAY_ON" || k == "UNDERLAY_INNER" || k == "GLOW_ON" || k == "BEVEL_ON")
                {
                    sb.Append(first ? "" : " ").Append(k);
                    first = false;
                }
            sb.Append("], outline ").Append((d.Mat.HasProperty(TunerUiOutlineWidthId) ? d.Mat.GetFloat(TunerUiOutlineWidthId) : 0f).ToString("0.###", Inv)).Append(')');
        }
        return sb.ToString();
    }

    static void NoteTunerDriver(TunerSession s, Component c)
    {
        if (!ReferenceEquals(c, null) && c != null && s.LiveDriverSet.Add(c)) s.LiveDrivers.Add(c);
    }

    static Component[] NoteTunerAnimated(TunerSession s, Renderer r)
    {
        var d = new Component[]
        {
            r.GetComponentInParent<Animator>(true), r.GetComponentInParent<Animation>(true), r is SkinnedMeshRenderer ? r.GetComponent<Cloth>() : null
        };
        foreach (var c in d) NoteTunerDriver(s, c);
        return d;
    }

    static readonly Dictionary<Renderer, TunerRend> _tunerOldRends = new Dictionary<Renderer, TunerRend>(new TunerRefEq<Renderer>());
    static readonly List<TunerDraw> _tunerOldDraws = new List<TunerDraw>();
    static readonly Dictionary<Material, int> _tunerCrcNow = new Dictionary<Material, int>(new TunerRefEq<Material>());

    static int TunerCrcNow(Material m)
    {
        int crc;
        if (!_tunerCrcNow.TryGetValue(m, out crc))
        {
            long t = TpNow();
            _tunerCrcNow[m] = crc = m.ComputeCRC();
            TpAdd(TP_CRC, t);
        }
        return crc;
    }

    static bool ReuseTunerRend(TunerSession s, Renderer r)
    {
        TunerRend e;
        if (_tunerOldRends.Count == 0 || !_tunerOldRends.TryGetValue(r, out e)) return false;
        var mesh = e.Skin != null ? e.Skin.sharedMesh : e.Filter != null ? e.Filter.sharedMesh : null;
        if (mesh == null || !ReferenceEquals(mesh, e.Mesh) || e.FirstDraw + e.DrawCount > _tunerOldDraws.Count) return false;
        r.GetSharedMaterials(_tunerMatTmp);
        bool same = _tunerMatTmp.Count == e.Mats.Length;
        for (int k = 0; same && k < e.Mats.Length; k++) same = ReferenceEquals(_tunerMatTmp[k], e.Mats[k]);
        _tunerMatTmp.Clear();
        if (!same) return false;
        for (int k = 0; k < e.DrawCount; k++)
        {
            var d = _tunerOldDraws[e.FirstDraw + k];
            if (d.Rend != e || d.Mat == null || TunerCrcNow(d.Mat) != d.Crc) return false;
        }
        _tunerOldRends.Remove(r);
        if (e.Drivers != null) foreach (var c in e.Drivers) NoteTunerDriver(s, c);
        int first = s.Draws.Count;
        for (int k = 0; k < e.DrawCount; k++) s.Draws.Add(_tunerOldDraws[e.FirstDraw + k]);
        e.FirstDraw = first;
        s.Rends.Add(e);
        return true;
    }

    static int AddTunerRend(TunerSession s, Renderer r, double now)
    {
        if (ReuseTunerRend(s, r)) return s.Rends.Count - 1;
        var drivers = NoteTunerAnimated(s, r);
        var sprite = r as SpriteRenderer;
        if (sprite != null) return AddTunerSprite(s, sprite);
        if (TunerIsTilemap(r)) return AddTunerTilemap(s, r, now);
        var skin = r as SkinnedMeshRenderer;
        MeshFilter filter = null;
        Mesh mesh = null;
        bool text = false;
        bool bake = r is ParticleSystemRenderer || r is LineRenderer || r is TrailRenderer;
        if (skin != null)
        {
            mesh = skin.sharedMesh;
        }
        else if (bake) { }
        else if (r is MeshRenderer)
        {
            filter = r.GetComponent<MeshFilter>();
            mesh = filter != null ? filter.sharedMesh : null;
            if (r.GetComponent<TMP_Text>() != null)
            {
                text = true;
                s.HasText = true;
                HookTunerText();
            }
        }
        else
        {
            s.LiveRends.Add(r);
            return -1;
        }
        r.GetSharedMaterials(_tunerMatTmp);
        var e = new TunerRend
        {
            R = r,
            Go = r.gameObject,
            T = r.transform,
            Filter = filter,
            Skin = skin,
            BakeR = bake ? r : null,
            Ps = r is ParticleSystemRenderer ? r.GetComponent<ParticleSystem>() : null,
            Bones = skin != null ? skin.bones : null,
            Mats = _tunerMatTmp.ToArray(),
            Mesh = mesh,
            Shapes = skin != null && mesh != null ? mesh.blendShapeCount : 0,
            Drivers = drivers,
            FirstDraw = s.Draws.Count,
            HasMpb = r.HasPropertyBlock()
        };
        s.Rends.Add(e);
        if (mesh != null)
        {
            int subs = Math.Min(mesh.subMeshCount, e.Mats.Length);
            for (int k = 0; k < subs; k++)
            {
                var m = e.Mats[k];
                if (m == null) continue;
                var info = TunerShaderInfoOf(m.shader);
                int q = m.renderQueue;
                bool clip = info.Cutoff && (m.IsKeywordEnabled("_ALPHATEST_ON") || (q >= (int)RenderQueue.AlphaTest && q < (int)RenderQueue.GeometryLast));
                bool sdf = m.HasProperty(TunerGradientScaleId);
                s.Draws.Add(new TunerDraw
                {
                    Rend = e,
                    Sub = k,
                    Mat = m,
                    ColorId = info.Color,
                    TexId = info.Tex,
                    Cutoff = clip ? m.GetFloat(TunerAlphaCutoffId) : -1f,
                    Transparent = sdf || q >= (int)RenderQueue.Transparent,
                    Sdf = sdf,
                    VertexColor = sdf,
                    Flat = sdf,
                    Real = sdf,
                    Crc = TunerCrcNow(m)
                });
                if (sdf) s.RealText = true;
            }
        }
        e.DrawCount = s.Draws.Count - e.FirstDraw;
        e.Reusable = mesh != null && !bake && !text;
        for (int k = e.FirstDraw; k < s.Draws.Count; k++) if (s.Draws[k].Real) e.Reusable = false;
        _tunerMatTmp.Clear();
        return s.Rends.Count - 1;
    }

    class TunerMatVals
    {
        public int ColorId;
        public int TexId;
        public int Crc;
        public Color Color;
        public Texture Tex;
        public Vector4 St;
        public bool Dead;
    }

    sealed class TunerRefEq<T> : IEqualityComparer<T> where T : class
    {
        public bool Equals(T a, T b) { return ReferenceEquals(a, b); }
        public int GetHashCode(T o) { return System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(o); }
    }

    static readonly Dictionary<Material, TunerMatVals> _tunerMatVals = new Dictionary<Material, TunerMatVals>(new TunerRefEq<Material>());

    static TunerMatVals TunerMatValsOf(Material m, int colorId, int texId, bool crc)
    {
        var v = new TunerMatVals { ColorId = colorId, TexId = texId };
        if (!m)
        {
            v.Dead = true;
            return v;
        }
        if (crc)
        {
            int c;
            if (!_tunerDrawCrc.TryGetValue(m, out c)) _tunerDrawCrc[m] = c = m.ComputeCRC();
            v.Crc = c;
        }
        v.Color = colorId >= 0 ? m.GetColor(colorId) : Color.white;
        v.Tex = texId >= 0 ? m.GetTexture(texId) : null;
        Vector2 scale = Vector2.one, offset = Vector2.zero;
        if (v.Tex != null)
        {
            scale = m.GetTextureScale(texId);
            offset = m.GetTextureOffset(texId);
        }
        v.St = new Vector4(scale.x, scale.y, offset.x, offset.y);
        return v;
    }

    const int TUNER_MAT_CHECK_SLICES = 8;

    static void CheckTunerRendMats(TunerSession s)
    {
        int n = s.Rends.Count;
        if (n == 0) return;
        int from = 0, count = n;
        if (s.MatCheckGen == _tunerChangeGen && s.MatCheckRends == n)
        {
            count = Math.Max(256, n / (TunerHashLive(s) ? TUNER_MAT_CHECK_SLICES * 4 : TUNER_MAT_CHECK_SLICES));
            from = s.MatCheckAt % n;
        }
        s.MatCheckGen = _tunerChangeGen;
        s.MatCheckRends = n;
        for (int i = 0; i < count && i < n; i++)
        {
            var e = s.Rends[(from + i) % n];
            if (!e.Active || e.Kind != TunerKind.Mesh) continue;
            var mesh = e.Skin != null ? e.Skin.sharedMesh : e.Filter != null ? e.Filter.sharedMesh : null;
            if (!ReferenceEquals(mesh, e.Mesh)) s.CacheDirty = true;
            e.HasMpb = e.R.HasPropertyBlock();
            e.R.GetSharedMaterials(_tunerMatTmp);
            bool same = _tunerMatTmp.Count == e.Mats.Length;
            for (int k = 0; same && k < e.Mats.Length; k++) same = ReferenceEquals(_tunerMatTmp[k], e.Mats[k]);
            if (!same) s.CacheDirty = true;
        }
        s.MatCheckAt = (from + count) % n;
        _tunerMatTmp.Clear();
    }

    const int TUNER_LIVE_SLICES = 4;

    static bool TunerHashLive(TunerSession s)
    {
        return TunerUsesCamera(s) && EditorApplication.isPlaying && !EditorApplication.isPaused && TunerHasLiveRends(s);
    }

    static ulong TunerGeometryHash(TunerSession s, double now)
    {
        if (s.GeomAt == now) return s.GeomHash;
        ulong h = 14695981039346656037UL;
        bool live = TunerHashLive(s);
        if (live) h = TunerMix(h, (uint)Time.frameCount);
        int phase = live ? (s.LivePhase = (s.LivePhase + 1) % TUNER_LIVE_SLICES) : -1;
        var rends = s.Rends;
        for (int i = 0; i < rends.Count; i++)
        {
            var e = rends[i];
            if (e.Kind == TunerKind.Graphic) continue;
            if (!TunerRendAlive(e))
            {
                s.CacheDirty = true;
                e.Active = false;
                continue;
            }
            if (live && e.Kind == TunerKind.Mesh && e.BakeR == null)
            {
                if (i % TUNER_LIVE_SLICES == phase) e.Active = TunerRendVisible(e);
                continue;
            }
            bool active = TunerRendVisible(e);
            e.Active = active;
            h = TunerMix(h, active ? 1u : 0u);
            if (!active) continue;
            if (e.Kind != TunerKind.Mesh)
            {
                h = TunerMix(h, e.T.localToWorldMatrix);
                h = HashTuner2DGeometry(s, e, h, now);
                continue;
            }
            if (!live) h = TunerMix(h, e.T.localToWorldMatrix);
            if (e.BakeR != null) h = MixTunerBaked(e, h);
            if (e.Skin != null) h = TunerMix(h, TunerSkinHash(e));
        }
        h = PrepareTunerUi(s, h, now);
        s.GeomHash = h;
        s.GeomAt = now;
        return h;
    }

    static ulong TunerSkinHash(TunerRend e)
    {
        ulong sk = 14695981039346656037UL;
        var bones = e.Bones;
        if (bones != null)
            for (int b = 0; b < bones.Length; b++)
                if (!ReferenceEquals(bones[b], null) && bones[b]) sk = TunerMix(sk, bones[b].localToWorldMatrix);
        for (int k = 0; k < e.Shapes; k++) sk = TunerMix(sk, e.Skin.GetBlendShapeWeight(k));
        e.SkinHash = sk;
        return sk;
    }

    static void RefreshTunerSkinHashes(TunerSession s)
    {
        var rends = s.Rends;
        for (int i = 0; i < rends.Count; i++)
        {
            var e = rends[i];
            if (e.Skin != null && e.Active && e.Skin) TunerSkinHash(e);
        }
    }

    static void RefreshTunerFlatDraws(TunerSession s, double now)
    {
        var rends = s.Rends;
        for (int i = 0; i < rends.Count; i++)
        {
            var e = rends[i];
            if (e.Kind == TunerKind.Sprite && e.Active && TunerRendAlive(e)) HashTuner2DGeometry(s, e, 0UL, now);
        }
        var draws = s.Draws;
        for (int i = 0; i < draws.Count; i++)
        {
            var e = draws[i].Rend;
            if ((e.Kind == TunerKind.Sprite || e.Kind == TunerKind.Tilemap) && e.Active && TunerRendAlive(e)) HashTuner2DDraw(e, draws[i], 0UL);
        }
        PrepareTunerUi(s, 0UL, now);
    }

    static void RefreshTunerMarkedFlat(TunerSession s, double now)
    {
        var v = TunerViewOf(s, false);
        if (v == null || ResolveTunerMarked(s, v, now).Count == 0) return;
        CollectTunerMarkedDraws(s, v, now);
        TunerRend last = null;
        foreach (var d in v.MarkedDraws)
        {
            var e = d.Rend;
            if ((e.Kind != TunerKind.Sprite && e.Kind != TunerKind.Tilemap) || !e.Active || !TunerRendAlive(e)) continue;
            if (e.Kind == TunerKind.Sprite && !ReferenceEquals(e, last)) HashTuner2DGeometry(s, e, 0UL, now);
            last = e;
            HashTuner2DDraw(e, d, 0UL);
        }
    }

    static ulong HashTuner(TunerSession s, double now)
    {
        long stage = TpNow();
        ulong h = TunerGeometryHash(s, now);
        TpAdd(TP_HASH_GEO, stage);
        bool camera = TunerUsesCamera(s);
        _tunerDrawCrc.Clear();
        _tunerMatVals.Clear();
        var mpb = s.Mpb ?? (s.Mpb = new MaterialPropertyBlock());
        TunerRend mpbFor = null;
        bool hasMpb = false;
        Material lastMat = null;
        TunerMatVals lastVals = null;
        CheckTunerRendMats(s);
        bool live = TunerHashLive(s);
        int phase = s.LivePhase;
        var draws = s.Draws;
        for (int di = 0; di < draws.Count; di++)
        {
            var d = draws[di];
            var e = d.Rend;
            if (!e.Active) continue;
            if (live && e.Kind == TunerKind.Mesh && di % TUNER_LIVE_SLICES != phase) continue;
            if (e.Kind != TunerKind.Mesh)
            {
                h = HashTuner2DDraw(e, d, h);
                continue;
            }
            var m = d.Mat;
            if (ReferenceEquals(m, null))
            {
                s.CacheDirty = true;
                continue;
            }
            TunerMatVals mv;
            if (ReferenceEquals(m, lastMat) && lastVals.ColorId == d.ColorId && lastVals.TexId == d.TexId) mv = lastVals;
            else if (!_tunerMatVals.TryGetValue(m, out mv) || mv.ColorId != d.ColorId || mv.TexId != d.TexId)
            {
                bool fresh = mv == null;
                mv = TunerMatValsOf(m, d.ColorId, d.TexId, d.Real || camera);
                if (fresh) _tunerMatVals[m] = mv;
                if (mv.Dead)
                {
                    s.CacheDirty = true;
                    continue;
                }
                h = TunerMix(h, unchecked((uint)mv.Crc));
                h = MixTunerColor(h, mv.Color);
                h = TunerMix(h, mv.Tex);
                h = TunerMix(h, mv.St.x);
                h = TunerMix(h, mv.St.y);
                h = TunerMix(h, mv.St.z);
                h = TunerMix(h, mv.St.w);
            }
            if (mv.Dead)
            {
                s.CacheDirty = true;
                continue;
            }
            lastMat = m;
            lastVals = mv;
            d.Color = mv.Color;
            var tex = mv.Tex;
            if (!ReferenceEquals(mpbFor, e))
            {
                mpbFor = e;
                hasMpb = e.HasMpb;
                if (hasMpb) e.R.GetPropertyBlock(mpb);
            }
            if (hasMpb)
            {
                if (d.ColorId >= 0 && mpb.HasColor(d.ColorId)) d.Color = mpb.GetColor(d.ColorId);
                if (d.TexId >= 0 && mpb.HasTexture(d.TexId))
                {
                    var t = mpb.GetTexture(d.TexId);
                    if (t != null) tex = t;
                }
                h = MixTunerColor(h, d.Color);
                h = TunerMix(h, tex);
            }
            d.Tex = tex != null && tex.dimension == TextureDimension.Tex2D ? tex : null;
            d.St = mv.St;
        }
        h = TunerMix(h, (uint)s.UiGen);
        h = MixTunerSceneRender(s, h);
        stage = TpNow();
        h = MixTunerView(s, h, now);
        TpAdd(TP_HASH_VIEW, stage);
        s.ContentHash = h;
        h = TunerMix(h, s.CamPos);
        h = TunerMix(h, s.CamRot.x);
        h = TunerMix(h, s.CamRot.y);
        h = TunerMix(h, s.CamRot.z);
        h = TunerMix(h, s.CamRot.w);
        h = TunerMix(h, s.Fov);
        h = TunerMix(h, s.Ortho);
        h = TunerMix(h, (uint)s.Width);
        h = TunerMix(h, (uint)s.Height);
        return h;
    }

    static bool TunerUseBake(TunerRend e)
    {
        return e.Skin != null && (!e.Skin.isVisible || (!EditorApplication.isPlaying && AnimationMode.InAnimationMode()));
    }

    static Mesh BakeTunerSkin(TunerSession s, TunerRend e, double now)
    {
        if (e.Baked == null) e.Baked = new Mesh { name = "_SaturaTunerBaked", hideFlags = HideFlags.HideAndDontSave };
        if (e.BakedAt == now) return e.Baked;
        e.Skin.BakeMesh(e.Baked, false);
        e.BakedAt = now;
        return e.Baked;
    }

    static Matrix4x4 TunerBakedMatrix(TunerRend e)
    {
        return Matrix4x4.TRS(e.T.position, e.T.rotation, Vector3.one);
    }

    static bool EnsureTunerResources(TunerSession s, out string err)
    {
        err = null;
        if (s.Unlit == null)
        {
            var sh = TunerUnlitShader();
            if (sh == null)
            {
                err = "the unlit tuner shader is unavailable";
                return false;
            }
            s.Unlit = new Material(sh) { name = TUNER_UNLIT_NAME, hideFlags = HideFlags.HideAndDontSave };
        }
        if (s.GridMesh == null) s.GridMesh = BuildTunerGrid();
        if (s.GridMat == null)
        {
            s.GridMat = new Material(Shader.Find("Hidden/Internal-Colored")) { name = TUNER_GRID_NAME, hideFlags = HideFlags.HideAndDontSave };
            s.GridMat.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
            s.GridMat.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
            s.GridMat.SetInt("_Cull", (int)CullMode.Off);
            s.GridMat.SetInt("_ZWrite", 0);
            s.GridMat.SetInt("_ZTest", (int)CompareFunction.LessEqual);
        }
        if (s.Cmd == null) s.Cmd = new CommandBuffer { name = "SaturaTuner" };
        if (s.Mpb == null) s.Mpb = new MaterialPropertyBlock();
        return true;
    }

    static bool EnsureTunerTargets(TunerSession s, int w, int h, out string err)
    {
        err = null;
        if (s.Target != null && s.Target.width == w && s.Target.height == h && s.Target.IsCreated()
            && (s.Resolve == null || s.Resolve.IsCreated())) return true;
        ReleaseTunerTexture(ref s.Target);
        ReleaseTunerTexture(ref s.Resolve);
        ReleaseTunerTexture(ref s.SrpTarget);
        s.Target = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32)
        {
            name = TUNER_RT_NAME, hideFlags = HideFlags.HideAndDontSave, antiAliasing = TUNER_MSAA
        };
        if (!s.Target.Create())
        {
            err = "could not create a " + w + "x" + h + " render target";
            return false;
        }
        if (s.Target.antiAliasing > 1)
        {
            s.Resolve = new RenderTexture(w, h, 0, RenderTextureFormat.ARGB32) { name = TUNER_RT_NAME, hideFlags = HideFlags.HideAndDontSave };
            if (!s.Resolve.Create())
            {
                err = "could not create a " + w + "x" + h + " resolve target";
                return false;
            }
        }
        return true;
    }

    static Matrix4x4 TunerGridMatrix(TunerSession s)
    {
        if (s.Ortho > 0f)
        {
            float step = Mathf.Pow(10f, Mathf.Floor(Mathf.Log10(Mathf.Max(s.Ortho * 0.4f, 1e-4f))));
            float major = step * TUNER_GRID_MAJOR;
            var c = new Vector3(Mathf.Round(s.CamPos.x / major) * major, Mathf.Round(s.CamPos.y / major) * major, 0f);
            return Matrix4x4.TRS(c, Quaternion.Euler(-90f, 0f, 0f), new Vector3(step, step, step));
        }
        var fwd = s.CamRot * Vector3.forward;
        var focus = s.CamPos;
        if (Mathf.Abs(fwd.y) > 1e-4f && -s.CamPos.y / fwd.y > 0f) focus = s.CamPos + fwd * Mathf.Min(-s.CamPos.y / fwd.y, TUNER_GRID_HALF * 0.5f);
        var at = new Vector3(Mathf.Round(focus.x / TUNER_GRID_MAJOR) * TUNER_GRID_MAJOR, 0f,
            Mathf.Round(focus.z / TUNER_GRID_MAJOR) * TUNER_GRID_MAJOR);
        return Matrix4x4.Translate(at);
    }

    static void UpdateTunerLods(TunerSession s, double now)
    {
        UpdateTunerLods(s, now, s.CamPos, s.Fov, s.Ortho);
    }

    const double TUNER_LODS_REFRESH = 10.0;
    const int TUNER_LOD_SLICES = 32;

    struct TunerLodPlace
    {
        public Vector3 Point;
        public float Size;
        public bool Enabled;
        public bool Gone;
    }

    static void RefreshTunerLodPlace(TunerSession s, int gi)
    {
        var g = s.Lods[gi];
        var p = new TunerLodPlace();
        if (g == null) p.Gone = true;
        else
        {
            var t = g.transform;
            var ls = t.lossyScale;
            p.Size = g.size * Mathf.Max(Mathf.Abs(ls.x), Mathf.Max(Mathf.Abs(ls.y), Mathf.Abs(ls.z)));
            p.Point = t.TransformPoint(g.localReferencePoint);
            p.Enabled = g.enabled;
        }
        s.LodPlace[gi] = p;
    }

    sealed class TunerLodScan
    {
        public int Gen;
        public int Count;
        public double At;
        public int Next;
        public readonly Dictionary<Renderer, TunerRend> ByR = new Dictionary<Renderer, TunerRend>();
        public readonly HashSet<LODGroup> Seen = new HashSet<LODGroup>();
        public readonly List<LODGroup> Lods = new List<LODGroup>();
        public readonly List<LOD[]> Levels = new List<LOD[]>();
        public readonly List<TunerRend[][]> Rends = new List<TunerRend[][]>();
    }

    const double TUNER_LOD_SCAN_BUDGET_MS = 1.5;

    static void UpdateTunerLods(TunerSession s, double now, Vector3 camPos, float fov, float ortho)
    {
        bool built = s.LodsAt >= 0;
        if (s.LodScan == null && (s.LodsGen != s.RendsGen || s.LodsCount != s.Rends.Count || now - s.LodsAt > TUNER_LODS_REFRESH))
        {
            var scan = s.LodScan = new TunerLodScan { Gen = s.RendsGen, Count = s.Rends.Count, At = now };
            foreach (var e in s.Rends)
                if (e.R != null) scan.ByR[e.R] = e;
        }
        if (s.LodScan != null)
        {
            var scan = s.LodScan;
            if (scan.Gen != s.RendsGen || scan.Count != s.Rends.Count)
            {
                s.LodScan = null;
                if (built) return;
                UpdateTunerLods(s, now, camPos, fov, ortho);
                return;
            }
            long until = built ? System.Diagnostics.Stopwatch.GetTimestamp() + (long)(TUNER_LOD_SCAN_BUDGET_MS * System.Diagnostics.Stopwatch.Frequency / 1000.0) : long.MaxValue;
            var rends = s.Rends;
            while (scan.Next < rends.Count)
            {
                var e = rends[scan.Next++];
                if (e.R != null)
                {
                    var g = e.R.GetComponentInParent<LODGroup>(true);
                    if (g != null && scan.Seen.Add(g))
                    {
                        var lods = g.GetLODs();
                        var levels = new TunerRend[lods.Length][];
                        for (int i = 0; i < lods.Length; i++)
                        {
                            var list = new List<TunerRend>();
                            if (lods[i].renderers != null)
                                foreach (var r in lods[i].renderers)
                                {
                                    TunerRend x;
                                    if (r != null && scan.ByR.TryGetValue(r, out x)) list.Add(x);
                                }
                            levels[i] = list.ToArray();
                        }
                        scan.Lods.Add(g);
                        scan.Levels.Add(lods);
                        scan.Rends.Add(levels);
                    }
                }
                if ((scan.Next & 63) == 0 && System.Diagnostics.Stopwatch.GetTimestamp() > until) break;
            }
            if (scan.Next >= rends.Count)
            {
                s.LodScan = null;
                s.LodsGen = scan.Gen;
                s.LodsCount = scan.Count;
                s.LodsAt = scan.At;
                s.RendByR.Clear();
                foreach (var kv in scan.ByR) s.RendByR[kv.Key] = kv.Value;
                foreach (var e in rends) e.LodHidden = false;
                s.Lods.Clear();
                s.Lods.AddRange(scan.Lods);
                s.LodLevels.Clear();
                s.LodLevels.AddRange(scan.Levels);
                s.LodRends.Clear();
                s.LodRends.AddRange(scan.Rends);
                s.LodActive.Clear();
                s.LodPlace.Clear();
                for (int gi = 0; gi < s.Lods.Count; gi++)
                {
                    s.LodActive.Add(-2);
                    s.LodPlace.Add(default);
                    RefreshTunerLodPlace(s, gi);
                }
                s.LodPlaceAt = 0;
            }
        }
        if (s.Lods.Count == 0) return;
        int slice = Math.Max(64, s.Lods.Count / TUNER_LOD_SLICES);
        for (int k = 0; k < slice && k < s.Lods.Count; k++)
        {
            s.LodPlaceAt = (s.LodPlaceAt + 1) % s.Lods.Count;
            RefreshTunerLodPlace(s, s.LodPlaceAt);
        }
        float bias = QualitySettings.lodBias;
        float tanHalf = Mathf.Tan(fov * 0.5f * Mathf.Deg2Rad);
        for (int gi = 0; gi < s.Lods.Count; gi++)
        {
            var place = s.LodPlace[gi];
            if (place.Gone) continue;
            var lods = s.LodLevels[gi];
            int active = -1;
            if (place.Enabled)
            {
                float size = place.Size;
                float rel;
                if (ortho > 0f) rel = size / (2f * ortho);
                else
                {
                    float dist = Vector3.Distance(place.Point, camPos);
                    rel = size / Mathf.Max(1e-5f, 2f * dist * tanHalf);
                }
                rel *= bias;
                for (int i = 0; i < lods.Length; i++)
                {
                    if (rel >= lods[i].screenRelativeTransitionHeight)
                    {
                        active = i;
                        break;
                    }
                }
            }
            else active = 0;
            if (s.LodActive[gi] == active) continue;
            s.LodActive[gi] = active;
            var levels = s.LodRends[gi];
            for (int i = 0; i < levels.Length; i++)
                foreach (var e in levels[i]) e.LodHidden = i != active;
            if (active >= 0 && active < levels.Length)
                foreach (var e in levels[active]) e.LodHidden = false;
        }
    }

    static bool TunerDrawReady(TunerDraw d)
    {
        var e = d.Rend;
        if (!e.Active || e.LodHidden) return false;
        if (e.Kind == TunerKind.Mesh) return d.Mat != null;
        if (e.Kind == TunerKind.Graphic && (d.Pop || e.Ui == null || e.Ui.StencilOnly)) return false;
        return e.Shown != null && d.Sub < e.Shown.subMeshCount && e.Shown.vertexCount > 0;
    }

    static void RecordTunerDraw(TunerSession s, CommandBuffer cmd, TunerDraw d, int pass, double now)
    {
        RecordTunerDraw(s, cmd, d, s.Unlit, pass, now);
    }

    static void RecordTunerDraw(TunerSession s, CommandBuffer cmd, TunerDraw d, Material mat, int pass, double now)
    {
        var e = d.Rend;
        cmd.SetGlobalColor(TunerColorId, d.Color);
        cmd.SetGlobalTexture(TunerTexId, d.Tex != null ? d.Tex : Texture2D.whiteTexture);
        cmd.SetGlobalVector(TunerTexStId, d.St);
        cmd.SetGlobalFloat(TunerCutoffId, d.Cutoff);
        cmd.SetGlobalFloat(TunerVertexColorId, d.VertexColor ? 1f : 0f);
        cmd.SetGlobalFloat(TunerSdfId, d.Sdf ? 1f : 0f);
        cmd.SetGlobalFloat(TunerFlatId, d.Flat ? 1f : 0f);
        cmd.SetGlobalVector(TunerTexAddId, d.TexAdd);
        cmd.SetGlobalVector(TunerUiViewClipId, e.Kind == TunerKind.Graphic ? e.Ui.ViewClip : TunerUiNoViewClip);
        if (e.Kind != TunerKind.Mesh) cmd.DrawMesh(e.Shown, d.Matrix, mat, d.Sub, pass);
        else if (e.UseBake) cmd.DrawMesh(BakeTunerSkin(s, e, now), TunerBakedMatrix(e), mat, d.Sub, pass);
        else cmd.DrawRenderer(e.R, mat, d.Sub, pass);
    }

    static void RecordTunerOpaque(TunerSession s, CommandBuffer cmd, double now)
    {
        foreach (var d in s.Draws)
        {
            if (d.Transparent || !TunerDrawReady(d)) continue;
            if (d.Real) RecordTunerReal(s, cmd, d, now);
            else RecordTunerDraw(s, cmd, d, 0, now);
        }
    }

    static bool TunerFlatUi(TunerRend e)
    {
        var root = e.Kind == TunerKind.Graphic && e.Ui != null ? e.Ui.Root : null;
        return root != null && root.Canvas != null && root.Canvas.renderMode != RenderMode.WorldSpace;
    }

    static void RecordTunerTransparent(TunerSession s, CommandBuffer cmd, double now, bool flatUiOnly = false)
    {
        var list = _tunerSorted;
        list.Clear();
        var fwd = s.CamRot * Vector3.forward;
        foreach (var e in s.Rends)
            if (e.Active && (!flatUiOnly || e.Kind == TunerKind.Graphic)) TunerSortKeys(e, s.CamPos, fwd);
        for (int k = 0; k < s.Draws.Count; k++)
        {
            var d = s.Draws[k];
            if (!d.Transparent || (flatUiOnly && !TunerFlatUi(d.Rend))) continue;
            if (d.Rend.Kind == TunerKind.Graphic ? !TunerUiReady(d) : !TunerDrawReady(d)) continue;
            d.Index = k;
            list.Add(d);
        }
        TunerUiState ui;
        if (_tunerUi.TryGetValue(s, out ui))
            for (int k = 0; k < ui.Pops.Count; k++)
            {
                var d = ui.Pops[k];
                if ((flatUiOnly && !TunerFlatUi(d.Rend)) || !TunerUiReady(d)) continue;
                d.Index = s.Draws.Count + k;
                list.Add(d);
            }
        list.Sort(TunerDrawOrder);
        foreach (var d in list)
        {
            if (d.Rend.Kind == TunerKind.Graphic) RecordTunerUi(s, cmd, d);
            else if (d.Real) RecordTunerReal(s, cmd, d, now);
            else RecordTunerDraw(s, cmd, d, 1, now);
        }
        list.Clear();
    }

    static void RecordTunerReal(TunerSession s, CommandBuffer cmd, TunerDraw d, double now)
    {
        var m = d.Mat;
        if (m.shader == null) return;
        foreach (var p in TunerUiPasses(m.shader)) cmd.DrawRenderer(d.Rend.R, m, d.Sub, p);
    }

    static int CompareTunerDraws(TunerDraw x, TunerDraw y)
    {
        var a = x.Rend;
        var b = y.Rend;
        int c = a.Overlay.CompareTo(b.Overlay);
        if (c != 0) return c;
        c = CompareTunerSortLevels(a.Levels, b.Levels);
        if (c != 0) return c;
        c = (x.Pop ? a.PopRank : a.Rank).CompareTo(y.Pop ? b.PopRank : b.Rank);
        if (c != 0) return c;
        return x.Index.CompareTo(y.Index);
    }

    static int CompareTunerSortLevels(List<TunerSortLevel> a, List<TunerSortLevel> b)
    {
        int n = Math.Min(a.Count, b.Count);
        for (int i = 0; i < n; i++)
        {
            var p = a[i];
            var q = b[i];
            if (ReferenceEquals(p.Obj, q.Obj)) continue;
            int c = p.Layer.CompareTo(q.Layer);
            if (c != 0) return c;
            c = p.Order.CompareTo(q.Order);
            if (c != 0) return c;
            return q.Depth.CompareTo(p.Depth);
        }
        return 0;
    }

    static string RenderTuner(TunerSession s, double now)
    {
        int w = s.Width, h = s.Height;
        string err;
        long ensure = TpNow();
        if (!EnsureTunerResources(s, out err)) return err;
        if (!EnsureTunerTargets(s, w, h, out err)) return err;
        long bake = TpNow();
        if (s.SkinsGen != s.RendsGen || s.SkinsCount != s.Rends.Count)
        {
            s.SkinsGen = s.RendsGen;
            s.SkinsCount = s.Rends.Count;
            s.Skins.Clear();
            foreach (var e in s.Rends)
            {
                e.UseBake = false;
                if (e.Skin != null) s.Skins.Add(e);
            }
        }
        foreach (var e in s.Skins) e.UseBake = e.Active && TunerUseBake(e);
        TpAdd(TP_BAKE, bake);
        long lods = TpNow();
        UpdateTunerLods(s, now);
        TpAdd(TP_LODS, lods);
        TpAdd(TP_ENSURE, ensure);
        ApplyTunerGridColor(s);
        var view = Matrix4x4.Scale(new Vector3(1f, 1f, -1f)) * Matrix4x4.Inverse(Matrix4x4.TRS(s.CamPos, s.CamRot, Vector3.one));
        float aspect = (float)w / h;
        var proj = TunerProjection(s.Fov, s.Ortho, aspect, s.Near, s.Far, s.OrthoClip);
        GeometryUtility.CalculateFrustumPlanes(proj * view, _tunerFrustum);
        bool real = TunerUsesCamera(s);
        long stage = TpNow();
        if (real)
        {
            RenderTunerSceneCamera(s, w, h, view, proj);
            s.CompileStale = ShaderUtil.anythingCompiling;
            TpAdd(TP_CAMERA, stage);
            stage = TpNow();
        }
        var cmd = s.Cmd;
        cmd.Clear();
        cmd.SetRenderTarget(s.Target);
        var clear = TunerSceneBackground();
        if (real)
        {
            if (!_tunerCameraDepth) cmd.ClearRenderTarget(true, false, Color.clear);
        }
        else cmd.ClearRenderTarget(true, true, QualitySettings.activeColorSpace == ColorSpace.Linear ? clear.linear : clear);
        cmd.SetViewProjectionMatrices(view, proj);
        cmd.SetGlobalVector(TunerViewPosId, s.CamPos);
        BeginTunerUi(s, cmd, w, h);
        var gridView = TunerViewOf(s, false);
        bool gridOn = (gridView == null || !gridView.GridOff) && !(s.Scene && _tunerIsoOn && TunerCanvasViewOf(s) != null);
        if (real)
        {
            if (!_tunerCameraDepth) RecordTunerDepth(s, cmd, now);
            if (gridOn) cmd.DrawMesh(s.GridMesh, TunerGridMatrix(s), s.GridMat, 0, 0);
            if (TunerHasUi(s)) RecordTunerTransparent(s, cmd, now, true);
        }
        else
        {
            RecordTunerOpaque(s, cmd, now);
            if (gridOn) cmd.DrawMesh(s.GridMesh, TunerGridMatrix(s), s.GridMat, 0, 0);
            RecordTunerTransparent(s, cmd, now);
        }
        RecordTunerOutline(s, cmd, now);
        TpAdd(TP_RECORD, stage);
        var prevActive = RenderTexture.active;
        var prevScreen = Shader.GetGlobalVector(TunerScreenParamsId);
        float prevZTest = Shader.GetGlobalFloat(TunerUiZTestId);
        var prevCamPos = Shader.GetGlobalVector(TunerCameraPosId);
        stage = TpNow();
        Graphics.ExecuteCommandBuffer(cmd);
        TpAdd(TP_EXECUTE, stage);
        Shader.SetGlobalVector(TunerScreenParamsId, prevScreen);
        Shader.SetGlobalFloat(TunerUiZTestId, prevZTest);
        Shader.SetGlobalVector(TunerCameraPosId, prevCamPos);
        stage = TpNow();
        DrawTunerSelectionWire(s, now);
        TpAdd(TP_WIRE, stage);
        stage = TpNow();
        DrawTunerGizmos(s, now);
        DrawTunerCanvasFrame(s, view, proj);
        TpAdd(TP_GIZMOS, stage);
        stage = TpNow();
        SealTunerAlpha(s);
        var src = s.Target;
        if (s.Resolve != null)
        {
            Graphics.Blit(s.Target, s.Resolve);
            src = s.Resolve;
        }
        RenderTexture.active = prevActive;
        TpAdd(TP_SEAL, stage);
        s.Seq++;
        stage = TpNow();
        var info = new TunerFrameInfo { Seq = s.Seq, W = w, H = h, Pos = s.CamPos, Rot = s.CamRot, Fov = s.Fov, Ortho = s.Ortho, Ack = s.TransformAck, AckRecvMs = s.TransformRecvMs, Poses = TunerFramePoses(s), Icons = TunerFrameIcons(s, now), CamSeq = s.CamSeq, CamRecvMs = s.CamRecvMs, StartMs = s.RenderStartMs, GapMs = _tunerTickGapMs };
        TpAdd(TP_INFO, stage);
        stage = TpNow();
        if (!SubmitTunerSurface(s, src, w, h, ref info, now)) s.Dirty = true;
        TpAdd(TP_SUBMIT, stage);
        return null;
    }

    static char[] _stw = new char[1024];
    static int _stwLen;
    static byte[] _stwBytes = new byte[4096];

    static void StwReset()
    {
        _stwLen = 0;
    }

    static void StwEnsure(int n)
    {
        if (_stwLen + n <= _stw.Length) return;
        Array.Resize(ref _stw, Math.Max(_stw.Length * 2, _stwLen + n));
    }

    static void StwRaw(string t)
    {
        StwEnsure(t.Length);
        t.CopyTo(0, _stw, _stwLen, t.Length);
        _stwLen += t.Length;
    }

    static void StwChar(char c)
    {
        StwEnsure(1);
        _stw[_stwLen++] = c;
    }

    static void StwLong(long v)
    {
        if (v < 0)
        {
            StwChar('-');
            v = -v;
        }
        StwEnsure(20);
        int start = _stwLen;
        do
        {
            _stw[_stwLen++] = (char)('0' + (int)(v % 10));
            v /= 10;
        } while (v > 0);
        for (int a = start, b = _stwLen - 1; a < b; a++, b--)
        {
            char t = _stw[a];
            _stw[a] = _stw[b];
            _stw[b] = t;
        }
    }

    static void StwFloat(float f)
    {
        if (float.IsNaN(f) || float.IsInfinity(f))
        {
            StwChar('0');
            return;
        }
        double d = f;
        if (d < 0)
        {
            StwChar('-');
            d = -d;
        }
        if (d >= 1e12)
        {
            StwRaw(d.ToString("R", Inv));
            return;
        }
        long ip = (long)d;
        long fp = (long)Math.Round((d - ip) * 1e6);
        if (fp >= 1000000)
        {
            ip++;
            fp -= 1000000;
        }
        StwLong(ip);
        if (fp == 0) return;
        int digits = 6;
        while (fp % 10 == 0)
        {
            fp /= 10;
            digits--;
        }
        StwChar('.');
        StwEnsure(digits);
        for (int i = digits - 1; i >= 0; i--)
        {
            _stw[_stwLen + i] = (char)('0' + (int)(fp % 10));
            fp /= 10;
        }
        _stwLen += digits;
    }

    static void StwVec(Vector3 v)
    {
        StwChar('[');
        StwFloat(v.x);
        StwChar(',');
        StwFloat(v.y);
        StwChar(',');
        StwFloat(v.z);
        StwChar(']');
    }

    static void StwQuat(Quaternion q)
    {
        StwChar('[');
        StwFloat(q.x);
        StwChar(',');
        StwFloat(q.y);
        StwChar(',');
        StwFloat(q.z);
        StwChar(',');
        StwFloat(q.w);
        StwChar(']');
    }

    static bool StwSend(ControlClient to)
    {
        if (to == null)
        {
            var sink = _tunerSink;
            if (sink == null) return false;
            try { sink(new string(_stw, 0, _stwLen)); }
            catch { return false; }
            return true;
        }
        int max = Encoding.UTF8.GetMaxByteCount(_stwLen) + 1;
        if (_stwBytes.Length < max) _stwBytes = new byte[Math.Max(max, _stwBytes.Length * 2)];
        int n = Encoding.UTF8.GetBytes(_stw, 0, _stwLen, _stwBytes, 0);
        _stwBytes[n++] = (byte)'\n';
        TpSent(_stw, _stwLen, n);
        return CtrlSendTo(to, _stwBytes, n);
    }

    static void StwFrameHead(TunerSession s, ref TunerFrameInfo f)
    {
        StwReset();
        StwRaw("{\"type\":\"event\",\"event\":\"tuner/frame\",\"session\":");
        StwRaw(s.NameJson);
        StwRaw(",\"seq\":");
        StwLong(f.Seq);
        if (f.Ack > 0)
        {
            StwRaw(",\"ack\":");
            StwLong(f.Ack);
            StwRaw(",\"xr\":");
            StwMs(f.AckRecvMs);
        }
        StwRaw(",\"width\":");
        StwLong(f.W);
        StwRaw(",\"height\":");
        StwLong(f.H);
        StwRaw(",\"camera\":{\"position\":");
        StwVec(f.Pos);
        StwRaw(",\"rotation\":");
        StwQuat(f.Rot);
        StwRaw(",\"fov\":");
        StwFloat(f.Fov);
        if (f.Ortho > 0f)
        {
            StwRaw(",\"ortho\":");
            StwFloat(f.Ortho);
        }
        StwRaw(",\"width\":");
        StwLong(f.W);
        StwRaw(",\"height\":");
        StwLong(f.H);
        StwChar('}');
        if (f.Poses != null)
        {
            StwRaw(",\"poses\":");
            StwRaw(f.Poses);
        }
        if (f.Icons != null)
        {
            StwRaw(",\"icons\":");
            StwRaw(f.Icons);
        }
        if (f.CamSeq > 0)
        {
            StwRaw(",\"lt\":[");
            StwLong(f.CamSeq);
            StwChar(',');
            StwMs(f.CamRecvMs);
            StwChar(',');
            StwMs(f.StartMs);
            StwChar(',');
            StwMs(f.EndMs);
        }
    }

    static void StwMs(double ms)
    {
        StwRaw(ms.ToString("0.###", Inv));
    }
}
