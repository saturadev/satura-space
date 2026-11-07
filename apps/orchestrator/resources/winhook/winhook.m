// Injected via DYLD_INSERT_LIBRARIES into the Unity GUI clone editor.
// Goal: keep the GUI editor lifecycle (so the MPPM clone shares the Library + stays alive)
// but never let any NSWindow become visible on screen. We hook PUBLIC AppKit methods only
// (stable across Unity versions): force every window off-screen and call the original so
// Unity's window state machine still completes (no hang). Logs every interception.

#import <AppKit/AppKit.h>
#import <objc/runtime.h>
#import <dispatch/dispatch.h>
#import <stdarg.h>
#import <stdio.h>
#import <stdlib.h>
#import <string.h>
#import <limits.h>
#import <dlfcn.h>
#import <unistd.h>
#import <time.h>

static FILE *gl;
static void L(const char *f, ...) {
    if (!gl) gl = fopen("/tmp/winhook.log", "a");
    if (!gl) return;
    va_list a; va_start(a, f);
    vfprintf(gl, f, a); fputc('\n', gl); fflush(gl);
    va_end(a);
}

// Strategy: NO-OP every "show on screen" path entirely. All on-screen ordering funnels through
// -[NSWindow orderWindow:relativeTo:]; we let NSWindowOut (hide) through and drop everything else,
// so a window object can exist but is never placed on a display. makeKeyAndOrderFront:/orderFront:
// are also dropped outright (belt and suspenders). The window never appears.

typedef void (*v_id_imp)(id, SEL, id);

// When reveal is requested (g_reveal) OR a blocking modal is up (g_modalActive), let the editor's
// windows through so the user can drive the editor / answer the dialog; otherwise every show path is
// dropped and the window stays off-screen. g_modalActive is bumped for the duration of any
// runModalForWindow: — those halt Unity's main thread waiting on user input, so they MUST be shown.
static volatile int g_reveal;
static volatile int g_modalActive;
static inline int showAllowed(void) { return g_reveal || g_modalActive; }

static v_id_imp orig_mkof, orig_of;
static void my_mkof(id self, SEL _cmd, id s) {
    if (showAllowed()) { if (orig_mkof) orig_mkof(self, _cmd, s); return; }
    L("[winhook] blocked makeKeyAndOrderFront:");
}
static void my_of(id self, SEL _cmd, id s) {
    if (showAllowed()) { if (orig_of) orig_of(self, _cmd, s); return; }
    L("[winhook] blocked orderFront:");
}

typedef void (*orderWindow_imp)(id, SEL, NSInteger, NSInteger);
static orderWindow_imp orig_orderWindow;
static void my_orderWindow(id self, SEL _cmd, NSInteger place, NSInteger other) {
    if (showAllowed() || place == NSWindowOut) {   // NSWindowOut (0) = hide, always allowed
        if (orig_orderWindow) orig_orderWindow(self, _cmd, place, other);
        return;
    }
    L("[winhook] blocked orderWindow:relativeTo: place=%ld title='%s'", (long)place,
      [[(NSWindow *)self title] UTF8String] ?: "?");
}

static int isTermsWindow(NSWindow *w) {
    NSString *t = [w title];
    if (!t) return 0;
    return ([t rangeOfString:@"Terms" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [t rangeOfString:@"License" options:NSCaseInsensitiveSearch].location != NSNotFound ||
            [t rangeOfString:@"Agreement" options:NSCaseInsensitiveSearch].location != NSNotFound);
}

static int viewHasProgressIndicator(NSView *v, int depth) {
    if (!v || depth > 6) return 0;
    if ([v isKindOfClass:[NSProgressIndicator class]]) return 1;
    for (NSView *sub in [v subviews])
        if (viewHasProgressIndicator(sub, depth + 1)) return 1;
    return 0;
}

static int isBusyProgressWindow(NSWindow *w) {
    NSString *t = [w title];
    if (t && [t rangeOfString:@"Hold on" options:NSCaseInsensitiveSearch].location != NSNotFound) return 1;
    @try {
        return viewHasProgressIndicator([w contentView], 0);
    } @catch (...) {}
    return 0;
}

typedef void (*setVisible_imp)(id, SEL, BOOL);
static setVisible_imp orig_setVisible;
static void my_setVisible(id self, SEL _cmd, BOOL v) {
    if (v) {
        L("[winhook] setIsVisible:YES title='%s'", [[(NSWindow *)self title] UTF8String] ?: "?");
        if (!showAllowed() && isBusyProgressWindow((NSWindow *)self)) {
            L("[winhook] -> blocking busy-progress window");
            if (orig_setVisible) orig_setVisible(self, _cmd, NO);
            return;
        }
    }
    if (orig_setVisible) orig_setVisible(self, _cmd, v);
}

typedef void (*ofr_imp)(id, SEL);
static ofr_imp orig_ofr;
static void my_ofr(id self, SEL _cmd) {
    if (showAllowed()) { if (orig_ofr) orig_ofr(self, _cmd); return; }
    L("[winhook] blocked orderFrontRegardless title='%s'", [[(NSWindow *)self title] UTF8String] ?: "?");
}

static NSWindow *g_runModalWindow;
static void ModalScan(void);

typedef NSModalResponse (*runModal_imp)(id, SEL, id);
static runModal_imp orig_runModal;
static NSModalResponse my_runModal(id self, SEL _cmd, id win) {
    L("[winhook] runModalForWindow title='%s'", [[(NSWindow *)win title] UTF8String] ?: "?");
    // Any other modal (EditorUtility.DisplayDialog: "Recovering Scene Backups", API-update prompts,
    // save prompts, …) blocks Unity's main thread until the user answers. If we keep the app hidden
    // the dialog is un-clickable and the whole editor hangs, so surface app + dialog for its duration.
    g_modalActive++;
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    @try {
        if ([(id)win isKindOfClass:[NSWindow class]]) [(NSWindow *)win makeKeyAndOrderFront:nil];
    } @catch (...) {}
    [NSApp activateIgnoringOtherApps:YES];
    L("[winhook] -> surfaced blocking modal for user input");
    if ([(id)win isKindOfClass:[NSWindow class]]) g_runModalWindow = (NSWindow *)win;
    ModalScan();
    NSModalResponse r = orig_runModal ? orig_runModal(self, _cmd, win) : 0;
    g_runModalWindow = nil;
    g_modalActive--;
    ModalScan();
    if (!g_reveal && g_modalActive == 0) {   // dialog answered; return to hidden/accessory
        @try {
            for (NSWindow *w in [NSApp windows]) {
                if (w != (NSWindow *)win && [w isVisible]) [w orderOut:nil];
            }
        } @catch (...) {}
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
    }
    L("[winhook] modal returned %ld", (long)r);
    return r;
}

static IMP setImp(Class c, SEL s, IMP n) {
    Method m = class_getInstanceMethod(c, s);
    if (!m) { L("[winhook] NOT FOUND %s", sel_getName(s)); return NULL; }
    IMP o = method_getImplementation(m);
    method_setImplementation(m, n);
    L("[winhook] hooked %s", sel_getName(s));
    return o;
}

static int g_noActivate;
static inline int activateBlocked(void) { return g_noActivate && !showAllowed(); }

typedef void (*v_imp)(id, SEL);
typedef void (*v_bool_imp)(id, SEL, BOOL);
static v_bool_imp orig_activateIgnoring;
static v_imp orig_activate, orig_finishLaunching;
static void my_activateIgnoring(id self, SEL _cmd, BOOL flag) {
    if (!activateBlocked()) { if (orig_activateIgnoring) orig_activateIgnoring(self, _cmd, flag); return; }
    L("[winhook] blocked activateIgnoringOtherApps:");
}
static void my_activate(id self, SEL _cmd) {
    if (!activateBlocked()) { if (orig_activate) orig_activate(self, _cmd); return; }
    L("[winhook] blocked activate");
}
static void my_finishLaunching(id self, SEL _cmd) {
    if (activateBlocked()) {
        [(NSApplication *)self setActivationPolicy:NSApplicationActivationPolicyAccessory];
        L("[winhook] accessory policy before finishLaunching");
    }
    if (orig_finishLaunching) orig_finishLaunching(self, _cmd);
}

static int g_termsSurfaced;

static void scanOnce(void) {
    @try {
        NSWindow *terms = nil;
        for (NSWindow *w in [NSApp windows]) {
            if (isTermsWindow(w) && [w isVisible]) {
                if (!terms) terms = w;
            } else if (!showAllowed() && isBusyProgressWindow(w) && [w isVisible]) {
                L("[winhook] scan -> orderOut busy-progress '%s'", [[w title] UTF8String] ?: "?");
                [w orderOut:nil];
            }
        }
        if (terms && !g_termsSurfaced) {
            g_termsSurfaced = 1;
            g_modalActive++;
            [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
            [terms makeKeyAndOrderFront:nil];
            [NSApp activateIgnoringOtherApps:YES];
            L("[winhook] scan -> surfaced terms/license window '%s' for the user", [[terms title] UTF8String] ?: "?");
        } else if (!terms && g_termsSurfaced) {
            g_termsSurfaced = 0;
            g_modalActive--;
            if (!g_reveal && g_modalActive == 0) {
                for (NSWindow *w in [NSApp windows]) {
                    if ([w isVisible]) [w orderOut:nil];
                }
                [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
            }
            L("[winhook] scan -> terms/license window closed");
        }
    } @catch (...) {}
}

// Held for the process lifetime so macOS App Nap stays disabled. A headless clone is an accessory app
// with no visible window (we park every window off-screen), so macOS classifies it as idle/background
// and suspends it for seconds at a time (the ~5-7s freezes) — even though it's actively rendering +
// streaming. NSProcessInfo activity tells the OS this process is doing latency-sensitive work, which
// disables App Nap. The batchmode primary doesn't need this (no UI → not a nap target).
static id g_activity;

// --- Reveal-on-demand -------------------------------------------------------
// The orchestrator writes SATURA_WINHOOK_REVEAL_FILE = {"want":0|1,"epoch":N}. We poll it and,
// on want=1, un-suppress + order the real editor window on screen (Regular activation so it lands
// in the Dock and takes focus); on want=0 we hide it again and go back to Accessory. We also write
// <file>.status on load, which doubles as the injection-loaded ack the orchestrator waits for.

static char g_revealFile[PATH_MAX];
static int  g_revealFileSet;
static long g_revealEpoch;
static long g_boundsX, g_boundsY, g_boundsW, g_boundsH;
static int  g_hasBounds;

static void ResolveRevealFile(void) {
    const char *env = getenv("SATURA_WINHOOK_REVEAL_FILE");
    if (!env || !env[0]) return;
    strncpy(g_revealFile, env, sizeof(g_revealFile) - 1);
    g_revealFile[sizeof(g_revealFile) - 1] = '\0';
    g_revealFileSet = 1;
    L("[winhook] reveal file = %s", g_revealFile);
}

static long ParseLongField(const char *buf, const char *key) {
    const char *p = strstr(buf, key);
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

static long ReadRevealWant(void) {
    FILE *f = fopen(g_revealFile, "r");
    if (!f) return -1;
    char buf[256] = { 0 };
    fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    long epoch = ParseLongField(buf, "\"epoch\"");
    if (epoch >= 0) g_revealEpoch = epoch;
    long bw = ParseLongField(buf, "\"w\"");
    long bh = ParseLongField(buf, "\"h\"");
    if (bw > 0 && bh > 0) {
        g_boundsX = ParseLongField(buf, "\"x\"");
        g_boundsY = ParseLongField(buf, "\"y\"");
        g_boundsW = bw;
        g_boundsH = bh;
        g_hasBounds = 1;
    } else {
        g_hasBounds = 0;
    }
    return ParseLongField(buf, "\"want\"");
}

static void WriteStatus(int loaded, int shown, int ready) {
    if (!g_revealFileSet) return;
    char path[PATH_MAX + 8];
    snprintf(path, sizeof(path), "%s.status", g_revealFile);
    FILE *f = fopen(path, "w");
    if (!f) return;
    fprintf(f, "{\"loaded\":%d,\"shown\":%d,\"ready\":%d,\"epoch\":%ld}",
            loaded ? 1 : 0, shown ? 1 : 0, ready ? 1 : 0, g_revealEpoch);
    fclose(f);
}

// True only in the process that actually owns the editor's main window. Unity spawns worker
// subprocesses (asset import, shader compiler, package manager) that inherit our env + dylib; without
// this gate each one would honor the reveal file, flip to Regular activation, and add a duplicate
// Dock icon. Workers have no large editor window, so this returns 0 for them.
static int hasEditorMainWindow(void) {
    @try {
        for (NSWindow *w in [NSApp windows]) {
            if (isTermsWindow(w)) continue;
            NSRect fr = [w frame];
            if (fr.size.width >= 320 && fr.size.height >= 240) return 1;
        }
    } @catch (...) {}
    return 0;
}

// The orchestrator's reveal bounds are global top-left DIP coordinates (Electron); Cocoa frames are
// bottom-left-origin points relative to the primary screen, so flip Y against its height.
static void ApplyRevealBounds(NSWindow *w) {
    if (!g_hasBounds) return;
    @try {
        NSScreen *primary = [[NSScreen screens] firstObject];
        if (!primary) return;
        if ([w styleMask] & NSWindowStyleMaskFullScreen) return;
        CGFloat screenH = [primary frame].size.height;
        NSRect fr = NSMakeRect((CGFloat)g_boundsX,
                               screenH - (CGFloat)(g_boundsY + g_boundsH),
                               (CGFloat)g_boundsW, (CGFloat)g_boundsH);
        [w setFrame:fr display:YES];
        L("[winhook] reveal bounds applied x=%ld y=%ld w=%ld h=%ld",
          g_boundsX, g_boundsY, g_boundsW, g_boundsH);
    } @catch (...) {}
}

static void RevealRescueOffscreen(NSWindow *w) {
    if (g_hasBounds) return;
    @try {
        if ([w styleMask] & NSWindowStyleMaskFullScreen) return;
        NSRect fr = [w frame];
        for (NSScreen *s in [NSScreen screens])
            if (NSIntersectsRect(fr, [s frame])) return;
        NSScreen *primary = [[NSScreen screens] firstObject];
        if (!primary) return;
        [w setFrame:[primary visibleFrame] display:YES];
        L("[winhook] reveal off-screen fallback -> primary work area");
    } @catch (...) {}
}

static void RevealShowEditor(void) {
    @try {
        [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
        NSWindow *main = nil;
        CGFloat best = 0;
        for (NSWindow *w in [NSApp windows]) {
            if (isTermsWindow(w)) continue;
            NSRect fr = [w frame];
            if (fr.size.width < 320 || fr.size.height < 240) continue;
            CGFloat area = fr.size.width * fr.size.height;
            if (area > best) { best = area; main = w; }
        }
        for (NSWindow *w in [NSApp windows]) {
            if (w == main || isTermsWindow(w)) continue;
            NSRect fr = [w frame];
            if (fr.size.width < 320 || fr.size.height < 240) continue;  // skip tiny utility windows
            [w makeKeyAndOrderFront:nil];   // routed to the original IMP because g_reveal is set
            L("[winhook] reveal shown title='%s'", [[w title] UTF8String] ?: "?");
        }
        if (main) {
            if ([main isMiniaturized]) [main deminiaturize:nil];
            ApplyRevealBounds(main);
            RevealRescueOffscreen(main);
            [main makeKeyAndOrderFront:nil];
            L("[winhook] reveal shown main title='%s'", [[main title] UTF8String] ?: "?");
        }
        [NSApp activateIgnoringOtherApps:YES];
        WriteStatus(1, 1, 0);
    } @catch (...) {}
}

static void RevealHideEditor(void) {
    @try {
        for (NSWindow *w in [NSApp windows]) {
            if ([w isVisible]) [w orderOut:nil];   // orderWindow:NSWindowOut is always allowed
        }
        [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
        WriteStatus(1, 0, 0);
        L("[winhook] reveal hidden");
    } @catch (...) {}
}

static long g_shownEpoch = -1;

static void PollReveal(void) {
    if (!g_revealFileSet) return;
    long want = ReadRevealWant();
    if (want < 0) return;
    int w = want ? 1 : 0;
    if (w == g_reveal) {
        if (w && g_revealEpoch != g_shownEpoch) {
            g_shownEpoch = g_revealEpoch;
            L("[winhook] reveal again (epoch=%ld)", g_revealEpoch);
            RevealShowEditor();
        }
        return;
    }
    if (w && !hasEditorMainWindow()) return;   // worker subprocess: never reveal (no Dock icon)
    g_reveal = w;
    g_shownEpoch = g_revealEpoch;
    L("[winhook] reveal transition -> %d (epoch=%ld)", w, g_revealEpoch);
    if (w) RevealShowEditor(); else RevealHideEditor();
}

// --- Modal dialog detection + resolution -----------------------------------
// A blocking modal (DisplayDialog, save prompt, API updater, Safe Mode, …) halts Unity's main thread,
// so the MCP bridge can neither see nor answer it. This hook is the only layer that keeps running:
// the detection timer below is a main-queue GCD source, and main-queue blocks ARE pumped by a modal
// session's run loop, so both the scan and the button click execute on the main thread while the
// modal is up. Protocol: we publish visible dialogs (title/message/buttons) to
// SATURA_MODAL_STATUS_FILE whenever the set changes, and consume click/close commands from
// SATURA_MODAL_CMD_FILE (strictly increasing seq; a stale cmd file from a previous run is absorbed
// at startup as the initial consumed seq). Terms and busy-progress windows keep their existing
// auto-behaviors and are never reported.

#define MODAL_MAX_DIALOGS 8
#define MODAL_MAX_BUTTONS 16

typedef struct {
    NSWindow *win;
    NSButton *buttons[MODAL_MAX_BUTTONS];
    int nButtons;
    int strong;
    char id[64];
} ModalRef;

static char g_modalStatusFile[PATH_MAX];
static char g_modalCmdFile[PATH_MAX];
static int  g_modalStatusSet, g_modalCmdSet;
static long g_modalSeq;
static long g_modalCmdDone = -1;
static unsigned g_lastDialogsSig;
static int g_modalStatusWritten;
static char g_lastCmdJson[512];
static ModalRef g_modalRefs[MODAL_MAX_DIALOGS];
static int g_nModalRefs;

static unsigned Fnv1aStr(const char *s) {
    unsigned h = 2166136261u;
    while (*s) { h ^= (unsigned char)*s++; h *= 16777619u; }
    return h;
}

static int ParseStringField(const char *buf, const char *key, char *out, size_t cap) {
    const char *p = strstr(buf, key);
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

static void AppendRaw(char *buf, size_t cap, size_t *len, const char *s) {
    while (*s && *len + 1 < cap) buf[(*len)++] = *s++;
    buf[*len] = '\0';
}

// Escapes for JSON without ever emitting invalid UTF-8 (which would break json.loads): complete
// multi-byte sequences are copied atomically, and malformed bytes — stray continuations, bad leads,
// or a sequence cut short by the source's own truncation — are dropped.
static void AppendJsonEscaped(char *buf, size_t cap, size_t *len, const char *s, size_t maxBytes) {
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
        else if (c < 0x20) *len += snprintf(buf + *len, cap - *len, "\\u%04x", c);
        else buf[(*len)++] = (char)c;
    }
    buf[*len] = '\0';
}

// strncpy truncation can cut a UTF-8 sequence in half — walk back over any partial tail.
static void TrimUtf8Tail(char *s) {
    size_t n = strlen(s);
    if (n == 0) return;
    size_t cont = 0;
    while (cont < n && cont < 3 && ((unsigned char)s[n - 1 - cont] & 0xC0) == 0x80) cont++;
    if (cont >= n) { s[0] = '\0'; return; }
    unsigned char lead = (unsigned char)s[n - 1 - cont];
    if (lead < 0x80) return;
    int seq = (lead & 0xE0) == 0xC0 ? 2 : (lead & 0xF0) == 0xE0 ? 3 : (lead & 0xF8) == 0xF0 ? 4 : 0;
    if (seq == 0 || (size_t)seq != cont + 1) s[n - 1 - cont] = '\0';
}

static void ResolveModalFiles(void) {
    const char *sf = getenv("SATURA_MODAL_STATUS_FILE");
    if (sf && sf[0]) {
        strncpy(g_modalStatusFile, sf, sizeof(g_modalStatusFile) - 1);
        g_modalStatusSet = 1;
        L("[winhook] modal status file = %s", g_modalStatusFile);
    }
    const char *cf = getenv("SATURA_MODAL_CMD_FILE");
    if (cf && cf[0]) {
        strncpy(g_modalCmdFile, cf, sizeof(g_modalCmdFile) - 1);
        g_modalCmdSet = 1;
        FILE *f = fopen(g_modalCmdFile, "r");
        if (f) {
            char buf[1024] = { 0 };
            fread(buf, 1, sizeof(buf) - 1, f);
            fclose(f);
            long seq = ParseLongField(buf, "\"seq\"");
            if (seq > g_modalCmdDone) g_modalCmdDone = seq;
        }
    }
}

// Weak (heuristic) matches are kept only if view traversal finds real buttons; strong matches
// (the active modal session / sheet / modal-panel level) are always reported.
static int dialogStrength(NSWindow *w) {
    if (![w isVisible]) return 0;
    if (isTermsWindow(w) || isBusyProgressWindow(w)) return 0;
    if (w == g_runModalWindow || w == [NSApp modalWindow] || [w isSheet]) return 2;
    if ([w level] >= NSModalPanelWindowLevel) return 2;
    NSRect fr = [w frame];
    if (fr.size.width > 1200 || fr.size.height > 900) return 0;
    if (fr.size.width < 120 || fr.size.height < 60) return 0;
    if (!([w styleMask] & NSWindowStyleMaskResizable)) return 1;
    return 0;
}

// NSAlert panels carry no window title: the bold headline (messageText) and the informative text are
// both plain NSTextFields in the content view. The first static text encountered is the headline and
// feeds only `head`; the longest of the REMAINING fields is the message — keeping the two separate
// means a message shorter than the headline is no longer discarded when the headline is promoted to
// the title. AppKit can attach the informative field a beat after the window is surfaced, so a scan
// may legitimately see the headline alone; the caller marks such an entry textComplete:false and the
// next timer scan heals it.
static void CollectViews(NSView *v, int depth, ModalRef *ref, char *msg, size_t msgCap,
                         char *head, size_t headCap, const char *title) {
    if (!v || depth > 8) return;
    if ([v isKindOfClass:[NSButton class]] && ![v isKindOfClass:[NSPopUpButton class]]) {
        NSButton *b = (NSButton *)v;
        const char *t = [[b title] UTF8String];
        if (t && t[0] && ref->nButtons < MODAL_MAX_BUTTONS) ref->buttons[ref->nButtons++] = b;
        return;
    }
    if ([v isKindOfClass:[NSTextField class]] && ![(NSTextField *)v isEditable]) {
        const char *s = [[(NSTextField *)v stringValue] UTF8String];
        if (s && s[0] && (!title || strcmp(s, title) != 0)) {
            if (!head[0]) {
                strncpy(head, s, headCap - 1);
                head[headCap - 1] = '\0';
                TrimUtf8Tail(head);
            } else if (strlen(s) > strlen(msg)) {
                strncpy(msg, s, msgCap - 1);
                msg[msgCap - 1] = '\0';
                TrimUtf8Tail(msg);
            }
        }
    }
    for (NSView *sub in [v subviews]) CollectViews(sub, depth + 1, ref, msg, msgCap, head, headCap, title);
}

// Each dialog is serialized into its own scratch buffer, sized so the worst case (fully escaped
// title + message + 16 buttons) always fits, then appended to the body only if it fits whole —
// truncation can drop a trailing dialog but can never publish malformed JSON.
static void BuildModalRefs(char *body, size_t cap, size_t *blen) {
    static char entry[12288];
    g_nModalRefs = 0;
    for (NSWindow *w in [NSApp windows]) {
        if (g_nModalRefs >= MODAL_MAX_DIALOGS) break;
        int strength = dialogStrength(w);
        if (!strength) continue;
        ModalRef *ref = &g_modalRefs[g_nModalRefs];
        memset(ref, 0, sizeof(*ref));
        ref->win = w;
        ref->strong = strength == 2;
        const char *title = [[w title] UTF8String] ?: "";
        char msg[2001] = { 0 };
        char head[257] = { 0 };
        @try {
            CollectViews([w contentView], 0, ref, msg, sizeof(msg), head, sizeof(head), title);
        } @catch (...) {}
        if (!ref->strong && ref->nButtons == 0) continue;
        if (!title[0] && head[0]) {
            title = head;
        } else if (title[0] && head[0] && !msg[0]) {
            strncpy(msg, head, sizeof(msg) - 1);
            msg[sizeof(msg) - 1] = '\0';
        }
        snprintf(ref->id, sizeof(ref->id), "%lx-%08x", (long)[w windowNumber], Fnv1aStr(title));
        g_nModalRefs++;
        if (!body) continue;
        size_t elen = 0;
        entry[0] = '\0';
        AppendRaw(entry, sizeof(entry), &elen, "{\"id\":\"");
        AppendRaw(entry, sizeof(entry), &elen, ref->id);
        AppendRaw(entry, sizeof(entry), &elen, "\",\"title\":\"");
        AppendJsonEscaped(entry, sizeof(entry), &elen, title, 256);
        AppendRaw(entry, sizeof(entry), &elen, "\",\"message\":\"");
        AppendJsonEscaped(entry, sizeof(entry), &elen, msg, 2000);
        AppendRaw(entry, sizeof(entry), &elen, "\",\"buttons\":[");
        for (int i = 0; i < ref->nButtons; i++) {
            if (i) AppendRaw(entry, sizeof(entry), &elen, ",");
            AppendRaw(entry, sizeof(entry), &elen, "\"");
            AppendJsonEscaped(entry, sizeof(entry), &elen, [[ref->buttons[i] title] UTF8String] ?: "", 128);
            AppendRaw(entry, sizeof(entry), &elen, "\"");
        }
        AppendRaw(entry, sizeof(entry), &elen, "],\"cls\":\"");
        AppendJsonEscaped(entry, sizeof(entry), &elen, class_getName([w class]), 64);
        AppendRaw(entry, sizeof(entry), &elen,
                  (ref->nButtons > 0 && msg[0]) ? "\",\"textComplete\":true}" : "\",\"textComplete\":false}");
        if (elen + 8 >= sizeof(entry) || *blen + elen + 2 >= cap) continue;
        if (*blen > 0) AppendRaw(body, cap, blen, ",");
        AppendRaw(body, cap, blen, entry);
    }
}

static int ModalWriteStatus(const char *dialogsJson) {
    char tmp[PATH_MAX + 8];
    snprintf(tmp, sizeof(tmp), "%s.tmp", g_modalStatusFile);
    FILE *f = fopen(tmp, "w");
    if (!f) return 0;
    g_modalSeq++;
    fprintf(f, "{\"v\":1,\"seq\":%ld,\"ts\":%ld,\"pid\":%d,\"dialogs\":[%s]",
            g_modalSeq, (long)time(NULL), getpid(), dialogsJson);
    if (g_lastCmdJson[0]) fprintf(f, ",\"lastCmd\":%s", g_lastCmdJson);
    fputs("}", f);
    fclose(f);
    if (rename(tmp, g_modalStatusFile) != 0) return 0;
    return 1;
}

// Worker subprocesses (asset import, shader compiler) inherit the env + dylib; the main-window gate
// keeps them from clobbering the editor's status file — same reasoning as the reveal gate above.
// Once this process has published (g_modalStatusWritten), it owns the file and must stay allowed to
// update it: a startup modal can end before the main window exists, and without this the clearing
// write is skipped, leaving a stale "dialog open" status that blocks every tool.
static int modalPublishAllowed(void) {
    if (!g_modalStatusSet) return 0;
    return g_modalActive || g_modalStatusWritten || hasEditorMainWindow();
}

static void ModalScan(void) {
    if (!modalPublishAllowed()) return;
    @try {
        static char body[16384];
        size_t blen = 0;
        body[0] = '\0';
        BuildModalRefs(body, sizeof(body), &blen);
        unsigned sig = Fnv1aStr(body);
        if (g_modalStatusWritten && sig == g_lastDialogsSig) return;
        if (g_nModalRefs > 0) L("[winhook] modal scan -> %d dialog(s)", g_nModalRefs);
        if (ModalWriteStatus(body)) {
            g_lastDialogsSig = sig;
            g_modalStatusWritten = 1;
        }
    } @catch (...) {}
}

static void ModalPollCmd(void) {
    if (!g_modalCmdSet || !modalPublishAllowed()) return;
    FILE *f = fopen(g_modalCmdFile, "r");
    if (!f) return;
    char buf[1024] = { 0 };
    fread(buf, 1, sizeof(buf) - 1, f);
    fclose(f);
    long seq = ParseLongField(buf, "\"seq\"");
    if (seq < 0 || seq <= g_modalCmdDone) return;
    g_modalCmdDone = seq;
    char id[64] = { 0 }, action[16] = { 0 }, button[128] = { 0 };
    ParseStringField(buf, "\"id\"", id, sizeof(id));
    ParseStringField(buf, "\"action\"", action, sizeof(action));
    ParseStringField(buf, "\"button\"", button, sizeof(button));
    L("[winhook] modal cmd seq=%ld id='%s' action='%s' button='%s'", seq, id, action, button);
    const char *outcome = "not_found";
    char detail[192] = { 0 };
    @try {
        BuildModalRefs(NULL, 0, NULL);
        ModalRef *ref = NULL;
        for (int i = 0; i < g_nModalRefs; i++)
            if (strcmp(g_modalRefs[i].id, id) == 0) { ref = &g_modalRefs[i]; break; }
        if (ref) {
            if (strcmp(action, "close") == 0) {
                NSWindow *w = ref->win;
                if (w == [NSApp modalWindow] || w == g_runModalWindow) {
                    [NSApp stopModalWithCode:NSModalResponseCancel];
                    [w orderOut:nil];
                } else {
                    @try { [w performClose:nil]; } @catch (...) { [w orderOut:nil]; }
                }
                outcome = "closed";
            } else if (strcmp(action, "click") == 0) {
                NSButton *btn = NULL;
                for (int i = 0; i < ref->nButtons && !btn; i++) {
                    const char *t = [[ref->buttons[i] title] UTF8String] ?: "";
                    if (strcmp(t, button) == 0) btn = ref->buttons[i];
                }
                for (int i = 0; i < ref->nButtons && !btn; i++) {
                    const char *t = [[ref->buttons[i] title] UTF8String] ?: "";
                    if (strcasecmp(t, button) == 0) btn = ref->buttons[i];
                }
                // The status file caps labels at 128 escaped source bytes, so a longer real title
                // round-trips back truncated — accept it as a prefix of the full title.
                for (int i = 0; i < ref->nButtons && !btn; i++) {
                    const char *t = [[ref->buttons[i] title] UTF8String] ?: "";
                    if (strlen(button) >= 120 && strncmp(t, button, strlen(button)) == 0)
                        btn = ref->buttons[i];
                }
                if (btn) {
                    snprintf(detail, sizeof(detail), "%s", [[btn title] UTF8String] ?: button);
                    [btn performClick:nil];
                    outcome = "clicked";
                } else {
                    outcome = "button_not_found";
                }
            } else {
                outcome = "error";
                snprintf(detail, sizeof(detail), "unknown action");
            }
        }
    } @catch (...) {
        outcome = "error";
    }
    L("[winhook] modal cmd -> %s '%s'", outcome, detail);
    {
        size_t dlen = 0;
        char esc[256] = { 0 };
        AppendJsonEscaped(esc, sizeof(esc), &dlen, detail, 190);
        snprintf(g_lastCmdJson, sizeof(g_lastCmdJson),
                 "{\"seq\":%ld,\"outcome\":\"%s\",\"detail\":\"%s\"}", seq, outcome, esc);
    }
    g_modalStatusWritten = 0;
    ModalScan();
}

// The editor is not the only process that sees DYLD_INSERT_LIBRARIES — everything Unity spawns
// inherits it, and Unity's helpers are not all arm64 (JobProcess and LightBaker ship x86_64-only).
// dyld ABORTS a process whose insert has no matching slice instead of skipping it, so those helpers
// die on launch: endless "Failed executing external process for 'Layout Systems' job." with GI
// precompute and lightmap baking silently dead. dyld has already mapped us by the time a constructor
// runs, so scrubbing our own path out of the variable costs this process nothing and leaves the
// children clean. Other entries (someone else's insert) are preserved.
static void DropSelfFromDyldInsert(void) {
    const char *cur = getenv("DYLD_INSERT_LIBRARIES");
    if (!cur || !*cur) return;

    Dl_info info;
    const char *self = dladdr((void *)&DropSelfFromDyldInsert, &info) ? info.dli_fname : NULL;
    const char *selfBase = self ? strrchr(self, '/') : NULL;
    if (selfBase) selfBase++; else selfBase = self;

    char *orig = strdup(cur);          // setenv/unsetenv may free the storage `cur` points at
    char *scan = strdup(cur);
    char *kept = calloc(1, strlen(cur) + 1);
    int dropped = 0;
    if (orig && scan && kept) {
        char *save = NULL;
        for (char *tok = strtok_r(scan, ":", &save); tok; tok = strtok_r(NULL, ":", &save)) {
            const char *base = strrchr(tok, '/');
            if (base) base++; else base = tok;
            // Match on the resolved image path, falling back to the leaf name so a relative or
            // symlinked entry still matches the path dyld handed back.
            if ((self && strcmp(tok, self) == 0) || (selfBase && strcmp(base, selfBase) == 0)) {
                dropped = 1;
                continue;
            }
            if (*kept) strcat(kept, ":");
            strcat(kept, tok);
        }
        if (dropped) {
            L("[winhook] scrubbed self from DYLD_INSERT_LIBRARIES so Unity's x86_64 helpers survive"
              " (was '%s', now '%s')", orig, *kept ? kept : "<unset>");
            if (*kept) setenv("DYLD_INSERT_LIBRARIES", kept, 1);
            else unsetenv("DYLD_INSERT_LIBRARIES");
        }
    }
    free(kept); free(scan); free(orig);
}

__attribute__((constructor))
static void winhook_init(void) {
    L("[winhook] loaded pid=%d", getpid());
    DropSelfFromDyldInsert();
    g_activity = [[[NSProcessInfo processInfo]
        beginActivityWithOptions:(NSActivityUserInitiated | NSActivityLatencyCritical)
                          reason:@"Satura Space headless clone streaming"] retain];
    L("[winhook] App Nap disabled (beginActivity)");
    ResolveRevealFile();
    ResolveModalFiles();
    WriteStatus(1, 0, 0);
    Class w = objc_getClass("NSWindow");
    if (!w) { L("[winhook] NSWindow class missing"); return; }
    orig_mkof = (v_id_imp)setImp(w, @selector(makeKeyAndOrderFront:), (IMP)my_mkof);
    orig_of = (v_id_imp)setImp(w, @selector(orderFront:), (IMP)my_of);
    orig_orderWindow = (orderWindow_imp)setImp(w, @selector(orderWindow:relativeTo:), (IMP)my_orderWindow);
    orig_setVisible = (setVisible_imp)setImp(w, @selector(setIsVisible:), (IMP)my_setVisible);
    orig_ofr = (ofr_imp)setImp(w, @selector(orderFrontRegardless), (IMP)my_ofr);
    Class app = objc_getClass("NSApplication");
    if (app) orig_runModal = (runModal_imp)setImp(app, @selector(runModalForWindow:), (IMP)my_runModal);
    const char *na = getenv("SATURA_WINHOOK_NO_ACTIVATE");
    g_noActivate = na && strcmp(na, "1") == 0;
    if (app && g_noActivate) {
        orig_activateIgnoring = (v_bool_imp)setImp(app, @selector(activateIgnoringOtherApps:), (IMP)my_activateIgnoring);
        if (class_getInstanceMethod(app, @selector(activate))) orig_activate = (v_imp)setImp(app, @selector(activate), (IMP)my_activate);
        orig_finishLaunching = (v_imp)setImp(app, @selector(finishLaunching), (IMP)my_finishLaunching);
    }
    dispatch_async(dispatch_get_main_queue(), ^{
        if (NSApp) {
            // This block is pumped by the main run loop — which includes a modal session's loop. Do
            // NOT force Accessory while a blocking modal (or user reveal) is up, or we'd yank the app
            // back to background mid-dialog and make it un-clickable (the editor then hangs).
            if (!g_modalActive && !g_reveal) {
                [NSApp setActivationPolicy:NSApplicationActivationPolicyAccessory];
                L("[winhook] set accessory activation policy");
            } else {
                L("[winhook] skipped initial accessory policy (modal/reveal active)");
            }
        } else {
            L("[winhook] NSApp nil at policy time");
        }
        dispatch_source_t t = dispatch_source_create(DISPATCH_SOURCE_TYPE_TIMER, 0, 0, dispatch_get_main_queue());
        dispatch_source_set_timer(t, dispatch_time(DISPATCH_TIME_NOW, 0), 200 * NSEC_PER_MSEC, 50 * NSEC_PER_MSEC);
        dispatch_source_set_event_handler(t, ^{ scanOnce(); PollReveal(); ModalScan(); ModalPollCmd(); });
        dispatch_resume(t);  // intentionally retained for process lifetime
    });
}
