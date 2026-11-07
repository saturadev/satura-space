using System;
using System.Collections.Generic;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

public static partial class MCPTestBridge
{
    const float TUNER_OUTLINE_GAIN = 8.75f;
    const int TUNER_PASS_MASK = 0;
    const int TUNER_PASS_BLUR = 1;
    const int TUNER_PASS_COMPOSITE = 2;
    const int TUNER_PASS_PICK_OPAQUE = 3;
    const int TUNER_PASS_OPAQUE_ALPHA = 4;
    const int TUNER_PASS_PICK_TRANSPARENT = 5;
    const float TUNER_OUTLINE_ALPHA_CLIP = 0.01f;
    static readonly Color TunerOutlineParentDefault = new Color(255f / 255f, 102f / 255f, 0f / 255f, 1f);
    static readonly Color TunerOutlineChildDefault = new Color(94f / 255f, 119f / 255f, 155f / 255f, 1f);
    static readonly Vector4 TunerMaskParent = new Vector4(1f, 0f, 0f, 0f);
    static readonly Vector4 TunerMaskChild = new Vector4(0f, 1f, 0f, 0f);

    static Vector4 TunerOutlineColor(Color c)
    {
        var o = QualitySettings.activeColorSpace == ColorSpace.Linear ? c.linear : c;
        return new Vector4(o.r, o.g, o.b, 1f);
    }

    static void SealTunerAlpha(TunerSession s)
    {
        var mat = TunerViewMaterial();
        if (mat == null || s.Target == null) return;
        var prev = RenderTexture.active;
        Graphics.Blit(Texture2D.whiteTexture, s.Target, mat, TUNER_PASS_OPAQUE_ALPHA);
        RenderTexture.active = prev;
    }

    static float TunerCoverageClip(TunerDraw d)
    {
        if (d.Cutoff >= 0f) return Mathf.Max(d.Cutoff, TUNER_OUTLINE_ALPHA_CLIP);
        if (d.Transparent || d.Flat || d.Rend.Kind != TunerKind.Mesh) return TUNER_OUTLINE_ALPHA_CLIP;
        return -1f;
    }

    static void CollectTunerMarkedDraws(TunerSession s, TunerViewState v, double now)
    {
        if (v.MarkedDrawsTree == v.MarkedTreeGen && v.MarkedDrawsGen == s.DrawsGen && v.MarkedDrawsCount == s.Draws.Count) return;
        v.MarkedDrawsTree = v.MarkedTreeGen;
        v.MarkedDrawsGen = s.DrawsGen;
        v.MarkedDrawsCount = s.Draws.Count;
        v.MarkedDraws.Clear();
        v.MarkedRoles.Clear();
        if (v.MarkedTree.Count == 0) return;
        foreach (var d in s.Draws)
        {
            var go = d.Rend.Go;
            if (ReferenceEquals(go, null) || !v.MarkedTree.Contains(go)) continue;
            v.MarkedDraws.Add(d);
            v.MarkedRoles.Add(v.MarkedSet.Contains(go) ? 1 : 2);
        }
    }

    static void RecordTunerOutline(TunerSession s, CommandBuffer cmd, double now)
    {
        long start = System.Diagnostics.Stopwatch.GetTimestamp();
        RecordTunerOutlineInner(s, cmd, now);
        var st = TunerViewOf(s, true).Stats;
        NoteTunerStat(ref st.Outline, ref st.OutlineMax, System.Diagnostics.Stopwatch.GetTimestamp() - start);
    }

    static void RecordTunerOutlineInner(TunerSession s, CommandBuffer cmd, double now)
    {
        var v = TunerViewOf(s, false);
        var marked = v != null ? ResolveTunerMarked(s, v, now) : null;
        if (marked == null || marked.Count == 0)
        {
            if (v != null) LogTunerViewChange(s, ref v.OutlineReport, null);
            return;
        }
        if (!TunerAnnotations(now).Outline)
        {
            LogTunerViewChange(s, ref v.OutlineReport, "outline: off (Selection Outline)");
            return;
        }
        var mat = TunerViewMaterial();
        if (mat == null) return;
        CollectTunerMarkedDraws(s, v, now);
        int parents = 0, children = 0;
        TunerDraw first = null;
        for (int i = 0; i < v.MarkedDraws.Count; i++)
        {
            if (!TunerDrawReady(v.MarkedDraws[i]) || TunerCulledFar(v, v.MarkedDraws[i].Rend.R)) continue;
            if (first == null) first = v.MarkedDraws[i];
            if (v.MarkedRoles[i] == 1) parents++;
            else children++;
        }
        LogTunerViewChange(s, ref v.OutlineReport, "outline: " + TunerMarkedNames(s, v) + " parent draws " + parents + ", child draws " + children
            + (v.MarkedGhosts > 0 ? ", ghosts " + v.MarkedGhosts : "") + (SaturaDebug.On && first != null ? ", mask at " + TunerMaskAt(first) : ""));
        if (parents + children == 0) return;
        int w = s.Width, h = s.Height;
        if (EnsureTunerViewTexture(ref v.Mask, w, h, RenderTextureFormat.ARGB32, 0) == null) return;
        if (EnsureTunerViewTexture(ref v.BlurA, w, h, RenderTextureFormat.ARGBHalf, 0) == null) return;
        if (EnsureTunerViewTexture(ref v.BlurB, w, h, RenderTextureFormat.ARGBHalf, 0) == null) return;
        Matrix4x4 view, proj;
        TunerViewMatrices(s, w, h, out view, out proj);
        cmd.SetRenderTarget(v.Mask);
        cmd.ClearRenderTarget(false, true, Color.clear);
        cmd.SetViewProjectionMatrices(view, proj);
        for (int i = 0; i < v.MarkedDraws.Count; i++)
        {
            var d = v.MarkedDraws[i];
            if (!TunerDrawReady(d) || TunerCulledFar(v, d.Rend.R)) continue;
            int role = v.MarkedRoles[i];
            cmd.SetGlobalVector(TunerMaskColorId, role == 1 ? TunerMaskParent : TunerMaskChild);
            cmd.SetGlobalFloat(TunerClipId, TunerCoverageClip(d));
            RecordTunerDraw(s, cmd, d, mat, TUNER_PASS_MASK, now);
        }
        cmd.SetGlobalVector(TunerBlurDirId, new Vector4(1f, 0f, 0f, 0f));
        cmd.Blit(v.Mask, v.BlurA, mat, TUNER_PASS_BLUR);
        cmd.SetGlobalVector(TunerBlurDirId, new Vector4(0f, 1f, 0f, 0f));
        cmd.Blit(v.BlurA, v.BlurB, mat, TUNER_PASS_BLUR);
        cmd.SetGlobalTexture(TunerMaskTexId, v.Mask);
        TunerTheme theme;
        _tunerThemes.TryGetValue(s, out theme);
        cmd.SetGlobalVector(TunerParentColorId, TunerOutlineColor(theme != null ? theme.Outline : TunerOutlineParentDefault));
        cmd.SetGlobalVector(TunerChildColorId, TunerOutlineColor(theme != null ? theme.OutlineChild : TunerOutlineChildDefault));
        cmd.SetGlobalFloat(TunerOutlineGainId, TUNER_OUTLINE_GAIN);
        cmd.Blit(v.BlurB, s.Target, mat, TUNER_PASS_COMPOSITE);
        cmd.SetRenderTarget(s.Target);
        cmd.SetViewProjectionMatrices(view, proj);
    }

    static string TunerMaskAt(TunerDraw d)
    {
        var e = d.Rend;
        Vector3 p = e.Kind == TunerKind.Mesh ? (e.R != null ? e.R.bounds.center : Vector3.zero) : (Vector3)d.Matrix.GetColumn(3);
        return TunerTuple(p.x, p.y, p.z);
    }

    static readonly Color TunerSelectedWireDefault = new Color(94f / 255f, 119f / 255f, 155f / 255f, 64f / 255f);
    static Material _tunerWireMat;
    static CommandBuffer _tunerWireCmd;

    static Color TunerSelectedWireColor()
    {
        var raw = EditorPrefs.GetString("Scene/Wireframe Selected", "");
        var parts = raw.Split(';');
        float r, g, b, a;
        if (parts.Length == 5 && float.TryParse(parts[1], System.Globalization.NumberStyles.Float, Inv, out r) && float.TryParse(parts[2], System.Globalization.NumberStyles.Float, Inv, out g)
            && float.TryParse(parts[3], System.Globalization.NumberStyles.Float, Inv, out b) && float.TryParse(parts[4], System.Globalization.NumberStyles.Float, Inv, out a))
            return new Color(r, g, b, a);
        return TunerSelectedWireDefault;
    }

    static void DrawTunerSelectionWire(TunerSession s, double now)
    {
        var v = TunerViewOf(s, false);
        if (v == null) return;
        var marked = ResolveTunerMarked(s, v, now);
        if (marked == null || marked.Count == 0 || !TunerAnnotations(now).Wire)
        {
            LogTunerViewChange(s, ref v.WireReport, marked != null && marked.Count > 0 ? "wire: off (Selection Wire)" : null);
            return;
        }
        if (_tunerWireMat == null)
        {
            var sh = Shader.Find("Hidden/Internal-Colored");
            if (sh == null) return;
            _tunerWireMat = new Material(sh) { name = "_SaturaTunerWire", hideFlags = HideFlags.HideAndDontSave };
            _tunerWireMat.SetInt("_SrcBlend", (int)BlendMode.SrcAlpha);
            _tunerWireMat.SetInt("_DstBlend", (int)BlendMode.OneMinusSrcAlpha);
            _tunerWireMat.SetInt("_Cull", (int)CullMode.Back);
            _tunerWireMat.SetInt("_ZWrite", 0);
            _tunerWireMat.SetInt("_ZTest", (int)CompareFunction.LessEqual);
            _tunerWireMat.SetFloat("_ZBias", -1f);
        }
        _tunerWireMat.SetColor("_Color", TunerSelectedWireColor());
        if (_tunerWireCmd == null) _tunerWireCmd = new CommandBuffer { name = "SaturaTunerWire" };
        var cmd = _tunerWireCmd;
        cmd.Clear();
        Matrix4x4 view, proj;
        TunerViewMatrices(s, s.Width, s.Height, out view, out proj);
        cmd.SetRenderTarget(s.Target);
        cmd.SetViewProjectionMatrices(view, proj);
        CollectTunerMarkedDraws(s, v, now);
        int n = 0;
        foreach (var d in v.MarkedDraws)
        {
            if (d.Rend.Kind != TunerKind.Mesh || !TunerDrawReady(d) || TunerCulledFar(v, d.Rend.R)) continue;
            RecordTunerDraw(s, cmd, d, _tunerWireMat, 0, now);
            n++;
        }
        LogTunerViewChange(s, ref v.WireReport, "wire: " + TunerMarkedNames(s, v) + " draws " + n);
        if (n == 0) return;
        var prev = RenderTexture.active;
        GL.wireframe = true;
        try { Graphics.ExecuteCommandBuffer(cmd); }
        finally
        {
            GL.wireframe = false;
            RenderTexture.active = prev;
        }
    }
}
