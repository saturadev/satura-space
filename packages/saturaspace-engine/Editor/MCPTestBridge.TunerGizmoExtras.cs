using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public static partial class MCPTestBridge
{
    const float TUNER_PROBE_RADIUS_PX = 7f;
    static readonly Color TunerProbeCellColor = new Color(1f, 1f, 1f, 0.35f);
    static readonly Color TunerProbeLinkColor = new Color(1f, 0.92f, 0.016f, 1f);
    static readonly Color[] TunerLodColors =
    {
        new Color(0.4831376f, 0.6211768f, 0.0219608f, 1.0f),
        new Color(0.2792160f, 0.4078432f, 0.5835296f, 1.0f),
        new Color(0.2070592f, 0.5333336f, 0.6556864f, 1.0f),
        new Color(0.5333336f, 0.1600000f, 0.0282352f, 1.0f),
        new Color(0.3827448f, 0.2886272f, 0.5239216f, 1.0f),
        new Color(0.8000000f, 0.4423528f, 0.0000000f, 1.0f),
        new Color(0.4486272f, 0.4078432f, 0.0501960f, 1.0f),
        new Color(0.7749016f, 0.6368624f, 0.0250984f, 1.0f)
    };
    static readonly Color TunerCulledLodColor = new Color(.4f, 0f, 0f, 1f);

    static Vector3[] _tunerProbeTetPos;
    static int[] _tunerProbeTets;
    static int[] _tunerProbeEdges;
    static int _tunerProbeKey;
    static GUIStyle _tunerLodLabelStyle;
    static Texture2D _tunerLodLabelBg;
    static GUIStyle _tunerProbeWeightStyle;
    static readonly Vector3[] _tunerShDir = new Vector3[1];
    static readonly Color[] _tunerShOut = new Color[1];
    static readonly List<Renderer> _tunerProbeRends = new List<Renderer>();

    static float TunerWorldPerPixel(TunerSession s, Vector3 p)
    {
        float h = Mathf.Max(1, s.Height);
        if (s.Ortho > 0f) return 2f * s.Ortho / h;
        float d = Mathf.Max(1e-3f, Vector3.Dot(p - s.CamPos, s.CamRot * Vector3.forward));
        return 2f * d * Mathf.Tan(s.Fov * 0.5f * Mathf.Deg2Rad) / h;
    }

    static void DrawTunerGizmoExtras(TunerSession s, TunerViewState v, GameObject sel, double now)
    {
        var anno = TunerAnnotations(now);
        if (anno.LodLabels && sel != null) DrawTunerLodLabel(s, v, sel);
        if (anno.ProbeMode != 3) DrawTunerLightProbes(s, v, sel, anno);
    }

    static void DrawTunerLodLabel(TunerSession s, TunerViewState v, GameObject sel)
    {
        var g = sel.GetComponent<LODGroup>();
        if (g == null) return;
        int gi = s.Lods.IndexOf(g);
        if (gi < 0) return;
        var place = s.LodPlace[gi];
        if (place.Gone) return;
        var fwd = s.CamRot * Vector3.forward;
        if (Vector3.Dot(fwd, (s.CamPos - place.Point).normalized) > 0f) return;
        int level = s.LodActive[gi];
        int count = g.lodCount;
        ResetTunerGizmoState();
        Handles.color = level >= 0 ? TunerLodColors[Mathf.Min(level, TunerLodColors.Length - 1)] : TunerCulledLodColor;
        Handles.SelectionFrame(0, place.Point, s.CamRot, place.Size / 2f);
        var below = place.Point - s.CamRot * Vector3.up * (place.Size / 2f);
        var label = level >= 0 ? "LOD " + level.ToString(Inv) : "Culled";
        if (_tunerLodLabelStyle == null)
        {
            _tunerLodLabelStyle = new GUIStyle(EditorStyles.boldLabel)
            {
                alignment = TextAnchor.UpperCenter,
                fontSize = 20,
                padding = new RectOffset(12, 12, 8, 8),
                fixedWidth = 200,
                fixedHeight = 45
            };
            _tunerLodLabelStyle.normal.textColor = Color.white;
            if (_tunerLodLabelBg == null)
            {
                _tunerLodLabelBg = new Texture2D(1, 1, TextureFormat.RGBA32, false) { hideFlags = HideFlags.HideAndDontSave };
                _tunerLodLabelBg.SetPixel(0, 0, new Color(0.11f, 0.11f, 0.11f, 0.82f));
                _tunerLodLabelBg.Apply(false);
            }
            _tunerLodLabelStyle.normal.background = _tunerLodLabelBg;
        }
        Handles.Label(below, label, _tunerLodLabelStyle);
        TunerGizmoNote(v, "lod:label:" + label + "/" + count.ToString(Inv));
    }

    static bool EnsureTunerProbeCells(Vector3[] pos)
    {
        int key = pos.Length;
        for (int i = 0; i < pos.Length; i += Math.Max(1, pos.Length / 16)) key = key * 31 + pos[i].GetHashCode();
        if (_tunerProbeTets != null && key == _tunerProbeKey) return true;
        _tunerProbeKey = key;
        _tunerProbeTets = null;
        _tunerProbeEdges = null;
        try
        {
            int[] tets;
            Vector3[] outPos;
            Lightmapping.Tetrahedralize(pos, out tets, out outPos);
            _tunerProbeTets = tets ?? new int[0];
            _tunerProbeTetPos = outPos ?? pos;
            var seen = new HashSet<long>();
            var edges = new List<int>();
            for (int t = 0; t + 3 < _tunerProbeTets.Length; t += 4)
                for (int a = 0; a < 4; a++)
                    for (int b = a + 1; b < 4; b++)
                    {
                        int i0 = _tunerProbeTets[t + a], i1 = _tunerProbeTets[t + b];
                        if (i0 > i1) { var tmp = i0; i0 = i1; i1 = tmp; }
                        if (seen.Add(((long)i0 << 32) | (uint)i1))
                        {
                            edges.Add(i0);
                            edges.Add(i1);
                        }
                    }
            _tunerProbeEdges = edges.ToArray();
        }
        catch (Exception e)
        {
            Debug.LogWarning("[Tuner] light probe cells are unavailable: " + e.Message);
            _tunerProbeTets = new int[0];
            _tunerProbeEdges = new int[0];
            _tunerProbeTetPos = pos;
        }
        return true;
    }

    static Color TunerProbeColor(SphericalHarmonicsL2[] sh, int i, Vector3 toCam)
    {
        if (sh == null || i < 0 || i >= sh.Length) return Color.grey;
        _tunerShDir[0] = toCam;
        sh[i].Evaluate(_tunerShDir, _tunerShOut);
        var c = _tunerShOut[0];
        if (QualitySettings.activeColorSpace == ColorSpace.Linear) c = c.gamma;
        c.a = 1f;
        return c;
    }

    static void DrawTunerProbe(TunerSession s, Vector3 p, SphericalHarmonicsL2[] sh, int i)
    {
        Gizmos.color = TunerProbeColor(sh, i, (s.CamPos - p).normalized);
        Gizmos.DrawSphere(p, TunerWorldPerPixel(s, p) * TUNER_PROBE_RADIUS_PX);
    }

    static void DrawTunerLightProbes(TunerSession s, TunerViewState v, GameObject sel, TunerAnnoState anno)
    {
        if (SupportedRenderingFeatures.active.overridesLightProbeSystem) return;
        var lp = LightmapSettings.lightProbes;
        if (lp == null || lp.count == 0) return;
        var pos = lp.positions;
        var sh = lp.bakedProbes;
        ResetTunerGizmoState();
        if (anno.ProbeMode == 1 || anno.ProbeMode == 2)
        {
            if (anno.ProbeMode == 2 && EnsureTunerProbeCells(pos))
            {
                Handles.color = TunerProbeCellColor;
                Handles.zTest = CompareFunction.LessEqual;
                var tp = _tunerProbeTetPos;
                for (int e = 0; e + 1 < _tunerProbeEdges.Length; e += 2) Handles.DrawLine(tp[_tunerProbeEdges[e]], tp[_tunerProbeEdges[e + 1]]);
                ResetTunerGizmoState();
            }
            for (int i = 0; i < pos.Length; i++) DrawTunerProbe(s, pos[i], sh, i);
            v.GizmoCur = null;
            TunerGizmoNote(v, "probes:" + (anno.ProbeMode == 2 ? "cells:" : "all:") + pos.Length.ToString(Inv));
            return;
        }
        if (sel == null || !EnsureTunerProbeCells(pos) || _tunerProbeTets.Length == 0) return;
        _tunerProbeRends.Clear();
        foreach (var go in v.SelectedSet)
        {
            if (go == null || !go.activeInHierarchy) continue;
            var r = go.GetComponent<Renderer>();
            if (r != null && r.enabled && r.lightProbeUsage == LightProbeUsage.BlendProbes) _tunerProbeRends.Add(r);
        }
        if (!v.SelectedSet.Contains(sel))
        {
            var r = sel.GetComponent<Renderer>();
            if (r != null && r.enabled && r.lightProbeUsage == LightProbeUsage.BlendProbes) _tunerProbeRends.Add(r);
        }
        int drawn = 0;
        var tpos = _tunerProbeTetPos;
        bool sameOrder = tpos.Length == pos.Length;
        foreach (var r in _tunerProbeRends)
        {
            var anchor = r.probeAnchor != null ? r.probeAnchor.position : r.bounds.center;
            int tet;
            Vector4 w;
            if (!FindTunerProbeTet(anchor, out tet, out w)) continue;
            for (int k = 0; k < 4; k++)
            {
                int pi = _tunerProbeTets[tet + k];
                var p = tpos[pi];
                Handles.color = TunerProbeLinkColor;
                Handles.zTest = CompareFunction.Always;
                Handles.DrawLine(anchor, p);
                DrawTunerProbe(s, p, sh, sameOrder ? pi : -1);
                if (anno.ProbeWeights)
                {
                    if (_tunerProbeWeightStyle == null)
                    {
                        _tunerProbeWeightStyle = new GUIStyle(EditorStyles.miniBoldLabel) { alignment = TextAnchor.MiddleCenter };
                        _tunerProbeWeightStyle.normal.textColor = TunerProbeLinkColor;
                    }
                    Handles.Label(Vector3.Lerp(anchor, p, 0.5f), w[k].ToString("0.00", Inv), _tunerProbeWeightStyle);
                }
            }
            ResetTunerGizmoState();
            drawn++;
        }
        if (drawn > 0)
        {
            v.GizmoCur = sel;
            TunerGizmoNote(v, "probes:selection:" + drawn.ToString(Inv) + (anno.ProbeWeights ? ":weights" : ""));
        }
    }

    static bool FindTunerProbeTet(Vector3 p, out int tet, out Vector4 weights)
    {
        tet = -1;
        weights = default;
        var tp = _tunerProbeTetPos;
        var tets = _tunerProbeTets;
        float bestOut = float.MaxValue;
        for (int t = 0; t + 3 < tets.Length; t += 4)
        {
            Vector3 a = tp[tets[t]], b = tp[tets[t + 1]], c = tp[tets[t + 2]], d = tp[tets[t + 3]];
            var m = new Matrix4x4(
                new Vector4(a.x - d.x, a.y - d.y, a.z - d.z, 0f),
                new Vector4(b.x - d.x, b.y - d.y, b.z - d.z, 0f),
                new Vector4(c.x - d.x, c.y - d.y, c.z - d.z, 0f),
                new Vector4(0f, 0f, 0f, 1f));
            if (Mathf.Abs(m.determinant) < 1e-9f) continue;
            var l = m.inverse.MultiplyVector(p - d);
            var w = new Vector4(l.x, l.y, l.z, 1f - l.x - l.y - l.z);
            float outside = Mathf.Max(0f, -Mathf.Min(Mathf.Min(w.x, w.y), Mathf.Min(w.z, w.w)));
            if (outside < bestOut)
            {
                bestOut = outside;
                tet = t;
                weights = w;
                if (outside <= 1e-4f) break;
            }
        }
        if (tet < 0) return false;
        if (bestOut > 1e-4f)
        {
            float x = Mathf.Max(0f, weights.x), y = Mathf.Max(0f, weights.y), z = Mathf.Max(0f, weights.z), q = Mathf.Max(0f, weights.w);
            float sum = Mathf.Max(1e-6f, x + y + z + q);
            weights = new Vector4(x / sum, y / sum, z / sum, q / sum);
        }
        return true;
    }
}
