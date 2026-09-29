export declare const root: string;
export declare const toolchain: {
  version: string; binaryUrl: string; binarySha256: string;
  sourceUrl: string; sourceRevision: string; sourceSha256: string;
};
export declare const bendEnv: Record<string, string | undefined>;
export declare function resolveBendExecutable(): string;
export declare function resolveBendSource(): string;
export declare function assertPinnedCompiler(bend: string): string;
