using System;
using System.Reflection;
using System.Threading.Tasks;
using UnityEngine;

public static class UgsAutoInit
{
    static bool started;

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void Boot()
    {
        if (started) return;
        if (!SaturaSpace.SaturaLaunch.Managed) return;
        started = true;
        _ = Run();
    }

    static async Task Run()
    {
        try
        {
            var servicesType = FindType("Unity.Services.Core.UnityServices, Unity.Services.Core");
            if (servicesType == null) return;

            var stateProp = servicesType.GetProperty("State",
                BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
            var instanceProp = servicesType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
            object services = instanceProp != null ? instanceProp.GetValue(null) : null;

            if (!IsInitialized(stateProp, services))
            {
                var initTask = InvokeInitialize(servicesType, services);
                if (initTask != null) await initTask;
            }

            await TrySignInAnonymously();
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[UgsAutoInit] UnityServices.InitializeAsync failed: {Unwrap(e).Message}");
        }
    }

    static bool IsInitialized(PropertyInfo stateProp, object services)
    {
        if (stateProp == null) return false;
        object holder = stateProp.GetGetMethod(true).IsStatic ? null : services;
        if (holder == null && !stateProp.GetGetMethod(true).IsStatic) return false;
        var state = stateProp.GetValue(holder);
        return state != null && state.ToString() == "Initialized";
    }

    static Task InvokeInitialize(Type servicesType, object services)
    {
        var method = FindMethod(servicesType, "InitializeAsync",
            BindingFlags.Public | BindingFlags.Static | BindingFlags.Instance);
        if (method == null) return null;
        object target = method.IsStatic ? null : services;
        if (target == null && !method.IsStatic) return null;
        return Invoke(method, target);
    }

    static async Task TrySignInAnonymously()
    {
        var authType = FindType("Unity.Services.Authentication.AuthenticationService, Unity.Services.Authentication");
        if (authType == null) return;

        var instanceProp = authType.GetProperty("Instance", BindingFlags.Public | BindingFlags.Static);
        object auth = instanceProp != null ? instanceProp.GetValue(null) : null;
        if (auth == null) return;

        var signedInProp = authType.GetProperty("IsSignedIn", BindingFlags.Public | BindingFlags.Instance);
        if (signedInProp != null && signedInProp.GetValue(auth) is bool signedIn && signedIn) return;

        var signIn = FindMethod(authType, "SignInAnonymouslyAsync", BindingFlags.Public | BindingFlags.Instance);
        if (signIn == null) return;

        var task = Invoke(signIn, auth);
        if (task != null) await task;
    }

    static MethodInfo FindMethod(Type type, string name, BindingFlags flags)
    {
        MethodInfo best = null;
        foreach (var m in type.GetMethods(flags))
        {
            if (m.Name != name) continue;
            if (!typeof(Task).IsAssignableFrom(m.ReturnType)) continue;
            if (best == null || m.GetParameters().Length < best.GetParameters().Length) best = m;
        }
        return best;
    }

    static Task Invoke(MethodInfo method, object target)
    {
        var pars = method.GetParameters();
        var args = new object[pars.Length];
        for (int i = 0; i < pars.Length; i++)
            args[i] = pars[i].HasDefaultValue ? pars[i].DefaultValue : Type.Missing;
        return method.Invoke(target, args) as Task;
    }

    static Type FindType(string assemblyQualifiedName)
    {
        var t = Type.GetType(assemblyQualifiedName, false);
        if (t != null) return t;

        int comma = assemblyQualifiedName.IndexOf(',');
        string shortName = comma >= 0 ? assemblyQualifiedName.Substring(0, comma).Trim() : assemblyQualifiedName;
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            try
            {
                var found = asm.GetType(shortName, false);
                if (found != null) return found;
            }
            catch { }
        }
        return null;
    }

    static Exception Unwrap(Exception e)
    {
        while (e is TargetInvocationException tie && tie.InnerException != null) e = tie.InnerException;
        if (e is AggregateException ae && ae.InnerException != null) return ae.InnerException;
        return e;
    }
}
