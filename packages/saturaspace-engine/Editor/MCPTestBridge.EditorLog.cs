using UnityEngine;
using UnityEditor;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using SaturaSpace;

public static partial class MCPTestBridge
{
    static string EditorConsolePath => Path.Combine(SspaceRoot, ".mcp_logs", "console.log");

    static readonly Regex _compileErrorLine = new Regex(@":\s*error CS\d+", RegexOptions.Compiled);

    static readonly string[] _internalLogPrefixes = { "[MCPTestBridge]", "[MCPControl]", "[RawFrameStream]" };

    static bool IsInternalDiagnostic(string message)
    {
        for (int i = 0; i < _internalLogPrefixes.Length; i++)
            if (message.StartsWith(_internalLogPrefixes[i])) return true;
        return false;
    }

    static StreamWriter _editorConsole;
    static readonly object _editorConsoleLock = new object();

    const string ConsoleSessionFreshKey = "SaturaSpace.ConsoleSessionFresh";

    [InitializeOnLoadMethod]
    static void InitEditorLogCapture()
    {
        if (Inert) return;
        if (!SessionState.GetBool(ConsoleSessionFreshKey, false))
        {
            SessionState.SetBool(ConsoleSessionFreshKey, true);
            TruncateEditorConsole();
        }
        Application.logMessageReceived += OnEditorLog;
        EditorApplication.playModeStateChanged += RearmEditorLogCapture;
        AssemblyReloadEvents.beforeAssemblyReload += CloseEditorConsole;
        EditorApplication.quitting += CloseEditorConsole;
    }

    static void RearmEditorLogCapture(PlayModeStateChange state)
    {
        if (state != PlayModeStateChange.EnteredEditMode) return;
        Application.logMessageReceived -= OnEditorLog;
        Application.logMessageReceived += OnEditorLog;
    }

    static void TruncateEditorConsole()
    {
        lock (_editorConsoleLock)
        {
            try
            {
                if (!File.Exists(EditorConsolePath)) return;
                using (var fs = new FileStream(EditorConsolePath, FileMode.Open, FileAccess.Write,
                    FileShare.ReadWrite | FileShare.Delete))
                    fs.SetLength(0);
            }
            catch { }
        }
    }

    static void OnEditorLog(string message, string stackTrace, LogType type)
    {
        if (EditorApplication.isPlayingOrWillChangePlaymode) return;

        if (type == LogType.Error && message != null && _compileErrorLine.IsMatch(message))
            return;

        if (type == LogType.Log && message != null && IsInternalDiagnostic(message))
            return;

        char severity;
        switch (type)
        {
            case LogType.Error:
            case LogType.Exception:
            case LogType.Assert:
                severity = 'E';
                break;
            case LogType.Warning:
                severity = 'W';
                break;
            default:
                severity = 'L';
                break;
        }

        if (message != null && message.Length > 2000)
            message = message.Substring(0, 2000) + "...(truncated)";

        var sb = new StringBuilder(128);
        sb.Append("[F:-1 T:0.000] ").Append(severity).Append(' ')
          .Append(message ?? string.Empty).Append('\n');
        if (severity == 'E' && !string.IsNullOrEmpty(stackTrace))
        {
            var stackLines = stackTrace.Split('\n');
            for (int i = 0; i < stackLines.Length; i++)
            {
                var ln = stackLines[i].TrimEnd();
                if (ln.Length == 0) continue;
                sb.Append("    ").Append(ln).Append('\n');
            }
        }

        lock (_editorConsoleLock)
        {
            try
            {
                if (_editorConsole == null)
                {
                    Directory.CreateDirectory(Path.GetDirectoryName(EditorConsolePath));
                    SspaceFolder.EnsureFor(EditorConsolePath);
                    _editorConsole = new StreamWriter(
                        new FileStream(EditorConsolePath, FileMode.Append, FileAccess.Write,
                            FileShare.ReadWrite | FileShare.Delete, 8192),
                        new UTF8Encoding(false), 8192)
                    {
                        AutoFlush = true,
                        NewLine = "\n"
                    };
                }
                _editorConsole.Write(sb.ToString());
            }
            catch { }
        }
    }

    static void CloseEditorConsole()
    {
        lock (_editorConsoleLock)
        {
            if (_editorConsole == null) return;
            try { _editorConsole.Flush(); } catch { }
            try { _editorConsole.Dispose(); } catch { }
            _editorConsole = null;
        }
    }
}
