using System;
using System.Collections.Generic;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEngine;
using UnityEngine.Experimental.Rendering;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    const int TUNER_MAX_SIDE = 1600;
    const int TUNER_MIN_SIDE = 64;
    const double TUNER_STATE_INTERVAL = 0.05;
    const double TUNER_DRAG_LOST = 10.0;
    const double TUNER_RESOLVE_INTERVAL = 0.5;
    const double TUNER_QUIET_AFTER = 1.0;
    const double TUNER_QUIET_CHECK = 0.25;
    const double TUNER_PLAY_HIERARCHY_INTERVAL = 1.0;
    static bool _tunerHierarchyPending;
    static double _tunerHierarchyFlushedAt = -1;
    const double TUNER_QUIET_SLOW_AFTER = 3.0;
    const double TUNER_QUIET_IDLE_AFTER = 10.0;
    const double TUNER_QUIET_SLOW_CHECK = 1.0;
    const double TUNER_QUIET_IDLE_CHECK = 2.0;

    static double TunerQuietCheck(double quiet)
    {
        return quiet < TUNER_QUIET_SLOW_AFTER ? TUNER_QUIET_CHECK : quiet < TUNER_QUIET_IDLE_AFTER ? TUNER_QUIET_SLOW_CHECK : TUNER_QUIET_IDLE_CHECK;
    }
    const double TUNER_CAMERA_FAST_HOLD = 0.25;
    const double TUNER_EYE_SETTLE = 8.0;
    const double TUNER_EYE_SETTLE_MIN = 0.25;
    const double TUNER_EYE_SETTLE_MAX = 1.0;
    const double TUNER_SUSTAINED_GAP = 0.2;
    const int TUNER_GRID_HALF = 60;
    const int TUNER_GRID_MAJOR = 10;
    const string TUNER_CAMERA_NAME = "_SaturaTunerCamera";
    const string TUNER_GRID_NAME = "_SaturaTunerGrid";
    const string TUNER_UNLIT_NAME = "_SaturaTunerUnlit";
    const string TUNER_RT_NAME = "_SaturaTunerTarget";
    static readonly Color TunerClear = new Color32(0x1e, 0x20, 0x25, 255);

    [Serializable]
    class TunerComponentArgs
    {
        public string type;
        public int index;
        public bool hasFields;
        public string[] fields;
        public string[] exclude;
    }

    [Serializable]
    class TunerObjectArgs
    {
        public string path;
        public string scene;
        public string label;
        public bool all;
        public bool children;
        public TunerComponentArgs[] components;
        public string[] exclude;
        [NonSerialized] public int nth;
    }

    [Serializable]
    class TunerUiArgs
    {
        public string path;
        public string scene;
    }

    [Serializable]
    class TunerAssetArgs
    {
        public string path;
        public string label;
        public bool hasFields;
        public string[] fields;
        public string[] exclude;
    }

    [Serializable]
    class TunerOpenArgs
    {
        public string kind;
        public string path;
        public string scene;
        public string id;
        public bool ghost;
    }

    [Serializable]
    class TunerTransformItem
    {
        public string id;
        public float[] position;
        public float[] rotation;
        public float[] localScale;
        public float fov;
    }

    [Serializable]
    class TunerCameraArgs
    {
        public float[] position;
        public float[] lookAt;
    }

    [Serializable]
    class TunerArgs
    {
        public string session;
        public TunerObjectArgs[] objects;
        public TunerStateArgs[] states;
        public TunerAssetArgs[] assets;
        public TunerOpenArgs[] opened;
        public TunerUiArgs ui;
        public TunerCameraArgs camera;
        public string state;
        public string activeState;
        public TunerOverrideArgs[] overrides;
        public string id;
        public string component;
        public string prop;
        public string field;
        public string op;
        public string value;
        public int index = -1;
        public float[] position;
        public float[] rotation;
        public float[] localScale;
        public float fov;
        public float ortho;
        public float near;
        public float far;
        public int width;
        public int height;
        public float points;
        public bool hidden;
        public bool final;
        public int seq;
        public int cseq;
        public string kind;
        public string path;
        public string scene;
        public string label;
        public string method;
        public string type;
        public string asset;
        public AnimatorViewSpec animator;
        public TunerTransformItem[] items;
        public string[] ids;
        public bool ghost;
        public string[] prefabs;
        public string query;
    }

    [Serializable]
    class TunerCommand
    {
        public int id;
        public TunerArgs args;
    }

    const double TUNER_CAMERA_WAIT = 1.0;

    class TunerSession
    {
        public string Name;
        public bool AppCamera;
        public double StartedAt;
        public ControlClient Client;
        public TunerObjectArgs[] Specs;
        public GameObject[] Objects;
        public bool[] Found;
        public List<TunerStateDef> States = new List<TunerStateDef>();
        public int Active = -1;
        public readonly List<TunerFrozen> Frozen = new List<TunerFrozen>();
        public readonly List<TunerEntry> Entries = new List<TunerEntry>();
        public bool Ui;
        public bool Scene;
        public string CanvasView = "";
        public string CanvasViewScene = "";
        public string SceneFilter;
        public int SceneBoundsGen = -1;
        public double SceneBoundsAt;
        public bool SceneBoundsOk;
        public bool SceneNoRenderers;
        public Bounds SceneBoundsValue;
        public ParticleSystem SimPs;
        public ParticleSystem PlayPs;
        public double SimAt;
        public bool SimPaused;
        public bool SimStopped;
        public float SimSpeed = 1f;
        public bool ParticlesSent;
        public ulong ParticlesKey;
        public double NextParticles;
        public List<TunerEntry> Members = new List<TunerEntry>();
        public double IconsSentAt = -1;
        public double IconsListAt = -1;
        public int IconsGen = -1;
        public ulong IconsSig;
        public readonly List<KeyValuePair<TunerEntry, string>> IconList = new List<KeyValuePair<TunerEntry, string>>();
        public Dictionary<string, TunerEntry> MemberById = new Dictionary<string, TunerEntry>();
        public Dictionary<GameObject, TunerEntry> MemberByGo = new Dictionary<GameObject, TunerEntry>();
        public readonly Dictionary<string, string> MemberPaths = new Dictionary<string, string>();
        public ulong MembersHash;
        public int WalkGen;
        public readonly HashSet<TunerEntry> MemberMarks = new HashSet<TunerEntry>();
        public readonly HashSet<TunerEntry> MemberDeep = new HashSet<TunerEntry>();
        public bool MembersRebuild;
        public bool MembersPlaying;
        public int MembersStructGen = -1;
        public int CheckSentAt;
        public int CheckAllAt;
        public double MembersCheckNext;
        public double MembersRolledAt;
        public double MembersScenesAt;
        public readonly List<TunerSceneSnap> MemberScenes = new List<TunerSceneSnap>();
        public int[] TargetHier = new int[0];
        public int TreeGen;
        public int TreeSent = -1;
        public int MembersGen = -1;
        public double MembersAt = -1;
        public int PrefabGen = -1;
        public bool MembersCapped;
        public int MembersLevels;
        public bool MembersLazy;
        public List<TunerEntry> Sent = new List<TunerEntry>();
        public ulong SentHash;
        public HashSet<string> TreeOpen = new HashSet<string>();
        public string TreeQuery;
        public string RevealPath;
        public string RevealMissing;
        public string RevealScene;
        public string WatchEntry;
        public string[] WatchIds = new string[0];
        public string LiveObjects;
        public double NextLiveObjects;
        public string[] Prefabs;
        public bool PrefabTuner;
        public string UnsavedJson;
        public HashSet<string> ScopeDeps;
        public double ScopeDepsAt;
        public int ScopeDepsGen;
        public string PrefabError;
        public string ActivePrefab;
        public readonly Dictionary<string, TunerTrack> Tracks = new Dictionary<string, TunerTrack>();
        public bool TracksStale = true;
        public double NextTrack;
        public double NextSweep;
        public string Inspected;
        public bool Dragging;
        public double DragAt;
        public int TransformAck;
        public double TransformRecvMs;
        public readonly List<TunerSetUndo> SetUndo = new List<TunerSetUndo>();
        public bool PauseApplied;
        public bool PauseRestore;
        public string NameJson;
        public Mesh GridMesh;
        public Material GridMat;
        public Material Unlit;
        public CommandBuffer Cmd;
        public MaterialPropertyBlock Mpb;
        public RenderTexture Target;
        public RenderTexture Resolve;
        public RenderTexture SrpTarget;
        public bool CompileStale;
        public readonly List<TunerRend> Rends = new List<TunerRend>();
        public readonly Dictionary<Renderer, TunerRend> RendByR = new Dictionary<Renderer, TunerRend>();
        public readonly List<LODGroup> Lods = new List<LODGroup>();
        public readonly List<LOD[]> LodLevels = new List<LOD[]>();
        public int LodsCount = -1;
        public double LodsAt = -1;
        public int LodsGen = -1;
        public int RendsGen;
        public readonly List<TunerRend[][]> LodRends = new List<TunerRend[][]>();
        public readonly List<int> LodActive = new List<int>();
        public readonly List<TunerLodPlace> LodPlace = new List<TunerLodPlace>();
        public int LodPlaceAt;
        public TunerLodScan LodScan;
        public int HeavySkips;
        public ulong RendSig;
        public readonly List<TunerRend> Skins = new List<TunerRend>();
        public int SkinsGen = -1;
        public int SkinsCount = -1;
        public int IconsWalk = -1;
        public readonly List<TunerDraw> Draws = new List<TunerDraw>();
        public readonly List<Renderer> LiveRends = new List<Renderer>();
        public readonly List<Component> LiveDrivers = new List<Component>();
        public readonly HashSet<Component> LiveDriverSet = new HashSet<Component>(new TunerRefEq<Component>());
        public int[][] ObjRends;
        public int DrawsGen;
        public bool CacheDirty = true;
        public int HierarchyGen;
        public double LastRebuild;
        public ulong LastHash;
        public ulong GeomHash;
        public int MatCheckGen = -1;
        public int LivePhase;
        public int MatCheckRends;
        public int MatCheckAt;
        public double GeomAt = -1;
        public double NextFrame;
        public double NextCheck;
        public double ChangedAt;
        public double RenderedAt = -1;
        public int CheckEvents;
        public int HashEvents = -1;
        public ulong ContentHash;
        public ulong ChangedHash;
        public int Watch = -1;
        public double NextLive;
        public int LiveSampleGen;
        public ulong LivePoseHash;
        public ulong[] PoseNow;
        public ulong[] PoseSent;
        public ulong[] FramePoseSent;
        public string[] DescCache;
        public ulong[] DescKey;
        public string LiveObject;
        public readonly Dictionary<Component, SerializedObject> Serialized = new Dictionary<Component, SerializedObject>();
        public ulong ShadowKey;
        public int ShadowState;
        public Vector3 ShadowPoint;
        public Vector3 ShadowNormal;
        public string ShadowKind;
        public Vector3 CamPos = new Vector3(0f, 2f, -6f);
        public Quaternion CamRot = Quaternion.identity;
        public float Fov = 50f;
        public float Ortho;
        public bool OrthoClip;
        public float Near = TUNER_NEAR;
        public float Far = TUNER_FAR;
        public int UiGen;
        public bool HasText;
        public bool RealText;
        public string TextReport;
        public readonly Dictionary<Sprite, TunerSpriteGeo> SpriteGeo = new Dictionary<Sprite, TunerSpriteGeo>();
        public readonly Dictionary<Component, TunerTileGeo> TileGeo = new Dictionary<Component, TunerTileGeo>();
        public int TileGeoGen;
        public double CamMovedAt = -1;
        public double EyeSettleAt;
        public int CamSeq;
        public double CamRecvMs;
        public double RenderStartMs;
        public double HashedAt = -1;
        public int Width = 960;
        public float Ppp;
        public int Height = 540;
        public bool Dirty = true;
        public bool Hidden;
        public double LastResolve;
        public double LastState;
        public bool StatePending;
        public bool LastPlaying;
        public readonly List<TunerEditBase> EditBases = new List<TunerEditBase>();
        public readonly HashSet<GameObject> EditObjects = new HashSet<GameObject>();
        public List<TunerEditRow> EditRows = new List<TunerEditRow>();
        public string EditSig = "";
        public bool EditsDirty;
        public TunerEditTrail Trail = new TunerEditTrail();
        public double NextEditDiff;
        public int Seq;
        public volatile bool Ended;
        public TunerSurface Surface;
    }

    static readonly Dictionary<string, TunerSession> _tuners = new Dictionary<string, TunerSession>();
    static Action<string> _tunerSink;
    static Scene _tunerDdol;
    static bool _tunerDdolKnown;

    static bool TunerGraphics => SystemInfo.graphicsDeviceType != GraphicsDeviceType.Null;

    [InitializeOnLoadMethod]
    static void InitTuner()
    {
        if (Inert) return;
        EditorApplication.update += TunerTick;
        EditorApplication.playModeStateChanged += OnTunerPlayMode;
        AssemblyReloadEvents.beforeAssemblyReload += OnTunerBeforeReload;
        EditorApplication.quitting += OnTunerQuitting;
        EditorApplication.hierarchyChanged += OnTunerHierarchyChanged;
        SweepStaleTunerObjects();
    }

    static void OnTunerBeforeReload()
    {
        KeepTunerCloneWatchOverReload();
        EndAllTuners("domainReload");
        StopTunerWake();
        RestoreTunerTickRate();
        ReleaseTunerWakeTimer();
    }

    static void OnTunerHierarchyChanged()
    {
        if (EditorApplication.isPlaying)
        {
            _tunerHierarchyPending = true;
            return;
        }
        _tunerHierarchyGen++;
    }

    const double TUNER_ROOTS_POLL = 0.25;
    const double TUNER_ROOTS_POLL_PLAY = 0.5;
    static double _tunerRootsPollAt = -1;
    static ulong _tunerRootsSig;
    static readonly List<GameObject> _tunerRootsPollTmp = new List<GameObject>();

    static void PollTunerRoots(double now, bool playing)
    {
        if (_tunerRootsPollAt >= 0 && now - _tunerRootsPollAt < (playing ? TUNER_ROOTS_POLL_PLAY : TUNER_ROOTS_POLL)) return;
        _tunerRootsPollAt = now;
        ulong h = 14695981039346656037UL;
        foreach (var sc in TunerScenes())
        {
            h = TunerMix(h, (uint)sc.GetHashCode());
            h = TunerMix(h, (uint)sc.rootCount);
            sc.GetRootGameObjects(_tunerRootsPollTmp);
            foreach (var go in _tunerRootsPollTmp)
            {
                if (go == null) continue;
                h = TunerMix(h, (uint)go.GetHashCode());
                h = TunerMix(h, (uint)go.transform.hierarchyCount);
            }
        }
        _tunerRootsPollTmp.Clear();
        if (h == _tunerRootsSig) return;
        bool first = _tunerRootsSig == 0;
        _tunerRootsSig = h;
        if (first) return;
        SaturaDebug.Log("[Tuner] scene objects were added, removed or moved between roots");
        OnTunerHierarchyChanged();
    }

    static void FlushTunerHierarchy(double now, bool playing)
    {
        if (!_tunerHierarchyPending || (playing && now - _tunerHierarchyFlushedAt < TUNER_PLAY_HIERARCHY_INTERVAL)) return;
        _tunerHierarchyPending = false;
        _tunerHierarchyFlushedAt = now;
        _tunerHierarchyGen++;
    }

    static void OnTunerQuitting()
    {
        EndAllTuners("quit");
        RestoreTunerTickRate();
        ReleaseTunerWakeTimer();
    }

    static void SweepStaleTunerObjects()
    {
        try
        {
            foreach (var cam in Resources.FindObjectsOfTypeAll<Camera>())
                if (cam != null && cam.name == TUNER_CAMERA_NAME && (cam.hideFlags & HideFlags.DontSave) != 0)
                    UnityEngine.Object.DestroyImmediate(cam.gameObject);
            foreach (var rt in Resources.FindObjectsOfTypeAll<RenderTexture>())
                if (rt != null && rt.name == TUNER_RT_NAME)
                    UnityEngine.Object.DestroyImmediate(rt);
        }
        catch { }
    }

    static void OnTunerPlayMode(PlayModeStateChange state)
    {
        _tunerDdolKnown = false;
        if (state == PlayModeStateChange.ExitingPlayMode)
        {
            foreach (var s in new List<TunerSession>(_tuners.Values))
            {
                FlushTunerTracks(s);
                DropTunerSceneTracks(s);
                try { ReleaseTunerFreezes(s); }
                catch (Exception e) { Debug.LogException(e); }
                s.SetUndo.Clear();
            }
            return;
        }
        if (state != PlayModeStateChange.EnteredPlayMode && state != PlayModeStateChange.EnteredEditMode) return;
        foreach (var s in new List<TunerSession>(_tuners.Values))
        {
            for (int i = 0; i < s.Objects.Length; i++) s.Objects[i] = null;
            foreach (var e in s.Entries) if (!e.Asset) e.Go = null;
            ResolveTunerObjects(s);
            ResolveTunerEntries(s);
            RebuildTunerMembers(s);
            if (state == PlayModeStateChange.EnteredPlayMode) EnterTunerState(s, s.Active < 0 ? 0 : s.Active);
            DropTunerSceneTracks(s);
            s.Dragging = false;
            s.StatePending = true;
            s.Dirty = true;
            s.CacheDirty = true;
            SaturaDebug.Log("[Tuner] " + s.Name + " now in " + (state == PlayModeStateChange.EnteredPlayMode ? "Play" : "Edit") + " Mode ("
                + CountFound(s) + " of " + s.Specs.Length + " objects found)");
        }
    }

    static void HandleTunerCommand(int id, string cmd, string line, ControlClient from)
    {
        TunerCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerCommand>(line); }
        catch (Exception e)
        {
            TunerResult(from, id, "bad arguments: " + e.Message, null);
            return;
        }
        var a = parsed != null ? parsed.args : null;
        if (a == null || string.IsNullOrEmpty(a.session))
        {
            TunerResult(from, id, "a session is required", null);
            return;
        }
        try
        {
            switch (cmd)
            {
                case "tuner/start":
                    TunerStart(id, a, from);
                    break;
                case "tuner/refresh":
                    TunerRefresh(id, a, from);
                    break;
                case "tuner/camera":
                    TunerCamera(id, a, from);
                    break;
                case "tuner/edit":
                    TunerEdit(id, a, from);
                    break;
                case "tuner/transform":
                    TunerTransform(id, a, from);
                    break;
                case "tuner/select":
                    TunerSelect(id, a, from);
                    break;
                case "tuner/reset":
                    TunerReset(id, a, from);
                    break;
                case "tuner/watch":
                {
                    var sw = FindTuner(a.session);
                    if (sw != null)
                    {
                        sw.Inspected = a.id;
                        TouchTunerMember(sw, a.id);
                        sw.WatchIds = CleanTunerIds(a.ids);
                        foreach (var wid in sw.WatchIds) TouchTunerMember(sw, wid);
                        BaseTunerEdits(sw, a.id);
                        foreach (var wid in sw.WatchIds) BaseTunerEdits(sw, wid);
                        UpdateTunerSent(sw);
                        sw.LiveObjects = null;
                        sw.NextLiveObjects = 0;
                    }
                    TunerWatch(id, a, from);
                    break;
                }
                case "tuner/open":
                    TunerOpen(id, a, from);
                    break;
                case "tuner/close":
                    TunerClose(id, a, from);
                    break;
                case "tuner/button":
                    TunerButton(id, a, from);
                    break;
                case "tuner/tree":
                    TunerTree(a);
                    break;
                case "tuner/visibility":
                    TunerVisibility(id, a, from);
                    break;
                case "tuner/stop":
                    TunerStop(id, a, from);
                    break;
                case "tuner/canvases":
                    TunerCanvases(id, from);
                    break;
                case "tuner/particles":
                    TunerParticlesCommand(id, a, from);
                    break;
                default:
                    if (!HandleTunerSave(id, cmd, a, from) && !HandleTunerView(id, cmd, line, from) && !HandleTunerAnnotations(id, cmd, line, from) && !HandleTunerRect(id, cmd, line, from) && !HandleTunerHandles(id, cmd, line, from) && !HandleTunerAnimator(id, cmd, line, from) && !HandleTunerStaging(id, cmd, line, from) && !HandleTunerHierarchy(id, cmd, line, from) && !HandleTunerCanvasView(id, cmd, line, from))
                        TunerResult(from, id, "unknown command: " + cmd, null);
                    break;
            }
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            TunerResult(from, id, e.GetType().Name + ": " + e.Message, null);
        }
    }

    static void TunerStart(int id, TunerArgs a, ControlClient from)
    {
        HealTunerEditorStyles();
        TunerSession old;
        if (_tuners.TryGetValue(a.session, out old)) EndTuner(old, "restart");
        var notOpen = a.kind == "scene" ? TunerSceneNotOpen(a.scene) : null;
        if (notOpen != null)
        {
            TunerResult(from, id, notOpen, null);
            return;
        }
        var s = new TunerSession
        {
            Name = a.session,
            NameJson = JStr(a.session),
            Client = from,
            LastPlaying = EditorApplication.isPlaying
        };
        BuildTunerStates(s, a);
        s.Objects = new GameObject[s.Specs.Length];
        s.Found = new bool[s.Specs.Length];
        s.Ui = a.kind == "ui" && s.Specs.Length > 0;
        if (s.Ui) s.Specs[0].children = true;
        s.Scene = a.kind == "scene" || a.kind == "prefabs";
        if (a.kind == "scene" && !string.IsNullOrEmpty(a.scene)) s.SceneFilter = a.scene;
        s.PrefabTuner = a.kind == "prefabs";
        if (a.kind == "prefabs") OpenTunerPrefabs(s, a.prefabs);
        ResolveTunerObjects(s);
        SetTunerAnimatorSpec(s, a.animator);
        foreach (var asset in a.assets ?? new TunerAssetArgs[0])
            if (asset != null) TunerFilterAssetEntry(AddTunerAssetEntry(s, asset.path, asset.label, false), asset);
        foreach (var o in a.opened ?? new TunerOpenArgs[0])
        {
            if (o == null || string.IsNullOrEmpty(o.path)) continue;
            if (o.kind == "asset") AddTunerAssetEntry(s, o.path, null, true);
            else AddTunerOpenedEntry(s, o.path, o.scene, o.id, o.ghost);
        }
        ResolveTunerEntries(s);
        int active = FindTunerState(s, a.activeState);
        if (active < 0) active = 0;
        s.Active = active;
        RebuildTunerMembers(s);
        int restored = RestoreTunerOverrides(s, a.overrides);
        s.StartedAt = EditorApplication.timeSinceStartup;
        _tuners[s.Name] = s;
        if (old != null && !EditorApplication.isPlaying) CarryTunerEdits(old, s);
        StartTunerCloneWatch();
        EnterTunerState(s, active);
        SettleTunerScene();
        TunerTrackAll(s);
        var st = s.States[s.Active];
        InitTunerCamera(s, st.Camera ?? a.camera);
        var canvas = TunerUiCanvas(s);
        SaturaDebug.Log("[Tuner] start " + s.Name + " in " + (EditorApplication.isPlaying ? "Play" : "Edit") + " Mode ("
            + (s.Ui ? "UI " + TunerSpecPath(s.Specs[0]) + (canvas != null ? " on canvas " + canvas.name : "") + ", " : "")
            + (s.Scene ? (s.SceneFilter != null ? "scene " + s.SceneFilter : "whole scene") + ", " : "")
            + s.Specs.Length + " objects, " + CountFound(s) + " found, " + s.Members.Count + " in subtrees, "
            + s.Entries.Count + " other entr" + (s.Entries.Count == 1 ? "y" : "ies") + ", "
            + s.States.Count + " state" + (s.States.Count == 1 ? "" : "s") + ", active " + st.Name
            + (restored > 0 ? ", " + restored + " restored override" + (restored == 1 ? "" : "s") : "")
            + (TunerGraphics ? "" : ", no graphics") + ")");
        TunerResult(from, id, null, "\"state\":" + DescribeTunerState(s, true));
    }

    static void TunerRefresh(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        ResolveTunerObjects(s);
        ResolveTunerEntries(s);
        RebuildTunerMembers(s);
        s.TracksStale = true;
        s.Dirty = true;
        s.CacheDirty = true;
        TunerResult(from, id, null, "\"state\":" + DescribeTunerState(s, true));
    }

    static void TunerCamera(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        var wasPos = s.CamPos;
        var wasRot = s.CamRot;
        float wasFov = s.Fov, wasOrtho = s.Ortho;
        Vector3 pos;
        if (ToVec3(a.position, out pos)) s.CamPos = pos;
        Quaternion rot;
        if (ToQuat(a.rotation, out rot)) s.CamRot = rot;
        if (a.fov > 0.1f && a.fov < 179f) s.Fov = a.fov;
        s.Ortho = a.ortho > 0f && a.ortho < 1e7f ? a.ortho : 0f;
        bool clip = a.near > 0f && a.far > a.near && a.far < 1e7f;
        if (clip)
        {
            s.Near = a.near;
            s.Far = a.far;
        }
        s.OrthoClip = s.Ortho > 0f && clip;
        s.AppCamera = true;
        if (a.cseq > 0)
        {
            s.CamSeq = a.cseq;
            s.CamRecvMs = EpochMs();
        }
        if (s.CamPos != wasPos || s.CamRot != wasRot || s.Fov != wasFov || s.Ortho != wasOrtho)
        {
            s.CamMovedAt = EditorApplication.timeSinceStartup;
            NoteTunerActivity();
        }
        NoteTunerProjection(s);
        if (a.width > 0 && a.height > 0) ClampTunerSize(a.width, a.height, out s.Width, out s.Height);
        if (a.points >= 1f) s.Ppp = s.Width / a.points;
        s.Dirty = true;
        TunerResult(from, id, null, null);
    }

    static void TunerEdit(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        int i = TunerIndex(s, a.id);
        var entry = i < 0 ? FindTunerEntry(s, a.id) : null;
        if (i < 0 && entry == null)
        {
            TunerResult(from, id, "no object '" + a.id + "' in session " + s.Name, null);
            return;
        }
        if (i >= 0 && !TunerInActive(s, i))
        {
            TunerResult(from, id, "object '" + a.id + "' is not part of state " + s.States[s.Active].Name, null);
            return;
        }
        var prop = !string.IsNullOrEmpty(a.prop) ? a.prop : a.field;
        string error = ApplyTunerEdit(s, a.id, i, a.component, prop, a.op, a.value, a.index);
        if (error == null)
        {
            FlushTunerTracks(s);
            s.Dirty = true;
            s.StatePending = true;
            Debug.Log("[Tuner] " + (string.IsNullOrEmpty(a.op) ? "set" : a.op) + " " + TunerEntryPath(s, a.id) + " "
                + a.component + "." + prop + (string.IsNullOrEmpty(a.value) ? "" : " = " + a.value)
                + (EditorApplication.isPlaying ? "" : " (Edit Mode, with Undo)"));
        }
        TunerResult(from, id, error, "\"object\":" + DescribeTunerEntry(s, a.id));
    }

    static string ApplyTunerEdit(TunerSession s, string entry, int i, string key, string prop, string op, string value, int index)
    {
        var target = TunerTrackTargetFor(s, entry, key);
        if (target == null)
        {
            var go = TunerEntryObject(s, entry);
            if (go == null && FindTunerEntry(s, entry) == null && i >= 0) return "object '" + s.Specs[i].path + "' is not in the loaded scenes";
            return "component '" + key + "' is not tunable on " + TunerEntryPath(s, entry);
        }
        if (TunerReadOnlyObject(target)) return TunerEntryPath(s, entry) + " is read-only";
        if (i >= 0)
        {
            var spec = TunerSpecFor(s.Specs[i], s.Objects[i], target);
            if (spec != null && !TunerFieldAllowed(target, spec.fields, prop)) return "field '" + prop + "' of " + key + " is not tunable";
        }
        if (!TunerFieldAllowed(target, null, prop)) return "field '" + prop + "' of " + key + " is not tunable";
        var t = EnsureTunerTrack(s, entry, key);
        if (EditorApplication.isPlaying) RebaseTunerTrack(s, t, prop);
        else BaseTunerEdits(s, entry);
        Undo.IncrementCurrentGroup();
        Undo.SetCurrentGroupName("Tuner " + key + "." + prop);
        var err = ApplyTunerEditTo(target, prop, op, value, index);
        Undo.IncrementCurrentGroup();
        if (err != null) return err;
        MarkTunerSceneDirty(target);
        if (t != null) MarkTunerTrack(t, prop);
        return null;
    }

    static void TunerTransform(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        var items = a.items != null && a.items.Length > 0
            ? a.items
            : new[] { new TunerTransformItem { id = a.id, position = a.position, rotation = a.rotation, localScale = a.localScale, fov = a.fov } };
        bool playing = EditorApplication.isPlaying;
        s.DragAt = EditorApplication.timeSinceStartup;
        if (!s.Dragging)
        {
            s.Dragging = true;
            Undo.IncrementCurrentGroup();
            var first = items.Length == 1 ? TunerEntryObject(s, items[0].id) : null;
            Undo.SetCurrentGroupName(items.Length == 1 ? "Tuner move " + (first != null ? first.name : items[0].id) : "Tuner move " + items.Length + " objects");
        }
        string error = null;
        var moved = new List<string>();
        var keyed = new List<KeyValuePair<TunerTransformItem, Transform>>();
        if (!playing)
            foreach (var it in items)
                if (it != null) BaseTunerEdits(s, it.id);
        foreach (var it in items)
        {
            if (it == null) continue;
            string objPath;
            Transform t;
            var err = ApplyTunerTransform(s, it, playing, a.final, out objPath, out t);
            if (err != null)
            {
                if (error == null) error = err;
                continue;
            }
            moved.Add(objPath + " to " + TunerTuple(t.localPosition.x, t.localPosition.y, t.localPosition.z));
            if (a.final && !playing) keyed.Add(new KeyValuePair<TunerTransformItem, Transform>(it, t));
        }
        foreach (var kv in keyed) TunerTransformRecordSame(kv.Key, kv.Value);
        if (a.seq > s.TransformAck)
        {
            s.TransformAck = a.seq;
            s.TransformRecvMs = EpochMs();
        }
        if (a.final)
        {
            s.Dragging = false;
            Undo.IncrementCurrentGroup();
            FlushTunerTracks(s);
            if (moved.Count > 0)
                Debug.Log("[Tuner] moved " + string.Join(", ", moved) + (playing ? "" : " (Edit Mode, with Undo)"));
        }
        s.Dirty = true;
        s.StatePending = true;
        TunerResult(from, id, error, null);
    }

    static void TunerTransformRecordSame(TunerTransformItem it, Transform t)
    {
        Vector3 v;
        Quaternion q;
        try
        {
            if (ToVec3(it.position, out v) && !(t is RectTransform)) TunerAnimRecordSame(t, "m_LocalPosition");
            if (ToQuat(it.rotation, out q)) TunerAnimRecordSame(t, "m_LocalRotation");
            if (ToVec3(it.localScale, out v)) TunerAnimRecordSame(t, "m_LocalScale");
            var cam = it.fov > 1f && it.fov < 179f ? t.GetComponent<Camera>() : null;
            if (cam != null && !cam.orthographic) TunerAnimRecordSame(cam, "field of view");
        }
        catch (Exception e) { Debug.LogWarning("[Tuner] animator: could not key " + t.name + ": " + e.Message); }
    }

    static string ApplyTunerTransform(TunerSession s, TunerTransformItem it, bool playing, bool final, out string objPath, out Transform t)
    {
        objPath = null;
        t = null;
        int i = TunerIndex(s, it.id);
        var entry = i < 0 ? FindTunerEntry(s, it.id) : null;
        if (i < 0 && (entry == null || entry.Asset)) return "no object '" + it.id + "' in session " + s.Name;
        if (i >= 0 && !TunerInActive(s, i)) return "object '" + it.id + "' is not part of state " + s.States[s.Active].Name;
        var go = i >= 0 ? s.Objects[i] : entry.Go;
        objPath = i >= 0 ? TunerSpecPath(s.Specs[i]) : entry.Path;
        if (go == null) return "object '" + objPath + "' is not in the loaded scenes";
        if (TunerReadOnlyObject(go)) return objPath + " is read-only";
        t = go.transform;
        var rt = t as RectTransform;
        var spec = i >= 0 ? s.Specs[i] : null;
        string key;
        if (spec == null) key = TunerKeyOf(go, t);
        else
        {
            key = TunerSpecAll(spec) || TunerSpecFor(spec, go, t) != null ? TunerKeyOf(go, t) : null;
            if (key != null && TunerSpecAll(spec) && TunerFilterExcludes(spec.exclude, key)) key = null;
        }
        if (key == null) return "the Transform of " + objPath + " is not tunable";
        TouchTunerMember(s, it.id);
        if (s.TracksStale) TunerTrackAll(s);
        var track = EnsureTunerTrack(s, it.id, key);
        Undo.RecordObject(t, "Tuner move " + go.name);
        Vector3 v;
        Quaternion q;
        if (ToVec3(it.position, out v))
        {
            if (rt != null)
            {
                if (playing)
                {
                    RebaseTunerTrack(s, track, "m_AnchoredPosition");
                    RebaseTunerTrack(s, track, "m_LocalPosition.z");
                }
                t.position = v;
                rt.anchoredPosition = rt.anchoredPosition;
                if (track != null)
                {
                    MarkTunerTrack(track, "m_AnchoredPosition");
                    MarkTunerTrack(track, "m_LocalPosition.z");
                }
            }
            else
            {
                if (playing) RebaseTunerTrack(s, track, "m_LocalPosition");
                t.position = v;
                if (track != null) MarkTunerTrack(track, "m_LocalPosition");
            }
        }
        if (ToQuat(it.rotation, out q))
        {
            if (playing) RebaseTunerTrack(s, track, "m_LocalRotation");
            t.rotation = q;
            if (track != null) MarkTunerTrack(track, "m_LocalRotation");
        }
        if (ToVec3(it.localScale, out v))
        {
            if (playing) RebaseTunerTrack(s, track, "m_LocalScale");
            t.localScale = v;
            if (track != null) MarkTunerTrack(track, "m_LocalScale");
        }
        var cam = it.fov > 1f && it.fov < 179f ? t.GetComponent<Camera>() : null;
        if (cam != null && !cam.orthographic && Mathf.Abs(cam.fieldOfView - it.fov) > 0.01f)
        {
            Undo.RecordObject(cam, "Align With View");
            cam.fieldOfView = it.fov;
        }
        MarkTunerSceneDirty(t);
        if (track != null && track.Dirty) DiffTunerTrack(s, track);
        return null;
    }

    static void TunerVisibility(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        if (s.Hidden != a.hidden)
        {
            s.Hidden = a.hidden;
            if (!s.Hidden)
            {
                s.Dirty = true;
                s.NextLive = 0;
                s.LiveObject = null;
                SignalEditorTick();
            }
        }
        TunerResult(from, id, null, null);
    }

    static void TunerStop(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        TunerResult(from, id, null, null);
        if (s != null)
        {
            SaturaDebug.Log("[Tuner] stop " + s.Name);
            EndTuner(s, "stop");
        }
    }

    static TunerSession FindTuner(string name)
    {
        TunerSession s;
        return name != null && _tuners.TryGetValue(name, out s) ? s : null;
    }

    static int TunerIndex(TunerSession s, string id)
    {
        if (string.IsNullOrEmpty(id) || id[0] != 'o') return -1;
        int i;
        if (!int.TryParse(id.Substring(1), System.Globalization.NumberStyles.None, Inv, out i)) return -1;
        return i >= 0 && i < s.Specs.Length ? i : -1;
    }

    static int CountFound(TunerSession s)
    {
        int n = 0;
        foreach (var f in s.Found) if (f) n++;
        return n;
    }

    static void EndAllTuners(string reason)
    {
        if (_tuners.Count == 0) return;
        foreach (var s in new List<TunerSession>(_tuners.Values)) EndTuner(s, reason);
    }

    static void EndTuner(TunerSession s, string reason)
    {
        TunerSession cur;
        if (_tuners.TryGetValue(s.Name, out cur) && cur == s) _tuners.Remove(s.Name);
        s.Ended = true;
        try { ReleaseTunerFreezes(s); }
        catch (Exception e) { Debug.LogException(e); }
        StopTunerParticles(s);
        EndTunerAnimator(s, reason);
        ReleaseTunerPrefabs(s, reason);
        DestroyTunerResources(s);
        if (_tuners.Count == 0) ReleaseTunerShared();
        if (reason != null && reason != "restart")
            TunerEmit(s.Client, "{\"type\":\"event\",\"event\":\"tuner/ended\",\"session\":" + JStr(s.Name)
                + ",\"reason\":" + JStr(reason) + "}");
    }

    static void DestroyTunerResources(TunerSession s)
    {
        DestroyTunerView(s);
        ReleaseTunerSurface(s);
        ReleaseTunerTexture(ref s.Target);
        ReleaseTunerTexture(ref s.Resolve);
        ReleaseTunerTexture(ref s.SrpTarget);
        if (s.GridMesh != null) UnityEngine.Object.DestroyImmediate(s.GridMesh);
        if (s.GridMat != null) UnityEngine.Object.DestroyImmediate(s.GridMat);
        if (s.Unlit != null) UnityEngine.Object.DestroyImmediate(s.Unlit);
        if (s.Cmd != null) s.Cmd.Release();
        ClearTunerCache(s);
        ClearTunerSpriteGeo(s);
        ClearTunerTileGeo(s, false);
        ClearTunerSerialized(s);
        s.GridMesh = null;
        s.GridMat = null;
        s.Unlit = null;
        s.Cmd = null;
        s.CacheDirty = true;
    }

    static void ReleaseTunerTexture(ref RenderTexture rt)
    {
        if (rt == null) return;
        if (RenderTexture.active == rt) RenderTexture.active = null;
        rt.Release();
        UnityEngine.Object.DestroyImmediate(rt);
        rt = null;
    }

    static void TunerResult(ControlClient to, int id, string error, string payload)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"type\":\"result\",\"id\":").Append(id.ToString(Inv))
          .Append(",\"status\":").Append(error == null ? "\"completed\"" : "\"error\"");
        if (error != null) sb.Append(",\"error\":").Append(JStr(error));
        if (!string.IsNullOrEmpty(payload)) sb.Append(',').Append(payload);
        sb.Append('}');
        TunerEmit(to, sb.ToString());
    }

    static bool TunerEmit(ControlClient to, string json)
    {
        if (to == null)
        {
            var sink = _tunerSink;
            if (sink == null) return false;
            try { sink(json); }
            catch { return false; }
            return true;
        }
        bool ok = CtrlSendLine(to, json, out int sent);
        TpSent(json, sent);
        return ok;
    }

    static void ClampTunerSize(int w, int h, out int ow, out int oh)
    {
        float scale = 1f;
        int longSide = Math.Max(w, h);
        if (longSide > TUNER_MAX_SIDE) scale = (float)TUNER_MAX_SIDE / longSide;
        ow = Mathf.Clamp(Mathf.RoundToInt(w * scale), TUNER_MIN_SIDE, TUNER_MAX_SIDE);
        oh = Mathf.Clamp(Mathf.RoundToInt(h * scale), TUNER_MIN_SIDE, TUNER_MAX_SIDE);
    }

    static bool ToVec3(float[] v, out Vector3 r)
    {
        r = default;
        if (v == null || v.Length != 3) return false;
        r = new Vector3(v[0], v[1], v[2]);
        return !float.IsNaN(r.x) && !float.IsNaN(r.y) && !float.IsNaN(r.z);
    }

    static bool ToQuat(float[] v, out Quaternion r)
    {
        r = Quaternion.identity;
        if (v == null || v.Length != 4) return false;
        float mag = Mathf.Sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2] + v[3] * v[3]);
        if (mag < 1e-6f || float.IsNaN(mag)) return false;
        r = new Quaternion(v[0] / mag, v[1] / mag, v[2] / mag, v[3] / mag);
        return true;
    }

    static void InitTunerCamera(TunerSession s, TunerCameraArgs cam)
    {
        Vector3 pos, look;
        if (cam != null && ToVec3(cam.position, out pos) && ToVec3(cam.lookAt, out look))
        {
            s.CamPos = pos;
            s.CamRot = (look - pos).sqrMagnitude > 1e-8f ? Quaternion.LookRotation(look - pos) : Quaternion.identity;
            return;
        }
        Bounds total = default;
        Renderer biggest = null;
        bool any = s.Scene && TunerSceneBounds(s, out total, out biggest);
        if (s.Scene)
            SaturaDebug.Log("[Tuner] framing " + s.Name + ": " + (any ? "center " + total.center + " size " + total.size : "nothing to frame")
                + (biggest != null ? ", largest " + TunerObjectPath(biggest.gameObject) + " (" + biggest.GetType().Name + " " + biggest.bounds.size + ")" : ""));
        foreach (var i in TunerActiveObjects(s))
        {
            var go = s.Objects[i];
            Bounds b;
            if (go == null || !TunerBounds(go, out b)) continue;
            if (!any) total = b;
            else total.Encapsulate(b);
            any = true;
        }
        if (TunerPlanar(s))
        {
            var center = any ? total.center : Vector3.zero;
            var ext = any ? total.extents : Vector3.one;
            s.CamRot = Quaternion.identity;
            s.CamPos = new Vector3(center.x, center.y, center.z - Mathf.Max(10f, ext.z * 2f + 10f));
            s.Ortho = Mathf.Max(0.05f, Mathf.Max(ext.y, ext.x) * 1.3f);
            return;
        }
        if (!any)
        {
            s.CamPos = new Vector3(0f, 2f, -6f);
            s.CamRot = Quaternion.LookRotation(-s.CamPos);
            return;
        }
        float radius = Mathf.Max(0.25f, total.extents.magnitude);
        float dist = radius / Mathf.Sin(s.Fov * 0.5f * Mathf.Deg2Rad) * 1.1f;
        var dir = new Vector3(0.6f, 0.55f, -1f).normalized;
        s.CamPos = total.center + dir * dist;
        s.CamRot = Quaternion.LookRotation(-dir);
    }

    static void ResolveTunerObjects(TunerSession s)
    {
        s.LastResolve = EditorApplication.timeSinceStartup;
        List<Scene> scenes = null;
        for (int i = 0; i < s.Specs.Length; i++)
        {
            if (s.Objects[i] != null) continue;
            if (scenes == null) scenes = TunerScenes();
            s.Objects[i] = FindTunerObject(scenes, s.Specs[i]);
            s.Found[i] = s.Objects[i] != null;
            if (s.Found[i])
            {
                s.CacheDirty = true;
                s.MembersAt = -1;
            }
        }
    }

    static List<Scene> TunerScenes()
    {
        var list = new List<Scene>();
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (sc.IsValid() && sc.isLoaded) list.Add(sc);
        }
        if (Application.isPlaying)
        {
            if (!_tunerDdolKnown || !_tunerDdol.IsValid())
            {
                GameObject temp = null;
                try
                {
                    temp = new GameObject("_SaturaTunerDdolProbe");
                    UnityEngine.Object.DontDestroyOnLoad(temp);
                    _tunerDdol = temp.scene;
                    _tunerDdolKnown = true;
                }
                catch
                {
                    _tunerDdolKnown = false;
                }
                finally
                {
                    if (temp != null) UnityEngine.Object.DestroyImmediate(temp);
                }
            }
            if (_tunerDdolKnown && _tunerDdol.IsValid() && !list.Contains(_tunerDdol)) list.Add(_tunerDdol);
        }
        AddTunerPrefabScenes(list);
        return list;
    }

    static GameObject FindTunerObject(List<Scene> scenes, TunerObjectArgs spec)
    {
        var exact = (spec.path ?? "").TrimStart('/');
        var hit = FindTunerObjectAt(scenes, spec, exact);
        var clean = exact.Trim();
        return hit != null || clean == exact ? hit : FindTunerObjectAt(scenes, spec, clean);
    }

    static GameObject FindTunerObjectAt(List<Scene> scenes, TunerObjectArgs spec, string path)
    {
        if (path.Length == 0) return null;
        var nth = spec.nth > 0 ? new List<GameObject>() : null;
        foreach (var sc in scenes)
        {
            if (!string.IsNullOrEmpty(spec.scene) && sc.name != spec.scene && sc.path != spec.scene) continue;
            foreach (var root in sc.GetRootGameObjects())
            {
                if (root == null || (root.hideFlags & HideFlags.HideInHierarchy) != 0 || SaturaEngineObjects.Contains(root)) continue;
                if (spec.nth > 0)
                {
                    MatchTunerPathAll(root.transform, path, nth);
                    if (nth.Count > spec.nth) return nth[spec.nth];
                    continue;
                }
                var hit = MatchTunerPath(root.transform, path);
                if (hit != null) return hit;
            }
        }
        return null;
    }

    static void MatchTunerPathAll(Transform t, string rest, List<GameObject> into)
    {
        var sub = TunerMatchHead(t, rest);
        if (sub == null) return;
        if (sub.Length == 0)
        {
            into.Add(t.gameObject);
            return;
        }
        for (int i = 0; i < t.childCount; i++) MatchTunerPathAll(t.GetChild(i), sub, into);
    }

    static List<TunerObjectArgs> ExpandTunerSpec(TunerObjectArgs o, ref List<Scene> scenes)
    {
        var path = (o.path ?? "").Trim().Trim('/');
        var one = new List<TunerObjectArgs> { o };
        if (path.IndexOf('*') < 0) return one;
        if (scenes == null) scenes = TunerScenes();
        var parts = path.Split('/');
        var hits = new List<GameObject>();
        foreach (var sc in scenes)
        {
            if (!string.IsNullOrEmpty(o.scene) && sc.name != o.scene && sc.path != o.scene) continue;
            foreach (var root in sc.GetRootGameObjects())
            {
                if (root == null || (root.hideFlags & HideFlags.HideInHierarchy) != 0 || SaturaEngineObjects.Contains(root)) continue;
                GlobTunerPath(root.transform, parts, 0, hits);
            }
        }
        var seen = new HashSet<GameObject>();
        var count = new Dictionary<string, int>();
        var list = new List<TunerObjectArgs>();
        foreach (var go in hits)
        {
            if (!seen.Add(go) || !TunerSpecHas(o, go)) continue;
            var p = TunerHierarchyPath(go.transform);
            int k;
            count.TryGetValue(p, out k);
            count[p] = k + 1;
            list.Add(new TunerObjectArgs { path = p, scene = o.scene, all = o.all, children = o.children, components = o.components, exclude = o.exclude, nth = k });
        }
        if (list.Count == 1) list[0].label = o.label;
        return list.Count > 0 ? list : one;
    }

    static void GlobTunerPath(Transform t, string[] parts, int k, List<GameObject> into)
    {
        var p = parts[k];
        var last = k == parts.Length - 1;
        if (p == "**")
        {
            if (last) into.Add(t.gameObject);
            else GlobTunerPath(t, parts, k + 1, into);
            for (int i = 0; i < t.childCount; i++) GlobTunerPath(t.GetChild(i), parts, k, into);
            return;
        }
        if (!TunerNameMatches(t.name, p)) return;
        if (last)
        {
            into.Add(t.gameObject);
            return;
        }
        for (int i = 0; i < t.childCount; i++) GlobTunerPath(t.GetChild(i), parts, k + 1, into);
    }

    static bool TunerNameMatches(string name, string pattern)
    {
        if (pattern == "*") return true;
        if (pattern.IndexOf('*') < 0) return name == pattern;
        return System.Text.RegularExpressions.Regex.IsMatch(name, "^" + System.Text.RegularExpressions.Regex.Escape(pattern).Replace("\\*", ".*") + "$");
    }

    static bool TunerSpecHas(TunerObjectArgs o, GameObject go)
    {
        if (o.components == null) return true;
        foreach (var c in o.components)
            if (c != null && !string.IsNullOrEmpty(c.type) && FindTunerComponent(go, c.type, c.index) == null) return false;
        return true;
    }

    static string TunerHierarchyPath(Transform t)
    {
        return TunerIndexedPath(t);
    }

    static GameObject MatchTunerPath(Transform t, string rest)
    {
        var sub = TunerMatchHead(t, rest);
        if (sub == null) return null;
        if (sub.Length == 0) return t.gameObject;
        for (int i = 0; i < t.childCount; i++)
        {
            var hit = MatchTunerPath(t.GetChild(i), sub);
            if (hit != null) return hit;
        }
        return null;
    }

    static TunerComponentArgs FindTunerComponentSpec(TunerObjectArgs obj, string key)
    {
        if (obj.components == null || string.IsNullOrEmpty(key)) return null;
        foreach (var c in obj.components)
            if (c != null && TunerComponentKey(c) == key) return c;
        return null;
    }

    static string TunerComponentKey(TunerComponentArgs c)
    {
        return c.index > 0 ? c.type + "#" + c.index.ToString(Inv) : c.type;
    }

    static Component FindTunerComponent(GameObject go, string type, int index)
    {
        if (go == null || string.IsNullOrEmpty(type)) return null;
        int n = 0;
        foreach (var c in go.GetComponents<Component>())
        {
            if (c == null || !TunerTypeMatches(c.GetType(), type)) continue;
            if (n++ == index) return c;
        }
        return null;
    }

    static bool TunerTypeMatches(Type t, string name)
    {
        for (; t != null && t != typeof(UnityEngine.Object); t = t.BaseType)
            if (t.Name == name || t.FullName == name) return true;
        return false;
    }

    static bool TunerFieldAllowed(UnityEngine.Object comp, string[] fields, string prop)
    {
        if (string.IsNullOrEmpty(prop) || prop == "m_Script") return false;
        if (fields != null && fields.Length > 0)
        {
            foreach (var f in fields)
                if (!string.IsNullOrEmpty(f) && (prop == f || prop.StartsWith(f + ".", StringComparison.Ordinal))) return true;
            return false;
        }
        int dot = prop.IndexOf('.');
        var top = dot < 0 ? prop : prop.Substring(0, dot);
        var so = new SerializedObject(comp);
        var it = so.GetIterator();
        bool enter = true;
        while (it.NextVisible(enter))
        {
            enter = false;
            if (it.propertyPath == top) return true;
        }
        return false;
    }

    static bool TunerBounds(GameObject go, out Bounds bounds)
    {
        bounds = default;
        bool any = false;
        var rends = go.GetComponentsInChildren<Renderer>(false);
        for (int pass = 0; pass < 2 && !any; pass++)
        {
            foreach (var r in rends)
            {
                Bounds rb;
                if (r == null || !r.enabled || TunerFxRenderer(r) != (pass == 1) || !TunerRendererBounds(r, out rb)) continue;
                if (!any) bounds = rb;
                else bounds.Encapsulate(rb);
                any = true;
            }
        }
        TunerUiBounds(go, ref bounds, ref any);
        return any;
    }

    static string DescribeTunerState(TunerSession s, bool full = false)
    {
        var sb = new StringBuilder(4096 + (full || s.TreeSent != s.TreeGen ? s.Members.Count * 96 : 0));
        sb.Append("{\"session\":").Append(JStr(s.Name))
          .Append(",\"playing\":").Append(EditorApplication.isPlaying ? "true" : "false")
          .Append(",\"graphics\":").Append(TunerGraphics ? "true" : "false")
          .Append(",\"paused\":").Append(EditorApplication.isPlaying && EditorApplication.isPaused ? "true" : "false")
          .Append(",\"planar\":").Append(TunerPlanar(s) ? "true" : "false");
        if (s.Scene) AppendTunerSceneBounds(sb, s);
        sb.Append(",\"activeState\":").Append(JStr(s.Active >= 0 ? s.States[s.Active].Name : ""))
          .Append(",\"states\":[");
        for (int k = 0; k < s.States.Count; k++)
        {
            if (k > 0) sb.Append(',');
            AppendTunerStateInfo(sb, s.States[k]);
        }
        sb.Append("],\"objects\":[");
        bool first = true;
        foreach (var i in TunerActiveObjects(s))
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append(DescribeTunerObjectCached(s, i));
        }
        sb.Append("],\"entries\":[");
        for (int k = 0; k < s.Entries.Count; k++)
        {
            if (k > 0) sb.Append(',');
            sb.Append(DescribeTunerEntry(s, s.Entries[k].Id));
        }
        sb.Append(']');
        if (full || s.TreeSent != s.TreeGen)
        {
            s.TreeSent = s.TreeGen;
            AppendTunerMembers(sb, s);
            sb.Append(",\"membersCapped\":").Append(s.MembersCapped ? s.MembersLevels : 0);
            AppendTunerFilterCount(sb, s);
        }
        AppendTunerCanvasView(sb, s);
        if (s.MembersLazy) AppendTunerWatchGone(sb, s);
        if (s.Prefabs != null)
        {
            sb.Append(",\"prefabs\":[");
            for (int k = 0; k < s.Prefabs.Length; k++)
            {
                if (k > 0) sb.Append(',');
                sb.Append(JStr(s.Prefabs[k]));
            }
            sb.Append(']');
            if (s.PrefabError != null) sb.Append(",\"prefabError\":").Append(JStr(s.PrefabError));
        }
        sb.Append(",\"unsaved\":").Append(TunerUnsavedJson(s));
        AppendTunerEdits(sb, s);
        sb.Append(",\"overrides\":[");
        first = true;
        foreach (var st in s.States)
        {
            foreach (var ov in st.Overrides)
            {
                if (!first) sb.Append(',');
                first = false;
                AppendTunerOverride(sb, s, st.Name, ov);
            }
        }
        sb.Append("]}");
        return sb.ToString();
    }

    static readonly Dictionary<string, KeyValuePair<int, string>> _tunerNearMiss = new Dictionary<string, KeyValuePair<int, string>>();

    static string TunerNearMissText(string path, string scene)
    {
        var key = (scene ?? "") + "|" + path;
        if (_tunerNearMiss.TryGetValue(key, out var hit) && hit.Key == _tunerStructureGen) return hit.Value;
        var near = TunerNearMiss(path, scene, 3);
        var text = near.Count == 0 ? "" : ". Did you mean " + string.Join(", ", near) + "?";
        if (_tunerNearMiss.Count > 256) _tunerNearMiss.Clear();
        _tunerNearMiss[key] = new KeyValuePair<int, string>(_tunerStructureGen, text);
        return text;
    }

    static List<string> TunerNearMiss(string path, string scene, int max)
    {
        var want = (path ?? "").Trim().Trim('/');
        var leaf = want.Substring(want.LastIndexOf('/') + 1).ToLowerInvariant();
        var wantLower = want.ToLowerInvariant();
        var wantParent = want.LastIndexOf('/') > 0 ? wantLower.Substring(0, wantLower.LastIndexOf('/')) : null;
        var scored = new List<KeyValuePair<float, string>>();
        int seen = 0;
        var stack = new List<KeyValuePair<Transform, string>>();
        foreach (var sc in TunerScenes())
        {
            if (!string.IsNullOrEmpty(scene) && sc.name != scene && sc.path != scene) continue;
            if (TunerPrefabOfScene(sc) != null) continue;
            foreach (var root in sc.GetRootGameObjects())
                if (root != null && !SaturaEngineObjects.Contains(root)) stack.Add(new KeyValuePair<Transform, string>(root.transform, root.name));
            while (stack.Count > 0 && seen < 200000)
            {
                var cur = stack[stack.Count - 1];
                stack.RemoveAt(stack.Count - 1);
                seen++;
                var name = cur.Key.name.ToLowerInvariant();
                float score = -1f;
                var full = cur.Value.ToLowerInvariant();
                if (full == wantLower) score = 0f;
                else if (name == leaf) score = 1f;
                else if (leaf.Length >= 3 && (name.Contains(leaf) || (name.Length >= 3 && leaf.Contains(name)))) score = 3f;
                else
                {
                    int d = TunerEditDistance(name, leaf, 3);
                    if (d <= Mathf.Max(1, Mathf.Min(3, leaf.Length / 3))) score = 2f + d * 0.25f;
                    else if (wantParent != null && full.Length > wantParent.Length && full[wantParent.Length] == '/' && full.StartsWith(wantParent) && full.IndexOf('/', wantParent.Length + 1) < 0) score = 4f;
                }
                if (score >= 0f)
                {
                    score += TunerEditDistance(full, wantLower, 40) * 0.01f;
                    scored.Add(new KeyValuePair<float, string>(score, cur.Value));
                }
                var t = cur.Key;
                for (int c = t.childCount - 1; c >= 0; c--)
                {
                    var ch = t.GetChild(c);
                    stack.Add(new KeyValuePair<Transform, string>(ch, cur.Value + "/" + ch.name));
                }
            }
            stack.Clear();
        }
        scored.Sort((a, b) => a.Key != b.Key ? a.Key.CompareTo(b.Key) : a.Value.Length.CompareTo(b.Value.Length));
        var outList = new List<string>();
        foreach (var kv in scored)
        {
            if (outList.Contains(kv.Value)) continue;
            outList.Add(kv.Value);
            if (outList.Count >= max) break;
        }
        return outList;
    }

    static int TunerEditDistance(string a, string b, int cap)
    {
        if (Mathf.Abs(a.Length - b.Length) > cap) return cap + 1;
        if (a.Length > 96) a = a.Substring(a.Length - 96);
        if (b.Length > 96) b = b.Substring(b.Length - 96);
        var prev = new int[b.Length + 1];
        var cur = new int[b.Length + 1];
        for (int j = 0; j <= b.Length; j++) prev[j] = j;
        for (int i = 1; i <= a.Length; i++)
        {
            cur[0] = i;
            int rowMin = cur[0];
            for (int j = 1; j <= b.Length; j++)
            {
                int cost = a[i - 1] == b[j - 1] ? 0 : 1;
                cur[j] = Mathf.Min(Mathf.Min(prev[j] + 1, cur[j - 1] + 1), prev[j - 1] + cost);
                if (cur[j] < rowMin) rowMin = cur[j];
            }
            if (rowMin > cap) return cap + 1;
            var tmp = prev; prev = cur; cur = tmp;
        }
        return prev[b.Length];
    }

    static string DescribeTunerObject(TunerSession s, int i)
    {
        var spec = s.Specs[i];
        var go = s.Objects[i];
        var sb = new StringBuilder(2048);
        var path = (spec.path ?? "").Trim().TrimStart('/');
        sb.Append("{\"id\":").Append(JStr("o" + i.ToString(Inv)))
          .Append(",\"path\":").Append(JStr(path));
        if (go == null)
        {
            var slash = path.LastIndexOf('/');
            var fallback = slash >= 0 ? path.Substring(slash + 1) : path;
            sb.Append(",\"scene\":").Append(JStr(spec.scene ?? ""))
              .Append(",\"label\":").Append(JStr(string.IsNullOrEmpty(spec.label) ? fallback : spec.label))
              .Append(",\"ancestors\":[],\"active\":false");
            AppendTunerVec(sb, "position", Vector3.zero);
            AppendTunerQuat(sb, "rotation", Quaternion.identity);
            AppendTunerVec(sb, "localPosition", Vector3.zero);
            AppendTunerQuat(sb, "localRotation", Quaternion.identity);
            AppendTunerVec(sb, "localScale", Vector3.one);
            sb.Append(",\"bounds\":null,\"components\":[],\"error\":")
              .Append(JStr("not found in the loaded scenes: " + path + (string.IsNullOrEmpty(spec.scene) ? "" : " (scene " + spec.scene + ")") + TunerNearMissText(path, spec.scene)))
              .Append('}');
            return sb.ToString();
        }
        var t = go.transform;
        var uiError = TunerUiError(s, i);
        sb.Append(",\"scene\":").Append(JStr(TunerSceneKey(go.scene) ?? ""))
          .Append(",\"label\":").Append(JStr(string.IsNullOrEmpty(spec.label) ? go.name : spec.label))
          .Append(",\"ancestors\":[");
        var chain = new List<string>();
        for (var p = t.parent; p != null; p = p.parent) chain.Add(p.name);
        for (int k = chain.Count - 1; k >= 0; k--)
        {
            if (k < chain.Count - 1) sb.Append(',');
            sb.Append(JStr(chain[k]));
        }
        sb.Append("],\"active\":").Append(go.activeInHierarchy ? "true" : "false");
        var prefabMark = TunerPrefabMark(go);
        if (prefabMark != null) sb.Append(",\"prefab\":\"").Append(prefabMark).Append('"');
        var prefabState = TunerPrefabState(go);
        if (prefabState != 0) sb.Append(",\"pf\":").Append(((int)prefabState).ToString(Inv));
        AppendTunerVec(sb, "position", t.position);
        AppendTunerQuat(sb, "rotation", t.rotation);
        AppendTunerVec(sb, "localPosition", t.localPosition);
        AppendTunerQuat(sb, "localRotation", t.localRotation);
        AppendTunerVec(sb, "localScale", t.localScale);
        Bounds b;
        if (TunerBounds(go, out b))
        {
            sb.Append(",\"bounds\":{\"center\":");
            AppendTunerArray(sb, b.center.x, b.center.y, b.center.z);
            sb.Append(",\"size\":");
            AppendTunerArray(sb, b.size.x, b.size.y, b.size.z);
            sb.Append('}');
        }
        else sb.Append(",\"bounds\":null");
        sb.Append(",\"components\":[");
        if (TunerSpecAll(spec)) AppendTunerAllComponents(sb, go, spec.exclude);
        else
        {
            bool first = true;
            foreach (var c in spec.components)
            {
                if (c == null || string.IsNullOrEmpty(c.type)) continue;
                if (!first) sb.Append(',');
                first = false;
                AppendTunerComponent(sb, go, c);
            }
        }
        sb.Append(']');
        AppendTunerAt(sb, t);
        if (uiError != null) sb.Append(",\"error\":").Append(JStr(uiError));
        AppendTunerInspect(sb, path, string.IsNullOrEmpty(spec.scene) ? TunerSceneKey(go.scene) : spec.scene, TunerSpecAll(spec) ? null : spec.components, TunerSpecAll(spec) ? spec.exclude : null, TunerAmbiguousAt(t));
        sb.Append('}');
        return sb.ToString();
    }

    static void AppendTunerAllComponents(StringBuilder sb, GameObject go, string[] exclude = null)
    {
        bool first = true;
        foreach (var kv in TunerComponentKeys(go))
        {
            if (TunerFilterExcludes(exclude, kv.Key)) continue;
            if (!first) sb.Append(',');
            first = false;
            AppendTunerComponentKey(sb, kv.Key, kv.Value);
        }
    }

    static void AppendTunerComponent(StringBuilder sb, GameObject go, TunerComponentArgs spec)
    {
        var comp = FindTunerComponent(go, spec.type, spec.index);
        if (comp == null)
        {
            sb.Append("{\"key\":").Append(JStr(TunerComponentKey(spec)))
              .Append(",\"type\":").Append(JStr(spec.type))
              .Append(",\"error\":").Append(JStr("no " + spec.type + (spec.index > 0 ? " #" + spec.index.ToString(Inv) : "") + " on " + go.name)).Append('}');
            return;
        }
        AppendTunerComponentKey(sb, TunerKeyOf(go, comp), comp);
    }

    static void AppendTunerComponentKey(StringBuilder sb, string key, UnityEngine.Object comp)
    {
        sb.Append("{\"key\":").Append(JStr(key))
          .Append(",\"type\":").Append(JStr(comp.GetType().Name))
          .Append('}');
    }

    static void AppendTunerVec(StringBuilder sb, string name, Vector3 v)
    {
        sb.Append(",\"").Append(name).Append("\":");
        AppendTunerArray(sb, v.x, v.y, v.z);
    }

    static void AppendTunerQuat(StringBuilder sb, string name, Quaternion q)
    {
        sb.Append(",\"").Append(name).Append("\":");
        AppendTunerArray(sb, q.x, q.y, q.z, q.w);
    }

    static void AppendTunerArray(StringBuilder sb, params float[] v)
    {
        sb.Append('[');
        for (int i = 0; i < v.Length; i++)
        {
            if (i > 0) sb.Append(',');
            var n = Num(v[i]);
            sb.Append(n == "null" ? "0" : n);
        }
        sb.Append(']');
    }

    const double TUNER_HEAVY_MS = 12.0;
    const int TUNER_HEAVY_SKIPS = 3;

    static ulong TunerRendererSig()
    {
        long t = TpNow();
        var all = UnityEngine.Object.FindObjectsByType<Renderer>(FindObjectsInactive.Include, FindObjectsSortMode.None);
        ulong h = (ulong)all.Length * 1099511628211UL;
        foreach (var r in all)
        {
            ulong id = (ulong)r.GetHashCode();
            h += id * 0x9E3779B97F4A7C15UL ^ (id >> 7);
        }
        TpAdd(TP_RSIG, t);
        return h;
    }
    const double TUNER_PLAY_REBUILD_INTERVAL = 2.0;

    static readonly List<TunerSession> _tunerTickList = new List<TunerSession>();

    static double _tunerTickAtMs;
    static double _tunerTickGapMs;

    static double EpochMs()
    {
        return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000.0;
    }

    static void TunerTick()
    {
        double nowMs = EpochMs();
        _tunerTickGapMs = _tunerTickAtMs > 0 ? nowMs - _tunerTickAtMs : 0;
        _tunerTickAtMs = nowMs;
        if (_tuners.Count > 0) DrainControl();
        double now = EditorApplication.timeSinceStartup;
        bool playing = EditorApplication.isPlaying;
        long flush = TpNow();
        PumpTunerTickRate(now, playing);
        if (_tuners.Count > 0) PollTunerRoots(now, playing);
        FlushTunerHierarchy(now, playing);
        TpAdd(TP_FLUSH, flush);
        PumpTunerIsolation();
        if (_tuners.Count == 0) return;
        long tickStart = TpNow();
        TpTickStart(tickStart);
        var list = _tunerTickList;
        list.Clear();
        list.AddRange(_tuners.Values);
        for (int n = 0; n < list.Count; n++)
        {
            var s = list[n];
            if (s.Ended) continue;
            if (s.Client != null && !CtrlClientAlive(s.Client))
            {
                Debug.Log("[Tuner] client of " + s.Name + " disconnected, ending the session");
                EndTuner(s, null);
                continue;
            }
            try
            {
                TickTuner(s, now, playing);
            }
            catch (Exception e)
            {
                Debug.LogException(e);
            }
        }
        list.Clear();
        ClearTunerMemberTouched();
        TpAdd(TP_TICK, tickStart);
    }

    static bool TunerEyeSettle(TunerSession s, double now, bool playing)
    {
        if (playing || !TunerUsesCamera(s)) return false;
        double since = now - Math.Max(s.CamMovedAt, _tunerEyeSettleFrom);
        if (since > TUNER_EYE_SETTLE) return false;
        if (since < TUNER_CAMERA_FAST_HOLD || now < s.EyeSettleAt)
        {
            WakeTunerAt(Math.Max(s.EyeSettleAt, now + TUNER_CAMERA_FAST_HOLD - since), now);
            return false;
        }
        s.EyeSettleAt = now + Math.Min(TUNER_EYE_SETTLE_MAX, Math.Max(TUNER_EYE_SETTLE_MIN, since * 0.25));
        return true;
    }

    static void TickTuner(TunerSession s, double now, bool playing)
    {
        if (s.Dragging && now - s.DragAt > TUNER_DRAG_LOST)
        {
            s.Dragging = false;
            Undo.IncrementCurrentGroup();
            FlushTunerTracks(s);
            s.StatePending = true;
            s.Dirty = true;
        }
        bool changed = false;
        bool missing = false;
        foreach (var i in TunerActiveObjects(s))
        {
            if (s.Objects[i] == null)
            {
                if (s.Found[i])
                {
                    s.Found[i] = false;
                    changed = true;
                    s.MembersAt = -1;
                }
                missing = true;
            }
        }
        foreach (var e in s.Entries)
            if (!e.Asset && e.Go == null) missing = true;
        if (missing && now - s.LastResolve >= TUNER_RESOLVE_INTERVAL)
        {
            long resolveStart = TpNow();
            int before = CountFound(s) + CountTunerEntries(s);
            ResolveTunerObjects(s);
            ResolveTunerEntries(s);
            if (CountFound(s) + CountTunerEntries(s) != before)
            {
                changed = true;
                s.TracksStale = true;
                s.MembersAt = -1;
            }
            TpAdd(TP_RESOLVE, resolveStart);
        }
        long stage = TpNow();
        TickTunerMembers(s, now);
        TpAdd(TP_MEMBERS, stage);
        bool heavy = playing && TunerMs(System.Diagnostics.Stopwatch.GetTimestamp() - stage) > TUNER_HEAVY_MS;
        if (playing != s.LastPlaying)
        {
            s.LastPlaying = playing;
            changed = true;
        }
        if (changed)
        {
            s.StatePending = true;
            s.Dirty = true;
            s.CacheDirty = true;
        }
        if (s.StatePending && !heavy && !s.Dragging && now - s.LastState >= TUNER_STATE_INTERVAL)
        {
            s.StatePending = false;
            s.LastState = now;
            stage = TpNow();
            TunerEmit(s.Client, "{\"type\":\"event\",\"event\":\"tuner/state\",\"session\":" + s.NameJson
                + ",\"state\":" + DescribeTunerState(s) + "}");
            TpAdd(TP_STATE, stage);
            heavy = playing && TunerMs(System.Diagnostics.Stopwatch.GetTimestamp() - stage) > TUNER_HEAVY_MS;
        }
        stage = TpNow();
        TickTunerTracks(s, now);
        if (!s.Dragging) TickTunerEdits(s, now);
        TpAdd(TP_TRACKS, stage);
        if (!s.CacheDirty && playing && s.Scene && s.HierarchyGen != _tunerHierarchyGen && now - s.LastRebuild >= TUNER_PLAY_REBUILD_INTERVAL
            && TunerRendererSig() == s.RendSig)
        {
            s.HierarchyGen = _tunerHierarchyGen;
            s.LastRebuild = now;
        }
        if (s.CacheDirty || (s.HierarchyGen != _tunerHierarchyGen && now - s.LastRebuild >= (playing ? TUNER_PLAY_REBUILD_INTERVAL : TUNER_REBUILD_INTERVAL)))
        {
            if (heavy && s.HeavySkips < TUNER_HEAVY_SKIPS)
            {
                s.HeavySkips++;
                WakeTunerAt(now, now);
                return;
            }
            stage = TpNow();
            RebuildTunerCache(s, now);
            TpAdd(TP_REBUILD, stage);
            if (playing && s.Scene) s.RendSig = TunerRendererSig();
            heavy = playing;
        }
        if (s.Hidden) return;
        var view = TunerViewOf(s, false);
        long animStart = System.Diagnostics.Stopwatch.GetTimestamp();
        TickTunerAnimator(s, now, playing);
        TickTunerStaging(s, now, playing);
        if (view != null)
        {
            view.Stats.Ticks++;
            NoteTunerStat(ref view.Stats.Anim, ref view.Stats.AnimMax, System.Diagnostics.Stopwatch.GetTimestamp() - animStart);
        }
        TpAdd(TP_ANIM, animStart);
        stage = TpNow();
        PumpTunerLive(s, now, playing);
        TpAdd(TP_LIVE, stage);
        stage = TpNow();
        TickTunerParticles(s, now, playing);
        TpAdd(TP_PARTICLES, stage);
        if (playing && !heavy && TunerIconListStale(s, now))
        {
            stage = TpNow();
            RefreshTunerIconList(s, now);
            heavy = TunerMs(System.Diagnostics.Stopwatch.GetTimestamp() - stage) > TUNER_HEAVY_MS;
        }
        if (heavy && s.HeavySkips < TUNER_HEAVY_SKIPS)
        {
            s.HeavySkips++;
            s.Dirty = true;
            WakeTunerAt(now, now);
            return;
        }
        s.HeavySkips = 0;
        if (!TunerGraphics) return;
        stage = TpNow();
        PumpTunerSurface(s);
        TpAdd(TP_SURFACE, stage);
        if (!TunerSurfaceMode(s, now)) return;
        bool settle = TunerEyeSettle(s, now, playing);
        if (settle) s.Dirty = true;
        bool fast = s.Dragging || TunerAnimMoving(s, now) || (s.CamMovedAt >= 0 && now - s.CamMovedAt < TUNER_CAMERA_FAST_HOLD);
        double interval = fast ? TUNER_DRAG_FRAME_INTERVAL : TUNER_FRAME_INTERVAL;
        bool playLive = playing && !EditorApplication.isPaused;
        if (playLive) interval = TUNER_DRAG_FRAME_INTERVAL;
        if (fast && s.NextFrame - now > interval) s.NextFrame = now + interval;
        if (now + TUNER_FRAME_SLACK < s.NextFrame)
        {
            if (s.Dirty) WakeTunerAt(s.NextFrame, now);
            return;
        }
        if (playLive) s.Dirty = true;
        int events = _tunerChangeGen + _tunerHierarchyGen + _tunerAnimSampleGen;
        if (!s.Dirty && now + TUNER_FRAME_SLACK < s.NextCheck && events == s.CheckEvents) return;
        s.CheckEvents = events;
        if (s.HasText || TunerHasUi(s))
        {
            stage = TpNow();
            Canvas.ForceUpdateCanvases();
            TpAdd(TP_CANVAS, stage);
        }
        stage = TpNow();
        bool animMoving = TunerAnimMoving(s, now);
        bool skipHash = !s.CacheDirty && s.HashedAt >= 0 && (s.Dragging || animMoving || ((settle || playLive || (s.Dirty && s.CamMovedAt >= 0 && now - s.CamMovedAt < TUNER_CAMERA_FAST_HOLD))
            && events == s.HashEvents));
        ulong hash = s.LastHash;
        if (skipHash && (s.Dragging || animMoving))
        {
            s.Dirty = true;
            if (!playing) RefreshTunerSkinHashes(s);
            RefreshTunerFlatDraws(s, now);
        }
        else if (skipHash && playLive) RefreshTunerMarkedFlat(s, now);
        if (!skipHash)
        {
            hash = HashTuner(s, now);
            s.HashedAt = now;
            s.HashEvents = events;
            TpAdd(TP_HASH, stage);
        }
        if (s.CacheDirty && playing)
        {
            WakeTunerAt(now, now);
            return;
        }
        if (s.CacheDirty)
        {
            stage = TpNow();
            RebuildTunerCache(s, now);
            TpAdd(TP_REBUILD, stage);
            hash = HashTuner(s, now);
        }
        if (s.CompileStale && !ShaderUtil.anythingCompiling)
        {
            s.CompileStale = false;
            s.Dirty = true;
        }
        if (!s.Dirty && hash == s.LastHash)
        {
            s.NextCheck = now + (!fast && !playing && !s.CompileStale && now - s.ChangedAt > TUNER_QUIET_AFTER ? TunerQuietCheck(now - s.ChangedAt) : interval);
            return;
        }
        if (s.ContentHash != s.ChangedHash)
        {
            s.ChangedHash = s.ContentHash;
            s.ChangedAt = now;
        }
        if (!s.AppCamera && now - s.StartedAt < TUNER_CAMERA_WAIT)
        {
            s.NextCheck = now + interval;
            return;
        }
        if (TunerSurfaceBlocked(s))
        {
            _tpBlocked++;
            return;
        }
        if (s.Dirty) _tpRenderDirty++;
        else _tpRenderHash++;
        s.Dirty = false;
        s.LastHash = hash;
        s.NextFrame = now - s.NextFrame > interval ? now + interval : s.NextFrame + interval;
        s.NextCheck = s.NextFrame;
        long renderStart = System.Diagnostics.Stopwatch.GetTimestamp();
        s.RenderStartMs = EpochMs();
        string err = RenderTuner(s, now);
        NoteTunerFrame(s, renderStart);
        TpAdd(TP_RENDER, renderStart);
        TpFrame();
        bool sustained = !fast && s.RenderedAt >= 0 && now - s.RenderedAt < TUNER_SUSTAINED_GAP && !TunerSettling(now);
        if (fast) _tpRenderFast++;
        if (sustained) _tpRenderSustained++;
        if (fast || sustained) NoteTunerActivity();
        s.RenderedAt = now;
        if (err != null) Debug.LogWarning("[Tuner] render failed: " + err);
    }

    static Mesh BuildTunerGrid()
    {
        int half = TUNER_GRID_HALF;
        var verts = new List<Vector3>();
        var cols = new List<Color>();
        var idx = new List<int>();
        const int segs = 24;
        for (int k = -half; k <= half; k++)
        {
            bool major = k % TUNER_GRID_MAJOR == 0;
            float baseAlpha = major ? 1f : 0.4f;
            for (int axis = 0; axis < 2; axis++)
            {
                for (int sgi = 0; sgi < segs; sgi++)
                {
                    float a0 = -half + 2f * half * sgi / segs;
                    float a1 = -half + 2f * half * (sgi + 1) / segs;
                    var p0 = axis == 0 ? new Vector3(k, 0f, a0) : new Vector3(a0, 0f, k);
                    var p1 = axis == 0 ? new Vector3(k, 0f, a1) : new Vector3(a1, 0f, k);
                    idx.Add(verts.Count);
                    verts.Add(p0);
                    cols.Add(new Color(1f, 1f, 1f, baseAlpha * TunerGridFade(p0, half)));
                    idx.Add(verts.Count);
                    verts.Add(p1);
                    cols.Add(new Color(1f, 1f, 1f, baseAlpha * TunerGridFade(p1, half)));
                }
            }
        }
        var mesh = new Mesh { name = TUNER_GRID_NAME, hideFlags = HideFlags.HideAndDontSave };
        mesh.indexFormat = IndexFormat.UInt32;
        mesh.SetVertices(verts);
        mesh.SetColors(cols);
        mesh.SetIndices(idx, MeshTopology.Lines, 0);
        mesh.bounds = new Bounds(Vector3.zero, new Vector3(2f * half, 0.01f, 2f * half));
        return mesh;
    }

    static float TunerGridFade(Vector3 p, int half)
    {
        float d = new Vector2(p.x, p.z).magnitude / half;
        return Mathf.Clamp01(1f - d * d);
    }
}
