using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;

namespace HotReloadPrototype.Editor {
    internal static class ResponseFileDefines {
        const string ProjectRsp = "Assets/csc.rsp";
        static readonly Regex DefineOption = new Regex(@"^[-/]d(?:efine)?:(\S+)$", RegexOptions.IgnoreCase);

        public static string[] With(IEnumerable<string> defines) {
            return (defines ?? Array.Empty<string>()).Concat(Read()).Distinct(StringComparer.Ordinal).ToArray();
        }

        static IEnumerable<string> Read() {
            string text;
            try { text = File.ReadAllText(ProjectRsp); }
            catch { yield break; }
            foreach (var token in text.Split((char[])null, StringSplitOptions.RemoveEmptyEntries)) {
                var m = DefineOption.Match(token.Trim('"'));
                if (!m.Success) continue;
                foreach (var symbol in m.Groups[1].Value.Split(new[] { ';', ',' }, StringSplitOptions.RemoveEmptyEntries))
                    yield return symbol;
            }
        }
    }
}
