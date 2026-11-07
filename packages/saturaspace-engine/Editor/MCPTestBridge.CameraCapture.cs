using System;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using SaturaSpace;

public static partial class MCPTestBridge
{
    internal static void ResolveCaptureSize(out int w, out int h)
    {
        w = 1280;
        h = 720;
        if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null) return;
        try
        {
            PlayModeWindow.GetRenderingResolution(out uint uw, out uint uh);
            if (uw >= 16 && uh >= 16 && uw <= 8192 && uh <= 8192) { w = (int)uw; h = (int)uh; }
        }
        catch { }
    }

    internal const int MaxCapturePoses = 16;

    internal static string CaptureFromPose(Vector3 cameraPos, Vector3 lookAtPos, int width, int height, string path)
    {
        return CaptureFromPoses(new[] { cameraPos }, new[] { lookAtPos }, width, height, path);
    }

    internal static void GridLayout(int count, out int cols, out int rows)
    {
        cols = Mathf.Max(1, Mathf.CeilToInt(Mathf.Sqrt(count)));
        rows = Mathf.Max(1, (count + cols - 1) / cols);
    }

    internal static string CaptureFromPoses(Vector3[] positions, Vector3[] targets, int width, int height, string path, ShotScope[] scopes = null)
    {
        if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null)
            return "capture is not possible in headless-nographics mode: no GPU device exists, nothing is ever rendered.";
        int n = positions != null ? positions.Length : 0;
        if (n == 0 || targets == null || targets.Length != n)
            return "capture failed: expected one look-at target per camera position";
        if (n > MaxCapturePoses)
            return "capture failed: at most " + MaxCapturePoses + " camera poses per capture, got " + n;
        GridLayout(n, out int cols, out int rows);
        int gutter = n > 1 ? 1 : 0;
        if (width / cols < 16 + 2 * gutter || height / rows < 16 + 2 * gutter)
            return "capture failed: " + width + "x" + height + " is too small for a " + cols + "x" + rows + " grid";
        GameObject go = null;
        Camera cam = null;
        Texture2D canvas = null;
        var prevActive = RenderTexture.active;
        try
        {
            go = new GameObject("_SaturaCaptureCamera") { hideFlags = HideFlags.HideAndDontSave };
            cam = go.AddComponent<Camera>();
            cam.clearFlags = CameraClearFlags.Skybox;
            cam.cullingMask = -1;
            cam.fieldOfView = 60f;
            cam.nearClipPlane = 0.03f;
            cam.farClipPlane = 5000f;
            cam.enabled = false;
            canvas = new Texture2D(width, height, TextureFormat.RGBA32, false);
            if (n > 1)
            {
                var fill = new Color32[width * height];
                var bg = new Color32(0, 0, 0, 255);
                for (int i = 0; i < fill.Length; i++) fill[i] = bg;
                canvas.SetPixels32(fill);
            }
            for (int i = 0; i < n; i++)
            {
                int c = i % cols, r = i / cols;
                int x0 = c * width / cols + (c > 0 ? gutter : 0);
                int x1 = (c + 1) * width / cols - (c < cols - 1 ? gutter : 0);
                int y0 = r * height / rows + (r > 0 ? gutter : 0);
                int y1 = (r + 1) * height / rows - (r < rows - 1 ? gutter : 0);
                var restore = scopes != null && i < scopes.Length ? ShotHide(scopes[i]) : null;
                string err;
                try
                {
                    err = RenderPoseInto(cam, positions[i], targets[i], x1 - x0, y1 - y0, canvas, x0, height - y1);
                }
                finally
                {
                    restore?.Invoke();
                }
                if (err != null) return "capture failed" + (n > 1 ? " on point " + i : "") + ": " + err;
            }
            var dir = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
            SspaceFolder.EnsureFor(path);
            File.WriteAllBytes(path, canvas.EncodeToPNG());
            Debug.Log("[MCPTestBridge] Screenshot saved (" + width + "x" + height
                + (n > 1 ? ", " + cols + "x" + rows + " grid of " + n : "") + "): " + path);
            return null;
        }
        catch (Exception e)
        {
            return "capture failed: " + e.Message;
        }
        finally
        {
            RenderTexture.active = prevActive;
            if (cam != null) cam.targetTexture = null;
            if (canvas != null) UnityEngine.Object.DestroyImmediate(canvas);
            if (go != null) UnityEngine.Object.DestroyImmediate(go);
        }
    }

    static string RenderPoseInto(Camera cam, Vector3 cameraPos, Vector3 lookAtPos, int width, int height,
        Texture2D canvas, int destX, int destY)
    {
        RenderTexture rt = null;
        try
        {
            cam.transform.SetPositionAndRotation(cameraPos, Quaternion.identity);
            if ((lookAtPos - cameraPos).sqrMagnitude >= 1e-8f)
                cam.transform.LookAt(lookAtPos);
            rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
            if (!rt.Create()) return "could not create a " + width + "x" + height + " render target";
            cam.aspect = (float)width / height;
            bool rendered = false;
            if (GraphicsSettings.currentRenderPipeline != null)
            {
                var req = new RenderPipeline.StandardRequest { destination = rt };
                if (RenderPipeline.SupportsRenderRequest(cam, req))
                {
                    RenderPipeline.SubmitRenderRequest(cam, req);
                    rendered = true;
                }
            }
            if (!rendered)
            {
                cam.targetTexture = rt;
                cam.Render();
                cam.targetTexture = null;
            }
            RenderTexture.active = rt;
            canvas.ReadPixels(new Rect(0, 0, width, height), destX, destY);
            return null;
        }
        catch (Exception e)
        {
            return e.Message;
        }
        finally
        {
            if (rt != null)
            {
                if (RenderTexture.active == rt) RenderTexture.active = null;
                cam.targetTexture = null;
                rt.Release();
                UnityEngine.Object.DestroyImmediate(rt);
            }
        }
    }
}
