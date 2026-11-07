using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using TangentMode = UnityEditor.AnimationUtility.TangentMode;

public static partial class MCPTestBridge
{
    static string TunerAnimObjectName(GameObject root, string path)
    {
        if (string.IsNullOrEmpty(path)) return root != null ? root.name : "";
        int slash = path.LastIndexOf('/');
        return slash >= 0 ? path.Substring(slash + 1) : path;
    }

    static string TunerAnimComponentLabel(Type t)
    {
        if (t == null) return "?";
        if (t == typeof(GameObject)) return "GameObject";
        return ObjectNames.NicifyVariableName(t.Name);
    }

    static string TunerAnimGroupLabel(Type type, string group)
    {
        if (type == typeof(Transform) || type == typeof(RectTransform))
        {
            if (group == "m_LocalPosition") return "Position";
            if (group == "m_LocalScale") return "Scale";
            if (group.StartsWith("localEulerAngles", StringComparison.Ordinal) || group == "m_LocalRotation") return "Rotation";
        }
        if (group.StartsWith("material.", StringComparison.Ordinal))
            return "Material " + ObjectNames.NicifyVariableName(group.Substring(9).TrimStart('_'));
        group = System.Text.RegularExpressions.Regex.Replace(group, @"\.Array\.data\[(\d+)\]", " $1");
        return string.Join(" ", group.Split('.').Select(p => ObjectNames.NicifyVariableName(p)));
    }

    static string TunerAnimFloat(float v)
    {
        if (float.IsNaN(v) || float.IsInfinity(v)) return "null";
        return v.ToString("R", Inv);
    }

    static void AppendTunerAnimKey(StringBuilder sb, AnimationCurve c, int i)
    {
        var k = c[i];
        sb.Append('[').Append(TunerAnimFloat(k.time))
          .Append(',').Append(TunerAnimFloat(k.value))
          .Append(',').Append(TunerAnimFloat(k.inTangent))
          .Append(',').Append(TunerAnimFloat(k.outTangent))
          .Append(',').Append(TunerAnimFloat(k.inWeight))
          .Append(',').Append(TunerAnimFloat(k.outWeight))
          .Append(',').Append(((int)k.weightedMode).ToString(Inv))
          .Append(',').Append(((int)AnimationUtility.GetKeyLeftTangentMode(c, i)).ToString(Inv))
          .Append(',').Append(((int)AnimationUtility.GetKeyRightTangentMode(c, i)).ToString(Inv))
          .Append(',').Append(AnimationUtility.GetKeyBroken(c, i) ? '1' : '0')
          .Append(']');
    }

    sealed class TunerAnimPropLayout
    {
        public string Meta;
        public readonly List<(string id, string meta, EditorCurveBinding b)> Channels = new List<(string, string, EditorCurveBinding)>();
    }

    sealed class TunerAnimClipCache
    {
        public AnimationClip Clip;
        public int Dirty = -1;
        public int Rev = -1;
        public int Edits = -1;
        public int Seq;
        public string Head;
        public string Struct;
        public bool HeadChanged;
        public double BuildMs;
        public int Keys;
        public readonly List<TunerAnimPropLayout> Props = new List<TunerAnimPropLayout>();
        public readonly Dictionary<string, string> KeyJson = new Dictionary<string, string>();
        public readonly Dictionary<string, AnimationCurve> Curves = new Dictionary<string, AnimationCurve>();
        public readonly HashSet<string> Changed = new HashSet<string>();
    }

    static readonly Dictionary<AnimationClip, HashSet<string>> _tunerCurveTouched = new Dictionary<AnimationClip, HashSet<string>>();

    static void NoteTunerCurveTouched(AnimationClip clip, EditorCurveBinding binding, AnimationUtility.CurveModifiedType type)
    {
        if (clip == null) return;
        bool open = false;
        foreach (var st in _tunerAnims.Values)
            if (st.Cache.Clip == clip)
            {
                open = true;
                break;
            }
        if (!open) return;
        if (type == AnimationUtility.CurveModifiedType.ClipModified || string.IsNullOrEmpty(binding.propertyName))
        {
            _tunerCurveTouched[clip] = null;
            return;
        }
        if (_tunerCurveTouched.TryGetValue(clip, out var set) && set == null) return;
        if (set == null) _tunerCurveTouched[clip] = set = new HashSet<string>();
        set.Add(TunerAnimId(binding));
    }

    static string TunerAnimClipHead(AnimationClip clip)
    {
        var sb = new StringBuilder(256);
        var settings = AnimationUtility.GetAnimationClipSettings(clip);
        var ro = TunerAnimReadOnly(clip);
        sb.Append("\"name\":").Append(JStr(clip.name))
          .Append(",\"path\":").Append(JStr(AssetDatabase.GetAssetPath(clip)))
          .Append(",\"readOnly\":").Append(ro != null ? "true" : "false")
          .Append(",\"length\":").Append(TunerAnimFloat(clip.length))
          .Append(",\"frameRate\":").Append(TunerAnimFloat(TunerAnimFps(clip)))
          .Append(",\"loop\":").Append(settings.loopTime ? "true" : "false")
          .Append(",\"legacy\":").Append(clip.legacy ? "true" : "false")
          .Append(",\"human\":").Append(clip.humanMotion ? "true" : "false")
          .Append(",\"events\":[");
        var evs = TunerAnimEvents(clip);
        for (int i = 0; i < evs.Length; i++)
        {
            var e = evs[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"t\":").Append(TunerAnimFloat(e.time))
              .Append(",\"fn\":").Append(JStr(e.functionName ?? ""))
              .Append(",\"f\":").Append(TunerAnimFloat(e.floatParameter))
              .Append(",\"i\":").Append(e.intParameter.ToString(Inv))
              .Append(",\"s\":").Append(JStr(e.stringParameter ?? ""))
              .Append(",\"o\":").Append(JStr(TunerAssetRefOf(e.objectReferenceParameter)))
              .Append(",\"oName\":").Append(JStr(e.objectReferenceParameter != null ? e.objectReferenceParameter.name : ""))
              .Append('}');
        }
        sb.Append(']');
        return sb.ToString();
    }

    static void BuildTunerClipLayout(TunerAnimClipCache cc, AnimationClip clip, GameObject root)
    {
        cc.Props.Clear();
        var groups = new List<(string key, string path, Type type, string group, string section, string label, int order, List<EditorCurveBinding> list)>();
        var index = new Dictionary<string, int>();
        foreach (var b in TunerAnimClipBindings(clip))
        {
            if (b.type == typeof(Transform) && b.propertyName.StartsWith("m_LocalEulerAnglesHint", StringComparison.Ordinal)) continue;
            var g = TunerAnimGroupOf(b.propertyName, out _);
            var key = b.path + "|" + (b.type != null ? b.type.FullName : "") + "|" + g;
            if (!index.TryGetValue(key, out var at))
            {
                string section = "", label;
                int order = 0;
                if (TunerHumanBinding(b) && clip.humanMotion) section = TunerHumanSection(g, out label, out order);
                else label = TunerAnimGroupLabel(b.type, g);
                groups.Add((key, b.path, b.type, g, section, label, order, new List<EditorCurveBinding>()));
                at = groups.Count - 1;
                index[key] = at;
            }
            groups[at].list.Add(b);
        }
        groups.Sort((x, y) =>
        {
            int c = string.CompareOrdinal(x.path, y.path);
            if (c != 0) return c;
            c = TunerAnimTypeOrder(x.type).CompareTo(TunerAnimTypeOrder(y.type));
            if (c != 0) return c;
            c = string.CompareOrdinal(x.type != null ? x.type.Name : "", y.type != null ? y.type.Name : "");
            if (c != 0) return c;
            if (x.section.Length > 0 || y.section.Length > 0)
            {
                c = TunerHumanSectionOrder(x.section).CompareTo(TunerHumanSectionOrder(y.section));
                if (c != 0) return c;
                c = x.order.CompareTo(y.order);
                if (c != 0) return c;
            }
            return TunerAnimGroupOrder(x.group).CompareTo(TunerAnimGroupOrder(y.group)) is int o && o != 0 ? o : string.CompareOrdinal(x.group, y.group);
        });
        var sig = new StringBuilder();
        foreach (var g in groups)
        {
            bool pptr = g.list[0].isPPtrCurve;
            bool missing = root == null || g.type == null || AnimationUtility.GetEditorCurveValueType(root, g.list[0]) == null;
            var layout = new TunerAnimPropLayout();
            var sb = new StringBuilder(256);
            sb.Append("{\"id\":").Append(JStr(g.key))
              .Append(",\"path\":").Append(JStr(g.path))
              .Append(",\"object\":").Append(JStr(TunerAnimObjectName(root, g.path)))
              .Append(",\"type\":").Append(JStr(g.type != null ? g.type.FullName : ""))
              .Append(",\"component\":").Append(JStr(TunerAnimComponentLabel(g.type)))
              .Append(",\"group\":").Append(JStr(g.group))
              .Append(",\"label\":").Append(JStr(g.label))
              .Append(",\"section\":").Append(JStr(g.section))
              .Append(",\"pptr\":").Append(pptr ? "true" : "false")
              .Append(",\"missing\":").Append(missing ? "true" : "false")
              .Append(",\"channels\":[");
            layout.Meta = sb.ToString();
            sig.Append(g.key).Append(missing ? "!" : "").Append('\n');
            foreach (var b in g.list.OrderBy(b => "xyzwrgba".IndexOf(b.propertyName[b.propertyName.Length - 1])))
            {
                TunerAnimGroupOf(b.propertyName, out var ch);
                var id = TunerAnimId(b);
                var meta = "{\"id\":" + JStr(id) + ",\"prop\":" + JStr(b.propertyName) + ",\"label\":" + JStr(ch) + ",\"discrete\":" + (b.isDiscreteCurve ? "true" : "false") + ",\"keys\":";
                layout.Channels.Add((id, meta, b));
                sig.Append(' ').Append(id).Append('\n');
            }
            cc.Props.Add(layout);
        }
        cc.Struct = sig.ToString();
    }

    static string TunerAnimKeysJson(AnimationClip clip, EditorCurveBinding b, out int count, out AnimationCurve curve)
    {
        var sb = new StringBuilder(64);
        sb.Append('[');
        count = 0;
        curve = null;
        if (b.isPPtrCurve)
        {
            var oc = AnimationUtility.GetObjectReferenceCurve(clip, b) ?? new ObjectReferenceKeyframe[0];
            for (int k = 0; k < oc.Length; k++)
            {
                if (k > 0) sb.Append(',');
                sb.Append('[').Append(TunerAnimFloat(oc[k].time)).Append(",0,0,0,0,0,0,3,3,1,").Append(JStr(oc[k].value != null ? oc[k].value.name : "None")).Append(']');
            }
            count = oc.Length;
        }
        else
        {
            var c = AnimationUtility.GetEditorCurve(clip, b);
            curve = c;
            if (c != null)
            {
                for (int k = 0; k < c.length; k++)
                {
                    if (k > 0) sb.Append(',');
                    AppendTunerAnimKey(sb, c, k);
                }
                count = c.length;
            }
        }
        return sb.Append(']').ToString();
    }

    static TunerAnimClipCache RefreshTunerClipCache(TunerAnimState st) => RefreshTunerClipCache(st, st.Cache, st.Clip);

    static TunerAnimClipCache RefreshTunerClipCache(TunerAnimState st, TunerAnimClipCache cc, AnimationClip clip)
    {
        var root = st.Owner != null ? st.Owner.Root : null;
        int dirty = EditorUtility.GetDirtyCount(clip);
        bool fresh = cc.Clip != clip;
        if (!fresh && cc.Dirty == dirty && cc.Rev == st.Rev && cc.Edits == _tunerCurveEdits) return cc;
        var sw = System.Diagnostics.Stopwatch.StartNew();
        HashSet<string> touched = null;
        bool partial = false;
        if (!fresh && _tunerCurveTouched.TryGetValue(clip, out var set))
        {
            touched = set;
            partial = set != null;
        }
        _tunerCurveTouched.Remove(clip);
        if (fresh)
        {
            cc.KeyJson.Clear();
            cc.Curves.Clear();
            cc.Changed.Clear();
            cc.Head = null;
        }
        cc.Clip = clip;
        cc.Dirty = dirty;
        cc.Rev = st.Rev;
        cc.Edits = _tunerCurveEdits;
        var oldStruct = cc.Struct;
        BuildTunerClipLayout(cc, clip, root);
        var head = TunerAnimClipHead(clip);
        bool changed = fresh || oldStruct != cc.Struct;
        if (head != cc.Head)
        {
            cc.Head = head;
            cc.HeadChanged = true;
            changed = true;
        }
        var live = new HashSet<string>();
        int keys = 0;
        foreach (var p in cc.Props)
            foreach (var ch in p.Channels)
            {
                live.Add(ch.id);
                if (partial && !touched.Contains(ch.id) && cc.KeyJson.ContainsKey(ch.id)) continue;
                var k = TunerAnimKeysJson(clip, ch.b, out var n, out var curve);
                keys += n;
                if (curve != null) cc.Curves[ch.id] = curve;
                else cc.Curves.Remove(ch.id);
                if (cc.KeyJson.TryGetValue(ch.id, out var old) && old == k) continue;
                cc.KeyJson[ch.id] = k;
                cc.Changed.Add(ch.id);
                changed = true;
            }
        foreach (var id in cc.KeyJson.Keys.Where(k => !live.Contains(k)).ToList())
        {
            cc.KeyJson.Remove(id);
            cc.Curves.Remove(id);
            cc.Changed.Remove(id);
        }
        if (changed) cc.Seq++;
        cc.BuildMs = sw.Elapsed.TotalMilliseconds;
        if (!partial) cc.Keys = keys;
        if (fresh && cc.BuildMs > 5) SaturaDebug.Log("[Tuner] animator model for " + clip.name + ": " + cc.Props.Sum(p => p.Channels.Count) + " curves, " + keys + " keys built in " + cc.BuildMs.ToString("0.#", Inv) + " ms");
        return cc;
    }

    static void AppendTunerClipFull(StringBuilder sb, TunerAnimClipCache cc)
    {
        sb.Append('{').Append(cc.Head).Append(",\"props\":[");
        for (int i = 0; i < cc.Props.Count; i++)
        {
            var p = cc.Props[i];
            if (i > 0) sb.Append(',');
            sb.Append(p.Meta);
            for (int j = 0; j < p.Channels.Count; j++)
            {
                var ch = p.Channels[j];
                if (j > 0) sb.Append(',');
                sb.Append(ch.meta).Append(cc.KeyJson.TryGetValue(ch.id, out var k) ? k : "[]").Append('}');
            }
            sb.Append("]}");
        }
        sb.Append("]}");
    }

    static bool TunerAnimValue(TunerAnimState st, EditorCurveBinding b, out float v)
    {
        if (b.type == typeof(Animator) && st.Clip != null && st.Clip.humanMotion)
        {
            AnimationCurve c = null;
            if (st.Cache.Clip == st.Clip) st.Cache.Curves.TryGetValue(TunerAnimId(b), out c);
            else c = AnimationUtility.GetEditorCurve(st.Clip, b);
            if (c != null && c.length > 0)
            {
                v = c.Evaluate((float)st.Time);
                return true;
            }
        }
        return TunerAnimCurrent(st.Owner.Root, b, out v);
    }

    static int TunerAnimTypeOrder(Type t)
    {
        if (t == typeof(GameObject)) return 0;
        if (t == typeof(Transform) || t == typeof(RectTransform)) return 1;
        return 2;
    }

    static int TunerAnimGroupOrder(string g)
    {
        if (g == "m_LocalPosition") return 0;
        if (g.StartsWith("localEulerAngles", StringComparison.Ordinal) || g == "m_LocalRotation") return 1;
        if (g == "m_LocalScale") return 2;
        return 3;
    }

    static string TunerAnimJson(TunerAnimState st, bool playing)
    {
        var sb = new StringBuilder(2048);
        sb.Append("{\"mode\":").Append(playing ? "\"play\"" : "\"edit\"");
        var o = st.Owner;
        if (o != null && o.Root != null)
        {
            string ctrl = "";
            if (o.Kind == TunerAnimKind.Animator && o.Animator.runtimeAnimatorController != null) ctrl = AssetDatabase.GetAssetPath(o.Animator.runtimeAnimatorController);
            string note = "";
            if (o.Kind == TunerAnimKind.Animator && o.Animator.runtimeAnimatorController is AnimatorOverrideController) note = "override";
            sb.Append(",\"owner\":{\"path\":").Append(JStr(TunerObjectPath(o.Root)))
              .Append(",\"name\":").Append(JStr(o.Root.name))
              .Append(",\"kind\":").Append(o.Kind == TunerAnimKind.Animator ? "\"animator\"" : "\"legacy\"")
              .Append(",\"controller\":").Append(JStr(ctrl))
              .Append(",\"note\":").Append(JStr(note))
              .Append(",\"human\":").Append(TunerHuman(o) ? "true" : "false")
              .Append('}');
            sb.Append(",\"clips\":[");
            var clips = TunerAnimClips(o);
            var states = TunerAnimStates(o);
            for (int i = 0; i < clips.Count; i++)
            {
                var c = clips[i];
                if (i > 0) sb.Append(',');
                string state = states.TryGetValue(c, out var names) ? string.Join(", ", names) : "";
                sb.Append("{\"name\":").Append(JStr(c.name))
                  .Append(",\"path\":").Append(JStr(AssetDatabase.GetAssetPath(c)))
                  .Append(",\"readOnly\":").Append(TunerAnimReadOnly(c) != null ? "true" : "false")
                  .Append(",\"state\":").Append(JStr(state))
                  .Append('}');
            }
            sb.Append(']');
        }
        else sb.Append(",\"owner\":null,\"clips\":[]");
        if (st.Target != null) sb.Append(",\"target\":{\"path\":").Append(JStr(TunerObjectPath(st.Target))).Append(",\"name\":").Append(JStr(st.Target.name)).Append('}');
        else sb.Append(",\"target\":null");
        bool fullModel = false;
        if (st.Clip != null && o != null && o.Root != null)
        {
            var cc = RefreshTunerClipCache(st);
            bool full = !st.SentAny || st.SentClip != st.Clip || st.SentStruct != cc.Struct || st.SentSeq < 0;
            fullModel = full;
            if (full)
            {
                sb.Append(",\"clip\":");
                AppendTunerClipFull(sb, cc);
                st.FullCount++;
                st.SentValues.Clear();
            }
            else if (st.SentSeq != cc.Seq)
            {
                sb.Append(",\"clipPatch\":{\"base\":").Append(st.SentSeq.ToString(Inv)).Append(",\"seq\":").Append(cc.Seq.ToString(Inv));
                if (cc.HeadChanged) sb.Append(",\"head\":{").Append(cc.Head).Append('}');
                sb.Append(",\"chans\":{");
                bool firstCh = true;
                foreach (var id in cc.Changed)
                {
                    if (!cc.KeyJson.TryGetValue(id, out var k)) continue;
                    if (!firstCh) sb.Append(',');
                    firstCh = false;
                    sb.Append(JStr(id)).Append(':').Append(k);
                }
                sb.Append("}}");
                st.PatchCount++;
            }
            sb.Append(",\"clipSeq\":").Append(cc.Seq.ToString(Inv));
            st.SentAny = true;
            st.SentClip = st.Clip;
            st.SentStruct = cc.Struct;
            st.SentSeq = cc.Seq;
            cc.Changed.Clear();
            cc.HeadChanged = false;
            sb.Append(",\"values\":{");
            bool first = true;
            foreach (var p in cc.Props)
                foreach (var ch in p.Channels)
                {
                    if (ch.b.isPPtrCurve) continue;
                    if (!TunerAnimValue(st, ch.b, out var v)) continue;
                    if (!full && st.SentValues.TryGetValue(ch.id, out var old) && (old == v || (float.IsNaN(old) && float.IsNaN(v)))) continue;
                    st.SentValues[ch.id] = v;
                    if (!first) sb.Append(',');
                    first = false;
                    sb.Append(JStr(ch.id)).Append(':').Append(TunerAnimFloat(v));
                }
            sb.Append("},\"valuesFull\":").Append(full ? "true" : "false");
            sb.Append(",\"pending\":{");
            first = true;
            foreach (var kv in st.Pending)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append(JStr(kv.Key)).Append(':').Append(TunerAnimFloat(kv.Value));
            }
            sb.Append('}');
            sb.Append(",\"methods\":").Append(TunerAnimMethodsJson(st));
        }
        else
        {
            sb.Append(",\"clip\":null,\"clipSeq\":-1");
            st.SentAny = true;
            st.SentClip = null;
            st.SentSeq = -1;
            st.SentValues.Clear();
        }
        if (TunerHuman(o) && o.Root != null)
            sb.Append(",\"rootMotion\":{\"on\":").Append(TunerRootMotionOn(st) ? "true" : "false")
              .Append(",\"mode\":").Append(st.RootMotion < 0 ? "\"auto\"" : st.RootMotion > 0 ? "\"on\"" : "\"off\"")
              .Append(",\"animator\":").Append(o.Animator.applyRootMotion ? "true" : "false").Append('}');
        sb.Append(",\"time\":").Append(Num(st.Time))
          .Append(",\"preview\":").Append(st.Preview ? "true" : "false")
          .Append(",\"playing\":").Append((playing ? st.Live && st.Hold == null && o != null : st.Playing) ? "true" : "false")
          .Append(",\"record\":").Append(st.Record ? "true" : "false")
          .Append(",\"locked\":").Append(st.Locked ? "true" : "false")
          .Append(",\"live\":").Append(st.Live && st.Hold == null ? "true" : "false")
          .Append(",\"takenOver\":").Append(st.Hold != null ? "true" : "false")
          .Append(",\"status\":").Append(JStr(st.Status ?? ""))
          .Append(",\"error\":").Append(JStr(st.Error ?? ""))
          .Append(",\"rev\":").Append(st.Rev.ToString(Inv))
          .Append('}');
        return sb.ToString();
    }

    static string TunerAnimMethodsJson(TunerAnimState st)
    {
        var root = st.Owner != null ? st.Owner.Root : null;
        if (root == null) return "[]";
        int count = root.GetComponents<MonoBehaviour>().Length;
        if (st.MethodsFor == root && st.MethodsGen == _tunerHierarchyGen && st.MethodsCount == count) return st.MethodsJson;
        var seen = new HashSet<string>();
        var sb = new StringBuilder("[");
        foreach (var mb in root.GetComponents<MonoBehaviour>())
        {
            if (mb == null) continue;
            var ns = mb.GetType().Namespace ?? "";
            if (ns == "SaturaSpace" || ns.StartsWith("SaturaSpace.", StringComparison.Ordinal)) continue;
            for (var t = mb.GetType(); t != null && t != typeof(MonoBehaviour) && t != typeof(Behaviour); t = t.BaseType)
                foreach (var m in t.GetMethods(BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly))
                {
                    if (m.IsSpecialName || m.IsGenericMethod || m.ReturnType != typeof(void)) continue;
                    var ps = m.GetParameters();
                    if (ps.Length > 1) continue;
                    string kind = "none";
                    if (ps.Length == 1)
                    {
                        var pt = ps[0].ParameterType;
                        if (pt == typeof(float)) kind = "float";
                        else if (pt == typeof(int) || pt.IsEnum) kind = "int";
                        else if (pt == typeof(string)) kind = "string";
                        else if (pt == typeof(AnimationEvent)) kind = "event";
                        else if (typeof(UnityEngine.Object).IsAssignableFrom(pt)) kind = "object";
                        else continue;
                    }
                    if (m.Name.StartsWith("<", StringComparison.Ordinal) || TunerAnimUnityMessages.Contains(m.Name) || !seen.Add(m.Name + "/" + kind)) continue;
                    if (sb.Length > 1) sb.Append(',');
                    sb.Append("{\"name\":").Append(JStr(m.Name)).Append(",\"param\":\"").Append(kind).Append("\",\"component\":").Append(JStr(mb.GetType().Name));
                    if (kind == "object") sb.Append(",\"otype\":").Append(JStr(ps[0].ParameterType.FullName));
                    sb.Append('}');
                }
        }
        sb.Append(']');
        st.MethodsJson = sb.ToString();
        st.MethodsFor = root;
        st.MethodsGen = _tunerHierarchyGen;
        st.MethodsCount = count;
        return st.MethodsJson;
    }


    static readonly HashSet<string> TunerAnimUnityMessages = new HashSet<string>
    {
        "Awake", "Start", "Update", "LateUpdate", "FixedUpdate", "OnEnable", "OnDisable", "OnDestroy", "OnValidate", "Reset",
        "OnGUI", "OnDrawGizmos", "OnDrawGizmosSelected", "OnApplicationQuit", "OnApplicationPause", "OnApplicationFocus",
        "OnBecameVisible", "OnBecameInvisible", "OnAnimatorMove", "OnAnimatorIK", "OnTransformParentChanged", "OnTransformChildrenChanged"
    };

    static string TunerAnimPropsJson(TunerAnimState st)
    {
        var root = st.Owner != null ? st.Owner.Root : null;
        if (root == null) return "[]";
        var animated = new HashSet<string>();
        foreach (var b in TunerAnimClipBindings(st.Clip))
        {
            var g = TunerAnimGroupOf(b.propertyName, out _);
            if (b.type == typeof(Transform) && g.StartsWith("localEulerAngles", StringComparison.Ordinal)) g = "localEulerAnglesRaw";
            animated.Add(b.path + "|" + b.type.FullName + "|" + g);
        }
        var groups = new List<(string path, Type type, string group, List<string> ids)>();
        foreach (var b in TunerAnimAnimatable(root))
        {
            if (b.type == null) continue;
            string g = TunerAnimGroupOf(b.propertyName, out var ch);
            string id = TunerAnimId(b);
            if (b.type == typeof(Transform))
            {
                if (g == "m_LocalEulerAnglesHint") continue;
                if (g == "m_LocalRotation")
                {
                    if (ch == "w") continue;
                    g = "localEulerAnglesRaw";
                    id = b.path + "|" + b.type.FullName + "|localEulerAnglesRaw." + ch;
                }
            }
            int at = groups.FindIndex(x => x.path == b.path && x.type == b.type && x.group == g);
            if (at < 0)
            {
                groups.Add((b.path, b.type, g, new List<string>()));
                at = groups.Count - 1;
            }
            if (!groups[at].ids.Contains(id)) groups[at].ids.Add(id);
        }
        var sb = new StringBuilder("[");
        int n = 0;
        foreach (var g in groups.OrderBy(x => x.path, StringComparer.Ordinal).ThenBy(x => TunerAnimTypeOrder(x.type)).ThenBy(x => x.type.Name, StringComparer.Ordinal).ThenBy(x => TunerAnimGroupOrder(x.group)).ThenBy(x => x.group, StringComparer.Ordinal))
        {
            if (n++ > 0) sb.Append(',');
            var key = g.path + "|" + g.type.FullName + "|" + g.group;
            sb.Append("{\"id\":").Append(JStr(key))
              .Append(",\"path\":").Append(JStr(g.path))
              .Append(",\"object\":").Append(JStr(TunerAnimObjectName(root, g.path)))
              .Append(",\"component\":").Append(JStr(TunerAnimComponentLabel(g.type)))
              .Append(",\"label\":").Append(JStr(TunerAnimGroupLabel(g.type, g.group)))
              .Append(",\"animated\":").Append(animated.Contains(key) ? "true" : "false")
              .Append(",\"ids\":[").Append(string.Join(",", g.ids.Select(JStr))).Append("]}");
        }
        sb.Append(']');
        return sb.ToString();
    }
}
