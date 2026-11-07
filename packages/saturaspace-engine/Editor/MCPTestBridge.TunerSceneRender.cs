using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;
using UnityEngine.Rendering.RendererUtils;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    const int TUNER_PASS_DEPTH = 2;
    const string TUNER_URP_CAMERA_DATA = "UnityEngine.Rendering.Universal.UniversalAdditionalCameraData, Unity.RenderPipelines.Universal.Runtime";

    static Camera _tunerSceneCam;
    static SceneView _tunerSceneHost;
    const string TUNER_SCENE_HOST_NAME = "_SaturaTunerSceneView";
    static Type _tunerUrpCameraData;
    static PropertyInfo _tunerUrpPost;
    static bool _tunerUrpKnown;
    static bool _tunerSceneRenderWarned;
    static int _tunerChangeGen;
    static int _tunerAllRendGen = -1;
    static readonly List<Renderer> _tunerAllRends = new List<Renderer>();
    static readonly List<Renderer> _tunerAllParticles = new List<Renderer>();
    static readonly List<Renderer> _tunerHideScene = new List<Renderer>();
    static int _tunerHideGen = -1;
    static string _tunerHideFilter;
    static bool _tunerHideParticles;
    static readonly List<Terrain> _tunerAllTerrains = new List<Terrain>();
    static readonly List<Renderer> _tunerHidden = new List<Renderer>();
    static readonly List<Terrain> _tunerHiddenTerrains = new List<Terrain>();
    static readonly HashSet<Renderer> _tunerShownRends = new HashSet<Renderer>();
    static readonly List<Renderer> _tunerRendScratch = new List<Renderer>();
    static int _tunerLightGen = -1;
    static readonly List<Light> _tunerLights = new List<Light>();
    const double TUNER_SCENE_SETTLE = 1.5;
    const double TUNER_SETTLE_FRAME = 0.3;
    static double _tunerSettleUntil = -1;
    static int _tunerLightDataGen;
    static TunerSession _tunerDepthFor;
    static bool _tunerCameraDepth;
    static Matrix4x4 _tunerDepthView;
    static Matrix4x4 _tunerDepthProj;
    static CommandBuffer _tunerDepthCmd;
    static readonly ShaderTagId TunerDepthOnlyTag = new ShaderTagId("DepthOnly");
    static readonly RenderStateBlock TunerDepthNoColor = new RenderStateBlock(RenderStateMask.Blend)
    {
        blendState = new BlendState { blendState0 = new RenderTargetBlendState((ColorWriteMask)0) }
    };

    static readonly Color TunerUnityBackground = new Color(0.278431f, 0.278431f, 0.278431f, 1f);
    static FieldInfo _tunerBgField;
    static PropertyInfo _tunerBgColor;
    static bool _tunerBgKnown;

    static Color TunerSceneBackground()
    {
        if (!_tunerBgKnown)
        {
            _tunerBgKnown = true;
            _tunerBgField = typeof(SceneView).GetField("kSceneViewBackground", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            var t = _tunerBgField != null ? _tunerBgField.FieldType : null;
            _tunerBgColor = t != null ? t.GetProperty("Color", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic) : null;
        }
        try
        {
            if (_tunerBgField != null && _tunerBgColor != null)
            {
                var pref = _tunerBgField.GetValue(null);
                if (pref != null) return (Color)_tunerBgColor.GetValue(pref);
            }
        }
        catch { }
        return TunerUnityBackground;
    }

    static string OnOff(bool on)
    {
        return on ? "on" : "off";
    }

    [InitializeOnLoadMethod]
    static void InitTunerSceneRender()
    {
        if (Inert) return;
        ObjectChangeEvents.changesPublished += CountTunerSceneChanges;
        EditorSceneManager.sceneOpened += OnTunerSceneOpened;
        EditorSceneManager.newSceneCreated += OnTunerSceneCreated;
        Lightmapping.lightingDataUpdated += OnTunerLightingData;
        RenderPipelineManager.endCameraRendering += OnTunerEndCamera;
        PrefabStage.prefabStageOpened += OnTunerPrefabStageOpened;
        AssemblyReloadEvents.beforeAssemblyReload += ReleaseTunerSceneCamera;
        InitTunerVisibility();
    }

    static void CountTunerSceneChanges(ref ObjectChangeEventStream stream)
    {
        _tunerChangeGen++;
        for (int i = 0; i < stream.length; i++)
        {
            switch (stream.GetEventType(i))
            {
                case ObjectChangeKind.CreateGameObjectHierarchy:
                case ObjectChangeKind.DestroyGameObjectHierarchy:
                case ObjectChangeKind.ChangeGameObjectStructure:
                case ObjectChangeKind.ChangeGameObjectStructureHierarchy:
                case ObjectChangeKind.ChangeGameObjectParent:
                case ObjectChangeKind.UpdatePrefabInstances:
                    OnTunerHierarchyChanged();
                    return;
            }
        }
    }

    static void OnTunerSceneOpened(Scene scene, OpenSceneMode mode)
    {
        if (!EditorApplication.isPlaying) DynamicGI.UpdateEnvironment();
        SettleTunerScene();
        EditorApplication.delayCall += () => TickTunerEditMode(scene);
    }

    static void OnTunerPrefabStageOpened(PrefabStage stage)
    {
        SettleTunerScene();
        EditorApplication.delayCall += () =>
        {
            if (stage != null) TickTunerEditMode(stage.scene);
        };
    }

    static readonly Dictionary<Type, MethodInfo[]> _tunerTickMethods = new Dictionary<Type, MethodInfo[]>();
    static readonly List<MonoBehaviour> _tunerTickScratch = new List<MonoBehaviour>();
    static readonly List<MonoBehaviour> _tunerTickTargets = new List<MonoBehaviour>();
    static bool _tunerTickWarned;

    static MethodInfo[] TunerTickMethods(Type t)
    {
        if (_tunerTickMethods.TryGetValue(t, out var found)) return found;
        MethodInfo[] methods = null;
        if (t.IsDefined(typeof(ExecuteAlways), false) || t.IsDefined(typeof(ExecuteInEditMode), false))
            methods = new[] { TunerFindTickMethod(t, "Update"), TunerFindTickMethod(t, "LateUpdate") };
        if (methods != null && methods[0] == null && methods[1] == null) methods = null;
        _tunerTickMethods[t] = methods;
        return methods;
    }

    static MethodInfo TunerFindTickMethod(Type t, string name)
    {
        for (var c = t; c != null && c != typeof(MonoBehaviour); c = c.BaseType)
        {
            var m = c.GetMethod(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly, null, Type.EmptyTypes, null);
            if (m != null) return m;
        }
        return null;
    }

    static void TickTunerEditMode(Scene scene)
    {
        TickTunerEditMode(scene, true);
    }

    static void TickTunerEditMode(Scene scene, bool redraw)
    {
        if (EditorApplication.isPlaying || !scene.IsValid() || !scene.isLoaded) return;
        _tunerTickTargets.Clear();
        foreach (var root in scene.GetRootGameObjects())
        {
            root.GetComponentsInChildren(false, _tunerTickScratch);
            foreach (var mb in _tunerTickScratch)
                if (mb != null && mb.isActiveAndEnabled && TunerTickMethods(mb.GetType()) != null) _tunerTickTargets.Add(mb);
        }
        _tunerTickScratch.Clear();
        for (int pass = 0; pass < 2; pass++)
            foreach (var mb in _tunerTickTargets)
            {
                var m = mb != null ? TunerTickMethods(mb.GetType())[pass] : null;
                if (m == null || !mb.isActiveAndEnabled) continue;
                try { m.Invoke(mb, null); }
                catch (Exception e)
                {
                    if (_tunerTickWarned) continue;
                    _tunerTickWarned = true;
                    Debug.LogWarning("[Tuner] " + mb.GetType().Name + "." + m.Name + " failed while settling the scene: " + (e.InnerException ?? e).Message);
                }
            }
        _tunerTickTargets.Clear();
        if (!redraw) return;
        _tunerChangeGen++;
    }

    static void OnTunerSceneCreated(Scene scene, NewSceneSetup setup, NewSceneMode mode)
    {
        SettleTunerScene();
    }

    static void OnTunerLightingData()
    {
        _tunerLightDataGen++;
    }

    static double _tunerEyeSettleFrom = -1;

    static void SettleTunerScene()
    {
        _tunerSettleUntil = EditorApplication.timeSinceStartup + TUNER_SCENE_SETTLE;
        _tunerEyeSettleFrom = EditorApplication.timeSinceStartup;
        if (!EditorApplication.isPlaying) EditorApplication.QueuePlayerLoopUpdate();
    }

    static bool TunerSettling(double now)
    {
        if (_tunerSettleUntil < 0) return false;
        if (now < _tunerSettleUntil) return true;
        _tunerSettleUntil = -1;
        return false;
    }

    static bool TunerUsesCamera(TunerSession s)
    {
        return !s.Ui;
    }

    static Camera TunerSceneCamera()
    {
        if (_tunerSceneCam != null && _tunerSceneHost != null) return _tunerSceneCam;
        if (_tunerSceneHost == null)
            foreach (var view in Resources.FindObjectsOfTypeAll<SceneView>())
                if (view != null && view.name == TUNER_SCENE_HOST_NAME) _tunerSceneHost = view;
        if (_tunerSceneHost == null)
        {
            _tunerSceneHost = ScriptableObject.CreateInstance<SceneView>();
            _tunerSceneHost.name = TUNER_SCENE_HOST_NAME;
            _tunerSceneHost.hideFlags = HideFlags.HideAndDontSave;
            _tunerSceneHost.drawGizmos = false;
            _tunerSceneHost.showGrid = false;
            var settings = _tunerSceneHost.cameraSettings;
            settings.occlusionCulling = false;
            _tunerSceneHost.cameraSettings = settings;
        }
        _tunerSceneCam = _tunerSceneHost.camera;
        _tunerSceneCam.gameObject.name = TUNER_CAMERA_NAME;
        _tunerSceneCam.cameraType = CameraType.SceneView;
        _tunerSceneCam.useOcclusionCulling = false;
        return _tunerSceneCam;
    }

    static void SyncTunerSceneHost(TunerViewState v)
    {
        var st = _tunerSceneHost != null ? _tunerSceneHost.sceneViewState : null;
        if (st == null) return;
        if (!st.fxEnabled) st.fxEnabled = true;
        if (st.showFog == v.FogOff) st.showFog = !v.FogOff;
        if (st.showSkybox == v.SkyboxOff) st.showSkybox = !v.SkyboxOff;
        if (st.showImageEffects == v.PostOff) st.showImageEffects = !v.PostOff;
        if (st.showParticleSystems == v.ParticlesOff) st.showParticleSystems = !v.ParticlesOff;
        if (st.alwaysRefresh != v.AlwaysRefresh) st.alwaysRefresh = v.AlwaysRefresh;
    }

    static void OnTunerEndCamera(ScriptableRenderContext ctx, Camera cam)
    {
        var s = _tunerDepthFor;
        if (s == null || cam != _tunerSceneCam || s.Target == null) return;
        if (!cam.TryGetCullingParameters(out var p)) return;
        var cull = ctx.Cull(ref p);
        var list = ctx.CreateRendererList(new RendererListDesc(TunerDepthOnlyTag, cull, cam)
        {
            renderQueueRange = RenderQueueRange.opaque,
            sortingCriteria = SortingCriteria.CommonOpaque,
            stateBlock = TunerDepthNoColor
        });
        if (_tunerDepthCmd == null) _tunerDepthCmd = new CommandBuffer { name = "Tuner camera depth" };
        var cmd = _tunerDepthCmd;
        cmd.Clear();
        cmd.SetRenderTarget(s.Target);
        cmd.ClearRenderTarget(true, false, Color.clear);
        cmd.SetViewProjectionMatrices(_tunerDepthView, _tunerDepthProj);
        cmd.DrawRendererList(list);
        ctx.ExecuteCommandBuffer(cmd);
        cmd.Clear();
        _tunerCameraDepth = true;
    }

    static void ReleaseTunerSceneCamera()
    {
        _tunerDepthCmd?.Release();
        _tunerDepthCmd = null;
        if (_tunerSceneHost != null) UnityEngine.Object.DestroyImmediate(_tunerSceneHost);
        _tunerSceneHost = null;
        foreach (var view in Resources.FindObjectsOfTypeAll<SceneView>())
            if (view != null && view.name == TUNER_SCENE_HOST_NAME) UnityEngine.Object.DestroyImmediate(view);
        _tunerSceneCam = null;
        if (_tunerViewLights != null)
            foreach (var l in _tunerViewLights)
                if (l != null) UnityEngine.Object.DestroyImmediate(l.gameObject);
        _tunerViewLights = null;
        if (_tunerViewLightsScene.IsValid()) EditorSceneManager.ClosePreviewScene(_tunerViewLightsScene);
        _tunerViewLightsScene = default;
    }

    static readonly Color TunerViewFrontLight = new Color(0.769f, 0.769f, 0.769f, 1f);
    static readonly Color TunerViewUpLight = new Color(0.212f, 0.227f, 0.259f, 1f);
    static readonly Color TunerViewMidLight = new Color(0.114f, 0.125f, 0.133f, 1f);
    static readonly Color TunerViewDownLight = new Color(0.047f, 0.043f, 0.035f, 1f);
    static readonly Color TunerViewFillLight = new Color(0.32f, 0.33f, 0.34f, 1f);
    static Light[] _tunerViewLights;
    static Scene _tunerViewLightsScene;

    static Light[] TunerViewLights()
    {
        if (_tunerViewLights != null && _tunerViewLights[0] != null) return _tunerViewLights;
        if (!_tunerViewLightsScene.IsValid()) _tunerViewLightsScene = EditorSceneManager.NewPreviewScene();
        _tunerViewLights = new Light[3];
        for (int i = 0; i < 3; i++)
        {
            var go = EditorUtility.CreateGameObjectWithHideFlags("SceneLight", HideFlags.HideAndDontSave, typeof(Light));
            var l = go.GetComponent<Light>();
            l.type = LightType.Directional;
            l.intensity = 1f;
            l.enabled = false;
            SceneManager.MoveGameObjectToScene(go, _tunerViewLightsScene);
            _tunerViewLights[i] = l;
        }
        _tunerViewLights[0].color = TunerViewFrontLight;
        _tunerViewLights[1].color = TunerViewUpLight - TunerViewMidLight;
        _tunerViewLights[1].transform.LookAt(Vector3.down);
        _tunerViewLights[1].renderMode = LightRenderMode.ForceVertex;
        _tunerViewLights[2].color = TunerViewDownLight - TunerViewMidLight;
        _tunerViewLights[2].transform.LookAt(Vector3.up);
        _tunerViewLights[2].renderMode = LightRenderMode.ForceVertex;
        return _tunerViewLights;
    }

    static bool TunerSceneHasLights(Scene scene, GameObject own)
    {
        foreach (var root in scene.GetRootGameObjects())
        {
            if (root == own) continue;
            if (root.GetComponentsInChildren<Light>(false).Length > 0) return true;
            if (TunerLight2DType != null)
                foreach (var c in root.GetComponentsInChildren(TunerLight2DType, false))
                    if (c is Behaviour b && b.enabled) return true;
        }
        return false;
    }

    static bool _tunerLight2DLooked;
    static Type _tunerLight2DType;

    static Type TunerLight2DType
    {
        get
        {
            if (!_tunerLight2DLooked)
            {
                _tunerLight2DLooked = true;
                _tunerLight2DType = TiTypeOrNull("UnityEngine.Rendering.Universal.Light2D");
            }
            return _tunerLight2DType;
        }
    }

    static void SetTunerPostProcessing(Camera cam, bool on)
    {
        if (!_tunerUrpKnown)
        {
            _tunerUrpKnown = true;
            _tunerUrpCameraData = Type.GetType(TUNER_URP_CAMERA_DATA, false);
            if (_tunerUrpCameraData != null) _tunerUrpPost = _tunerUrpCameraData.GetProperty("renderPostProcessing", BindingFlags.Public | BindingFlags.Instance);
        }
        if (_tunerUrpCameraData == null || _tunerUrpPost == null || !(GraphicsSettings.currentRenderPipeline != null && GraphicsSettings.currentRenderPipeline.GetType().Name.StartsWith("Universal", StringComparison.Ordinal))) return;
        var data = cam.GetComponent(_tunerUrpCameraData) ?? cam.gameObject.AddComponent(_tunerUrpCameraData);
        if (data != null && (bool)_tunerUrpPost.GetValue(data) != on) _tunerUrpPost.SetValue(data, on);
    }

    static readonly List<SkinnedMeshRenderer> _tunerForcedSkins = new List<SkinnedMeshRenderer>();

    static List<SkinnedMeshRenderer> ForceTunerSkinning(TunerSession s)
    {
        _tunerForcedSkins.Clear();
        if (EditorApplication.isPlaying) return _tunerForcedSkins;
        foreach (var e in s.Rends)
        {
            if (e.Skin == null || !e.Active || e.SkinHash == e.SkinDrawn) continue;
            e.SkinDrawn = e.SkinHash;
            if (e.Skin.forceMatrixRecalculationPerRender) continue;
            e.Skin.forceMatrixRecalculationPerRender = true;
            _tunerForcedSkins.Add(e.Skin);
        }
        return _tunerForcedSkins;
    }

    static RenderTexture TunerSrpTarget(TunerSession s)
    {
        var t = s.Target;
        if (t.antiAliasing <= 1) return t;
        var srp = s.SrpTarget;
        if (srp != null && srp.width == t.width && srp.height == t.height && srp.IsCreated()) return srp;
        ReleaseTunerTexture(ref s.SrpTarget);
        s.SrpTarget = new RenderTexture(t.width, t.height, 24, RenderTextureFormat.ARGB32) { name = TUNER_RT_NAME, hideFlags = HideFlags.HideAndDontSave };
        return s.SrpTarget.Create() ? s.SrpTarget : t;
    }

    static void RenderTunerSceneCamera(TunerSession s, int w, int h, Matrix4x4 view, Matrix4x4 proj)
    {
        var v = TunerViewOf(s, true);
        var cam = TunerSceneCamera();
        _tunerCameraDepth = false;
        cam.transform.SetPositionAndRotation(s.CamPos, s.CamRot);
        cam.orthographic = s.Ortho > 0f;
        if (s.Ortho > 0f) cam.orthographicSize = s.Ortho;
        cam.fieldOfView = s.Fov;
        cam.nearClipPlane = s.Near;
        cam.farClipPlane = s.Far;
        cam.aspect = (float)w / h;
        cam.ResetWorldToCameraMatrix();
        if (s.Ortho > 0f && !s.OrthoClip) cam.projectionMatrix = proj;
        else cam.ResetProjectionMatrix();
        var prefab = ActiveTunerPrefab(s);
        bool lighting = prefab != null && Unsupported.SetOverrideLightingSettings(prefab.Scene);
        ulong cullWas = cam.overrideSceneCullingMask;
        if (prefab != null)
        {
            cam.scene = prefab.Scene;
            cam.overrideSceneCullingMask = 0;
        }
        bool canvasOnly = s.Scene && prefab == null && _tunerIsoOn && TunerCanvasViewOf(s) != null;
        bool sky = !v.SkyboxOff && !canvasOnly && RenderSettings.skybox != null && (prefab == null || prefab.EnvLit);
        cam.clearFlags = sky ? CameraClearFlags.Skybox : CameraClearFlags.SolidColor;
        cam.backgroundColor = TunerSceneBackground();
        cam.allowMSAA = true;
        var main = Camera.main;
        cam.allowHDR = main == null || main.allowHDR;
        cam.targetTexture = s.Target;
        cam.cullingMask = Tools.visibleLayers;
        SyncTunerSceneHost(v);
        SetTunerPostProcessing(cam, !v.PostOff && !v.LightingOff && !canvasOnly);
        bool asyncWas = ShaderUtil.allowAsyncCompilation;
        ShaderUtil.allowAsyncCompilation = EditorSettings.asyncShaderCompilation;
        bool fogWas = RenderSettings.fog;
        bool fogOff = v.FogOff || canvasOnly || (s.Ortho > 0f && !s.OrthoClip);
        if (fogOff && fogWas) Unsupported.SetRenderSettingsUseFogNoDirty(false);
        float shadowWas = QualitySettings.shadowDistance;
        bool shadowFar = s.Ortho > 0f && s.OrthoClip;
        if (shadowFar) Unsupported.SetQualitySettingsShadowDistanceTemporarily(shadowWas + s.Ortho * Mathf.Min(1f, cam.aspect));
        HideTunerOthers(s, v);
        bool visWas = SetTunerSceneVisibility(s.Scene && prefab == null && _tunerIsoOn);
        if (s.Scene && prefab == null) HideTunerVisHidden();
        var forced = ForceTunerSkinning(s);
        bool unlit = false;
        var drawingWas = prefab == null ? BeginTunerThirdPartyDrawing(!v.GizmosOff) : null;
        try
        {
            if (prefab != null)
            {
                if (!EditorApplication.isPlaying) TickTunerEditMode(prefab.Scene, false);
                unlit = !TunerSceneHasLights(prefab.Scene, prefab.Light);
            }
            if (unlit || v.LightingOff)
            {
                unlit = true;
                var lights = TunerViewLights();
                lights[0].transform.rotation = cam.transform.rotation;
                ulong mask = prefab != null ? EditorSceneManager.GetSceneCullingMask(prefab.Scene) : SceneCullingMasks.DefaultSceneCullingMask;
                if (EditorSceneManager.GetSceneCullingMask(_tunerViewLightsScene) != mask) EditorSceneManager.SetSceneCullingMask(_tunerViewLightsScene, mask);
                UnityEditorInternal.InternalEditorUtility.SetCustomLighting(lights, TunerViewFillLight);
                cam.allowHDR = false;
            }
            SortingGroup.UpdateAllSortingGroups();
            _tunerDepthFor = s;
            _tunerDepthView = view;
            _tunerDepthProj = proj;
            var dest = GraphicsSettings.currentRenderPipeline != null ? TunerSrpTarget(s) : s.Target;
            cam.targetTexture = dest;
            var req = new RenderPipeline.StandardRequest { destination = dest };
            if (GraphicsSettings.currentRenderPipeline != null && RenderPipeline.SupportsRenderRequest(cam, req))
            {
                RenderPipeline.SubmitRenderRequest(cam, req);
                if (dest != s.Target) Graphics.Blit(dest, s.Target);
            }
            else
            {
                cam.targetTexture = s.Target;
                cam.Render();
            }
        }
        catch (Exception e)
        {
            if (!_tunerSceneRenderWarned)
            {
                _tunerSceneRenderWarned = true;
                Debug.LogWarning("[Tuner] the scene camera could not render: " + e.Message);
            }
        }
        finally
        {
            SetTunerSceneVisibility(visWas);
            EndTunerThirdPartyDrawing(drawingWas);
            _tunerDepthFor = null;
            if (unlit)
            {
                UnityEditorInternal.InternalEditorUtility.RemoveCustomLighting();
            }
            if (fogOff && fogWas) Unsupported.SetRenderSettingsUseFogNoDirty(true);
            if (lighting) Unsupported.RestoreOverrideLightingSettings();
            foreach (var smr in forced)
                if (smr != null) smr.forceMatrixRecalculationPerRender = false;
            ShowTunerOthers();
            ShaderUtil.allowAsyncCompilation = asyncWas;
            if (shadowFar) Unsupported.SetQualitySettingsShadowDistanceTemporarily(shadowWas);
            cam.targetTexture = null;
            if (prefab != null)
            {
                cam.scene = default;
                cam.overrideSceneCullingMask = cullWas;
            }
        }
    }

    static void RefreshTunerAllRends()
    {
        if (_tunerAllRendGen == _tunerHierarchyGen) return;
        _tunerAllRendGen = _tunerHierarchyGen;
        _tunerAllRends.Clear();
        _tunerAllTerrains.Clear();
        _tunerAllRends.AddRange(UnityEngine.Object.FindObjectsByType<Renderer>(FindObjectsInactive.Exclude, FindObjectsSortMode.None));
        _tunerAllParticles.Clear();
        foreach (var r in _tunerAllRends)
            if (r is ParticleSystemRenderer) _tunerAllParticles.Add(r);
        _tunerAllTerrains.AddRange(UnityEngine.Object.FindObjectsByType<Terrain>(FindObjectsInactive.Exclude, FindObjectsSortMode.None));
    }

    static void CollectTunerShownRends(TunerSession s)
    {
        _tunerShownRends.Clear();
        foreach (var oi in TunerActiveObjects(s))
        {
            var go = oi < s.Objects.Length ? s.Objects[oi] : null;
            if (go == null) continue;
            go.GetComponentsInChildren(false, _tunerRendScratch);
            foreach (var r in _tunerRendScratch) _tunerShownRends.Add(r);
        }
        foreach (var e in s.Entries)
        {
            if (e.Asset || e.Go == null) continue;
            e.Go.GetComponentsInChildren(false, _tunerRendScratch);
            foreach (var r in _tunerRendScratch) _tunerShownRends.Add(r);
        }
        _tunerRendScratch.Clear();
    }

    static bool TunerKeepsWorld(TunerSession s)
    {
        foreach (var oi in TunerActiveObjects(s))
        {
            var go = oi < s.Objects.Length ? s.Objects[oi] : null;
            if (go != null && go.GetComponentInChildren<Light>(false) != null) return true;
        }
        foreach (var e in s.Entries)
            if (!e.Asset && e.Go != null && e.Go.GetComponentInChildren<Light>(false) != null) return true;
        return false;
    }

    static void HideTunerOthers(TunerSession s, TunerViewState v)
    {
        _tunerHidden.Clear();
        _tunerHiddenTerrains.Clear();
        bool isolate = s.Scene && s.SceneFilter != null;
        bool cull = TunerCullsFar(s, v);
        LogTunerViewChange(s, ref v.ContextReport, cull ? "context off: objects far from the filter are not drawn" : v.Context ? "context on: the whole scene is drawn" : null);
        if (!cull) StopTunerRest(v);
        if (!isolate && !cull && !v.ParticlesOff) return;
        RefreshTunerAllRends();
        if (cull)
        {
            HideTunerRest(s, v);
            if (!isolate) return;
        }
        if (!isolate)
        {
            foreach (var r in _tunerAllParticles)
            {
                if (r == null || r.forceRenderingOff) continue;
                r.forceRenderingOff = true;
                _tunerHidden.Add(r);
            }
            return;
        }
        if (_tunerHideGen != _tunerAllRendGen || _tunerHideFilter != s.SceneFilter || _tunerHideParticles != v.ParticlesOff)
        {
            _tunerHideGen = _tunerAllRendGen;
            _tunerHideFilter = s.SceneFilter;
            _tunerHideParticles = v.ParticlesOff;
            _tunerHideScene.Clear();
            foreach (var r in _tunerAllRends)
                if (r != null && ((v.ParticlesOff && r is ParticleSystemRenderer) || !TunerSceneInFilter(s, r.gameObject.scene))) _tunerHideScene.Add(r);
        }
        foreach (var r in _tunerHideScene)
        {
            if (r == null || r.forceRenderingOff) continue;
            r.forceRenderingOff = true;
            _tunerHidden.Add(r);
        }
        foreach (var t in _tunerAllTerrains)
        {
            if (t == null || !t.drawHeightmap || TunerSceneInFilter(s, t.gameObject.scene)) continue;
            t.drawHeightmap = false;
            t.drawTreesAndFoliage = false;
            _tunerHiddenTerrains.Add(t);
        }
    }

    static readonly List<Renderer> _tunerVisHideRends = new List<Renderer>();
    static readonly List<Terrain> _tunerVisHideTerrains = new List<Terrain>();
    static int _tunerVisHideGen = -1;
    static int _tunerVisHideRendGen = -1;

    static void HideTunerVisHidden()
    {
        if (!_tunerIsoOn) return;
        RefreshTunerAllRends();
        if (_tunerVisHideGen != _tunerVisGen || _tunerVisHideRendGen != _tunerAllRendGen)
        {
            _tunerVisHideGen = _tunerVisGen;
            _tunerVisHideRendGen = _tunerAllRendGen;
            _tunerVisHideRends.Clear();
            _tunerVisHideTerrains.Clear();
            foreach (var r in _tunerAllRends)
                if (r != null && TunerVisHidden(r.gameObject)) _tunerVisHideRends.Add(r);
            foreach (var t in _tunerAllTerrains)
                if (t != null && TunerVisHidden(t.gameObject)) _tunerVisHideTerrains.Add(t);
        }
        foreach (var r in _tunerVisHideRends)
        {
            if (r == null || r.forceRenderingOff) continue;
            r.forceRenderingOff = true;
            _tunerHidden.Add(r);
        }
        foreach (var t in _tunerVisHideTerrains)
        {
            if (t == null || !t.drawHeightmap) continue;
            t.drawHeightmap = false;
            t.drawTreesAndFoliage = false;
            _tunerHiddenTerrains.Add(t);
        }
    }

    static void ShowTunerOthers()
    {
        foreach (var r in _tunerHidden)
            if (r != null) r.forceRenderingOff = false;
        foreach (var t in _tunerHiddenTerrains)
        {
            if (t == null) continue;
            t.drawHeightmap = true;
            t.drawTreesAndFoliage = true;
        }
        _tunerHidden.Clear();
        _tunerHiddenTerrains.Clear();
    }

    static readonly Plane[] _tunerFrustum = new Plane[6];

    static Bounds TunerRendBounds(TunerSession s, TunerRend e)
    {
        if (e.BoundsAt != s.HashedAt)
        {
            e.Bounds = e.R.bounds;
            e.BoundsAt = s.HashedAt;
        }
        return e.Bounds;
    }

    static bool TunerInFrustum(Bounds b)
    {
        var c = b.center;
        var x = b.extents;
        for (int i = 0; i < 6; i++)
        {
            var p = _tunerFrustum[i];
            var n = p.normal;
            float r = x.x * Math.Abs(n.x) + x.y * Math.Abs(n.y) + x.z * Math.Abs(n.z);
            if (n.x * c.x + n.y * c.y + n.z * c.z + p.distance + r < 0f) return false;
        }
        return true;
    }

    static void RecordTunerDepth(TunerSession s, CommandBuffer cmd, double now)
    {
        TunerRend last = null;
        bool inView = true;
        bool first = true;
        Texture setTex = null;
        Vector4 setSt = default;
        float setCutoff = float.NaN;
        Color setColor = default;
        foreach (var d in s.Draws)
        {
            if (d.Transparent || d.Rend.Kind != TunerKind.Mesh || !TunerDrawReady(d)) continue;
            if (!ReferenceEquals(d.Rend, last))
            {
                last = d.Rend;
                inView = TunerInFrustum(TunerRendBounds(s, last));
            }
            if (!inView) continue;
            if (last.UseBake)
            {
                RecordTunerDraw(s, cmd, d, TUNER_PASS_DEPTH, now);
                setTex = null;
                continue;
            }
            var tex = d.Tex != null ? d.Tex : Texture2D.whiteTexture;
            if (first)
            {
                first = false;
                cmd.SetGlobalFloat(TunerVertexColorId, 0f);
                cmd.SetGlobalFloat(TunerSdfId, 0f);
                cmd.SetGlobalFloat(TunerFlatId, 0f);
                cmd.SetGlobalVector(TunerTexAddId, Vector4.zero);
                cmd.SetGlobalVector(TunerUiViewClipId, TunerUiNoViewClip);
            }
            if (!ReferenceEquals(tex, setTex) || d.St != setSt || d.Cutoff != setCutoff || d.Color != setColor || d.VertexColor || d.Sdf || d.Flat || d.TexAdd != Vector4.zero)
            {
                RecordTunerDraw(s, cmd, d, TUNER_PASS_DEPTH, now);
                setTex = d.VertexColor || d.Sdf || d.Flat || d.TexAdd != Vector4.zero ? null : tex;
                first = setTex == null;
                setSt = d.St;
                setCutoff = d.Cutoff;
                setColor = d.Color;
                continue;
            }
            cmd.DrawRenderer(last.R, s.Unlit, d.Sub, TUNER_PASS_DEPTH);
        }
    }

    static ulong MixTunerSceneRender(TunerSession s, ulong h)
    {
        if (!TunerUsesCamera(s)) return h;
        var v = TunerViewOf(s, false);
        h = TunerMix(h, (uint)_tunerChangeGen);
        h = TunerMix(h, (uint)_tunerHierarchyGen);
        if (v != null)
        {
            h = TunerMix(h, (v.SkyboxOff ? 1u : 0u) | (v.FogOff ? 2u : 0u) | (v.PostOff ? 4u : 0u) | (v.ParticlesOff ? 8u : 0u) | (v.LightingOff ? 16u : 0u));
            if (v.AlwaysRefresh) h = TunerMix(h, (uint)(EditorApplication.timeSinceStartup / TUNER_FRAME_INTERVAL));
        }
        h = MixTunerLighting(h);
        h = TunerMix(h, (uint)_tunerLightDataGen | (ShaderUtil.anythingCompiling ? 0x80000000u : 0u));
        double now = EditorApplication.timeSinceStartup;
        if (TunerSettling(now))
        {
            if (!EditorApplication.isPlaying) EditorApplication.QueuePlayerLoopUpdate();
            h = TunerMix(h, (uint)(now / TUNER_SETTLE_FRAME));
        }
        if (EditorApplication.isPlaying && !EditorApplication.isPaused && TunerHasLiveRends(s)) h = TunerMix(h, (uint)Time.frameCount);
        return h;
    }

    static bool TunerHasLiveRends(TunerSession s)
    {
        foreach (var r in s.LiveRends)
            if (r != null && r.enabled && r.gameObject.activeInHierarchy) return true;
        foreach (var c in s.LiveDrivers)
        {
            if (c == null || !c.gameObject.activeInHierarchy) continue;
            var an = c as Animator;
            if (an != null && an.enabled && an.runtimeAnimatorController != null && an.speed != 0f) return true;
            var la = c as Animation;
            if (la != null && la.enabled && la.isPlaying) return true;
            var cloth = c as Cloth;
            if (cloth != null && cloth.enabled) return true;
        }
        return false;
    }

    static ulong MixTunerColor(ulong h, Color c)
    {
        h = TunerMix(h, c.r);
        h = TunerMix(h, c.g);
        h = TunerMix(h, c.b);
        return TunerMix(h, c.a);
    }

    static ulong MixTunerLighting(ulong h)
    {
        if (_tunerLightGen != _tunerHierarchyGen)
        {
            _tunerLightGen = _tunerHierarchyGen;
            _tunerLights.Clear();
            _tunerLights.AddRange(UnityEngine.Object.FindObjectsByType<Light>(FindObjectsInactive.Include, FindObjectsSortMode.None));
        }
        foreach (var l in _tunerLights)
        {
            if (l == null) continue;
            bool on = l.isActiveAndEnabled;
            h = TunerMix(h, on ? 1u : 0u);
            if (!on) continue;
            h = TunerMix(h, l.transform.localToWorldMatrix);
            h = MixTunerColor(h, l.color);
            h = TunerMix(h, l.intensity);
            h = TunerMix(h, l.range);
            h = TunerMix(h, l.spotAngle);
            h = TunerMix(h, l.colorTemperature);
            h = TunerMix(h, l.shadowStrength);
            h = TunerMix(h, (uint)l.type | ((uint)l.shadows << 4));
            h = TunerMix(h, unchecked((uint)l.cullingMask));
        }
        h = TunerMix(h, (uint)RenderSettings.ambientMode | ((uint)RenderSettings.fogMode << 4) | (RenderSettings.fog ? 256u : 0u));
        h = MixTunerColor(h, RenderSettings.ambientSkyColor);
        h = MixTunerColor(h, RenderSettings.ambientEquatorColor);
        h = MixTunerColor(h, RenderSettings.ambientGroundColor);
        h = TunerMix(h, RenderSettings.ambientIntensity);
        h = TunerMix(h, RenderSettings.reflectionIntensity);
        h = MixTunerColor(h, RenderSettings.fogColor);
        h = TunerMix(h, RenderSettings.fogDensity);
        h = TunerMix(h, RenderSettings.fogStartDistance);
        h = TunerMix(h, RenderSettings.fogEndDistance);
        h = TunerMix(h, RenderSettings.sun);
        var probe = RenderSettings.ambientProbe;
        for (int c = 0; c < 3; c++)
            for (int k = 0; k < 9; k++) h = TunerMix(h, probe[c, k]);
        h = TunerMix(h, ReflectionProbe.defaultTexture);
        var sky = RenderSettings.skybox;
        h = TunerMix(h, sky);
        if (sky != null) h = TunerMix(h, unchecked((uint)sky.ComputeCRC()));
        return h;
    }
}
