using Mono.Cecil;
using Mono.Cecil.Cil;

static class Vendor
{
    static readonly string[] KeptNamespaces =
    {
        "System.Runtime.CompilerServices",
        "System.Diagnostics.CodeAnalysis",
        "System.Runtime.Versioning",
        "System.Runtime.InteropServices",
        "FxResources",
    };

    public static int Run(string[] args)
    {
        if (args.Length < 2) return Usage();
        var outDir = Path.GetFullPath(args[0]);
        var prefix = "";
        var inputs = new List<(string File, string NewName)>();
        var friends = new List<(string Asm, string Friend)>();
        var strings = new Dictionary<string, string>(StringComparer.Ordinal);
        for (var i = 1; i < args.Length; i++)
        {
            var flag = args[i];
            if (i + 1 >= args.Length) return Usage();
            var value = args[++i];
            var eq = value.LastIndexOf('=');
            if (flag == "--prefix") prefix = value;
            else if (eq <= 0) return Usage();
            else if (flag == "--asm") inputs.Add((Path.GetFullPath(value[..eq]), value[(eq + 1)..]));
            else if (flag == "--ivt") friends.Add((value[..eq], value[(eq + 1)..]));
            else if (flag == "--ldstr") strings[value[..eq]] = value[(eq + 1)..];
            else return Usage();
        }
        if (prefix.Length == 0 || inputs.Count == 0) return Usage();

        var resolver = new VendorResolver();
        foreach (var dir in inputs.Select(x => Path.GetDirectoryName(x.File)!).Distinct()) resolver.AddSearchDirectory(dir);
        foreach (var dir in (Environment.GetEnvironmentVariable("ILFIXUP_LIB") ?? "").Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            if (Directory.Exists(dir)) resolver.AddSearchDirectory(dir);

        var assemblies = inputs
            .Select(x => (Asm: AssemblyDefinition.ReadAssembly(x.File, new ReaderParameters { InMemory = true, AssemblyResolver = resolver }), x.NewName))
            .ToList();
        var newNames = assemblies.ToDictionary(a => a.Asm.Name.Name, a => a.NewName);

        var renames = new Dictionary<(string Asm, string Type), string>();
        foreach (var (asm, _) in assemblies)
            foreach (var type in asm.MainModule.Types)
                if (type.Namespace.Length > 0 && !Kept(type))
                    renames[(asm.Name.Name, type.FullName)] = prefix + type.Namespace;

        foreach (var (asm, newName) in assemblies)
        {
            var module = asm.MainModule;
            var own = asm.Name.Name;

            var refRenames = 0;
            foreach (var tr in module.GetTypeReferences().ToList())
            {
                if (tr.DeclaringType != null) continue;
                var scope = ScopeName(tr.Scope, own);
                if (scope == null || !newNames.ContainsKey(scope)) continue;
                if (renames.TryGetValue((scope, tr.FullName), out var ns)) { tr.Namespace = ns; refRenames++; }
            }

            foreach (var custom in AllAttributes(module)) FixAttribute(custom, own, renames, newNames);

            var moved = module.Types.Where(t => t.Namespace.Length > 0 && !Kept(t)).ToList();
            foreach (var type in moved) module.Types.Remove(type);
            foreach (var type in moved)
            {
                if (!type.Namespace.StartsWith(prefix, StringComparison.Ordinal)) type.Namespace = prefix + type.Namespace;
                module.Types.Add(type);
            }

            foreach (var r in module.AssemblyReferences)
                if (newNames.TryGetValue(r.Name, out var to)) Unsign(r, to);

            var movedResources = 0;
            foreach (var res in module.Resources)
            {
                if (!res.Name.EndsWith(".resources", StringComparison.Ordinal)) continue;
                var owner = res.Name[..^".resources".Length];
                if (!renames.ContainsKey((own, owner))) continue;
                res.Name = prefix + res.Name;
                movedResources++;
            }

            var dropped = 0;
            foreach (var ivt in asm.CustomAttributes.Where(IsFriend).ToList())
            {
                var full = (string)ivt.ConstructorArguments[0].Value;
                var friend = full.Split(',')[0].Trim();
                if (newNames.TryGetValue(friend, out var renamed))
                    ivt.ConstructorArguments[0] = new CustomAttributeArgument(module.TypeSystem.String, renamed);
                else if (full.Contains("PublicKey", StringComparison.OrdinalIgnoreCase)) { asm.CustomAttributes.Remove(ivt); dropped++; }
            }
            foreach (var (target, friend) in friends.Where(f => f.Asm == newName))
                AddFriend(asm, friend);

            var rewritten = 0;
            if (strings.Count > 0)
                foreach (var type in module.GetTypes())
                    foreach (var method in type.Methods.Where(m => m.HasBody))
                        foreach (var ins in method.Body.Instructions)
                            if (ins.OpCode == OpCodes.Ldstr && strings.TryGetValue((string)ins.Operand, out var replacement))
                            {
                                ins.Operand = replacement;
                                rewritten++;
                            }

            asm.Name.Name = newName;
            asm.Name.PublicKey = Array.Empty<byte>();
            asm.Name.HasPublicKey = false;
            module.Attributes &= ~ModuleAttributes.StrongNameSigned;
            module.Name = newName + ".dll";

            var renamedTypes = renames.Keys.Count(k => k.Asm == own);
            Console.WriteLine($"ilfixup: vendor {own} -> {newName}: {renamedTypes} types, {refRenames} type refs, {dropped} friend attrs dropped, {rewritten} strings, {movedResources} resources");
        }

        foreach (var (asm, _) in assemblies) resolver.RegisterAssembly(asm);
        Directory.CreateDirectory(outDir);
        foreach (var (asm, newName) in assemblies) asm.Write(Path.Combine(outDir, newName + ".dll"));

        return Check(outDir, assemblies.Select(a => a.NewName).ToList(), newNames.Keys.ToHashSet(), prefix);
    }

    static int Usage()
    {
        Console.Error.WriteLine("usage: ilfixup vendor <outDir> --prefix <Ns.> --asm <file.dll>=<NewName> [...] [--ivt <NewName>=<Friend>] [--ldstr <old>=<new>]");
        return 2;
    }

    static bool Kept(TypeDefinition type) =>
        !type.IsPublic && KeptNamespaces.Any(ns => type.Namespace == ns || type.Namespace.StartsWith(ns + ".", StringComparison.Ordinal));

    static string? ScopeName(IMetadataScope scope, string own) => scope switch
    {
        AssemblyNameReference a => a.Name,
        ModuleDefinition => own,
        _ => null,
    };

    static void Unsign(AssemblyNameReference r, string name)
    {
        r.Name = name;
        r.PublicKey = Array.Empty<byte>();
        r.PublicKeyToken = Array.Empty<byte>();
        r.HasPublicKey = false;
    }

    static bool IsFriend(CustomAttribute a) =>
        a.AttributeType.FullName == "System.Runtime.CompilerServices.InternalsVisibleToAttribute" && a.ConstructorArguments.Count == 1;

    public static void AddFriend(AssemblyDefinition asm, string friend)
    {
        if (asm.CustomAttributes.Where(IsFriend).Any(a => (string)a.ConstructorArguments[0].Value == friend)) return;
        var template = asm.CustomAttributes.FirstOrDefault(IsFriend);
        MethodReference ctor;
        if (template != null) ctor = template.Constructor;
        else
        {
            var module = asm.MainModule;
            var type = new TypeReference("System.Runtime.CompilerServices", "InternalsVisibleToAttribute", module, module.TypeSystem.CoreLibrary);
            ctor = new MethodReference(".ctor", module.TypeSystem.Void, type) { HasThis = true };
            ctor.Parameters.Add(new ParameterDefinition(module.TypeSystem.String));
        }
        var attr = new CustomAttribute(ctor);
        attr.ConstructorArguments.Add(new CustomAttributeArgument(asm.MainModule.TypeSystem.String, friend));
        asm.CustomAttributes.Add(attr);
    }

    static List<CustomAttribute> AllAttributes(ModuleDefinition module)
    {
        var providers = new List<ICustomAttributeProvider> { module.Assembly, module };
        foreach (var type in module.GetTypes())
        {
            providers.Add(type);
            providers.AddRange(type.GenericParameters);
            providers.AddRange(type.Fields);
            providers.AddRange(type.Properties);
            providers.AddRange(type.Events);
            foreach (var method in type.Methods)
            {
                providers.Add(method);
                providers.Add(method.MethodReturnType);
                providers.AddRange(method.Parameters);
                providers.AddRange(method.GenericParameters);
            }
        }
        return providers.Where(p => p.HasCustomAttributes).SelectMany(p => p.CustomAttributes).ToList();
    }

    static void FixAttribute(CustomAttribute attr, string own, Dictionary<(string, string), string> renames, Dictionary<string, string> newNames)
    {
        if (!attr.HasConstructorArguments && !attr.HasFields && !attr.HasProperties) return;
        for (var i = 0; i < attr.ConstructorArguments.Count; i++)
            FixArgument(attr.ConstructorArguments[i], own, renames, newNames);
        foreach (var named in attr.Fields.Concat(attr.Properties))
            FixArgument(named.Argument, own, renames, newNames);
    }

    static void FixArgument(CustomAttributeArgument arg, string own, Dictionary<(string, string), string> renames, Dictionary<string, string> newNames)
    {
        switch (arg.Value)
        {
            case TypeReference type:
                FixParsedType(type, own, renames, newNames);
                break;
            case CustomAttributeArgument boxed:
                FixArgument(boxed, own, renames, newNames);
                break;
            case CustomAttributeArgument[] array:
                foreach (var item in array) FixArgument(item, own, renames, newNames);
                break;
        }
    }

    static void FixParsedType(TypeReference type, string own, Dictionary<(string, string), string> renames, Dictionary<string, string> newNames)
    {
        if (type is TypeSpecification spec)
        {
            FixParsedType(spec.ElementType, own, renames, newNames);
            if (type is GenericInstanceType generic)
                foreach (var a in generic.GenericArguments) FixParsedType(a, own, renames, newNames);
            return;
        }
        var top = type;
        while (top.DeclaringType != null) top = top.DeclaringType;
        var scope = ScopeName(top.Scope, own);
        if (scope == null) return;
        if (renames.TryGetValue((scope, top.FullName), out var ns)) top.Namespace = ns;
        if (top.Scope is AssemblyNameReference r && newNames.TryGetValue(r.Name, out var to)) Unsign(r, to);
    }

    static int Check(string outDir, List<string> produced, HashSet<string> originals, string prefix)
    {
        var failures = new List<string>();
        foreach (var name in produced)
        {
            var asm = AssemblyDefinition.ReadAssembly(Path.Combine(outDir, name + ".dll"));
            var module = asm.MainModule;
            foreach (var r in module.AssemblyReferences.Where(r => originals.Contains(r.Name)))
                failures.Add($"{name}: still references assembly {r.Name}");
            foreach (var type in module.Types.Where(t => t.IsPublic && !t.Namespace.StartsWith(prefix, StringComparison.Ordinal)))
                failures.Add($"{name}: public type outside {prefix}*: {type.FullName}");
            foreach (var tr in module.GetTypeReferences().Where(t => t.DeclaringType == null && t.Scope is AssemblyNameReference a && produced.Contains(a.Name)))
                if (tr.Namespace.Length > 0 && !tr.Namespace.StartsWith(prefix, StringComparison.Ordinal) && !KeptNamespaces.Any(ns => tr.Namespace.StartsWith(ns, StringComparison.Ordinal)))
                    failures.Add($"{name}: type ref {tr.FullName} into {((AssemblyNameReference)tr.Scope).Name} was not renamed");
        }
        foreach (var f in failures.Distinct().Take(40)) Console.Error.WriteLine("ilfixup: " + f);
        if (failures.Count > 0) return 1;
        Console.WriteLine($"ilfixup: vendor check passed for {produced.Count} assemblies");
        return 0;
    }
}

sealed class VendorResolver : DefaultAssemblyResolver
{
    public new void RegisterAssembly(AssemblyDefinition assembly) => base.RegisterAssembly(assembly);
}
