using System.Collections;
using System.Collections.Generic;
using System.Globalization;
using System.Text;

namespace SaturaSpace.Playables
{
    public static class JsonOut
    {
        public static string Write(object value)
        {
            var sb = new StringBuilder(1 << 16);
            WriteValue(sb, value);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object value)
        {
            switch (value)
            {
                case null:
                    sb.Append("null");
                    return;
                case string s:
                    WriteString(sb, s);
                    return;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    return;
                case float f:
                    sb.Append(float.IsNaN(f) || float.IsInfinity(f) ? "null" : f.ToString("R", CultureInfo.InvariantCulture));
                    return;
                case double d:
                    sb.Append(double.IsNaN(d) || double.IsInfinity(d) ? "null" : d.ToString("R", CultureInfo.InvariantCulture));
                    return;
                case int or long or uint or ulong or short or ushort or byte or sbyte:
                    sb.Append(System.Convert.ToString(value, CultureInfo.InvariantCulture));
                    return;
                case IDictionary dict:
                    sb.Append('{');
                    bool firstEntry = true;
                    foreach (DictionaryEntry entry in dict)
                    {
                        if (!firstEntry) sb.Append(',');
                        firstEntry = false;
                        WriteString(sb, (string) entry.Key);
                        sb.Append(':');
                        WriteValue(sb, entry.Value);
                    }
                    sb.Append('}');
                    return;
                case IEnumerable list:
                    sb.Append('[');
                    bool firstItem = true;
                    foreach (object item in list)
                    {
                        if (!firstItem) sb.Append(',');
                        firstItem = false;
                        WriteValue(sb, item);
                    }
                    sb.Append(']');
                    return;
                default:
                    WriteString(sb, value.ToString());
                    return;
            }
        }

        private static void WriteString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 32) sb.Append("\\u").Append(((int) c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
        }
    }

    public class Node : Dictionary<string, object>
    {
    }
}
