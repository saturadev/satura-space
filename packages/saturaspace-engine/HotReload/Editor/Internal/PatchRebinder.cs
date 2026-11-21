using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using SaturaSpace.Vendor.Mono.Cecil;
using SaturaSpace.Vendor.Mono.Cecil.Cil;
using RAssembly = System.Reflection.Assembly;
using RBindingFlags = System.Reflection.BindingFlags;
using RMethodBase = System.Reflection.MethodBase;

namespace HotReloadPrototype.Editor {
    internal static class PatchRebinder {
        public sealed class Output {
            public byte[] pe;
            public byte[] pdb;
            public readonly List<int> methodTokens = new List<int>();
            public readonly List<string> keptInPatch = new List<string>();
            public int rebound;
            public string symbolsDropped;
        }

        public static Output Run(byte[] pe, byte[] pdb, RAssembly live, IEnumerable<string> referencePaths = null,
                                 IEnumerable<string> changedTypes = null) {
            if (pe == null) throw new ArgumentNullException(nameof(pe));
            if (live == null) throw new ArgumentNullException(nameof(live));
            var refs = referencePaths?.Where(p => !string.IsNullOrEmpty(p)).ToList() ?? new List<string>();
            try {
                return RunCore(pe, pdb, live, refs, changedTypes, withSymbols: pdb != null);
            } catch (Exception e) when (pdb != null) {
                var o = RunCore(pe, null, live, refs, changedTypes, withSymbols: false);
                o.symbolsDropped = e.GetType().Name + ": " + e.Message;
                return o;
            }
        }

        public static void AfterLoad(RAssembly patch, Output o) {
            if (patch == null || o == null) return;
            var module = patch.ManifestModule;
            foreach (var token in o.methodTokens) {
                try { MonoInterop.DisableVisibilityChecks(module.ResolveMethod(token)); } catch { }
            }
        }

        static Output RunCore(byte[] pe, byte[] pdb, RAssembly live, List<string> refs, IEnumerable<string> changedTypes, bool withSymbols) {
            var rp = new ReaderParameters { InMemory = true, ReadingMode = ReadingMode.Deferred, AssemblyResolver = new PathResolver(refs) };
            if (withSymbols) {
                rp.ReadSymbols = true;
                rp.SymbolStream = new MemoryStream(pdb);
                rp.SymbolReaderProvider = new PortablePdbReaderProvider();
            }
            using (rp.AssemblyResolver)
            using (var module = ModuleDefinition.ReadModule(new MemoryStream(pe), rp)) {
                var r = new Rebinder(module, live);
                var o = new Output();
                r.Apply(o, changedTypes);
                using (var peOut = new MemoryStream())
                using (var pdbOut = withSymbols ? new MemoryStream() : null) {
                    var wp = new WriterParameters();
                    if (withSymbols) {
                        wp.WriteSymbols = true;
                        wp.SymbolStream = pdbOut;
                        wp.SymbolWriterProvider = new PortablePdbWriterProvider();
                    }
                    module.Write(peOut, wp);
                    o.pe = peOut.ToArray();
                    o.pdb = pdbOut?.ToArray();
                }
                foreach (var md in r.flagged) o.methodTokens.Add(md.MetadataToken.ToInt32());
                return o;
            }
        }

        sealed class PathResolver : DefaultAssemblyResolver {
            readonly Dictionary<string, string> byName = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            readonly Dictionary<string, AssemblyDefinition> cache = new Dictionary<string, AssemblyDefinition>(StringComparer.OrdinalIgnoreCase);

            public PathResolver(List<string> refs) {
                foreach (var p in refs) {
                    var n = Path.GetFileNameWithoutExtension(p);
                    if (!byName.ContainsKey(n)) byName[n] = p;
                }
                var dirs = new HashSet<string>(StringComparer.Ordinal);
                foreach (var a in AppDomain.CurrentDomain.GetAssemblies()) {
                    string loc;
                    try { loc = a.IsDynamic ? null : a.Location; } catch { loc = null; }
                    if (string.IsNullOrEmpty(loc)) continue;
                    var dir = Path.GetDirectoryName(loc);
                    if (!string.IsNullOrEmpty(dir) && dirs.Add(dir)) AddSearchDirectory(dir);
                }
            }

            public override AssemblyDefinition Resolve(AssemblyNameReference name) {
                if (cache.TryGetValue(name.Name, out var hit)) return hit;
                AssemblyDefinition a = null;
                if (byName.TryGetValue(name.Name, out var path) && File.Exists(path)) {
                    try {
                        a = AssemblyDefinition.ReadAssembly(path, new ReaderParameters { AssemblyResolver = this, ReadingMode = ReadingMode.Deferred });
                    } catch { a = null; }
                }
                a = a ?? base.Resolve(name);
                cache[name.Name] = a;
                return a;
            }

            protected override void Dispose(bool disposing) {
                foreach (var a in cache.Values) a?.Dispose();
                cache.Clear();
                base.Dispose(disposing);
            }
        }

        sealed class RefEq<T> : IEqualityComparer<T> where T : class {
            public static readonly RefEq<T> Instance = new RefEq<T>();
            public bool Equals(T a, T b) => ReferenceEquals(a, b);
            public int GetHashCode(T o) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(o);
        }

        sealed class Rebinder {
            const RBindingFlags All = RBindingFlags.Instance | RBindingFlags.Static | RBindingFlags.Public |
                                      RBindingFlags.NonPublic | RBindingFlags.DeclaredOnly;

            readonly ModuleDefinition module;
            readonly RAssembly live;
            readonly AssemblyNameReference liveScope;
            bool scopeAdded;

            readonly Dictionary<TypeDefinition, Type> liveTypes = new Dictionary<TypeDefinition, Type>(RefEq<TypeDefinition>.Instance);
            readonly Dictionary<TypeDefinition, TypeReference> liveRefs = new Dictionary<TypeDefinition, TypeReference>(RefEq<TypeDefinition>.Instance);
            readonly Dictionary<Type, HashSet<string>> liveMethodKeys = new Dictionary<Type, HashSet<string>>();
            readonly Dictionary<TypeReference, TypeReference> typeMemo = new Dictionary<TypeReference, TypeReference>(RefEq<TypeReference>.Instance);
            readonly Dictionary<MemberReference, MemberReference> memberMemo = new Dictionary<MemberReference, MemberReference>(RefEq<MemberReference>.Instance);
            readonly HashSet<string> kept = new HashSet<string>(StringComparer.Ordinal);
            public readonly List<MethodDefinition> flagged = new List<MethodDefinition>();
            int rebound;

            public Rebinder(ModuleDefinition module, RAssembly live) {
                this.module = module;
                this.live = live;
                var n = live.GetName();
                liveScope = new AssemblyNameReference(n.Name, n.Version ?? new Version(0, 0, 0, 0));
                var token = n.GetPublicKeyToken();
                if (token != null && token.Length > 0) liveScope.PublicKeyToken = token;
                if (!string.IsNullOrEmpty(n.CultureName)) liveScope.Culture = n.CultureName;
            }

            public void Apply(Output o, IEnumerable<string> changedTypes) {
                var types = module.GetTypes().ToList();

                foreach (var td in types) {
                    if (IsShadow(td)) {
                        foreach (var md in td.Methods)
                            if (IsGeneratedName(md.Name)) RetargetSignature(md);
                        continue;
                    }
                    if (td.BaseType != null) td.BaseType = RT(td.BaseType);
                    foreach (var i in td.Interfaces) i.InterfaceType = RT(i.InterfaceType);
                    foreach (var f in td.Fields) f.FieldType = RT(f.FieldType);
                    RetargetConstraints(td);
                    foreach (var md in td.Methods) RetargetSignature(md);
                }
                foreach (var td in types) {
                    if (IsShadow(td)) continue;
                    foreach (var md in td.Methods)
                        for (int i = 0; i < md.Overrides.Count; i++) md.Overrides[i] = RM(md.Overrides[i]);
                }

                typeMemo.Clear();
                memberMemo.Clear();
                collecting = true;
                if (changedTypes == null) {
                    foreach (var td in types) ReachType(td);
                } else {
                    foreach (var name in changedTypes) {
                        var td = module.GetType(name.Replace('+', '/'));
                        if (td != null) ReachType(td);
                    }
                }
                while (queue.Count > 0) {
                    var md = queue.Dequeue();
                    var td = md.DeclaringType;
                    bool shadow = IsShadow(td);
                    if (shadow && md.IsConstructor && md.IsStatic) continue;
                    RetargetBody(md.Body);
                    if (!shadow || IsGeneratedName(md.Name) || !LiveHasMethod(td, md)) flagged.Add(md);
                }

                o.rebound = rebound;
                o.keptInPatch.AddRange(kept);
            }

            bool collecting;
            readonly Queue<MethodDefinition> queue = new Queue<MethodDefinition>();
            readonly HashSet<MethodDefinition> reached = new HashSet<MethodDefinition>(RefEq<MethodDefinition>.Instance);
            readonly HashSet<TypeDefinition> reachedTypes = new HashSet<TypeDefinition>(RefEq<TypeDefinition>.Instance);

            void Reach(MethodDefinition md) {
                if (collecting && md.HasBody && reached.Add(md)) queue.Enqueue(md);
            }

            void ReachType(TypeDefinition td) {
                if (!collecting || !reachedTypes.Add(td)) return;
                foreach (var md in td.Methods) Reach(md);
            }

            void ReachKept(TypeDefinition td) {
                if (!collecting || td.Module != module || IsShadow(td) || td.Name == "<Module>") return;
                if (!IsGenerated(td) && !IsCompilerEmbedded(td)) Keep(TypeName(td) + " (new type)");
                ReachType(td);
            }

            void RetargetSignature(MethodDefinition md) {
                md.ReturnType = RT(md.ReturnType);
                foreach (var p in md.Parameters) p.ParameterType = RT(p.ParameterType);
                RetargetConstraints(md);
            }

            void RetargetConstraints(IGenericParameterProvider owner) {
                if (!owner.HasGenericParameters) return;
                foreach (var gp in owner.GenericParameters)
                    foreach (var c in gp.Constraints) c.ConstraintType = RT(c.ConstraintType);
            }

            void RetargetBody(MethodBody body) {
                foreach (var v in body.Variables) v.VariableType = RT(v.VariableType);
                foreach (var eh in body.ExceptionHandlers)
                    if (eh.CatchType != null) eh.CatchType = RT(eh.CatchType);
                foreach (var ins in body.Instructions) {
                    switch (ins.Operand) {
                        case TypeReference t: ins.Operand = RT(t); break;
                        case FieldReference f: ins.Operand = RF(f); break;
                        case MethodReference m: ins.Operand = RM(m); break;
                        case CallSite cs:
                            cs.ReturnType = RT(cs.ReturnType);
                            foreach (var p in cs.Parameters) p.ParameterType = RT(p.ParameterType);
                            break;
                    }
                }
            }

            static bool IsGeneratedName(string name) => name.Length > 0 && name[0] == '<';

            static bool IsGenerated(TypeDefinition td) {
                for (var t = td; t != null; t = t.DeclaringType)
                    if (IsGeneratedName(t.Name)) return true;
                return false;
            }

            bool IsShadow(TypeDefinition td) => LiveType(td) != null;

            Type LiveType(TypeDefinition td) {
                if (liveTypes.TryGetValue(td, out var lt)) return lt;
                lt = null;
                if (!IsGenerated(td) && (td.DeclaringType == null || LiveType(td.DeclaringType) != null)) {
                    try { lt = live.GetType(td.FullName.Replace('/', '+'), false); } catch { lt = null; }
                    if (lt != null && lt.IsValueType != td.IsValueType) lt = null;
                }
                liveTypes[td] = lt;
                return lt;
            }

            TypeReference LiveRef(TypeDefinition td) {
                if (liveRefs.TryGetValue(td, out var r)) return r;
                r = null;
                if (LiveType(td) != null) {
                    if (!scopeAdded) { module.AssemblyReferences.Add(liveScope); scopeAdded = true; }
                    var tr = new TypeReference(td.Namespace, td.Name, module, liveScope, td.IsValueType);
                    if (td.DeclaringType != null) tr.DeclaringType = LiveRef(td.DeclaringType);
                    foreach (var gp in td.GenericParameters) tr.GenericParameters.Add(new GenericParameter(gp.Name, tr));
                    r = tr;
                }
                liveRefs[td] = r;
                return r;
            }

            TypeDefinition OwnDef(TypeReference decl) {
                if (decl is TypeDefinition td) return td.Module == module ? td : null;
                if (decl is GenericInstanceType g && g.ElementType is TypeDefinition e) return e.Module == module ? e : null;
                return null;
            }

            TypeReference RT(TypeReference t) {
                if (t == null) return null;
                if (typeMemo.TryGetValue(t, out var r)) return r;
                r = RTCore(t);
                typeMemo[t] = r;
                return r;
            }

            TypeReference RTCore(TypeReference t) {
                switch (t) {
                    case GenericParameter _:
                        return t;
                    case TypeDefinition td: {
                        if (td.Module != module) return t;
                        var lr = LiveRef(td);
                        if (lr == null) { ReachKept(td); return t; }
                        rebound++;
                        return lr;
                    }
                    case GenericInstanceType g: {
                        var e = RT(g.ElementType);
                        var args = g.GenericArguments.Select(RT).ToList();
                        if (e == g.ElementType && Same(args, g.GenericArguments)) return t;
                        var n = new GenericInstanceType(e);
                        foreach (var a in args) n.GenericArguments.Add(a);
                        return n;
                    }
                    case ArrayType a: {
                        var e = RT(a.ElementType);
                        if (e == a.ElementType) return t;
                        if (a.IsVector) return new ArrayType(e);
                        var n = new ArrayType(e);
                        n.Dimensions.Clear();
                        foreach (var d in a.Dimensions) n.Dimensions.Add(new ArrayDimension(d.LowerBound, d.UpperBound));
                        return n;
                    }
                    case ByReferenceType b: { var e = RT(b.ElementType); return e == b.ElementType ? t : new ByReferenceType(e); }
                    case PointerType p: { var e = RT(p.ElementType); return e == p.ElementType ? t : new PointerType(e); }
                    case PinnedType p: { var e = RT(p.ElementType); return e == p.ElementType ? t : new PinnedType(e); }
                    case SentinelType s: { var e = RT(s.ElementType); return e == s.ElementType ? t : new SentinelType(e); }
                    case RequiredModifierType m: {
                        var e = RT(m.ElementType); var mod = RT(m.ModifierType);
                        return e == m.ElementType && mod == m.ModifierType ? t : new RequiredModifierType(mod, e);
                    }
                    case OptionalModifierType m: {
                        var e = RT(m.ElementType); var mod = RT(m.ModifierType);
                        return e == m.ElementType && mod == m.ModifierType ? t : new OptionalModifierType(mod, e);
                    }
                    default:
                        return t;
                }
            }

            TypeReference RTArgs(TypeReference decl) {
                if (!(decl is GenericInstanceType g)) return decl;
                var args = g.GenericArguments.Select(RT).ToList();
                if (Same(args, g.GenericArguments)) return decl;
                var n = new GenericInstanceType(g.ElementType);
                foreach (var a in args) n.GenericArguments.Add(a);
                return n;
            }

            static bool Same(IList<TypeReference> a, IList<TypeReference> b) {
                for (int i = 0; i < a.Count; i++) if (a[i] != b[i]) return false;
                return true;
            }

            FieldReference RF(FieldReference f) {
                if (memberMemo.TryGetValue(f, out var hit)) return (FieldReference)hit;
                var r = RFCore(f);
                memberMemo[f] = r;
                return r;
            }

            FieldReference RFCore(FieldReference f) {
                var decl = f.DeclaringType;
                var td = OwnDef(decl);
                if (td == null) {
                    var nd = RT(decl);
                    var ft = RT(f.FieldType);
                    return nd == decl && ft == f.FieldType ? f : new FieldReference(f.Name, ft, nd);
                }
                var fd = f as FieldDefinition ?? td.Fields.FirstOrDefault(x => x.Name == f.Name);
                if (fd == null) return f;
                if (LiveHasField(td, fd)) {
                    rebound++;
                    return new FieldReference(fd.Name, RT(fd.FieldType), RT(decl));
                }
                if (IsShadow(td)) Keep($"{TypeName(td)}.{fd.Name} (new {(fd.IsStatic ? "static field" : "instance field — unsafe on live objects")})");
                else ReachKept(td);
                if (f is FieldDefinition) return f;
                var nd2 = RTArgs(decl);
                return nd2 == decl ? f : new FieldReference(fd.Name, fd.FieldType, nd2);
            }

            bool LiveHasField(TypeDefinition td, FieldDefinition fd) {
                var lt = LiveType(td);
                if (lt == null) return false;
                try {
                    var fi = lt.GetField(fd.Name, All);
                    return fi != null && fi.IsStatic == fd.IsStatic && RKey(fi.FieldType) == CKey(fd.FieldType);
                } catch {
                    return false;
                }
            }

            MethodReference RM(MethodReference m) {
                if (memberMemo.TryGetValue(m, out var hit)) return (MethodReference)hit;
                var r = RMCore(m);
                memberMemo[m] = r;
                return r;
            }

            MethodReference RMCore(MethodReference m) {
                if (m is GenericInstanceMethod gim) {
                    var e = RM(gim.ElementMethod);
                    var args = gim.GenericArguments.Select(RT).ToList();
                    if (e == gim.ElementMethod && Same(args, gim.GenericArguments)) return m;
                    var n = new GenericInstanceMethod(e);
                    foreach (var a in args) n.GenericArguments.Add(a);
                    return n;
                }

                var decl = m.DeclaringType;
                var td = OwnDef(decl);
                if (td == null) {
                    var nd = RT(decl);
                    var ret = RT(m.ReturnType);
                    var ps = m.Parameters.Select(p => RT(p.ParameterType)).ToList();
                    if (nd == decl && ret == m.ReturnType && Same(ps, m.Parameters.Select(p => p.ParameterType).ToList())) return m;
                    return Clone(m, m, nd, ret, ps);
                }

                var md = m as MethodDefinition ?? FindDef(td, m);
                if (md == null) return m;
                if (LiveHasMethod(td, md)) {
                    rebound++;
                    return Clone(m, md, RT(decl), RT(md.ReturnType), md.Parameters.Select(p => RT(p.ParameterType)).ToList());
                }
                if (IsShadow(td)) {
                    if (!IsGeneratedName(md.Name) && !(md.IsConstructor && md.IsStatic))
                        Keep($"{TypeName(td)}.{md.Name}({string.Join(", ", md.Parameters.Select(p => p.ParameterType.Name))}) (new or changed signature)");
                    Reach(md);
                } else {
                    ReachKept(td);
                }
                if (m is MethodDefinition) return m;
                var nd2 = RTArgs(decl);
                return nd2 == decl ? m : Clone(m, md, nd2, md.ReturnType, md.Parameters.Select(p => p.ParameterType).ToList());
            }

            static MethodReference Clone(MethodReference m, MethodReference sig, TypeReference decl, TypeReference ret, List<TypeReference> ps) {
                var n = new MethodReference(m.Name, ret, decl) {
                    HasThis = m.HasThis,
                    ExplicitThis = m.ExplicitThis,
                    CallingConvention = m.CallingConvention,
                };
                foreach (var gp in sig.GenericParameters) n.GenericParameters.Add(new GenericParameter(gp.Name, n));
                foreach (var p in ps) n.Parameters.Add(new ParameterDefinition(p));
                return n;
            }

            static MethodDefinition FindDef(TypeDefinition td, MethodReference m) {
                var key = CKeySig(m);
                foreach (var md in td.Methods)
                    if (md.Name == m.Name && md.Parameters.Count == m.Parameters.Count && CKeySig(md) == key) return md;
                return null;
            }

            bool LiveHasMethod(TypeDefinition td, MethodDefinition md) {
                if (IsGeneratedName(md.Name) || (md.IsConstructor && md.IsStatic)) return false;
                var lt = LiveType(td);
                if (lt == null) return false;
                if (!liveMethodKeys.TryGetValue(lt, out var keys)) {
                    keys = new HashSet<string>(StringComparer.Ordinal);
                    try {
                        foreach (var mi in lt.GetMethods(All)) TryAdd(keys, mi);
                        foreach (var ci in lt.GetConstructors(All)) TryAdd(keys, ci);
                    } catch { }
                    liveMethodKeys[lt] = keys;
                }
                return keys.Contains(CKeyMethod(md));
            }

            static void TryAdd(HashSet<string> keys, RMethodBase mb) {
                try { keys.Add(RKeyMethod(mb)); } catch { }
            }

            void Keep(string what) {
                kept.Add(what);
            }

            static string TypeName(TypeDefinition td) => td.FullName.Replace('/', '+');

            static bool IsCompilerEmbedded(TypeDefinition td) =>
                td.Namespace == "Microsoft.CodeAnalysis" || td.Namespace == "System.Runtime.CompilerServices";

            static string CKeyMethod(MethodDefinition md) =>
                md.Name + "|" + (md.IsStatic ? "s" : "i") + "|" + md.GenericParameters.Count + "|" + CKeySig(md);

            static string CKeySig(MethodReference m) =>
                CKey(m.ReturnType) + "(" + string.Join(",", m.Parameters.Select(p => CKey(p.ParameterType))) + ")";

            static string RKeyMethod(RMethodBase mb) {
                var ret = mb is System.Reflection.MethodInfo mi ? RKey(mi.ReturnType) : "System.Void";
                int arity = mb.IsGenericMethodDefinition ? mb.GetGenericArguments().Length : 0;
                return mb.Name + "|" + (mb.IsStatic ? "s" : "i") + "|" + arity + "|" + ret + "(" +
                       string.Join(",", mb.GetParameters().Select(p => RKey(p.ParameterType))) + ")";
            }

            static string CKey(TypeReference t) {
                switch (t) {
                    case RequiredModifierType m: return CKey(m.ElementType);
                    case OptionalModifierType m: return CKey(m.ElementType);
                    case PinnedType p: return CKey(p.ElementType);
                    case GenericParameter gp: return (gp.Type == GenericParameterType.Method ? "!!" : "!") + gp.Position;
                    case ByReferenceType b: return CKey(b.ElementType) + "&";
                    case PointerType p: return CKey(p.ElementType) + "*";
                    case ArrayType a: return CKey(a.ElementType) + (a.IsVector ? "[]" : a.Rank == 1 ? "[*]" : "[" + new string(',', a.Rank - 1) + "]");
                    case GenericInstanceType g: return CKey(g.ElementType) + "<" + string.Join(",", g.GenericArguments.Select(CKey)) + ">";
                    default: return t.FullName.Replace('/', '+');
                }
            }

            static string RKey(Type t) {
                if (t.IsGenericParameter) return (t.DeclaringMethod != null ? "!!" : "!") + t.GenericParameterPosition;
                if (t.IsByRef) return RKey(t.GetElementType()) + "&";
                if (t.IsPointer) return RKey(t.GetElementType()) + "*";
                if (t.IsArray) {
                    int rank = t.GetArrayRank();
                    bool vector = t == t.GetElementType().MakeArrayType();
                    return RKey(t.GetElementType()) + (vector ? "[]" : rank == 1 ? "[*]" : "[" + new string(',', rank - 1) + "]");
                }
                if (t.IsGenericType) {
                    var def = t.IsGenericTypeDefinition ? t : t.GetGenericTypeDefinition();
                    return Plain(def) + "<" + string.Join(",", t.GetGenericArguments().Select(RKey)) + ">";
                }
                return Plain(t);
            }

            static string Plain(Type t) {
                if (t.IsNested) return Plain(t.DeclaringType) + "+" + t.Name;
                return string.IsNullOrEmpty(t.Namespace) ? t.Name : t.Namespace + "." + t.Name;
            }
        }
    }
}
