using System.Collections.Generic;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const double TUNER_FOCUS_BOUNDS_EVERY = 0.25;
    const int TUNER_REST_BOUNDS_SLICE = 1500;
    const double TUNER_REST_RETRY = 0.5;
    const double TUNER_REST_ROOTS_EVERY = 5.0;
    const float TUNER_NEAR_MIN = 3f;
    const float TUNER_NEAR_MAX = 20f;
    static readonly List<GameObject> _tunerFocusRoots = new List<GameObject>();
    static readonly HashSet<Renderer> _tunerRestSeen = new HashSet<Renderer>();
    static readonly Dictionary<GameObject, int> _tunerRestGroupOf = new Dictionary<GameObject, int>();
    static readonly List<Bounds> _tunerRestGroupBounds = new List<Bounds>();

    class TunerRestState
    {
        public int AllGen = -1;
        public int RendsGen = -1;
        public int DrawsGen = -1;
        public string[] FocusIds;
        public bool FocusOn;
        public int FocusCount = -1;
        public double BuiltAt = -1;
        public bool Missing;
        public bool Particles;
        public int Built;
        public bool Active;
        public readonly List<Renderer> Hide = new List<Renderer>();
        public Bounds[] HideBounds = new Bounds[0];
        public bool[] Far = new bool[0];
        public int[] Group = new int[0];
        public bool[] GroupNear = new bool[0];
        public readonly Dictionary<Renderer, int> Index = new Dictionary<Renderer, int>();
        public readonly Dictionary<Renderer, Bounds> Known = new Dictionary<Renderer, Bounds>();
        public int BoundsBuilt = -1;
        public int BoundsNext;
        public readonly List<Renderer> Shown = new List<Renderer>();
        public readonly HashSet<Renderer> ShownSet = new HashSet<Renderer>();
        public readonly List<GameObject> Roots = new List<GameObject>();
        public readonly List<GameObject> HiddenRoots = new List<GameObject>();
        public readonly List<Renderer> Extra = new List<Renderer>();
        public double ExtraAt = -1;
        public double RootsAt = -1;
        public double FocusAt = -1;
        public bool HasBounds;
        public Bounds FocusBounds;
        public float Near;
        public string Report;
    }

    static readonly Dictionary<TunerViewState, TunerRestState> _tunerRest = new Dictionary<TunerViewState, TunerRestState>();

    static TunerRestState TunerRestOf(TunerViewState v)
    {
        TunerRestState r;
        if (!_tunerRest.TryGetValue(v, out r))
        {
            r = new TunerRestState();
            _tunerRest[v] = r;
        }
        return r;
    }

    static bool TunerCullsFar(TunerSession s, TunerViewState v)
    {
        if (v.Context) return false;
        bool focus = v.FocusOn && v.FocusIds.Length > 0;
        if (focus && !v.FocusTree) return true;
        if (s.Scene) return focus;
        return !TunerKeepsWorld(s);
    }

    static void CollectTunerFocusRoots(TunerSession s, TunerViewState v, double now)
    {
        _tunerFocusRoots.Clear();
        if (v.FocusOn && v.FocusIds.Length > 0)
            foreach (var go in ResolveTunerFocus(s, v, now))
                if (go != null) _tunerFocusRoots.Add(go);
        if (_tunerFocusRoots.Count > 0 || s.Scene) return;
        foreach (var oi in TunerActiveObjects(s))
        {
            var go = oi < s.Objects.Length ? s.Objects[oi] : null;
            if (go != null) _tunerFocusRoots.Add(go);
        }
        foreach (var e in s.Entries)
            if (!e.Asset && e.Go != null) _tunerFocusRoots.Add(e.Go);
    }

    static void HideTunerRest(TunerSession s, TunerViewState v)
    {
        var st = TunerRestOf(v);
        double now = EditorApplication.timeSinceStartup;
        st.Active = true;
        int focusCount = v.FocusOn ? ResolveTunerFocus(s, v, now).Count : 0;
        bool stale = st.AllGen != _tunerAllRendGen || st.RendsGen != s.RendsGen || st.DrawsGen != s.DrawsGen || st.Particles != v.ParticlesOff
            || !ReferenceEquals(st.FocusIds, v.FocusIds) || st.FocusOn != v.FocusOn || st.FocusCount != focusCount;
        if (!stale && (st.Missing || (st.Shown.Count == 0 && s.Draws.Count > 0)) && now - st.BuiltAt > TUNER_REST_RETRY)
        {
            _tunerAllRendGen = -1;
            RefreshTunerAllRends();
            stale = true;
        }
        if (stale)
        {
            st.AllGen = _tunerAllRendGen;
            st.RendsGen = s.RendsGen;
            st.DrawsGen = s.DrawsGen;
            st.Particles = v.ParticlesOff;
            st.FocusIds = v.FocusIds;
            st.FocusOn = v.FocusOn;
            st.FocusCount = focusCount;
            st.BuiltAt = now;
            st.Missing = false;
            st.Built++;
            st.FocusAt = -1;
            CollectTunerFocusRoots(s, v, now);
            st.Roots.Clear();
            st.Roots.AddRange(_tunerFocusRoots);
            _tunerFocusRoots.Clear();
            st.Shown.Clear();
            st.ShownSet.Clear();
            foreach (var root in st.Roots)
            {
                root.GetComponentsInChildren(false, _tunerRendScratch);
                foreach (var r in _tunerRendScratch)
                    if (r != null && st.ShownSet.Add(r)) st.Shown.Add(r);
            }
            _tunerRendScratch.Clear();
            st.Known.Clear();
            for (int i = 0; i < st.Hide.Count && i < st.HideBounds.Length; i++)
                if (!ReferenceEquals(st.Hide[i], null)) st.Known[st.Hide[i]] = st.HideBounds[i];
            st.Hide.Clear();
            st.Index.Clear();
            _tunerRestSeen.Clear();
            foreach (var r in _tunerAllRends) AddTunerRest(st, v, r);
            foreach (var e in s.Rends) AddTunerRest(st, v, e.R);
            _tunerRestSeen.Clear();
            GroupTunerRest(st);
            st.ExtraAt = -1;
        }
        int n = st.Hide.Count;
        if (st.BoundsBuilt != st.Built)
        {
            st.BoundsBuilt = st.Built;
            st.BoundsNext = 0;
            if (st.HideBounds.Length != n) st.HideBounds = new Bounds[n];
            if (st.Far.Length != n) st.Far = new bool[n];
            for (int i = 0; i < n; i++)
            {
                Bounds b;
                st.HideBounds[i] = st.Known.TryGetValue(st.Hide[i], out b) ? b : TunerRestBounds(st.Hide[i]);
            }
            st.Known.Clear();
        }
        else if (n > 0)
        {
            int slice = Mathf.Min(n, TUNER_REST_BOUNDS_SLICE);
            for (int k = 0; k < slice; k++)
            {
                int i = (st.BoundsNext + k) % n;
                st.HideBounds[i] = TunerRestBounds(st.Hide[i]);
            }
            st.BoundsNext = (st.BoundsNext + slice) % n;
        }
        if (st.FocusAt < 0 || now - st.FocusAt >= TUNER_FOCUS_BOUNDS_EVERY)
        {
            st.FocusAt = now;
            Bounds fb;
            st.HasBounds = TunerFocusBounds(st, out fb);
            if (st.HasBounds)
            {
                st.FocusBounds = fb;
                st.Near = Mathf.Clamp(fb.extents.magnitude * 0.5f + 2f, TUNER_NEAR_MIN, TUNER_NEAR_MAX);
            }
        }
        System.Array.Clear(st.GroupNear, 0, st.GroupNear.Length);
        for (int i = 0; i < n; i++)
        {
            bool far = !st.HasBounds || (v.ParticlesOff && st.Hide[i] is ParticleSystemRenderer) || TunerBoundsGap(st.HideBounds[i], st.FocusBounds) > st.Near;
            st.Far[i] = far;
            int g = st.Group[i];
            if (!far && g >= 0) st.GroupNear[g] = true;
        }
        int near = 0, culled = 0;
        for (int i = 0; i < n; i++)
        {
            var r = st.Hide[i];
            var b = st.HideBounds[i];
            int g = st.Group[i];
            bool far = st.Far[i] && !(g >= 0 && st.GroupNear[g] && !(v.ParticlesOff && r is ParticleSystemRenderer));
            st.Far[i] = far;
            if (!far)
            {
                near++;
                continue;
            }
            culled++;
            if (!TunerInFrustum(b)) continue;
            if (r == null)
            {
                st.Missing = true;
                continue;
            }
            if (r.forceRenderingOff) continue;
            r.forceRenderingOff = true;
            _tunerHidden.Add(r);
        }
        if (st.RootsAt < 0 || now - st.RootsAt >= TUNER_REST_ROOTS_EVERY)
        {
            st.RootsAt = now;
            st.ExtraAt = -1;
            st.HiddenRoots.Clear();
            foreach (var r in Resources.FindObjectsOfTypeAll<Renderer>())
            {
                if (r == null || r.gameObject.scene.IsValid() || EditorUtility.IsPersistent(r) || !r.gameObject.activeInHierarchy) continue;
                var root = r.transform.root.gameObject;
                if (!st.HiddenRoots.Contains(root)) st.HiddenRoots.Add(root);
            }
        }
        if (st.HiddenRoots.Count > 0 && (st.ExtraAt < 0 || now - st.ExtraAt >= TUNER_REST_RETRY))
        {
            st.ExtraAt = now;
            st.Extra.Clear();
            foreach (var root in st.HiddenRoots)
            {
                if (root == null) continue;
                root.GetComponentsInChildren(false, _tunerRendScratch);
                foreach (var r in _tunerRendScratch)
                    if (!st.ShownSet.Contains(r)) st.Extra.Add(r);
            }
            _tunerRendScratch.Clear();
        }
        foreach (var r in st.Extra)
        {
            if (r == null || r.forceRenderingOff) continue;
            r.forceRenderingOff = true;
            _tunerHidden.Add(r);
        }
        int terrains = HideTunerFarTerrains(st);
        LogTunerViewChange(s, ref st.Report, "focus: " + st.Shown.Count + " renderers in the filter, " + near + " outside it within "
            + st.Near.ToString("0.#", Inv) + " m drawn as they are, " + culled + " farther away and " + terrains + " terrains not drawn");
    }

    static void GroupTunerRest(TunerRestState st)
    {
        int n = st.Hide.Count;
        if (st.Group.Length != n) st.Group = new int[n];
        _tunerRestGroupOf.Clear();
        _tunerRestGroupBounds.Clear();
        for (int i = 0; i < n; i++)
        {
            st.Group[i] = -1;
            var r = st.Hide[i];
            var root = r != null ? PrefabUtility.GetOutermostPrefabInstanceRoot(r.gameObject) : null;
            if (root == null) continue;
            int g;
            if (!_tunerRestGroupOf.TryGetValue(root, out g))
            {
                g = _tunerRestGroupBounds.Count;
                _tunerRestGroupOf[root] = g;
                _tunerRestGroupBounds.Add(new Bounds(root.transform.position, Vector3.zero));
            }
            if (!(r is ParticleSystemRenderer))
            {
                var gb = _tunerRestGroupBounds[g];
                gb.Encapsulate(r.bounds);
                _tunerRestGroupBounds[g] = gb;
            }
            st.Group[i] = g;
        }
        for (int i = 0; i < n; i++)
            if (st.Group[i] >= 0 && _tunerRestGroupBounds[st.Group[i]].extents.magnitude > TUNER_NEAR_MAX) st.Group[i] = -1;
        if (st.GroupNear.Length != _tunerRestGroupBounds.Count) st.GroupNear = new bool[_tunerRestGroupBounds.Count];
        _tunerRestGroupOf.Clear();
        _tunerRestGroupBounds.Clear();
    }

    static void AddTunerRest(TunerRestState st, TunerViewState v, Renderer r)
    {
        if (r == null || !_tunerRestSeen.Add(r)) return;
        if (st.ShownSet.Contains(r) && !(v.ParticlesOff && r is ParticleSystemRenderer)) return;
        st.Index[r] = st.Hide.Count;
        st.Hide.Add(r);
    }

    static int HideTunerFarTerrains(TunerRestState st)
    {
        int n = 0;
        foreach (var t in _tunerAllTerrains)
        {
            if (t == null || !t.drawHeightmap || TunerTerrainInFocus(st, t)) continue;
            if (st.HasBounds && t.terrainData != null)
            {
                var tb = t.terrainData.bounds;
                tb.center += t.GetPosition();
                if (TunerBoundsGap(tb, st.FocusBounds) <= st.Near) continue;
            }
            t.drawHeightmap = false;
            t.drawTreesAndFoliage = false;
            _tunerHiddenTerrains.Add(t);
            n++;
        }
        return n;
    }

    static bool TunerTerrainInFocus(TunerRestState st, Terrain t)
    {
        foreach (var root in st.Roots)
            if (root != null && t.transform.IsChildOf(root.transform)) return true;
        return false;
    }

    static bool TunerCulledFar(TunerViewState v, Renderer r)
    {
        TunerRestState st;
        if (v == null || ReferenceEquals(r, null) || !_tunerRest.TryGetValue(v, out st) || !st.Active) return false;
        int i;
        return st.Index.TryGetValue(r, out i) && i < st.Far.Length && st.Far[i];
    }

    static void StopTunerRest(TunerViewState v)
    {
        TunerRestState st;
        if (_tunerRest.TryGetValue(v, out st)) st.Active = false;
    }

    static Bounds TunerRestBounds(Renderer r)
    {
        if (r == null) return new Bounds(Vector3.zero, -Vector3.one);
        var b = r.bounds;
        b.Expand(Vector3.one * 0.05f);
        return b;
    }

    static bool TunerFocusBounds(TunerRestState st, out Bounds b)
    {
        b = default;
        bool any = false;
        foreach (var r in st.Shown)
        {
            if (r == null || !r.enabled || !r.gameObject.activeInHierarchy) continue;
            var rb = r.bounds;
            if (rb.size == Vector3.zero && rb.center == Vector3.zero) continue;
            if (!any) b = rb;
            else b.Encapsulate(rb);
            any = true;
        }
        if (any) return true;
        foreach (var root in st.Roots)
        {
            if (root == null) continue;
            var p = root.transform.position;
            if (!any) b = new Bounds(p, Vector3.zero);
            else b.Encapsulate(p);
            any = true;
        }
        return any;
    }

    static float TunerBoundsGap(Bounds a, Bounds b)
    {
        if (a.extents.x < 0f) return float.MaxValue;
        var d = Vector3.Max(Vector3.zero, Vector3.Max(a.min - b.max, b.min - a.max));
        return d.magnitude;
    }

    static void ReleaseTunerRest()
    {
        _tunerRest.Clear();
        _tunerFocusRoots.Clear();
        _tunerRestSeen.Clear();
        _tunerRestGroupOf.Clear();
        _tunerRestGroupBounds.Clear();
    }
}
