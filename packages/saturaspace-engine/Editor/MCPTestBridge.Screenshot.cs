using System;
using System.IO;
using UnityEditor;
using UnityEngine;
using SaturaSpace;

public static partial class MCPTestBridge
{
    delegate void ComposeGameViewFn(RenderTexture target, int targetDisplay, Vector2 mousePosition, bool clearTexture, bool renderIMGUI);
    static ComposeGameViewFn _composeGameView;
    static bool _composeGameViewResolved;

    static bool TryComposeGameView(RenderTexture rt)
    {
        if (!_composeGameViewResolved)
        {
            _composeGameViewResolved = true;
            var m = typeof(EditorGUIUtility).GetMethod("RenderPlayModeViewCamerasInternal",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            if (m != null)
            {
                try { _composeGameView = (ComposeGameViewFn)Delegate.CreateDelegate(typeof(ComposeGameViewFn), m); }
                catch { _composeGameView = null; }
            }
        }
        if (_composeGameView == null) return false;
        try { _composeGameView(rt, 0, Vector2.zero, true, true); return true; }
        catch { return false; }
    }

    static void HandleScreenshotCommand(UnityCommandDto cmd, string path, float[] cameraPos, float[] lookAt, float[] poses, CmdArgs a)
    {
        if (SystemInfo.graphicsDeviceType == UnityEngine.Rendering.GraphicsDeviceType.Null)
        {
            AckError(cmd, "screenshot is not possible in headless-nographics mode: this editor runs with -nographics, "
                + "so no GPU device exists and nothing is ever rendered — neither the game frame nor a camera "
                + "render from points. Switch the project's Unity mode to 'Headless Graphics' (or Normal) and relaunch to "
                + "capture screenshots.");
            return;
        }
        if (poses != null)
        {
            if (poses.Length == 0 || poses.Length % 6 != 0)
            {
                AckError(cmd, "screenshot poses must be a flat list of 6 numbers per point "
                    + "(camera x, y, z, look-at x, y, z), got " + poses.Length);
                return;
            }
            int n = poses.Length / 6;
            var positions = new Vector3[n];
            var targets = new Vector3[n];
            for (int i = 0; i < n; i++)
            {
                int o = i * 6;
                positions[i] = new Vector3(poses[o], poses[o + 1], poses[o + 2]);
                targets[i] = new Vector3(poses[o + 3], poses[o + 4], poses[o + 5]);
            }
            string planErr = ShotPlan(a, positions, targets, out var scopes);
            if (planErr != null)
            {
                AckError(cmd, planErr);
                return;
            }
            ResolveCaptureSize(out int gw, out int gh);
            string gridErr = CaptureFromPoses(positions, targets, gw, gh, path, scopes);
            if (gridErr == null) AckAppliedAfterEffect(cmd);
            else AckError(cmd, gridErr);
            return;
        }
        if (cameraPos != null && cameraPos.Length == 3 && lookAt != null && lookAt.Length == 3)
        {
            ResolveCaptureSize(out int w, out int h);
            string poseErr = CaptureFromPose(
                new Vector3(cameraPos[0], cameraPos[1], cameraPos[2]),
                new Vector3(lookAt[0], lookAt[1], lookAt[2]),
                w, h, path);
            if (poseErr == null) AckAppliedAfterEffect(cmd);
            else AckError(cmd, poseErr);
            return;
        }
        if (!EditorApplication.isPlaying)
        {
            AckError(cmd, "screenshot of the game frame requires Play Mode: it captures the streamed frame, which "
                + "only exists while the game is playing. Either enter play mode first "
                + "(unity.play()) and retry, or pass camera points "
                + "to render the scene from a virtual camera — that works in Edit Mode.");
            return;
        }
        var stream = LocalStreamServer.Instance;
        var frame = stream != null ? stream.CurrentFrame : null;
        string err = frame != null
            ? WriteRenderTexturePng(frame, path, SystemInfo.graphicsUVStartsAtTop)
            : CaptureComposed(path);
        if (err == null) AckAppliedAfterEffect(cmd);
        else AckError(cmd, err);
    }

    static string CaptureComposed(string path)
    {
        ResolveCaptureSize(out int w, out int h);
        RenderTexture rt = null;
        try
        {
            rt = new RenderTexture(w, h, 24, RenderTextureFormat.ARGB32);
            if (!rt.Create()) return "screenshot failed: could not create a " + w + "x" + h + " render target";
            if (!TryComposeGameView(rt))
                return "screenshot failed: no stream is active and the game-view compose is unavailable";
            return WriteRenderTexturePng(rt, path, SystemInfo.graphicsUVStartsAtTop);
        }
        catch (Exception e)
        {
            return "screenshot failed: " + e.Message;
        }
        finally
        {
            if (rt != null)
            {
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);
            }
        }
    }

    static string WriteRenderTexturePng(RenderTexture rt, string path, bool flipRows)
    {
        Texture2D tex = null;
        var prevActive = RenderTexture.active;
        try
        {
            RenderTexture.active = rt;
            tex = new Texture2D(rt.width, rt.height, TextureFormat.RGBA32, false);
            tex.ReadPixels(new Rect(0, 0, rt.width, rt.height), 0, 0);
            if (flipRows) FlipRows(tex);
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            SspaceFolder.EnsureFor(path);
            File.WriteAllBytes(path, tex.EncodeToPNG());
            Debug.Log("[MCPTestBridge] Screenshot saved (" + rt.width + "x" + rt.height + "): " + path);
            return null;
        }
        catch (Exception e)
        {
            return "screenshot failed: " + e.Message;
        }
        finally
        {
            RenderTexture.active = prevActive;
            if (tex != null) UnityEngine.Object.DestroyImmediate(tex);
        }
    }

    static void FlipRows(Texture2D tex)
    {
        var pixels = tex.GetPixels32();
        int w = tex.width, h = tex.height;
        var flipped = new Color32[pixels.Length];
        for (int y = 0; y < h; y++)
            Array.Copy(pixels, y * w, flipped, (h - 1 - y) * w, w);
        tex.SetPixels32(flipped);
    }
}
