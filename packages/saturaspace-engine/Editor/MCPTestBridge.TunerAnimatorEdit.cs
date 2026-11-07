using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.Animations;
using UnityEngine;
using TangentMode = UnityEditor.AnimationUtility.TangentMode;

public static partial class MCPTestBridge
{
    const string TUNER_ANIM_DIR = "Assets/Anim";

    [Serializable]
    class TunerAnimKeyArg
    {
        public string id;
        public string path;
        public string type;
        public string prop;
        public float t;
        public int frame = -1;
        public bool hasV;
        public float v;
        public bool hasTan;
        public float inT;
        public float outT;
        public float inW;
        public float outW;
        public int wm;
        public int lm;
        public int rm;
        public bool broken;
        public string tangent;
        public float dv;
        public bool add;
    }

    [Serializable]
    class TunerAnimEventArg
    {
        public float t;
        public int frame = -1;
        public string fn;
        public float f;
        public int i;
        public string s;
        public string o;
    }

    sealed class TunerAnimEditCtx
    {
        public AnimationClip Clip;
        public GameObject Root;
        public string Label;
        public Action<AnimationClip> Touch;
        public Dictionary<string, AnimationCurve> DragBase;
    }

    static readonly Dictionary<string, Type> _tunerAnimTypes = new Dictionary<string, Type>();

    static Type TunerAnimType(string name)
    {
        if (string.IsNullOrEmpty(name)) return null;
        if (_tunerAnimTypes.TryGetValue(name, out var t)) return t;
        if (name == "UnityEngine.GameObject" || name == "GameObject") t = typeof(GameObject);
        else
        {
            bool shortName = name.IndexOf('.') < 0;
            foreach (var c in TypeCache.GetTypesDerivedFrom<Component>())
            {
                if (c.FullName == name)
                {
                    t = c;
                    break;
                }
                if (shortName && c.Name == name && (t == null || c.Namespace == "UnityEngine")) t = c;
            }
        }
        if (t != null) _tunerAnimTypes[name] = t;
        return t;
    }

    static string TunerAnimId(EditorCurveBinding b)
    {
        return b.path + "|" + (b.type != null ? b.type.FullName : "") + "|" + b.propertyName + (b.isPPtrCurve ? "|pptr" : "");
    }

    static float TunerAnimFps(AnimationClip clip) => clip != null && clip.frameRate > 0f ? clip.frameRate : 60f;

    static float TunerAnimSnap(AnimationClip clip, double t)
    {
        double fr = TunerAnimFps(clip);
        return (float)(Math.Round(Math.Max(0, t) * fr) / fr);
    }

    static int TunerAnimFrame(AnimationClip clip, double t) => (int)Math.Round(t * TunerAnimFps(clip));

    static int TunerAnimKeyAt(AnimationCurve c, AnimationClip clip, double t)
    {
        if (c == null) return -1;
        int f = TunerAnimFrame(clip, t);
        for (int i = 0; i < c.length; i++)
            if (TunerAnimFrame(clip, c[i].time) == f) return i;
        return -1;
    }

    static bool TunerAnimIsRotation(EditorCurveBinding b)
    {
        return b.type == typeof(Transform) && (b.propertyName.StartsWith("localEulerAngles", StringComparison.Ordinal) || b.propertyName.StartsWith("m_LocalRotation", StringComparison.Ordinal));
    }

    static string TunerAnimGroupOf(string prop, out string channel)
    {
        int dot = prop.LastIndexOf('.');
        if (dot > 0 && dot == prop.Length - 2)
        {
            char c = prop[prop.Length - 1];
            if ("xyzwrgba".IndexOf(c) >= 0)
            {
                channel = c.ToString();
                return prop.Substring(0, dot);
            }
        }
        channel = "";
        return prop;
    }

    static List<EditorCurveBinding> TunerAnimClipBindings(AnimationClip clip)
    {
        var list = new List<EditorCurveBinding>();
        if (clip == null) return list;
        list.AddRange(AnimationUtility.GetCurveBindings(clip));
        list.AddRange(AnimationUtility.GetObjectReferenceCurveBindings(clip));
        return list;
    }

    static readonly Dictionary<GameObject, (int gen, EditorCurveBinding[] list)> _tunerAnimatable = new Dictionary<GameObject, (int, EditorCurveBinding[])>();

    static EditorCurveBinding[] TunerAnimAnimatable(GameObject root)
    {
        if (root == null) return new EditorCurveBinding[0];
        if (_tunerAnimatable.TryGetValue(root, out var hit) && hit.gen == _tunerHierarchyGen) return hit.list;
        var list = new List<EditorCurveBinding>();
        foreach (var t in root.GetComponentsInChildren<Transform>(true))
            list.AddRange(AnimationUtility.GetAnimatableBindings(t.gameObject, root));
        var arr = list.ToArray();
        _tunerAnimatable[root] = (_tunerHierarchyGen, arr);
        return arr;
    }

    static bool TunerAnimFindBinding(AnimationClip clip, GameObject root, string id, out EditorCurveBinding b)
    {
        b = default;
        if (string.IsNullOrEmpty(id)) return false;
        foreach (var x in TunerAnimClipBindings(clip))
            if (TunerAnimId(x) == id)
            {
                b = x;
                return true;
            }
        if (root != null)
            foreach (var x in TunerAnimAnimatable(root))
                if (TunerAnimId(x) == id)
                {
                    b = x;
                    return true;
                }
        var parts = id.Split('|');
        if (parts.Length < 3) return false;
        var type = TunerAnimType(parts[1]);
        if (type == null) return false;
        b = parts.Length > 3 && parts[3] == "pptr" ? EditorCurveBinding.PPtrCurve(parts[0], type, parts[2]) : EditorCurveBinding.FloatCurve(parts[0], type, parts[2]);
        return true;
    }

    static string TunerAnimKeyId(AnimationClip clip, GameObject root, TunerAnimKeyArg k)
    {
        if (!string.IsNullOrEmpty(k.id)) return k.id;
        if (string.IsNullOrEmpty(k.prop)) return null;
        var prop = TunerAnimAliasProp(clip, k.prop);
        var path = (k.path ?? "").Trim('/');
        Type type = TunerAnimType(string.IsNullOrEmpty(k.type) ? "UnityEngine.Transform" : k.type);
        if (type == null && root != null)
            foreach (var x in TunerAnimAnimatable(root))
                if (x.type.Name == k.type)
                {
                    type = x.type;
                    break;
                }
        if (type == null) return null;
        return path + "|" + type.FullName + "|" + prop;
    }

    static string TunerAnimAliasProp(AnimationClip clip, string prop)
    {
        string ch;
        var g = TunerAnimGroupOf(prop, out ch);
        string suffix = ch.Length > 0 ? "." + ch : "";
        switch (g.ToLowerInvariant())
        {
            case "position":
            case "localposition":
                return "m_LocalPosition" + suffix;
            case "scale":
            case "localscale":
                return "m_LocalScale" + suffix;
            case "rotation":
            case "eulerangles":
            case "localeulerangles":
                return TunerAnimEulerPrefix(clip) + suffix;
        }
        return prop;
    }

    static string TunerAnimEulerPrefix(AnimationClip clip)
    {
        foreach (var b in AnimationUtility.GetCurveBindings(clip))
        {
            if (b.type != typeof(Transform)) continue;
            if (b.propertyName.StartsWith("localEulerAnglesBaked.", StringComparison.Ordinal)) return "localEulerAnglesBaked";
            if (b.propertyName.StartsWith("localEulerAngles.", StringComparison.Ordinal)) return "localEulerAngles";
            if (b.propertyName.StartsWith("localEulerAnglesRaw.", StringComparison.Ordinal)) return "localEulerAnglesRaw";
        }
        return clip.legacy ? "localEulerAnglesBaked" : "localEulerAnglesRaw";
    }

    static string TunerAnimEulerPrefixFor(AnimationClip clip, string path)
    {
        foreach (var name in new[] { "localEulerAnglesBaked", "localEulerAngles", "localEulerAnglesRaw" })
            if (AnimationUtility.GetEditorCurve(clip, EditorCurveBinding.FloatCurve(path, typeof(Transform), name + ".x")) != null) return name;
        if (clip.legacy) return "localEulerAnglesBaked";
        return "localEulerAnglesRaw";
    }

    static List<EditorCurveBinding> TunerAnimExpandGroup(AnimationClip clip, EditorCurveBinding b)
    {
        var list = new List<EditorCurveBinding>();
        if (b.type == typeof(Transform))
        {
            string prefix = null;
            if (TunerAnimIsRotation(b)) prefix = TunerAnimEulerPrefixFor(clip, b.path);
            else if (b.propertyName.StartsWith("m_LocalPosition", StringComparison.Ordinal)) prefix = "m_LocalPosition";
            else if (b.propertyName.StartsWith("m_LocalScale", StringComparison.Ordinal)) prefix = "m_LocalScale";
            if (prefix != null)
            {
                foreach (var c in "xyz") list.Add(EditorCurveBinding.FloatCurve(b.path, b.type, prefix + "." + c));
                return list;
            }
        }
        list.Add(b);
        return list;
    }

    static Type TunerAnimValueType(GameObject root, EditorCurveBinding b)
    {
        if (b.isPPtrCurve) return typeof(UnityEngine.Object);
        if (root == null) return typeof(float);
        try
        {
            var t = AnimationUtility.GetEditorCurveValueType(root, b);
            return t ?? typeof(float);
        }
        catch
        {
            return typeof(float);
        }
    }

    static bool TunerAnimCurrent(GameObject root, EditorCurveBinding b, out float v)
    {
        v = 0f;
        if (root == null || b.isPPtrCurve) return false;
        try
        {
            if (b.isDiscreteCurve)
            {
                if (!AnimationUtility.GetDiscreteIntValue(root, b, out int iv)) return false;
                v = iv;
                return true;
            }
            return AnimationUtility.GetFloatValue(root, b, out v);
        }
        catch
        {
            return false;
        }
    }

    static void TunerAnimModes(AnimationCurve c, int i, TangentMode? left, TangentMode? right, bool broken)
    {
        if (left.HasValue) AnimationUtility.SetKeyLeftTangentMode(c, i, left.Value);
        if (right.HasValue) AnimationUtility.SetKeyRightTangentMode(c, i, right.Value);
        AnimationUtility.SetKeyBroken(c, i, broken);
    }

    static int TunerAnimPutKey(AnimationCurve c, AnimationClip clip, float time, float value, Type valueType)
    {
        int at = TunerAnimKeyAt(c, clip, time);
        if (at >= 0)
        {
            var k = c[at];
            k.value = value;
            return c.MoveKey(at, k);
        }
        var key = new Keyframe(time, value);
        if (valueType == typeof(bool))
        {
            int i = c.AddKey(key);
            TunerAnimModes(c, i, TangentMode.Constant, TangentMode.Constant, true);
            return i;
        }
        if (valueType == typeof(int))
        {
            int i = c.AddKey(key);
            if (c.length <= 1) TunerAnimModes(c, i, TangentMode.Linear, TangentMode.Linear, true);
            else
            {
                TunerAnimKeyModeFromContext(c, i);
                AnimationUtility.SetKeyBroken(c, i, true);
            }
            return i;
        }
        int j = c.AddKey(key);
        if (j < 0) return -1;
        TunerAnimModes(c, j, TangentMode.ClampedAuto, TangentMode.ClampedAuto, false);
        TunerAnimUpdateTangents(c);
        TunerAnimKeyModeFromContext(c, j);
        return j;
    }

    static MethodInfo _tunerAnimUpdateTangents;
    static bool _tunerAnimUpdateTangentsLooked;

    static void TunerAnimUpdateTangents(AnimationCurve c)
    {
        if (!_tunerAnimUpdateTangentsLooked)
        {
            _tunerAnimUpdateTangentsLooked = true;
            _tunerAnimUpdateTangents = typeof(AnimationUtility).GetMethod("UpdateTangentsFromMode", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, new[] { typeof(AnimationCurve) }, null);
        }
        if (_tunerAnimUpdateTangents != null)
        {
            try
            {
                _tunerAnimUpdateTangents.Invoke(null, new object[] { c });
                return;
            }
            catch { _tunerAnimUpdateTangents = null; }
        }
        for (int i = 0; i < c.length; i++)
            TunerAnimModes(c, i, AnimationUtility.GetKeyLeftTangentMode(c, i), AnimationUtility.GetKeyRightTangentMode(c, i), AnimationUtility.GetKeyBroken(c, i));
    }

    static void TunerAnimKeyModeFromContext(AnimationCurve c, int i)
    {
        bool broken = false;
        bool smooth = false;
        int last = c.length - 1;
        if (i > 0)
        {
            if (AnimationUtility.GetKeyBroken(c, i - 1)) broken = true;
            var m = AnimationUtility.GetKeyRightTangentMode(c, i - 1);
            if (m == TangentMode.ClampedAuto || m == TangentMode.Auto) smooth = true;
        }
        if (i < last)
        {
            if (AnimationUtility.GetKeyBroken(c, i + 1)) broken = true;
            var m = AnimationUtility.GetKeyLeftTangentMode(c, i + 1);
            if (m == TangentMode.ClampedAuto || m == TangentMode.Auto) smooth = true;
        }
        if (broken && !smooth)
        {
            TangentMode? left = null;
            TangentMode? right = null;
            if (i > 0) left = AnimationUtility.GetKeyRightTangentMode(c, i - 1);
            if (i < last) right = AnimationUtility.GetKeyLeftTangentMode(c, i + 1);
            if (i == 0) left = right ?? AnimationUtility.GetKeyRightTangentMode(c, i);
            if (i == last) right = left ?? AnimationUtility.GetKeyLeftTangentMode(c, i);
            TunerAnimModes(c, i, left, right, true);
            return;
        }
        var mode = TangentMode.Free;
        if ((i == 0 || AnimationUtility.GetKeyRightTangentMode(c, i - 1) == TangentMode.ClampedAuto) && (i == last || AnimationUtility.GetKeyLeftTangentMode(c, i + 1) == TangentMode.ClampedAuto))
            mode = TangentMode.ClampedAuto;
        else if ((i == 0 || AnimationUtility.GetKeyRightTangentMode(c, i - 1) == TangentMode.Auto) && (i == last || AnimationUtility.GetKeyLeftTangentMode(c, i + 1) == TangentMode.Auto))
            mode = TangentMode.Auto;
        TunerAnimModes(c, i, mode, mode, broken);
    }

    static void TunerAnimBegin(TunerAnimEditCtx ctx)
    {
        ctx.Touch?.Invoke(ctx.Clip);
        Undo.RegisterCompleteObjectUndo(ctx.Clip, ctx.Label);
    }

    static void TunerAnimSave(AnimationCurve c, AnimationClip clip, EditorCurveBinding b)
    {
        if (c == null || c.length == 0)
        {
            AnimationUtility.SetEditorCurve(clip, b, null);
            return;
        }
        TunerAnimUpdateTangents(c);
        AnimationUtility.SetEditorCurve(clip, b, c);
    }

    static void TunerAnimDone(AnimationClip clip, bool save)
    {
        EditorUtility.SetDirty(clip);
        if (save) TunerSaveAsset(clip);
        else NoteTunerAssetEdit(clip);
    }

    static string TunerAnimReadOnly(AnimationClip clip)
    {
        if (clip == null) return "no clip is open";
        if ((clip.hideFlags & HideFlags.NotEditable) != 0 || !AssetDatabase.GetAssetPath(clip).EndsWith(".anim", StringComparison.OrdinalIgnoreCase))
            return "clip " + clip.name + " is read-only (it comes from " + Path.GetFileName(AssetDatabase.GetAssetPath(clip)) + "): duplicate it as an editable clip first";
        return null;
    }

    static string TunerAnimAddKeys(TunerAnimEditCtx ctx, IList<string> ids, double time, IDictionary<string, float> values, bool zeroFrame, IDictionary<string, float> previous, bool save = true)
    {
        var clip = ctx.Clip;
        float t = TunerAnimSnap(clip, time);
        var bindings = new List<EditorCurveBinding>();
        var explicitIds = new HashSet<string>();
        foreach (var id in ids)
        {
            if (!TunerAnimFindBinding(clip, ctx.Root, id, out var b)) return "no property " + id;
            if (b.isPPtrCurve) continue;
            if (b.type == typeof(Transform) && b.propertyName.StartsWith("m_LocalRotation.", StringComparison.Ordinal))
            {
                if (b.propertyName.EndsWith(".w", StringComparison.Ordinal)) continue;
                var euler = EditorCurveBinding.FloatCurve(b.path, b.type, TunerAnimEulerPrefixFor(clip, b.path) + b.propertyName.Substring(b.propertyName.Length - 2));
                if (values != null && values.TryGetValue(id, out var qv) && !values.ContainsKey(TunerAnimId(euler))) values[TunerAnimId(euler)] = qv;
                b = euler;
            }
            explicitIds.Add(TunerAnimId(b));
            if (!bindings.Contains(b)) bindings.Add(b);
        }
        foreach (var b in bindings.ToList())
        {
            if (b.type != typeof(Transform) || !(b.propertyName.StartsWith("localEulerAngles", StringComparison.Ordinal) || b.propertyName.StartsWith("m_LocalPosition.", StringComparison.Ordinal) || b.propertyName.StartsWith("m_LocalScale.", StringComparison.Ordinal))) continue;
            foreach (var sib in TunerAnimExpandGroup(clip, b))
                if (!bindings.Contains(sib) && AnimationUtility.GetEditorCurve(clip, sib) == null) bindings.Add(sib);
        }
        if (bindings.Count == 0) return "nothing to key";
        TunerAnimBegin(ctx);
        var saveB = new List<EditorCurveBinding>();
        var saveC = new List<AnimationCurve>();
        foreach (var b in bindings)
        {
            var id = TunerAnimId(b);
            float v;
            if (values == null || !values.TryGetValue(id, out v))
            {
                var existing = AnimationUtility.GetEditorCurve(clip, b);
                if (b.type == typeof(Animator) && existing != null && existing.length > 0) v = existing.Evaluate(t);
                else if (!TunerAnimCurrent(ctx.Root, b, out v)) v = existing != null && existing.length > 0 ? existing.Evaluate(t) : 0f;
            }
            var type = TunerAnimValueType(ctx.Root, b);
            var c = AnimationUtility.GetEditorCurve(clip, b) ?? new AnimationCurve();
            if (zeroFrame && c.length == 0 && TunerAnimFrame(clip, t) != 0)
            {
                float pv = previous != null && previous.TryGetValue(id, out var p) ? p : v;
                TunerAnimPutKey(c, clip, 0f, pv, type);
            }
            TunerAnimPutKey(c, clip, t, v, type);
            TunerAnimUpdateTangents(c);
            saveB.Add(b);
            saveC.Add(c);
        }
        AnimationUtility.SetEditorCurves(clip, saveB.ToArray(), saveC.ToArray());
        TunerAnimDone(clip, save);
        return null;
    }

    static string TunerAnimAddProps(TunerAnimEditCtx ctx, IList<string> ids)
    {
        var clip = ctx.Clip;
        var todo = new List<EditorCurveBinding>();
        foreach (var id in ids)
        {
            if (!TunerAnimFindBinding(clip, ctx.Root, id, out var b)) return "no property " + id;
            foreach (var x in TunerAnimExpandGroup(clip, b))
                if (!todo.Contains(x)) todo.Add(x);
        }
        TunerAnimBegin(ctx);
        float len = clip.length;
        foreach (var b in todo)
        {
            if (b.isPPtrCurve)
            {
                if (AnimationUtility.GetObjectReferenceCurve(clip, b) != null) continue;
                AnimationUtility.GetObjectReferenceValue(ctx.Root, b, out var obj);
                var keys = len > 0f
                    ? new[] { new ObjectReferenceKeyframe { time = 0f, value = obj }, new ObjectReferenceKeyframe { time = len, value = obj } }
                    : new[] { new ObjectReferenceKeyframe { time = 0f, value = obj } };
                AnimationUtility.SetObjectReferenceCurve(clip, b, keys);
                continue;
            }
            if (AnimationUtility.GetEditorCurve(clip, b) != null) continue;
            if (!TunerAnimCurrent(ctx.Root, b, out var v)) v = 0f;
            if (float.IsNaN(v)) v = 0f;
            var type = TunerAnimValueType(ctx.Root, b);
            var c = new AnimationCurve();
            TunerAnimPutKey(c, clip, 0f, v, type);
            if (len > 0f) TunerAnimPutKey(c, clip, len, v, type);
            TunerAnimSave(c, clip, b);
        }
        TunerAnimDone(clip, true);
        return null;
    }

    static string TunerAnimRemoveProps(TunerAnimEditCtx ctx, IList<string> ids)
    {
        var clip = ctx.Clip;
        var all = TunerAnimClipBindings(clip);
        var drop = new List<EditorCurveBinding>();
        foreach (var id in ids)
        {
            int n = 0;
            foreach (var b in all)
            {
                var bid = TunerAnimId(b);
                string ch;
                var gid = b.path + "|" + b.type.FullName + "|" + TunerAnimGroupOf(b.propertyName, out ch);
                if (bid == id || gid == id)
                {
                    if (!drop.Contains(b)) drop.Add(b);
                    n++;
                }
            }
            if (n == 0) return "the clip has no property " + id;
        }
        TunerAnimBegin(ctx);
        foreach (var b in drop)
        {
            if (b.isPPtrCurve) AnimationUtility.SetObjectReferenceCurve(clip, b, null);
            else AnimationUtility.SetEditorCurve(clip, b, null);
        }
        TunerAnimDone(clip, true);
        return null;
    }

    static Dictionary<string, List<float>> TunerAnimGroupKeys(AnimationClip clip, GameObject root, IEnumerable<TunerAnimKeyArg> keys, out string error)
    {
        error = null;
        var map = new Dictionary<string, List<float>>();
        foreach (var k in keys ?? new TunerAnimKeyArg[0])
        {
            if (k == null) continue;
            var id = TunerAnimKeyId(clip, root, k);
            if (id == null)
            {
                error = "a key needs id, or prop (with path and type)";
                return null;
            }
            float t = k.frame >= 0 ? k.frame / TunerAnimFps(clip) : k.t;
            if (!map.TryGetValue(id, out var list)) map[id] = list = new List<float>();
            list.Add(t);
        }
        return map;
    }

    static string TunerAnimDeleteKeys(TunerAnimEditCtx ctx, IEnumerable<TunerAnimKeyArg> keys)
    {
        var clip = ctx.Clip;
        var map = TunerAnimGroupKeys(clip, ctx.Root, keys, out var err);
        if (err != null) return err;
        if (map.Count == 0) return "no keys given";
        TunerAnimBegin(ctx);
        int n = 0;
        foreach (var kv in map)
        {
            if (!TunerAnimFindBinding(clip, ctx.Root, kv.Key, out var b)) continue;
            if (b.isPPtrCurve)
            {
                var oc = AnimationUtility.GetObjectReferenceCurve(clip, b);
                if (oc == null) continue;
                var kept = oc.Where(x => !kv.Value.Any(t => TunerAnimFrame(clip, t) == TunerAnimFrame(clip, x.time))).ToArray();
                n += oc.Length - kept.Length;
                AnimationUtility.SetObjectReferenceCurve(clip, b, kept.Length > 0 ? kept : null);
                continue;
            }
            var c = AnimationUtility.GetEditorCurve(clip, b);
            if (c == null) continue;
            foreach (var t in kv.Value)
            {
                int i = TunerAnimKeyAt(c, clip, t);
                if (i < 0) continue;
                c.RemoveKey(i);
                n++;
            }
            TunerAnimSave(c, clip, b);
        }
        TunerAnimDone(clip, true);
        return n == 0 ? "none of those keys exist" : null;
    }

    static string TunerAnimMoveKeys(TunerAnimEditCtx ctx, IEnumerable<TunerAnimKeyArg> keys, int dFrames, float dv, bool copy, bool save)
    {
        var clip = ctx.Clip;
        var map = TunerAnimGroupKeys(clip, ctx.Root, keys, out var err);
        if (err != null) return err;
        if (map.Count == 0) return "no keys given";
        float fps = TunerAnimFps(clip);
        var extra = new Dictionary<string, float>();
        var adds = new HashSet<string>();
        foreach (var k in keys)
        {
            if (k == null || !(TunerAnimKeyId(clip, ctx.Root, k) is string kid)) continue;
            string at = kid + "@" + TunerAnimFrame(clip, k.frame >= 0 ? k.frame / fps : k.t);
            if (k.dv != 0f) extra[at] = k.dv;
            if (k.add) adds.Add(at);
        }
        TunerAnimBegin(ctx);
        foreach (var kv in map)
        {
            if (!TunerAnimFindBinding(clip, ctx.Root, kv.Key, out var b)) continue;
            var frames = new HashSet<int>(kv.Value.Select(t => TunerAnimFrame(clip, t)));
            if (b.isPPtrCurve)
            {
                var oc = AnimationUtility.GetObjectReferenceCurve(clip, b);
                if (oc == null) continue;
                var moved = new List<ObjectReferenceKeyframe>();
                var stay = new List<ObjectReferenceKeyframe>();
                foreach (var x in oc)
                {
                    int f = TunerAnimFrame(clip, x.time);
                    if (frames.Contains(f))
                    {
                        moved.Add(new ObjectReferenceKeyframe { time = Math.Max(0, f + dFrames) / fps, value = x.value });
                        if (copy) stay.Add(x);
                    }
                    else stay.Add(x);
                }
                var targets = new HashSet<int>(moved.Select(m => TunerAnimFrame(clip, m.time)));
                stay.RemoveAll(x => targets.Contains(TunerAnimFrame(clip, x.time)));
                stay.AddRange(moved);
                AnimationUtility.SetObjectReferenceCurve(clip, b, stay.OrderBy(x => x.time).ToArray());
                continue;
            }
            var c = TunerAnimDragCurve(ctx, clip, b);
            if (c == null) continue;
            var inserts = frames.Where(f => adds.Contains(kv.Key + "@" + f) && TunerAnimKeyAt(c, clip, f / fps) < 0).Select(f => new KeyValuePair<int, float>(f, c.Evaluate(f / fps))).ToList();
            foreach (var ins in inserts) TunerAnimPutKey(c, clip, ins.Key / fps, ins.Value, typeof(float));
            var keysIn = c.keys;
            var movedK = new List<Keyframe>();
            var stayK = new List<Keyframe>();
            foreach (var k in keysIn)
            {
                int f = TunerAnimFrame(clip, k.time);
                if (frames.Contains(f))
                {
                    var m = k;
                    m.time = Math.Max(0, f + dFrames) / fps;
                    m.value = k.value + dv + (extra.TryGetValue(kv.Key + "@" + f, out var ex) ? ex : 0f);
                    movedK.Add(m);
                    if (copy) stayK.Add(k);
                }
                else stayK.Add(k);
            }
            var tf = new HashSet<int>(movedK.Select(m => TunerAnimFrame(clip, m.time)));
            stayK.RemoveAll(k => tf.Contains(TunerAnimFrame(clip, k.time)));
            stayK.AddRange(movedK);
            var nc = new AnimationCurve(stayK.OrderBy(k => k.time).ToArray()) { preWrapMode = c.preWrapMode, postWrapMode = c.postWrapMode };
            TunerAnimSave(nc, clip, b);
        }
        TunerAnimDone(clip, save);
        return null;
    }

    static AnimationCurve TunerAnimDragCurve(TunerAnimEditCtx ctx, AnimationClip clip, EditorCurveBinding b)
    {
        var c = AnimationUtility.GetEditorCurve(clip, b);
        if (ctx.DragBase == null) return c;
        var id = TunerAnimId(b);
        if (ctx.DragBase.TryGetValue(id, out var keep))
            return new AnimationCurve(keep.keys) { preWrapMode = keep.preWrapMode, postWrapMode = keep.postWrapMode };
        if (c != null) ctx.DragBase[id] = new AnimationCurve(c.keys) { preWrapMode = c.preWrapMode, postWrapMode = c.postWrapMode };
        return c;
    }

    static string TunerAnimPasteKeys(TunerAnimEditCtx ctx, IList<TunerAnimKeyArg> keys, double at)
    {
        var clip = ctx.Clip;
        if (keys == null || keys.Count == 0) return "nothing to paste";
        float fps = TunerAnimFps(clip);
        double t0 = keys.Min(k => k.t);
        int shift = (int)Math.Round((at - t0) * fps);
        var byId = new Dictionary<string, List<TunerAnimKeyArg>>();
        foreach (var k in keys)
        {
            var id = TunerAnimKeyId(clip, ctx.Root, k);
            if (id == null) return "a pasted key has no property";
            if (!byId.TryGetValue(id, out var l)) byId[id] = l = new List<TunerAnimKeyArg>();
            l.Add(k);
        }
        TunerAnimBegin(ctx);
        foreach (var kv in byId)
        {
            if (!TunerAnimFindBinding(clip, ctx.Root, kv.Key, out var b) || b.isPPtrCurve) continue;
            var c = AnimationUtility.GetEditorCurve(clip, b) ?? new AnimationCurve();
            foreach (var k in kv.Value)
            {
                float t = Math.Max(0, (int)Math.Round(k.t * fps) + shift) / fps;
                int old = TunerAnimKeyAt(c, clip, t);
                if (old >= 0) c.RemoveKey(old);
                var key = new Keyframe(t, k.v, k.hasTan ? k.inT : 0f, k.hasTan ? k.outT : 0f, k.hasTan ? k.inW : 1f / 3f, k.hasTan ? k.outW : 1f / 3f) { weightedMode = (WeightedMode)Mathf.Clamp(k.wm, 0, 3) };
                int i = c.AddKey(key);
                if (i < 0) continue;
                if (k.hasTan)
                {
                    TunerAnimModes(c, i, (TangentMode)Mathf.Clamp(k.lm, 0, 4), (TangentMode)Mathf.Clamp(k.rm, 0, 4), k.broken);
                    var back = c[i];
                    back.inTangent = k.inT;
                    back.outTangent = k.outT;
                    back.inWeight = k.inW;
                    back.outWeight = k.outW;
                    back.weightedMode = (WeightedMode)Mathf.Clamp(k.wm, 0, 3);
                    c.MoveKey(i, back);
                }
                else TunerAnimModes(c, i, TangentMode.ClampedAuto, TangentMode.ClampedAuto, false);
            }
            TunerAnimSave(c, clip, b);
        }
        TunerAnimDone(clip, true);
        return null;
    }

    static readonly string[] TUNER_ANIM_TANGENTS =
    {
        "clampedAuto", "auto", "freeSmooth", "flat", "broken",
        "leftFree", "leftLinear", "leftConstant", "leftWeighted",
        "rightFree", "rightLinear", "rightConstant", "rightWeighted",
        "bothFree", "bothLinear", "bothConstant", "weighted",
        "linear", "step", "ease", "easeIn", "easeOut", "easeInOut", "bezier"
    };

    static bool TunerAnimPreset(string mode, out float x1, out float y1, out float x2, out float y2)
    {
        x1 = y1 = x2 = y2 = 0f;
        switch (mode)
        {
            case "ease": x1 = 0.25f; y1 = 0.1f; x2 = 0.25f; y2 = 1f; return true;
            case "easeIn": x1 = 0.42f; y1 = 0f; x2 = 1f; y2 = 1f; return true;
            case "easeOut": x1 = 0f; y1 = 0f; x2 = 0.58f; y2 = 1f; return true;
            case "easeInOut": x1 = 0.42f; y1 = 0f; x2 = 0.58f; y2 = 1f; return true;
        }
        if (mode != null && mode.StartsWith("bezier", StringComparison.Ordinal))
        {
            var p = mode.Substring(6).Trim().Split(new[] { ' ', ',' }, StringSplitOptions.RemoveEmptyEntries);
            if (p.Length != 4) return false;
            var v = new float[4];
            for (int i = 0; i < 4; i++)
                if (!float.TryParse(p[i], NumberStyles.Float, CultureInfo.InvariantCulture, out v[i])) return false;
            x1 = Mathf.Clamp01(v[0]);
            y1 = v[1];
            x2 = Mathf.Clamp01(v[2]);
            y2 = v[3];
            return true;
        }
        return false;
    }

    static bool TunerAnimIsAuto(TangentMode m) => m == TangentMode.ClampedAuto || m == TangentMode.Auto;

    static void TunerAnimSide(AnimationCurve c, int i, bool left, TangentMode mode)
    {
        var l = AnimationUtility.GetKeyLeftTangentMode(c, i);
        var r = AnimationUtility.GetKeyRightTangentMode(c, i);
        if (left)
        {
            l = mode;
            if (TunerAnimIsAuto(r)) r = TangentMode.Free;
        }
        else
        {
            r = mode;
            if (TunerAnimIsAuto(l)) l = TangentMode.Free;
        }
        var keep = c[i];
        TunerAnimModes(c, i, l, r, true);
        var k = c[i];
        if (l == TangentMode.Free) k.inTangent = keep.inTangent;
        if (r == TangentMode.Free) k.outTangent = keep.outTangent;
        if (l == TangentMode.Constant) k.inTangent = float.PositiveInfinity;
        if (r == TangentMode.Constant) k.outTangent = float.PositiveInfinity;
        k.inWeight = keep.inWeight;
        k.outWeight = keep.outWeight;
        c.MoveKey(i, k);
    }

    static void TunerAnimApplyEase(AnimationCurve c, int i, float x1, float y1, float x2, float y2)
    {
        if (i < 0 || i >= c.length - 1) return;
        float dt = c[i + 1].time - c[i].time;
        float dv = c[i + 1].value - c[i].value;
        if (dt <= 0f) return;
        TunerAnimSide(c, i, false, TangentMode.Free);
        TunerAnimSide(c, i + 1, true, TangentMode.Free);
        float ow = Mathf.Clamp(x1, 1e-4f, 1f);
        float iw = Mathf.Clamp(1f - x2, 1e-4f, 1f);
        var a = c[i];
        a.outWeight = ow;
        a.outTangent = x1 < 1e-3f && Mathf.Abs(y1) < 1e-3f ? y2 * dv / (Mathf.Max(x2, 1e-3f) * dt) : y1 * dv / (ow * dt);
        a.weightedMode = (WeightedMode)((int)a.weightedMode | (int)WeightedMode.Out);
        c.MoveKey(i, a);
        var b = c[i + 1];
        b.inWeight = iw;
        b.inTangent = 1f - x2 < 1e-3f && Mathf.Abs(1f - y2) < 1e-3f ? (1f - y1) * dv / (Mathf.Max(1f - x1, 1e-3f) * dt) : (1f - y2) * dv / (iw * dt);
        b.weightedMode = (WeightedMode)((int)b.weightedMode | (int)WeightedMode.In);
        c.MoveKey(i + 1, b);
    }

    static void TunerAnimToggleWeight(AnimationCurve c, int i, WeightedMode side, bool on)
    {
        var k = c[i];
        var before = k.weightedMode;
        k.weightedMode = on ? k.weightedMode | side : k.weightedMode & ~side;
        c.MoveKey(i, k);
        if ((side & WeightedMode.Out) != 0 && on && (before & WeightedMode.Out) == 0)
        {
            var r = AnimationUtility.GetKeyRightTangentMode(c, i);
            if (r == TangentMode.Linear || r == TangentMode.Constant) TunerAnimSide(c, i, false, TangentMode.Free);
            k = c[i];
            if (i < c.length - 1) k.outWeight = 1f / 3f;
            c.MoveKey(i, k);
        }
        if ((side & WeightedMode.In) != 0 && on && (before & WeightedMode.In) == 0)
        {
            var l = AnimationUtility.GetKeyLeftTangentMode(c, i);
            if (l == TangentMode.Linear || l == TangentMode.Constant) TunerAnimSide(c, i, true, TangentMode.Free);
            k = c[i];
            if (i > 0) k.inWeight = 1f / 3f;
            c.MoveKey(i, k);
        }
    }

    static void TunerAnimApplyTangent(AnimationCurve c, int i, string mode, bool on)
    {
        switch (mode)
        {
            case "clampedAuto":
            case "auto":
            {
                var m = mode == "auto" ? TangentMode.Auto : TangentMode.ClampedAuto;
                TunerAnimModes(c, i, m, m, false);
                return;
            }
            case "freeSmooth":
            case "flat":
            {
                var k0 = c[i];
                float inT = float.IsInfinity(k0.inTangent) ? 0f : k0.inTangent;
                float outT = float.IsInfinity(k0.outTangent) ? 0f : k0.outTangent;
                float slope = mode == "flat" ? 0f : (inT + outT) * 0.5f;
                TunerAnimModes(c, i, TangentMode.Free, TangentMode.Free, false);
                var k = c[i];
                k.inTangent = slope;
                k.outTangent = slope;
                k.inWeight = k0.inWeight;
                k.outWeight = k0.outWeight;
                c.MoveKey(i, k);
                return;
            }
            case "broken":
                if (!on)
                {
                    TunerAnimApplyTangent(c, i, "freeSmooth", true);
                    return;
                }
                {
                    var keep = c[i];
                    var l = AnimationUtility.GetKeyLeftTangentMode(c, i);
                    var r = AnimationUtility.GetKeyRightTangentMode(c, i);
                    TunerAnimModes(c, i, TunerAnimIsAuto(l) ? TangentMode.Free : l, TunerAnimIsAuto(r) ? TangentMode.Free : r, true);
                    var k = c[i];
                    k.inTangent = keep.inTangent;
                    k.outTangent = keep.outTangent;
                    c.MoveKey(i, k);
                }
                return;
            case "weighted":
                TunerAnimToggleWeight(c, i, WeightedMode.Both, on);
                return;
            case "leftWeighted":
                TunerAnimToggleWeight(c, i, WeightedMode.In, on);
                return;
            case "rightWeighted":
                TunerAnimToggleWeight(c, i, WeightedMode.Out, on);
                return;
        }
        var tm = mode.EndsWith("Linear", StringComparison.Ordinal) ? TangentMode.Linear : mode.EndsWith("Constant", StringComparison.Ordinal) ? TangentMode.Constant : TangentMode.Free;
        if (mode.StartsWith("both", StringComparison.Ordinal))
        {
            var keep = c[i];
            TunerAnimModes(c, i, tm, tm, true);
            var k = c[i];
            if (tm == TangentMode.Free)
            {
                k.inTangent = keep.inTangent;
                k.outTangent = keep.outTangent;
            }
            if (tm == TangentMode.Constant)
            {
                k.inTangent = float.PositiveInfinity;
                k.outTangent = float.PositiveInfinity;
            }
            c.MoveKey(i, k);
            return;
        }
        TunerAnimSide(c, i, mode.StartsWith("left", StringComparison.Ordinal), tm);
    }

    static string TunerAnimSetTangents(TunerAnimEditCtx ctx, IEnumerable<TunerAnimKeyArg> keys, string mode, bool on, bool save = true)
    {
        var clip = ctx.Clip;
        if (Array.IndexOf(TUNER_ANIM_TANGENTS, mode) < 0 && !(mode ?? "").StartsWith("bezier", StringComparison.Ordinal))
            return "tangent mode is one of " + string.Join(", ", TUNER_ANIM_TANGENTS) + " or \"bezier x1 y1 x2 y2\"";
        var map = TunerAnimGroupKeys(clip, ctx.Root, keys, out var err);
        if (err != null) return err;
        if (map.Count == 0) return "no keys given";
        TunerAnimBegin(ctx);
        foreach (var kv in map)
        {
            if (!TunerAnimFindBinding(clip, ctx.Root, kv.Key, out var b) || b.isPPtrCurve) continue;
            var c = AnimationUtility.GetEditorCurve(clip, b);
            if (c == null) continue;
            foreach (var t in kv.Value)
            {
                int i = TunerAnimKeyAt(c, clip, t);
                if (i < 0) continue;
                if (mode == "linear" || mode == "step")
                {
                    var seg = mode == "step" ? TangentMode.Constant : TangentMode.Linear;
                    if (i < c.length - 1)
                    {
                        TunerAnimSide(c, i, false, seg);
                        TunerAnimSide(c, i + 1, true, seg);
                    }
                }
                else if (TunerAnimPreset(mode, out var x1, out var y1, out var x2, out var y2)) TunerAnimApplyEase(c, i, x1, y1, x2, y2);
                else TunerAnimApplyTangent(c, i, mode, on);
            }
            TunerAnimSave(c, clip, b);
        }
        TunerAnimDone(clip, save);
        return null;
    }

    static string TunerAnimSetRaw(TunerAnimEditCtx ctx, IEnumerable<TunerAnimKeyArg> keys, bool save)
    {
        var clip = ctx.Clip;
        var list = (keys ?? new TunerAnimKeyArg[0]).Where(k => k != null).ToList();
        if (list.Count == 0) return "no keys given";
        TunerAnimBegin(ctx);
        foreach (var k in list)
        {
            var id = TunerAnimKeyId(clip, ctx.Root, k);
            if (id == null || !TunerAnimFindBinding(clip, ctx.Root, id, out var b) || b.isPPtrCurve) return "no property for key " + (k.id ?? k.prop);
            var c = AnimationUtility.GetEditorCurve(clip, b);
            float t = k.frame >= 0 ? k.frame / TunerAnimFps(clip) : k.t;
            int i = TunerAnimKeyAt(c, clip, t);
            if (i < 0) return "no key at f" + TunerAnimFrame(clip, t) + " on " + id;
            if (k.hasTan) TunerAnimModes(c, i, (TangentMode)Mathf.Clamp(k.lm, 0, 4), (TangentMode)Mathf.Clamp(k.rm, 0, 4), k.broken);
            var key = c[i];
            if (k.hasV) key.value = k.v;
            if (k.hasTan)
            {
                key.inTangent = k.inT;
                key.outTangent = k.outT;
                key.inWeight = Mathf.Clamp(k.inW, 0f, 1f);
                key.outWeight = Mathf.Clamp(k.outW, 0f, 1f);
                key.weightedMode = (WeightedMode)Mathf.Clamp(k.wm, 0, 3);
            }
            c.MoveKey(i, key);
            TunerAnimSave(c, clip, b);
        }
        TunerAnimDone(clip, save);
        return null;
    }

    static UnityEngine.Object TunerAssetRef(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return null;
        int hash = raw.LastIndexOf('#');
        if (hash > 0 && long.TryParse(raw.Substring(hash + 1), NumberStyles.Integer, CultureInfo.InvariantCulture, out long lid))
        {
            var path = raw.Substring(0, hash);
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
                if (o != null && AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out _, out long id) && id == lid) return o;
            return null;
        }
        return AssetDatabase.LoadMainAssetAtPath(raw);
    }

    static string TunerAssetRefOf(UnityEngine.Object o)
    {
        if (o == null) return "";
        var path = AssetDatabase.GetAssetPath(o);
        if (string.IsNullOrEmpty(path) || AssetDatabase.IsMainAsset(o)) return path;
        return AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out _, out long lid) ? path + "#" + lid.ToString(CultureInfo.InvariantCulture) : path;
    }

    static AnimationEvent[] TunerAnimEvents(AnimationClip clip) => AnimationUtility.GetAnimationEvents(clip) ?? new AnimationEvent[0];

    static void TunerAnimFillEvent(AnimationEvent e, TunerAnimEventArg a, AnimationClip clip)
    {
        if (a.fn != null) e.functionName = a.fn;
        e.floatParameter = a.f;
        e.intParameter = a.i;
        e.stringParameter = a.s ?? "";
        e.objectReferenceParameter = string.IsNullOrEmpty(a.o) ? null : TunerAssetRef(a.o);
    }

    static string TunerAnimEventOp(TunerAnimEditCtx ctx, string op, int index, double time, TunerAnimEventArg ev, int[] indices)
    {
        var clip = ctx.Clip;
        var list = TunerAnimEvents(clip).ToList();
        switch (op)
        {
            case "addEvent":
            {
                var e = new AnimationEvent { time = TunerAnimSnap(clip, time), functionName = "" };
                if (ev != null) TunerAnimFillEvent(e, ev, clip);
                list.Add(e);
                break;
            }
            case "moveEvent":
                if (index < 0 || index >= list.Count) return "no event #" + index;
                list[index].time = TunerAnimSnap(clip, time);
                break;
            case "editEvent":
                if (index < 0 || index >= list.Count) return "no event #" + index;
                if (ev == null) return "editEvent needs ev";
                TunerAnimFillEvent(list[index], ev, clip);
                break;
            case "deleteEvent":
            {
                var drop = new HashSet<int>(indices ?? new int[0]);
                if (index >= 0) drop.Add(index);
                if (drop.Count == 0 || drop.Any(i => i < 0 || i >= list.Count)) return "no such event";
                list = list.Where((e, i) => !drop.Contains(i)).ToList();
                break;
            }
            default:
                return "unknown event op " + op;
        }
        TunerAnimBegin(ctx);
        AnimationUtility.SetAnimationEvents(clip, list.OrderBy(e => e.time).ToArray());
        TunerAnimDone(clip, true);
        return null;
    }

    static string TunerAnimSettings(TunerAnimEditCtx ctx, float length, float frameRate, int loop)
    {
        var clip = ctx.Clip;
        if (frameRate > 1000f) return "frame rate is 1..1000";
        var curves = new List<(EditorCurveBinding b, AnimationCurve c)>();
        float last = 0f;
        foreach (var b in AnimationUtility.GetCurveBindings(clip))
        {
            var c = AnimationUtility.GetEditorCurve(clip, b);
            if (c == null || c.length == 0) continue;
            last = Mathf.Max(last, c[c.length - 1].time);
            curves.Add((b, c));
        }
        float target = length >= 0f ? TunerAnimSnap(clip, length) : -1f;
        if (target >= 0f)
        {
            if (target + 0.5f / TunerAnimFps(clip) < last) return "keys go up to " + last.ToString("0.###", CultureInfo.InvariantCulture) + " s: move or delete them before making the clip shorter";
            if (curves.Count == 0 && target > 0f) return "the clip has no properties yet: add one, then set its length";
        }
        TunerAnimBegin(ctx);
        if (frameRate > 0f) clip.frameRate = frameRate;
        if (loop >= 0)
        {
            var st = AnimationUtility.GetAnimationClipSettings(clip);
            st.loopTime = loop > 0;
            AnimationUtility.SetAnimationClipSettings(clip, st);
        }
        if (target > last + 0.5f / TunerAnimFps(clip))
            foreach (var (b, c) in curves)
            {
                var type = TunerAnimValueType(ctx.Root, b);
                TunerAnimPutKey(c, clip, target, c.Evaluate(c[c.length - 1].time), type);
                TunerAnimSave(c, clip, b);
            }
        TunerAnimDone(clip, true);
        return null;
    }

    static string TunerAnimFolderFor(GameObject root, List<AnimationClip> existing)
    {
        foreach (var c in existing ?? new List<AnimationClip>())
        {
            var p = c != null ? AssetDatabase.GetAssetPath(c) : null;
            if (!string.IsNullOrEmpty(p) && p.EndsWith(".anim", StringComparison.OrdinalIgnoreCase) && p.StartsWith("Assets/", StringComparison.Ordinal))
                return Path.GetDirectoryName(p).Replace('\\', '/');
        }
        var safe = new string((root != null ? root.name : "Clips").Select(ch => char.IsLetterOrDigit(ch) || ch == '_' || ch == '-' || ch == ' ' ? ch : '_').ToArray()).Trim();
        var scene = root != null ? root.scene.path : null;
        if (!string.IsNullOrEmpty(scene) && scene.StartsWith("Assets/", StringComparison.Ordinal) && root.scene.IsValid())
            return Path.GetDirectoryName(scene).Replace('\\', '/') + "/" + (safe.Length > 0 ? safe : "Clips");
        return TUNER_ANIM_DIR + "/" + (safe.Length > 0 ? safe : "Clips");
    }

    static void TunerAnimEnsureFolder(string folder)
    {
        if (AssetDatabase.IsValidFolder(folder)) return;
        var parent = Path.GetDirectoryName(folder).Replace('\\', '/');
        TunerAnimEnsureFolder(parent);
        AssetDatabase.CreateFolder(parent, Path.GetFileName(folder));
    }

    static readonly List<string> _tunerAnimNewAssets = new List<string>();


    static AnimatorController TunerAnimBaseController(Animator a)
    {
        var rac = a != null ? a.runtimeAnimatorController : null;
        if (rac is AnimatorController ac) return ac;
        if (rac is AnimatorOverrideController aoc) return aoc.runtimeAnimatorController as AnimatorController;
        return null;
    }

    static string TunerAnimCreateClip(GameObject target, string name, out AnimationClip made)
    {
        made = null;
        if (target == null) return "select an object first";
        if (EditorApplication.isPlaying) return "create clips in Edit Mode";
        var owner = TunerAnimOwnerOf(target);
        var root = owner != null ? owner.Root : target;
        var folder = TunerAnimFolderFor(root, owner != null ? TunerAnimClips(owner) : null);
        var clipName = string.IsNullOrWhiteSpace(name) ? root.name + " Clip" : name.Trim();
        if (clipName.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0 || clipName.Length > 120) return "invalid clip name " + clipName;
        if (owner != null && owner.Kind == TunerAnimKind.Animator && owner.Animator.runtimeAnimatorController is AnimatorOverrideController && TunerAnimBaseController(owner.Animator) == null)
            return "this Animator uses an Override Controller without a base controller";
        TunerAnimEnsureFolder(folder);
        var path = AssetDatabase.GenerateUniqueAssetPath(folder + "/" + clipName + ".anim");
        var clip = new AnimationClip { frameRate = 60f };
        var st = AnimationUtility.GetAnimationClipSettings(clip);
        st.loopTime = true;
        AnimationUtility.SetAnimationClipSettings(clip, st);
        if (owner != null && owner.Kind == TunerAnimKind.Legacy) clip.legacy = true;
        AssetDatabase.CreateAsset(clip, path);
        _tunerAnimNewAssets.Add(path);
        made = clip;
        if (owner == null)
        {
            var ctrlPath = AssetDatabase.GenerateUniqueAssetPath(folder + "/" + root.name + ".controller");
            var ac = AnimatorController.CreateAnimatorControllerAtPathWithClip(ctrlPath, clip);
            _tunerAnimNewAssets.Add(ctrlPath);
            var an = target.GetComponent<Animator>();
            if (an == null) an = Undo.AddComponent<Animator>(target);
            else Undo.RecordObject(an, "Create clip");
            an.runtimeAnimatorController = ac;
            EditorUtility.SetDirty(target);
            Debug.Log("[Tuner] animator: created " + path + " and an Animator with " + ctrlPath + " on " + TunerObjectPath(target));
        }
        else if (owner.Kind == TunerAnimKind.Animator)
        {
            var ac = TunerAnimBaseController(owner.Animator);
            if (ac == null) return "the Animator's controller is not an Animator Controller";
            var sm = ac.layers[0].stateMachine;
            var state = sm.AddState(sm.MakeUniqueStateName(clip.name));
            state.motion = clip;
            EditorUtility.SetDirty(ac);
            TunerSaveAsset(ac);
            Debug.Log("[Tuner] animator: created " + path + " as state " + state.name + " of " + AssetDatabase.GetAssetPath(ac));
        }
        else
        {
            var anim = owner.Legacy;
            anim.AddClip(clip, clip.name);
            if (anim.clip == null) anim.clip = clip;
            EditorUtility.SetDirty(anim);
            Debug.Log("[Tuner] animator: created " + path + " on the Animation of " + TunerObjectPath(owner.Root));
        }
        TunerSaveAsset(clip);
        if (!EditorApplication.isPlaying) MarkTunerSceneDirty(root);
        _tunerAnimatable.Remove(root);
        return null;
    }

    static string TunerAnimDuplicate(TunerAnimOwner owner, AnimationClip src, out AnimationClip made)
    {
        made = null;
        if (owner == null || src == null) return "nothing to duplicate";
        var folder = TunerAnimFolderFor(owner.Root, TunerAnimClips(owner));
        TunerAnimEnsureFolder(folder);
        var path = AssetDatabase.GenerateUniqueAssetPath(folder + "/" + src.name + ".anim");
        var copy = UnityEngine.Object.Instantiate(src);
        copy.name = Path.GetFileNameWithoutExtension(path);
        copy.hideFlags = HideFlags.None;
        AssetDatabase.CreateAsset(copy, path);
        _tunerAnimNewAssets.Add(path);
        made = copy;
        switch (owner.Kind)
        {
            case TunerAnimKind.Animator:
            {
                var rac = owner.Animator.runtimeAnimatorController;
                if (rac is AnimatorOverrideController aoc)
                {
                    var pairs = new List<KeyValuePair<AnimationClip, AnimationClip>>();
                    aoc.GetOverrides(pairs);
                    for (int i = 0; i < pairs.Count; i++)
                        if ((pairs[i].Value != null ? pairs[i].Value : pairs[i].Key) == src) pairs[i] = new KeyValuePair<AnimationClip, AnimationClip>(pairs[i].Key, copy);
                    aoc.ApplyOverrides(pairs);
                    EditorUtility.SetDirty(aoc);
                    TunerSaveAsset(aoc);
                }
                else if (rac is AnimatorController ac)
                {
                    foreach (var layer in ac.layers) TunerAnimSwapMotion(layer.stateMachine, src, copy);
                    EditorUtility.SetDirty(ac);
                    TunerSaveAsset(ac);
                }
                break;
            }
            case TunerAnimKind.Legacy:
            {
                var anim = owner.Legacy;
                AnimationUtility.SetAnimationClips(anim, AnimationUtility.GetAnimationClips(owner.Root).Select(c => c == src ? copy : c).ToArray());
                if (anim.clip == src) anim.clip = copy;
                EditorUtility.SetDirty(anim);
                if (!EditorApplication.isPlaying) MarkTunerSceneDirty(owner.Root);
                break;
            }
        }
        Debug.Log("[Tuner] animator: duplicated read-only clip " + src.name + " as " + path);
        return null;
    }

    static void TunerAnimSwapMotion(AnimatorStateMachine sm, Motion from, Motion to)
    {
        foreach (var cs in sm.states)
            if (cs.state != null && cs.state.motion == from) cs.state.motion = to;
        foreach (var sub in sm.stateMachines) TunerAnimSwapMotion(sub.stateMachine, from, to);
    }

    static Vector3 TunerAnimClosestEuler(Quaternion q, Vector3 hint)
    {
        var e = q.eulerAngles;
        var alt = new Vector3(180f - e.x, e.y + 180f, e.z + 180f);
        Vector3 best = Vector3.zero;
        float bestD = float.MaxValue;
        foreach (var cand in new[] { e, alt })
        {
            var v = new Vector3(TunerAnimNear(cand.x, hint.x), TunerAnimNear(cand.y, hint.y), TunerAnimNear(cand.z, hint.z));
            float d = (v - hint).sqrMagnitude;
            if (d < bestD)
            {
                bestD = d;
                best = v;
            }
        }
        return best;
    }

    static float TunerAnimNear(float a, float target)
    {
        return a + Mathf.Round((target - a) / 360f) * 360f;
    }
}
