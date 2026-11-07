using UnityEngine;
using UnityEditor;
using UnityEditor.SceneManagement;
using System;
using System.IO;
using SaturaSpace;

public static partial class MCPTestBridge
{
    const string SS_SCENE_OPENING = "MCPTestBridge_SceneOpening";
    const string SS_SCENE_RESUME_TRIES = "MCPTestBridge_SceneResumeTries";
    const int MAX_SCENE_RESUME_TRIES = 3;

    static bool _sceneOpening
    {
        get => SessionState.GetBool(SS_SCENE_OPENING, false);
        set => SessionState.SetBool(SS_SCENE_OPENING, value);
    }

    [InitializeOnLoadMethod]
    static void RearmPendingSceneAfterReload()
    {
        if (Inert) return;
        if (EditorApplication.isPlayingOrWillChangePlaymode) return;
        if (string.IsNullOrEmpty(SessionState.GetString(SS_PENDING_SCENE, ""))) return;
        RunOnNextUpdate(ResumePendingScene);
    }

    static void ErasePendingScene()
    {
        SessionState.EraseString(SS_PENDING_SCENE);
        SessionState.EraseBool(SS_PENDING_PLAY);
    }

    static void ResumePendingScene()
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode) return;
        string pendingScene = SessionState.GetString(SS_PENDING_SCENE, "");
        if (string.IsNullOrEmpty(pendingScene)) return;
        int tries = SessionState.GetInt(SS_SCENE_RESUME_TRIES, 0) + 1;
        if (tries > MAX_SCENE_RESUME_TRIES)
        {
            Debug.LogWarning("[MCPTestBridge] scene open/play for '" + pendingScene
                + "' was interrupted " + MAX_SCENE_RESUME_TRIES + "x — giving up (not retrying again).");
            ErasePendingScene();
            SessionState.EraseInt(SS_SCENE_RESUME_TRIES);
            WriteSceneResult("error", pendingScene, false,
                "scene open/play was interrupted repeatedly — play entry is being blocked or cancelled "
                + "(competing stop command, refused play entry, or a blocking dialog)");
            _sceneOpening = false;
            return;
        }
        SessionState.SetInt(SS_SCENE_RESUME_TRIES, tries);
        var trigger = new SceneTriggerData
        {
            scenePath = pendingScene,
            enterPlayMode = SessionState.GetBool(SS_PENDING_PLAY, false)
        };
        ErasePendingScene();
        OpenSceneAndMaybePlay(trigger);
    }

    static void ClearSceneResult()
    {
        try { if (File.Exists(SceneResultsPath)) File.Delete(SceneResultsPath); }
        catch (Exception e) { Debug.LogWarning("[MCPTestBridge] could not clear stale scene result: " + e.Message); }
    }

    static void HandleOpenScene(SceneTriggerData trigger)
    {
        ClearSceneResult();
        SessionState.EraseInt(SS_SCENE_RESUME_TRIES);
        _sceneOpening = true;

        string fullPath = Path.Combine(ProjectRoot, trigger.scenePath);
        if (!File.Exists(fullPath))
        {
            WriteSceneResult("error", trigger.scenePath, false, $"Scene file not found: {trigger.scenePath}");
            _sceneOpening = false;
            return;
        }

        if (EditorApplication.isPlaying)
        {
            SessionState.SetString(SS_PENDING_SCENE, trigger.scenePath);
            SessionState.SetBool(SS_PENDING_PLAY, trigger.enterPlayMode);
            EditorApplication.isPlaying = false;
        }
        else
        {
            OpenSceneAndMaybePlay(trigger);
        }
    }

    static void OpenSceneAndMaybePlay(SceneTriggerData trigger)
    {
        _sceneOpening = true;

        if (trigger.enterPlayMode && EditorUtility.scriptCompilationFailed)
        {
            string cerr = RecompileError() ?? "script compilation failed";
            WriteSceneResult("error", trigger.scenePath, false,
                "cannot enter Play Mode — script compile errors block Play (the scene was NOT reloaded):\n" + cerr);
            _sceneOpening = false;
            return;
        }

        string dirty = DirtyOpenScenes();
        bool sceneLoaded = IsSceneLoaded(trigger.scenePath);
        bool cloneStale = sceneLoaded && CloneOpenSceneStale();
        bool preserveInMemory = trigger.enterPlayMode && sceneLoaded && !cloneStale;

        if (preserveInMemory)
        {
            if (!string.IsNullOrEmpty(dirty))
                Debug.Log("[MCPTestBridge] Entering Play Mode on the already-loaded scene '" + trigger.scenePath
                    + "' — keeping its unsaved in-memory changes (" + dirty + "); not reloading from disk.");
        }
        else
        {
            if (cloneStale)
                Debug.Log("[MCPTestBridge] clone scene '" + trigger.scenePath
                    + "' is stale vs disk — reloading before Play Mode.");
            else if (!string.IsNullOrEmpty(dirty))
                Debug.LogWarning("[MCPTestBridge] Opening '" + trigger.scenePath + "' reloads scenes from disk — "
                    + "unsaved in-memory changes will be DISCARDED in: " + dirty + ". Save first "
                    + "(exec EditorSceneManager.SaveOpenScenes()) to keep them.");
            string closing = OtherLoadedScenes(trigger.scenePath);
            //if (!string.IsNullOrEmpty(closing))
            //    Debug.LogWarning("[MCPTestBridge] Opening '" + trigger.scenePath + "' in single mode CLOSES the "
            //        + "other open scene(s): " + closing + ".");
            try
            {
                EditorSceneManager.OpenScene(trigger.scenePath);
                ClearCloneSceneStale();
            }
            catch (Exception e)
            {
                WriteSceneResult("error", trigger.scenePath, false, e.Message);
                _sceneOpening = false;
                return;
            }
        }

        if (trigger.enterPlayMode)
        {
            SessionState.SetString(SS_PENDING_SCENE, trigger.scenePath);
            SessionState.SetBool(SS_PENDING_PLAY, true);
            EditorApplication.isPlaying = true;
        }
        else
        {
            WriteSceneResult("completed", trigger.scenePath, false, "", preserveInMemory ? "" : dirty);
            _sceneOpening = false;
            Debug.Log($"[MCPTestBridge] Scene opened: {trigger.scenePath}");
        }
    }

    static void KeepUnsavedScenesOnQuit()
    {
        if (EditorApplication.isPlaying || EditorApplication.isPlayingOrWillChangePlaymode) return;
        var dirty = new System.Collections.Generic.List<UnityEngine.SceneManagement.Scene>();
        for (int i = 0; i < EditorSceneManager.sceneCount; i++)
        {
            var s = EditorSceneManager.GetSceneAt(i);
            if (s.IsValid() && s.isLoaded && s.isDirty) dirty.Add(s);
        }
        if (dirty.Count == 0) return;
        try { OnTunerAnimReload(); }
        catch (Exception e) { Debug.LogException(e); }
        const string dir = "Assets/_Recovery";
        try { Directory.CreateDirectory(dir); }
        catch (Exception e) { Debug.LogException(e); return; }
        foreach (var s in dirty)
        {
            var name = string.IsNullOrEmpty(s.name) ? "Untitled" : s.name;
            var path = AssetDatabase.GenerateUniqueAssetPath(dir + "/" + name + ".unity");
            try
            {
                bool ok = EditorSceneManager.SaveScene(s, path, true);
                Debug.Log("[MCPTestBridge] Unsaved changes in " + (string.IsNullOrEmpty(s.path) ? name : s.path) + (ok ? " kept in " + path : " could not be kept"));
            }
            catch (Exception e) { Debug.LogException(e); }
        }
    }

    static string DirtyOpenScenes()
    {
        var names = new System.Collections.Generic.List<string>();
        for (int i = 0; i < EditorSceneManager.sceneCount; i++)
        {
            var s = EditorSceneManager.GetSceneAt(i);
            if (s.isDirty)
                names.Add(string.IsNullOrEmpty(s.path) ? (string.IsNullOrEmpty(s.name) ? "<untitled>" : s.name) : s.path);
        }
        return string.Join(", ", names);
    }

    static string OtherLoadedScenes(string scenePath)
    {
        var names = new System.Collections.Generic.List<string>();
        for (int i = 0; i < EditorSceneManager.sceneCount; i++)
        {
            var s = EditorSceneManager.GetSceneAt(i);
            if (!s.isLoaded || s.path == scenePath) continue;
            names.Add(string.IsNullOrEmpty(s.path) ? (string.IsNullOrEmpty(s.name) ? "<untitled>" : s.name) : s.path);
        }
        return string.Join(", ", names);
    }

    static bool IsSceneLoaded(string scenePath)
    {
        if (string.IsNullOrEmpty(scenePath)) return false;
        for (int i = 0; i < EditorSceneManager.sceneCount; i++)
        {
            var s = EditorSceneManager.GetSceneAt(i);
            if (s.isLoaded && s.path == scenePath) return true;
        }
        return false;
    }

    static void WriteSceneResult(string status, string scenePath, bool isPlayMode, string error, string discardedScenes = "")
    {
        var result = new SceneResultData
        {
            status = status,
            scenePath = scenePath,
            isPlayMode = isPlayMode,
            error = error,
            hadUnsavedChanges = !string.IsNullOrEmpty(discardedScenes),
            discardedScenes = discardedScenes ?? "",
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };
        SspaceFolder.EnsureFor(SceneResultsPath);
        try { File.WriteAllText(SceneResultsPath, JsonUtility.ToJson(result, true)); }
        catch (Exception e) { Debug.LogWarning("[MCPTestBridge] scene result write failed: " + e.Message); }
        BroadcastOpDone("scene", status);
    }

    static void HandleStopPlay()
    {
        if (!EditorApplication.isPlaying)
        {
            WriteStopPlayResult("completed", "Already in Edit Mode.");
            return;
        }

        _stoppingPlay = true;

        SessionState.SetBool(SS_PENDING_STOP, true);
        EditorApplication.isPlaying = false;
    }

    static void WriteStopPlayResult(string status, string error)
    {
        var result = new StopPlayResultData
        {
            status = status,
            wasPlaying = string.IsNullOrEmpty(error) || !error.Contains("Already"),
            error = error,
            timestamp = DateTimeOffset.UtcNow.ToUnixTimeSeconds()
        };
        SspaceFolder.EnsureFor(StopPlayResultsPath);
        try { File.WriteAllText(StopPlayResultsPath, JsonUtility.ToJson(result, true)); }
        catch (Exception e) { Debug.LogWarning("[MCPTestBridge] stop-play result write failed: " + e.Message); }
        BroadcastOpDone("stopplay", status);
        _stoppingPlay = false;
    }
}
