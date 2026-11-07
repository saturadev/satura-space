using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using SaturaSpace.Vendor.HarmonyLib;
using UnityEditor;
using UnityEngine;
using UnityEngine.LowLevel;
using LowLevelPlayerLoop = UnityEngine.LowLevel.PlayerLoop;

namespace HotReloadPrototype.Editor {
    public static class WriteTracer {
        const string HarmonyId = "saturaspace.writetracer";
        const string ArmedKey = "SaturaSpace.WriteTracer.Armed";
        const int StackFrameCap = 12;
        const int ReportEventCap = 2000;

        [Serializable]
        public class EventData {
            public long seq;
            public int frame;
            public string phase;
            public string member;
            public string instance;
            public string oldValue;
            public string newValue;
            public string site;
            public string stack;
            public string origin;
            public string affects;
            public bool same;
        }

        [Serializable]
        public class SiteData {
            public string site;
            public string member;
            public int count;
            public int sameCount;
            public long firstSeq;
            public long lastSeq;
        }

        [Serializable]
        public class ReportData {
            public string status;
            public string target;
            public string members;
            public long totalEvents;
            public int bufferedEvents;
            public int drivers;
            public List<EventData> events = new List<EventData>();
            public List<SiteData> sites = new List<SiteData>();
        }

        class PatchInfo {
            public string member;
            public PropertyInfo prop;
        }

        class Sampler {
            public string member;
            public UnityEngine.Object obj;
            public PropertyInfo prop;
            public object last;
            public bool primed;
            public string channel;
            public bool local;
        }

        struct SampleAfterFixedUpdate { }
        struct SampleAfterUpdate { }
        struct SampleAfterAnimation { }
        struct SampleEndOfFrame { }
        struct PhaseBeginFixedUpdate { }
        struct PhaseBeginUpdate { }

        static Harmony harmony;
        static bool active;
        static string targetLabel = "";
        static string memberLabel = "";
        static readonly Dictionary<MethodBase, PatchInfo> patches = new Dictionary<MethodBase, PatchInfo>();
        static readonly HashSet<long> instanceIds = new HashSet<long>();
        static readonly Dictionary<string, SiteData> sites = new Dictionary<string, SiteData>();
        static readonly List<Sampler> samplers = new List<Sampler>();
        static readonly object enteredSentinel = new object();
        static bool transformWrittenSinceSample;
        static bool targetInterpolates;
        static int driverCount;
        static EventData[] ring;
        static long seq;
        static string currentPhase = "startup";
        const string BetweenFrames = "between frames (EarlyUpdate, end-of-frame coroutines)";
        static int suppressDepth;
        static double deadline;
        static bool loopInstalled;
        static bool hooksInstalled;

        public static string Start(GameObject target, string[] members, int maxEvents, float autoStopSeconds, bool includeAncestors) {
            if (target == null) return "TRACE_ERROR: target GameObject is null";
            StopInternal(true);
            targetLabel = HierarchyPath(target.transform);
            memberLabel = string.Join(", ", members ?? Array.Empty<string>());
            ring = new EventData[Mathf.Clamp(maxEvents, 100, 10000)];
            seq = 0;
            harmony = new Harmony(HarmonyId);
            var patched = new List<string>();
            var failed = new List<string>();
            var samplingFallback = new List<string>();
            driverCount = 0;
            targetInterpolates = Interpolates(target);
            foreach (var spec in members ?? Array.Empty<string>())
                ResolveSpec(target, spec.Trim(), includeAncestors, patched, failed, samplingFallback);
            if (patches.Count == 0 && samplers.Count == 0) {
                StopInternal(true);
                return "TRACE_ERROR: nothing traceable. " + string.Join("; ", failed);
            }
            active = true;
            currentPhase = Application.isPlaying ? BetweenFrames : "editor";
            float window = autoStopSeconds > 0 ? autoStopSeconds : 30f;
            deadline = EditorApplication.timeSinceStartup + window;
            InstallHooks();
            SessionState.SetString(ArmedKey, targetLabel);
            var sb = new StringBuilder();
            sb.Append("TRACING ").Append(targetLabel).Append(" [").Append(memberLabel).Append("]: ").Append(DescribePatched(patched)).Append('\n');
            if (failed.Count > 0) sb.Append("not traced: ").Append(string.Join("; ", failed)).Append('\n');
            if (samplingFallback.Count > 0)
                sb.Append("NOTE: Unity also writes ").Append(string.Join(", ", samplingFallback))
                    .Append(" natively (physics, animation), so those writes show as [native] with the player-loop phase, not a C# stack\n");
            if (!includeAncestors && (members ?? Array.Empty<string>()).Any(m => {
                    var s = (m ?? "").Trim();
                    return s == "Transform" || IsWorldTransformMember(s);
                }))
                sb.Append("ancestors excluded (include_ancestors=false): world-space position/rotation/eulerAngles are patched but NOT sampled — parent-driven drift will not be reported; managed writes to them on the target still are\n");
            if (!Application.isPlaying) sb.Append("Edit Mode: entering Play wipes this trace (domain reload); start it in Play Mode\n");
            sb.Append("stops in ").Append(window.ToString("F0", CultureInfo.InvariantCulture)).Append(" s or at unity.traceReport()");
            return sb.ToString();
        }

        public static void Stop() => StopInternal(false);

        public static string ReportJson(bool stop) {
            if (ring == null) {
                string armed = SessionState.GetString(ArmedKey, "");
                if (!string.IsNullOrEmpty(armed)) SessionState.EraseString(ArmedKey);
                return JsonUtility.ToJson(new ReportData { status = string.IsNullOrEmpty(armed) ? "none" : "wiped", target = armed });
            }
            var report = new ReportData {
                status = active && !stop ? "active" : "stopped",
                target = targetLabel,
                members = memberLabel,
                totalEvents = seq,
                drivers = driverCount
            };
            if (stop && active) StopInternal(false);
            var buffered = new List<EventData>();
            foreach (var e in ring)
                if (e != null) buffered.Add(e);
            buffered.Sort((a, b) => a.seq.CompareTo(b.seq));
            report.bufferedEvents = buffered.Count;
            report.events = buffered.Count > ReportEventCap
                ? buffered.GetRange(buffered.Count - ReportEventCap, ReportEventCap)
                : buffered;
            report.sites = sites.Values.OrderByDescending(s => s.count).ToList();
            return JsonUtility.ToJson(report);
        }

        static string DescribePatched(List<string> patched) {
            var transformProps = patched.Count(p => p.StartsWith("Transform.", StringComparison.Ordinal) && p.IndexOf('(') < 0);
            var transformMethods = patched.Where(p => p.StartsWith("Transform.", StringComparison.Ordinal) && p.IndexOf('(') >= 0)
                .Select(p => p.Substring(10, p.IndexOf('(') - 10)).Distinct().ToList();
            var parts = new List<string>();
            if (transformProps > 0 || transformMethods.Count > 0)
                parts.Add("Transform setters (" + transformProps + ") and " + string.Join("/", transformMethods));
            var others = patched.Where(p => !p.StartsWith("Transform.", StringComparison.Ordinal))
                .Select(p => p.IndexOf('(') >= 0 ? p.Substring(0, p.IndexOf('(')) : p).Distinct().ToList();
            if (others.Count > 0) {
                var byComp = others.GroupBy(o => o.Substring(0, Math.Max(0, o.IndexOf('.'))))
                    .Select(g => g.Key + "." + string.Join("/", g.Select(o => o.Substring(o.IndexOf('.') + 1))));
                parts.Add(string.Join(", ", byComp));
            }
            if (driverCount > 0) parts[parts.Count - 1] += " (scripts driving the body)";
            return parts.Count > 0 ? string.Join("; ", parts) : "sampling only";
        }

        static bool Interpolates(GameObject go) {
            foreach (var name in new[] { "Rigidbody", "Rigidbody2D" }) {
                var c = go.GetComponent(name);
                if (c == null) continue;
                var p = c.GetType().GetProperty("interpolation");
                if (p != null && Convert.ToInt32(p.GetValue(c, null)) != 0) return true;
            }
            return false;
        }

        static readonly string[][] Drivers = {
            new[] { "Rigidbody", "position,rotation,linearVelocity,velocity,angularVelocity", "MovePosition,MoveRotation,AddForce,AddRelativeForce,AddForceAtPosition,AddExplosionForce,AddTorque,AddRelativeTorque" },
            new[] { "Rigidbody2D", "position,rotation,linearVelocity,velocity,angularVelocity", "MovePosition,MoveRotation,AddForce,AddRelativeForce,AddForceAtPosition,AddTorque" },
            new[] { "CharacterController", "", "Move,SimpleMove" },
            new[] { "NavMeshAgent", "destination,velocity,nextPosition", "SetDestination,Move,Warp,ResetPath" },
        };

        static void AddDrivers(GameObject target, List<string> patched, List<string> failed) {
            foreach (var d in Drivers) {
                var comp = target.GetComponent(d[0]);
                if (comp == null) continue;
                var type = comp.GetType();
                var ignored = new List<string>();
                int before = patches.Count;
                foreach (var name in d[1].Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries)) {
                    var prop = type.GetProperty(name, BindingFlags.Public | BindingFlags.Instance);
                    if (prop == null || name == "velocity" && type.GetProperty("linearVelocity") != null) continue;
                    AddProperty(comp, d[0] + "." + name, prop, patched, ignored, null, false);
                }
                foreach (var name in d[2].Split(new[] { ',' }, StringSplitOptions.RemoveEmptyEntries))
                    foreach (var m in type.GetMethods(BindingFlags.Public | BindingFlags.Instance).Where(x => x.Name == name))
                        AddMethod(d[0] + "." + name, m, patched, ignored);
                if (patches.Count > before) {
                    driverCount += patches.Count - before;
                    RegisterInstance(comp);
                }
            }
        }

        static bool IsWorldTransformMember(string label) =>
            label == "Transform.position" || label == "Transform.rotation" || label == "Transform.eulerAngles";

        static void ResolveSpec(GameObject target, string spec, bool includeAncestors, List<string> patched, List<string> failed, List<string> samplingFallback) {
            if (string.IsNullOrEmpty(spec)) return;
            if (spec == "Transform") {
                var t = target.transform;
                foreach (var p in new[] { "position", "localPosition", "rotation", "localRotation", "eulerAngles", "localEulerAngles", "localScale" })
                    AddProperty(t, "Transform." + p, typeof(Transform).GetProperty(p), patched, failed, null, false);
                foreach (var p in new[] { "position", "localPosition", "rotation", "localRotation", "localScale" }) {
                    if (!includeAncestors && IsWorldTransformMember("Transform." + p)) continue;
                    samplers.Add(new Sampler {
                        member = "Transform." + p, obj = t, prop = typeof(Transform).GetProperty(p),
                        channel = p == "localScale" ? "scale" : p.IndexOf("osition", StringComparison.Ordinal) >= 0 ? "position" : "rotation",
                        local = p.StartsWith("local", StringComparison.Ordinal)
                    });
                }
                AddDrivers(target, patched, failed);
                foreach (var name in new[] { "SetPositionAndRotation", "SetLocalPositionAndRotation", "SetParent", "LookAt", "Translate", "Rotate", "RotateAround" })
                    foreach (var m in typeof(Transform).GetMethods(BindingFlags.Public | BindingFlags.Instance).Where(x => x.Name == name))
                        AddMethod("Transform." + name, m, patched, failed);
                RegisterInstance(t);
                if (includeAncestors)
                    for (var a = t.parent; a != null; a = a.parent) RegisterInstance(a);
                return;
            }
            int dot = spec.IndexOf('.');
            if (dot <= 0 || dot == spec.Length - 1) {
                failed.Add(spec + " (expected 'Transform' or 'Component.member')");
                return;
            }
            string compName = spec.Substring(0, dot);
            string memberName = spec.Substring(dot + 1);
            UnityEngine.Object inst;
            Type type;
            if (compName == "GameObject") {
                inst = target;
                type = typeof(GameObject);
            } else {
                var comp = target.GetComponent(compName);
                if (comp == null) {
                    failed.Add(spec + " (no such component on target)");
                    return;
                }
                inst = comp;
                type = comp.GetType();
            }
            var prop = type.GetProperty(memberName, BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance);
            if (prop != null) {
                string label = compName + "." + memberName;
                AddProperty(inst, label, prop, patched, failed, samplingFallback,
                    includeAncestors || !IsWorldTransformMember(label));
                RegisterInstance(inst);
                return;
            }
            var methods = type.GetMethods(BindingFlags.Public | BindingFlags.Instance).Where(m => m.Name == memberName).ToArray();
            if (methods.Length == 0) {
                failed.Add(spec + " (no property or method '" + memberName + "' on " + type.Name + ")");
                return;
            }
            bool any = false;
            foreach (var m in methods)
                any |= AddMethod(compName + "." + memberName, m, patched, failed);
            if (any) RegisterInstance(inst);
        }

        static void AddProperty(UnityEngine.Object inst, string label, PropertyInfo prop, List<string> patched, List<string> failed, List<string> samplingFallback, bool sample = true) {
            if (prop == null) {
                failed.Add(label + " (property not found)");
                return;
            }
            if (sample && prop.CanRead)
                samplers.Add(new Sampler { member = label, obj = inst, prop = prop });
            var setter = prop.GetSetMethod(true);
            if (setter == null) {
                failed.Add(label + " (no setter; sampling only)");
                return;
            }
            if (setter.GetMethodBody() == null) {
                failed.Add(label + " (native icall setter; sampling only)");
                return;
            }
            if (PatchOne(setter, label, prop, failed)) {
                patched.Add(label);
                if (samplingFallback != null && IsNativeBacked(setter)) samplingFallback.Add(label);
            }
        }

        static bool IsNativeBacked(MethodInfo setter) {
            if (setter == null) return false;
            if ((setter.GetMethodImplementationFlags() & MethodImplAttributes.InternalCall) != 0) return true;
            var dt = setter.DeclaringType;
            if (dt == null) return false;
            string injected = setter.Name + "_Injected";
            foreach (var m in dt.GetMethods(BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance | BindingFlags.Static))
                if (m.Name == injected) return true;
            return false;
        }

        static bool AddMethod(string label, MethodInfo method, List<string> patched, List<string> failed) {
            if (method == null) {
                failed.Add(label + " (not found in this Unity version)");
                return false;
            }
            if (method.GetMethodBody() == null) {
                failed.Add(label + " (native icall; cannot patch)");
                return false;
            }
            if (!PatchOne(method, label, null, failed)) return false;
            patched.Add(label + FormatSignature(method));
            return true;
        }

        static string FormatSignature(MethodInfo m) {
            var ps = m.GetParameters();
            return ps.Length == 0 ? "()" : "(" + string.Join(",", ps.Select(p => p.ParameterType.Name)) + ")";
        }

        static bool PatchOne(MethodBase method, string label, PropertyInfo prop, List<string> failed) {
            if (patches.ContainsKey(method)) return true;
            try {
                harmony.Patch(method,
                    prefix: new HarmonyMethod(
                        typeof(WriteTracer).GetMethod(nameof(TracePrefix), BindingFlags.NonPublic | BindingFlags.Static)),
                    finalizer: new HarmonyMethod(
                        typeof(WriteTracer).GetMethod(nameof(TraceFinalizer), BindingFlags.NonPublic | BindingFlags.Static)));
                patches[method] = new PatchInfo { member = label, prop = prop };
                return true;
            } catch (Exception e) {
                failed.Add(label + " (" + e.GetType().Name + ": " + FirstLine(e.Message) + ")");
                return false;
            }
        }

        static long InstanceKey(UnityEngine.Object o) {
#if UNITY_6000_5_OR_NEWER
            return unchecked((long)EntityId.ToULong(o.GetEntityId()));
#else
            return o.GetInstanceID();
#endif
        }

        static void RegisterInstance(UnityEngine.Object o) {
            if (o != null) instanceIds.Add(InstanceKey(o));
        }

        static void TracePrefix(object __instance, object[] __args, MethodBase __originalMethod, out object __state) {
            __state = null;
            if (!active || suppressDepth > 0) return;
            try {
                var uo = __instance as UnityEngine.Object;
                if (uo == null || !instanceIds.Contains(InstanceKey(uo))) return;
                if (!patches.TryGetValue(__originalMethod, out var info)) return;
                object rawOld = null;
                string oldVal = "";
                if (info.prop != null && info.prop.CanRead) {
                    try {
                        rawOld = info.prop.GetValue(__instance, null);
                        oldVal = FormatValue(rawOld);
                    } catch { }
                }
                bool same = info.prop != null && rawOld != null
                    && __args != null && __args.Length == 1 && rawOld.Equals(__args[0]);
                var trace = new System.Diagnostics.StackTrace(2, true);
                RenderStack(trace, out var site, out var stack);
                Record(info.member, uo, oldVal, FormatArgs(__args), site, stack, "managed", same, null, EditorPhaseOf(trace));
                suppressDepth++;
                if (uo is Transform) transformWrittenSinceSample = true;
                __state = uo is Transform ? enteredSentinel : ((object)FindSampler(info.member, uo) ?? enteredSentinel);
                if (EditorApplication.timeSinceStartup > deadline) StopInternal(false);
            } catch { }
        }

        static Sampler FindSampler(string member, UnityEngine.Object obj) {
            foreach (var s in samplers)
                if (s.member == member && ReferenceEquals(s.obj, obj)) return s;
            return null;
        }

        static void TraceFinalizer(object __state) {
            if (__state == null) return;
            if (suppressDepth > 0) suppressDepth--;
            var s = __state as Sampler;
            if (s == null || s.obj == null) return;
            try {
                s.last = s.prop.GetValue(s.obj, null);
                s.primed = true;
            } catch { }
        }

        static string EditorPhaseOf(System.Diagnostics.StackTrace st) {
            for (int i = st.FrameCount - 1; i >= 0; i--) {
                var m = st.GetFrame(i).GetMethod();
                if (m == null || m.DeclaringType != typeof(EditorApplication)) continue;
                if (m.Name.IndexOf("CallUpdateFunctions", StringComparison.Ordinal) >= 0) return "EditorApplication.update";
                if (m.Name.IndexOf("CallDelayFunctions", StringComparison.Ordinal) >= 0) return "EditorApplication.delayCall";
            }
            return null;
        }

        static void Record(string member, UnityEngine.Object inst, string oldVal, string newVal, string site, string stack, string origin, bool same = false, string affects = null, string phase = null) {
            seq++;
            var e = new EventData {
                seq = seq,
                frame = Time.frameCount,
                phase = phase ?? currentPhase,
                member = member,
                instance = inst != null ? inst.name : "",
                oldValue = oldVal,
                newValue = newVal,
                site = site,
                stack = stack,
                origin = origin,
                affects = affects ?? "",
                same = same
            };
            ring[(int)((seq - 1) % ring.Length)] = e;
            string key = member + "|" + site;
            if (!sites.TryGetValue(key, out var s)) {
                s = new SiteData { site = site, member = member, firstSeq = seq };
                sites[key] = s;
            }
            s.count++;
            if (same) s.sameCount++;
            s.lastSeq = seq;
        }

        static void RenderStack(System.Diagnostics.StackTrace st, out string site, out string stack) {
            var sb = new StringBuilder();
            site = "";
            string firstFrame = "";
            int taken = 0;
            for (int i = 0; i < st.FrameCount && taken < StackFrameCap; i++) {
                var f = st.GetFrame(i);
                var m = f.GetMethod();
                if (m == null) continue;
                var dt = m.DeclaringType;
                string full = dt != null ? (dt.FullName ?? dt.Name) : "";
                if (dt == typeof(WriteTracer)
                    || full.StartsWith("SaturaSpace.Vendor.", StringComparison.Ordinal)
                    || full.StartsWith("HarmonyLib", StringComparison.Ordinal)
                    || full.StartsWith("MonoMod", StringComparison.Ordinal)
                    || m.Name.IndexOf("_Patch", StringComparison.Ordinal) >= 0) continue;
                string file = f.GetFileName();
                int line = f.GetFileLineNumber();
                string frame = (dt != null ? dt.Name + "." : "") + m.Name
                    + (string.IsNullOrEmpty(file) ? "" : " @ " + System.IO.Path.GetFileName(file) + ":" + line);
                if (firstFrame.Length == 0) firstFrame = frame;
                if (site.Length == 0 && dt != null
                    && !full.StartsWith("UnityEngine", StringComparison.Ordinal)
                    && !full.StartsWith("UnityEditor", StringComparison.Ordinal))
                    site = frame;
                if (taken > 0) sb.Append(" < ");
                sb.Append(frame);
                taken++;
            }
            if (site.Length == 0) site = firstFrame.Length > 0 ? firstFrame : "(unknown)";
            stack = sb.ToString();
        }

        static string FormatValue(object v) {
            if (v == null) return "null";
            switch (v) {
                case Vector3 v3: return v3.ToString("F3");
                case Vector2 v2: return v2.ToString("F3");
                case Vector4 v4: return v4.ToString("F3");
                case Quaternion q: return "euler" + q.eulerAngles.ToString("F2");
                case Transform tr: return tr != null ? HierarchyPath(tr) : "null";
                case UnityEngine.Object o: return o != null ? o.name : "null";
                case float f: return f.ToString("F4", CultureInfo.InvariantCulture);
                case double d: return d.ToString("F4", CultureInfo.InvariantCulture);
                default: return v.ToString();
            }
        }

        static string FormatArgs(object[] args) {
            if (args == null || args.Length == 0) return "";
            if (args.Length == 1) return FormatValue(args[0]);
            return string.Join(", ", args.Select(FormatValue));
        }

        static void InstallHooks() {
            if (!hooksInstalled) {
                EditorApplication.update += EditorTick;
                EditorApplication.playModeStateChanged += OnPlayModeChanged;
                hooksInstalled = true;
            }
            if (Application.isPlaying) InstallLoop();
        }

        static void OnPlayModeChanged(PlayModeStateChange change) {
            if (change == PlayModeStateChange.EnteredPlayMode) InstallLoop();
            else if (change == PlayModeStateChange.ExitingPlayMode) RemoveLoop();
        }

        static void EditorTick() {
            if (!active) return;
            if (EditorApplication.timeSinceStartup > deadline) {
                StopInternal(false);
                return;
            }
            if (Application.isPlaying) return;
            SamplePoint("editor window (inspector, undo, or native tool)", "editor");
        }

        static void MarkFixedUpdate() { if (active) currentPhase = "FixedUpdate"; }
        static void MarkUpdate() { if (active) currentPhase = "Update"; }

        static void SampleFixed() => SamplePoint("physics/FixedUpdate window", "Update");
        static void SampleUpdate() => SamplePoint("Update window", "animation");
        static void SampleAnimation() => SamplePoint("animation window (Animator/Timeline)", "LateUpdate");
        static void SampleEnd() => SamplePoint("late window (LateUpdate/PostLateUpdate/rendering)", BetweenFrames);

        static void SamplePoint(string endedWindow, string nextPhase) {
            if (!active) return;
            try {
                foreach (var s in samplers) {
                    if (s.obj == null || s.channel != null) continue;
                    object cur;
                    try { cur = s.prop.GetValue(s.obj, null); } catch { continue; }
                    if (!s.primed) {
                        s.last = cur;
                        s.primed = true;
                        continue;
                    }
                    if (!Equals(cur, s.last) && FormatValue(cur) != FormatValue(s.last)) {
                        bool suppressed = transformWrittenSinceSample && s.obj is Transform;
                        if (!suppressed)
                            Record(s.member, s.obj, FormatValue(s.last), FormatValue(cur), "[native] " + endedWindow, "", "native");
                        s.last = cur;
                    }
                }
                SampleTransforms(endedWindow);
                transformWrittenSinceSample = false;
                currentPhase = nextPhase;
            } catch { }
        }

        static void SampleTransforms(string endedWindow) {
            UnityEngine.Object obj = null;
            var changed = new List<KeyValuePair<Sampler, object>>();
            foreach (var s in samplers) {
                if (s.channel == null || s.obj == null) continue;
                object cur;
                try { cur = s.prop.GetValue(s.obj, null); } catch { continue; }
                if (!s.primed) {
                    s.last = cur;
                    s.primed = true;
                    continue;
                }
                if (Equals(cur, s.last) || FormatValue(cur) == FormatValue(s.last)) continue;
                if (transformWrittenSinceSample) {
                    s.last = cur;
                    continue;
                }
                obj = s.obj;
                changed.Add(new KeyValuePair<Sampler, object>(s, cur));
            }
            if (changed.Count == 0) return;
            var olds = new List<string>();
            var news = new List<string>();
            var channels = new List<string>();
            foreach (var channel in new[] { "position", "rotation", "scale" }) {
                var world = changed.FirstOrDefault(c => c.Key.channel == channel && !c.Key.local);
                var local = changed.FirstOrDefault(c => c.Key.channel == channel && c.Key.local);
                var pick = world.Key ?? local.Key;
                if (pick == null) continue;
                var cur = world.Key != null ? world.Value : local.Value;
                string label = channel == "scale" ? "localScale"
                    : world.Key == null ? (channel == "position" ? "localPosition" : "localRotation")
                    : channel + (local.Key == null && samplers.Any(x => x.channel == channel && x.local) ? " (parent moved)" : "");
                olds.Add(label + ": " + FormatValue(pick.last));
                news.Add(label + ": " + FormatValue(cur));
                channels.Add(channel);
            }
            foreach (var c in changed) c.Key.last = c.Value;
            string site = endedWindow == "Update window" && targetInterpolates ? "Rigidbody interpolation" : endedWindow;
            Record("Transform", obj, string.Join("; ", olds), string.Join("; ", news), "[native] " + site, "", "native", false, string.Join(",", channels));
        }

        static void InstallLoop() {
            if (loopInstalled) return;
            var loop = LowLevelPlayerLoop.GetCurrentPlayerLoop();
            var roots = new List<PlayerLoopSystem>(loop.subSystemList);
            RemoveFromRoots(roots);
            PrependChild(roots, typeof(UnityEngine.PlayerLoop.FixedUpdate),
                new PlayerLoopSystem { type = typeof(PhaseBeginFixedUpdate), updateDelegate = MarkFixedUpdate });
            PrependChild(roots, typeof(UnityEngine.PlayerLoop.Update),
                new PlayerLoopSystem { type = typeof(PhaseBeginUpdate), updateDelegate = MarkUpdate });
            AppendChild(roots, typeof(UnityEngine.PlayerLoop.FixedUpdate),
                new PlayerLoopSystem { type = typeof(SampleAfterFixedUpdate), updateDelegate = SampleFixed });
            AppendChild(roots, typeof(UnityEngine.PlayerLoop.Update),
                new PlayerLoopSystem { type = typeof(SampleAfterUpdate), updateDelegate = SampleUpdate });
            InsertNearChild(roots, typeof(UnityEngine.PlayerLoop.PreLateUpdate),
                typeof(UnityEngine.PlayerLoop.PreLateUpdate.DirectorUpdateAnimationEnd), true,
                new PlayerLoopSystem { type = typeof(SampleAfterAnimation), updateDelegate = SampleAnimation });
            InsertNearChild(roots, typeof(UnityEngine.PlayerLoop.PostLateUpdate),
                typeof(UnityEngine.PlayerLoop.PostLateUpdate.ProfilerEndFrame), false,
                new PlayerLoopSystem { type = typeof(SampleEndOfFrame), updateDelegate = SampleEnd });
            loop.subSystemList = roots.ToArray();
            LowLevelPlayerLoop.SetPlayerLoop(loop);
            loopInstalled = true;
        }

        static void RemoveLoop() {
            if (!loopInstalled) return;
            var loop = LowLevelPlayerLoop.GetCurrentPlayerLoop();
            var roots = new List<PlayerLoopSystem>(loop.subSystemList);
            if (RemoveFromRoots(roots)) {
                loop.subSystemList = roots.ToArray();
                LowLevelPlayerLoop.SetPlayerLoop(loop);
            }
            loopInstalled = false;
        }

        static bool RemoveFromRoots(List<PlayerLoopSystem> roots) {
            bool IsOurs(PlayerLoopSystem s) =>
                s.type == typeof(SampleAfterFixedUpdate) || s.type == typeof(SampleAfterUpdate)
                || s.type == typeof(SampleAfterAnimation) || s.type == typeof(SampleEndOfFrame)
                || s.type == typeof(PhaseBeginFixedUpdate) || s.type == typeof(PhaseBeginUpdate);
            bool removed = roots.RemoveAll(IsOurs) > 0;
            for (int i = 0; i < roots.Count; i++) {
                var sys = roots[i];
                if (sys.subSystemList == null) continue;
                var children = new List<PlayerLoopSystem>(sys.subSystemList);
                if (children.RemoveAll(IsOurs) == 0) continue;
                sys.subSystemList = children.ToArray();
                roots[i] = sys;
                removed = true;
            }
            return removed;
        }

        static void PrependChild(List<PlayerLoopSystem> roots, Type parent, PlayerLoopSystem sys) {
            int idx = roots.FindIndex(s => s.type == parent);
            if (idx < 0) return;
            var p = roots[idx];
            var children = p.subSystemList != null ? new List<PlayerLoopSystem>(p.subSystemList) : new List<PlayerLoopSystem>();
            children.Insert(0, sys);
            p.subSystemList = children.ToArray();
            roots[idx] = p;
        }

        static void AppendChild(List<PlayerLoopSystem> roots, Type parent, PlayerLoopSystem sys) {
            int idx = roots.FindIndex(s => s.type == parent);
            if (idx < 0) return;
            var p = roots[idx];
            var children = p.subSystemList != null ? new List<PlayerLoopSystem>(p.subSystemList) : new List<PlayerLoopSystem>();
            children.Add(sys);
            p.subSystemList = children.ToArray();
            roots[idx] = p;
        }

        static void InsertNearChild(List<PlayerLoopSystem> roots, Type parent, Type anchor, bool after, PlayerLoopSystem sys) {
            int idx = roots.FindIndex(s => s.type == parent);
            if (idx < 0) return;
            var p = roots[idx];
            var children = p.subSystemList != null ? new List<PlayerLoopSystem>(p.subSystemList) : new List<PlayerLoopSystem>();
            int a = children.FindIndex(s => s.type == anchor);
            if (a < 0) children.Add(sys);
            else children.Insert(after ? a + 1 : a, sys);
            p.subSystemList = children.ToArray();
            roots[idx] = p;
        }

        static void StopInternal(bool clearBuffer) {
            active = false;
            if (harmony != null) {
                try { harmony.UnpatchAll(HarmonyId); } catch { }
                harmony = null;
            }
            patches.Clear();
            RemoveLoop();
            if (hooksInstalled) {
                EditorApplication.update -= EditorTick;
                EditorApplication.playModeStateChanged -= OnPlayModeChanged;
                hooksInstalled = false;
            }
            samplers.Clear();
            instanceIds.Clear();
            transformWrittenSinceSample = false;
            suppressDepth = 0;
            if (clearBuffer) {
                SessionState.EraseString(ArmedKey);
                ring = null;
                seq = 0;
                sites.Clear();
                targetLabel = "";
                memberLabel = "";
            }
        }

        static string HierarchyPath(Transform t) {
            var sb = new StringBuilder(t.name);
            for (var p = t.parent; p != null; p = p.parent) sb.Insert(0, p.name + "/");
            return sb.ToString();
        }

        static string FirstLine(string s) {
            if (string.IsNullOrEmpty(s)) return "";
            int i = s.IndexOf('\n');
            return i < 0 ? s : s.Substring(0, i);
        }
    }
}
