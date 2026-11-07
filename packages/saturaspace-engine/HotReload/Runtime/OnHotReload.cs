using System;

namespace HotReloadPrototype {
    [AttributeUsage(AttributeTargets.Method)]
    public sealed class OnHotReload : Attribute { }
}
