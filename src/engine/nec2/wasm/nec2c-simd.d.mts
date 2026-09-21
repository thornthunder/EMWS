// The SIMD build of the engine. Emscripten generates the same loader API for both, so
// the types live in one place; only the WebAssembly behind them differs.

export type { Nec2cFS, Nec2cModule, Nec2cModuleOptions } from './nec2c.d.mts';
import type { Nec2cModule, Nec2cModuleOptions } from './nec2c.d.mts';

declare function createNec2c(options?: Nec2cModuleOptions): Promise<Nec2cModule>;
export default createNec2c;
