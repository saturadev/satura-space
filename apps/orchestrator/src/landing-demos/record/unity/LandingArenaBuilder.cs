using System.Text;
using UnityEditor;
using UnityEditor.Animations;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

public static class LandingArenaBuilder
{
    public const string ScenePath = "Assets/Scenes/LandingArena.unity";
    const string Root = "Assets/SaturaLanding";
    const string Mats = Root + "/Materials";
    const string Anim = Root + "/Anim";

    static void Folder(string parent, string name)
    {
        if (!AssetDatabase.IsValidFolder(parent + "/" + name)) AssetDatabase.CreateFolder(parent, name);
    }

    static Material Lit(string name, Color c, float smooth, float metal = 0f, Color? emission = null)
    {
        var path = Mats + "/" + name + ".mat";
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null)
        {
            m = new Material(Shader.Find("Universal Render Pipeline/Lit"));
            AssetDatabase.CreateAsset(m, path);
        }
        m.SetColor("_BaseColor", c);
        m.SetFloat("_Smoothness", smooth);
        m.SetFloat("_Metallic", metal);
        if (emission.HasValue)
        {
            m.EnableKeyword("_EMISSION");
            m.SetColor("_EmissionColor", emission.Value);
            m.globalIlluminationFlags = MaterialGlobalIlluminationFlags.RealtimeEmissive;
        }
        EditorUtility.SetDirty(m);
        return m;
    }

    static Material ParticleMat(string name, bool additive)
    {
        var path = Mats + "/" + name + ".mat";
        var m = AssetDatabase.LoadAssetAtPath<Material>(path);
        if (m == null)
        {
            m = new Material(Shader.Find("Universal Render Pipeline/Particles/Unlit"));
            AssetDatabase.CreateAsset(m, path);
        }
        m.SetFloat("_Surface", 1f);
        m.SetFloat("_Blend", additive ? 2f : 0f);
        m.SetColor("_BaseColor", Color.white);
        m.renderQueue = (int)RenderQueue.Transparent;
        EditorUtility.SetDirty(m);
        return m;
    }

    static GameObject Empty(string name, Transform parent, Vector3 pos, Vector3 euler = default)
    {
        var go = new GameObject(name);
        go.transform.SetParent(parent, false);
        go.transform.localPosition = pos;
        go.transform.localEulerAngles = euler;
        return go;
    }

    static GameObject Prim(PrimitiveType type, string name, Transform parent, Vector3 pos, Vector3 scale, Material mat, Vector3 euler = default, bool keepCollider = true)
    {
        var go = GameObject.CreatePrimitive(type);
        go.name = name;
        go.transform.SetParent(parent, false);
        go.transform.localPosition = pos;
        go.transform.localEulerAngles = euler;
        go.transform.localScale = scale;
        go.GetComponent<MeshRenderer>().sharedMaterial = mat;
        if (!keepCollider) Object.DestroyImmediate(go.GetComponent<Collider>());
        return go;
    }

    static Light PointLight(GameObject go, Color c, float intensity, float range)
    {
        var l = go.AddComponent<Light>();
        l.type = LightType.Point;
        l.color = c;
        l.intensity = intensity;
        l.range = range;
        l.shadows = LightShadows.None;
        return l;
    }

    static Gradient Fade(Color a, Color b)
    {
        var g = new Gradient();
        g.SetKeys(
            new[] { new GradientColorKey(a, 0f), new GradientColorKey(b, 1f) },
            new[] { new GradientAlphaKey(0f, 0f), new GradientAlphaKey(0.9f, 0.25f), new GradientAlphaKey(0.6f, 0.7f), new GradientAlphaKey(0f, 1f) });
        return g;
    }

    static ParticleSystem Motes(GameObject go, Material mat)
    {
        var ps = go.AddComponent<ParticleSystem>();
        var main = ps.main;
        main.duration = 8f;
        main.loop = true;
        main.prewarm = true;
        main.startLifetime = 6f;
        main.startSpeed = 0.45f;
        main.startSize = 0.09f;
        main.startColor = new Color(0.7f, 0.88f, 1f);
        main.gravityModifier = -0.004f;
        main.simulationSpace = ParticleSystemSimulationSpace.World;
        main.maxParticles = 1000;
        var em = ps.emission;
        em.rateOverTime = 14f;
        var sh = ps.shape;
        sh.enabled = true;
        sh.shapeType = ParticleSystemShapeType.Cone;
        sh.angle = 8f;
        sh.radius = 0.85f;
        var col = ps.colorOverLifetime;
        col.enabled = true;
        col.color = Fade(new Color(1f, 1f, 1f), new Color(1f, 1f, 1f));
        var sol = ps.sizeOverLifetime;
        sol.enabled = true;
        sol.size = new ParticleSystem.MinMaxCurve(1f, AnimationCurve.EaseInOut(0f, 0.6f, 1f, 1.2f));
        var noise = ps.noise;
        noise.enabled = true;
        noise.strength = 0.12f;
        noise.frequency = 0.35f;
        var r = go.GetComponent<ParticleSystemRenderer>();
        r.renderMode = ParticleSystemRenderMode.Billboard;
        r.sharedMaterial = mat;
        return ps;
    }

    static Mesh TileGrid(int nx, int nz, float size, float gap)
    {
        var path = Root + "/TileGrid.asset";
        var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(path);
        if (mesh == null)
        {
            mesh = new Mesh();
            AssetDatabase.CreateAsset(mesh, path);
        }
        mesh.Clear();
        mesh.name = "TileGrid";
        var v = new System.Collections.Generic.List<Vector3>();
        var n = new System.Collections.Generic.List<Vector3>();
        var t = new System.Collections.Generic.List<int>();
        var h = (size - gap) * 0.5f;
        for (var i = 0; i < nx; i++)
            for (var j = 0; j < nz; j++)
            {
                var cx = (i - (nx - 1) * 0.5f) * size;
                var cz = (j - (nz - 1) * 0.5f) * size;
                var b = v.Count;
                v.Add(new Vector3(cx - h, 0f, cz - h));
                v.Add(new Vector3(cx - h, 0f, cz + h));
                v.Add(new Vector3(cx + h, 0f, cz + h));
                v.Add(new Vector3(cx + h, 0f, cz - h));
                for (var k = 0; k < 4; k++) n.Add(Vector3.up);
                t.AddRange(new[] { b, b + 1, b + 2, b, b + 2, b + 3 });
            }
        mesh.SetVertices(v);
        mesh.SetNormals(n);
        mesh.SetTriangles(t, 0);
        mesh.RecalculateBounds();
        EditorUtility.SetDirty(mesh);
        return mesh;
    }

    static Mesh StatueMesh(string name)
    {
        var path = Root + "/" + name + ".asset";
        var mesh = AssetDatabase.LoadAssetAtPath<Mesh>(path);
        if (mesh == null)
        {
            mesh = new Mesh();
            AssetDatabase.CreateAsset(mesh, path);
        }
        mesh.Clear();
        mesh.name = name;
        var b = System.IO.File.ReadAllBytes(Root + "/Statues/" + name + ".bytes");
        var nv = System.BitConverter.ToInt32(b, 0);
        var nt = System.BitConverter.ToInt32(b, 4);
        var mn = new Vector3(System.BitConverter.ToSingle(b, 8), System.BitConverter.ToSingle(b, 12), System.BitConverter.ToSingle(b, 16));
        var mx = new Vector3(System.BitConverter.ToSingle(b, 20), System.BitConverter.ToSingle(b, 24), System.BitConverter.ToSingle(b, 28));
        var span = (mx - mn) / 65535f;
        var v = new Vector3[nv];
        var o = 32;
        for (var i = 0; i < nv; i++, o += 6)
            v[i] = mn + Vector3.Scale(span, new Vector3(System.BitConverter.ToUInt16(b, o), System.BitConverter.ToUInt16(b, o + 2), System.BitConverter.ToUInt16(b, o + 4)));
        var t = new int[nt * 3];
        for (var i = 0; i < t.Length; i++, o += 2) t[i] = System.BitConverter.ToUInt16(b, o);
        mesh.vertices = v;
        mesh.triangles = t;
        mesh.RecalculateNormals();
        mesh.RecalculateBounds();
        EditorUtility.SetDirty(mesh);
        return mesh;
    }

    static void Niche(string name, Transform walls, float x, Material sage, Material marble, Material plaster, Material voidMat, string figure, float yaw, Vector3 head)
    {
        var niche = Empty(name, walls, new Vector3(x, 0f, 4.96f));
        Prim(PrimitiveType.Cube, "Recess", niche.transform, new Vector3(0f, 1.55f, 0f), new Vector3(1.4f, 2.3f, 0.04f), voidMat, default, false);
        Prim(PrimitiveType.Cylinder, "Arch", niche.transform, new Vector3(0f, 2.7f, 0f), new Vector3(1.4f, 0.02f, 1.4f), voidMat, new Vector3(90f, 0f, 0f), false);
        Prim(PrimitiveType.Cube, "Sill", niche.transform, new Vector3(0f, 0.4f, -0.02f), new Vector3(1.46f, 0.05f, 0.06f), sage, default, false);
        var lamp = Empty("Lamp", niche.transform, new Vector3(0f, 2.55f, -0.7f));
        PointLight(lamp, new Color(0.62f, 0.78f, 1f), 1.4f, 3.2f);
        var ped = Prim(PrimitiveType.Cube, "Pedestal", niche.transform, new Vector3(0f, 0.42f, -0.34f), new Vector3(0.56f, 0.84f, 0.56f), plaster);
        ped.isStatic = true;
        var statue = Empty("Statue", niche.transform, new Vector3(0f, 0.84f, -0.34f), new Vector3(0f, yaw, 0f));
        var cc = statue.AddComponent<CapsuleCollider>();
        cc.center = new Vector3(0f, 0.66f, 0f);
        cc.radius = 0.2f;
        cc.height = 1.32f;
        var body = Empty("Mesh", statue.transform, Vector3.zero);
        body.AddComponent<MeshFilter>().sharedMesh = StatueMesh(figure);
        body.AddComponent<MeshRenderer>().sharedMaterial = marble;
        var hd = Empty("Head", statue.transform, head);
        hd.AddComponent<SphereCollider>().radius = 0.1f;
    }

    public static string Build()
    {
        Folder("Assets", "SaturaLanding");
        Folder(Root, "Materials");
        Folder(Root, "Anim");
        Folder("Assets", "Scenes");
        var plaster = Lit("Plaster", new Color(0.95f, 0.955f, 0.96f), 0.2f);
        var seam = Lit("Seam", new Color(0.16f, 0.17f, 0.2f), 0.3f);
        var tile = Lit("LitTile", new Color(0.97f, 0.98f, 1f), 0.55f, 0f, new Color(0.86f, 0.9f, 0.98f));
        var sage = Lit("Sage", new Color(0.6f, 0.65f, 0.47f), 0.1f);
        var voidMat = Lit("Void", new Color(0.02f, 0.025f, 0.05f), 0.9f);
        var marble = Lit("Marble", new Color(0.95f, 0.945f, 0.92f), 0.3f);
        var obsidian = Lit("Obsidian", new Color(0.015f, 0.016f, 0.018f), 0.7f);
        var motesMat = ParticleMat("Motes", true);

        var scene = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Single);
        RenderSettings.ambientMode = AmbientMode.Trilight;
        RenderSettings.skybox = null;
        RenderSettings.ambientSkyColor = new Color(0.42f, 0.46f, 0.6f);
        RenderSettings.ambientEquatorColor = new Color(0.36f, 0.38f, 0.46f);
        RenderSettings.ambientGroundColor = new Color(0.6f, 0.64f, 0.72f);

        var cam = GameObject.Find("Main Camera");
        cam.transform.position = new Vector3(0f, 2.2f, -8.6f);
        cam.transform.rotation = Quaternion.LookRotation(new Vector3(0f, 1.7f, 1.2f) - cam.transform.position);
        var cc = cam.GetComponent<Camera>();
        cc.clearFlags = CameraClearFlags.SolidColor;
        cc.backgroundColor = new Color(0.008f, 0.01f, 0.025f);
        cc.fieldOfView = 50f;

        var lights = new GameObject("Lights");
        var sun = GameObject.Find("Directional Light");
        sun.name = "Skylight";
        sun.transform.SetParent(lights.transform, true);
        sun.transform.rotation = Quaternion.Euler(64f, 18f, 0f);
        var sl = sun.GetComponent<Light>();
        sl.color = new Color(0.98f, 1f, 0.97f);
        sl.intensity = 0.7f;
        sl.shadows = LightShadows.Soft;
        sl.shadowStrength = 0.45f;
        var glow = Empty("Floor Glow", lights.transform, new Vector3(0f, 0.25f, -2.6f));
        PointLight(glow, new Color(0.86f, 0.92f, 1f), 1.2f, 9f);

        var room = new GameObject("Room");
        var grid = Empty("FloorGrid", room.transform, Vector3.zero);
        var floor = Prim(PrimitiveType.Cube, "Floor", grid.transform, new Vector3(0f, -0.2f, -1f), new Vector3(10f, 0.4f, 12f), seam);
        floor.isStatic = true;
        var tiles = Empty("Tiles", grid.transform, new Vector3(0f, 0.004f, -1f));
        tiles.AddComponent<MeshFilter>().sharedMesh = TileGrid(10, 12, 1f, 0.05f);
        var tr = tiles.AddComponent<MeshRenderer>();
        tr.sharedMaterial = tile;
        tr.shadowCastingMode = ShadowCastingMode.Off;
        tiles.isStatic = true;

        var walls = Empty("Walls", room.transform, Vector3.zero);
        Prim(PrimitiveType.Cube, "Back", walls.transform, new Vector3(0f, 2.25f, 5.25f), new Vector3(10f, 4.5f, 0.5f), plaster).isStatic = true;
        Prim(PrimitiveType.Cube, "Trim", walls.transform, new Vector3(0f, 0.06f, 4.98f), new Vector3(10f, 0.12f, 0.06f), sage, default, false);
        Niche("Niche L", walls.transform, -2.7f, sage, marble, plaster, voidMat, "Venus", -12f, new Vector3(-0.109f, 1.341f, -0.101f));
        Niche("Niche R", walls.transform, 2.7f, sage, marble, plaster, voidMat, "Apollo", 12f, new Vector3(-0.075f, 1.335f, -0.173f));

        var mono = new GameObject("Monolith");
        mono.transform.position = new Vector3(0f, 0f, 1.2f);
        Prim(PrimitiveType.Cube, "Slab", mono.transform, new Vector3(0f, 1.98f, 0f), new Vector3(1.76f, 3.96f, 0.44f), obsidian);
        var motes = Empty("Motes", mono.transform, new Vector3(0f, 0.05f, -1.05f), new Vector3(-90f, 0f, 0f));
        Motes(motes, motesMat);

        var ctrl = BuildAnimation(mono);
        EditorSceneManager.MarkSceneDirty(scene);
        EditorSceneManager.SaveScene(scene, ScenePath);
        AssetDatabase.SaveAssets();
        return "saved " + scene.path + " roots=" + scene.rootCount + " controller=" + (ctrl != null ? ctrl.name : "none");
    }

    static AnimationClip Clip(string name, float fps)
    {
        var path = Anim + "/" + name + ".anim";
        var fresh = new AnimationClip { frameRate = fps };
        var st = AnimationUtility.GetAnimationClipSettings(fresh);
        st.loopTime = true;
        AnimationUtility.SetAnimationClipSettings(fresh, st);
        var clip = AssetDatabase.LoadAssetAtPath<AnimationClip>(path);
        if (clip == null)
        {
            AssetDatabase.CreateAsset(fresh, path);
            return fresh;
        }
        fresh.name = clip.name;
        EditorUtility.CopySerialized(fresh, clip);
        Object.DestroyImmediate(fresh);
        EditorUtility.SetDirty(clip);
        return clip;
    }

    static AnimatorController BuildAnimation(GameObject mono)
    {
        var hover = Clip("MonolithHover", 30f);
        var arrive = Clip("MonolithArrival", 30f);
        var path = Anim + "/Monolith.controller";
        AssetDatabase.DeleteAsset(Anim + "/Turret.controller");
        AssetDatabase.DeleteAsset(Anim + "/TurretScan.anim");
        AssetDatabase.DeleteAsset(Anim + "/TurretFire.anim");
        AssetDatabase.DeleteAsset(path);
        var ctrl = AnimatorController.CreateAnimatorControllerAtPath(path);
        var sm = ctrl.layers[0].stateMachine;
        var s1 = sm.AddState("Hover");
        s1.motion = hover;
        var s2 = sm.AddState("Arrival");
        s2.motion = arrive;
        sm.defaultState = s1;
        var an = mono.AddComponent<Animator>();
        an.runtimeAnimatorController = ctrl;
        return ctrl;
    }

    static SaturaSpace.ClipKey K(string prop, int frame, float v, string tangent, string path)
    {
        var k = SaturaSpace.SaturaClips.Key(prop, frame, v).On(path, "Transform");
        return tangent.Length > 0 ? k.Tangent(tangent) : k;
    }

    static void Keys(StringBuilder report, string clip, params SaturaSpace.ClipKey[] keys)
    {
        try
        {
            SaturaSpace.SaturaClips.SetKeys("Monolith", clip, keys);
            report.Append(clip).Append(' ').Append(keys.Length).Append(" keys; ");
        }
        catch (SaturaSpace.SaturaClipException e) { report.Append(clip).Append(" FAILED ").Append(e.Message).Append("; "); }
    }

    public static string Keyframes()
    {
        EditorSceneManager.OpenScene(ScenePath);
        const string S = "Slab";
        var report = new StringBuilder();
        Keys(report, "MonolithHover",
            K("position.y", 0, 1.98f, "easeInOut", S), K("position.y", 120, 2.18f, "easeInOut", S), K("position.y", 240, 1.98f, "easeInOut", S),
            K("rotation.y", 0, 0f, "linear", S), K("rotation.y", 240, 180f, "linear", S));
        Keys(report, "MonolithArrival",
            K("position.y", 0, -2.1f, "easeOut", S), K("position.y", 150, 1.98f, "easeOut", S), K("position.y", 180, 1.98f, "", S),
            K("scale.x", 0, 0.9f, "easeOut", S), K("scale.x", 150, 1.76f, "easeOut", S), K("scale.x", 180, 1.76f, "", S));
        AssetDatabase.SaveAssets();
        EditorSceneManager.SaveScene(UnityEngine.SceneManagement.SceneManager.GetActiveScene());
        return report.ToString();
    }
}
