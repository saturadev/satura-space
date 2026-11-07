using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Text;
using Unity.Profiling;

public static partial class MCPTestBridge
{
    const int TP_TICK = 0;
    const int TP_RESOLVE = 1;
    const int TP_MEMBERS = 2;
    const int TP_STATE = 3;
    const int TP_TRACKS = 4;
    const int TP_REBUILD = 5;
    const int TP_ANIM = 6;
    const int TP_LIVE = 7;
    const int TP_PARTICLES = 8;
    const int TP_SURFACE = 9;
    const int TP_CANVAS = 10;
    const int TP_HASH = 11;
    const int TP_RENDER = 12;
    const int TP_CAMERA = 13;
    const int TP_RECORD = 14;
    const int TP_EXECUTE = 15;
    const int TP_GIZMOS = 16;
    const int TP_SEAL = 17;
    const int TP_SUBMIT = 18;
    const int TP_INSPECTOR = 19;
    const int TP_BRIDGE = 20;
    const int TP_HASH_GEO = 21;
    const int TP_HASH_VIEW = 22;
    const int TP_BR_STREAM = 23;
    const int TP_BR_CONTROL = 24;
    const int TP_BR_REVEAL = 25;
    const int TP_BR_STATUS = 26;
    const int TP_BR_WORLD = 27;
    const int TP_BR_CMDLOG = 28;
    const int TP_BR_REST = 29;
    const int TP_TI_LAYOUT = 30;
    const int TP_TI_UITK = 31;
    const int TP_TI_PAINT = 32;
    const int TP_TI_JSON = 33;
    const int TP_TI_EMIT = 34;
    const int TP_ENSURE = 35;
    const int TP_WIRE = 36;
    const int TP_INFO = 37;
    const int TP_FLUSH = 38;
    const int TP_CRC = 39;
    const int TP_ROOTS = 40;
    const int TP_ICONS = 41;
    const int TP_BAKE = 42;
    const int TP_LODS = 43;
    const int TP_RSIG = 44;
    const int TP_COUNT = 45;
    const int TP_GAPS = 4096;

    static readonly string[] TpNames =
    {
        "tick", "resolve", "members", "state", "tracks", "rebuild", "anim", "live", "particles", "surface", "canvas", "hash",
        "render", "camera", "record", "execute", "gizmos", "seal", "submit", "inspector", "bridge", "hash.geometry", "hash.view",
        "bridge.stream", "bridge.control", "bridge.reveal", "bridge.status", "bridge.world", "bridge.cmdlog", "bridge.rest",
        "inspector.layout", "inspector.uitk", "inspector.paint", "inspector.json", "inspector.emit",
        "ensure", "wire", "info", "flush", "crc", "roots", "icons", "bake", "lods", "rsig"
    };

    static readonly double[] _tpSum = new double[TP_COUNT];
    static readonly long[] _tpAlloc = new long[TP_COUNT];
    static readonly long[] _tpMarkAt = new long[64];
    static readonly long[] _tpMarkAlloc = new long[64];
    static int _tpMarks;
    static readonly Dictionary<int, TpTraffic> _tpTraffic = new Dictionary<int, TpTraffic>();
    static readonly object _tpTrafficLock = new object();

    sealed class TpTraffic
    {
        public string Name;
        public long Messages;
        public long Bytes;
    }
    static readonly double[] _tpMax = new double[TP_COUNT];
    static readonly int[] _tpN = new int[TP_COUNT];
    static readonly double[] _tpTickGaps = new double[TP_GAPS];
    static readonly double[] _tpFrameGaps = new double[TP_GAPS];
    static int _tpTickGapN;
    static int _tpFrameGapN;
    static long _tpLastTick;
    static long _tpLastFrame;
    static int _tpBlocked;
    static readonly Dictionary<string, int> _tpRecv = new Dictionary<string, int>();
    static int _tpRenderDirty;
    static int _tpRenderHash;
    static int _tpRenderFast;
    static int _tpRenderSustained;
    static int _tpActivity;
    static int _tpTiPartial;
    static ProfilerRecorder _tpGc;
    static long _tpGcBytes;
    static int _tpGcFrames;

    static long TpNow()
    {
        long now = Stopwatch.GetTimestamp();
        if (!_tpGc.Valid) return now;
        if (_tpMarks == _tpMarkAt.Length) _tpMarks = 0;
        _tpMarkAt[_tpMarks] = now;
        _tpMarkAlloc[_tpMarks] = _tpGc.CurrentValue;
        _tpMarks++;
        return now;
    }

    static void TpAdd(int stage, long start)
    {
        double ms = TunerMs(Stopwatch.GetTimestamp() - start);
        if (_tpGc.Valid)
        {
            long alloc = _tpGc.CurrentValue;
            for (int k = _tpMarks - 1; k >= 0; k--)
            {
                if (_tpMarkAt[k] != start) continue;
                if (alloc > _tpMarkAlloc[k]) _tpAlloc[stage] += alloc - _tpMarkAlloc[k];
                _tpMarks = k;
                break;
            }
        }
        _tpSum[stage] += ms;
        _tpN[stage]++;
        if (ms > _tpMax[stage]) _tpMax[stage] = ms;
    }

    static void TpGap(double[] ring, ref int n, ref long last, long now)
    {
        if (last != 0)
        {
            ring[n % TP_GAPS] = TunerMs(now - last);
            n++;
        }
        last = now;
    }

    static void TpTickStart(long now)
    {
        if (_tpGc.Valid)
        {
            _tpGcBytes += _tpGc.LastValue;
            _tpGcFrames++;
        }
        TpGap(_tpTickGaps, ref _tpTickGapN, ref _tpLastTick, now);
    }

    static void TpFrame()
    {
        TpGap(_tpFrameGaps, ref _tpFrameGapN, ref _tpLastFrame, Stopwatch.GetTimestamp());
    }

    static void TpReset()
    {
        Array.Clear(_tpSum, 0, TP_COUNT);
        lock (_tpTrafficLock) _tpTraffic.Clear();
        _tpRecv.Clear();
        _tpRenderDirty = _tpRenderHash = _tpRenderFast = _tpRenderSustained = _tpActivity = 0;
        _tpTiPartial = 0;
        Array.Clear(_tpAlloc, 0, TP_COUNT);
        _tpMarks = 0;
        Array.Clear(_tpMax, 0, TP_COUNT);
        Array.Clear(_tpN, 0, TP_COUNT);
        _tpTickGapN = _tpFrameGapN = 0;
        _tpLastTick = _tpLastFrame = 0;
        _tpBlocked = 0;
        _tpGcBytes = 0;
        _tpGcFrames = 0;
        if (!_tpGc.Valid) _tpGc = ProfilerRecorder.StartNew(ProfilerCategory.Memory, "GC Allocated In Frame");
    }

    static void TpStopGc()
    {
        _tpRecv.Clear();
        if (_tpGc.Valid) _tpGc.Dispose();
        _tpGc = default;
    }

    static double TpPercentile(double[] ring, int n, double p)
    {
        int count = Math.Min(n, TP_GAPS);
        if (count == 0) return 0;
        var sorted = new double[count];
        Array.Copy(ring, sorted, count);
        Array.Sort(sorted);
        return sorted[Math.Min(count - 1, (int)(p * count))];
    }

    static void TpAppendJson(StringBuilder sb)
    {
        sb.Append(",\"stages\":{");
        bool first = true;
        for (int i = 0; i < TP_COUNT; i++)
        {
            if (_tpN[i] == 0) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append('"').Append(TpNames[i]).Append("\":{\"n\":").Append(_tpN[i].ToString(Inv))
              .Append(",\"ms\":").Append(Num(_tpSum[i] / _tpN[i]))
              .Append(",\"max\":").Append(Num(_tpMax[i]))
              .Append(",\"total\":").Append(Num(_tpSum[i]))
              .Append(",\"alloc\":").Append(_tpAlloc[i].ToString(Inv)).Append('}');
        }
        sb.Append('}');
        sb.Append(",\"traffic\":{");
        lock (_tpTrafficLock)
        {
            first = true;
            foreach (var t in _tpTraffic.Values)
            {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('"').Append(t.Name).Append("\":{\"n\":").Append(t.Messages.ToString(Inv))
                  .Append(",\"bytes\":").Append(t.Bytes.ToString(Inv)).Append('}');
            }
        }
        sb.Append('}');
        sb.Append(",\"recv\":{");
        first = true;
        foreach (var kv in _tpRecv)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append('"').Append(kv.Key).Append("\":").Append(kv.Value.ToString(Inv));
        }
        sb.Append('}');
        sb.Append(",\"renders\":{\"dirty\":").Append(_tpRenderDirty.ToString(Inv)).Append(",\"hash\":").Append(_tpRenderHash.ToString(Inv))
          .Append(",\"fast\":").Append(_tpRenderFast.ToString(Inv)).Append(",\"sustained\":").Append(_tpRenderSustained.ToString(Inv))
          .Append(",\"activity\":").Append(_tpActivity.ToString(Inv)).Append('}');
        sb.Append(",\"inspectorPartial\":").Append(_tpTiPartial.ToString(Inv));
        sb.Append(",\"tickGap\":{\"n\":").Append(Math.Min(_tpTickGapN, TP_GAPS).ToString(Inv))
          .Append(",\"p50\":").Append(Num(TpPercentile(_tpTickGaps, _tpTickGapN, 0.5)))
          .Append(",\"p95\":").Append(Num(TpPercentile(_tpTickGaps, _tpTickGapN, 0.95)))
          .Append(",\"max\":").Append(Num(TpPercentile(_tpTickGaps, _tpTickGapN, 1.0))).Append('}');
        sb.Append(",\"frameGap\":{\"n\":").Append(Math.Min(_tpFrameGapN, TP_GAPS).ToString(Inv))
          .Append(",\"p50\":").Append(Num(TpPercentile(_tpFrameGaps, _tpFrameGapN, 0.5)))
          .Append(",\"p95\":").Append(Num(TpPercentile(_tpFrameGaps, _tpFrameGapN, 0.95)))
          .Append(",\"max\":").Append(Num(TpPercentile(_tpFrameGaps, _tpFrameGapN, 1.0))).Append('}');
        sb.Append(",\"surfaceBlocked\":").Append(_tpBlocked.ToString(Inv));
        sb.Append(",\"gcFrame\":{\"frames\":").Append(_tpGcFrames.ToString(Inv)).Append(",\"bytes\":").Append(_tpGcBytes.ToString(Inv)).Append('}');
    }

    static void TpRecv(string cmd)
    {
        if (!_tpGc.Valid) return;
        int n;
        _tpRecv.TryGetValue(cmd, out n);
        _tpRecv[cmd] = n + 1;
    }

    const string TpEventKey = "\"event\":\"";

    static void TpSent(string json, int bytes)
    {
        int limit = Math.Min(json.Length, 160);
        int at = json.IndexOf(TpEventKey, 0, limit, StringComparison.Ordinal);
        int end = at;
        int hash = 17;
        if (at >= 0)
        {
            at += TpEventKey.Length;
            for (end = at; end < limit && json[end] != '"'; end++) hash = hash * 31 + json[end];
        }
        TpCount(hash, json, null, at, end, bytes);
    }

    static void TpSent(char[] json, int len, int bytes)
    {
        int limit = Math.Min(len, 160);
        int at = -1;
        for (int i = 0; i + TpEventKey.Length <= limit && at < 0; i++)
        {
            int k = 0;
            while (k < TpEventKey.Length && json[i + k] == TpEventKey[k]) k++;
            if (k == TpEventKey.Length) at = i + k;
        }
        int end = at;
        int hash = 17;
        if (at >= 0)
            for (end = at; end < limit && json[end] != '"'; end++) hash = hash * 31 + json[end];
        TpCount(hash, null, json, at, end, bytes);
    }

    static void TpCount(int hash, string json, char[] chars, int at, int end, int bytes)
    {
        lock (_tpTrafficLock)
        {
            if (!_tpTraffic.TryGetValue(hash, out var t))
            {
                string name = at < 0 || end <= at ? "result" : json != null ? json.Substring(at, end - at) : new string(chars, at, end - at);
                t = new TpTraffic { Name = name };
                _tpTraffic[hash] = t;
            }
            t.Messages++;
            t.Bytes += bytes;
        }
    }

    static string TpLine()
    {
        var sb = new StringBuilder(", stages");
        for (int i = 0; i < TP_COUNT; i++)
        {
            if (_tpN[i] == 0) continue;
            sb.Append(' ').Append(TpNames[i]).Append(' ').Append((_tpSum[i] / _tpN[i]).ToString("0.00", Inv)).Append('/')
              .Append(_tpMax[i].ToString("0.0", Inv)).Append('x').Append(_tpN[i].ToString(Inv))
              .Append(' ').Append((_tpAlloc[i] / _tpN[i]).ToString(Inv)).Append('B');
        }
        sb.Append(", gc ").Append(_tpGcBytes.ToString(Inv)).Append("B in ").Append(_tpGcFrames.ToString(Inv)).Append(" frames");
        lock (_tpTrafficLock)
        {
            sb.Append(", sent");
            foreach (var t in _tpTraffic.Values)
                sb.Append(' ').Append(t.Name).Append(' ').Append(t.Messages.ToString(Inv)).Append('/').Append(t.Bytes.ToString(Inv)).Append('B');
        }
        sb.Append(", tick gap p50 ").Append(TpPercentile(_tpTickGaps, _tpTickGapN, 0.5).ToString("0.0", Inv))
          .Append(" p95 ").Append(TpPercentile(_tpTickGaps, _tpTickGapN, 0.95).ToString("0.0", Inv))
          .Append(" ms, frame gap p50 ").Append(TpPercentile(_tpFrameGaps, _tpFrameGapN, 0.5).ToString("0.0", Inv))
          .Append(" p95 ").Append(TpPercentile(_tpFrameGaps, _tpFrameGapN, 0.95).ToString("0.0", Inv))
          .Append(" ms, surface blocked ").Append(_tpBlocked.ToString(Inv));
        return sb.ToString();
    }
}
