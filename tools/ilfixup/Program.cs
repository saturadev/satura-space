if (args.Length < 2 || args[0] != "vendor")
{
    Console.Error.WriteLine("usage: ilfixup vendor <outDir> --prefix <Ns.> --asm <file.dll>=<NewName> [...]");
    return 2;
}
return Vendor.Run(args[1..]);
