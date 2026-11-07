using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    const string TUNER_UI_ENV_CANVAS = "Canvas (Environment)";

    static bool TunerIsUiPrefabRoot(GameObject root)
    {
        if (root == null || !(root.transform is RectTransform)) return false;
        return root.GetComponent<Canvas>() != null || root.GetComponentInChildren<CanvasRenderer>(true) != null;
    }

    static bool TunerNeedsUiEnv(GameObject root)
    {
        var canvas = root.GetComponent<Canvas>();
        if (canvas == null || canvas.renderMode == RenderMode.WorldSpace) return true;
        var rt = (RectTransform)canvas.transform;
        return !(rt.sizeDelta == Vector2.zero && rt.anchorMin == Vector2.zero && rt.anchorMax == Vector2.zero && rt.pivot == Vector2.zero);
    }

    static bool TunerEnvObject(GameObject go)
    {
        return go != null && (go.hideFlags & HideFlags.DontSaveInEditor) != 0 && (go.hideFlags & HideFlags.HideInHierarchy) == 0;
    }

    static bool TunerEnvMember(GameObject go)
    {
        if (go == null) return false;
        var p = TunerPrefabOfScene(go.scene);
        return p != null && p.Env != null && p.Root != null && !go.transform.IsChildOf(p.Root.transform);
    }

    static string TunerEnvLocked(GameObject go)
    {
        return go.name + " belongs to the Prefab Mode environment, not to the prefab, so it can't be changed";
    }

    static void LockTunerUiEnvironment(TunerPrefab p)
    {
        foreach (var root in p.Scene.GetRootGameObjects())
        {
            if (!TunerEnvObject(root)) continue;
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                if (t.IsChildOf(p.Root.transform)) continue;
                t.gameObject.hideFlags |= HideFlags.NotEditable;
                foreach (var c in t.GetComponents<Component>())
                    if (c != null) c.hideFlags |= HideFlags.NotEditable;
            }
        }
    }

    static void AddTunerUiEnvironment(TunerPrefab p)
    {
        p.Ui = TunerIsUiPrefabRoot(p.Root);
        if (!p.Ui || !TunerNeedsUiEnv(p.Root)) return;
        string from = null;
        var envAsset = EditorSettings.prefabUIEnvironment;
        var envPath = envAsset != null ? AssetDatabase.GetAssetPath(envAsset) : null;
        if (!string.IsNullOrEmpty(envPath) && MoveTunerEnvScene(p, envPath)) from = envPath;
        Canvas host = null;
        foreach (var go in p.Scene.GetRootGameObjects())
        {
            if (go == p.Root || !TunerEnvObject(go)) continue;
            host = go.GetComponentInChildren<Canvas>();
            if (host != null) break;
        }
        bool made = host == null;
        if (made)
        {
            var go = EditorUtility.CreateGameObjectWithHideFlags(TUNER_UI_ENV_CANVAS, HideFlags.DontSave);
            int layer = LayerMask.NameToLayer("UI");
            if (layer >= 0) go.layer = layer;
            host = go.AddComponent<Canvas>();
            host.renderMode = RenderMode.ScreenSpaceOverlay;
            SceneManager.MoveGameObjectToScene(go, p.Scene);
        }
        p.Root.transform.SetParent(host.transform, false);
        p.Env = host.gameObject;
        Canvas.ForceUpdateCanvases();
        var rect = ((RectTransform)host.transform).rect;
        if (made && (rect.width < 1f || rect.height < 1f))
        {
            var size = Handles.GetMainGameViewSize();
            if (size.x < 1f || size.y < 1f) size = new Vector2(1920f, 1080f);
            host.renderMode = RenderMode.WorldSpace;
            var rt = (RectTransform)host.transform;
            rt.anchorMin = rt.anchorMax = rt.pivot = new Vector2(0.5f, 0.5f);
            rt.sizeDelta = size;
            rt.localScale = Vector3.one;
            rt.SetPositionAndRotation(new Vector3(size.x * 0.5f, size.y * 0.5f, 0f), Quaternion.identity);
            Canvas.ForceUpdateCanvases();
            rect = rt.rect;
        }
        LockTunerUiEnvironment(p);
        Debug.Log("[Tuner] put UI prefab " + p.Path + " under " + host.name + " (" + host.renderMode + ", " + rect.width.ToString("0", Inv) + "x" + rect.height.ToString("0", Inv)
            + (from != null ? ", environment " + from : made ? ", made like Prefab Mode" : "") + ")");
    }

    static void AddTunerRegularEnvironment(TunerPrefab p)
    {
        if (TunerIsUiPrefabRoot(p.Root)) return;
        var envAsset = EditorSettings.prefabRegularEnvironment;
        var envPath = envAsset != null ? AssetDatabase.GetAssetPath(envAsset) : null;
        if (string.IsNullOrEmpty(envPath) || !MoveTunerEnvScene(p, envPath)) return;
        foreach (var root in p.Scene.GetRootGameObjects())
        {
            if (root == p.Root || !TunerEnvObject(root)) continue;
            if (p.Env == null) p.Env = root;
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                t.gameObject.hideFlags |= HideFlags.NotEditable;
                foreach (var c in t.GetComponents<Component>())
                    if (c != null) c.hideFlags |= HideFlags.NotEditable;
            }
        }
        Debug.Log("[Tuner] opened prefab " + p.Path + " in the environment " + envPath);
    }

    static Cubemap _tunerPrefabReflection;
    static MethodInfo _tunerAmbientFromSky;
    static bool _tunerAmbientLooked;

    static void SetTunerPrefabLighting(Scene scene)
    {
        if (!Unsupported.SetOverrideLightingSettings(scene)) return;
        try
        {
            if (_tunerPrefabReflection == null) _tunerPrefabReflection = EditorGUIUtility.Load("PrefabMode/DefaultReflectionForPrefabMode.exr") as Cubemap;
            RenderSettings.defaultReflectionMode = DefaultReflectionMode.Custom;
            RenderSettings.customReflectionTexture = _tunerPrefabReflection;
            RenderSettings.skybox = AssetDatabase.GetBuiltinExtraResource<Material>("Default-Skybox.mat");
            RenderSettings.ambientMode = AmbientMode.Skybox;
            RenderSettings.fog = false;
            if (!_tunerAmbientLooked)
            {
                _tunerAmbientLooked = true;
                _tunerAmbientFromSky = typeof(UnityEditorInternal.InternalEditorUtility).GetMethod("CalculateAmbientProbeFromSkybox", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
                if (_tunerAmbientFromSky == null) Debug.LogWarning("[Tuner] InternalEditorUtility.CalculateAmbientProbeFromSkybox was not found, prefab ambient light falls back to DynamicGI");
            }
            if (_tunerAmbientFromSky != null) _tunerAmbientFromSky.Invoke(null, null);
            else DynamicGI.UpdateEnvironment();
        }
        catch (Exception e) { Debug.LogWarning("[Tuner] could not set up the prefab lighting: " + e.Message); }
        finally { Unsupported.RestoreOverrideLightingSettings(); }
    }

    struct TunerEnvLighting
    {
        public Material Skybox;
        public AmbientMode AmbientMode;
        public Color Sky, Equator, Ground, AmbientLight, Subtractive, FogColor;
        public float AmbientIntensity, FogDensity, FogStart, FogEnd, ReflectionIntensity;
        public SphericalHarmonicsL2 Probe;
        public bool Fog;
        public FogMode FogMode;
        public DefaultReflectionMode ReflectionMode;
        public Texture Reflection;
        public int Bounces, Resolution;
        public Light Sun;
    }

    static bool CopyTunerEnvLighting(Scene from, Scene to)
    {
        var l = new TunerEnvLighting();
        if (!Unsupported.SetOverrideLightingSettings(from)) return false;
        try
        {
            l.Skybox = RenderSettings.skybox;
            l.AmbientMode = RenderSettings.ambientMode;
            l.Sky = RenderSettings.ambientSkyColor;
            l.Equator = RenderSettings.ambientEquatorColor;
            l.Ground = RenderSettings.ambientGroundColor;
            l.AmbientLight = RenderSettings.ambientLight;
            l.AmbientIntensity = RenderSettings.ambientIntensity;
            l.Probe = RenderSettings.ambientProbe;
            l.Subtractive = RenderSettings.subtractiveShadowColor;
            l.Fog = RenderSettings.fog;
            l.FogMode = RenderSettings.fogMode;
            l.FogColor = RenderSettings.fogColor;
            l.FogDensity = RenderSettings.fogDensity;
            l.FogStart = RenderSettings.fogStartDistance;
            l.FogEnd = RenderSettings.fogEndDistance;
            l.ReflectionMode = RenderSettings.defaultReflectionMode;
            l.Reflection = RenderSettings.customReflectionTexture;
            l.ReflectionIntensity = RenderSettings.reflectionIntensity;
            l.Bounces = RenderSettings.reflectionBounces;
            l.Resolution = RenderSettings.defaultReflectionResolution;
            l.Sun = RenderSettings.sun;
        }
        finally { Unsupported.RestoreOverrideLightingSettings(); }
        if (!Unsupported.SetOverrideLightingSettings(to)) return false;
        try
        {
            RenderSettings.skybox = l.Skybox;
            RenderSettings.ambientMode = l.AmbientMode;
            RenderSettings.ambientSkyColor = l.Sky;
            RenderSettings.ambientEquatorColor = l.Equator;
            RenderSettings.ambientGroundColor = l.Ground;
            RenderSettings.ambientLight = l.AmbientLight;
            RenderSettings.ambientIntensity = l.AmbientIntensity;
            RenderSettings.ambientProbe = l.Probe;
            RenderSettings.subtractiveShadowColor = l.Subtractive;
            RenderSettings.fog = l.Fog;
            RenderSettings.fogMode = l.FogMode;
            RenderSettings.fogColor = l.FogColor;
            RenderSettings.fogDensity = l.FogDensity;
            RenderSettings.fogStartDistance = l.FogStart;
            RenderSettings.fogEndDistance = l.FogEnd;
            RenderSettings.defaultReflectionMode = l.ReflectionMode;
            RenderSettings.customReflectionTexture = l.Reflection;
            RenderSettings.reflectionIntensity = l.ReflectionIntensity;
            RenderSettings.reflectionBounces = l.Bounces;
            RenderSettings.defaultReflectionResolution = l.Resolution;
            RenderSettings.sun = l.Sun;
        }
        finally { Unsupported.RestoreOverrideLightingSettings(); }
        return true;
    }

    static bool MoveTunerEnvScene(TunerPrefab p, string envPath)
    {
        Scene env = default;
        try
        {
            env = EditorSceneManager.OpenPreviewScene(envPath);
            p.EnvLit = CopyTunerEnvLighting(env, p.Scene);
            foreach (var root in env.GetRootGameObjects())
            {
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                {
                    t.gameObject.name += " (Environment)";
                    t.gameObject.hideFlags |= HideFlags.DontSave;
                }
                SceneManager.MoveGameObjectToScene(root, p.Scene);
            }
            return true;
        }
        catch (Exception e)
        {
            Debug.LogWarning("[Tuner] could not load the UI environment " + envPath + ": " + e.Message);
            return false;
        }
        finally
        {
            if (env.IsValid()) EditorSceneManager.ClosePreviewScene(env);
        }
    }

    static GameObject FindTunerEnvRooted(Transform t)
    {
        for (int i = 0; i < t.childCount; i++)
        {
            var c = t.GetChild(i);
            if ((c.gameObject.hideFlags & HideFlags.DontSaveInEditor) == 0) return c.gameObject;
            var hit = FindTunerEnvRooted(c);
            if (hit != null) return hit;
        }
        return null;
    }

    static void ReattachTunerEnv(TunerPrefab p, GameObject envRoot)
    {
        if (p.Root != null) return;
        var root = FindTunerEnvRooted(envRoot.transform);
        if (root == null) return;
        p.Root = root;
        p.Env = root.transform.parent.gameObject;
    }

    static void DropTunerUiEnvironment(TunerPrefab p)
    {
        p.Env = null;
        p.Ui = false;
        p.EnvLit = false;
    }
}
