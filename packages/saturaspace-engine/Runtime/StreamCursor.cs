#if UNITY_EDITOR
using UnityEngine;

public static class StreamCursor
{
    public static Texture2D Texture { get; private set; }
    public static Vector2 Hotspot { get; private set; }
    public static int Version { get; private set; }
    public static bool LockEmulated { get; set; }
    public static int DiscardDeltaFrame { get; private set; } = -1;
    static CursorLockMode lockState;

    public static CursorLockMode LockState
    {
        get => lockState;
        set
        {
            if (value == CursorLockMode.Locked && lockState != CursorLockMode.Locked) DiscardDeltaFrame = Time.frameCount + 1;
            lockState = value;
        }
    }

    public static void OnSetCursor(Texture2D texture, Vector2 hotspot)
    {
        Texture = texture;
        Hotspot = hotspot;
        Version++;
    }

    public static void OnEscape()
    {
        if (!LockEmulated || LockState == CursorLockMode.None) return;
        LockState = CursorLockMode.None;
        Cursor.visible = true;
    }
}
#endif
