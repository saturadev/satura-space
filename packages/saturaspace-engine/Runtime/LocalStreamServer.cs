using System;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;
using UnityEngine.Rendering;

public class LocalStreamServer : MonoBehaviour
{
    public static LocalStreamServer Instance;

    public enum Phase { Off, Negotiating, Streaming, Transition, Suspended, Disposed }

    public RenderTexture CurrentFrame => rt;
    public Phase StreamPhase => phase;

    public int MeasuredFps { get; private set; }
    public int StreamWidth => width;
    public int StreamHeight => height;
    public bool Streaming => running && !noGraphics && rt != null;
    public bool CaptureSuspended;
    public string HoldReason { get; private set; } = "";
    public bool NoCamera { get; private set; }

    int mediaPort, inputPort;
    int width = 960, height = 540;
    int lastCapturedFrame = -1;

    RenderTexture rt;
    readonly System.Collections.Generic.List<RenderTexture> retiredRts =
        new System.Collections.Generic.List<RenderTexture>();
    int composited;
    int captured;
    int loopTicks;
    float fpsT0;
    bool verboseStats;
    bool eofCaptureWarned;
    bool compositing;
    bool gameViewRequested;
    const int EofQuietFrames = 30;
    bool compositeSafe;
    bool noGraphics;
    int lastEofFrame = -1000;
    Phase phase = Phase.Off;
    int negotiateApplies;
    int nextApplyFrame;
    int sizeMismatches;
    Vector2 acceptedMismatch = new Vector2(-1, -1);
    const int NegotiateRetryFrames = 5;
    const int NegotiateMaxApplies = 30;
    readonly System.Collections.Generic.List<SharedSurfaceSender> retiredSenders =
        new System.Collections.Generic.List<SharedSurfaceSender>();
    volatile int appGenAck;
    const int MaxRetiredSenders = 3;
    const int StarvedFramesWithoutHolds = 30;
    readonly object advertiseLock = new object();

    static readonly int RingSize = ResolveRingSize();

    static int ResolveRingSize()
    {
        if (int.TryParse(Environment.GetEnvironmentVariable("MC_STREAM_RING"), out var r) && r >= 2 && r <= 8)
            return r;
        return 6;
    }
    volatile SharedSurfaceSender sharedSender;
    Thread advertiseThread;
    readonly AutoResetEvent advertiseWake = new AutoResetEvent(false);
    const int AdvertisePollMs = 1;
    const int AdvertiseGiveUpMs = 250;
    uint surfaceGen;
    float surfaceRetryAt;
    bool surfaceErrorLogged;

    UdpClient sendSock;
    UdpClient recvSock;
    readonly object sendLock = new object();
    volatile bool running = true;
    Thread recvThread;

    volatile int pendingCap = -1;
    volatile int pendingResW, pendingResH;
    volatile int pendingResStampMs;
    volatile int pendingMute = -1;
    volatile int pendingVolume = -1;
    volatile int pendingAudioTap = -1;
    volatile int audioTapStampMs;
    volatile int pendingVideoLock = -1;
    volatile int videoLockStampMs;
    bool wantVideoLock;
    int videoFps = 60;
    double mediaTime;
    double mediaReal;
    int mediaFrame = -1;
    double mediaClock;
    bool mediaLocked;
    const int VideoLockLeaseMs = 4000;

    bool userMuted;
    float userVolume = 1f;
    bool audioTapActive;
    SaturaAudioTap audioTap;
    float audioTapCheckAt;
    const int AudioTapLeaseMs = 4000;

    int lastCursorState = -1;
    uint lastCursorImageSent;
    float cursorSentAt;
    readonly byte[] cursorPkt = new byte[8];
    int cursorImageVersion;
    uint cursorImageId;
    uint cursorImageCounter;
    byte[] cursorImagePkt;

    const float ResApplyMinIntervalSec = 0.5f;
    const int ResSettleMs = 500;
    float lastResApplyAt = -ResApplyMinIntervalSec;
    int skipCaptureUntilFrame = -1;
    float noCameraSince = -1f;
    bool sawCamera;
    Camera[] cameraScratch = new Camera[8];
    const float NoCameraHoldFirstSec = 10f;
    const float NoCameraHoldSec = 2f;

    [Serializable] class PingMsg { public int ping = -1; }
    [Serializable] class HeldMsg { public uint[] held; public uint upTo; public uint gen; public int on = 1; }
    [Serializable] class GenAckMsg { public long genAck = -1; }
    [Serializable] class CapMsg { public int fpsCap = -1; }
    [Serializable] class ResMsg { public string streamRes; }
    [Serializable] class MuteMsg { public int mute = -1; }
    [Serializable] class VolumeMsg { public int volume = -1; }
    [Serializable] class AudioTapMsg { public int audioTap = -1; }
    [Serializable] class VideoLockMsg { public int videoLock = -1; }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
    static void Boot()
    {
        if (!int.TryParse(Environment.GetEnvironmentVariable("MC_UDP_PORT"), out int p) || p <= 0)
            return;
        var go = new GameObject("LocalStreamServer");
        SaturaEngineObjects.Mark(go);
        DontDestroyOnLoad(go);
        go.AddComponent<LocalStreamServer>().Begin(p);
    }

    void Begin(int p)
    {
        Instance = this;
        mediaPort = p;
        inputPort = int.TryParse(Environment.GetEnvironmentVariable("MC_UDP_INPUT_PORT"), out var ip) && ip > 0
            ? ip : p + 1;

        var res = Environment.GetEnvironmentVariable("MC_UDP_RES");
        if (!string.IsNullOrEmpty(res))
        {
            var s = res.Split('x');
            if (s.Length == 2) { int.TryParse(s[0], out width); int.TryParse(s[1], out height); }
        }
        int.TryParse(Environment.GetEnvironmentVariable("MC_PLAYER_INDEX"), out var playerIndex);
        verboseStats = SaturaDebug.Flag("MC_STREAM_VERBOSE");
        compositeSafe = Application.platform != RuntimePlatform.OSXEditor || Application.isBatchMode;

        Application.runInBackground = true;
        SaturaFrameRate.Keep();

        noGraphics = SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null;
        StartSockets();
        if (noGraphics)
        {
            Debug.Log("[LocalStreamServer] no graphics device (-nographics) — running headless: simulation and input only, no capture or video stream.");
            return;
        }

        rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
        rt.Create();
        UpdatePhase();
        StartAdvertiseThread();

        userVolume = AudioListener.volume;
        if (playerIndex != 0)
        {
            userMuted = true;
            ApplyMute(true);
        }

        StartCoroutine(EndOfFrameCapture());
    }

    void StartSockets()
    {
        sendSock = new UdpClient();
        sendSock.Connect("127.0.0.1", mediaPort);
        recvSock = new UdpClient(new IPEndPoint(IPAddress.Loopback, inputPort));
        recvThread = new Thread(RecvLoop) { IsBackground = true, Name = "LocalStreamServer.recv" };
        recvThread.Start();
    }

    void StartAdvertiseThread()
    {
        if (advertiseThread != null || !SharedSurfaceSender.GpuSignalsCompletion) return;
        advertiseThread = new Thread(AdvertiseLoop) { IsBackground = true, Name = "LocalStreamServer.advertise" };
        advertiseThread.Start();
    }

    void AdvertiseLoop()
    {
        while (running)
        {
            advertiseWake.WaitOne();
            int deadline = Environment.TickCount + AdvertiseGiveUpMs;
            while (running && Environment.TickCount - deadline < 0)
            {
                bool busy;
                lock (advertiseLock)
                {
                    var sender = sharedSender;
                    if (sender == null || !sender.CompletesOffThread) break;
                    uint sid = sender.PollAdvertiseOffThread(out var stamp, out var seq);
                    if (sid != 0)
                    {
                        AdvertiseSurface(sid, sender.Width, sender.Height, sender.Generation, stamp, seq);
                        Interlocked.Increment(ref captured);
                    }
                    busy = sender.Busy;
                }
                if (!busy) break;
                Thread.Sleep(AdvertisePollMs);
            }
        }
    }

    public void EditorPump()
    {
        if (noGraphics || rt == null) return;
        bool quiet = Time.frameCount - lastEofFrame > EofQuietFrames;
        if (quiet != compositing)
        {
            compositing = quiet;
            gameViewRequested = false;
            SaturaDebug.Log(quiet
                ? $"[LocalStreamServer] no game view render since frame {Mathf.Max(lastEofFrame, 0)}; " + (compositeSafe ? "the stream renders its own composite" : "asking for a game view")
                : $"[LocalStreamServer] the game view renders again at frame {lastEofFrame}; composite off");
        }
        if (!quiet) return;
        if (compositeSafe) CaptureTick();
        else if (!gameViewRequested && !CaptureSuspended && !PlayTransitionPending())
        {
            gameViewRequested = true;
            SetPlayModeResolution(width, height);
        }
    }

    System.Collections.IEnumerator EndOfFrameCapture()
    {
        var wait = new WaitForEndOfFrame();
        while (running)
        {
            yield return wait;
            lastEofFrame = Time.frameCount;
            if (rt == null) continue;
            loopTicks++;
            PumpAdvertise();
            if (phase != Phase.Streaming) continue;
            if (Time.unscaledTime < surfaceRetryAt) continue;
            if (CaptureGated()) continue;

            swComposite.Restart();
            try
            {
                GL.Viewport(new Rect(0, 0, Screen.width, Screen.height));
                ScreenCapture.CaptureScreenshotIntoRenderTexture(rt);
            }
            catch (Exception e) { if (!eofCaptureWarned) { eofCaptureWarned = true; Debug.LogWarning($"[LocalStreamServer] eof capture failed: {e.Message}"); } swComposite.Stop(); continue; }
            swComposite.Stop();
            composeMs += swComposite.Elapsed.TotalMilliseconds;
            composited++;
            lastCapturedFrame = Time.frameCount;

            swCapture.Restart();
            SharedSurfaceCapture();
            swCapture.Stop();
            captureMs += swCapture.Elapsed.TotalMilliseconds;
        }
    }

#if UNITY_EDITOR
    delegate void ComposeFn(RenderTexture target, int targetDisplay, Vector2 mousePosition, bool clearTexture, bool renderIMGUI);
    static System.Reflection.MethodInfo composeMethod;
    static ComposeFn composeFn;
    static bool composeResolved;
    readonly object[] composeArgs = new object[5];

    bool RenderComposite()
    {
        if (!composeResolved)
        {
            composeResolved = true;
            var t = Type.GetType("UnityEditor.EditorGUIUtility, UnityEditor");
            composeMethod = t?.GetMethod("RenderPlayModeViewCamerasInternal",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            if (composeMethod == null)
                Debug.LogError("[LocalStreamServer] EditorGUIUtility.RenderPlayModeViewCamerasInternal not found — stream will be black");
            else
            {
                try { composeFn = (ComposeFn)Delegate.CreateDelegate(typeof(ComposeFn), composeMethod); }
                catch { composeFn = null; }
            }
        }
        if (composeFn != null)
        {
            try { composeFn(rt, 0, StreamInput.GameMousePosition, false, true); return true; }
            catch { return false; }
        }
        if (composeMethod == null) return false;
        composeArgs[0] = rt;
        composeArgs[1] = 0;
        composeArgs[2] = StreamInput.GameMousePosition;
        composeArgs[3] = false;
        composeArgs[4] = true;
        try { composeMethod.Invoke(null, composeArgs); return true; }
        catch { return false; }
    }
#else
    bool RenderComposite() => false;
#endif

#if UNITY_EDITOR
    static bool PlayTransitionPending()
    {
        return UnityEditor.EditorApplication.isPlaying !=
            UnityEditor.EditorApplication.isPlayingOrWillChangePlaymode;
    }
#else
    static bool PlayTransitionPending() { return false; }
#endif

#if UNITY_EDITOR
    static Func<Vector2> gameViewSizeFn;
    static bool gameViewSizeResolved;
    internal static Vector2 GameViewSize()
    {
        if (!gameViewSizeResolved)
        {
            gameViewSizeResolved = true;
            var t = Type.GetType("UnityEditor.PlayModeView, UnityEditor");
            var m = t?.GetMethod("GetMainPlayModeViewTargetSize",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static, null, Type.EmptyTypes, null);
            if (m != null && m.ReturnType == typeof(Vector2))
            {
                try { gameViewSizeFn = (Func<Vector2>)Delegate.CreateDelegate(typeof(Func<Vector2>), m); }
                catch { gameViewSizeFn = null; }
            }
            if (gameViewSizeFn == null)
                Debug.LogWarning("[LocalStreamServer] PlayModeView.GetMainPlayModeViewTargetSize not found — the game view size can't be checked against the stream");
        }
        if (gameViewSizeFn == null) return new Vector2(-1, -1);
        try { return gameViewSizeFn(); }
        catch { return new Vector2(-1, -1); }
    }
#else
    internal static Vector2 GameViewSize() { return new Vector2(-1, -1); }
#endif

    void SetPhase(Phase next, string why)
    {
        if (next == phase) return;
        SaturaDebug.Log($"[stream] {phase} -> {next} gen={surfaceGen} rt={width}x{height} frame={Time.frameCount}: {why}");
        phase = next;
    }

    void UpdatePhase()
    {
        if (!running) { SetPhase(Phase.Disposed, "server stopped"); return; }
        if (noGraphics || rt == null) { SetPhase(Phase.Off, noGraphics ? "no graphics device" : "no render texture"); return; }
        if (CaptureSuspended) { SetPhase(Phase.Suspended, "the editor window is revealed"); return; }
        if (PlayTransitionPending()) { SetPhase(Phase.Transition, "play mode is changing"); return; }
        if (phase != Phase.Streaming && phase != Phase.Negotiating)
        {
            SetPhase(Phase.Negotiating, phase == Phase.Off ? "stream started" : "left " + phase);
            negotiateApplies = 0;
            nextApplyFrame = 0;
            acceptedMismatch = new Vector2(-1, -1);
        }
        var gv = GameViewSize();
        bool known = gv.x >= 0 && gv.y >= 0;
        bool match = !known || ((int)gv.x == width && (int)gv.y == height) || gv == acceptedMismatch;
        if (phase == Phase.Streaming)
        {
            if (match) return;
            sizeMismatches++;
            SetPhase(Phase.Negotiating, $"game view is {gv.x}x{gv.y}, not {width}x{height} (mismatch #{sizeMismatches})");
            negotiateApplies = 0;
            nextApplyFrame = 0;
            acceptedMismatch = new Vector2(-1, -1);
        }
        if (match)
        {
            skipCaptureUntilFrame = Mathf.Max(skipCaptureUntilFrame, Time.frameCount + 1);
            SetPhase(Phase.Streaming, known ? $"game view is {gv.x}x{gv.y} after {negotiateApplies} apply(s)" : "game view size unknown");
            return;
        }
        if (Time.frameCount < nextApplyFrame) return;
        if (negotiateApplies >= NegotiateMaxApplies)
        {
            acceptedMismatch = gv;
            Debug.LogWarning($"[stream] the game view stays {gv.x}x{gv.y} after {negotiateApplies} tries to set {width}x{height}; streaming it scaled");
            SetPhase(Phase.Streaming, "gave up negotiating");
            return;
        }
        negotiateApplies++;
        nextApplyFrame = Time.frameCount + NegotiateRetryFrames;
        SetPlayModeResolution(width, height);
        if (negotiateApplies == 1 || negotiateApplies % 10 == 0)
            SaturaDebug.Log($"[stream] set the game view to {width}x{height} (it is {gv.x}x{gv.y}, try {negotiateApplies})");
    }

#if UNITY_EDITOR
    static System.Reflection.MethodInfo setResMethod;
    static bool setResResolved;
    void SetPlayModeResolution(int w, int h)
    {
        if (!setResResolved)
        {
            setResResolved = true;
            var t = Type.GetType("UnityEditor.PlayModeWindow, UnityEditor");
            setResMethod = t?.GetMethod("SetCustomRenderingResolution",
                new[] { typeof(uint), typeof(uint), typeof(string) });
            if (setResMethod == null)
                Debug.LogWarning("[LocalStreamServer] PlayModeWindow.SetCustomRenderingResolution not found — composite may not match stream resolution");
        }
        try { setResMethod?.Invoke(null, new object[] { (uint)w, (uint)h, "saturaspace-stream" }); }
        catch (Exception e) { Debug.LogWarning($"[LocalStreamServer] SetCustomRenderingResolution failed: {e.Message}"); }
    }
#else
    void SetPlayModeResolution(int w, int h) { }
#endif

#if UNITY_EDITOR
    void ApplyMute(bool mute)
    {
        try { UnityEditor.EditorUtility.audioMasterMute = mute; }
        catch (Exception e) { Debug.LogWarning($"[LocalStreamServer] audioMasterMute failed: {e.Message}"); }
    }
#else
    void ApplyMute(bool mute) { AudioListener.pause = mute; }
#endif

    bool CaptureGated()
    {
        return Time.frameCount == lastCapturedFrame || Time.frameCount <= skipCaptureUntilFrame || NoCameraHold();
    }

    bool NoCameraHold()
    {
        if (DisplayCameraLive())
        {
            if (noCameraSince >= 0f)
                Debug.Log($"[stream] a camera renders display 1 after {Mathf.RoundToInt((Time.realtimeSinceStartup - noCameraSince) * 1000f)} ms; frames resume at frame {Time.frameCount}");
            sawCamera = true;
            noCameraSince = -1f;
            HoldReason = "";
            NoCamera = false;
            return false;
        }
        float now = Time.realtimeSinceStartup;
        if (noCameraSince < 0f)
        {
            noCameraSince = now;
            Debug.Log($"[stream] no camera renders display 1 at frame {Time.frameCount}; holding frames up to {(sawCamera ? NoCameraHoldSec : NoCameraHoldFirstSec)} s");
        }
        bool hold = now - noCameraSince < (sawCamera ? NoCameraHoldSec : NoCameraHoldFirstSec);
        HoldReason = hold ? (SceneLoading() ? "Loading scene…" : "Waiting for a camera…") : "";
        if (!hold && !NoCamera)
        {
            NoCamera = true;
            Debug.Log($"[stream] still no camera renders display 1 after {Mathf.RoundToInt(now - noCameraSince)} s; Satura Space shows that instead of the picture");
        }
        return hold;
    }

    bool DisplayCameraLive()
    {
        int n = Camera.allCamerasCount;
        if (n == 0) return false;
        if (cameraScratch.Length < n) cameraScratch = new Camera[n * 2];
        n = Camera.GetAllCameras(cameraScratch);
        bool live = false;
        for (int i = 0; i < n && !live; i++)
        {
            var c = cameraScratch[i];
            live = c != null && c.targetTexture == null && c.targetDisplay == 0;
        }
        Array.Clear(cameraScratch, 0, n);
        return live;
    }

    static bool SceneLoading()
    {
        for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++)
            if (!UnityEngine.SceneManagement.SceneManager.GetSceneAt(i).isLoaded) return true;
        return false;
    }

    void ApplyResolution(int w, int h)
    {
        w = Mathf.Clamp(w, 64, 3840);
        h = Mathf.Clamp(h, 64, 3840);
        if (w == width && h == height) return;
        width = w; height = h;
        try { Environment.SetEnvironmentVariable("MC_UDP_RES", width + "x" + height); } catch { }
        if (rt != null) retiredRts.Add(rt);
        rt = new RenderTexture(width, height, 24, RenderTextureFormat.ARGB32);
        rt.Create();
        if (phase == Phase.Streaming) SetPhase(Phase.Negotiating, "resize to " + width + "x" + height);
        negotiateApplies = 0;
        nextApplyFrame = 0;
        acceptedMismatch = new Vector2(-1, -1);
        UpdatePhase();
        skipCaptureUntilFrame = Time.frameCount + 2;
        surfaceRetryAt = 0f;
        surfaceErrorLogged = false;
    }

    void RetireSender(SharedSurfaceSender old, string why)
    {
        if (old == null) return;
        retiredSenders.Add(old);
        SaturaDebug.Log($"[stream] retired gen {old.Generation} {old.Width}x{old.Height}: {why} ({retiredSenders.Count} kept until the app moves on)");
        while (retiredSenders.Count > MaxRetiredSenders)
        {
            var oldest = retiredSenders[0];
            retiredSenders.RemoveAt(0);
            Debug.LogWarning($"[stream] destroying gen {oldest.Generation} without an ack from the app ({MaxRetiredSenders} retired rings kept)");
            oldest.Dispose();
        }
    }

    void PumpRetiredSenders()
    {
        if (retiredSenders.Count == 0) return;
        var cur = sharedSender;
        if (cur == null || (uint)appGenAck != cur.Generation) return;
        foreach (var old in retiredSenders)
        {
            SaturaDebug.Log($"[stream] destroyed gen {old.Generation}: the app acked gen {cur.Generation}");
            old.Dispose();
        }
        retiredSenders.Clear();
    }

    void LateUpdate()
    {
        int reqCap = pendingCap;
        if (reqCap >= 0)
        {
            pendingCap = -1;
            SaturaFrameRate.SetCap(reqCap);
        }
        SaturaFrameRate.Keep();
        SaturaFrameRate.Pace();
        if (noGraphics) return;

        UpdatePhase();
        PumpRetiredSenders();

        if (retiredRts.Count > 0)
        {
            foreach (var t in retiredRts) { try { t.Release(); Destroy(t); } catch { } }
            retiredRts.Clear();
        }

        int rw = pendingResW, rh = pendingResH;
        if (rw > 0 && rh > 0)
        {
            if (rw == width && rh == height)
            {
                pendingResW = 0; pendingResH = 0;
            }
            else if (!PlayTransitionPending()
                && Time.unscaledTime - lastResApplyAt >= ResApplyMinIntervalSec
                && Environment.TickCount - pendingResStampMs >= ResSettleMs)
            {
                pendingResW = 0; pendingResH = 0;
                lastResApplyAt = Time.unscaledTime;
                ApplyResolution(rw, rh);
            }
        }

        int mute = pendingMute;
        if (mute >= 0)
        {
            pendingMute = -1;
            userMuted = mute != 0;
            if (!audioTapActive) ApplyMute(userMuted);
            UpdateAudioTapGain();
        }
        int vol = pendingVolume;
        if (vol >= 0)
        {
            pendingVolume = -1;
            userVolume = Mathf.Clamp01(vol / 100f);
            if (!audioTapActive) AudioListener.volume = userVolume;
            UpdateAudioTapGain();
        }
        PumpAudioTap();
        PumpVideoLock();

        PumpCursorState();
        PumpStats();
    }

    void PumpAudioTap()
    {
        int want = pendingAudioTap;
        if (want >= 0)
        {
            pendingAudioTap = -1;
            if (want == 1 && !audioTapActive) BeginAudioTap();
            else if (want == 0 && audioTapActive) EndAudioTap();
        }
        if (!audioTapActive) return;
        if (Environment.TickCount - audioTapStampMs > AudioTapLeaseMs)
        {
            EndAudioTap();
            return;
        }
        if (Time.unscaledTime < audioTapCheckAt) return;
        audioTapCheckAt = Time.unscaledTime + 0.5f;
        if (audioTap != null && audioTap.isActiveAndEnabled)
        {
            var own = audioTap.GetComponent<AudioListener>();
            if (own != null && own.isActiveAndEnabled) return;
        }
        DetachAudioTap();
        var listener = FindAnyObjectByType<AudioListener>();
        if (listener == null || !listener.isActiveAndEnabled) return;
        audioTap = listener.gameObject.AddComponent<SaturaAudioTap>();
        audioTap.hideFlags = HideFlags.HideAndDontSave;
    }

    void PumpVideoLock()
    {
        int want = pendingVideoLock;
        if (want >= 0)
        {
            pendingVideoLock = -1;
            wantVideoLock = want != 0;
            if (want > 0) videoFps = want;
        }
        bool on = wantVideoLock && Application.isPlaying && Environment.TickCount - videoLockStampMs <= VideoLockLeaseMs;
        if (on) SaturaGameClock.Lock("stream recorder", videoFps, false);
        else if (wantVideoLock && Environment.TickCount - videoLockStampMs > VideoLockLeaseMs) SaturaGameClock.Unlock("stream recorder", "lease expired");
        else SaturaGameClock.Unlock("stream recorder", "recording stopped");
    }

    double MediaStamp()
    {
        int f = Time.frameCount;
        double real = Application.isPlaying ? Time.unscaledTimeAsDouble : Time.realtimeSinceStartupAsDouble;
        double clock = SaturaGameClock.Clock;
        bool locked = SaturaGameClock.Locked;
        if (mediaFrame >= 0)
        {
            if (locked && mediaLocked) mediaTime += Math.Max(0.0, clock - mediaClock);
            else mediaTime += Math.Max(0.0, real - mediaReal);
        }
        mediaFrame = f;
        mediaReal = real;
        mediaClock = clock;
        mediaLocked = locked;
        return mediaTime;
    }

    void BeginAudioTap()
    {
        audioTapActive = true;
        audioTapCheckAt = 0f;
        SaturaAudioTap.SampleRate = AudioSettings.outputSampleRate;
        UpdateAudioTapGain();
        ApplyMute(false);
        AudioListener.volume = 1f;
        SaturaDebug.Log($"[LocalStreamServer] audio capture on ({AudioSettings.outputSampleRate} Hz)");
    }

    void EndAudioTap()
    {
        audioTapActive = false;
        DetachAudioTap();
        SaturaAudioTap.Gain = 1f;
        ApplyMute(userMuted);
        AudioListener.volume = userVolume;
        SaturaDebug.Log("[LocalStreamServer] audio capture off");
    }

    void DetachAudioTap()
    {
        if (audioTap == null) return;
        try { Destroy(audioTap); } catch { }
        audioTap = null;
    }

    void UpdateAudioTapGain()
    {
        SaturaAudioTap.Gain = userMuted ? 0f : userVolume;
    }

    void PumpCursorState()
    {
        var mode = Cursor.lockState;
        int locked = mode == CursorLockMode.Locked ? 1 : 0;
        int visible = Cursor.visible ? 1 : 0;
#if UNITY_EDITOR
        if (StreamCursor.Version != cursorImageVersion)
        {
            cursorImageVersion = StreamCursor.Version;
            BuildCursorImage(StreamCursor.Texture, StreamCursor.Hotspot);
        }
#endif
        int state = locked | (visible << 1) | ((int)mode << 2);
        if (state == lastCursorState && cursorImageId == lastCursorImageSent && Time.unscaledTime - cursorSentAt < 1f) return;
        lastCursorState = state;
        lastCursorImageSent = cursorImageId;
        cursorSentAt = Time.unscaledTime;
        if (cursorImagePkt != null) Send(cursorImagePkt);
        cursorPkt[0] = (byte)'C';
        cursorPkt[1] = (byte)locked;
        cursorPkt[2] = (byte)visible;
        cursorPkt[3] = (byte)mode;
        WriteU32(cursorPkt, 4, cursorImageId);
        Send(cursorPkt);
    }

    const int MaxCursorSide = 128;

    void BuildCursorImage(Texture2D tex, Vector2 hotspot)
    {
        cursorImagePkt = null;
        cursorImageId = 0;
        if (tex == null || tex.width <= 0 || tex.height <= 0) return;
        float scale = Mathf.Min(1f, MaxCursorSide / (float)Mathf.Max(tex.width, tex.height));
        int w = Mathf.Max(1, Mathf.RoundToInt(tex.width * scale));
        int h = Mathf.Max(1, Mathf.RoundToInt(tex.height * scale));
        RenderTexture tmp = null;
        Texture2D copy = null;
        var prev = RenderTexture.active;
        try
        {
            tmp = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            Graphics.Blit(tex, tmp);
            RenderTexture.active = tmp;
            copy = new Texture2D(w, h, TextureFormat.RGBA32, false);
            copy.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            copy.Apply();
            var png = copy.EncodeToPNG();
            if (png == null || png.Length > 60000) return;
            var pkt = new byte[9 + png.Length];
            cursorImageId = ++cursorImageCounter;
            pkt[0] = (byte)'K';
            WriteU32(pkt, 1, cursorImageId);
            WriteU16(pkt, 5, (ushort)Mathf.Clamp(Mathf.RoundToInt(hotspot.x * scale), 0, w - 1));
            WriteU16(pkt, 7, (ushort)Mathf.Clamp(Mathf.RoundToInt(hotspot.y * scale), 0, h - 1));
            Buffer.BlockCopy(png, 0, pkt, 9, png.Length);
            cursorImagePkt = pkt;
        }
        catch (Exception e)
        {
            cursorImageId = 0;
            Debug.LogWarning($"[LocalStreamServer] custom cursor capture failed: {e.Message}");
        }
        finally
        {
            RenderTexture.active = prev;
            if (tmp != null) RenderTexture.ReleaseTemporary(tmp);
            if (copy != null) Destroy(copy);
        }
    }

    void PumpStats()
    {
        float elapsed = Time.unscaledTime - fpsT0;
        if (elapsed < 1f) return;
        if (verboseStats)
        {
            float avgCompose = composited > 0 ? (float)(composeMs / composited) : 0f;
            float avgCapture = composited > 0 ? (float)(captureMs / composited) : 0f;
            Debug.Log($"[stream] loop={loopTicks} capture={captured} targetFrameRate={Application.targetFrameRate} vSyncCount={QualitySettings.vSyncCount} source={SaturaFrameRate.Source} composeMs={avgCompose:F1} captureMs={avgCapture:F1} composite={compositing}");
        }
        // Divide by the real window, not by 1: this only runs on a frame tick, so at a low
        // target the window overshoots a second by up to one frame period (at 5 fps it lands
        // at ~1.2s) and a raw count would report 6 fps for a limiter holding exactly 5.
        MeasuredFps = Mathf.RoundToInt(Interlocked.Exchange(ref captured, 0) / elapsed);
        composited = 0; loopTicks = 0; composeMs = 0; captureMs = 0; fpsT0 = Time.unscaledTime;
    }

    readonly System.Diagnostics.Stopwatch swComposite = new System.Diagnostics.Stopwatch();
    readonly System.Diagnostics.Stopwatch swCapture = new System.Diagnostics.Stopwatch();
    double composeMs, captureMs;

    void CaptureTick()
    {
        if (!running || rt == null) return;
        loopTicks++;
        PumpStats();
        UpdatePhase();
        PumpRetiredSenders();
        PumpAdvertise();
        if (phase != Phase.Streaming) return;
        if (Time.unscaledTime < surfaceRetryAt) return;
        if (CaptureGated()) return;

        swComposite.Restart();
        bool ok = RenderComposite();
        swComposite.Stop();
        composeMs += swComposite.Elapsed.TotalMilliseconds;
        if (!ok) return;
        composited++;
        lastCapturedFrame = Time.frameCount;
        swCapture.Restart();
        SharedSurfaceCapture();
        swCapture.Stop();
        captureMs += swCapture.Elapsed.TotalMilliseconds;
    }

    void PumpAdvertise()
    {
        var sender = sharedSender;
        if (sender == null) return;
        uint sid = sender.PumpAdvertise(out var stamp, out var seq);
        if (sid != 0)
        {
            AdvertiseSurface(sid, sender.Width, sender.Height, sender.Generation, stamp, seq);
            Interlocked.Increment(ref captured);
        }
    }

    void SharedSurfaceCapture()
    {
        if (sharedSender != null && sharedSender.DeviceLost)
        {
            Debug.LogWarning("[LocalStreamServer] graphics device reset — recreating shared surface ring");
            lock (advertiseLock)
            {
                sharedSender.Dispose();
                sharedSender = null;
            }
        }
        if (sharedSender == null || sharedSender.Width != width || sharedSender.Height != height)
        {
            var created = SharedSurfaceSender.TryCreate(width, height, RingSize);
            surfaceGen = NextGeneration();
            bool holds = sharedSender != null && sharedSender.Handshake;
            if (created != null)
            {
                created.Generation = surfaceGen;
                if (holds) created.ExpectHolds();
            }
            lock (advertiseLock)
            {
                RetireSender(sharedSender, created != null ? $"replaced by gen {surfaceGen} {width}x{height}" : "no new ring");
                sharedSender = created;
            }
            if (created != null) SaturaDebug.Log($"[stream] gen {surfaceGen} {width}x{height} ring {created.Count}, slot holds {(holds ? "on from the start (the app held the last generation)" : "off until the app sends them")}");
            if (sharedSender == null)
            {
                surfaceRetryAt = Time.unscaledTime + 5f;
                if (!surfaceErrorLogged)
                {
                    surfaceErrorLogged = true;
                    Debug.LogError("[LocalStreamServer] shared surface unavailable — SaturaSharedSurface plugin missing or graphics device unavailable. " +
                                   "The Unity Panel will be black; there is no fallback transport. Retrying every 5s.");
                }
                return;
            }
            surfaceErrorLogged = false;
        }
        int slot = sharedSender.Blit(rt, MediaStamp());
        if (slot >= 0)
        {
            sharedSender.NoteFed();
            if (sharedSender.CompletesOffThread) advertiseWake.Set();
        }
        else if (sharedSender.Handshake && !sharedSender.HeldSeen && sharedSender.NoteStarved() == StarvedFramesWithoutHolds)
        {
            Debug.LogWarning($"[stream] gen {sharedSender.Generation}: every slot is lent and the app sent no holds for this generation in {StarvedFramesWithoutHolds} frames; writing round-robin until it does");
            sharedSender.DropHandshake();
        }
    }

    static uint NextGeneration()
    {
        uint last = 0;
        uint.TryParse(Environment.GetEnvironmentVariable("MC_STREAM_GEN"), out last);
        uint tick = (uint)Environment.TickCount;
        uint next = tick > last ? tick : last + 1;
        if (next == 0) next = 1;
        try { Environment.SetEnvironmentVariable("MC_STREAM_GEN", next.ToString()); } catch { }
        return next;
    }

    readonly byte[] advertisePkt = new byte[30];

    void AdvertiseSurface(uint surfaceId, int w, int h, uint generation, double stamp, uint seq)
    {
        lock (sendLock)
        {
            var pkt = advertisePkt;
            pkt[0] = (byte)'S';
            pkt[1] = 1;
            WriteU32(pkt, 2, surfaceId);
            WriteU32(pkt, 6, 0);
            WriteU16(pkt, 10, (ushort)w);
            WriteU16(pkt, 12, (ushort)h);
            WriteU32(pkt, 14, generation);
            long bits = BitConverter.DoubleToInt64Bits(stamp);
            WriteU32(pkt, 18, (uint)bits);
            WriteU32(pkt, 22, (uint)(bits >> 32));
            WriteU32(pkt, 26, seq);
            try { sendSock?.Send(pkt, pkt.Length); } catch { }
        }
    }

    void Send(byte[] pkt)
    {
        lock (sendLock)
        {
            try { sendSock?.Send(pkt, pkt.Length); } catch { }
        }
    }

    public void SendPacket(byte[] pkt, int len)
    {
        lock (sendLock)
        {
            try { sendSock?.Send(pkt, len); } catch { }
        }
    }

    void RecvLoop()
    {
        var any = new IPEndPoint(IPAddress.Any, 0);
        while (running)
        {
            try
            {
                var data = recvSock.Receive(ref any);
                var json = Encoding.UTF8.GetString(data);
#if UNITY_EDITOR
                if (json.StartsWith("{\"v\":", StringComparison.Ordinal))
                {
                    RawInputStream.Instance?.Enqueue(json);
                    continue;
                }
#endif
                if (json.IndexOf("\"ping\"", StringComparison.Ordinal) >= 0)
                {
                    int id = -1;
                    try { id = JsonUtility.FromJson<PingMsg>(json).ping; } catch { }
                    var pong = new byte[5];
                    pong[0] = (byte)'P';
                    WriteU32(pong, 1, (uint)id);
                    Send(pong);
                    continue;
                }
                if (json.IndexOf("\"genAck\"", StringComparison.Ordinal) >= 0)
                {
                    long g = -1;
                    try { g = JsonUtility.FromJson<GenAckMsg>(json).genAck; } catch { }
                    if (g >= 0) appGenAck = unchecked((int)(uint)g);
                    continue;
                }
                if (json.IndexOf("\"held\"", StringComparison.Ordinal) >= 0)
                {
                    HeldMsg m = null;
                    try { m = JsonUtility.FromJson<HeldMsg>(json); } catch { }
                    var sender = sharedSender;
                    if (m != null && sender != null && m.gen == sender.Generation)
                    {
                        if (m.on == 0) sender.DropHandshake();
                        else sender.ApplyHeld(m.held, m.upTo);
                    }
                    continue;
                }
                if (json.IndexOf("\"fpsCap\"", StringComparison.Ordinal) >= 0)
                {
                    int c = -1;
                    try { c = JsonUtility.FromJson<CapMsg>(json).fpsCap; } catch { }
                    if (c >= 0) pendingCap = c;
                    continue;
                }
                if (json.IndexOf("\"streamRes\"", StringComparison.Ordinal) >= 0)
                {
                    string r = null;
                    try { r = JsonUtility.FromJson<ResMsg>(json).streamRes; } catch { }
                    var parts = r?.Split('x');
                    if (parts != null && parts.Length == 2
                        && int.TryParse(parts[0], out var w) && int.TryParse(parts[1], out var h)
                        && w > 0 && h > 0
                        && (w != pendingResW || h != pendingResH))
                    {
                        pendingResW = w; pendingResH = h;
                        pendingResStampMs = Environment.TickCount;
                    }
                    continue;
                }
                if (json.IndexOf("\"mute\"", StringComparison.Ordinal) >= 0)
                {
                    int m = -1;
                    try { m = JsonUtility.FromJson<MuteMsg>(json).mute; } catch { }
                    if (m >= 0) pendingMute = m != 0 ? 1 : 0;
                    continue;
                }
                if (json.IndexOf("\"audioTap\"", StringComparison.Ordinal) >= 0)
                {
                    int a = -1;
                    try { a = JsonUtility.FromJson<AudioTapMsg>(json).audioTap; } catch { }
                    if (a >= 0)
                    {
                        audioTapStampMs = Environment.TickCount;
                        pendingAudioTap = a != 0 ? 1 : 0;
                    }
                    continue;
                }
                if (json.IndexOf("\"videoLock\"", StringComparison.Ordinal) >= 0)
                {
                    int v = -1;
                    try { v = JsonUtility.FromJson<VideoLockMsg>(json).videoLock; } catch { }
                    if (v >= 0)
                    {
                        videoLockStampMs = Environment.TickCount;
                        pendingVideoLock = Mathf.Clamp(v, 0, 240);
                    }
                    continue;
                }
                if (json.IndexOf("\"volume\"", StringComparison.Ordinal) >= 0)
                {
                    int v = -1;
                    try { v = JsonUtility.FromJson<VolumeMsg>(json).volume; } catch { }
                    if (v >= 0) pendingVolume = Mathf.Clamp(v, 0, 100);
                    continue;
                }
#if UNITY_EDITOR
                RawInputStream.Instance?.Enqueue(json);
#endif
            }
            catch
            {
                if (!running) break;
            }
        }
    }

    static void WriteU32(byte[] b, int o, uint v)
    {
        b[o] = (byte)v; b[o + 1] = (byte)(v >> 8); b[o + 2] = (byte)(v >> 16); b[o + 3] = (byte)(v >> 24);
    }
    static void WriteU16(byte[] b, int o, ushort v)
    {
        b[o] = (byte)v; b[o + 1] = (byte)(v >> 8);
    }

    static readonly System.Collections.Generic.List<Thread> lingeringThreads = new System.Collections.Generic.List<Thread>();

    static void StopThread(Thread t, string name)
    {
        lock (lingeringThreads) lingeringThreads.RemoveAll(x => !x.IsAlive);
        if (t == null || !t.IsAlive) return;
        if (t.Join(1000)) return;
        lock (lingeringThreads) lingeringThreads.Add(t);
        Debug.LogWarning($"[stream] the {name} thread didn't stop within 1 s after the stream server closed; it is kept referenced until it exits");
    }

    void OnDestroy()
    {
        if (audioTapActive) EndAudioTap();
        SaturaGameClock.Unlock("stream recorder", "stream server destroyed");
        running = false;
        SetPhase(Phase.Disposed, "server destroyed");
        advertiseWake.Set();
        try { recvSock?.Close(); } catch { }
        try { sendSock?.Close(); } catch { }
        StopThread(recvThread, "recv");
        StopThread(advertiseThread, "advertise");
        recvThread = null;
        advertiseThread = null;
        lock (advertiseLock)
        {
            try { sharedSender?.Dispose(); } catch { }
            sharedSender = null;
            foreach (var old in retiredSenders) { try { old.Dispose(); } catch { } }
            retiredSenders.Clear();
        }
        try { rt?.Release(); } catch { }
        foreach (var t in retiredRts) { try { t.Release(); } catch { } }
        retiredRts.Clear();
    }
}
