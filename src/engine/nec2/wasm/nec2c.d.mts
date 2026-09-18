// Hand-written types for the Emscripten-generated loader (nec2c.mjs).
// Only the parts of the Emscripten module API that EMWS uses are declared.

export interface Nec2cFS {
  writeFile(path: string, data: string | Uint8Array): void;
  readFile(path: string, options: { encoding: 'utf8' }): string;
  readFile(path: string, options?: { encoding: 'binary' }): Uint8Array;
  unlink(path: string): void;
}

export interface Nec2cModule {
  /** Runs nec2c's main(argc, argv) and returns its exit code. */
  callMain(args: string[]): number;
  /** Emscripten's in-memory filesystem. */
  FS: Nec2cFS;
}

export interface Nec2cModuleOptions {
  /** The bytes of nec2c.wasm. Skips the loader's own fetch. */
  wasmBinary?: ArrayBuffer | Uint8Array;
  /** Supply an already-compiled module; lets many runs share one compilation. */
  instantiateWasm?: (
    imports: WebAssembly.Imports,
    onSuccess: (instance: WebAssembly.Instance, module?: WebAssembly.Module) => void,
  ) => object;
  print?: (line: string) => void;
  printErr?: (line: string) => void;
  locateFile?: (path: string, scriptDirectory: string) => string;
}

declare function createNec2c(options?: Nec2cModuleOptions): Promise<Nec2cModule>;
export default createNec2c;
