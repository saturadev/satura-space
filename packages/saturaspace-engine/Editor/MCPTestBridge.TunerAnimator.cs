using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;
using UnityEngine.SceneManagement;

[Serializable]
class AnimatorViewSpec
{
    public string path;
    public string clip;
}

public static partial class MCPTestBridge
{
    const double TUNER_ANIM_EMIT = 0.05;
    const double TUNER_ANIM_REFRESH_EDIT = 0.25;
    const double TUNER_ANIM_REFRESH_PLAY = 0.1;
    const double TUNER_ANIM_SAVE_DELAY = 0.4;
    const double TUNER_ANIM_SPEC_RESOLVE = 0.5;
    const double TUNER_ANIM_RESUME_WAIT = 3.0;

    enum TunerAnimKind { Animator, Legacy }

    sealed class TunerAnimOwner
    {
        public TunerAnimKind Kind;
        public GameObject Root;
        public Animator Animator;
        public Animation Legacy;
    }

    sealed class TunerAnimHold
    {
        public Behaviour Behaviour;
        public bool Enabled;
        public bool KeepState;
    }

    [Serializable]
    class TunerAnimatorArgs
    {
        public string session;
        public string op;
        public string obj;
        public string clip;
        public string name;
        public float time = float.NaN;
        public int frame = -1;
        public int dir;
        public string value;
        public string id;
        public string[] ids;
        public TunerAnimKeyArg[] keys;
        public TunerAnimEventArg[] events;
        public TunerAnimEventArg ev;
        public int df;
        public float dv;
        public bool copy;
        public bool live;
        public string mode;
        public int index = -1;
        public int[] indices;
        public float length = -1f;
        public float frameRate = -1f;
        public int loop = -1;
        public int locked = -1;
    }

    [Serializable]
    class TunerAnimatorCommand
    {
        public int id;
        public TunerAnimatorArgs args;
    }

    sealed class TunerAnimState
    {
        public AnimatorViewSpec Spec;
        public GameObject SpecGo;
        public double SpecAt = -1;
        public GameObject SelGo;
        public int SelGen = -1;
        public bool SelSeen;
        public double SelLostAt = -1;
        public TunerAnimOwner Owner;
        public GameObject Target;
        public AnimationClip Clip;
        public string WantClip;
        public double Time;
        public double RestoreTime = -1;
        public bool RestorePreview;
        public bool Playing;
        public double PlayAt;
        public bool Preview;
        public bool Record;
        public bool Locked;
        public string LockPath;
        public string LockKeep;
        public double LockAt = -1;
        public PlayableGraph Graph;
        public AnimationClip GraphFor;
        public int GraphRev = -1;
        public bool Live = true;
        public TunerAnimHold Hold;
        public bool ResumeAfterSave;
        public double ResumeAt = -1;
        public bool ResumePreview;
        public int Rev;
        public int SampledRev = -1;
        public bool Dirty = true;
        public double NextEmit;
        public double RefreshAt;
        public string LastJson;
        public bool Sent;
        public string Error;
        public string Status = "";
        public readonly Dictionary<string, float> Pending = new Dictionary<string, float>();
        public readonly HashSet<AnimationClip> Touched = new HashSet<AnimationClip>();
        public string MethodsJson = "[]";
        public GameObject MethodsFor;
        public int MethodsGen = -1;
        public int MethodsCount = -1;
        public double SaveAt = -1;
        public readonly HashSet<AnimationClip> SaveClips = new HashSet<AnimationClip>();
        public int DragGroup = -1;
        public Dictionary<string, AnimationCurve> DragBase;
        public int DragSteps;
        public int RootMotion = -1;
        public bool HasRest;
        public Vector3 RestPos;
        public Quaternion RestRot = Quaternion.identity;
        public bool HasA0;
        public Vector3 A0Pos;
        public Quaternion A0Rot = Quaternion.identity;
        public bool GraphHuman;
        public AnimationClipPlayable GraphClip;
        public AnimationClipPlayable HeldClip;
        public bool HeldPaused;
        public readonly TunerAnimClipCache Cache = new TunerAnimClipCache();
        public int SentSeq = -1;
        public AnimationClip SentClip;
        public string SentStruct;
        public bool SentAny;
        public readonly Dictionary<string, float> SentValues = new Dictionary<string, float>();
        public int EmitCount;
        public long EmitBytes;
        public int FullCount;
        public int PatchCount;
    }

    static readonly Dictionary<TunerSession, TunerAnimState> _tunerAnims = new Dictionary<TunerSession, TunerAnimState>();
    static int _tunerAnimSampleGen;
    static double _tunerAnimSampledAt = -1;
    const double TUNER_ANIM_FAST_HOLD = 0.25;
    static TunerAnimState _tunerAnimPreviewing;
    static AnimationModeDriver _tunerAnimDriver;
    static bool _tunerAnimApplying;
    static MethodInfo _tunerAnimEulerHint;
    static bool _tunerAnimEulerHintLooked;

    [InitializeOnLoadMethod]
    static void InitTunerAnimator()
    {
        if (Inert) return;
        EditorSceneManager.sceneSaving += OnTunerAnimSceneSaving;
        EditorSceneManager.sceneSaved += OnTunerAnimSceneSaved;
        EditorApplication.playModeStateChanged += OnTunerAnimPlayMode;
        Undo.undoRedoPerformed += OnTunerAnimUndo;
        Undo.postprocessModifications += OnTunerAnimModifications;
        AssemblyReloadEvents.beforeAssemblyReload += OnTunerAnimReload;
        AnimationUtility.onCurveWasModified += OnTunerCurveModified;
    }

    static int _tunerCurveEdits;

    static void OnTunerCurveModified(AnimationClip clip, EditorCurveBinding binding, AnimationUtility.CurveModifiedType type)
    {
        _tunerCurveEdits++;
        NoteTunerCurveTouched(clip, binding, type);
    }

    [Serializable]
    class TunerAnimSaved
    {
        public string owner;
        public bool locked;
        public string clip = "";
        public double time;
        public bool preview;
    }

    const string TUNER_ANIM_SAVED = "SaturaTunerAnim:";

    static TunerAnimState TunerAnimOf(TunerSession s)
    {
        if (_tunerAnims.TryGetValue(s, out var st)) return st;
        st = new TunerAnimState();
        _tunerAnims[s] = st;
        RestoreTunerAnimEdits(s.Name, st);
        return st;
    }

    static void SaveTunerAnimEdits()
    {
        foreach (var kv in _tunerAnims) SaveTunerAnimState(kv.Key.Name, kv.Value);
    }

    static void SaveTunerAnimState(string session, TunerAnimState st)
    {
        {
            var saved = new TunerAnimSaved();
            saved.clip = st.Clip != null ? TunerAnimClipKey(st.Clip) : "";
            saved.time = st.Time;
            saved.owner = st.Locked && st.Owner != null && st.Owner.Root != null ? TunerObjectPath(st.Owner.Root) : st.LockPath ?? st.LockKeep ?? "";
            saved.locked = (st.Locked || st.LockPath != null) && saved.owner.Length > 0;
            saved.preview = st.Preview && !EditorApplication.isPlaying;
            if (saved.clip.Length == 0) SessionState.EraseString(TUNER_ANIM_SAVED + session);
            else SessionState.SetString(TUNER_ANIM_SAVED + session, JsonUtility.ToJson(saved));
        }
    }

    static void RestoreTunerAnimEdits(string session, TunerAnimState st)
    {
        var raw = SessionState.GetString(TUNER_ANIM_SAVED + session, "");
        if (string.IsNullOrEmpty(raw)) return;
        SessionState.EraseString(TUNER_ANIM_SAVED + session);
        try
        {
            var saved = JsonUtility.FromJson<TunerAnimSaved>(raw);
            if (!string.IsNullOrEmpty(saved.clip)) st.WantClip = saved.clip;
            st.RestoreTime = saved.time;
            st.RestorePreview = saved.preview;
            if (saved.locked && !string.IsNullOrEmpty(saved.owner)) st.LockPath = saved.owner;
        }
        catch (Exception e) { Debug.LogException(e); }
    }

    static void SetTunerAnimatorSpec(TunerSession s, AnimatorViewSpec spec)
    {
        var st = TunerAnimOf(s);
        st.Spec = spec != null && !string.IsNullOrEmpty(spec.path) ? spec : null;
        st.SpecGo = null;
        st.SpecAt = -1;
        if (st.Spec != null && !string.IsNullOrEmpty(st.Spec.clip)) st.WantClip = st.Spec.clip;
    }

    static void OnTunerAnimSceneSaving(Scene scene, string path)
    {
        foreach (var st in _tunerAnims.Values)
        {
            if (!st.Preview || EditorApplication.isPlaying) continue;
            StopTunerAnimPreview(st);
            st.ResumeAfterSave = true;
        }
    }

    static void OnTunerAnimSceneSaved(Scene scene)
    {
        foreach (var st in _tunerAnims.Values)
        {
            if (!st.ResumeAfterSave) continue;
            st.ResumeAfterSave = false;
            if (!EditorApplication.isPlaying) StartTunerAnimPreview(st);
        }
    }

    static void OnTunerAnimPlayMode(PlayModeStateChange change)
    {
        if (change != PlayModeStateChange.ExitingEditMode && change != PlayModeStateChange.ExitingPlayMode) return;
        foreach (var st in _tunerAnims.Values)
        {
            StopTunerAnimPreview(st);
            ReleaseTunerAnimHold(st);
            st.Playing = false;
            st.Owner = null;
            st.Clip = null;
            st.SelGo = null;
            st.SelGen = -1;
            st.Live = true;
            st.Rev++;
            st.Dirty = true;
        }
    }

    static void OnTunerAnimReload()
    {
        try { SaveTunerAnimEdits(); }
        catch (Exception e) { Debug.LogException(e); }
        foreach (var st in _tunerAnims.Values)
        {
            StopTunerAnimPreview(st);
            ReleaseTunerAnimHold(st);
        }
        if (_tunerAnimDriver != null && AnimationMode.InAnimationMode(_tunerAnimDriver)) AnimationMode.StopAnimationMode(_tunerAnimDriver);
        TunerRestoreSkinBounds();
    }

    static void OnTunerAnimUndo()
    {
        foreach (var st in _tunerAnims.Values)
        {
            foreach (var c in st.Touched)
                if (c != null) st.SaveClips.Add(c);
            if (st.Clip != null && TunerAnimReadOnly(st.Clip) == null) st.SaveClips.Add(st.Clip);
            if (st.SaveClips.Count > 0) st.SaveAt = EditorApplication.timeSinceStartup + 0.2;
            st.Rev++;
            st.Pending.Clear();
            st.Dirty = true;
            st.MethodsGen = -1;
        }
        _tunerAnimatable.Clear();
    }

    static bool CloseTunerAnim(TunerAnimState st)
    {
        bool held = st.Hold != null;
        st.Record = false;
        st.Playing = false;
        StopTunerAnimPreview(st);
        ReleaseTunerAnimHold(st);
        DestroyTunerAnimGraph(st);
        st.Pending.Clear();
        if (st.DragGroup >= 0) Undo.CollapseUndoOperations(st.DragGroup);
        st.DragGroup = -1;
        FlushTunerAnimSaves(st);
        st.Dirty = true;
        return held;
    }

    static void EndTunerAnimator(TunerSession s, string reason)
    {
        if (!_tunerAnims.TryGetValue(s, out var st)) return;
        try { SaveTunerAnimState(s.Name, st); }
        catch (Exception e) { Debug.LogException(e); }
        CloseTunerAnim(st);
        _tunerAnims.Remove(s);
    }

    static TunerAnimOwner TunerAnimOwnerOf(GameObject go)
    {
        for (var t = go != null ? go.transform : null; t != null; t = t.parent)
        {
            var an = t.GetComponent<Animator>();
            if (an != null && an.runtimeAnimatorController != null) return new TunerAnimOwner { Kind = TunerAnimKind.Animator, Root = t.gameObject, Animator = an };
            var lg = t.GetComponent<Animation>();
            if (lg != null) return new TunerAnimOwner { Kind = TunerAnimKind.Legacy, Root = t.gameObject, Legacy = lg };
        }
        return null;
    }

    static List<AnimationClip> TunerAnimClips(TunerAnimOwner o)
    {
        var list = new List<AnimationClip>();
        if (o == null || o.Root == null) return list;
        IEnumerable<AnimationClip> src;
        switch (o.Kind)
        {
            case TunerAnimKind.Animator:
                src = o.Animator != null && o.Animator.runtimeAnimatorController != null ? o.Animator.runtimeAnimatorController.animationClips : Enumerable.Empty<AnimationClip>();
                break;
            default:
                src = AnimationUtility.GetAnimationClips(o.Root);
                break;
        }
        foreach (var c in src)
            if (c != null && !list.Contains(c)) list.Add(c);
        return list;
    }

    static Dictionary<AnimationClip, List<string>> TunerAnimStates(TunerAnimOwner o)
    {
        var map = new Dictionary<AnimationClip, List<string>>();
        if (o == null || o.Kind != TunerAnimKind.Animator || o.Animator == null) return map;
        var rc = o.Animator.runtimeAnimatorController;
        var overrides = rc as AnimatorOverrideController;
        var ctrl = (overrides != null ? overrides.runtimeAnimatorController : rc) as AnimatorController;
        if (ctrl == null) return map;
        foreach (var layer in ctrl.layers)
            if (layer != null && layer.stateMachine != null) TunerAnimCollectStates(layer.stateMachine, overrides, map);
        return map;
    }

    static void TunerAnimCollectStates(AnimatorStateMachine sm, AnimatorOverrideController overrides, Dictionary<AnimationClip, List<string>> map)
    {
        foreach (var cs in sm.states)
        {
            var clip = cs.state != null ? cs.state.motion as AnimationClip : null;
            if (clip == null) continue;
            if (overrides != null && overrides[clip] != null) clip = overrides[clip];
            if (!map.TryGetValue(clip, out var names)) map[clip] = names = new List<string>();
            if (!names.Contains(cs.state.name)) names.Add(cs.state.name);
        }
        foreach (var child in sm.stateMachines)
            if (child.stateMachine != null) TunerAnimCollectStates(child.stateMachine, overrides, map);
    }

    static bool TunerAnimOwnerAlive(TunerAnimOwner o)
    {
        if (o == null || o.Root == null) return false;
        switch (o.Kind)
        {
            case TunerAnimKind.Animator: return o.Animator != null;
            default: return o.Legacy != null;
        }
    }

    static bool SameTunerAnimOwner(TunerAnimOwner a, TunerAnimOwner b)
    {
        if (a == null || b == null) return a == b;
        return a.Kind == b.Kind && a.Root == b.Root;
    }

    static string TunerAnimClipKey(AnimationClip clip)
    {
        var path = AssetDatabase.GetAssetPath(clip);
        if (string.IsNullOrEmpty(path) || AssetDatabase.IsMainAsset(clip)) return path;
        return path + "::" + clip.name;
    }

    static AnimationClip PickTunerAnimClip(TunerAnimState st, List<AnimationClip> clips)
    {
        if (clips.Count == 0) return null;
        if (!string.IsNullOrEmpty(st.WantClip))
        {
            var want = clips.FirstOrDefault(c => TunerAnimClipKey(c) == st.WantClip)
                ?? clips.FirstOrDefault(c => c.name == st.WantClip || AssetDatabase.GetAssetPath(c) == st.WantClip);
            if (want != null) return want;
        }
        var o = st.Owner;
        if (EditorApplication.isPlaying && TunerAnimLive(o, out var live, out _) && clips.Contains(live)) return live;
        if (o.Kind == TunerAnimKind.Animator)
        {
            var ctrl = o.Animator.runtimeAnimatorController as UnityEditor.Animations.AnimatorController;
            var def = ctrl != null && ctrl.layers.Length > 0 && ctrl.layers[0].stateMachine != null ? ctrl.layers[0].stateMachine.defaultState : null;
            if (def != null && def.motion is AnimationClip dc && clips.Contains(dc)) return dc;
        }
        if (o.Kind == TunerAnimKind.Legacy && o.Legacy.clip != null && clips.Contains(o.Legacy.clip)) return o.Legacy.clip;
        return clips[0];
    }

    static void SwitchTunerAnimOwner(TunerAnimState st, TunerAnimOwner owner)
    {
        StopTunerAnimPreview(st);
        ReleaseTunerAnimHold(st);
        st.Owner = owner;
        st.Playing = false;
        st.Live = true;
        st.Time = 0;
        st.RootMotion = -1;
        st.HasRest = false;
        st.Pending.Clear();
        st.Clip = owner != null ? PickTunerAnimClip(st, TunerAnimClips(owner)) : null;
        if (st.RestoreTime >= 0 && st.Clip != null) st.Time = Math.Min(st.RestoreTime, TunerAnimLen(st));
        st.RestoreTime = -1;
        bool resume = st.RestorePreview && st.Clip != null && !EditorApplication.isPlaying;
        st.RestorePreview = false;
        st.Error = null;
        st.Status = "";
        st.Rev++;
        st.Dirty = true;
        if (owner != null)
            Debug.Log("[Tuner] animator: " + TunerObjectPath(owner.Root) + " (" + TunerAnimKindName(owner.Kind) + ") clip " + (st.Clip != null ? st.Clip.name : "none") + " of " + TunerAnimClips(owner).Count);
        if (resume && owner != null && !st.Preview && StartTunerAnimPreview(st)) Debug.Log("[Tuner] animator: preview back on after the panel came back");
    }

    static double TunerAnimLen(TunerAnimState st) => st.Clip != null ? st.Clip.length : 0;

    static string TunerAnimKindName(TunerAnimKind k) => k == TunerAnimKind.Animator ? "Animator" : "Animation";

    static void ResolveTunerAnim(TunerSession s, TunerAnimState st, double now)
    {
        var v = TunerViewOf(s, false);
        var sel = v == null ? null : ResolveTunerSelection(s, v, now);
        if (sel == null && st.SelGo != null && v != null && (v.SelId != null || v.SelPath != null))
        {
            if (st.SelLostAt < 0) st.SelLostAt = now;
            if (now - st.SelLostAt < 1.0) sel = st.SelGo;
        }
        else st.SelLostAt = -1;
        if (sel == null && st.Spec != null && !st.SelSeen)
        {
            if (st.SpecGo == null && (st.SpecAt < 0 || now - st.SpecAt >= TUNER_ANIM_SPEC_RESOLVE))
            {
                st.SpecAt = now;
                st.SpecGo = FindTunerObject(TunerScenes(), new TunerObjectArgs { path = st.Spec.path });
            }
            sel = st.SpecGo;
        }
        else if (sel != null) st.SelSeen = true;
        if (st.Owner != null && !TunerAnimOwnerAlive(st.Owner))
        {
            SwitchTunerAnimOwner(st, null);
            st.SelGo = null;
            if (st.Locked && st.LockKeep != null) st.LockPath = st.LockKeep;
            st.Locked = false;
        }
        else if (st.Locked && st.Owner == null && st.LockKeep != null && st.LockPath == null)
        {
            st.LockPath = st.LockKeep;
            st.Locked = false;
        }
        if (st.LockPath != null && (st.LockAt < 0 || now - st.LockAt >= TUNER_ANIM_SPEC_RESOLVE))
        {
            st.LockAt = now;
            var lockGo = FindTunerObject(TunerScenes(), new TunerObjectArgs { path = st.LockPath });
            var lockOwner = lockGo != null ? TunerAnimOwnerOf(lockGo) : null;
            if (lockOwner != null)
            {
                st.LockKeep = st.LockPath;
                st.LockPath = null;
                if (!SameTunerAnimOwner(lockOwner, st.Owner)) SwitchTunerAnimOwner(st, lockOwner);
                st.Locked = true;
                st.Dirty = true;
            }
        }
        if (st.Locked && st.Owner != null) return;
        if (ReferenceEquals(sel, st.SelGo) && st.SelGen == _tunerHierarchyGen && (st.Owner == null || st.Clip != null)) return;
        st.SelGo = sel;
        st.SelGen = _tunerHierarchyGen;
        var owner = TunerAnimOwnerOf(sel);
        if (!SameTunerAnimOwner(owner, st.Owner)) SwitchTunerAnimOwner(st, owner);
        else if (owner != null)
        {
            st.Owner = owner;
            var clips = TunerAnimClips(owner);
            if (st.Clip == null || !clips.Contains(st.Clip))
            {
                st.Clip = PickTunerAnimClip(st, clips);
                st.Rev++;
            }
        }
        var target = owner == null ? sel : null;
        if (target != st.Target)
        {
            st.Target = target;
            st.Dirty = true;
        }
    }

    static bool StartTunerAnimPreview(TunerAnimState st)
    {
        if (st.Preview) return true;
        if (EditorApplication.isPlaying || st.Owner == null || st.Owner.Root == null || st.Clip == null) return false;
        if (_tunerAnimPreviewing != null && _tunerAnimPreviewing != st) StopTunerAnimPreview(_tunerAnimPreviewing);
        if (_tunerAnimDriver == null)
        {
            _tunerAnimDriver = ScriptableObject.CreateInstance<AnimationModeDriver>();
            _tunerAnimDriver.hideFlags = HideFlags.HideAndDontSave;
            _tunerAnimDriver.name = "SaturaTunerTimeline";
        }
        if (AnimationMode.InAnimationMode() && !AnimationMode.InAnimationMode(_tunerAnimDriver))
        {
            st.Status = "Unity's own Animation window is previewing. Turn its preview off first.";
            return false;
        }
        var rt = st.Owner.Root.transform;
        st.RestPos = rt.localPosition;
        st.RestRot = rt.localRotation;
        st.HasRest = true;
        st.HasA0 = false;
        AnimationMode.StartAnimationMode(_tunerAnimDriver);
        st.Preview = true;
        _tunerAnimPreviewing = st;
        st.SampledRev = -1;
        Debug.Log("[Tuner] animator preview on: " + TunerObjectPath(st.Owner.Root) + " clip " + st.Clip.name + " (Edit Mode, the scene is restored when it stops)");
        SampleTunerAnim(st);
        return true;
    }

    static readonly List<SkinnedMeshRenderer> _tunerLiveSkins = new List<SkinnedMeshRenderer>();

    static void TunerPreviewSkinBounds(GameObject root)
    {
        if (root == null) return;
        foreach (var smr in root.GetComponentsInChildren<SkinnedMeshRenderer>(true))
        {
            if (smr.updateWhenOffscreen) continue;
            smr.updateWhenOffscreen = true;
            _tunerLiveSkins.Add(smr);
        }
    }

    static void TunerRestoreSkinBounds()
    {
        foreach (var smr in _tunerLiveSkins)
            if (smr != null) smr.updateWhenOffscreen = false;
        _tunerLiveSkins.Clear();
    }

    static void StopTunerAnimPreview(TunerAnimState st)
    {
        if (st == null || !st.Preview) return;
        st.Preview = false;
        st.Playing = false;
        st.Pending.Clear();
        DestroyTunerAnimGraph(st);
        if (_tunerAnimPreviewing == st) _tunerAnimPreviewing = null;
        TunerRestoreSkinBounds();
        try
        {
            if (_tunerAnimDriver != null && AnimationMode.InAnimationMode(_tunerAnimDriver)) AnimationMode.StopAnimationMode(_tunerAnimDriver);
        }
        catch (Exception e) { Debug.LogException(e); }
        st.Dirty = true;
        if (!EditorApplication.isPlaying) EditorApplication.QueuePlayerLoopUpdate();
        SignalTunerTick();
        Debug.Log("[Tuner] animator preview off, the scene is restored");
    }

    static void DestroyTunerAnimGraph(TunerAnimState st)
    {
        if (st.Graph.IsValid()) st.Graph.Destroy();
        st.Graph = default;
        st.GraphFor = null;
        st.GraphRev = -1;
        st.GraphHuman = false;
        st.GraphClip = default;
        st.HasA0 = false;
    }

    static bool EnsureTunerAnimGraph(TunerAnimState st)
    {
        var anim = st.Owner.Animator;
        if (anim == null || st.Clip == null) return false;
        bool human = TunerHuman(st.Owner);
        if (st.Graph.IsValid() && st.GraphFor == st.Clip && st.GraphRev == st.Rev && st.GraphHuman == human) return true;
        DestroyTunerAnimGraph(st);
        if (human)
        {
            st.Graph = BuildTunerHumanGraph(anim, st.Clip, "Satura Tuner timeline", out st.GraphClip);
            st.GraphFor = st.Clip;
            st.GraphRev = st.Rev;
            st.GraphHuman = true;
            return true;
        }
        st.Graph = PlayableGraph.Create("Satura Tuner timeline");
        NoteTunerGraph(st.Graph);
        st.Graph.SetTimeUpdateMode(DirectorUpdateMode.Manual);
        var cp = AnimationClipPlayable.Create(st.Graph, st.Clip);
        cp.SetApplyFootIK(false);
        var output = AnimationPlayableOutput.Create(st.Graph, "output", anim);
        output.SetSourcePlayable(cp);
        output.SetWeight(0f);
        st.GraphFor = st.Clip;
        st.GraphRev = st.Rev;
        return true;
    }

    static void SampleTunerAnimEulerHint(GameObject root, AnimationClip clip, float t)
    {
        if (!_tunerAnimEulerHintLooked)
        {
            _tunerAnimEulerHintLooked = true;
            _tunerAnimEulerHint = typeof(AnimationUtility).GetMethod("SampleEulerHint", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, new[] { typeof(GameObject), typeof(AnimationClip), typeof(float), typeof(WrapMode) }, null);
        }
        if (_tunerAnimEulerHint == null) return;
        try { _tunerAnimEulerHint.Invoke(null, new object[] { root, clip, t, WrapMode.Clamp }); }
        catch { _tunerAnimEulerHint = null; }
    }

    static void SampleTunerAnim(TunerAnimState st)
    {
        if (st.Owner == null || st.Owner.Root == null || st.Clip == null) return;
        var root = st.Owner.Root;
        float t = (float)st.Time;
        if (EditorApplication.isPlaying)
        {
            if (st.Hold == null) return;
            _tunerAnimApplying = true;
            try
            {
                st.Clip.SampleAnimation(root, t);
            }
            catch (Exception e)
            {
                st.Error = e.GetType().Name + ": " + e.Message;
            }
            finally { _tunerAnimApplying = false; }
        }
        else
        {
            if (!st.Preview) return;
            bool graph = st.Owner.Kind != TunerAnimKind.Legacy && st.Owner.Animator != null && !st.Clip.legacy && EnsureTunerAnimGraph(st);
            _tunerAnimApplying = true;
            AnimationMode.BeginSampling();
            try
            {
                if (graph && st.GraphHuman) SampleTunerHuman(st, t);
                else if (graph)
                {
                    AnimationMode.SamplePlayableGraph(st.Graph, 0, t);
                    SampleTunerAnimEulerHint(root, st.Clip, t);
                }
                else AnimationMode.SampleAnimationClip(root, st.Clip, t);
                TunerPreviewSkinBounds(root);
                st.Error = null;
            }
            catch (Exception e)
            {
                st.Error = e.GetType().Name + ": " + e.Message;
                Debug.LogException(e);
            }
            finally
            {
                AnimationMode.EndSampling();
                _tunerAnimApplying = false;
            }
            EditorApplication.QueuePlayerLoopUpdate();
        }
        st.SampledRev = st.Rev;
        st.Pending.Clear();
        st.Dirty = true;
        _tunerAnimSampleGen++;
        _tunerAnimSampledAt = EditorApplication.timeSinceStartup;
        SignalTunerTick();
    }

    static void SampleTunerHuman(TunerAnimState st, float t)
    {
        var tr = st.Owner.Root.transform;
        if (!st.HasRest)
        {
            st.RestPos = tr.localPosition;
            st.RestRot = tr.localRotation;
            st.HasRest = true;
        }
        if (!st.HasA0)
        {
            AnimationMode.SamplePlayableGraph(st.Graph, 0, 0f);
            st.A0Pos = tr.localPosition;
            st.A0Rot = tr.localRotation;
            st.HasA0 = true;
        }
        AnimationMode.SamplePlayableGraph(st.Graph, 0, t);
        PlaceTunerRoot(tr, st.RestPos, st.RestRot, st.A0Pos, st.A0Rot, tr.localPosition, tr.localRotation, TunerRootMotionOn(st));
    }

    static bool TunerAnimPlaying(TunerSession s)
    {
        return _tunerAnims.TryGetValue(s, out var st) && st.Owner != null && st.Clip != null && st.Playing && (st.Preview || st.Hold != null);
    }

    static bool TunerAnimMoving(TunerSession s, double now)
    {
        return TunerAnimPlaying(s) || (_tunerAnimSampledAt >= 0 && now - _tunerAnimSampledAt < TUNER_ANIM_FAST_HOLD && _tunerAnims.ContainsKey(s));
    }

    static bool TunerAnimLive(TunerAnimOwner o, out AnimationClip clip, out double time)
    {
        clip = null;
        time = 0;
        if (o == null || o.Root == null) return false;
        switch (o.Kind)
        {
            case TunerAnimKind.Animator:
            {
                var a = o.Animator;
                if (a == null || !a.isActiveAndEnabled || a.runtimeAnimatorController == null || a.layerCount == 0) return false;
                var infos = a.GetCurrentAnimatorClipInfo(0);
                float best = -1f;
                foreach (var ci in infos)
                    if (ci.clip != null && ci.weight > best)
                    {
                        best = ci.weight;
                        clip = ci.clip;
                    }
                if (clip == null) return false;
                var si = a.GetCurrentAnimatorStateInfo(0);
                double len = Math.Max(1e-4, clip.length);
                double t = si.normalizedTime * len;
                time = clip.isLooping ? t % len : Math.Min(t, len);
                return true;
            }
            default:
            {
                var an = o.Legacy;
                if (an == null) return false;
                float best = -1f;
                AnimationState pick = null;
                foreach (AnimationState s in an)
                    if (s.enabled && s.weight > best)
                    {
                        best = s.weight;
                        pick = s;
                    }
                if (pick == null || pick.clip == null) return false;
                clip = pick.clip;
                double len = Math.Max(1e-4, clip.length);
                bool loops = pick.wrapMode == WrapMode.Loop || pick.wrapMode == WrapMode.PingPong || (pick.wrapMode == WrapMode.Default && clip.wrapMode == WrapMode.Loop);
                time = loops ? pick.time % len : Math.Min(pick.time, len);
                return true;
            }
        }
    }

    static void TakeOverTunerAnim(TunerAnimState st)
    {
        if (st.Hold != null || st.Owner == null || st.Owner.Root == null) return;
        var h = new TunerAnimHold();
        if (st.Owner.Kind == TunerAnimKind.Legacy) h.Behaviour = st.Owner.Legacy;
        else
        {
            var a = st.Owner.Animator;
            h.Behaviour = a;
            if (a != null)
            {
                h.KeepState = a.keepAnimatorStateOnDisable;
                a.keepAnimatorStateOnDisable = true;
            }
        }
        if (h.Behaviour != null)
        {
            h.Enabled = h.Behaviour.enabled;
            h.Behaviour.enabled = false;
        }
        st.Hold = h;
        st.Live = false;
        st.Playing = false;
        Debug.Log("[Tuner] animator took over " + TunerObjectPath(st.Owner.Root) + " at " + st.Time.ToString("0.###", Inv) + " s (Play Mode, Resume hands it back)");
    }

    static void ReleaseTunerAnimHold(TunerAnimState st)
    {
        var h = st.Hold;
        if (h == null) return;
        st.Hold = null;
        st.Live = true;
        try
        {
            if (h.Behaviour != null)
            {
                h.Behaviour.enabled = h.Enabled;
                if (h.Behaviour is Animator a) a.keepAnimatorStateOnDisable = h.KeepState;
            }
        }
        catch (Exception e) { Debug.LogException(e); }
        if (st.Owner != null && st.Owner.Root != null) Debug.Log("[Tuner] animator resumed " + TunerObjectPath(st.Owner.Root) + ": the game drives it again");
    }

    static void TunerAnimBeforeDiscard()
    {
        foreach (var st in _tunerAnims.Values)
        {
            FlushTunerAnimSaves(st);
            st.ResumePreview = st.Preview;
            st.ResumeAt = -1;
            if (st.Clip != null) st.WantClip = TunerAnimClipKey(st.Clip);
            StopTunerAnimPreview(st);
        }
    }

    static void TunerAnimAfterDiscard()
    {
        _tunerAnimatable.Clear();
        _tunerCurveTouched.Clear();
        double now = EditorApplication.timeSinceStartup;
        foreach (var st in _tunerAnims.Values)
        {
            if (st.Owner != null && !TunerAnimOwnerAlive(st.Owner))
            {
                double t = st.Time;
                SwitchTunerAnimOwner(st, null);
                st.SelGo = null;
                st.RestoreTime = t;
            }
            st.ResumeAt = now + TUNER_ANIM_RESUME_WAIT;
            st.Touched.Clear();
            st.SaveClips.Clear();
            st.SaveAt = -1;
            st.Pending.Clear();
            st.Cache.Clip = null;
            st.SentSeq = -1;
            st.SentAny = false;
            st.SentClip = null;
            st.SentValues.Clear();
            st.LastJson = null;
            st.MethodsGen = -1;
            st.Rev++;
            st.Dirty = true;
        }
    }

    static void ResumeTunerAnimAfterDiscard(TunerAnimState st, double now, bool playing)
    {
        if (playing || now > st.ResumeAt)
        {
            st.ResumeAt = -1;
            st.ResumePreview = false;
            st.RestoreTime = -1;
            return;
        }
        if (st.Owner == null || st.Clip == null) return;
        st.ResumeAt = -1;
        st.RestoreTime = -1;
        if (!st.ResumePreview) return;
        st.ResumePreview = false;
        StartTunerAnimPreview(st);
    }

    static void FlushTunerAnimSaves(TunerAnimState st)
    {
        foreach (var c in st.SaveClips)
            if (c != null) TunerSaveAsset(c);
        st.SaveClips.Clear();
        st.SaveAt = -1;
    }

    static void TickTunerAnimator(TunerSession s, double now, bool playing)
    {
        var st = TunerAnimOf(s);
        ResolveTunerAnim(s, st, now);
        if (st.ResumeAt >= 0) ResumeTunerAnimAfterDiscard(st, now, playing);
        if (st.SaveAt >= 0 && now >= st.SaveAt) FlushTunerAnimSaves(st);
        if (st.Owner != null && st.Clip != null)
        {
            if (!playing)
            {
                if (st.Preview && st.Playing)
                {
                    double dt = Math.Min(0.25, Math.Max(0, now - st.PlayAt));
                    st.PlayAt = now;
                    double len = Math.Max(1e-3, TunerAnimLen(st));
                    st.Time += dt;
                    if (st.Time >= len)
                    {
                        if (st.Clip.isLooping) st.Time %= len;
                        else
                        {
                            st.Time = len;
                            st.Playing = false;
                        }
                    }
                    SampleTunerAnim(st);
                    s.Dirty = true;
                    NoteTunerActivity();
                    WakeTunerAt(now + TUNER_DRAG_FRAME_INTERVAL, now);
                }
                else if (st.Preview && st.SampledRev != st.Rev)
                {
                    SampleTunerAnim(st);
                    s.Dirty = true;
                }
            }
            else if (st.Live && st.Hold == null)
            {
                if (TunerAnimLive(st.Owner, out var live, out var t))
                {
                    if (live != st.Clip && TunerAnimClips(st.Owner).Contains(live))
                    {
                        st.Clip = live;
                        st.Rev++;
                    }
                    if (live == st.Clip && Math.Abs(t - st.Time) > 1e-5)
                    {
                        st.Time = t;
                        st.Dirty = true;
                    }
                }
                WakeTunerAt(now + TUNER_ANIM_REFRESH_PLAY, now);
            }
            else if (st.Hold != null && st.SampledRev != st.Rev)
            {
                SampleTunerAnim(st);
                s.Dirty = true;
            }
        }
        if (now >= st.RefreshAt)
        {
            st.RefreshAt = now + (playing ? TUNER_ANIM_REFRESH_PLAY : TUNER_ANIM_REFRESH_EDIT);
            st.Dirty = true;
        }
        EmitTunerAnimator(s, st, now, playing);
    }

    static void EmitTunerAnimator(TunerSession s, TunerAnimState st, double now, bool playing)
    {
        if (!st.Dirty || now < st.NextEmit) return;
        st.NextEmit = now + TUNER_ANIM_EMIT;
        st.Dirty = false;
        string json;
        try { json = TunerAnimJson(st, playing); }
        catch (Exception e)
        {
            Debug.LogException(e);
            st.Error = e.GetType().Name + ": " + e.Message;
            json = "{\"mode\":" + (playing ? "\"play\"" : "\"edit\"") + ",\"error\":" + JStr(st.Error) + "}";
        }
        if (st.Sent && json == st.LastJson) return;
        st.Sent = true;
        st.LastJson = json;
        st.EmitCount++;
        st.EmitBytes += json.Length;
        TunerEmit(s.Client, "{\"type\":\"event\",\"event\":\"tuner/live\",\"session\":" + s.NameJson + ",\"animator\":" + json + "}");
    }

    static bool HandleTunerAnimator(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/animator") return false;
        TunerAnimatorCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerAnimatorCommand>(line); }
        catch (Exception e)
        {
            TunerResult(from, id, "bad arguments: " + e.Message, null);
            return true;
        }
        var args = parsed != null ? parsed.args : null;
        var s = args != null ? FindTuner(args.session) : null;
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + (args != null ? args.session : "") + "'", null);
            return true;
        }
        var st = TunerAnimOf(s);
        string err;
        string data = null;
        try { err = RunTunerAnimOp(s, st, args, out data); }
        catch (Exception e)
        {
            Debug.LogException(e);
            err = e.GetType().Name + ": " + e.Message;
        }
        st.Dirty = true;
        st.NextEmit = 0;
        s.Dirty = true;
        SignalEditorTick();
        if (err != null) TunerResult(from, id, err, null);
        else TunerResult(from, id, null, "\"time\":" + Num(st.Time) + ",\"rev\":" + st.Rev + (data != null ? ",\"data\":" + data : ""));
        return true;
    }

    static TunerAnimEditCtx TunerAnimCtx(TunerAnimState st, string label, AnimationClip clip = null)
    {
        return new TunerAnimEditCtx { Clip = clip ?? st.Clip, Root = st.Owner != null ? st.Owner.Root : null, Label = label, Touch = c => TouchTunerAnimClip(st, c) };
    }

    static void TouchTunerAnimClip(TunerAnimState st, AnimationClip clip)
    {
        if (clip == null) return;
        st.Touched.Add(clip);
    }

    static double TunerAnimTimeArg(TunerAnimState st, TunerAnimatorArgs a)
    {
        if (a.frame >= 0 && st.Clip != null) return a.frame / (double)TunerAnimFps(st.Clip);
        if (!float.IsNaN(a.time)) return a.time;
        return st.Time;
    }

    static void SetTunerAnimTime(TunerAnimState st, double t, bool playing)
    {
        double len = TunerAnimLen(st);
        st.Time = Math.Max(0, Math.Min(Math.Max(len, 0), t));
        st.Playing = false;
        st.Pending.Clear();
        if (playing)
        {
            TakeOverTunerAnim(st);
            st.SampledRev = -1;
            SampleTunerAnim(st);
        }
        else if (StartTunerAnimPreview(st)) SampleTunerAnim(st);
    }

    static List<float> TunerAnimKeyTimes(AnimationClip clip)
    {
        var set = new SortedSet<float>();
        if (clip == null) return set.ToList();
        foreach (var b in AnimationUtility.GetCurveBindings(clip))
        {
            var c = AnimationUtility.GetEditorCurve(clip, b);
            if (c != null)
                foreach (var k in c.keys) set.Add(k.time);
        }
        foreach (var b in AnimationUtility.GetObjectReferenceCurveBindings(clip))
            foreach (var k in AnimationUtility.GetObjectReferenceCurve(clip, b) ?? new ObjectReferenceKeyframe[0]) set.Add(k.time);
        return set.ToList();
    }

    static string RunTunerAnimOp(TunerSession s, TunerAnimState st, TunerAnimatorArgs a, out string data)
    {
        data = null;
        bool playing = EditorApplication.isPlaying;
        if (st.DragGroup >= 0 && a.op != "moveKeys" && a.op != "setTangents" && a.op != "tangent" && a.op != "model") EndTunerAnimDrag(st);
        switch (a.op)
        {
            case "close":
            {
                bool held = CloseTunerAnim(st);
                Debug.Log("[Tuner] animator panel closed: preview, Record and playback are off" + (held ? ", the game drives the object again" : ""));
                return null;
            }
            case "undo":
                Undo.PerformUndo();
                return null;
            case "redo":
                Undo.PerformRedo();
                return null;
            case "model":
                st.SentSeq = -1;
                st.SentAny = false;
                st.SentClip = null;
                st.SentValues.Clear();
                st.LastJson = null;
                return null;
            case "lock":
            {
                st.Locked = a.locked > 0 && st.Owner != null;
                st.LockKeep = st.Locked ? TunerObjectPath(st.Owner.Root) : null;
                st.LockPath = null;
                if (!st.Locked)
                {
                    st.SelGo = null;
                    st.SelGen = -1;
                }
                st.Dirty = true;
                Debug.Log("[Tuner] animator " + (st.Locked ? "locked on " + st.Owner.Root.name + ": selecting other objects keeps this clip" : "unlocked: the timeline follows the selection"));
                return null;
            }
            case "createClip":
            {
                var target = st.Owner != null ? st.Owner.Root : st.Target;
                if (!string.IsNullOrEmpty(a.obj)) target = FindTunerObject(TunerScenes(), new TunerObjectArgs { path = a.obj });
                StopTunerAnimPreview(st);
                Undo.IncrementCurrentGroup();
                Undo.SetCurrentGroupName("Create clip");
                _tunerAnimNewAssets.Clear();
                var err = TunerAnimCreateClip(target, a.name, out var made);
                foreach (var np in _tunerAnimNewAssets) NoteTunerCreatedAsset(np);
                if (err != null) return err;
                st.WantClip = AssetDatabase.GetAssetPath(made);
                st.SelGo = null;
                st.SelGen = -1;
                st.Owner = null;
                st.Clip = null;
                ResolveTunerAnim(s, st, EditorApplication.timeSinceStartup);
                if (st.Clip != made && st.Owner != null && TunerAnimClips(st.Owner).Contains(made))
                {
                    st.Clip = made;
                    st.Rev++;
                }
                data = JStr(AssetDatabase.GetAssetPath(made));
                return null;
            }
        }
        if (st.Owner == null) return st.Target != null ? "this object has no clips yet: create one first" : "select an animated object first";
        switch (a.op)
        {
            case "clip":
            {
                var clips = TunerAnimClips(st.Owner);
                var pick = clips.FirstOrDefault(c => TunerAnimClipKey(c) == a.clip)
                    ?? clips.FirstOrDefault(c => AssetDatabase.GetAssetPath(c) == a.clip)
                    ?? clips.FirstOrDefault(c => c.name == a.clip);
                if (pick == null) return "no clip '" + a.clip + "' on " + st.Owner.Root.name;
                bool was = st.Preview;
                StopTunerAnimPreview(st);
                st.Clip = pick;
                st.WantClip = TunerAnimClipKey(pick);
                st.Time = Math.Min(st.Time, pick.length);
                st.Rev++;
                if (playing && st.Hold != null) SampleTunerAnim(st);
                else if (was) StartTunerAnimPreview(st);
                Debug.Log("[Tuner] animator clip " + pick.name + " (" + st.WantClip + ")");
                return null;
            }
            case "duplicateClip":
            {
                if (st.Clip == null) return "no clip is open";
                if (TunerAnimReadOnly(st.Clip) == null) return "clip " + st.Clip.name + " is already editable";
                StopTunerAnimPreview(st);
                _tunerAnimNewAssets.Clear();
                var err = TunerAnimDuplicate(st.Owner, st.Clip, out var made);
                foreach (var np in _tunerAnimNewAssets) NoteTunerCreatedAsset(np);
                if (err != null) return err;
                st.Clip = made;
                st.WantClip = AssetDatabase.GetAssetPath(made);
                st.Rev++;
                data = JStr(st.WantClip);
                return null;
            }
        }
        if (st.Clip == null) return "this object has no clips yet: create one first";
        switch (a.op)
        {
            case "preview":
                if (playing) return null;
                if (a.value == "0" || a.value == "false") StopTunerAnimPreview(st);
                else if (!StartTunerAnimPreview(st)) return st.Status.Length > 0 ? st.Status : "the preview could not start";
                return null;
            case "time":
                SetTunerAnimTime(st, TunerAnimTimeArg(st, a), playing);
                return null;
            case "first":
                SetTunerAnimTime(st, 0, playing);
                return null;
            case "last":
                SetTunerAnimTime(st, TunerAnimLen(st), playing);
                return null;
            case "step":
            {
                double fps = TunerAnimFps(st.Clip);
                double f = Math.Round(st.Time * fps) + (a.dir < 0 ? -1 : 1);
                SetTunerAnimTime(st, f / fps, playing);
                return null;
            }
            case "prevKey":
            case "nextKey":
            {
                var times = TunerAnimKeyTimes(st.Clip);
                int cur = TunerAnimFrame(st.Clip, st.Time);
                float? hit = null;
                if (a.op == "nextKey")
                {
                    foreach (var t in times)
                        if (TunerAnimFrame(st.Clip, t) > cur)
                        {
                            hit = t;
                            break;
                        }
                }
                else
                    for (int i = times.Count - 1; i >= 0; i--)
                        if (TunerAnimFrame(st.Clip, times[i]) < cur)
                        {
                            hit = times[i];
                            break;
                        }
                if (hit.HasValue) SetTunerAnimTime(st, hit.Value, playing);
                return null;
            }
            case "play":
                if (playing)
                {
                    ReleaseTunerAnimHold(st);
                    return null;
                }
                if (!StartTunerAnimPreview(st)) return st.Status.Length > 0 ? st.Status : "the preview could not start";
                if (st.Time >= TunerAnimLen(st) - 1e-4) st.Time = 0;
                st.Playing = true;
                st.PlayAt = EditorApplication.timeSinceStartup;
                return null;
            case "pause":
                st.Playing = false;
                if (playing)
                {
                    TakeOverTunerAnim(st);
                    st.SampledRev = -1;
                    SampleTunerAnim(st);
                }
                return null;
            case "resume":
                if (playing) ReleaseTunerAnimHold(st);
                return null;
            case "record":
            {
                bool on = !(a.value == "0" || a.value == "false");
                if (on && TunerAnimReadOnly(st.Clip) is string ro) return ro;
                st.Record = on;
                if (on)
                {
                    st.Playing = false;
                    if (playing) TakeOverTunerAnim(st);
                    else if (!StartTunerAnimPreview(st)) return st.Status.Length > 0 ? st.Status : "the preview could not start";
                }
                Debug.Log("[Tuner] animator record " + (on ? "on" : "off") + " for " + st.Clip.name);
                return null;
            }
            case "props":
                if (st.Owner != null && st.Owner.Root != null) _tunerAnimatable.Remove(st.Owner.Root);
                data = TunerAnimPropsJson(st);
                return null;
            case "rootMotion":
            {
                st.RootMotion = a.value == "auto" ? -1 : a.value == "0" || a.value == "false" || a.value == "off" ? 0 : 1;
                st.SampledRev = -1;
                Debug.Log("[Tuner] animator root motion " + (TunerRootMotionOn(st) ? "on: the character travels like Apply Root Motion in the game" : "off: the character stays in place") + (st.RootMotion < 0 ? " (follows the Animator's Apply Root Motion)" : "") + " for " + st.Owner.Root.name);
                return null;
            }
        }
        var editClip = st.Clip;
        if (TunerAnimReadOnly(editClip) is string readOnly) return readOnly;
        var ctx = TunerAnimCtx(st, "Tuner " + a.op, editClip);
        if (st.DragGroup < 0)
        {
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Tuner " + a.op);
        }
        string result;
        switch (a.op)
        {
            case "addKey":
            {
                var ids = TunerAnimExpandIds(st, editClip, a.ids, a.id);
                if (ids.Count == 0)
                {
                    if (st.Pending.Count > 0) ids.AddRange(st.Pending.Keys);
                    if (ids.Count == 0) ids.AddRange(TunerAnimClipBindings(editClip).Where(b => !b.isPPtrCurve).Select(TunerAnimId));
                }
                result = TunerAnimAddKeys(ctx, ids, TunerAnimTimeArg(st, a), new Dictionary<string, float>(st.Pending), false, null);
                break;
            }
            case "setKey":
            {
                var values = new Dictionary<string, float>();
                var ids = new List<string>();
                foreach (var k in a.keys ?? new TunerAnimKeyArg[0])
                {
                    if (k == null || !k.hasV) continue;
                    var id = TunerAnimKeyId(editClip, ctx.Root, k);
                    if (id == null) return "a key needs id, or prop (with path and type)";
                    values[id] = k.v;
                    ids.Add(id);
                }
                if (ids.Count == 0) return "setKey needs keys with a value";
                result = TunerAnimAddKeys(ctx, ids, TunerAnimTimeArg(st, a), values, false, null);
                break;
            }
            case "deleteKeys":
                result = TunerAnimDeleteKeys(ctx, a.keys);
                break;
            case "moveKeys":
                result = TunerAnimDrag(st, a, () =>
                {
                    ctx.DragBase = st.DragBase;
                    return TunerAnimMoveKeys(ctx, a.keys, a.df, a.dv, a.copy, !a.live);
                });
                break;
            case "pasteKeys":
                result = TunerAnimPasteKeys(ctx, a.keys, TunerAnimTimeArg(st, a));
                break;
            case "tangent":
                result = TunerAnimDrag(st, a, () => TunerAnimSetTangents(ctx, a.keys, a.mode, !(a.value == "0" || a.value == "false"), !a.live));
                break;
            case "setTangents":
                result = TunerAnimDrag(st, a, () => TunerAnimSetRaw(ctx, a.keys, !a.live));
                break;
            case "addProp":
                result = TunerAnimAddProps(ctx, TunerAnimIds(a.ids, a.id));
                break;
            case "removeProp":
                result = TunerAnimRemoveProps(ctx, TunerAnimIds(a.ids, a.id));
                break;
            case "addEvent":
            case "moveEvent":
            case "editEvent":
            case "deleteEvent":
                result = TunerAnimEventOp(ctx, a.op, a.index, TunerAnimTimeArg(st, a), a.ev, a.indices);
                break;
            case "settings":
                result = TunerAnimSettings(ctx, a.length, a.frameRate, a.loop);
                break;
            default:
                return "unknown animator op '" + a.op + "'";
        }
        if (result != null) return result;
        st.Rev++;
        if (a.op == "addKey" || a.op == "setKey") st.Pending.Clear();
        if (a.live)
        {
            st.DragSteps++;
            return null;
        }
        Debug.Log("[Tuner] animator " + a.op + " on " + editClip.name + " at f" + TunerAnimFrame(st.Clip, TunerAnimTimeArg(st, a)) + TunerAnimOpNote(a, st.DragSteps));
        st.DragSteps = 0;
        return null;
    }


    static string TunerAnimOpNote(TunerAnimatorArgs a, int steps = 0)
    {
        var parts = new List<string>();
        if (a.keys != null && a.keys.Length > 0) parts.Add(a.keys.Length + " key" + (a.keys.Length == 1 ? "" : "s"));
        if (a.ids != null && a.ids.Length > 0) parts.Add(string.Join(", ", a.ids));
        else if (!string.IsNullOrEmpty(a.id)) parts.Add(a.id);
        if (a.df != 0) parts.Add("by " + a.df + " frames");
        if (a.dv != 0f) parts.Add("value " + a.dv.ToString("+0.###;-0.###", Inv));
        if (a.copy) parts.Add("copy");
        if (!string.IsNullOrEmpty(a.mode)) parts.Add(a.mode);
        if (a.index >= 0) parts.Add("event #" + a.index);
        if (a.length >= 0f) parts.Add("length " + a.length.ToString("0.###", Inv));
        if (a.frameRate > 0f) parts.Add("frame rate " + a.frameRate.ToString("0.###", Inv));
        if (a.loop >= 0) parts.Add("loop " + (a.loop > 0 ? "on" : "off"));
        if (steps > 0) parts.Add("after " + steps + " live step" + (steps == 1 ? "" : "s"));
        return parts.Count > 0 ? " (" + string.Join(", ", parts) + ")" : "";
    }

    static string TunerAnimDrag(TunerAnimState st, TunerAnimatorArgs a, Func<string> apply)
    {
        if (a.live && st.DragGroup < 0)
        {
            Undo.IncrementCurrentGroup();
            st.DragGroup = Undo.GetCurrentGroup();
            st.DragBase = new Dictionary<string, AnimationCurve>();
        }
        var r = apply();
        if (!a.live) EndTunerAnimDrag(st);
        return r;
    }

    static void EndTunerAnimDrag(TunerAnimState st)
    {
        if (st.DragGroup >= 0) Undo.CollapseUndoOperations(st.DragGroup);
        st.DragGroup = -1;
        st.DragBase = null;
    }

    static List<string> TunerAnimIds(string[] ids, string id)
    {
        var list = new List<string>();
        if (ids != null) list.AddRange(ids.Where(x => !string.IsNullOrEmpty(x)));
        if (!string.IsNullOrEmpty(id)) list.Add(id);
        return list;
    }

    static List<string> TunerAnimExpandIds(TunerAnimState st, AnimationClip clip, string[] ids, string id)
    {
        var want = TunerAnimIds(ids, id);
        var outIds = new List<string>();
        if (want.Count == 0) return outIds;
        var all = TunerAnimClipBindings(clip).Where(b => !b.isPPtrCurve).ToList();
        foreach (var w in want)
        {
            bool hit = false;
            foreach (var b in all)
            {
                var bid = TunerAnimId(b);
                var gid = b.path + "|" + b.type.FullName + "|" + TunerAnimGroupOf(b.propertyName, out _);
                var oid = b.path + "|" + b.type.FullName;
                if (bid == w || gid == w || oid == w || b.path == w || w == "*")
                {
                    if (!outIds.Contains(bid)) outIds.Add(bid);
                    hit = true;
                }
            }
            if (!hit && !outIds.Contains(w)) outIds.Add(w);
        }
        return outIds;
    }

    static int _tunerAnimModSeq;

    static UndoPropertyModification[] OnTunerAnimModifications(UndoPropertyModification[] mods)
    {
        if (mods != null && mods.Length > 0) _tunerAnimModSeq++;
        if (_tunerAnims.Count == 0 || mods == null || mods.Length == 0 || _tunerAnimApplying) return mods;
        TunerAnimState st = null;
        bool playing = EditorApplication.isPlaying;
        foreach (var x in _tunerAnims.Values)
            if (x.Owner != null && x.Owner.Root != null && x.Clip != null && (playing ? x.Hold != null : x.Preview))
            {
                st = x;
                break;
            }
        if (st == null) return mods;
        try { return ProcessTunerAnimMods(st, mods, playing); }
        catch (Exception e)
        {
            Debug.LogException(e);
            return mods;
        }
    }

    static void TunerAnimRecordSame(UnityEngine.Object target, string path)
    {
        if (target == null || string.IsNullOrEmpty(path) || _tunerAnims.Count == 0 || EditorApplication.isPlaying) return;
        if (!(target is Component) && !(target is GameObject)) return;
        if (!_tunerAnims.Values.Any(x => x.Record && x.Preview && x.Owner != null && x.Owner.Root != null && x.Clip != null)) return;
        var so = new SerializedObject(target);
        var p = so.FindProperty(path);
        if (p == null) return;
        var mods = new List<UndoPropertyModification>();
        void add(SerializedProperty q)
        {
            string v;
            switch (q.propertyType)
            {
                case SerializedPropertyType.Float: v = q.floatValue.ToString("R", Inv); break;
                case SerializedPropertyType.Integer: v = q.intValue.ToString(Inv); break;
                case SerializedPropertyType.Boolean: v = q.boolValue ? "1" : "0"; break;
                case SerializedPropertyType.Enum: v = q.intValue.ToString(Inv); break;
                default: return;
            }
            var pm = new PropertyModification { target = target, propertyPath = q.propertyPath, value = v };
            var pm2 = new PropertyModification { target = target, propertyPath = q.propertyPath, value = v };
            mods.Add(new UndoPropertyModification { previousValue = pm, currentValue = pm2 });
        }
        if (p.hasVisibleChildren || p.propertyType == SerializedPropertyType.Quaternion || p.propertyType == SerializedPropertyType.Vector3 || p.propertyType == SerializedPropertyType.Vector2 || p.propertyType == SerializedPropertyType.Vector4 || p.propertyType == SerializedPropertyType.Color)
        {
            var it = p.Copy();
            var end = p.GetEndProperty();
            if (it.Next(true))
                while (!SerializedProperty.EqualContents(it, end))
                {
                    add(it);
                    if (!it.Next(false)) break;
                }
        }
        else add(p);
        if (mods.Count == 0) return;
        OnTunerAnimModifications(mods.ToArray());
        Debug.Log("[Tuner] animator: Record keyed " + path + " on " + target.name + " at its current value");
    }

    sealed class TunerAnimRot
    {
        public Transform T;
        public readonly List<UndoPropertyModification> Mods = new List<UndoPropertyModification>();
    }

    static UndoPropertyModification[] ProcessTunerAnimMods(TunerAnimState st, UndoPropertyModification[] mods, bool playing)
    {
        var root = st.Owner.Root;
        var clip = st.Clip;
        bool record = st.Record && TunerAnimReadOnly(clip) == null;
        var keep = new List<UndoPropertyModification>();
        var rots = new Dictionary<Transform, TunerAnimRot>();
        var vecs = new Dictionary<(Transform, string), List<UndoPropertyModification>>();
        var others = new List<(EditorCurveBinding b, UndoPropertyModification m)>();
        foreach (var m in mods)
        {
            var pm = m.currentValue ?? m.previousValue;
            var target = pm != null ? pm.target : null;
            Transform owner = target is Component comp ? comp.transform : target is GameObject g ? g.transform : null;
            if (owner == null || !(owner == root.transform || owner.IsChildOf(root.transform)))
            {
                keep.Add(m);
                continue;
            }
            var path = pm.propertyPath ?? "";
            if (target is Transform tr && !(target is RectTransform) && (path.StartsWith("m_LocalRotation.", StringComparison.Ordinal) || path.StartsWith("m_LocalEulerAnglesHint.", StringComparison.Ordinal)))
            {
                if (!rots.TryGetValue(tr, out var r)) rots[tr] = r = new TunerAnimRot { T = tr };
                r.Mods.Add(m);
                continue;
            }
            if (target is Transform tv && !(target is RectTransform) && (path.StartsWith("m_LocalPosition.", StringComparison.Ordinal) || path.StartsWith("m_LocalScale.", StringComparison.Ordinal)))
            {
                var key = (tv, path.Substring(0, path.IndexOf('.')));
                if (!vecs.TryGetValue(key, out var l)) vecs[key] = l = new List<UndoPropertyModification>();
                l.Add(m);
                continue;
            }
            var type = AnimationUtility.PropertyModificationToEditorCurveBinding(pm, root, out var b);
            if (type == null || b.isPPtrCurve)
            {
                keep.Add(m);
                continue;
            }
            others.Add((b, m));
        }
        var values = new Dictionary<string, float>();
        var prevs = new Dictionary<string, float>();
        var handled = new List<(EditorCurveBinding b, UndoPropertyModification m)>();
        foreach (var r in rots.Values)
        {
            var path = AnimationUtility.CalculateTransformPath(r.T, root.transform);
            var prefix = TunerAnimEulerPrefixFor(clip, path);
            var ids = "xyz".Select(c => EditorCurveBinding.FloatCurve(path, typeof(Transform), prefix + "." + c)).ToArray();
            bool animated = ids.Any(x => AnimationUtility.GetEditorCurve(clip, x) != null);
            if (!record && !animated)
            {
                keep.AddRange(r.Mods);
                continue;
            }
            var prevQ = r.T.localRotation;
            var hint = TransformUtils.GetInspectorRotation(r.T);
            bool hasHint = false;
            foreach (var m in r.Mods)
            {
                if (m.currentValue != null && m.currentValue.propertyPath.StartsWith("m_LocalEulerAnglesHint.", StringComparison.Ordinal)) hasHint = true;
                var p = m.previousValue;
                if (p == null || !float.TryParse(p.value, System.Globalization.NumberStyles.Float, Inv, out var f)) continue;
                switch (p.propertyPath)
                {
                    case "m_LocalRotation.x": prevQ.x = f; break;
                    case "m_LocalRotation.y": prevQ.y = f; break;
                    case "m_LocalRotation.z": prevQ.z = f; break;
                    case "m_LocalRotation.w": prevQ.w = f; break;
                }
            }
            Vector3 reference = hint;
            for (int i = 0; i < 3; i++)
            {
                var c = AnimationUtility.GetEditorCurve(clip, ids[i]);
                if (c != null && c.length > 0) reference[i] = c.Evaluate((float)st.Time);
            }
            var cur = TunerAnimClosestEuler(r.T.localRotation, hasHint ? hint : reference);
            var prv = TunerAnimClosestEuler(prevQ, reference);
            for (int i = 0; i < 3; i++)
            {
                var id = TunerAnimId(ids[i]);
                values[id] = cur[i];
                prevs[id] = prv[i];
            }
            foreach (var m in r.Mods)
                if (m.previousValue != null) handled.Add((EditorCurveBinding.FloatCurve(path, typeof(Transform), m.previousValue.propertyPath), m));
        }
        foreach (var kv in vecs)
        {
            var t = kv.Key.Item1;
            var prefix = kv.Key.Item2;
            var path = AnimationUtility.CalculateTransformPath(t, root.transform);
            var ids = "xyz".Select(c => EditorCurveBinding.FloatCurve(path, typeof(Transform), prefix + "." + c)).ToArray();
            bool animated = ids.Any(x => AnimationUtility.GetEditorCurve(clip, x) != null);
            if (!record && !animated)
            {
                keep.AddRange(kv.Value);
                continue;
            }
            var curV = prefix == "m_LocalPosition" ? t.localPosition : t.localScale;
            var prvV = curV;
            foreach (var m in kv.Value)
            {
                var p = m.previousValue;
                if (p == null || !float.TryParse(p.value, System.Globalization.NumberStyles.Float, Inv, out var f)) continue;
                int axis = p.propertyPath.EndsWith(".x", StringComparison.Ordinal) ? 0 : p.propertyPath.EndsWith(".y", StringComparison.Ordinal) ? 1 : 2;
                prvV[axis] = f;
            }
            for (int i = 0; i < 3; i++)
            {
                var id = TunerAnimId(ids[i]);
                values[id] = curV[i];
                prevs[id] = prvV[i];
            }
            foreach (var m in kv.Value)
                if (m.previousValue != null) handled.Add((EditorCurveBinding.FloatCurve(path, typeof(Transform), m.previousValue.propertyPath), m));
        }
        foreach (var (b, m) in others)
        {
            bool animated = AnimationUtility.GetEditorCurve(clip, b) != null;
            if (!record && !animated)
            {
                keep.Add(m);
                continue;
            }
            var id = TunerAnimId(b);
            if (!TunerAnimCurrent(root, b, out var v)) continue;
            values[id] = v;
            if (m.previousValue != null && float.TryParse(m.previousValue.value, System.Globalization.NumberStyles.Float, Inv, out var pv)) prevs[id] = pv;
            handled.Add((b, m));
        }
        if (handled.Count == 0) return mods;
        if (!playing && st.Preview && _tunerAnimDriver != null && AnimationMode.InAnimationMode(_tunerAnimDriver))
            foreach (var (b, m) in handled)
                if (m.previousValue != null)
                {
                    try { AnimationMode.AddPropertyModification(b, m.previousValue, m.keepPrefabOverride); }
                    catch (Exception e) { Debug.LogWarning("[Tuner] animator: could not hold " + b.propertyName + ": " + e.Message); }
                }
        if (values.Count == 0)
        {
            st.Dirty = true;
            return keep.ToArray();
        }
        if (record)
        {
            var ctx = TunerAnimCtx(st, "Tuner record");
            var err = TunerAnimAddKeys(ctx, values.Keys.ToList(), st.Time, values, true, prevs, false);
            if (err != null)
            {
                st.Error = err;
                return mods;
            }
            st.SaveClips.Add(clip);
            st.SaveAt = EditorApplication.timeSinceStartup + TUNER_ANIM_SAVE_DELAY;
            st.Rev++;
            st.SampledRev = st.Rev;
            Debug.Log("[Tuner] animator recorded " + values.Count + " channel" + (values.Count == 1 ? "" : "s") + " at f" + TunerAnimFrame(clip, st.Time) + " in " + clip.name + ": "
                    + string.Join(", ", values.Select(kv => TunerAnimShortId(kv.Key) + "=" + kv.Value.ToString("0.###", Inv))));
        }
        else
        {
            foreach (var kv in values) st.Pending[kv.Key] = kv.Value;
            Debug.Log("[Tuner] animator: " + values.Count + " animated value" + (values.Count == 1 ? "" : "s") + " changed without Record (" + string.Join(", ", values.Keys.Select(TunerAnimShortId)) + "), Add Key keeps them");
        }
        st.Dirty = true;
        return keep.ToArray();
    }

    static string TunerAnimShortId(string id)
    {
        var parts = id.Split('|');
        if (parts.Length < 3) return id;
        return (parts[0].Length > 0 ? parts[0] + ":" : "") + parts[2];
    }
}
