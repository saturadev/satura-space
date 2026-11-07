using UnityEngine;
using UnityEngine.Rendering;
using UnityEditor;
using UnityEditor.SceneManagement;
using System;
using System.IO;

public static partial class MCPTestBridge
{
    public static void StartRawStream()
    {
        if (Inert) return;
        string scene = Environment.GetEnvironmentVariable("MC_STREAM_SCENE");
        if (string.IsNullOrEmpty(scene)) scene = "Assets/Scenes/Prototype.unity";

        bool headless = SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null;

        if (File.Exists(scene))
            EditorSceneManager.OpenScene(scene);
        else
            Debug.LogWarning($"[RawFrameStream] scene not found: {scene} (staying in Edit Mode on current scene)");

        Debug.Log(headless
            ? "[SaturaSpace] ✓ Ready to work — headless (simulation & input only, no live view)"
            : $"[SaturaSpace] ✓ Ready to work — {SystemInfo.graphicsDeviceType} · Edit Mode — press Play in the player to stream");
    }
}
