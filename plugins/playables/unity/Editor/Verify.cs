using System;
using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.LowLevel;
using UnityEngine.SceneManagement;

namespace SaturaSpace.Playables
{
    [Serializable]
    public class VerifyStep
    {
        public string kind = "tap";
        public float[] from;
        public float[] to;
        public string target;
        public int frames = 12;
    }

    [Serializable]
    public class VerifyRun
    {
        public string scene;
        public string scenePath;
        public int seed;
        public VerifyStep[] steps = Array.Empty<VerifyStep>();
    }

    [Serializable]
    public class VerifyProbe
    {
        public string type;
        public string[] members = Array.Empty<string>();
        public bool inactive;
    }

    [Serializable]
    public class VerifySettle
    {
        public string type;
        public string member;
        public string equals;
        public int frames = 2;
    }

    [Serializable]
    public class VerifyScript
    {
        public VerifyRun[] runs = Array.Empty<VerifyRun>();
        public VerifyProbe[] probes = Array.Empty<VerifyProbe>();
        public VerifySettle[] settle = Array.Empty<VerifySettle>();
        public int settleMax = 600;
        public int finalWait = 360;
        public int fps = 60;
        public float deadline = 600;
    }

    public class ScriptedInput : BaseInput
    {
        public Vector2 position;
        public bool held;
        public bool pressed;
        public bool released;

        public override bool mousePresent => true;
        public override bool touchSupported => false;
        public override int touchCount => 0;
        public override Vector2 mousePosition => position;
        public override Vector2 mouseScrollDelta => Vector2.zero;
        public override bool GetMouseButton(int button) => button == 0 && held;
        public override bool GetMouseButtonDown(int button) => button == 0 && pressed;
        public override bool GetMouseButtonUp(int button) => button == 0 && released;
        public override float GetAxisRaw(string axisName) => 0f;
        public override bool GetButtonDown(string buttonName) => false;
        public override string compositionString => "";
    }

    public class VerifyDriver
    {
        private enum Phase
        {
            Load,
            Settle,
            Act,
            Final,
            Done
        }

        private struct Pointer
        {
            public Vector3 world;
            public string target;
            public bool down;
        }

        public VerifyScript script;
        public string outPath;
        private Phase _phase = Phase.Load;
        private int _run = -1;
        private int _step;
        private int _frame;
        private int _calm;
        private int _waited;
        private bool _loaded;
        private bool _wasDown;
        private readonly Queue<Pointer?> _timeline = new Queue<Pointer?>();
        private Pointer _last;
        private ScriptedInput _input;
        private List<object> _states;
        private readonly List<object> _runs = new List<object>();
        private readonly List<object> _log = new List<object>();
        private double _deadline;

        private struct LoopMarker
        {
        }

        public void Begin()
        {
            Application.runInBackground = true;
            Hook(true);
            Time.captureDeltaTime = 1f / Mathf.Max(1, script.fps);
            _deadline = EditorApplication.timeSinceStartup + script.deadline;
            SceneManager.sceneLoaded += OnLoaded;
            NextRun();
        }

        internal static void Detach()
        {
            Hook(null);
        }

        private void Hook(bool on)
        {
            Hook(on ? this : null);
            if (!on) SceneManager.sceneLoaded -= OnLoaded;
        }

        private static void Hook(VerifyDriver driver)
        {
            PlayerLoopSystem root = PlayerLoop.GetCurrentPlayerLoop();
            for (int i = 0; i < root.subSystemList.Length; i++)
            {
                if (root.subSystemList[i].type != typeof(UnityEngine.PlayerLoop.Update)) continue;
                var list = new List<PlayerLoopSystem>(root.subSystemList[i].subSystemList ?? Array.Empty<PlayerLoopSystem>());
                list.RemoveAll(s => s.type == typeof(LoopMarker));
                if (driver != null) list.Insert(0, new PlayerLoopSystem {type = typeof(LoopMarker), updateDelegate = driver.Update});
                root.subSystemList[i].subSystemList = list.ToArray();
            }

            PlayerLoop.SetPlayerLoop(root);
        }

        private void OnLoaded(Scene scene, LoadSceneMode mode)
        {
            if (_run < 0 || _run >= script.runs.Length) return;
            UnityEngine.Random.InitState(script.runs[_run].seed);
            _loaded = true;
        }

        private void NextRun()
        {
            _run++;
            if (_run >= script.runs.Length)
            {
                Finish(0, null);
                return;
            }

            VerifyRun run = script.runs[_run];
            _states = new List<object>();
            _loaded = false;
            _step = 0;
            _frame = 0;
            _phase = Phase.Load;
            _timeline.Clear();
            EditorSceneManager.LoadSceneInPlayMode(run.scenePath, new LoadSceneParameters(LoadSceneMode.Single));
        }

        private void Update()
        {
            if (_phase == Phase.Done) return;
            try
            {
                Tick();
            }
            catch (Exception e)
            {
                Finish(1, e.ToString());
            }
        }

        private void Tick()
        {
            if (EditorApplication.timeSinceStartup > _deadline)
            {
                Finish(3, "deadline passed in run " + _run + " step " + _step);
                return;
            }

            if (_phase == Phase.Load)
            {
                if (!_loaded) return;
                _frame = 0;
                _calm = 0;
                _waited = 0;
                _phase = Phase.Settle;
                EnsureInput();
            }

            _frame++;
            if (_input == null) EnsureInput();
            if (_input != null)
            {
                _input.pressed = false;
                _input.released = false;
            }

            if (_phase == Phase.Settle)
            {
                _waited++;
                _calm = Settled() ? _calm + 1 : 0;
                int need = SettleFrames();
                if (_calm < need && _waited < script.settleMax) return;
                Snapshot(_waited >= script.settleMax && _calm < need);
                VerifyRun run = script.runs[_run];
                if (_step >= run.steps.Length)
                {
                    _phase = Phase.Final;
                    _waited = 0;
                    return;
                }

                Expand(run.steps[_step]);
                _step++;
                _phase = Phase.Act;
            }

            if (_phase == Phase.Act)
            {
                if (_timeline.Count == 0)
                {
                    _phase = Phase.Settle;
                    _calm = 0;
                    _waited = 0;
                    return;
                }

                Pointer? next = _timeline.Dequeue();
                if (next.HasValue) Apply(next.Value);
                return;
            }

            if (_phase == Phase.Final)
            {
                _waited++;
                if (_waited < script.finalWait) return;
                Snapshot(false);
                _runs.Add(new Node
                {
                    ["scene"] = script.runs[_run].scene,
                    ["seed"] = script.runs[_run].seed,
                    ["states"] = _states
                });
                NextRun();
            }
        }

        private void EnsureInput()
        {
            EventSystem system = EventSystem.current != null ? EventSystem.current : UnityEngine.Object.FindAnyObjectByType<EventSystem>();
            if (system == null) return;
            var module = system.GetComponent<StandaloneInputModule>();
            foreach (BaseInputModule other in system.GetComponents<BaseInputModule>())
            {
                if (other != module) other.enabled = false;
            }

            if (module == null) module = system.gameObject.AddComponent<StandaloneInputModule>();
            module.enabled = true;
            _input = system.GetComponent<ScriptedInput>();
            if (_input == null) _input = system.gameObject.AddComponent<ScriptedInput>();
            module.inputOverride = _input;
            _input.held = false;
            _wasDown = false;
        }

        private static Vector3 Vec(float[] v)
        {
            if (v == null || v.Length == 0) return Vector3.zero;
            return new Vector3(v[0], v.Length > 1 ? v[1] : 0f, v.Length > 2 ? v[2] : 0f);
        }

        private void Expand(VerifyStep step)
        {
            int frames = Mathf.Max(1, step.frames);
            string kind = (step.kind ?? "tap").ToLowerInvariant();
            if (kind == "wait")
            {
                for (int i = 0; i < frames; i++) _timeline.Enqueue(null);
                return;
            }

            var from = new Pointer {world = Vec(step.from), target = step.target, down = false};
            if (kind == "move")
            {
                _timeline.Enqueue(from);
                return;
            }

            _timeline.Enqueue(from);
            from.down = true;
            _timeline.Enqueue(from);
            if (kind == "drag")
            {
                Vector3 a = Vec(step.from);
                Vector3 b = Vec(step.to);
                for (int i = 1; i <= frames; i++) _timeline.Enqueue(new Pointer {world = Vector3.Lerp(a, b, (float) i / frames), down = true});
                _timeline.Enqueue(new Pointer {world = b, down = false});
            }
            else if (kind == "hold")
            {
                for (int i = 0; i < frames; i++) _timeline.Enqueue(from);
                from.down = false;
                _timeline.Enqueue(from);
            }
            else
            {
                from.down = false;
                _timeline.Enqueue(from);
            }
        }

        private void Apply(Pointer pointer)
        {
            if (_input == null) return;
            _input.position = ScreenOf(pointer);
            _input.pressed = pointer.down && !_wasDown;
            _input.released = !pointer.down && _wasDown;
            _input.held = pointer.down;
            _wasDown = pointer.down;
            _last = pointer;
            _log.Add(new Node {["run"] = _run, ["frame"] = _frame, ["x"] = Round(_input.position.x), ["y"] = Round(_input.position.y), ["down"] = pointer.down});
        }

        private static Vector2 ScreenOf(Pointer pointer)
        {
            if (!string.IsNullOrEmpty(pointer.target))
            {
                GameObject go = FindPath(pointer.target);
                if (go != null)
                {
                    if (go.transform is RectTransform rect)
                    {
                        Canvas canvas = go.GetComponentInParent<Canvas>();
                        Camera cam = canvas != null && canvas.rootCanvas.renderMode != RenderMode.ScreenSpaceOverlay ? canvas.rootCanvas.worldCamera : null;
                        return RectTransformUtility.WorldToScreenPoint(cam, rect.TransformPoint(rect.rect.center));
                    }

                    if (Camera.main != null) return Camera.main.WorldToScreenPoint(go.transform.position);
                }
            }

            if (Camera.main == null) return Vector2.zero;
            return Camera.main.WorldToScreenPoint(pointer.world);
        }

        internal static GameObject FindPath(string path)
        {
            string[] parts = path.Split('/');
            for (int s = 0; s < SceneManager.sceneCount; s++)
            {
                foreach (GameObject root in SceneManager.GetSceneAt(s).GetRootGameObjects())
                {
                    if (root.name != parts[0]) continue;
                    Transform current = root.transform;
                    for (int i = 1; i < parts.Length && current != null; i++) current = current.Find(parts[i]);
                    if (current != null) return current.gameObject;
                }
            }

            return null;
        }

        private bool Settled()
        {
            foreach (VerifySettle settle in script.settle ?? Array.Empty<VerifySettle>())
            {
                if (settle == null || string.IsNullOrEmpty(settle.type)) continue;
                Type type = Probes.FindType(settle.type);
                if (type == null) continue;
                foreach (UnityEngine.Object obj in Probes.SceneObjects(type, FindObjectsInactive.Exclude))
                {
                    object value = Probes.Member(obj, settle.member);
                    string text = value == null ? "null" : Convert.ToString(value, CultureInfo.InvariantCulture);
                    if (!string.Equals(text, settle.equals, StringComparison.OrdinalIgnoreCase)) return false;
                }
            }

            return true;
        }

        private int SettleFrames()
        {
            int need = 1;
            foreach (VerifySettle settle in script.settle ?? Array.Empty<VerifySettle>())
            {
                if (settle != null && !string.IsNullOrEmpty(settle.type)) need = Mathf.Max(need, settle.frames);
            }

            return need;
        }

        private void Snapshot(bool timedOut)
        {
            var state = new Node {["step"] = _step, ["frame"] = _frame, ["probes"] = Probes.Capture(script.probes)};
            if (timedOut) state["settleTimeout"] = true;
            _states.Add(state);
        }

        private static double Round(float v)
        {
            return Math.Round(v, 2);
        }

        private void Finish(int code, string error)
        {
            _phase = Phase.Done;
            Hook(false);
            Time.captureDeltaTime = 0;
            var root = new Node
            {
                ["side"] = "unity",
                ["unityVersion"] = Application.unityVersion,
                ["exit"] = code,
                ["error"] = error,
                ["rng"] = Probes.RngCheck(),
                ["runs"] = _runs,
                ["input"] = _log
            };
            Directory.CreateDirectory(Path.GetDirectoryName(outPath));
            File.WriteAllText(outPath + ".part", JsonOut.Write(root));
            if (File.Exists(outPath)) File.Delete(outPath);
            File.Move(outPath + ".part", outPath);
            Debug.Log("[Playables] verify finished code " + code + " runs " + _runs.Count + (error != null ? " " + error : ""));
            Verify.Done();
        }
    }

    public static class Probes
    {
        private const BindingFlags Members = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        private static readonly Dictionary<string, Type> Types = new Dictionary<string, Type>();

        public static UnityEngine.Object[] SceneObjects(Type type, FindObjectsInactive inactive)
        {
#if UNITY_6000_6_OR_NEWER
            return UnityEngine.Object.FindObjectsByType(type, inactive);
#else
            return UnityEngine.Object.FindObjectsByType(type, inactive, FindObjectsSortMode.None);
#endif
        }

        public static Type FindType(string name)
        {
            if (string.IsNullOrEmpty(name)) return null;
            if (Types.TryGetValue(name, out Type cached)) return cached;
            Type found = null;
            foreach (Assembly assembly in AppDomain.CurrentDomain.GetAssemblies())
            {
                found = assembly.GetType(name, false);
                if (found != null) break;
            }

            Types[name] = found;
            return found;
        }

        public static object Member(object target, string path)
        {
            object current = target;
            foreach (string part in (path ?? "").Split('.'))
            {
                if (current == null) return null;
                if (current is UnityEngine.Object u && u == null) return null;
                if (part.Length == 0) continue;
                current = One(current, part);
            }

            return current;
        }

        private static object One(object target, string name)
        {
            if (name == "length" || name == "Count")
            {
                if (target is Array array) return array.Length;
                if (target is ICollection collection) return collection.Count;
            }

            for (Type type = target.GetType(); type != null; type = type.BaseType)
            {
                FieldInfo field = type.GetField(name, Members);
                if (field != null) return field.GetValue(target);
                PropertyInfo property = type.GetProperty(name, Members);
                if (property != null && property.GetIndexParameters().Length == 0) return property.GetValue(target);
            }

            return null;
        }

        public static object Value(object value, int depth = 0)
        {
            switch (value)
            {
                case null:
                    return null;
                case UnityEngine.Object u when u == null:
                    return null;
                case string s:
                    return s;
                case bool b:
                    return b;
                case Enum e:
                    return Convert.ToInt64(e, CultureInfo.InvariantCulture);
                case float f:
                    return Math.Round(f, 3);
                case double d:
                    return Math.Round(d, 3);
                case int or long or short or byte or uint or ulong or ushort or sbyte:
                    return Convert.ToInt64(value, CultureInfo.InvariantCulture);
                case Vector2 v2:
                    return new List<object> {Math.Round(v2.x, 3), Math.Round(v2.y, 3)};
                case Vector3 v3:
                    return new List<object> {Math.Round(v3.x, 3), Math.Round(v3.y, 3), Math.Round(v3.z, 3)};
                case Vector4 v4:
                    return new List<object> {Math.Round(v4.x, 3), Math.Round(v4.y, 3), Math.Round(v4.z, 3), Math.Round(v4.w, 3)};
                case Vector2Int i2:
                    return new List<object> {(long) i2.x, (long) i2.y};
                case Vector3Int i3:
                    return new List<object> {(long) i3.x, (long) i3.y, (long) i3.z};
                case Quaternion q:
                    Vector3 euler = q.eulerAngles;
                    return new List<object> {Math.Round(euler.x, 2), Math.Round(euler.y, 2), Math.Round(euler.z, 2)};
                case Color c:
                    return new List<object> {Math.Round(c.r, 3), Math.Round(c.g, 3), Math.Round(c.b, 3), Math.Round(c.a, 3)};
                case GameObject go:
                    return go.name;
                case Component component:
                    return component.gameObject.name;
                case UnityEngine.Object o:
                    return o.name;
                case IEnumerable list when depth < 2:
                    var items = new List<object>();
                    foreach (object item in list)
                    {
                        if (items.Count >= 256) break;
                        items.Add(Value(item, depth + 1));
                    }

                    return items;
                default:
                    return Convert.ToString(value, CultureInfo.InvariantCulture);
            }
        }

        public static string PathOf(Transform t)
        {
            string path = t.name;
            while (t.parent != null)
            {
                t = t.parent;
                path = t.name + "/" + path;
            }

            return path;
        }

        public static Node Capture(VerifyProbe[] probes)
        {
            var result = new Node();
            foreach (VerifyProbe probe in probes ?? Array.Empty<VerifyProbe>())
            {
                Type type = FindType(probe.type);
                var rows = new List<string>();
                if (type != null)
                {
                    foreach (UnityEngine.Object obj in SceneObjects(type, probe.inactive ? FindObjectsInactive.Include : FindObjectsInactive.Exclude))
                    {
                        var row = new Node();
                        if (obj is Component component) row["path"] = PathOf(component.transform);
                        else if (obj is GameObject go) row["path"] = PathOf(go.transform);
                        foreach (string member in probe.members ?? Array.Empty<string>()) row[member] = Value(Member(obj, member));
                        rows.Add(JsonOut.Write(row));
                    }
                }

                rows.Sort(string.CompareOrdinal);
                result[probe.type] = new Node {["found"] = type != null, ["rows"] = rows};
            }

            return result;
        }

        public static Node RngCheck()
        {
            UnityEngine.Random.State saved = UnityEngine.Random.state;
            UnityEngine.Random.InitState(12345);
            var ints = new List<object>();
            for (int i = 0; i < 16; i++) ints.Add(UnityEngine.Random.Range(0, 6));
            ints.Add(UnityEngine.Random.Range(-5, 5));
            ints.Add(UnityEngine.Random.Range(0, 1000000));
            var floats = new List<object>
            {
                Math.Round(UnityEngine.Random.value, 6),
                Math.Round(UnityEngine.Random.Range(2.5f, 7.5f), 6)
            };
            UnityEngine.Random.state = saved;
            return new Node {["seed"] = 12345, ["ints"] = ints, ["floats"] = floats};
        }
    }

    [InitializeOnLoad]
    public static class Verify
    {
        private const string ActiveKey = "SaturaSpace.Playables.Verify.Active";
        private const string ScriptKey = "SaturaSpace.Playables.Verify.Script";
        private const string OutKey = "SaturaSpace.Playables.Verify.Out";
        private const string StartSceneKey = "SaturaSpace.Playables.Verify.StartScene";

        static Verify()
        {
            EditorApplication.playModeStateChanged += OnPlayMode;
        }

        public static bool Active => SessionState.GetBool(ActiveKey, false);

        public static string Start(string scriptPath, string outPath)
        {
            if (Active) throw new InvalidOperationException("A playable verify run is already going in this editor.");
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("Stop play mode before verifying a playable.");
            var script = JsonUtility.FromJson<VerifyScript>(File.ReadAllText(scriptPath));
            if (script.runs == null || script.runs.Length == 0) throw new ArgumentException("The verify script has no runs.");
            var start = AssetDatabase.LoadAssetAtPath<SceneAsset>(script.runs[0].scenePath);
            if (start == null) throw new ArgumentException("There is no scene at " + script.runs[0].scenePath);
            if (File.Exists(outPath)) File.Delete(outPath);
            SessionState.SetBool(ActiveKey, true);
            SessionState.SetString(ScriptKey, scriptPath);
            SessionState.SetString(OutKey, outPath);
            SessionState.SetString(StartSceneKey, EditorSceneManager.playModeStartScene != null ? AssetDatabase.GetAssetPath(EditorSceneManager.playModeStartScene) : "");
            EditorSceneManager.playModeStartScene = start;
            EditorApplication.EnterPlaymode();
            Debug.Log("[Playables] verify entering play mode with " + script.runs.Length + " runs");
            return "{\"started\":true,\"runs\":" + script.runs.Length + "}";
        }

        public static string Stop()
        {
            bool was = Active;
            SessionState.SetBool(ActiveKey, false);
            if (EditorApplication.isPlaying) EditorApplication.ExitPlaymode();
            RestoreStartScene();
            return "{\"stopped\":" + (was ? "true" : "false") + "}";
        }

        internal static void Done()
        {
            SessionState.SetBool(ActiveKey, false);
            EditorApplication.delayCall += () =>
            {
                if (EditorApplication.isPlaying) EditorApplication.ExitPlaymode();
            };
        }

        private static void RestoreStartScene()
        {
            string path = SessionState.GetString(StartSceneKey, "");
            EditorSceneManager.playModeStartScene = string.IsNullOrEmpty(path) ? null : AssetDatabase.LoadAssetAtPath<SceneAsset>(path);
        }

        private static void OnPlayMode(PlayModeStateChange change)
        {
            if (change == PlayModeStateChange.EnteredEditMode)
            {
                VerifyDriver.Detach();
                if (SessionState.GetString(ScriptKey, "") != "") RestoreStartScene();
                SessionState.EraseString(ScriptKey);
                SessionState.SetBool(ActiveKey, false);
                return;
            }

            if (change != PlayModeStateChange.EnteredPlayMode || !Active) return;
            try
            {
                var script = JsonUtility.FromJson<VerifyScript>(File.ReadAllText(SessionState.GetString(ScriptKey, "")));
                var driver = new VerifyDriver {script = script, outPath = SessionState.GetString(OutKey, "")};
                driver.Begin();
            }
            catch (Exception e)
            {
                Debug.LogError("[Playables] verify could not start: " + e);
                Stop();
            }
        }
    }
}
