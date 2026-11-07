using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;

if (args.Length < 2 || (args[0] != "verify" && args[0] != "patch"))
{
    Console.WriteLine("usage: harmony-metadata-repair verify <dll>");
    Console.WriteLine("       harmony-metadata-repair patch <dll> [outDll]");
    return 64;
}

return args[0] == "verify" ? Verify(args[1]) : Repair(args[1], args.Length > 2 ? args[2] : args[1]);

static int Verify(string path)
{
    using var fs = File.OpenRead(path);
    using var pe = new PEReader(fs);
    var md = pe.GetMetadataReader();
    int bad = 0, total = 0;

    foreach (var arHandle in md.AssemblyReferences)
    {
        total++;
        try
        {
            var ar = md.GetAssemblyReference(arHandle);
            _ = md.GetString(ar.Name);
            _ = ar.Culture.IsNil ? "" : md.GetString(ar.Culture);
            _ = ar.Version;
            _ = ar.PublicKeyOrToken.IsNil ? Array.Empty<byte>() : md.GetBlobBytes(ar.PublicKeyOrToken);
        }
        catch (Exception e)
        {
            bad++;
            Console.WriteLine($"asmref FAIL {MetadataTokens.GetToken(arHandle):x8}: {e.GetType().Name}: {e.Message}");
        }
    }

    foreach (var trHandle in md.TypeReferences)
    {
        total++;
        try
        {
            var tr = md.GetTypeReference(trHandle);
            _ = md.GetString(tr.Name);
            _ = tr.Namespace.IsNil ? "" : md.GetString(tr.Namespace);
            var scope = tr.ResolutionScope;
            if (!scope.IsNil && scope.Kind == HandleKind.AssemblyReference)
            {
                var ar = md.GetAssemblyReference((AssemblyReferenceHandle)scope);
                _ = md.GetString(ar.Name);
                _ = ar.Version;
            }
        }
        catch (Exception e)
        {
            bad++;
            Console.WriteLine($"typeref FAIL {MetadataTokens.GetToken(trHandle):x8}: {e.GetType().Name}: {e.Message}");
        }
    }

    Console.WriteLine($"{Path.GetFileName(path)}: checked {total} rows, {bad} failures");
    return bad == 0 ? 0 : 1;
}

static unsafe int Repair(string inPath, string outPath)
{
    var bytes = File.ReadAllBytes(inPath);
    var fixes = new List<(int row, long fileOffset, uint oldScope)>();

    using (var fs = File.OpenRead(inPath))
    using (var pe = new PEReader(fs))
    {
        var md = pe.GetMetadataReader();
        int typeRefCount = md.GetTableRowCount(TableIndex.TypeRef);
        int asmRefCount = md.GetTableRowCount(TableIndex.AssemblyRef);
        int moduleRefCount = md.GetTableRowCount(TableIndex.ModuleRef);
        int rowSize = md.GetTableRowSize(TableIndex.TypeRef);
        int tableMetaOffset = md.GetTableMetadataOffset(TableIndex.TypeRef);
        int scopeSize = rowSize - (md.GetHeapSize(HeapIndex.String) > 0xFFFF ? 8 : 4);
        if (scopeSize != 2) { Console.WriteLine($"unexpected ResolutionScope column size {scopeSize}; only 2-byte coded indexes supported"); return 2; }

        var typeDefs = new HashSet<string>();
        foreach (var tdHandle in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(tdHandle);
            var ns = td.Namespace.IsNil ? "" : md.GetString(td.Namespace);
            typeDefs.Add($"{ns}|{md.GetString(td.Name)}");
        }

        long tableFileOffset = pe.PEHeaders.MetadataStartOffset + tableMetaOffset;
        byte* basePtr = md.MetadataPointer;

        for (int row = 1; row <= typeRefCount; row++)
        {
            byte* p = basePtr + tableMetaOffset + (row - 1) * rowSize;
            uint scope = *(ushort*)p;
            uint tag = scope & 0x3;
            uint rid = scope >> 2;
            bool dangling = tag switch
            {
                0 => rid > 1,
                1 => rid > (uint)moduleRefCount,
                2 => rid > (uint)asmRefCount,
                3 => rid > (uint)typeRefCount,
                _ => true,
            };
            if (!dangling) continue;

            var tr = md.GetTypeReference(MetadataTokens.TypeReferenceHandle(row));
            var name = md.GetString(tr.Name);
            var ns = tr.Namespace.IsNil ? "" : md.GetString(tr.Namespace);
            bool hasLocalDef = typeDefs.Contains($"{ns}|{name}");
            Console.WriteLine($"row {row} ({ns}.{name}): dangling scope 0x{scope:x}, local TypeDef = {hasLocalDef}");
            if (!hasLocalDef) { Console.WriteLine("no local TypeDef to retarget to; refusing to patch"); return 3; }
            fixes.Add((row, tableFileOffset + (row - 1) * rowSize, scope));
        }
    }

    if (fixes.Count == 0) { Console.WriteLine("nothing to patch"); return 0; }

    foreach (var (row, fileOffset, oldScope) in fixes)
    {
        uint cur = (uint)(bytes[fileOffset] | (bytes[fileOffset + 1] << 8));
        if (cur != oldScope) { Console.WriteLine($"row {row}: file/metadata offset mismatch (0x{cur:x} != 0x{oldScope:x})"); return 4; }
        bytes[fileOffset] = 0x04;
        bytes[fileOffset + 1] = 0x00;
    }

    File.WriteAllBytes(outPath, bytes);
    Console.WriteLine($"patched {fixes.Count} TypeRef rows -> {outPath}");
    return 0;
}
