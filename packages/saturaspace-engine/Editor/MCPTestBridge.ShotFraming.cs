using System;
using System.Collections.Generic;
using UnityEngine;

public static partial class MCPTestBridge
{
    internal sealed class ShotScope
    {
        public readonly List<GameObject> Keep = new List<GameObject>();
        public readonly List<GameObject> Hide = new List<GameObject>();
    }

    static string ShotFind(string path, string what, out GameObject go)
    {
        go = TiFindObject((path ?? "").Trim(), null);
        return go != null ? null : "no object '" + path + "' to " + what + " in the open scenes; pass a full hierarchy path like 'Level/Player'";
    }

    static Bounds ShotBounds(GameObject go)
    {
        bool any = false;
        var b = new Bounds(go.transform.position, Vector3.zero);
        foreach (var r in go.GetComponentsInChildren<Renderer>())
        {
            if (!r.enabled || !r.gameObject.activeInHierarchy || r is ParticleSystemRenderer || r is TrailRenderer || r is LineRenderer) continue;
            if (any) b.Encapsulate(r.bounds);
            else b = r.bounds;
            any = true;
        }
        if (!any)
            foreach (var c in go.GetComponentsInChildren<Collider>())
            {
                if (!c.enabled || !c.gameObject.activeInHierarchy) continue;
                if (any) b.Encapsulate(c.bounds);
                else b = c.bounds;
                any = true;
            }
        return any ? b : new Bounds(go.transform.position, Vector3.one);
    }

    static string ShotFrame(string path, float yaw, float pitch, float distance, out Vector3 camPos, out Vector3 lookAt)
    {
        camPos = lookAt = Vector3.zero;
        var err = ShotFind(path, "frame", out var go);
        if (err != null) return err;
        var b = ShotBounds(go);
        var fwd = Vector3.ProjectOnPlane(go.transform.forward, Vector3.up);
        if (fwd.sqrMagnitude < 1e-6f) fwd = Vector3.forward;
        var flat = Quaternion.AngleAxis(yaw, Vector3.up) * fwd.normalized;
        float p = Mathf.Clamp(pitch, -89f, 89f) * Mathf.Deg2Rad;
        var dir = flat * Mathf.Cos(p) + Vector3.up * Mathf.Sin(p);
        float radius = Mathf.Max(b.extents.magnitude, 0.1f);
        float dist = distance > 0 ? distance : radius / Mathf.Sin(30f * Mathf.Deg2Rad) * 1.1f;
        lookAt = b.center;
        camPos = b.center + dir * dist;
        return null;
    }

    static bool ShotUnder(Transform t, List<GameObject> roots)
    {
        foreach (var r in roots)
            if (r != null && (t == r.transform || t.IsChildOf(r.transform))) return true;
        return false;
    }

    static Action ShotHide(ShotScope scope)
    {
        if (scope == null || (scope.Keep.Count == 0 && scope.Hide.Count == 0)) return null;
        var renderers = new HashSet<Renderer>();
        var terrains = new HashSet<Terrain>();
        if (scope.Keep.Count > 0)
        {
            foreach (var r in UnityEngine.Object.FindObjectsByType<Renderer>(FindObjectsInactive.Exclude, FindObjectsSortMode.None))
                if (!r.forceRenderingOff && !ShotUnder(r.transform, scope.Keep)) renderers.Add(r);
            foreach (var t in Terrain.activeTerrains)
                if (t != null && !ShotUnder(t.transform, scope.Keep)) terrains.Add(t);
        }
        foreach (var h in scope.Hide)
        {
            if (h == null) continue;
            foreach (var r in h.GetComponentsInChildren<Renderer>())
                if (!r.forceRenderingOff) renderers.Add(r);
            foreach (var t in h.GetComponentsInChildren<Terrain>()) terrains.Add(t);
        }
        var heightmaps = new Dictionary<Terrain, bool>();
        var foliage = new Dictionary<Terrain, bool>();
        foreach (var r in renderers) r.forceRenderingOff = true;
        foreach (var t in terrains)
        {
            heightmaps[t] = t.drawHeightmap;
            foliage[t] = t.drawTreesAndFoliage;
            t.drawHeightmap = false;
            t.drawTreesAndFoliage = false;
        }
        return () =>
        {
            foreach (var r in renderers)
                if (r != null) r.forceRenderingOff = false;
            foreach (var t in terrains)
            {
                if (t == null) continue;
                t.drawHeightmap = heightmaps[t];
                t.drawTreesAndFoliage = foliage[t];
            }
        };
    }

    static string ShotPlan(CmdArgs a, Vector3[] positions, Vector3[] targets, out ShotScope[] scopes)
    {
        scopes = null;
        int n = positions.Length;
        bool framed = a.frame != null && a.frame.Length > 0;
        bool scoped = (a.isolate != null && a.isolate.Length > 0) || (a.hide != null && a.hide.Length > 0);
        if (!framed && !scoped) return null;
        if (framed && a.frame.Length != n) return "expected one frame entry per pose, got " + a.frame.Length + " for " + n;
        if (framed && (a.view == null || a.view.Length != n * 3)) return "expected yaw, pitch and distance per framed pose";
        if (scoped) scopes = new ShotScope[n];
        for (int i = 0; i < n; i++)
        {
            string where = n > 1 ? "pose " + (i + 1) + ": " : "";
            if (framed && !string.IsNullOrEmpty(a.frame[i]))
            {
                var err = ShotFrame(a.frame[i], a.view[i * 3], a.view[i * 3 + 1], a.view[i * 3 + 2], out positions[i], out targets[i]);
                if (err != null) return where + err;
            }
            if (!scoped) continue;
            var scope = new ShotScope();
            foreach (var pair in new[] { (a.isolate, scope.Keep, "isolate"), (a.hide, scope.Hide, "hide") })
            {
                var list = pair.Item1;
                if (list == null || i >= list.Length || string.IsNullOrEmpty(list[i])) continue;
                foreach (var path in list[i].Split('\n'))
                {
                    if (path.Trim().Length == 0) continue;
                    var err = ShotFind(path, pair.Item3, out var go);
                    if (err != null) return where + err;
                    pair.Item2.Add(go);
                }
            }
            scopes[i] = scope;
        }
        return null;
    }
}
