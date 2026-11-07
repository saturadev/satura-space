using System;
using System.IO;
using System.Security.Cryptography;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;

public static partial class MCPTestBridge
{
    const string ApiUpdaterGraphPath = "Library/APIUpdater/project-dependencies.graph";

    static void HandleRefresh()
    {
        SaturaDebug.Log("[MCPTestBridge] Refresh triggered. Calling AssetDatabase.Refresh()...");
        SanitizeApiUpdaterGraph();
        AssetDatabase.Refresh();
        if (EditorUtility.scriptCompilationFailed && !EditorApplication.isCompiling)
        {
            Debug.Log("[MCPTestBridge] previous compilation failed and refresh found nothing to compile — "
                + "forcing a full script compilation so the failed state is re-evaluated.");
            CompilationPipeline.RequestScriptCompilation();
        }
    }

    static void SanitizeApiUpdaterGraph()
    {
        try
        {
            if (!File.Exists(ApiUpdaterGraphPath)) return;
            var bytes = File.ReadAllBytes(ApiUpdaterGraphPath);
            if (!IsTornApiUpdaterGraph(bytes)) return;
            File.Delete(ApiUpdaterGraphPath);
            Debug.Log("[MCPTestBridge] Deleted torn " + ApiUpdaterGraphPath + " (payload hash mismatch from an interrupted save) — "
                + "Unity's APIUpdaterManager would NRE on it during the next dll import; the file is a cache and regenerates.");
        }
        catch (Exception e)
        {
            Debug.LogWarning("[MCPTestBridge] APIUpdater graph preflight failed: " + e.Message);
        }
    }

    static bool IsTornApiUpdaterGraph(byte[] bytes)
    {
        if (bytes.Length == 0) return true;
        if (bytes.Length < 14) return false;
        if (bytes[0] != 0x55 || bytes[1] != 0x41 || bytes[2] != 0x44 || bytes[3] != 0x47) return false;
        if (bytes[4] != 2) return false;
        long hashLen = BitConverter.ToInt64(bytes, 5);
        if (hashLen <= 0 || hashLen > 255) return true;
        long payloadStart = 13 + hashLen;
        if (bytes.Length <= payloadStart) return true;
        byte[] computed;
        using (var sha = SHA256.Create())
            computed = sha.ComputeHash(bytes, (int)payloadStart, bytes.Length - (int)payloadStart);
        if (computed.Length != hashLen) return true;
        for (int i = 0; i < hashLen; i++)
            if (bytes[13 + i] != computed[i]) return true;
        return false;
    }
}
