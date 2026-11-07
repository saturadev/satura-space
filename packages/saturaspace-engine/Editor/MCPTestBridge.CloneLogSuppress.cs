using System;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    static bool _cloneLogFilterInstalled;
    static ILogHandler _cloneLogFilterOriginal;

    [InitializeOnLoadMethod]
    static void InstallCloneLogCountsFilter()
    {
        if (Inert) return;
        try
        {
            if (_cloneLogFilterInstalled) return;
            if (Application.platform != RuntimePlatform.WindowsEditor) return;
            if (!IsVirtualProjectClone) return;

            var logger = Debug.unityLogger;
            if (logger == null) return;

            var current = logger.logHandler;
            if (current is MppmCloneLogFilter) { _cloneLogFilterInstalled = true; return; }

            _cloneLogFilterOriginal = current;
            logger.logHandler = new MppmCloneLogFilter(current);
            _cloneLogFilterInstalled = true;
            EditorApplication.quitting += RestoreCloneLogCountsFilter;
        }
        catch { }
    }

    static void RestoreCloneLogCountsFilter()
    {
        try
        {
            var logger = Debug.unityLogger;
            if (logger != null && logger.logHandler is MppmCloneLogFilter && _cloneLogFilterOriginal != null)
                logger.logHandler = _cloneLogFilterOriginal;
        }
        catch { }
        _cloneLogFilterInstalled = false;
    }

    sealed class MppmCloneLogFilter : ILogHandler
    {
        readonly ILogHandler _inner;

        public MppmCloneLogFilter(ILogHandler inner)
        {
            _inner = inner;
        }

        static bool IsCloneLogCountsNoise(string text)
        {
            if (string.IsNullOrEmpty(text)) return false;
            if (text.IndexOf("UpdateCloneLogCountsMessage", StringComparison.Ordinal) < 0) return false;
            return text.IndexOf("MessagingService", StringComparison.Ordinal) >= 0
                || text.IndexOf("Serialize", StringComparison.Ordinal) >= 0;
        }

        static bool IsGameViewPlayModeTeardownNoise(Exception exception)
        {
            if (exception == null || !(exception is NullReferenceException)) return false;
            string text = exception.ToString();
            if (string.IsNullOrEmpty(text)) return false;
            return text.IndexOf("GameView.OnPlayModeStateChanged", StringComparison.Ordinal) >= 0
                || (text.IndexOf("Internal_PlayModeStateChanged", StringComparison.Ordinal) >= 0
                    && text.IndexOf("GameView", StringComparison.Ordinal) >= 0);
        }

        public void LogException(Exception exception, UnityEngine.Object context)
        {
            try
            {
                if (exception != null && IsCloneLogCountsNoise(exception.ToString())) return;
                if (IsGameViewPlayModeTeardownNoise(exception)) return;
            }
            catch { }

            if (_inner != null) _inner.LogException(exception, context);
        }

        public void LogFormat(LogType logType, UnityEngine.Object context, string format, params object[] args)
        {
            try
            {
                string text = (args != null && args.Length > 0) ? string.Format(format, args) : format;
                if (IsCloneLogCountsNoise(text)) return;
            }
            catch { }

            if (_inner != null) _inner.LogFormat(logType, context, format, args);
        }
    }
}
