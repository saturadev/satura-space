using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.Search;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    sealed class TunerSearchPicker
    {
        public string Key;
        public SearchViewState State;
        public SearchContext Context;
        public Type Type;
        public bool Custom;
        public bool AllowScene;
        public bool SawScene;
        public Object Current;
        public string Providers;
        public TunerSearchRun LastRun;
        public double LastRunAt;
        public readonly Dictionary<Object, SearchItem> Items = new Dictionary<Object, SearchItem>();
    }

    sealed class TunerSearchRun
    {
        public TunerSearchPicker Picker;
        public string Search;
        public SearchContext Context;
        public ISearchList Results;
        public IEnumerator<SearchItem> Items;
        public Func<SearchItem, bool> Filter;
        public bool Truncated;
        public bool Superseded;
        public readonly Stopwatch Clock = Stopwatch.StartNew();
        public readonly List<KeyValuePair<Object, SearchItem>> Found = new List<KeyValuePair<Object, SearchItem>>();
        public readonly HashSet<Object> Seen = new HashSet<Object>();
        public readonly List<Action<TunerSearchRun>> Waiters = new List<Action<TunerSearchRun>>();
    }

    const double TUNER_SEARCH_STEP_MS = 12.0;
    static readonly List<TunerSearchRun> s_TunerSearchRuns = new List<TunerSearchRun>();
    static bool s_TunerSearchPumping;

    const int TUNER_SEARCH_PICKERS_KEPT = 4;
    static readonly string[] s_TunerSearchObjectProviders = { "asset", "adb", "scene", "find" };
    static readonly List<TunerSearchPicker> s_TunerSearchPickers = new List<TunerSearchPicker>();
    static readonly PropertyInfo s_TunerSearchSelectedIds = typeof(SearchViewState).GetProperty("selectedIds", TunerPopupAny);
    static readonly PropertyInfo s_TunerSearchFilterHandler = typeof(SearchViewState).GetProperty("filterHandler", TunerPopupAny);
    static readonly PropertyInfo s_TunerSearchFilterType = typeof(SearchContext).GetProperty("filterType", TunerPopupAny);
    static readonly PropertyInfo s_TunerSearchRuntimeContext = typeof(SearchContext).GetProperty("runtimeContext", TunerPopupAny);
    static readonly FieldInfo s_TunerSearchDelegateWindow = typeof(SearchService).Assembly.GetType("UnityEditor.Search.ObjectFieldGUI")?.GetField("s_DelegateWindow", BindingFlags.Static | BindingFlags.NonPublic);
    static int s_TunerSearchPickerSeq;
    static SearchProvider s_TunerSearchPickProvider;

    static bool TunerPopupSearchPickerPrefix(SearchViewState args)
    {
        if (args == null || args.context == null) return true;
        if (TunerPopupImguiActive) return !TunerPopupOpenSearch(args);
        if (s_TunerUitkDispatchRoot != null) return !TunerPopupOpenSearchUitk(args);
        return true;
    }

    static TunerSearchPicker TunerSearchPickerBegin(SearchViewState state)
    {
        var ctx = state.context;
        Type type = null;
        try { type = s_TunerSearchFilterType?.GetValue(ctx) as Type; }
        catch { }
        var ids = new List<string>();
        try
        {
            foreach (var p in ctx.providers)
                if (p != null) ids.Add(p.id);
        }
        catch { }
        var sp = new TunerSearchPicker
        {
            Key = "search" + (++s_TunerSearchPickerSeq).ToString(TunerPopupInv),
            State = state,
            Context = ctx,
            Type = type ?? typeof(Object),
            Current = TunerSearchPickerCurrent(state),
            Custom = ids.Count == 0 || ids.Any(id => Array.IndexOf(s_TunerSearchObjectProviders, id) < 0),
            Providers = string.Join(",", ids)
        };
        bool sceneType = typeof(Component).IsAssignableFrom(sp.Type) || sp.Type == typeof(GameObject) || sp.Type == typeof(Object);
        sp.AllowScene = sceneType && (sp.Custom || ids.Contains("scene"));
        s_TunerSearchPickers.Add(sp);
        while (s_TunerSearchPickers.Count > TUNER_SEARCH_PICKERS_KEPT) s_TunerSearchPickers.RemoveAt(0);
        return sp;
    }

    static TunerSearchPicker TunerSearchPickerFind(string key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        foreach (var sp in s_TunerSearchPickers)
            if (sp.Key == key) return sp;
        return null;
    }

    static Object TunerSearchPickerCurrent(SearchViewState state)
    {
        try
        {
            var ids = s_TunerSearchSelectedIds?.GetValue(state) as Array;
            if (ids == null || ids.Length == 0) return null;
            return TiObjectFromId(ids.GetValue(0));
        }
        catch { return null; }
    }

    static void TunerSearchPickerRun(TunerSearchPicker sp, string search, Action<TunerSearchRun> done)
    {
        search = search ?? "";
        var now = EditorApplication.timeSinceStartup;
        if (sp.LastRun != null && sp.LastRun.Search == search && now - sp.LastRunAt < TUNER_POPUP_CACHE_S)
        {
            done(sp.LastRun);
            return;
        }
        foreach (var r in s_TunerSearchRuns)
            if (r.Picker == sp && r.Search == search)
            {
                r.Waiters.Add(done);
                return;
            }
        for (int i = s_TunerSearchRuns.Count - 1; i >= 0; i--)
            if (s_TunerSearchRuns[i].Picker == sp)
            {
                s_TunerSearchRuns[i].Superseded = true;
                TunerSearchFinish(s_TunerSearchRuns[i]);
            }
        var run = new TunerSearchRun { Picker = sp, Search = search };
        run.Waiters.Add(done);
        try { run.Filter = s_TunerSearchFilterHandler?.GetValue(sp.State) as Func<SearchItem, bool>; }
        catch { }
        try
        {
            var ctx = new SearchContext(sp.Context.providers, search, sp.Context.options & ~SearchFlags.Synchronous);
            run.Context = ctx;
            try { s_TunerSearchFilterType?.SetValue(ctx, s_TunerSearchFilterType.GetValue(sp.Context)); }
            catch { }
            try { s_TunerSearchRuntimeContext?.SetValue(ctx, s_TunerSearchRuntimeContext.GetValue(sp.Context)); }
            catch { }
            run.Results = SearchService.Request(ctx);
            run.Items = run.Results.GetEnumerator();
        }
        catch (Exception e)
        {
            Debug.LogWarning("[tunerPopup] search picker " + sp.Key + " could not list " + sp.Providers + ": " + e.Message);
            TunerSearchFinish(run);
            return;
        }
        s_TunerSearchRuns.Add(run);
        if (TunerSearchStep(run))
        {
            TunerSearchFinish(run);
            return;
        }
        if (!s_TunerSearchPumping)
        {
            s_TunerSearchPumping = true;
            EditorApplication.update += TunerSearchPump;
        }
    }

    static void TunerSearchPump()
    {
        if (s_TunerSearchRuns.Count == 0)
        {
            s_TunerSearchPumping = false;
            EditorApplication.update -= TunerSearchPump;
            return;
        }
        NoteTunerActivity();
        var runs = s_TunerSearchRuns.ToArray();
        foreach (var run in runs)
            if (TunerSearchStep(run)) TunerSearchFinish(run);
    }

    static bool TunerSearchStep(TunerSearchRun run)
    {
        var sp = run.Picker;
        var budget = Stopwatch.StartNew();
        try
        {
            while (budget.Elapsed.TotalMilliseconds < TUNER_SEARCH_STEP_MS)
            {
                if (run.Found.Count >= TUNER_POPUP_MAX_CANDIDATES || run.Clock.Elapsed.TotalSeconds > TUNER_POPUP_LIST_BUDGET_S)
                {
                    run.Truncated = true;
                    return true;
                }
                if (!run.Items.MoveNext()) return true;
                var item = run.Items.Current;
                if (item == null)
                {
                    if (run.Context.searchInProgress) return false;
                    continue;
                }
                if (run.Filter != null)
                {
                    bool keep;
                    try { keep = run.Filter(item); }
                    catch { keep = true; }
                    if (!keep) continue;
                }
                Object o = null;
                try { o = item.ToObject(sp.Type); }
                catch { }
                if (o == null || !sp.Type.IsInstanceOfType(o) || !run.Seen.Add(o)) continue;
                if (string.IsNullOrEmpty(item.label))
                {
                    try { item.label = item.GetLabel(run.Context, true); }
                    catch { }
                }
                sp.Items[o] = item;
                run.Found.Add(new KeyValuePair<Object, SearchItem>(o, item));
            }
            return false;
        }
        catch (Exception e)
        {
            Debug.LogWarning("[tunerPopup] search picker " + sp.Key + " could not list " + sp.Providers + ": " + e.Message);
            return true;
        }
    }

    static void TunerSearchFinish(TunerSearchRun run)
    {
        s_TunerSearchRuns.Remove(run);
        try { run.Items?.Dispose(); }
        catch { }
        try { run.Results?.Dispose(); }
        catch { }
        try { run.Context?.Dispose(); }
        catch { }
        run.Items = null;
        run.Results = null;
        run.Context = null;
        if (run.Superseded) run.Truncated = true;
        else
        {
            run.Picker.LastRun = run;
            run.Picker.LastRunAt = EditorApplication.timeSinceStartup;
            SaturaDebug.Log("[tunerPopup] search picker " + run.Picker.Key + " listed " + run.Found.Count + " in " + run.Clock.ElapsedMilliseconds + " ms" + (run.Truncated ? " (truncated)" : ""));
        }
        foreach (var w in run.Waiters)
        {
            try { w(run); }
            catch (Exception e) { Debug.LogException(e); }
        }
        run.Waiters.Clear();
    }

    static void TunerSearchPickerCandidates(TunerSearchPicker sp, bool scene, string search, Action<List<TunerPopupCandidate>, bool> done)
    {
        TunerSearchPickerRun(sp, search, run =>
        {
            if (!sp.SawScene) sp.SawScene = run.Found.Exists(kv => kv.Key != null && !EditorUtility.IsPersistent(kv.Key));
            var list = new List<TunerPopupCandidate>();
            foreach (var kv in run.Found)
            {
                var o = kv.Key;
                if (o == null || EditorUtility.IsPersistent(o) == scene) continue;
                var label = string.IsNullOrEmpty(kv.Value.label) ? o.name : kv.Value.label;
                if (!scene)
                {
                    var c = new TunerPopupCandidate { Name = label, TypeName = o.GetType().Name, Path = AssetDatabase.GetAssetPath(o), Obj = o };
                    if (AssetDatabase.TryGetGUIDAndLocalFileIdentifier(o, out var guid, out long lid))
                    {
                        c.Guid = guid;
                        if (!AssetDatabase.IsMainAsset(o))
                        {
                            c.LocalId = lid.ToString(TunerPopupInv);
                            c.Sub = true;
                        }
                    }
                    list.Add(c);
                    continue;
                }
                var go = o as GameObject ?? (o as Component)?.gameObject;
                if (go == null) continue;
                list.Add(new TunerPopupCandidate
                {
                    Name = label,
                    TypeName = o.GetType().Name,
                    ScenePath = TunerUitkHierarchyPath(go.transform),
                    Scene = go.scene.path,
                    Component = o is Component ? o.GetType().Name : null,
                    Obj = o
                });
            }
            done(list, run.Truncated);
        });
    }

    static SearchItem TunerSearchPickerItem(TunerSearchPicker sp, Object o)
    {
        if (o == null) return null;
        if (sp.Items.TryGetValue(o, out var item)) return item;
        if (s_TunerSearchPickProvider == null)
            s_TunerSearchPickProvider = new SearchProvider("satura.tuner.pick", "Satura Tuner") { toObject = (i, t) => i.data as Object };
        return new SearchItem(o.GetHashCode().ToString(TunerPopupInv)) { provider = s_TunerSearchPickProvider, data = o, label = o.name };
    }

    static void TunerSearchPickerTrack(TunerSearchPicker sp, Object o)
    {
        sp.State.trackingHandler?.Invoke(TunerSearchPickerItem(sp, o));
    }

    static void TunerSearchPickerSelect(TunerSearchPicker sp, Object o, bool canceled)
    {
        sp.State.selectHandler?.Invoke(TunerSearchPickerItem(sp, o), canceled);
    }

    static string TunerSearchPickerJson(TunerSearchPicker sp, string extra)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"type\":").Append(TunerUitkStr(sp.Type.FullName));
        sb.Append(",\"typeName\":").Append(TunerUitkStr(sp.Type.Name));
        sb.Append(",\"allowSceneObjects\":").Append(sp.AllowScene ? "true" : "false");
        sb.Append(",\"current\":").Append(TunerPopupObjectRefJson(sp.Current));
        if (sp.Current != null) sb.Append(",\"currentName\":").Append(TunerUitkStr(sp.Current.name));
        if (sp.Custom) sb.Append(",\"context\":").Append(TunerUitkStr(sp.Key));
        sb.Append(extra ?? "").Append('}');
        return sb.ToString();
    }

    static Object TunerSearchPickerResolve(TunerSearchPicker sp, string raw, out string error)
    {
        error = null;
        var trimmed = (raw ?? "null").Trim();
        if (trimmed == "null" || trimmed.Length == 0) return null;
        var picked = TunerUitkResolveObject(TunerPopupParseObjectRef(trimmed), sp.Type);
        if (picked == null) error = "could not find that object";
        else if (!sp.AllowScene && !EditorUtility.IsPersistent(picked)) error = "this field only takes assets";
        return picked;
    }

    static bool TunerPopupOpenSearch(SearchViewState state)
    {
        var sp = TunerSearchPickerBegin(state);
        try { s_TunerSearchDelegateWindow?.SetValue(null, null); }
        catch { }
        var current = sp.Current;
        var st = new TunerPopupSession { Original = current, ObjectType = sp.Type, AllowScene = sp.AllowScene };
        void Push(TunerPopup p, Object o, bool close)
        {
            TunerPopupDeliver(p, "SearchPickerUpdated", () => TunerSearchPickerTrack(sp, o));
            if (close) TunerPopupDeliver(p, "SearchPickerClosed", () => TunerSearchPickerSelect(sp, o, false));
        }
        var popup = TunerInspectorAddPopup("object", TunerPopupMouseRect(), false, TunerSearchPickerJson(sp, null), st, (p, action, raw) =>
        {
            var picked = TunerSearchPickerResolve(sp, raw, out var error);
            if (error != null) return error;
            TunerPopupBeginChange(st);
            Push(p, picked, action == "commit");
            TunerPopupEndChange(st);
            if (action == "commit") st.Committed = true;
            return null;
        }, p =>
        {
            if (st.Committed) return;
            try
            {
                if (st.Touched) Push(p, current, true);
                else TunerPopupDeliver(p, "SearchPickerClosed", () => TunerSearchPickerSelect(sp, current, true));
                TunerPopupEndChange(st);
            }
            catch (Exception e)
            {
                if (!TiIsExitGui(e)) Debug.LogWarning("[tunerPopup] could not restore the search picker value: " + e.Message);
            }
        });
        if (popup != null) SaturaDebug.Log("[tunerPopup] search picker " + sp.Key + " for " + sp.Type.Name + " (" + sp.Providers + (sp.Custom ? ", listed by its providers" : ", listed by type") + ") hosted as object popup " + popup.Id);
        return popup != null;
    }

    static bool TunerPopupOpenSearchUitk(SearchViewState state)
    {
        var root = s_TunerUitkDispatchRoot;
        if (root == null || root.panel == null) return false;
        var owner = root.panel.Pick(s_TunerUitkLastPointer);
        if (owner == null || TunerUitkRootOf(owner, out _) != root) owner = root;
        var field = owner;
        for (var e = owner; e != null; e = e.hierarchy.parent)
        {
            if (e.GetType().FullName != "UnityEditor.Search.ObjectField") continue;
            field = e;
            break;
        }
        var sp = TunerSearchPickerBegin(state);
        var touched = false;
        var anchor = field != root ? TunerUitkFieldAnchor(field) : new Rect(s_TunerUitkLastPointer, Vector2.one);
        var popup = TunerUitkSetPopup(field, "object", anchor, TunerSearchPickerJson(sp, TunerUitkPropertyJson(field)), (action, raw) =>
        {
            if (action == "cancel")
            {
                if (touched) TunerSearchPickerTrack(sp, sp.Current);
                TunerSearchPickerSelect(sp, sp.Current, true);
                return null;
            }
            var picked = TunerSearchPickerResolve(sp, raw, out var error);
            if (error != null) return error;
            touched = true;
            Undo.IncrementCurrentGroup();
            TunerSearchPickerTrack(sp, picked);
            if (action == "commit") TunerSearchPickerSelect(sp, picked, false);
            return null;
        });
        if (popup != null) SaturaDebug.Log("[tunerPopup] search picker " + sp.Key + " for " + sp.Type.Name + " (" + sp.Providers + ") hosted as UI Toolkit object popup " + popup.Id);
        return popup != null;
    }
}
