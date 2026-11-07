using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using UnityEngine;
using Debug = UnityEngine.Debug;

public static class SaturaFrameRate
{
    public const string CapFileName = "fps-cap";
    const string PristineEnv = "SATURA_FPS_PRISTINE";
    const string WroteEnv = "SATURA_FPS_WROTE";

    public static int Cap { get; private set; }

    static bool managed;
    static bool held;
    static int heldTarget;
    static int heldVSync;
    static bool gameSeen;
    static int gameTarget;
    static int gameVSync;
    static readonly Stopwatch clock = Stopwatch.StartNew();
    static double paceFrom;
    static double windowFrom;
    static int windowFrames;
    static bool paceLocked;
    static int paceFrame = -1;
    static double paceEntry = -1;
    static double paceDelta = -1;
    static double paceAcc;
    static bool criticalTimer = Application.platform == RuntimePlatform.OSXEditor;

    [StructLayout(LayoutKind.Sequential)]
    struct KEvent
    {
        public UIntPtr ident;
        public short filter;
        public ushort flags;
        public uint fflags;
        public IntPtr data;
        public IntPtr udata;
    }

    [DllImport("libc", EntryPoint = "kqueue")]
    static extern int KQueue();

    [DllImport("libc", EntryPoint = "kevent")]
    static extern int KEventWait(int kq, ref KEvent change, int nchanges, out KEvent ev, int nevents, IntPtr timeout);

    [DllImport("libc", EntryPoint = "close")]
    static extern int CloseFd(int fd);

    public static int MeasuredFps { get; private set; }

    public static string Source => Cap > 0 ? "cap" : "game";

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
    static void Init()
    {
        managed = int.TryParse(Environment.GetEnvironmentVariable("MC_UDP_PORT"), out var p) && p > 0;
        held = false;
        gameSeen = false;
        Cap = 0;
        paceFrom = -1;
        paceLocked = false;
        windowFrom = clock.Elapsed.TotalMilliseconds;
        windowFrames = 0;
        MeasuredFps = 0;
        if (!managed) return;
        if (string.IsNullOrEmpty(GetEnv(PristineEnv)))
            SetEnv(PristineEnv, Application.targetFrameRate + "," + QualitySettings.vSyncCount);
        Cap = ReadCapFile();
        if (int.TryParse(GetEnv(WroteEnv), out var wrote) && wrote == Application.targetFrameRate
            && TryParsePair(GetEnv(PristineEnv), out var target, out var vsync))
        {
            Set(target, vsync);
            if (Cap <= 0) SaturaDebug.Log($"[SaturaFrameRate] no cap, undid the last one: targetFrameRate={target} vSyncCount={vsync}");
        }
        SetEnv(WroteEnv, null);
        if (Cap <= 0) return;
        Hold();
        SaturaDebug.Log($"[SaturaFrameRate] frame-rate cap {Cap} fps");
    }

    static string GetEnv(string name)
    {
        try { return Environment.GetEnvironmentVariable(name); } catch { return null; }
    }

    static void SetEnv(string name, string value)
    {
        try { Environment.SetEnvironmentVariable(name, value); } catch { }
    }

    static bool TryParsePair(string s, out int target, out int vsync)
    {
        target = 0;
        vsync = 0;
        var parts = s?.Split(',');
        return parts != null && parts.Length == 2 && int.TryParse(parts[0], out target) && int.TryParse(parts[1], out vsync);
    }

    static string CapFilePath()
    {
        var root = Path.GetDirectoryName(Application.dataPath);
        return string.IsNullOrEmpty(root) ? null : Path.Combine(root, ".sspace", CapFileName);
    }

    static int ReadCapFile()
    {
        try
        {
            var path = CapFilePath();
            if (path == null || !File.Exists(path)) return 0;
            return int.TryParse(File.ReadAllText(path).Trim(), out var c) && c > 0 ? Mathf.Clamp(c, 1, 1000) : 0;
        }
        catch { return 0; }
    }

    static void Set(int target, int vsync)
    {
        QualitySettings.vSyncCount = vsync;
        Application.targetFrameRate = target;
    }

    static void Hold()
    {
        if (!held)
        {
            held = true;
            heldTarget = Application.targetFrameRate;
            heldVSync = QualitySettings.vSyncCount;
        }
        Set(Cap, 0);
        SetEnv(WroteEnv, Cap.ToString());
    }

    static void Release()
    {
        int target = gameSeen ? gameTarget : heldTarget;
        int vsync = gameSeen ? gameVSync : heldVSync;
        bool restore = gameSeen || held;
        held = false;
        gameSeen = false;
        SetEnv(WroteEnv, null);
        if (!restore) return;
        Set(target, vsync);
        SaturaDebug.Log($"[SaturaFrameRate] cap off, back to the game's targetFrameRate={target} vSyncCount={vsync}");
    }

    public static void SetCap(int cap)
    {
        if (!managed) return;
        cap = cap > 0 ? Mathf.Clamp(cap, 1, 1000) : 0;
        if (cap == Cap) return;
        Keep();
        Cap = cap;
        if (cap > 0)
        {
            Hold();
            SaturaDebug.Log($"[SaturaFrameRate] frame-rate cap {cap} fps");
        }
        else Release();
    }

    public static void Keep()
    {
        if (!managed || Cap <= 0) return;
        if (Application.targetFrameRate == Cap && QualitySettings.vSyncCount == 0) return;
        gameSeen = true;
        gameTarget = Application.targetFrameRate;
        gameVSync = QualitySettings.vSyncCount;
        Set(Cap, 0);
    }

    public static void EditorTick(bool pace)
    {
        double now = clock.Elapsed.TotalMilliseconds;
        int frame = Time.frameCount;
        bool ran = frame != paceFrame;
        double lastDelta = paceDelta;
        paceDelta = paceEntry < 0 ? -1 : now - paceEntry;
        paceEntry = now;
        paceFrame = frame;
        int target = Application.targetFrameRate;
        if (!pace || !managed || target <= 0 || Application.isBatchMode || lastDelta < 0 || paceDelta < 0)
        {
            paceLocked = false;
            return;
        }
        double period = 1000.0 / target;
        if (lastDelta < period)
        {
            double edge = period - lastDelta / 2;
            double acc = paceAcc + lastDelta;
            if (ran && acc < edge) acc = edge;
            else if (!ran && acc >= edge) acc = edge - 0.01;
            paceAcc = ran ? acc - period : acc;
        }
        if (!paceLocked)
        {
            if (!ran || lastDelta >= Math.Min(2.0, period / 4)) return;
            paceLocked = true;
            paceAcc = 0;
        }
        if (!ran || paceDelta >= period) return;
        double pending = paceAcc + paceDelta;
        if (pending >= period - paceDelta / 2) return;
        double due = now + period - pending;
        double wait = due - clock.Elapsed.TotalMilliseconds;
        if (wait <= 0) return;
        if (!(wait > 1 && CriticalSleep(wait - 0.1)) && wait > 2) Thread.Sleep((int)(wait - 1));
        while (clock.Elapsed.TotalMilliseconds < due) Thread.SpinWait(64);
    }

    static bool CriticalSleep(double ms)
    {
        if (!criticalTimer) return false;
        try
        {
            int kq = KQueue();
            if (kq < 0) return false;
            var change = new KEvent
            {
                ident = (UIntPtr)1,
                filter = -7,
                flags = 0x1 | 0x10,
                fflags = 0x4 | 0x20,
                data = (IntPtr)(long)(ms * 1e6)
            };
            int n = KEventWait(kq, ref change, 1, out _, 1, IntPtr.Zero);
            CloseFd(kq);
            return n > 0;
        }
        catch (Exception e)
        {
            criticalTimer = false;
            Debug.LogWarning("[SaturaFrameRate] no precise timer, pacing falls back to Thread.Sleep: " + e.Message);
            return false;
        }
    }

    public static void Pace()
    {
        if (!managed) return;
        double now = clock.Elapsed.TotalMilliseconds;
        int target = Application.targetFrameRate;
        if (Application.isBatchMode && target > 0)
        {
            double period = 1000.0 / target;
            if (paceFrom >= 0)
            {
                double due = paceFrom + period;
                double wait = due - now;
                if (wait > 2) Thread.Sleep((int)(wait - 1));
                while ((now = clock.Elapsed.TotalMilliseconds) < due) Thread.SpinWait(64);
                paceFrom = now - due < period ? due : now;
            }
            else paceFrom = now;
        }
        else paceFrom = -1;
        windowFrames++;
        double span = now - windowFrom;
        if (span < 1000) return;
        MeasuredFps = (int)Math.Round(windowFrames * 1000.0 / span);
        windowFrames = 0;
        windowFrom = now;
    }
}
