using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEditor;
using UnityEditor.Compilation;
using UnityEngine;
using SaturaSpace;

public static partial class MCPTestBridge
{
    static TcpListener _ctrlListener;
    static Thread _ctrlAccept;
    static volatile bool _ctrlRunning;
    static readonly object _ctrlClientsLock = new object();
    static readonly List<ControlClient> _ctrlClients = new List<ControlClient>();
    static readonly object _ctrlInboxLock = new object();
    static readonly Queue<KeyValuePair<ControlClient, string>> _ctrlInbox = new Queue<KeyValuePair<ControlClient, string>>();
    static int _ctrlPort;
    static string _ctrlToken;
    const int CtrlHelloTimeoutMs = 5000;
    const int CtrlHelloMaxChars = 4096;
    static volatile string _ctrlBusyLine;
    static long _ctrlBusySinceMs;

    static int ControlServerPort => _ctrlPort;

    class ControlClient
    {
        public TcpClient Tcp;
        public NetworkStream Stream;
        public NdjsonFramer Framer = new NdjsonFramer();
        public Thread Reader;
        public readonly object WriteLock = new object();
    }

    [InitializeOnLoadMethod]
    static void StartControlServer()
    {
        if (Inert) return;
        try
        {
            var env = Environment.GetEnvironmentVariable("MC_CONTROL_TCP_PORT");
            if (!int.TryParse(env, out var port) || port <= 0) return;
            var token = Environment.GetEnvironmentVariable("MC_CONTROL_TOKEN");
            if (string.IsNullOrEmpty(token))
            {
                Debug.LogWarning("[MCPControl] MC_CONTROL_TOKEN is not set; control socket stays off");
                return;
            }
            _ctrlToken = token;
            _ctrlPort = port;
            _ctrlRunning = true;
            _ctrlListener = new TcpListener(IPAddress.Loopback, port);
            _ctrlListener.Server.SetSocketOption(SocketOptionLevel.Socket, SocketOptionName.ReuseAddress, true);
            _ctrlListener.Start();
            _ctrlAccept = new Thread(CtrlAcceptLoop) { IsBackground = true, Name = "MCPControl.accept" };
            _ctrlAccept.Start();

            AssemblyReloadEvents.beforeAssemblyReload += ShutdownControlServer;
            EditorApplication.quitting += ShutdownControlServer;
            Debug.Log($"[MCPControl] control socket listening on 127.0.0.1:{port}");
        }
        catch (Exception e)
        {
            Debug.LogWarning($"[MCPControl] failed to start control socket: {e.Message}");
            _ctrlPort = 0;
        }
    }

    static void ShutdownControlServer()
    {
        if (!_ctrlRunning && _ctrlListener == null) return;
        EndAllTuners("domainReload");
        _ctrlRunning = false;
        try { _ctrlListener?.Stop(); } catch { }
        lock (_ctrlClientsLock)
        {
            foreach (var c in _ctrlClients)
            {
                try { c.Stream?.Close(); } catch { }
                try { c.Tcp?.Close(); } catch { }
            }
            _ctrlClients.Clear();
        }
        try { _ctrlAccept?.Join(500); } catch { }
        _ctrlListener = null;
        _ctrlAccept = null;
        _ctrlPort = 0;
        AssemblyReloadEvents.beforeAssemblyReload -= ShutdownControlServer;
        EditorApplication.quitting -= ShutdownControlServer;
    }

    static void CtrlAcceptLoop()
    {
        while (_ctrlRunning)
        {
            try
            {
                var tcp = _ctrlListener.AcceptTcpClient();
                tcp.NoDelay = true;
                tcp.SendTimeout = 2000;
                tcp.ReceiveTimeout = CtrlHelloTimeoutMs;
                var client = new ControlClient { Tcp = tcp, Stream = tcp.GetStream() };
                client.Reader = new Thread(() => CtrlReadLoop(client)) { IsBackground = true, Name = "MCPControl.read" };
                client.Reader.Start();
            }
            catch
            {
                if (!_ctrlRunning) break;
                Thread.Sleep(100);
            }
        }
    }

    static void CtrlReadLoop(ControlClient client)
    {
        var buf = new byte[8192];
        var decoder = Encoding.UTF8.GetDecoder();
        var hello = new StringBuilder();
        bool authed = false;
        try
        {
            while (_ctrlRunning)
            {
                int n = client.Stream.Read(buf, 0, buf.Length);
                if (n <= 0) break;
                int charCount = decoder.GetCharCount(buf, 0, n);
                var chars = new char[charCount];
                decoder.GetChars(buf, 0, n, chars, 0);
                var text = new string(chars);
                if (!authed)
                {
                    hello.Append(text);
                    var head = hello.ToString();
                    int nl = head.IndexOf('\n');
                    if (nl < 0)
                    {
                        if (head.Length > CtrlHelloMaxChars) break;
                        continue;
                    }
                    if (!CtrlHelloOk(head.Substring(0, nl).Trim())) break;
                    authed = true;
                    client.Tcp.ReceiveTimeout = 0;
                    lock (_ctrlClientsLock) _ctrlClients.Add(client);
                    text = head.Substring(nl + 1);
                }
                var lines = client.Framer.Push(text);
                if (lines.Count > 0)
                {
                    lock (_ctrlInboxLock)
                        foreach (var line in lines) _ctrlInbox.Enqueue(new KeyValuePair<ControlClient, string>(client, line));
                    SignalEditorTick();
                    foreach (var line in lines) WakeTunerOnInput(line);
                }
            }
        }
        catch { }
        finally
        {
            lock (_ctrlClientsLock) _ctrlClients.Remove(client);
            try { client.Stream?.Close(); } catch { }
            try { client.Tcp?.Close(); } catch { }
        }
    }

    [Serializable]
    class ControlHello
    {
        public string type;
        public string token;
    }

    static bool CtrlHelloOk(string line)
    {
        ControlHello h;
        try { h = JsonUtility.FromJson<ControlHello>(line); }
        catch { return false; }
        if (h == null || h.type != "hello" || h.token == null || _ctrlToken == null) return false;
        if (h.token.Length != _ctrlToken.Length) return false;
        int diff = 0;
        for (int i = 0; i < h.token.Length; i++) diff |= h.token[i] ^ _ctrlToken[i];
        return diff == 0;
    }

    static void DrainControl()
    {
        if (_ctrlPort == 0) return;
        List<KeyValuePair<ControlClient, string>> batch = null;
        while (true)
        {
            if (batch == null) batch = new List<KeyValuePair<ControlClient, string>>();
            else batch.Clear();
            lock (_ctrlInboxLock)
            {
                while (_ctrlInbox.Count > 0) batch.Add(_ctrlInbox.Dequeue());
            }
            if (batch.Count == 0) break;
            for (int i = 0; i < batch.Count; i++)
            {
                var item = batch[i];
                if (CtrlSuperseded(batch, i)) continue;
                HandleControlLineWatched(item.Value, item.Key);
            }
        }
    }

    static bool CtrlSuperseded(List<KeyValuePair<ControlClient, string>> batch, int i)
    {
        string key = CtrlCoalesceKey(batch[i].Value);
        if (key == null) return false;
        for (int j = i + 1; j < batch.Count; j++)
            if (ReferenceEquals(batch[j].Key, batch[i].Key) && CtrlCoalesceKey(batch[j].Value) == key) return true;
        return false;
    }

    static string CtrlCoalesceKey(string line)
    {
        if (line == null || line.Length > 8192) return null;
        string cmd = null;
        if (line.IndexOf("\"cmd\":\"tuner/transform\"", StringComparison.Ordinal) >= 0) cmd = "t";
        else if (line.IndexOf("\"cmd\":\"tuner/camera\"", StringComparison.Ordinal) >= 0) cmd = "c";
        if (cmd == null || line.IndexOf("\"final\":true", StringComparison.Ordinal) >= 0) return null;
        int at = line.IndexOf("\"session\":\"", StringComparison.Ordinal);
        if (at < 0) return null;
        at += 11;
        int end = line.IndexOf('"', at);
        if (end < 0) return null;
        string key = cmd + line.Substring(at, end - at);
        if (cmd != "t") return key;
        int id = line.IndexOf("\"id\":\"", StringComparison.Ordinal);
        if (id < 0) return key;
        id += 6;
        int idEnd = line.IndexOf('"', id);
        return idEnd < 0 ? key : key + "|" + line.Substring(id, idEnd - id);
    }

    static void HandleControlLineWatched(string line, ControlClient from)
    {
        _ctrlBusyLine = line;
        Interlocked.Exchange(ref _ctrlBusySinceMs, NowMs);
        try { HandleControlLine(line, from); }
        finally
        {
            Interlocked.Exchange(ref _ctrlBusySinceMs, 0);
            _ctrlBusyLine = null;
        }
    }

    static void HandleControlLine(string line, ControlClient from)
    {
        ControlEnvelope env;
        try { env = JsonUtility.FromJson<ControlEnvelope>(line); }
        catch { return; }
        if (env == null || env.type != "command") return;
        _lastActivity = EditorApplication.timeSinceStartup;

        if (env.cmd != null && env.cmd.StartsWith("tuner", StringComparison.Ordinal)) TpRecv(env.cmd);
        if (env.cmd != null && env.cmd.StartsWith("tuner/", StringComparison.Ordinal))
        {
            if (env.cmd == "tuner/camera" || env.cmd == "tuner/anim" || env.cmd == "tuner/transform" || env.cmd == "tuner/edit" || env.cmd == "tuner/hierarchy") NoteTunerActivity();
            HandleTunerCommand(env.id, env.cmd, line, from);
            return;
        }

        if (env.cmd != null && env.cmd.StartsWith("tunerInspector/", StringComparison.Ordinal))
        {
            if (env.cmd == "tunerInspector/input" || env.cmd == "tunerInspector/open") NoteTunerActivity();
            HandleTunerInspectorCommand(env.id, env.cmd, line, from);
            return;
        }

        if (env.cmd != null && env.cmd.StartsWith("tunerPopup/", StringComparison.Ordinal))
        {
            NoteTunerActivity();
            HandleTunerPopupCommand(env.id, env.cmd, line, from);
            return;
        }

        switch (env.cmd)
        {
            case "ping":
                CtrlReply(from, $"{{\"type\":\"result\",\"id\":{env.id},\"status\":\"completed\"}}");
                break;
            case "status":
                CtrlReply(from, $"{{\"type\":\"result\",\"id\":{env.id},\"status\":\"completed\",{StatusFields()}}}");
                break;
            case "fileTrigger":
                HandleFileTrigger(env.id, line, from);
                break;
            case "editor/leaveStage":
                HandleLeaveStage(env.id, from);
                break;
            case "input/scheme":
                HandleInputScheme(env.id, line, from);
                break;
            case "input/generate":
                HandleInputGenerate(env.id, from);
                break;
            case "input/gamepadModule":
                HandleGamepadModule(env.id, line, from);
                break;
            default:
                CtrlReply(from,
                    $"{{\"type\":\"result\",\"id\":{env.id},\"status\":\"error\",\"error\":\"unknown command: {CtrlEscape(env.cmd)}\"}}");
                break;
        }
    }

    [Serializable]
    class FileTriggerArgs
    {
        public string file;
        public string body;
    }

    [Serializable]
    class FileTriggerCommand
    {
        public int id;
        public FileTriggerArgs args;
    }

    static void HandleFileTrigger(int id, string line, ControlClient from)
    {
        FileTriggerCommand ft;
        try { ft = JsonUtility.FromJson<FileTriggerCommand>(line); }
        catch { ft = null; }
        if (ft == null || ft.args == null || string.IsNullOrEmpty(ft.args.file)
            || !ft.args.file.EndsWith("_trigger.json"))
        {
            CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":\"bad fileTrigger args\"}}");
            return;
        }
        try
        {
            var root = Path.GetFullPath(SspaceRoot).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;
            var triggerPath = Path.GetFullPath(Path.Combine(root, ft.args.file));
            var cmp = Application.platform == RuntimePlatform.WindowsEditor ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (!triggerPath.StartsWith(root, cmp))
            {
                CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":\"fileTrigger path is outside .sspace\"}}");
                return;
            }
            SspaceFolder.EnsureFor(triggerPath);
            File.WriteAllText(triggerPath, ft.args.body ?? "");
            CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"completed\"}}");
        }
        catch (Exception e)
        {
            CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":\"{CtrlEscape(e.Message)}\"}}");
        }
    }

    static string StatusFields()
    {
        return "\"isPlaying\":" + (EditorApplication.isPlaying ? "true" : "false")
            + ",\"isCompiling\":" + (EditorApplication.isCompiling ? "true" : "false")
            + ",\"isBatchMode\":" + (Application.isBatchMode ? "true" : "false");
    }

    static void BroadcastStatusEvent()
    {
        if (_ctrlPort == 0) return;
        CtrlBroadcast($"{{\"type\":\"event\",\"event\":\"status\",{StatusFields()}}}");
    }

    static void BroadcastOpDone(string op, string status, string nonce = null)
    {
        if (_ctrlPort == 0) return;
        var noncePart = string.IsNullOrEmpty(nonce) ? "" : $",\"nonce\":\"{CtrlEscape(nonce)}\"";
        CtrlBroadcast(
            $"{{\"type\":\"event\",\"event\":\"opDone\",\"op\":\"{CtrlEscape(op)}\",\"status\":\"{CtrlEscape(status)}\"{noncePart}}}");
    }

    static void CtrlBroadcast(string json)
    {
        if (_ctrlPort == 0) return;
        var bytes = Encoding.UTF8.GetBytes(json + "\n");
        lock (_ctrlClientsLock)
        {
            for (int i = _ctrlClients.Count - 1; i >= 0; i--)
            {
                var c = _ctrlClients[i];
                try
                {
                    lock (c.WriteLock) c.Stream.Write(bytes, 0, bytes.Length);
                }
                catch
                {
                    try { c.Stream?.Close(); } catch { }
                    try { c.Tcp?.Close(); } catch { }
                    _ctrlClients.RemoveAt(i);
                }
            }
        }
    }

    static void CtrlReply(ControlClient to, string json)
    {
        if (to == null)
        {
            CtrlBroadcast(json);
            return;
        }
        CtrlSendLine(to, json, out _);
    }

    const int CTRL_POOL_MAX = 256 * 1024;

    [ThreadStatic] static byte[] _ctrlLineBuf;

    static bool CtrlSendLine(ControlClient to, string json, out int sent)
    {
        int max = Encoding.UTF8.GetMaxByteCount(json.Length) + 1;
        if (max > CTRL_POOL_MAX)
        {
            var bytes = Encoding.UTF8.GetBytes(json + "\n");
            sent = bytes.Length;
            return CtrlSendTo(to, bytes);
        }
        var buf = _ctrlLineBuf;
        if (buf == null || buf.Length < max) _ctrlLineBuf = buf = new byte[Math.Max(max, 4096)];
        int n = Encoding.UTF8.GetBytes(json, 0, json.Length, buf, 0);
        buf[n++] = (byte)'\n';
        sent = n;
        return CtrlSendTo(to, buf, n);
    }

    static bool CtrlSendTo(ControlClient c, byte[] bytes)
    {
        return CtrlSendTo(c, bytes, bytes.Length);
    }

    static bool CtrlSendTo(ControlClient c, byte[] bytes, int count)
    {
        try
        {
            lock (c.WriteLock) c.Stream.Write(bytes, 0, count);
            return true;
        }
        catch
        {
            try { c.Stream?.Close(); } catch { }
            try { c.Tcp?.Close(); } catch { }
            return false;
        }
    }

    static bool CtrlClientAlive(ControlClient c)
    {
        lock (_ctrlClientsLock) return _ctrlClients.Contains(c);
    }

    static string CtrlEscape(string s)
    {
        return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
