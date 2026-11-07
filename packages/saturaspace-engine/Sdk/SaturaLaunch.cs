using System;
using UnityEngine;

namespace SaturaSpace
{

public static class SaturaLaunch
{
    static int _managed = -1;

    public static bool Managed
    {
        get
        {
            if (_managed < 0) _managed = Detect() ? 1 : 0;
            return _managed == 1;
        }
    }

    public static string Arg(string name)
    {
        try
        {
            var args = Environment.GetCommandLineArgs();
            for (int i = 0; i < args.Length - 1; i++)
                if (args[i] == name) return args[i + 1];
        }
        catch { }
        return null;
    }

    static bool Detect()
    {
        if (!string.IsNullOrEmpty(Arg("-mcpRoot"))) return true;
        try { return !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("MC_INSTANCE_ID")); }
        catch { return false; }
    }
}
}
