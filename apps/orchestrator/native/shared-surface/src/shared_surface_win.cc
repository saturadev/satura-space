#include <node_api.h>
#include <windows.h>
#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <string>
#include <vector>

static uint64_t ReadU64(napi_env env, napi_value lo, napi_value hi) {
  uint32_t l = 0, h = 0;
  napi_get_value_uint32(env, lo, &l);
  napi_get_value_uint32(env, hi, &h);
  return ((uint64_t)h << 32) | (uint64_t)l;
}

static napi_value Duplicate(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  uint32_t pid = 0;
  napi_get_value_uint32(env, argv[0], &pid);
  uint64_t srcHandle = ReadU64(env, argv[1], argv[2]);

  HANDLE src = OpenProcess(PROCESS_DUP_HANDLE, FALSE, pid);
  if (!src) {
    napi_value n;
    napi_get_null(env, &n);
    return n;
  }
  HANDLE local = nullptr;
  BOOL ok = DuplicateHandle(src, (HANDLE)(uintptr_t)srcHandle, GetCurrentProcess(),
                            &local, 0, FALSE, DUPLICATE_SAME_ACCESS);
  CloseHandle(src);
  if (!ok || !local) {
    napi_value n;
    napi_get_null(env, &n);
    return n;
  }

  void* copy = nullptr;
  napi_value buf;
  napi_create_buffer_copy(env, sizeof(HANDLE), &local, &copy, &buf);
  return buf;
}

static napi_value Close(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);

  void* data = nullptr;
  size_t len = 0;
  napi_get_buffer_info(env, argv[0], &data, &len);
  if (data && len >= sizeof(HANDLE)) {
    HANDLE h = *(HANDLE*)data;
    if (h) CloseHandle(h);
  }
  napi_value undef;
  napi_get_undefined(env, &undef);
  return undef;
}

static std::wstring Utf8ToWide(napi_env env, napi_value v) {
  size_t len = 0;
  napi_get_value_string_utf16(env, v, nullptr, 0, &len);
  std::wstring s;
  s.resize(len);
  size_t copied = 0;
  napi_get_value_string_utf16(env, v, reinterpret_cast<char16_t*>(&s[0]), len + 1, &copied);
  s.resize(copied);
  return s;
}

static HANDLE EnsureKillOnCloseJob() {
  static HANDLE job = nullptr;
  if (job) return job;
  job = CreateJobObjectW(nullptr, nullptr);
  if (!job) return nullptr;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {};
  info.BasicLimitInformation.LimitFlags =
      JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  SetInformationJobObject(job, JobObjectExtendedLimitInformation, &info, sizeof(info));
  return job;
}

static bool InjectDll(HANDLE proc, const std::wstring& dllPath) {
  SIZE_T bytes = (dllPath.size() + 1) * sizeof(wchar_t);
  void* remote = VirtualAllocEx(proc, nullptr, bytes, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
  if (!remote) return false;
  if (!WriteProcessMemory(proc, remote, dllPath.c_str(), bytes, nullptr)) {
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    return false;
  }
  HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
  auto loadLib = (LPTHREAD_START_ROUTINE)GetProcAddress(k32, "LoadLibraryW");
  if (!loadLib) {
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    return false;
  }
  HANDLE th = CreateRemoteThread(proc, nullptr, 0, loadLib, remote, 0, nullptr);
  if (!th) {
    VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
    return false;
  }
  WaitForSingleObject(th, 10000);
  DWORD loaded = 0;
  GetExitCodeThread(th, &loaded);
  CloseHandle(th);
  VirtualFreeEx(proc, remote, 0, MEM_RELEASE);
  return loaded != 0;
}

static napi_value LaunchWithHook(napi_env env, napi_callback_info info) {
  size_t argc = 5;
  napi_value argv[5];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto fail = [&]() { napi_value n; napi_get_null(env, &n); return n; };
  if (argc < 5) return fail();

  std::wstring exe = Utf8ToWide(env, argv[0]);
  std::wstring cwd = Utf8ToWide(env, argv[2]);
  std::wstring envBlock = Utf8ToWide(env, argv[3]);
  std::wstring dll = Utf8ToWide(env, argv[4]);

  std::wstring cmd = L"\"" + exe + L"\"";
  uint32_t n = 0;
  napi_get_array_length(env, argv[1], &n);
  for (uint32_t i = 0; i < n; i++) {
    napi_value item;
    napi_get_element(env, argv[1], i, &item);
    std::wstring a = Utf8ToWide(env, item);
    bool needQuote = a.empty() || a.find_first_of(L" \t\"") != std::wstring::npos;
    cmd += L" ";
    if (needQuote) {
      cmd += L"\"";
      for (wchar_t c : a) { if (c == L'"') cmd += L"\\"; cmd += c; }
      cmd += L"\"";
    } else {
      cmd += a;
    }
  }

  std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
  cmdBuf.push_back(0);

  STARTUPINFOW si = {};
  si.cb = sizeof(si);
  PROCESS_INFORMATION pi = {};
  DWORD flags = CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
  LPVOID envPtr = envBlock.empty() ? nullptr : (LPVOID)envBlock.c_str();
  LPCWSTR cwdPtr = cwd.empty() ? nullptr : cwd.c_str();

  if (!CreateProcessW(exe.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE, flags,
                      envPtr, cwdPtr, &si, &pi)) {
    return fail();
  }

  HANDLE job = EnsureKillOnCloseJob();
  if (job) AssignProcessToJobObject(job, pi.hProcess);

  bool injected = InjectDll(pi.hProcess, dll);

  ResumeThread(pi.hThread);
  DWORD pid = pi.dwProcessId;
  CloseHandle(pi.hThread);
  CloseHandle(pi.hProcess);

  napi_value out, pidVal, injVal;
  napi_create_object(env, &out);
  napi_create_uint32(env, pid, &pidVal);
  napi_get_boolean(env, injected, &injVal);
  napi_set_named_property(env, out, "pid", pidVal);
  napi_set_named_property(env, out, "injected", injVal);
  return out;
}

static napi_value SetJobKillOnClose(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  bool enabled = true;
  if (argc >= 1) napi_get_value_bool(env, argv[0], &enabled);
  napi_value out;
  HANDLE job = EnsureKillOnCloseJob();
  if (!job) {
    napi_get_boolean(env, false, &out);
    return out;
  }
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
  limits.BasicLimitInformation.LimitFlags =
      (enabled ? JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE : 0) | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK;
  BOOL ok = SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits));
  napi_get_boolean(env, ok != FALSE, &out);
  return out;
}

static napi_value AssignToKillJob(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value out;
  uint32_t pid = 0;
  if (argc < 1 || napi_get_value_uint32(env, argv[0], &pid) != napi_ok || !pid) {
    napi_get_boolean(env, false, &out);
    return out;
  }
  HANDLE job = EnsureKillOnCloseJob();
  HANDLE proc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, FALSE, pid);
  BOOL ok = job && proc && AssignProcessToJobObject(job, proc);
  if (proc) CloseHandle(proc);
  napi_get_boolean(env, ok != FALSE, &out);
  return out;
}

#include <cstdio>
#include <cstdarg>
static void RBLOG(const char* fmt, ...) {
  char* path = nullptr;
  size_t len = 0;
  if (_dupenv_s(&path, &len, "SATURA_SS_LOG") != 0 || !path) return;
  FILE* f = nullptr;
  if (fopen_s(&f, path, "a") == 0 && f) {
    va_list a; va_start(a, fmt); vfprintf(f, fmt, a); fputc('\n', f); va_end(a); fclose(f);
  }
  free(path);
}

static ID3D11Texture2D* OpenSharedOnAnyAdapter(HANDLE shared, ID3D11DeviceContext** outCtx) {
  IDXGIFactory1* factory = nullptr;
  if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory)) || !factory) {
    RBLOG("[rb] CreateDXGIFactory1 failed");
    return nullptr;
  }
  ID3D11Texture2D* result = nullptr;
  IDXGIAdapter1* adapter = nullptr;
  for (UINT i = 0; factory->EnumAdapters1(i, &adapter) != DXGI_ERROR_NOT_FOUND; i++) {
    DXGI_ADAPTER_DESC1 ad = {};
    adapter->GetDesc1(&ad);
    if (ad.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) { adapter->Release(); adapter = nullptr; continue; }

    ID3D11Device* dev = nullptr;
    ID3D11DeviceContext* ctx = nullptr;
    D3D_FEATURE_LEVEL got = {};
    HRESULT hrDev = D3D11CreateDevice(adapter, D3D_DRIVER_TYPE_UNKNOWN, nullptr,
                                      D3D11_CREATE_DEVICE_BGRA_SUPPORT, nullptr, 0,
                                      D3D11_SDK_VERSION, &dev, &got, &ctx);
    adapter->Release();
    adapter = nullptr;
    if (FAILED(hrDev) || !dev) { if (dev) dev->Release(); if (ctx) ctx->Release(); continue; }

    ID3D11Device1* dev1 = nullptr;
    if (SUCCEEDED(dev->QueryInterface(__uuidof(ID3D11Device1), (void**)&dev1)) && dev1) {
      ID3D11Texture2D* tex = nullptr;
      HRESULT hrOpen = dev1->OpenSharedResource1(shared, __uuidof(ID3D11Texture2D), (void**)&tex);
      dev1->Release();
      if (SUCCEEDED(hrOpen) && tex) {
        RBLOG("[rb] opened on adapter %u (%ls)", i, ad.Description);
        result = tex;
        *outCtx = ctx;
        dev->Release();
        break;
      }
      RBLOG("[rb] adapter %u OpenSharedResource1 hr=0x%08lx", i, (unsigned long)hrOpen);
    }
    ctx->Release();
    dev->Release();
  }
  factory->Release();
  return result;
}

static napi_value Readback(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  auto nullret = [&]() { napi_value n; napi_get_null(env, &n); return n; };
  if (argc < 3) return nullret();

  void* data = nullptr;
  size_t len = 0;
  napi_get_buffer_info(env, argv[0], &data, &len);
  if (!data || len < sizeof(HANDLE)) return nullret();
  HANDLE shared = *(HANDLE*)data;
  if (!shared) return nullret();
  uint32_t width = 0, height = 0;
  napi_get_value_uint32(env, argv[1], &width);
  napi_get_value_uint32(env, argv[2], &height);
  if (width == 0 || height == 0) return nullret();

  ID3D11DeviceContext* ctx = nullptr;
  ID3D11Texture2D* shTex = OpenSharedOnAnyAdapter(shared, &ctx);
  if (!shTex || !ctx) {
    if (shTex) shTex->Release();
    if (ctx) ctx->Release();
    return nullret();
  }
  ID3D11Device* dev = nullptr;
  shTex->GetDevice(&dev);
  if (!dev) { ctx->Release(); shTex->Release(); return nullret(); }

  D3D11_TEXTURE2D_DESC desc = {};
  shTex->GetDesc(&desc);
  bool keyedMutex = (desc.MiscFlags & D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX) != 0;

  IDXGIKeyedMutex* km = nullptr;
  if (keyedMutex) {
    if (SUCCEEDED(shTex->QueryInterface(__uuidof(IDXGIKeyedMutex), (void**)&km)) && km) {
      if (FAILED(km->AcquireSync(0, 1000))) {
        km->Release();
        dev->Release(); ctx->Release(); shTex->Release();
        return nullret();
      }
    }
  }

  D3D11_TEXTURE2D_DESC sdesc = desc;
  sdesc.Usage = D3D11_USAGE_STAGING;
  sdesc.BindFlags = 0;
  sdesc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
  sdesc.MiscFlags = 0;
  ID3D11Texture2D* staging = nullptr;
  HRESULT hrStg = dev->CreateTexture2D(&sdesc, nullptr, &staging);
  if (FAILED(hrStg) || !staging) {
    RBLOG("[rb] staging CreateTexture2D failed hr=0x%08lx", (unsigned long)hrStg);
    if (km) { km->ReleaseSync(0); km->Release(); }
    dev->Release(); ctx->Release(); shTex->Release();
    return nullret();
  }
  ctx->CopyResource(staging, shTex);
  ctx->Flush();

  if (km) { km->ReleaseSync(0); km->Release(); }

  D3D11_MAPPED_SUBRESOURCE mapped = {};
  HRESULT hrMap = ctx->Map(staging, 0, D3D11_MAP_READ, 0, &mapped);
  if (FAILED(hrMap)) {
    RBLOG("[rb] Map failed hr=0x%08lx", (unsigned long)hrMap);
    staging->Release();
    dev->Release(); ctx->Release(); shTex->Release();
    return nullret();
  }

  const int kGrid = 5;
  uint32_t samples[kGrid * kGrid];
  int sampleCount = 0;
  uint32_t firstVal = 0;
  bool allSame = true;
  bool nonBlack = false;
  uint32_t distinctSet[kGrid * kGrid];
  int distinct = 0;
  const uint8_t* base = (const uint8_t*)mapped.pData;
  for (int gy = 0; gy < kGrid; gy++) {
    for (int gx = 0; gx < kGrid; gx++) {
      uint32_t px = (uint32_t)((uint64_t)(width - 1) * gx / (kGrid - 1));
      uint32_t py = (uint32_t)((uint64_t)(height - 1) * gy / (kGrid - 1));
      const uint8_t* p = base + (size_t)py * mapped.RowPitch + (size_t)px * 4;
      uint32_t val = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
      if (p[0] != 0 || p[1] != 0 || p[2] != 0) nonBlack = true;
      if (sampleCount == 0) firstVal = val;
      else if (val != firstVal) allSame = false;
      bool seen = false;
      for (int k = 0; k < distinct; k++) if (distinctSet[k] == val) { seen = true; break; }
      if (!seen && distinct < kGrid * kGrid) distinctSet[distinct++] = val;
      samples[sampleCount++] = val;
    }
  }

  ctx->Unmap(staging, 0);
  staging->Release();
  dev->Release();
  ctx->Release();
  shTex->Release();

  napi_value out;
  napi_create_object(env, &out);
  napi_value v;
  napi_get_boolean(env, true, &v); napi_set_named_property(env, out, "ok", v);
  napi_create_uint32(env, (uint32_t)distinct, &v); napi_set_named_property(env, out, "distinct", v);
  napi_get_boolean(env, allSame, &v); napi_set_named_property(env, out, "allSame", v);
  napi_get_boolean(env, nonBlack, &v); napi_set_named_property(env, out, "nonBlack", v);
  napi_get_boolean(env, keyedMutex, &v); napi_set_named_property(env, out, "keyedMutex", v);
  napi_value arr;
  napi_create_array_with_length(env, sampleCount, &arr);
  for (int i = 0; i < sampleCount; i++) {
    napi_value e;
    napi_create_uint32(env, samples[i], &e);
    napi_set_element(env, arr, i, e);
  }
  napi_set_named_property(env, out, "samples", arr);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value duplicate, close, launchWithHook, readback, assignToKillJob, setJobKillOnClose;
  napi_create_function(env, "duplicate", NAPI_AUTO_LENGTH, Duplicate, nullptr, &duplicate);
  napi_create_function(env, "close", NAPI_AUTO_LENGTH, Close, nullptr, &close);
  napi_create_function(env, "launchWithHook", NAPI_AUTO_LENGTH, LaunchWithHook, nullptr, &launchWithHook);
  napi_create_function(env, "readback", NAPI_AUTO_LENGTH, Readback, nullptr, &readback);
  napi_create_function(env, "assignToKillJob", NAPI_AUTO_LENGTH, AssignToKillJob, nullptr, &assignToKillJob);
  napi_create_function(env, "setJobKillOnClose", NAPI_AUTO_LENGTH, SetJobKillOnClose, nullptr, &setJobKillOnClose);
  napi_set_named_property(env, exports, "duplicate", duplicate);
  napi_set_named_property(env, exports, "close", close);
  napi_set_named_property(env, exports, "launchWithHook", launchWithHook);
  napi_set_named_property(env, exports, "readback", readback);
  napi_set_named_property(env, exports, "assignToKillJob", assignToKillJob);
  napi_set_named_property(env, exports, "setJobKillOnClose", setJobKillOnClose);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
