using System;
using UnityEditor;
using UnityEngine;

namespace SaturaSpace
{
    public sealed class SaturaClipException : InvalidOperationException
    {
        public SaturaClipException(string message) : base(message) { }
    }

    [Serializable]
    public sealed class ClipKey
    {
        public string path = "";
        public string type = "Transform";
        public string prop;
        public int frame = -1;
        public float time = -1f;
        public float value;
        public string tangent;

        public ClipKey On(string childPath, string componentType = null)
        {
            path = childPath ?? "";
            if (!string.IsNullOrEmpty(componentType)) type = componentType;
            return this;
        }

        public ClipKey Tangent(string mode)
        {
            tangent = mode;
            return this;
        }

        public override string ToString()
        {
            var at = frame >= 0 ? "f" + frame : time + "s";
            return (string.IsNullOrEmpty(path) ? "" : path + "/") + type + "." + prop + " " + at + " = " + value + (string.IsNullOrEmpty(tangent) ? "" : " [" + tangent + "]");
        }
    }

    public sealed class ClipResult
    {
        public AnimationClip Clip { get; }
        public string Path { get; }
        public string[] Done { get; }
        readonly string _text;

        internal ClipResult(AnimationClip clip, string path, string[] done, string text)
        {
            Clip = clip;
            Path = path;
            Done = done;
            _text = text;
        }

        public override string ToString() => _text;
    }

    public sealed class ClipTarget
    {
        internal readonly string Path;

        ClipTarget(string path)
        {
            Path = path;
        }

        public static implicit operator ClipTarget(string path) => path == null ? null : new ClipTarget(path);

        public static implicit operator ClipTarget(GameObject go)
        {
            if (go == null) throw new SaturaClipException("the GameObject is null (maybe GameObject.Find found nothing): pass its hierarchy path instead");
            return new ClipTarget(MCPTestBridge.TunerIndexedPath(go.transform));
        }

        public static implicit operator ClipTarget(Component c)
        {
            if (c == null) throw new SaturaClipException("the component is null: pass the object's hierarchy path instead");
            return new ClipTarget(MCPTestBridge.TunerIndexedPath(c.transform));
        }

        internal static string Of(ClipTarget t) => t?.Path;

        public override string ToString() => Path;
    }

    public static class SaturaClips
    {
        public static string List(ClipTarget obj) => MCPTestBridge.ClipsList(ClipTarget.Of(obj));

        public static AnimationClip Get(ClipTarget obj, string clip = null) => MCPTestBridge.ClipsGet(ClipTarget.Of(obj), clip);

        public static string Describe(ClipTarget obj, string clip = null) => MCPTestBridge.ClipsDescribe(ClipTarget.Of(obj), clip);

        public static ClipResult Create(ClipTarget obj, string name, float frameRate = 0f, bool? loop = null) =>
            MCPTestBridge.ClipsCreate(ClipTarget.Of(obj), name, frameRate, Loop(loop));

        public static ClipResult SetKeys(ClipTarget obj, string clip, params ClipKey[] keys) => MCPTestBridge.ClipsSetKeys(ClipTarget.Of(obj), clip, keys);

        public static ClipResult RemoveKeys(ClipTarget obj, string clip, params ClipKey[] keys) => MCPTestBridge.ClipsRemoveKeys(ClipTarget.Of(obj), clip, keys);

        public static ClipResult RemoveProperty(ClipTarget obj, string clip, string prop, string path = "", string type = "Transform") =>
            MCPTestBridge.ClipsRemoveProperty(ClipTarget.Of(obj), clip, prop, path, type);

        public static ClipResult SetEvents(ClipTarget obj, string clip, params AnimationEvent[] events) => MCPTestBridge.ClipsSetEvents(ClipTarget.Of(obj), clip, events, false);

        public static ClipResult AddEvent(ClipTarget obj, string clip, AnimationEvent e) => MCPTestBridge.ClipsSetEvents(ClipTarget.Of(obj), clip, new[] { e }, true);

        public static ClipResult Settings(ClipTarget obj, string clip, float length = -1f, float frameRate = 0f, bool? loop = null) =>
            MCPTestBridge.ClipsSettings(ClipTarget.Of(obj), clip, length, frameRate, Loop(loop));

        public static ClipResult Delete(ClipTarget obj, string clip = null) => MCPTestBridge.ClipsDelete(ClipTarget.Of(obj), clip);

        public static ClipKey Key(string prop, int frame, float value) => new ClipKey { prop = prop, frame = frame, value = value };

        public static ClipKey KeyAt(string prop, float seconds, float value) => new ClipKey { prop = prop, time = seconds, value = value };

        public static ClipKey Muscle(string muscle, int frame, float value) =>
            new ClipKey { path = "", type = "Animator", prop = MCPTestBridge.ClipsMuscleProp(muscle), frame = frame, value = value };

        public static string[] Muscles(string filter = null) => MCPTestBridge.ClipsMuscles(filter);

        public static string PathOf(GameObject root, GameObject child)
        {
            if (child == null) throw new SaturaClipException("PathOf(root, child) needs the child");
            if (root == null) return AnimationUtility.CalculateTransformPath(child.transform, null);
            if (child != root && !child.transform.IsChildOf(root.transform)) throw new SaturaClipException(child.name + " is not under " + root.name);
            return AnimationUtility.CalculateTransformPath(child.transform, root.transform);
        }

        static int Loop(bool? loop) => loop.HasValue ? (loop.Value ? 1 : 0) : -1;
    }
}
