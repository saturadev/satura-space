using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using SaturaSpace;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public static partial class MCPTestBridge
{
    const string SS_STAGING_LAST = "satura.staging.last";
    const string SS_STAGING_OPEN = "satura.staging.open";
    const string SS_STAGING_PENDING = "satura.staging.pending";
    const string SS_STAGING_REPORTS = "satura.staging.reports";
    const double STAGING_EMIT = 0.25;
    const int StagingVideoFps = 30;
    const int StagingVideoW = 960;
    const int StagingVideoH = 540;
    const float StagingVideoMax = 300f;
    const int StagingSnapW = 480;
    const int StagingSnapH = 270;
    const int StagingSnapKeep = 300;
    const int StagingReportMax = 400000;

    [Serializable]
    class StagingArgs
    {
        public string session;
        public string op;
        public string path;
    }

    [Serializable]
    class StagingCommand
    {
        public int id;
        public StagingArgs args;
    }

    [Serializable]
    class StagingStore
    {
        public List<string> keys = new List<string>();
        public List<string> runs = new List<string>();
    }

    sealed class StagingShot
    {
        public GameObject go;
        public Camera cam;
        public RenderTexture rt;
        public Texture2D tex;
    }

    sealed class StagingRec
    {
        public int run;
        public CamVideoRig rig;
        public Texture2D frame;
        public string path;
        public int written;
        public int skipped;
        public double clock0;
        public int lastFrame = -1;
        public bool full;
    }

    static readonly Dictionary<int, StagingRec> _stagingRecs = new Dictionary<int, StagingRec>();
    static readonly Dictionary<string, string> _stagingSent = new Dictionary<string, string>();
    static readonly Dictionary<string, double> _stagingAt = new Dictionary<string, double>();
    static StagingStore _stagingLast;
    static StagingStore _stagingReports;
    static readonly Dictionary<int, StagingShot> _stagingShots = new Dictionary<int, StagingShot>();
    static string[] _stagingScenes;
    static bool _stagingScenesDirty = true;
    static double _stagingScenesAt = -10;
    static HashSet<string> _stagingOpen;
    static List<string> _stagingPending;
    static int _stagingPlayFrame = -1;
    static bool _stagingFromPanel;
    static readonly HashSet<GameObject> _stagingCopies = new HashSet<GameObject>();

    [InitializeOnLoadMethod]
    static void InitStaging()
    {
        if (Inert) return;
        SaturaHandles.ScenarioStarted += OnScenarioStarted;
        SaturaHandles.ScenarioEnded += OnScenarioEnded;
        SaturaHandles.StagingReplaced += OnStagingReplaced;
        SaturaHandles.SnapshotRequested += OnStagingSnapshot;
        SaturaHandles.StagingSceneSource = StagingScenes;
        EditorApplication.projectChanged += () => _stagingScenesDirty = true;
        EditorApplication.delayCall += PruneStagingSnapshots;
        EditorApplication.playModeStateChanged += OnStagingPlayMode;
        EditorApplication.update += StagingUpdate;
        AssemblyReloadEvents.beforeAssemblyReload += () => StopStagingRecs("scripts recompiled");
    }

    static StagingStore StagingLast()
    {
        if (_stagingLast != null) return _stagingLast;
        try { _stagingLast = JsonUtility.FromJson<StagingStore>(SessionState.GetString(SS_STAGING_LAST, "{}")) ?? new StagingStore(); }
        catch { _stagingLast = new StagingStore(); }
        return _stagingLast;
    }

    static StagingStore StagingReports()
    {
        if (_stagingReports != null) return _stagingReports;
        try { _stagingReports = JsonUtility.FromJson<StagingStore>(SessionState.GetString(SS_STAGING_REPORTS, "{}")) ?? new StagingStore(); }
        catch { _stagingReports = new StagingStore(); }
        return _stagingReports;
    }

    static void PutStaging(StagingStore store, string key, string value, string ss)
    {
        int i = store.keys.IndexOf(key);
        if (i < 0)
        {
            store.keys.Add(key);
            store.runs.Add(value);
        }
        else store.runs[i] = value;
        SessionState.SetString(ss, JsonUtility.ToJson(store));
    }

    static string StagingReportJson(string path)
    {
        var live = SaturaHandles.ScenarioReport(path);
        if (live != null) return live;
        var store = StagingReports();
        int i = store.keys.IndexOf(path);
        return i >= 0 && i < store.runs.Count ? store.runs[i] : "null";
    }

    static HashSet<string> StagingOpen()
    {
        if (_stagingOpen != null) return _stagingOpen;
        _stagingOpen = new HashSet<string>(SessionState.GetString(SS_STAGING_OPEN, "").Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries));
        return _stagingOpen;
    }

    static List<string> StagingPending()
    {
        if (_stagingPending != null) return _stagingPending;
        _stagingPending = SessionState.GetString(SS_STAGING_PENDING, "").Split(new[] { '\n' }, StringSplitOptions.RemoveEmptyEntries).ToList();
        return _stagingPending;
    }

    static void SaveStagingPending() => SessionState.SetString(SS_STAGING_PENDING, string.Join("\n", StagingPending()));

    static void OnStagingPlayMode(PlayModeStateChange change)
    {
        if (change == PlayModeStateChange.EnteredPlayMode) _stagingPlayFrame = Time.frameCount;
        else if (change == PlayModeStateChange.ExitingPlayMode)
        {
            StopStagingRecs("Play Mode ended");
            _stagingCopies.Clear();
            foreach (var run in _stagingShots.Keys.ToArray()) DropStagingShot(run);
        }
        else if (change == PlayModeStateChange.EnteredEditMode && StagingPending().Count > 0)
        {
            Debug.Log("[Staging] dropped " + StagingPending().Count + " queued scenario(s): Play Mode ended before they started");
            StagingPending().Clear();
            SaveStagingPending();
        }
        _stagingSent.Clear();
    }

    static void StagingUpdate()
    {
        var pending = StagingPending();
        if (pending.Count == 0 || !EditorApplication.isPlaying || EditorApplication.isPaused) return;
        if (_stagingPlayFrame < 0) _stagingPlayFrame = Time.frameCount;
        if (Time.frameCount - _stagingPlayFrame < 3) return;
        var paths = pending.ToList();
        pending.Clear();
        SaveStagingPending();
        foreach (var p in paths)
        {
            string r;
            _stagingFromPanel = true;
            try { r = SaturaHandles.Call(p); }
            finally { _stagingFromPanel = false; }
            if (r.Contains("\"status\":\"error\"")) Debug.LogWarning("[Staging] " + p + " did not start: " + r);
        }
    }

    static bool HandleTunerStaging(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/staging") return false;
        StagingCommand parsed;
        try { parsed = JsonUtility.FromJson<StagingCommand>(line); }
        catch (Exception e)
        {
            TunerResult(from, id, "bad arguments: " + e.Message, null);
            return true;
        }
        var a = parsed != null ? parsed.args : null;
        var s = a != null ? FindTuner(a.session) : null;
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + (a != null ? a.session : "") + "'", null);
            return true;
        }
        string err = null;
        string data = null;
        switch (a.op)
        {
            case "open":
                StagingOpen().Add(s.Name);
                SessionState.SetString(SS_STAGING_OPEN, string.Join("\n", StagingOpen()));
                _stagingSent.Remove(s.Name);
                break;
            case "close":
                StagingOpen().Remove(s.Name);
                SessionState.SetString(SS_STAGING_OPEN, string.Join("\n", StagingOpen()));
                break;
            case "run":
                err = RunStagingScenario(a.path, out data);
                break;
            case "report":
                data = StagingReportJson(a.path ?? "");
                break;
            case "stop":
                if (StagingPending().Remove(a.path ?? ""))
                {
                    SaveStagingPending();
                    data = "\"unqueued\"";
                    break;
                }
                var stop = SaturaHandles.StopScenario(a.path ?? "");
                if (stop.Contains("\"status\":\"error\"")) err = "no run of " + a.path + " is going";
                else data = stop;
                Debug.Log("[Staging] stop " + a.path + (err != null ? ": " + err : ""));
                break;
            default:
                err = "unknown staging op '" + a.op + "'";
                break;
        }
        if (a.op != "report")
        {
            _stagingSent.Remove(s.Name);
            _stagingAt[s.Name] = 0;
            SignalEditorTick();
        }
        if (err != null) TunerResult(from, id, err, null);
        else TunerResult(from, id, null, data != null ? "\"data\":" + data : null);
        return true;
    }

    static string RunStagingScenario(string path, out string data)
    {
        data = null;
        if (string.IsNullOrWhiteSpace(path)) return "which scenario? Pass its path, like DoorStaging/OpensWhenPlayerWalksIn";
        path = path.Trim();
        if (!EditorApplication.isPlaying)
        {
            var exists = SaturaHandles.StagingJson().Contains(JStr(path));
            if (!exists) return "no scenario " + path + " in the open scene";
            var group = path.Substring(0, Math.Max(0, path.LastIndexOf('/')));
            StagingPending().RemoveAll(p => p != path && p.StartsWith(group + "/", StringComparison.Ordinal) && p.LastIndexOf('/') == group.Length);
            if (!StagingPending().Contains(path)) StagingPending().Add(path);
            SaveStagingPending();
            if (!EditorApplication.isPlayingOrWillChangePlaymode)
            {
                Debug.Log("[Staging] entering Play Mode to run " + path);
                EditorApplication.isPlaying = true;
            }
            data = "\"queued\"";
            return null;
        }
        string r;
        _stagingFromPanel = true;
        try { r = SaturaHandles.Call(path); }
        finally { _stagingFromPanel = false; }
        Debug.Log("[Staging] run " + path + ": " + (r.Length > 300 ? r.Substring(0, 300) + "..." : r));
        if (r.Contains("\"status\":\"error\"") && !r.Contains("\"scenario\":true"))
        {
            var m = System.Text.RegularExpressions.Regex.Match(r, "\"error\":\"((?:[^\"\\\\]|\\\\.)*)\"");
            return m.Success ? System.Text.RegularExpressions.Regex.Unescape(m.Groups[1].Value) : r;
        }
        data = r;
        return null;
    }

    static void TickTunerStaging(TunerSession s, double now, bool playing)
    {
        if (!StagingOpen().Contains(s.Name)) return;
        if (_stagingAt.TryGetValue(s.Name, out var at) && now - at < STAGING_EMIT) return;
        _stagingAt[s.Name] = now;
        string json;
        try { json = StagingStateJson(playing); }
        catch (Exception e)
        {
            json = "{\"error\":" + JStr(e.GetType().Name + ": " + e.Message) + "}";
        }
        if (_stagingSent.TryGetValue(s.Name, out var sent) && sent == json) return;
        _stagingSent[s.Name] = json;
        TunerEmit(s.Client, "{\"type\":\"event\",\"event\":\"tuner/live\",\"session\":" + s.NameJson + ",\"staging\":" + json + "}");
    }

    static string StagingStateJson(bool playing)
    {
        var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
        var sb = new StringBuilder("{\"playing\":").Append(playing ? "true" : "false");
        sb.Append(",\"scene\":").Append(JStr(scene.name)).Append(",\"scenePath\":").Append(JStr(scene.path));
        sb.Append(",\"scenes\":[").Append(string.Join(",", StagingScenes().Select(JStr))).Append(']');
        sb.Append(",\"pending\":[").Append(string.Join(",", StagingPending().Select(JStr))).Append(']');
        sb.Append(",\"items\":").Append(SaturaHandles.StagingJson());
        sb.Append(",\"last\":{");
        var last = StagingLast();
        for (int i = 0; i < last.keys.Count && i < last.runs.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(JStr(last.keys[i])).Append(':').Append(last.runs[i]);
        }
        sb.Append("}}");
        return sb.ToString();
    }

    static void OnScenarioStarted(int run)
    {
        if (!SaturaHandles.ScenarioRun(run, out var root, out var path, out var loop)) return;
        Debug.Log("[Staging] scenario " + path + " started (run " + run + (loop ? ", loops until stopped" : "") + ")");
        if (root == null || !EditorApplication.isPlaying || _stagingFromPanel) return;
        if (SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null)
        {
            Debug.Log("[Staging] no video for run " + run + ": this editor has no GPU");
            return;
        }
        try { _stagingRecs[run] = StartStagingRec(run, root, path); }
        catch (Exception e) { Debug.LogWarning("[Staging] no video for run " + run + ": " + e.Message); }
    }

    static void OnScenarioEnded(int run)
    {
        DropStagingShot(run);
        string video = null;
        if (_stagingRecs.TryGetValue(run, out var rec))
        {
            _stagingRecs.Remove(run);
            video = EndStagingRec(rec);
            if (video != null) SaturaHandles.SetRunVideo(run, video);
        }
        if (!SaturaHandles.ScenarioRun(run, out _, out var path, out _)) return;
        var json = SaturaHandles.ScenarioState(run) ?? SaturaHandles.Result(run);
        PutStaging(StagingLast(), path, json, SS_STAGING_LAST);
        var report = SaturaHandles.ScenarioReportOf(run);
        if (report != null && report.Length <= StagingReportMax) PutStaging(StagingReports(), path, report, SS_STAGING_REPORTS);
        var word = json.Contains("\"result\":\"pass\"") ? "pass" : json.Contains("\"result\":\"fail\"") ? "fail" : "no result";
        Debug.Log("[Staging] scenario " + path + " ended (run " + run + "): " + word + (video != null ? ", video " + video : ""));
    }

    static void OnStagingReplaced(GameObject old, GameObject fresh)
    {
        if (old == null || fresh == null) return;
        _stagingCopies.RemoveWhere(g => g == null);
        _stagingCopies.Add(fresh);
        var from = old.transform;
        var to = fresh.transform;
        foreach (var s in _tuners.Values)
        {
            bool moved = false;
            if (s.Objects != null)
                for (int i = 0; i < s.Objects.Length; i++)
                {
                    var go = s.Objects[i];
                    if (go == null || (go != old && !go.transform.IsChildOf(from))) continue;
                    var twin = StagingCounterpart(from, to, go.transform);
                    if (twin == null) continue;
                    s.Objects[i] = twin;
                    moved = true;
                }
            foreach (var e in s.Entries)
            {
                if (e.Go == null || (e.Go != old && !e.Go.transform.IsChildOf(from))) continue;
                var twin = StagingCounterpart(from, to, e.Go.transform);
                if (twin == null) continue;
                e.Go = twin;
                moved = true;
            }
            if (moved) s.TracksStale = true;
        }
        SignalEditorTick();
    }

    static GameObject StagingCounterpart(Transform oldRoot, Transform freshRoot, Transform t)
    {
        var route = new List<int>();
        for (var c = t; c != oldRoot; c = c.parent)
        {
            if (c == null) return null;
            route.Add(c.GetSiblingIndex());
        }
        var cur = freshRoot;
        for (int k = route.Count - 1; k >= 0; k--)
        {
            if (route[k] >= cur.childCount) return null;
            cur = cur.GetChild(route[k]);
        }
        return cur.gameObject;
    }

    static bool TunerInStagingCopy(GameObject go)
    {
        if (_stagingCopies.Count == 0 || go == null) return false;
        for (var t = go.transform; t != null; t = t.parent)
            if (_stagingCopies.Contains(t.gameObject)) return true;
        return false;
    }

    static StagingRec StartStagingRec(int run, GameObject root, string path)
    {
        var folder = Path.Combine(Path.GetDirectoryName(Application.dataPath), SspaceFolder.DirName, "videos", "staging");
        Directory.CreateDirectory(folder);
        SspaceFolder.EnsureFor(Path.Combine(folder, "x.mp4"));
        var file = Path.Combine(folder, CamVideoFileName(path.Replace('/', '-')) + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-run" + run + ".mp4");
        var rig = new CamVideoRig { name = path, path = file };
        rig.go = new GameObject("_SaturaStagingCamera_" + run) { hideFlags = HideFlags.HideAndDontSave };
        SaturaEngineObjects.Mark(rig.go);
        rig.cam = rig.go.AddComponent<Camera>();
        var main = Camera.main;
        if (main != null) rig.cam.CopyFrom(main);
        rig.cam.targetTexture = null;
        rig.cam.enabled = false;
        rig.cam.aspect = (float)StagingVideoW / StagingVideoH;
        PoseStagingCamera(rig.cam, root, main);
        rig.rt = new RenderTexture(StagingVideoW, StagingVideoH, 24, RenderTextureFormat.ARGB32);
        if (!rig.rt.Create())
        {
            UnityEngine.Object.DestroyImmediate(rig.go);
            throw new InvalidOperationException("could not create the render target");
        }
        var rec = new StagingRec { run = run, rig = rig, path = file, frame = new Texture2D(StagingVideoW, StagingVideoH, TextureFormat.RGBA32, false) };
        rig.enc = CamVideoEncoder(file, StagingVideoFps, StagingVideoW, StagingVideoH);
        if (_stagingRecs.Count == 0) SaturaGameClock.FrameEnd += StagingFrame;
        SaturaGameClock.Lock("staging run " + run, StagingVideoFps, false);
        rec.clock0 = SaturaGameClock.Clock;
        WriteStagingFrame(rec);
        return rec;
    }

    static void PoseStagingCamera(Camera cam, GameObject root, Camera main)
    {
        bool any = false;
        var b = new Bounds(root.transform.position, Vector3.one);
        foreach (var r in root.GetComponentsInChildren<Renderer>())
        {
            if (r == null || !r.enabled || r is ParticleSystemRenderer) continue;
            if (!any) { b = r.bounds; any = true; }
            else b.Encapsulate(r.bounds);
        }
        float aspect = (float)StagingVideoW / StagingVideoH;
        bool flat = main != null ? main.orthographic : b.size.z < 0.01f;
        if (flat)
        {
            cam.orthographic = true;
            var rot = main != null ? main.transform.rotation : Quaternion.identity;
            cam.transform.rotation = rot;
            cam.transform.position = b.center - rot * Vector3.forward * Mathf.Max(10f, b.extents.magnitude * 2f);
            cam.orthographicSize = Mathf.Max(0.5f, Mathf.Max(b.extents.y, b.extents.x / aspect) * 1.15f);
            return;
        }
        cam.orthographic = false;
        if (cam.fieldOfView < 20f || cam.fieldOfView > 90f) cam.fieldOfView = 50f;
        var dir = new Vector3(-0.55f, 0.6f, -1f).normalized;
        float radius = Mathf.Max(0.5f, b.extents.magnitude);
        float vfov = cam.fieldOfView * Mathf.Deg2Rad * 0.5f;
        float hfov = Mathf.Atan(Mathf.Tan(vfov) * aspect);
        float dist = radius / Mathf.Sin(Mathf.Min(vfov, hfov)) * 1.05f;
        cam.transform.position = b.center + dir * dist;
        cam.transform.rotation = Quaternion.LookRotation(b.center - cam.transform.position);
        cam.nearClipPlane = Mathf.Max(0.01f, dist - radius * 2f) * 0.5f;
        cam.farClipPlane = Mathf.Max(cam.farClipPlane, dist + radius * 4f);
    }

    static void StagingFrame()
    {
        foreach (var rec in _stagingRecs.Values.ToArray())
        {
            if (rec.full || Time.frameCount == rec.lastFrame) continue;
            rec.lastFrame = Time.frameCount;
            double game = SaturaGameClock.Clock - rec.clock0;
            if (game > StagingVideoMax)
            {
                rec.full = true;
                Debug.Log("[Staging] video for run " + rec.run + " stopped at " + StagingVideoMax + " s; the run goes on");
                continue;
            }
            int due = (int)Math.Floor(game * StagingVideoFps + 1e-4) + 1;
            if (due <= rec.written) continue;
            rec.skipped += due - rec.written - 1;
            try { WriteStagingFrame(rec); }
            catch (Exception e)
            {
                rec.full = true;
                Debug.LogWarning("[Staging] video for run " + rec.run + " stopped: " + e.Message);
            }
        }
    }

    static void WriteStagingFrame(StagingRec rec)
    {
        var prev = RenderTexture.active;
        try
        {
            CamVideoRender(rec.rig);
            RenderTexture.active = rec.rig.rt;
            rec.frame.ReadPixels(new Rect(0, 0, StagingVideoW, StagingVideoH), 0, 0, false);
            rec.frame.Apply(false);
            _camVideoAddFrame.Invoke(rec.rig.enc, new object[] { rec.frame });
            rec.written++;
        }
        finally { RenderTexture.active = prev; }
    }

    static string EndStagingRec(StagingRec rec)
    {
        SaturaGameClock.Unlock("staging run " + rec.run, "scenario ended");
        if (_stagingRecs.Count == 0) SaturaGameClock.FrameEnd -= StagingFrame;
        var s = new CamVideoSession { frame = rec.frame };
        s.rigs.Add(rec.rig);
        var err = CamVideoRelease(s);
        if (err != null)
        {
            Debug.LogWarning("[Staging] video for run " + rec.run + " failed: " + err);
            return null;
        }
        Debug.Log("[Staging] video for run " + rec.run + ": " + rec.written + " frames, " + rec.skipped + " skipped, " + rec.path);
        return rec.written > 1 ? rec.path : null;
    }

    static void StopStagingRecs(string why)
    {
        foreach (var rec in _stagingRecs.Values.ToArray())
        {
            _stagingRecs.Remove(rec.run);
            var video = EndStagingRec(rec);
            if (video != null) SaturaHandles.SetRunVideo(rec.run, video);
        }
    }

    static void OnStagingSnapshot(int run, int seq, string name)
    {
        if (!EditorApplication.isPlaying || SystemInfo.graphicsDeviceType == GraphicsDeviceType.Null) return;
        if (!SaturaHandles.ScenarioRun(run, out var root, out var path, out _) || root == null) return;
        try
        {
            if (!_stagingShots.TryGetValue(run, out var shot) || shot.go == null)
            {
                shot = new StagingShot();
                shot.go = new GameObject("_SaturaStagingSnapshot_" + run) { hideFlags = HideFlags.HideAndDontSave };
                SaturaEngineObjects.Mark(shot.go);
                shot.cam = shot.go.AddComponent<Camera>();
                var main = Camera.main;
                if (main != null) shot.cam.CopyFrom(main);
                shot.cam.targetTexture = null;
                shot.cam.enabled = false;
                shot.cam.aspect = (float)StagingSnapW / StagingSnapH;
                PoseStagingCamera(shot.cam, root, main);
                shot.rt = new RenderTexture(StagingSnapW, StagingSnapH, 24, RenderTextureFormat.ARGB32);
                shot.tex = new Texture2D(StagingSnapW, StagingSnapH, TextureFormat.RGB24, false);
                _stagingShots[run] = shot;
                if (!shot.rt.Create()) throw new InvalidOperationException("could not create the render target");
            }
            var prev = RenderTexture.active;
            try
            {
                CamVideoRender(new CamVideoRig { cam = shot.cam, rt = shot.rt });
                RenderTexture.active = shot.rt;
                shot.tex.ReadPixels(new Rect(0, 0, StagingSnapW, StagingSnapH), 0, 0, false);
                shot.tex.Apply(false);
            }
            finally { RenderTexture.active = prev; }
            var folder = StagingSnapFolder();
            Directory.CreateDirectory(folder);
            SspaceFolder.EnsureFor(Path.Combine(folder, "x.jpg"));
            var file = Path.Combine(folder, CamVideoFileName(path.Replace('/', '-')) + "-" + DateTime.Now.ToString("yyyyMMdd-HHmmss") + "-run" + run + "-" + seq + "-" + CamVideoFileName(name) + ".jpg");
            File.WriteAllBytes(file, shot.tex.EncodeToJPG(80));
            SaturaHandles.SetSnapshot(run, seq, file.Replace('\\', '/'));
        }
        catch (Exception e) { Debug.LogWarning("[Staging] snapshot '" + name + "' of run " + run + " failed: " + e.Message); }
    }

    static string StagingSnapFolder() => Path.Combine(Path.GetDirectoryName(Application.dataPath), SspaceFolder.DirName, "staging", "snapshots");

    static void DropStagingShot(int run)
    {
        if (!_stagingShots.TryGetValue(run, out var shot)) return;
        _stagingShots.Remove(run);
        if (shot.rt != null)
        {
            shot.rt.Release();
            UnityEngine.Object.DestroyImmediate(shot.rt);
        }
        if (shot.tex != null) UnityEngine.Object.DestroyImmediate(shot.tex);
        if (shot.go != null) UnityEngine.Object.DestroyImmediate(shot.go);
    }

    static void PruneStagingSnapshots()
    {
        try
        {
            var dir = new DirectoryInfo(StagingSnapFolder());
            if (!dir.Exists) return;
            foreach (var f in dir.GetFiles("*.jpg").OrderByDescending(f => f.LastWriteTimeUtc).Skip(StagingSnapKeep)) f.Delete();
        }
        catch (Exception e) { Debug.LogWarning("[Staging] could not prune old snapshots: " + e.Message); }
    }

    static string[] StagingScenes()
    {
        var now = EditorApplication.timeSinceStartup;
        if (_stagingScenes != null && (!_stagingScenesDirty || now - _stagingScenesAt < 2)) return _stagingScenes;
        _stagingScenesAt = now;
        _stagingScenesDirty = false;
        try { _stagingScenes = FindStagingScenes(); }
        catch (Exception e)
        {
            Debug.LogWarning("[Staging] could not list the staging scenes: " + e.Message);
            if (_stagingScenes == null) _stagingScenes = new string[0];
        }
        return _stagingScenes;
    }

    static string[] FindStagingScenes()
    {
        var scripts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var t in TypeCache.GetTypesDerivedFrom<SaturaStaging>())
        {
            if (t.IsAbstract) continue;
            foreach (var g in AssetDatabase.FindAssets(t.Name + " t:MonoScript"))
            {
                var p = AssetDatabase.GUIDToAssetPath(g);
                var ms = AssetDatabase.LoadAssetAtPath<MonoScript>(p);
                if (ms != null && ms.GetClass() == t) scripts.Add(p);
            }
        }
        if (scripts.Count == 0) return new string[0];
        var memo = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
        var list = new List<string>();
        foreach (var g in AssetDatabase.FindAssets("t:Scene", new[] { "Assets" }))
        {
            var p = AssetDatabase.GUIDToAssetPath(g);
            if (p.EndsWith(".unity", StringComparison.OrdinalIgnoreCase) && HoldsStaging(p, scripts, memo, 0)) list.Add(p);
        }
        list.Sort(StringComparer.OrdinalIgnoreCase);
        return list.ToArray();
    }

    static bool HoldsStaging(string path, HashSet<string> scripts, Dictionary<string, bool> memo, int depth)
    {
        if (memo.TryGetValue(path, out var known)) return known;
        memo[path] = false;
        bool found = false;
        foreach (var d in AssetDatabase.GetDependencies(path, false))
        {
            if (scripts.Contains(d)) found = true;
            else if (depth < 8 && d.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) && HoldsStaging(d, scripts, memo, depth + 1)) found = true;
            if (found) break;
        }
        memo[path] = found;
        return found;
    }
}
