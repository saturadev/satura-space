using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text;
using SaturaSpace;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using TangentMode = UnityEditor.AnimationUtility.TangentMode;

public static partial class MCPTestBridge
{
    const int CLIPS_KEYS_SHOWN = 12;
    const int CLIPS_CURVES_SHOWN = 60;

    public static Func<UnityEngine.SceneManagement.Scene, bool> ExecSceneDirty;

    static SaturaClipException ClipsError(string message) => new SaturaClipException(message);

    static bool ClipsSceneDirty(UnityEngine.SceneManagement.Scene scene)
    {
        try
        {
            if (ExecSceneDirty != null) return ExecSceneDirty(scene);
        }
        catch (Exception) { }
        return scene.isDirty;
    }

    static GameObject ClipsFind(string obj)
    {
        if (string.IsNullOrWhiteSpace(obj)) return null;
        var go = FindTunerObject(TunerScenes(), new TunerObjectArgs { path = obj.Trim().Trim('/') });
        if (go == null) throw ClipsError("no object '" + obj + "' in the open scenes: pass its hierarchy path, like \"Rig/Cube\"");
        return go;
    }

    static AnimationClip ClipsResolve(string obj, string clipName, out GameObject go, out TunerAnimOwner owner)
    {
        if (string.IsNullOrEmpty(clipName) && obj != null && obj.Trim().EndsWith(".anim", StringComparison.OrdinalIgnoreCase))
        {
            clipName = obj.Trim();
            obj = null;
        }
        go = ClipsFind(obj);
        owner = TunerAnimOwnerOf(go);
        if (!string.IsNullOrEmpty(clipName) && clipName.StartsWith("Assets/", StringComparison.Ordinal))
        {
            var byPath = AssetDatabase.LoadAssetAtPath<AnimationClip>(clipName);
            if (byPath == null) byPath = AssetDatabase.LoadAllAssetsAtPath(clipName).OfType<AnimationClip>().FirstOrDefault(c => !c.name.StartsWith("__preview__", StringComparison.Ordinal));
            if (byPath == null) throw ClipsError("no AnimationClip at " + clipName);
            return byPath;
        }
        if (go == null) throw ClipsError("pass the object's scene path (plus a clip name when it has several), or the clip's asset path like \"Assets/Anim/Cube/Hop.anim\"");
        if (owner == null) throw ClipsError(go.name + " has no Animator or Animation with clips: SaturaClips.Create(\"" + TunerObjectPath(go) + "\", \"Name\") makes one");
        var clips = TunerAnimClips(owner);
        if (string.IsNullOrEmpty(clipName))
        {
            if (clips.Count == 1) return clips[0];
            throw ClipsError(clips.Count == 0
                ? owner.Root.name + " has no clips yet: SaturaClips.Create(\"" + TunerObjectPath(owner.Root) + "\", \"Name\") makes one"
                : owner.Root.name + " has " + clips.Count + " clips: pass one of " + string.Join(", ", clips.Select(c => c.name)));
        }
        var hit = clips.FirstOrDefault(c => c.name == clipName) ?? clips.FirstOrDefault(c => string.Equals(c.name, clipName, StringComparison.OrdinalIgnoreCase));
        if (hit == null)
            throw ClipsError("no clip '" + clipName + "' on " + owner.Root.name + (clips.Count == 0 ? " (it has no clips; SaturaClips.Create makes one)" : " (it has " + string.Join(", ", clips.Select(c => c.name)) + ")"));
        return hit;
    }

    static void ClipsTouched(AnimationClip clip)
    {
        foreach (var st in _tunerAnims.Values)
            if (st.Clip == clip)
            {
                st.Rev++;
                st.Dirty = true;
            }
    }

    static ClipResult ClipsResult(AnimationClip clip, GameObject root, TunerAnimOwner owner, List<string> done)
    {
        var path = clip != null ? AssetDatabase.GetAssetPath(clip) : "";
        var text = new StringBuilder(clip != null ? ClipsText(clip, root, owner) : "");
        if (done != null && done.Count > 0)
        {
            if (text.Length > 0) text.Append('\n');
            text.Append("done: ").Append(string.Join("; ", done));
        }
        return new ClipResult(clip, path, done != null ? done.ToArray() : new string[0], text.ToString());
    }

    internal static string ClipsList(string obj)
    {
        var go = ClipsFind(obj);
        if (go == null) throw ClipsError("SaturaClips.List needs the object's scene path");
        var owner = TunerAnimOwnerOf(go);
        if (owner == null) return TunerObjectPath(go) + " has no clips (no Animator or Animation on it or its parents). SaturaClips.Create(\"" + TunerObjectPath(go) + "\", \"Name\") makes a clip and an Animator with a controller that plays it.";
        var kind = owner.Kind == TunerAnimKind.Animator ? "Animator" : "Animation (legacy)";
        var sb = new StringBuilder();
        var clips = TunerAnimClips(owner);
        sb.Append(TunerObjectPath(owner.Root)).Append(": ").Append(kind);
        if (owner.Kind == TunerAnimKind.Animator && owner.Animator.runtimeAnimatorController != null) sb.Append(" with ").Append(AssetDatabase.GetAssetPath(owner.Animator.runtimeAnimatorController));
        sb.Append(", ").Append(clips.Count).Append(clips.Count == 1 ? " clip" : " clips");
        foreach (var c in clips) sb.Append("\n  ").Append(c.name).Append("  ").Append(AssetDatabase.GetAssetPath(c)).Append("  ").Append(ClipsSummary(c, owner));
        return sb.ToString();
    }

    internal static AnimationClip ClipsGet(string obj, string clipName) => ClipsResolve(obj, clipName, out _, out _);

    internal static string ClipsDescribe(string obj, string clipName)
    {
        if (string.IsNullOrEmpty(clipName) && obj != null && !obj.Trim().EndsWith(".anim", StringComparison.OrdinalIgnoreCase))
        {
            var found = ClipsFind(obj);
            var all = found != null ? TunerAnimOwnerOf(found) : null;
            var list = all != null ? TunerAnimClips(all) : null;
            if (list != null && list.Count > 1) return string.Join("\n\n", list.Select(c => ClipsText(c, all.Root, all)));
        }
        var clip = ClipsResolve(obj, clipName, out var go, out var owner);
        return ClipsText(clip, owner != null ? owner.Root : go, owner);
    }

    static string ClipsNum(float v) => v.ToString("0.####", CultureInfo.InvariantCulture);

    static string ClipsSummary(AnimationClip clip, TunerAnimOwner owner)
    {
        float fps = TunerAnimFps(clip);
        var parts = new List<string>
        {
            ClipsNum(clip.length) + " s (" + Mathf.RoundToInt(clip.length * fps) + " frames) at " + ClipsNum(fps) + " fps",
            AnimationUtility.GetAnimationClipSettings(clip).loopTime ? "loop" : "no loop"
        };
        if (clip.humanMotion) parts.Add("humanoid");
        var ro = TunerAnimReadOnly(clip);
        if (ro != null) parts.Add("read-only");
        return string.Join(", ", parts);
    }

    static string ClipsTangent(TangentMode m)
    {
        switch (m)
        {
            case TangentMode.Auto: return "auto";
            case TangentMode.Linear: return "linear";
            case TangentMode.Constant: return "constant";
            case TangentMode.Free: return "free";
            default: return "clampedAuto";
        }
    }

    static string ClipsBindingName(EditorCurveBinding b)
    {
        var type = b.type != null ? b.type.Name : "?";
        if (TunerHumanBinding(b) && TunerMuscleOf(b.propertyName) >= 0) return "muscle " + b.propertyName;
        var where = string.IsNullOrEmpty(b.path) ? "" : b.path + "/";
        if (b.type == typeof(Transform))
        {
            var dot = b.propertyName.LastIndexOf('.');
            var head = dot > 0 ? b.propertyName.Substring(0, dot) : b.propertyName;
            var alias = head == "m_LocalPosition" ? "position" : head == "m_LocalScale" ? "scale" : head.StartsWith("localEulerAngles", StringComparison.Ordinal) ? "rotation" : null;
            if (alias != null) return where + alias + (dot > 0 ? b.propertyName.Substring(dot) : "");
        }
        return where + type + "." + b.propertyName;
    }

    static string ClipsText(AnimationClip clip, GameObject root, TunerAnimOwner owner)
    {
        float fps = TunerAnimFps(clip);
        var sb = new StringBuilder();
        sb.Append(clip.name).Append("  ").Append(AssetDatabase.GetAssetPath(clip)).Append("\n  ").Append(ClipsSummary(clip, owner));
        if (root != null) sb.Append(", on ").Append(TunerObjectPath(root));
        var curves = AnimationUtility.GetCurveBindings(clip);
        var refs = AnimationUtility.GetObjectReferenceCurveBindings(clip);
        if (curves.Length + refs.Length == 0) sb.Append("\n  no properties yet: SaturaClips.SetKeys adds them");
        int shown = 0;
        foreach (var b in curves)
        {
            if (shown++ >= CLIPS_CURVES_SHOWN) break;
            var c = AnimationUtility.GetEditorCurve(clip, b);
            if (c == null) continue;
            sb.Append("\n  ").Append(ClipsBindingName(b)).Append(':');
            for (int i = 0; i < c.length && i < CLIPS_KEYS_SHOWN; i++)
            {
                var l = ClipsTangent(AnimationUtility.GetKeyLeftTangentMode(c, i));
                var r = ClipsTangent(AnimationUtility.GetKeyRightTangentMode(c, i));
                sb.Append(i == 0 ? " " : " | ").Append('f').Append(Mathf.RoundToInt(c[i].time * fps)).Append(' ').Append(ClipsNum(c[i].value));
                if (c[i].weightedMode != WeightedMode.None) sb.Append(" [weighted]");
                else if (l != "clampedAuto" || r != "clampedAuto") sb.Append(" [").Append(l == r ? l : l + "/" + r).Append(']');
            }
            if (c.length > CLIPS_KEYS_SHOWN) sb.Append(" | ... ").Append(c.length).Append(" keys");
        }
        foreach (var b in refs)
        {
            if (shown++ >= CLIPS_CURVES_SHOWN) break;
            var oc = AnimationUtility.GetObjectReferenceCurve(clip, b);
            if (oc == null) continue;
            sb.Append("\n  ").Append(ClipsBindingName(b)).Append(':');
            for (int i = 0; i < oc.Length && i < CLIPS_KEYS_SHOWN; i++)
                sb.Append(i == 0 ? " " : " | ").Append('f').Append(Mathf.RoundToInt(oc[i].time * fps)).Append(' ').Append(oc[i].value != null ? AssetDatabase.GetAssetPath(oc[i].value) + ":" + oc[i].value.name : "none");
        }
        if (curves.Length + refs.Length > CLIPS_CURVES_SHOWN) sb.Append("\n  ... ").Append(curves.Length + refs.Length).Append(" properties in all");
        var evs = TunerAnimEvents(clip);
        if (evs.Length > 0)
        {
            sb.Append("\n  events:");
            for (int i = 0; i < evs.Length; i++)
            {
                var e = evs[i];
                var args = new List<string>();
                if (!string.IsNullOrEmpty(e.stringParameter)) args.Add("\"" + e.stringParameter + "\"");
                if (e.floatParameter != 0f) args.Add(ClipsNum(e.floatParameter) + "f");
                if (e.intParameter != 0) args.Add(e.intParameter.ToString(CultureInfo.InvariantCulture));
                if (e.objectReferenceParameter != null) args.Add(AssetDatabase.GetAssetPath(e.objectReferenceParameter));
                sb.Append(i == 0 ? " " : " | ").Append('f').Append(Mathf.RoundToInt(e.time * fps)).Append(' ').Append(e.functionName).Append('(').Append(string.Join(", ", args)).Append(')');
            }
        }
        return sb.ToString();
    }

    internal static ClipResult ClipsCreate(string obj, string name, float frameRate, int loop)
    {
        var go = ClipsFind(obj);
        if (go == null) throw ClipsError("SaturaClips.Create needs the object's scene path");
        if (EditorApplication.isPlaying) throw ClipsError("create clips in Edit Mode: unity.stop() first");
        if (frameRate < 0f || frameRate > 1000f) throw ClipsError("frameRate is frames per second, 1..1000");
        var owner = TunerAnimOwnerOf(go);
        var want = (name ?? "").Trim();
        var dup = owner != null && want.Length > 0 ? TunerAnimClips(owner).FirstOrDefault(c => string.Equals(c.name, want, StringComparison.OrdinalIgnoreCase)) : null;
        if (dup != null) throw ClipsError(owner.Root.name + " already has a clip '" + dup.name + "' (" + AssetDatabase.GetAssetPath(dup) + "): edit it with SetKeys, or pick another name");
        var sceneWasDirty = go.scene.IsValid() && ClipsSceneDirty(go.scene);
        var hadOwner = owner != null;
        var firstNew = _tunerAnimNewAssets.Count;
        Undo.IncrementCurrentGroup();
        var group = Undo.GetCurrentGroup();
        Undo.SetCurrentGroupName("SaturaClips.Create " + name);
        AnimationClip made;
        _tunerAgentEdit = true;
        try
        {
            var err = TunerAnimCreateClip(go, name, out made);
            if (err != null) throw ClipsError(err);
            if (frameRate > 0f || loop >= 0)
            {
                var ctx0 = new TunerAnimEditCtx { Clip = made, Root = TunerAnimOwnerOf(go)?.Root ?? go, Label = "SaturaClips.Create " + name };
                var e2 = TunerAnimSettings(ctx0, -1f, frameRate, loop);
                if (e2 != null) throw ClipsError(e2);
            }
        }
        finally
        {
            _tunerAgentEdit = false;
            Undo.CollapseUndoOperations(group);
        }
        var created = _tunerAnimNewAssets.Skip(firstNew).Distinct().ToList();
        var newOwner = TunerAnimOwnerOf(go);
        var notes = new List<string> { "created " + string.Join(" and ", created) };
        if (want.Length > 0 && made.name != want) notes.Add("named it " + made.name + " because " + want + ".anim already exists in that folder");
        if (!hadOwner) notes.Add("added an Animator with a new controller to " + TunerObjectPath(go) + " that plays it");
        else if (newOwner != null && newOwner.Kind == TunerAnimKind.Animator) notes.Add("added a state to " + AssetDatabase.GetAssetPath(TunerAnimBaseController(newOwner.Animator)));
        else if (newOwner != null) notes.Add("added it to the Animation on " + TunerObjectPath(newOwner.Root));
        if (!hadOwner || newOwner != null && newOwner.Kind == TunerAnimKind.Legacy) ClipsSaveScene(go, sceneWasDirty, notes);
        notes.Add("undo with SaturaClips.Delete");
        Debug.Log("[Tuner] agent SaturaClips.Create " + AssetDatabase.GetAssetPath(made));
        return ClipsResult(made, newOwner?.Root ?? go, newOwner, notes);
    }

    static void ClipsSaveScene(GameObject go, bool sceneWasDirty, List<string> notes)
    {
        if (!go.scene.IsValid() || string.IsNullOrEmpty(go.scene.path)) return;
        EditorSceneManager.MarkSceneDirty(go.scene);
        if (sceneWasDirty) notes.Add("the scene " + go.scene.path + " had other unsaved changes, so it was not saved: save it when those are done");
        else if (EditorSceneManager.SaveScene(go.scene)) notes.Add("saved the scene " + go.scene.path);
        else notes.Add("could not save the scene " + go.scene.path);
    }

    static TunerAnimKeyArg ClipsKeyArg(ClipKey k, int index, bool needValue)
    {
        var where = "key " + index;
        if (k == null) throw ClipsError(where + " is null");
        if (string.IsNullOrWhiteSpace(k.prop)) throw ClipsError(where + " needs prop, like \"position.y\", \"rotation.z\", \"scale.x\", \"m_Intensity\" (with .On(\"Lamp\", \"Light\")) or SaturaClips.Muscle(...)");
        if (k.frame < 0 && !(k.time >= 0f)) throw ClipsError(where + " (" + k.prop + ") needs a frame (0 or more) or a time in seconds");
        if (needValue && (float.IsNaN(k.value) || float.IsInfinity(k.value))) throw ClipsError(where + " (" + k.prop + ") needs a finite value");
        return new TunerAnimKeyArg
        {
            path = (k.path ?? "").Trim().Trim('/'),
            type = string.IsNullOrWhiteSpace(k.type) ? null : k.type.Trim(),
            prop = k.prop.Trim(),
            frame = k.frame >= 0 ? k.frame : -1,
            t = k.frame >= 0 ? 0f : k.time,
            hasV = needValue,
            v = k.value,
            tangent = needValue ? ClipsTangentMode(k.tangent, where + " (" + k.prop + ")") : null
        };
    }

    static string ClipsTangentMode(string mode, string where)
    {
        if (string.IsNullOrWhiteSpace(mode)) return null;
        var m = mode.Trim();
        if (m == "constant") m = "bothConstant";
        else if (m == "free") m = "bothFree";
        if (m.StartsWith("bezier ", StringComparison.Ordinal) || Array.IndexOf(TUNER_ANIM_TANGENTS, m) >= 0 && m != "bezier") return m;
        throw ClipsError(where + ": tangent is one of " + string.Join(", ", TUNER_ANIM_TANGENTS.Where(x => x != "bezier")) + ", constant, free, or \"bezier x1 y1 x2 y2\"");
    }

    static ClipResult ClipsEdit(string api, string obj, string clipName, Func<TunerAnimEditCtx, TunerAnimOwner, string> op, string doneNote, List<string> more = null)
    {
        var clip = ClipsResolve(obj, clipName, out var go, out var owner);
        var ro = TunerAnimReadOnly(clip);
        if (ro != null) throw ClipsError(ro);
        var root = owner != null ? owner.Root : go;
        var ctx = new TunerAnimEditCtx { Clip = clip, Root = root, Label = "SaturaClips." + api };
        Undo.IncrementCurrentGroup();
        var group = Undo.GetCurrentGroup();
        Undo.SetCurrentGroupName(ctx.Label);
        _tunerAgentEdit = true;
        try
        {
            var err = op(ctx, owner);
            if (err == "the clip has no properties yet: add one, then set its length")
                err = "the clip has no keys yet, and a clip's length comes from its keys. Add some first, like SaturaClips.SetKeys(obj, clip, SaturaClips.Key(\"position.y\", 0, 0), SaturaClips.Key(\"position.y\", 60, 1)) (the last key sets the length), then stretch it with Settings(obj, clip, length: 2)";
            if (err != null) throw ClipsError("SaturaClips." + api + ": " + err);
        }
        finally
        {
            _tunerAgentEdit = false;
            Undo.CollapseUndoOperations(group);
        }
        ClipsTouched(clip);
        Debug.Log("[Tuner] agent SaturaClips." + api + " on " + AssetDatabase.GetAssetPath(clip));
        var notes = new List<string> { doneNote + " (one Undo step: " + ctx.Label + ")" };
        if (more != null) notes.AddRange(more);
        return ClipsResult(clip, root, owner, notes);
    }

    internal static ClipResult ClipsSetKeys(string obj, string clipName, ClipKey[] keys) => ClipsKeys("SetKeys", obj, clipName, keys, true);

    internal static ClipResult ClipsRemoveKeys(string obj, string clipName, ClipKey[] keys) => ClipsKeys("RemoveKeys", obj, clipName, keys, false);

    static ClipResult ClipsKeys(string api, string obj, string clipName, ClipKey[] keys, bool set)
    {
        if (keys == null || keys.Length == 0)
            throw ClipsError(set ? "SaturaClips.SetKeys needs keys, like SaturaClips.Key(\"position.y\", 30, 1.5f)" : "SaturaClips.RemoveKeys needs keys, like SaturaClips.Key(\"position.y\", 30, 0) (the value is ignored)");
        var plain = new List<TunerAnimKeyArg>();
        for (int i = 0; i < keys.Length; i++) plain.Add(ClipsKeyArg(keys[i], i, set));
        var done = set ? "set " + keys.Length + (keys.Length == 1 ? " key" : " keys") : "removed keys";
        return ClipsEdit(api, obj, clipName, (ctx, owner) => set ? ClipSetKeys(ctx, plain.ToArray()) : TunerAnimDeleteKeys(ctx, plain.ToArray()), done);
    }

    internal static ClipResult ClipsRemoveProperty(string obj, string clipName, string prop, string path, string type)
    {
        if (string.IsNullOrWhiteSpace(prop)) throw ClipsError("SaturaClips.RemoveProperty needs prop, like \"position\" (all three axes), \"position.y\" or \"m_Intensity\" with path and type");
        return ClipsEdit("RemoveProperty", obj, clipName, (ctx, owner) =>
        {
            var id = TunerAnimKeyId(ctx.Clip, ctx.Root, new TunerAnimKeyArg { path = (path ?? "").Trim('/'), type = string.IsNullOrWhiteSpace(type) ? null : type, prop = prop.Trim() });
            if (id == null) return "no component type " + type;
            return TunerAnimRemoveProps(ctx, new List<string> { id });
        }, "removed " + prop);
    }

    internal static ClipResult ClipsSetEvents(string obj, string clipName, AnimationEvent[] events, bool append)
    {
        var given = events ?? new AnimationEvent[0];
        for (int i = 0; i < given.Length; i++)
        {
            var e = given[i];
            if (e == null) throw ClipsError("event " + i + " is null");
            if (string.IsNullOrEmpty(e.functionName) || !(char.IsLetter(e.functionName[0]) || e.functionName[0] == '_') || !e.functionName.All(ch => char.IsLetterOrDigit(ch) || ch == '_'))
                throw ClipsError("event " + i + " needs functionName, the method Unity calls on the object's scripts, like \"OnStep\"");
            if (!(e.time >= 0f)) throw ClipsError("event " + i + " (" + e.functionName + ") needs a time in seconds, 0 or more");
        }
        return ClipsEdit(append ? "AddEvent" : "SetEvents", obj, clipName, (ctx, owner) =>
        {
            var clip = ctx.Clip;
            var list = append ? TunerAnimEvents(clip).ToList() : new List<AnimationEvent>();
            foreach (var e in given)
                list.Add(new AnimationEvent
                {
                    time = TunerAnimSnap(clip, e.time),
                    functionName = e.functionName,
                    floatParameter = e.floatParameter,
                    intParameter = e.intParameter,
                    stringParameter = e.stringParameter ?? "",
                    objectReferenceParameter = e.objectReferenceParameter,
                    messageOptions = e.messageOptions
                });
            TunerAnimBegin(ctx);
            AnimationUtility.SetAnimationEvents(clip, list.OrderBy(x => x.time).ToArray());
            TunerAnimDone(clip, true);
            return null;
        }, append ? "added " + given.Length + (given.Length == 1 ? " event" : " events") : given.Length == 0 ? "cleared the events" : "set " + given.Length + (given.Length == 1 ? " event" : " events"));
    }

    internal static ClipResult ClipsSettings(string obj, string clipName, float length, float frameRate, int loop)
    {
        if (frameRate < 0f || frameRate > 1000f) throw ClipsError("frameRate is frames per second, 1..1000");
        if (length < 0f && frameRate <= 0f && loop < 0) throw ClipsError("SaturaClips.Settings needs length, frameRate or loop, like Settings(obj, clip, loop: false)");
        return ClipsEdit("Settings", obj, clipName, (ctx, owner) =>
        {
            return TunerAnimSettings(ctx, length, frameRate, loop);
        }, "changed the settings");
    }

    internal static ClipResult ClipsDelete(string obj, string clipName)
    {
        var clip = ClipsResolve(obj, clipName, out var go, out var owner);
        if (EditorApplication.isPlaying) throw ClipsError("delete clips in Edit Mode: unity.stop() first");
        var path = AssetDatabase.GetAssetPath(clip);
        if (string.IsNullOrEmpty(path) || !path.EndsWith(".anim", StringComparison.OrdinalIgnoreCase))
            throw ClipsError("SaturaClips.Delete removes .anim assets only; " + clip.name + " lives in " + (string.IsNullOrEmpty(path) ? "no asset" : path));
        var notes = new List<string>();
        Undo.IncrementCurrentGroup();
        var group = Undo.GetCurrentGroup();
        Undo.SetCurrentGroupName("SaturaClips.Delete " + clip.name);
        _tunerAgentEdit = true;
        try
        {
            if (owner != null && owner.Kind == TunerAnimKind.Animator && TunerAnimBaseController(owner.Animator) is AnimatorController ac)
            {
                foreach (var layer in ac.layers)
                    ClipDeleteStates(layer.stateMachine, clip, AssetDatabase.GetAssetPath(ac), notes);
                EditorUtility.SetDirty(ac);
                AssetDatabase.SaveAssetIfDirty(ac);
            }
            else if (owner != null && owner.Kind == TunerAnimKind.Legacy && owner.Legacy != null)
            {
                Undo.RecordObject(owner.Legacy, "Delete clip " + clip.name);
                if (owner.Legacy.GetClip(clip.name) != null) owner.Legacy.RemoveClip(clip);
                if (owner.Legacy.clip == clip) owner.Legacy.clip = null;
                EditorUtility.SetDirty(owner.Legacy);
                MarkTunerSceneDirty(owner.Legacy);
                notes.Add("removed it from the Animation on " + TunerObjectPath(owner.Root) + " (scene left unsaved)");
            }
            ClipsTouched(clip);
            if (owner != null) _tunerAnimatable.Remove(owner.Root);
            if (!AssetDatabase.MoveAssetToTrash(path)) throw ClipsError("could not delete " + path);
        }
        finally
        {
            _tunerAgentEdit = false;
            Undo.CollapseUndoOperations(group);
        }
        notes.Add("moved " + path + " to the system Trash (restore it from there; Unity can't undo an asset delete)");
        if (owner == null) notes.Add("no object was given, so no controller was updated: a state that played this clip now has no clip");
        Debug.Log("[Tuner] agent SaturaClips.Delete " + path);
        return new ClipResult(null, path, notes.ToArray(), "deleted " + path + "\ndone: " + string.Join("; ", notes));
    }

    static void ClipDeleteStates(AnimatorStateMachine sm, AnimationClip clip, string ctrlPath, List<string> notes)
    {
        if (sm == null) return;
        foreach (var cs in sm.states.ToList())
            if (cs.state != null && cs.state.motion == clip)
            {
                notes.Add("removed state " + cs.state.name + " from " + ctrlPath);
                sm.RemoveState(cs.state);
            }
        foreach (var child in sm.stateMachines)
            ClipDeleteStates(child.stateMachine, clip, ctrlPath, notes);
    }

    static string ClipSetKeys(TunerAnimEditCtx ctx, TunerAnimKeyArg[] keys)
    {
        var clip = ctx.Clip;
        if (keys == null || keys.Length == 0) return "no keys given";
        var byTime = new Dictionary<float, (List<string> ids, Dictionary<string, float> values)>();
        var tangents = new Dictionary<string, List<TunerAnimKeyArg>>();
        foreach (var k in keys)
        {
            if (k == null) continue;
            var id = TunerAnimKeyId(clip, ctx.Root, k);
            if (id == null) return "no component type " + k.type + " for " + k.prop;
            if (!TunerAnimFindBinding(clip, ctx.Root, id, out var b)) return "no property " + id;
            if (b.isPPtrCurve) return id + " is an object reference curve: SetKeys writes number curves only (use AnimationUtility.SetObjectReferenceCurve)";
            if (b.type == typeof(Transform) && !ClipsTransformProp(b.propertyName))
                return "Transform has no animatable property " + b.propertyName + ": use position.x/y/z, rotation.x/y/z (degrees) or scale.x/y/z, or name the component with .On(path, \"Light\")";
            if (ctx.Root != null && !string.IsNullOrEmpty(b.path) && ctx.Root.transform.Find(b.path) == null)
                return "no child '" + b.path + "' under " + ctx.Root.name + " (path is relative to the animated object; SaturaClips.PathOf(root, child) builds it)";
            float t = k.frame >= 0 ? k.frame / TunerAnimFps(clip) : TunerAnimSnap(clip, k.t);
            if (!byTime.TryGetValue(t, out var g)) byTime[t] = g = (new List<string>(), new Dictionary<string, float>());
            if (!g.ids.Contains(id)) g.ids.Add(id);
            g.values[id] = k.v;
            if (!string.IsNullOrEmpty(k.tangent))
            {
                if (!tangents.TryGetValue(k.tangent, out var l)) tangents[k.tangent] = l = new List<TunerAnimKeyArg>();
                l.Add(new TunerAnimKeyArg { id = id, t = t });
            }
        }
        foreach (var kv in byTime.OrderBy(x => x.Key))
        {
            var err = TunerAnimAddKeys(ctx, kv.Value.ids, kv.Key, kv.Value.values, false, null);
            if (err != null) return err;
        }
        foreach (var kv in tangents)
        {
            var err = TunerAnimSetTangents(ctx, kv.Value, kv.Key, true);
            if (err != null) return err;
        }
        return null;
    }

    static bool ClipsTransformProp(string prop)
    {
        var dot = prop.LastIndexOf('.');
        if (dot < 0) return false;
        var axis = prop.Substring(dot + 1);
        var head = prop.Substring(0, dot);
        if (head == "m_LocalRotation") return axis == "x" || axis == "y" || axis == "z" || axis == "w";
        return (axis == "x" || axis == "y" || axis == "z") && (head == "m_LocalPosition" || head == "m_LocalScale" || head == "localEulerAngles" || head == "localEulerAnglesRaw" || head == "localEulerAnglesBaked");
    }

    internal static string ClipsMuscleProp(string muscle)
    {
        if (string.IsNullOrWhiteSpace(muscle)) throw ClipsError("SaturaClips.Muscle needs a muscle name, like \"Spine Front-Back\" or \"Left Upper Arm Down-Up\" (SaturaClips.Muscles(\"arm\") lists them)");
        var name = muscle.Trim();
        var i = TunerMuscleOf(name);
        if (i < 0)
        {
            var names = HumanTrait.MuscleName;
            for (int j = 0; j < names.Length && i < 0; j++)
                if (string.Equals(names[j], name, StringComparison.OrdinalIgnoreCase) || string.Equals(TunerMuscleProp(j), name, StringComparison.OrdinalIgnoreCase)) i = j;
        }
        if (i < 0)
        {
            var words = name.ToLowerInvariant().Split(new[] { ' ', '-', '.' }, StringSplitOptions.RemoveEmptyEntries);
            var near = HumanTrait.MuscleName.Where(n => words.Any(w => w.Length > 2 && n.ToLowerInvariant().Contains(w))).Take(8).ToList();
            throw ClipsError("no humanoid muscle '" + muscle + "'" + (near.Count > 0 ? ": did you mean " + string.Join(", ", near) + "?" : "; SaturaClips.Muscles() lists all " + HumanTrait.MuscleCount));
        }
        return TunerMuscleProp(i);
    }

    internal static string[] ClipsMuscles(string filter)
    {
        var f = (filter ?? "").Trim().ToLowerInvariant();
        return HumanTrait.MuscleName.Where(n => f.Length == 0 || n.ToLowerInvariant().Contains(f)).ToArray();
    }
}
