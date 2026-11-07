#if ENABLE_INPUT_SYSTEM && (UNITY_EDITOR_OSX || UNITY_EDITOR_WIN)
using System;
using System.Runtime.InteropServices;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.LowLevel;

internal static class NativeHeldKeys
{
#if UNITY_EDITOR_OSX
    [DllImport("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")]
    [return: MarshalAs(UnmanagedType.I1)]
    static extern bool CGEventSourceKeyState(int stateId, ushort keyCode);

    static bool KeyDown(ushort code) => CGEventSourceKeyState(0, code);

    static readonly (ushort code, Key key)[] Map =
    {
        (0x00, Key.A), (0x0B, Key.B), (0x08, Key.C), (0x02, Key.D), (0x0E, Key.E),
        (0x03, Key.F), (0x05, Key.G), (0x04, Key.H), (0x22, Key.I), (0x26, Key.J),
        (0x28, Key.K), (0x25, Key.L), (0x2E, Key.M), (0x2D, Key.N), (0x1F, Key.O),
        (0x23, Key.P), (0x0C, Key.Q), (0x0F, Key.R), (0x01, Key.S), (0x11, Key.T),
        (0x20, Key.U), (0x09, Key.V), (0x0D, Key.W), (0x07, Key.X), (0x10, Key.Y),
        (0x06, Key.Z),
        (0x12, Key.Digit1), (0x13, Key.Digit2), (0x14, Key.Digit3), (0x15, Key.Digit4),
        (0x17, Key.Digit5), (0x16, Key.Digit6), (0x1A, Key.Digit7), (0x1C, Key.Digit8),
        (0x19, Key.Digit9), (0x1D, Key.Digit0),
        (0x31, Key.Space), (0x24, Key.Enter), (0x30, Key.Tab), (0x35, Key.Escape),
        (0x33, Key.Backspace), (0x39, Key.CapsLock),
        (0x1B, Key.Minus), (0x18, Key.Equals), (0x21, Key.LeftBracket), (0x1E, Key.RightBracket),
        (0x2A, Key.Backslash), (0x29, Key.Semicolon), (0x27, Key.Quote), (0x2B, Key.Comma),
        (0x2F, Key.Period), (0x2C, Key.Slash), (0x32, Key.Backquote),
        (0x38, Key.LeftShift), (0x3C, Key.RightShift), (0x3B, Key.LeftCtrl), (0x3E, Key.RightCtrl),
        (0x3A, Key.LeftAlt), (0x3D, Key.RightAlt), (0x37, Key.LeftMeta), (0x36, Key.RightMeta),
        (0x7B, Key.LeftArrow), (0x7C, Key.RightArrow), (0x7D, Key.DownArrow), (0x7E, Key.UpArrow),
        (0x73, Key.Home), (0x77, Key.End), (0x74, Key.PageUp), (0x79, Key.PageDown),
        (0x75, Key.Delete),
        (0x7A, Key.F1), (0x78, Key.F2), (0x63, Key.F3), (0x76, Key.F4), (0x60, Key.F5),
        (0x61, Key.F6), (0x62, Key.F7), (0x64, Key.F8), (0x65, Key.F9), (0x6D, Key.F10),
        (0x67, Key.F11), (0x6F, Key.F12),
        (0x52, Key.Numpad0), (0x53, Key.Numpad1), (0x54, Key.Numpad2), (0x55, Key.Numpad3),
        (0x56, Key.Numpad4), (0x57, Key.Numpad5), (0x58, Key.Numpad6), (0x59, Key.Numpad7),
        (0x5B, Key.Numpad8), (0x5C, Key.Numpad9),
        (0x4B, Key.NumpadDivide), (0x43, Key.NumpadMultiply), (0x4E, Key.NumpadMinus),
        (0x45, Key.NumpadPlus), (0x4C, Key.NumpadEnter), (0x41, Key.NumpadPeriod),
        (0x51, Key.NumpadEquals)
    };
#else
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    static bool KeyDown(ushort code) => (GetAsyncKeyState(code) & 0x8000) != 0;

    static readonly (ushort code, Key key)[] Map =
    {
        (0x41, Key.A), (0x42, Key.B), (0x43, Key.C), (0x44, Key.D), (0x45, Key.E),
        (0x46, Key.F), (0x47, Key.G), (0x48, Key.H), (0x49, Key.I), (0x4A, Key.J),
        (0x4B, Key.K), (0x4C, Key.L), (0x4D, Key.M), (0x4E, Key.N), (0x4F, Key.O),
        (0x50, Key.P), (0x51, Key.Q), (0x52, Key.R), (0x53, Key.S), (0x54, Key.T),
        (0x55, Key.U), (0x56, Key.V), (0x57, Key.W), (0x58, Key.X), (0x59, Key.Y),
        (0x5A, Key.Z),
        (0x31, Key.Digit1), (0x32, Key.Digit2), (0x33, Key.Digit3), (0x34, Key.Digit4),
        (0x35, Key.Digit5), (0x36, Key.Digit6), (0x37, Key.Digit7), (0x38, Key.Digit8),
        (0x39, Key.Digit9), (0x30, Key.Digit0),
        (0x20, Key.Space), (0x0D, Key.Enter), (0x09, Key.Tab), (0x1B, Key.Escape),
        (0x08, Key.Backspace), (0x14, Key.CapsLock),
        (0xBD, Key.Minus), (0xBB, Key.Equals), (0xDB, Key.LeftBracket), (0xDD, Key.RightBracket),
        (0xDC, Key.Backslash), (0xBA, Key.Semicolon), (0xDE, Key.Quote), (0xBC, Key.Comma),
        (0xBE, Key.Period), (0xBF, Key.Slash), (0xC0, Key.Backquote),
        (0xA0, Key.LeftShift), (0xA1, Key.RightShift), (0xA2, Key.LeftCtrl), (0xA3, Key.RightCtrl),
        (0xA4, Key.LeftAlt), (0xA5, Key.RightAlt), (0x5B, Key.LeftMeta), (0x5C, Key.RightMeta),
        (0x25, Key.LeftArrow), (0x27, Key.RightArrow), (0x28, Key.DownArrow), (0x26, Key.UpArrow),
        (0x24, Key.Home), (0x23, Key.End), (0x21, Key.PageUp), (0x22, Key.PageDown),
        (0x2E, Key.Delete),
        (0x70, Key.F1), (0x71, Key.F2), (0x72, Key.F3), (0x73, Key.F4), (0x74, Key.F5),
        (0x75, Key.F6), (0x76, Key.F7), (0x77, Key.F8), (0x78, Key.F9), (0x79, Key.F10),
        (0x7A, Key.F11), (0x7B, Key.F12),
        (0x60, Key.Numpad0), (0x61, Key.Numpad1), (0x62, Key.Numpad2), (0x63, Key.Numpad3),
        (0x64, Key.Numpad4), (0x65, Key.Numpad5), (0x66, Key.Numpad6), (0x67, Key.Numpad7),
        (0x68, Key.Numpad8), (0x69, Key.Numpad9),
        (0x6F, Key.NumpadDivide), (0x6A, Key.NumpadMultiply), (0x6D, Key.NumpadMinus),
        (0x6B, Key.NumpadPlus), (0x6E, Key.NumpadPeriod)
    };
#endif

    public static bool TryCapture(ref KeyboardState state)
    {
        bool any = false;
        try
        {
            for (int i = 0; i < Map.Length; i++)
            {
                if (!KeyDown(Map[i].code)) continue;
                state.Press(Map[i].key);
                any = true;
            }
        }
        catch (Exception)
        {
            return false;
        }
        return any;
    }
}
#endif
