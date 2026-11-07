#include <node_api.h>
#import <IOSurface/IOSurface.h>
#import <CoreFoundation/CoreFoundation.h>
#import <AppKit/AppKit.h>
#include <stdlib.h>
#include <unordered_map>

static std::unordered_map<uint32_t, IOSurfaceRef> g_retained;
static uint32_t g_nextToken = 0;

typedef struct { double dx; double dy; } MouseDelta;

static napi_threadsafe_function g_mouseTsfn = nullptr;
static id g_mouseMonitor = nil;

static void CallMouseJs(napi_env env, napi_value cb, void* ctx, void* data) {
  MouseDelta* d = (MouseDelta*)data;
  if (env && cb) {
    napi_value undef, ax, ay;
    napi_get_undefined(env, &undef);
    napi_create_double(env, d->dx, &ax);
    napi_create_double(env, d->dy, &ay);
    napi_value argv[2] = { ax, ay };
    napi_call_function(env, undef, cb, 2, argv, nullptr);
  }
  free(d);
}

static napi_value StartMouseDeltas(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  napi_value result;
  if (g_mouseMonitor) {
    napi_get_boolean(env, true, &result);
    return result;
  }
  napi_value name;
  napi_create_string_utf8(env, "mouseDeltas", NAPI_AUTO_LENGTH, &name);
  if (napi_create_threadsafe_function(env, argv[0], nullptr, name, 512, 1, nullptr, nullptr,
                                      nullptr, CallMouseJs, &g_mouseTsfn) != napi_ok) {
    napi_get_boolean(env, false, &result);
    return result;
  }
  napi_unref_threadsafe_function(env, g_mouseTsfn);
  NSEventMask mask = NSEventMaskMouseMoved | NSEventMaskLeftMouseDragged |
                     NSEventMaskRightMouseDragged | NSEventMaskOtherMouseDragged;
  g_mouseMonitor = [NSEvent addLocalMonitorForEventsMatchingMask:mask
                                                         handler:^NSEvent*(NSEvent* e) {
    double dx = [e deltaX];
    double dy = [e deltaY];
    if ((dx != 0.0 || dy != 0.0) && g_mouseTsfn) {
      MouseDelta* d = (MouseDelta*)malloc(sizeof(MouseDelta));
      d->dx = dx;
      d->dy = dy;
      if (napi_call_threadsafe_function(g_mouseTsfn, d, napi_tsfn_nonblocking) != napi_ok) free(d);
    }
    return e;
  }];
  napi_get_boolean(env, g_mouseMonitor != nil, &result);
  return result;
}

static napi_value Lookup(napi_env env, napi_callback_info info) {
  size_t argc = 3;
  napi_value argv[3];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t id = 0, want_w = 0, want_h = 0;
  napi_get_value_uint32(env, argv[0], &id);
  if (argc >= 3) {
    napi_get_value_uint32(env, argv[1], &want_w);
    napi_get_value_uint32(env, argv[2], &want_h);
  }

  napi_value result;
  napi_create_object(env, &result);
  IOSurfaceRef surface = IOSurfaceLookup((IOSurfaceID)id);
  if (!surface) {
    napi_value err;
    napi_create_string_utf8(env, "missing", NAPI_AUTO_LENGTH, &err);
    napi_set_named_property(env, result, "error", err);
    return result;
  }
  uint32_t got_w = (uint32_t)IOSurfaceGetWidth(surface);
  uint32_t got_h = (uint32_t)IOSurfaceGetHeight(surface);
  if ((want_w && got_w != want_w) || (want_h && got_h != want_h)) {
    CFRelease(surface);
    napi_value err, w, h;
    napi_create_string_utf8(env, "size", NAPI_AUTO_LENGTH, &err);
    napi_create_uint32(env, got_w, &w);
    napi_create_uint32(env, got_h, &h);
    napi_set_named_property(env, result, "error", err);
    napi_set_named_property(env, result, "width", w);
    napi_set_named_property(env, result, "height", h);
    return result;
  }

  uint32_t token = ++g_nextToken;
  if (token == 0) token = ++g_nextToken;
  g_retained[token] = surface;

  void* copy = nullptr;
  napi_value buf, tok;
  IOSurfaceRef value = surface;
  napi_create_buffer_copy(env, sizeof(IOSurfaceRef), &value, &copy, &buf);
  napi_create_uint32(env, token, &tok);
  napi_set_named_property(env, result, "handle", buf);
  napi_set_named_property(env, result, "token", tok);
  return result;
}

static napi_value Release(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr);
  uint32_t token = 0;
  napi_get_value_uint32(env, argv[0], &token);

  napi_value out;
  auto it = g_retained.find(token);
  if (it != g_retained.end()) {
    CFRelease(it->second);
    g_retained.erase(it);
    napi_get_boolean(env, true, &out);
  } else {
    napi_get_boolean(env, false, &out);
  }
  return out;
}

static napi_value Retained(napi_env env, napi_callback_info info) {
  napi_value out;
  napi_create_uint32(env, (uint32_t)g_retained.size(), &out);
  return out;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value lookup, release, retained, startMouse;
  napi_create_function(env, "lookup", NAPI_AUTO_LENGTH, Lookup, nullptr, &lookup);
  napi_create_function(env, "release", NAPI_AUTO_LENGTH, Release, nullptr, &release);
  napi_create_function(env, "retained", NAPI_AUTO_LENGTH, Retained, nullptr, &retained);
  napi_create_function(env, "startMouseDeltas", NAPI_AUTO_LENGTH, StartMouseDeltas, nullptr,
                       &startMouse);
  napi_set_named_property(env, exports, "lookup", lookup);
  napi_set_named_property(env, exports, "release", release);
  napi_set_named_property(env, exports, "retained", retained);
  napi_set_named_property(env, exports, "startMouseDeltas", startMouse);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
