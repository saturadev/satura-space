#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>

#define REVEAL_ABSENT 0
#define REVEAL_WANT   (1 << 0)
#define REVEAL_SHOWN  (1 << 1)
#define REVEAL_READY  (1 << 2)
#define REVEAL_PRESENT (1 << 3)

#define HIDE_ENFORCE_TICKS 12

static void HLOG(const char* fmt, ...) {
    char* path = NULL; size_t len = 0;
    if (_dupenv_s(&path, &len, "SATURA_WINHOOK_LOG") != 0 || !path) return;
    FILE* f = NULL;
    if (fopen_s(&f, path, "a") == 0 && f) {
        va_list a; va_start(a, fmt);
        vfprintf(f, fmt, a); fputc('\n', f); fflush(f);
        va_end(a); fclose(f);
    }
    free(path);
}

typedef BOOL (WINAPI* ShowWindow_t)(HWND, int);
typedef BOOL (WINAPI* SetWindowPos_t)(HWND, HWND, int, int, int, int, UINT);
typedef HWND (WINAPI* CreateWindowExW_t)(DWORD, LPCWSTR, LPCWSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
typedef HWND (WINAPI* CreateWindowExA_t)(DWORD, LPCSTR, LPCSTR, DWORD, int, int, int, int, HWND, HMENU, HINSTANCE, LPVOID);
typedef BOOL (WINAPI* Beep_t)(DWORD, DWORD);
typedef BOOL (WINAPI* NtUserMessageBeep_t)(UINT);

static ShowWindow_t         real_ShowWindow;
static ShowWindow_t         real_ShowWindowAsync;
static SetWindowPos_t       real_SetWindowPos;
static CreateWindowExW_t    real_CreateWindowExW;
static CreateWindowExA_t    real_CreateWindowExA;
static Beep_t               real_Beep;

static volatile LONG g_reveal;

// A blocking modal (EditorUtility.DisplayDialog: "Recovering Scene Backups", API-update prompts, save
// prompts, …) halts the editor until the user answers. Keeping it hidden makes it un-clickable, so
// let modal dialogs through the hide hooks (and surface them in the sweep below) instead of hiding
// or closing them. Uses the same classifier that previously chose which dialogs to dismiss.
static int LooksLikeModalDialog(HWND hwnd);

static int IsChildWindow(HWND hwnd) {
    return (GetWindowLongPtrW(hwnd, GWL_STYLE) & WS_CHILD) != 0;
}

static BOOL WINAPI my_ShowWindow(HWND h, int cmd) {
    if (g_reveal || IsChildWindow(h) || LooksLikeModalDialog(h)) return real_ShowWindow(h, cmd);
    return real_ShowWindow(h, SW_HIDE);
}
static BOOL WINAPI my_ShowWindowAsync(HWND h, int cmd) {
    if (g_reveal || IsChildWindow(h) || LooksLikeModalDialog(h)) return real_ShowWindowAsync(h, cmd);
    return real_ShowWindowAsync(h, SW_HIDE);
}
static BOOL WINAPI my_SetWindowPos(HWND h, HWND ins, int x, int y, int cx, int cy, UINT flags) {
    if (g_reveal || IsChildWindow(h) || LooksLikeModalDialog(h)) return real_SetWindowPos(h, ins, x, y, cx, cy, flags);
    flags = (flags & ~SWP_SHOWWINDOW) | SWP_HIDEWINDOW;
    return real_SetWindowPos(h, ins, x, y, cx, cy, flags);
}
static HWND WINAPI my_CreateWindowExW(DWORD ex, LPCWSTR cls, LPCWSTR name, DWORD style,
                                      int x, int y, int w, int h, HWND parent, HMENU menu, HINSTANCE inst, LPVOID p) {
    if (g_reveal || (style & WS_CHILD)) return real_CreateWindowExW(ex, cls, name, style, x, y, w, h, parent, menu, inst, p);
    return real_CreateWindowExW(ex, cls, name, style & ~WS_VISIBLE, x, y, w, h, parent, menu, inst, p);
}
static HWND WINAPI my_CreateWindowExA(DWORD ex, LPCSTR cls, LPCSTR name, DWORD style,
                                      int x, int y, int w, int h, HWND parent, HMENU menu, HINSTANCE inst, LPVOID p) {
    if (g_reveal || (style & WS_CHILD)) return real_CreateWindowExA(ex, cls, name, style, x, y, w, h, parent, menu, inst, p);
    return real_CreateWindowExA(ex, cls, name, style & ~WS_VISIBLE, x, y, w, h, parent, menu, inst, p);
}

static BOOL WINAPI my_Beep(DWORD freq, DWORD dur) {
    if (g_reveal) return real_Beep(freq, dur);
    HLOG("[winhook] suppressed Beep freq=%lu dur=%lu", freq, dur);
    return TRUE;
}

static NtUserMessageBeep_t tramp_NtUserMessageBeep;

static BOOL WINAPI my_NtUserMessageBeep(UINT type) {
    if (g_reveal) return tramp_NtUserMessageBeep ? tramp_NtUserMessageBeep(type) : TRUE;
    HLOG("[winhook] suppressed NtUserMessageBeep type=0x%x", type);
    return TRUE;
}

static int StubLen(const uint8_t* p) {
    uint8_t b = p[0];
    if (b == 0x4C && p[1] == 0x8B && p[2] == 0xD1) return 3;
    if (b == 0xB8) return 5;
    if (b == 0xF6 && p[1] == 0x04 && p[2] == 0x25) return 8;
    if (b == 0x0F && p[1] == 0x05) return 2;
    if (b == 0xC3) return 1;
    if (b == 0xCD) return 2;
    if (b == 0x74 || b == 0x75 || b == 0xEB) return 2;
    if (b == 0xE9) return 5;
    return 0;
}

static void* InlineHookStub(void* target, void* detour) {
    if (!target || !detour) return NULL;
    uint8_t* t = (uint8_t*)target;

    int copied = 0, sawSyscall = 0;
    while (copied < 48) {
        int n = StubLen(t + copied);
        if (n <= 0) return NULL;
        if (t[copied] == 0x0F && t[copied + 1] == 0x05) sawSyscall = 1;
        copied += n;
        if (sawSyscall && t[copied - 1] == 0xC3 && copied >= 14) {
            if (t[copied] == 0xCD && t[copied + 1] == 0x2E) {
                copied += 2;
                if (t[copied] == 0xC3) copied += 1;
            }
            break;
        }
    }
    if (copied < 14) return NULL;

    uint8_t* tramp = (uint8_t*)VirtualAlloc(NULL, 64, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!tramp) return NULL;
    for (int i = 0; i < copied; i++) tramp[i] = t[i];

    DWORD old;
    if (!VirtualProtect(t, 14, PAGE_EXECUTE_READWRITE, &old)) { VirtualFree(tramp, 0, MEM_RELEASE); return NULL; }
    t[0] = 0xFF; t[1] = 0x25; *(DWORD*)(t + 2) = 0;
    *(uint64_t*)(t + 6) = (uint64_t)detour;
    VirtualProtect(t, 14, old, &old);
    FlushInstructionCache(GetCurrentProcess(), t, 14);
    return tramp;
}

static int IsModuleMapped(HMODULE mod) {
    MEMORY_BASIC_INFORMATION mbi;
    if (VirtualQuery((LPCVOID)mod, &mbi, sizeof(mbi)) != sizeof(mbi)) return 0;
    if (mbi.State != MEM_COMMIT) return 0;
    if (mbi.AllocationBase != (PVOID)mod) return 0;
    if (mbi.Type != MEM_IMAGE) return 0;
    return 1;
}

static int PatchModuleIAT(HMODULE mod, void* oldFn, void* newFn) {
    if (!mod || !oldFn || !newFn) return 0;
    if (!IsModuleMapped(mod)) return 0;

    int patched = 0;
    __try {
        uint8_t* base = (uint8_t*)mod;
        IMAGE_DOS_HEADER* dos = (IMAGE_DOS_HEADER*)base;
        if (dos->e_magic != IMAGE_DOS_SIGNATURE) return 0;
        if ((DWORD)dos->e_lfanew >= 0x10000) return 0;
        IMAGE_NT_HEADERS* nt = (IMAGE_NT_HEADERS*)(base + dos->e_lfanew);
        if (nt->Signature != IMAGE_NT_SIGNATURE) return 0;
        SIZE_T imgSize = nt->OptionalHeader.SizeOfImage;
        if (!imgSize) return 0;
        IMAGE_DATA_DIRECTORY imp = nt->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT];
        if (!imp.VirtualAddress) return 0;
        if (imp.VirtualAddress + sizeof(IMAGE_IMPORT_DESCRIPTOR) > imgSize) return 0;

        IMAGE_IMPORT_DESCRIPTOR* desc = (IMAGE_IMPORT_DESCRIPTOR*)(base + imp.VirtualAddress);
        for (; desc->Name; desc++) {
            if ((uint8_t*)(desc + 1) > base + imgSize) break;
            if (desc->FirstThunk + sizeof(IMAGE_THUNK_DATA) > imgSize) continue;
            IMAGE_THUNK_DATA* thunk = (IMAGE_THUNK_DATA*)(base + desc->FirstThunk);
            for (; thunk->u1.Function; thunk++) {
                if ((uint8_t*)(thunk + 1) > base + imgSize) break;
                void** slot = (void**)&thunk->u1.Function;
                if (*slot == oldFn) {
                    DWORD old;
                    if (VirtualProtect(slot, sizeof(void*), PAGE_READWRITE, &old)) {
                        *slot = newFn;
                        VirtualProtect(slot, sizeof(void*), old, &old);
                        patched++;
                    }
                }
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        return patched;
    }
    return patched;
}

static void PatchAllModules(void) {
    HMODULE mods[1024];
    DWORD needed = 0;
    HMODULE psapi = LoadLibraryW(L"psapi.dll");
    typedef BOOL (WINAPI* EPM_t)(HANDLE, HMODULE*, DWORD, LPDWORD);
    EPM_t EPM = NULL;
    HMODULE k32 = GetModuleHandleW(L"kernel32.dll");
    if (k32) EPM = (EPM_t)GetProcAddress(k32, "K32EnumProcessModules");
    if (!EPM && psapi) EPM = (EPM_t)GetProcAddress(psapi, "EnumProcessModules");
    if (!EPM) return;
    if (!EPM(GetCurrentProcess(), mods, sizeof(mods), &needed)) return;
    int count = (int)(needed / sizeof(HMODULE));
    HMODULE self = NULL;
    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
                       (LPCWSTR)&PatchAllModules, &self);
    int total = 0;
    for (int i = 0; i < count; i++) {
        if (mods[i] == self) continue;
        total += PatchModuleIAT(mods[i], (void*)real_ShowWindow,      (void*)my_ShowWindow);
        total += PatchModuleIAT(mods[i], (void*)real_ShowWindowAsync, (void*)my_ShowWindowAsync);
        total += PatchModuleIAT(mods[i], (void*)real_SetWindowPos,    (void*)my_SetWindowPos);
        total += PatchModuleIAT(mods[i], (void*)real_CreateWindowExW, (void*)my_CreateWindowExW);
        total += PatchModuleIAT(mods[i], (void*)real_CreateWindowExA, (void*)my_CreateWindowExA);
        total += PatchModuleIAT(mods[i], (void*)real_Beep,            (void*)my_Beep);
    }
    HLOG("[winhook] patched %d IAT slot(s) across %d module(s)", total, count);
}

static WCHAR g_revealFile[MAX_PATH];
static int   g_revealFileSet;

static void ResolveRevealFile(void) {
    char* path = NULL; size_t len = 0;
    if (_dupenv_s(&path, &len, "SATURA_WINHOOK_REVEAL_FILE") != 0 || !path) return;
    int n = MultiByteToWideChar(CP_UTF8, 0, path, -1, g_revealFile, MAX_PATH);
    if (n > 0) g_revealFileSet = 1;
    HLOG("[winhook] reveal file = %s", path);
    free(path);
}

static void RestoredRect(HWND hwnd, RECT* out) {
    WINDOWPLACEMENT wp;
    wp.length = sizeof(wp);
    if (IsIconic(hwnd) && GetWindowPlacement(hwnd, &wp)) {
        *out = wp.rcNormalPosition;
    } else if (!GetWindowRect(hwnd, out)) {
        out->left = out->top = out->right = out->bottom = 0;
    }
}

static int IsEditorMainWindow(HWND hwnd) {
    WCHAR cls[256];
    if (GetClassNameW(hwnd, cls, 256) <= 0) return 0;
    if (wcsstr(cls, L"ConsoleWindowClass")) return 0;
    if (wcsstr(cls, L"PseudoConsoleWindow")) return 0;
    RECT r;
    RestoredRect(hwnd, &r);
    if ((r.right - r.left) < 320 || (r.bottom - r.top) < 240) return 0;
    return 1;
}

static HWND g_editorMainHwnd;

static BOOL CALLBACK FindEditorMainWindow(HWND hwnd, LPARAM lparam) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    if (GetWindow(hwnd, GW_OWNER) != NULL) return TRUE;
    if (!IsEditorMainWindow(hwnd)) return TRUE;
    RECT r;
    RestoredRect(hwnd, &r);
    LONG area = (r.right - r.left) * (r.bottom - r.top);
    LONG* best = (LONG*)lparam;
    if (area > *best) {
        g_editorMainHwnd = hwnd;
        *best = area;
    }
    return TRUE;
}

static void NudgeRepaint(HWND h) {
    RedrawWindow(h, NULL, NULL, RDW_INVALIDATE | RDW_ALLCHILDREN);
}

static HWND g_dismissEditorMain;

static BOOL CALLBACK FindProgressChild(HWND hwnd, LPARAM lparam) {
    WCHAR cls[64];
    if (GetClassNameW(hwnd, cls, 64) > 0 && wcsstr(cls, L"msctls_progress32")) {
        *(int*)lparam = 1;
        return FALSE;
    }
    return TRUE;
}

static int IsBusyProgressDialog(HWND hwnd) {
    WCHAR title[256];
    if (InternalGetWindowText(hwnd, title, 256) > 0) {
        if (wcsstr(title, L"Hold on")) return 1;
        if (wcsstr(title, L"Hold On")) return 1;
    }
    int hasProgress = 0;
    EnumChildWindows(hwnd, FindProgressChild, (LPARAM)&hasProgress);
    return hasProgress;
}

static int IsExternalSceneChangeDialog(HWND hwnd) {
    WCHAR title[256];
    if (InternalGetWindowText(hwnd, title, 256) <= 0) return 0;
    return wcsstr(title, L"modified externally") != NULL;
}

static int LooksLikeModalDialog(HWND hwnd) {
    WCHAR cls[256];
    if (GetClassNameW(hwnd, cls, 256) <= 0) return 0;
    if (wcsstr(cls, L"ConsoleWindowClass")) return 0;
    if (wcsstr(cls, L"PseudoConsoleWindow")) return 0;
    if (wcsstr(cls, L"IME")) return 0;
    if (wcsstr(cls, L"MSCTFIME")) return 0;
    if (wcsstr(cls, L"Default IME")) return 0;
    if (IsBusyProgressDialog(hwnd)) return 0;
    if (IsExternalSceneChangeDialog(hwnd)) return 0;

    if (wcscmp(cls, L"#32770") == 0) return 1;

    if (GetWindow(hwnd, GW_OWNER) == NULL) return 0;
    LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
    if (!(style & WS_POPUP)) return 0;
    RECT r;
    RestoredRect(hwnd, &r);
    LONG w = r.right - r.left, h = r.bottom - r.top;
    if (w <= 0 || h <= 0) return 0;
    if (w > 1200 || h > 900) return 0;
    return 1;
}

static BOOL CALLBACK ShowModalDialogs(HWND hwnd, LPARAM lparam) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    if (hwnd == g_dismissEditorMain) return TRUE;
    if (IsBusyProgressDialog(hwnd)) {
        if (IsWindowVisible(hwnd)) {
            HLOG("[winhook] hiding busy-progress dialog hwnd=%p", (void*)hwnd);
            real_ShowWindow(hwnd, SW_HIDE);
        }
        return TRUE;
    }
    if (IsExternalSceneChangeDialog(hwnd)) {
        HLOG("[winhook] dismissing external-scene-change dialog hwnd=%p", (void*)hwnd);
        if (IsWindowVisible(hwnd)) real_ShowWindow(hwnd, SW_HIDE);
        PostMessageW(hwnd, WM_CLOSE, 0, 0);
        return TRUE;
    }
    if (!LooksLikeModalDialog(hwnd)) return TRUE;

    if (!IsWindowVisible(hwnd)) {   // surface on first appearance only; don't keep stealing focus
        WCHAR cls[256] = { 0 }, title[256] = { 0 };
        GetClassNameW(hwnd, cls, 256);
        InternalGetWindowText(hwnd, title, 256);
        HLOG("[winhook] surfacing modal hwnd=%p cls=%ls title=%ls for user input", (void*)hwnd, cls, title);
        real_ShowWindow(hwnd, SW_SHOW);
        SetForegroundWindow(hwnd);
        *(int*)lparam += 1;
    }
    return TRUE;
}

static void SweepModalDialogs(void) {
    if (g_reveal) return;
    g_dismissEditorMain = NULL;
    LONG best = 0;
    EnumWindows(FindEditorMainWindow, (LPARAM)&best);
    g_dismissEditorMain = g_editorMainHwnd;
    int shown = 0;
    __try {
        EnumWindows(ShowModalDialogs, (LPARAM)&shown);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
    if (shown) HLOG("[winhook] surfaced %d modal dialog(s)", shown);
}

static long g_revealEpoch;
static long g_revealX, g_revealY, g_revealW, g_revealH;
static int  g_revealHasBounds;
static int  g_frameCorrected;
static WCHAR g_statusFile[MAX_PATH];
static int   g_statusFileSet;

static void ResolveStatusFile(void) {
    if (g_statusFileSet || !g_revealFileSet) return;
    int len = lstrlenW(g_revealFile);
    if (len + 8 >= MAX_PATH) return;
    lstrcpyW(g_statusFile, g_revealFile);
    lstrcatW(g_statusFile, L".status");
    g_statusFileSet = 1;
}

static long ParseLongField(const char* buf, const char* key) {
    const char* p = strstr(buf, key);
    if (!p) return -1;
    p += strlen(key);
    while (*p == ' ' || *p == ':') p++;
    int neg = 0;
    if (*p == '-') { neg = 1; p++; }
    if (*p < '0' || *p > '9') return -1;
    long v = 0;
    while (*p >= '0' && *p <= '9') { v = v * 10 + (*p - '0'); p++; }
    return neg ? -v : v;
}

static int ReadStatusFile(int* shown, int* ready) {
    *shown = 0; *ready = 0;
    if (!g_statusFileSet) return 0;
    HANDLE f = CreateFileW(g_statusFile, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return 0;
    char buf[256] = { 0 };
    DWORD got = 0;
    ReadFile(f, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(f);
    long epoch = ParseLongField(buf, "\"epoch\"");
    if (epoch != g_revealEpoch) return 0;
    if (strstr(buf, "\"shown\":1")) *shown = 1;
    if (strstr(buf, "\"ready\":1")) *ready = 1;
    return 1;
}

static int ReadRevealState(void) {
    HANDLE f = CreateFileW(g_revealFile, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return REVEAL_ABSENT;
    char buf[256] = { 0 };
    DWORD got = 0;
    ReadFile(f, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(f);

    long want = ParseLongField(buf, "\"want\"");
    long epoch = ParseLongField(buf, "\"epoch\"");
    if (epoch >= 0 && epoch != g_revealEpoch) {
        g_revealEpoch = epoch;
        g_frameCorrected = 0;
    }

    int state = REVEAL_PRESENT;
    if (want != 0) state |= REVEAL_WANT;
    if (!(state & REVEAL_WANT)) return state;

    long bw = ParseLongField(buf, "\"w\"");
    long bh = ParseLongField(buf, "\"h\"");
    if (bw > 0 && bh > 0) {
        g_revealX = ParseLongField(buf, "\"x\"");
        g_revealY = ParseLongField(buf, "\"y\"");
        g_revealW = bw;
        g_revealH = bh;
        g_revealHasBounds = 1;
    } else {
        g_revealHasBounds = 0;
    }

    int shown = 0, ready = 0;
    ResolveStatusFile();
    if (ReadStatusFile(&shown, &ready)) {
        if (shown) state |= REVEAL_SHOWN;
        if (ready) state |= REVEAL_READY;
    }
    return state;
}

static void WriteRevealShown(int shown, int ready) {
    ResolveStatusFile();
    if (!g_statusFileSet) return;
    HANDLE f = CreateFileW(g_statusFile, GENERIC_WRITE, FILE_SHARE_READ,
                           NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    char buf[96];
    int n = _snprintf_s(buf, sizeof(buf), _TRUNCATE,
                        "{\"shown\":%d,\"ready\":%d,\"epoch\":%ld}",
                        shown ? 1 : 0, ready ? 1 : 0, g_revealEpoch);
    if (n > 0) { DWORD wrote = 0; WriteFile(f, buf, (DWORD)n, &wrote, NULL); }
    CloseHandle(f);
}

static int LocateEditorMainWindow(void) {
    g_editorMainHwnd = NULL;
    LONG best = 0;
    EnumWindows(FindEditorMainWindow, (LPARAM)&best);
    return g_editorMainHwnd != NULL;
}

static int g_hideTicks;
static int g_revealNudges;

#define REVEAL_MAX_NUDGES 120

static void RevealBringToFront(HWND h) {
    HWND fg = GetForegroundWindow();
    DWORD fgThread = 0;
    if (fg && fg != h) fgThread = GetWindowThreadProcessId(fg, NULL);
    DWORD ourThread = GetCurrentThreadId();
    BOOL attached = FALSE;
    if (fgThread && fgThread != ourThread)
        attached = AttachThreadInput(ourThread, fgThread, TRUE);
    SetForegroundWindow(h);
    BringWindowToTop(h);
    if (attached) AttachThreadInput(ourThread, fgThread, FALSE);
    if (GetForegroundWindow() != h) {
        keybd_event(VK_MENU, 0, 0, 0);
        keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, 0);
        SetForegroundWindow(h);
        BringWindowToTop(h);
    }
}

static void RevealExpandWindow(HWND h) {
    if (IsIconic(h)) real_ShowWindowAsync(h, SW_RESTORE);
    if (g_revealHasBounds) {
        if (IsZoomed(h)) real_ShowWindowAsync(h, SW_RESTORE);
        real_ShowWindowAsync(h, SW_SHOW);
        real_SetWindowPos(h, HWND_TOP, g_revealX, g_revealY, g_revealW, g_revealH,
                          SWP_SHOWWINDOW | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    } else {
        real_ShowWindowAsync(h, SW_SHOW);
        if (!MonitorFromWindow(h, MONITOR_DEFAULTTONULL))
            real_ShowWindowAsync(h, SW_MAXIMIZE);
    }
    RevealBringToFront(h);
    NudgeRepaint(h);
}

typedef HRESULT (WINAPI* DwmGetWindowAttribute_t)(HWND, DWORD, PVOID, DWORD);
static DwmGetWindowAttribute_t pDwmGetWindowAttribute;
static int g_dwmResolved;

#define DWMWA_EXT_FRAME_BOUNDS 9

static void ResolveDwm(void) {
    if (g_dwmResolved) return;
    g_dwmResolved = 1;
    HMODULE m = GetModuleHandleW(L"dwmapi.dll");
    if (!m) m = LoadLibraryW(L"dwmapi.dll");
    if (m) pDwmGetWindowAttribute = (DwmGetWindowAttribute_t)GetProcAddress(m, "DwmGetWindowAttribute");
}

// SetWindowPos includes the invisible DWM resize borders in the rect, so the visible frame lands a
// few pixels short of the requested bounds and a gap opens against the neighboring app window.
// Once the window sits at the raw target, measure the invisible insets and grow the rect by them.
static void RevealCorrectFrame(void) {
    if (!g_revealHasBounds || g_frameCorrected) return;
    HWND h = g_editorMainHwnd;
    if (!h || !IsWindow(h) || !IsWindowVisible(h) || IsIconic(h) || IsZoomed(h)) return;
    RECT wr;
    if (!GetWindowRect(h, &wr)) return;
    if (wr.left != g_revealX || wr.top != g_revealY || (wr.right - wr.left) != g_revealW) return;
    ResolveDwm();
    if (!pDwmGetWindowAttribute) { g_frameCorrected = 1; return; }
    RECT fr;
    if (pDwmGetWindowAttribute(h, DWMWA_EXT_FRAME_BOUNDS, &fr, sizeof(fr)) != 0) {
        g_frameCorrected = 1;
        return;
    }
    int li = fr.left - wr.left;
    int ti = fr.top - wr.top;
    int ri = wr.right - fr.right;
    int bi = wr.bottom - fr.bottom;
    g_frameCorrected = 1;
    if (li == 0 && ti == 0 && ri == 0 && bi == 0) return;
    if (li < 0 || ti < 0 || ri < 0 || bi < 0 || li > 32 || ti > 32 || ri > 32 || bi > 32) return;
    real_SetWindowPos(h, NULL, g_revealX - li, g_revealY - ti,
                      g_revealW + li + ri, g_revealH + ti + bi,
                      SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
    HLOG("[winhook] reveal frame correction li=%d ti=%d ri=%d bi=%d", li, ti, ri, bi);
}

static void RevealShowEditor(void) {
    __try {
        if (LocateEditorMainWindow()) {
            RevealExpandWindow(g_editorMainHwnd);
            WriteRevealShown(1, 0);
            HLOG("[winhook] reveal shown hwnd=%p", (void*)g_editorMainHwnd);
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

static void RevealEnsureExpanded(void) {
    __try {
        if (!g_editorMainHwnd || !IsWindow(g_editorMainHwnd)) LocateEditorMainWindow();
        HWND h = g_editorMainHwnd;
        if (!h) return;
        if (IsIconic(h) || !IsWindowVisible(h)) {
            RevealExpandWindow(h);
            HLOG("[winhook] reveal re-expanded hwnd=%p", (void*)h);
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

static BOOL CALLBACK HideProcessWindow(HWND hwnd, LPARAM lparam) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    WCHAR cls[256];
    if (GetClassNameW(hwnd, cls, 256) > 0) {
        if (wcsstr(cls, L"ConsoleWindowClass")) return TRUE;
        if (wcsstr(cls, L"PseudoConsoleWindow")) return TRUE;
    }
    if (IsWindowVisible(hwnd)) {
        real_ShowWindow(hwnd, SW_HIDE);
        *(int*)lparam += 1;
    }
    return TRUE;
}

static void RevealHideEditor(void) {
    __try {
        int hidden = 0;
        EnumWindows(HideProcessWindow, (LPARAM)&hidden);
        if (hidden) HLOG("[winhook] reveal hid %d window(s)", hidden);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

static BOOL CALLBACK HideCloneWindow(HWND hwnd, LPARAM lparam) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    WCHAR cls[256];
    if (GetClassNameW(hwnd, cls, 256) > 0) {
        if (wcsstr(cls, L"ConsoleWindowClass")) return TRUE;
        if (wcsstr(cls, L"PseudoConsoleWindow")) return TRUE;
    }
    if (LooksLikeModalDialog(hwnd)) return TRUE;
    if (IsWindowVisible(hwnd)) {
        real_ShowWindow(hwnd, SW_HIDE);
        *(int*)lparam += 1;
    }
    return TRUE;
}

static void EnforceCloneHidden(void) {
    __try {
        int hidden = 0;
        EnumWindows(HideCloneWindow, (LPARAM)&hidden);
        if (hidden) HLOG("[winhook] clone-mode hid %d window(s)", hidden);
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

// --- Modal dialog detection + resolution -----------------------------------
// A blocking modal halts Unity's main thread, so the MCP bridge can neither see nor answer it. This
// background thread keeps running, and the modal message loop still pumps posted messages, so we can
// both enumerate the dialog (title/message/buttons) and answer it with PostMessageW. Protocol: publish
// visible dialogs to SATURA_MODAL_STATUS_FILE whenever the set changes; consume click/close commands
// from SATURA_MODAL_CMD_FILE (strictly increasing seq; a stale cmd file from a previous run is
// absorbed at startup as the initial consumed seq). Busy-progress and external-scene-change dialogs
// are excluded by LooksLikeModalDialog itself, so their existing auto-behaviors are never reported.

#define MODAL_MAX_DIALOGS 8
#define MODAL_MAX_BUTTONS 16

typedef struct {
    HWND hwnd;
    char id[24];
    char title[512];
    char message[2048];
    char buttons[MODAL_MAX_BUTTONS][128];
    HWND buttonHwnds[MODAL_MAX_BUTTONS];
    int nButtons;
    char cls[64];
} ModalInfo;

static WCHAR g_modalStatusFileW[MAX_PATH];
static WCHAR g_modalCmdFileW[MAX_PATH];
static int   g_modalStatusSet, g_modalCmdSet;
static long  g_modalSeq;
static long long g_modalCmdDone = -1;
static unsigned g_lastDialogsSig;
static int   g_modalStatusWritten;
static char  g_lastCmdJson[512];
static ModalInfo g_modalDialogs[MODAL_MAX_DIALOGS];
static int   g_nModalDialogs;

static unsigned Fnv1aStr(const char* s) {
    unsigned h = 2166136261u;
    while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; }
    return h;
}

// Command seqs are floored at epoch-milliseconds by the Python side (~1.75e12) — far beyond LLP64's
// 32-bit long, so the modal path parses them as long long (ParseLongField would overflow and the
// wrapped-negative windows would silently discard every command).
static long long ParseInt64Field(const char* buf, const char* key) {
    const char* p = strstr(buf, key);
    if (!p) return -1;
    p += strlen(key);
    while (*p == ' ' || *p == ':') p++;
    int neg = 0;
    if (*p == '-') { neg = 1; p++; }
    if (*p < '0' || *p > '9') return -1;
    long long v = 0;
    while (*p >= '0' && *p <= '9') { v = v * 10 + (*p - '0'); p++; }
    return neg ? -v : v;
}

static int ParseStringField(const char* buf, const char* key, char* out, size_t cap) {
    const char* p = strstr(buf, key);
    if (!p) return 0;
    p += strlen(key);
    while (*p == ' ' || *p == ':') p++;
    if (*p != '"') return 0;
    p++;
    size_t i = 0;
    while (*p && *p != '"' && i + 1 < cap) {
        if (*p == '\\' && p[1]) {
            p++;
            if (*p == 'n') out[i++] = '\n';
            else if (*p == 't') out[i++] = '\t';
            else if (*p == 'r') out[i++] = '\r';
            else out[i++] = *p;
            p++;
        } else {
            out[i++] = *p++;
        }
    }
    out[i] = '\0';
    return 1;
}

static void AppendRaw(char* buf, size_t cap, size_t* len, const char* s) {
    while (*s && *len + 1 < cap) buf[(*len)++] = *s++;
    buf[*len] = '\0';
}

// Escapes for JSON without ever emitting invalid UTF-8 (which would break json.loads): complete
// multi-byte sequences are copied atomically, and malformed bytes — stray continuations, bad leads,
// or a sequence cut short by the source's own truncation — are dropped.
static void AppendJsonEscaped(char* buf, size_t cap, size_t* len, const char* s, size_t maxBytes) {
    size_t used = 0;
    while (*s && used < maxBytes && *len + 8 < cap) {
        unsigned char c = (unsigned char)*s;
        if (c >= 0x80) {
            int seq = (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : (c & 0xF8) == 0xF0 ? 4 : 0;
            int valid = seq > 0;
            for (int i = 1; valid && i < seq; i++)
                if (((unsigned char)s[i] & 0xC0) != 0x80) valid = 0;
            if (!valid) { s++; used++; continue; }
            if (used + seq > maxBytes || *len + seq + 1 >= cap) break;
            for (int i = 0; i < seq; i++) { buf[(*len)++] = *s++; used++; }
            continue;
        }
        s++; used++;
        if (c == '"' || c == '\\') { buf[(*len)++] = '\\'; buf[(*len)++] = (char)c; }
        else if (c == '\n') { buf[(*len)++] = '\\'; buf[(*len)++] = 'n'; }
        else if (c == '\r') { buf[(*len)++] = '\\'; buf[(*len)++] = 'r'; }
        else if (c == '\t') { buf[(*len)++] = '\\'; buf[(*len)++] = 't'; }
        else if (c < 0x20) *len += _snprintf_s(buf + *len, cap - *len, _TRUNCATE, "\\u%04x", c);
        else buf[(*len)++] = (char)c;
    }
    buf[*len] = '\0';
}

// A too-small buffer makes WideCharToMultiByte return 0 with PARTIALLY WRITTEN, unterminated output
// that can end mid-UTF-8-sequence. Shrink the source until the conversion fits whole instead. A cut
// between surrogate halves yields U+FFFD, which is still valid UTF-8.
static void WideToUtf8(const WCHAR* src, char* dst, int cap) {
    dst[0] = '\0';
    if (WideCharToMultiByte(CP_UTF8, 0, src, -1, dst, cap, NULL, NULL) > 0) return;
    int len = lstrlenW(src);
    while (len > 0) {
        int need = WideCharToMultiByte(CP_UTF8, 0, src, len, NULL, 0, NULL, NULL);
        if (need > 0 && need < cap) {
            int n = WideCharToMultiByte(CP_UTF8, 0, src, len, dst, cap - 1, NULL, NULL);
            dst[n > 0 ? n : 0] = '\0';
            return;
        }
        len--;
    }
    dst[0] = '\0';
}

static int ResolveModalEnvFile(const char* name, WCHAR* out) {
    char* path = NULL; size_t len = 0;
    if (_dupenv_s(&path, &len, name) != 0 || !path) return 0;
    int n = MultiByteToWideChar(CP_UTF8, 0, path, -1, out, MAX_PATH);
    if (n > 0) HLOG("[winhook] %s = %s", name, path);
    free(path);
    return n > 0;
}

static void ResolveModalFiles(void) {
    g_modalStatusSet = ResolveModalEnvFile("SATURA_MODAL_STATUS_FILE", g_modalStatusFileW);
    g_modalCmdSet = ResolveModalEnvFile("SATURA_MODAL_CMD_FILE", g_modalCmdFileW);
    if (g_modalCmdSet) {
        HANDLE f = CreateFileW(g_modalCmdFileW, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                               NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
        if (f != INVALID_HANDLE_VALUE) {
            char buf[1024] = { 0 };
            DWORD got = 0;
            ReadFile(f, buf, sizeof(buf) - 1, &got, NULL);
            CloseHandle(f);
            long long seq = ParseInt64Field(buf, "\"seq\"");
            if (seq > g_modalCmdDone) g_modalCmdDone = seq;
        }
    }
}

static BOOL CALLBACK CollectDialogChild(HWND child, LPARAM lparam) {
    ModalInfo* info = (ModalInfo*)lparam;
    WCHAR cls[64];
    if (GetClassNameW(child, cls, 64) <= 0) return TRUE;
    WCHAR textW[1024] = { 0 };
    if (wcscmp(cls, L"Button") == 0) {
        LONG_PTR style = GetWindowLongPtrW(child, GWL_STYLE);
        if ((style & BS_TYPEMASK) == BS_GROUPBOX) return TRUE;
        if (info->nButtons >= MODAL_MAX_BUTTONS) return TRUE;
        if (GetWindowTextW(child, textW, 1024) <= 0) return TRUE;
        WideToUtf8(textW, info->buttons[info->nButtons], sizeof(info->buttons[0]));
        if (info->buttons[info->nButtons][0]) {
            info->buttonHwnds[info->nButtons] = child;
            info->nButtons++;
        }
    } else if (wcscmp(cls, L"Static") == 0) {
        LONG_PTR style = GetWindowLongPtrW(child, GWL_STYLE) & SS_TYPEMASK;
        if (style == SS_ICON || style == SS_BITMAP) return TRUE;
        if (GetWindowTextW(child, textW, 1024) <= 0) return TRUE;
        char text[2048];
        WideToUtf8(textW, text, sizeof(text));
        if (strlen(text) > strlen(info->message))
            strcpy_s(info->message, sizeof(info->message), text);
    }
    return TRUE;
}

static int DialogBlocksInput(HWND hwnd) {
    HWND owner = GetWindow(hwnd, GW_OWNER);
    if (owner) return !IsWindowEnabled(owner);
    WCHAR cls[64];
    if (GetClassNameW(hwnd, cls, 64) <= 0) return 0;
    return wcscmp(cls, L"#32770") == 0;
}

static BOOL CALLBACK CollectModalDialog(HWND hwnd, LPARAM lparam) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid != GetCurrentProcessId()) return TRUE;
    if (g_nModalDialogs >= MODAL_MAX_DIALOGS) return FALSE;
    if (!IsWindowVisible(hwnd)) return TRUE;
    if (!LooksLikeModalDialog(hwnd)) return TRUE;
    if (g_reveal && !DialogBlocksInput(hwnd)) return TRUE;
    ModalInfo* info = &g_modalDialogs[g_nModalDialogs];
    memset(info, 0, sizeof(*info));
    info->hwnd = hwnd;
    WCHAR titleW[256] = { 0 }, clsW[64] = { 0 };
    InternalGetWindowText(hwnd, titleW, 256);
    GetClassNameW(hwnd, clsW, 64);
    WideToUtf8(titleW, info->title, sizeof(info->title));
    WideToUtf8(clsW, info->cls, sizeof(info->cls));
    EnumChildWindows(hwnd, CollectDialogChild, (LPARAM)info);
    _snprintf_s(info->id, sizeof(info->id), _TRUNCATE, "%lx-%08x",
                (unsigned long)((ULONG_PTR)hwnd & 0xffffffff), Fnv1aStr(info->title));
    g_nModalDialogs++;
    return TRUE;
}

static void BuildModalDialogs(void) {
    g_nModalDialogs = 0;
    EnumWindows(CollectModalDialog, 0);
}

// Each dialog is serialized into its own scratch buffer, sized so the worst case (fully escaped
// title + message + 16 buttons) always fits, then appended to the body only if it fits whole —
// truncation can drop a trailing dialog but can never publish malformed JSON.
static int ModalWriteStatus(void) {
    static char body[16384];
    static char entry[12288];
    size_t blen = 0;
    body[0] = '\0';
    for (int d = 0; d < g_nModalDialogs; d++) {
        ModalInfo* info = &g_modalDialogs[d];
        size_t elen = 0;
        entry[0] = '\0';
        AppendRaw(entry, sizeof(entry), &elen, "{\"id\":\"");
        AppendRaw(entry, sizeof(entry), &elen, info->id);
        AppendRaw(entry, sizeof(entry), &elen, "\",\"title\":\"");
        AppendJsonEscaped(entry, sizeof(entry), &elen, info->title, 500);
        AppendRaw(entry, sizeof(entry), &elen, "\",\"message\":\"");
        AppendJsonEscaped(entry, sizeof(entry), &elen, info->message, 2000);
        AppendRaw(entry, sizeof(entry), &elen, "\",\"buttons\":[");
        for (int i = 0; i < info->nButtons; i++) {
            if (i) AppendRaw(entry, sizeof(entry), &elen, ",");
            AppendRaw(entry, sizeof(entry), &elen, "\"");
            AppendJsonEscaped(entry, sizeof(entry), &elen, info->buttons[i], 126);
            AppendRaw(entry, sizeof(entry), &elen, "\"");
        }
        AppendRaw(entry, sizeof(entry), &elen, "],\"cls\":\"");
        AppendJsonEscaped(entry, sizeof(entry), &elen, info->cls, 62);
        AppendRaw(entry, sizeof(entry), &elen,
                  (info->nButtons > 0 && info->message[0]) ? "\",\"textComplete\":true}" : "\",\"textComplete\":false}");
        if (elen + 8 >= sizeof(entry) || blen + elen + 2 >= sizeof(body)) continue;
        if (blen > 0) AppendRaw(body, sizeof(body), &blen, ",");
        AppendRaw(body, sizeof(body), &blen, entry);
    }
    unsigned sig = Fnv1aStr(body);
    if (g_modalStatusWritten && sig == g_lastDialogsSig) return 1;
    WCHAR tmp[MAX_PATH + 8];
    lstrcpyW(tmp, g_modalStatusFileW);
    lstrcatW(tmp, L".tmp");
    HANDLE f = CreateFileW(tmp, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return 0;
    static char out[20480];
    g_modalSeq++;
    int n = _snprintf_s(out, sizeof(out), _TRUNCATE,
                        "{\"v\":1,\"seq\":%ld,\"ts\":%lld,\"pid\":%lu,\"dialogs\":[%s]%s%s}",
                        g_modalSeq, (long long)_time64(NULL), GetCurrentProcessId(), body,
                        g_lastCmdJson[0] ? ",\"lastCmd\":" : "",
                        g_lastCmdJson[0] ? g_lastCmdJson : "");
    DWORD wrote = 0;
    if (n > 0) WriteFile(f, out, (DWORD)n, &wrote, NULL);
    CloseHandle(f);
    if (n <= 0 || !MoveFileExW(tmp, g_modalStatusFileW, MOVEFILE_REPLACE_EXISTING)) return 0;
    g_lastDialogsSig = sig;
    g_modalStatusWritten = 1;
    return 1;
}

static void ModalScan(void) {
    if (!g_modalStatusSet) return;
    __try {
        BuildModalDialogs();
        if (g_nModalDialogs > 0) HLOG("[winhook] modal scan -> %d dialog(s)", g_nModalDialogs);
        ModalWriteStatus();
    } __except (EXCEPTION_EXECUTE_HANDLER) {
    }
}

static void ModalPollCmd(void) {
    if (!g_modalCmdSet || !g_modalStatusSet) return;
    HANDLE f = CreateFileW(g_modalCmdFileW, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                           NULL, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (f == INVALID_HANDLE_VALUE) return;
    char buf[1024] = { 0 };
    DWORD got = 0;
    ReadFile(f, buf, sizeof(buf) - 1, &got, NULL);
    CloseHandle(f);
    long long seq = ParseInt64Field(buf, "\"seq\"");
    if (seq < 0 || seq <= g_modalCmdDone) return;
    g_modalCmdDone = seq;
    char id[64] = { 0 }, action[16] = { 0 }, button[128] = { 0 };
    ParseStringField(buf, "\"id\"", id, sizeof(id));
    ParseStringField(buf, "\"action\"", action, sizeof(action));
    ParseStringField(buf, "\"button\"", button, sizeof(button));
    HLOG("[winhook] modal cmd seq=%lld id='%s' action='%s' button='%s'", seq, id, action, button);
    const char* outcome = "not_found";
    char detail[192] = { 0 };
    __try {
        BuildModalDialogs();
        ModalInfo* info = NULL;
        for (int i = 0; i < g_nModalDialogs; i++)
            if (strcmp(g_modalDialogs[i].id, id) == 0) { info = &g_modalDialogs[i]; break; }
        if (info) {
            if (strcmp(action, "close") == 0) {
                PostMessageW(info->hwnd, WM_CLOSE, 0, 0);
                outcome = "closed";
            } else if (strcmp(action, "click") == 0) {
                int idx = -1;
                for (int i = 0; i < info->nButtons && idx < 0; i++)
                    if (strcmp(info->buttons[i], button) == 0) idx = i;
                for (int i = 0; i < info->nButtons && idx < 0; i++)
                    if (_stricmp(info->buttons[i], button) == 0) idx = i;
                // The status file caps labels at 126 escaped source bytes, so a longer real label
                // round-trips back truncated — accept it as a prefix of the stored label.
                for (int i = 0; i < info->nButtons && idx < 0; i++)
                    if (strlen(button) >= 120 && strncmp(info->buttons[i], button, strlen(button)) == 0)
                        idx = i;
                if (idx >= 0) {
                    strcpy_s(detail, sizeof(detail), info->buttons[idx]);
                    PostMessageW(info->hwnd, WM_COMMAND,
                                 MAKEWPARAM(GetDlgCtrlID(info->buttonHwnds[idx]), BN_CLICKED),
                                 (LPARAM)info->buttonHwnds[idx]);
                    outcome = "clicked";
                } else {
                    outcome = "button_not_found";
                }
            } else {
                outcome = "error";
                strcpy_s(detail, sizeof(detail), "unknown action");
            }
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) {
        outcome = "error";
    }
    HLOG("[winhook] modal cmd -> %s '%s'", outcome, detail);
    {
        size_t dlen = 0;
        char esc[256] = { 0 };
        AppendJsonEscaped(esc, sizeof(esc), &dlen, detail, 190);
        _snprintf_s(g_lastCmdJson, sizeof(g_lastCmdJson), _TRUNCATE,
                    "{\"seq\":%lld,\"outcome\":\"%s\",\"detail\":\"%s\"}", seq, outcome, esc);
    }
    g_modalStatusWritten = 0;
    ModalScan();
}

static void PollReveal(void) {
    ModalScan();
    ModalPollCmd();
    if (!g_revealFileSet) {
        SweepModalDialogs();
        EnforceCloneHidden();
        return;
    }

    int state = ReadRevealState();
    int want = (state & REVEAL_WANT) != 0;

    if (want != g_reveal) {
        InterlockedExchange(&g_reveal, want);
        g_hideTicks = want ? 0 : HIDE_ENFORCE_TICKS;
        g_revealNudges = 0;
        g_frameCorrected = 0;
        HLOG("[winhook] reveal transition -> %d", want);
        if (!want) {
            RevealHideEditor();
            return;
        }
    }

    if (g_reveal) {
        if (!(state & REVEAL_SHOWN)) {
            RevealShowEditor();
        } else {
            RevealEnsureExpanded();
            __try {
                RevealCorrectFrame();
            } __except (EXCEPTION_EXECUTE_HANDLER) {
                g_frameCorrected = 1;
            }
            if (!(state & REVEAL_READY) && g_revealNudges < REVEAL_MAX_NUDGES) {
                g_revealNudges++;
                __try {
                    if (g_editorMainHwnd && IsWindowVisible(g_editorMainHwnd))
                        RedrawWindow(g_editorMainHwnd, NULL, NULL, RDW_INVALIDATE | RDW_ALLCHILDREN);
                } __except (EXCEPTION_EXECUTE_HANDLER) {
                }
            }
        }
    } else {
        if (g_hideTicks > 0) {
            g_hideTicks--;
            RevealHideEditor();
        }
        SweepModalDialogs();
    }
}

static DWORD WINAPI HookThread(LPVOID p) {
    HMODULE u = GetModuleHandleW(L"user32.dll");
    if (!u) u = LoadLibraryW(L"user32.dll");
    if (!u) { HLOG("[winhook] no user32"); return 0; }
    real_ShowWindow      = (ShowWindow_t)GetProcAddress(u, "ShowWindow");
    real_ShowWindowAsync = (ShowWindow_t)GetProcAddress(u, "ShowWindowAsync");
    real_SetWindowPos    = (SetWindowPos_t)GetProcAddress(u, "SetWindowPos");
    real_CreateWindowExW = (CreateWindowExW_t)GetProcAddress(u, "CreateWindowExW");
    real_CreateWindowExA = (CreateWindowExA_t)GetProcAddress(u, "CreateWindowExA");
    HMODULE k = GetModuleHandleW(L"kernel32.dll");
    if (!k) k = LoadLibraryW(L"kernel32.dll");
    if (k) real_Beep = (Beep_t)GetProcAddress(k, "Beep");

    HMODULE w32u = GetModuleHandleW(L"win32u.dll");
    if (!w32u) w32u = LoadLibraryW(L"win32u.dll");
    void* ntBeep = w32u ? (void*)GetProcAddress(w32u, "NtUserMessageBeep") : NULL;
    HLOG("[winhook] resolved pid=%lu SW=%p SWP=%p Beep=%p NtBeep=%p", GetCurrentProcessId(),
         (void*)real_ShowWindow, (void*)real_SetWindowPos, (void*)real_Beep, ntBeep);

    if (ntBeep) {
        tramp_NtUserMessageBeep = (NtUserMessageBeep_t)InlineHookStub(ntBeep, (void*)my_NtUserMessageBeep);
        HLOG("[winhook] NtUserMessageBeep inline hook %s (tramp=%p)",
             tramp_NtUserMessageBeep ? "installed" : "FAILED", (void*)tramp_NtUserMessageBeep);
    }

    ResolveRevealFile();
    ResolveModalFiles();

    for (int i = 0; i < 48; i++) {
        PatchAllModules();
        PollReveal();
        Sleep(150);
    }
    for (;;) {
        PatchAllModules();
        for (int j = 0; j < 10; j++) {
            PollReveal();
            Sleep(100);
        }
    }
    return 0;
}

BOOL WINAPI DllMain(HINSTANCE inst, DWORD reason, LPVOID reserved) {
    if (reason == DLL_PROCESS_ATTACH) {
        DisableThreadLibraryCalls(inst);
        HLOG("[winhook] DLL_PROCESS_ATTACH pid=%lu", GetCurrentProcessId());
        CreateThread(NULL, 0, HookThread, NULL, 0, NULL);
    }
    return TRUE;
}
