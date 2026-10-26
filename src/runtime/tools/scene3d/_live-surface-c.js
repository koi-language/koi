/**
 * Native half of the live 3D viewport (macOS): a tiny C library Blender
 * loads with ctypes to put each viewport frame into a shared IOSurface.
 *
 * Blender draws the frame on the GPU; the library copies it into a global
 * BGRA IOSurface (flipped to top-down on the way). The GUI looks the same
 * surface up by id and hands it to Flutter as a native texture — no socket,
 * no copy on the GUI side. Each write bumps the surface seed, which is how
 * the GUI knows a new frame landed.
 *
 * Embedded as a string (like the Python builder) so the bundled engine
 * carries it; the release build compiles it next to Blender inside the app
 * (scripts/fetch-blender-bundle.mjs), dev builds compile it on first use.
 *
 * NOTE: plain C inside String.raw — never use backticks or ${ in it.
 */
export const LIVE_SURFACE_C = String.raw`
#include <IOSurface/IOSurface.h>
#include <CoreFoundation/CoreFoundation.h>
#include <Accelerate/Accelerate.h>
#include <stdint.h>
#include <string.h>

#pragma clang diagnostic ignored "-Wdeprecated-declarations"

static void put_int(CFMutableDictionaryRef d, CFStringRef k, int v) {
    CFNumberRef n = CFNumberCreate(NULL, kCFNumberIntType, &v);
    CFDictionarySetValue(d, k, n);
    CFRelease(n);
}

/* A global (lookup-by-id) BGRA surface of w x h. NULL on failure. */
void *bls_create(int w, int h) {
    CFMutableDictionaryRef d = CFDictionaryCreateMutable(NULL, 0,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    put_int(d, kIOSurfaceWidth, w);
    put_int(d, kIOSurfaceHeight, h);
    put_int(d, kIOSurfaceBytesPerElement, 4);
    put_int(d, kIOSurfacePixelFormat, 'BGRA');
    CFDictionarySetValue(d, kIOSurfaceIsGlobal, kCFBooleanTrue);
    IOSurfaceRef s = IOSurfaceCreate(d);
    CFRelease(d);
    return (void *)s;
}

uint32_t bls_id(void *s) {
    return s ? IOSurfaceGetID((IOSurfaceRef)s) : 0;
}

/* GPU read-back rows (RGBA8, bottom-up) → surface (BGRA, top-down). */
int bls_write_rgba(void *s, const uint8_t *rgba, int w, int h) {
    IOSurfaceRef surf = (IOSurfaceRef)s;
    if (!surf || !rgba) return -1;
    if ((int)IOSurfaceGetWidth(surf) != w || (int)IOSurfaceGetHeight(surf) != h) return -2;
    if (IOSurfaceLock(surf, 0, NULL) != kIOReturnSuccess) return -3;
    uint8_t *base = (uint8_t *)IOSurfaceGetBaseAddress(surf);
    size_t stride = IOSurfaceGetBytesPerRow(surf);
    const size_t row = (size_t)w * 4;
    /* Flip by walking the source bottom row first (negative row bytes). */
    vImage_Buffer src = { (void *)(rgba + row * (size_t)(h - 1)), (vImagePixelCount)h, (vImagePixelCount)w, (size_t)0 - row };
    vImage_Buffer dst = { base, (vImagePixelCount)h, (vImagePixelCount)w, stride };
    const uint8_t map[4] = { 2, 1, 0, 3 };
    vImage_Error err = vImagePermuteChannels_ARGB8888(&src, &dst, map, kvImageDoNotTile);
    if (err != kvImageNoError) {
        for (int y = 0; y < h; y++) {
            const uint8_t *sp = rgba + row * (size_t)(h - 1 - y);
            uint8_t *dp = base + stride * (size_t)y;
            for (int x = 0; x < w; x++, sp += 4, dp += 4) {
                dp[0] = sp[2]; dp[1] = sp[1]; dp[2] = sp[0]; dp[3] = sp[3];
            }
        }
    }
    IOSurfaceUnlock(surf, 0, NULL);
    return 0;
}

void bls_release(void *s) {
    if (s) CFRelease((IOSurfaceRef)s);
}
`;
