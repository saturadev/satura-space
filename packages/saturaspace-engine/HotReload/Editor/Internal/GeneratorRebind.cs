using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis;
using SaturaSpace.Vendor.Microsoft.CodeAnalysis.CSharp;
using Cecil = SaturaSpace.Vendor.Mono.Cecil;

namespace HotReloadPrototype.Editor {
    internal static class GeneratorRebind {
        const string Prefix = "SaturaSpace.Vendor.";

        static readonly Dictionary<string, Assembly> loaded = new Dictionary<string, Assembly>(StringComparer.OrdinalIgnoreCase);
        static Dictionary<string, Assembly> homes;

        static Dictionary<string, Assembly> Homes() {
            if (homes != null) return homes;
            return homes = new Dictionary<string, Assembly>(StringComparer.Ordinal) {
                { "Microsoft.CodeAnalysis", typeof(Compilation).Assembly },
                { "Microsoft.CodeAnalysis.CSharp", typeof(CSharpCompilation).Assembly },
                { "System.Collections.Immutable", typeof(SaturaSpace.Vendor.System.Collections.Immutable.ImmutableArray).Assembly },
                { "System.Reflection.Metadata", typeof(SaturaSpace.Vendor.System.Reflection.Metadata.MetadataReader).Assembly },
                { "System.Runtime.CompilerServices.Unsafe", typeof(SaturaSpace.Vendor.System.Runtime.CompilerServices.Unsafe).Assembly },
            };
        }

        internal static Assembly Load(string path) {
            string key = path + "|" + File.GetLastWriteTimeUtc(path).Ticks;
            if (loaded.TryGetValue(key, out var hit)) return hit;
            var asm = Rewrite(path) ?? Assembly.LoadFrom(path);
            loaded[key] = asm;
            return asm;
        }

        static Assembly Rewrite(string path) {
            var map = Homes();
            using (var resolver = new Cecil.DefaultAssemblyResolver()) {
                resolver.AddSearchDirectory(Path.GetDirectoryName(path));
                foreach (var home in map.Values.Select(a => a.Location).Where(l => !string.IsNullOrEmpty(l)).Select(Path.GetDirectoryName).Distinct())
                    resolver.AddSearchDirectory(home);
                var corlib = Path.GetDirectoryName(typeof(object).Assembly.Location);
                if (!string.IsNullOrEmpty(corlib)) {
                    resolver.AddSearchDirectory(corlib);
                    resolver.AddSearchDirectory(Path.Combine(corlib, "Facades"));
                }
                using (var module = Cecil.ModuleDefinition.ReadModule(path, new Cecil.ReaderParameters { InMemory = true, AssemblyResolver = resolver })) {
                    var refs = module.AssemblyReferences.Where(r => map.ContainsKey(r.Name)).ToList();
                    if (refs.Count == 0) return null;
                    foreach (var tr in module.GetTypeReferences()) {
                        if (tr.DeclaringType != null || tr.Namespace.Length == 0) continue;
                        if (tr.Scope is Cecil.AssemblyNameReference a && map.ContainsKey(a.Name) && !tr.Namespace.StartsWith(Prefix, StringComparison.Ordinal))
                            tr.Namespace = Prefix + tr.Namespace;
                    }
                    var targets = new Dictionary<string, Cecil.AssemblyNameReference>(StringComparer.Ordinal);
                    var retarget = new Dictionary<Cecil.AssemblyNameReference, Cecil.AssemblyNameReference>();
                    foreach (var r in refs) {
                        var home = map[r.Name].GetName();
                        if (targets.TryGetValue(home.Name, out var first)) { retarget[r] = first; continue; }
                        r.Name = home.Name;
                        r.Version = home.Version;
                        r.PublicKey = Array.Empty<byte>();
                        r.PublicKeyToken = Array.Empty<byte>();
                        r.HasPublicKey = false;
                        targets[home.Name] = r;
                    }
                    if (retarget.Count > 0) {
                        foreach (var tr in module.GetTypeReferences())
                            if (tr.Scope is Cecil.AssemblyNameReference a && retarget.TryGetValue(a, out var to)) tr.Scope = to;
                        foreach (var r in retarget.Keys) module.AssemblyReferences.Remove(r);
                    }
                    module.Attributes &= ~Cecil.ModuleAttributes.StrongNameSigned;
                    using (var ms = new MemoryStream()) {
                        module.Write(ms);
                        return Assembly.Load(ms.ToArray());
                    }
                }
            }
        }
    }
}
