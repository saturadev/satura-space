#include <d3d11_1.h>
#include <dxgi1_2.h>
#include <cstdint>
#include <cstdlib>
#include <cstring>

#include "UnityPluginAPI/IUnityInterface.h"
#include "UnityPluginAPI/IUnityGraphics.h"
#include "UnityPluginAPI/IUnityGraphicsD3D11.h"

#define SS_EXPORT extern "C" __declspec(dllexport)

#include <cstdio>
#include <cstdarg>
static void SSLOG(const char* fmt, ...) {
    char* path = nullptr;
    size_t len = 0;
    if (_dupenv_s(&path, &len, "SATURA_SS_LOG") != 0 || !path) return;
    FILE* f = nullptr;
    if (fopen_s(&f, path, "a") == 0 && f) {
        va_list a;
        va_start(a, fmt);
        vfprintf(f, fmt, a);
        fputc('\n', f);
        va_end(a);
        fclose(f);
    }
    free(path);
}

static IUnityInterfaces* s_Interfaces = nullptr;
static IUnityGraphics* s_Graphics = nullptr;
static IUnityGraphicsD3D11* s_D3D11 = nullptr;
static ID3D11DeviceContext* s_immediateCtx = nullptr;

static ID3D11DeviceContext* ImmediateContext() {
    if (s_immediateCtx) return s_immediateCtx;
    if (!s_D3D11) return nullptr;
    ID3D11Device* device = s_D3D11->GetDevice();
    if (!device) return nullptr;
    device->GetImmediateContext(&s_immediateCtx);
    return s_immediateCtx;
}

static const int kMaxRing = 8;

static const LONG kSlotIdle = 0;
static const LONG kSlotQueued = 1;
static const LONG kSlotSubmitted = 2;

struct SSHandle {
    int count;
    int width;
    int height;
    LONG epoch;
    volatile LONG lost;
    ID3D11Texture2D* textures[kMaxRing];
    HANDLE sharedHandles[kMaxRing];
    uint32_t surfaceIds[kMaxRing];
    ID3D11Query* queries[kMaxRing];
    volatile LONG states[kMaxRing];
};

static volatile LONG s_deviceEpoch = 0;

static const int kMaxPending = 64;
struct PendingCopy { SSHandle* hnd; int slot; ID3D11Resource* src; };
static PendingCopy s_pending[kMaxPending] = {};
static int s_pendingTicket = 0;

static const int kMaxHandles = 16;
static SSHandle* s_registry[kMaxHandles] = {};
static SRWLOCK s_lock = SRWLOCK_INIT;

static void UNITY_INTERFACE_API OnGraphicsDeviceEvent(UnityGfxDeviceEventType eventType) {
    if (eventType != kUnityGfxDeviceEventInitialize && eventType != kUnityGfxDeviceEventShutdown
        && eventType != kUnityGfxDeviceEventBeforeReset)
        return;
    AcquireSRWLockExclusive(&s_lock);
    if (s_immediateCtx) { s_immediateCtx->Release(); s_immediateCtx = nullptr; }
    InterlockedIncrement(&s_deviceEpoch);
    ReleaseSRWLockExclusive(&s_lock);
    SSLOG("[ss] device event %d epoch=%ld", (int)eventType, (long)s_deviceEpoch);
}

SS_EXPORT void UNITY_INTERFACE_API
UnityPluginLoad(IUnityInterfaces* unityInterfaces) {
    s_Interfaces = unityInterfaces;
    s_Graphics = unityInterfaces->Get<IUnityGraphics>();
    s_D3D11 = unityInterfaces->Get<IUnityGraphicsD3D11>();
    if (s_Graphics) s_Graphics->RegisterDeviceEventCallback(OnGraphicsDeviceEvent);
    SSLOG("[ss] UnityPluginLoad graphics=%p d3d11=%p renderer=%d", (void*)s_Graphics, (void*)s_D3D11,
          s_Graphics ? (int)s_Graphics->GetRenderer() : -1);
}

static uint8_t* s_flipScratch = nullptr;
static size_t s_flipScratchLen = 0;

SS_EXPORT void UNITY_INTERFACE_API UnityPluginUnload() {
    if (s_Graphics) s_Graphics->UnregisterDeviceEventCallback(OnGraphicsDeviceEvent);
    if (s_immediateCtx) { s_immediateCtx->Release(); s_immediateCtx = nullptr; }
    if (s_flipScratch) { free(s_flipScratch); s_flipScratch = nullptr; s_flipScratchLen = 0; }
    s_D3D11 = nullptr;
    s_Graphics = nullptr;
    s_Interfaces = nullptr;
}

static bool MakeSlot(ID3D11Device* device, int w, int h,
                     ID3D11Texture2D** outTexture, HANDLE* outHandle, uint32_t* outId,
                     ID3D11Query** outQuery) {
    D3D11_TEXTURE2D_DESC desc = {};
    desc.Width = (UINT)w;
    desc.Height = (UINT)h;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_TYPELESS;
    desc.SampleDesc.Count = 1;
    desc.SampleDesc.Quality = 0;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_SHADER_RESOURCE | D3D11_BIND_RENDER_TARGET;
    desc.CPUAccessFlags = 0;
    desc.MiscFlags = D3D11_RESOURCE_MISC_SHARED | D3D11_RESOURCE_MISC_SHARED_NTHANDLE;

    ID3D11Texture2D* tex = nullptr;
    HRESULT hrTex = device->CreateTexture2D(&desc, nullptr, &tex);
    if (FAILED(hrTex) || !tex) {
        SSLOG("[ss] CreateTexture2D failed hr=0x%08lx", (unsigned long)hrTex);
        return false;
    }

    IDXGIResource1* dxgiRes = nullptr;
    HRESULT hrQI = tex->QueryInterface(__uuidof(IDXGIResource1), (void**)&dxgiRes);
    if (FAILED(hrQI) || !dxgiRes) {
        SSLOG("[ss] QueryInterface(IDXGIResource1) failed hr=0x%08lx", (unsigned long)hrQI);
        tex->Release();
        return false;
    }

    HANDLE shared = nullptr;
    HRESULT hr = dxgiRes->CreateSharedHandle(
        nullptr, DXGI_SHARED_RESOURCE_READ | DXGI_SHARED_RESOURCE_WRITE, nullptr, &shared);
    dxgiRes->Release();
    if (FAILED(hr) || !shared) {
        SSLOG("[ss] CreateSharedHandle failed hr=0x%08lx", (unsigned long)hr);
        tex->Release();
        return false;
    }

    ID3D11Query* query = nullptr;
    D3D11_QUERY_DESC qd = {};
    qd.Query = D3D11_QUERY_EVENT;
    HRESULT hrQ = device->CreateQuery(&qd, &query);
    if (FAILED(hrQ)) {
        SSLOG("[ss] CreateQuery failed hr=0x%08lx (slot readiness disabled)", (unsigned long)hrQ);
        query = nullptr;
    }

    *outTexture = tex;
    *outHandle = shared;
    *outId = (uint32_t)(uintptr_t)shared;
    *outQuery = query;
    return true;
}

static void RegisterHandle(SSHandle* hnd) {
    AcquireSRWLockExclusive(&s_lock);
    for (int i = 0; i < kMaxHandles; i++) {
        if (!s_registry[i]) { s_registry[i] = hnd; break; }
    }
    ReleaseSRWLockExclusive(&s_lock);
}

static void FreeHandleContents(SSHandle* hnd) {
    for (int i = 0; i < hnd->count; i++) {
        if (hnd->queries[i]) hnd->queries[i]->Release();
        if (hnd->sharedHandles[i]) CloseHandle(hnd->sharedHandles[i]);
        if (hnd->textures[i]) hnd->textures[i]->Release();
    }
}

SS_EXPORT void* satura_ss_create(int w, int h, int count) {
    SSLOG("[ss] satura_ss_create w=%d h=%d count=%d d3d11=%p", w, h, count, (void*)s_D3D11);
    if (!s_D3D11 || w <= 0 || h <= 0) return nullptr;
    ID3D11Device* device = s_D3D11->GetDevice();
    if (!device) {
        SSLOG("[ss] GetDevice() returned null");
        return nullptr;
    }
    if (count < 1) count = 1;
    if (count > kMaxRing) count = kMaxRing;

    SSHandle* hnd = new SSHandle();
    hnd->count = 0;
    hnd->width = w;
    hnd->height = h;
    hnd->epoch = s_deviceEpoch;
    hnd->lost = 0;
    for (int i = 0; i < kMaxRing; i++) {
        hnd->textures[i] = nullptr;
        hnd->sharedHandles[i] = nullptr;
        hnd->surfaceIds[i] = 0;
        hnd->queries[i] = nullptr;
        hnd->states[i] = kSlotIdle;
    }

    for (int i = 0; i < count; i++) {
        if (!MakeSlot(device, w, h, &hnd->textures[i], &hnd->sharedHandles[i],
                      &hnd->surfaceIds[i], &hnd->queries[i])) {
            hnd->count = i;
            FreeHandleContents(hnd);
            delete hnd;
            return nullptr;
        }
        hnd->count = i + 1;
    }
    RegisterHandle(hnd);
    return hnd;
}

SS_EXPORT int satura_ss_count(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    return hnd ? hnd->count : 0;
}

SS_EXPORT void* satura_ss_texture_ptr(void* handle, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count) return nullptr;
    return hnd->textures[slot];
}

SS_EXPORT unsigned int satura_ss_surface_id(void* handle, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count) return 0;
    return hnd->surfaceIds[slot];
}

SS_EXPORT int satura_ss_slot_ready(void* handle, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count) return 0;
    return hnd->states[slot] == kSlotIdle ? 1 : 0;
}

SS_EXPORT int satura_ss_device_lost(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd) return 0;
    if (hnd->lost) return 1;
    return hnd->epoch != s_deviceEpoch ? 1 : 0;
}

SS_EXPORT void satura_ss_reset(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd) return;
    AcquireSRWLockExclusive(&s_lock);
    for (int i = 0; i < kMaxPending; i++) {
        if (s_pending[i].hnd == hnd) {
            if (s_pending[i].src) s_pending[i].src->Release();
            s_pending[i].hnd = nullptr;
            s_pending[i].src = nullptr;
            s_pending[i].slot = 0;
        }
    }
    for (int i = 0; i < hnd->count; i++) InterlockedExchange(&hnd->states[i], kSlotIdle);
    ReleaseSRWLockExclusive(&s_lock);
    SSLOG("[ss] satura_ss_reset %p", handle);
}

SS_EXPORT void satura_ss_flush(void*) {
    ID3D11DeviceContext* ctx = ImmediateContext();
    if (ctx) ctx->Flush();
}

SS_EXPORT int satura_ss_upload_bytes(void* handle, int slot, const void* pixels, int len, int flipY) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count || !pixels) return 0;
    ID3D11Texture2D* dst = hnd->textures[slot];
    if (!dst) return 0;
    UINT rowPitch = (UINT)hnd->width * 4u;
    size_t needed = (size_t)rowPitch * (size_t)hnd->height;
    if ((size_t)len < needed) return 0;
    ID3D11DeviceContext* ctx = ImmediateContext();
    if (!ctx) return 0;

    const void* upload = pixels;
    if (flipY) {
        if (s_flipScratchLen < needed) {
            free(s_flipScratch);
            s_flipScratch = (uint8_t*)malloc(needed);
            s_flipScratchLen = s_flipScratch ? needed : 0;
        }
        if (!s_flipScratch) return 0;
        const uint8_t* src = (const uint8_t*)pixels;
        for (UINT y = 0; y < (UINT)hnd->height; y++) {
            memcpy(s_flipScratch + (size_t)y * rowPitch,
                   src + (size_t)(hnd->height - 1 - y) * rowPitch, rowPitch);
        }
        upload = s_flipScratch;
    }

    ctx->UpdateSubresource(dst, 0, nullptr, upload, rowPitch, 0);
    ctx->Flush();
    return 1;
}

SS_EXPORT int satura_ss_set_pending_copy(void* handle, void* srcTexture, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count || !srcTexture) return -1;
    AcquireSRWLockExclusive(&s_lock);
    if (hnd->states[slot] != kSlotIdle) {
        ReleaseSRWLockExclusive(&s_lock);
        return -1;
    }
    int ticket = s_pendingTicket;
    s_pendingTicket = (s_pendingTicket + 1) % kMaxPending;
    if (s_pending[ticket].src) {
        s_pending[ticket].src->Release();
        if (s_pending[ticket].hnd)
            InterlockedExchange(&s_pending[ticket].hnd->states[s_pending[ticket].slot], kSlotIdle);
    }
    ID3D11Resource* src = (ID3D11Resource*)srcTexture;
    src->AddRef();
    s_pending[ticket].hnd = hnd;
    s_pending[ticket].slot = slot;
    s_pending[ticket].src = src;
    InterlockedExchange(&hnd->states[slot], kSlotQueued);
    ReleaseSRWLockExclusive(&s_lock);
    return ticket;
}

static void PollHandle(ID3D11DeviceContext* ctx, SSHandle* hnd) {
    for (int i = 0; i < hnd->count; i++) {
        if (hnd->states[i] != kSlotSubmitted) continue;
        if (!hnd->queries[i]) {
            InterlockedExchange(&hnd->states[i], kSlotIdle);
            continue;
        }
        HRESULT hr = ctx->GetData(hnd->queries[i], nullptr, 0, D3D11_ASYNC_GETDATA_DONOTFLUSH);
        if (hr == S_OK) {
            InterlockedExchange(&hnd->states[i], kSlotIdle);
        } else if (FAILED(hr)) {
            SSLOG("[ss] GetData failed hr=0x%08lx — marking handle lost", (unsigned long)hr);
            InterlockedExchange(&hnd->lost, 1);
            InterlockedExchange(&hnd->states[i], kSlotIdle);
        }
    }
}

static void UNITY_INTERFACE_API OnRenderEvent(int eventId) {
    if (!s_D3D11) return;
    ID3D11DeviceContext* ctx = ImmediateContext();
    if (!ctx) return;
    AcquireSRWLockExclusive(&s_lock);
    for (int i = 0; i < kMaxHandles; i++) {
        if (s_registry[i]) PollHandle(ctx, s_registry[i]);
    }
    if (eventId >= 0 && eventId < kMaxPending) {
        PendingCopy pc = s_pending[eventId];
        s_pending[eventId].hnd = nullptr;
        s_pending[eventId].src = nullptr;
        if (pc.hnd && pc.hnd->lost) {
            if (pc.slot >= 0 && pc.slot < pc.hnd->count)
                InterlockedExchange(&pc.hnd->states[pc.slot], kSlotIdle);
        } else if (pc.hnd && pc.src && pc.slot >= 0 && pc.slot < pc.hnd->count && pc.hnd->textures[pc.slot]) {
            ctx->CopyResource(pc.hnd->textures[pc.slot], pc.src);
            if (pc.hnd->queries[pc.slot]) {
                ctx->End(pc.hnd->queries[pc.slot]);
                ctx->Flush();
                InterlockedExchange(&pc.hnd->states[pc.slot], kSlotSubmitted);
            } else {
                ctx->Flush();
                InterlockedExchange(&pc.hnd->states[pc.slot], kSlotIdle);
            }
        } else if (pc.hnd && pc.slot >= 0 && pc.slot < pc.hnd->count) {
            InterlockedExchange(&pc.hnd->states[pc.slot], kSlotIdle);
        }
        if (pc.src) pc.src->Release();
    }
    ReleaseSRWLockExclusive(&s_lock);
}

SS_EXPORT void* satura_ss_get_copy_callback() {
    return (void*)OnRenderEvent;
}

SS_EXPORT void satura_ss_destroy(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd) return;
    AcquireSRWLockExclusive(&s_lock);
    for (int i = 0; i < kMaxPending; i++) {
        if (s_pending[i].hnd == hnd) {
            if (s_pending[i].src) s_pending[i].src->Release();
            s_pending[i].hnd = nullptr;
            s_pending[i].src = nullptr;
        }
    }
    for (int i = 0; i < kMaxHandles; i++) {
        if (s_registry[i] == hnd) s_registry[i] = nullptr;
    }
    FreeHandleContents(hnd);
    ReleaseSRWLockExclusive(&s_lock);
    delete hnd;
}
