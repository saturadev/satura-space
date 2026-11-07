using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using UnityEngine.SceneManagement;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    [Serializable]
    class TunerPopupObjectsArgs
    {
        public string type;
        public bool allowSceneObjects;
        public bool scene;
        public string search;
        public int offset;
        public int limit = 60;
        public string[] known;
        public string context;
    }

    [Serializable]
    class TunerPopupObjectsCommand
    {
        public int id;
        public TunerPopupObjectsArgs args;
    }

    [Serializable]
    class TunerPopupKeyIn
    {
        public float time;
        public float value;
        public float inTangent;
        public float outTangent;
        public float inWeight;
        public float outWeight;
        public int weightedMode;
        public int left = -1;
        public int right = -1;
        public bool broken;
    }

    [Serializable]
    class TunerPopupCurveIn
    {
        public TunerPopupKeyIn[] keys;
        public int preWrapMode = (int)WrapMode.ClampForever;
        public int postWrapMode = (int)WrapMode.ClampForever;
    }

    sealed class TunerPopupCandidate
    {
        public string Name;
        public string TypeName;
        public string Path;
        public string Guid;
        public string LocalId;
        public string ScenePath;
        public string Scene;
        public string Component;
        public bool Sub;
        public UnityEngine.Object Obj;
    }

    const int TUNER_POPUP_MAX_CANDIDATES = 5000;
    const double TUNER_POPUP_LIST_BUDGET_S = 4.0;
    const double TUNER_POPUP_CACHE_S = 30.0;
    const int TUNER_POPUP_ICON_PX = 32;
    static readonly CultureInfo TunerPopupInv = CultureInfo.InvariantCulture;
    static readonly Dictionary<string, Type> s_TunerPopupTypes = new Dictionary<string, Type>();
    static string s_TunerPopupListKey;
    static List<TunerPopupCandidate> s_TunerPopupList;
    static bool s_TunerPopupListTruncated;
    static double s_TunerPopupListAt;
    static bool s_TunerPopupPatched;
    static string s_TunerPopupPatchError;

    static void HandleTunerPopupCommand(int id, string cmd, string line, ControlClient from)
    {
        try
        {
            switch (cmd)
            {
                case "tunerPopup/objects":
                    var parsed = JsonUtility.FromJson<TunerPopupObjectsCommand>(line);
                    if (parsed?.args == null || string.IsNullOrEmpty(parsed.args.type))
                    {
                        TunerPopupReply(from, id, "a type is required", null);
                        return;
                    }
                    TunerPopupObjects(parsed.args, (json, error) => TunerPopupReply(from, id, error, error != null ? null : "\"objects\":" + json));
                    break;
                default:
                    TunerPopupReply(from, id, "unknown command: " + cmd, null);
                    break;
            }
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogException(inner);
            TunerPopupReply(from, id, inner.GetType().Name + ": " + inner.Message, null);
        }
    }

    static void TunerPopupReply(ControlClient to, int id, string error, string payload)
    {
        var sb = new StringBuilder(256 + (payload?.Length ?? 0));
        sb.Append("{\"type\":\"result\",\"id\":").Append(id.ToString(TunerUitkInv))
          .Append(",\"status\":").Append(error == null ? "\"completed\"" : "\"error\"");
        if (error != null) sb.Append(",\"error\":").Append(TunerUitkStr(error));
        if (!string.IsNullOrEmpty(payload)) sb.Append(',').Append(payload);
        sb.Append('}');
        CtrlReply(to, sb.ToString());
    }

    internal static Type TunerPopupFindType(string fullName)
    {
        if (string.IsNullOrEmpty(fullName)) return null;
        if (s_TunerPopupTypes.TryGetValue(fullName, out var cached)) return cached;
        Type found = null;
        foreach (var t in TypeCache.GetTypesDerivedFrom<UnityEngine.Object>())
        {
            if (t.FullName == fullName)
            {
                found = t;
                break;
            }
            if (found == null && t.Name == fullName) found = t;
        }
        if (found == null && fullName == typeof(UnityEngine.Object).FullName) found = typeof(UnityEngine.Object);
        s_TunerPopupTypes[fullName] = found;
        return found;
    }

    static string[] TunerPopupWords(string search)
    {
        return string.IsNullOrWhiteSpace(search) ? new string[0] : search.ToLowerInvariant().Split(new[] { ' ' }, StringSplitOptions.RemoveEmptyEntries);
    }

    static bool TunerPopupMatches(string name, string[] words)
    {
        if (words.Length == 0) return true;
        var n = (name ?? "").ToLowerInvariant();
        foreach (var w in words)
            if (n.IndexOf(w, StringComparison.Ordinal) < 0) return false;
        return true;
    }

    static void TunerPopupObjects(TunerPopupObjectsArgs a, Action<string, string> done)
    {
        var search = TunerSearchPickerFind(a.context);
        var type = search != null ? search.Type : TunerPopupFindType(a.type) ?? typeof(UnityEngine.Object);
        var scene = a.scene && a.allowSceneObjects;
        var key = (search != null ? search.Key + "|" : "") + type.FullName + "|" + (scene ? "scene" : "assets") + "|" + (a.search ?? "");
        var now = EditorApplication.timeSinceStartup;
        if (a.offset > 0 && key == s_TunerPopupListKey && s_TunerPopupList != null && now - s_TunerPopupListAt <= TUNER_POPUP_CACHE_S)
        {
            done(TunerPopupObjectsPage(a, s_TunerPopupList, s_TunerPopupListTruncated), null);
            return;
        }
        if (search != null)
        {
            TunerSearchPickerCandidates(search, scene, a.search, (list, truncated) =>
            {
                string json;
                try
                {
                    TunerPopupKeepList(key, list, truncated);
                    json = TunerPopupObjectsPage(a, list, truncated, search.Custom && search.AllowScene && !search.SawScene && string.IsNullOrEmpty(a.search) && !truncated);
                }
                catch (Exception e)
                {
                    Debug.LogException(e);
                    done(null, e.GetType().Name + ": " + e.Message);
                    return;
                }
                done(json, null);
            });
            return;
        }
        var words = TunerPopupWords(a.search);
        bool cut;
        var found = scene ? TunerPopupSceneCandidates(type, words, out cut) : TunerPopupAssetCandidates(type, words, out cut);
        found.Sort((x, y) =>
        {
            var c = string.Compare(x.Name, y.Name, StringComparison.OrdinalIgnoreCase);
            return c != 0 ? c : string.CompareOrdinal(x.Path ?? x.ScenePath, y.Path ?? y.ScenePath);
        });
        TunerPopupKeepList(key, found, cut);
        done(TunerPopupObjectsPage(a, found, cut), null);
    }

    static void TunerPopupKeepList(string key, List<TunerPopupCandidate> list, bool truncated)
    {
        s_TunerPopupList = list;
        s_TunerPopupListKey = key;
        s_TunerPopupListTruncated = truncated;
        s_TunerPopupListAt = EditorApplication.timeSinceStartup;
    }

    static string TunerPopupObjectsPage(TunerPopupObjectsArgs a, List<TunerPopupCandidate> all, bool truncated, bool noScene = false)
    {
        var offset = Mathf.Max(0, a.offset);
        var limit = Mathf.Clamp(a.limit, 1, 200);
        var known = new HashSet<string>(a.known ?? new string[0]);
        var tex = new Dictionary<string, string>();
        var sb = new StringBuilder(4096);
        sb.Append("{\"total\":").Append(all.Count.ToString(TunerPopupInv));
        if (truncated) sb.Append(",\"truncated\":true");
        if (noScene) sb.Append(",\"noScene\":true");
        sb.Append(",\"items\":[");
        var first = true;
        for (int i = offset; i < all.Count && i < offset + limit; i++)
        {
            var c = all[i];
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"name\":").Append(TunerUitkStr(c.Name ?? ""));
            sb.Append(",\"typeName\":").Append(TunerUitkStr(c.TypeName ?? ""));
            if (!string.IsNullOrEmpty(c.Path)) sb.Append(",\"path\":").Append(TunerUitkStr(c.Path));
            if (!string.IsNullOrEmpty(c.Guid)) sb.Append(",\"guid\":").Append(TunerUitkStr(c.Guid));
            if (!string.IsNullOrEmpty(c.LocalId)) sb.Append(",\"localId\":").Append(TunerUitkStr(c.LocalId));
            if (!string.IsNullOrEmpty(c.ScenePath)) sb.Append(",\"scenePath\":").Append(TunerUitkStr(c.ScenePath));
            if (!string.IsNullOrEmpty(c.Scene)) sb.Append(",\"scene\":").Append(TunerUitkStr(c.Scene));
            if (!string.IsNullOrEmpty(c.Component)) sb.Append(",\"component\":").Append(TunerUitkStr(c.Component));
            if (c.Sub) sb.Append(",\"sub\":1");
            var icon = TunerPopupIconFor(c);
            if (icon != null)
            {
                var ik = TunerUitkTextureKey(icon, new Rect(0f, 0f, 1f, 1f));
                sb.Append(",\"icon\":").Append(TunerUitkStr(ik));
                if (!known.Contains(ik) && !tex.ContainsKey(ik))
                {
                    var png = TunerPopupIconPng(icon, out var w, out var h);
                    if (png != null) tex[ik] = "{\"w\":" + w.ToString(TunerPopupInv) + ",\"h\":" + h.ToString(TunerPopupInv) + ",\"png\":\"" + Convert.ToBase64String(png) + "\"}";
                }
            }
            sb.Append('}');
        }
        sb.Append(']');
        if (tex.Count > 0)
        {
            sb.Append(",\"tex\":{");
            var firstTex = true;
            foreach (var kv in tex)
            {
                if (!firstTex) sb.Append(',');
                firstTex = false;
                sb.Append(TunerUitkStr(kv.Key)).Append(':').Append(kv.Value);
            }
            sb.Append('}');
        }
        sb.Append('}');
        return sb.ToString();
    }

    static List<TunerPopupCandidate> TunerPopupAssetCandidates(Type type, string[] words, out bool truncated)
    {
        truncated = false;
        var list = new List<TunerPopupCandidate>();
        var isComponent = typeof(Component).IsAssignableFrom(type);
        var isGameObject = type == typeof(GameObject);
        var anything = type == typeof(UnityEngine.Object);
        var filter = isComponent || isGameObject ? "t:GameObject" : anything ? "" : "t:" + type.Name;
        var sw = Stopwatch.StartNew();
        foreach (var guid in AssetDatabase.FindAssets(filter))
        {
            if (list.Count >= TUNER_POPUP_MAX_CANDIDATES || sw.Elapsed.TotalSeconds > TUNER_POPUP_LIST_BUDGET_S)
            {
                truncated = true;
                break;
            }
            var path = AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(path) || AssetDatabase.IsValidFolder(path)) continue;
            var mainType = AssetDatabase.GetMainAssetTypeAtPath(path);
            if (mainType == null) continue;
            var fileName = System.IO.Path.GetFileNameWithoutExtension(path);
            if (isComponent)
            {
                if (!TunerPopupMatches(fileName, words)) continue;
                var go = AssetDatabase.LoadAssetAtPath<GameObject>(path);
                var comp = go != null ? go.GetComponent(type) : null;
                if (comp == null) continue;
                list.Add(new TunerPopupCandidate { Name = fileName, TypeName = comp.GetType().Name, Path = path, Guid = guid, Component = comp.GetType().Name });
                continue;
            }
            if (type.IsAssignableFrom(mainType))
            {
                if (TunerPopupMatches(fileName, words))
                    list.Add(new TunerPopupCandidate { Name = fileName, TypeName = mainType.Name, Path = path, Guid = guid });
                continue;
            }
            if (anything || isGameObject) continue;
            foreach (var o in AssetDatabase.LoadAllAssetRepresentationsAtPath(path))
            {
                if (o == null || !type.IsInstanceOfType(o) || !TunerPopupMatches(o.name, words)) continue;
                AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out _, out long lid);
                list.Add(new TunerPopupCandidate { Name = o.name, TypeName = o.GetType().Name, Path = path, Guid = guid, LocalId = lid.ToString(TunerPopupInv), Sub = true, Obj = o });
            }
        }
        return list;
    }

    static List<TunerPopupCandidate> TunerPopupSceneCandidates(Type type, string[] words, out bool truncated)
    {
        truncated = false;
        var list = new List<TunerPopupCandidate>();
        var isComponent = typeof(Component).IsAssignableFrom(type);
        var goLike = type == typeof(GameObject) || type == typeof(UnityEngine.Object);
        if (!isComponent && !goLike) return list;
        for (int s = 0; s < SceneManager.sceneCount; s++)
        {
            var sc = SceneManager.GetSceneAt(s);
            if (!sc.isLoaded) continue;
            foreach (var root in sc.GetRootGameObjects())
            {
                if (SaturaEngineObjects.Contains(root)) continue;
                foreach (var t in root.GetComponentsInChildren<Transform>(true))
                {
                    if (list.Count >= TUNER_POPUP_MAX_CANDIDATES)
                    {
                        truncated = true;
                        return list;
                    }
                    var go = t.gameObject;
                    if ((go.hideFlags & HideFlags.HideInHierarchy) != 0 || !TunerPopupMatches(go.name, words)) continue;
                    var path = TunerUitkHierarchyPath(t);
                    if (goLike)
                    {
                        list.Add(new TunerPopupCandidate { Name = go.name, TypeName = "GameObject", ScenePath = path, Scene = sc.path, Obj = go });
                        continue;
                    }
                    foreach (var c in go.GetComponents(type))
                    {
                        if (c == null) continue;
                        list.Add(new TunerPopupCandidate { Name = go.name, TypeName = c.GetType().Name, ScenePath = path, Scene = sc.path, Component = c.GetType().Name, Obj = c });
                    }
                }
            }
        }
        return list;
    }

    static Texture TunerPopupIconFor(TunerPopupCandidate c)
    {
        try
        {
            if (c.Obj != null && (c.Sub || !string.IsNullOrEmpty(c.ScenePath)))
                return AssetPreview.GetMiniThumbnail(c.Obj) ?? AssetPreview.GetMiniTypeThumbnail(c.Obj.GetType());
            if (!string.IsNullOrEmpty(c.Path)) return AssetDatabase.GetCachedIcon(c.Path);
        }
        catch { }
        return null;
    }

    static byte[] TunerPopupIconPng(Texture tex, out int w, out int h)
    {
        w = Mathf.Max(1, tex.width);
        h = Mathf.Max(1, tex.height);
        var scale = Mathf.Min(1f, TUNER_POPUP_ICON_PX / (float)Mathf.Max(w, h));
        w = Mathf.Max(1, Mathf.RoundToInt(w * scale));
        h = Mathf.Max(1, Mathf.RoundToInt(h * scale));
        var prev = RenderTexture.active;
        var rt = RenderTexture.GetTemporary(w, h, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
        Texture2D copy = null;
        try
        {
            Graphics.Blit(tex, rt);
            RenderTexture.active = rt;
            copy = new Texture2D(w, h, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
            copy.ReadPixels(new Rect(0, 0, w, h), 0, 0);
            copy.Apply();
            return copy.EncodeToPNG();
        }
        catch
        {
            return null;
        }
        finally
        {
            RenderTexture.active = prev;
            RenderTexture.ReleaseTemporary(rt);
            if (copy != null) UnityEngine.Object.DestroyImmediate(copy);
        }
    }

    static string TunerPopupFloat(float f)
    {
        if (float.IsNaN(f)) return "0";
        if (float.IsPositiveInfinity(f)) return "1e999";
        if (float.IsNegativeInfinity(f)) return "-1e999";
        return f.ToString("R", TunerPopupInv);
    }

    static float TunerPopupTangentIn(float f)
    {
        if (f >= 1e37f) return float.PositiveInfinity;
        if (f <= -1e37f) return float.NegativeInfinity;
        return f;
    }

    internal static string TunerPopupCurveJson(AnimationCurve c)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"keys\":[");
        var keys = c != null ? c.keys : new Keyframe[0];
        for (int i = 0; i < keys.Length; i++)
        {
            var k = keys[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"time\":").Append(TunerPopupFloat(k.time));
            sb.Append(",\"value\":").Append(TunerPopupFloat(k.value));
            sb.Append(",\"inTangent\":").Append(TunerPopupFloat(k.inTangent));
            sb.Append(",\"outTangent\":").Append(TunerPopupFloat(k.outTangent));
            sb.Append(",\"inWeight\":").Append(TunerPopupFloat(k.inWeight));
            sb.Append(",\"outWeight\":").Append(TunerPopupFloat(k.outWeight));
            sb.Append(",\"weightedMode\":").Append(((int)k.weightedMode).ToString(TunerPopupInv));
            sb.Append(",\"left\":").Append(((int)AnimationUtility.GetKeyLeftTangentMode(c, i)).ToString(TunerPopupInv));
            sb.Append(",\"right\":").Append(((int)AnimationUtility.GetKeyRightTangentMode(c, i)).ToString(TunerPopupInv));
            sb.Append(",\"broken\":").Append(AnimationUtility.GetKeyBroken(c, i) ? "true" : "false");
            sb.Append('}');
        }
        sb.Append("],\"preWrapMode\":").Append(((int)(c != null ? c.preWrapMode : WrapMode.ClampForever)).ToString(TunerPopupInv));
        sb.Append(",\"postWrapMode\":").Append(((int)(c != null ? c.postWrapMode : WrapMode.ClampForever)).ToString(TunerPopupInv));
        sb.Append('}');
        return sb.ToString();
    }

    internal static AnimationCurve TunerPopupParseCurve(string raw)
    {
        return TunerPopupCurveFrom(JsonUtility.FromJson<TunerPopupCurveIn>(raw));
    }

    static AnimationCurve TunerPopupCurveFrom(TunerPopupCurveIn v)
    {
        var input = v?.keys ?? new TunerPopupKeyIn[0];
        var sorted = input.OrderBy(k => k.time).ToArray();
        var keys = sorted.Select(k => new Keyframe(k.time, k.value, TunerPopupTangentIn(k.inTangent), TunerPopupTangentIn(k.outTangent), k.inWeight, k.outWeight)
        {
            weightedMode = (WeightedMode)Mathf.Clamp(k.weightedMode, 0, 3)
        }).ToArray();
        var curve = new AnimationCurve(keys)
        {
            preWrapMode = (WrapMode)(v?.preWrapMode ?? (int)WrapMode.ClampForever),
            postWrapMode = (WrapMode)(v?.postWrapMode ?? (int)WrapMode.ClampForever)
        };
        for (int i = 0; i < sorted.Length && i < curve.length; i++)
        {
            var k = sorted[i];
            var left = k.left >= 0 && k.left <= 4 ? (AnimationUtility.TangentMode)k.left : AnimationUtility.TangentMode.Free;
            var right = k.right >= 0 && k.right <= 4 ? (AnimationUtility.TangentMode)k.right : AnimationUtility.TangentMode.Free;
            if (left != AnimationUtility.TangentMode.Free) AnimationUtility.SetKeyLeftTangentMode(curve, i, left);
            if (right != AnimationUtility.TangentMode.Free) AnimationUtility.SetKeyRightTangentMode(curve, i, right);
            if (k.broken) AnimationUtility.SetKeyBroken(curve, i, true);
            else if (left != AnimationUtility.TangentMode.Free || right != AnimationUtility.TangentMode.Free) AnimationUtility.SetKeyBroken(curve, i, false);
        }
        return curve;
    }

    internal static string TunerPopupObjectRefJson(UnityEngine.Object o)
    {
        if (o == null) return "null";
        var sb = new StringBuilder(128);
        sb.Append("{\"id\":").Append(TunerUitkStr(o.GetHashCode().ToString(TunerPopupInv)));
        if (EditorUtility.IsPersistent(o))
        {
            sb.Append(",\"path\":").Append(TunerUitkStr(AssetDatabase.GetAssetPath(o)));
            if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out var guid, out long lid))
                sb.Append(",\"guid\":").Append(TunerUitkStr(guid)).Append(",\"localId\":").Append(TunerUitkStr(lid.ToString(TunerPopupInv)));
        }
        else
        {
            var go = o as GameObject ?? (o as Component)?.gameObject;
            if (go != null)
            {
                sb.Append(",\"scenePath\":").Append(TunerUitkStr(TunerUitkHierarchyPath(go.transform)));
                sb.Append(",\"scene\":").Append(TunerUitkStr(go.scene.path));
                if (o is Component c) sb.Append(",\"component\":").Append(TunerUitkStr(c.GetType().Name));
            }
        }
        sb.Append('}');
        return sb.ToString();
    }

    static TunerUitkObjectRef TunerPopupParseObjectRef(string raw)
    {
        if (string.IsNullOrEmpty(raw) || raw.Trim() == "null") return null;
        string Str(string key) => TunerUitkJsonString(TunerUitkJsonRaw(raw, key));
        var r = new TunerUitkObjectRef
        {
            id = Str("id"),
            guid = Str("guid"),
            path = Str("path"),
            scene = Str("scene"),
            scenePath = Str("scenePath"),
            component = Str("component")
        };
        var lid = Str("localId");
        if (!string.IsNullOrEmpty(lid) && long.TryParse(lid.Trim(), NumberStyles.Integer, TunerPopupInv, out var l)) r.localId = l;
        return r;
    }

    internal static MethodInfo TunerPopupHook(string name)
    {
        return typeof(TunerPopupHooks).GetMethod(name, BindingFlags.Static | BindingFlags.Public) ?? throw new MissingMethodException("TunerPopupHooks." + name);
    }

    static void TunerPopupEnsurePatches()
    {
        if (s_TunerPopupPatched || s_TunerPopupPatchError != null) return;
        var failures = new List<string>();
        try
        {
            var asm = FindHarmony();
            if (asm == null)
            {
                s_TunerPopupPatchError = "Harmony is not loaded";
                Debug.LogWarning("[tunerPopup] popups stay unhooked: " + s_TunerPopupPatchError);
                return;
            }
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-popups");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var ctor = methodType.GetConstructor(new[] { typeof(MethodInfo) });
            const BindingFlags any = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;
            void Apply(MethodBase target, string label, string prefix, string postfix = null)
            {
                try
                {
                    if (target == null) throw new MissingMethodException(label);
                    var call = new object[patch.GetParameters().Length];
                    call[0] = target;
                    if (prefix != null) call[1] = ctor.Invoke(new object[] { TunerPopupHook(prefix) });
                    if (postfix != null) call[2] = ctor.Invoke(new object[] { TunerPopupHook(postfix) });
                    patch.Invoke(harmony, call);
                }
                catch (Exception e)
                {
                    var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
                    failures.Add(label + ": " + inner.Message);
                }
            }
            MethodInfo Find(Type type, string name, Func<ParameterInfo[], bool> match)
            {
                return type?.GetMethods(any).FirstOrDefault(m => m.Name == name && match(m.GetParameters()));
            }
            MethodInfo Getter(Type type, string name)
            {
                return type?.GetProperty(name, any)?.GetGetMethod(true);
            }
            var editorAsm = typeof(Editor).Assembly;
            var colorPicker = editorAsm.GetType("UnityEditor.ColorPicker");
            var curveWindow = editorAsm.GetType("UnityEditor.CurveEditorWindow");
            var gradientPicker = editorAsm.GetType("UnityEditor.GradientPicker");
            var objectSelector = editorAsm.GetType("UnityEditor.ObjectSelector");
            var maskInfo = editorAsm.GetType("UnityEditor.MaskFieldGUI")?.GetNestedType("MaskCallbackInfo", any);
            Apply(typeof(UnityEditor.IMGUI.Controls.AdvancedDropdown).GetMethod("Show", any, null, new[] { typeof(Rect) }, null), "AdvancedDropdown.Show", nameof(TunerPopupDropdownPrefix));
            Apply(Find(colorPicker, "Show", ps => ps.Length == 6 && ps[1].ParameterType == typeof(Action<Color>)), "ColorPicker.Show", nameof(TunerPopupColorShowPrefix));
            Apply(Getter(colorPicker, "color"), "ColorPicker.color", nameof(TunerPopupColorGetPrefix));
            Apply(Find(typeof(EditorGUI), "SetCurveEditorWindowCurve", ps => ps.Length == 3), "EditorGUI.SetCurveEditorWindowCurve", nameof(TunerPopupSetCurvePrefix));
            Apply(Find(typeof(EditorGUI), "ShowCurvePopup", ps => ps.Length == 1 && ps[0].ParameterType == typeof(Rect)), "EditorGUI.ShowCurvePopup", nameof(TunerPopupShowCurvePrefix));
            Apply(Getter(curveWindow, "curve"), "CurveEditorWindow.curve", nameof(TunerPopupCurveGetPrefix));
            Apply(Find(gradientPicker, "Show", ps => ps.Length == 6 && ps[3].ParameterType == typeof(Action<Gradient>)), "GradientPicker.Show", nameof(TunerPopupGradientShowPrefix));
            Apply(Getter(gradientPicker, "gradient"), "GradientPicker.gradient", nameof(TunerPopupGradientGetPrefix));
            Apply(Find(objectSelector, "Show", ps => ps.Length > 3 && ps[0].ParameterType == typeof(Type[]) && ps[1].ParameterType == typeof(SerializedProperty)), "ObjectSelector.Show(property)", nameof(TunerPopupObjectShowPropPrefix));
            Apply(Find(objectSelector, "Show", ps => ps.Length > 3 && ps[0].ParameterType == typeof(Object) && ps[1].ParameterType == typeof(Type[])), "ObjectSelector.Show(object)", nameof(TunerPopupObjectShowObjPrefix));
            Apply(Find(objectSelector, "GetCurrentObject", ps => ps.Length == 0), "ObjectSelector.GetCurrentObject", nameof(TunerPopupObjectGetPrefix));
            var searchPicker = typeof(UnityEditor.Search.SearchService).Assembly.GetType("UnityEditor.Search.SearchPickerWindow");
            Apply(Find(searchPicker, "ShowPicker", ps => ps.Length == 1 && ps[0].ParameterType == typeof(UnityEditor.Search.SearchViewState)), "SearchPickerWindow.ShowPicker", nameof(TunerPopupSearchPickerPrefix));
            Apply(typeof(EditorWindow).GetMethod("Close", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null), "EditorWindow.Close", nameof(TunerPopupWindowClosePrefix));
            Apply(Find(maskInfo, "SetMaskValueDelegate", ps => ps.Length == 3), "MaskCallbackInfo.SetMaskValueDelegate", null, nameof(TunerPopupMaskChangedPostfix));
            Apply(Find(typeof(UnityEngine.UIElements.GenericDropdownMenu), "DropDown", ps => ps.Length == 3 && ps[0].ParameterType == typeof(Rect) && ps[2].ParameterType.IsEnum), "GenericDropdownMenu.DropDown", nameof(TunerPopupGenericMenuPrefix));
            s_TunerPopupPatched = true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            s_TunerPopupPatchError = inner.GetType().Name + ": " + inner.Message;
        }
        if (failures.Count > 0 || s_TunerPopupPatchError != null)
            Debug.LogWarning("[tunerPopup] some popups stay unhooked: " + (s_TunerPopupPatchError ?? string.Join("; ", failures)));
    }
}
