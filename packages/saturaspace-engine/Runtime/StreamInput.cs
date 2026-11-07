#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Reflection;
using UnityEditor;
using UnityEditorInternal;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;
#endif

public class StreamInput : IDisposable
{
    [Serializable]
    class Ev
    {
        public string k;
        public string c;
        public string s;
        public float x; public float y;
        public float dx; public float dy;
        public float wx; public float wy;
        public int b; public int n; public int r; public int m; public int v;
        public double t;
    }

    [Serializable]
    class Msg
    {
        public int v;
        public string sid;
        public double now;
        public Ev[] ev;
        public string[] keys;
        public float mx; public float my; public int btn;
        public float dx; public float dy; public int locked;
        public float sx; public float sy;
        public int focus;
        public long useq;
        public int nr;
        public int bye;
        public int hp; public float px; public float py;
        public int ha; public double ax; public double ay; public double aw;
        public string[] pb;
        public int hpad; public float lx; public float ly; public float rx; public float ry; public float lt; public float rt;
    }

    class Owner
    {
        public readonly HashSet<string> keys = new HashSet<string>();
        public int btn;
        public bool phone;
        public uint pad;
        public float lt, rt;
        public Vector2 ls, rs;
        public long useq;
        public bool acc;
        public double ax, ay, aw;
    }

    readonly Dictionary<string, Owner> owners = new Dictionary<string, Owner>();
    string sender = "";
    bool forcing;

    Owner Own(string sid)
    {
        sid = sid ?? "";
        if (!owners.TryGetValue(sid, out var o)) owners[sid] = o = new Owner();
        return o;
    }

    bool OtherOwnsKey(string name, Owner me)
    {
        foreach (var kv in owners)
            if (kv.Value != me && kv.Value.keys.Contains(name)) return true;
        return false;
    }

    bool OtherOwnsBtn(int bit, Owner me)
    {
        foreach (var kv in owners)
            if (kv.Value != me && (kv.Value.btn & bit) != 0) return true;
        return false;
    }

    const int ModShift = 1, ModCtrl = 2, ModAlt = 4, ModMeta = 8, ModCaps = 16;

    public static Vector2 GameMousePosition { get; private set; }
    static bool driving;

    public static void ApplyRepaintMouse(int skinMode)
    {
        if (!driving || skinMode != 0 || !Application.isPlaying) return;
        var e = Event.current;
        if (e != null && e.type == EventType.Repaint) e.mousePosition = GameMousePosition;
    }

    readonly int rtW, rtH;

    public StreamInput(int w, int h, bool startSuspended = false)
    {
        rtW = w; rtH = h;
        pos = new Vector2(w * 0.5f, h * 0.5f);
        GameMousePosition = pos;
        suspended = startSuspended;
        driving = !startSuspended;
#if ENABLE_INPUT_SYSTEM
        PurgeTagged();
        kb = InputSystem.AddDevice<Keyboard>(KeyboardName);
        mouse = InputSystem.AddDevice<Mouse>(MouseName);
        InputSystem.EnableDevice(kb);
        InputSystem.EnableDevice(mouse);
        devicePos = new Vector2(w * 0.5f, h * 0.5f);
        if (!startSuspended)
        {
            TakeOver();
            kb.MakeCurrent();
            mouse.MakeCurrent();
            InputSystem.QueueStateEvent(kb, new KeyboardState());
            InputSystem.QueueStateEvent(mouse, new MouseState { position = devicePos });
        }
#endif
    }

    bool suspended;
    bool focusKnown;

    public void SetSuspended(bool value)
    {
        if (value == suspended) return;
        if (value) ReleaseAll(-1);
        suspended = value;
        driving = !value;
#if ENABLE_INPUT_SYSTEM
        if (suspended) HandBack();
        else TakeOver();
        if (suspended)
        {
            foreach (var d in InputSystem.devices)
                if (d is Keyboard k && k.native && k.added) { k.MakeCurrent(); break; }
            foreach (var d in InputSystem.devices)
                if (d is Mouse nm && nm.native && nm.added) { nm.MakeCurrent(); break; }
        }
        else
        {
            if (kb != null && kb.added) kb.MakeCurrent();
            if (mouse != null && mouse.added) mouse.MakeCurrent();
        }
#endif
    }

    public void EnsureNativeCurrent()
    {
#if ENABLE_INPUT_SYSTEM
        if (!suspended) return;
        if (Keyboard.current == null || Keyboard.current == kb)
            foreach (var d in InputSystem.devices)
                if (d is Keyboard k && k.native && k.added) { k.MakeCurrent(); break; }
        if (Mouse.current == null || Mouse.current == mouse)
            foreach (var d in InputSystem.devices)
                if (d is Mouse nm && nm.native && nm.added) { nm.MakeCurrent(); break; }
#endif
    }

    const float SenderTimeout = 1.5f;
    readonly Dictionary<string, KeyValuePair<bool, float>> senders = new Dictionary<string, KeyValuePair<bool, float>>();
    readonly List<string> staleSenders = new List<string>();

    void NoteSender(string sid, bool focused)
    {
        senders[sid] = new KeyValuePair<bool, float>(focused, Time.realtimeSinceStartup);
    }

    bool AnySenderFocused()
    {
        float now = Time.realtimeSinceStartup;
        bool any = false;
        staleSenders.Clear();
        foreach (var kv in senders)
        {
            if (now - kv.Value.Value > SenderTimeout) { staleSenders.Add(kv.Key); continue; }
            if (kv.Value.Key) any = true;
        }
        for (int i = 0; i < staleSenders.Count; i++)
        {
            senders.Remove(staleSenders[i]);
            if (owners.TryGetValue(staleSenders[i], out var o) && o.phone)
            {
                Debug.Log($"[StreamInput] phone sender {staleSenders[i]} went quiet, releasing {o.keys.Count} keys, buttons {o.btn}, pad {o.pad}");
                ReleaseOwner(staleSenders[i]);
            }
        }
        return any;
    }

    public void SyncFocus()
    {
        if (suspended || !Application.isPlaying) return;
        bool want = !focusKnown || AnySenderFocused();
        if (Application.isFocused != want) InternalEditorUtility.OnGameViewFocus(want);
    }

    public void Apply(string json, double ageSeconds)
    {
        if (suspended) return;
        Msg m = null;
        try { m = JsonUtility.FromJson<Msg>(json); } catch { }
        if (m == null) return;
        if (m.keys == null) m.keys = Array.Empty<string>();
        double nowIs = InputNow();

        if (m.v >= 3)
        {
            ApplyPhone(m, nowIs, ageSeconds);
            return;
        }

        sender = m.v >= 2 ? m.sid ?? "" : "";
        if (m.v >= 2)
        {
            focusKnown = true;
            NoteSender(m.sid ?? "", m.focus != 0);
            bool hasEvents = m.ev != null && m.ev.Length > 0;
            if (m.focus == 0 && !hasEvents) return;
            locked = m.locked != 0;
            if (hasEvents)
            {
                for (int i = 0; i < m.ev.Length; i++)
                {
                    var e = m.ev[i];
                    if (e == null || string.IsNullOrEmpty(e.k)) continue;
                    double time = nowIs - ageSeconds - Math.Max(0.0, (m.now - e.t) / 1000.0);
                    Handle(e, time);
                }
            }
            if (m.focus != 0) Reconcile(m.keys, m.btn, -1);
            return;
        }

        focusKnown = false;
        locked = m.locked != 0;
        int mods = LegacyMods(m.keys);
        if (m.locked != 0)
        {
            if (m.dx != 0f || m.dy != 0f) Move(0.5f, 0.5f, m.dx, m.dy, mods, -1);
        }
        else if (m.mx != lastMx || m.my != lastMy || m.dx != 0f || m.dy != 0f)
        {
            Move(m.mx, m.my, m.dx, m.dy, mods, -1);
        }
        lastMx = m.mx; lastMy = m.my;
        Reconcile(m.keys, m.btn, -1);
        if (m.sx != 0f || m.sy != 0f) Wheel(m.sx, m.sy, mods, -1);
    }

    float lastMx = -1f, lastMy = -1f;

    void ApplyPhone(Msg m, double nowIs, double ageSeconds)
    {
        focusKnown = true;
        string sid = string.IsNullOrEmpty(m.sid) ? "phone" : m.sid;
        if (m.bye != 0)
        {
            if (owners.ContainsKey(sid)) Debug.Log($"[StreamInput] phone sender {sid} left, releasing what it held");
            ReleaseOwner(sid);
            senders.Remove(sid);
            return;
        }
        NoteSender(sid, m.focus != 0);
        var o = Own(sid);
        o.phone = true;
        sender = sid;
        locked = Cursor.lockState == CursorLockMode.Locked;
        try
        {
            if (m.ev != null)
            {
                for (int i = 0; i < m.ev.Length; i++)
                {
                    var e = m.ev[i];
                    if (e == null || string.IsNullOrEmpty(e.k)) continue;
                    double time = nowIs - ageSeconds - Math.Max(0.0, (m.now - e.t) / 1000.0);
                    Handle(e, time);
                }
            }
            if (m.nr == 0)
            {
                Reconcile(m.keys, m.btn, -1);
                ReconcilePad(o, m.pb);
                if (m.ha != 0 && !o.acc) { o.ax = m.ax; o.ay = m.ay; o.aw = m.aw; o.acc = true; }
                return;
            }
            if (m.useq <= o.useq) return;
            o.useq = m.useq;
            if (m.ha != 0)
            {
                if (!o.acc) { o.ax = m.ax; o.ay = m.ay; o.aw = m.aw; o.acc = true; }
                float dx = (float)(m.ax - o.ax), dy = (float)(m.ay - o.ay), dw = (float)(m.aw - o.aw);
                o.ax = m.ax; o.ay = m.ay; o.aw = m.aw;
                if (m.hp != 0 || dx != 0f || dy != 0f)
                {
                    float x = m.hp != 0 ? m.px : pos.x / ScreenW();
                    float y = m.hp != 0 ? m.py : pos.y / ScreenH();
                    Move(x, y, dx, dy, 0, -1);
                }
                if (dw != 0f) Wheel(0f, dw, 0, -1);
            }
            else if (m.hp != 0)
            {
                Move(m.px, m.py, 0f, 0f, 0, -1);
            }
#if ENABLE_INPUT_SYSTEM
            if (m.hpad != 0)
            {
                o.ls = Vector2.ClampMagnitude(new Vector2(m.lx, m.ly), 1f);
                o.rs = Vector2.ClampMagnitude(new Vector2(m.rx, m.ry), 1f);
                QueuePad(-1);
            }
#endif
        }
        finally
        {
            sender = "";
        }
    }

    void ReconcilePad(Owner o, string[] names)
    {
#if ENABLE_INPUT_SYSTEM
        uint bits = 0;
        float lt = 0f, rt = 0f;
        if (names != null)
        {
            for (int i = 0; i < names.Length; i++)
            {
                var n = names[i];
                if (string.IsNullOrEmpty(n)) continue;
                if (n == "LeftTrigger") { lt = 1f; continue; }
                if (n == "RightTrigger") { rt = 1f; continue; }
                if (n == "LeftStickPress") n = "LeftStick";
                else if (n == "RightStickPress") n = "RightStick";
                if (Enum.TryParse(n, false, out GamepadButton gb) && (int)gb < 32) bits |= 1u << (int)gb;
            }
        }
        if (bits == o.pad && lt == o.lt && rt == o.rt) return;
        o.pad = bits; o.lt = lt; o.rt = rt;
        QueuePad(-1);
#endif
    }

    void ReleaseOwner(string sid)
    {
        if (!owners.TryGetValue(sid, out var o)) return;
        string prev = sender;
        sender = sid;
        try
        {
            released.Clear();
            released.AddRange(o.keys);
            for (int i = 0; i < released.Count; i++) KeyUp(released[i], 0, -1);
            for (int b = 0; b < 5; b++)
                if ((o.btn & (1 << b)) != 0) MouseButton(false, b, pos.x / ScreenW(), pos.y / ScreenH(), 1, 0, -1);
#if ENABLE_INPUT_SYSTEM
            bool hadPad = o.pad != 0 || o.lt != 0f || o.rt != 0f || o.ls != Vector2.zero || o.rs != Vector2.zero;
            o.pad = 0; o.lt = 0f; o.rt = 0f; o.ls = Vector2.zero; o.rs = Vector2.zero;
            if (hadPad) QueuePad(-1);
#endif
        }
        finally
        {
            sender = prev;
            owners.Remove(sid);
        }
    }

    public string Describe()
    {
        var sb = new System.Text.StringBuilder();
        sb.Append("held=[").Append(string.Join(",", held)).Append("] btn=").Append(heldBtn).Append(" owners={");
        foreach (var kv in owners)
            sb.Append(kv.Key).Append(kv.Value.phone ? "(phone)" : "").Append(":[").Append(string.Join(",", kv.Value.keys)).Append("] btn=").Append(kv.Value.btn)
                .Append(" pad=").Append(kv.Value.pad).Append(" ls=").Append(kv.Value.ls).Append(" rs=").Append(kv.Value.rs).Append("; ");
        sb.Append('}');
        return sb.ToString();
    }

    void Handle(Ev e, double time)
    {
        switch (e.k)
        {
            case "kd": KeyDown(e.c, e.r != 0, e.m, time); break;
            case "ku": KeyUp(e.c, e.m, time); break;
            case "tx": Text(e.s, e.m, time); break;
            case "md": MouseButton(true, e.b, e.x, e.y, e.n, e.m, time); break;
            case "mu": MouseButton(false, e.b, e.x, e.y, e.n, e.m, time); break;
            case "mm": Move(e.x, e.y, e.dx, e.dy, e.m, time); break;
            case "wh":
                {
                    float nx = e.wx != 0f ? -e.wx / 120f : e.dx / 120f;
                    float ny = e.wy != 0f ? e.wy / 120f : -e.dy / 120f;
                    if (!locked) SetPosition(e.x, e.y);
                    Wheel(nx, ny, e.m, time);
                    break;
                }
            case "fo":
                break;
        }
    }

    void Reconcile(string[] keys, int btn, double time)
    {
        var me = Own(sender);
        released.Clear();
        foreach (var k in me.keys)
            if (Array.IndexOf(keys, k) < 0) released.Add(k);
        int mods = LegacyMods(keys);
        for (int i = 0; i < released.Count; i++) KeyUp(released[i], mods, time);
        for (int i = 0; i < keys.Length; i++)
            if (!string.IsNullOrEmpty(keys[i]) && !me.keys.Contains(keys[i])) KeyDown(keys[i], false, mods, time);
        suppressedBtn &= btn;
        int changed = (btn & ~suppressedBtn) ^ me.btn;
        for (int b = 0; b < 5; b++)
        {
            int bit = 1 << b;
            if ((changed & bit) == 0) continue;
            float x = pos.x / ScreenW(), y = pos.y / ScreenH();
            MouseButton((btn & bit) != 0, b, x, y, 1, mods, time);
        }
    }

    void ReleaseAll(double time)
    {
        forcing = true;
        try
        {
            released.Clear();
            released.AddRange(held);
            for (int i = 0; i < released.Count; i++) KeyUp(released[i], 0, time);
            for (int b = 0; b < 5; b++)
                if ((heldBtn & (1 << b)) != 0) MouseButton(false, b, pos.x / ScreenW(), pos.y / ScreenH(), 1, 0, time);
            owners.Clear();
#if ENABLE_INPUT_SYSTEM
            if (pad != null && pad.added) QueuePad(time);
#endif
        }
        finally
        {
            forcing = false;
        }
    }

    static bool KeysAllowed => EditorApplication.isPlaying && !EditorApplication.isPaused;

    void KeyDown(string name, bool repeat, int m, double time)
    {
        if (string.IsNullOrEmpty(name)) return;
        Own(sender).keys.Add(name);
        bool wasHeld = !held.Add(name);
        if (!wasHeld && name == "Escape") StreamCursor.OnEscape();
        if (TryMap(name, out var code) && KeysAllowed && !SilentModifier(code))
        {
            var mods = ToModifiers(m) | KeyMods(code);
            var e = new Event { type = EventType.KeyDown, keyCode = code, mousePosition = pos, modifiers = mods, displayIndex = 0 };
            if (!RouteShortcut(e))
            {
                Queue(e);
                char special = SpecialChar(code);
                if (special != '\0')
                    Queue(new Event { type = EventType.KeyDown, character = special, mousePosition = pos, modifiers = ToModifiers(m), displayIndex = 0 });
            }
        }
#if ENABLE_INPUT_SYSTEM
        if (!wasHeld && !repeat && TryKey(name, out var key))
        {
            kbState.Press(key);
            QueueKeyboard(time);
        }
#endif
    }

    void KeyUp(string name, int m, double time)
    {
        if (string.IsNullOrEmpty(name) || !held.Contains(name)) return;
        if (forcing)
        {
            foreach (var kv in owners) kv.Value.keys.Remove(name);
        }
        else
        {
            var me = Own(sender);
            me.keys.Remove(name);
            if (OtherOwnsKey(name, me)) return;
        }
        held.Remove(name);
        if (TryMap(name, out var code) && KeysAllowed && !SilentModifier(code))
        {
            var e = new Event { type = EventType.KeyUp, keyCode = code, mousePosition = pos, modifiers = ToModifiers(m) | KeyMods(code), displayIndex = 0 };
            if (!RouteShortcut(e)) Queue(e);
        }
#if ENABLE_INPUT_SYSTEM
        if (TryKey(name, out var key))
        {
            kbState.Release(key);
            QueueKeyboard(time);
        }
#endif
    }

    void Text(string s, int m, double time)
    {
        if (string.IsNullOrEmpty(s)) return;
        bool legacy = KeysAllowed;
        var mods = ToModifiers(m);
        for (int i = 0; i < s.Length; i++)
        {
            char c = s[i];
            if (c == '\r') c = '\n';
            if (legacy)
                Queue(new Event { type = EventType.KeyDown, character = c, mousePosition = pos, modifiers = mods, displayIndex = 0 });
#if ENABLE_INPUT_SYSTEM
            if (kb == null || !kb.added) continue;
            if (char.IsHighSurrogate(c) && i + 1 < s.Length && char.IsLowSurrogate(s[i + 1]))
            {
                if (legacy)
                    Queue(new Event { type = EventType.KeyDown, character = s[i + 1], mousePosition = pos, modifiers = mods, displayIndex = 0 });
                var te = TextEvent.Create(kb.deviceId, char.ConvertToUtf32(c, s[i + 1]), time);
                InputSystem.QueueEvent(ref te);
                i++;
                continue;
            }
            InputSystem.QueueTextEvent(kb, c, time);
#endif
        }
    }

    void SetPosition(float x, float y)
    {
        if (locked)
        {
            pos = new Vector2(ScreenW() * 0.5f, ScreenH() * 0.5f);
        }
        else
        {
            if (Cursor.lockState == CursorLockMode.Confined)
            {
                x = Mathf.Clamp(x, 0f, 0.9999f);
                y = Mathf.Clamp(y, 0f, 0.9999f);
            }
            pos = new Vector2(x * ScreenW(), y * ScreenH());
        }
        GameMousePosition = pos;
#if ENABLE_INPUT_SYSTEM
        devicePos = new Vector2(pos.x, ScreenH() - pos.y);
#endif
    }

    void Move(float x, float y, float dx, float dy, int m, double time)
    {
        if (StreamCursor.LockEmulated && Time.frameCount <= StreamCursor.DiscardDeltaFrame) { dx = 0f; dy = 0f; }
        SetPosition(x, y);
        Queue(new Event
        {
            type = heldBtn != 0 ? EventType.MouseDrag : EventType.MouseMove,
            mousePosition = pos,
            delta = new Vector2(dx, dy),
            modifiers = ToModifiers(m),
            displayIndex = 0
        });
#if ENABLE_INPUT_SYSTEM
        QueueMouse(new Vector2(dx * OsDeltaScale, -dy * OsDeltaScale), Vector2.zero, time);
#endif
    }

    void MouseButton(bool down, int b, float x, float y, int clicks, int m, double time)
    {
        if (b < 0 || b > 4) return;
        int bit = 1 << b;
        var me = Own(sender);
        if (down && (me.btn & bit) != 0) return;
        if (forcing)
        {
            foreach (var kv in owners) kv.Value.btn &= ~bit;
        }
        else if (OtherOwnsBtn(bit, me))
        {
            if (down) me.btn |= bit; else me.btn &= ~bit;
            return;
        }
        bool inside = locked || (x >= 0f && x < 1f && y >= 0f && y < 1f) || Cursor.lockState == CursorLockMode.Confined;
        if (down && !inside)
        {
            suppressedBtn |= bit;
            return;
        }
        bool wasSuppressed = (suppressedBtn & bit) != 0;
        suppressedBtn &= ~bit;
        SetPosition(x, y);
        clickCount = (ushort)Mathf.Clamp(clicks, 1, ushort.MaxValue);
        if (down) heldBtn |= bit; else heldBtn &= ~bit;
        if (!forcing)
        {
            if (down) me.btn |= bit; else me.btn &= ~bit;
        }
        Queue(new Event
        {
            type = down ? EventType.MouseDown : EventType.MouseUp,
            mousePosition = pos,
            button = b,
            clickCount = clickCount,
            modifiers = ToModifiers(m),
            displayIndex = 0
        });
#if ENABLE_INPUT_SYSTEM
        if (!wasSuppressed) QueueMouse(Vector2.zero, Vector2.zero, time);
#endif
    }

    void Wheel(float notchesX, float notchesY, int m, double time)
    {
        Queue(new Event
        {
            type = EventType.ScrollWheel,
            mousePosition = pos,
            delta = new Vector2(notchesX * 3f, notchesY * -3f),
            modifiers = ToModifiers(m),
            displayIndex = 0
        });
#if ENABLE_INPUT_SYSTEM
        float scale = PlatformScroll() ? PlatformScrollUnit : 1f;
        QueueMouse(Vector2.zero, new Vector2(notchesX * scale, notchesY * scale), time);
#endif
    }

    static void Queue(Event e) => EditorGUIUtility.QueueGameViewInputEvent(e);

    float ScreenW()
    {
        var gv = LocalStreamServer.GameViewSize();
        return gv.x > 0 ? gv.x : Screen.width > 0 ? Screen.width : rtW;
    }

    float ScreenH()
    {
        var gv = LocalStreamServer.GameViewSize();
        return gv.y > 0 ? gv.y : Screen.height > 0 ? Screen.height : rtH;
    }

    public void Dispose()
    {
        driving = false;
#if ENABLE_INPUT_SYSTEM
        HandBack();
        if (kb != null && kb.added) InputSystem.RemoveDevice(kb);
        if (mouse != null && mouse.added) InputSystem.RemoveDevice(mouse);
        if (pad != null && pad.added) InputSystem.RemoveDevice(pad);
        pad = null;
#endif
    }

    static double InputNow()
    {
#if ENABLE_INPUT_SYSTEM
        try { return InputState.currentTime; } catch { return -1; }
#else
        return -1;
#endif
    }

#if ENABLE_INPUT_SYSTEM
#if UNITY_EDITOR_OSX
    const float OsDeltaScale = 0.25f;
#else
    const float OsDeltaScale = 1f;
#endif
#if UNITY_EDITOR_WIN
    const float PlatformScrollUnit = 120f;
#else
    const float PlatformScrollUnit = 1f;
#endif
    const string KeyboardName = "SaturaKeyboard";
    const string MouseName = "SaturaMouse";
    const string Tag = "Satura";

    readonly Keyboard kb;
    readonly Mouse mouse;
    Gamepad pad;
    Vector2 devicePos;
    KeyboardState kbState;
    double lastKbTime, lastMouseTime, lastPadTime;

    void QueuePad(double time)
    {
        uint bits = 0;
        float lt = 0f, rt = 0f;
        Vector2 ls = Vector2.zero, rs = Vector2.zero;
        bool any = false;
        foreach (var kv in owners)
        {
            var o = kv.Value;
            bits |= o.pad;
            lt = Mathf.Max(lt, o.lt);
            rt = Mathf.Max(rt, o.rt);
            if (o.ls.sqrMagnitude > ls.sqrMagnitude) ls = o.ls;
            if (o.rs.sqrMagnitude > rs.sqrMagnitude) rs = o.rs;
            if (o.pad != 0 || o.lt != 0f || o.rt != 0f || o.ls != Vector2.zero || o.rs != Vector2.zero) any = true;
        }
        if (pad == null || !pad.added)
        {
            if (!any) return;
            pad = ModulePad();
            if (pad == null)
            {
                if (!padRefused) Debug.Log("[StreamInput] phone gamepad input ignored: the Satura Remote gamepad module is off (scripting define SATURA_REMOTE_GAMEPAD)");
                padRefused = true;
                return;
            }
            InputSystem.EnableDevice(pad);
            Debug.Log($"[StreamInput] phone drives the virtual gamepad {pad.name} from the Satura Remote gamepad module");
        }
        var st = new GamepadState { leftStick = ls, rightStick = rs, leftTrigger = lt, rightTrigger = rt, buttons = bits };
        InputSystem.QueueStateEvent(pad, st, Stamp(time, ref lastPadTime));
    }

    static MethodInfo moduleAcquire;
    static bool moduleResolved;
    bool padRefused;

    static Gamepad ModulePad()
    {
        if (!moduleResolved)
        {
            moduleResolved = true;
            try { moduleAcquire = Type.GetType(InputScheme.GamepadModuleType, false)?.GetMethod("Acquire", BindingFlags.Public | BindingFlags.Static); }
            catch { moduleAcquire = null; }
        }
        if (moduleAcquire == null) return null;
        try { return moduleAcquire.Invoke(null, null) as Gamepad; }
        catch (Exception e)
        {
            Debug.LogWarning("[StreamInput] the Satura Remote gamepad module failed to add its device: " + e.Message);
            return null;
        }
    }

    static PropertyInfo scrollBehaviorProp;
    static bool scrollBehaviorResolved;

    static bool PlatformScroll()
    {
        if (!scrollBehaviorResolved)
        {
            scrollBehaviorResolved = true;
            scrollBehaviorProp = typeof(InputSettings).GetProperty("scrollDeltaBehavior", BindingFlags.Instance | BindingFlags.Public);
        }
        if (scrollBehaviorProp == null) return false;
        try { return Convert.ToInt32(scrollBehaviorProp.GetValue(InputSystem.settings)) != 0; }
        catch { return false; }
    }

    double Stamp(double time, ref double last)
    {
        if (time < 0) return -1;
        if (time < last) time = last;
        last = time;
        return time;
    }

    void QueueKeyboard(double time)
    {
        if (kb == null || !kb.added) return;
        InputSystem.QueueStateEvent(kb, kbState, Stamp(time, ref lastKbTime));
    }

    void QueueMouse(Vector2 delta, Vector2 scroll, double time)
    {
        if (mouse == null || !mouse.added) return;
        var ms = new MouseState
        {
            position = devicePos,
            delta = delta,
            scroll = scroll,
            clickCount = clickCount,
            displayIndex = 0
        };
        if ((heldBtn & 1) != 0) ms = ms.WithButton(UnityEngine.InputSystem.LowLevel.MouseButton.Left, true);
        if ((heldBtn & 2) != 0) ms = ms.WithButton(UnityEngine.InputSystem.LowLevel.MouseButton.Right, true);
        if ((heldBtn & 4) != 0) ms = ms.WithButton(UnityEngine.InputSystem.LowLevel.MouseButton.Middle, true);
        if ((heldBtn & 8) != 0) ms = ms.WithButton(UnityEngine.InputSystem.LowLevel.MouseButton.Back, true);
        if ((heldBtn & 16) != 0) ms = ms.WithButton(UnityEngine.InputSystem.LowLevel.MouseButton.Forward, true);
        InputSystem.QueueStateEvent(mouse, ms, Stamp(time, ref lastMouseTime));
    }

    static readonly Dictionary<string, Key> isxKeyCache = new Dictionary<string, Key>();

    static bool TryKey(string name, out Key key)
    {
        if (isxKeyCache.TryGetValue(name, out key)) return key != Key.None;
        if (!Enum.TryParse(name, false, out key)) key = Key.None;
        isxKeyCache[name] = key;
        return key != Key.None;
    }

    InputSettings ownSettings;
    InputSettings gameSettings;
    readonly List<InputDevice> heldNative = new List<InputDevice>();

    void TakeOver()
    {
        if (ownSettings == null)
        {
            var current = InputSystem.settings;
            if (current != null)
            {
                gameSettings = current;
                ownSettings = UnityEngine.Object.Instantiate(current);
                ownSettings.hideFlags = HideFlags.HideAndDontSave;
                ownSettings.backgroundBehavior = InputSettings.BackgroundBehavior.IgnoreFocus;
                ownSettings.editorInputBehaviorInPlayMode = InputSettings.EditorInputBehaviorInPlayMode.AllDeviceInputAlwaysGoesToGameView;
                InputSystem.settings = ownSettings;
            }
        }
        var devices = new List<InputDevice>(InputSystem.devices);
        for (int i = 0; i < devices.Count; i++)
        {
            var d = devices[i];
            if (!(d is Keyboard || d is UnityEngine.InputSystem.Pointer) || !d.native || !d.added || !d.enabled) continue;
            InputSystem.DisableDevice(d);
            heldNative.Add(d);
        }
    }

    void HandBack()
    {
        if (ownSettings != null)
        {
            if (InputSystem.settings == ownSettings && gameSettings != null) InputSystem.settings = gameSettings;
            UnityEngine.Object.DestroyImmediate(ownSettings);
            ownSettings = null;
            gameSettings = null;
        }
        for (int i = 0; i < heldNative.Count; i++)
        {
            var d = heldNative[i];
            if (d != null && d.added && !d.enabled) InputSystem.EnableDevice(d);
        }
        heldNative.Clear();
    }

    public static void PurgeTagged()
    {
        var devices = new List<InputDevice>(InputSystem.devices);
        for (int i = 0; i < devices.Count; i++)
        {
            var d = devices[i];
            if (d != null && d.added && !d.native && d.name != null && d.name.StartsWith(Tag, StringComparison.Ordinal))
                InputSystem.RemoveDevice(d);
        }
    }

#if UNITY_EDITOR_OSX || UNITY_EDITOR_WIN
    public void InjectNative(KeyboardState state)
    {
        foreach (var d in InputSystem.devices)
        {
            if (d is Keyboard k && k.native && k.added && k.enabled)
            {
                InputSystem.QueueStateEvent(k, state);
                return;
            }
        }
    }
#endif
#endif

    static Type shortcutIntegration;
    static PropertyInfo ignoreInPlayProp;
    static PropertyInfo controllerProp;
    static MethodInfo handleKeyMethod;
    static MemberInfo contextManagerMember;
    static Type gameViewType;
    static bool shortcutsResolved;
    static UnityEngine.Object gameView;
    static float gameViewLookupAt = -10f;

    static bool RouteShortcut(Event e)
    {
        if (!Application.isPlaying) return false;
        if (!shortcutsResolved)
        {
            shortcutsResolved = true;
            const BindingFlags any = BindingFlags.Static | BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic;
            foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
            {
                shortcutIntegration = asm.GetType("UnityEditor.ShortcutManagement.ShortcutIntegration", false);
                if (shortcutIntegration != null) break;
            }
            gameViewType = typeof(EditorWindow).Assembly.GetType("UnityEditor.GameView", false);
            ignoreInPlayProp = shortcutIntegration?.GetProperty("ignoreWhenPlayModeFocused", any);
            controllerProp = shortcutIntegration?.GetProperty("instance", any);
            var controllerType = controllerProp?.PropertyType;
            handleKeyMethod = controllerType?.GetMethod("HandleKeyEvent", any, null, new[] { typeof(Event) }, null);
            contextManagerMember = (MemberInfo)controllerType?.GetField("contextManager", any) ?? controllerType?.GetProperty("contextManager", any);
            if (handleKeyMethod == null)
                Debug.LogWarning("[StreamInput] ShortcutController.HandleKeyEvent not found — editor shortcuts stay off in the stream");
        }
        if (handleKeyMethod == null || controllerProp == null) return false;
        try
        {
            if (ignoreInPlayProp != null && (bool)ignoreInPlayProp.GetValue(null)) return false;
            var controller = controllerProp.GetValue(null);
            if (controller == null) return false;
            object contexts = contextManagerMember is FieldInfo f ? f.GetValue(controller)
                : contextManagerMember is PropertyInfo p ? p.GetValue(controller) : null;
            contexts?.GetType().GetMethod("SetFocusedWindow", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic)
                ?.Invoke(contexts, new object[] { FindGameView() });
            handleKeyMethod.Invoke(controller, new object[] { e });
            return e.type == EventType.Used;
        }
        catch (Exception ex)
        {
            Debug.LogWarning("[StreamInput] shortcut routing failed: " + (ex.InnerException ?? ex).Message);
            handleKeyMethod = null;
            return false;
        }
    }

    static EditorWindow FindGameView()
    {
        if (gameViewType == null) return null;
        if (gameView == null && Time.realtimeSinceStartup - gameViewLookupAt > 1f)
        {
            gameViewLookupAt = Time.realtimeSinceStartup;
            var all = Resources.FindObjectsOfTypeAll(gameViewType);
            gameView = all.Length > 0 ? all[0] : null;
        }
        return gameView as EditorWindow;
    }

    static readonly Dictionary<string, KeyCode> SpecialKeys = new Dictionary<string, KeyCode>
    {
        { "Enter", KeyCode.Return },
        { "NumpadEnter", KeyCode.KeypadEnter },
        { "Backquote", KeyCode.BackQuote },
        { "LeftCtrl", KeyCode.LeftControl },
        { "RightCtrl", KeyCode.RightControl },
        { "LeftMeta", KeyCode.LeftCommand },
        { "RightMeta", KeyCode.RightCommand },
        { "Digit0", KeyCode.Alpha0 },
        { "Digit1", KeyCode.Alpha1 },
        { "Digit2", KeyCode.Alpha2 },
        { "Digit3", KeyCode.Alpha3 },
        { "Digit4", KeyCode.Alpha4 },
        { "Digit5", KeyCode.Alpha5 },
        { "Digit6", KeyCode.Alpha6 },
        { "Digit7", KeyCode.Alpha7 },
        { "Digit8", KeyCode.Alpha8 },
        { "Digit9", KeyCode.Alpha9 },
        { "Numpad0", KeyCode.Keypad0 },
        { "Numpad1", KeyCode.Keypad1 },
        { "Numpad2", KeyCode.Keypad2 },
        { "Numpad3", KeyCode.Keypad3 },
        { "Numpad4", KeyCode.Keypad4 },
        { "Numpad5", KeyCode.Keypad5 },
        { "Numpad6", KeyCode.Keypad6 },
        { "Numpad7", KeyCode.Keypad7 },
        { "Numpad8", KeyCode.Keypad8 },
        { "Numpad9", KeyCode.Keypad9 },
        { "NumpadPlus", KeyCode.KeypadPlus },
        { "NumpadMinus", KeyCode.KeypadMinus },
        { "NumpadMultiply", KeyCode.KeypadMultiply },
        { "NumpadDivide", KeyCode.KeypadDivide },
        { "NumpadPeriod", KeyCode.KeypadPeriod },
        { "NumpadEquals", KeyCode.KeypadEquals },
        { "NumLock", KeyCode.Numlock },
        { "PrintScreen", KeyCode.Print },
        { "ContextMenu", KeyCode.Menu }
    };

    static readonly Dictionary<string, KeyCode> keyCache = new Dictionary<string, KeyCode>();

    readonly HashSet<string> held = new HashSet<string>();
    readonly List<string> released = new List<string>();
    int heldBtn;
    int suppressedBtn;
    ushort clickCount = 1;
    bool locked;
    Vector2 pos;

    static bool TryMap(string name, out KeyCode code)
    {
        if (keyCache.TryGetValue(name, out code)) return code != KeyCode.None;
        if (!SpecialKeys.TryGetValue(name, out code) && !Enum.TryParse(name, false, out code))
            code = KeyCode.None;
        keyCache[name] = code;
        return code != KeyCode.None;
    }

    static EventModifiers ToModifiers(int m)
    {
        EventModifiers mods = EventModifiers.None;
        if ((m & ModShift) != 0) mods |= EventModifiers.Shift;
        if ((m & ModCtrl) != 0) mods |= EventModifiers.Control;
        if ((m & ModAlt) != 0) mods |= EventModifiers.Alt;
        if ((m & ModMeta) != 0) mods |= EventModifiers.Command;
        if ((m & ModCaps) != 0) mods |= EventModifiers.CapsLock;
        return mods;
    }

    static int LegacyMods(string[] keys)
    {
        int m = 0;
        for (int i = 0; i < keys.Length; i++)
        {
            switch (keys[i])
            {
                case "LeftShift": case "RightShift": m |= ModShift; break;
                case "LeftCtrl": case "RightCtrl": m |= ModCtrl; break;
                case "LeftAlt": case "RightAlt": m |= ModAlt; break;
                case "LeftCommand": case "RightCommand": case "LeftMeta": case "RightMeta": m |= ModMeta; break;
            }
        }
        return m;
    }

    static EventModifiers KeyMods(KeyCode code)
    {
        switch (code)
        {
            case KeyCode.UpArrow: case KeyCode.DownArrow:
            case KeyCode.LeftArrow: case KeyCode.RightArrow:
            case KeyCode.Insert: case KeyCode.Home: case KeyCode.End:
            case KeyCode.PageUp: case KeyCode.PageDown:
            case KeyCode.Delete: case KeyCode.Backspace:
                return EventModifiers.FunctionKey;
        }
        if (code >= KeyCode.F1 && code <= KeyCode.F15) return EventModifiers.FunctionKey;
        if (code >= KeyCode.Keypad0 && code <= KeyCode.KeypadEquals) return EventModifiers.Numeric;
        return EventModifiers.None;
    }

    static bool SilentModifier(KeyCode code)
    {
#if UNITY_EDITOR_OSX
        switch (code)
        {
            case KeyCode.LeftShift: case KeyCode.RightShift:
            case KeyCode.LeftControl: case KeyCode.RightControl:
            case KeyCode.LeftAlt: case KeyCode.RightAlt:
            case KeyCode.LeftCommand: case KeyCode.RightCommand:
            case KeyCode.CapsLock:
                return true;
        }
#endif
        return false;
    }

    static char SpecialChar(KeyCode code)
    {
        switch (code)
        {
            case KeyCode.Return: case KeyCode.KeypadEnter: return '\n';
            case KeyCode.Tab: return '\t';
        }
        return '\0';
    }
}
#endif
