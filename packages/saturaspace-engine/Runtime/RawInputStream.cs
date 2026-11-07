#if UNITY_EDITOR
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using UnityEditor;
using UnityEngine;
using UnityEngine.LowLevel;
using Debug = UnityEngine.Debug;
#if ENABLE_INPUT_SYSTEM && (UNITY_EDITOR_OSX || UNITY_EDITOR_WIN)
using UnityEngine.InputSystem.LowLevel;
#endif

[DefaultExecutionOrder(int.MinValue)]
public class RawInputStream : MonoBehaviour
{
    public static RawInputStream Instance;

    int rtW = 960, rtH = 540;
    StreamInput input;
    readonly ConcurrentQueue<KeyValuePair<string, long>> inbound = new ConcurrentQueue<KeyValuePair<string, long>>();
    const int MaxInbound = 4096;

    static bool Enabled =>
        int.TryParse(Environment.GetEnvironmentVariable("MC_UDP_PORT"), out int p) && p > 0;

#if ENABLE_INPUT_SYSTEM
    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void PurgeStaleDevices()
    {
        if (!Enabled) return;
        StreamInput.PurgeTagged();
    }
#endif

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Boot()
    {
        if (!Enabled) return;
        var go = new GameObject("RawInputStream");
        SaturaEngineObjects.Mark(go);
        DontDestroyOnLoad(go);
        go.AddComponent<RawInputStream>().Begin();
    }

    static bool RevealedNow()
    {
        try
        {
            var file = Environment.GetEnvironmentVariable("SATURA_WINHOOK_REVEAL_FILE");
            if (string.IsNullOrEmpty(file) || !System.IO.File.Exists(file)) return false;
            var text = System.IO.File.ReadAllText(file);
            int i = text.IndexOf("\"want\"", StringComparison.Ordinal);
            if (i < 0) return false;
            i += 6;
            while (i < text.Length && (text[i] == ' ' || text[i] == ':')) i++;
            return i < text.Length && text[i] == '1';
        }
        catch
        {
            return false;
        }
    }

    void Begin()
    {
        Instance = this;
        Application.runInBackground = true;
        suspendInput = RevealedNow();
        EnsureInput();
        InstallEarlyLoop();
        EditorApplication.update += OnEditorUpdate;
    }

    struct StreamInputEarly { }

    static void InstallEarlyLoop()
    {
        var loop = PlayerLoop.GetCurrentPlayerLoop();
        if (loop.subSystemList == null) return;
        var roots = new List<PlayerLoopSystem>(loop.subSystemList);
        RemoveEarlyLoop(roots);
        var early = new PlayerLoopSystem { type = typeof(StreamInputEarly), updateDelegate = EarlyTick };
        int idx = roots.FindIndex(s => s.type == typeof(UnityEngine.PlayerLoop.EarlyUpdate));
        if (idx >= 0)
        {
            var sys = roots[idx];
            var children = sys.subSystemList != null ? new List<PlayerLoopSystem>(sys.subSystemList) : new List<PlayerLoopSystem>();
            children.Insert(0, early);
            sys.subSystemList = children.ToArray();
            roots[idx] = sys;
        }
        else
        {
            roots.Insert(0, early);
        }
        loop.subSystemList = roots.ToArray();
        PlayerLoop.SetPlayerLoop(loop);
    }

    static void UninstallEarlyLoop()
    {
        var loop = PlayerLoop.GetCurrentPlayerLoop();
        if (loop.subSystemList == null) return;
        var roots = new List<PlayerLoopSystem>(loop.subSystemList);
        if (!RemoveEarlyLoop(roots)) return;
        loop.subSystemList = roots.ToArray();
        PlayerLoop.SetPlayerLoop(loop);
    }

    static bool RemoveEarlyLoop(List<PlayerLoopSystem> roots)
    {
        bool removed = roots.RemoveAll(s => s.type == typeof(StreamInputEarly)) > 0;
        for (int i = 0; i < roots.Count; i++)
        {
            var sys = roots[i];
            if (sys.subSystemList == null) continue;
            var children = new List<PlayerLoopSystem>(sys.subSystemList);
            if (children.RemoveAll(s => s.type == typeof(StreamInputEarly)) == 0) continue;
            sys.subSystemList = children.ToArray();
            roots[i] = sys;
            removed = true;
        }
        return removed;
    }

    static void EarlyTick()
    {
        var self = Instance;
        if (self != null) self.Tick();
    }

    void OnEditorUpdate()
    {
        if (EditorApplication.isPaused) Tick();
    }

#if ENABLE_INPUT_SYSTEM && (UNITY_EDITOR_OSX || UNITY_EDITOR_WIN)
    int healIn;
    bool wasActive = true;
#endif

    bool suspendInput;

    public void SetInputSuspended(bool value)
    {
        suspendInput = value;
        input?.SetSuspended(value);
    }

    void EnsureInput()
    {
        var res = Environment.GetEnvironmentVariable("MC_UDP_RES");
        if (!string.IsNullOrEmpty(res))
        {
            var s = res.Split('x');
            if (s.Length == 2) { int.TryParse(s[0], out rtW); int.TryParse(s[1], out rtH); }
        }
        input = new StreamInput(rtW, rtH, suspendInput);
    }

    public string DescribeInput() => input?.Describe() ?? "no stream input";

    public void Enqueue(string json)
    {
        if (string.IsNullOrWhiteSpace(json)) return;
        if (inbound.Count >= MaxInbound) inbound.TryDequeue(out _);
        inbound.Enqueue(new KeyValuePair<string, long>(json, Stopwatch.GetTimestamp()));
    }

    void Tick()
    {
        if (input == null)
        {
            if (Instance == null) Instance = this;
            EnsureInput();
        }
        long now = Stopwatch.GetTimestamp();
        while (inbound.TryDequeue(out var item))
        {
            input.Apply(item.Key, Math.Max(0, now - item.Value) / (double)Stopwatch.Frequency);
        }
        input.SyncFocus();
        if (suspendInput) input.EnsureNativeCurrent();
#if ENABLE_INPUT_SYSTEM && (UNITY_EDITOR_OSX || UNITY_EDITOR_WIN)
        bool active = UnityEditorInternal.InternalEditorUtility.isApplicationActive;
        if (active && !wasActive) healIn = 3;
        wasActive = active;
        if (healIn > 0 && --healIn == 0 && Application.isFocused && !suspendInput)
        {
            var held = new KeyboardState();
            if (NativeHeldKeys.TryCapture(ref held)) input.InjectNative(held);
        }
#endif
    }

    void OnDestroy()
    {
        EditorApplication.update -= OnEditorUpdate;
        UninstallEarlyLoop();
        input?.Dispose();
        input = null;
        if (Instance == this) Instance = null;
    }
}
#endif
