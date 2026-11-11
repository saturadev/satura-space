using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEngine;

namespace SaturaSpace
{
    public static class SaturaPlugins
    {
        static readonly Dictionary<string, Func<string, string>> _commands = new Dictionary<string, Func<string, string>>();

        public static void Command(string name, Func<string, string> run)
        {
            if (string.IsNullOrEmpty(name) || run == null) return;
            _commands[name] = run;
        }

        public static string Json(string s)
        {
            if (s == null) return "null";
            var b = new StringBuilder(s.Length + 2);
            b.Append('"');
            foreach (var c in s)
            {
                switch (c)
                {
                    case '"': b.Append("\\\""); break;
                    case '\\': b.Append("\\\\"); break;
                    case '\n': b.Append("\\n"); break;
                    case '\r': b.Append("\\r"); break;
                    case '\t': b.Append("\\t"); break;
                    default:
                        if (c < 0x20) b.Append("\\u").Append(((int)c).ToString("x4"));
                        else b.Append(c);
                        break;
                }
            }
            b.Append('"');
            return b.ToString();
        }

        internal static void Run(int id, string name, string line, Action<string> reply)
        {
            if (!_commands.TryGetValue(name, out var run))
            {
                reply($"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":{Json("No plugin command " + name + " in this editor. It may still be compiling.")}}}");
                return;
            }
            EditorApplication.delayCall += () =>
            {
                string value;
                try { value = run(line); }
                catch (Exception e)
                {
                    Debug.LogWarning($"[SaturaPlugins] {name} failed: {e}");
                    reply($"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":{Json(e.Message)}}}");
                    return;
                }
                reply($"{{\"type\":\"result\",\"id\":{id},\"status\":\"completed\",\"value\":{(string.IsNullOrEmpty(value) ? "null" : value)}}}");
            };
        }
    }
}
