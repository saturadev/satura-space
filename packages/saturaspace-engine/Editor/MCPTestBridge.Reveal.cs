using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using SaturaSpace;

public static partial class MCPTestBridge
{
    static string _revealFile;
    static string _statusFile;
    static bool _revealFileResolved;
    static long _revealEpoch;
    static MethodInfo _miLoadDefaultWindowPreferences;
    static MethodInfo _miTryLoadWindowLayout;
    static MethodInfo _miGetDefaultLayoutPath;
    static PropertyInfo _piProjectLayoutPath;
    static Type _tContainerWindow;
    static PropertyInfo _piShowMode;
    static bool _revealReflectionResolved;

    static readonly bool _revealDebug =
        SaturaDebug.Flag("SATURA_REVEAL_DEBUG");

    static void ResolveRevealFile()
    {
        if (_revealFileResolved) return;
        _revealFileResolved = true;
        _revealFile = Environment.GetEnvironmentVariable("SATURA_WINHOOK_REVEAL_FILE");
        if (string.IsNullOrEmpty(_revealFile)) return;
        _statusFile = _revealFile + ".status";
        EditorApplication.quitting += RestoreLayoutOnQuit;
    }

    static long ParseLongField(string text, string key)
    {
        int i = text.IndexOf(key, StringComparison.Ordinal);
        if (i < 0) return -1;
        i += key.Length;
        while (i < text.Length && (text[i] == ' ' || text[i] == ':')) i++;
        bool neg = false;
        if (i < text.Length && text[i] == '-') { neg = true; i++; }
        if (i >= text.Length || text[i] < '0' || text[i] > '9') return -1;
        long v = 0;
        while (i < text.Length && text[i] >= '0' && text[i] <= '9') { v = v * 10 + (text[i] - '0'); i++; }
        return neg ? -v : v;
    }

    static void ResolveRevealReflection()
    {
        if (_revealReflectionResolved) return;
        _revealReflectionResolved = true;
        var wl = Type.GetType("UnityEditor.WindowLayout,UnityEditor");
        _miLoadDefaultWindowPreferences = wl?.GetMethod("LoadDefaultWindowPreferences",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
        _miTryLoadWindowLayout = wl?.GetMethod("TryLoadWindowLayout",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null,
            new[] { typeof(string), typeof(bool), typeof(bool), typeof(bool), typeof(bool) }, null);
        _miGetDefaultLayoutPath = wl?.GetMethod("GetDefaultLayoutPath",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
        _piProjectLayoutPath = wl?.GetProperty("ProjectLayoutPath",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        _tContainerWindow = Type.GetType("UnityEditor.ContainerWindow,UnityEditor");
        _piShowMode = _tContainerWindow?.GetProperty("showMode",
            BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
    }

    static bool MainWindowExists()
    {
        if (_tContainerWindow == null || _piShowMode == null) return false;
        foreach (var w in Resources.FindObjectsOfTypeAll(_tContainerWindow))
        {
            try { if (Convert.ToInt32(_piShowMode.GetValue(w)) == 4) return true; }
            catch { }
        }
        return false;
    }

    static PropertyInfo _piSkinIndex;
    static MethodInfo _miUpdateSkinCache;
    static bool _skinReflectionResolved;

    static void ResolveSkinReflection()
    {
        if (_skinReflectionResolved) return;
        _skinReflectionResolved = true;
        _piSkinIndex = typeof(EditorGUIUtility).GetProperty("skinIndex",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        var es = Type.GetType("UnityEditor.EditorStyles,UnityEditor");
        _miUpdateSkinCache = es?.GetMethod("UpdateSkinCache",
            BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic,
            null, new[] { typeof(int) }, null);
    }

    static void ForceDarkSkin()
    {
        ResolveSkinReflection();
        if (_piSkinIndex == null) return;
        try
        {
            int cur = Convert.ToInt32(_piSkinIndex.GetValue(null));
            if (cur != 1 && _piSkinIndex.CanWrite) _piSkinIndex.SetValue(null, 1);
            if (TunerInGui()) _miUpdateSkinCache?.Invoke(null, new object[] { 1 });
        }
        catch (Exception e) { if (_revealDebug) Debug.LogWarning("[RevealDBG] skin set failed: " + e.Message); }
        HealTunerEditorStyles();
    }

    static void RepaintAll()
    {
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null) continue;
            try { w.Repaint(); } catch { }
        }
    }

    enum RevealState { Hidden, Showing, Settling, Revealed }

    const double REVEAL_WINDOW_TIMEOUT = 6.0;
    const int REVEAL_SETTLE_TICKS = 2;
    const int REVEAL_MAX_RELAYOUTS = 3;

    static RevealState _revealState = RevealState.Hidden;
    static long _revealCycleEpoch = -1;
    static double _revealCycleStartedAt;
    static int _revealSettleTicks;
    static int _revealRelayouts;

    static bool RevealActive() => RevealWanted() || _revealState != RevealState.Hidden;

    static void SetRevealState(RevealState next, string why)
    {
        if (next == _revealState) return;
        if (_revealDebug) Debug.Log("[RevealDBG] " + _revealState + " -> " + next + ": " + why);
        _revealState = next;
        _revealSettleTicks = 0;
    }

    static bool AnyDockedEditorWindow()
    {
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null) continue;
            try { if (w.docked) return true; } catch { }
        }
        return false;
    }

    const double HIDDEN_LAYOUT_RETRY_INTERVAL = 1.0;

    static double _lastHiddenLayoutAttempt = double.NegativeInfinity;
    static bool _hiddenMaximizeUnavailable;
    static bool _hiddenMarkerChecked;
    static bool _hiddenMarkerPresent;

    static string HiddenLayoutMarker => Path.Combine(SspaceRoot, ".hidden_layout_maximize");

    static bool HiddenLayoutOurs
    {
        get
        {
            if (!_hiddenMarkerChecked)
            {
                _hiddenMarkerChecked = true;
                try { _hiddenMarkerPresent = File.Exists(HiddenLayoutMarker); }
                catch { _hiddenMarkerPresent = false; }
            }
            return _hiddenMarkerPresent;
        }
        set
        {
            _hiddenMarkerChecked = true;
            _hiddenMarkerPresent = value;
            try
            {
                if (value)
                {
                    SspaceFolder.EnsureFor(HiddenLayoutMarker);
                    File.WriteAllText(HiddenLayoutMarker, "1");
                }
                else if (File.Exists(HiddenLayoutMarker)) File.Delete(HiddenLayoutMarker);
            }
            catch { }
        }
    }

    static EditorWindow FindMaximizedWindow()
    {
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null) continue;
            try { if (w.maximized) return w; } catch { }
        }
        return null;
    }

    static string _layoutsDir;
    static bool _layoutsDirResolved;

    static string LayoutsDir
    {
        get
        {
            if (_layoutsDirResolved) return _layoutsDir;
            _layoutsDirResolved = true;
            try
            {
                var wl = Type.GetType("UnityEditor.WindowLayout,UnityEditor");
                var pi = wl?.GetProperty("layoutsProjectPath",
                    BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
                var v = pi?.GetValue(null) as string;
                if (!string.IsNullOrEmpty(v))
                    _layoutsDir = Path.IsPathRooted(v) ? v : Path.Combine(ProjectRoot, v);
            }
            catch { }
            if (string.IsNullOrEmpty(_layoutsDir))
                _layoutsDir = Path.Combine(ProjectRoot, "UserSettings", "Layouts");
            return _layoutsDir;
        }
    }

    static bool MaximizeBackupExists()
    {
        try
        {
            var fi = new FileInfo(Path.Combine(LayoutsDir, "CurrentMaximizeLayout.dwlt"));
            return fi.Exists && fi.Length > 0;
        }
        catch { return false; }
    }

    static void DeleteMaximizeBackup()
    {
        try
        {
            var p = Path.Combine(LayoutsDir, "CurrentMaximizeLayout.dwlt");
            if (File.Exists(p)) File.Delete(p);
        }
        catch { }
    }

    static void CloseDuplicateGameViews()
    {
        EditorWindow keep = null;
        List<EditorWindow> extras = null;
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null || w.GetType().Name != "GameView") continue;
            if (keep == null) { keep = w; continue; }
            bool preferNew;
            try
            {
                preferNew = w.maximized || (!keep.maximized && w.docked && !keep.docked);
            }
            catch { preferNew = false; }
            extras ??= new List<EditorWindow>();
            if (preferNew) { extras.Add(keep); keep = w; }
            else extras.Add(w);
        }
        if (extras == null) return;
        Debug.LogWarning("[MCPTestBridge] closing " + extras.Count + " duplicate GameView tab(s)");
        foreach (var w in extras)
        {
            try { w.Close(); } catch { }
            if (w != null)
            {
                try { UnityEngine.Object.DestroyImmediate(w); } catch { }
            }
        }
    }

    static void DeleteProjectLayoutFiles()
    {
        try
        {
            if (!Directory.Exists(LayoutsDir)) return;
            foreach (var f in Directory.GetFiles(LayoutsDir, "CurrentLayout*.dwlt"))
                try { File.Delete(f); } catch { }
        }
        catch { }
    }

    static bool _layoutFailureLogged;

    static bool LayoutHealthy() => FindMaximizedWindow() == null || MaximizeBackupExists();

    static bool TryInvokeLayout(MethodInfo mi, object[] args, string what)
    {
        if (mi == null) return false;
        try
        {
            var r = mi.Invoke(null, args);
            return !(r is bool ok) || ok;
        }
        catch (Exception e)
        {
            var ex = e.InnerException ?? e;
            if (!_layoutFailureLogged)
            {
                _layoutFailureLogged = true;
                Debug.LogWarning("[MCPTestBridge] " + what + " failed: " + ex);
            }
            else if (_revealDebug) Debug.LogWarning("[RevealDBG] " + what + " failed: " + ex.Message);
            return false;
        }
    }

    static string ProjectLayoutPath()
    {
        try { return _piProjectLayoutPath?.GetValue(null) as string; }
        catch { return null; }
    }

    static bool ApplyDefaultLayout()
    {
        ResolveRevealReflection();
        try
        {
            string path = null;
            try { path = _miGetDefaultLayoutPath?.Invoke(null, null) as string; }
            catch { }

            if (!string.IsNullOrEmpty(path) && File.Exists(path)
                && TryInvokeLayout(_miTryLoadWindowLayout,
                                   new object[] { path, false, true, true, true },
                                   "default layout apply"))
                return true;

            try { return EditorApplication.ExecuteMenuItem("Window/Layouts/Default"); }
            catch (Exception e)
            {
                if (_revealDebug) Debug.LogWarning("[RevealDBG] Default layout menu item failed: " + e.Message);
                return false;
            }
        }
        finally
        {
            CloseDuplicateGameViews();
            RepaintAll();
        }
    }

    static bool RebuildLayoutLadder()
    {
        if (TryInvokeLayout(_miLoadDefaultWindowPreferences, null, "layout rebuild") && LayoutHealthy())
            return true;

        var projectLayout = ProjectLayoutPath();
        if (!string.IsNullOrEmpty(projectLayout)
            && TryInvokeLayout(_miTryLoadWindowLayout,
                               new object[] { projectLayout, false, false, true, false },
                               "layout reload")
            && LayoutHealthy())
            return true;

        DeleteProjectLayoutFiles();
        return TryInvokeLayout(_miLoadDefaultWindowPreferences, null, "default layout rebuild") && LayoutHealthy();
    }

    static bool RebuildLayoutSilently()
    {
        ResolveRevealFile();
        ResolveRevealReflection();
        bool ok = false;
        try
        {
            ok = RebuildLayoutLadder();
            return ok;
        }
        finally
        {
            if (ok) _layoutFailureLogged = false;
            CloseDuplicateGameViews();
            RepaintAll();
        }
    }

    const double DEFUSE_POLL_INTERVAL = 1.0;
    const int DEFUSE_MAX_ATTEMPTS = 3;
    const string SS_DEFUSE_GAVE_UP = "MCPTestBridge_DefuseGaveUp";
    static double _lastDefusePoll = double.NegativeInfinity;
    static int _defuseAttempts;

    static bool DefuseGaveUp
    {
        get => SessionState.GetBool(SS_DEFUSE_GAVE_UP, false);
        set => SessionState.SetBool(SS_DEFUSE_GAVE_UP, value);
    }

    static void PumpDefuseOrphanMaximize()
    {
        ResolveRevealFile();
        if (string.IsNullOrEmpty(_revealFile)) return;
        double now = EditorApplication.timeSinceStartup;
        if (now - _lastDefusePoll < DEFUSE_POLL_INTERVAL) return;
        _lastDefusePoll = now;
        if (EditorApplication.isPlayingOrWillChangePlaymode || EditorApplication.isCompiling) return;
        if (LayoutHealthy())
        {
            _defuseAttempts = 0;
            if (DefuseGaveUp) DefuseGaveUp = false;
            _layoutFailureLogged = false;
            return;
        }
        if (DefuseGaveUp) return;
        _defuseAttempts++;
        Debug.LogWarning("[MCPTestBridge] maximized layout without restore backup — rebuilding layout silently (attempt "
            + _defuseAttempts + "/" + DEFUSE_MAX_ATTEMPTS + ")");
        HiddenLayoutOurs = false;
        if (RebuildLayoutSilently())
        {
            _defuseAttempts = 0;
            _layoutFailureLogged = false;
            return;
        }
        if (_defuseAttempts >= DEFUSE_MAX_ATTEMPTS)
        {
            DefuseGaveUp = true;
            Debug.LogWarning("[MCPTestBridge] could not rebuild the window layout after " + DEFUSE_MAX_ATTEMPTS
                + " attempts — applying the editor's Default layout.");
            bool applied = ApplyDefaultLayout();
            _layoutFailureLogged = false;
            if (applied && LayoutHealthy())
                Debug.Log("[MCPTestBridge] Default layout applied.");
            else
                Debug.LogWarning("[MCPTestBridge] the Default layout did not take either — pick a layout from the "
                    + "editor's Layout menu to reset it.");
        }
    }

    static bool GameViewSuppressed =>
        Application.platform == RuntimePlatform.WindowsEditor && IsVirtualProjectClone;

    static readonly string[] HiddenLayoutPriority =
        { "GameView", "ProjectBrowser", "ConsoleWindow", "InspectorWindow", "SceneHierarchyWindow" };

    static EditorWindow PickHiddenLayoutTarget()
    {
        bool noGameView = GameViewSuppressed;
        EditorWindow best = null;
        EditorWindow fallback = null;
        int bestRank = int.MaxValue;
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null) continue;
            bool docked;
            try { docked = w.docked; } catch { continue; }
            if (!docked) continue;
            var n = w.GetType().Name;
            if (noGameView && (n == "GameView" || n == "SimulatorWindow")) continue;
            int rank = Array.IndexOf(HiddenLayoutPriority, n);
            if (rank >= 0 && rank < bestRank) { best = w; bestRank = rank; }
            else if (fallback == null && !(w is SceneView)) fallback = w;
        }
        return best ?? fallback;
    }

    static void PumpHiddenMinimalLayout()
    {
        double now = EditorApplication.timeSinceStartup;
        if (now - _lastHiddenLayoutAttempt < HIDDEN_LAYOUT_RETRY_INTERVAL) return;
        _lastHiddenLayoutAttempt = now;
        if (EditorApplication.isCompiling) return;
        if (EditorApplication.isPlayingOrWillChangePlaymode && !EditorApplication.isPlaying) return;
        if (!MainWindowExists()) return;
        var maximized = FindMaximizedWindow();
        if (HiddenLayoutOurs)
        {
            if (maximized != null) return;
            HiddenLayoutOurs = false;
        }
        else if (maximized != null && (_hiddenMaximizeUnavailable || !StowUserMaximized(maximized))) return;
        if (_hiddenMaximizeUnavailable) return;
        EnsureDockedGameView();
        CloseDuplicateGameViews();
        var target = PickHiddenLayoutTarget();
        if (target == null) return;
        try
        {
            DeleteMaximizeBackup();
            target.maximized = true;
            if (!target.maximized)
            {
                if (_revealDebug) Debug.LogWarning("[RevealDBG] hidden maximize did not take, retrying later");
                return;
            }
            if (!MaximizeBackupExists())
            {
                _hiddenMaximizeUnavailable = true;
                Debug.LogWarning("[MCPTestBridge] maximize backup was not written — undoing hidden minimal layout");
                RebuildLayoutSilently();
                return;
            }
            HiddenLayoutOurs = true;
            if (_revealDebug) Debug.Log("[RevealDBG] hidden: maximized " + target.GetType().Name);
        }
        catch (Exception e)
        {
            if (_revealDebug) Debug.LogWarning("[RevealDBG] hidden maximize failed: " + e.Message);
        }
    }

    static MethodInfo _miCreateWindow;

    static void EnsureDockedGameView()
    {
        if (GameViewSuppressed) return;
        var gvType = Type.GetType("UnityEditor.GameView,UnityEditor");
        if (gvType == null) return;
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null || !IsPlayModeViewWindow(w)) continue;
            try { if (w.docked) return; } catch { return; }
        }
        try
        {
            _miCreateWindow ??= Array.Find(typeof(EditorWindow).GetMethods(BindingFlags.Public | BindingFlags.Static),
                m => m.Name == "CreateWindow" && m.IsGenericMethodDefinition && m.GetParameters().Length == 1
                     && m.GetParameters()[0].ParameterType == typeof(Type[]));
            var dockNextTo = Array.FindAll(new[] { typeof(SceneView), Type.GetType("UnityEditor.ProjectBrowser,UnityEditor"),
                Type.GetType("UnityEditor.InspectorWindow,UnityEditor") }, t => t != null);
            _miCreateWindow?.MakeGenericMethod(gvType).Invoke(null, new object[] { dockNextTo });
            if (_revealDebug) Debug.Log("[RevealDBG] hidden: no docked GameView, docked a new one");
        }
        catch (Exception e) { if (_revealDebug) Debug.LogWarning("[RevealDBG] docking a GameView failed: " + (e.InnerException ?? e).Message); }
    }

    const string SS_USER_MAXIMIZED = "MCPTestBridge_UserMaximized";

    static bool IsPlayModeViewWindow(EditorWindow w)
    {
        var n = w.GetType().Name;
        return n == "GameView" || n == "SimulatorWindow";
    }

    static bool StowUserMaximized(EditorWindow w)
    {
        try
        {
            if (IsPlayModeViewWindow(w) || !MaximizeBackupExists()) return false;
            var type = w.GetType().FullName;
            w.maximized = false;
            SessionState.SetString(SS_USER_MAXIMIZED, type);
            if (_revealDebug) Debug.Log("[RevealDBG] hidden: unmaximized the user's " + type + " so only the GameView renders");
            return FindMaximizedWindow() == null;
        }
        catch (Exception e)
        {
            if (_revealDebug) Debug.LogWarning("[RevealDBG] unmaximizing the user's window failed: " + e.Message);
            return false;
        }
    }

    static void RestoreUserMaximized()
    {
        var type = SessionState.GetString(SS_USER_MAXIMIZED, "");
        if (type.Length == 0) return;
        SessionState.EraseString(SS_USER_MAXIMIZED);
        if (FindMaximizedWindow() != null) return;
        foreach (var w in Resources.FindObjectsOfTypeAll<EditorWindow>())
        {
            if (w == null) continue;
            try
            {
                if (w.GetType().FullName != type || !w.docked) continue;
                w.maximized = true;
                if (_revealDebug) Debug.Log("[RevealDBG] reveal: maximized the user's " + type + " again");
            }
            catch (Exception e)
            {
                if (_revealDebug) Debug.LogWarning("[RevealDBG] re-maximizing the user's window failed: " + e.Message);
            }
            return;
        }
    }

    static void RestoreRevealedLayout()
    {
        if (!HiddenLayoutOurs || !MainWindowExists()) return;
        var maximized = FindMaximizedWindow();
        if (maximized == null)
        {
            HiddenLayoutOurs = false;
            return;
        }
        if (MaximizeBackupExists())
        {
            try
            {
                maximized.maximized = false;
                HiddenLayoutOurs = false;
                if (FindMaximizedWindow() == null) DeleteMaximizeBackup();
                CloseDuplicateGameViews();
                if (_revealDebug) Debug.Log("[RevealDBG] reveal: unmaximized " + maximized.GetType().Name);
                RestoreUserMaximized();
                RepaintAll();
            }
            catch (Exception e)
            {
                if (_revealDebug) Debug.LogWarning("[RevealDBG] reveal unmaximize failed: " + e.Message);
            }
            return;
        }
        HiddenLayoutOurs = false;
        Debug.LogWarning("[MCPTestBridge] maximize backup missing — rebuilding layout from saved preferences");
        RebuildLayoutSilently();
    }

    static void RestoreLayoutOnQuit()
    {
        if (!HiddenLayoutOurs) return;
        var maximized = FindMaximizedWindow();
        if (maximized == null) return;
        if (!MaximizeBackupExists()) return;
        try { maximized.maximized = false; } catch { }
    }

    static void HandleLeaveStage(int id, ControlClient from)
    {
        EditorApplication.delayCall += () =>
        {
            bool main;
            try
            {
                if (!(StageUtility.GetCurrentStage() is MainStage))
                {
                    Debug.Log("[MCPTestBridge] hiding the editor: leaving " + StageUtility.GetCurrentStage().GetType().Name);
                    StageUtility.GoToMainStage();
                }
                main = StageUtility.GetCurrentStage() is MainStage;
            }
            catch (Exception e)
            {
                CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":\"{CtrlEscape(e.Message)}\"}}");
                return;
            }
            if (!main) Debug.Log("[MCPTestBridge] hide canceled: the editor is still in " + StageUtility.GetCurrentStage().GetType().Name);
            CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"completed\",\"mainStage\":{(main ? "true" : "false")}}}");
        };
        SignalEditorTick();
    }

    static bool _lastShown;
    static bool _lastReady;
    static bool _lastRevealPresent;
    static double _lastRevealPoll = double.NegativeInfinity;

    const double REVEAL_POLL_INTERVAL = 0.2;

    static string ReadFileShared(string path)
    {
        using (var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite))
        using (var sr = new StreamReader(fs))
            return sr.ReadToEnd();
    }

    static bool RevealFileState(out bool shown, out bool ready)
    {
        double now = EditorApplication.timeSinceStartup;
        if (now - _lastRevealPoll >= REVEAL_POLL_INTERVAL)
        {
            _lastRevealPoll = now;
            try
            {
                if (!File.Exists(_revealFile))
                {
                    _lastShown = false;
                    _lastReady = false;
                    _lastRevealPresent = false;
                }
                else
                {
                    var text = ReadFileShared(_revealFile);
                    long want = ParseLongField(text, "\"want\"");
                    long epoch = ParseLongField(text, "\"epoch\"");
                    if (epoch >= 0) _revealEpoch = epoch;
                    _lastRevealPresent = want != 0;

                    _lastShown = false;
                    _lastReady = false;
                    if (_lastRevealPresent && !string.IsNullOrEmpty(_statusFile) && File.Exists(_statusFile))
                    {
                        try
                        {
                            var stext = ReadFileShared(_statusFile);
                            if (ParseLongField(stext, "\"epoch\"") == _revealEpoch)
                            {
                                _lastShown = stext.Contains("\"shown\":1");
                                _lastReady = stext.Contains("\"ready\":1");
                            }
                        }
                        catch { }
                    }
                }
            }
            catch
            {
                _lastRevealPresent = true;
            }
        }
        shown = _lastShown;
        ready = _lastReady;
        return _lastRevealPresent;
    }

    static bool RevealWanted()
    {
        ResolveRevealFile();
        if (string.IsNullOrEmpty(_revealFile)) return false;
        return RevealFileState(out _, out _);
    }

    static bool RevealNeedsLayoutReload() =>
        !EditorApplication.isPlaying && _revealRelayouts < REVEAL_MAX_RELAYOUTS
        && !AnyDockedEditorWindow() && FindMaximizedWindow() == null;

    static void StartRevealCycle(bool ready)
    {
        _revealCycleEpoch = _revealEpoch;
        _revealCycleStartedAt = EditorApplication.timeSinceStartup;
        _revealRelayouts = 0;
        _revealSettleTicks = 0;
        if (!HiddenLayoutOurs) SessionState.EraseString(SS_USER_MAXIMIZED);
        SetRevealState(ready ? RevealState.Revealed : RevealState.Showing, "reveal epoch " + _revealEpoch + (ready ? ", already shown" : ""));
    }

    static void WriteRevealStatus(bool shown, bool ready)
    {
        if (string.IsNullOrEmpty(_statusFile)) return;
        try
        {
            SspaceFolder.EnsureFor(_statusFile);
            File.WriteAllText(_statusFile,
                "{\"shown\":" + (shown ? 1 : 0) + ",\"ready\":" + (ready ? 1 : 0) +
                ",\"epoch\":" + _revealEpoch + "}");
        }
        catch (Exception e) { if (_revealDebug) Debug.LogWarning("[RevealDBG] write status failed: " + e.Message); }
    }

    static void WriteRevealReady()
    {
        WriteRevealStatus(true, true);
        _lastShown = true;
        _lastReady = true;
        _lastRevealPresent = true;
    }

    const double STANDALONE_RESTORE_POLL_INTERVAL = 0.5;
    static double _lastStandaloneRestorePoll = double.NegativeInfinity;
    static bool _standaloneRestoreDone;

    static bool ManagedProjectBreadcrumb()
    {
        try
        {
            return File.Exists(Path.Combine(SspaceRoot, ".winhook_reveal"))
                || File.Exists(HiddenLayoutMarker);
        }
        catch { return false; }
    }

    static void RestoreStandaloneHiddenLayout()
    {
        if (_standaloneRestoreDone) return;
        double now = EditorApplication.timeSinceStartup;
        if (now - _lastStandaloneRestorePoll < STANDALONE_RESTORE_POLL_INTERVAL) return;
        _lastStandaloneRestorePoll = now;
        if (EditorApplication.isCompiling || EditorApplication.isPlayingOrWillChangePlaymode) return;
        ResolveRevealReflection();
        if (!MainWindowExists()) return;
        var maximized = FindMaximizedWindow();
        if (maximized == null)
        {
            if (HiddenLayoutOurs) HiddenLayoutOurs = false;
            _standaloneRestoreDone = true;
            return;
        }
        if (!HiddenLayoutOurs && !ManagedProjectBreadcrumb())
        {
            _standaloneRestoreDone = true;
            return;
        }
        Debug.Log("[MCPTestBridge] standalone editor with leftover hidden layout — restoring");
        HiddenLayoutOurs = true;
        RestoreRevealedLayout();
        if (!HiddenLayoutOurs) _standaloneRestoreDone = true;
    }

    static void PumpRevealLayout()
    {
        ResolveRevealFile();
        if (string.IsNullOrEmpty(_revealFile))
        {
            RestoreStandaloneHiddenLayout();
            return;
        }

        ResolveRevealReflection();
        if (_miLoadDefaultWindowPreferences == null) return;

        bool want = RevealFileState(out bool shown, out bool ready);
        if (!want)
        {
            if (_revealState != RevealState.Hidden)
            {
                SetRevealState(RevealState.Hidden, "hide requested");
                _lastHiddenLayoutAttempt = double.NegativeInfinity;
            }
            PumpHiddenMinimalLayout();
            return;
        }

        if (_revealState == RevealState.Hidden || (_revealCycleEpoch != _revealEpoch && !ready)) StartRevealCycle(ready);
        else if (ready) _revealCycleEpoch = _revealEpoch;

        RestoreRevealedLayout();
        if (_revealState == RevealState.Revealed)
        {
            if (!ready) WriteRevealReady();
            return;
        }

        bool playing = EditorApplication.isPlaying;
        if (!playing)
            try { EditorApplication.QueuePlayerLoopUpdate(); } catch { }
        bool timedOut = EditorApplication.timeSinceStartup - _revealCycleStartedAt > REVEAL_WINDOW_TIMEOUT;

        if (_revealState == RevealState.Showing)
        {
            if (!timedOut && !(shown && MainWindowExists())) return;
            ForceDarkSkin();
            if (RevealNeedsLayoutReload())
            {
                _revealRelayouts++;
                if (_revealDebug) Debug.Log("[RevealDBG] no windows after reveal, reloading the layout, attempt " + _revealRelayouts);
                try { _miLoadDefaultWindowPreferences.Invoke(null, null); }
                catch (Exception e) { Debug.LogWarning("[MCPTestBridge] reveal layout failed: " + (e.InnerException ?? e).Message); }
                ForceDarkSkin();
            }
            RepaintAll();
            SetRevealState(RevealState.Settling, timedOut ? "the window wait timed out" : "the window is shown");
            return;
        }

        RepaintAll();
        if (++_revealSettleTicks < REVEAL_SETTLE_TICKS) return;
        if (RevealNeedsLayoutReload())
        {
            SetRevealState(RevealState.Showing, "no docked windows after the layout reload");
            return;
        }
        CloseDuplicateGameViews();
        WriteRevealReady();
        SetRevealState(RevealState.Revealed, "layout ready");
    }
}
