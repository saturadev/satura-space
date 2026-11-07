using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEngine;

public static class ClonePlayerTagShim
{
    const BindingFlags AnyMember = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;
    const string MppmEditorNs = "Unity.Multiplayer.PlayMode.Editor.";
    const string MppmEditorAsm = ", UnityEditor.MultiplayerModule";

    static bool _unlinkedWarned;

    static bool IsVirtualProjectClone =>
        Array.IndexOf(Environment.GetCommandLineArgs(), "--virtual-project-clone") >= 0;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    static void EarlySeed() => Seed();

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void LateSeed() => Seed();

    static void Seed()
    {
        if (!IsVirtualProjectClone) return;
        try { SeedPackageTags(); }
        catch { }
        try { SeedModulePlayer(); }
        catch { }
    }

    static void SeedPackageTags()
    {
        var type = FindType("Unity.Multiplayer.Playmode.CurrentPlayer, Unity.Multiplayer.Playmode");
        if (type == null) return;

        var tagsField = type.GetField("s_Tags", BindingFlags.NonPublic | BindingFlags.Static);
        var loadedField = type.GetField("s_Loaded", BindingFlags.NonPublic | BindingFlags.Static);
        if (tagsField == null || loadedField == null) return;

        if (tagsField.GetValue(null) == null) tagsField.SetValue(null, new List<string>());
        loadedField.SetValue(null, true);
    }

    static void SeedModulePlayer()
    {
        var current = Type.GetType("Unity.Multiplayer.PlayMode.CurrentPlayer, UnityEngine.MultiplayerModule", false);
        var apiType = Type.GetType("Unity.Multiplayer.PlayMode.CurrentPlayerApi, UnityEngine.MultiplayerModule", false);
        var apiField = current?.GetField("s_CurrentPlayerApi", AnyMember);
        if (apiType == null || apiField == null || apiField.GetValue(null) != null) return;
        if (CloneLinkedInRegistry() != false) return;

        apiField.SetValue(null, Activator.CreateInstance(apiType, true));
        if (_unlinkedWarned) return;
        _unlinkedWarned = true;
        Debug.LogWarning("[SaturaSpace] This clone has no MPPM player in Library/VP/SystemData.json, so MPPM CurrentPlayer reports a non-main editor with no tags.");
    }

    static bool? CloneLinkedInRegistry()
    {
        var migration = Type.GetType(MppmEditorNs + "MigrationUtility" + MppmEditorAsm, false);
        var storeType = Type.GetType(MppmEditorNs + "SystemDataStore" + MppmEditorAsm, false);
        var editorType = Type.GetType(MppmEditorNs + "VirtualProjectsEditor" + MppmEditorAsm, false);
        var playerType = Type.GetType(MppmEditorNs + "PlayerStateJson" + MppmEditorAsm, false);
        var infoType = Type.GetType(MppmEditorNs + "TypeDependentPlayerInfo" + MppmEditorAsm, false);
        if (migration == null || storeType == null || editorType == null || playerType == null || infoType == null)
            return null;
        if (!(bool)migration.GetMethod("ShouldEnableMultiplayerPlayMode", AnyMember).Invoke(null, null)) return null;

        var self = editorType.GetProperty("CloneIdentifier", AnyMember)?.GetValue(null);
        if (self == null) return null;
        var path = storeType.GetProperty("ClonePath", AnyMember)?.GetValue(null) as string;
        if (string.IsNullOrEmpty(path) || !File.Exists(path)) return false;

        var store = storeType.GetMethod("GetClone", AnyMember).Invoke(null, null);
        var players = storeType.GetMethod("LoadAllPlayerJson", AnyMember).Invoke(store, null) as IDictionary;
        if (players == null) return false;
        var infoProp = playerType.GetProperty("TypeDependentPlayerInfo", AnyMember);
        var idProp = infoType.GetProperty("VirtualProjectIdentifier", AnyMember);
        foreach (var player in players.Values)
        {
            var info = player == null ? null : infoProp.GetValue(player);
            if (info != null && Equals(idProp.GetValue(info), self)) return true;
        }
        return false;
    }

    static Type FindType(string assemblyQualifiedName)
    {
        var t = Type.GetType(assemblyQualifiedName, false);
        if (t != null) return t;

        int comma = assemblyQualifiedName.IndexOf(',');
        string shortName = comma >= 0 ? assemblyQualifiedName.Substring(0, comma).Trim() : assemblyQualifiedName;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                var found = asm.GetType(shortName, false);
                if (found != null) return found;
            }
            catch { }
        }
        return null;
    }
}
