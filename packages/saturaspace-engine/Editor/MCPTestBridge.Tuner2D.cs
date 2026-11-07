using System;
using System.Collections.Generic;
using System.Linq.Expressions;
using System.Reflection;
using TMPro;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.UI;

public static partial class MCPTestBridge
{
    const int TUNER_TILE_VERTS = 400000;
    const long TUNER_TILE_CELLS = 4000000;
    const int TUNER_SLICE_QUADS = 20000;
    const double TUNER_TILE_REBUILD = 0.25;
    const ulong TUNER_HASH_SEED = 14695981039346656037UL;
    static readonly Vector4 TunerAlphaAdd = new Vector4(1f, 1f, 1f, 0f);
    static readonly Vector4 TunerNoSt = new Vector4(1f, 1f, 0f, 0f);
    static readonly Vector3[] _tunerCorners = new Vector3[4];
    static readonly List<Graphic> _tunerGraphicTmp = new List<Graphic>();
    static readonly List<Component> _tunerModTmp = new List<Component>();
    static readonly object[] _tunerPopulateArgs = new object[1];
    static VertexHelper _tunerVh;
    static MethodInfo _tunerPopulate;
    static bool _tunerPopulateKnown;
    static bool _tunerPopulateWarned;
    static bool _tunerTextHooked;

    static Type _tmType;
    static Type _tmRendType;
    static bool _tmKnown;
    static Func<Component, Vector3Int, Sprite> _tmSprite;
    static Func<Component, Vector3Int, Color> _tmColor;
    static Func<Component, Vector3Int, Matrix4x4> _tmMatrix;
    static Func<Component, Vector3Int, Vector3> _tmCenter;
    static Func<Component, int> _tmUsed;
    static PropertyInfo _tmBounds;
    static PropertyInfo _tmTint;
    static PropertyInfo _tmOrient;
    static PropertyInfo _tmAnchor;
    static PropertyInfo _tmSortOrder;
    static readonly Dictionary<Component, int> _tunerTileVersions = new Dictionary<Component, int>();

    class TunerTileGeo
    {
        public ulong Key;
        public Mesh Mesh;
        public List<Texture> Tex;
        public double BuiltAt;
        public int Seen;
    }

    class TunerSpriteGeo
    {
        public Vector2[] V;
        public Vector2[] Uv;
        public ushort[] Tri;
        public Mesh Mesh;
    }

    static bool TunerTilemapApi()
    {
        if (_tmKnown) return _tmType != null;
        _tmKnown = true;
        try
        {
            var type = Type.GetType("UnityEngine.Tilemaps.Tilemap, UnityEngine.TilemapModule");
            var rend = Type.GetType("UnityEngine.Tilemaps.TilemapRenderer, UnityEngine.TilemapModule");
            if (type == null || rend == null) return false;
            _tmType = type;
            _tmRendType = rend;
            _tmSprite = TunerTileFn<Sprite>("GetSprite");
            _tmColor = TunerTileFn<Color>("GetColor");
            _tmMatrix = TunerTileFn<Matrix4x4>("GetTransformMatrix");
            _tmCenter = TunerTileFn<Vector3>("GetCellCenterLocal");
            var used = type.GetMethod("GetUsedTilesCount", Type.EmptyTypes);
            if (used != null && used.ReturnType == typeof(int))
            {
                var c = Expression.Parameter(typeof(Component));
                _tmUsed = Expression.Lambda<Func<Component, int>>(Expression.Call(Expression.Convert(c, type), used), c).Compile();
            }
            _tmBounds = type.GetProperty("cellBounds");
            _tmTint = type.GetProperty("color");
            _tmOrient = type.GetProperty("orientationMatrix");
            _tmAnchor = type.GetProperty("tileAnchor");
            _tmSortOrder = rend.GetProperty("sortOrder");
            if (_tmSprite == null || _tmColor == null || _tmMatrix == null || _tmCenter == null || _tmBounds == null)
            {
                _tmType = null;
                Debug.LogWarning("[Tuner] this Unity version's Tilemap API is not the expected one, tilemaps are not drawn");
                return false;
            }
        }
        catch (Exception e)
        {
            _tmType = null;
            Debug.LogWarning("[Tuner] tilemaps are not drawn: " + e.Message);
            return false;
        }
        try
        {
            var ev = _tmType.GetEvent("tilemapTileChanged", BindingFlags.Public | BindingFlags.Static);
            var handler = typeof(MCPTestBridge).GetMethod(nameof(OnTunerTilesChanged), BindingFlags.NonPublic | BindingFlags.Static);
            if (ev != null && handler != null) ev.AddEventHandler(null, Delegate.CreateDelegate(ev.EventHandlerType, handler));
        }
        catch (Exception e)
        {
            Debug.LogWarning("[Tuner] tile changes are polled, the tilemap change event is unavailable: " + e.Message);
        }
        return true;
    }

    static Func<Component, Vector3Int, T> TunerTileFn<T>(string name)
    {
        var mi = _tmType.GetMethod(name, new[] { typeof(Vector3Int) });
        if (mi == null || mi.ReturnType != typeof(T)) return null;
        var c = Expression.Parameter(typeof(Component));
        var p = Expression.Parameter(typeof(Vector3Int));
        return Expression.Lambda<Func<Component, Vector3Int, T>>(Expression.Call(Expression.Convert(c, _tmType), mi, p), c, p).Compile();
    }

    static void OnTunerTilesChanged(Component tilemap, Array tiles)
    {
        if (_tuners.Count == 0 || ReferenceEquals(tilemap, null)) return;
        int v;
        _tunerTileVersions.TryGetValue(tilemap, out v);
        _tunerTileVersions[tilemap] = v + 1;
    }

    static void HookTunerText()
    {
        if (_tunerTextHooked) return;
        _tunerTextHooked = true;
        TMPro_EventManager.TEXT_CHANGED_EVENT.Add(OnTunerTextChanged);
    }

    static void OnTunerTextChanged(UnityEngine.Object o)
    {
        if (_tuners.Count == 0) return;
        foreach (var s in _tuners.Values)
            if (s.HasText) s.UiGen++;
        var t = o as TMP_Text;
        if (t != null) MarkTunerTextDirty(t);
    }

    static bool TunerIsTilemap(Renderer r)
    {
        return TunerTilemapApi() && _tmRendType.IsInstanceOfType(r);
    }

    static bool TunerRendAlive(TunerRend e)
    {
        if (e.Kind == TunerKind.Graphic) return e.G != null && e.Rect != null;
        return e.R != null;
    }

    static bool TunerRendVisible(TunerRend e)
    {
        if (e.Kind != TunerKind.Graphic)
            return e.R.enabled && e.Go.activeInHierarchy && (e.Kind != TunerKind.Sprite || e.SpriteR.sprite != null) && !TunerVisHidden(e.Go);
        return e.G.isActiveAndEnabled && e.Canvas != null && e.Canvas.isActiveAndEnabled && !TunerVisHidden(e.G.gameObject);
    }

    static int AddTunerSprite(TunerSession s, SpriteRenderer sr)
    {
        var e = new TunerRend
        {
            Kind = TunerKind.Sprite,
            R = sr,
            Go = sr.gameObject,
            T = sr.transform,
            SpriteR = sr
        };
        s.Rends.Add(e);
        s.Draws.Add(new TunerDraw { Rend = e, Transparent = true, Flat = true, Cutoff = -1f, ColorId = -1, TexId = -1, St = TunerNoSt });
        return s.Rends.Count - 1;
    }

    static int AddTunerTilemap(TunerSession s, Renderer r, double now)
    {
        var tm = r.GetComponent(_tmType);
        if (tm == null) return -1;
        var e = new TunerRend
        {
            Kind = TunerKind.Tilemap,
            R = r,
            Go = r.gameObject,
            T = r.transform,
            Tiles = tm
        };
        try { UseTunerTilemap(s, e, now); }
        catch (Exception ex)
        {
            Debug.LogWarning("[Tuner] could not read the tilemap " + r.name + ": " + ex.Message);
            e.TileTex = new List<Texture>();
            e.Shown = null;
        }
        s.Rends.Add(e);
        for (int k = 0; k < e.TileTex.Count; k++)
            s.Draws.Add(new TunerDraw
            {
                Rend = e,
                Sub = k,
                Transparent = true,
                Flat = true,
                VertexColor = true,
                Cutoff = -1f,
                ColorId = -1,
                TexId = -1,
                Tex = e.TileTex[k],
                St = TunerNoSt,
                Color = Color.white
            });
        return s.Rends.Count - 1;
    }

    static void CollectTunerGraphics(TunerSession s, GameObject go, Dictionary<Component, int> index, List<int> idx)
    {
        go.GetComponentsInChildren(true, _tunerGraphicTmp);
        foreach (var g in _tunerGraphicTmp)
        {
            int at;
            if (g != null && index.TryGetValue(g, out at) && at >= 0) idx.Add(at);
        }
        _tunerGraphicTmp.Clear();
    }

    static Canvas TunerSortingCanvas(Canvas c)
    {
        for (var cur = c; cur != null;)
        {
            if (cur.isRootCanvas || cur.overrideSorting) return cur;
            var parent = cur.transform.parent;
            cur = parent != null ? parent.GetComponentInParent<Canvas>(true) : null;
        }
        return c;
    }

    static readonly List<SortingGroup> _tunerSortGroups = new List<SortingGroup>();

    static void TunerSortKeys(TunerRend e, Vector3 cam, Vector3 fwd)
    {
        var levels = e.Levels;
        levels.Clear();
        if (e.Kind == TunerKind.Graphic)
        {
            var c = e.SortCanvas != null ? e.SortCanvas : e.Canvas;
            levels.Add(new TunerSortLevel
            {
                Obj = c != null ? (UnityEngine.Object)c : e.G,
                Layer = c != null ? SortingLayer.GetLayerValueFromID(c.sortingLayerID) : 0,
                Order = c != null ? c.sortingOrder : 0,
                Depth = e.Overlay ? 0f : Vector3.Dot((c != null ? c.transform.position : e.T.position) - cam, fwd)
            });
            return;
        }
        var groups = _tunerSortGroups;
        e.T.GetComponentsInParent(false, groups);
        int root = -1;
        for (int i = 0; i < groups.Count; i++)
        {
            if (!groups[i].isActiveAndEnabled) continue;
            root = i;
            if (groups[i].sortAtRoot) break;
        }
        for (int i = root; i >= 0; i--)
        {
            var g = groups[i];
            if (!g.isActiveAndEnabled) continue;
            levels.Add(new TunerSortLevel
            {
                Obj = g,
                Layer = SortingLayer.GetLayerValueFromID(g.sortingLayerID),
                Order = g.sortingOrder,
                Depth = Vector3.Dot(g.transform.position - cam, fwd)
            });
        }
        groups.Clear();
        var r = e.R;
        levels.Add(new TunerSortLevel
        {
            Obj = r,
            Layer = SortingLayer.GetLayerValueFromID(r.sortingLayerID),
            Order = r.sortingOrder,
            Depth = Vector3.Dot(r.bounds.center - cam, fwd)
        });
    }

    static ulong HashTuner2DGeometry(TunerSession s, TunerRend e, ulong h, double now)
    {
        switch (e.Kind)
        {
            case TunerKind.Sprite:
            {
                var sr = e.SpriteR;
                var sp = sr.sprite;
                var mode = sr.drawMode;
                var size = mode == SpriteDrawMode.Simple ? Vector2.zero : sr.size;
                ulong key = TunerMix(TunerMix(TunerMix(TunerMix(TUNER_HASH_SEED, sp), (uint)mode), size.x), size.y);
                if (key != e.Key || e.Shown == null)
                {
                    e.Key = key;
                    e.Shown = sp == null ? null : mode == SpriteDrawMode.Simple ? TunerSpriteMesh(s, sp) : BuildTunerSliced(s, e, sp, mode, size);
                }
                h = TunerMix(h, (uint)key);
                h = TunerMix(h, (uint)(key >> 32));
                return TunerMix(h, (sr.flipX ? 1u : 0u) | (sr.flipY ? 2u : 0u));
            }
            case TunerKind.Tilemap:
            {
                ulong sig;
                try { sig = TunerTileSig(e); }
                catch (Exception) { sig = e.Key; }
                if (sig != e.Key && now - e.BuiltAt >= TUNER_TILE_REBUILD) s.CacheDirty = true;
                h = TunerMix(h, (uint)sig);
                h = TunerMix(h, (uint)(sig >> 32));
                h = TunerMix(h, (uint)e.Key);
                return TunerMix(h, (uint)(e.Key >> 32));
            }
            default:
                return h;
        }
    }

    static ulong HashTuner2DDraw(TunerRend e, TunerDraw d, ulong h)
    {
        switch (e.Kind)
        {
            case TunerKind.Sprite:
            {
                var sr = e.SpriteR;
                var sp = sr.sprite;
                d.Tex = sp != null ? sp.texture : null;
                d.Color = sr.color;
                d.TexAdd = Vector4.zero;
                d.Matrix = sr.flipX || sr.flipY
                    ? e.T.localToWorldMatrix * Matrix4x4.Scale(new Vector3(sr.flipX ? -1f : 1f, sr.flipY ? -1f : 1f, 1f))
                    : e.T.localToWorldMatrix;
                break;
            }
            case TunerKind.Tilemap:
                d.Matrix = e.T.localToWorldMatrix;
                break;
            default:
                return h;
        }
        h = TunerMix(h, d.Color.r);
        h = TunerMix(h, d.Color.g);
        h = TunerMix(h, d.Color.b);
        h = TunerMix(h, d.Color.a);
        return TunerMix(h, d.Tex);
    }

    static TunerSpriteGeo TunerSpriteGeoOf(TunerSession s, Sprite sp)
    {
        TunerSpriteGeo g;
        if (s.SpriteGeo.TryGetValue(sp, out g)) return g;
        g = null;
        try
        {
            var v = sp.vertices;
            var uv = sp.uv;
            var tri = sp.triangles;
            if (v != null && uv != null && tri != null && v.Length > 0 && v.Length == uv.Length)
                g = new TunerSpriteGeo { V = v, Uv = uv, Tri = tri };
        }
        catch (Exception) { }
        s.SpriteGeo[sp] = g;
        return g;
    }

    static Mesh TunerSpriteMesh(TunerSession s, Sprite sp)
    {
        var g = TunerSpriteGeoOf(s, sp);
        if (g == null) return null;
        if (g.Mesh != null) return g.Mesh;
        int n = g.V.Length;
        var v = new Vector3[n];
        var nrm = new Vector3[n];
        for (int k = 0; k < n; k++)
        {
            v[k] = g.V[k];
            nrm[k] = Vector3.back;
        }
        var t = new int[g.Tri.Length];
        for (int k = 0; k < t.Length; k++) t[k] = g.Tri[k];
        g.Mesh = new Mesh { name = "_SaturaTunerSprite", hideFlags = HideFlags.HideAndDontSave };
        g.Mesh.vertices = v;
        g.Mesh.normals = nrm;
        g.Mesh.uv = g.Uv;
        g.Mesh.triangles = t;
        return g.Mesh;
    }

    static void ClearTunerSpriteGeo(TunerSession s)
    {
        foreach (var g in s.SpriteGeo.Values)
            if (g != null && g.Mesh != null) UnityEngine.Object.DestroyImmediate(g.Mesh);
        s.SpriteGeo.Clear();
    }

    static Mesh BuildTunerSliced(TunerSession s, TunerRend e, Sprite sp, SpriteDrawMode mode, Vector2 size)
    {
        Rect tr;
        try { tr = sp.textureRect; }
        catch (Exception) { return TunerSpriteMesh(s, sp); }
        var tex = sp.texture;
        var rect = sp.rect;
        if (tex == null || rect.width <= 0f || rect.height <= 0f) return TunerSpriteMesh(s, sp);
        float ppu = sp.pixelsPerUnit > 0f ? sp.pixelsPerUnit : 100f;
        var border = sp.border;
        var pivot = sp.pivot;
        float w = Mathf.Abs(size.x), h = Mathf.Abs(size.y);
        float x0 = -pivot.x / rect.width * w, y0 = -pivot.y / rect.height * h;
        float l = border.x / ppu, b = border.y / ppu, r = border.z / ppu, t = border.w / ppu;
        if (l + r > w && l + r > 0f)
        {
            float k = w / (l + r);
            l *= k;
            r *= k;
        }
        if (b + t > h && b + t > 0f)
        {
            float k = h / (b + t);
            b *= k;
            t *= k;
        }
        float tw = tex.width, th = tex.height;
        bool tiled = mode == SpriteDrawMode.Tiled;
        float tileW = (rect.width - border.x - border.z) / ppu, tileH = (rect.height - border.y - border.w) / ppu;
        var xs = TunerSegments(x0, w, l, r, tr.xMin / tw, tr.xMax / tw, (tr.xMin + border.x) / tw, (tr.xMax - border.z) / tw, tiled ? tileW : 0f);
        var ys = TunerSegments(y0, h, b, t, tr.yMin / th, tr.yMax / th, (tr.yMin + border.y) / th, (tr.yMax - border.w) / th, tiled ? tileH : 0f);
        if ((long)xs.Count * ys.Count > TUNER_SLICE_QUADS)
        {
            xs = TunerSegments(x0, w, l, r, tr.xMin / tw, tr.xMax / tw, (tr.xMin + border.x) / tw, (tr.xMax - border.z) / tw, 0f);
            ys = TunerSegments(y0, h, b, t, tr.yMin / th, tr.yMax / th, (tr.yMin + border.y) / th, (tr.yMax - border.w) / th, 0f);
        }
        int quads = xs.Count * ys.Count;
        var verts = new Vector3[quads * 4];
        var uvs = new Vector2[quads * 4];
        var nrm = new Vector3[quads * 4];
        var tris = new int[quads * 6];
        int q = 0;
        foreach (var y in ys)
        {
            foreach (var x in xs)
            {
                int v = q * 4, i = q * 6;
                verts[v] = new Vector3(x.x, y.x, 0f);
                verts[v + 1] = new Vector3(x.x, y.y, 0f);
                verts[v + 2] = new Vector3(x.y, y.y, 0f);
                verts[v + 3] = new Vector3(x.y, y.x, 0f);
                uvs[v] = new Vector2(x.z, y.z);
                uvs[v + 1] = new Vector2(x.z, y.w);
                uvs[v + 2] = new Vector2(x.w, y.w);
                uvs[v + 3] = new Vector2(x.w, y.z);
                for (int k = 0; k < 4; k++) nrm[v + k] = Vector3.back;
                tris[i] = v;
                tris[i + 1] = v + 1;
                tris[i + 2] = v + 2;
                tris[i + 3] = v + 2;
                tris[i + 4] = v + 3;
                tris[i + 5] = v;
                q++;
            }
        }
        if (e.Own == null) e.Own = new Mesh { name = "_SaturaTunerSliced", hideFlags = HideFlags.HideAndDontSave, indexFormat = IndexFormat.UInt32 };
        e.Own.Clear();
        e.Own.vertices = verts;
        e.Own.normals = nrm;
        e.Own.uv = uvs;
        e.Own.triangles = tris;
        return e.Own;
    }

    static List<Vector4> TunerSegments(float start, float len, float lo, float hi, float u0, float u3, float u1, float u2, float tile)
    {
        var o = new List<Vector4>();
        float a = start + lo, z = start + len - hi;
        if (lo > 0f) o.Add(new Vector4(start, a, u0, u1));
        if (z > a)
        {
            if (tile > 1e-5f && (z - a) / tile <= TUNER_SLICE_QUADS)
            {
                for (float p = a; p < z - 1e-5f; p += tile)
                {
                    float n = Mathf.Min(p + tile, z);
                    o.Add(new Vector4(p, n, u1, u1 + (u2 - u1) * (n - p) / tile));
                }
            }
            else o.Add(new Vector4(a, z, u1, u2));
        }
        if (hi > 0f) o.Add(new Vector4(z, start + len, u2, u3));
        return o;
    }

    static ulong TunerTileSig(TunerRend e)
    {
        var tm = e.Tiles;
        ulong h = TUNER_HASH_SEED;
        var b = (BoundsInt)_tmBounds.GetValue(tm);
        unchecked
        {
            h = TunerMix(h, (uint)b.xMin);
            h = TunerMix(h, (uint)b.yMin);
            h = TunerMix(h, (uint)b.zMin);
            h = TunerMix(h, (uint)b.size.x);
            h = TunerMix(h, (uint)b.size.y);
            h = TunerMix(h, (uint)b.size.z);
            if (_tmUsed != null) h = TunerMix(h, (uint)_tmUsed(tm));
            if (_tmTint != null)
            {
                var c = (Color)_tmTint.GetValue(tm);
                h = TunerMix(TunerMix(TunerMix(TunerMix(h, c.r), c.g), c.b), c.a);
            }
            if (_tmOrient != null) h = TunerMix(h, (Matrix4x4)_tmOrient.GetValue(tm));
            if (_tmAnchor != null) h = TunerMix(h, (Vector3)_tmAnchor.GetValue(tm));
            if (_tmSortOrder != null) h = TunerMix(h, (uint)Convert.ToInt32(_tmSortOrder.GetValue(e.R)));
            int v;
            if (_tunerTileVersions.TryGetValue(tm, out v)) h = TunerMix(h, (uint)v);
        }
        return h;
    }

    static void UseTunerTilemap(TunerSession s, TunerRend e, double now)
    {
        TunerTileGeo g;
        s.TileGeo.TryGetValue(e.Tiles, out g);
        if (g != null && g.Mesh != null && g.Key == TunerTileSig(e))
        {
            e.Key = g.Key;
            e.Shown = g.Mesh;
            e.TileTex = g.Tex;
            e.BuiltAt = g.BuiltAt;
            g.Seen = s.TileGeoGen;
            return;
        }
        if (g == null)
        {
            g = new TunerTileGeo();
            s.TileGeo[e.Tiles] = g;
        }
        e.Own = g.Mesh;
        g.Mesh = null;
        BuildTunerTilemap(s, e, now);
        g.Key = e.Key;
        g.Mesh = e.Own;
        g.Tex = e.TileTex;
        g.BuiltAt = e.BuiltAt;
        g.Seen = s.TileGeoGen;
        e.Own = null;
    }

    static readonly List<Component> _tunerTileGone = new List<Component>();

    static void ClearTunerTileGeo(TunerSession s, bool unseenOnly)
    {
        _tunerTileGone.Clear();
        foreach (var kv in s.TileGeo)
            if (!unseenOnly || kv.Value.Seen != s.TileGeoGen || kv.Key == null) _tunerTileGone.Add(kv.Key);
        foreach (var k in _tunerTileGone)
        {
            var g = s.TileGeo[k];
            if (g.Mesh != null) UnityEngine.Object.DestroyImmediate(g.Mesh);
            s.TileGeo.Remove(k);
        }
        _tunerTileGone.Clear();
    }

    static void BuildTunerTilemap(TunerSession s, TunerRend e, double now)
    {
        e.BuiltAt = now;
        e.TileTex = new List<Texture>();
        e.Key = TunerTileSig(e);
        var tm = e.Tiles;
        var bounds = (BoundsInt)_tmBounds.GetValue(tm);
        var tint = _tmTint != null ? (Color)_tmTint.GetValue(tm) : Color.white;
        var orient = _tmOrient != null ? (Matrix4x4)_tmOrient.GetValue(tm) : Matrix4x4.identity;
        int sort = _tmSortOrder != null ? Convert.ToInt32(_tmSortOrder.GetValue(e.R)) : 0;
        bool fromRight = sort == 1 || sort == 3, fromTop = sort == 2 || sort == 3;
        var verts = new List<Vector3>();
        var uvs = new List<Vector2>();
        var cols = new List<Color>();
        var tris = new List<List<int>>();
        var subOf = new Dictionary<Texture, int>();
        long cells = (long)bounds.size.x * bounds.size.y * bounds.size.z;
        bool full = cells > TUNER_TILE_CELLS;
        for (int z = bounds.zMin; z < bounds.zMax && !full; z++)
        {
            for (int yi = 0; yi < bounds.size.y && !full; yi++)
            {
                int y = fromTop ? bounds.yMax - 1 - yi : bounds.yMin + yi;
                for (int xi = 0; xi < bounds.size.x; xi++)
                {
                    int x = fromRight ? bounds.xMax - 1 - xi : bounds.xMin + xi;
                    var pos = new Vector3Int(x, y, z);
                    var sp = _tmSprite(tm, pos);
                    if (sp == null) continue;
                    var tex = sp.texture;
                    if (tex == null) continue;
                    var geo = TunerSpriteGeoOf(s, sp);
                    if (geo == null) continue;
                    if (verts.Count + geo.V.Length > TUNER_TILE_VERTS)
                    {
                        full = true;
                        break;
                    }
                    int sub;
                    if (!subOf.TryGetValue(tex, out sub))
                    {
                        sub = tris.Count;
                        subOf[tex] = sub;
                        tris.Add(new List<int>());
                        e.TileTex.Add(tex);
                    }
                    var col = _tmColor(tm, pos) * tint;
                    var m = Matrix4x4.Translate(_tmCenter(tm, pos)) * orient * _tmMatrix(tm, pos);
                    int b0 = verts.Count;
                    for (int k = 0; k < geo.V.Length; k++)
                    {
                        verts.Add(m.MultiplyPoint3x4(geo.V[k]));
                        uvs.Add(geo.Uv[k]);
                        cols.Add(col);
                    }
                    var list = tris[sub];
                    for (int k = 0; k < geo.Tri.Length; k++) list.Add(b0 + geo.Tri[k]);
                }
            }
        }
        if (full) Debug.LogWarning("[Tuner] the tilemap " + e.Go.name + " is too large, only part of it is drawn");
        if (e.Own == null) e.Own = new Mesh { name = "_SaturaTunerTiles", hideFlags = HideFlags.HideAndDontSave, indexFormat = IndexFormat.UInt32 };
        e.Own.Clear();
        e.Own.SetVertices(verts);
        e.Own.SetUVs(0, uvs);
        e.Own.SetColors(cols);
        e.Own.subMeshCount = tris.Count;
        for (int k = 0; k < tris.Count; k++) e.Own.SetTriangles(tris[k], k, false);
        e.Shown = e.Own;
    }

    static bool TunerRectBounds(RectTransform rt, ref Bounds b, ref bool any)
    {
        if (rt == null) return false;
        var r = rt.rect;
        if (r.width <= 0f || r.height <= 0f) return false;
        rt.GetWorldCorners(_tunerCorners);
        for (int k = 0; k < 4; k++)
        {
            if (!any) b = new Bounds(_tunerCorners[k], Vector3.zero);
            else b.Encapsulate(_tunerCorners[k]);
            any = true;
        }
        return true;
    }

    static void TunerRendBounds(TunerRend e, ref Bounds b, ref bool any)
    {
        if (e.Kind == TunerKind.Graphic)
        {
            TunerRectBounds(e.Rect, ref b, ref any);
            return;
        }
        Bounds rb;
        if (!TunerRendererBounds(e.R, out rb)) return;
        if (!any) b = rb;
        else b.Encapsulate(rb);
        any = true;
    }

    static void TunerUiBounds(GameObject go, ref Bounds b, ref bool any)
    {
        go.GetComponentsInChildren(false, _tunerGraphicTmp);
        foreach (var g in _tunerGraphicTmp)
        {
            if (g == null || !g.isActiveAndEnabled || g.GetComponentInParent<Canvas>() == null || !g.TryGetComponent<CanvasRenderer>(out var cr) || cr.cull) continue;
            TunerRectBounds(g.rectTransform, ref b, ref any);
        }
        _tunerGraphicTmp.Clear();
        if (go.activeInHierarchy) TunerRectBounds(go.transform as RectTransform, ref b, ref any);
    }

    static bool TunerPlanar(TunerSession s)
    {
        if (s.Prefabs != null)
        {
            var ap = ActiveTunerPrefab(s);
            if (ap != null && ap.Ui) return true;
        }
        if (s.Scene) return EditorSettings.defaultBehaviorMode == EditorBehaviorMode.Mode2D;
        bool flat = false;
        foreach (var i in TunerActiveObjects(s))
        {
            var go = i < s.Objects.Length ? s.Objects[i] : null;
            if (go == null) continue;
            if (go.transform is RectTransform) flat = true;
            foreach (var r in go.GetComponentsInChildren<Renderer>(false))
            {
                if (r == null) continue;
                if (r is SpriteRenderer || TunerIsTilemap(r)) flat = true;
                else if (r is SkinnedMeshRenderer || (r is MeshRenderer && r.GetComponent<TMP_Text>() == null)) return false;
            }
            if (!flat && go.GetComponentInChildren<Graphic>(false) != null) flat = true;
        }
        return flat || EditorSettings.defaultBehaviorMode == EditorBehaviorMode.Mode2D;
    }
}
