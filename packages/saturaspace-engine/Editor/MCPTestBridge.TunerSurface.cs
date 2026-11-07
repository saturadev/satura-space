using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public static partial class MCPTestBridge
{
    const int TUNER_SURFACE_RING = 4;
    const double TUNER_SURFACE_RETRY = 30.0;
    const double TUNER_SURFACE_RETRY_MAX = 600.0;

    class TunerSurface
    {
        public SharedSurfaceSender Sender;
        public uint Generation;
        public readonly Dictionary<uint, TunerFramePending> Pending = new Dictionary<uint, TunerFramePending>();
        public ControlClient Client;
        public bool OffThread;
        public int Sent;
        public int Dropped;
    }

    struct TunerFramePending
    {
        public string Head;
        public string Tail;
        public bool Stamp;
    }

    const int TUNER_ADVERTISE_POLL_MS = 1;
    const int TUNER_ADVERTISE_GIVE_UP_MS = 250;
    static readonly List<TunerSurface> _tunerAdvertise = new List<TunerSurface>();
    static readonly AutoResetEvent _tunerAdvertiseWake = new AutoResetEvent(false);
    static Thread _tunerAdvertiseThread;

    static double _tunerSurfaceBlockedUntil = -1;
    static uint _tunerSurfaceGen;
    static int _tunerSurfaceFailures;

    static bool TunerSurfacePlatform
    {
        get
        {
            var dev = SystemInfo.graphicsDeviceType;
            if (Application.platform == RuntimePlatform.OSXEditor) return dev == GraphicsDeviceType.Metal;
            if (Application.platform == RuntimePlatform.WindowsEditor) return dev == GraphicsDeviceType.Direct3D11;
            return false;
        }
    }

    static bool TunerSurfaceMode(TunerSession s, double now)
    {
        if (!TunerSurfacePlatform) return false;
        if (s.Surface != null && s.Surface.Sender != null) return true;
        if (now >= _tunerSurfaceBlockedUntil) return true;
        if (s.Dirty) WakeTunerAt(_tunerSurfaceBlockedUntil, now);
        return false;
    }

    static bool TunerSurfaceBlocked(TunerSession s)
    {
        var sf = s.Surface;
        return sf != null && sf.Sender != null && sf.Sender.Width == s.Width && sf.Sender.Height == s.Height && !sf.Sender.DeviceLost
            && !sf.Sender.SlotFree();
    }

    static bool EnsureTunerSurface(TunerSession s, int w, int h, double now)
    {
        var sf = s.Surface;
        if (sf != null && sf.Sender != null)
        {
            if (sf.Sender.DeviceLost)
                Debug.LogWarning("[Tuner] " + s.Name + " graphics device reset, recreating the shared surface");
            else if (sf.Sender.Width == w && sf.Sender.Height == h)
                return true;
            ReleaseTunerSurface(s);
        }
        var sender = SharedSurfaceSender.TryCreate(w, h, TUNER_SURFACE_RING);
        if (sender == null)
        {
            double wait = Math.Min(TUNER_SURFACE_RETRY * (1 << Math.Min(_tunerSurfaceFailures, 5)), TUNER_SURFACE_RETRY_MAX);
            _tunerSurfaceFailures++;
            _tunerSurfaceBlockedUntil = now + wait;
            Debug.LogWarning("[Tuner] " + s.Name + " shared surface unavailable, no frames (retry in "
                + wait.ToString(Inv) + "s)");
            return false;
        }
        _tunerSurfaceFailures = 0;
        _tunerSurfaceBlockedUntil = -1;
        uint gen = (uint)Environment.TickCount;
        if (gen == _tunerSurfaceGen || gen == 0) gen = _tunerSurfaceGen + 1;
        _tunerSurfaceGen = gen;
        s.Surface = new TunerSurface { Sender = sender, Generation = gen };
        SaturaDebug.Log("[Tuner] " + s.Name + " shared surface " + w + "x" + h + " ring " + sender.Count + " generation " + gen);
        return true;
    }

    static bool SubmitTunerSurface(TunerSession s, RenderTexture src, int w, int h, ref TunerFrameInfo info, double now)
    {
        if (!EnsureTunerSurface(s, w, h, now))
        {
            ForgetTunerFrameSent(s, ref info);
            return false;
        }
        var sf = s.Surface;
        int slot = sf.Sender.Blit(src);
        if (slot < 0)
        {
            ForgetTunerFrameSent(s, ref info);
            sf.Dropped++;
            s.Dirty = true;
            return true;
        }
        uint sid = sf.Sender.SurfaceIdAt(slot);
        GL.Flush();
        info.EndMs = EpochMs();
        var pending = TunerFramePendingOf(s, sf, sid, ref info);
        lock (sf.Pending) sf.Pending[sid] = pending;
        if (sf.OffThread) WakeTunerAdvertise(sf);
        else if (!EditorApplication.isPlaying || EditorApplication.isPaused) SignalTunerTick();
        return true;
    }

    static void ForgetTunerFrameSent(TunerSession s, ref TunerFrameInfo info)
    {
        if (info.Icons != null) s.IconsSig = 0;
        if (info.Poses != null && s.FramePoseSent != null) Array.Clear(s.FramePoseSent, 0, s.FramePoseSent.Length);
    }

    static TunerFramePending TunerFramePendingOf(TunerSession s, TunerSurface sf, uint sid, ref TunerFrameInfo info)
    {
        bool stamp = info.CamSeq > 0;
        StwFrameHead(s, ref info);
        string head = new string(_stw, 0, _stwLen);
        StwReset();
        if (stamp)
        {
            StwChar(',');
            StwMs(info.GapMs);
            StwChar(']');
        }
        StwRaw(",\"surface\":{\"id\":");
        StwLong(sid);
        StwRaw(",\"handleHigh\":0,\"format\":1,\"generation\":");
        StwLong(sf.Generation);
        StwRaw(",\"flipY\":true}}");
        string tail = new string(_stw, 0, _stwLen);
        StwReset();
        return new TunerFramePending { Head = head, Tail = tail, Stamp = stamp };
    }

    static string TunerFrameText(TunerFramePending p)
    {
        return p.Stamp ? p.Head + "," + EpochMs().ToString("0.###", Inv) + p.Tail : p.Head + p.Tail;
    }

    static bool TakeTunerFrame(TunerSurface sf, uint sid, out TunerFramePending p)
    {
        lock (sf.Pending)
        {
            if (!sf.Pending.TryGetValue(sid, out p)) return false;
            sf.Pending.Remove(sid);
            return true;
        }
    }

    static void PumpTunerSurface(TunerSession s)
    {
        var sf = s.Surface;
        if (sf == null || sf.Sender == null) return;
        sf.Client = s.Client;
        sf.OffThread = s.Client != null && sf.Sender.CompletesOffThread;
        if (sf.OffThread)
        {
            if (sf.Sender.Busy) WakeTunerAdvertise(sf);
            return;
        }
        uint sid = sf.Sender.PumpAdvertise();
        TunerFramePending p;
        if (sid != 0 && TakeTunerFrame(sf, sid, out p))
        {
            StwReset();
            StwRaw(TunerFrameText(p));
            if (StwSend(s.Client)) sf.Sent++;
        }
        if (sf.Sender.Busy) SignalTunerTick();
    }

    static void WakeTunerAdvertise(TunerSurface sf)
    {
        lock (_tunerAdvertise)
        {
            if (!_tunerAdvertise.Contains(sf)) _tunerAdvertise.Add(sf);
            if (_tunerAdvertiseThread == null)
            {
                _tunerAdvertiseThread = new Thread(TunerAdvertiseLoop) { IsBackground = true, Name = "Tuner.advertise" };
                _tunerAdvertiseThread.Start();
            }
        }
        _tunerAdvertiseWake.Set();
    }

    static void TunerAdvertiseLoop()
    {
        var list = new List<TunerSurface>();
        var bytes = new byte[4096];
        while (true)
        {
            _tunerAdvertiseWake.WaitOne();
            int deadline = Environment.TickCount + TUNER_ADVERTISE_GIVE_UP_MS;
            while (Environment.TickCount - deadline < 0)
            {
                list.Clear();
                lock (_tunerAdvertise) list.AddRange(_tunerAdvertise);
                bool busy = false;
                foreach (var sf in list)
                {
                    var sender = sf.Sender;
                    var client = sf.Client;
                    if (sender == null || client == null || !sf.OffThread)
                    {
                        lock (_tunerAdvertise) _tunerAdvertise.Remove(sf);
                        continue;
                    }
                    try
                    {
                        uint sid = sender.PollAdvertiseOffThread();
                        TunerFramePending p;
                        if (sid != 0 && TakeTunerFrame(sf, sid, out p))
                        {
                            string text = TunerFrameText(p);
                            int max = Encoding.UTF8.GetMaxByteCount(text.Length) + 1;
                            if (bytes.Length < max) bytes = new byte[Math.Max(max, bytes.Length * 2)];
                            int n = Encoding.UTF8.GetBytes(text, 0, text.Length, bytes, 0);
                            bytes[n++] = (byte)'\n';
                            if (CtrlSendTo(client, bytes, n)) Interlocked.Increment(ref sf.Sent);
                        }
                        if (sender.Busy) busy = true;
                    }
                    catch (Exception)
                    {
                        lock (_tunerAdvertise) _tunerAdvertise.Remove(sf);
                    }
                }
                if (!busy) break;
                Thread.Sleep(TUNER_ADVERTISE_POLL_MS);
            }
        }
    }

    static void ReleaseTunerSurface(TunerSession s)
    {
        var sf = s.Surface;
        s.Surface = null;
        if (sf == null || sf.Sender == null) return;
        sf.OffThread = false;
        lock (_tunerAdvertise) _tunerAdvertise.Remove(sf);
        SaturaDebug.Log("[Tuner] " + s.Name + " shared surface " + sf.Sender.Width + "x" + sf.Sender.Height + " released after "
            + sf.Sent + " frames, " + sf.Dropped + " dropped");
        try { sf.Sender.Dispose(); }
        catch (Exception e) { Debug.LogException(e); }
        sf.Sender = null;
        lock (sf.Pending) sf.Pending.Clear();
    }
}
