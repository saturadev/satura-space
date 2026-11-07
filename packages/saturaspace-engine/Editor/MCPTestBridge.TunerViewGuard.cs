using System.Collections.Generic;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    const int TI_VIEW_GUARD_ASSETS = 256;

    sealed class TiViewMark
    {
        public readonly List<Scene> CleanScenes = new List<Scene>();
        public readonly List<Object> CleanAssets = new List<Object>();
    }

    static TiViewMark TiViewGuardBegin(TiSession s)
    {
        if (!s.ViewOnly || EditorApplication.isPlaying) return null;
        var mark = new TiViewMark();
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (sc.IsValid() && sc.isLoaded && !sc.isDirty) mark.CleanScenes.Add(sc);
        }
        if (s.ViewAssets == null) s.ViewAssets = TiViewAssets(s);
        foreach (var o in s.ViewAssets)
            if (o != null && !EditorUtility.IsDirty(o)) mark.CleanAssets.Add(o);
        return mark;
    }

    static void TiViewGuardEnd(TiSession s, TiViewMark mark)
    {
        if (mark == null) return;
        var cleared = new List<string>();
        foreach (var sc in mark.CleanScenes)
        {
            if (!sc.IsValid() || !sc.isLoaded || !sc.isDirty) continue;
            ClearTunerSceneDirtiness(sc);
            if (!sc.isDirty) cleared.Add(string.IsNullOrEmpty(sc.path) ? sc.name : sc.path);
        }
        var assets = new HashSet<string>();
        foreach (var o in mark.CleanAssets)
        {
            if (o == null || !EditorUtility.IsDirty(o)) continue;
            EditorUtility.ClearDirty(o);
            assets.Add(AssetDatabase.GetAssetPath(o));
        }
        cleared.AddRange(assets);
        var fresh = TiViewAssets(s);
        if (fresh.Count != (s.ViewAssets?.Count ?? -1)) s.ViewAssets = fresh;
        if (cleared.Count > 0)
            SaturaDebug.Log("[tunerInspector] " + s.Id + " showing " + (s.Go != null ? TunerObjectPath(s.Go) : s.Spec?.path) + ": Unity's inspector marked "
                + string.Join(", ", cleared) + " as changed without an edit; cleared it so a look leaves no unsaved changes");
    }

    static List<Object> TiViewAssets(TiSession s)
    {
        var roots = new List<Object>();
        if (s.Asset != null && !(s.Asset is GameObject)) roots.Add(s.Asset);
        var gos = new List<GameObject>(s.Gos);
        if (gos.Count == 0 && s.Spec != null && s.Spec.kind != "asset")
        {
            var go = TiFindObject(s.Spec.path, s.Spec.scene);
            if (go != null) gos.Add(go);
        }
        foreach (var go in gos)
        {
            if (go == null) continue;
            foreach (var c in go.GetComponents<Component>())
            {
                if (c == null || c is Transform) continue;
                var so = new SerializedObject(c);
                var p = so.GetIterator();
                int seen = 0;
                while (p.NextVisible(true) && seen++ < 400)
                {
                    if (p.propertyType != SerializedPropertyType.ObjectReference) continue;
                    var r = p.objectReferenceValue;
                    if (r != null && EditorUtility.IsPersistent(r) && !roots.Contains(r)) roots.Add(r);
                }
            }
        }
        var list = new List<Object>();
        var paths = new HashSet<string>();
        foreach (var r in roots)
        {
            var path = AssetDatabase.GetAssetPath(r);
            if (string.IsNullOrEmpty(path) || !path.StartsWith("Assets/") || !paths.Add(path)) continue;
            if (path.EndsWith(".unity") || path.EndsWith(".prefab") || path.EndsWith(".fbx", System.StringComparison.OrdinalIgnoreCase)) continue;
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
            {
                if (o == null) continue;
                list.Add(o);
                if (list.Count >= TI_VIEW_GUARD_ASSETS) return list;
            }
        }
        return list;
    }
}
