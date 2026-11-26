using System;
using System.Collections.Generic;
using System.IO;
using UnityEditor;
using UnityEngine;
using UnityEngine.Rendering;

namespace SaturaSpace.Playables
{
    [InitializeOnLoad]
    static class MeshExport
    {
        const uint Magic = 0x48534D50;
        const int MaxTexture = 2048;

        static MeshExport()
        {
            ExportRegistry.Asset(typeof(Mesh), (obj, ctx) => ctx.Add("meshes", obj, () => DumpMesh((Mesh) obj, ctx)));
            ExportRegistry.Asset(typeof(Material), (obj, ctx) => ctx.Add("materials", obj, () => DumpMaterial((Material) obj, ctx)));
            ExportRegistry.Asset(typeof(Texture2D), (obj, ctx) => ctx.Add("textures", obj, () => DumpTexture((Texture2D) obj, ctx)));
            ExportRegistry.Component("UnityEngine.MeshFilter", "m_Mesh");
            ExportRegistry.Component("UnityEngine.MeshRenderer", "m_Materials");
            ExportRegistry.Component("UnityEngine.SkinnedMeshRenderer", "m_Materials", "m_Mesh", "m_Bones", "m_RootBone");
            ExportRegistry.Component("UnityEngine.Light", "m_Type", "m_Color", "m_Intensity", "m_Range", "m_SpotAngle");
            ExportRegistry.Component("UnityEngine.BoxCollider", "m_IsTrigger", "m_Size", "m_Center");
            ExportRegistry.Component("UnityEngine.SphereCollider", "m_IsTrigger", "m_Radius", "m_Center");
            ExportRegistry.Component("UnityEngine.CapsuleCollider", "m_IsTrigger", "m_Radius", "m_Height", "m_Direction", "m_Center");
            ExportRegistry.Component("UnityEngine.MeshCollider", "m_IsTrigger", "m_Convex", "m_Mesh");
            ExportRegistry.Component("UnityEngine.Rigidbody", "m_Mass", "m_Drag", "m_LinearDamping", "m_UseGravity", "m_IsKinematic", "m_Constraints");
        }

        static int Index(ExportContext ctx, string table)
        {
            return ctx.Tables.TryGetValue(table, out List<object> rows) ? rows.Count - 1 : 0;
        }

        static object Vec(Vector3 v)
        {
            return new Node {["$v"] = new[] {v.x, v.y, v.z}};
        }

        static object Col(Color c)
        {
            return new Node {["$c"] = new[] {c.r, c.g, c.b, c.a}};
        }

        static Node DumpMesh(Mesh mesh, ExportContext ctx)
        {
            Scene(ctx);
            string path = AssetDatabase.GetAssetPath(mesh);
            Vector3[] vertices = mesh.vertices;
            Vector3[] normals = mesh.normals;
            Vector2[] uv = mesh.uv;
            BoneWeight[] weights = mesh.boneWeights;
            Matrix4x4[] bindposes = mesh.bindposes;
            int count = vertices.Length;
            bool hasNormals = normals != null && normals.Length == count && count > 0;
            bool hasUv = uv != null && uv.Length == count && count > 0;
            bool hasSkin = weights != null && weights.Length == count && count > 0 && bindposes != null && bindposes.Length > 0;
            if (hasSkin && bindposes.Length > 255)
            {
                ctx.Warn("mesh " + mesh.name + " has more than 255 bones, exported without skin");
                hasSkin = false;
            }

            var submeshes = new List<int[]>();
            int indexCount = 0;
            for (int s = 0; s < mesh.subMeshCount; s++)
            {
                int[] triangles = mesh.GetTopology(s) == MeshTopology.Triangles ? mesh.GetTriangles(s) : Array.Empty<int>();
                if (mesh.GetTopology(s) != MeshTopology.Triangles) ctx.Warn("mesh " + mesh.name + " submesh " + s + " is not made of triangles, skipped");
                submeshes.Add(triangles);
                indexCount += triangles.Length;
            }

            if (count == 0) ctx.Warn("mesh " + mesh.name + " has no readable vertices");
            bool wide = count > 65535;
            uint flags = (hasNormals ? 1u : 0u) | (hasUv ? 2u : 0u) | (hasSkin ? 4u : 0u) | (wide ? 16u : 0u);
            Bounds bounds = mesh.bounds;
            using (var stream = new MemoryStream())
            using (var w = new BinaryWriter(stream))
            {
                w.Write(Magic);
                w.Write(flags);
                w.Write((uint) count);
                w.Write((uint) indexCount);
                w.Write((uint) submeshes.Count);
                w.Write((uint) (hasSkin ? bindposes.Length : 0));
                w.Write(bounds.center.x);
                w.Write(bounds.center.y);
                w.Write(bounds.center.z);
                w.Write(bounds.extents.x);
                w.Write(bounds.extents.y);
                w.Write(bounds.extents.z);
                foreach (int[] triangles in submeshes) w.Write((uint) triangles.Length);
                foreach (Vector3 v in vertices)
                {
                    w.Write(v.x);
                    w.Write(v.y);
                    w.Write(v.z);
                }

                if (hasNormals)
                {
                    foreach (Vector3 n in normals)
                    {
                        w.Write(n.x);
                        w.Write(n.y);
                        w.Write(n.z);
                    }
                }

                if (hasUv)
                {
                    foreach (Vector2 t in uv)
                    {
                        w.Write(t.x);
                        w.Write(t.y);
                    }
                }

                if (hasSkin)
                {
                    foreach (BoneWeight b in weights)
                    {
                        w.Write((byte) b.boneIndex0);
                        w.Write((byte) b.boneIndex1);
                        w.Write((byte) b.boneIndex2);
                        w.Write((byte) b.boneIndex3);
                    }

                    foreach (BoneWeight b in weights)
                    {
                        float sum = b.weight0 + b.weight1 + b.weight2 + b.weight3;
                        float k = sum > 0f ? 255f / sum : 0f;
                        int w1 = Mathf.RoundToInt(b.weight1 * k);
                        int w2 = Mathf.RoundToInt(b.weight2 * k);
                        int w3 = Mathf.RoundToInt(b.weight3 * k);
                        w.Write((byte) Mathf.Clamp(255 - w1 - w2 - w3, 0, 255));
                        w.Write((byte) w1);
                        w.Write((byte) w2);
                        w.Write((byte) w3);
                    }

                    foreach (Matrix4x4 m in bindposes)
                    {
                        for (int i = 0; i < 16; i++) w.Write(m[i]);
                    }
                }

                foreach (int[] triangles in submeshes)
                {
                    foreach (int index in triangles)
                    {
                        if (wide) w.Write((uint) index);
                        else w.Write((ushort) index);
                    }
                }

                w.Flush();
                string file = "mesh" + Index(ctx, "meshes") + ".bin";
                ctx.File(file, stream.ToArray(), "mesh", string.IsNullOrEmpty(path) ? mesh.name : path);
                return new Node
                {
                    ["name"] = mesh.name,
                    ["file"] = file,
                    ["vertices"] = count,
                    ["triangles"] = indexCount / 3,
                    ["path"] = path
                };
            }
        }

        static Color MainColor(Material material)
        {
            if (material.HasProperty("_BaseColor")) return material.GetColor("_BaseColor");
            if (material.HasProperty("_Color")) return material.GetColor("_Color");
            if (material.HasProperty("_TintColor")) return material.GetColor("_TintColor");
            return Color.white;
        }

        static Node DumpMaterial(Material material, ExportContext ctx)
        {
            Scene(ctx);
            string shader = material.shader != null ? material.shader.name : "";
            string map = material.HasProperty("_BaseMap") ? "_BaseMap" : material.HasProperty("_MainTex") ? "_MainTex" : null;
            Texture texture = map != null ? material.GetTexture(map) : null;
            int mode = 0;
            if (material.renderQueue >= 3000) mode = 2;
            else if (material.renderQueue >= 2450 || material.IsKeywordEnabled("_ALPHATEST_ON")) mode = 1;
            Color color = MainColor(material);
            var node = new Node
            {
                ["name"] = material.name,
                ["shader"] = shader,
                ["color"] = Col(color),
                ["mode"] = mode,
                ["cutoff"] = material.HasProperty("_Cutoff") ? material.GetFloat("_Cutoff") : 0.5f,
                ["unlit"] = shader.Contains("Unlit") || shader.StartsWith("Sprites/") || shader.StartsWith("UI/") || shader.Contains("Particles") || shader.StartsWith("Skybox"),
                ["doubleSided"] = material.HasProperty("_Cull") && material.GetFloat("_Cull") < 0.5f,
                ["gloss"] = material.HasProperty("_Smoothness") ? material.GetFloat("_Smoothness") : material.HasProperty("_Glossiness") ? material.GetFloat("_Glossiness") : 0f,
                ["queue"] = material.renderQueue,
                ["path"] = AssetDatabase.GetAssetPath(material)
            };
            if (texture is Texture2D texture2D)
            {
                node["texture"] = ctx.Ref(texture2D);
                Vector2 scale = material.GetTextureScale(map);
                Vector2 offset = material.GetTextureOffset(map);
                node["st"] = new Node {["$v"] = new[] {scale.x, scale.y, offset.x, offset.y}};
            }
            else if (texture != null)
            {
                ctx.Warn("material " + material.name + " uses a " + texture.GetType().Name + " as its main texture, exported without it");
            }

            if (material.HasProperty("_EmissionColor") && material.IsKeywordEnabled("_EMISSION")) node["emission"] = Col(material.GetColor("_EmissionColor"));
            return node;
        }

        static byte[] Png(Texture source, int width, int height)
        {
            RenderTexture target = RenderTexture.GetTemporary(width, height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            RenderTexture previous = RenderTexture.active;
            try
            {
                Graphics.Blit(source, target);
                RenderTexture.active = target;
                var copy = new Texture2D(width, height, TextureFormat.RGBA32, false);
                copy.ReadPixels(new Rect(0, 0, width, height), 0, 0);
                copy.Apply();
                byte[] png = copy.EncodeToPNG();
                UnityEngine.Object.DestroyImmediate(copy);
                return png;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(target);
            }
        }

        static Node DumpTexture(Texture2D texture, ExportContext ctx)
        {
            string path = AssetDatabase.GetAssetPath(texture);
            float fit = Mathf.Min(1f, (float) MaxTexture / Mathf.Max(texture.width, texture.height));
            int width = Mathf.Max(1, Mathf.RoundToInt(texture.width * fit));
            int height = Mathf.Max(1, Mathf.RoundToInt(texture.height * fit));
            string file = "texture" + Index(ctx, "textures") + ".png";
            ctx.File(file, Png(texture, width, height), "texture", string.IsNullOrEmpty(path) ? texture.name : path);
            return new Node
            {
                ["name"] = texture.name,
                ["file"] = file,
                ["width"] = width,
                ["height"] = height,
                ["repeat"] = texture.wrapMode == TextureWrapMode.Repeat,
                ["point"] = texture.filterMode == FilterMode.Point,
                ["path"] = path
            };
        }

        static void Scene(ExportContext ctx)
        {
            if (ctx.Tables.ContainsKey("render")) return;
            var probe = new Color[3];
            if (RenderSettings.ambientMode == AmbientMode.Flat)
            {
                probe[0] = probe[1] = probe[2] = RenderSettings.ambientLight;
            }
            else if (RenderSettings.ambientMode == AmbientMode.Trilight)
            {
                probe[0] = RenderSettings.ambientSkyColor;
                probe[1] = RenderSettings.ambientEquatorColor;
                probe[2] = RenderSettings.ambientGroundColor;
            }
            else
            {
                RenderSettings.ambientProbe.Evaluate(SkyNormals, probe);
                if (Dark(probe))
                {
                    DynamicGI.UpdateEnvironment();
                    RenderSettings.ambientProbe.Evaluate(SkyNormals, probe);
                }

                bool encode = true;
                if (Dark(probe))
                {
                    encode = PlayerSettings.colorSpace == ColorSpace.Linear;
                    if (!SkyLight(probe)) ctx.Warn("the scene has no ambient light yet (no skybox probe); set render.ambient in playable.json");
                }

                if (encode)
                {
                    for (int i = 0; i < 3; i++) probe[i] = probe[i].gamma;
                }
            }

            var node = new Node
            {
                ["sky"] = Col(probe[0]),
                ["equator"] = Col(probe[1]),
                ["ground"] = Col(probe[2]),
                ["linear"] = PlayerSettings.colorSpace == ColorSpace.Linear,
                ["fog"] = RenderSettings.fog,
                ["fogColor"] = Col(RenderSettings.fogColor),
                ["fogMode"] = (int) RenderSettings.fogMode,
                ["fogDensity"] = RenderSettings.fogDensity,
                ["fogStart"] = RenderSettings.fogStartDistance,
                ["fogEnd"] = RenderSettings.fogEndDistance
            };
            ctx.Tables["render"] = new List<object> {node};
            string backdrop = Backdrop(ctx);
            if (backdrop != null) node["backdrop"] = backdrop;
        }

        static readonly Vector3[] SkyNormals = {Vector3.up, Vector3.forward, Vector3.down};

        static bool Dark(Color[] colors)
        {
            return colors[0].maxColorComponent + colors[1].maxColorComponent + colors[2].maxColorComponent < 0.002f;
        }

        static bool SkyLight(Color[] probe)
        {
            if (RenderSettings.skybox == null) return false;
            const int size = 16;
            var host = new GameObject("PlayablesSky") {hideFlags = HideFlags.HideAndDontSave};
            var cube = new Cubemap(size, TextureFormat.RGBA32, false);
            try
            {
                var camera = host.AddComponent<Camera>();
                camera.enabled = false;
                camera.cullingMask = 0;
                camera.clearFlags = CameraClearFlags.Skybox;
                if (!camera.RenderToCubemap(cube)) return false;
                var sum = new Vector3[3];
                for (int face = 0; face < 6; face++)
                {
                    Color[] pixels = cube.GetPixels((CubemapFace) face);
                    for (int y = 0; y < size; y++)
                    {
                        for (int x = 0; x < size; x++)
                        {
                            float u = (x + 0.5f) / size * 2f - 1f;
                            float v = (y + 0.5f) / size * 2f - 1f;
                            Vector3 d = face == 0 ? new Vector3(1, -v, -u) : face == 1 ? new Vector3(-1, -v, u) : face == 2 ? new Vector3(u, 1, v) : face == 3 ? new Vector3(u, -1, -v) : face == 4 ? new Vector3(u, -v, 1) : new Vector3(-u, -v, -1);
                            float solid = 4f / (size * size * Mathf.Pow(d.sqrMagnitude, 1.5f));
                            d.Normalize();
                            Color c = pixels[y * size + x];
                            for (int i = 0; i < 3; i++) sum[i] += new Vector3(c.r, c.g, c.b) * (Mathf.Max(0f, Vector3.Dot(d, SkyNormals[i])) * solid / Mathf.PI);
                        }
                    }
                }

                for (int i = 0; i < 3; i++) probe[i] = new Color(sum[i].x, sum[i].y, sum[i].z, 1f) * RenderSettings.ambientIntensity;
                return true;
            }
            catch (Exception)
            {
                return false;
            }
            finally
            {
                UnityEngine.Object.DestroyImmediate(cube);
                UnityEngine.Object.DestroyImmediate(host);
            }
        }

        static string Backdrop(ExportContext ctx)
        {
            if (RenderSettings.skybox == null) return null;
            Camera source = null;
#if UNITY_6000_6_OR_NEWER
            Camera[] cameras = UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsInactive.Exclude);
#else
            Camera[] cameras = UnityEngine.Object.FindObjectsByType<Camera>(FindObjectsInactive.Exclude, FindObjectsSortMode.None);
#endif
            foreach (Camera camera in cameras)
            {
                if (camera.clearFlags == CameraClearFlags.Skybox && (source == null || camera.CompareTag("MainCamera"))) source = camera;
            }

            if (source == null) return null;
            var host = new GameObject("PlayablesBackdrop") {hideFlags = HideFlags.HideAndDontSave};
            RenderTexture target = RenderTexture.GetTemporary(144, 256, 16, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            RenderTexture previous = RenderTexture.active;
            try
            {
                var camera = host.AddComponent<Camera>();
                camera.CopyFrom(source);
                camera.enabled = false;
                camera.cullingMask = 0;
                camera.rect = new Rect(0, 0, 1, 1);
                camera.aspect = 9f / 16f;
                camera.targetTexture = target;
                camera.Render();
                RenderTexture.active = target;
                var copy = new Texture2D(target.width, target.height, TextureFormat.RGB24, false);
                copy.ReadPixels(new Rect(0, 0, target.width, target.height), 0, 0);
                copy.Apply();
                byte[] png = copy.EncodeToPNG();
                UnityEngine.Object.DestroyImmediate(copy);
                camera.targetTexture = null;
                return ctx.File("backdrop.png", png, "texture", AssetDatabase.GetAssetPath(RenderSettings.skybox));
            }
            catch (Exception e)
            {
                ctx.Warn("the skybox backdrop could not be rendered: " + e.Message);
                return null;
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(target);
                UnityEngine.Object.DestroyImmediate(host);
            }
        }
    }
}
