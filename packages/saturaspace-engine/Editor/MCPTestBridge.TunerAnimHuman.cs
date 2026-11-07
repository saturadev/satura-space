using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.Animations;
using UnityEngine.Playables;

public static partial class MCPTestBridge
{
    static bool _tunerHumanReflected;
    static MethodInfo _tunerMotionXCreate;
    static MethodInfo _tunerMotionXAbsolute;
    static MethodInfo _tunerMotionXPlayable;
    static MethodInfo _tunerClipOverrideLoop;
    static MethodInfo _tunerClipLoopTime;
    static Dictionary<string, int> _tunerMuscleIndex;
    static string[] _tunerMuscleProp;

    static readonly string[] TunerHumanSections = { "Root", "IK Goals", "Body", "Head", "Left Arm", "Left Fingers", "Right Arm", "Right Fingers", "Left Leg", "Right Leg", "Other" };
    static readonly string[] TunerHumanRootGroups = { "RootT", "RootQ", "MotionT", "MotionQ" };
    static readonly string[] TunerHumanGoalGroups = { "LeftFootT", "LeftFootQ", "RightFootT", "RightFootQ", "LeftHandT", "LeftHandQ", "RightHandT", "RightHandQ" };

    static void ReflectTunerHuman()
    {
        if (_tunerHumanReflected) return;
        _tunerHumanReflected = true;
        try
        {
            var t = typeof(AnimationClipPlayable).Assembly.GetType("UnityEngine.Animations.AnimationMotionXToDeltaPlayable");
            if (t != null)
            {
                _tunerMotionXCreate = t.GetMethod("Create", BindingFlags.Public | BindingFlags.Static, null, new[] { typeof(PlayableGraph) }, null);
                _tunerMotionXAbsolute = t.GetMethod("SetAbsoluteMotion", BindingFlags.Public | BindingFlags.Instance);
                _tunerMotionXPlayable = t.GetMethod("op_Implicit", new[] { t });
            }
            _tunerClipOverrideLoop = typeof(AnimationClipPlayable).GetMethod("SetOverrideLoopTime", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
            _tunerClipLoopTime = typeof(AnimationClipPlayable).GetMethod("SetLoopTime", BindingFlags.NonPublic | BindingFlags.Public | BindingFlags.Instance);
        }
        catch (Exception e) { Debug.LogException(e); }
    }

    static Playable TunerMotionXNode(PlayableGraph g)
    {
        ReflectTunerHuman();
        if (_tunerMotionXCreate == null || _tunerMotionXAbsolute == null || _tunerMotionXPlayable == null) return Playable.Null;
        try
        {
            var node = _tunerMotionXCreate.Invoke(null, new object[] { g });
            _tunerMotionXAbsolute.Invoke(node, new object[] { true });
            return (Playable)_tunerMotionXPlayable.Invoke(null, new[] { node });
        }
        catch (Exception e)
        {
            Debug.LogException(e);
            return Playable.Null;
        }
    }

    static void TunerClipPlayOnce(AnimationClipPlayable cp)
    {
        ReflectTunerHuman();
        try
        {
            _tunerClipOverrideLoop?.Invoke(cp, new object[] { true });
            _tunerClipLoopTime?.Invoke(cp, new object[] { false });
        }
        catch (Exception e) { Debug.LogException(e); }
    }

    static readonly List<PlayableGraph> _tunerGraphsMade = new List<PlayableGraph>();

    static void NoteTunerGraph(PlayableGraph g)
    {
        _tunerGraphsMade.RemoveAll(x => !x.IsValid());
        _tunerGraphsMade.Add(g);
    }

    static PlayableGraph BuildTunerHumanGraph(Animator animator, AnimationClip clip, string name, out AnimationClipPlayable cp)
    {
        var g = PlayableGraph.Create(name);
        NoteTunerGraph(g);
        g.SetTimeUpdateMode(DirectorUpdateMode.Manual);
        cp = AnimationClipPlayable.Create(g, clip);
        TunerClipPlayOnce(cp);
        cp.SetApplyFootIK(false);
        var mixer = AnimationLayerMixerPlayable.Create(g, 1);
        mixer.ConnectInput(0, cp, 0, 1f);
        Playable root = mixer;
        var mx = TunerMotionXNode(g);
        if (mx.IsValid())
        {
            mx.SetInputWeight(0, 1f);
            g.Connect(root, 0, mx, 0);
            root = mx;
        }
        var output = AnimationPlayableOutput.Create(g, "output", animator);
        output.SetSourcePlayable(root);
        output.SetWeight(0f);
        return g;
    }

    static bool TunerHuman(TunerAnimOwner o)
    {
        return o != null && o.Kind != TunerAnimKind.Legacy && o.Animator != null && o.Animator.avatar != null && o.Animator.avatar.isHuman && o.Animator.avatar.isValid;
    }

    static bool TunerRootMotionOn(TunerAnimState st)
    {
        if (st.RootMotion >= 0) return st.RootMotion > 0;
        return st.Owner != null && st.Owner.Animator != null && st.Owner.Animator.applyRootMotion;
    }

    static void PlaceTunerRoot(Transform root, Vector3 restPos, Quaternion restRot, Vector3 a0p, Quaternion a0q, Vector3 atp, Quaternion atq, bool motion)
    {
        if (!motion)
        {
            root.localPosition = restPos;
            root.localRotation = restRot;
            return;
        }
        var inv = Quaternion.Inverse(a0q);
        root.localRotation = restRot * (inv * atq);
        root.localPosition = restPos + restRot * (inv * (atp - a0p));
    }

    static void InitTunerMuscles()
    {
        if (_tunerMuscleIndex != null) return;
        _tunerMuscleIndex = new Dictionary<string, int>();
        var names = HumanTrait.MuscleName;
        _tunerMuscleProp = new string[names.Length];
        for (int i = 0; i < names.Length; i++)
        {
            var n = names[i];
            string prop = n;
            var bone = HumanTrait.BoneFromMuscle(i);
            if (bone >= (int)HumanBodyBones.LeftThumbProximal && bone <= (int)HumanBodyBones.RightLittleDistal)
            {
                var side = n.StartsWith("Left ", StringComparison.Ordinal) ? "LeftHand" : "RightHand";
                var rest = n.Substring(n.IndexOf(' ') + 1);
                int sp = rest.IndexOf(' ');
                prop = sp > 0 ? side + "." + rest.Substring(0, sp) + "." + rest.Substring(sp + 1) : side + "." + rest;
            }
            _tunerMuscleProp[i] = prop;
            _tunerMuscleIndex[prop] = i;
            _tunerMuscleIndex[n] = i;
        }
    }

    static int TunerMuscleOf(string prop)
    {
        InitTunerMuscles();
        return _tunerMuscleIndex.TryGetValue(prop, out var i) ? i : -1;
    }

    static string TunerMuscleProp(int i)
    {
        InitTunerMuscles();
        return i >= 0 && i < _tunerMuscleProp.Length ? _tunerMuscleProp[i] : null;
    }

    static string TunerBonePart(int bone)
    {
        switch ((HumanBodyBones)bone)
        {
            case HumanBodyBones.Hips:
            case HumanBodyBones.Spine:
            case HumanBodyBones.Chest:
            case HumanBodyBones.UpperChest:
                return "Body";
            case HumanBodyBones.Neck:
            case HumanBodyBones.Head:
            case HumanBodyBones.LeftEye:
            case HumanBodyBones.RightEye:
            case HumanBodyBones.Jaw:
                return "Head";
            case HumanBodyBones.LeftShoulder:
            case HumanBodyBones.LeftUpperArm:
            case HumanBodyBones.LeftLowerArm:
            case HumanBodyBones.LeftHand:
                return "Left Arm";
            case HumanBodyBones.RightShoulder:
            case HumanBodyBones.RightUpperArm:
            case HumanBodyBones.RightLowerArm:
            case HumanBodyBones.RightHand:
                return "Right Arm";
            case HumanBodyBones.LeftUpperLeg:
            case HumanBodyBones.LeftLowerLeg:
            case HumanBodyBones.LeftFoot:
            case HumanBodyBones.LeftToes:
                return "Left Leg";
            case HumanBodyBones.RightUpperLeg:
            case HumanBodyBones.RightLowerLeg:
            case HumanBodyBones.RightFoot:
            case HumanBodyBones.RightToes:
                return "Right Leg";
        }
        var n = ((HumanBodyBones)bone).ToString();
        if (n.StartsWith("Left", StringComparison.Ordinal)) return "Left Fingers";
        if (n.StartsWith("Right", StringComparison.Ordinal)) return "Right Fingers";
        return "Other";
    }

    static bool TunerHumanBinding(EditorCurveBinding b) => b.type == typeof(Animator) && string.IsNullOrEmpty(b.path) && !b.isPPtrCurve;

    static string TunerHumanSection(string group, out string label, out int order)
    {
        order = 1000;
        int ri = Array.IndexOf(TunerHumanRootGroups, group);
        if (ri >= 0)
        {
            order = ri;
            label = ObjectNames.NicifyVariableName(group);
            return "Root";
        }
        int gi = Array.IndexOf(TunerHumanGoalGroups, group);
        if (gi >= 0)
        {
            order = gi;
            label = ObjectNames.NicifyVariableName(group);
            return "IK Goals";
        }
        int mi = TunerMuscleOf(group);
        if (mi >= 0)
        {
            order = mi;
            var part = TunerBonePart(HumanTrait.BoneFromMuscle(mi));
            var name = HumanTrait.MuscleName[mi];
            if (part.StartsWith("Left ", StringComparison.Ordinal) && name.StartsWith("Left ", StringComparison.Ordinal)) name = name.Substring(5);
            else if (part.StartsWith("Right ", StringComparison.Ordinal) && name.StartsWith("Right ", StringComparison.Ordinal)) name = name.Substring(6);
            label = name;
            return part;
        }
        if (group.EndsWith("TDOF", StringComparison.Ordinal))
        {
            var boneName = group.Substring(0, group.Length - 4);
            if (Enum.TryParse<HumanBodyBones>(boneName, out var hb))
            {
                order = 500 + (int)hb;
                var part = TunerBonePart((int)hb);
                var nice = ObjectNames.NicifyVariableName(boneName);
                if (part.StartsWith("Left ", StringComparison.Ordinal) && nice.StartsWith("Left ", StringComparison.Ordinal)) nice = nice.Substring(5);
                else if (part.StartsWith("Right ", StringComparison.Ordinal) && nice.StartsWith("Right ", StringComparison.Ordinal)) nice = nice.Substring(6);
                label = nice + " Translation";
                return part;
            }
        }
        label = ObjectNames.NicifyVariableName(group);
        return "Other";
    }

    static int TunerHumanSectionOrder(string section)
    {
        int i = Array.IndexOf(TunerHumanSections, section);
        return i < 0 ? TunerHumanSections.Length : i;
    }
}
