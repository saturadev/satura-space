using System;
using System.Collections.Generic;
using System.Diagnostics;
using UnityEngine;
using UnityEngine.LowLevel;
using Debug = UnityEngine.Debug;

public static class SaturaGameClock
{
    public enum Mode { Free, Follow, Exact }

    struct Owner
    {
        public int fps;
        public bool exact;
    }

    struct ClockLoop { }

    static readonly Dictionary<string, Owner> owners = new Dictionary<string, Owner>();
    static bool locked;
    static float savedCaptureDeltaTime;
    static bool loopInstalled;
    static bool reloadHooked;
    static readonly Stopwatch pace = new Stopwatch();
    static double realAt;
    static double realDt;
    static int lastTickFrame = -1;

    public static Mode Current { get; private set; }
    public static int Fps { get; private set; }
    public static float Step { get; private set; }
    public static double Clock { get; private set; }
    public static int Frames { get; private set; }
    public static bool Locked => locked;

    public static event Action FrameEnd;

    public static string Describe()
    {
        if (owners.Count == 0) return "free";
        var parts = new List<string>();
        foreach (var kv in owners) parts.Add(kv.Key + "@" + kv.Value.fps + (kv.Value.exact ? " exact" : " follow"));
        return string.Join(", ", parts);
    }

    public static void Lock(string owner, int fps, bool exact)
    {
        fps = Mathf.Clamp(fps, 1, 240);
        if (owners.TryGetValue(owner, out var had) && had.fps == fps && had.exact == exact) return;
        owners[owner] = new Owner { fps = fps, exact = exact };
        HookReload();
        InstallLoop();
        Apply("locked by " + owner);
    }

    public static void Unlock(string owner, string why)
    {
        if (!owners.Remove(owner)) return;
        Apply(owner + " let go: " + why);
    }

    public static void UnlockAll(string why)
    {
        if (owners.Count == 0 && !locked) return;
        owners.Clear();
        Apply(why);
    }

    static void Apply(string why)
    {
        if (owners.Count == 0)
        {
            if (locked)
            {
                locked = false;
                Time.captureDeltaTime = savedCaptureDeltaTime;
                SaturaDebug.Log($"[SaturaGameClock] free again ({why}): {Frames} frames, {Clock:F3} s of game time while locked");
            }
            Current = Mode.Free;
            Fps = 0;
            Step = 0f;
            UninstallLoop();
            return;
        }
        int fps = 0;
        bool exact = false;
        foreach (var o in owners.Values)
        {
            fps = Math.Max(fps, o.fps);
            exact |= o.exact;
        }
        if (!locked)
        {
            locked = true;
            savedCaptureDeltaTime = Time.captureDeltaTime;
            Clock = 0;
            Frames = 0;
            realDt = 0;
            pace.Restart();
            realAt = 0;
        }
        Current = exact ? Mode.Exact : Mode.Follow;
        Fps = fps;
        Step = 1f / fps;
        Time.captureDeltaTime = Step;
        SaturaDebug.Log($"[SaturaGameClock] {Current} at {fps} fps ({why}); owners: {Describe()}");
    }

    static void Tick()
    {
        if (!locked || !Application.isPlaying) return;
        if (Time.frameCount == lastTickFrame) return;
        lastTickFrame = Time.frameCount;
        Clock += Time.captureDeltaTime > 0f ? Time.captureDeltaTime : Time.unscaledDeltaTime;
        Frames++;
        try { FrameEnd?.Invoke(); }
        catch (Exception e) { Debug.LogWarning("[SaturaGameClock] frame callback failed: " + e.Message); }
        double now = pace.Elapsed.TotalSeconds;
        double dt = now - realAt;
        if (Current == Mode.Exact)
        {
            double wait = Step - dt;
            if (wait > 0.0005) System.Threading.Thread.Sleep((int)Math.Ceiling(wait * 1000.0));
            now = pace.Elapsed.TotalSeconds;
            dt = now - realAt;
        }
        realAt = now;
        if (dt > 0 && dt < 1) realDt = realDt > 0 ? realDt * 0.9 + dt * 0.1 : dt;
        float step = Current == Mode.Exact
            ? 1f / Fps
            : (realDt > 0 ? Mathf.Clamp((float)realDt, 0.001f, 1f / Fps) : 1f / Fps);
        Step = step;
        if (Time.captureDeltaTime != step) Time.captureDeltaTime = step;
    }

    static void HookReload()
    {
#if UNITY_EDITOR
        if (reloadHooked) return;
        reloadHooked = true;
        UnityEditor.AssemblyReloadEvents.beforeAssemblyReload += () => UnlockAll("scripts reloading");
        UnityEditor.EditorApplication.playModeStateChanged += (s) =>
        {
            if (s == UnityEditor.PlayModeStateChange.ExitingPlayMode) UnlockAll("play mode ended");
        };
#endif
    }

    static void InstallLoop()
    {
        if (loopInstalled) return;
        var loop = PlayerLoop.GetCurrentPlayerLoop();
        if (loop.subSystemList == null) return;
        for (int i = 0; i < loop.subSystemList.Length; i++)
        {
            var sys = loop.subSystemList[i];
            if (sys.type != typeof(UnityEngine.PlayerLoop.PostLateUpdate)) continue;
            var children = new List<PlayerLoopSystem>(sys.subSystemList ?? new PlayerLoopSystem[0]);
            children.RemoveAll(c => c.type == typeof(ClockLoop));
            children.Insert(0, new PlayerLoopSystem { type = typeof(ClockLoop), updateDelegate = Tick });
            sys.subSystemList = children.ToArray();
            loop.subSystemList[i] = sys;
            PlayerLoop.SetPlayerLoop(loop);
            loopInstalled = true;
            return;
        }
    }

    static void UninstallLoop()
    {
        if (!loopInstalled) return;
        loopInstalled = false;
        var loop = PlayerLoop.GetCurrentPlayerLoop();
        if (loop.subSystemList == null) return;
        for (int i = 0; i < loop.subSystemList.Length; i++)
        {
            var sys = loop.subSystemList[i];
            if (sys.subSystemList == null) continue;
            var children = new List<PlayerLoopSystem>(sys.subSystemList);
            if (children.RemoveAll(c => c.type == typeof(ClockLoop)) == 0) continue;
            sys.subSystemList = children.ToArray();
            loop.subSystemList[i] = sys;
        }
        PlayerLoop.SetPlayerLoop(loop);
    }
}
