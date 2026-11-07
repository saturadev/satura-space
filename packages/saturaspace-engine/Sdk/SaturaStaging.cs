using System;
using System.Collections.Generic;
using System.Linq;
using UnityEngine;

namespace SaturaSpace
{

[AttributeUsage(AttributeTargets.Method, AllowMultiple = false, Inherited = true)]
public sealed class SaturaScenarioAttribute : Attribute
{
    public string Description { get; }
    public bool Loop { get; set; }

    public SaturaScenarioAttribute(string description = "")
    {
        Description = description ?? "";
    }
}

public sealed class SaturaCheckException : Exception
{
    public SaturaCheckException(string message) : base(message) { }
}

[DefaultExecutionOrder(-32000)]
public abstract class SaturaStaging : MonoBehaviour
{
    static SaturaStaging _spawnTemplate;
    static Transform _templates;

    GameObject _template;
    internal bool Used;

    public string RunningScenario => SaturaHandles.RunningOn(this);

    protected virtual void Awake()
    {
        if (!Application.isPlaying) return;
        if (_spawnTemplate != null)
        {
            _template = _spawnTemplate._template;
            return;
        }
        if (_template != null) return;
        if (_templates == null || _templates.gameObject.scene != gameObject.scene)
        {
            var holder = new GameObject("[SaturaStaging templates]") { hideFlags = HideFlags.HideInHierarchy };
            holder.SetActive(false);
            if (gameObject.scene.IsValid()) UnityEngine.SceneManagement.SceneManager.MoveGameObjectToScene(holder, gameObject.scene);
            _templates = holder.transform;
        }
        var t = transform;
        _template = Instantiate(gameObject, _templates);
        _template.name = gameObject.name;
        _template.transform.localPosition = t.localPosition;
        _template.transform.localRotation = t.localRotation;
        _template.transform.localScale = t.localScale;
    }

    protected void Check(bool condition, string what)
    {
        var label = string.IsNullOrWhiteSpace(what) ? "check" : what.Trim();
        SaturaHandles.RecordCheck(this, label, condition);
        if (!condition) throw new SaturaCheckException(label);
        Debug.Log("check passed: " + label);
    }

    protected void Plot(string name, float value) => SaturaHandles.RecordPlot(this, name, value, float.NaN, float.NaN, false);

    protected void Plot(string name, float value, float min, float max) => SaturaHandles.RecordPlot(this, name, value, min, max, true);

    protected void Metric(string name, float value, string unit = "", float min = float.NegativeInfinity, float max = float.PositiveInfinity)
    {
        var label = string.IsNullOrWhiteSpace(name) ? "metric" : name.Trim();
        SaturaHandles.RecordMetric(this, label, value, unit, min, max);
        bool low = !float.IsNaN(min) && !float.IsNegativeInfinity(min);
        bool high = !float.IsNaN(max) && !float.IsPositiveInfinity(max);
        if (!low && !high) return;
        var u = string.IsNullOrWhiteSpace(unit) ? "" : " " + unit.Trim();
        var range = low && high ? Num(min) + "–" + Num(max) : low ? "at least " + Num(min) : "at most " + Num(max);
        Check((!low || value >= min) && (!high || value <= max), label + " " + Num(value) + u + ", allowed " + range + u);
    }

    protected void Track(Component target)
    {
        if (target != null) SaturaHandles.RecordTrack(this, target.transform);
    }

    protected void Track(GameObject target)
    {
        if (target != null) SaturaHandles.RecordTrack(this, target.transform);
    }

    protected void Step(string name) => SaturaHandles.RecordStep(this, name);

    protected void Snapshot(string name = "") => SaturaHandles.RecordSnapshot(this, name);

    static string Num(float v) => v.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);

    internal SaturaStaging Fresh(out string note)
    {
        note = null;
        GameObject made = null;
        if (_template != null)
        {
            _spawnTemplate = this;
            try { made = Instantiate(_template, transform.parent); }
            finally { _spawnTemplate = null; }
            var src = _template.transform;
            made.transform.localPosition = src.localPosition;
            made.transform.localRotation = src.localRotation;
            made.transform.localScale = src.localScale;
        }
        else
        {
            var asset = SourcePrefab();
            if (asset == null) return null;
            made = Instantiate(asset, transform.parent);
            made.transform.localPosition = transform.localPosition;
            made.transform.localRotation = transform.localRotation;
            made.transform.localScale = transform.localScale;
            note = name + " was reset from its prefab asset, without the scene's overrides: its staging script has its own Awake that doesn't call base.Awake()";
        }
        made.name = gameObject.name;
        made.transform.SetSiblingIndex(transform.GetSiblingIndex());
        var fresh = made.GetComponent(GetType()) as SaturaStaging;
        gameObject.SetActive(false);
        Destroy(gameObject);
        return fresh;
    }

    GameObject SourcePrefab()
    {
#if UNITY_EDITOR
        return UnityEditor.PrefabUtility.GetCorrespondingObjectFromOriginalSource(gameObject);
#else
        return null;
#endif
    }

    internal static List<SaturaStaging> LiveAll()
    {
        return UnityEngine.Object.FindObjectsByType<SaturaStaging>(FindObjectsInactive.Exclude, FindObjectsSortMode.None)
            .Where(s => s != null && s.gameObject.scene.IsValid() && s.gameObject.scene.isLoaded && (s.gameObject.hideFlags & HideFlags.HideInHierarchy) == 0)
            .OrderBy(s => s.gameObject.scene.path, StringComparer.Ordinal)
            .ThenBy(s => s.transform.GetSiblingIndex())
            .ToList();
    }

    internal static string PathOf(Transform t)
    {
        var parts = new List<string>();
        for (; t != null; t = t.parent) parts.Add(t.name);
        parts.Reverse();
        return string.Join("/", parts);
    }
}
}
