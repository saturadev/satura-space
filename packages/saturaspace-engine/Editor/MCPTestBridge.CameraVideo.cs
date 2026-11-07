using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;
using SaturaSpace;

public static partial class MCPTestBridge
{
    [Serializable]
    class CamVideoCamArgs
    {
        public string name = "";
        public float[] position;
        public float[] rotation;
        public float[] lookAt;
        public string lookAtObject = "";
        public string follow = "";
        public float fov;
    }

    [Serializable]
    class CamVideoArgs
    {
        public CamVideoCamArgs[] cameras;
        public int width = 1280;
        public int height = 720;
        public int fps = 30;
        public string folder = "";
        public float maxSeconds = 600f;
        public float seconds;
    }

    [Serializable]
    class CamVideoClip
    {
        public string name;
        public string path;
    }

    [Serializable]
    class CamVideoReply
    {
        public bool ok = true;
        public string error = "";
        public string state = "";
        public int frames;
        public float seconds;
        public float gameSeconds;
        public float wallSeconds;
        public int skipped;
        public string clock = "";
        public int fps;
        public int width;
        public int height;
        public string note = "";
        public CamVideoClip[] clips;
    }

    sealed class CamVideoRig
    {
        public string name;
        public string path;
        public GameObject go;
        public Camera cam;
        public RenderTexture rt;
        public IDisposable enc;
        public Transform follow;
        public Vector3 offset;
        public Transform lookAtT;
        public Renderer[] lookAtR;
        public Vector3 lookAtP;
        public bool hasLookAt;
        public bool hasRotation;
        public Quaternion rotation;
    }

    sealed class CamVideoSession
    {
        public List<CamVideoRig> rigs = new List<CamVideoRig>();
        public Texture2D frame;
        public int width;
        public int height;
        public int fps;
        public float maxSeconds;
        public float seconds;
        public double t0;
        public double clock0;
        public bool gameClock;
        public int written;
        public int skipped;
        public int lastFrame = -1;
        public string folder;
    }

    const string SS_CAMVIDEO_LAST = "satura.camvideo.last";
    const int MaxVideoCameras = 6;

    static CamVideoSession _camVideo;
    static bool _camVideoHooked;

    public static string CameraVideoStart(string json)
    {
        try { return JsonUtility.ToJson(CamVideoBegin(json)); }
        catch (Exception e) { return JsonUtility.ToJson(new CamVideoReply { ok = false, error = e.Message }); }
    }

    public static string CameraVideoStop()
    {
        if (_camVideo != null) return JsonUtility.ToJson(CamVideoEnd(""));
        var last = SessionState.GetString(SS_CAMVIDEO_LAST, "");
        if (!string.IsNullOrEmpty(last))
        {
            SessionState.EraseString(SS_CAMVIDEO_LAST);
            return last;
        }
        return JsonUtility.ToJson(new CamVideoReply { ok = false, error = "no camera recording is running" });
    }

    public static string CameraVideoStatus()
    {
        var s = _camVideo;
        if (s == null) return JsonUtility.ToJson(new CamVideoReply { state = "idle" });
        return JsonUtility.ToJson(CamVideoDescribe(s, "recording", ""));
    }

    static CamVideoReply CamVideoBegin(string json)
    {
        if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null)
            throw new InvalidOperationException("camera video needs a GPU: this editor runs with -nographics, so nothing is rendered");
        if (_camVideo != null)
            throw new InvalidOperationException("a camera recording is already running: stop it first");
        var a = JsonUtility.FromJson<CamVideoArgs>(string.IsNullOrEmpty(json) ? "{}" : json);
        int n = a.cameras != null ? a.cameras.Length : 0;
        if (n == 0) throw new ArgumentException("pass at least one camera");
        if (n > MaxVideoCameras) throw new ArgumentException("at most " + MaxVideoCameras + " cameras at once, got " + n);
        int w = Mathf.Clamp(a.width / 2 * 2, 64, 3840);
        int h = Mathf.Clamp(a.height / 2 * 2, 64, 2160);
        int fps = Mathf.Clamp(a.fps <= 0 ? 30 : a.fps, 1, 60);
        string root = Path.GetDirectoryName(Application.dataPath);
        string folder = string.IsNullOrEmpty(a.folder)
            ? Path.Combine(root, SspaceFolder.DirName, "videos", "cameras-" + DateTime.Now.ToString("yyyyMMdd-HHmmss"))
            : (Path.IsPathRooted(a.folder) ? a.folder : Path.Combine(root, a.folder));
        Directory.CreateDirectory(folder);
        SspaceFolder.EnsureFor(Path.Combine(folder, "x.mp4"));

        var s = new CamVideoSession
        {
            width = w,
            height = h,
            fps = fps,
            maxSeconds = a.maxSeconds > 0 ? a.maxSeconds : 600f,
            seconds = a.seconds > 0 ? a.seconds : 0f,
            folder = folder
        };
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var main = Camera.main;
        try
        {
            for (int i = 0; i < n; i++)
                s.rigs.Add(CamVideoMakeRig(a.cameras[i], i, s, main, names));
            s.frame = new Texture2D(w, h, TextureFormat.RGBA32, false);
            foreach (var r in s.rigs)
                r.enc = CamVideoEncoder(r.path, fps, w, h);
        }
        catch
        {
            CamVideoRelease(s);
            throw;
        }
        SessionState.EraseString(SS_CAMVIDEO_LAST);
        _camVideo = s;
        CamVideoHook();
        s.t0 = EditorApplication.timeSinceStartup;
        s.gameClock = EditorApplication.isPlaying;
        if (s.gameClock)
        {
            SaturaGameClock.Lock("camera video", fps, true);
            SaturaGameClock.FrameEnd += CamVideoFrame;
            s.clock0 = SaturaGameClock.Clock;
        }
        s.lastFrame = Time.frameCount;
        CamVideoWrite(s);
        Debug.Log("[MCPTestBridge] Camera video started: " + n + " camera(s), " + w + "x" + h + " at " + fps + " fps, "
            + (s.gameClock ? "game clock " + SaturaGameClock.Current + " (" + SaturaGameClock.Describe() + ")" : "edit mode, wall clock")
            + (s.seconds > 0 ? ", " + s.seconds + " s of game time" : "") + ", " + folder);
        return CamVideoDescribe(s, "recording", "");
    }

    static MethodInfo _camVideoAddFrame;

    static Type CamVideoType(string fullName)
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            var t = asm.GetType(fullName, false);
            if (t != null) return t;
        }
        throw new InvalidOperationException("This Unity version has no " + fullName + ", so camera video can't record");
    }

    static IDisposable CamVideoEncoder(string path, int fps, int w, int h)
    {
        var encoderType = CamVideoType("UnityEditor.Media.MediaEncoder");
        var attrsType = CamVideoType("UnityEditor.Media.VideoTrackAttributes");
        var rationalType = CamVideoType("UnityEditor.Media.MediaRational");
        object attrs = Activator.CreateInstance(attrsType);
        attrsType.GetField("frameRate").SetValue(attrs, Activator.CreateInstance(rationalType, fps));
        attrsType.GetField("width").SetValue(attrs, (uint)w);
        attrsType.GetField("height").SetValue(attrs, (uint)h);
        attrsType.GetField("includeAlpha").SetValue(attrs, false);
        var mode = attrsType.GetField("bitRateMode");
        mode.SetValue(attrs, Enum.Parse(mode.FieldType, "High"));
        var ctor = encoderType.GetConstructor(new[] { typeof(string), attrsType });
        if (ctor == null) throw new InvalidOperationException("MediaEncoder(string, VideoTrackAttributes) is missing in this Unity version");
        _camVideoAddFrame = _camVideoAddFrame ?? encoderType.GetMethod("AddFrame", new[] { typeof(Texture2D) });
        if (_camVideoAddFrame == null) throw new InvalidOperationException("MediaEncoder.AddFrame(Texture2D) is missing in this Unity version");
        try { return (IDisposable)ctor.Invoke(new object[] { path, attrs }); }
        catch (TargetInvocationException e) { throw e.InnerException ?? e; }
    }

    static CamVideoRig CamVideoMakeRig(CamVideoCamArgs c, int index, CamVideoSession s, Camera main, HashSet<string> names)
    {
        string label = string.IsNullOrWhiteSpace(c.name) ? "camera-" + (index + 1) : c.name.Trim();
        string file = CamVideoFileName(label);
        string unique = file;
        for (int k = 2; File.Exists(Path.Combine(s.folder, unique + ".mp4")) || !names.Add(unique); k++) unique = file + "-" + k;
        var r = new CamVideoRig { name = label, path = Path.Combine(s.folder, unique + ".mp4") };
        if (!string.IsNullOrWhiteSpace(c.follow))
        {
            var go = TiFindObject(c.follow.Trim(), null);
            if (go == null) throw new ArgumentException(label + ": no object '" + c.follow + "' to follow in the open scenes");
            r.follow = go.transform;
        }
        bool hasPos = c.position != null && c.position.Length == 3;
        if (c.position != null && c.position.Length != 0 && !hasPos) throw new ArgumentException(label + ": position is [x, y, z]");
        if (!hasPos && r.follow == null) throw new ArgumentException(label + ": pass a position [x, y, z], or follow an object");
        r.offset = hasPos ? new Vector3(c.position[0], c.position[1], c.position[2]) : new Vector3(0f, 2f, -5f);
        if (!string.IsNullOrWhiteSpace(c.lookAtObject))
        {
            var go = TiFindObject(c.lookAtObject.Trim(), null);
            if (go == null) throw new ArgumentException(label + ": no object '" + c.lookAtObject + "' to look at in the open scenes");
            r.lookAtT = go.transform;
            r.lookAtR = go.GetComponentsInChildren<Renderer>();
            r.hasLookAt = true;
        }
        else if (c.lookAt != null && c.lookAt.Length == 3)
        {
            r.lookAtP = new Vector3(c.lookAt[0], c.lookAt[1], c.lookAt[2]);
            r.hasLookAt = true;
        }
        else if (c.lookAt != null && c.lookAt.Length != 0) throw new ArgumentException(label + ": lookAt is [x, y, z] or an object path");
        if (c.rotation != null && c.rotation.Length == 3)
        {
            r.rotation = Quaternion.Euler(c.rotation[0], c.rotation[1], c.rotation[2]);
            r.hasRotation = true;
        }
        else if (c.rotation != null && c.rotation.Length != 0) throw new ArgumentException(label + ": rotation is [x, y, z] in degrees");
        if (!r.hasLookAt && !r.hasRotation && r.follow != null)
        {
            r.lookAtT = r.follow;
            r.lookAtR = r.follow.GetComponentsInChildren<Renderer>();
            r.hasLookAt = true;
        }
        if (!r.hasLookAt && !r.hasRotation) throw new ArgumentException(label + ": pass lookAt (a point or an object) or rotation");

        r.go = new GameObject("_SaturaVideoCamera_" + label) { hideFlags = HideFlags.HideAndDontSave };
        SaturaEngineObjects.Mark(r.go);
        r.cam = r.go.AddComponent<Camera>();
        if (main != null) r.cam.CopyFrom(main);
        else
        {
            r.cam.clearFlags = CameraClearFlags.Skybox;
            r.cam.cullingMask = -1;
            r.cam.nearClipPlane = 0.03f;
            r.cam.farClipPlane = 5000f;
            r.cam.fieldOfView = 60f;
        }
        if (c.fov > 0f)
        {
            r.cam.orthographic = false;
            r.cam.fieldOfView = Mathf.Clamp(c.fov, 1f, 179f);
        }
        r.cam.targetTexture = null;
        r.cam.enabled = false;
        r.cam.aspect = (float)s.width / s.height;
        r.rt = new RenderTexture(s.width, s.height, 24, RenderTextureFormat.ARGB32);
        if (!r.rt.Create()) throw new InvalidOperationException("could not create a " + s.width + "x" + s.height + " render target");
        return r;
    }

    static string CamVideoFileName(string label)
    {
        var chars = label.ToCharArray();
        for (int i = 0; i < chars.Length; i++)
            if (!char.IsLetterOrDigit(chars[i]) && chars[i] != '-' && chars[i] != '_') chars[i] = '-';
        var name = new string(chars).Trim('-');
        return name.Length == 0 ? "camera" : name;
    }

    static void CamVideoHook()
    {
        if (_camVideoHooked) return;
        _camVideoHooked = true;
        EditorApplication.update += CamVideoTick;
        EditorApplication.playModeStateChanged += CamVideoPlayModeChanged;
        AssemblyReloadEvents.beforeAssemblyReload += CamVideoBeforeReload;
    }

    static void CamVideoUnhook()
    {
        if (!_camVideoHooked) return;
        _camVideoHooked = false;
        EditorApplication.update -= CamVideoTick;
        EditorApplication.playModeStateChanged -= CamVideoPlayModeChanged;
        AssemblyReloadEvents.beforeAssemblyReload -= CamVideoBeforeReload;
    }

    static void CamVideoPlayModeChanged(PlayModeStateChange state)
    {
        if (_camVideo == null) return;
        if (state == PlayModeStateChange.ExitingPlayMode) CamVideoAbort("Stopped when Play Mode ended.");
        else if (state == PlayModeStateChange.ExitingEditMode) CamVideoAbort("Stopped when Play Mode started: start the cameras once the game is playing.");
    }

    static void CamVideoBeforeReload()
    {
        if (_camVideo != null) CamVideoAbort("Stopped when scripts recompiled.");
    }

    static void CamVideoAbort(string note)
    {
        var reply = CamVideoEnd(note);
        SessionState.SetString(SS_CAMVIDEO_LAST, JsonUtility.ToJson(reply));
    }

    static void CamVideoTick()
    {
        var s = _camVideo;
        if (s == null) return;
        double elapsed = EditorApplication.timeSinceStartup - s.t0;
        if (elapsed >= s.maxSeconds)
        {
            CamVideoAbort("Stopped at the " + Mathf.RoundToInt(s.maxSeconds) + " s limit.");
            return;
        }
        if (s.gameClock) return;
        int due = (int)(elapsed * s.fps) + 1;
        if (due <= s.written) return;
        s.skipped += due - s.written - 1;
        try { CamVideoWrite(s); }
        catch (Exception e) { CamVideoAbort("Stopped on an error: " + e.Message); }
        CamVideoCheckDone(s);
    }

    static void CamVideoFrame()
    {
        var s = _camVideo;
        if (s == null || !s.gameClock) return;
        if (Time.frameCount == s.lastFrame) return;
        s.lastFrame = Time.frameCount;
        double game = SaturaGameClock.Clock - s.clock0;
        int due = (int)Math.Floor(game * s.fps + 1e-4) + 1;
        if (due <= s.written) return;
        s.skipped += due - s.written - 1;
        try { CamVideoWrite(s); }
        catch (Exception e)
        {
            CamVideoAbort("Stopped on an error: " + e.Message);
            return;
        }
        CamVideoCheckDone(s);
    }

    static void CamVideoCheckDone(CamVideoSession s)
    {
        if (_camVideo != s || s.seconds <= 0f) return;
        if (s.written < Mathf.RoundToInt(s.seconds * s.fps) + 1) return;
        CamVideoAbort("");
    }

    static void CamVideoWrite(CamVideoSession s)
    {
        var prev = RenderTexture.active;
        try
        {
            foreach (var r in s.rigs)
            {
                CamVideoPose(r);
                CamVideoRender(r);
                RenderTexture.active = r.rt;
                s.frame.ReadPixels(new Rect(0, 0, s.width, s.height), 0, 0, false);
                s.frame.Apply(false);
                _camVideoAddFrame.Invoke(r.enc, new object[] { s.frame });
            }
            s.written++;
        }
        finally
        {
            RenderTexture.active = prev;
        }
    }

    static void CamVideoPose(CamVideoRig r)
    {
        var pos = r.follow != null ? r.follow.position + r.offset : r.offset;
        r.go.transform.position = pos;
        if (r.hasLookAt)
        {
            var target = r.lookAtT != null ? CamVideoCenter(r) : r.lookAtP;
            if ((target - pos).sqrMagnitude >= 1e-8f) r.go.transform.rotation = Quaternion.LookRotation(target - pos);
        }
        else r.go.transform.rotation = r.rotation;
    }

    static Vector3 CamVideoCenter(CamVideoRig r)
    {
        if (r.lookAtR != null)
        {
            bool any = false;
            var b = new Bounds();
            foreach (var rend in r.lookAtR)
            {
                if (rend == null || !rend.enabled || !rend.gameObject.activeInHierarchy) continue;
                if (!any) { b = rend.bounds; any = true; }
                else b.Encapsulate(rend.bounds);
            }
            if (any) return b.center;
        }
        return r.lookAtT != null ? r.lookAtT.position : r.lookAtP;
    }

    static void CamVideoRender(CamVideoRig r)
    {
        if (GraphicsSettings.currentRenderPipeline != null)
        {
            var req = new RenderPipeline.StandardRequest { destination = r.rt };
            if (RenderPipeline.SupportsRenderRequest(r.cam, req))
            {
                RenderPipeline.SubmitRenderRequest(r.cam, req);
                return;
            }
        }
        r.cam.targetTexture = r.rt;
        r.cam.Render();
        r.cam.targetTexture = null;
    }

    static CamVideoReply CamVideoDescribe(CamVideoSession s, string state, string note)
    {
        var clips = new CamVideoClip[s.rigs.Count];
        for (int i = 0; i < clips.Length; i++) clips[i] = new CamVideoClip { name = s.rigs[i].name, path = s.rigs[i].path };
        return new CamVideoReply
        {
            state = state,
            frames = s.written,
            seconds = Mathf.Round(s.written * 100f / s.fps) / 100f,
            gameSeconds = s.gameClock ? (float)Math.Round(SaturaGameClock.Clock - s.clock0, 2) : 0f,
            wallSeconds = (float)Math.Round(EditorApplication.timeSinceStartup - s.t0, 2),
            skipped = s.skipped,
            clock = s.gameClock ? SaturaGameClock.Current + " " + SaturaGameClock.Describe() : "wall",
            fps = s.fps,
            width = s.width,
            height = s.height,
            note = note ?? "",
            clips = clips
        };
    }

    static CamVideoReply CamVideoEnd(string note)
    {
        var s = _camVideo;
        _camVideo = null;
        CamVideoUnhook();
        if (s == null) return new CamVideoReply { ok = false, error = "no camera recording is running" };
        var reply = CamVideoDescribe(s, "saved", note);
        if (s.gameClock)
        {
            SaturaGameClock.FrameEnd -= CamVideoFrame;
            SaturaGameClock.Unlock("camera video", string.IsNullOrEmpty(note) ? "saved" : note);
        }
        string err = CamVideoRelease(s);
        if (err != null)
        {
            reply.ok = false;
            reply.error = "writing the videos failed: " + err;
        }
        Debug.Log("[MCPTestBridge] Camera video saved: " + s.rigs.Count + " clip(s), " + s.written + " frames each, "
            + reply.gameSeconds + " s game time in " + reply.wallSeconds + " s wall time, " + s.skipped + " skipped, " + s.folder
            + (string.IsNullOrEmpty(note) ? "" : " (" + note + ")"));
        return reply;
    }

    static string CamVideoRelease(CamVideoSession s)
    {
        string err = null;
        foreach (var r in s.rigs)
        {
            try { r.enc?.Dispose(); }
            catch (Exception e) { err = e.Message; }
            r.enc = null;
            if (r.cam != null) r.cam.targetTexture = null;
            if (r.rt != null)
            {
                if (RenderTexture.active == r.rt) RenderTexture.active = null;
                r.rt.Release();
                UnityEngine.Object.DestroyImmediate(r.rt);
            }
            if (r.go != null) UnityEngine.Object.DestroyImmediate(r.go);
        }
        if (s.frame != null) UnityEngine.Object.DestroyImmediate(s.frame);
        s.frame = null;
        return err;
    }
}
