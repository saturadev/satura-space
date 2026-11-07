#if ENABLE_INPUT_SYSTEM
using UnityEngine;
using UnityEngine.InputSystem;
using UnityEngine.InputSystem.Layouts;
using UnityEngine.InputSystem.LowLevel;

namespace SaturaSpace.Remote
{
    [InputControlLayout(stateType = typeof(GamepadState), displayName = "Satura Remote Gamepad")]
#if UNITY_EDITOR
    [UnityEditor.InitializeOnLoad]
#endif
    public class SaturaRemoteGamepad : Gamepad
    {
        public const string DeviceName = "SaturaRemoteGamepad";

        static SaturaRemoteGamepad device;

        static SaturaRemoteGamepad()
        {
            Register();
        }

        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        static void Register()
        {
            InputSystem.RegisterLayout<SaturaRemoteGamepad>();
        }

        public static Gamepad Acquire()
        {
            if (device != null && device.added) return device;
            Register();
            device = InputSystem.AddDevice<SaturaRemoteGamepad>(DeviceName);
            Debug.Log("[SaturaRemoteGamepad] added the virtual gamepad the phone drives");
            return device;
        }

        public static void Release()
        {
            if (device != null && device.added) InputSystem.RemoveDevice(device);
            device = null;
        }

        public static bool Active => device != null && device.added;
    }
}
#endif
