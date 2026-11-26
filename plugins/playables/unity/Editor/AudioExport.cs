using System;
using System.IO;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace SaturaSpace.Playables
{
    [InitializeOnLoad]
    public static class AudioExport
    {
        private static readonly string[] BrowserFormats = {".wav", ".ogg", ".mp3", ".flac"};

        static AudioExport()
        {
            ExportRegistry.Asset(typeof(AudioClip), (obj, ctx) => ctx.Add("audio", obj, () => Dump((AudioClip) obj, ctx)));
            ExportRegistry.Component("UnityEngine.AudioSource", "m_audioClip", "m_Resource", "m_PlayOnAwake", "m_Volume", "m_Pitch", "Loop", "Mute");
        }

        private static Node Dump(AudioClip clip, ExportContext ctx)
        {
            string path = AssetDatabase.GetAssetPath(clip) ?? "";
            var node = new Node
            {
                ["name"] = clip.name,
                ["path"] = path,
                ["length"] = clip.length,
                ["samples"] = clip.samples,
                ["frequency"] = clip.frequency,
                ["channels"] = clip.channels
            };
            string extension = Path.GetExtension(path).ToLowerInvariant();
            string id = path.Length > 0 ? AssetDatabase.AssetPathToGUID(path) : "";
            string stem = "audio_" + Safe(clip.name) + "_" + (id.Length >= 8 ? id.Substring(0, 8) : Mathf.Abs(clip.GetInstanceID()).ToString());
            byte[] bytes = null;
            if (Array.IndexOf(BrowserFormats, extension) >= 0 && File.Exists(path)) bytes = File.ReadAllBytes(path);
            else extension = ".wav";

            if (bytes == null)
            {
                try
                {
                    bytes = Pcm(clip, path);
                }
                catch (Exception e)
                {
                    ctx.Warn("audio clip " + clip.name + ": " + e.Message);
                }
            }

            if (bytes == null)
            {
                ctx.Warn("audio clip " + clip.name + " (" + path + ") could not be read: convert it to wav, ogg or mp3, or set its Load Type to Decompress On Load");
                node["file"] = null;
                return node;
            }

            node["file"] = ctx.File(stem + extension, bytes, "audio", path);
            return node;
        }

        private static string Safe(string name)
        {
            var sb = new StringBuilder();
            foreach (char c in name)
            {
                if (sb.Length >= 40) break;
                sb.Append(c < 128 && (char.IsLetterOrDigit(c) || c == '-') ? char.ToLowerInvariant(c) : '_');
            }

            return sb.ToString();
        }

        private static byte[] Pcm(AudioClip clip, string path)
        {
            byte[] wav = Read(clip);
            if (wav != null) return wav;
            var importer = path.Length > 0 ? AssetImporter.GetAtPath(path) as AudioImporter : null;
            if (importer == null) return null;
            AudioImporterSampleSettings saved = importer.defaultSampleSettings;
            AudioImporterSampleSettings readable = saved;
            readable.loadType = AudioClipLoadType.DecompressOnLoad;
            readable.compressionFormat = AudioCompressionFormat.PCM;
            importer.defaultSampleSettings = readable;
            importer.SaveAndReimport();
            try
            {
                var fresh = AssetDatabase.LoadAssetAtPath<AudioClip>(path);
                return fresh != null ? Read(fresh) : null;
            }
            finally
            {
                importer.defaultSampleSettings = saved;
                importer.SaveAndReimport();
            }
        }

        private static byte[] Read(AudioClip clip)
        {
            if (clip.loadType != AudioClipLoadType.DecompressOnLoad) return null;
            if (clip.loadState != AudioDataLoadState.Loaded && !clip.LoadAudioData()) return null;
            if (clip.loadState != AudioDataLoadState.Loaded) return null;
            var data = new float[clip.samples * clip.channels];
            if (data.Length == 0 || !clip.GetData(data, 0)) return null;
            return Wav(data, clip.channels, clip.frequency);
        }

        private static byte[] Wav(float[] data, int channels, int frequency)
        {
            var bytes = new byte[44 + data.Length * 2];
            using (var writer = new BinaryWriter(new MemoryStream(bytes)))
            {
                writer.Write(Encoding.ASCII.GetBytes("RIFF"));
                writer.Write(bytes.Length - 8);
                writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
                writer.Write(16);
                writer.Write((short) 1);
                writer.Write((short) channels);
                writer.Write(frequency);
                writer.Write(frequency * channels * 2);
                writer.Write((short) (channels * 2));
                writer.Write((short) 16);
                writer.Write(Encoding.ASCII.GetBytes("data"));
                writer.Write(data.Length * 2);
                foreach (float sample in data) writer.Write((short) Mathf.RoundToInt(Mathf.Clamp(sample, -1f, 1f) * 32767f));
            }

            return bytes;
        }
    }
}
