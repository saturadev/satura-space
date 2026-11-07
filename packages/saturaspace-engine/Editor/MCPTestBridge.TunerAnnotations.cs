using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const double TUNER_ANNO_INTERVAL = 1.0;
    const int TUNER_ANNO_THUMB = 32;
    const string TUNER_TERRAIN_WARNINGS_PREF = "Terrain.ShowDebugWarnings";

    [Serializable]
    class TunerAnnoArgs
    {
        public string session;
        public string op;
        public string key;
        public bool on;
        public float value;
        public bool recent = true;
        public int[] classIDs;
        public string[] scripts;
        public string[] have;
    }

    [Serializable]
    class TunerAnnoCommand
    {
        public int id;
        public TunerAnnoArgs args;
    }

    class TunerAnnoState
    {
        public bool Use3d = true;
        public float IconSize = 0.03f;
        public bool Fade;
        public float FadeSize = 5f;
        public bool Outline = true;
        public bool Wire;
        public bool LodLabels = true;
        public int ProbeMode = 3;
        public bool ProbeWeights;
        public bool ProbeOcclusion;
        public bool ProbeInvalid;
        public double At = -1;
        public int Gen;
    }

    static readonly TunerAnnoState _tunerAnno = new TunerAnnoState();
    static readonly Dictionary<string, string> _tunerAnnoThumbs = new Dictionary<string, string>();
    static Type _tunerAnnoType;
    static Type _tunerProbeVisType;
    static bool _tunerAnnoKnown;
    static MethodInfo _tunerAnnoGetAll;
    static MethodInfo _tunerAnnoGetRecent;
    static MethodInfo _tunerAnnoSetGizmo;
    static MethodInfo _tunerAnnoSetIcon;
    static MethodInfo _tunerAnnoCanHideLod;
    static FieldInfo _tunerGizmoInfoClass;
    static FieldInfo _tunerGizmoInfoScript;
    static FieldInfo _tunerGizmoInfoFlags;

    const BindingFlags TunerAnnoFlags = BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public;

    static bool EnsureTunerAnnoReflection()
    {
        if (_tunerAnnoKnown) return _tunerAnnoType != null;
        _tunerAnnoKnown = true;
        try
        {
            _tunerAnnoType = typeof(Editor).Assembly.GetType("UnityEditor.AnnotationUtility");
            _tunerProbeVisType = typeof(Editor).Assembly.GetType("UnityEditor.LightProbeVisualization");
            if (_tunerAnnoType != null)
            {
                _tunerAnnoGetAll = _tunerAnnoType.GetMethod("GetAnnotations", TunerAnnoFlags);
                _tunerAnnoGetRecent = _tunerAnnoType.GetMethod("GetRecentlyChangedAnnotations", TunerAnnoFlags);
                _tunerAnnoSetGizmo = _tunerAnnoType.GetMethod("SetGizmoEnabled", TunerAnnoFlags);
                _tunerAnnoSetIcon = _tunerAnnoType.GetMethod("SetIconEnabled", TunerAnnoFlags);
                _tunerAnnoCanHideLod = _tunerAnnoType.GetMethod("CanHideLODLabels", TunerAnnoFlags);
            }
            const BindingFlags inst = BindingFlags.Instance | BindingFlags.NonPublic;
            _tunerGizmoInfoClass = typeof(GizmoInfo).GetField("m_ClassID", inst);
            _tunerGizmoInfoScript = typeof(GizmoInfo).GetField("m_ScriptClass", inst);
            _tunerGizmoInfoFlags = typeof(GizmoInfo).GetField("m_Flags", inst);
        }
        catch (Exception e) { Debug.LogWarning("[Tuner] Unity's gizmo settings are not reachable: " + e.Message); }
        if (_tunerAnnoType == null || _tunerAnnoGetAll == null || _tunerAnnoSetGizmo == null || _tunerAnnoSetIcon == null || _tunerGizmoInfoClass == null)
        {
            Debug.LogWarning("[Tuner] AnnotationUtility was not found, the Gizmos menu uses defaults");
            _tunerAnnoType = null;
        }
        return _tunerAnnoType != null;
    }

    static object TunerAnnoGet(Type t, string name)
    {
        if (t == null) return null;
        try
        {
            var p = t.GetProperty(name, TunerAnnoFlags);
            return p != null ? p.GetValue(null, null) : null;
        }
        catch { return null; }
    }

    static void TunerAnnoPut(Type t, string name, object value)
    {
        if (t == null) return;
        var p = t.GetProperty(name, TunerAnnoFlags);
        if (p == null) throw new MissingMemberException(t.Name + "." + name);
        if (p.PropertyType.IsEnum) value = Enum.ToObject(p.PropertyType, Convert.ToInt32(value));
        p.SetValue(null, value, null);
    }

    static bool TunerAnnoBool(Type t, string name, bool fallback)
    {
        var o = TunerAnnoGet(t, name);
        return o is bool b ? b : fallback;
    }

    static float TunerAnnoFloat(Type t, string name, float fallback)
    {
        var o = TunerAnnoGet(t, name);
        return o is float f ? f : fallback;
    }

    static TunerAnnoState TunerAnnotations(double now)
    {
        var a = _tunerAnno;
        if (a.At >= 0 && now - a.At < TUNER_ANNO_INTERVAL) return a;
        a.At = now;
        if (!EnsureTunerAnnoReflection()) return a;
        bool use3d = TunerAnnoBool(_tunerAnnoType, "use3dGizmos", a.Use3d);
        float size = TunerAnnoFloat(_tunerAnnoType, "iconSize", a.IconSize);
        bool fade = TunerAnnoBool(_tunerAnnoType, "fadeGizmos", a.Fade);
        float fadeSize = TunerAnnoFloat(_tunerAnnoType, "fadeGizmoSize", a.FadeSize);
        bool outline = TunerAnnoBool(_tunerAnnoType, "showSelectionOutline", a.Outline);
        bool wire = TunerAnnoBool(_tunerAnnoType, "showSelectionWire", a.Wire);
        bool lod = TunerAnnoBool(_tunerAnnoType, "showLODLabels", a.LodLabels);
        var mode = TunerAnnoGet(_tunerProbeVisType, "lightProbeVisualizationMode");
        int probeMode = mode != null ? Convert.ToInt32(mode) : a.ProbeMode;
        bool weights = TunerAnnoBool(_tunerProbeVisType, "showInterpolationWeights", a.ProbeWeights);
        bool occlusion = TunerAnnoBool(_tunerProbeVisType, "showOcclusions", a.ProbeOcclusion);
        bool invalid = TunerAnnoBool(_tunerProbeVisType, "highlightInvalidCells", a.ProbeInvalid);
        if (use3d != a.Use3d || size != a.IconSize || fade != a.Fade || fadeSize != a.FadeSize || outline != a.Outline || wire != a.Wire || lod != a.LodLabels
            || probeMode != a.ProbeMode || weights != a.ProbeWeights || occlusion != a.ProbeOcclusion || invalid != a.ProbeInvalid)
        {
            a.Use3d = use3d;
            a.IconSize = size;
            a.Fade = fade;
            a.FadeSize = fadeSize;
            a.Outline = outline;
            a.Wire = wire;
            a.LodLabels = lod;
            a.ProbeMode = probeMode;
            a.ProbeWeights = weights;
            a.ProbeOcclusion = occlusion;
            a.ProbeInvalid = invalid;
            a.Gen++;
        }
        return a;
    }

    static bool HandleTunerAnnotations(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/annotations") return false;
        TunerAnnoCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerAnnoCommand>(line); }
        catch (Exception e)
        {
            TunerResult(from, id, "bad arguments: " + e.Message, null);
            return true;
        }
        var a = parsed != null ? parsed.args : null;
        var s = a != null ? FindTuner(a.session) : null;
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + (a != null ? a.session : "") + "'", null);
            return true;
        }
        if (!EnsureTunerAnnoReflection())
        {
            TunerResult(from, id, "Unity's gizmo settings are not reachable in this editor version", null);
            return true;
        }
        string err = null;
        try
        {
            if (a.op == "general") err = TunerAnnoSetGeneral(s, a);
            else if (a.op == "icon" || a.op == "gizmo") err = TunerAnnoSetItems(s, a);
            else if (a.op != "get") err = "unknown op '" + a.op + "'";
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            err = inner.Message;
        }
        if (err != null)
        {
            TunerResult(from, id, err, null);
            return true;
        }
        if (a.op != "get")
        {
            _tunerAnno.At = -1;
            _tunerGizmoInfo.Clear();
            foreach (var t in _tuners.Values)
            {
                t.IconsListAt = -1;
                t.Dirty = true;
            }
            SignalEditorTick();
        }
        TunerResult(from, id, null, "\"annotations\":" + TunerAnnotationsJson(a.have));
        return true;
    }

    static string TunerAnnoSetGeneral(TunerSession s, TunerAnnoArgs a)
    {
        switch (a.key)
        {
            case "use3dIcons": TunerAnnoPut(_tunerAnnoType, "use3dGizmos", a.on); break;
            case "iconSize": TunerAnnoPut(_tunerAnnoType, "iconSize", Mathf.Max(0f, a.value)); break;
            case "fadeGizmos": TunerAnnoPut(_tunerAnnoType, "fadeGizmos", a.on); break;
            case "fadeGizmoSize": TunerAnnoPut(_tunerAnnoType, "fadeGizmoSize", Mathf.Clamp(a.value, 2f, 10f)); break;
            case "selectionOutline": TunerAnnoPut(_tunerAnnoType, "showSelectionOutline", a.on); break;
            case "selectionWire": TunerAnnoPut(_tunerAnnoType, "showSelectionWire", a.on); break;
            case "lodLabels": TunerAnnoPut(_tunerAnnoType, "showLODLabels", a.on); break;
            case "terrainWarnings": EditorPrefs.SetBool(TUNER_TERRAIN_WARNINGS_PREF, a.on); break;
            case "probeMode": TunerAnnoPut(_tunerProbeVisType, "lightProbeVisualizationMode", Mathf.Clamp(Mathf.RoundToInt(a.value), 0, 3)); break;
            case "probeWeights": TunerAnnoPut(_tunerProbeVisType, "showInterpolationWeights", a.on); break;
            case "probeOcclusion": TunerAnnoPut(_tunerProbeVisType, "showOcclusions", a.on); break;
            case "probeInvalid": TunerAnnoPut(_tunerProbeVisType, "highlightInvalidCells", a.on); break;
            default: return "unknown gizmo setting '" + a.key + "'";
        }
        SaturaDebug.Log("[Tuner] " + s.Name + " gizmo setting " + a.key + " = " + (a.key == "iconSize" || a.key == "fadeGizmoSize" || a.key == "probeMode" ? a.value.ToString("0.#####", Inv) : OnOff(a.on)));
        return null;
    }

    static string TunerAnnoSetItems(TunerSession s, TunerAnnoArgs a)
    {
        int n = a.classIDs != null ? a.classIDs.Length : 0;
        if (n == 0 || a.scripts == null || a.scripts.Length != n) return "no components given";
        var names = new StringBuilder();
        for (int i = 0; i < n; i++)
        {
            var script = a.scripts[i] ?? "";
            if (a.op == "icon") _tunerAnnoSetIcon.Invoke(null, new object[] { a.classIDs[i], script, a.on ? 1 : 0 });
            else _tunerAnnoSetGizmo.Invoke(null, new object[] { a.classIDs[i], script, a.on ? 1 : 0, a.recent });
            if (i < 8) names.Append(i > 0 ? ", " : "").Append(script.Length > 0 ? script : "class " + a.classIDs[i].ToString(Inv));
        }
        if (n > 8) names.Append(" and ").Append((n - 8).ToString(Inv)).Append(" more");
        SaturaDebug.Log("[Tuner] " + s.Name + " gizmo " + a.op + " " + OnOff(a.on) + ": " + names);
        return null;
    }

    static string TunerAnnoKey(int classID, string script)
    {
        return string.IsNullOrEmpty(script) ? "c" + classID.ToString(Inv) : "s" + script;
    }

    static string TunerAnnotationsJson(string[] have)
    {
        var st = TunerAnnotations(EditorApplication.timeSinceStartup);
        var haveSet = have != null ? new HashSet<string>(have) : null;
        var sb = new StringBuilder(16384);
        bool canHideLod = true;
        try { if (_tunerAnnoCanHideLod != null) canHideLod = (bool)_tunerAnnoCanHideLod.Invoke(null, null); }
        catch { }
        bool probesSupported = !UnityEngine.Rendering.SupportedRenderingFeatures.active.overridesLightProbeSystem && _tunerProbeVisType != null;
        sb.Append("{\"use3dIcons\":").Append(st.Use3d ? "true" : "false")
          .Append(",\"iconSize\":").Append(Num(st.IconSize))
          .Append(",\"fadeGizmos\":").Append(st.Fade ? "true" : "false")
          .Append(",\"fadeGizmoSize\":").Append(Num(st.FadeSize))
          .Append(",\"selectionOutline\":").Append(st.Outline ? "true" : "false")
          .Append(",\"selectionWire\":").Append(st.Wire ? "true" : "false")
          .Append(",\"lodLabels\":").Append(st.LodLabels ? "true" : "false")
          .Append(",\"canHideLodLabels\":").Append(canHideLod ? "true" : "false")
          .Append(",\"terrainWarnings\":").Append(EditorPrefs.GetBool(TUNER_TERRAIN_WARNINGS_PREF, true) ? "true" : "false")
          .Append(",\"lightProbes\":{\"supported\":").Append(probesSupported ? "true" : "false")
          .Append(",\"mode\":").Append(st.ProbeMode.ToString(Inv))
          .Append(",\"weights\":").Append(st.ProbeWeights ? "true" : "false")
          .Append(",\"occlusion\":").Append(st.ProbeOcclusion ? "true" : "false")
          .Append(",\"invalidCells\":").Append(st.ProbeInvalid ? "true" : "false")
          .Append("},\"items\":[");
        var thumbs = new StringBuilder();
        int nThumbs = 0;
        GizmoInfo[] infos = GizmoUtility.GetGizmoInfo();
        int n = 0;
        foreach (var info in infos)
        {
            int classID = (int)_tunerGizmoInfoClass.GetValue(info);
            string script = (string)_tunerGizmoInfoScript.GetValue(info) ?? "";
            int flags = _tunerGizmoInfoFlags != null ? (int)_tunerGizmoInfoFlags.GetValue(info) : 0;
            var key = TunerAnnoKey(classID, script);
            string png = TunerAnnoThumb(key, info);
            if (n++ > 0) sb.Append(',');
            sb.Append("{\"k\":").Append(JStr(key))
              .Append(",\"c\":").Append(classID.ToString(Inv))
              .Append(",\"s\":").Append(JStr(script))
              .Append(",\"n\":").Append(JStr(info.name ?? ""))
              .Append(",\"f\":").Append(flags.ToString(Inv))
              .Append(",\"i\":").Append(info.iconEnabled ? "1" : "0")
              .Append(",\"g\":").Append(info.gizmoEnabled ? "1" : "0")
              .Append(",\"t\":").Append(png != null ? "1" : "0")
              .Append('}');
            if (png != null && (haveSet == null || !haveSet.Contains(key)))
            {
                if (nThumbs++ > 0) thumbs.Append(',');
                thumbs.Append(JStr(key)).Append(':').Append(JStr(png));
            }
        }
        sb.Append("],\"recent\":[");
        if (_tunerAnnoGetRecent != null)
        {
            try
            {
                var recent = (Array)_tunerAnnoGetRecent.Invoke(null, null);
                int k = 0;
                foreach (var r in recent)
                {
                    var rt = r.GetType();
                    int c = (int)rt.GetField("classID").GetValue(r);
                    var sc = (string)rt.GetField("scriptClass").GetValue(r);
                    if (k++ > 0) sb.Append(',');
                    sb.Append(JStr(TunerAnnoKey(c, sc)));
                }
            }
            catch { }
        }
        sb.Append("],\"thumbs\":{").Append(thumbs).Append("}}");
        return sb.ToString();
    }

    static string TunerAnnoThumb(string key, GizmoInfo info)
    {
        string png;
        if (_tunerAnnoThumbs.TryGetValue(key, out png)) return png;
        png = null;
        Texture tex = null;
        int prevSkin = -1;
        try
        {
            prevSkin = SetTunerEditorSkin();
            tex = info.thumb;
        }
        catch { }
        finally { if (prevSkin >= 0) _tunerSetSkin(prevSkin); }
        if (tex != null)
        {
            RenderTexture rt = null;
            Texture2D read = null;
            var prev = RenderTexture.active;
            try
            {
                rt = RenderTexture.GetTemporary(TUNER_ANNO_THUMB, TUNER_ANNO_THUMB, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
                RenderTexture.active = rt;
                GL.Clear(false, true, Color.clear);
                Graphics.Blit(tex, rt);
                RenderTexture.active = rt;
                read = new Texture2D(TUNER_ANNO_THUMB, TUNER_ANNO_THUMB, TextureFormat.RGBA32, false);
                read.ReadPixels(new Rect(0, 0, TUNER_ANNO_THUMB, TUNER_ANNO_THUMB), 0, 0, false);
                read.Apply(false);
                png = "data:image/png;base64," + Convert.ToBase64String(read.EncodeToPNG());
            }
            catch { png = null; }
            finally
            {
                RenderTexture.active = prev;
                if (rt != null) RenderTexture.ReleaseTemporary(rt);
                if (read != null) UnityEngine.Object.DestroyImmediate(read);
            }
        }
        _tunerAnnoThumbs[key] = png;
        return png;
    }
}
