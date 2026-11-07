using System;
using UnityEngine;

[AddComponentMenu("")]
public sealed class SaturaAudioTap : MonoBehaviour
{
    const int MaxFloatsPerPacket = 12288;

    public static volatile float Gain = 1f;
    public static volatile int SampleRate = 48000;

    byte[] pkt = new byte[0];

    void OnAudioFilterRead(float[] data, int channels)
    {
        var server = LocalStreamServer.Instance;
        if (server != null && channels > 0)
        {
            int perPacket = MaxFloatsPerPacket / channels * channels;
            int rate = SampleRate;
            for (int off = 0; off < data.Length; off += perPacket)
            {
                int n = Math.Min(perPacket, data.Length - off);
                int len = 6 + n * 4;
                if (pkt.Length < len) pkt = new byte[6 + perPacket * 4];
                pkt[0] = (byte)'A';
                pkt[1] = (byte)channels;
                pkt[2] = (byte)rate; pkt[3] = (byte)(rate >> 8); pkt[4] = (byte)(rate >> 16); pkt[5] = (byte)(rate >> 24);
                Buffer.BlockCopy(data, off * 4, pkt, 6, n * 4);
                server.SendPacket(pkt, len);
            }
        }
        float g = Gain;
        if (g == 1f) return;
        for (int i = 0; i < data.Length; i++) data[i] *= g;
    }
}
