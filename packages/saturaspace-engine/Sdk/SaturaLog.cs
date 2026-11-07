using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.CompilerServices;
using System.Threading;
using System.Text;
using UnityEngine;

namespace SaturaSpace
{

public static class SaturaLog
{
    const int FlushEveryN = 256;
    const int StreamBufSize = 8192;
    const long FileCap = 64L * 1024 * 1024;
    const int LinePrefixChars = 24;

    static string _dir;
    static bool _dirResolved;

    static string Dir
    {
        get
        {
            if (!_dirResolved)
            {
                _dirResolved = true;
                if (SaturaLaunch.Managed)
                {
                    try { _dir = Path.Combine(RuntimeRoot(), ".mcp_logs"); }
                    catch { _dir = null; }
                }
            }
            return _dir;
        }
    }

    public static bool Enabled => Dir != null;

    static readonly Dictionary<string, TagWriter> Writers = new(32);
    static readonly HashSet<string> FailedTags = new HashSet<string>();
    static readonly char[] InvalidChars = Path.GetInvalidFileNameChars();
    static bool _hooked;

    public static event Action<string, string> LineLogged;

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    public static void Log(string tag, string message)
    {
        var w = GetWriter(tag);
        if (w != null)
        {
            var s = w.Stream;
            s.Write("[F:");
            s.Write(Time.frameCount);
            s.Write(" T:");
            s.Write(Time.realtimeSinceStartup.ToString("F3"));
            s.Write("] ");
            s.WriteLine(message);
            w.Note(1, message?.Length ?? 0);
        }
        LineLogged?.Invoke(tag, message);
    }

    public static void LogRaw(string tag, int frame, float time, string message)
    {
        var w = GetWriter(tag);
        if (w != null)
        {
            var s = w.Stream;
            s.Write("[F:");
            s.Write(frame);
            s.Write(" T:");
            s.Write(time.ToString("F3"));
            s.Write("] ");
            s.WriteLine(message);
            w.Note(1, message?.Length ?? 0);
        }
        LineLogged?.Invoke(tag, message);
    }

    public static void LogBatch(string tag, IList<string> messages)
    {
        if (messages == null || messages.Count == 0) return;
        var w = GetWriter(tag);
        if (w != null)
        {
            var s = w.Stream;
            var frame = Time.frameCount;
            var time = Time.realtimeSinceStartup.ToString("F3");
            long chars = 0;
            for (int i = 0; i < messages.Count; i++)
            {
                s.Write("[F:");
                s.Write(frame);
                s.Write(" T:");
                s.Write(time);
                s.Write("] ");
                s.WriteLine(messages[i]);
                chars += messages[i]?.Length ?? 0;
            }
            w.Note(messages.Count, chars);
        }
        if (LineLogged != null)
            for (int i = 0; i < messages.Count; i++)
                LineLogged.Invoke(tag, messages[i]);
    }

    public static void Flush()
    {
        foreach (var w in Writers.Values)
        {
            try { w.Stream.Flush(); } catch { }
            w.Pending = 0;
        }
    }

    static FileStream OpenShared(string path)
    {
        return new FileStream(path, FileMode.Append, FileAccess.Write,
            FileShare.ReadWrite | FileShare.Delete, StreamBufSize);
    }

    public static void Clear()
    {
        Shutdown(keepConsole: true);
        FailedTags.Clear();
        var dir = Dir;
        if (dir == null) return;
        string[] files;
        try
        {
            if (!Directory.Exists(dir)) return;
            files = Directory.GetFiles(dir);
        }
        catch (Exception) { return; }
        var consolePath = Path.GetFullPath(Path.Combine(dir, ConsoleFile));
        foreach (var f in files)
        {
            if (Path.GetFullPath(f).Equals(consolePath, StringComparison.OrdinalIgnoreCase))
                continue;
            try { File.Delete(f); continue; }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            try
            {
                using (var fs = new FileStream(f, FileMode.Open, FileAccess.Write,
                    FileShare.ReadWrite | FileShare.Delete))
                    fs.SetLength(0);
            }
            catch (Exception) { }
        }
    }

    public static void Clear(string tag)
    {
        var safe = Sanitize(tag);
        FailedTags.Remove(safe);
        if (Writers.TryGetValue(safe, out var w))
        {
            w.Dispose();
            Writers.Remove(safe);
        }
        var dir = Dir;
        if (dir == null) return;
        var path = Path.Combine(dir, safe + ".log");
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { }
    }

    public static string LogDirectory => Dir;

    const string TagLog = "_log";
    const string TagWarn = "_warn";
    const string TagError = "_error";

    static void OnUnityLog(string message, string stackTrace, LogType type)
    {
        if (message != null && message.Length > 2000)
            message = message.Substring(0, 2000) + "...(truncated)";

        char severity;
        switch (type)
        {
            case LogType.Error:
            case LogType.Exception:
            case LogType.Assert:
                severity = 'E';
                Log(TagError, message);
                if (!string.IsNullOrEmpty(stackTrace))
                {
                    string firstLine = "";
                    foreach (var line in stackTrace.Split('\n'))
                    {
                        var t = line.Trim();
                        if (t.Length == 0 || t.StartsWith("UnityEngine.Debug", StringComparison.Ordinal)
                            || t.StartsWith("UnityEngine.Logger", StringComparison.Ordinal)) continue;
                        firstLine = t;
                        break;
                    }
                    if (firstLine.Length > 0)
                        Log(TagError, "  at " + firstLine);
                }
                break;
            case LogType.Warning:
                severity = 'W';
                Log(TagWarn, message);
                break;
            default:
                severity = 'L';
                Log(TagLog, message);
                break;
        }

        WriteConsole(severity, message, severity == 'E' ? stackTrace : null);
    }

    const string ConsoleFile = "console.log";
    const int ConsoleQueueCap = 50000;
    const int ConsoleFlushMs = 50;
    static StreamWriter _console;
    static string _consolePath;
    static long _consoleBytes;
    static volatile bool _consoleFailed;
    static readonly ConcurrentQueue<string> _consoleQueue = new ConcurrentQueue<string>();
    static Thread _consoleThread;
    static volatile bool _consoleRun;
    static int _consoleDropped;

    static void StartConsole()
    {
        var dir = Dir;
        if (dir == null) { _consoleFailed = true; return; }
        try
        {
            Directory.CreateDirectory(dir);
            SspaceGitignore.EnsureFor(dir);
            _consolePath = Path.Combine(dir, ConsoleFile);
            _console = OpenConsole(_consolePath);
            _consoleRun = true;
            _consoleThread = new Thread(ConsoleLoop) { IsBackground = true, Name = "SaturaLog.Console" };
            _consoleThread.Start();
        }
        catch
        {
            try { _console?.Dispose(); } catch { }
            _console = null;
            _consoleThread = null;
            _consoleFailed = true;
        }
    }

    static StreamWriter OpenConsole(string path)
    {
        var fs = OpenShared(path);
        Interlocked.Exchange(ref _consoleBytes, fs.Length);
        return new StreamWriter(fs, new UTF8Encoding(false), StreamBufSize)
        {
            AutoFlush = false,
            NewLine = "\n"
        };
    }

    static void WriteConsole(char severity, string message, string stackTrace)
    {
        try
        {
            if (_consoleFailed) return;
            if (_consoleThread == null) StartConsole();
            if (_console == null) return;
            if (_consoleQueue.Count >= ConsoleQueueCap)
            {
                Interlocked.Increment(ref _consoleDropped);
                return;
            }
            var sb = new StringBuilder(96);
            sb.Append("[F:").Append(Time.frameCount)
              .Append(" T:").Append(Time.realtimeSinceStartup.ToString("F3"))
              .Append("] ").Append(severity).Append(' ').Append(message ?? string.Empty).Append('\n');
            if (!string.IsNullOrEmpty(stackTrace))
            {
                var stackLines = stackTrace.Split('\n');
                for (int i = 0; i < stackLines.Length; i++)
                {
                    var ln = stackLines[i].TrimEnd();
                    if (ln.Length == 0) continue;
                    sb.Append("    ").Append(ln).Append('\n');
                }
            }
            _consoleQueue.Enqueue(sb.ToString());
        }
        catch { }
    }

    static void ConsoleLoop()
    {
        while (_consoleRun)
        {
            if (DrainConsole())
            {
                try { _console.Flush(); } catch { }
                CapConsole();
            }
            Thread.Sleep(ConsoleFlushMs);
        }
        try { if (DrainConsole()) _console.Flush(); } catch { }
    }

    static bool DrainConsole()
    {
        bool wrote = false;
        int dropped = Interlocked.Exchange(ref _consoleDropped, 0);
        if (dropped > 0)
        {
            try
            {
                _console.Write("[F:-1 T:0.000] W [console] dropped ");
                _console.Write(dropped);
                _console.Write(" line(s) during a log burst\n");
                wrote = true;
            }
            catch { }
        }
        while (_consoleQueue.TryDequeue(out var s))
        {
            try { _console.Write(s); wrote = true; Interlocked.Add(ref _consoleBytes, s.Length); } catch { }
        }
        return wrote;
    }

    static void CapConsole()
    {
        if (Interlocked.Read(ref _consoleBytes) < FileCap || _consolePath == null) return;
        var old = _console;
        try { old.Flush(); } catch { }
        try { old.Dispose(); } catch { }
        bool cleared = TruncateFile(_consolePath);
        try { _console = OpenConsole(_consolePath); }
        catch { _console = StreamWriter.Null; }
        if (!cleared || Interlocked.Read(ref _consoleBytes) >= FileCap)
        {
            Interlocked.Exchange(ref _consoleBytes, 0);
            return;
        }
        try
        {
            _console.Write("[F:-1 T:0.000] W [console] cleared after reaching " + (FileCap >> 20) + " MB\n");
            _console.Flush();
        }
        catch { }
    }

    static bool TruncateFile(string path)
    {
        try
        {
            if (!File.Exists(path)) return true;
            using (var fs = new FileStream(path, FileMode.Open, FileAccess.Write,
                FileShare.ReadWrite | FileShare.Delete))
                fs.SetLength(0);
            return true;
        }
        catch { return false; }
    }

    static void TruncateConsole()
    {
        var dir = Dir;
        if (dir == null) return;
        if (TruncateFile(Path.Combine(dir, ConsoleFile)))
            Interlocked.Exchange(ref _consoleBytes, 0);
    }

    [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.BeforeSceneLoad)]
    static void Hook()
    {
        if (_hooked) return;
        if (Dir == null) return;
        _hooked = true;
        _consoleFailed = false;
        FailedTags.Clear();
        TruncateConsole();
        Application.logMessageReceived += OnUnityLog;
        Application.quitting += Shutdown;
        AppDomain.CurrentDomain.DomainUnload += OnDomainUnload;
        WriteConsole('P', "Entered Play Mode", null);
    }

    static void OnDomainUnload(object sender, EventArgs e) => Shutdown();

    static void Shutdown() => Shutdown(keepConsole: false);

    static void Shutdown(bool keepConsole)
    {
        Application.logMessageReceived -= OnUnityLog;
        foreach (var w in Writers.Values)
            w.Dispose();
        Writers.Clear();
        if (!keepConsole)
        {
            _consoleRun = false;
            var th = _consoleThread;
            _consoleThread = null;
            if (th != null) { try { th.Join(500); } catch { } }
            if (_console != null)
            {
                try { DrainConsole(); _console.Flush(); } catch { }
                try { _console.Dispose(); } catch { }
                _console = null;
            }
        }
        _hooked = false;
    }

    [MethodImpl(MethodImplOptions.AggressiveInlining)]
    static TagWriter GetWriter(string tag)
    {
        var dir = Dir;
        if (dir == null) return null;
        var safe = Sanitize(tag);
        if (Writers.TryGetValue(safe, out var w))
            return w;
        if (FailedTags.Contains(safe)) return null;
        try
        {
            Directory.CreateDirectory(dir);
            SspaceGitignore.EnsureFor(dir);
            w = new TagWriter(Path.Combine(dir, safe + ".log"));
        }
        catch
        {
            FailedTags.Add(safe);
            return null;
        }
        Writers[safe] = w;
        return w;
    }

    static string Sanitize(string tag)
    {
        if (string.IsNullOrEmpty(tag)) return "_default";

        int firstBad = -1;
        for (int i = 0; i < tag.Length && firstBad < 0; i++)
            for (int j = 0; j < InvalidChars.Length; j++)
                if (tag[i] == InvalidChars[j]) { firstBad = i; break; }
        if (firstBad < 0) return tag;

        var sb = new StringBuilder(tag.Length);
        sb.Append(tag, 0, firstBad);
        for (int i = firstBad; i < tag.Length; i++)
        {
            var c = tag[i];
            bool bad = false;
            for (int j = 0; j < InvalidChars.Length; j++)
            {
                if (c == InvalidChars[j]) { bad = true; break; }
            }
            sb.Append(bad ? '_' : c);
        }
        return sb.ToString();
    }

    static string GetProjectRoot()
    {
        var over = SaturaLaunch.Arg("-mcpRoot");
        if (!string.IsNullOrEmpty(over))
            return over;
#if !UNITY_EDITOR
        return Application.persistentDataPath;
#else
        return Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
#endif
    }

    static string RuntimeRoot()
    {
        var root = GetProjectRoot();
        if (string.IsNullOrEmpty(SaturaLaunch.Arg("-mcpRoot")) && Application.isEditor)
        {
            var dir = Path.Combine(root, ".sspace");
            try { Directory.CreateDirectory(dir); } catch { }
            SspaceGitignore.EnsureFor(dir);
            return dir;
        }
        SspaceGitignore.EnsureFor(root);
        return root;
    }

    sealed class TagWriter : IDisposable
    {
        readonly string _path;
        public StreamWriter Stream;
        public int Pending;
        long _written;

        public TagWriter(string path)
        {
            _path = path;
            Stream = Open(path, out _written);
        }

        static StreamWriter Open(string path, out long length)
        {
            var fs = OpenShared(path);
            length = fs.Length;
            return new StreamWriter(fs, Encoding.UTF8, StreamBufSize)
            {
                AutoFlush = false,
                NewLine = "\n"
            };
        }

        public void Note(int lines, long chars)
        {
            _written += chars + (long)lines * LinePrefixChars;
            Pending += lines;
            if (_written >= FileCap)
            {
                Cap();
                return;
            }
            if (Pending >= FlushEveryN)
            {
                try { Stream.Flush(); } catch { }
                Pending = 0;
            }
        }

        void Cap()
        {
            Pending = 0;
            try { Stream.Flush(); } catch { }
            try { Stream.Dispose(); } catch { }
            bool cleared = TruncateFile(_path);
            try { Stream = Open(_path, out _written); }
            catch { Stream = StreamWriter.Null; _written = 0; }
            if (!cleared || _written >= FileCap)
            {
                _written = 0;
                return;
            }
            try { Stream.WriteLine("[F:-1 T:0.000] [SaturaLog] cleared after reaching " + (FileCap >> 20) + " MB"); }
            catch { }
        }

        public void Dispose()
        {
            try { Stream?.Flush(); } catch { }
            try { Stream?.Dispose(); } catch { }
        }
    }
}

static class SspaceGitignore
{
    const string DirName = ".sspace";

    internal static void EnsureFor(string path)
    {
        if (string.IsNullOrEmpty(path) || path.IndexOf(DirName, StringComparison.OrdinalIgnoreCase) < 0) return;
        try
        {
            var dir = path;
            while (!string.IsNullOrEmpty(dir)
                   && !string.Equals(Path.GetFileName(dir), DirName, StringComparison.OrdinalIgnoreCase))
                dir = Path.GetDirectoryName(dir);
            if (string.IsNullOrEmpty(dir) || !Directory.Exists(dir)) return;
            var gi = Path.Combine(dir, ".gitignore");
            if (Directory.Exists(gi)) return;
            if (File.Exists(gi) && IgnoresEverything(File.ReadAllText(gi))) return;
            File.WriteAllText(gi, "*\n", new UTF8Encoding(false));
        }
        catch { }
    }

    static bool IgnoresEverything(string content)
    {
        bool all = false;
        foreach (var raw in content.Split('\n'))
        {
            var line = raw.EndsWith("\r", StringComparison.Ordinal) ? raw.Substring(0, raw.Length - 1) : raw;
            line = line.Trim();
            if (line.Length == 0 || line[0] == '#') continue;
            if (line[0] == '!') return false;
            if (line == "*") all = true;
        }
        return all;
    }
}
}
