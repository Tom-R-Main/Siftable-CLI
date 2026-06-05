declare const Bun: {
  spawnSync(
    command: string[],
    options?: {
      cwd?: string;
      stdout?: "pipe";
      stderr?: "pipe";
    }
  ): {
    stdout: ArrayBuffer;
    stderr: ArrayBuffer;
    exitCode: number | null;
  };
};

declare module "bun:ffi" {
  export const suffix: "dylib" | "so" | "dll";
  export const FFIType: {
    buffer: "buffer";
    ptr: "ptr";
    u32: "u32";
    u64: "u64";
    bool: "bool";
  };
  export function dlopen<T extends Record<string, { args?: readonly string[]; returns?: string }>>(
    path: string,
    symbols: T
  ): {
    symbols: {
      [K in keyof T]: (...args: any[]) => any;
    };
    close(): void;
  };
}
