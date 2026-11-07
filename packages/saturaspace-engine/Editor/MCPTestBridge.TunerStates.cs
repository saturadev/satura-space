using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const string TUNER_DEFAULT_STATE = "default";
    const int TUNER_SNAPSHOT_MAX = 4096;

    [Serializable]
    class TunerAnimateArgs
    {
        public string path;
        public string scene;
        public string state;
        public string clip;
        public int layer = -1;
        public float time = -1f;
        public float seconds = -1f;
    }

    [Serializable]
    class TunerCallArgs
    {
        public string type;
        public string path;
        public string scene;
        public string component;
        public string method;
    }

    [Serializable]
    class TunerSetArgs
    {
        public string path;
        public string scene;
        public string component;
        public string field;
        public string value;
    }

    [Serializable]
    class TunerStepArgs
    {
        public TunerAnimateArgs animate;
        public TunerCallArgs call;
        public TunerSetArgs set;
    }

    [Serializable]
    class TunerStateArgs
    {
        public string name;
        public string label;
        public string note;
        public TunerObjectArgs[] objects;
        public TunerCameraArgs camera;
        public TunerStepArgs[] setup;
        public bool pause;
    }

    [Serializable]
    class TunerOverrideArgs
    {
        public string state;
        public string id;
        public string path;
        public string component;
        public string field;
        public string before;
        public string after;
        public string beforeRaw;
        public string afterRaw;
    }

    [Serializable]
    class TunerSnapEntry
    {
        public string p;
        public string v;
    }

    [Serializable]
    class TunerSnap
    {
        public TunerSnapEntry[] e;
    }

    class TunerStateDef
    {
        public string Name;
        public string Label;
        public string Note;
        public int[] Objects;
        public TunerCameraArgs Camera;
        public TunerStepArgs[] Setup;
        public bool Pause;
        public string Error;
        public readonly List<TunerOverride> Overrides = new List<TunerOverride>();
    }

    class TunerOverride
    {
        public string Entry;
        public string Component;
        public string Field;
        public string Before;
        public string BeforeRaw;
        public string After;
        public string AfterRaw;
        public bool Fresh;
        public TunerRuntimeOrigin Runtime;
    }

    class TunerFrozen
    {
        public Animator Animator;
        public bool Enabled;
        public float Speed;
    }

    class TunerSetUndo
    {
        public Component Target;
        public string Raw;
    }

    static void BuildTunerStates(TunerSession s, TunerArgs a)
    {
        var specs = new List<TunerObjectArgs>();
        List<UnityEngine.SceneManagement.Scene> scenes = null;
        foreach (var o in a.objects ?? new TunerObjectArgs[0])
            if (o != null) specs.AddRange(ExpandTunerSpec(o, ref scenes));
        int shared = specs.Count;
        var seen = new HashSet<string>();
        foreach (var sa in a.states ?? new TunerStateArgs[0])
        {
            if (sa == null || string.IsNullOrEmpty(sa.name) || !seen.Add(sa.name)) continue;
            var idx = new List<int>();
            for (int i = 0; i < shared; i++) idx.Add(i);
            foreach (var o in sa.objects ?? new TunerObjectArgs[0])
            {
                if (o == null || string.IsNullOrEmpty(o.path)) continue;
                foreach (var e in ExpandTunerSpec(o, ref scenes))
                {
                    specs.Add(e);
                    idx.Add(specs.Count - 1);
                }
            }
            s.States.Add(new TunerStateDef
            {
                Name = sa.name,
                Label = string.IsNullOrEmpty(sa.label) ? sa.name : sa.label,
                Note = sa.note ?? "",
                Objects = idx.ToArray(),
                Camera = ValidTunerCamera(sa.camera),
                Setup = sa.setup ?? new TunerStepArgs[0],
                Pause = sa.pause
            });
        }
        if (s.States.Count == 0)
        {
            var all = new int[shared];
            for (int i = 0; i < shared; i++) all[i] = i;
            s.States.Add(new TunerStateDef
            {
                Name = TUNER_DEFAULT_STATE,
                Label = "",
                Note = "",
                Objects = all,
                Camera = ValidTunerCamera(a.camera),
                Setup = new TunerStepArgs[0]
            });
        }
        s.Specs = specs.ToArray();
    }

    static TunerCameraArgs ValidTunerCamera(TunerCameraArgs c)
    {
        Vector3 p, l;
        return c != null && ToVec3(c.position, out p) && ToVec3(c.lookAt, out l) ? c : null;
    }

    static int FindTunerState(TunerSession s, string name)
    {
        if (string.IsNullOrEmpty(name)) return -1;
        for (int k = 0; k < s.States.Count; k++)
            if (s.States[k].Name == name) return k;
        return -1;
    }

    static readonly int[] TunerNoObjects = new int[0];

    static int[] TunerActiveObjects(TunerSession s)
    {
        return s.Active >= 0 && s.Active < s.States.Count ? s.States[s.Active].Objects : TunerNoObjects;
    }

    static bool TunerInActive(TunerSession s, int i)
    {
        return Array.IndexOf(TunerActiveObjects(s), i) >= 0;
    }

    static string TunerSpecPath(TunerObjectArgs spec)
    {
        return (spec.path ?? "").Trim().TrimStart('/');
    }

    static int RestoreTunerOverrides(TunerSession s, TunerOverrideArgs[] list)
    {
        if (list == null) return 0;
        int n = 0;
        foreach (var o in list)
        {
            if (o == null || string.IsNullOrEmpty(o.field) || string.IsNullOrEmpty(o.component) || string.IsNullOrEmpty(o.id)
                || string.IsNullOrEmpty(o.afterRaw)) continue;
            if (o.state == TUNER_EDIT_STATE) continue;
            int k = FindTunerState(s, o.state);
            if (k < 0 || string.IsNullOrEmpty(o.beforeRaw)) continue;
            int i = TunerIndex(s, o.id);
            if (i >= 0 && Array.IndexOf(s.States[k].Objects, i) < 0) continue;
            var bucket = s.States[k].Overrides;
            if (TunerIndex(s, o.id) < 0 && FindTunerEntry(s, o.id) == null)
            {
                if (o.id[0] != 'u' || string.IsNullOrEmpty(o.path)) continue;
                s.MemberPaths[o.id] = o.path;
            }
            if (!string.IsNullOrEmpty(o.path) && o.path != TunerEntryPath(s, o.id)) continue;
            if (FindTunerOverride(bucket, o.id, o.component, o.field) != null) continue;
            bucket.Add(new TunerOverride
            {
                Entry = o.id,
                Component = o.component,
                Field = o.field,
                Before = o.before ?? "",
                BeforeRaw = o.beforeRaw ?? "",
                After = o.after ?? "",
                AfterRaw = o.afterRaw
            });
            TouchTunerMember(s, o.id);
            n++;
        }
        return n;
    }

    static TunerOverride FindTunerOverride(List<TunerOverride> list, string entry, string component, string field)
    {
        foreach (var o in list)
            if (o.Entry == entry && o.Component == component && o.Field == field) return o;
        return null;
    }

    static void EnterTunerState(TunerSession s, int k)
    {
        s.Active = k;
        var st = s.States[k];
        RebuildTunerMembers(s);
        DropTunerSceneTracks(s);
        if (!EditorApplication.isPlaying)
        {
            st.Error = null;
            s.Dirty = true;
            s.CacheDirty = true;
            s.StatePending = true;
            return;
        }
        var errors = new List<string>();
        int steps = 0;
        foreach (var step in st.Setup)
        {
            if (step == null) continue;
            string err;
            try { err = RunTunerStep(s, step); }
            catch (Exception e) { err = e.GetType().Name + ": " + e.Message; }
            steps++;
            if (err != null) errors.Add(err);
        }
        if (steps > 0)
        {
            ResolveTunerObjects(s);
            RebuildTunerMembers(s);
        }
        int applied = 0;
        ResolveTunerEntries(s);
        foreach (var o in st.Overrides)
        {
            var target = TunerTrackTargetFor(s, o.Entry, o.Component);
            if (target == null) continue;
            var err = RestoreTunerValue(target, o.Field, o.AfterRaw);
            if (err == null) applied++;
            else errors.Add(o.Component + "." + o.Field + ": " + err);
        }
        if (st.Pause && EditorApplication.isPlaying)
        {
            if (!s.PauseApplied)
            {
                s.PauseRestore = EditorApplication.isPaused;
                s.PauseApplied = true;
            }
            EditorApplication.isPaused = true;
        }
        st.Error = errors.Count > 0 ? string.Join("; ", errors) : null;
        s.Dirty = true;
        s.CacheDirty = true;
        s.StatePending = true;
        SaturaDebug.Log("[Tuner] enter state " + st.Name + " of " + s.Name + " (" + steps + " setup step" + (steps == 1 ? "" : "s")
            + ", " + applied + " override" + (applied == 1 ? "" : "s") + " applied" + (st.Pause ? ", paused" : "") + ")"
            + (st.Error != null ? " errors: " + st.Error : ""));
    }

    static void LeaveTunerState(TunerSession s)
    {
        if (s.Active < 0) return;
        DropTunerSceneTracks(s);
        var st = s.States[s.Active];
        for (int j = st.Overrides.Count - 1; j >= 0; j--)
        {
            var o = st.Overrides[j];
            var target = TunerTrackTargetFor(s, o.Entry, o.Component);
            if (target != null && !string.IsNullOrEmpty(o.BeforeRaw)) RestoreTunerValue(target, o.Field, o.BeforeRaw);
        }
        for (int j = s.SetUndo.Count - 1; j >= 0; j--)
        {
            var u = s.SetUndo[j];
            if (u.Target != null) RestoreTunerSnapshot(u.Target, u.Raw);
        }
        s.SetUndo.Clear();
        ReleaseTunerFreezes(s);
        s.Active = -1;
    }

    static void ReleaseTunerFreezes(TunerSession s)
    {
        for (int j = s.Frozen.Count - 1; j >= 0; j--)
        {
            var f = s.Frozen[j];
            if (f.Animator == null) continue;
            f.Animator.speed = f.Speed;
            f.Animator.enabled = f.Enabled;
        }
        s.Frozen.Clear();
        if (s.PauseApplied)
        {
            s.PauseApplied = false;
            if (EditorApplication.isPlaying) EditorApplication.isPaused = s.PauseRestore;
        }
    }

    static void FreezeTunerAnimator(TunerSession s, Animator anim)
    {
        foreach (var f in s.Frozen)
            if (f.Animator == anim) return;
        s.Frozen.Add(new TunerFrozen { Animator = anim, Enabled = anim.enabled, Speed = anim.speed });
    }

    static GameObject FindTunerStepObject(string path, string scene)
    {
        return FindTunerObject(TunerScenes(), new TunerObjectArgs { path = path, scene = scene });
    }

    static string RunTunerStep(TunerSession s, TunerStepArgs step)
    {
        if (step.animate != null && !string.IsNullOrEmpty(step.animate.path)) return RunTunerAnimate(s, step.animate);
        if (step.call != null && !string.IsNullOrEmpty(step.call.method)) return RunTunerCall(step.call);
        if (step.set != null && !string.IsNullOrEmpty(step.set.field)) return RunTunerSet(s, step.set);
        return null;
    }

    static string RunTunerAnimate(TunerSession s, TunerAnimateArgs a)
    {
        var go = FindTunerStepObject(a.path, a.scene);
        if (go == null) return "animate: no object " + a.path;
        var anim = go.GetComponent<Animator>();
        if (anim == null) anim = go.GetComponentInChildren<Animator>(true);
        if (!string.IsNullOrEmpty(a.state))
        {
            if (anim == null) return "animate: no Animator on " + a.path;
            if (anim.runtimeAnimatorController == null) return "animate: the Animator on " + a.path + " has no controller";
            FreezeTunerAnimator(s, anim);
            anim.enabled = true;
            anim.speed = 1f;
            float t = a.time >= 0f ? a.time : 0f;
            anim.Play(a.state, a.layer, t);
            anim.Update(0f);
            var info = anim.GetCurrentAnimatorStateInfo(a.layer >= 0 ? a.layer : 0);
            bool hit = info.IsName(a.state) || info.shortNameHash == Animator.StringToHash(a.state);
            anim.speed = 0f;
            anim.enabled = false;
            return hit ? null : "animate: Animator state '" + a.state + "' not found on " + a.path;
        }
        if (string.IsNullOrEmpty(a.clip)) return "animate: needs a state or a clip";
        var clip = FindTunerClip(go, anim, a.clip);
        if (clip == null) return "animate: no AnimationClip '" + a.clip + "' for " + a.path;
        if (anim != null)
        {
            FreezeTunerAnimator(s, anim);
            anim.speed = 0f;
            anim.enabled = false;
        }
        float seconds = a.seconds >= 0f ? a.seconds : a.time >= 0f ? a.time * clip.length : 0f;
        clip.SampleAnimation(anim != null ? anim.gameObject : go, Mathf.Clamp(seconds, 0f, clip.length));
        return null;
    }

    static AnimationClip FindTunerClip(GameObject go, Animator anim, string name)
    {
        if (anim != null && anim.runtimeAnimatorController != null)
            foreach (var c in anim.runtimeAnimatorController.animationClips)
                if (c != null && c.name == name) return c;
        var legacy = go.GetComponentInChildren<Animation>(true);
        if (legacy != null)
            foreach (AnimationState st in legacy)
                if (st != null && st.clip != null && st.clip.name == name) return st.clip;
        foreach (var guid in AssetDatabase.FindAssets("t:AnimationClip " + name))
        {
            var path = AssetDatabase.GUIDToAssetPath(guid);
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
            {
                var c = o as AnimationClip;
                if (c != null && c.name == name && (c.hideFlags & HideFlags.HideInHierarchy) == 0) return c;
            }
        }
        return null;
    }

    static string RunTunerCall(TunerCallArgs a)
    {
        MethodInfo mi;
        object target = null;
        string where;
        if (!string.IsNullOrEmpty(a.path))
        {
            var go = FindTunerStepObject(a.path, a.scene);
            if (go == null) return "call: no object " + a.path;
            var comp = FindTunerComponent(go, a.component, 0);
            if (comp == null) return "call: no " + a.component + " on " + a.path;
            mi = FindTunerMethod(comp.GetType(), a.method, false);
            if (mi == null) return "call: no parameterless method '" + a.method + "' on " + comp.GetType().Name;
            if (!mi.IsStatic) target = comp;
            where = a.path + " " + comp.GetType().Name;
        }
        else
        {
            if (string.IsNullOrEmpty(a.type)) return "call: needs a type or a path and component";
            var t = FindTunerType(a.type);
            if (t == null) return "call: type '" + a.type + "' not found in the loaded assemblies";
            mi = FindTunerMethod(t, a.method, true);
            if (mi == null) return "call: no parameterless static method '" + a.method + "' on " + t.Name;
            where = t.Name;
        }
        try { mi.Invoke(target, null); }
        catch (TargetInvocationException e)
        {
            var inner = e.InnerException ?? e;
            Debug.LogException(inner);
            return "call " + where + "." + a.method + ": " + inner.GetType().Name + ": " + inner.Message;
        }
        return null;
    }

    static string RunTunerSet(TunerSession s, TunerSetArgs a)
    {
        var go = FindTunerStepObject(a.path, a.scene);
        if (go == null) return "set: no object " + a.path;
        var comp = FindTunerComponent(go, a.component, 0);
        if (comp == null) return "set: no " + a.component + " on " + a.path;
        string raw, display;
        bool snap = SnapshotTunerField(comp, a.field, out raw, out display);
        var err = ApplyTunerEditTo(comp, a.field, "set", a.value ?? "", -1);
        if (err != null) return "set " + a.path + " " + a.component + "." + a.field + ": " + err;
        if (snap) s.SetUndo.Add(new TunerSetUndo { Target = comp, Raw = raw });
        return null;
    }

    static void TunerSelect(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        if (!EditorApplication.isPlaying)
        {
            TunerResult(from, id, "states work in Play Mode only", null);
            return;
        }
        int k = FindTunerState(s, a.state);
        if (k < 0)
        {
            var names = new List<string>();
            foreach (var st in s.States) names.Add(st.Name);
            TunerResult(from, id, "no state '" + a.state + "' (states: " + string.Join(", ", names) + ")", null);
            return;
        }
        LeaveTunerState(s);
        EnterTunerState(s, k);
        TunerResult(from, id, null, "\"state\":" + DescribeTunerState(s));
    }

    static void TunerReset(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        if (!string.IsNullOrEmpty(a.id) && TunerIndex(s, a.id) < 0 && FindTunerEntry(s, a.id) == null)
        {
            TunerResult(from, id, "no object '" + a.id + "' in session " + s.Name, null);
            return;
        }
        if (!EditorApplication.isPlaying)
        {
            TunerResult(from, id, "Reset only works in Play Mode. In Edit Mode, use Undo, or close the Tuner and discard your changes.", null);
            return;
        }
        FlushTunerTracks(s);
        var field = !string.IsNullOrEmpty(a.field) ? a.field : a.prop;
        int n = 0;
        Undo.IncrementCurrentGroup();
        Undo.SetCurrentGroupName("Tuner reset");
        if (a.state == "*")
        {
            for (int k = 0; k < s.States.Count; k++) n += ResetTunerOverrides(s, s.States[k].Overrides, k == s.Active, a.id, a.component, field);
        }
        else if (string.IsNullOrEmpty(a.state))
        {
            if (s.Active >= 0) n = ResetTunerOverrides(s, s.States[s.Active].Overrides, true, a.id, a.component, field);
        }
        else
        {
            int k = FindTunerState(s, a.state);
            if (k < 0)
            {
                TunerResult(from, id, "no state '" + a.state + "'", null);
                return;
            }
            n = ResetTunerOverrides(s, s.States[k].Overrides, k == s.Active, a.id, a.component, field);
        }
        Undo.IncrementCurrentGroup();
        FlushTunerTracks(s);
        s.Dirty = true;
        s.StatePending = true;
        Debug.Log("[Tuner] reset " + s.Name + " state=" + (string.IsNullOrEmpty(a.state) ? "(current)" : a.state)
            + (string.IsNullOrEmpty(a.id) ? "" : " id=" + a.id) + (string.IsNullOrEmpty(a.component) ? "" : " component=" + a.component)
            + (string.IsNullOrEmpty(field) ? "" : " field=" + field) + " -> " + n + " change" + (n == 1 ? "" : "s") + " reset");
        TunerResult(from, id, null, "\"state\":" + DescribeTunerState(s));
    }

    static int ResetTunerOverrides(TunerSession s, List<TunerOverride> list, bool live, string entry, string component, string field)
    {
        int n = 0;
        for (int j = list.Count - 1; j >= 0; j--)
        {
            var o = list[j];
            if (!string.IsNullOrEmpty(entry) && o.Entry != entry) continue;
            if (!string.IsNullOrEmpty(component) && !string.Equals(o.Component, component, component == "transform" ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)) continue;
            if (!string.IsNullOrEmpty(field) && o.Field != field && !o.Field.StartsWith(field + ".", StringComparison.Ordinal)) continue;
            if (live)
            {
                var target = TunerTrackTargetFor(s, o.Entry, o.Component);
                if (target != null && !string.IsNullOrEmpty(o.BeforeRaw))
                {
                    RestoreTunerValue(target, o.Field, o.BeforeRaw);
                    MarkTunerSceneDirty(target);
                    var t = FindTunerTrack(s, o.Entry, o.Component);
                    if (t != null) MarkTunerTrack(t, o.Field);
                }
            }
            list.RemoveAt(j);
            n++;
        }
        return n;
    }

    static void AppendTunerStateInfo(StringBuilder sb, TunerStateDef st)
    {
        sb.Append("{\"name\":").Append(JStr(st.Name))
          .Append(",\"label\":").Append(JStr(st.Label))
          .Append(",\"note\":").Append(JStr(st.Note))
          .Append(",\"changes\":").Append(st.Overrides.Count.ToString(Inv))
          .Append(",\"pause\":").Append(st.Pause ? "true" : "false");
        if (st.Error != null) sb.Append(",\"error\":").Append(JStr(st.Error));
        sb.Append('}');
    }

    static void AppendTunerOverride(StringBuilder sb, TunerSession s, string state, TunerOverride o)
    {
        sb.Append("{\"state\":").Append(JStr(state))
          .Append(",\"id\":").Append(JStr(o.Entry))
          .Append(",\"path\":").Append(JStr(TunerEntryPath(s, o.Entry)))
          .Append(",\"component\":").Append(JStr(o.Component))
          .Append(",\"field\":").Append(JStr(o.Field))
          .Append(",\"before\":").Append(JStr(o.Before))
          .Append(",\"after\":").Append(JStr(o.After))
          .Append(",\"beforeRaw\":").Append(JStr(o.BeforeRaw))
          .Append(",\"afterRaw\":").Append(JStr(o.AfterRaw));
        if (o.Runtime != null)
        {
            sb.Append(",\"runtime\":{");
            bool first = true;
            if (o.Runtime.Prefab != null)
            {
                sb.Append("\"prefab\":").Append(JStr(o.Runtime.Prefab));
                first = false;
            }
            if (o.Runtime.Child != null)
            {
                if (!first) sb.Append(',');
                sb.Append("\"child\":").Append(JStr(o.Runtime.Child));
                first = false;
            }
            if (o.Runtime.CopyOf != null)
            {
                if (!first) sb.Append(',');
                sb.Append("\"copyOf\":").Append(JStr(o.Runtime.CopyOf));
            }
            sb.Append('}');
        }
        sb.Append('}');
    }

    static bool SnapshotTunerField(Component comp, string field, out string raw, out string display)
    {
        raw = null;
        display = null;
        if (comp == null || string.IsNullOrEmpty(field)) return false;
        var rect = comp as RectTransform;
        if (rect != null && field.StartsWith("m_AnchoredPosition", StringComparison.Ordinal)) rect.anchoredPosition = rect.anchoredPosition;
        var so = new SerializedObject(comp);
        so.UpdateIfRequiredOrScript();
        var p = so.FindProperty(field);
        if (p == null) return false;
        var entries = new List<KeyValuePair<string, string>>();
        SnapshotTunerProp(p, entries, 0);
        if (entries.Count == 0) return false;
        var sb = new StringBuilder(64 + entries.Count * 24);
        sb.Append("{\"e\":[");
        for (int i = 0; i < entries.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"p\":").Append(JStr(entries[i].Key)).Append(",\"v\":").Append(JStr(entries[i].Value)).Append('}');
        }
        sb.Append("]}");
        raw = sb.ToString();
        display = TunerDisplayValue(p, comp is Transform && field == "m_LocalRotation");
        return true;
    }

    static void SnapshotTunerProp(SerializedProperty p, List<KeyValuePair<string, string>> outList, int depth)
    {
        if (outList.Count >= TUNER_SNAPSHOT_MAX || depth > TUNER_MAX_DEPTH) return;
        if (p.isArray && p.propertyType == SerializedPropertyType.Generic)
        {
            int n = p.arraySize;
            outList.Add(new KeyValuePair<string, string>(p.propertyPath + ".Array.size", n.ToString(Inv)));
            for (int i = 0; i < n && outList.Count < TUNER_SNAPSHOT_MAX; i++)
                SnapshotTunerProp(p.GetArrayElementAtIndex(i), outList, depth + 1);
            return;
        }
        if (p.propertyType == SerializedPropertyType.Generic)
        {
            var c = p.Copy();
            var end = p.GetEndProperty();
            if (c.Next(true))
            {
                while (!SerializedProperty.EqualContents(c, end))
                {
                    SnapshotTunerProp(c.Copy(), outList, depth + 1);
                    if (!c.Next(false)) break;
                }
            }
            return;
        }
        var v = TunerRawValue(p);
        if (v != null) outList.Add(new KeyValuePair<string, string>(p.propertyPath, v));
    }

    static string RestoreTunerSnapshot(Component comp, string raw)
    {
        if (comp == null || string.IsNullOrEmpty(raw)) return "nothing to restore";
        TunerSnap snap;
        try { snap = JsonUtility.FromJson<TunerSnap>(raw); }
        catch (Exception e) { return "bad snapshot: " + e.Message; }
        if (snap == null || snap.e == null) return "bad snapshot";
        var so = new SerializedObject(comp);
        so.UpdateIfRequiredOrScript();
        string first = null;
        const string sizeSuffix = ".Array.size";
        foreach (var en in snap.e)
        {
            if (en == null || string.IsNullOrEmpty(en.p)) continue;
            if (en.p.EndsWith(sizeSuffix, StringComparison.Ordinal))
            {
                var arr = so.FindProperty(en.p.Substring(0, en.p.Length - sizeSuffix.Length));
                int n;
                if (arr != null && arr.isArray && int.TryParse(en.v, System.Globalization.NumberStyles.Integer, Inv, out n)) arr.arraySize = n;
                else if (first == null) first = "cannot resize " + en.p;
                continue;
            }
            var p = so.FindProperty(en.p);
            if (p == null)
            {
                if (first == null) first = "no field " + en.p;
                continue;
            }
            var err = SetTunerValue(p, en.v ?? "");
            if (err != null && first == null) first = err;
        }
        so.ApplyModifiedProperties();
        return first;
    }

    static string TunerRawValue(SerializedProperty p)
    {
        switch (p.propertyType)
        {
            case SerializedPropertyType.Integer:
                return p.longValue.ToString(Inv);
            case SerializedPropertyType.Float:
                return p.doubleValue.ToString("R", Inv);
            case SerializedPropertyType.Boolean:
                return p.boolValue ? "true" : "false";
            case SerializedPropertyType.String:
                return p.stringValue ?? "";
            case SerializedPropertyType.Enum:
            {
                Type ft;
                ResolveTunerField(p.serializedObject.targetObject.GetType(), p.propertyPath, out ft);
                if (ft != null && ft.IsEnum && ft.IsDefined(typeof(FlagsAttribute), false)) return p.enumValueFlag.ToString(Inv);
                return p.enumValueIndex.ToString(Inv);
            }
            case SerializedPropertyType.LayerMask:
                return p.intValue.ToString(Inv);
            case SerializedPropertyType.Color:
            {
                var c = p.colorValue;
                return RawFloats(c.r, c.g, c.b, c.a);
            }
            case SerializedPropertyType.Vector2:
                return RawFloats(p.vector2Value.x, p.vector2Value.y);
            case SerializedPropertyType.Vector3:
                return RawFloats(p.vector3Value.x, p.vector3Value.y, p.vector3Value.z);
            case SerializedPropertyType.Vector4:
                return RawFloats(p.vector4Value.x, p.vector4Value.y, p.vector4Value.z, p.vector4Value.w);
            case SerializedPropertyType.Quaternion:
            {
                var q = p.quaternionValue;
                return RawFloats(q.x, q.y, q.z, q.w);
            }
            case SerializedPropertyType.Vector2Int:
                return p.vector2IntValue.x.ToString(Inv) + "," + p.vector2IntValue.y.ToString(Inv);
            case SerializedPropertyType.Vector3Int:
                return p.vector3IntValue.x.ToString(Inv) + "," + p.vector3IntValue.y.ToString(Inv) + "," + p.vector3IntValue.z.ToString(Inv);
            default:
                return null;
        }
    }

    static string RawFloats(params float[] v)
    {
        var parts = new string[v.Length];
        for (int i = 0; i < v.Length; i++) parts[i] = v[i].ToString("R", Inv);
        return string.Join(",", parts);
    }

    static string TunerRound(double d, double scale)
    {
        if (double.IsNaN(d)) return "NaN";
        if (double.IsInfinity(d)) return d > 0 ? "Infinity" : "-Infinity";
        var r = Math.Round(d * scale, MidpointRounding.AwayFromZero) / scale;
        if (r == 0) r = 0;
        return r.ToString("R", Inv);
    }

    static string TunerTuple(params double[] v)
    {
        var parts = new string[v.Length];
        for (int i = 0; i < v.Length; i++) parts[i] = TunerRound(v[i], 1000);
        return "(" + string.Join(", ", parts) + ")";
    }

    static double Wrap180(double d)
    {
        d %= 360.0;
        if (d > 180.0) d -= 360.0;
        if (d <= -180.0) d += 360.0;
        return d;
    }

    static string TunerDisplayValue(SerializedProperty p, bool euler)
    {
        switch (p.propertyType)
        {
            case SerializedPropertyType.Integer:
                return p.longValue.ToString(Inv);
            case SerializedPropertyType.Float:
                return TunerRound(p.doubleValue, 10000);
            case SerializedPropertyType.Boolean:
                return p.boolValue ? "true" : "false";
            case SerializedPropertyType.String:
                return JStr(p.stringValue ?? "");
            case SerializedPropertyType.Enum:
            {
                Type ft;
                ResolveTunerField(p.serializedObject.targetObject.GetType(), p.propertyPath, out ft);
                if (ft != null && ft.IsEnum && ft.IsDefined(typeof(FlagsAttribute), false))
                {
                    var names = new List<string>();
                    long v = p.enumValueFlag;
                    foreach (var e in Enum.GetValues(ft))
                    {
                        long n = Convert.ToInt64(e, Inv);
                        if (n == 0 || (n & (n - 1)) != 0 || (v & n) == 0) continue;
                        names.Add(ObjectNames.NicifyVariableName(Enum.GetName(ft, e)));
                    }
                    return names.Count > 0 ? string.Join(" | ", names) : "Nothing";
                }
                int idx = p.enumValueIndex;
                var opts = p.enumDisplayNames;
                return idx >= 0 && idx < opts.Length ? opts[idx] : idx.ToString(Inv);
            }
            case SerializedPropertyType.LayerMask:
            {
                var names = new List<string>();
                int v = p.intValue;
                for (int i = 0; i < 32; i++)
                {
                    var n = LayerMask.LayerToName(i);
                    if (!string.IsNullOrEmpty(n) && (v & (1 << i)) != 0) names.Add(n);
                }
                return names.Count > 0 ? string.Join(" | ", names) : "Nothing";
            }
            case SerializedPropertyType.Color:
            {
                var c = p.colorValue;
                if (c.r > 1.001f || c.g > 1.001f || c.b > 1.001f) return TunerTuple(c.r, c.g, c.b, c.a);
                return TiJsonColor(c).Trim('"');
            }
            case SerializedPropertyType.Vector2:
                return TunerTuple(p.vector2Value.x, p.vector2Value.y);
            case SerializedPropertyType.Vector3:
                return TunerTuple(p.vector3Value.x, p.vector3Value.y, p.vector3Value.z);
            case SerializedPropertyType.Vector4:
                return TunerTuple(p.vector4Value.x, p.vector4Value.y, p.vector4Value.z, p.vector4Value.w);
            case SerializedPropertyType.Quaternion:
            {
                var q = p.quaternionValue;
                if (euler)
                {
                    var e = q.eulerAngles;
                    return TunerTuple(Wrap180(e.x), Wrap180(e.y), Wrap180(e.z));
                }
                return TunerTuple(q.x, q.y, q.z, q.w);
            }
            case SerializedPropertyType.Vector2Int:
                return TunerTuple(p.vector2IntValue.x, p.vector2IntValue.y);
            case SerializedPropertyType.Vector3Int:
                return TunerTuple(p.vector3IntValue.x, p.vector3IntValue.y, p.vector3IntValue.z);
            case SerializedPropertyType.ObjectReference:
                return p.objectReferenceValue == null ? "None" : p.objectReferenceValue.name;
            default:
                if (p.isArray && p.propertyType == SerializedPropertyType.Generic)
                    return p.arraySize.ToString(Inv) + (p.arraySize == 1 ? " element" : " elements");
                return "{…}";
        }
    }
}
