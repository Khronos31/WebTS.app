/*
 * config.h for the WebTS.app libmpeg2 build.
 *
 * Upstream generates this with autotools. We are not running autotools for a
 * single fixed target, so this supplies the handful of symbols the vendored C
 * sources actually read. Those symbols are, in full:
 *
 *   ARCH_X86 ARCH_X86_64 ARCH_PPC ARCH_ALPHA ARCH_SPARC ARCH_ARM
 *   HAVE_ALTIVEC_H HAVE_BWX HAVE_CIX HAVE_FIX HAVE_MVI
 *   ACCEL_DETECT ATTRIBUTE_ALIGNED_MAX HAVE_BUILTIN_EXPECT
 *
 * Every ARCH_ is deliberately left undefined. The hand-written MMX, AltiVec,
 * Alpha, VIS and ARM sources are not vendored at all, so defining one would
 * only produce link errors; leaving them undefined makes mpeg2_detect_accel
 * return the caller's mask unchanged and the decoder run its C paths. WASM
 * has no runtime CPU detection worth doing here, and WASM SIMD would be a
 * separate port, not one of these.
 *
 * ACCEL_DETECT guards inline asm (cpuid, amask) and must stay undefined.
 */

#ifndef WEBTS_LIBMPEG2_CONFIG_H
#define WEBTS_LIBMPEG2_CONFIG_H

/* clang, which is what emcc is, always has __builtin_expect. */
#define HAVE_BUILTIN_EXPECT 1

/* Upstream aligns its DCT blocks to 16. Nothing here needs more. */
#define ATTRIBUTE_ALIGNED_MAX 16

#endif /* WEBTS_LIBMPEG2_CONFIG_H */
