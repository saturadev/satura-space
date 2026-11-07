using System;
using System.IO;
using UnityEngine;

namespace HotReloadPrototype.Editor {
    internal static class HotReloadPaths {
        static string projectRoot;

        public static string ProjectRoot =>
            projectRoot ?? (projectRoot = Directory.GetParent(Application.dataPath).FullName);

        public static string Norm(string p) => p.Replace('\\', '/').ToLowerInvariant();

        public static string ToFull(string projectRelative) =>
            Path.IsPathRooted(projectRelative) ? projectRelative : Path.Combine(ProjectRoot, projectRelative);

        public static string MakeProjectRelative(string fullPath) {
            var full = Path.GetFullPath(fullPath);
            if (full.StartsWith(ProjectRoot, StringComparison.OrdinalIgnoreCase))
                return full.Substring(ProjectRoot.Length).TrimStart('/', '\\');
            return full;
        }
    }
}
