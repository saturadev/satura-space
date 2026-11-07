using System;

public static partial class MCPTestBridge
{
    [Serializable]
    class SceneTriggerData
    {
        public string scenePath = "";
        public bool enterPlayMode = false;
    }

    [Serializable]
    class SceneResultData
    {
        public string status;
        public string scenePath;
        public bool isPlayMode;
        public string error;
        public bool hadUnsavedChanges;
        public string discardedScenes;
        public long timestamp;
    }

    [Serializable]
    class RefreshResultData
    {
        public string status;
        public long timestamp;
    }

    [Serializable]
    class StopPlayResultData
    {
        public string status;
        public bool wasPlaying;
        public string error;
        public long timestamp;
    }

    [Serializable]
    class SceneStatusData
    {
        public string name;
        public string path;
        public bool loaded;
        public bool dirty;
        public bool active;
        public int rootCount;
    }

    [Serializable]
    class StatusData
    {
        public bool isPlaying;
        public bool isPaused;
        public bool isCompiling;
        public bool isBatchMode;
        public int pid;
        public int controlPort;
        public string activeScene;
        public string activeSceneName;
        public bool scenesDirty;
        public SceneStatusData[] scenes;
        public bool isStreaming;
        public int streamActualFps;
        public int actualFps;
        public string streamRes;
        public int fpsCap;
        public int targetFrameRate;
        public int vSyncCount;
        public string fpsSource;
        public long timestamp;
    }

    [Serializable]
    public class ExecResultData
    {
        public string status;
        public string output;
        public string error;
        public string nonce;
        public long timestamp;
    }

    [Serializable]
    class FlushLogsResultData
    {
        public string status;
        public long timestamp;
    }
}
