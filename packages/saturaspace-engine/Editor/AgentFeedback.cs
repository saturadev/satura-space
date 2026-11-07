using System;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace SaturaSpace
{
    public static class AgentFeedback
    {
        const int MaxKept = 8;

        [Serializable]
        class ManifestDto
        {
            public int schema = 1;
            public long seq;
            public string file = "";
            public long timestamp;
        }

        public static string UserFeedback(Vector3 cameraPos, Vector3 lookAtPos)
        {
            if (EditorApplication.isPlaying)
                return "[feedback] skipped: feedback overlay is edit-mode only (the live stream already shows play mode).";
            if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null)
                return "[feedback] skipped: no GPU device (-nographics), nothing can be rendered.";
            var seq = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var dir = Path.Combine(MCPTestBridge.SspaceRootDir, "feedback");
            var rel = "feedback/fb-" + seq + ".png";
            var path = Path.Combine(dir, "fb-" + seq + ".png");
            MCPTestBridge.ResolveCaptureSize(out int w, out int h);
            var err = MCPTestBridge.CaptureFromPose(cameraPos, lookAtPos, w, h, path);
            if (err != null) return "[feedback] " + err;
            Prune(dir, path);
            WriteManifest(seq, rel);
            return "[feedback] captured " + w + "x" + h + " edit-mode render -> .sspace/" + rel
                + " (shown as an overlay in the Satura Space panel).";
        }

        static void Prune(string dir, string keepPath)
        {
            try
            {
                var files = Directory.GetFiles(dir, "fb-*.png")
                    .OrderByDescending(f => f, StringComparer.Ordinal)
                    .ToArray();
                foreach (var f in files.Skip(MaxKept))
                {
                    if (Path.GetFullPath(f) == Path.GetFullPath(keepPath)) continue;
                    try { File.Delete(f); } catch { }
                }
            }
            catch { }
        }

        static void WriteManifest(long seq, string rel)
        {
            var manifest = new ManifestDto
            {
                seq = seq,
                file = rel,
                timestamp = seq
            };
            var target = Path.Combine(MCPTestBridge.SspaceRootDir, "feedback.json");
            var tmp = target + ".tmp";
            try
            {
                SspaceFolder.EnsureFor(target);
                File.WriteAllText(tmp, JsonUtility.ToJson(manifest));
                if (File.Exists(target)) File.Delete(target);
                File.Move(tmp, target);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[AgentFeedback] manifest write failed: " + e.Message);
            }
        }
    }
}
