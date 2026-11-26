using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.EventSystems;
using UnityEngine.Rendering;
using UnityEngine.SceneManagement;

namespace SaturaSpace.Playables
{
    [InitializeOnLoad]
    static class Commands
    {
        [Serializable]
        class PathArgs
        {
            public string config;
            public string outDir;
            public string script;
            public string outPath;
            public string scene;
        }

        [Serializable]
        class Command
        {
            public PathArgs args;
        }

        static Commands()
        {
            SaturaPlugins.Command("playables.export", line =>
            {
                PathArgs a = Parse(line);
                return Exporter.Export(Inside(a.config), Inside(a.outDir));
            });
            SaturaPlugins.Command("playables.scan", line => Scan(Parse(line).scene));
            SaturaPlugins.Command("playables.verify", line =>
            {
                PathArgs a = Parse(line);
                return Verify.Start(Inside(a.script), Inside(a.outPath));
            });
            SaturaPlugins.Command("playables.verifyStop", _ => Verify.Stop());
            SaturaPlugins.Command("playables.state", _ => "{\"playing\":" + (EditorApplication.isPlaying ? "true" : "false") + ",\"verifying\":" + (Verify.Active ? "true" : "false") + ",\"compiling\":" + (EditorApplication.isCompiling ? "true" : "false") + "}");
        }

        static PathArgs Parse(string line)
        {
            PathArgs a = JsonUtility.FromJson<Command>(line)?.args;
            if (a == null) throw new ArgumentException("missing args");
            return a;
        }

        static string Inside(string path)
        {
            if (string.IsNullOrEmpty(path)) throw new ArgumentException("a path is missing");
            string root = Path.GetFullPath(Path.GetDirectoryName(Application.dataPath)).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
            string full = Path.GetFullPath(Path.IsPathRooted(path) ? path : Path.Combine(root, path));
            if (!full.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("the path " + path + " is outside the project");
            return full;
        }

        static string Scan(string scenePath)
        {
            var scenes = new List<object>();
            foreach (string guid in AssetDatabase.FindAssets("t:Scene", new[] {"Assets"}))
            {
                string path = AssetDatabase.GUIDToAssetPath(guid);
                scenes.Add(new Node {["path"] = path, ["inBuild"] = EditorBuildSettings.scenes.Any(s => s.path == path && s.enabled)});
            }

            var root = new Node
            {
                ["unityVersion"] = Application.unityVersion,
                ["pipeline"] = GraphicsSettings.currentRenderPipeline == null ? "builtin" : GraphicsSettings.currentRenderPipeline.GetType().Name,
                ["scenes"] = scenes
            };
            if (string.IsNullOrEmpty(scenePath)) return JsonOut.Write(root);
            if (AssetDatabase.LoadAssetAtPath<SceneAsset>(scenePath) == null) throw new ArgumentException("There is no scene at " + scenePath);

            var assets = new List<object>();
            var scripts = new List<object>();
            long total = 0;
            foreach (string dep in AssetDatabase.GetDependencies(scenePath, true).OrderBy(p => p))
            {
                if (dep == scenePath) continue;
                Type type = AssetDatabase.GetMainAssetTypeAtPath(dep);
                long bytes = File.Exists(dep) ? new FileInfo(dep).Length : 0;
                if (type == typeof(MonoScript))
                {
                    if (!dep.StartsWith("Assets/")) continue;
                    var script = AssetDatabase.LoadAssetAtPath<MonoScript>(dep);
                    Type cls = script != null ? script.GetClass() : null;
                    scripts.Add(new Node
                    {
                        ["path"] = dep,
                        ["class"] = cls != null ? cls.FullName : null,
                        ["lines"] = File.Exists(dep) ? File.ReadAllLines(dep).Length : 0
                    });
                    continue;
                }

                total += bytes;
                var row = new Node {["path"] = dep, ["type"] = type != null ? type.Name : "?", ["bytes"] = bytes};
                AssetImporter importer = AssetImporter.GetAtPath(dep);
                if (importer is TextureImporter ti)
                {
                    var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(dep);
                    if (tex != null) row["size"] = new List<object> {tex.width, tex.height};
                    row["sprite"] = ti.textureType == TextureImporterType.Sprite;
                }
                else if (importer is AudioImporter)
                {
                    var clip = AssetDatabase.LoadAssetAtPath<AudioClip>(dep);
                    if (clip != null) row["seconds"] = Math.Round(clip.length, 2);
                }
                else if (importer is ModelImporter)
                {
                    long tris = 0;
                    foreach (UnityEngine.Object sub in AssetDatabase.LoadAllAssetsAtPath(dep))
                    {
                        if (sub is Mesh mesh) tris += mesh.triangles.Length / 3;
                    }

                    row["tris"] = tris;
                }

                assets.Add(row);
            }

            var components = new Dictionary<string, int>();
            Scene scene = SceneManager.GetSceneByPath(scenePath);
            bool opened = false;
            if (!scene.IsValid() || !scene.isLoaded)
            {
                if (EditorApplication.isPlayingOrWillChangePlaymode) throw new InvalidOperationException("Stop play mode before scanning a scene that is not open.");
                scene = EditorSceneManager.OpenScene(scenePath, OpenSceneMode.Additive);
                opened = true;
            }

            string inputModule = null;
            try
            {
                foreach (GameObject go in scene.GetRootGameObjects())
                {
                    foreach (Component c in go.GetComponentsInChildren<Component>(true))
                    {
                        if (c == null) continue;
                        string name = c.GetType().FullName ?? "?";
                        components[name] = components.TryGetValue(name, out int n) ? n + 1 : 1;
                        if (c is BaseInputModule) inputModule = name;
                    }
                }
            }
            finally
            {
                if (opened) EditorSceneManager.CloseScene(scene, true);
            }

            root["scene"] = scenePath;
            root["inputModule"] = inputModule;
            root["scripts"] = scripts;
            root["components"] = components.OrderByDescending(kv => kv.Value).ToDictionary(kv => kv.Key, kv => (object) kv.Value);
            root["assets"] = assets;
            root["assetBytes"] = total;
            return JsonOut.Write(root);
        }
    }
}
