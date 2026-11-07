using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    static void ReleaseTunerShared()
    {
        ReleaseTunerGizmoRig();
        StopTunerCloneWatch();
        TpStopGc();
        _ctrlLineBuf = null;
        ReleaseTunerSceneCamera();
        _tunerDrawCrc.Clear();
        _tunerUiCrc.Clear();
        _tunerLights.Clear();
        _tunerRoots.Clear();
        _tunerRootsGen = -1;
        _tunerSceneEditors.Clear();
        _tunerForcedSkins.Clear();
        _tunerTileVersions.Clear();
        _tunerAllRends.Clear();
        _tunerAllParticles.Clear();
        _tunerHideScene.Clear();
        _tunerHideGen = -1;
        _tunerAllRendGen = -1;
        _tunerAllTerrains.Clear();
        _tunerShownRends.Clear();
        ReleaseTunerRest();
        _tunerUiClips.Clear();
        _tunerUiMaskRects.Clear();
        if (_tunerViewMat != null) Object.DestroyImmediate(_tunerViewMat);
        _tunerViewMat = null;
        if (_tunerUiScratch != null) Object.DestroyImmediate(_tunerUiScratch);
        _tunerUiScratch = null;
        if (_tunerWireMat != null) Object.DestroyImmediate(_tunerWireMat);
        _tunerWireMat = null;
        if (_tunerWireCmd != null) _tunerWireCmd.Release();
        _tunerWireCmd = null;
    }

    static void TiReleaseShared()
    {
        if (s_TiSink != null)
        {
            if (RenderTexture.active == s_TiSink) RenderTexture.active = null;
            s_TiSink.Release();
            Object.DestroyImmediate(s_TiSink);
            s_TiSink = null;
        }
        foreach (var tool in s_TiTools.Values)
            if (tool != null) Object.DestroyImmediate(tool);
        s_TiTools.Clear();
        s_TiClipRecs.Clear();
        TiReleaseJsonBuffers();
        s_TiMatPaths.Clear();
        s_TiListMarks.Clear();
        foreach (var p in s_TiPendingTextures)
            if (p.Copy != null) Object.DestroyImmediate(p.Copy);
        s_TiPendingTextures.Clear();
        s_TunerSearchRuns.Clear();
        s_TunerSearchPickers.Clear();
        s_TunerPopupList = null;
        if (!s_TiHooked) return;
        s_TiHooked = false;
        EditorApplication.update -= TunerInspectorTick;
        AssemblyReloadEvents.beforeAssemblyReload -= TiDisposeAll;
        EditorApplication.quitting -= TiDisposeAll;
        Undo.undoRedoPerformed -= TiMarkAllDirty;
        ObjectChangeEvents.changesPublished -= TiOnChanges;
        EditorApplication.hierarchyChanged -= TiOnHierarchyChanged;
        EditorApplication.playModeStateChanged -= TiOnPlayMode;
        EditorApplication.projectChanged -= TiMarkAllDirty;
    }
}
