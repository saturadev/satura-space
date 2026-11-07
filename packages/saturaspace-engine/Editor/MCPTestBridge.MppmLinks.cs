using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEngine;

public static partial class MCPTestBridge
{
    static string MppmLinksPath => Path.Combine(SspaceRoot, ".mppm_clone_links.json");
    static DateTime _mppmLinksStamp;

    const BindingFlags MppmAny = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static | BindingFlags.Instance;

    [Serializable]
    class MppmCloneLink
    {
        public int index;
        public string vpId;
    }

    [Serializable]
    class MppmCloneLinksData
    {
        public MppmCloneLink[] links;
    }

    enum MppmLinkOutcome { Done, Retry }

    static void PumpMppmCloneLinks()
    {
        if (IsVirtualProjectClone) return;
        DateTime stamp;
        try
        {
            if (!File.Exists(MppmLinksPath)) return;
            stamp = File.GetLastWriteTimeUtc(MppmLinksPath);
        }
        catch { return; }
        if (stamp == _mppmLinksStamp) return;

        MppmCloneLinksData data = null;
        try { data = JsonUtility.FromJson<MppmCloneLinksData>(File.ReadAllText(MppmLinksPath)); }
        catch (Exception e) { Debug.LogWarning("[MCPTestBridge] MPPM clone link request unreadable: " + e.Message); }
        if (data == null || data.links == null || data.links.Length == 0)
        {
            _mppmLinksStamp = stamp;
            return;
        }

        try
        {
            if (ApplyMppmCloneLinks(data.links) == MppmLinkOutcome.Retry) return;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[MCPTestBridge] MPPM clone link failed: " + inner.Message);
        }
        _mppmLinksStamp = stamp;
    }

    static Type MppmEditorType(string name) =>
        Type.GetType("Unity.Multiplayer.PlayMode.Editor." + name + ", UnityEditor.MultiplayerModule", false);

    static MppmLinkOutcome ApplyMppmCloneLinks(MppmCloneLink[] links)
    {
        var migration = MppmEditorType("MigrationUtility");
        var storeType = MppmEditorType("SystemDataStore");
        var playerType = MppmEditorType("PlayerStateJson");
        var infoType = MppmEditorType("TypeDependentPlayerInfo");
        var idType = MppmEditorType("VirtualProjectIdentifier");
        if (migration == null || storeType == null || playerType == null || infoType == null || idType == null)
            return MppmLinkOutcome.Done;
        if (!(bool)migration.GetMethod("ShouldEnableMultiplayerPlayMode", MppmAny).Invoke(null, null))
            return MppmLinkOutcome.Done;
        if (storeType.GetField("s_FileSystemDelegates", MppmAny)?.GetValue(null) == null)
            return MppmLinkOutcome.Retry;

        var store = storeType.GetMethod("GetMain", MppmAny).Invoke(null, null);
        var all = storeType.GetMethod("LoadAllPlayerJson", MppmAny).Invoke(store, null) as IDictionary;
        if (all == null) return MppmLinkOutcome.Retry;
        var save = storeType.GetMethod("SavePlayerJson", MppmAny);
        var tryParse = idType.GetMethod("TryParse", MppmAny);
        var newClone = infoType.GetMethod("NewClone", MppmAny);
        var newEmpty = infoType.GetMethod("NewEmpty", MppmAny);
        var infoProp = playerType.GetProperty("TypeDependentPlayerInfo", MppmAny);
        var idProp = infoType.GetProperty("VirtualProjectIdentifier", MppmAny);
        var activeProp = playerType.GetProperty("Active", MppmAny);
        var nameProp = playerType.GetProperty("Name", MppmAny);

        object LinkedId(object player)
        {
            var info = infoProp.GetValue(player);
            return info == null ? null : idProp.GetValue(info);
        }

        void Save(int index, object player) => save.Invoke(store, new[] { (object)index, player });

        foreach (var link in links)
        {
            if (link == null || string.IsNullOrEmpty(link.vpId)) continue;
            if (!Directory.Exists(Path.Combine(ProjectRoot, "Library", "VP", link.vpId))) continue;
            var parseArgs = new object[] { link.vpId, null };
            if (!(bool)tryParse.Invoke(null, parseArgs) || parseArgs[1] == null) continue;
            var id = parseArgs[1];

            if (!all.Contains(link.index) || link.index < 2)
            {
                Debug.LogWarning($"[MCPTestBridge] MPPM has no player slot {link.index} for clone {link.vpId}; it runs without MPPM tags.");
                continue;
            }

            var stale = new List<KeyValuePair<int, object>>();
            foreach (DictionaryEntry e in all)
            {
                if ((int)e.Key != link.index && Equals(LinkedId(e.Value), id))
                    stale.Add(new KeyValuePair<int, object>((int)e.Key, e.Value));
            }
            foreach (var s in stale)
            {
                infoProp.SetValue(s.Value, newEmpty.Invoke(null, null));
                activeProp.SetValue(s.Value, false);
                Save(s.Key, s.Value);
            }

            var target = all[link.index];
            var current = LinkedId(target);
            bool active = (bool)activeProp.GetValue(target);
            if (Equals(current, id) && !active) continue;
            if (active && current != null && !Equals(current, id)
                && Directory.Exists(Path.Combine(ProjectRoot, "Library", "VP", current.ToString())))
            {
                Debug.LogWarning($"[MCPTestBridge] MPPM {nameProp.GetValue(target)} is active on {current}; clone {link.vpId} runs without MPPM tags.");
                continue;
            }

            infoProp.SetValue(target, newClone.Invoke(null, new[] { id }));
            activeProp.SetValue(target, false);
            Save(link.index, target);
            Debug.Log($"[MCPTestBridge] MPPM {nameProp.GetValue(target)} linked to clone {link.vpId}.");
        }
        return MppmLinkOutcome.Done;
    }
}
