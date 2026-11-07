using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const double TUNER_SIM_MAX_STEP = 0.1;
    const double TUNER_PARTICLES_INTERVAL = 0.25;

    static ulong MixTunerBaked(TunerRend e, ulong h)
    {
        switch (e.BakeR)
        {
            case ParticleSystemRenderer psr:
                if (e.Ps == null) return h;
                h = TunerMix(h, (uint)e.Ps.particleCount);
                h = TunerMix(h, e.Ps.time);
                h = TunerMix(h, (uint)psr.renderMode);
                h = TunerMix(h, e.Ps.trails.enabled ? 1u : 0u);
                return h;
            case LineRenderer lr:
                h = TunerMix(h, (uint)lr.positionCount);
                for (int k = 0; k < lr.positionCount; k++) h = TunerMix(h, lr.GetPosition(k));
                h = TunerMix(h, lr.widthMultiplier);
                h = TunerMix(h, lr.useWorldSpace ? 1u : 0u);
                return h;
            case TrailRenderer tr:
                h = TunerMix(h, (uint)tr.positionCount);
                for (int k = 0; k < tr.positionCount; k++) h = TunerMix(h, tr.GetPosition(k));
                h = TunerMix(h, tr.widthMultiplier);
                return h;
        }
        return h;
    }

    static ParticleSystem TunerParticleRoot(GameObject go)
    {
        if (go == null) return null;
        ParticleSystem top = null;
        for (var t = go.transform; t != null; t = t.parent)
        {
            if (t.TryGetComponent<ParticleSystem>(out var ps)) top = ps;
        }
        return top;
    }

    static void StopTunerParticles(TunerSession s)
    {
        var ps = s.SimPs;
        s.SimPs = null;
        if (ps == null || EditorApplication.isPlaying) return;
        ps.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
        ps.Clear(true);
        s.Dirty = true;
    }

    static void TickTunerParticles(TunerSession s, double now, bool playing)
    {
        var v = TunerViewOf(s, false);
        var root = v == null ? null : TunerParticleRoot(ResolveTunerSelection(s, v, now));
        if (playing)
        {
            s.SimPs = null;
            s.PlayPs = root;
        }
        else
        {
            s.PlayPs = null;
            if (root != s.SimPs)
            {
                StopTunerParticles(s);
                s.SimPs = root;
                s.SimAt = now;
                s.SimPaused = false;
                s.SimStopped = false;
                if (root != null) root.Simulate(0f, true, true, false);
            }
            if (root != null && root.gameObject.activeInHierarchy && !s.SimPaused && !s.SimStopped)
            {
                double dt = now - s.SimAt;
                if (dt >= TUNER_FRAME_INTERVAL * 0.5)
                {
                    s.SimAt = now;
                    if (dt > TUNER_SIM_MAX_STEP) dt = TUNER_SIM_MAX_STEP;
                    root.Simulate((float)(dt * s.SimSpeed), true, false, false);
                }
                WakeTunerAt(now + TUNER_FRAME_INTERVAL, now);
            }
            else s.SimAt = now;
        }
        EmitTunerParticles(s, playing ? s.PlayPs : s.SimPs, playing, now);
    }

    static void EmitTunerParticles(TunerSession s, ParticleSystem root, bool playing, double now)
    {
        if (root == null)
        {
            if (!s.ParticlesSent) return;
            s.ParticlesSent = false;
            TunerEmit(s.Client, "{\"type\":\"event\",\"event\":\"tuner/live\",\"session\":" + s.NameJson + ",\"particles\":null}");
            return;
        }
        if (s.ParticlesSent && now < s.NextParticles) return;
        s.NextParticles = now + TUNER_PARTICLES_INTERVAL;
        int count = 0;
        foreach (var ps in root.GetComponentsInChildren<ParticleSystem>(false)) count += ps.particleCount;
        bool running = playing ? root.isPlaying && !root.isPaused : !s.SimPaused && !s.SimStopped;
        ulong key = TunerMix(TunerMix(TunerMix(TunerMix(14695981039346656037UL, (uint)count), root.time), running ? 1u : 0u), s.SimSpeed);
        key = TunerMixString(key, root.name);
        if (s.ParticlesSent && key == s.ParticlesKey) return;
        s.ParticlesSent = true;
        s.ParticlesKey = key;
        var sb = new System.Text.StringBuilder(256);
        sb.Append("{\"type\":\"event\",\"event\":\"tuner/live\",\"session\":").Append(s.NameJson)
          .Append(",\"particles\":{\"name\":").Append(JStr(root.name))
          .Append(",\"path\":").Append(JStr(TunerObjectPath(root.gameObject)))
          .Append(",\"mode\":\"").Append(playing ? "play" : "edit")
          .Append("\",\"playing\":").Append(running ? "true" : "false")
          .Append(",\"time\":").Append(root.time.ToString("0.###", Inv))
          .Append(",\"duration\":").Append(root.main.duration.ToString("0.###", Inv))
          .Append(",\"count\":").Append(count.ToString(Inv))
          .Append(",\"speed\":").Append(s.SimSpeed.ToString("0.###", Inv))
          .Append("}}");
        TunerEmit(s.Client, sb.ToString());
    }

    static void TunerParticlesCommand(int id, TunerArgs a, ControlClient from)
    {
        var s = FindTuner(a.session);
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + a.session + "'", null);
            return;
        }
        bool playing = EditorApplication.isPlaying;
        var root = playing ? s.PlayPs : s.SimPs;
        if (root == null)
        {
            TunerResult(from, id, "no particle system is selected", null);
            return;
        }
        var now = EditorApplication.timeSinceStartup;
        switch (a.op)
        {
            case "play":
                if (playing) root.Play(true);
                else if (s.SimStopped) TunerRestartParticles(s, root, now);
                else s.SimPaused = false;
                break;
            case "pause":
                if (playing) root.Pause(true);
                else s.SimPaused = true;
                break;
            case "restart":
                if (playing)
                {
                    root.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                    root.Clear(true);
                    root.Play(true);
                }
                else TunerRestartParticles(s, root, now);
                break;
            case "stop":
                if (!playing) root.Simulate(0f, true, true, false);
                root.Stop(true, ParticleSystemStopBehavior.StopEmittingAndClear);
                root.Clear(true);
                if (!playing)
                {
                    s.SimStopped = true;
                    s.SimPaused = false;
                }
                break;
            case "speed":
                float speed;
                if (!float.TryParse(a.value, System.Globalization.NumberStyles.Float, Inv, out speed) || speed < 0f || speed > 100f)
                {
                    TunerResult(from, id, "speed must be a number from 0 to 100", null);
                    return;
                }
                s.SimSpeed = speed;
                break;
            default:
                TunerResult(from, id, "unknown particles op '" + a.op + "'", null);
                return;
        }
        s.Dirty = true;
        s.ParticlesKey = 0;
        s.NextParticles = 0;
        WakeTunerAt(now, now);
        TunerResult(from, id, null, null);
    }

    static void TunerRestartParticles(TunerSession s, ParticleSystem root, double now)
    {
        root.Simulate(0f, true, true, false);
        s.SimStopped = false;
        s.SimPaused = false;
        s.SimAt = now;
    }
}
