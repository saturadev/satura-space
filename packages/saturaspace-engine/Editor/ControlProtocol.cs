using System.Collections.Generic;

namespace SaturaSpace
{
    public sealed class NdjsonFramer
    {
        private string _buf = "";

        public List<string> Push(string chunk)
        {
            _buf += chunk;
            var lines = new List<string>();
            int nl;
            while ((nl = _buf.IndexOf('\n')) >= 0)
            {
                var line = _buf.Substring(0, nl).Trim();
                _buf = _buf.Substring(nl + 1);
                if (line.Length > 0) lines.Add(line);
            }
            return lines;
        }

        public void Reset()
        {
            _buf = "";
        }
    }

    [System.Serializable]
    public class ControlEnvelope
    {
        public string type;
        public int id;
        public string cmd;
        public string @event;
    }

    [System.Serializable]
    public class ControlResultEnvelope
    {
        public string type = "result";
        public int id;
        public string status;
        public string error;
    }
}
