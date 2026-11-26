using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

namespace SaturaSpace.Playables
{
    [Serializable]
    public class ScaleRule
    {
        public string path;
        public float scale = 1f;
    }

    [Serializable]
    public class ExportConfig
    {
        public string[] scenes = Array.Empty<string>();
        public string[] extraSprites = Array.Empty<string>();
        public string[] extraAssets = Array.Empty<string>();
        public int atlasMaxSize = 2048;
        public int atlasPadding = 2;
        public float spriteScale = 1f;
        public ScaleRule[] spriteScales = Array.Empty<ScaleRule>();
        public string[] skipComponents = Array.Empty<string>();
    }

    public sealed class ExportContext
    {
        internal readonly Dictionary<string, List<object>> Tables = new Dictionary<string, List<object>>();
        internal readonly Dictionary<UnityEngine.Object, Node> Done = new Dictionary<UnityEngine.Object, Node>();
        internal readonly List<object> Files = new List<object>();
        internal readonly List<object> Warnings = new List<object>();
        internal Func<UnityEngine.Object, object> Resolve;

        public string OutDir { get; internal set; }
        public string ConfigJson { get; internal set; }
        public ExportConfig Config { get; internal set; }

        public object Ref(UnityEngine.Object obj)
        {
            return Resolve(obj);
        }

        public Node Add(string table, UnityEngine.Object asset, Func<Node> dump)
        {
            if (Done.TryGetValue(asset, out Node existing)) return existing;
            if (!Tables.TryGetValue(table, out List<object> rows))
            {
                rows = new List<object>();
                Tables[table] = rows;
            }

            var reference = new Node {["$a"] = table, ["$i"] = rows.Count};
            Done[asset] = reference;
            rows.Add(null);
            int index = rows.Count - 1;
            rows[index] = dump();
            return reference;
        }

        public string File(string name, byte[] bytes, string kind, string source)
        {
            System.IO.File.WriteAllBytes(Path.Combine(OutDir, name), bytes);
            Files.Add(new Node {["file"] = name, ["bytes"] = bytes.Length, ["kind"] = kind, ["source"] = source});
            return name;
        }

        public void Record(string name, long bytes, string kind, string source)
        {
            Files.Add(new Node {["file"] = name, ["bytes"] = bytes, ["kind"] = kind, ["source"] = source});
        }

        public void Warn(string text)
        {
            if (!Warnings.Contains(text)) Warnings.Add(text);
        }
    }

    public static class ExportRegistry
    {
        internal static readonly List<KeyValuePair<Type, Func<UnityEngine.Object, ExportContext, object>>> Handlers =
            new List<KeyValuePair<Type, Func<UnityEngine.Object, ExportContext, object>>>();

        internal static readonly Dictionary<string, string[]> Props = new Dictionary<string, string[]>();

        public static void Asset(Type type, Func<UnityEngine.Object, ExportContext, object> dump)
        {
            Handlers.RemoveAll(h => h.Key == type);
            Handlers.Add(new KeyValuePair<Type, Func<UnityEngine.Object, ExportContext, object>>(type, dump));
        }

        public static void Component(string typeName, params string[] props)
        {
            Props[typeName] = props;
        }

        internal static Func<UnityEngine.Object, ExportContext, object> Find(Type type)
        {
            for (Type t = type; t != null; t = t.BaseType)
            {
                foreach (var h in Handlers)
                {
                    if (h.Key == t) return h.Value;
                }
            }

            return null;
        }
    }

    public static class Exporter
    {
        private class Unit
        {
            public string key;
            public GameObject[] roots;
            public readonly Dictionary<UnityEngine.Object, int> ids = new Dictionary<UnityEngine.Object, int>();
            public int nextId = 1;
        }

        private static readonly HashSet<string> SkippedProps = new HashSet<string>
        {
            "m_ObjectHideFlags", "m_CorrespondingSourceObject", "m_PrefabInstance", "m_PrefabAsset", "m_PrefabInternal",
            "m_GameObject", "m_Script", "m_Name", "m_EditorHideFlags", "m_EditorClassIdentifier", "m_Children",
            "m_Father", "m_RootOrder", "m_LocalEulerAnglesHint", "m_Enabled", "m_ConstrainProportionsScale"
        };

        private static readonly Dictionary<string, string[]> NativeProps = new Dictionary<string, string[]>
        {
            {"UnityEngine.Transform", new[] {"m_LocalRotation", "m_LocalPosition", "m_LocalScale"}},
            {
                "UnityEngine.RectTransform",
                new[]
                {
                    "m_LocalRotation", "m_LocalPosition", "m_LocalScale", "m_AnchorMin", "m_AnchorMax",
                    "m_AnchoredPosition", "m_SizeDelta", "m_Pivot"
                }
            },
            {
                "UnityEngine.SpriteRenderer",
                new[]
                {
                    "m_Sprite", "m_Color", "m_FlipX", "m_FlipY", "m_SortingLayerID", "m_SortingOrder", "m_DrawMode",
                    "m_Size", "m_MaskInteraction"
                }
            },
            {
                "UnityEngine.Camera",
                new[]
                {
                    "m_ClearFlags", "m_BackGroundColor", "m_NormalizedViewPortRect", "near clip plane",
                    "far clip plane", "field of view", "orthographic", "orthographic size", "m_Depth", "m_CullingMask"
                }
            },
            {"UnityEngine.BoxCollider2D", new[] {"m_IsTrigger", "m_Offset", "m_Size"}},
            {"UnityEngine.CircleCollider2D", new[] {"m_IsTrigger", "m_Offset", "m_Radius"}},
            {"UnityEngine.Animator", new[] {"m_Controller", "m_UpdateMode", "m_CullingMode"}},
            {
                "UnityEngine.Canvas",
                new[] {"m_RenderMode", "m_Camera", "m_PlaneDistance", "m_PixelPerfect", "m_SortingOrder", "m_SortingLayerID"}
            },
            {"UnityEngine.CanvasRenderer", new string[0]},
            {"UnityEngine.CanvasGroup", new[] {"m_Alpha", "m_Interactable", "m_BlocksRaycasts", "m_IgnoreParentGroups"}},
            {"UnityEngine.AudioListener", new string[0]},
            {"UnityEngine.Behaviour", new string[0]}
        };

        private static readonly Dictionary<string, Unit> Prefabs = new Dictionary<string, Unit>();
        private static readonly Queue<Unit> PrefabQueue = new Queue<Unit>();
        private static readonly List<Sprite> Sprites = new List<Sprite>();
        private static readonly Dictionary<Sprite, int> SpriteIndex = new Dictionary<Sprite, int>();
        private static readonly List<AnimationClip> Clips = new List<AnimationClip>();
        private static readonly Dictionary<AnimationClip, int> ClipIndex = new Dictionary<AnimationClip, int>();
        private static readonly List<RuntimeAnimatorController> Controllers = new List<RuntimeAnimatorController>();
        private static readonly Dictionary<RuntimeAnimatorController, int> ControllerIndex = new Dictionary<RuntimeAnimatorController, int>();
        private static readonly List<Font> Fonts = new List<Font>();
        private static readonly Dictionary<Font, int> FontIndex = new Dictionary<Font, int>();
        private static ExportContext _ctx;
        private static HashSet<string> _skip = new HashSet<string>();

        public static void RunBatch()
        {
            try
            {
                string projectRoot = Path.GetDirectoryName(Application.dataPath);
                string configPath = Arg("-playableConfig", Path.Combine(projectRoot, "Playable", "playable.json"));
                string outDir = Arg("-playableOut", Path.Combine(projectRoot, "Playable", "build"));
                string summary = Export(configPath, outDir);
                Debug.Log("[Playables] export " + summary);
            }
            catch (Exception e)
            {
                Debug.LogError("[Playables] export failed: " + e);
                EditorApplication.Exit(1);
            }
        }

        public static string Arg(string name, string fallback)
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
            {
                if (args[i] == name) return args[i + 1];
            }

            return fallback;
        }

        public static string Export(string configPath, string outDir)
        {
            if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("Stop play mode before exporting a playable.");
            string json = File.ReadAllText(configPath);
            var config = JsonUtility.FromJson<ExportConfig>(json);
            if (config.scenes == null || config.scenes.Length == 0) throw new ArgumentException("The playable config lists no scenes.");
            Directory.CreateDirectory(outDir);
            foreach (string old in Directory.GetFiles(outDir)) File.Delete(old);

            Prefabs.Clear();
            PrefabQueue.Clear();
            Sprites.Clear();
            SpriteIndex.Clear();
            Clips.Clear();
            ClipIndex.Clear();
            Controllers.Clear();
            ControllerIndex.Clear();
            Fonts.Clear();
            FontIndex.Clear();
            _skip = new HashSet<string>(config.skipComponents ?? Array.Empty<string>());
            _ctx = new ExportContext {OutDir = outDir, ConfigJson = json, Config = config};
            _ctx.Resolve = obj => Ref(null, obj);

            var scenesNode = new Node();
            var opened = new List<Scene>();
            try
            {
                foreach (string scenePath in config.scenes)
                {
                    Scene scene = SceneManager.GetSceneByPath(scenePath);
                    if (!scene.IsValid() || !scene.isLoaded)
                    {
                        if (AssetDatabase.LoadAssetAtPath<SceneAsset>(scenePath) == null) throw new ArgumentException("There is no scene at " + scenePath);
                        scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Additive);
                        opened.Add(scene);
                    }
                    else if (scene.isDirty)
                    {
                        _ctx.Warn("scene " + scenePath + " has unsaved changes; the export used them");
                    }

                    var unit = new Unit {key = scene.name, roots = scene.GetRootGameObjects()};
                    AssignIds(unit);
                    scenesNode[scene.name] = new Node {["path"] = scenePath, ["roots"] = DumpRoots(unit)};
                }

                var prefabsNode = new Node();
                foreach (string path in config.extraAssets ?? Array.Empty<string>())
                {
                    foreach (UnityEngine.Object asset in AssetDatabase.LoadAllAssetsAtPath(path))
                    {
                        if (asset is GameObject go && go.transform.parent == null) PrefabUnit(path);
                        else if (!(asset is GameObject) && !(asset is Component)) Ref(null, asset);
                    }
                }

                while (PrefabQueue.Count > 0)
                {
                    Unit unit = PrefabQueue.Dequeue();
                    prefabsNode[unit.key] = new Node {["roots"] = DumpRoots(unit)};
                }

                foreach (string path in config.extraSprites ?? Array.Empty<string>())
                {
                    foreach (UnityEngine.Object asset in AssetDatabase.LoadAllAssetsAtPath(path))
                    {
                        if (asset is Sprite sprite) IndexOf(sprite, Sprites, SpriteIndex);
                    }
                }

                var controllersNode = new List<object>();
                for (int i = 0; i < Controllers.Count; i++) controllersNode.Add(DumpController(Controllers[i]));

                var clipsNode = new List<object>();
                for (int i = 0; i < Clips.Count; i++) clipsNode.Add(DumpClip(Clips[i]));

                var fontsNode = new List<object>();
                for (int i = 0; i < Fonts.Count; i++) fontsNode.Add(DumpFont(Fonts[i], i, outDir));

                var atlasesNode = new List<object>();
                List<object> spritesNode = AtlasPacker.Pack(Sprites, config, _ctx, atlasesNode);

                var sortingLayers = new List<object>();
                foreach (SortingLayer layer in SortingLayer.layers)
                {
                    sortingLayers.Add(new Node {["id"] = layer.id, ["name"] = layer.name, ["value"] = layer.value});
                }

                var buildScenes = new List<object>();
                foreach (EditorBuildSettingsScene buildScene in EditorBuildSettings.scenes)
                {
                    if (buildScene.enabled) buildScenes.Add(Path.GetFileNameWithoutExtension(buildScene.path));
                }

                var layers = new List<object>();
                for (int i = 0; i < 32; i++) layers.Add(LayerMask.LayerToName(i));

                var root = new Node
                {
                    ["format"] = 2,
                    ["unityVersion"] = Application.unityVersion,
                    ["product"] = PlayerSettings.productName,
                    ["buildScenes"] = buildScenes,
                    ["sortingLayers"] = sortingLayers,
                    ["layers"] = layers,
                    ["scenes"] = scenesNode,
                    ["prefabs"] = prefabsNode,
                    ["sprites"] = spritesNode,
                    ["atlases"] = atlasesNode,
                    ["clips"] = clipsNode,
                    ["controllers"] = controllersNode,
                    ["fonts"] = fontsNode,
                    ["tables"] = _ctx.Tables.ToDictionary(kv => kv.Key, kv => (object) kv.Value),
                    ["files"] = _ctx.Files,
                    ["warnings"] = _ctx.Warnings
                };

                string text = JsonOut.Write(root);
                File.WriteAllText(Path.Combine(outDir, "scene.json"), text);
                var summary = new Node
                {
                    ["scenes"] = scenesNode.Count,
                    ["prefabs"] = prefabsNode.Count,
                    ["sprites"] = Sprites.Count,
                    ["atlases"] = atlasesNode.Count,
                    ["clips"] = Clips.Count,
                    ["controllers"] = Controllers.Count,
                    ["fonts"] = Fonts.Count,
                    ["tables"] = _ctx.Tables.ToDictionary(kv => kv.Key, kv => (object) kv.Value.Count),
                    ["json"] = text.Length,
                    ["files"] = _ctx.Files,
                    ["warnings"] = _ctx.Warnings
                };
                return JsonOut.Write(summary);
            }
            finally
            {
                foreach (Scene scene in opened)
                {
                    if (scene.IsValid()) EditorSceneManager.CloseScene(scene, true);
                }

                _ctx = null;
            }
        }

        private static void AssignIds(Unit unit)
        {
            foreach (GameObject root in unit.roots) AssignIds(unit, root);
        }

        private static void AssignIds(Unit unit, GameObject go)
        {
            unit.ids[go] = unit.nextId++;
            foreach (Component component in go.GetComponents<Component>())
            {
                if (component != null) unit.ids[component] = unit.nextId++;
            }

            foreach (Transform child in go.transform) AssignIds(unit, child.gameObject);
        }

        private static Unit PrefabUnit(string path)
        {
            if (Prefabs.TryGetValue(path, out Unit unit)) return unit;
            var root = AssetDatabase.LoadAssetAtPath<GameObject>(path);
            unit = new Unit {key = path, roots = new[] {root}};
            AssignIds(unit);
            Prefabs[path] = unit;
            PrefabQueue.Enqueue(unit);
            return unit;
        }

        private static List<object> DumpRoots(Unit unit)
        {
            var list = new List<object>();
            foreach (GameObject root in unit.roots) list.Add(DumpGameObject(unit, root));
            return list;
        }

        private static Node DumpGameObject(Unit unit, GameObject go)
        {
            var node = new Node
            {
                ["id"] = unit.ids[go],
                ["name"] = go.name,
                ["active"] = go.activeSelf,
                ["layer"] = go.layer,
                ["tag"] = go.tag
            };
            var components = new List<object>();
            foreach (Component component in go.GetComponents<Component>())
            {
                if (component == null)
                {
                    _ctx.Warn("missing script on " + go.name);
                    continue;
                }

                if (_skip.Contains(component.GetType().FullName)) continue;
                components.Add(DumpComponent(unit, component));
            }

            node["components"] = components;
            var children = new List<object>();
            foreach (Transform child in go.transform) children.Add(DumpGameObject(unit, child.gameObject));
            node["children"] = children;
            return node;
        }

        private static Node DumpComponent(Unit unit, Component component)
        {
            string typeName = component.GetType().FullName;
            var node = new Node {["id"] = unit.ids[component], ["type"] = typeName};
            if (component is Behaviour behaviour) node["enabled"] = behaviour.enabled;
            else if (component is Renderer renderer) node["enabled"] = renderer.enabled;
            else if (component is Collider collider) node["enabled"] = collider.enabled;

            if (!ExportRegistry.Props.TryGetValue(typeName, out string[] allowed)) NativeProps.TryGetValue(typeName, out allowed);
            node["props"] = DumpSerialized(unit, new SerializedObject(component), allowed);
            return node;
        }

        private static Node DumpSerialized(Unit unit, SerializedObject serialized, string[] allowed)
        {
            var props = new Node();
            SerializedProperty it = serialized.GetIterator();
            bool enter = true;
            while (it.Next(enter))
            {
                enter = false;
                if (SkippedProps.Contains(it.name)) continue;
                if (allowed != null && Array.IndexOf(allowed, it.name) < 0) continue;
                props[it.name] = Convert(unit, it);
            }

            return props;
        }

        private static object Tagged(string tag, params float[] values)
        {
            return new Node {[tag] = values};
        }

        private static object Convert(Unit unit, SerializedProperty p)
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer:
                    return p.longValue;
                case SerializedPropertyType.Boolean:
                    return p.boolValue;
                case SerializedPropertyType.Float:
                    return p.numericType == SerializedPropertyNumericType.Double ? p.doubleValue : (double) p.floatValue;
                case SerializedPropertyType.String:
                    return p.stringValue;
                case SerializedPropertyType.Color:
                    Color c = p.colorValue;
                    return Tagged("$c", c.r, c.g, c.b, c.a);
                case SerializedPropertyType.ObjectReference:
                    return Ref(unit, p.objectReferenceValue);
                case SerializedPropertyType.LayerMask:
                case SerializedPropertyType.Enum:
                case SerializedPropertyType.Character:
                case SerializedPropertyType.ArraySize:
                    return p.intValue;
                case SerializedPropertyType.Vector2:
                    return Tagged("$v", p.vector2Value.x, p.vector2Value.y);
                case SerializedPropertyType.Vector3:
                    return Tagged("$v", p.vector3Value.x, p.vector3Value.y, p.vector3Value.z);
                case SerializedPropertyType.Vector4:
                    return Tagged("$v", p.vector4Value.x, p.vector4Value.y, p.vector4Value.z, p.vector4Value.w);
                case SerializedPropertyType.Vector2Int:
                    return Tagged("$v", p.vector2IntValue.x, p.vector2IntValue.y);
                case SerializedPropertyType.Vector3Int:
                    return Tagged("$v", p.vector3IntValue.x, p.vector3IntValue.y, p.vector3IntValue.z);
                case SerializedPropertyType.Quaternion:
                    Quaternion q = p.quaternionValue;
                    Vector3 euler = q.eulerAngles;
                    return Tagged("$q", q.x, q.y, q.z, q.w, euler.x, euler.y, euler.z);
                case SerializedPropertyType.Rect:
                    Rect r = p.rectValue;
                    return Tagged("$rect", r.x, r.y, r.width, r.height);
                case SerializedPropertyType.Bounds:
                    Bounds b = p.boundsValue;
                    return new Node {["center"] = Tagged("$v", b.center.x, b.center.y, b.center.z), ["extent"] = Tagged("$v", b.extents.x, b.extents.y, b.extents.z)};
                case SerializedPropertyType.AnimationCurve:
                    return new Node {["$curve"] = CurveKeys(p.animationCurveValue)};
                case SerializedPropertyType.Gradient:
                    return null;
                case SerializedPropertyType.ManagedReference:
                    _ctx.Warn("[SerializeReference] field " + p.propertyPath + " exported as null");
                    return null;
                case SerializedPropertyType.Generic:
                    if (p.isArray)
                    {
                        var list = new List<object>();
                        for (int i = 0; i < p.arraySize; i++) list.Add(Convert(unit, p.GetArrayElementAtIndex(i)));
                        return list;
                    }

                    var node = new Node();
                    SerializedProperty child = p.Copy();
                    SerializedProperty end = p.GetEndProperty();
                    if (!child.Next(true)) return node;
                    while (!SerializedProperty.EqualContents(child, end))
                    {
                        node[child.name] = Convert(unit, child);
                        if (!child.Next(false)) break;
                    }

                    return node;
                default:
                    return null;
            }
        }

        private static int IndexOf<T>(T item, List<T> list, Dictionary<T, int> index)
        {
            if (index.TryGetValue(item, out int i)) return i;
            i = list.Count;
            list.Add(item);
            index[item] = i;
            return i;
        }

        private static object Ref(Unit unit, UnityEngine.Object obj)
        {
            if (obj == null) return null;
            if (obj is Sprite sprite) return new Node {["$sprite"] = IndexOf(sprite, Sprites, SpriteIndex)};
            if (obj is AnimationClip clip) return new Node {["$clip"] = IndexOf(clip, Clips, ClipIndex)};
            if (obj is RuntimeAnimatorController controller)
                return new Node {["$ctrl"] = IndexOf(controller, Controllers, ControllerIndex)};
            if (obj is Font font) return new Node {["$font"] = IndexOf(font, Fonts, FontIndex)};
            if (obj is GameObject || obj is Component)
            {
                if (EditorUtility.IsPersistent(obj))
                {
                    string path = AssetDatabase.GetAssetPath(obj);
                    Unit prefab = PrefabUnit(path);
                    if (prefab.ids.TryGetValue(obj, out int prefabId))
                        return new Node {["$prefab"] = path, ["$id"] = prefabId};
                    _ctx.Warn("unresolved prefab reference " + path);
                    return null;
                }

                if (unit != null && unit.ids.TryGetValue(obj, out int id)) return new Node {["$id"] = id};
                _ctx.Warn("reference outside of export unit " + (unit != null ? unit.key : "asset") + ": " + obj.name);
                return null;
            }

            var handler = ExportRegistry.Find(obj.GetType());
            if (handler != null) return handler(obj, _ctx);

            string ns = obj.GetType().Namespace ?? "";
            if (obj is ScriptableObject so && !ns.StartsWith("UnityEngine") && !ns.StartsWith("UnityEditor") && !ns.StartsWith("Unity."))
            {
                return _ctx.Add("objects", so, () => new Node
                {
                    ["type"] = so.GetType().FullName,
                    ["name"] = so.name,
                    ["path"] = AssetDatabase.GetAssetPath(so),
                    ["props"] = DumpSerialized(null, new SerializedObject(so), null)
                });
            }

            return new Node {["$asset"] = AssetDatabase.GetAssetPath(obj), ["$type"] = obj.GetType().Name};
        }

        private static List<object> CurveKeys(AnimationCurve curve)
        {
            var keys = new List<object>();
            foreach (Keyframe key in curve.keys)
            {
                keys.Add(key.time);
                keys.Add(key.value);
                keys.Add(key.inTangent);
                keys.Add(key.outTangent);
            }

            return keys;
        }

        private static Node DumpClip(AnimationClip clip)
        {
            AnimationClipSettings settings = AnimationUtility.GetAnimationClipSettings(clip);
            var curves = new List<object>();
            foreach (EditorCurveBinding binding in AnimationUtility.GetCurveBindings(clip))
            {
                AnimationCurve curve = AnimationUtility.GetEditorCurve(clip, binding);
                if (curve.keys.Any(k => k.weightedMode != WeightedMode.None))
                    _ctx.Warn("weighted tangents ignored in " + clip.name + " " + binding.propertyName);
                curves.Add(new Node
                {
                    ["path"] = binding.path,
                    ["type"] = binding.type.FullName,
                    ["prop"] = binding.propertyName,
                    ["keys"] = CurveKeys(curve)
                });
            }

            var objectCurves = new List<object>();
            foreach (EditorCurveBinding binding in AnimationUtility.GetObjectReferenceCurveBindings(clip))
            {
                var keys = new List<object>();
                foreach (ObjectReferenceKeyframe key in AnimationUtility.GetObjectReferenceCurve(clip, binding))
                {
                    keys.Add(new List<object> {key.time, Ref(null, key.value)});
                }

                objectCurves.Add(new Node
                {
                    ["path"] = binding.path,
                    ["type"] = binding.type.FullName,
                    ["prop"] = binding.propertyName,
                    ["keys"] = keys
                });
            }

            var events = new List<object>();
            foreach (AnimationEvent animationEvent in AnimationUtility.GetAnimationEvents(clip))
            {
                events.Add(new Node
                {
                    ["time"] = animationEvent.time,
                    ["function"] = animationEvent.functionName,
                    ["string"] = animationEvent.stringParameter,
                    ["float"] = animationEvent.floatParameter,
                    ["int"] = animationEvent.intParameter
                });
            }

            return new Node
            {
                ["name"] = clip.name,
                ["length"] = clip.length,
                ["frameRate"] = clip.frameRate,
                ["loop"] = settings.loopTime,
                ["curves"] = curves,
                ["objectCurves"] = objectCurves,
                ["events"] = events
            };
        }

        private static Node DumpController(RuntimeAnimatorController runtimeController)
        {
            var node = new Node {["name"] = runtimeController.name};
            var layers = new List<object>();
            node["layers"] = layers;
            var controller = runtimeController as AnimatorController;
            if (controller == null)
            {
                _ctx.Warn("unsupported controller type " + runtimeController.GetType().Name + " " + runtimeController.name);
                return node;
            }

            var parameters = new List<object>();
            foreach (AnimatorControllerParameter parameter in controller.parameters)
            {
                parameters.Add(new Node
                {
                    ["name"] = parameter.name,
                    ["type"] = parameter.type.ToString(),
                    ["float"] = parameter.defaultFloat,
                    ["int"] = parameter.defaultInt,
                    ["bool"] = parameter.defaultBool
                });
            }

            node["parameters"] = parameters;

            foreach (AnimatorControllerLayer layer in controller.layers)
            {
                AnimatorStateMachine machine = layer.stateMachine;
                var states = new List<object>();
                foreach (ChildAnimatorState childState in machine.states)
                {
                    AnimatorState state = childState.state;
                    var clip = state.motion as AnimationClip;
                    if (state.motion != null && clip == null)
                        _ctx.Warn("unsupported motion in state " + state.name + " of " + controller.name);
                    var transitions = new List<object>();
                    foreach (AnimatorStateTransition transition in state.transitions) transitions.Add(DumpTransition(transition));
                    states.Add(new Node
                    {
                        ["name"] = state.name,
                        ["clip"] = clip != null ? Ref(null, clip) : null,
                        ["speed"] = state.speed,
                        ["writeDefaults"] = state.writeDefaultValues,
                        ["transitions"] = transitions
                    });
                }

                var any = new List<object>();
                foreach (AnimatorStateTransition transition in machine.anyStateTransitions) any.Add(DumpTransition(transition));

                layers.Add(new Node
                {
                    ["name"] = layer.name,
                    ["defaultState"] = machine.defaultState != null ? machine.defaultState.name : null,
                    ["states"] = states,
                    ["anyState"] = any
                });
            }

            return node;
        }

        private static Node DumpTransition(AnimatorStateTransition transition)
        {
            var conditions = new List<object>();
            foreach (AnimatorCondition condition in transition.conditions)
            {
                conditions.Add(new Node {["mode"] = condition.mode.ToString(), ["parameter"] = condition.parameter, ["threshold"] = condition.threshold});
            }

            return new Node
            {
                ["to"] = transition.destinationState != null ? transition.destinationState.name : null,
                ["hasExitTime"] = transition.hasExitTime,
                ["exitTime"] = transition.exitTime,
                ["duration"] = transition.duration,
                ["fixedDuration"] = transition.hasFixedDuration,
                ["conditions"] = conditions
            };
        }

        private static Node DumpFont(Font font, int index, string outDir)
        {
            string path = AssetDatabase.GetAssetPath(font);
            var node = new Node
            {
                ["name"] = font.name,
                ["lineHeight"] = font.fontSize > 0 ? (float) font.lineHeight / font.fontSize : 1.15f,
                ["ascent"] = font.fontSize > 0 ? (float) font.ascent / font.fontSize : 0.9f
            };
            string extension = Path.GetExtension(path).ToLowerInvariant();
            if ((path.StartsWith("Assets/") || path.StartsWith("Packages/")) && (extension == ".ttf" || extension == ".otf"))
            {
                string file = "font" + index + extension;
                _ctx.File(file, File.ReadAllBytes(path), "font", path);
                node["file"] = file;
                node["path"] = path;
            }
            else
            {
                _ctx.Warn("font " + font.name + " has no source file, falling back to a system font");
            }

            return node;
        }
    }
}
