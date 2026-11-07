using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    const int TUNER_MAX_MEMBERS = 1000000;
    const int TUNER_LAZY_MEMBERS = 20000;
    const int TUNER_TREE_HITS = 2000;
    const int TUNER_TREE_OPEN = 50000;
    const double TUNER_MEMBERS_POLL = 0.5;
    const double TUNER_MEMBERS_MIN = 0.1;
    const string TUNER_SCENE_PARENT = "scene:";

    class TunerRootList
    {
        public GameObject[] Gos;
        public string[] Names;
        public double At;
    }

    const double TUNER_ROOTS_REFRESH = 1.0;

    static bool TunerRootsStale(TunerRootList r)
    {
        for (int k = 0; k < r.Gos.Length; k++)
            if (r.Gos[k] == null) return true;
        return false;
    }

    static readonly Dictionary<Scene, TunerRootList> _tunerRoots = new Dictionary<Scene, TunerRootList>();
    static int _tunerRootsGen = -1;
    static readonly Dictionary<GameObject, int> _tunerTargetTmp = new Dictionary<GameObject, int>();

    const double TUNER_DESC_REFRESH = 2.0;

    static int _tunerStructureGen;

    static string DescribeTunerObjectCached(TunerSession s, int i)
    {
        if (s.DescCache == null || s.DescCache.Length != s.Specs.Length)
        {
            s.DescCache = new string[s.Specs.Length];
            s.DescKey = new ulong[s.Specs.Length];
        }
        ulong key = TunerObjectPoseHash(s, i);
        key = TunerMix(key, (uint)_tunerHierarchyGen);
        key = TunerMix(key, (uint)_tunerStructureGen);
        key = TunerMix(key, (uint)_tunerPrefabGen);
        key = TunerMix(key, (uint)(EditorApplication.timeSinceStartup / TUNER_DESC_REFRESH));
        key = TunerMix(key, EditorApplication.isPlaying ? 1u : 0u);
        if (s.DescCache[i] != null && s.DescKey[i] == key) return s.DescCache[i];
        var d = DescribeTunerObject(s, i);
        s.DescCache[i] = d;
        s.DescKey[i] = key;
        return d;
    }

    static bool TunerHasSubtrees(TunerSession s)
    {
        foreach (var i in TunerActiveObjects(s))
            if (s.Specs[i].children) return true;
        return false;
    }

    static string TunerUiError(TunerSession s, int i)
    {
        if (!s.Ui || i != 0 || s.Objects[i] == null) return null;
        var canvas = s.Objects[i].GetComponentInParent<Canvas>(true);
        if (canvas != null) return null;
        return s.Objects[i].name + " is not a Canvas or inside one. A UI Tuner needs a Canvas or an object under a Canvas; "
            + "use objects with \"children\": true for other objects";
    }

    static Canvas TunerUiCanvas(TunerSession s)
    {
        if (!s.Ui || s.Objects.Length == 0 || s.Objects[0] == null) return null;
        var canvas = s.Objects[0].GetComponentInParent<Canvas>(true);
        return canvas != null ? canvas.rootCanvas : null;
    }

    class TunerSceneSnap
    {
        public Scene Scene;
        public GameObject[] Roots;
        public string[] Names;
        public int[] Hier;
    }

    const double TUNER_MEMBERS_SCENES = 0.25;
    const double TUNER_MEMBERS_CHECK_PLAY = 0.05;
    const double TUNER_MEMBERS_SLICE_MS = 0.1;
    const double TUNER_MEMBERS_SLICE_MAX_MS = 1.0;
    const double TUNER_MEMBERS_SHARE = 0.005;
    const double TUNER_MEMBERS_ALL_MIN_PLAY = 0.25;
    const int TUNER_MEMBER_TOUCHED_MAX = 4096;

    static readonly HashSet<GameObject> _tunerMemberTouched = new HashSet<GameObject>();
    static bool _tunerMemberTouchedOverflow;
    static int _tunerMemberStructGen;

    static void NoteTunerMemberTouched(UnityEngine.Object o)
    {
        if (_tunerMemberTouchedOverflow) return;
        var go = o as GameObject;
        if (go == null)
        {
            var c = o as Component;
            if (c == null) return;
            go = c.gameObject;
        }
        if (_tunerMemberTouched.Count >= TUNER_MEMBER_TOUCHED_MAX)
        {
            _tunerMemberTouchedOverflow = true;
            _tunerMemberTouched.Clear();
            return;
        }
        _tunerMemberTouched.Add(go);
    }

    static void ClearTunerMemberTouched()
    {
        if (_tunerMemberTouchedOverflow) _tunerMemberStructGen++;
        _tunerMemberTouched.Clear();
        _tunerMemberTouchedOverflow = false;
    }

    static void TickTunerMembers(TunerSession s, double now)
    {
        if (s.Members.Count == 0 && !TunerHasSubtrees(s) && !s.Scene) return;
        bool playing = EditorApplication.isPlaying;
        if (s.MembersAt < 0 || s.MembersPlaying != playing)
        {
            RebuildTunerMembers(s);
            return;
        }
        if (now - s.MembersScenesAt >= TUNER_MEMBERS_SCENES)
        {
            s.MembersScenesAt = now;
            if (TunerMemberScenesChanged(s))
            {
                RebuildTunerMembers(s);
                return;
            }
        }
        bool all = s.MembersGen != _tunerHierarchyGen || s.MembersStructGen != _tunerMemberStructGen;
        if (all && (!playing || now - s.MembersAt >= TUNER_MEMBERS_ALL_MIN_PLAY))
        {
            s.MembersGen = _tunerHierarchyGen;
            s.MembersStructGen = _tunerMemberStructGen;
            CheckTunerMemberRange(s, 0, s.Members.Count, false);
        }
        if (_tunerMemberTouched.Count > 0)
        {
            TunerEntry e;
            foreach (var go in _tunerMemberTouched)
                if (go != null && s.MemberByGo.TryGetValue(go, out e)) CheckTunerMember(s, e, true);
        }
        CheckTunerMemberTops(s);
        if (now >= s.MembersCheckNext)
        {
            double since = s.MembersRolledAt > 0 ? now - s.MembersRolledAt : TUNER_MEMBERS_CHECK_PLAY;
            s.MembersRolledAt = now;
            s.MembersCheckNext = playing ? now + TUNER_MEMBERS_CHECK_PLAY : now;
            RollTunerMemberChecks(s, System.Math.Min(TUNER_MEMBERS_SLICE_MAX_MS, System.Math.Max(TUNER_MEMBERS_SLICE_MS, since * 1000.0 * TUNER_MEMBERS_SHARE)));
        }
        if (s.PrefabGen != _tunerPrefabGen && now - s.MembersAt >= TUNER_MEMBERS_POLL) RefreshTunerPrefabStates(s);
        if (s.MembersRebuild && now - s.MembersAt >= (playing ? TUNER_MEMBERS_MIN_PLAY : TUNER_MEMBERS_MIN))
        {
            RebuildTunerMembers(s, true);
            OnTunerHierarchyChanged();
        }
    }

    static bool TunerMemberScenesChanged(TunerSession s)
    {
        if (!s.Scene) return false;
        var scenes = TunerSessionScenes(s);
        if (scenes.Count != s.MemberScenes.Count) return true;
        for (int k = 0; k < scenes.Count; k++)
            if (scenes[k] != s.MemberScenes[k].Scene) return true;
        return false;
    }

    static void SnapTunerMemberTops(TunerSession s)
    {
        s.MemberScenes.Clear();
        if (s.Scene)
            foreach (var sc in TunerSessionScenes(s))
            {
                var roots = TunerRootsOf(sc);
                var snap = new TunerSceneSnap { Scene = sc };
                if (roots != null)
                {
                    snap.Roots = (GameObject[])roots.Gos.Clone();
                    snap.Names = (string[])roots.Names.Clone();
                    snap.Hier = new int[snap.Roots.Length];
                    for (int k = 0; k < snap.Roots.Length; k++) snap.Hier[k] = snap.Roots[k] != null ? snap.Roots[k].transform.hierarchyCount : 0;
                }
                s.MemberScenes.Add(snap);
            }
        var active = TunerActiveObjects(s);
        if (s.TargetHier.Length != active.Length) s.TargetHier = new int[active.Length];
        for (int k = 0; k < active.Length; k++)
        {
            var go = s.Objects[active[k]];
            s.TargetHier[k] = go != null ? go.transform.hierarchyCount : -1;
        }
    }

    static void CheckTunerMemberTops(TunerSession s)
    {
        var active = TunerActiveObjects(s);
        if (active.Length != s.TargetHier.Length)
        {
            s.MembersRebuild = true;
            return;
        }
        for (int k = 0; k < active.Length; k++)
        {
            var go = s.Objects[active[k]];
            int hc = go != null ? go.transform.hierarchyCount : -1;
            if (hc == s.TargetHier[k]) continue;
            s.TargetHier[k] = hc;
            CheckTunerMemberRange(s, 0, s.Members.Count, false);
            s.MembersRebuild = true;
        }
        foreach (var snap in s.MemberScenes)
        {
            if (!snap.Scene.IsValid() || !snap.Scene.isLoaded || snap.Roots == null) continue;
            var roots = TunerRootsOf(snap.Scene);
            if (roots == null || roots.Gos.Length != snap.Roots.Length)
            {
                s.MembersRebuild = true;
                continue;
            }
            for (int k = 0; k < snap.Roots.Length; k++)
            {
                var go = snap.Roots[k];
                if (go == null || !ReferenceEquals(roots.Gos[k], go) || roots.Names[k] != snap.Names[k])
                {
                    s.MembersRebuild = true;
                    continue;
                }
                int hc = go.transform.hierarchyCount;
                if (hc == snap.Hier[k]) continue;
                snap.Hier[k] = hc;
                TunerEntry e;
                if (s.MemberByGo.TryGetValue(go, out e) && e.Gen == s.WalkGen && e.Idx < s.Members.Count && s.Members[e.Idx] == e)
                    CheckTunerMemberRange(s, e.Idx, e.Idx + e.Size + 1, false);
                else CheckTunerMemberRange(s, 0, s.Members.Count, false);
                s.MembersRebuild = true;
            }
        }
    }

    static void RollTunerMemberChecks(TunerSession s, double ms)
    {
        long budget = (long)(ms * System.Diagnostics.Stopwatch.Frequency / 1000.0);
        var sent = s.Sent ?? s.Members;
        if (sent.Count > 0)
        {
            long end = System.Diagnostics.Stopwatch.GetTimestamp() + budget;
            if (s.CheckSentAt >= sent.Count) s.CheckSentAt = 0;
            int start = s.CheckSentAt;
            do
            {
                CheckTunerMember(s, sent[s.CheckSentAt], true);
                if (++s.CheckSentAt >= sent.Count) s.CheckSentAt = 0;
            }
            while (s.CheckSentAt != start && ((s.CheckSentAt & 15) != 0 || System.Diagnostics.Stopwatch.GetTimestamp() < end));
        }
        if (s.MembersLazy && s.Members.Count > 0)
        {
            long end = System.Diagnostics.Stopwatch.GetTimestamp() + budget;
            if (s.CheckAllAt >= s.Members.Count) s.CheckAllAt = 0;
            int start = s.CheckAllAt;
            do
            {
                CheckTunerMember(s, s.Members[s.CheckAllAt], false);
                if (++s.CheckAllAt >= s.Members.Count) s.CheckAllAt = 0;
            }
            while (s.CheckAllAt != start && ((s.CheckAllAt & 15) != 0 || System.Diagnostics.Stopwatch.GetTimestamp() < end));
        }
    }

    static void CheckTunerMemberRange(TunerSession s, int from, int to, bool names)
    {
        if (to > s.Members.Count) to = s.Members.Count;
        for (int k = from < 0 ? 0 : from; k < to; k++) CheckTunerMember(s, s.Members[k], names);
    }

    static void CheckTunerMember(TunerSession s, TunerEntry e, bool names)
    {
        if (e.Gen != s.WalkGen) return;
        var go = e.Go;
        if (go == null)
        {
            MarkTunerMemberParent(s, e);
            return;
        }
        var t = go.transform;
        if (t.childCount != e.ChildCount) MarkTunerMember(s, e, false);
        if (go.activeSelf != e.ActiveSelf) MarkTunerMember(s, e, true);
        if (go.GetComponentCount() != e.Comps) MarkTunerMember(s, e, false);
        if (!names) return;
        var parent = t.parent;
        if (!ReferenceEquals(parent, e.ParentT))
        {
            MarkTunerMemberParent(s, e);
            TunerEntry np;
            if (parent != null && s.MemberByGo.TryGetValue(parent.gameObject, out np)) MarkTunerMember(s, np, false);
            else s.MembersRebuild = true;
            return;
        }
        if (go.name != e.Name) MarkTunerMemberParent(s, e);
    }

    static void MarkTunerMember(TunerSession s, TunerEntry e, bool deep)
    {
        s.MemberMarks.Add(e);
        if (deep) s.MemberDeep.Add(e);
        s.MembersRebuild = true;
    }

    static void MarkTunerMemberParent(TunerSession s, TunerEntry e)
    {
        TunerEntry up;
        if (!string.IsNullOrEmpty(e.Parent) && e.Parent[0] == 'm' && s.MemberById.TryGetValue(e.Parent, out up)) s.MemberMarks.Add(up);
        s.MembersRebuild = true;
    }

    static void MarkTunerMemberIds(TunerSession s, string[] ids, string parent)
    {
        TunerEntry e;
        if (ids != null)
            foreach (var id in ids)
                if (!string.IsNullOrEmpty(id) && s.MemberById.TryGetValue(id, out e))
                {
                    MarkTunerMemberParent(s, e);
                    s.MemberMarks.Add(e);
                }
        if (!string.IsNullOrEmpty(parent) && s.MemberById.TryGetValue(parent, out e)) s.MemberMarks.Add(e);
        s.MembersRebuild = true;
    }

    static void RefreshTunerPrefabStates(TunerSession s)
    {
        s.PrefabGen = _tunerPrefabGen;
        bool any = false;
        foreach (var e in s.Sent ?? s.Members)
        {
            if (!e.Filled || e.Go == null || TunerPrefabState(e.Go) == e.PrefabState) continue;
            FillTunerMember(e);
            any = true;
        }
        if (any) UpdateTunerSent(s);
    }

    static int _tunerPrefabGen;
    static int _tunerPrefabUpdateGen;
    const byte TUNER_PF_PART = 1, TUNER_PF_ADDED = 2, TUNER_PF_OVERRIDES = 4;
    static System.Func<GameObject, bool> _tunerHasOverridesCached;

    static bool TunerPrefabHasOverrides(GameObject go)
    {
        if (_tunerHasOverridesCached == null)
        {
            var m = typeof(PrefabUtility).GetMethod("HasPrefabInstanceNonDefaultOverridesOrUnusedOverrides_CachedForUI",
                System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic, null, new[] { typeof(GameObject) }, null);
            try { _tunerHasOverridesCached = m != null && m.ReturnType == typeof(bool) ? (System.Func<GameObject, bool>)System.Delegate.CreateDelegate(typeof(System.Func<GameObject, bool>), m) : null; }
            catch { _tunerHasOverridesCached = null; }
            if (_tunerHasOverridesCached == null) _tunerHasOverridesCached = g => PrefabUtility.HasPrefabInstanceAnyOverrides(g, false);
        }
        return _tunerHasOverridesCached(go);
    }

    static byte TunerPrefabState(GameObject go)
    {
        if (go == null || EditorApplication.isPlaying) return 0;
        if (!PrefabUtility.IsPartOfNonAssetPrefabInstance(go))
            return go.transform.parent != null && PrefabUtility.IsAddedGameObjectOverride(go) ? TUNER_PF_ADDED : (byte)0;
        byte st = TUNER_PF_PART;
        if (PrefabUtility.IsOutermostPrefabInstanceRoot(go) && TunerPrefabHasOverrides(go)) st |= TUNER_PF_OVERRIDES;
        return st;
    }

    static readonly HashSet<TunerEntry> _tunerWalkVisit = new HashSet<TunerEntry>();
    static HashSet<TunerEntry> _tunerWalkDeep;
    static List<TunerEntry> _tunerWalkOld;
    static int _tunerWalkGen;
    static int _tunerWalkOldGen;
    static bool _tunerWalkReuse;
    static int _tunerWalkNoReuse;

    static bool TunerMembersCanReuse(TunerSession s)
    {
        if (s.MembersCapped || s.Members.Count == 0) return false;
        if (!s.Scene) return true;
        foreach (var i in TunerActiveObjects(s))
            if (s.Objects[i] != null && s.Specs[i].children) return false;
        return true;
    }

    static void RebuildTunerMembers(TunerSession s)
    {
        RebuildTunerMembers(s, false);
    }

    static void RebuildTunerMembers(TunerSession s, bool reuse)
    {
        _tunerVariantPaths.Clear();
        if (reuse && s.Trail != null) s.Trail.Dirty = true;
        reuse = reuse && TunerMembersCanReuse(s);
        s.MembersAt = EditorApplication.timeSinceStartup;
        s.MembersGen = _tunerHierarchyGen;
        s.MembersStructGen = _tunerMemberStructGen;
        s.MembersPlaying = EditorApplication.isPlaying;
        s.PrefabGen = _tunerPrefabGen;
        s.MembersRebuild = false;
        var old = s.Members;
        int oldGen = s.WalkGen;
        int gen = ++s.WalkGen;
        var visit = _tunerWalkVisit;
        visit.Clear();
        if (reuse)
            foreach (var m in s.MemberMarks)
            {
                TunerEntry e = m;
                for (int guard = 0; e != null && guard < 4096 && e.Gen == oldGen && visit.Add(e); guard++)
                {
                    TunerEntry up;
                    e = e.Parent != null && e.Parent.Length > 0 && e.Parent[0] == 'm' && s.MemberById.TryGetValue(e.Parent, out up) ? up : null;
                }
            }
        s.MemberMarks.Clear();
        var list = new List<TunerEntry>(old.Count + 16);
        var byId = reuse ? s.MemberById : new Dictionary<string, TunerEntry>(old.Count);
        var byGo = reuse ? s.MemberByGo : new Dictionary<GameObject, TunerEntry>(old.Count);
        var prev = s.MemberById;
        var targets = _tunerTargetTmp;
        targets.Clear();
        var active = TunerActiveObjects(s);
        foreach (var i in active)
            if (s.Objects[i] != null && !targets.ContainsKey(s.Objects[i])) targets[s.Objects[i]] = i;
        _tunerWalkRt = s.Prefabs == null && EditorApplication.isPlaying && _tunerLoadedScenes.Count > 0;
        _tunerWalkLazy = s.Members.Count > TUNER_LAZY_MEMBERS;
        _tunerWalkGen = gen;
        _tunerWalkOldGen = oldGen;
        _tunerWalkOld = old;
        _tunerWalkReuse = reuse;
        _tunerWalkDeep = s.MemberDeep;
        _tunerWalkNoReuse = 0;
        ulong h;
        bool capped;
        _tunerWalkMax = int.MaxValue;
        try
        {
            capped = WalkAllTunerMembers(s, active, targets, prev, list, byId, byGo, out h);
            if (capped)
            {
                _tunerWalkReuse = false;
                gen = _tunerWalkGen = ++s.WalkGen;
                byId = new Dictionary<string, TunerEntry>(old.Count);
                byGo = new Dictionary<GameObject, TunerEntry>(old.Count);
                reuse = false;
                _tunerWalkMax = TunerMemberDepthLimit(s, active);
                list.Clear();
                WalkAllTunerMembers(s, active, targets, prev, list, byId, byGo, out h);
                _tunerWalkMax = int.MaxValue;
                _tunerWalkFill = true;
                try
                {
                    ulong fill;
                    WalkAllTunerMembers(s, active, targets, prev, list, byId, byGo, out fill);
                    h = h * 1099511628211UL ^ fill;
                }
                finally { _tunerWalkFill = false; }
            }
        }
        finally
        {
            _tunerWalkOld = null;
            _tunerWalkDeep = null;
            _tunerWalkReuse = false;
            visit.Clear();
        }
        s.MemberDeep.Clear();
        targets.Clear();
        if (reuse)
            foreach (var e in old)
            {
                if (e.Gen == gen) continue;
                TunerEntry cur;
                if (byId.TryGetValue(e.Id, out cur) && cur == e) byId.Remove(e.Id);
                if (!ReferenceEquals(e.Go, null) && byGo.TryGetValue(e.Go, out cur) && cur == e) byGo.Remove(e.Go);
            }
        if (capped)
            for (int k = 0; k < list.Count; k++)
            {
                list[k].Idx = k;
                list[k].Size = 0;
            }
        s.Members = list;
        s.MemberById = byId;
        s.MemberByGo = byGo;
        if (capped && !s.MembersCapped)
            Debug.LogWarning("[Tuner] " + s.Name + " has more than " + TUNER_MAX_MEMBERS + " objects, the hierarchy lists every object down to level " + (_tunerLastDepthLimit + 1) + " and deeper ones up to the limit");
        s.MembersCapped = capped;
        s.MembersLevels = capped ? _tunerLastDepthLimit + 1 : 0;
        s.MembersHash = h;
        SnapTunerMemberTops(s);
        UpdateTunerSent(s);
    }

    static bool ReuseTunerMember(TunerSession s, TunerEntry e, GameObject go, int c, string parentId, List<TunerEntry> list, Dictionary<string, TunerEntry> byId)
    {
        if (!_tunerWalkReuse || _tunerWalkNoReuse > 0 || _tunerWalkFill) return false;
        if (e.Gen != _tunerWalkOldGen || !ReferenceEquals(e.Go, go) || e.Index != c || e.Parent != parentId) return false;
        if (_tunerWalkVisit.Contains(e) || _tunerWalkDeep.Contains(e)) return false;
        var old = _tunerWalkOld;
        int end = e.Idx + e.Size;
        if (e.Idx < 0 || end >= old.Count || old[e.Idx] != e) return false;
        for (int k = e.Idx; k <= end; k++)
        {
            var x = old[k];
            x.Gen = _tunerWalkGen;
            x.Idx = list.Count;
            list.Add(x);
        }
        TunerEntry up;
        if (parentId.Length > 0 && parentId[0] == 'm' && byId.TryGetValue(parentId, out up)) up.Kids++;
        return true;
    }

    static void TunerTree(TunerArgs a)
    {
        var s = FindTuner(a.session);
        if (s == null) return;
        s.TreeOpen.Clear();
        if (a.ids != null)
            foreach (var x in a.ids)
            {
                if (s.TreeOpen.Count >= TUNER_TREE_OPEN) break;
                if (!string.IsNullOrEmpty(x) && x.Length <= 32) s.TreeOpen.Add(x);
            }
        s.TreeQuery = string.IsNullOrEmpty(a.query) || a.query.Trim().Length == 0 ? null : a.query.Trim();
        s.RevealPath = string.IsNullOrEmpty(a.path) ? null : a.path;
        s.RevealScene = a.scene;
        UpdateTunerSent(s);
    }

    static void TunerTreeChain(TunerSession s, TunerEntry e, HashSet<string> chain)
    {
        for (int guard = 0; e != null && guard < 4096 && chain.Add(e.Id); guard++)
        {
            TunerEntry up;
            e = e.Parent != null && e.Parent.Length > 0 && e.Parent[0] == 'm' && s.MemberById.TryGetValue(e.Parent, out up) ? up : null;
        }
    }

    static void UpdateTunerSent(TunerSession s)
    {
        bool lazy = s.Members.Count > TUNER_LAZY_MEMBERS;
        s.MembersLazy = lazy;
        s.RevealMissing = null;
        ulong h;
        if (!lazy)
        {
            s.Sent = s.Members;
            h = 14695981039346656037UL;
            foreach (var m in s.Members)
            {
                if (!m.Filled) FillTunerMember(m);
                h = TunerMix(h, (uint)m.Hash);
                h = TunerMix(h, (uint)(m.Hash >> 32));
            }
        }
        else
        {
            var chain = new HashSet<string>();
            TunerEntry e;
            foreach (var wid in s.WatchIds)
                if (s.MemberById.TryGetValue(wid, out e)) TunerTreeChain(s, e, chain);
            if (!string.IsNullOrEmpty(s.Inspected) && s.MemberById.TryGetValue(s.Inspected, out e)) TunerTreeChain(s, e, chain);
            if (s.RevealPath != null)
            {
                var go = TiFindObject(s.RevealPath, s.RevealScene);
                int cut = s.RevealPath.IndexOf('/');
                if (go == null && cut > 0 && string.IsNullOrEmpty(s.RevealScene)) go = TiFindObject(s.RevealPath.Substring(cut + 1), s.RevealPath.Substring(0, cut));
                if (go == null) s.RevealMissing = s.RevealPath;
                else if (s.MemberByGo.TryGetValue(go, out e)) TunerTreeChain(s, e, chain);
            }
            if (s.TreeQuery != null)
            {
                int hits = 0;
                foreach (var m in s.Members)
                {
                    if (m.Name == null || m.Name.IndexOf(s.TreeQuery, System.StringComparison.OrdinalIgnoreCase) < 0) continue;
                    TunerTreeChain(s, m, chain);
                    if (++hits >= TUNER_TREE_HITS) break;
                }
            }
            var sent = new List<TunerEntry>();
            var ids = new HashSet<string>();
            h = 14695981039346656037UL;
            var all = s.Members;
            for (int k = 0; k < all.Count; k++)
            {
                var m = all[k];
                bool top = string.IsNullOrEmpty(m.Parent) || m.Parent[0] != 'm';
                if (!top && !(ids.Contains(m.Parent) && (s.TreeOpen.Contains(m.Parent) || chain.Contains(m.Id))))
                {
                    if (m.Idx == k && m.Size > 0) k += m.Size;
                    continue;
                }
                if (!m.Filled) FillTunerMember(m);
                sent.Add(m);
                ids.Add(m.Id);
                h = TunerMix(h, (uint)m.Hash);
                h = TunerMix(h, (uint)(m.Hash >> 32));
                h = TunerMix(h, (uint)m.Kids);
            }
            s.Sent = sent;
            if (s.RevealMissing != null) h = TunerMix(h, (uint)System.StringComparer.Ordinal.GetHashCode(s.RevealMissing) | 1u);
        }
        if (h != s.SentHash)
        {
            s.SentHash = h;
            s.TreeGen++;
            s.StatePending = true;
        }
    }

    static void AppendTunerWatchGone(StringBuilder sb, TunerSession s)
    {
        sb.Append(",\"watchGone\":[");
        bool first = true;
        var all = new List<string>(s.WatchIds);
        if (!string.IsNullOrEmpty(s.Inspected) && !all.Contains(s.Inspected)) all.Add(s.Inspected);
        foreach (var wid in all)
        {
            if (string.IsNullOrEmpty(wid) || wid[0] != 'm' || s.MemberById.ContainsKey(wid)) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append(JStr(wid));
        }
        sb.Append(']');
    }

    static int _tunerWalkDepth;
    static bool _tunerWalkFill;
    static int _tunerWalkMax = int.MaxValue;
    static int _tunerLastDepthLimit;

    static bool WalkAllTunerMembers(TunerSession s, int[] active, Dictionary<GameObject, int> targets, Dictionary<string, TunerEntry> prev,
        List<TunerEntry> list, Dictionary<string, TunerEntry> byId, Dictionary<GameObject, TunerEntry> byGo, out ulong h)
    {
        bool capped = false;
        h = 14695981039346656037UL;
        _tunerWalkDepth = 0;
        foreach (var i in active)
        {
            var go = s.Objects[i];
            if (go == null || !s.Specs[i].children || TunerUiError(s, i) != null) continue;
            var path = TunerObjectPath(go);
            var scene = TunerSceneKey(go.scene) ?? "";
            if (!WalkTunerMembers(s, go.transform, "o" + i.ToString(Inv), path, scene + "\n" + path, scene, _tunerWalkRt && TunerIsRuntime(go), targets, prev, list, byId, byGo, ref h))
                capped = true;
        }
        if (s.Scene && !capped)
        {
            foreach (var sc in TunerSessionScenes(s))
            {
                if (WalkTunerSceneRoots(s, sc, targets, prev, list, byId, byGo, ref h)) continue;
                capped = true;
                break;
            }
        }
        return capped;
    }

    static int TunerMemberDepthLimit(TunerSession s, int[] active)
    {
        var counts = new List<int>();
        foreach (var i in active)
        {
            var go = s.Objects[i];
            if (go == null || !s.Specs[i].children) continue;
            for (int c = 0; c < go.transform.childCount; c++) CountTunerDepths(go.transform.GetChild(c), 0, counts);
        }
        if (s.Scene)
            foreach (var sc in TunerSessionScenes(s))
            {
                var roots = TunerRootsOf(sc);
                if (roots == null) continue;
                foreach (var go in roots.Gos)
                    if (go != null) CountTunerDepths(go.transform, 0, counts);
            }
        int total = 0;
        int limit = 0;
        for (int d = 0; d < counts.Count; d++)
        {
            total += counts[d];
            if (total > TUNER_MAX_MEMBERS) break;
            limit = d;
        }
        _tunerLastDepthLimit = limit;
        return limit;
    }

    static void CountTunerDepths(Transform t, int depth, List<int> counts)
    {
        while (counts.Count <= depth) counts.Add(0);
        counts[depth]++;
        if (counts[depth] > TUNER_MAX_MEMBERS) return;
        for (int c = 0; c < t.childCount; c++) CountTunerDepths(t.GetChild(c), depth + 1, counts);
    }

    static bool _tunerWalkRt;
    static bool _tunerWalkLazy;

    static bool WalkTunerMembers(TunerSession s, Transform parent, string parentId, string parentPath, string parentKey, string scene, bool rt,
        Dictionary<GameObject, int> targets, Dictionary<string, TunerEntry> prev, List<TunerEntry> list,
        Dictionary<string, TunerEntry> byId, Dictionary<GameObject, TunerEntry> byGo, ref ulong h)
    {
        int n = parent.childCount;
        Dictionary<string, int> seen = null;
        for (int c = 0; c < n; c++)
            if (!VisitTunerMember(s, parent.GetChild(c), c, n, ref seen, parentId, parentPath + "/", parentKey + "/", scene, rt, targets, prev, list, byId, byGo, ref h))
                return false;
        return true;
    }

    static bool WalkTunerSceneRoots(TunerSession s, Scene sc, Dictionary<GameObject, int> targets, Dictionary<string, TunerEntry> prev,
        List<TunerEntry> list, Dictionary<string, TunerEntry> byId, Dictionary<GameObject, TunerEntry> byGo, ref ulong h)
    {
        var roots = TunerRootsOf(sc);
        if (roots == null) return true;
        var scene = TunerPrefabOfScene(sc) != null ? sc.path : sc.name ?? "";
        int n = roots.Gos.Length;
        Dictionary<string, int> seen = null;
        for (int c = 0; c < n; c++)
        {
            var go = roots.Gos[c];
            if (go == null || SaturaEngineObjects.Contains(go)) continue;
            if (!VisitTunerMember(s, go.transform, c, n, ref seen, TUNER_SCENE_PARENT + scene, "", scene + "\n", scene, false, targets, prev, list, byId, byGo, ref h))
                return false;
        }
        return true;
    }

    static bool VisitTunerMember(TunerSession s, Transform t, int c, int n, ref Dictionary<string, int> seen, string parentId, string pathPrefix,
        string keyPrefix, string scene, bool rtParent, Dictionary<GameObject, int> targets, Dictionary<string, TunerEntry> prev, List<TunerEntry> list,
        Dictionary<string, TunerEntry> byId, Dictionary<GameObject, TunerEntry> byGo, ref ulong h)
    {
        var go = t.gameObject;
        var name = go.name;
        int dup = 0;
        if (n > 1)
        {
            if (seen == null) seen = new Dictionary<string, int>();
            seen.TryGetValue(name, out dup);
            seen[name] = dup + 1;
        }
        if ((go.hideFlags & HideFlags.HideInHierarchy) != 0) return true;
        TunerEntry have;
        if (byGo.TryGetValue(go, out have) && have.Gen == _tunerWalkGen) { if (!_tunerWalkFill) return true; }
        else have = null;
        var path = dup > 0 ? pathPrefix + name + "[" + (dup + 1).ToString(Inv) + "]" : pathPrefix + name;
        var key = dup > 0 ? keyPrefix + name + "\u0001" + dup.ToString(Inv) : keyPrefix + name;
        bool rt = rtParent || (_tunerWalkRt && TunerIsRuntime(go));
        if (rt && !rtParent) key = key + "\u0002" + TunerIdOf(go).ToString();
        if (have != null) return WalkTunerMembers(s, t, have.Id, path, key, scene, rt, targets, prev, list, byId, byGo, ref h);
        int ti;
        if (targets.TryGetValue(go, out ti))
            return WalkTunerMembers(s, t, "o" + ti.ToString(Inv), path, key, scene, rt, targets, prev, list, byId, byGo, ref h);
        if (list.Count >= TUNER_MAX_MEMBERS) return false;
        var id = TunerMemberId(key, byId);
        TunerEntry e;
        if (prev.TryGetValue(id, out e) && ReuseTunerMember(s, e, go, c, parentId, list, byId)) return true;
        if (e == null) e = new TunerEntry { Id = id, Member = true };
        else if (e.Go != go && e.Touched) s.TracksStale = true;
        e.Go = go;
        if (e.Path != path && (!rt || e.Touched)) s.MemberPaths[id] = path;
        e.Path = path;
        e.Runtime = rt;
        e.Scene = scene;
        e.Parent = parentId;
        e.Name = name;
        e.Index = c;
        e.Dup = dup > 0;
        e.Nth = dup + 1;
        e.Active = go.activeInHierarchy;
        e.Env = TunerEnvMember(go);
        e.Kids = 0;
        e.Gen = _tunerWalkGen;
        e.Depth = _tunerWalkDepth;
        e.ChildCount = t.childCount;
        e.ActiveSelf = go.activeSelf;
        e.Comps = go.GetComponentCount();
        e.ParentT = t.parent;
        TunerEntry up;
        if (parentId.Length > 0 && parentId[0] == 'm' && byId.TryGetValue(parentId, out up)) up.Kids++;
        e.Idx = list.Count;
        e.Size = 0;
        list.Add(e);
        byId[id] = e;
        byGo[go] = e;
        ulong eh = 14695981039346656037UL;
        eh = TunerMixString(eh, id);
        eh = TunerMixString(eh, parentId);
        eh = TunerMixString(eh, name);
        eh = TunerMix(eh, (uint)c);
        eh = TunerMix(eh, e.Active ? 1u : 0u);
        eh = TunerMix(eh, e.Env ? 1u : 0u);
        eh = TunerMix(eh, rt ? 1u : 0u);
        e.BaseHash = eh;
        e.Filled = false;
        if (!_tunerWalkLazy) FillTunerMember(e);
        h = TunerMix(h, (uint)eh);
        h = TunerMix(h, (uint)(eh >> 32));
        if (_tunerWalkDepth >= _tunerWalkMax) return true;
        bool deep = _tunerWalkDeep != null && _tunerWalkDeep.Contains(e);
        _tunerWalkDepth++;
        if (deep) _tunerWalkNoReuse++;
        try { return WalkTunerMembers(s, t, id, path, key, scene, rt, targets, prev, list, byId, byGo, ref h); }
        finally
        {
            _tunerWalkDepth--;
            if (deep) _tunerWalkNoReuse--;
            e.Size = list.Count - e.Idx - 1;
        }
    }

    static void FillTunerMember(TunerEntry e)
    {
        e.Filled = true;
        e.Icon = e.Go != null ? TunerIconType(e.Go) : "";
        e.Types = e.Go != null ? TunerTypeNames(e.Go) : "";
        e.Prefab = e.Go != null ? TunerPrefabMark(e.Go) : null;
        e.PrefabAsset = e.Prefab == "root" || e.Prefab == "variant" ? TunerPrefabOpenPath(e.Go) : null;
        e.PrefabState = e.Go != null ? TunerPrefabState(e.Go) : (byte)0;
        e.Staging = e.Go != null && e.Go.GetComponent<SaturaSpace.SaturaStaging>() != null;
        e.Hash = TunerMix(TunerMix(TunerMixString(TunerMixString(TunerMixString(TunerMixString(e.BaseHash, e.Icon), e.Types), e.Prefab), e.PrefabAsset), e.PrefabState), e.Staging ? 1u : 0u);
    }

    static ulong TunerMixString(ulong h, string v)
    {
        if (v == null) return TunerMix(h, 0u);
        for (int k = 0; k < v.Length; k++) h = TunerMix(h, (uint)v[k]);
        return TunerMix(h, (uint)v.Length);
    }

    static string TunerMemberId(string key, Dictionary<string, TunerEntry> taken)
    {
        ulong h = TunerMixString(14695981039346656037UL, key);
        var id = "m" + h.ToString("x16", Inv);
        TunerEntry x;
        if (!taken.TryGetValue(id, out x) || x.Gen != _tunerWalkGen) return id;
        for (int k = 2; ; k++)
        {
            var alt = id + "-" + k.ToString(Inv);
            if (!taken.TryGetValue(alt, out x) || x.Gen != _tunerWalkGen) return alt;
        }
    }

    static void TouchTunerMember(TunerSession s, string id)
    {
        TunerEntry m;
        if (string.IsNullOrEmpty(id) || id[0] != 'm' || !s.MemberById.TryGetValue(id, out m) || m.Touched) return;
        m.Touched = true;
        if (m.Runtime) s.MemberPaths[id] = m.Path;
        s.TracksStale = true;
    }

    static readonly Dictionary<string, bool> _tunerVariantPaths = new Dictionary<string, bool>();

    static string TunerPrefabMark(GameObject go)
    {
        if (!PrefabUtility.IsAnyPrefabInstanceRoot(go)) return null;
        if (PrefabUtility.GetPrefabInstanceStatus(go) == PrefabInstanceStatus.MissingAsset) return "missing";
        var path = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);
        if (string.IsNullOrEmpty(path)) return "root";
        bool variant;
        if (!_tunerVariantPaths.TryGetValue(path, out variant))
        {
            var asset = AssetDatabase.LoadMainAssetAtPath(path);
            variant = asset != null && PrefabUtility.GetPrefabAssetType(asset) == PrefabAssetType.Variant;
            _tunerVariantPaths[path] = variant;
        }
        return variant ? "variant" : "root";
    }

    static readonly Dictionary<string, bool> _tunerModelPaths = new Dictionary<string, bool>();

    static string TunerPrefabOpenPath(GameObject go)
    {
        var p = TunerPrefabOfScene(go.scene);
        if (p != null && p.Root == go) return null;
        var path = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);
        if (string.IsNullOrEmpty(path) || !path.EndsWith(".prefab", System.StringComparison.OrdinalIgnoreCase)) return null;
        bool model;
        if (!_tunerModelPaths.TryGetValue(path, out model))
        {
            var asset = AssetDatabase.LoadMainAssetAtPath(path);
            model = asset == null || PrefabUtility.GetPrefabAssetType(asset) == PrefabAssetType.Model;
            _tunerModelPaths[path] = model;
        }
        return model ? null : path;
    }

    static readonly List<Component> _tunerIconComps = new List<Component>();

    static string TunerIconType(GameObject go)
    {
        _tunerIconComps.Clear();
        go.GetComponents(_tunerIconComps);
        var c = _tunerIconComps.Count > 1 ? _tunerIconComps[1] : null;
        _tunerIconComps.Clear();
        return c != null ? c.GetType().FullName : "";
    }

    static string TunerTypeNames(GameObject go)
    {
        _tunerIconComps.Clear();
        go.GetComponents(_tunerIconComps);
        var sb = new StringBuilder();
        int n = 0;
        for (int k = 1; k < _tunerIconComps.Count && n < 8; k++)
        {
            var c = _tunerIconComps[k];
            if (c == null) continue;
            if (sb.Length > 0) sb.Append(',');
            sb.Append(c.GetType().Name);
            n++;
        }
        _tunerIconComps.Clear();
        return sb.ToString();
    }

    static void AppendTunerMembers(StringBuilder sb, TunerSession s)
    {
        var sent = s.Sent ?? s.Members;
        sb.Append(",\"members\":[");
        for (int k = 0; k < sent.Count; k++)
        {
            var m = sent[k];
            if (k > 0) sb.Append(',');
            sb.Append("{\"id\":\"").Append(m.Id)
              .Append("\",\"parent\":\"").Append(m.Parent)
              .Append("\",\"name\":").Append(JStr(m.Name))
              .Append(",\"index\":").Append(m.Index.ToString(Inv))
              .Append(",\"active\":").Append(m.Active ? "true" : "false");
            if (m.Dup) sb.Append(",\"dup\":true,\"nth\":").Append(m.Nth.ToString(Inv));
            if (m.Env) sb.Append(",\"env\":true");
            if (m.Runtime) sb.Append(",\"runtime\":true");
            if (!string.IsNullOrEmpty(m.Icon)) sb.Append(",\"icon\":").Append(JStr(m.Icon));
            if (!string.IsNullOrEmpty(m.Types)) sb.Append(",\"types\":").Append(JStr(m.Types));
            if (m.Prefab != null) sb.Append(",\"prefab\":\"").Append(m.Prefab).Append('"');
            if (m.PrefabAsset != null) sb.Append(",\"asset\":").Append(JStr(m.PrefabAsset));
            if (m.PrefabState != 0) sb.Append(",\"pf\":").Append(((int)m.PrefabState).ToString(Inv));
            if (m.Staging) sb.Append(",\"staging\":true");
            if (s.MembersLazy && m.Kids > 0) sb.Append(",\"kids\":").Append(m.Kids.ToString(Inv));
            if (m.Go != null) sb.Append(",\"uid\":\"").Append(TunerIdOf(m.Go).ToString()).Append('"');
            sb.Append('}');
        }
        sb.Append(']');
        if (s.MembersLazy) sb.Append(",\"membersLazy\":true");
        if (s.MembersLazy && s.RevealMissing != null) sb.Append(",\"revealMissing\":").Append(JStr(s.RevealMissing));
    }

    static void AppendTunerFilterCount(StringBuilder sb, TunerSession s)
    {
        if (s.Ui || s.Prefabs != null || (s.Scene && s.SceneFilter == null)) return;
        int total = 0, shown = 0;
        var seen = new HashSet<GameObject>();
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (!sc.isLoaded) continue;
            bool inFilter = s.Scene && TunerSceneInFilter(s, sc);
            foreach (var r in sc.GetRootGameObjects())
            {
                int n = TunerCountTree(r.transform);
                total += n;
                if (inFilter) shown += n;
            }
        }
        if (!s.Scene && s.Objects != null)
        {
            for (int i = 0; i < s.Objects.Length; i++)
            {
                var go = s.Objects[i];
                if (go == null) continue;
                if (s.Specs != null && i < s.Specs.Length && s.Specs[i] != null && s.Specs[i].children) TunerAddTree(go.transform, seen);
                else seen.Add(go);
            }
            shown = seen.Count;
        }
        sb.Append(",\"filterCount\":[").Append(shown.ToString(Inv)).Append(',').Append(total.ToString(Inv)).Append(']');
    }

    static int TunerCountTree(Transform t)
    {
        int n = 1;
        for (int k = 0; k < t.childCount; k++) n += TunerCountTree(t.GetChild(k));
        return n;
    }

    static void TunerAddTree(Transform t, HashSet<GameObject> seen)
    {
        seen.Add(t.gameObject);
        for (int k = 0; k < t.childCount; k++) TunerAddTree(t.GetChild(k), seen);
    }

    static void AppendTunerAt(StringBuilder sb, Transform t)
    {
        sb.Append(",\"at\":[");
        int n = 0;
        for (var p = t; p != null; p = p.parent) n++;
        var at = new int[n];
        for (var p = t; p != null; p = p.parent) at[--n] = p.GetSiblingIndex();
        for (int k = 0; k < at.Length; k++)
        {
            if (k > 0) sb.Append(',');
            sb.Append(at[k].ToString(Inv));
        }
        sb.Append(']');
    }

    static int[] TunerAmbiguousAt(Transform t)
    {
        bool ambiguous = false;
        int n = 0;
        for (var p = t; p != null; p = p.parent)
        {
            n++;
            if (!ambiguous && TunerFirstNamed(p) != p) ambiguous = true;
        }
        if (!ambiguous) return null;
        var at = new int[n];
        for (var p = t; p != null; p = p.parent) at[--n] = p.GetSiblingIndex();
        return at;
    }

    static Transform TunerFirstNamed(Transform t)
    {
        var name = t.name;
        var parent = t.parent;
        if (parent != null)
        {
            for (int k = 0; k < parent.childCount; k++)
            {
                var c = parent.GetChild(k);
                if (c == t) return t;
                if (c.name == name) return c;
            }
            return t;
        }
        var roots = TunerRootsOf(t.gameObject.scene);
        if (roots == null) return t;
        for (int k = 0; k < roots.Gos.Length; k++)
        {
            if (roots.Gos[k] == null) continue;
            if (roots.Gos[k] == t.gameObject) return t;
            if (roots.Names[k] == name) return roots.Gos[k].transform;
        }
        return t;
    }

    static TunerRootList TunerRootsOf(Scene sc)
    {
        if (!sc.IsValid() || !sc.isLoaded) return null;
        if (_tunerRootsGen != _tunerHierarchyGen)
        {
            _tunerRoots.Clear();
            _tunerRootsGen = _tunerHierarchyGen;
        }
        TunerRootList r;
        double now = EditorApplication.timeSinceStartup;
        if (_tunerRoots.TryGetValue(sc, out r) && r.Gos.Length == sc.rootCount && now - r.At < TUNER_ROOTS_REFRESH && !TunerRootsStale(r)) return r;
        var gos = sc.GetRootGameObjects();
        var sorted = new List<GameObject>(gos);
        sorted.Sort((a, b) => a.transform.GetSiblingIndex().CompareTo(b.transform.GetSiblingIndex()));
        r = new TunerRootList { Gos = sorted.ToArray(), Names = new string[sorted.Count], At = now };
        for (int k = 0; k < r.Gos.Length; k++) r.Names[k] = r.Gos[k].name;
        _tunerRoots[sc] = r;
        return r;
    }

    static GameObject TunerFindAt(string path, string scene, int[] at)
    {
        if (at == null || at.Length == 0 || string.IsNullOrEmpty(path)) return null;
        var parts = path.TrimStart('/').Split('/');
        if (parts.Length != at.Length) return null;
        foreach (var sc in TunerScenes())
        {
            if (!string.IsNullOrEmpty(scene) && sc.name != scene && sc.path != scene) continue;
            foreach (var root in sc.GetRootGameObjects())
            {
                if (root == null || !TunerSegIs(root.transform, parts[0]) || root.transform.GetSiblingIndex() != at[0] || SaturaEngineObjects.Contains(root)) continue;
                var t = root.transform;
                for (int k = 1; k < at.Length && t != null; k++)
                {
                    if (at[k] < 0 || at[k] >= t.childCount) t = null;
                    else
                    {
                        t = t.GetChild(at[k]);
                        if (!TunerSegIs(t, parts[k])) t = null;
                    }
                }
                if (t != null) return t.gameObject;
            }
        }
        return null;
    }
    static List<Scene> TunerSessionScenes(TunerSession s)
    {
        if (s.Prefabs != null) return TunerPrefabScenes(s);
        var list = TunerScenes();
        list.RemoveAll(sc => TunerPrefabOfScene(sc) != null);
        if (s.SceneFilter != null) list.RemoveAll(sc => !TunerSceneInFilter(s, sc));
        return list;
    }

    static List<GameObject> TunerSceneRoots(TunerSession s)
    {
        var list = new List<GameObject>();
        if (!s.Scene) return list;
        foreach (var sc in TunerSessionScenes(s))
        {
            var roots = TunerRootsOf(sc);
            if (roots == null) continue;
            foreach (var go in roots.Gos)
                if (go != null && (go.hideFlags & HideFlags.HideInHierarchy) == 0 && !SaturaEngineObjects.Contains(go)) list.Add(go);
        }
        return list;
    }

    const float TUNER_MAX_BOUNDS = 100000f;

    static bool TunerSaneBounds(Bounds b)
    {
        var e = b.extents;
        float m = e.x + e.y + e.z;
        return !float.IsNaN(m) && !float.IsInfinity(m) && m < TUNER_MAX_BOUNDS && b.center.sqrMagnitude < TUNER_MAX_BOUNDS * TUNER_MAX_BOUNDS;
    }

    static readonly Dictionary<Mesh, Bounds[]> _tunerBoneBoxes = new Dictionary<Mesh, Bounds[]>();

    static Bounds[] TunerBoneBoxes(Mesh mesh)
    {
        Bounds[] boxes;
        if (_tunerBoneBoxes.TryGetValue(mesh, out boxes)) return boxes;
        boxes = null;
        try
        {
            var binds = mesh.bindposes;
            var weights = mesh.boneWeights;
            var verts = mesh.vertices;
            if (binds.Length > 0 && weights.Length == verts.Length)
            {
                boxes = new Bounds[binds.Length];
                var any = new bool[binds.Length];
                for (int v = 0; v < verts.Length; v++)
                {
                    var w = weights[v];
                    int bone = w.boneIndex0;
                    if (bone < 0 || bone >= binds.Length) continue;
                    var p = binds[bone].MultiplyPoint3x4(verts[v]);
                    if (!any[bone]) { boxes[bone] = new Bounds(p, Vector3.zero); any[bone] = true; }
                    else boxes[bone].Encapsulate(p);
                }
                for (int i = 0; i < boxes.Length; i++)
                    if (!any[i]) boxes[i] = new Bounds(Vector3.zero, -Vector3.one);
            }
        }
        catch { boxes = null; }
        _tunerBoneBoxes[mesh] = boxes;
        return boxes;
    }

    static bool TunerSkinnedBounds(SkinnedMeshRenderer smr, ref Bounds b)
    {
        var mesh = smr.sharedMesh;
        if (mesh == null || smr.updateWhenOffscreen) return false;
        var bones = smr.bones;
        var boxes = TunerBoneBoxes(mesh);
        if (boxes == null || bones == null || bones.Length != boxes.Length) return false;
        bool any = false;
        Bounds acc = default;
        for (int i = 0; i < boxes.Length; i++)
        {
            var box = boxes[i];
            var bone = bones[i];
            if (bone == null || box.size.x < 0f) continue;
            var m = bone.localToWorldMatrix;
            var c = m.MultiplyPoint3x4(box.center);
            var e = box.extents;
            var ext = new Vector3(
                Mathf.Abs(m.m00) * e.x + Mathf.Abs(m.m01) * e.y + Mathf.Abs(m.m02) * e.z,
                Mathf.Abs(m.m10) * e.x + Mathf.Abs(m.m11) * e.y + Mathf.Abs(m.m12) * e.z,
                Mathf.Abs(m.m20) * e.x + Mathf.Abs(m.m21) * e.y + Mathf.Abs(m.m22) * e.z);
            var wb = new Bounds(c, ext * 2f);
            if (!any) { acc = wb; any = true; }
            else acc.Encapsulate(wb);
        }
        if (!any) return false;
        b = acc;
        return true;
    }

    static bool TunerRendererBounds(Renderer r, out Bounds b)
    {
        b = r.bounds;
        var smr = r as SkinnedMeshRenderer;
        if (smr != null) TunerSkinnedBounds(smr, ref b);
        if (r is ParticleSystemRenderer || r is TrailRenderer)
        {
            var ps = r is ParticleSystemRenderer ? r.GetComponent<ParticleSystem>() : null;
            bool empty = b.size.sqrMagnitude < 1e-8f || (ps != null && ps.particleCount == 0);
            if (empty) b = new Bounds(r.transform.position, Vector3.one);
        }
        return TunerSaneBounds(b);
    }

    static bool TunerOnFlatCanvas(Component c)
    {
        var canvas = TunerRootCanvasOf(c.transform);
        return canvas != null && canvas.renderMode != RenderMode.WorldSpace;
    }

    const double TUNER_SCENE_BOUNDS_REFRESH = 2.0;

    static void AppendTunerSceneBounds(StringBuilder sb, TunerSession s)
    {
        double now = EditorApplication.timeSinceStartup;
        if (s.SceneBoundsGen != _tunerHierarchyGen || now - s.SceneBoundsAt > TUNER_SCENE_BOUNDS_REFRESH)
        {
            s.SceneBoundsGen = _tunerHierarchyGen;
            s.SceneBoundsAt = now;
            Bounds b;
            s.SceneBoundsOk = TunerSceneBounds(s, out b, out var biggest);
            s.SceneBoundsValue = b;
            s.SceneNoRenderers = biggest == null && s.Prefabs == null;
        }
        if (s.SceneNoRenderers) sb.Append(",\"sceneNoRenderers\":true");
        if (!s.SceneBoundsOk)
        {
            sb.Append(",\"sceneBounds\":null");
            return;
        }
        var v = s.SceneBoundsValue;
        sb.Append(",\"sceneBounds\":{\"center\":");
        AppendTunerArray(sb, v.center.x, v.center.y, v.center.z);
        sb.Append(",\"size\":");
        AppendTunerArray(sb, v.size.x, v.size.y, v.size.z);
        float fog = TunerFogReach();
        if (fog > 0) sb.Append(",\"fog\":").Append(fog.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        float clear = TunerFogClear();
        if (clear > 0) sb.Append(",\"fogClear\":").Append(clear.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture));
        var sun = TunerSunDirection();
        if (sun != Vector3.zero) AppendTunerVec(sb, "sun", sun);
        sb.Append('}');
    }

    const float TUNER_FOG_CLEAR = 0.3f;

    static float TunerFogClear()
    {
        if (!RenderSettings.fog) return 0;
        float d = RenderSettings.fogDensity;
        switch (RenderSettings.fogMode)
        {
            case FogMode.Linear:
                float a = RenderSettings.fogStartDistance, z = RenderSettings.fogEndDistance;
                return z > a ? Mathf.Max(0.01f, a + (z - a) * TUNER_FOG_CLEAR) : 0;
            case FogMode.Exponential:
                return d > 1e-6f ? -Mathf.Log(1f - TUNER_FOG_CLEAR) / d : 0;
            default:
                return d > 1e-6f ? Mathf.Sqrt(-Mathf.Log(1f - TUNER_FOG_CLEAR)) / d : 0;
        }
    }

    static Vector3 TunerSunDirection()
    {
        var sun = RenderSettings.sun;
        if (sun == null || !sun.isActiveAndEnabled || sun.type != LightType.Directional)
        {
            sun = null;
            float best = 0f;
            foreach (var l in Light.GetLights(LightType.Directional, 0))
                if (l != null && l.isActiveAndEnabled && l.intensity > best)
                {
                    best = l.intensity;
                    sun = l;
                }
        }
        return sun != null ? sun.transform.forward : Vector3.zero;
    }

    static float TunerFogReach()
    {
        if (!RenderSettings.fog) return 0;
        switch (RenderSettings.fogMode)
        {
            case FogMode.Linear:
                return RenderSettings.fogEndDistance > RenderSettings.fogStartDistance ? RenderSettings.fogEndDistance : 0;
            case FogMode.Exponential:
                return RenderSettings.fogDensity > 1e-6f ? 3f / RenderSettings.fogDensity : 0;
            default:
                return RenderSettings.fogDensity > 1e-6f ? 1.7320508f / RenderSettings.fogDensity : 0;
        }
    }

    static bool TunerFxRenderer(Renderer r)
    {
        return r is ParticleSystemRenderer || r is TrailRenderer || r is LineRenderer;
    }

    static bool TunerSceneBounds(TunerSession s, out Bounds bounds)
    {
        Renderer biggest;
        return TunerSceneBounds(s, out bounds, out biggest);
    }

    static GameObject TunerPrefabContent(GameObject root)
    {
        if (!TunerEnvMember(root)) return root;
        var p = TunerPrefabOfScene(root.scene);
        return p != null && p.Root != null && p.Root.transform.IsChildOf(root.transform) ? p.Root : null;
    }

    static bool TunerSceneBounds(TunerSession s, out Bounds bounds, out Renderer biggest)
    {
        bounds = default;
        biggest = null;
        bool any = false;
        var roots = TunerSceneRoots(s);
        for (int pass = 0; pass < 2 && !any; pass++)
        {
            float most = -1f;
            foreach (var root0 in roots)
            {
                var root = s.Prefabs != null ? TunerPrefabContent(root0) : root0;
                if (root == null) continue;
                foreach (var r in root.GetComponentsInChildren<Renderer>(false))
                {
                    Bounds rb;
                    if (r == null || !r.enabled || TunerFxRenderer(r) != (pass == 1) || TunerOnFlatCanvas(r) || !TunerRendererBounds(r, out rb)) continue;
                    if (!any) bounds = rb;
                    else bounds.Encapsulate(rb);
                    any = true;
                    float m = rb.size.sqrMagnitude;
                    if (m > most)
                    {
                        most = m;
                        biggest = r;
                    }
                }
            }
        }
        if (any) return true;
        if (s.Prefabs != null)
            foreach (var root in roots) TunerUiBounds(TunerEnvMember(root) ? TunerPrefabOfScene(root.scene).Root : root, ref bounds, ref any);
        if (any) return true;
        foreach (var root0 in roots)
        {
            var root = s.Prefabs != null ? TunerPrefabContent(root0) : root0;
            if (root == null) continue;
            var b = new Bounds(root.transform.position, Vector3.one);
            if (!any) bounds = b;
            else bounds.Encapsulate(b);
            any = true;
        }
        return any;
    }
}
