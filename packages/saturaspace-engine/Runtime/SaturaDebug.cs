using System;

public static class SaturaDebug
{
    public static readonly bool On = Environment.GetEnvironmentVariable("SATURA_DEBUG") == "1";

    public static bool Flag(string legacyEnv)
    {
        return On || Environment.GetEnvironmentVariable(legacyEnv) == "1";
    }

    public static void Log(object message)
    {
        if (On) UnityEngine.Debug.Log(message);
    }

    public static void Log(object message, UnityEngine.Object context)
    {
        if (On) UnityEngine.Debug.Log(message, context);
    }
}
