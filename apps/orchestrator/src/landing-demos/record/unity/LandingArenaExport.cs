using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;

public static class LandingArenaExport
{
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    static string F(float v) => float.IsNaN(v) || float.IsInfinity(v) ? "0" : v.ToString("R", Inv);
    static string V(Vector3 v) => "[" + F(v.x) + "," + F(v.y) + "," + F(v.z) + "]";
    static string Q(Quaternion q) => "[" + F(q.x) + "," + F(q.y) + "," + F(q.z) + "," + F(q.w) + "]";
    static string C(Color c) => "[" + F(c.r) + "," + F(c.g) + "," + F(c.b) + "," + F(c.a) + "]";

    static string S(string s)
    {
        var sb = new StringBuilder("\"");
        foreach (var ch in s ?? "")
        {
            if (ch == '"' || ch == '\\') sb.Append('\\').Append(ch);
            else if (ch < 32) sb.Append("\\u").Append(((int)ch).ToString("x4"));
            else sb.Append(ch);
        }
        return sb.Append('"').ToString();
    }

    static string Curve(AnimationCurve c)
    {
        if (c == null) return "null";
        var sb = new StringBuilder("{\"keys\":[");
        var keys = c.keys;
        for (var i = 0; i < keys.Length; i++)
        {
            var k = keys[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"time\":" + F(k.time) + ",\"value\":" + F(k.value) + ",\"inTangent\":" + F(k.inTangent) + ",\"outTangent\":" + F(k.outTangent) + ",\"inWeight\":" + F(k.inWeight) + ",\"outWeight\":" + F(k.outWeight) + ",\"weightedMode\":" + (int)k.weightedMode + "}");
        }
        return sb.Append("],\"preWrapMode\":" + (int)c.preWrapMode + ",\"postWrapMode\":" + (int)c.postWrapMode + "}").ToString();
    }

    static string Grad(Gradient g)
    {
        if (g == null) return "null";
        var sb = new StringBuilder("{\"mode\":" + (int)g.mode + ",\"colorSpace\":" + (int)g.colorSpace + ",\"colorKeys\":[");
        for (var i = 0; i < g.colorKeys.Length; i++)
        {
            if (i > 0) sb.Append(',');
            var k = g.colorKeys[i];
            sb.Append("{\"color\":{\"r\":" + F(k.color.r) + ",\"g\":" + F(k.color.g) + ",\"b\":" + F(k.color.b) + ",\"a\":1},\"time\":" + F(k.time) + "}");
        }
        sb.Append("],\"alphaKeys\":[");
        for (var i = 0; i < g.alphaKeys.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append("{\"alpha\":" + F(g.alphaKeys[i].alpha) + ",\"time\":" + F(g.alphaKeys[i].time) + "}");
        }
        return sb.Append("]}").ToString();
    }

    static void Props(StringBuilder sb, Component c, ref bool first)
    {
        var so = new SerializedObject(c);
        var it = so.GetIterator();
        var deep = c is ParticleSystem || c is ParticleSystemRenderer;
        var enter = true;
        while (deep ? it.Next(enter) : it.NextVisible(enter))
        {
            enter = true;
            var path = it.propertyPath;
            if (path == "m_Script" || path == "m_ObjectHideFlags" || path.Contains(".Array.") || path.StartsWith("m_CorrespondingSourceObject") || path.StartsWith("m_PrefabInstance") || path.StartsWith("m_PrefabAsset") || path == "m_GameObject") continue;
            string val = null;
            string extra = "";
            switch (it.propertyType)
            {
                case SerializedPropertyType.Float: val = F(it.floatValue); break;
                case SerializedPropertyType.Integer: val = it.longValue.ToString(Inv); break;
                case SerializedPropertyType.Boolean: val = it.boolValue ? "true" : "false"; break;
                case SerializedPropertyType.Enum:
                    val = it.enumValueIndex.ToString(Inv);
                    var names = it.enumDisplayNames;
                    var esb = new StringBuilder(",\"names\":[");
                    for (var i = 0; i < names.Length; i++) esb.Append(i > 0 ? "," : "").Append(S(names[i]));
                    extra = esb.Append("]").ToString();
                    break;
                case SerializedPropertyType.Color: val = C(it.colorValue); break;
                case SerializedPropertyType.Vector3: val = V(it.vector3Value); enter = false; break;
                case SerializedPropertyType.Vector2: val = "[" + F(it.vector2Value.x) + "," + F(it.vector2Value.y) + "]"; enter = false; break;
                case SerializedPropertyType.Quaternion: val = Q(it.quaternionValue); enter = false; break;
                case SerializedPropertyType.AnimationCurve: val = Curve(it.animationCurveValue); enter = false; break;
                case SerializedPropertyType.Gradient: val = Grad(it.gradientValue); enter = false; break;
                case SerializedPropertyType.ObjectReference:
                    var o = it.objectReferenceValue;
                    val = o == null ? "null" : S(o.name);
                    if (o != null) extra = ",\"ref\":" + S(o.GetType().Name);
                    break;
                case SerializedPropertyType.LayerMask: val = it.intValue.ToString(Inv); break;
                default: continue;
            }
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"component\":" + S(c.GetType().Name) + ",\"path\":" + S(path) + ",\"type\":" + S(it.propertyType.ToString()) + ",\"label\":" + S(it.displayName) + ",\"value\":" + val + extra);
            if (c is MonoBehaviour)
            {
                var fi = c.GetType().GetField(it.name);
                var rg = fi != null ? (RangeAttribute)System.Attribute.GetCustomAttribute(fi, typeof(RangeAttribute)) : null;
                if (rg != null) sb.Append(",\"min\":" + F(rg.min) + ",\"max\":" + F(rg.max));
            }
            sb.Append('}');
        }
    }

    static void Collider(StringBuilder sb, Collider col, ref bool first)
    {
        if (!first) sb.Append(',');
        first = false;
        sb.Append("{\"type\":" + S(col.GetType().Name) + ",\"enabled\":" + (col.enabled ? "true" : "false") + ",\"trigger\":" + (col.isTrigger ? "true" : "false"));
        if (col is BoxCollider b) sb.Append(",\"center\":" + V(b.center) + ",\"size\":" + V(b.size));
        if (col is SphereCollider s) sb.Append(",\"center\":" + V(s.center) + ",\"radius\":" + F(s.radius));
        if (col is CapsuleCollider c) sb.Append(",\"center\":" + V(c.center) + ",\"radius\":" + F(c.radius) + ",\"height\":" + F(c.height) + ",\"direction\":" + c.direction);
        sb.Append('}');
    }

    public static string ExpandAll()
    {
        var n = 0;
        foreach (var root in UnityEngine.SceneManagement.SceneManager.GetActiveScene().GetRootGameObjects())
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
                foreach (var c in t.GetComponents<Component>())
                {
                    if (c == null) continue;
                    InternalEditorUtility.SetIsInspectorExpanded(c, true);
                    var so = new SerializedObject(c);
                    var it = so.GetIterator();
                    while (it.Next(true))
                    {
                        if (c is ParticleSystem && !it.propertyPath.Contains(".") && it.propertyPath.EndsWith("Module"))
                        {
                            it.isExpanded = true;
                            n++;
                        }
                        else if (!(c is ParticleSystem) && it.hasVisibleChildren && it.propertyType == SerializedPropertyType.Generic)
                        {
                            it.isExpanded = true;
                            n++;
                        }
                    }
                }
        return "expanded " + n;
    }

    public static string Export(string outPath)
    {
        var sb = new StringBuilder();
        var meshes = new Dictionary<string, Mesh>();
        var scene = UnityEngine.SceneManagement.SceneManager.GetActiveScene();
        sb.Append("{\"scene\":" + S(scene.name) + ",\"objects\":[");
        var first = true;
        foreach (var root in scene.GetRootGameObjects())
            foreach (var t in root.GetComponentsInChildren<Transform>(true))
            {
                if (!first) sb.Append(',');
                first = false;
                var go = t.gameObject;
                var path = t.name;
                for (var p = t.parent; p != null; p = p.parent) path = p.name + "/" + path;
                sb.Append("{\"path\":" + S(path) + ",\"name\":" + S(go.name) + ",\"active\":" + (go.activeSelf ? "true" : "false") + ",\"static\":" + (go.isStatic ? "true" : "false") + ",\"lp\":" + V(t.localPosition) + ",\"lr\":" + Q(t.localRotation) + ",\"ls\":" + V(t.localScale) + ",\"euler\":" + V(t.localEulerAngles));
                var mf = go.GetComponent<MeshFilter>();
                var mr = go.GetComponent<MeshRenderer>();
                if (mf != null && mf.sharedMesh != null)
                {
                    meshes[mf.sharedMesh.name] = mf.sharedMesh;
                    sb.Append(",\"mesh\":" + S(mf.sharedMesh.name));
                }
                if (mr != null && mr.sharedMaterial != null)
                {
                    var m = mr.sharedMaterial;
                    var col = m.HasProperty("_BaseColor") ? m.GetColor("_BaseColor") : m.color;
                    var em = m.IsKeywordEnabled("_EMISSION") && m.HasProperty("_EmissionColor") ? m.GetColor("_EmissionColor") : Color.black;
                    sb.Append(",\"material\":" + S(m.name) + ",\"color\":" + C(col) + ",\"smooth\":" + F(m.HasProperty("_Smoothness") ? m.GetFloat("_Smoothness") : 0.5f) + ",\"metal\":" + F(m.HasProperty("_Metallic") ? m.GetFloat("_Metallic") : 0f) + ",\"emission\":" + C(em) + ",\"shadows\":" + (int)mr.shadowCastingMode);
                }
                var li = go.GetComponent<Light>();
                if (li != null) sb.Append(",\"light\":{\"type\":" + S(li.type.ToString()) + ",\"color\":" + C(li.color) + ",\"intensity\":" + F(li.intensity) + ",\"range\":" + F(li.range) + ",\"spotAngle\":" + F(li.spotAngle) + ",\"shadows\":" + S(li.shadows.ToString()) + "}");
                var cam = go.GetComponent<Camera>();
                if (cam != null) sb.Append(",\"camera\":{\"fov\":" + F(cam.fieldOfView) + ",\"near\":" + F(cam.nearClipPlane) + ",\"far\":" + F(cam.farClipPlane) + ",\"bg\":" + C(cam.backgroundColor) + "}");
                var rb = go.GetComponent<Rigidbody>();
                if (rb != null) sb.Append(",\"rigidbody\":{\"mass\":" + F(rb.mass) + ",\"gravity\":" + (rb.useGravity ? "true" : "false") + ",\"kinematic\":" + (rb.isKinematic ? "true" : "false") + "}");
                sb.Append(",\"colliders\":[");
                var fc = true;
                foreach (var c in go.GetComponents<Collider>()) Collider(sb, c, ref fc);
                sb.Append("],\"components\":[");
                fc = true;
                foreach (var c in go.GetComponents<Component>())
                {
                    if (c == null) continue;
                    if (!fc) sb.Append(',');
                    fc = false;
                    sb.Append(S(c.GetType().Name));
                }
                sb.Append("],\"fields\":[");
                var ff = true;
                foreach (var c in go.GetComponents<Component>())
                {
                    if (c == null || c is Transform) continue;
                    Props(sb, c, ref ff);
                }
                sb.Append("]}");
            }
        sb.Append("],\"meshes\":{");
        var fm = true;
        foreach (var kv in meshes)
        {
            if (!fm) sb.Append(',');
            fm = false;
            var me = kv.Value;
            sb.Append(S(kv.Key) + ":{\"v\":[");
            var vs = me.vertices;
            for (var i = 0; i < vs.Length; i++) sb.Append(i > 0 ? "," : "").Append(vs[i].x.ToString("0.####", Inv) + "," + vs[i].y.ToString("0.####", Inv) + "," + vs[i].z.ToString("0.####", Inv));
            sb.Append("],\"n\":[");
            var ns = me.normals;
            for (var i = 0; i < ns.Length; i++) sb.Append(i > 0 ? "," : "").Append(ns[i].x.ToString("0.###", Inv) + "," + ns[i].y.ToString("0.###", Inv) + "," + ns[i].z.ToString("0.###", Inv));
            sb.Append("],\"t\":[" + string.Join(",", me.triangles) + "]}");
        }
        sb.Append("},\"ambientSky\":" + C(RenderSettings.ambientSkyColor) + ",\"ambientEquator\":" + C(RenderSettings.ambientEquatorColor) + ",\"ambientGround\":" + C(RenderSettings.ambientGroundColor) + "}");
        System.IO.File.WriteAllText(outPath, sb.ToString());
        return "ok " + sb.Length;
    }
}
