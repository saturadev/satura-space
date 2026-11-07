using System;
using System.Collections.Generic;
using System.Diagnostics;
using UnityEditor;
using Debug = UnityEngine.Debug;

internal static class SaturaPrefGuard
{
    sealed class Pref
    {
        public string Key;
        public bool IsBool;
        public int Value;
    }

    static readonly Pref[] Prefs =
    {
        new Pref { Key = "EnterSafeModeDialog", IsBool = true, Value = 0 },
        new Pref { Key = "ScriptCompilationDuringPlay", IsBool = false, Value = 1 },
    };

    const string Prefix = "SaturaSpace.PrefGuard.";
    const string Absent = "none";

    static bool _held;

    internal static bool Managed => MCPTestBridge.IsOrchestratorManaged;

    internal static void Init()
    {
        foreach (var p in Prefs)
        {
            try { RecoverIfOrphaned(p); }
            catch (Exception e) { Debug.LogWarning($"[PrefGuard] couldn't check {p.Key}: {e.Message}"); }
        }
        if (!Managed) return;
        _held = true;
        foreach (var p in Prefs)
        {
            try { Acquire(p); }
            catch (Exception e) { Debug.LogWarning($"[PrefGuard] couldn't set {p.Key}: {e.Message}"); }
        }
        EditorApplication.quitting -= Release;
        EditorApplication.quitting += Release;
    }

    internal static void Release()
    {
        if (!_held) return;
        _held = false;
        foreach (var p in Prefs)
        {
            try { ReleaseOne(p); }
            catch (Exception e) { Debug.LogWarning($"[PrefGuard] couldn't restore {p.Key}: {e.Message}"); }
        }
    }

    static string OrigKey(Pref p) => Prefix + p.Key + ".orig";
    static string HoldersKey(Pref p) => Prefix + p.Key + ".holders";

    static void Acquire(Pref p)
    {
        int self = Process.GetCurrentProcess().Id;
        var holders = LiveHolders(p);
        if (!EditorPrefs.HasKey(OrigKey(p)))
        {
            var orig = Read(p);
            EditorPrefs.SetString(OrigKey(p), orig);
            Debug.Log($"[PrefGuard] {p.Key}: saved {orig}");
        }
        if (!holders.Contains(self)) holders.Add(self);
        WriteHolders(p, holders);
        if (Read(p) != Encode(p.Value))
        {
            Write(p, Encode(p.Value));
            Debug.Log($"[PrefGuard] {p.Key} set to {Encode(p.Value)} while Satura Space runs this editor, restored on quit");
        }
    }

    static void ReleaseOne(Pref p)
    {
        int self = Process.GetCurrentProcess().Id;
        var holders = LiveHolders(p);
        holders.Remove(self);
        WriteHolders(p, holders);
        if (holders.Count == 0) Restore(p, "on quit");
    }

    static void RecoverIfOrphaned(Pref p)
    {
        if (!EditorPrefs.HasKey(OrigKey(p))) return;
        var holders = LiveHolders(p);
        if (holders.Count > 0) return;
        WriteHolders(p, holders);
        Restore(p, "left behind by an editor that didn't quit cleanly");
    }

    static void Restore(Pref p, string why)
    {
        var orig = EditorPrefs.GetString(OrigKey(p), Absent);
        EditorPrefs.DeleteKey(OrigKey(p));
        EditorPrefs.DeleteKey(HoldersKey(p));
        var cur = Read(p);
        if (cur != Encode(p.Value) || cur == orig) return;
        Write(p, orig);
        Debug.Log($"[PrefGuard] {p.Key} restored to {orig} ({why})");
    }

    static List<int> LiveHolders(Pref p)
    {
        var list = new List<int>();
        var raw = EditorPrefs.GetString(HoldersKey(p), "");
        foreach (var part in raw.Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
            if (int.TryParse(part, out var pid) && !list.Contains(pid) && Alive(pid)) list.Add(pid);
        return list;
    }

    static void WriteHolders(Pref p, List<int> holders)
    {
        if (holders.Count == 0) EditorPrefs.DeleteKey(HoldersKey(p));
        else EditorPrefs.SetString(HoldersKey(p), string.Join(",", holders));
    }

    static bool Alive(int pid)
    {
        if (pid == Process.GetCurrentProcess().Id) return true;
        try
        {
            using (var proc = Process.GetProcessById(pid))
                return !proc.HasExited && proc.ProcessName.IndexOf("Unity", StringComparison.OrdinalIgnoreCase) >= 0;
        }
        catch { return false; }
    }

    static string Encode(int v) => v.ToString();

    static string Read(Pref p)
    {
        if (!EditorPrefs.HasKey(p.Key)) return Absent;
        return p.IsBool ? (EditorPrefs.GetBool(p.Key) ? "1" : "0") : EditorPrefs.GetInt(p.Key).ToString();
    }

    static void Write(Pref p, string v)
    {
        if (v == Absent) { EditorPrefs.DeleteKey(p.Key); return; }
        int.TryParse(v, out var n);
        if (p.IsBool) EditorPrefs.SetBool(p.Key, n != 0);
        else EditorPrefs.SetInt(p.Key, n);
    }
}
