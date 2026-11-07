using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.AssetImporters;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    const string TI_PREVIEW_PREF = "SaturaTunerInspectorPreviewExpanded";
    const string TI_MULTI_EDIT_NOTE = "Components that are only on some of the selected objects cannot be multi-edited.";

    static MethodInfo s_TiSetLocked;
    static PropertyInfo s_TiFirstInspected;
    static MethodInfo s_TiHasLargeHeader;
    static MethodInfo s_TiHiddenInInspector;
    static bool s_TiTrackerLooked;

    static void TiLookTracker()
    {
        if (s_TiTrackerLooked) return;
        s_TiTrackerLooked = true;
        s_TiSetLocked = typeof(ActiveEditorTracker).GetMethod("SetObjectsLockedByThisTracker", TiInstance, null, new[] { typeof(List<Object>) }, null);
        s_TiFirstInspected = typeof(Editor).GetProperty("firstInspectedEditor", TiInstance);
        s_TiHasLargeHeader = typeof(Editor).GetMethod("HasLargeHeader", TiInstance, null, Type.EmptyTypes, null);
        s_TiHiddenInInspector = typeof(EditorUtility).GetMethod("IsHiddenInInspector", TiStatic, null, new[] { typeof(Editor) }, null);
    }

    static bool TiBuildTracked(TiSession s, List<Object> objs)
    {
        TiLookTracker();
        if (s_TiSetLocked == null) return false;
        var tracker = new ActiveEditorTracker();
        tracker.inspectorMode = InspectorMode.Normal;
        s_TiSetLocked.Invoke(tracker, new object[] { objs });
        tracker.isLocked = true;
        tracker.ForceRebuild();
        s.Tracker = tracker;
        TiSectionsFromEditors(s, tracker.activeEditors);
        tracker.ClearDirty();
        if (objs.Count > 1)
            SaturaDebug.Log("[tunerInspector] " + s.Id + " multi-object inspector over " + objs.Count + " objects: "
                + string.Join(", ", s.Sections.Where(x => x.Kind == "component").Select(x => x.Key)) + (tracker.hasComponentsWhichCannotBeMultiEdited ? " (some components left out)" : ""));
        return true;
    }

    static void TiDestroyTracker(TiSession s)
    {
        var t = s.Tracker;
        s.Tracker = null;
        s.TrackerEditors = null;
        if (t == null) return;
        try { t.Destroy(); }
        catch (Exception e) { Debug.LogWarning("[tunerInspector] tracker destroy failed: " + e.Message); }
    }

    static bool TiTrackerChanged(TiSession s)
    {
        var t = s.Tracker;
        if (t == null || !t.isDirty) return false;
        t.RebuildIfNecessary();
        var now = t.activeEditors;
        t.ClearDirty();
        var before = s.TrackerEditors;
        if (before == null || before.Length != now.Length) return true;
        for (int i = 0; i < now.Length; i++)
            if (!ReferenceEquals(before[i], now[i])) return true;
        return false;
    }

    static bool TiCulled(Editor[] editors, int i)
    {
        var ed = editors[i];
        if (ed == null) return true;
        var target = ed.target;
        try
        {
            if (s_TiHiddenInInspector != null && (bool)s_TiHiddenInInspector.Invoke(null, new object[] { ed })) return true;
        }
        catch
        {
        }
        if (target != null && (target.hideFlags & HideFlags.HideInInspector) != 0) return true;
        if (target is ParticleSystemRenderer) return true;
        if (target != null && target.GetType().Name == "VFXRenderer") return true;
        if (target != null && target.GetType() == typeof(AssetImporter)) return true;
        if (i != 0 && editors[0] is AssetImporterEditor importer && !importer.showImportedObject) return true;
        return false;
    }

    static bool TiLargeHeader(Editor ed, bool first)
    {
        if (first) return true;
        if (s_TiHasLargeHeader == null) return false;
        try { return (bool)s_TiHasLargeHeader.Invoke(ed, null); }
        catch { return false; }
    }

    static void TiSectionsFromEditors(TiSession s, Editor[] editors)
    {
        s.TrackerEditors = editors;
        int materials = 0;
        int assets = 0;
        bool firstDone = false;
        bool prevImporter = false;
        GameObject addTo = null;
        TiRemovedQueue removed = null;
        for (int i = 0; i < editors.Length; i++)
        {
            var ed = editors[i];
            if (ed == null || TiCulled(editors, i)) continue;
            var target = ed.target;
            if (target == null) continue;
            if (removed != null)
            {
                if (target is Component rc && rc.gameObject == removed.Go) TiRemovedBefore(s, removed, rc);
                else
                {
                    TiRemovedRest(s, removed);
                    removed = null;
                }
            }
            bool first = !firstDone;
            firstDone = true;
            if (first && s_TiFirstInspected != null)
            {
                try { s_TiFirstInspected.SetValue(ed, true); }
                catch { }
            }
            var sec = new TiSection
            {
                Editor = ed,
                Target = target,
                OwnsEditor = false,
                Title = ObjectNames.GetInspectorTitle(target),
                TypeName = target.GetType().FullName,
                LargeHeader = TiLargeHeader(ed, first),
                Expandable = true
            };
            bool body = true;
            if (target is GameObject go)
            {
                sec.Key = "GameObject";
                sec.Kind = "gameObject";
                sec.LargeHeader = true;
                body = false;
                if (!EditorUtility.IsPersistent(go)) addTo = go;
                if (s.Gos.Count <= 1) removed = TiRemovedFor(go);
            }
            else if (target is Component c)
            {
                sec.Key = TiComponentKey(c, c.gameObject);
                sec.Kind = "component";
                sec.LargeHeader = false;
            }
            else if (target is AssetImporter)
            {
                sec.Key = "importer";
                sec.Kind = "importer";
            }
            else if (target is Material && !first && !prevImporter)
            {
                sec.Key = materials == 0 ? "Material" : "Material#" + materials.ToString(TiInv);
                sec.Kind = "material";
                materials++;
            }
            else if (prevImporter)
            {
                sec.Key = "imported";
                sec.Kind = "imported";
                sec.ImportedLabel = true;
            }
            else
            {
                sec.Key = assets == 0 ? "asset" : "asset#" + assets.ToString(TiInv);
                sec.Kind = "asset";
                assets++;
            }
            sec.Expandable = !sec.LargeHeader;
            prevImporter = target is AssetImporter;
            TiAddSection(s, sec, body);
        }
        TiRemovedRest(s, removed);
        if (addTo != null) TiAddAddComponent(s, addTo);
        if (s.Gos.Count > 1 && s.Tracker != null && s.Tracker.hasComponentsWhichCannotBeMultiEdited)
            TiAddMessage(s, "multiEdit", TI_MULTI_EDIT_NOTE, MessageType.Info);
        TiAddPreview(s, editors);
    }

    static void TiAddMaterialSections(TiSession s, IEnumerable<Renderer> renderers)
    {
        int n = 0;
        var seen = new HashSet<Material>();
        foreach (var r in renderers)
        {
            if (r == null) continue;
            foreach (var m in r.sharedMaterials)
            {
                if (m == null || !seen.Add(m)) continue;
                var ed = Editor.CreateEditor(m);
                if (ed == null) continue;
                ed.hideFlags = HideFlags.HideAndDontSave;
                var sec = new TiSection
                {
                    Key = n == 0 ? "Material" : "Material#" + n.ToString(TiInv),
                    Kind = "material",
                    Editor = ed,
                    Target = m,
                    Title = ObjectNames.GetInspectorTitle(m),
                    TypeName = m.GetType().FullName,
                    LargeHeader = true,
                    Expandable = false
                };
                n++;
                TiAddSection(s, sec, true);
            }
        }
    }

    static FieldInfo s_TiMatStack;
    static FieldInfo s_TiMatProp;
    static FieldInfo s_TiMatSerialized;
    static FieldInfo s_TiMatTargets;
    static FieldInfo s_TiMatStartY;
    static FieldInfo s_TiMatPosition;
    static bool s_TiMatLooked;
    static readonly Dictionary<Material, Dictionary<string, string>> s_TiMatPaths = new Dictionary<Material, Dictionary<string, string>>();

    static void TiLookMaterialStack()
    {
        if (s_TiMatLooked) return;
        s_TiMatLooked = true;
        s_TiMatStack = typeof(MaterialProperty).GetField("s_PropertyStack", TiStatic);
        var data = typeof(MaterialProperty).GetNestedType("PropertyData", BindingFlags.NonPublic);
        if (data == null) return;
        s_TiMatProp = data.GetField("property", TiInstance);
        s_TiMatSerialized = data.GetField("serializedProperty", TiInstance);
        s_TiMatTargets = data.GetField("targets", TiInstance);
        s_TiMatStartY = data.GetField("startY", TiInstance);
        s_TiMatPosition = data.GetField("position", TiInstance);
    }

    static void TiRecordMaterialProperty()
    {
        if (!s_TiRecording) return;
        var sec = s_TiDispatchSection;
        if (sec == null || Event.current == null || Event.current.type != EventType.Repaint) return;
        try
        {
            TiLookMaterialStack();
            if (s_TiMatStack == null || s_TiMatTargets == null || s_TiMatPosition == null || s_TiMatStartY == null) return;
            var stack = s_TiMatStack.GetValue(null) as System.Collections.IList;
            if (stack == null || stack.Count == 0) return;
            var data = stack[stack.Count - 1];
            var targets = s_TiMatTargets.GetValue(data) as Object[];
            var mat = targets != null && targets.Length > 0 ? targets[0] as Material : null;
            if (mat == null) return;
            var rect = (Rect)s_TiMatPosition.GetValue(data);
            float startY = (float)s_TiMatStartY.GetValue(data);
            if (startY != -1f)
            {
                rect = GUILayoutUtility.GetLastRect();
                rect.yMin = startY;
                rect.x = 1f;
                rect.width = EditorGUIUtility.labelWidth;
            }
            if (rect == Rect.zero) return;
            var prop = s_TiMatProp != null ? s_TiMatProp.GetValue(data) as MaterialProperty : null;
            string path, kind = null, label = null;
            if (prop != null)
            {
                path = TiMaterialPath(mat, prop.name);
                kind = prop.propertyType.ToString();
                label = prop.displayName;
            }
            else
            {
                var ser = s_TiMatSerialized != null ? s_TiMatSerialized.GetValue(data) : null;
                path = ser != null ? TiMaterialSerializedPath(ser.ToString(), out kind, out label) : null;
            }
            if (path == null) return;
            sec.Props.Add(new TiPropRec { C = s_TiDispatchIndex, Path = path, Kind = kind, Label = label, R = s_TiUnclipRect(rect) });
        }
        catch
        {
        }
    }

    static string TiMaterialSerializedPath(string name, out string kind, out string label)
    {
        switch (name)
        {
            case "LightmapFlags":
                kind = "Enum";
                label = "Global Illumination";
                return "m_LightmapFlags";
            case "EnableInstancingVariants":
                kind = "Boolean";
                label = "Enable GPU Instancing";
                return "m_EnableInstancingVariants";
            case "DoubleSidedGI":
                kind = "Boolean";
                label = "Double Sided Global Illumination";
                return "m_DoubleSidedGI";
            case "CustomRenderQueue":
                kind = "Integer";
                label = "Render Queue";
                return "m_CustomRenderQueue";
        }
        kind = null;
        label = null;
        return null;
    }

    static string TiMaterialPath(Material mat, string name)
    {
        Dictionary<string, string> map;
        if (!s_TiMatPaths.TryGetValue(mat, out map))
        {
            map = new Dictionary<string, string>();
            using (var so = new SerializedObject(mat))
            {
                foreach (var list in new[] { "m_TexEnvs", "m_Ints", "m_Floats", "m_Colors" })
                {
                    var arr = so.FindProperty("m_SavedProperties." + list);
                    if (arr == null || !arr.isArray) continue;
                    for (int i = 0; i < arr.arraySize; i++)
                    {
                        var first = arr.GetArrayElementAtIndex(i).FindPropertyRelative("first");
                        if (first == null || first.propertyType != SerializedPropertyType.String || map.ContainsKey(first.stringValue)) continue;
                        map[first.stringValue] = arr.propertyPath + ".Array.data[" + i.ToString(TiInv) + "].second";
                    }
                }
            }
            s_TiMatPaths[mat] = map;
        }
        string path;
        return map.TryGetValue(name, out path) ? path : null;
    }

    static Editor TiPreviewEditor(Editor[] editors)
    {
        if (editors == null || editors.Length == 0 || editors[0] == null) return null;
        var root = editors[0].target;
        if (root == null) return null;
        var rootPath = AssetDatabase.GetAssetPath(root);
        bool rootPersistent = EditorUtility.IsPersistent(root);
        for (int i = 0; i < editors.Length; i++)
        {
            var e = editors[i];
            if (e == null || e.target == null) continue;
            if (EditorUtility.IsPersistent(e.target) && AssetDatabase.GetAssetPath(e.target) != rootPath) continue;
            if (!rootPersistent && EditorUtility.IsPersistent(e.target)) continue;
            if (TiCulled(editors, i)) continue;
            if (editors[0] is AssetImporterEditor && !(e is AssetImporterEditor)) continue;
            bool has;
            try { has = e.HasPreviewGUI(); }
            catch { has = false; }
            if (has) return e;
        }
        return null;
    }

    static void TiAddPreview(TiSession s, Editor[] editors)
    {
        var ed = TiPreviewEditor(editors);
        if (ed == null) return;
        var sec = new TiSection { Key = "preview", Kind = "preview", Editor = ed, Target = ed.target, OwnsEditor = false, Expandable = true };
        var el = new VisualElement();
        el.name = "Preview";
        el.style.flexShrink = 0;
        var c = new IMGUIContainer(() => TiPreviewGUI(s, sec));
        c.name = "PreviewArea";
        el.Add(c);
        sec.Element = el;
        sec.Header = c;
        try
        {
            var title = ed.GetPreviewTitle();
            sec.Title = title != null && !string.IsNullOrEmpty(title.text) ? title.text : "Preview";
        }
        catch
        {
            sec.Title = "Preview";
        }
        s.Root.Add(el);
        s.Sections.Add(sec);
    }

    static void TiPreviewGUI(TiSession s, TiSection sec)
    {
        var ed = sec.Editor;
        if (ed == null || ed.target == null) return;
        var tint = GUI.color;
        TiResetGUIState();
        GUI.color = tint;
        bool expanded = EditorPrefs.GetBool(TI_PREVIEW_PREF, true);
        GUIContent title;
        try { title = ed.GetPreviewTitle(); }
        catch { title = null; }
        if (title == null || string.IsNullOrEmpty(title.text)) title = EditorGUIUtility.TrTextContent("Preview");
        bool has;
        try { has = ed.HasPreviewGUI(); }
        catch { has = false; }
        var bar = EditorGUILayout.BeginHorizontal((GUIStyle)"preToolbar", GUILayout.Height(21f));
        var titleRect = GUILayoutUtility.GetRect(title, (GUIStyle)"preToolbar2", GUILayout.ExpandWidth(false));
        GUI.Label(titleRect, title, (GUIStyle)"preToolbar2");
        var grab = GUILayoutUtility.GetRect(GUIContent.none, GUIStyle.none, GUILayout.ExpandWidth(true), GUILayout.Height(21f));
        if (expanded && has)
        {
            try { ed.OnPreviewSettings(); }
            catch (Exception e)
            {
                if (!TiIsExitGui(e) && s.LoggedErrors.Add("previewSettings:" + e.Message)) Debug.LogException(e);
            }
        }
        EditorGUILayout.EndHorizontal();
        var toggle = Rect.MinMaxRect(bar.xMin, bar.yMin, Mathf.Max(titleRect.xMax, grab.xMax), bar.yMax);
        var evt = Event.current;
        if (evt.type == EventType.MouseDown && evt.button == 0 && toggle.Contains(evt.mousePosition))
        {
            EditorPrefs.SetBool(TI_PREVIEW_PREF, !expanded);
            evt.Use();
            TiMarkDirty(s);
            return;
        }
        if (!expanded) return;
        float h = Mathf.Clamp(s.Width * 0.62f, 140f, 380f);
        GUILayout.BeginVertical((GUIStyle)"preBackground", GUILayout.Height(h));
        var area = GUILayoutUtility.GetRect(0f, 10240f, 64f, 10240f);
        if (!has) GUI.Label(area, "No preview", EditorStyles.centeredGreyMiniLabel);
        else if (!float.IsNaN(area.width) && !float.IsNaN(area.height) && !TiPscPreviewGUI(s, sec, ed, area))
        {
            try { ed.DrawPreview(area); }
            catch (Exception e)
            {
                if (!TiIsExitGui(e) && s.LoggedErrors.Add("preview:" + e.Message)) Debug.LogException(e);
            }
        }
        GUILayout.EndVertical();
    }

    static void TiImportedLabel()
    {
        var style = new GUIStyle("IN BigTitle")
        {
            font = EditorStyles.label.font,
            fontSize = EditorStyles.label.fontSize,
            alignment = TextAnchor.UpperLeft
        };
        var r = GUILayoutUtility.GetRect(16f, 20f);
        r.height = 21f;
        GUI.Label(r, "Imported Object", style);
        GUILayout.Space(-7f);
    }

    static Dictionary<Object, int> TiAssetDirtyCounts(TiSession s)
    {
        var map = new Dictionary<Object, int>();
        foreach (var sec in s.Sections)
        {
            var t = sec.Target;
            if (t == null || t is AssetImporter || !EditorUtility.IsPersistent(t) || map.ContainsKey(t)) continue;
            map[t] = EditorUtility.GetDirtyCount(t);
        }
        return map;
    }

    static void TiSaveDirtyAssets(TiSession s, Dictionary<Object, int> before)
    {
        foreach (var sec in s.Sections)
        {
            var t = sec.Target;
            if (t == null || t is AssetImporter || !EditorUtility.IsPersistent(t)) continue;
            if (!EditorUtility.IsDirty(t)) continue;
            if (!EditorApplication.isPlaying)
            {
                if (!before.TryGetValue(t, out var n) || n != EditorUtility.GetDirtyCount(t)) NoteTunerAssetEdit(t);
                continue;
            }
            try { AssetDatabase.SaveAssetIfDirty(t); }
            catch (Exception e) { Debug.LogWarning("[tunerInspector] could not save " + t.name + ": " + e.Message); }
        }
    }

    static Func<object, Object> s_TiIdToObject;
    static bool s_TiIdLooked;

    static Object TiObjectFromId(object id)
    {
        if (!s_TiIdLooked)
        {
            s_TiIdLooked = true;
            var t = id != null ? id.GetType() : null;
            MethodInfo m = null;
            if (t != null)
                m = typeof(EditorUtility).GetMethods(TiStatic).FirstOrDefault(x =>
                    (x.Name == "EntityIdToObject" || x.Name == "InstanceIDToObject") && x.GetParameters().Length == 1 && x.GetParameters()[0].ParameterType == t);
            if (m != null) s_TiIdToObject = o => m.Invoke(null, new[] { o }) as Object;
        }
        if (s_TiIdToObject == null || id == null) return null;
        try { return s_TiIdToObject(id); }
        catch { return null; }
    }

    static bool TiRecordOpen(Object obj)
    {
        var s = s_TiDispatch;
        if (s == null || obj == null) return false;
        if (obj is Component c) obj = c.gameObject;
        var sb = new StringBuilder();
        var go = obj as GameObject;
        if (go != null && !EditorUtility.IsPersistent(go))
        {
            TiStr(sb.Append("{\"kind\":\"object\",\"path\":"), TiObjectPath(go));
            if (go.scene.IsValid() && !string.IsNullOrEmpty(TunerSceneKey(go.scene))) TiStr(sb.Append(",\"scene\":"), TunerSceneKey(go.scene));
            sb.Append('}');
        }
        else
        {
            var path = AssetDatabase.GetAssetPath(obj);
            if (string.IsNullOrEmpty(path)) return true;
            TiStr(sb.Append("{\"kind\":\"asset\",\"path\":"), path);
            sb.Append('}');
        }
        s.Opens.Add(sb.ToString());
        TiMarkDirty(s);
        SaturaDebug.Log("[tunerInspector] open " + sb);
        return true;
    }

    static string TiPrefabAssetPath(Object obj)
    {
        if (obj is Component c) obj = c.gameObject;
        var go = obj as GameObject;
        if (go == null || !EditorUtility.IsPersistent(go)) return null;
        var path = AssetDatabase.GetAssetPath(go);
        return !string.IsNullOrEmpty(path) && path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) ? path : null;
    }

    static string TiScriptOpenJson(Object obj)
    {
        var path = obj != null && EditorUtility.IsPersistent(obj) ? AssetDatabase.GetAssetPath(obj) : null;
        if (string.IsNullOrEmpty(path) || !path.EndsWith(".cs", StringComparison.OrdinalIgnoreCase)) return null;
        string file;
        try { file = System.IO.Path.GetFullPath(path).Replace('\\', '/'); }
        catch { return null; }
        var sb = new StringBuilder();
        TiStr(sb.Append("{\"kind\":\"script\",\"path\":"), path);
        TiStr(sb.Append(",\"file\":"), file);
        return sb.Append('}').ToString();
    }

    static bool TiCatchOpenAsset(object id)
    {
        if (s_TiDispatch == null) return TunerPopupUitkCatch(() => TiCatchOpenAsset(id), () => TunerUitkCatchOpen(TiObjectFromId(id)));
        var obj = TiObjectFromId(id);
        var script = TiScriptOpenJson(obj);
        if (script != null)
        {
            s_TiDispatch.Opens.Add(script);
            TiMarkDirty(s_TiDispatch);
            SaturaDebug.Log("[tunerInspector] open " + script);
            return true;
        }
        var prefab = TiPrefabAssetPath(obj);
        if (prefab != null) return TiCatchOpenPrefab(prefab);
        TiRecordOpen(obj);
        return true;
    }

    static bool TiCatchOpenPrefab(string path)
    {
        var s = s_TiDispatch;
        if (s == null) return TunerPopupUitkCatch(() => TiCatchOpenPrefab(path), () => TunerUitkCatchOpenAsset(path));
        if (string.IsNullOrEmpty(path)) return true;
        var sb = new StringBuilder();
        TiStr(sb.Append("{\"kind\":\"prefab\",\"path\":"), path);
        sb.Append('}');
        s.Opens.Add(sb.ToString());
        TiMarkDirty(s);
        SaturaDebug.Log("[tunerInspector] open " + sb);
        return true;
    }

    static bool TiCatchSelection(Object[] objects)
    {
        if (s_TiDispatch == null) return TunerPopupUitkCatch(() => TiCatchSelection(objects), () => TunerUitkCatchSelect(objects != null && objects.Length > 0 ? objects[0] : null));
        if (objects != null && objects.Length > 0) TiRecordOpen(objects[0]);
        return true;
    }

    static void TiOpensJson(StringBuilder sb, TiSession s)
    {
        if (s.Opens.Count == 0) return;
        sb.Append(",\"opens\":[");
        for (int i = 0; i < s.Opens.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(s.Opens[i]);
        }
        sb.Append(']');
    }

    static bool TiCatchPing(Object obj)
    {
        if (s_TiDispatch == null) return TunerPopupUitkCatch(() => TiCatchPing(obj), () => false);
        var s = s_TiDispatch;
        if (obj is Component c) obj = c.gameObject;
        var go = obj as GameObject;
        if (go == null || EditorUtility.IsPersistent(go) || !go.scene.IsValid())
        {
            var assetPath = obj != null ? AssetDatabase.GetAssetPath(obj) : null;
            if (string.IsNullOrEmpty(assetPath) || !(assetPath.StartsWith("Assets/") || assetPath.StartsWith("Packages/")))
            {
                if (obj != null) SaturaDebug.Log("[tunerInspector] ping of asset " + obj.name + " ignored");
                return true;
            }
            var asb = new StringBuilder();
            TiStr(asb.Append("{\"kind\":\"asset\",\"path\":"), assetPath);
            asb.Append('}');
            var ajson = asb.ToString();
            if (!s.Pings.Contains(ajson)) s.Pings.Add(ajson);
            TiMarkDirty(s);
            SaturaDebug.Log("[tunerInspector] ping " + ajson);
            return true;
        }
        var sb = new StringBuilder();
        TiStr(sb.Append("{\"kind\":\"object\",\"path\":"), TiObjectPath(go));
        if (!string.IsNullOrEmpty(TunerSceneKey(go.scene))) TiStr(sb.Append(",\"scene\":"), TunerSceneKey(go.scene));
        sb.Append('}');
        var json = sb.ToString();
        if (!s.Pings.Contains(json)) s.Pings.Add(json);
        TiMarkDirty(s);
        SaturaDebug.Log("[tunerInspector] ping " + json);
        return true;
    }

    static bool TiCatchPingId(object id)
    {
        if (s_TiDispatch == null && s_TunerUitkDispatchRoot == null) return false;
        return TiCatchPing(TiObjectFromId(id));
    }

    static void TiPingsJson(StringBuilder sb, TiSession s)
    {
        if (s.Pings.Count == 0) return;
        sb.Append(",\"pings\":[");
        for (int i = 0; i < s.Pings.Count; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(s.Pings[i]);
        }
        sb.Append(']');
    }
}
