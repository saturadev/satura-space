using System.Collections.Generic;
using System.IO;
using System.Linq;
using UnityEditor;
using UnityEngine;

namespace SaturaSpace.Playables
{
    public static class AtlasPacker
    {
        private class Source
        {
            public Color32[] pixels;
            public int width;
            public int height;
        }

        private class Item
        {
            public int index;
            public Sprite sprite;
            public Source source;
            public float scale;
            public int sx;
            public int sy;
            public int w;
            public int h;
            public int page;
            public int x;
            public int y;
        }

        private class Layout
        {
            public int width;
            public List<int> heights = new List<int>();
            public long Area => heights.Sum(h => (long) h * width);
        }

        public static List<object> Pack(List<Sprite> sprites, ExportConfig config, ExportContext ctx, List<object> atlasesNode)
        {
            int maxSize = config.atlasMaxSize;
            int padding = config.atlasPadding;
            var sources = new Dictionary<Texture2D, Source>();
            var items = new List<Item>();
            for (int i = 0; i < sprites.Count; i++)
            {
                Sprite sprite = sprites[i];
                Texture2D texture = sprite.texture;
                if (!sources.TryGetValue(texture, out Source source))
                {
                    source = Downscale(ReadSource(texture, ctx), ScaleOf(AssetDatabase.GetAssetPath(texture), config));
                    sources[texture] = source;
                }

                float scale = (float) source.width / texture.width;
                Rect rect = sprite.rect;
                items.Add(new Item
                {
                    index = i,
                    sprite = sprite,
                    source = source,
                    scale = scale,
                    sx = Mathf.RoundToInt(rect.x * scale),
                    sy = Mathf.RoundToInt(rect.y * scale),
                    w = Mathf.Max(1, Mathf.RoundToInt(rect.width * scale)),
                    h = Mathf.Max(1, Mathf.RoundToInt(rect.height * scale))
                });
            }

            List<Item> ordered = items.OrderByDescending(item => item.h).ThenByDescending(item => item.w).ToList();
            Layout best = null;
            int minWidth = Mathf.NextPowerOfTwo(Mathf.Max(64, ordered.Count > 0 ? ordered.Max(item => item.w) + padding * 2 : 64));
            for (int width = minWidth; width <= Mathf.Max(maxSize, minWidth); width *= 2)
            {
                Layout layout = Place(ordered, width, Mathf.Max(maxSize, minWidth), padding);
                if (best == null || layout.heights.Count < best.heights.Count ||
                    (layout.heights.Count == best.heights.Count && layout.Area < best.Area))
                {
                    best = layout;
                }
            }

            var spritesNode = new List<object>();
            if (best == null) return spritesNode;
            Place(ordered, best.width, Mathf.Max(maxSize, minWidth), padding);

            for (int page = 0; page < best.heights.Count; page++)
            {
                int width = best.width;
                int height = best.heights[page];
                var pixels = new Color32[width * height];
                foreach (Item item in items.Where(item => item.page == page))
                {
                    for (int row = 0; row < item.h; row++)
                    {
                        int srcRow = Mathf.Clamp(item.sy + row, 0, item.source.height - 1);
                        for (int col = 0; col < item.w; col++)
                        {
                            int srcCol = Mathf.Clamp(item.sx + col, 0, item.source.width - 1);
                            pixels[(item.y + row) * width + item.x + col] = item.source.pixels[srcRow * item.source.width + srcCol];
                        }
                    }
                }

                var atlas = new Texture2D(width, height, TextureFormat.RGBA32, false);
                atlas.SetPixels32(pixels);
                atlas.Apply(false, false);
                string file = "atlas" + page + ".png";
                ctx.File(file, atlas.EncodeToPNG(), "atlas", string.Join(",", items.Where(item => item.page == page).Select(item => AssetDatabase.GetAssetPath(item.sprite.texture)).Distinct()));
                Object.DestroyImmediate(atlas);
                atlasesNode.Add(new Node {["file"] = file, ["width"] = width, ["height"] = height});
            }

            foreach (Item item in items)
            {
                Sprite sprite = item.sprite;
                Vector4 border = sprite.border * item.scale;
                spritesNode.Add(new Node
                {
                    ["name"] = sprite.name,
                    ["path"] = AssetDatabase.GetAssetPath(sprite),
                    ["atlas"] = item.page,
                    ["x"] = item.x,
                    ["y"] = best.heights[item.page] - item.y - item.h,
                    ["w"] = item.w,
                    ["h"] = item.h,
                    ["px"] = sprite.pivot.x * item.scale,
                    ["py"] = sprite.pivot.y * item.scale,
                    ["ppu"] = sprite.pixelsPerUnit * item.scale,
                    ["border"] = new[] {border.x, border.y, border.z, border.w}
                });
            }

            return spritesNode;
        }

        private static Layout Place(List<Item> ordered, int width, int maxHeight, int padding)
        {
            var layout = new Layout {width = width};
            int page = 0;
            int cursorX = padding;
            int cursorY = padding;
            int shelf = 0;
            int used = 0;
            foreach (Item item in ordered)
            {
                if (cursorX + item.w + padding > width)
                {
                    cursorX = padding;
                    cursorY += shelf + padding;
                    shelf = 0;
                }

                if (cursorY + item.h + padding > maxHeight && used > 0)
                {
                    layout.heights.Add(cursorY + shelf + padding);
                    page++;
                    cursorX = padding;
                    cursorY = padding;
                    shelf = 0;
                    used = 0;
                }

                item.page = page;
                item.x = cursorX;
                item.y = cursorY;
                cursorX += item.w + padding;
                shelf = Mathf.Max(shelf, item.h);
                used++;
            }

            layout.heights.Add(cursorY + shelf + padding);
            return layout;
        }

        private static float ScaleOf(string path, ExportConfig config)
        {
            float scale = config.spriteScale > 0 ? config.spriteScale : 1f;
            foreach (ScaleRule rule in config.spriteScales ?? new ScaleRule[0])
            {
                if (rule != null && !string.IsNullOrEmpty(rule.path) && (path == rule.path || path.StartsWith(rule.path.TrimEnd('/') + "/"))) scale = rule.scale;
            }

            return Mathf.Clamp(scale, 0.05f, 1f);
        }

        private static Source Downscale(Source source, float scale)
        {
            if (scale >= 0.999f) return source;
            int width = Mathf.Max(1, Mathf.RoundToInt(source.width * scale));
            int height = Mathf.Max(1, Mathf.RoundToInt(source.height * scale));
            var pixels = new Color32[width * height];
            float fx = (float) source.width / width;
            float fy = (float) source.height / height;
            for (int y = 0; y < height; y++)
            {
                int y0 = Mathf.FloorToInt(y * fy);
                int y1 = Mathf.Max(y0 + 1, Mathf.Min(source.height, Mathf.FloorToInt((y + 1) * fy)));
                for (int x = 0; x < width; x++)
                {
                    int x0 = Mathf.FloorToInt(x * fx);
                    int x1 = Mathf.Max(x0 + 1, Mathf.Min(source.width, Mathf.FloorToInt((x + 1) * fx)));
                    float r = 0, g = 0, b = 0, a = 0;
                    for (int sy = y0; sy < y1; sy++)
                    {
                        for (int sx = x0; sx < x1; sx++)
                        {
                            Color32 c = source.pixels[sy * source.width + sx];
                            float w = c.a / 255f;
                            r += c.r * w;
                            g += c.g * w;
                            b += c.b * w;
                            a += w;
                        }
                    }

                    int n = (y1 - y0) * (x1 - x0);
                    pixels[y * width + x] = a > 0
                        ? new Color32((byte) Mathf.RoundToInt(r / a), (byte) Mathf.RoundToInt(g / a), (byte) Mathf.RoundToInt(b / a), (byte) Mathf.RoundToInt(a * 255f / n))
                        : new Color32(0, 0, 0, 0);
                }
            }

            return new Source {pixels = pixels, width = width, height = height};
        }

        private static Source ReadSource(Texture2D texture, ExportContext ctx)
        {
            string path = AssetDatabase.GetAssetPath(texture);
            string extension = Path.GetExtension(path).ToLowerInvariant();
            if (extension == ".png" || extension == ".jpg" || extension == ".jpeg")
            {
                var loaded = new Texture2D(2, 2, TextureFormat.RGBA32, false);
                if (loaded.LoadImage(File.ReadAllBytes(path), false))
                {
                    var source = new Source {pixels = loaded.GetPixels32(), width = loaded.width, height = loaded.height};
                    Object.DestroyImmediate(loaded);
                    return source;
                }

                Object.DestroyImmediate(loaded);
            }

            ctx.Warn("texture " + path + " read through a render target, colours may differ slightly");
            RenderTexture target = RenderTexture.GetTemporary(texture.width, texture.height, 0, RenderTextureFormat.ARGB32, RenderTextureReadWrite.sRGB);
            Graphics.Blit(texture, target);
            RenderTexture previous = RenderTexture.active;
            RenderTexture.active = target;
            var copy = new Texture2D(texture.width, texture.height, TextureFormat.RGBA32, false);
            copy.ReadPixels(new Rect(0, 0, texture.width, texture.height), 0, 0);
            copy.Apply(false, false);
            RenderTexture.active = previous;
            RenderTexture.ReleaseTemporary(target);
            var result = new Source {pixels = copy.GetPixels32(), width = copy.width, height = copy.height};
            Object.DestroyImmediate(copy);
            return result;
        }
    }
}
