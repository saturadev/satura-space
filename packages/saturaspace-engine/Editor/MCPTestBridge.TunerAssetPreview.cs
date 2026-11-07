using System;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    static MethodInfo _tunerSetScenePath;

    static bool TunerAssetPreviewable(string path)
    {
        if (AssetImporter.GetAtPath(path) is ModelImporter) return true;
        var t = AssetDatabase.GetMainAssetTypeAtPath(path);
        return t != null && (typeof(Material).IsAssignableFrom(t) || typeof(Texture).IsAssignableFrom(t));
    }

    static void TunerSetScenePath(Scene scene, string path)
    {
        if (_tunerSetScenePath == null)
            _tunerSetScenePath = typeof(Scene).GetMethod("SetPathAndGuid", BindingFlags.NonPublic | BindingFlags.Instance, null, new[] { typeof(string), typeof(string) }, null);
        if (_tunerSetScenePath == null) throw new MissingMethodException("Scene.SetPathAndGuid");
        _tunerSetScenePath.Invoke(scene, new object[] { path, AssetDatabase.AssetPathToGUID(path) });
    }

    static GameObject TunerPreviewObject(TunerPrefab p, string name, Mesh mesh, Material mat, Vector3 scale)
    {
        var go = new GameObject(name) { hideFlags = HideFlags.HideAndDontSave };
        go.AddComponent<MeshFilter>().sharedMesh = mesh;
        go.AddComponent<MeshRenderer>().sharedMaterial = mat;
        go.transform.localScale = scale;
        SceneManager.MoveGameObjectToScene(go, p.Scene);
        return go;
    }

    static Material TunerTextureMaterial(TunerPrefab p, Texture tex)
    {
        var rp = GraphicsSettings.currentRenderPipeline;
        var rpName = rp != null ? rp.GetType().Name : "";
        Shader shader = null;
        if (rpName.Contains("Universal")) shader = Shader.Find("Universal Render Pipeline/Unlit");
        else if (rpName.Contains("HDRender")) shader = Shader.Find("HDRP/Unlit");
        if (shader == null) shader = Shader.Find("Unlit/Texture");
        if (shader == null) return null;
        var mat = new Material(shader) { hideFlags = HideFlags.HideAndDontSave, name = tex.name, mainTexture = tex };
        p.Temp.Add(mat);
        return mat;
    }

    static GameObject BuildTunerAssetPreview(TunerPrefab p, UnityEngine.Object main)
    {
        if (main is GameObject model) return (GameObject)PrefabUtility.InstantiatePrefab(model, p.Scene);
        if (main is Material mat) return TunerPreviewObject(p, mat.name, Resources.GetBuiltinResource<Mesh>("New-Sphere.fbx"), mat, Vector3.one);
        if (main is Texture tex)
        {
            var look = TunerTextureMaterial(p, tex);
            if (look == null) return null;
            float aspect = tex.height > 0 ? (float)tex.width / tex.height : 1f;
            return TunerPreviewObject(p, tex.name, Resources.GetBuiltinResource<Mesh>("Quad.fbx"), look, new Vector3(aspect, 1f, 1f));
        }
        return null;
    }

    static string LoadTunerAssetPreview(TunerPrefab p)
    {
        var main = AssetDatabase.LoadMainAssetAtPath(p.Path);
        if (main == null) return "no asset at " + p.Path;
        p.ReadOnly = true;
        try
        {
            p.Scene = EditorSceneManager.NewPreviewScene();
            var root = BuildTunerAssetPreview(p, main);
            if (root == null)
            {
                UnloadTunerPrefab(p);
                return "Unity can't preview " + p.Path;
            }
            TunerSetScenePath(p.Scene, p.Path);
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                t.gameObject.hideFlags = HideFlags.NotEditable;
                foreach (var c in t.GetComponents<Component>())
                    if (c != null) c.hideFlags = HideFlags.NotEditable;
            }
            p.Root = root;
            AddTunerPrefabLight(p);
            p.SavedDirty = TunerSceneDirtyId(p.Scene);
            _tunerHierarchyGen++;
            return null;
        }
        catch (Exception e)
        {
            UnloadTunerPrefab(p);
            return "could not open " + p.Path + ": " + e.Message;
        }
    }

    static void AddTunerPrefabLight(TunerPrefab p)
    {
        var lightGo = new GameObject("_SaturaTunerPrefabLight") { hideFlags = HideFlags.HideAndDontSave };
        var light = lightGo.AddComponent<Light>();
        light.type = LightType.Directional;
        light.intensity = 1f;
        light.color = new Color(1f, 0.956f, 0.839f);
        lightGo.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
        SceneManager.MoveGameObjectToScene(lightGo, p.Scene);
        p.Light = lightGo;
    }

    static void DestroyTunerPreviewTemps(TunerPrefab p)
    {
        foreach (var o in p.Temp)
            if (o != null) UnityEngine.Object.DestroyImmediate(o);
        p.Temp.Clear();
    }

    static void DropTunerReadOnlyPrefabs()
    {
        var drop = new System.Collections.Generic.List<string>();
        foreach (var kv in _tunerPrefabs)
            if (kv.Value.ReadOnly) drop.Add(kv.Key);
        foreach (var path in drop)
        {
            UnloadTunerPrefab(_tunerPrefabs[path]);
            _tunerPrefabs.Remove(path);
        }
    }

    static bool TunerPrefabEdits(string path)
    {
        return _tunerPrefabs.TryGetValue(path, out var p) && !p.ReadOnly;
    }

    static bool TunerReadOnlyObject(UnityEngine.Object o)
    {
        var go = o as GameObject ?? (o as Component)?.gameObject;
        if (go == null) return false;
        if (TunerEnvMember(go)) return true;
        var p = TunerPrefabOfScene(go.scene);
        return p != null && p.ReadOnly;
    }

    static string TunerSceneNotOpen(string scene)
    {
        if (string.IsNullOrEmpty(scene) || !scene.EndsWith(".unity", StringComparison.OrdinalIgnoreCase)) return null;
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (sc.isLoaded && sc.path == scene) return null;
        }
        return "Open " + System.IO.Path.GetFileNameWithoutExtension(scene) + " in the Unity editor first. The Tuner won't switch scenes for you.";
    }
}
