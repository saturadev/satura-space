using System;
using System.Linq;
using System.Reflection;

public static partial class MCPTestBridge
{
    const string HarmonyAssemblyName = "SaturaSpace.Vendor.Harmony";
    const string HarmonyTypeName = "SaturaSpace.Vendor.HarmonyLib.Harmony";
    const string HarmonyMethodTypeName = "SaturaSpace.Vendor.HarmonyLib.HarmonyMethod";
    static Assembly s_HarmonyAssembly;

    static Assembly FindHarmony()
    {
        if (s_HarmonyAssembly != null) return s_HarmonyAssembly;
        var own = typeof(MCPTestBridge).Assembly;
        if (own.GetType(HarmonyTypeName, false) != null) return s_HarmonyAssembly = own;
        var asm = AppDomain.CurrentDomain.GetAssemblies().FirstOrDefault(x => x.GetName().Name == HarmonyAssemblyName);
        if (asm == null)
        {
            try { asm = Assembly.Load(new AssemblyName(HarmonyAssemblyName)); }
            catch { }
        }
        return s_HarmonyAssembly = asm;
    }
}
