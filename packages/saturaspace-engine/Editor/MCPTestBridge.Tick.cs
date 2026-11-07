using System;
using System.Diagnostics;
using System.Reflection;
using System.Threading;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    static Thread _tickPump;
    static volatile bool _tickPumpRunning;
    static long _lastMainThreadPumpMs;
    static Action _signalTick;

    const int TICK_PUMP_POLL_MS = 100;
    const int TICK_PUMP_IDLE_MS = 250;
    const int MAIN_THREAD_STUCK_MS = 5000;

    static readonly bool OrchestratorManaged =
        !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MC_UDP_PORT"))
        || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("SATURA_WINHOOK_REVEAL_FILE"));

    static long NowMs => Stopwatch.GetTimestamp() / (Stopwatch.Frequency / 1000);

    static void StampMainThreadPump()
    {
        Interlocked.Exchange(ref _lastMainThreadPumpMs, NowMs);
    }

    public static void RunOnNextUpdate(Action action)
    {
        EditorApplication.CallbackFunction once = null;
        once = () =>
        {
            EditorApplication.update -= once;
            action();
        };
        EditorApplication.update += once;
        SignalEditorTick();
    }

    static void SignalEditorTick()
    {
        var signal = _signalTick;
        if (signal == null) return;
        try { signal(); }
        catch { }
    }

    [InitializeOnLoadMethod]
    static void StartTickPump()
    {
        if (Inert) return;
        if (Application.isBatchMode) return;
        if (!OrchestratorManaged) return;
        var mi = typeof(EditorApplication).GetMethod("SignalTick",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        if (mi == null)
        {
            UnityEngine.Debug.LogWarning(
                "[MCPTestBridge] EditorApplication.SignalTick not found — commands may stall while the editor window is hidden or unfocused.");
            return;
        }
        _signalTick = (Action)Delegate.CreateDelegate(typeof(Action), mi);
        StampMainThreadPump();
        _tickPumpRunning = true;
        _tickPump = new Thread(TickPumpLoop) { IsBackground = true, Name = "MCPTestBridge.tickPump" };
        _tickPump.Start();
        AssemblyReloadEvents.beforeAssemblyReload += StopTickPump;
        EditorApplication.quitting += StopTickPump;
    }

    static void StopTickPump()
    {
        _tickPumpRunning = false;
        AssemblyReloadEvents.beforeAssemblyReload -= StopTickPump;
        EditorApplication.quitting -= StopTickPump;
        try { _tickPump?.Join(300); } catch { }
        _tickPump = null;
    }

    static void TickPumpLoop()
    {
        long reportedSince = 0;
        while (_tickPumpRunning)
        {
            Thread.Sleep(TICK_PUMP_POLL_MS);
            if (!_tickPumpRunning) break;
            reportedSince = WatchStuckCommand(reportedSince);
            if (NowMs - Interlocked.Read(ref _lastMainThreadPumpMs) < TICK_PUMP_IDLE_MS) continue;
            SignalEditorTick();
        }
    }

    static long WatchStuckCommand(long reportedSince)
    {
        long since = Interlocked.Read(ref _ctrlBusySinceMs);
        if (since == 0 || since == reportedSince || NowMs - since < MAIN_THREAD_STUCK_MS) return reportedSince;
        var line = _ctrlBusyLine ?? "";
        if (line.Length > 400) line = line.Substring(0, 400) + "...";
        try { UnityEngine.Debug.LogWarning("[MCPControl] the editor main thread has been stuck for " + ((NowMs - since) / 1000) + " s handling: " + line); }
        catch { }
        return since;
    }
}
