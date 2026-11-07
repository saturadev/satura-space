#include "UnityPluginAPI/IUnityInterface.h"
#include "UnityPluginAPI/IUnityGraphics.h"
#include "UnityPluginAPI/IUnityGraphicsMetal.h"
#import <Metal/Metal.h>
#import <IOSurface/IOSurface.h>
#import <Foundation/Foundation.h>
#include <cstdint>
#include <mutex>

static IUnityInterfaces* s_Interfaces = nullptr;
static IUnityGraphics* s_Graphics = nullptr;
static IUnityGraphicsMetal* s_Metal = nullptr;
static id<MTLCommandQueue> s_fallbackQueue = nil;

static IUnityGraphicsMetal* MetalInterface(void) {
    if (!s_Metal && s_Interfaces) s_Metal = s_Interfaces->Get<IUnityGraphicsMetal>();
    return s_Metal;
}

static const int kMaxRing = 8;

static const int kSlotIdle = 0;
static const int kSlotQueued = 1;
static const int kSlotSubmitted = 2;

struct SSHandle {
    int count;
    int width;
    int height;
    uint64_t epoch;
    int lost;
    IOSurfaceRef surfaces[kMaxRing];
    void* texturePtrs[kMaxRing];
    uint32_t surfaceIds[kMaxRing];
    int states[kMaxRing];
    uint64_t slotGen[kMaxRing];
};

static uint64_t s_deviceEpoch = 0;
static uint64_t s_genCounter = 0;

static const int kMaxPending = 64;
struct PendingCopy { SSHandle* hnd; int slot; void* src; };
static PendingCopy s_pending[kMaxPending] = {};
static int s_pendingTicket = 0;

static const int kMaxHandles = 16;
static SSHandle* s_registry[kMaxHandles] = {};
static std::mutex s_lock;

static bool Registered(SSHandle* hnd) {
    for (int i = 0; i < kMaxHandles; i++) {
        if (s_registry[i] == hnd) return true;
    }
    return false;
}

static void UNITY_INTERFACE_API OnGraphicsDeviceEvent(UnityGfxDeviceEventType eventType) {
    if (eventType != kUnityGfxDeviceEventInitialize && eventType != kUnityGfxDeviceEventShutdown
        && eventType != kUnityGfxDeviceEventBeforeReset)
        return;
    std::lock_guard<std::mutex> guard(s_lock);
    s_fallbackQueue = nil;
    s_deviceEpoch++;
}

extern "C" void UNITY_INTERFACE_EXPORT UNITY_INTERFACE_API
UnityPluginLoad(IUnityInterfaces* unityInterfaces) {
    s_Interfaces = unityInterfaces;
    s_Graphics = unityInterfaces->Get<IUnityGraphics>();
    s_Metal = unityInterfaces->Get<IUnityGraphicsMetal>();
    if (s_Graphics) s_Graphics->RegisterDeviceEventCallback(OnGraphicsDeviceEvent);
}

extern "C" void UNITY_INTERFACE_EXPORT UNITY_INTERFACE_API UnityPluginUnload() {
    if (s_Graphics) s_Graphics->UnregisterDeviceEventCallback(OnGraphicsDeviceEvent);
    s_fallbackQueue = nil;
    s_Metal = nullptr;
    s_Graphics = nullptr;
    s_Interfaces = nullptr;
}

static size_t AlignedBytesPerRow(id<MTLDevice> device, int w) {
    size_t row = IOSurfaceAlignProperty(kIOSurfaceBytesPerRow, (size_t)w * 4);
    NSUInteger align = [device minimumLinearTextureAlignmentForPixelFormat:MTLPixelFormatRGBA8Unorm];
    if (align < 16) align = 16;
    return (row + align - 1) / align * align;
}

static bool MakeSlot(id<MTLDevice> device, int w, int h,
                     IOSurfaceRef* outSurface, void** outTexturePtr, uint32_t* outId) {
    size_t bytesPerRow = AlignedBytesPerRow(device, w);
    NSDictionary* props = @{
        (id)kIOSurfaceWidth: @(w),
        (id)kIOSurfaceHeight: @(h),
        (id)kIOSurfaceBytesPerElement: @(4),
        (id)kIOSurfaceBytesPerRow: @(bytesPerRow),
        (id)kIOSurfaceAllocSize: @(bytesPerRow * (size_t)h),
        (id)kIOSurfacePixelFormat: @((unsigned int)0x52474241),
        @"IOSurfaceIsGlobal": @YES
    };
    IOSurfaceRef surface = IOSurfaceCreate((__bridge CFDictionaryRef)props);
    if (!surface) return false;

    MTLTextureDescriptor* desc =
        [MTLTextureDescriptor texture2DDescriptorWithPixelFormat:MTLPixelFormatRGBA8Unorm
                                                           width:w
                                                          height:h
                                                       mipmapped:NO];
    desc.usage = MTLTextureUsageShaderRead | MTLTextureUsageRenderTarget | MTLTextureUsageShaderWrite;
    desc.storageMode = MTLStorageModeShared;

    id<MTLTexture> texture = [device newTextureWithDescriptor:desc iosurface:surface plane:0];
    if (!texture) {
        CFRelease(surface);
        return false;
    }

    *outSurface = surface;
    *outTexturePtr = (void*)CFBridgingRetain(texture);
    *outId = IOSurfaceGetID(surface);
    return true;
}

extern "C" void* UNITY_INTERFACE_EXPORT satura_ss_create(int w, int h, int count) {
    IUnityGraphicsMetal* metal = MetalInterface();
    if (!metal || w <= 0 || h <= 0) return nullptr;
    id<MTLDevice> device = metal->MetalDevice();
    if (!device) return nullptr;
    if (count < 1) count = 1;
    if (count > kMaxRing) count = kMaxRing;

    SSHandle* hnd = new SSHandle();
    hnd->count = 0;
    hnd->width = w;
    hnd->height = h;
    hnd->lost = 0;
    for (int i = 0; i < kMaxRing; i++) {
        hnd->surfaces[i] = nullptr;
        hnd->texturePtrs[i] = nullptr;
        hnd->surfaceIds[i] = 0;
        hnd->states[i] = kSlotIdle;
        hnd->slotGen[i] = 0;
    }

    for (int i = 0; i < count; i++) {
        if (!MakeSlot(device, w, h, &hnd->surfaces[i], &hnd->texturePtrs[i], &hnd->surfaceIds[i])) {
            for (int j = 0; j < i; j++) {
                if (hnd->texturePtrs[j]) CFBridgingRelease(hnd->texturePtrs[j]);
                if (hnd->surfaces[j]) CFRelease(hnd->surfaces[j]);
            }
            delete hnd;
            return nullptr;
        }
        hnd->count = i + 1;
    }
    std::lock_guard<std::mutex> guard(s_lock);
    hnd->epoch = s_deviceEpoch;
    for (int i = 0; i < kMaxHandles; i++) {
        if (!s_registry[i]) { s_registry[i] = hnd; break; }
    }
    return hnd;
}

extern "C" int UNITY_INTERFACE_EXPORT satura_ss_count(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    return hnd ? hnd->count : 0;
}

extern "C" void* UNITY_INTERFACE_EXPORT satura_ss_texture_ptr(void* handle, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count) return nullptr;
    return hnd->texturePtrs[slot];
}

extern "C" unsigned int UNITY_INTERFACE_EXPORT satura_ss_surface_id(void* handle, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count) return 0;
    return hnd->surfaceIds[slot];
}

extern "C" int UNITY_INTERFACE_EXPORT satura_ss_slot_ready(void* handle, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count) return 0;
    std::lock_guard<std::mutex> guard(s_lock);
    return hnd->states[slot] == kSlotIdle ? 1 : 0;
}

extern "C" int UNITY_INTERFACE_EXPORT satura_ss_device_lost(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd) return 0;
    std::lock_guard<std::mutex> guard(s_lock);
    if (hnd->lost) return 1;
    return hnd->epoch != s_deviceEpoch ? 1 : 0;
}

extern "C" void UNITY_INTERFACE_EXPORT satura_ss_reset(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd) return;
    std::lock_guard<std::mutex> guard(s_lock);
    for (int i = 0; i < kMaxPending; i++) {
        if (s_pending[i].hnd == hnd) {
            if (s_pending[i].src) CFRelease(s_pending[i].src);
            s_pending[i].hnd = nullptr;
            s_pending[i].src = nullptr;
            s_pending[i].slot = 0;
        }
    }
    for (int i = 0; i < hnd->count; i++) {
        hnd->states[i] = kSlotIdle;
        hnd->slotGen[i] = ++s_genCounter;
    }
}

extern "C" int UNITY_INTERFACE_EXPORT satura_ss_set_pending_copy(void* handle, void* srcTexture, int slot) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd || slot < 0 || slot >= hnd->count || !srcTexture) return -1;
    std::lock_guard<std::mutex> guard(s_lock);
    if (hnd->states[slot] != kSlotIdle) return -1;
    int ticket = s_pendingTicket;
    s_pendingTicket = (s_pendingTicket + 1) % kMaxPending;
    if (s_pending[ticket].src) {
        CFRelease(s_pending[ticket].src);
        if (s_pending[ticket].hnd && Registered(s_pending[ticket].hnd))
            s_pending[ticket].hnd->states[s_pending[ticket].slot] = kSlotIdle;
    }
    CFRetain(srcTexture);
    s_pending[ticket].hnd = hnd;
    s_pending[ticket].slot = slot;
    s_pending[ticket].src = srcTexture;
    hnd->states[slot] = kSlotQueued;
    return ticket;
}

static void UNITY_INTERFACE_API OnRenderEvent(int eventId) {
    if (eventId < 0 || eventId >= kMaxPending) return;
    IUnityGraphicsMetal* metal = MetalInterface();
    std::lock_guard<std::mutex> guard(s_lock);
    PendingCopy pc = s_pending[eventId];
    s_pending[eventId].hnd = nullptr;
    s_pending[eventId].src = nullptr;
    s_pending[eventId].slot = 0;
    bool valid = pc.hnd && Registered(pc.hnd) && pc.slot >= 0 && pc.slot < pc.hnd->count
                 && pc.src && pc.hnd->texturePtrs[pc.slot];
    if (valid && metal) {
        id<MTLTexture> src = (__bridge id<MTLTexture>)pc.src;
        id<MTLTexture> dst = (__bridge id<MTLTexture>)pc.hnd->texturePtrs[pc.slot];
        bool own = false;
        id<MTLCommandBuffer> cb = metal->CurrentCommandBuffer();
        if (cb && cb.status == MTLCommandBufferStatusNotEnqueued) {
            metal->EndCurrentCommandEncoder();
        } else {
            cb = nil;
            id<MTLDevice> device = metal->MetalDevice();
            if (device) {
                if (!s_fallbackQueue) s_fallbackQueue = [device newCommandQueue];
                if (s_fallbackQueue) {
                    cb = [s_fallbackQueue commandBuffer];
                    own = true;
                }
            }
        }
        if (cb && src.width == dst.width && src.height == dst.height && src.sampleCount == 1) {
            id<MTLBlitCommandEncoder> blit = [cb blitCommandEncoder];
            [blit copyFromTexture:src
                      sourceSlice:0
                      sourceLevel:0
                     sourceOrigin:MTLOriginMake(0, 0, 0)
                       sourceSize:MTLSizeMake(dst.width, dst.height, 1)
                        toTexture:dst
                 destinationSlice:0
                 destinationLevel:0
                destinationOrigin:MTLOriginMake(0, 0, 0)];
            [blit endEncoding];
            SSHandle* hnd = pc.hnd;
            int slot = pc.slot;
            uint64_t gen = ++s_genCounter;
            hnd->slotGen[slot] = gen;
            hnd->states[slot] = kSlotSubmitted;
            [cb addCompletedHandler:^(id<MTLCommandBuffer> done) {
                (void)done;
                (void)src;
                (void)dst;
                std::lock_guard<std::mutex> g(s_lock);
                if (Registered(hnd) && slot < hnd->count && hnd->slotGen[slot] == gen)
                    hnd->states[slot] = kSlotIdle;
            }];
            if (own) [cb commit];
        } else {
            pc.hnd->states[pc.slot] = kSlotIdle;
        }
    } else if (pc.hnd && Registered(pc.hnd) && pc.slot >= 0 && pc.slot < pc.hnd->count) {
        pc.hnd->states[pc.slot] = kSlotIdle;
    }
    if (pc.src) CFRelease(pc.src);
}

extern "C" void* UNITY_INTERFACE_EXPORT satura_ss_get_copy_callback() {
    return (void*)OnRenderEvent;
}

extern "C" void UNITY_INTERFACE_EXPORT satura_ss_destroy(void* handle) {
    SSHandle* hnd = (SSHandle*)handle;
    if (!hnd) return;
    {
        std::lock_guard<std::mutex> guard(s_lock);
        for (int i = 0; i < kMaxPending; i++) {
            if (s_pending[i].hnd == hnd) {
                if (s_pending[i].src) CFRelease(s_pending[i].src);
                s_pending[i].hnd = nullptr;
                s_pending[i].src = nullptr;
                s_pending[i].slot = 0;
            }
        }
        for (int i = 0; i < kMaxHandles; i++) {
            if (s_registry[i] == hnd) s_registry[i] = nullptr;
        }
        for (int i = 0; i < hnd->count; i++) {
            if (hnd->texturePtrs[i]) CFBridgingRelease(hnd->texturePtrs[i]);
            if (hnd->surfaces[i]) CFRelease(hnd->surfaces[i]);
        }
    }
    delete hnd;
}
