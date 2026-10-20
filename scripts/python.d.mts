export function probePython(executable: string, options?: { env?: NodeJS.ProcessEnv; timeoutMs?: number }): string;
export function resolvePython(options?: { env?: NodeJS.ProcessEnv; probe?: (executable: string) => string }): string;
