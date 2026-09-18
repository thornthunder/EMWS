/*
 * EMWS build shim for nec2c.
 *
 * Upstream nec2c gets this header from autotools (./configure). We build with
 * Emscripten directly instead, so this hand-written stand-in supplies the one
 * macro the sources actually use. It lets us compile the files in ../upstream
 * completely unmodified.
 *
 * Written for EMWS by ZR1JT. Public domain (The Unlicense).
 */
#ifndef EMWS_NEC2C_CONFIG_H
#define EMWS_NEC2C_CONFIG_H

#define PACKAGE_STRING "nec2c 1.3.1 (EMWS WebAssembly build)"

#endif
