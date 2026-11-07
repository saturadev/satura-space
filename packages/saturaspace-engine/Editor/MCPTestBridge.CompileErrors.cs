using UnityEngine;
using UnityEditor;
using UnityEditor.Compilation;
using System.IO;
using System.Text;
using SaturaSpace;

public static partial class MCPTestBridge
{
    static string CompileErrorsPath => Path.Combine(SspaceRoot, ".mcp_compile_errors.log");
    static string CleanCompilePath => Path.Combine(SspaceRoot, ".mcp_last_clean_compile");

    [InitializeOnLoadMethod]
    static void InitCompileErrorCapture()
    {
        if (Inert) return;
        CompilationPipeline.compilationStarted += OnCompileErrorCaptureStarted;
        CompilationPipeline.assemblyCompilationFinished += OnCompileErrorAssemblyFinished;
        CompilationPipeline.compilationFinished += OnCompileErrorCaptureFinished;
        EditorApplication.delayCall += SyncCompileStateAfterLoad;
    }

    static void SyncCompileStateAfterLoad()
    {
        if (EditorUtility.scriptCompilationFailed || EditorApplication.isCompiling) return;
        SspaceFolder.EnsureFor(CompileErrorsPath);
        try
        {
            if (File.Exists(CompileErrorsPath))
                File.Delete(CompileErrorsPath);
            if (!File.Exists(CleanCompilePath))
                File.WriteAllText(CleanCompilePath, System.DateTime.UtcNow.ToString("o"));
        }
        catch (IOException) { }
    }

    static StringBuilder _compileErrorBuffer;

    static void OnCompileErrorCaptureStarted(object ctx)
    {
        _compileErrorBuffer = new StringBuilder();
    }

    static void OnCompileErrorAssemblyFinished(string assembly, CompilerMessage[] messages)
    {
        if (_compileErrorBuffer == null) _compileErrorBuffer = new StringBuilder();
        foreach (var msg in messages)
        {
            if (msg.type == CompilerMessageType.Error)
                _compileErrorBuffer.AppendLine(msg.message);
        }
    }

    static void OnCompileErrorCaptureFinished(object ctx)
    {
        SspaceFolder.EnsureFor(CompileErrorsPath);
        try
        {
            if (_compileErrorBuffer != null && _compileErrorBuffer.Length > 0)
                File.WriteAllText(CompileErrorsPath, _compileErrorBuffer.ToString());
            else
            {
                if (File.Exists(CompileErrorsPath))
                    File.Delete(CompileErrorsPath);
                File.WriteAllText(CleanCompilePath, System.DateTime.UtcNow.ToString("o"));
            }
        }
        catch (IOException) { }
        _compileErrorBuffer = null;
    }
}
