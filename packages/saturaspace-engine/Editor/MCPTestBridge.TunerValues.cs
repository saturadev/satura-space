using System;
using System.Globalization;
using System.Reflection;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const int TUNER_MAX_DEPTH = 12;
    static readonly CultureInfo Inv = CultureInfo.InvariantCulture;

    static UnityEngine.Object LoadTunerAsset(string assetPath)
    {
        if (string.IsNullOrEmpty(assetPath)) return null;
        return AssetDatabase.LoadMainAssetAtPath(assetPath);
    }

    const BindingFlags AnyTunerMethod = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

    static MethodInfo FindTunerMethod(Type t, string name, bool wantStatic)
    {
        for (; t != null; t = t.BaseType)
        {
            foreach (var m in t.GetMethods(AnyTunerMethod | BindingFlags.DeclaredOnly))
            {
                if (m.Name != name || m.GetParameters().Length != 0 || m.ContainsGenericParameters) continue;
                if (wantStatic && !m.IsStatic) continue;
                return m;
            }
        }
        return null;
    }

    static Type FindTunerType(string name)
    {
        var assemblies = AppDomain.CurrentDomain.GetAssemblies();
        foreach (var asm in assemblies)
        {
            var t = asm.GetType(name, false);
            if (t != null) return t;
        }
        foreach (var asm in assemblies)
        {
            Type[] types;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException e) { types = e.Types; }
            catch { continue; }
            foreach (var t in types)
                if (t != null && t.Name == name) return t;
        }
        return null;
    }

    static string InvokeTunerMethod(string assetPath, string typeName, string method, bool save, out string output)
    {
        output = null;
        if (string.IsNullOrEmpty(method)) return "a method name is required";
        UnityEngine.Object obj = null;
        MethodInfo mi;
        if (!string.IsNullOrEmpty(assetPath))
        {
            try { obj = LoadTunerAsset(assetPath); }
            catch (Exception e) { return e.Message; }
            if (obj == null) return "no asset at " + assetPath;
            mi = FindTunerMethod(obj.GetType(), method, false);
            if (mi == null) return "no parameterless method '" + method + "' on " + obj.GetType().Name;
            Undo.RecordObject(obj, "Tuner " + method);
        }
        else
        {
            if (string.IsNullOrEmpty(typeName)) return "a static button needs a type";
            var t = FindTunerType(typeName);
            if (t == null) return "type '" + typeName + "' not found in the loaded assemblies";
            mi = FindTunerMethod(t, method, true);
            if (mi == null) return "no parameterless static method '" + method + "' on " + t.Name;
        }
        object result;
        try { result = mi.Invoke(mi.IsStatic ? null : obj, null); }
        catch (TargetInvocationException e)
        {
            var inner = e.InnerException ?? e;
            Debug.LogException(inner);
            return inner.GetType().Name + ": " + inner.Message;
        }
        catch (Exception e)
        {
            return e.GetType().Name + ": " + e.Message;
        }
        if (obj != null)
        {
            EditorUtility.SetDirty(obj);
            if (save) AssetDatabase.SaveAssetIfDirty(obj);
        }
        output = TunerMethodOutput(mi, result);
        Debug.Log("[Tuner] invoked " + mi.DeclaringType.Name + "." + mi.Name + (obj != null ? " on " + assetPath : "")
            + (output != null ? " -> " + output : ""));
        return null;
    }

    static string Num(double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) return "null";
        return d.ToString("R", Inv);
    }

    static string Num(float f)
    {
        if (float.IsNaN(f) || float.IsInfinity(f)) return "null";
        return f.ToString("R", Inv);
    }

    static FieldInfo ResolveTunerField(Type rootType, string propertyPath, out Type type)
    {
        type = rootType;
        FieldInfo fi = null;
        var parts = propertyPath.Replace(".Array.data[", ".[").Split('.');
        foreach (var part in parts)
        {
            if (type == null) return null;
            if (part.StartsWith("[", StringComparison.Ordinal))
            {
                type = type.IsArray ? type.GetElementType()
                    : type.IsGenericType ? type.GetGenericArguments()[0] : null;
                continue;
            }
            fi = FindTunerField(type, part);
            if (fi == null)
            {
                type = null;
                return null;
            }
            type = fi.FieldType;
        }
        return fi;
    }

    static FieldInfo FindTunerField(Type t, string name)
    {
        const BindingFlags flags = BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;
        for (; t != null; t = t.BaseType)
        {
            var f = t.GetField(name, flags);
            if (f != null) return f;
        }
        return null;
    }

    static string ApplyTunerEditTo(UnityEngine.Object obj, string prop, string op, string value, int index)
    {
        var so = new SerializedObject(obj);
        so.UpdateIfRequiredOrScript();
        var p = so.FindProperty(prop ?? "");
        if (p == null) return "no serialized field '" + prop + "' on " + obj.GetType().Name;
        string err;
        switch (string.IsNullOrEmpty(op) ? "set" : op)
        {
            case "set":
                err = SetTunerValue(p, value ?? "");
                break;
            case "arrayInsert":
                if (!p.isArray || p.propertyType == SerializedPropertyType.String) { err = prop + " is not an array"; break; }
                p.InsertArrayElementAtIndex(index < 0 || index > p.arraySize ? p.arraySize : index);
                err = null;
                break;
            case "arrayDelete":
                if (!p.isArray || p.propertyType == SerializedPropertyType.String) { err = prop + " is not an array"; break; }
                if (index < 0 || index >= p.arraySize) { err = "index " + index + " out of range"; break; }
                p.DeleteArrayElementAtIndex(index);
                err = null;
                break;
            default:
                err = "unknown op '" + op + "'";
                break;
        }
        if (err != null) return err;
        so.ApplyModifiedProperties();
        return null;
    }

    static string SetTunerValue(SerializedProperty p, string value)
    {
        try
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Integer:
                    p.longValue = (long)Math.Round(double.Parse(value, NumberStyles.Float, Inv));
                    return null;
                case SerializedPropertyType.Float:
                    p.doubleValue = double.Parse(value, NumberStyles.Float, Inv);
                    return null;
                case SerializedPropertyType.Boolean:
                    p.boolValue = value == "true" || value == "1";
                    return null;
                case SerializedPropertyType.String:
                    p.stringValue = value;
                    return null;
                case SerializedPropertyType.Enum:
                {
                    Type ft;
                    ResolveTunerField(p.serializedObject.targetObject.GetType(), p.propertyPath, out ft);
                    int n = int.Parse(value, Inv);
                    if (ft != null && ft.IsEnum && ft.IsDefined(typeof(FlagsAttribute), false)) p.enumValueFlag = n;
                    else p.enumValueIndex = n;
                    return null;
                }
                case SerializedPropertyType.LayerMask:
                    p.intValue = int.Parse(value, Inv);
                    return null;
                case SerializedPropertyType.Color:
                {
                    var v = Floats(value, 4);
                    p.colorValue = new Color(v[0], v[1], v[2], v[3]);
                    return null;
                }
                case SerializedPropertyType.Vector2:
                {
                    var v = Floats(value, 2);
                    p.vector2Value = new Vector2(v[0], v[1]);
                    return null;
                }
                case SerializedPropertyType.Vector3:
                {
                    var v = Floats(value, 3);
                    p.vector3Value = new Vector3(v[0], v[1], v[2]);
                    return null;
                }
                case SerializedPropertyType.Vector4:
                {
                    var v = Floats(value, 4);
                    p.vector4Value = new Vector4(v[0], v[1], v[2], v[3]);
                    return null;
                }
                case SerializedPropertyType.Quaternion:
                {
                    var v = Floats(value, 4);
                    var q = new Quaternion(v[0], v[1], v[2], v[3]);
                    float mag = Mathf.Sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
                    if (mag < 1e-6f) return "quaternion '" + value + "' has zero length";
                    p.quaternionValue = new Quaternion(q.x / mag, q.y / mag, q.z / mag, q.w / mag);
                    return null;
                }
                case SerializedPropertyType.Vector2Int:
                {
                    var v = Floats(value, 2);
                    p.vector2IntValue = new Vector2Int(Mathf.RoundToInt(v[0]), Mathf.RoundToInt(v[1]));
                    return null;
                }
                case SerializedPropertyType.Vector3Int:
                {
                    var v = Floats(value, 3);
                    p.vector3IntValue = new Vector3Int(Mathf.RoundToInt(v[0]), Mathf.RoundToInt(v[1]), Mathf.RoundToInt(v[2]));
                    return null;
                }
                default:
                    return p.propertyPath + " (" + p.propertyType + ") cannot be edited from the Tuner";
            }
        }
        catch (FormatException)
        {
            return "cannot parse '" + value + "' for " + p.propertyPath + " (" + p.propertyType + ")";
        }
        catch (OverflowException)
        {
            return "value '" + value + "' is out of range for " + p.propertyPath;
        }
    }

    static float[] Floats(string csv, int count)
    {
        var parts = csv.Split(',');
        if (parts.Length != count) throw new FormatException();
        var r = new float[count];
        for (int i = 0; i < count; i++) r[i] = float.Parse(parts[i].Trim(), NumberStyles.Float, Inv);
        return r;
    }
}
