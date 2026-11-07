using System;
using System.Runtime.InteropServices;
using UnityEngine;

public sealed class SharedSurfaceSender : IDisposable
{
    const string Lib = "SaturaSharedSurface";

    [DllImport(Lib)] static extern IntPtr satura_ss_create(int w, int h, int count);
    [DllImport(Lib)] static extern int satura_ss_count(IntPtr h);
    [DllImport(Lib)] static extern IntPtr satura_ss_texture_ptr(IntPtr h, int slot);
    [DllImport(Lib)] static extern uint satura_ss_surface_id(IntPtr h, int slot);
    [DllImport(Lib)] static extern void satura_ss_destroy(IntPtr h);
    [DllImport(Lib)] static extern void satura_ss_flush(IntPtr h);
    [DllImport(Lib)] static extern int satura_ss_set_pending_copy(IntPtr h, IntPtr srcTexture, int slot);
    [DllImport(Lib)] static extern IntPtr satura_ss_get_copy_callback();
    [DllImport(Lib)] static extern int satura_ss_upload_bytes(IntPtr h, int slot, IntPtr pixels, int len, int flipY);
    [DllImport(Lib)] static extern int satura_ss_slot_ready(IntPtr h, int slot);
    [DllImport(Lib)] static extern void satura_ss_reset(IntPtr h);
    [DllImport(Lib)] static extern int satura_ss_device_lost(IntPtr h);

    static readonly bool UseRenderThreadCopy =
        Application.platform == RuntimePlatform.WindowsEditor
        || Application.platform == RuntimePlatform.WindowsPlayer
        || Application.platform == RuntimePlatform.OSXEditor
        || Application.platform == RuntimePlatform.OSXPlayer;

    const int PollEvent = -1;
    const int StallResetTicks = 300;

    IntPtr handle;
    Texture2D[] ext;
    uint[] ids;
    int writeIndex;
    int advertiseIndex = -1;
    IntPtr copyCallback = IntPtr.Zero;
    bool tracked;
    readonly System.Collections.Generic.Queue<int> inFlight = new System.Collections.Generic.Queue<int>();
    int readySlot = -1;
    int advertisedSlot = -1;
    uint pendingAdvertise;
    double pendingStamp;
    double[] stamps;
    uint[] slotSeq;
    bool[] lent;
    bool handshake;
    bool heldSeen;
    int starved;
    uint advertiseSeq;
    int pendingSlot = -1;
    int stallTicks;
    RenderTexture srcRt;
    IntPtr srcPtr;
    bool lostSupported;
    bool flushSupported = Application.platform == RuntimePlatform.WindowsEditor
                          || Application.platform == RuntimePlatform.WindowsPlayer;
    readonly object gate = new object();
    public static readonly bool GpuSignalsCompletion = Application.platform == RuntimePlatform.OSXEditor
                                                      || Application.platform == RuntimePlatform.OSXPlayer;

    public int Width { get; }
    public int Height { get; }
    public int Count { get; }
    public uint Generation { get; set; }
    public bool CompletesOffThread => tracked && GpuSignalsCompletion;

    SharedSurfaceSender(IntPtr h, Texture2D[] t, uint[] sids, int w, int height)
    {
        handle = h;
        ext = t;
        ids = sids;
        Width = w;
        Height = height;
        Count = t.Length;
        stamps = new double[t.Length];
        slotSeq = new uint[t.Length];
        lent = new bool[t.Length];
        if (UseRenderThreadCopy)
        {
            try { copyCallback = satura_ss_get_copy_callback(); }
            catch (EntryPointNotFoundException) { copyCallback = IntPtr.Zero; }
            catch (DllNotFoundException) { copyCallback = IntPtr.Zero; }
            if (copyCallback != IntPtr.Zero)
            {
                try
                {
                    satura_ss_slot_ready(h, 0);
                    tracked = true;
                }
                catch (EntryPointNotFoundException) { }
                catch (DllNotFoundException) { }
            }
        }
        try
        {
            satura_ss_device_lost(h);
            lostSupported = true;
        }
        catch (EntryPointNotFoundException) { }
        catch (DllNotFoundException) { }
    }

    public bool DeviceLost
    {
        get
        {
            if (!lostSupported || handle == IntPtr.Zero) return false;
            return satura_ss_device_lost(handle) != 0;
        }
    }

    public static SharedSurfaceSender TryCreate(int w, int h, int count)
    {
        if (count < 1) count = 1;
        try
        {
            var hnd = satura_ss_create(w, h, count);
            if (hnd == IntPtr.Zero)
            {
                Debug.LogError("[SharedSurface] native create returned null (Metal device unavailable?)");
                return null;
            }
            int n = satura_ss_count(hnd);
            if (n <= 0)
            {
                satura_ss_destroy(hnd);
                Debug.LogError("[SharedSurface] native ring has no slots");
                return null;
            }
            var tex = new Texture2D[n];
            var sids = new uint[n];
            for (int i = 0; i < n; i++)
            {
                var texPtr = satura_ss_texture_ptr(hnd, i);
                uint id = satura_ss_surface_id(hnd, i);
                if (texPtr == IntPtr.Zero || id == 0)
                {
                    for (int j = 0; j < i; j++)
                    {
                        if (Application.isPlaying) UnityEngine.Object.Destroy(tex[j]);
                        else UnityEngine.Object.DestroyImmediate(tex[j]);
                    }
                    satura_ss_destroy(hnd);
                    Debug.LogError($"[SharedSurface] null texture or surface id at slot {i}");
                    return null;
                }
                tex[i] = Texture2D.CreateExternalTexture(w, h, TextureFormat.RGBA32, false, false, texPtr);
                sids[i] = id;
            }
            return new SharedSurfaceSender(hnd, tex, sids, w, h);
        }
        catch (DllNotFoundException)
        {
            Debug.LogError("[SharedSurface] native plugin SaturaSharedSurface not found");
            return null;
        }
        catch (Exception e)
        {
            Debug.LogError($"[SharedSurface] create failed: {e.Message}");
            return null;
        }
    }

    public bool Handshake
    {
        get { lock (gate) return handshake; }
    }

    public bool HeldSeen
    {
        get { lock (gate) return heldSeen; }
    }

    public void ExpectHolds()
    {
        lock (gate) handshake = true;
    }

    public int NoteStarved()
    {
        lock (gate) return ++starved;
    }

    public void NoteFed()
    {
        lock (gate) starved = 0;
    }

    public bool SlotFree()
    {
        lock (gate) return SlotFreeLocked();
    }

    public uint LastSeq
    {
        get { lock (gate) return advertiseSeq; }
    }

    public void ApplyHeld(uint[] held, uint upTo)
    {
        lock (gate)
        {
            if (ids == null) return;
            handshake = true;
            heldSeen = true;
            starved = 0;
            for (int i = 0; i < ids.Length; i++)
            {
                if (!lent[i] || slotSeq[i] > upTo) continue;
                if (held != null && Array.IndexOf(held, ids[i]) >= 0) continue;
                lent[i] = false;
            }
        }
    }

    public void DropHandshake()
    {
        lock (gate)
        {
            handshake = false;
            if (lent != null) Array.Clear(lent, 0, lent.Length);
        }
    }

    int FreeSlotLocked()
    {
        if (!handshake) return writeIndex;
        for (int k = 0; k < ext.Length; k++)
        {
            int s = (writeIndex + k) % ext.Length;
            if (!lent[s] && s != pendingSlot) return s;
        }
        return -1;
    }

    uint Lend(int slot, out double stamp, out uint seq)
    {
        lent[slot] = true;
        slotSeq[slot] = ++advertiseSeq;
        seq = slotSeq[slot];
        stamp = stamps[slot];
        return ids[slot];
    }

    bool SlotFreeLocked()
    {
        if (handle == IntPtr.Zero || ext == null) return false;
        int free = FreeSlotLocked();
        if (free < 0) return false;
        if (!tracked) return true;
        DrainCompleted();
        if (satura_ss_slot_ready(handle, free) != 0) return true;
        GL.IssuePluginEvent(copyCallback, PollEvent);
        if (++stallTicks >= StallResetTicks) RecoverFromStall();
        return false;
    }

    public bool Busy
    {
        get { lock (gate) return tracked && inFlight.Count > 0; }
    }

    public uint SurfaceIdAt(int slot)
    {
        if (ids == null || slot < 0 || slot >= ids.Length) return 0;
        return ids[slot];
    }

    public int Blit(RenderTexture rt, double stamp = 0)
    {
        if (handle == IntPtr.Zero || ext == null || rt == null) return -1;
        if (rt.width != Width || rt.height != Height) return -1;
        if (tracked) { lock (gate) return BlitTracked(rt, stamp); }
        int slot;
        lock (gate) slot = FreeSlotLocked();
        if (slot < 0) return -1;
        stamps[slot] = stamp;
        if (UseRenderThreadCopy && copyCallback != IntPtr.Zero)
        {
            IntPtr src = SourcePtr(rt);
            if (src == IntPtr.Zero) return -1;
            int ticket = satura_ss_set_pending_copy(handle, src, slot);
            if (ticket < 0) return -1;
            GL.IssuePluginEvent(copyCallback, ticket);
        }
        else
        {
            Graphics.CopyTexture(rt, ext[slot]);
            if (flushSupported)
            {
                try { satura_ss_flush(handle); }
                catch (EntryPointNotFoundException) { flushSupported = false; }
                catch (DllNotFoundException) { flushSupported = false; }
            }
        }
        lock (gate)
        {
            writeIndex = (slot + 1) % ext.Length;
            pendingAdvertise = advertiseIndex >= 0 ? ids[advertiseIndex] : 0;
            pendingStamp = advertiseIndex >= 0 ? stamps[advertiseIndex] : 0;
            pendingSlot = advertiseIndex;
            advertiseIndex = slot;
        }
        return slot;
    }

    IntPtr SourcePtr(RenderTexture rt)
    {
        if (!ReferenceEquals(rt, srcRt) || srcPtr == IntPtr.Zero || !rt.IsCreated())
        {
            srcRt = rt;
            srcPtr = rt.GetNativeTexturePtr();
        }
        return srcPtr;
    }

    int BlitTracked(RenderTexture rt, double stamp)
    {
        DrainCompleted();
        int slot = FreeSlotLocked();
        if (slot < 0)
        {
            GL.IssuePluginEvent(copyCallback, PollEvent);
            return -1;
        }
        bool queued = false;
        if (satura_ss_slot_ready(handle, slot) != 0)
        {
            IntPtr src = SourcePtr(rt);
            if (src != IntPtr.Zero)
            {
                int ticket = satura_ss_set_pending_copy(handle, src, slot);
                if (ticket >= 0)
                {
                    GL.IssuePluginEvent(copyCallback, ticket);
                    stamps[slot] = stamp;
                    if (readySlot == slot) readySlot = -1;
                    if (advertisedSlot == slot) advertisedSlot = -1;
                    inFlight.Enqueue(slot);
                    writeIndex = (slot + 1) % ext.Length;
                    queued = true;
                }
            }
        }
        if (queued)
        {
            stallTicks = 0;
            return slot;
        }
        GL.IssuePluginEvent(copyCallback, PollEvent);
        if (++stallTicks >= StallResetTicks) RecoverFromStall();
        return -1;
    }

    public uint PumpAdvertise() => PumpAdvertise(out _, out _);

    public uint PumpAdvertise(out double stamp, out uint seq)
    {
        lock (gate) return PumpAdvertiseLocked(out stamp, out seq);
    }

    public uint PollAdvertiseOffThread() => PollAdvertiseOffThread(out _, out _);

    public uint PollAdvertiseOffThread(out double stamp, out uint seq)
    {
        stamp = 0;
        seq = 0;
        lock (gate)
        {
            if (!CompletesOffThread || handle == IntPtr.Zero || ids == null) return 0;
            DrainCompleted();
            if (readySlot < 0 || readySlot == advertisedSlot) return 0;
            advertisedSlot = readySlot;
            return Lend(readySlot, out stamp, out seq);
        }
    }

    uint PumpAdvertiseLocked(out double stamp, out uint seq)
    {
        stamp = 0;
        seq = 0;
        if (handle == IntPtr.Zero || ids == null) return 0;
        if (!tracked)
        {
            uint pending = pendingAdvertise;
            int slot = pendingSlot;
            pendingAdvertise = 0;
            pendingSlot = -1;
            if (pending == 0 || slot < 0) return pending;
            uint sid = Lend(slot, out stamp, out seq);
            stamp = pendingStamp;
            return sid;
        }
        DrainCompleted();
        if (inFlight.Count > 0) GL.IssuePluginEvent(copyCallback, PollEvent);
        if (readySlot >= 0 && readySlot != advertisedSlot)
        {
            advertisedSlot = readySlot;
            return Lend(readySlot, out stamp, out seq);
        }
        return 0;
    }

    void DrainCompleted()
    {
        while (inFlight.Count > 0 && satura_ss_slot_ready(handle, inFlight.Peek()) != 0)
        {
            readySlot = inFlight.Dequeue();
            stallTicks = 0;
        }
    }

    void RecoverFromStall()
    {
        stallTicks = 0;
        Debug.LogWarning($"[SharedSurface] copy pipeline stalled for {StallResetTicks} captures — resetting ring state");
        try { satura_ss_reset(handle); }
        catch (EntryPointNotFoundException) { tracked = false; return; }
        catch (DllNotFoundException) { tracked = false; return; }
        inFlight.Clear();
        readySlot = -1;
        advertisedSlot = -1;
    }

    public void Dispose()
    {
        lock (gate) DisposeLocked();
    }

    void DisposeLocked()
    {
        srcRt = null;
        srcPtr = IntPtr.Zero;
        if (ext != null)
        {
            foreach (var t in ext)
            {
                if (t == null) continue;
                if (Application.isPlaying) UnityEngine.Object.Destroy(t);
                else UnityEngine.Object.DestroyImmediate(t);
            }
            ext = null;
        }
        ids = null;
        if (handle != IntPtr.Zero)
        {
            satura_ss_destroy(handle);
            handle = IntPtr.Zero;
        }
    }
}
