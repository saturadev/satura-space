using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;
#if UNITY_6000_5_OR_NEWER
using TunerObjId = UnityEngine.EntityId;
#else
using TunerObjId = System.Int32;
#endif

public static partial class MCPTestBridge
{
    const string TUNER_DDOL_SCENE = "DontDestroyOnLoad";
    const int TUNER_CLONES_PRUNE_MIN = 1024;
    const double TUNER_MEMBERS_MIN_PLAY = 0.25;
    const string TUNER_CLONE_WATCH_KEY = "SaturaTunerCloneWatch";

    static readonly HashSet<TunerObjId> _tunerLoadedIds = new HashSet<TunerObjId>();
    static readonly HashSet<Scene> _tunerLoadedScenes = new HashSet<Scene>();
    static bool _tunerLoadedDdol;
    static readonly List<Transform> _tunerLoadScratch = new List<Transform>();
    static readonly Dictionary<GameObject, Object> _tunerClones = new Dictionary<GameObject, Object>();
    static int _tunerClonesPruneAt = TUNER_CLONES_PRUNE_MIN;
    static bool _tunerCloneHooked;
    static bool _tunerCloneRecord;

    [InitializeOnLoadMethod]
    static void InitTunerRuntime()
    {
        if (Inert) return;
        SceneManager.sceneLoaded += OnTunerSceneLoaded;
        EditorApplication.playModeStateChanged += OnTunerRuntimePlayMode;
        if (EditorApplication.isPlaying) EditorApplication.delayCall += SnapshotTunerLoadedAll;
        if (SessionState.GetBool(TUNER_CLONE_WATCH_KEY, false))
        {
            SessionState.EraseBool(TUNER_CLONE_WATCH_KEY);
            StartTunerCloneWatch();
        }
    }

    static void KeepTunerCloneWatchOverReload()
    {
        if (_tuners.Count > 0) SessionState.SetBool(TUNER_CLONE_WATCH_KEY, true);
    }

    static TunerObjId TunerIdOf(Object o)
    {
#if UNITY_6000_5_OR_NEWER
        return o.GetEntityId();
#else
        return o.GetInstanceID();
#endif
    }

    static void OnTunerRuntimePlayMode(PlayModeStateChange state)
    {
        if (state == PlayModeStateChange.EnteredPlayMode) SnapshotTunerLoadedAll();
        else if (state == PlayModeStateChange.ExitingPlayMode || state == PlayModeStateChange.EnteredEditMode) ClearTunerRuntime();
    }

    static void ClearTunerRuntime()
    {
        _tunerLoadedIds.Clear();
        _tunerLoadedScenes.Clear();
        _tunerLoadedDdol = false;
        _tunerClones.Clear();
        _tunerClonesPruneAt = TUNER_CLONES_PRUNE_MIN;
    }

    static void OnTunerSceneLoaded(Scene sc, LoadSceneMode mode)
    {
        if (!EditorApplication.isPlaying) return;
        SnapshotTunerScene(sc);
        if (!_tunerLoadedDdol) SnapshotTunerDdol();
    }

    static void SnapshotTunerLoadedAll()
    {
        if (!EditorApplication.isPlaying) return;
        for (int i = 0; i < SceneManager.sceneCount; i++) SnapshotTunerScene(SceneManager.GetSceneAt(i));
        if (!_tunerLoadedDdol) SnapshotTunerDdol();
    }

    static void SnapshotTunerDdol()
    {
        _tunerLoadedDdol = true;
        foreach (var sc in TunerScenes())
            if (TunerIsDdol(sc)) SnapshotTunerRoots(sc);
    }

    static void SnapshotTunerScene(Scene sc)
    {
        if (!sc.IsValid() || !sc.isLoaded || !_tunerLoadedScenes.Add(sc)) return;
        SnapshotTunerRoots(sc);
    }

    static void SnapshotTunerRoots(Scene sc)
    {
        if (!sc.IsValid() || !sc.isLoaded) return;
        foreach (var root in sc.GetRootGameObjects())
        {
            if (root == null) continue;
            root.GetComponentsInChildren(true, _tunerLoadScratch);
            foreach (var t in _tunerLoadScratch) _tunerLoadedIds.Add(TunerIdOf(t.gameObject));
        }
        _tunerLoadScratch.Clear();
    }

    static bool TunerIsDdol(Scene sc)
    {
        if (!EditorApplication.isPlaying || !sc.IsValid()) return false;
        return (_tunerDdolKnown && sc == _tunerDdol) || (sc.buildIndex < 0 && sc.name == TUNER_DDOL_SCENE);
    }

    static bool TunerSceneInFilter(TunerSession s, Scene sc)
    {
        return s.SceneFilter == null || sc.name == s.SceneFilter || sc.path == s.SceneFilter || TunerIsDdol(sc);
    }

    static bool TunerIsRuntime(GameObject go)
    {
        if (go == null || !EditorApplication.isPlaying || _tunerLoadedScenes.Count == 0) return false;
        if (TunerInStagingCopy(go)) return false;
        return !_tunerLoadedIds.Contains(TunerIdOf(go)) || _tunerClones.ContainsKey(go);
    }

    static void StartTunerCloneWatch()
    {
        _tunerCloneRecord = true;
        if (_tunerCloneHooked) return;
        _tunerCloneHooked = true;
        var targets = typeof(Object).GetMethods(BindingFlags.Static | BindingFlags.NonPublic)
            .Where(m => (m.Name.StartsWith("Internal_CloneSingle", StringComparison.Ordinal) || m.Name.StartsWith("Internal_InstantiateSingle", StringComparison.Ordinal))
                && !m.Name.EndsWith("_Injected", StringComparison.Ordinal) && m.ReturnType == typeof(Object) && m.GetMethodBody() != null)
            .ToList();
        if (targets.Count == 0)
        {
            SaturaDebug.Log("[Tuner] runtime clone sources unavailable: no managed Instantiate entry points in this Unity");
            return;
        }
        try
        {
            var asm = FindHarmony();
            if (asm == null)
            {
                SaturaDebug.Log("[Tuner] runtime clone sources unavailable: Harmony is not loaded");
                return;
            }
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-clones");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var hook = typeof(TunerCloneHooks).GetMethod(nameof(TunerCloneHooks.ClonePostfix), BindingFlags.Static | BindingFlags.Public);
            var postfix = methodType.GetConstructor(new[] { typeof(MethodInfo) }).Invoke(new object[] { hook });
            foreach (var target in targets)
            {
                var args = new object[patch.GetParameters().Length];
                args[0] = target;
                args[2] = postfix;
                patch.Invoke(harmony, args);
            }
            SaturaDebug.Log("[Tuner] runtime clone sources on (" + targets.Count + " entry points)");
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[Tuner] runtime clone sources unavailable: " + inner.Message);
        }
    }

    static void StopTunerCloneWatch()
    {
        _tunerCloneRecord = false;
        _tunerClones.Clear();
        _tunerClonesPruneAt = TUNER_CLONES_PRUNE_MIN;
    }

    public static class TunerCloneHooks
    {
        public static void ClonePostfix(Object __0, Object __result) => NoteTunerClone(__0, __result);
    }

    static void NoteTunerClone(Object source, Object clone)
    {
        if (!_tunerCloneRecord || clone == null || source == null || !EditorApplication.isPlaying) return;
        var go = clone as GameObject;
        if (go == null)
        {
            var c = clone as Component;
            if (c == null) return;
            go = c.gameObject;
        }
        _tunerClones[go] = source;
        if (_tunerClones.Count >= _tunerClonesPruneAt) PruneTunerClones();
    }

    static readonly List<GameObject> _tunerClonesDead = new List<GameObject>();

    static void PruneTunerClones()
    {
        foreach (var kv in _tunerClones)
            if (kv.Key == null) _tunerClonesDead.Add(kv.Key);
        foreach (var k in _tunerClonesDead) _tunerClones.Remove(k);
        _tunerClonesDead.Clear();
        _tunerClonesPruneAt = Math.Max(TUNER_CLONES_PRUNE_MIN, _tunerClones.Count * 2);
    }

    class TunerRuntimeOrigin
    {
        public string Prefab;
        public string Child;
        public string CopyOf;
    }

    static TunerRuntimeOrigin TunerOriginOf(GameObject go)
    {
        if (!TunerIsRuntime(go) && !TunerUnderClone(go)) return null;
        var o = new TunerRuntimeOrigin();
        var cur = go;
        string rel = "";
        for (int hop = 0; hop < 8 && cur != null; hop++)
        {
            Transform cloneRoot = null;
            Object src = null;
            for (var t = cur.transform; t != null; t = t.parent)
                if (_tunerClones.TryGetValue(t.gameObject, out src) && src != null)
                {
                    cloneRoot = t;
                    break;
                }
            if (cloneRoot == null) break;
            var srcGo = src as GameObject ?? (src is Component sc ? sc.gameObject : null);
            if (srcGo == null) break;
            rel = TunerJoinPath(TunerRelPath(cloneRoot, cur.transform), rel);
            if (EditorUtility.IsPersistent(srcGo))
            {
                o.Prefab = AssetDatabase.GetAssetPath(srcGo);
                o.Child = TunerJoinPath(TunerRelPath(srcGo.transform.root, srcGo.transform), rel);
                if (o.Child == "") o.Child = null;
                return o;
            }
            if (!TunerIsRuntime(srcGo) || hop == 7)
            {
                o.CopyOf = TunerJoinPath(TunerObjectPath(srcGo), rel);
                return o;
            }
            cur = srcGo;
        }
        var linked = PrefabUtility.GetCorrespondingObjectFromSource(go);
        if (linked != null && EditorUtility.IsPersistent(linked))
        {
            o.Prefab = AssetDatabase.GetAssetPath(linked);
            var inner = TunerRelPath(linked.transform.root, linked.transform);
            o.Child = inner == "" ? null : inner;
        }
        return o;
    }

    static bool TunerUnderClone(GameObject go)
    {
        if (go == null || _tunerClones.Count == 0 || !EditorApplication.isPlaying) return false;
        for (var t = go.transform; t != null; t = t.parent)
            if (_tunerClones.ContainsKey(t.gameObject)) return true;
        return false;
    }

    static string TunerRelPath(Transform root, Transform t)
    {
        if (t == root) return "";
        var parts = new List<string>();
        for (var p = t; p != null && p != root; p = p.parent) parts.Add(p.name);
        parts.Reverse();
        return string.Join("/", parts);
    }

    static string TunerJoinPath(string a, string b)
    {
        if (string.IsNullOrEmpty(a)) return b ?? "";
        if (string.IsNullOrEmpty(b)) return a;
        return a + "/" + b;
    }
}
