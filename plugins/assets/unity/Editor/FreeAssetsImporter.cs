using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace SaturaSpace.FreeAssets
{
    [InitializeOnLoad]
    static class FreeAssetsImporter
    {
        [Serializable]
        class MapSet
        {
            public string part;
            public string color;
            public string normal;
            public string arm;
            public string rough;
            public string metal;
            public string ao;
            public string opacity;
        }

        [Serializable]
        class BuildArgs
        {
            public string kind;
            public string dir;
            public string id;
            public string name;
            public string model;
            public string hdri;
            public bool skybox;
            public MapSet[] sets;
        }

        [Serializable]
        class BuildCommand
        {
            public BuildArgs args;
        }

        class Built
        {
            public Material material;
            public bool packed;
            public bool cutout;
        }

        static FreeAssetsImporter()
        {
            SaturaPlugins.Command("assets.pipeline", _ => "{\"pipeline\":" + SaturaPlugins.Json(Pipeline()) + "}");
            SaturaPlugins.Command("assets.build", Build);
        }

        static string Pipeline()
        {
            var rp = GraphicsSettings.currentRenderPipeline;
            if (rp == null) return "builtin";
            var type = rp.GetType().FullName ?? "";
            if (type.Contains("Universal")) return "urp";
            if (type.Contains("HighDefinition")) return "hdrp";
            return "custom";
        }

        static string Build(string line)
        {
            var cmd = JsonUtility.FromJson<BuildCommand>(line);
            var a = cmd?.args;
            if (a == null || string.IsNullOrEmpty(a.dir) || !a.dir.StartsWith("Assets/", StringComparison.Ordinal) || a.dir.Contains(".."))
                throw new ArgumentException("assets.build needs a dir inside Assets/");
            var pipeline = Pipeline();
            if (pipeline == "hdrp") throw new NotSupportedException("This project uses HDRP. Free Assets builds materials for URP and the Built-in pipeline only for now.");
            if (pipeline == "custom") throw new NotSupportedException("This project uses a custom render pipeline. Free Assets builds materials for URP and the Built-in pipeline only.");
            AssetDatabase.Refresh(ImportAssetOptions.ForceSynchronousImport);
            var warnings = new List<string>();
            var o = new StringBuilder();
            o.Append("{\"kind\":").Append(SaturaPlugins.Json(a.kind)).Append(",\"pipeline\":").Append(SaturaPlugins.Json(pipeline));
            if (a.kind == "hdri") BuildSkybox(a, o, warnings);
            else if (a.kind == "model") BuildModel(a, pipeline, o, warnings);
            else if (a.kind == "material") BuildMaterialAsset(a, pipeline, o, warnings);
            else throw new ArgumentException("kind is model, material or hdri");
            if (warnings.Count > 0) o.Append(",\"warnings\":[").Append(string.Join(",", warnings.Select(SaturaPlugins.Json))).Append(']');
            o.Append('}');
            Debug.Log($"[FreeAssets] built {a.kind} {a.id} in {a.dir} for {pipeline}");
            return o.ToString();
        }

        static void BuildMaterialAsset(BuildArgs a, string pipeline, StringBuilder o, List<string> warnings)
        {
            var set = a.sets != null && a.sets.Length > 0 ? a.sets[0] : null;
            if (set == null) throw new ArgumentException("The material has no texture maps.");
            var path = $"{a.dir}/{a.id}.mat";
            var built = MakeMaterial(set, pipeline, path, a.id, warnings);
            AssetDatabase.SaveAssets();
            o.Append(",\"path\":").Append(SaturaPlugins.Json(path)).Append(",\"material\":").Append(SaturaPlugins.Json(path));
            o.Append(",\"materials\":[").Append(SaturaPlugins.Json(path)).Append(']');
            Selection.activeObject = built.material;
        }

        static void BuildModel(BuildArgs a, string pipeline, StringBuilder o, List<string> warnings)
        {
            if (string.IsNullOrEmpty(a.model)) throw new ArgumentException("The model has no mesh file.");
            var importer = AssetImporter.GetAtPath(a.model) as ModelImporter;
            if (importer == null) throw new InvalidOperationException($"Unity did not import {a.model} as a model.");
            importer.materialImportMode = ModelImporterMaterialImportMode.ImportStandard;
            importer.materialLocation = ModelImporterMaterialLocation.InPrefab;
            importer.SaveAndReimport();
            var sourceNames = AssetDatabase.LoadAllAssetsAtPath(a.model).OfType<Material>().Select(m => m.name).Distinct().ToList();
            if (sourceNames.Count == 0)
            {
                var model = AssetDatabase.LoadAssetAtPath<GameObject>(a.model);
                if (model != null) sourceNames = model.GetComponentsInChildren<Renderer>(true).SelectMany(r => r.sharedMaterials).Where(m => m != null).Select(m => m.name).Distinct().ToList();
            }
            var sets = (a.sets ?? new MapSet[0]).Where(s => s != null).ToArray();
            var made = new Dictionary<MapSet, Material>();
            var byName = new Dictionary<string, Material>();
            var paths = new List<string>();
            foreach (var name in sourceNames)
            {
                var set = SetFor(name, sets);
                if (set == null)
                {
                    warnings.Add($"No texture maps match material {name}; it keeps a plain {pipeline} material.");
                    continue;
                }
                if (!made.TryGetValue(set, out var mat))
                {
                    var label = string.IsNullOrEmpty(set.part) ? a.id : $"{a.id}_{set.part}";
                    var path = $"{a.dir}/{Safe(label)}.mat";
                    mat = MakeMaterial(set, pipeline, path, label, warnings).material;
                    made[set] = mat;
                    paths.Add(path);
                }
                byName[name] = mat;
                importer.AddRemap(new AssetImporter.SourceAssetIdentifier(typeof(Material), name), mat);
            }
            if (sourceNames.Count == 0 && sets.Length > 0)
            {
                var label = a.id;
                var path = $"{a.dir}/{Safe(label)}.mat";
                made[sets[0]] = MakeMaterial(sets[0], pipeline, path, label, warnings).material;
                paths.Add(path);
            }
            importer.SaveAndReimport();
            foreach (var unused in sets.Where(s => !made.ContainsKey(s)))
                foreach (var tex in new[] { unused.color, unused.normal, unused.arm, unused.rough, unused.metal, unused.ao, unused.opacity })
                    if (Has(tex) && !made.Keys.Any(s => s.color == tex || s.normal == tex || s.arm == tex || s.rough == tex || s.metal == tex || s.ao == tex || s.opacity == tex))
                        AssetDatabase.DeleteAsset(tex);
            var asset = AssetDatabase.LoadAssetAtPath<GameObject>(a.model);
            if (asset == null) throw new InvalidOperationException($"{a.model} has no model in it.");
            var preview = EditorSceneManager.NewPreviewScene();
            var root = new GameObject(a.name);
            UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(root, preview);
            var go = (GameObject)PrefabUtility.InstantiatePrefab(asset, preview);
            string prefabPath = $"{a.dir}/{Safe(a.id)}.prefab";
            int tris = 0;
            Bounds bounds = default;
            try
            {
                PrefabUtility.UnpackPrefabInstance(go, PrefabUnpackMode.Completely, InteractionMode.AutomatedAction);
                go.transform.SetParent(root.transform, false);
                var fallback = made.Values.FirstOrDefault();
                bool any = false;
                foreach (var r in go.GetComponentsInChildren<Renderer>(true))
                {
                    var mats = r.sharedMaterials;
                    for (int i = 0; i < mats.Length; i++)
                    {
                        var current = mats[i];
                        if (current != null && byName.TryGetValue(current.name, out var mine)) mats[i] = mine;
                        else if (current == null || !paths.Contains(AssetDatabase.GetAssetPath(current)))
                        {
                            if (fallback != null) mats[i] = fallback;
                        }
                    }
                    r.sharedMaterials = mats;
                    bounds = any ? Enclose(bounds, r.bounds) : r.bounds;
                    any = true;
                }
                if (any)
                {
                    go.transform.localPosition += new Vector3(0f, -bounds.min.y, 0f);
                    bounds.center += new Vector3(0f, -bounds.min.y, 0f);
                }
                foreach (var mf in go.GetComponentsInChildren<MeshFilter>(true)) tris += Tris(mf.sharedMesh);
                foreach (var sk in go.GetComponentsInChildren<SkinnedMeshRenderer>(true)) tris += Tris(sk.sharedMesh);
                PrefabUtility.SaveAsPrefabAsset(root, prefabPath, out bool ok);
                if (!ok) throw new InvalidOperationException($"Saving {prefabPath} failed.");
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(root);
                EditorSceneManager.ClosePreviewScene(preview);
            }
            var size = bounds.size;
            if (size.magnitude > 200f) warnings.Add($"The model is {size.magnitude:0} m across; check its import scale.");
            if (size.magnitude < 0.01f) warnings.Add("The model is under a centimetre across; check its import scale.");
            o.Append(",\"path\":").Append(SaturaPlugins.Json(prefabPath)).Append(",\"prefab\":").Append(SaturaPlugins.Json(prefabPath));
            o.Append(",\"tris\":").Append(tris);
            o.Append(",\"size\":[").Append(F(size.x)).Append(',').Append(F(size.y)).Append(',').Append(F(size.z)).Append(']');
            o.Append(",\"materials\":[").Append(string.Join(",", paths.Select(SaturaPlugins.Json))).Append(']');
            Selection.activeObject = AssetDatabase.LoadAssetAtPath<GameObject>(prefabPath);
        }

        static void BuildSkybox(BuildArgs a, StringBuilder o, List<string> warnings)
        {
            if (string.IsNullOrEmpty(a.hdri)) throw new ArgumentException("The HDRI has no image file.");
            var ti = AssetImporter.GetAtPath(a.hdri) as TextureImporter;
            if (ti == null) throw new InvalidOperationException($"Unity did not import {a.hdri} as a texture.");
            ti.textureShape = TextureImporterShape.Texture2D;
            ti.mipmapEnabled = false;
            ti.wrapModeU = TextureWrapMode.Repeat;
            ti.wrapModeV = TextureWrapMode.Clamp;
            ti.maxTextureSize = 8192;
            ti.SaveAndReimport();
            var tex = AssetDatabase.LoadAssetAtPath<Texture2D>(a.hdri);
            var shader = Shader.Find("Skybox/Panoramic");
            if (shader == null) throw new InvalidOperationException("The Skybox/Panoramic shader is missing from this Unity install.");
            var path = $"{a.dir}/{Safe(a.id)}_Skybox.mat";
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(shader);
                AssetDatabase.CreateAsset(mat, path);
            }
            else mat.shader = shader;
            mat.name = $"{a.id}_Skybox";
            mat.SetTexture("_MainTex", tex);
            mat.SetFloat("_Mapping", 1f);
            mat.EnableKeyword("_MAPPING_LATITUDE_LONGITUDE_LAYOUT");
            mat.DisableKeyword("_MAPPING_6_FRAMES_LAYOUT");
            mat.SetFloat("_ImageType", 0f);
            mat.SetFloat("_Exposure", 1f);
            mat.SetFloat("_Rotation", 0f);
            EditorUtility.SetDirty(mat);
            AssetDatabase.SaveAssets();
            o.Append(",\"path\":").Append(SaturaPlugins.Json(path)).Append(",\"skybox\":").Append(SaturaPlugins.Json(path));
            if (a.skybox)
            {
                var scene = EditorSceneManager.GetActiveScene();
                RenderSettings.skybox = mat;
                RenderSettings.ambientMode = AmbientMode.Skybox;
                DynamicGI.UpdateEnvironment();
                EditorSceneManager.MarkSceneDirty(scene);
                o.Append(",\"scene\":").Append(SaturaPlugins.Json(string.IsNullOrEmpty(scene.path) ? scene.name : scene.path));
                warnings.Add($"{(string.IsNullOrEmpty(scene.path) ? "The open scene" : scene.path)} now uses the skybox and has unsaved changes.");
            }
            Selection.activeObject = mat;
        }

        static MapSet SetFor(string material, MapSet[] sets)
        {
            if (sets.Length == 0) return null;
            var low = material.ToLowerInvariant();
            var named = sets.Where(s => !string.IsNullOrEmpty(s.part) && low.Contains(s.part.ToLowerInvariant())).OrderByDescending(s => s.part.Length).FirstOrDefault();
            if (named != null) return named;
            return sets.FirstOrDefault(s => string.IsNullOrEmpty(s.part)) ?? sets[0];
        }

        static Built MakeMaterial(MapSet set, string pipeline, string path, string label, List<string> warnings)
        {
            var urp = pipeline == "urp";
            var shader = Shader.Find(urp ? "Universal Render Pipeline/Lit" : "Standard");
            if (shader == null) throw new InvalidOperationException($"The {(urp ? "URP Lit" : "Standard")} shader is missing, so the material would come out pink.");
            var dir = Path.GetDirectoryName(path).Replace('\\', '/');
            var color = Has(set.color) ? set.color : null;
            var cutout = false;
            if (color != null && Has(set.opacity))
            {
                var merged = $"{dir}/textures/{Safe(label)}_ColorAlpha.png";
                if (Combine(color, set.opacity, merged)) { color = merged; cutout = true; }
                else warnings.Add($"Could not merge the opacity map into {label}'s color; it renders opaque.");
            }
            if (color != null) SetupTexture(color, TextureImporterType.Default, true, cutout, cutout);
            var normal = Has(set.normal) ? set.normal : null;
            if (normal != null) SetupTexture(normal, TextureImporterType.NormalMap, false, false, false);
            string mask = null;
            bool hasAo = false;
            if (Has(set.arm) || Has(set.rough) || Has(set.metal))
            {
                mask = $"{dir}/textures/{Safe(label)}_MetallicSmoothness.png";
                if (!Pack(set, mask, out hasAo))
                {
                    warnings.Add($"Could not read {label}'s roughness maps; it gets a fixed smoothness.");
                    mask = null;
                }
                else SetupTexture(mask, TextureImporterType.Default, false, true, false);
            }
            var mat = AssetDatabase.LoadAssetAtPath<Material>(path);
            if (mat == null)
            {
                mat = new Material(shader);
                AssetDatabase.CreateAsset(mat, path);
            }
            else
            {
                mat.shader = shader;
                mat.shaderKeywords = new string[0];
            }
            mat.name = Path.GetFileNameWithoutExtension(path);
            var colorTex = color != null ? AssetDatabase.LoadAssetAtPath<Texture2D>(color) : null;
            var normalTex = normal != null ? AssetDatabase.LoadAssetAtPath<Texture2D>(normal) : null;
            var maskTex = mask != null ? AssetDatabase.LoadAssetAtPath<Texture2D>(mask) : null;
            if (urp)
            {
                mat.SetFloat("_WorkflowMode", 1f);
                mat.SetTexture("_BaseMap", colorTex);
                mat.SetTexture("_MainTex", colorTex);
                mat.SetColor("_BaseColor", Color.white);
                mat.SetColor("_Color", Color.white);
                if (normalTex != null)
                {
                    mat.SetTexture("_BumpMap", normalTex);
                    mat.SetFloat("_BumpScale", 1f);
                    mat.EnableKeyword("_NORMALMAP");
                }
                if (maskTex != null)
                {
                    mat.SetTexture("_MetallicGlossMap", maskTex);
                    mat.SetFloat("_Metallic", 1f);
                    mat.SetFloat("_Smoothness", 1f);
                    mat.SetFloat("_SmoothnessTextureChannel", 0f);
                    mat.EnableKeyword("_METALLICSPECGLOSSMAP");
                    if (hasAo)
                    {
                        mat.SetTexture("_OcclusionMap", maskTex);
                        mat.SetFloat("_OcclusionStrength", 1f);
                        mat.EnableKeyword("_OCCLUSIONMAP");
                    }
                }
                else
                {
                    mat.SetFloat("_Metallic", 0f);
                    mat.SetFloat("_Smoothness", 0.25f);
                }
                if (cutout)
                {
                    mat.SetFloat("_AlphaClip", 1f);
                    mat.SetFloat("_Cutoff", 0.5f);
                    mat.EnableKeyword("_ALPHATEST_ON");
                    mat.SetOverrideTag("RenderType", "TransparentCutout");
                    mat.renderQueue = (int)RenderQueue.AlphaTest;
                }
                else
                {
                    mat.SetFloat("_AlphaClip", 0f);
                    mat.SetOverrideTag("RenderType", "Opaque");
                    mat.renderQueue = (int)RenderQueue.Geometry;
                }
            }
            else
            {
                mat.SetTexture("_MainTex", colorTex);
                mat.SetColor("_Color", Color.white);
                if (normalTex != null)
                {
                    mat.SetTexture("_BumpMap", normalTex);
                    mat.SetFloat("_BumpScale", 1f);
                    mat.EnableKeyword("_NORMALMAP");
                }
                if (maskTex != null)
                {
                    mat.SetTexture("_MetallicGlossMap", maskTex);
                    mat.SetFloat("_GlossMapScale", 1f);
                    mat.SetFloat("_SmoothnessTextureChannel", 0f);
                    mat.EnableKeyword("_METALLICGLOSSMAP");
                    if (hasAo)
                    {
                        mat.SetTexture("_OcclusionMap", maskTex);
                        mat.SetFloat("_OcclusionStrength", 1f);
                    }
                }
                else
                {
                    mat.SetFloat("_Metallic", 0f);
                    mat.SetFloat("_Glossiness", 0.25f);
                }
                if (cutout)
                {
                    mat.SetFloat("_Mode", 1f);
                    mat.SetFloat("_Cutoff", 0.5f);
                    mat.EnableKeyword("_ALPHATEST_ON");
                    mat.SetOverrideTag("RenderType", "TransparentCutout");
                    mat.renderQueue = (int)RenderQueue.AlphaTest;
                }
            }
            EditorUtility.SetDirty(mat);
            AssetDatabase.SaveAssetIfDirty(mat);
            return new Built { material = mat, packed = maskTex != null, cutout = cutout };
        }

        static void SetupTexture(string path, TextureImporterType type, bool srgb, bool keepAlpha, bool transparency)
        {
            var ti = AssetImporter.GetAtPath(path) as TextureImporter;
            if (ti == null) return;
            ti.textureType = type;
            ti.sRGBTexture = type == TextureImporterType.NormalMap ? false : srgb;
            ti.alphaSource = keepAlpha ? TextureImporterAlphaSource.FromInput : TextureImporterAlphaSource.None;
            ti.alphaIsTransparency = transparency;
            ti.mipmapEnabled = true;
            ti.maxTextureSize = 8192;
            ti.SaveAndReimport();
        }

        static Color32[] Read(string path, out int w, out int h)
        {
            w = h = 0;
            if (!Has(path)) return null;
            var full = Path.GetFullPath(path);
            if (!File.Exists(full)) return null;
            var ext = Path.GetExtension(full).ToLowerInvariant();
            if (ext != ".jpg" && ext != ".jpeg" && ext != ".png") return null;
            var tex = new Texture2D(2, 2, TextureFormat.RGBA32, false, true);
            try
            {
                if (!tex.LoadImage(File.ReadAllBytes(full), false)) return null;
                w = tex.width;
                h = tex.height;
                return tex.GetPixels32();
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(tex);
            }
        }

        static Func<int, int, Color32> Sampler(Color32[] px, int w, int h, int tw, int th)
        {
            if (px == null) return null;
            if (w == tw && h == th) return (x, y) => px[y * tw + x];
            return (x, y) => px[Math.Min(h - 1, y * h / th) * w + Math.Min(w - 1, x * w / tw)];
        }

        static bool Pack(MapSet set, string outPath, out bool hasAo)
        {
            hasAo = false;
            var arm = Read(set.arm, out int aw, out int ah);
            var rough = Read(set.rough, out int rw, out int rh);
            var metal = Read(set.metal, out int mw, out int mh);
            var ao = Read(set.ao, out int ow, out int oh);
            int tw = arm != null ? aw : rough != null ? rw : metal != null ? mw : 0;
            int th = arm != null ? ah : rough != null ? rh : metal != null ? mh : 0;
            if (tw == 0 || th == 0) return false;
            var sArm = Sampler(arm, aw, ah, tw, th);
            var sRough = Sampler(rough, rw, rh, tw, th);
            var sMetal = Sampler(metal, mw, mh, tw, th);
            var sAo = Sampler(ao, ow, oh, tw, th);
            hasAo = sArm != null || sAo != null;
            var outPx = new Color32[tw * th];
            for (int y = 0; y < th; y++)
            {
                for (int x = 0; x < tw; x++)
                {
                    byte m, occ, r;
                    if (sArm != null)
                    {
                        var c = sArm(x, y);
                        occ = c.r;
                        r = sRough != null ? sRough(x, y).r : c.g;
                        m = sMetal != null ? sMetal(x, y).r : c.b;
                    }
                    else
                    {
                        r = sRough != null ? sRough(x, y).r : (byte)191;
                        m = sMetal != null ? sMetal(x, y).r : (byte)0;
                        occ = sAo != null ? sAo(x, y).r : (byte)255;
                    }
                    outPx[y * tw + x] = new Color32(m, occ, 0, (byte)(255 - r));
                }
            }
            return WritePng(outPx, tw, th, outPath);
        }

        static bool Combine(string colorPath, string opacityPath, string outPath)
        {
            var color = Read(colorPath, out int cw, out int ch);
            var alpha = Read(opacityPath, out int ow, out int oh);
            if (color == null || alpha == null) return false;
            var s = Sampler(alpha, ow, oh, cw, ch);
            for (int y = 0; y < ch; y++)
                for (int x = 0; x < cw; x++)
                {
                    var i = y * cw + x;
                    var c = color[i];
                    c.a = s(x, y).r;
                    color[i] = c;
                }
            return WritePng(color, cw, ch, outPath);
        }

        static bool WritePng(Color32[] px, int w, int h, string outPath)
        {
            var tex = new Texture2D(w, h, TextureFormat.RGBA32, false, true);
            try
            {
                tex.SetPixels32(px);
                tex.Apply(false);
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(outPath)));
                File.WriteAllBytes(Path.GetFullPath(outPath), tex.EncodeToPNG());
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(tex);
            }
            AssetDatabase.ImportAsset(outPath, ImportAssetOptions.ForceSynchronousImport);
            return true;
        }

        static int Tris(Mesh mesh)
        {
            if (mesh == null) return 0;
            long n = 0;
            for (int i = 0; i < mesh.subMeshCount; i++)
                if (mesh.GetTopology(i) == MeshTopology.Triangles) n += mesh.GetIndexCount(i) / 3;
            return (int)n;
        }

        static Bounds Enclose(Bounds a, Bounds b)
        {
            a.Encapsulate(b);
            return a;
        }

        static bool Has(string s) => !string.IsNullOrEmpty(s);

        static string Safe(string s) => new string(s.Select(c => char.IsLetterOrDigit(c) || c == '_' || c == '-' || c == '.' ? c : '_').ToArray());

        static string F(float v) => Math.Round(v, 3).ToString(CultureInfo.InvariantCulture);
    }
}
