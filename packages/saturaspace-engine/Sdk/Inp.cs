#if ENABLE_INPUT_SYSTEM
using System;
using UnityEngine;
using UnityEngine.InputSystem;

namespace SaturaSpace
{
    public static class Inp
    {
        static readonly int KeyArrayLen = MaxKeyValue() + 1;

        static readonly bool[] keyCur = new bool[KeyArrayLen];
        static readonly bool[] keyPrev = new bool[KeyArrayLen];

        static int MaxKeyValue()
        {
            int max = 0;
            foreach (Key k in (Key[])Enum.GetValues(typeof(Key)))
                if ((int)k > max) max = (int)k;
            return max;
        }

        static readonly bool[] btnCur = new bool[3];
        static readonly bool[] btnPrev = new bool[3];

        static Mouse activeMouse;

        public static bool KeyboardPresent { get; private set; }
        public static bool MousePresent { get; private set; }
        public static Vector2 MousePosition { get; private set; }
        public static Vector2 MouseDelta { get; private set; }
        public static Vector2 Scroll { get; private set; }
        public static float ScrollY => Scroll.y;

        public static bool IsPressed(Key k)   { int i = (int)k; return (uint)i < (uint)keyCur.Length && keyCur[i]; }
        public static bool WasPressed(Key k)  { int i = (int)k; return (uint)i < (uint)keyCur.Length && keyCur[i] && !keyPrev[i]; }
        public static bool WasReleased(Key k) { int i = (int)k; return (uint)i < (uint)keyCur.Length && !keyCur[i] && keyPrev[i]; }

        public static bool ShiftHeld => IsPressed(Key.LeftShift) || IsPressed(Key.RightShift);
        public static bool CtrlHeld  => IsPressed(Key.LeftCtrl) || IsPressed(Key.RightCtrl);

        public static bool LeftHeld   => btnCur[0];
        public static bool RightHeld  => btnCur[1];
        public static bool MiddleHeld => btnCur[2];
        public static bool LeftPressedThisFrame  => btnCur[0] && !btnPrev[0];
        public static bool LeftReleasedThisFrame => !btnCur[0] && btnPrev[0];
        public static bool RightPressedThisFrame => btnCur[1] && !btnPrev[1];

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.AfterSceneLoad)]
        static void Install()
        {
            Array.Clear(keyCur, 0, keyCur.Length);
            Array.Clear(keyPrev, 0, keyPrev.Length);
            btnCur[0] = btnCur[1] = btnCur[2] = false;
            btnPrev[0] = btnPrev[1] = btnPrev[2] = false;
            MousePosition = MouseDelta = Scroll = Vector2.zero;
            KeyboardPresent = MousePresent = false;
            activeMouse = null;

            var leftovers = Resources.FindObjectsOfTypeAll<InpPump>();
            foreach (var p in leftovers) UnityEngine.Object.DestroyImmediate(p.gameObject);

            var go = new GameObject("SaturaSpace.InpPump");
            UnityEngine.Object.DontDestroyOnLoad(go);
            go.hideFlags = HideFlags.HideAndDontSave;
            go.AddComponent<InpPump>();
        }

        public static void Snapshot()
        {
            Array.Copy(keyCur, keyPrev, keyCur.Length);
            btnPrev[0] = btnCur[0]; btnPrev[1] = btnCur[1]; btnPrev[2] = btnCur[2];

            // Sample EVERY keyboard/mouse, not just Keyboard.current/Mouse.current: a streamed
            // session runs a synthetic device alongside the machine's real one, and whichever
            // fired an event last owns .current. Reading only .current makes real input vanish
            // whenever the stream is pumping (and vice versa), so OR the devices together.
            KeyboardPresent = false;
            MousePresent = false;
            Array.Clear(keyCur, 0, keyCur.Length);
            btnCur[0] = btnCur[1] = btnCur[2] = false;

            Vector2 delta = Vector2.zero, scroll = Vector2.zero;
            Mouse firstMouse = null;

            var devices = InputSystem.devices;
            for (int d = 0; d < devices.Count; d++)
            {
                var dev = devices[d];
                if (dev == null || !dev.added || !dev.enabled) continue;

                if (dev is Keyboard kb)
                {
                    KeyboardPresent = true;
                    var keys = kb.allKeys;
                    for (int i = 0; i < keys.Count; i++)
                    {
                        var ctrl = keys[i];
                        if (ctrl == null || !ctrl.isPressed) continue;
                        int idx = (int)ctrl.keyCode;
                        if ((uint)idx < (uint)keyCur.Length) keyCur[idx] = true;
                    }
                }
                else if (dev is Mouse m)
                {
                    MousePresent = true;
                    btnCur[0] |= m.leftButton.isPressed;
                    btnCur[1] |= m.rightButton.isPressed;
                    btnCur[2] |= m.middleButton.isPressed;

                    if (firstMouse == null) firstMouse = m;

                    var md = m.delta.ReadValue();
                    delta += md;
                    scroll += m.scroll.ReadValue();

                    // Position is absolute, so it can't be summed. Latch onto whichever mouse
                    // last actually moved and keep reading that one, so an idle second device
                    // can't yank the position back and forth.
                    if (md.sqrMagnitude > 0f) activeMouse = m;
                }
            }

            MouseDelta = delta;
            Scroll = scroll;

            if (activeMouse != null && (!activeMouse.added || !activeMouse.enabled)) activeMouse = null;
            var posSource = activeMouse ?? firstMouse;
            if (posSource != null) MousePosition = posSource.position.ReadValue();
        }
    }

    [DefaultExecutionOrder(int.MinValue + 1)]
    internal sealed class InpPump : MonoBehaviour
    {
        void Update() => Inp.Snapshot();
    }
}
#endif
