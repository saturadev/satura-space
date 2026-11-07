using System;
using System.Runtime.InteropServices;
using System.Threading;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const string OBJC = "/usr/lib/libobjc.A.dylib";
    const string TUNER_TICK_SELECTOR = "configureEditorUpdatesTickTimerWithUpdatesPerSecond:";
    const int TUNER_TICK_UPS = 60;
    const int TUNER_TICK_IDLE_UPS = 15;
    const double TUNER_TICK_HOLD = 1.0;
    const double TUNER_TICK_VERIFY_S = 1.0;
    const double TUNER_TICK_SAME_S = 1e-6;
    const double TUNER_WAKE_MIN_MS = 1000.0 / TUNER_TICK_UPS;

    static bool _editorRevealed;
    static double _tunerActiveAt = -1;
    static double _tunerTickBase = -1;
    static double _tunerTickApplied = -1;
    static int _tunerTickWant = -1;
    static int _tunerTickChecked = -1;
    static bool _tunerTickPlaying;
    static double _tunerTickVerifyAt;
    static bool _tunerTickMovedLogged;
    static bool _tunerTickBroken;
    static IntPtr _tunerTickDel;
    static IntPtr _tunerTickSel;
    static IntPtr _tunerTickTimerIvar;
    static IntPtr _tunerTickIntervalSel;
    static IntPtr _tunerWakeTimer;
    static int _tunerMinUpdateOffset = -1;
    static volatile bool _tunerWakePatched;
    static readonly object _tunerWakeTimerLock = new object();
    static volatile bool _tunerWakeArmed;
    static volatile bool _tunerWakeBoosted;
    static int _tunerWakePending;

    [DllImport(OBJC, EntryPoint = "objc_getClass")]
    static extern IntPtr ObjcClass(string name);

    [DllImport(OBJC, EntryPoint = "sel_registerName")]
    static extern IntPtr ObjcSel(string name);

    [DllImport(OBJC, EntryPoint = "objc_msgSend")]
    static extern IntPtr ObjcSend(IntPtr receiver, IntPtr selector);

    [DllImport(OBJC, EntryPoint = "objc_msgSend")]
    static extern double ObjcSendDouble(IntPtr receiver, IntPtr selector);

    [DllImport(OBJC, EntryPoint = "objc_msgSend")]
    static extern void ObjcSendWithInt(IntPtr receiver, IntPtr selector, int arg);

    [DllImport(OBJC, EntryPoint = "object_getClass")]
    static extern IntPtr ObjcClassOf(IntPtr obj);

    [DllImport(OBJC, EntryPoint = "class_getInstanceMethod")]
    static extern IntPtr ObjcMethod(IntPtr cls, IntPtr sel);

    [DllImport(OBJC, EntryPoint = "method_getTypeEncoding")]
    static extern IntPtr ObjcMethodTypes(IntPtr method);

    const string CF = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";

    [DllImport(CF, EntryPoint = "CFRunLoopTimerSetNextFireDate")]
    static extern void CfTimerSetNextFire(IntPtr timer, double fireDate);

    [DllImport(CF, EntryPoint = "CFRunLoopTimerIsValid")]
    [return: MarshalAs(UnmanagedType.I1)]
    static extern bool CfTimerIsValid(IntPtr timer);

    [DllImport(CF, EntryPoint = "CFAbsoluteTimeGetCurrent")]
    static extern double CfNow();

    [DllImport(CF, EntryPoint = "CFRetain")]
    static extern IntPtr CfRetain(IntPtr obj);

    [DllImport(CF, EntryPoint = "CFRelease")]
    static extern void CfRelease(IntPtr obj);

    [DllImport(OBJC, EntryPoint = "class_getInstanceVariable")]
    static extern IntPtr ObjcIvar(IntPtr cls, string name);

    [DllImport(OBJC, EntryPoint = "ivar_getOffset")]
    static extern IntPtr ObjcIvarOffset(IntPtr ivar);

    [DllImport(OBJC, EntryPoint = "ivar_getTypeEncoding")]
    static extern IntPtr ObjcIvarType(IntPtr ivar);

    static bool TunerTickBoosted => _tunerTickBase > 0 && _tunerTickWant == TUNER_TICK_UPS;

    static int TunerTickUps => _tunerTickBase > 0 ? _tunerTickWant : -1;

    static void SignalTunerTick()
    {
        if (_tunerTickBase <= 0) SignalEditorTick();
    }

    static void NoteTunerActivity()
    {
        double now = EditorApplication.timeSinceStartup;
        _tunerActiveAt = now;
        _tpActivity++;
        if (_tunerWakeArmed && !TunerTickBoosted) PumpTunerTickRate(now, EditorApplication.isPlaying);
    }

    static void WakeTunerNow()
    {
        if (!_tunerWakeArmed || _tunerWakeBoosted)
        {
            SignalEditorTick();
            return;
        }
        if (Interlocked.Exchange(ref _tunerWakePending, 1) == 1) return;
        bool woke = false;
        IntPtr timer = IntPtr.Zero;
        try
        {
            lock (_tunerWakeTimerLock)
            {
                if (_tunerWakeTimer != IntPtr.Zero && _tunerMinUpdateOffset > 0)
                {
                    timer = CfRetain(_tunerWakeTimer);
                    Marshal.WriteInt64(_tunerTickDel, _tunerMinUpdateOffset, BitConverter.DoubleToInt64Bits(TUNER_WAKE_MIN_MS));
                    _tunerWakePatched = true;
                }
            }
            if (timer != IntPtr.Zero && CfTimerIsValid(timer))
            {
                double since = NowMs - Interlocked.Read(ref _lastMainThreadPumpMs);
                double wait = Math.Max(0.0, TUNER_WAKE_MIN_MS + 1.0 - since) / 1000.0;
                CfTimerSetNextFire(timer, CfNow() + wait);
                woke = true;
            }
        }
        catch
        {
            _tunerWakeArmed = false;
        }
        finally
        {
            if (timer != IntPtr.Zero) CfRelease(timer);
        }
        if (woke) return;
        Interlocked.Exchange(ref _tunerWakePending, 0);
        SignalEditorTick();
    }

    static void WakeTunerOnInput(string line)
    {
        if (!_tunerWakeArmed || _tunerWakeBoosted || line == null) return;
        int at = line.IndexOf("\"cmd\":\"tuner", 0, Math.Min(line.Length, 256), StringComparison.Ordinal);
        if (at >= 0) WakeTunerNow();
    }

    static void UnpatchTunerWake()
    {
        if (!_tunerWakePatched) return;
        lock (_tunerWakeTimerLock)
        {
            _tunerWakePatched = false;
            double interval = ReadEditorTickInterval();
            if (interval > 0 && _tunerMinUpdateOffset > 0)
                Marshal.WriteInt64(_tunerTickDel, _tunerMinUpdateOffset, BitConverter.DoubleToInt64Bits(interval * 1000.0));
        }
    }

    static bool TrackTunerWakeTimer()
    {
        if (_tunerTickDel == IntPtr.Zero || _tunerTickTimerIvar == IntPtr.Zero) return false;
        if (_tunerMinUpdateOffset < 0)
        {
            var iv = ObjcIvar(ObjcClassOf(_tunerTickDel), "m_minimumUpdateTimeMs");
            _tunerMinUpdateOffset = iv != IntPtr.Zero && Marshal.PtrToStringAnsi(ObjcIvarType(iv)) == "d" ? (int)ObjcIvarOffset(iv) : 0;
        }
        if (_tunerMinUpdateOffset == 0) return false;
        try
        {
            var timer = Marshal.ReadIntPtr(_tunerTickDel, (int)ObjcIvarOffset(_tunerTickTimerIvar));
            if (timer == _tunerWakeTimer) return timer != IntPtr.Zero;
            lock (_tunerWakeTimerLock)
            {
                if (_tunerWakeTimer != IntPtr.Zero) CfRelease(_tunerWakeTimer);
                _tunerWakeTimer = timer == IntPtr.Zero ? IntPtr.Zero : CfRetain(timer);
            }
            return timer != IntPtr.Zero;
        }
        catch (Exception e)
        {
            Debug.LogWarning("[Tuner] can't wake the editor on input: " + e.Message);
            _tunerTickTimerIvar = IntPtr.Zero;
            return false;
        }
    }

    static void ReleaseTunerWakeTimer()
    {
        _tunerWakeArmed = false;
        UnpatchTunerWake();
        lock (_tunerWakeTimerLock)
        {
            if (_tunerWakeTimer != IntPtr.Zero) CfRelease(_tunerWakeTimer);
            _tunerWakeTimer = IntPtr.Zero;
        }
    }

    static void TunerWoke()
    {
        Interlocked.Exchange(ref _tunerWakePending, 0);
    }

    static bool SameTickInterval(double a, double b)
    {
        return Math.Abs(a - b) < TUNER_TICK_SAME_S;
    }

    static bool TickFastEnough(double interval, int ups)
    {
        return interval * ups <= 1.0 + TUNER_TICK_SAME_S;
    }

    static void PumpTunerTickRate(double now, bool playing)
    {
        PumpTunerTickRateInner(now, playing);
        _tunerWakeBoosted = TunerTickBoosted;
        if (_tunerWakePatched && !_tunerWakeBoosted) UnpatchTunerWake();
    }

    static void PumpTunerTickRateInner(double now, bool playing)
    {
        if (_tunerTickBroken)
        {
            _tunerWakeArmed = false;
            return;
        }
        if (_tunerTickBase > 0 && playing != _tunerTickPlaying) DropTunerTickRate();
        bool open = (_tuners.Count > 0 || s_TiSessions.Count > 0) && (!playing || EditorApplication.isPaused) && !_editorRevealed
            && OrchestratorManaged && !ManagesEditorIdle && !EditorApplication.isCompiling;
        bool active = _tunerActiveAt >= 0 && now - _tunerActiveAt < TUNER_TICK_HOLD;
        if (open && _tunerTickDel == IntPtr.Zero && ReadEditorTickInterval() <= 0) return;
        bool wake = open && TrackTunerWakeTimer();
        _tunerWakeArmed = wake;
        if (!open && _tunerWakeTimer != IntPtr.Zero) ReleaseTunerWakeTimer();
        int want = !open ? -1 : active ? TUNER_TICK_UPS : wake ? -1 : TUNER_TICK_IDLE_UPS;
        if (want < 0)
        {
            _tunerTickChecked = -1;
            if (_tunerTickBase > 0) RestoreTunerTickRate();
            return;
        }
        if (want == _tunerTickChecked && now < _tunerTickVerifyAt) return;
        _tunerTickChecked = want;
        _tunerTickVerifyAt = now + TUNER_TICK_VERIFY_S;
        double cur = ReadEditorTickInterval();
        if (cur <= 0) return;
        if (_tunerTickBase > 0 && !SameTickInterval(cur, _tunerTickApplied))
        {
            if (!_tunerTickMovedLogged)
            {
                _tunerTickMovedLogged = true;
                SaturaDebug.Log("[Tuner] editor update interval moved to " + cur.ToString("0.####", Inv) + " s, the Tuner's " + _tunerTickWant + "/s no longer holds");
            }
            if (TickFastEnough(cur, want))
            {
                DropTunerTickRate();
                return;
            }
            _tunerTickBase = cur;
            _tunerTickWant = -1;
        }
        if (_tunerTickBase <= 0)
        {
            if (TickFastEnough(cur, want)) return;
            _tunerTickBase = cur;
            _tunerTickPlaying = playing;
            _tunerTickWant = -1;
        }
        if (want == _tunerTickWant) return;
        if (!SetEditorTickUps(want))
        {
            DropTunerTickRate();
            return;
        }
        _tunerTickWant = want;
        _tunerTickApplied = ReadEditorTickInterval();
        if (_tunerTickApplied <= 0) DropTunerTickRate();
    }

    static void DropTunerTickRate()
    {
        _tunerTickBase = -1;
        _tunerTickApplied = -1;
        _tunerTickWant = -1;
        _tunerTickChecked = -1;
    }

    static void RestoreTunerTickRate()
    {
        if (_tunerTickBase <= 0) return;
        double restore = _tunerTickBase;
        double applied = _tunerTickApplied;
        bool playing = _tunerTickPlaying;
        DropTunerTickRate();
        if (_editorRevealed || _tunerTickBroken || EditorApplication.isPlaying != playing) return;
        double cur = ReadEditorTickInterval();
        if (cur <= 0 || !SameTickInterval(cur, applied)) return;
        SetEditorTickUps(Math.Max(1, (int)Math.Round(1.0 / restore)));
    }

    static IntPtr EditorAppDelegate(out IntPtr selector)
    {
        selector = _tunerTickSel;
        if (_tunerTickDel != IntPtr.Zero) return _tunerTickDel;
        selector = IntPtr.Zero;
        if (Application.platform != RuntimePlatform.OSXEditor) return IntPtr.Zero;
        var app = ObjcSend(ObjcClass("NSApplication"), ObjcSel("sharedApplication"));
        if (app == IntPtr.Zero) return IntPtr.Zero;
        var del = ObjcSend(app, ObjcSel("delegate"));
        if (del == IntPtr.Zero) return IntPtr.Zero;
        var sel = ObjcSel(TUNER_TICK_SELECTOR);
        var m = ObjcMethod(ObjcClassOf(del), sel);
        if (m == IntPtr.Zero || Marshal.PtrToStringAnsi(ObjcMethodTypes(m)) != "v20@0:8i16") return IntPtr.Zero;
        selector = sel;
        _tunerTickSel = sel;
        _tunerTickTimerIvar = ObjcIvar(ObjcClassOf(del), "m_editorUpdateTickTimer");
        _tunerTickIntervalSel = ObjcSel("timeInterval");
        _tunerTickDel = del;
        return del;
    }

    static double ReadEditorTickInterval()
    {
        try
        {
            IntPtr sel;
            var del = EditorAppDelegate(out sel);
            if (del == IntPtr.Zero)
            {
                _tunerTickBroken = true;
                return -1;
            }
            var ivar = _tunerTickTimerIvar;
            var timer = ivar == IntPtr.Zero ? IntPtr.Zero : Marshal.ReadIntPtr(del, (int)ObjcIvarOffset(ivar));
            double interval = timer == IntPtr.Zero ? 0 : ObjcSendDouble(timer, _tunerTickIntervalSel);
            return interval > 0 && interval <= 1.0 ? interval : 0;
        }
        catch (Exception e)
        {
            _tunerTickBroken = true;
            Debug.LogWarning("[Tuner] can't read the editor update rate: " + e.Message);
            return -1;
        }
    }

    static bool SetEditorTickUps(int ups)
    {
        try
        {
            IntPtr sel;
            var del = EditorAppDelegate(out sel);
            if (del == IntPtr.Zero)
            {
                _tunerTickBroken = true;
                return false;
            }
            ObjcSendWithInt(del, sel, ups);
            return true;
        }
        catch (Exception e)
        {
            _tunerTickBroken = true;
            Debug.LogWarning("[Tuner] can't set the editor update rate: " + e.Message);
            return false;
        }
    }
}
